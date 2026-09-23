#!/usr/bin/env node
// The Orca runner (ADR-0011): runs a rendered workflow script unchanged by
// supplying its four hooks, and starts each agent() as a supervised Orca
// worker. Launch it from its own Orca terminal — the Run it creates binds to
// that terminal.
//
//   node runner.mjs <rendered-script.js> [--state-dir <dir>]
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
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

const slug = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runScript(text, { orca = orcaCli(), stateDir, out = (s) => console.log(s), pollMs = 5000, objective = 'workflow run' }) {
  const script = loadScript(text)
  let run = null
  let currentPhase = null
  let count = 0

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
    if (result.error) {
      out(`!! ${title}: ${result.error} (outcome ${s.outcome}); agent() returns null`)
      return null
    }
    out(`<< ${title}: result received`)
    return result.value
  }

  return script(agent, parallel, phase, log)
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--state-dir')
  const stateDir = at >= 0 ? resolve(args.splice(at, 2)[1]) : null
  const [scriptPath] = args
  if (!scriptPath || args.length > 1 || (at >= 0 && !stateDir)) {
    console.error('usage: node runner.mjs <rendered-script.js> [--state-dir <dir>]')
    process.exit(2)
  }
  const path = resolve(scriptPath)
  try {
    const result = await runScript(readFileSync(path, 'utf8'), {
      stateDir: stateDir ?? join(dirname(path), 'orca-run'),
      objective: `workflow ${basename(path)}`,
    })
    console.log('== Result')
    console.log(JSON.stringify(result, null, 2))
  } catch (e) {
    console.error(e?.stack ?? String(e))
    process.exitCode = 1
  }
}
