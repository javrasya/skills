#!/usr/bin/env node
// The Orca runner (ADR-0011): runs a rendered workflow script unchanged by
// supplying its four hooks, and starts each agent() as a supervised Orca
// worker. Launch it from its own Orca terminal — the Run it creates binds to
// that terminal.
//
//   node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume]
//
// Every settled agent() result is journaled in the state dir, which defaults
// to <notes-dir>/orca-run for the rendered <notes-dir>/workflow.js. --resume
// replays the unchanged prefix of agent() calls from that journal without
// launching anything; the first call not in it, and every call after it, runs
// live. The Workflow runner's resumeFromRunId promises the same.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs'
import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { checkSchema, validate } from './schema.mjs'
import { orcaCli } from './orca-cli.mjs'

export const SUBMIT = fileURLToPath(new URL('./submit.mjs', import.meta.url))

// The same loading the workflow simulator does: the script's one ESM line
// becomes a plain const, and the body runs as an async function body so its
// top-level `return` is the run's result.
export function loadScript(text) {
  const body = text.replace(/^export const meta/m, 'const meta')
  return new Function('agent', 'parallel', 'phase', 'log', 'return (async () => {' + body + '\n})()')
}

export function workerPrompt(prompt, { schemaPath, resultPath, payloadPath }) {
  const what = schemaPath
    ? `Write your result to ${payloadPath} as one JSON object that matches the JSON Schema in ${schemaPath}.`
    : `Write your answer to ${payloadPath} as plain text.`
  const command = [`node "${SUBMIT}"`, schemaPath && `--schema "${schemaPath}"`, `--result "${resultPath}"`, `--payload "${payloadPath}"`,
    '--from <worker_handle> --dispatch-capability <capability> --task-id <task_id> --dispatch-id <dispatch_id>'].filter(Boolean).join(' ')
  return `${prompt}

---
How this run receives your result: your final message is not read. Your result reaches the workflow only through the submit command below, and submit sends your worker_done for you — never send worker_done yourself.
1. ${what}
2. Run this, replacing the four <placeholders> with the values from your Orca preamble, copied exactly:
   ${command}
3. If submit exits non-zero it prints every error: fix the payload and run it again until it exits 0. Then stop and idle.`
}

// Keys sorted, so a call hashes the same whatever order its options were
// written in.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
  return v
}

export const journalKey = (prompt, opts = {}) =>
  'v1:' + createHash('sha256').update(JSON.stringify([prompt, canonical(opts)])).digest('hex')

// key -> the results journaled under it, in journal order. A `started` line
// with no result is a call the last run was killed during: it replays nothing.
// A torn last line is one it was killed while writing.
export function readJournal(path) {
  const results = new Map()
  if (!existsSync(path)) return results
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e?.type !== 'result') continue
    if (!results.has(e.key)) results.set(e.key, [])
    results.get(e.key).push(e.result)
  }
  return results
}

const slug = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runScript(text, { orca = orcaCli(), stateDir, out = (s) => console.log(s), pollMs = 5000, objective = 'workflow run', resume = false }) {
  const script = loadScript(text)
  let run = null
  let currentPhase = null
  let count = 0

  mkdirSync(stateDir, { recursive: true })
  const journalPath = join(stateDir, 'journal.jsonl')
  const journaled = resume ? readJournal(journalPath) : new Map()
  // Rewritten from empty, replayed calls included, so the journal always
  // describes the latest run and a later resume replays from it alone.
  writeFileSync(journalPath, '')
  const journal = (entry) => appendFileSync(journalPath, JSON.stringify(entry) + '\n')
  const replays = new Map()
  let replaying = resume

  const phase = (title) => {
    currentPhase = title
    out(`== ${title}`)
  }
  const log = (msg) => out(`   ${msg}`)
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  // Re-reads what submit recorded: the script is handed a value only if it is
  // valid now, whatever the worker claimed when it settled.
  function readResult(resultPath, schema) {
    if (!existsSync(resultPath)) return { error: 'settled without submitting a result' }
    let value
    try {
      value = JSON.parse(readFileSync(resultPath, 'utf8'))
    } catch (e) {
      return { error: `recorded result is not JSON: ${e.message}` }
    }
    const errors = schema ? validate(schema, value) : typeof value === 'string' ? [] : ['$: expected text']
    return errors.length ? { error: `recorded result fails its schema: ${errors.join('; ')}` } : { value }
  }

  async function agent(prompt, opts = {}) {
    if (opts.schema) checkSchema(opts.schema)
    const n = ++count
    const label = opts.label || `agent-${n}`
    const title = `[${opts.phase ?? currentPhase ?? 'Run'}] ${label}`
    const key = journalKey(prompt, opts)

    // The k-th call with a key replays the k-th result journaled under it, so
    // identical calls each get their own. One miss ends the prefix for good:
    // what follows a changed call may depend on it, however unchanged it reads.
    const k = replays.get(key) ?? 0
    const cached = journaled.get(key)
    if (replaying && cached && k < cached.length) {
      replays.set(key, k + 1)
      journal({ type: 'result', key, n, title, result: cached[k] })
      out(`<< ${title}: replayed from the journal`)
      return cached[k]
    }
    if (replaying) out(`>> ${title}: not in the journal; this call and every one after it run live`)
    replaying = false

    const dir = join(stateDir, 'agents', `${String(n).padStart(3, '0')}-${slug(label)}`)
    mkdirSync(dir, { recursive: true })
    const schemaPath = opts.schema ? join(dir, 'schema.json') : null
    const resultPath = join(dir, 'result.json')
    const payloadPath = join(dir, opts.schema ? 'payload.json' : 'payload.txt')
    if (schemaPath) writeFileSync(schemaPath, JSON.stringify(opts.schema, null, 2))
    // A state dir reused across runs must not hand this agent an older result.
    rmSync(resultPath, { force: true })

    run ??= orca.runCreate({ objective })
    const { runId } = await run
    journal({ type: 'started', key, n, title })
    const w = await orca.workerStart({ run: runId, prompt: workerPrompt(prompt, { schemaPath, resultPath, payloadPath }), title })
    out(`>> ${title}: started as dispatch ${w.dispatchId}${w.terminal ? ` in terminal ${w.terminal}` : ''}`)
    if (w.mode !== 'terminal' || !w.terminal) {
      out(`!! ${title} has no terminal tab to watch (mode: ${w.mode ?? 'unknown'}). Orca's setting for new agent tabs decides this; set it to terminal. ${w.modeDetail}`)
    }

    let s
    while (!(s = await orca.workerShow({ dispatch: w.dispatchId })).settled) await sleep(pollMs)
    const result = readResult(resultPath, opts.schema)
    try {
      await orca.workerRelease({ dispatch: w.dispatchId })
    } catch (e) {
      out(`!! ${title}: could not release its worker: ${e.message}`)
    }
    // A null is journaled like any value, as the Workflow runner journals it:
    // a resume replays it until the call is edited.
    const value = result.error ? null : result.value
    journal({ type: 'result', key, n, title, result: value })
    if (result.error) out(`!! ${title}: ${result.error} (outcome ${s.outcome}); agent() returns null`)
    else out(`<< ${title}: result received`)
    return value
  }

  return script(agent, parallel, phase, log)
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) {
  const args = process.argv.slice(2)
  const r = args.indexOf('--resume')
  const resume = r >= 0 && !!args.splice(r, 1)
  const at = args.indexOf('--state-dir')
  const stateDir = at >= 0 ? resolve(args.splice(at, 2)[1]) : null
  const [scriptPath] = args
  if (!scriptPath || args.length > 1 || (at >= 0 && !stateDir)) {
    console.error('usage: node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume]')
    process.exit(2)
  }
  const path = resolve(scriptPath)
  try {
    const result = await runScript(readFileSync(path, 'utf8'), {
      stateDir: stateDir ?? join(dirname(path), 'orca-run'),
      objective: `workflow ${basename(path)}`,
      resume,
    })
    console.log('== Result')
    console.log(JSON.stringify(result, null, 2))
  } catch (e) {
    console.error(e?.stack ?? String(e))
    process.exitCode = 1
  }
}
