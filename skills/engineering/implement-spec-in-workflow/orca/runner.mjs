#!/usr/bin/env node
// The Orca runner (ADR-0011): runs a rendered workflow script unchanged by
// supplying its four hooks, and starts each agent() as a supervised Orca
// worker. Launch it from its own Orca terminal — the Run it creates binds to
// that terminal.
//
//   node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
//
// Every settled agent() call is journaled in the state dir, which defaults
// to <notes-dir>/orca-run for the rendered <notes-dir>/workflow.js: a value as
// its result, and a null (a dead agent, one that never started, one Orca could
// not reach) as failed, with no result. --resume replays the unchanged prefix
// of agent() calls from that journal without launching anything; the first
// call not in it or journaled as failed, and every call after it, runs live.
// The Workflow runner's resumeFromRunId promises the same. On exit the runner
// writes summary.json to the state dir: {runner, ok, result | error}, and on a
// failure also worktrees_kept, the worktrees it retained. Every line it prints
// is also appended, timestamped, to runner.log there.
//
// No change to this directory is done until the runner contract test passes
// under both runners (README.md). The offline tests do not replace it.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs'
import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { checkSchema } from './schema.mjs'
import { orcaCli, launchCommand, HARNESSES } from './orca-cli.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'
import { agentLifecycle } from './lifecycle.mjs'

export { SUBMIT, workerPrompt } from './lifecycle.mjs'

// The runner settings table (settings.mjs). Every limit the runner enforces
// lives there.
export const SETTINGS = RUNNER_SETTINGS

// The same loading the workflow simulator does: the script's one ESM line
// becomes a plain const, and the body runs as an async function body so its
// top-level `return` is the run's result. meta is also handed out as it is
// declared, so the Run's objective can name the spec the script is for.
export function loadScript(text) {
  const body = text.replace(/^export const meta\s*=/m, 'const meta = __meta.value =')
  return new Function('agent', 'parallel', 'phase', 'log', '__meta', 'return (async () => {' + body + '\n})()')
}

export const objectiveOf = (meta, fallback) => [meta?.name, meta?.description].filter(Boolean).join(': ') || fallback

// Keys sorted, so a call hashes the same whatever order its options were
// written in.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
  return v
}

export const journalKey = (prompt, opts = {}) =>
  'v1:' + createHash('sha256').update(JSON.stringify([prompt, canonical(opts)])).digest('hex')

// Every journal entry type and the fields it always carries, beside `type`.
// `at` is an ISO timestamp from the runner's clock. A failed entry may also
// carry `retained`, the worktree it left; a replayed result carries
// `replayed: true`. retry, nudge, continued and reattached are written by the
// behaviours that make them: a new attempt of a call, a nudge typed to a
// worker, a finished session continued in its terminal, and a resumed runner
// taking up a worker an earlier one started.
export const JOURNAL_ENTRIES = Object.freeze({
  started: ['at', 'key', 'n', 'title', 'dispatchId', 'harness', 'sessionId', 'worktree', 'terminal'],
  result: ['at', 'key', 'n', 'title', 'result'],
  failed: ['at', 'key', 'n', 'title', 'reason', 'attempts'],
  retained: ['at', 'retained'],
  retry: ['at', 'key', 'n', 'title', 'attempt', 'reason'],
  nudge: ['at', 'key', 'n', 'title', 'dispatchId', 'reason', 'count'],
  continued: ['at', 'key', 'n', 'title', 'dispatchId', 'sessionId', 'terminal', 'reason'],
  reattached: ['at', 'key', 'n', 'title', 'dispatchId', 'sessionId', 'terminal', 'worktree'],
})

// calls: key -> what was journaled under it, in journal order — { result }
// for a call that returned a value, { failed: true } for one that returned
// null. A failed entry holds its call's place but replays nothing, so a resume
// runs that call live again, as the Workflow runner re-runs an agent it
// journaled as failed. A `started` line with no settlement is a call the last
// run was killed during: it replays nothing. A torn last line is one it was
// killed while writing. retained: every worktree a dead agent left, from its
// failed entry or from a `retained` line an earlier resume carried forward.
// Only type, key, result and retained are read, so a journal written before
// entries carried timestamps and launch fields resumes the same way.
export function readJournal(path) {
  const calls = new Map()
  const retained = []
  if (!existsSync(path)) return { calls, retained }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e?.retained?.path && !retained.some((k) => k.path === e.retained.path)) retained.push(e.retained)
    if (e?.type !== 'result' && e?.type !== 'failed') continue
    if (!calls.has(e.key)) calls.set(e.key, [])
    calls.get(e.key).push(e.type === 'failed' ? { failed: true } : { result: e.result })
  }
  return { calls, retained }
}

export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

const iso = (clock) => new Date(clock.now()).toISOString()

// print, but every line also appended to <stateDir>/runner.log first, so the
// log holds what the operator saw even once the runner's tab is gone. The log
// is appended to across runs; the journal, not the log, is the resume state.
export function runnerLog(stateDir, print, clock = realClock) {
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, 'runner.log')
  return (s) => {
    const at = iso(clock)
    appendFileSync(path, String(s).split('\n').map((l) => `${at} ${l}\n`).join(''))
    print(s)
  }
}

// `settings` overrides entries of SETTINGS; `clock` is what the liveness
// limits are measured against, so tests can drive time.
// permissionMode: the orchestrating session's, which Claude workers start in
// as Workflow subagents inherit it. Without one, a Claude worker starts in
// Claude's own default mode.
export async function runScript(text, { orca = orcaCli(), stateDir, out: print = (s) => console.log(s), settings = {}, clock = realClock, fallbackObjective = 'workflow run', resume = false, permissionMode = null }) {
  const limits = { ...SETTINGS, ...settings }
  const out = runnerLog(stateDir, print, clock)
  const script = loadScript(text)
  const meta = {}
  let currentPhase = null
  let count = 0

  const journalPath = join(stateDir, 'journal.jsonl')
  const earlier = resume ? readJournal(journalPath) : { calls: new Map(), retained: [] }
  const journaled = earlier.calls
  // Rewritten from empty, replayed calls included, so the journal always
  // describes the latest run and a later resume replays from it alone.
  writeFileSync(journalPath, '')
  const journal = (entry) => appendFileSync(journalPath, JSON.stringify({ type: entry.type, at: iso(clock), ...entry }) + '\n')
  const replays = new Map()
  let replaying = resume
  // A dead agent never names its worktree to the script, so the script can
  // never reclaim it; the runner created it and names it instead. A resume
  // re-runs the dead agent in a new worktree, so the one it left in the
  // earlier run stays named here, and is journaled again for the next resume.
  const retained = []
  const keep = (k) => {
    if (!retained.some((r) => r.path === k.path)) retained.push(k)
    return k
  }
  for (const k of earlier.retained) journal({ type: 'retained', retained: keep(k) })
  const life = agentLifecycle({ orca, clock, limits, out, stateDir, objective: () => objectiveOf(meta.value, fallbackObjective), journal, keep })

  const phase = (title) => {
    currentPhase = title
    out(`== ${title}`)
  }
  const log = (msg) => out(`   ${msg}`)
  const parallel = (fns) => Promise.all(fns.map((f, i) => Promise.resolve().then(f).catch((e) => {
    out(`!! parallel: thunk ${i} threw (${e?.message ?? e}); it resolves to null`)
    return null
  })))

  async function agent(prompt, opts = {}) {
    if (opts.schema) checkSchema(opts.schema)
    const harness = opts.harness ?? 'claude'
    if (!HARNESSES.includes(harness)) throw new Error(`agent(): unknown harness "${harness}": expected one of ${HARNESSES.join(', ')}`)
    // A pi worker's model is `piModel`, never `model`: `model` stays a Claude
    // model the Workflow runner can take, since it ignores the harness and runs
    // every role on Claude. Both are in the call's journal key, as every option is.
    const launch = { harness, model: harness === 'pi' ? opts.piModel : opts.model, effort: opts.effort, permissionMode: harness === 'claude' ? permissionMode : null }
    // Refused here, before any worker, like an unsatisfiable schema.
    launchCommand(launch)
    const n = ++count
    const label = opts.label || `agent-${n}`
    const phaseName = opts.phase ?? currentPhase ?? 'Run'
    const title = `[${phaseName}] ${label}`
    const key = journalKey(prompt, opts)

    // The k-th call with a key replays the k-th entry journaled under it, so
    // identical calls each get their own; a failed entry keeps its place. One
    // miss ends the prefix for good: what follows a changed or failed call may
    // depend on it, however unchanged it reads.
    const k = replays.get(key) ?? 0
    const cached = journaled.get(key)
    const entry = replaying && cached && k < cached.length ? cached[k] : null
    if (entry && !entry.failed) {
      replays.set(key, k + 1)
      journal({ type: 'result', key, n, title, result: entry.result, replayed: true })
      out(`<< ${title}: replayed from the journal`)
      return entry.result
    }
    if (replaying) out(`>> ${title}: ${entry ? 'failed in the last run' : 'not in the journal'}; this call and every one after it run live`)
    replaying = false

    return life({ prompt, schema: opts.schema, isolated: opts.isolation === 'worktree', launch, key, n, label, title, phaseName })
  }

  try {
    return withRetained(await script(agent, parallel, phase, log, meta), retained)
  } catch (e) {
    // A run that throws still names what it kept: summary.json carries it.
    if (!(e instanceof Object)) e = new Error(String(e))
    e.worktrees_kept = [...retained]
    throw e
  } finally {
    for (const k of retained) out(`!! kept ${k.path}: ${k.reason}`)
  }
}

// summary.json for a run that threw: the error, and every worktree the runner
// retained, since the arming session reads this file and not the log.
export const failureSummary = (e) => ({ runner: 'orca', ok: false, error: e?.stack ?? String(e), worktrees_kept: Array.isArray(e?.worktrees_kept) ? e.worktrees_kept : [] })

// The run's result names each retained worktree beside the ones a reclaimer
// kept, in the same {path, reason} shape. A result that is not an object has
// nowhere to hold them; the log still names them.
function withRetained(result, retained) {
  if (!retained.length || !result || typeof result !== 'object' || Array.isArray(result)) return result
  const kept = Array.isArray(result.worktrees_kept) ? result.worktrees_kept : []
  const named = new Set(kept.map((k) => k?.path))
  return { ...result, worktrees_kept: [...kept, ...retained.filter((k) => !named.has(k.path))] }
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) {
  const args = process.argv.slice(2)
  let bad = false
  const r = args.indexOf('--resume')
  const resume = r >= 0 && !!args.splice(r, 1)
  const option = (name) => {
    const at = args.indexOf(name)
    if (at < 0) return null
    const [, value] = args.splice(at, 2)
    if (!value || value.startsWith('--')) bad = true
    return value ?? null
  }
  const stateDir = option('--state-dir')
  const permissionMode = option('--permission-mode')
  const [scriptPath] = args
  if (!scriptPath || args.length > 1 || bad) {
    console.error('usage: node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <orchestrator\'s Claude permission mode>]')
    process.exit(2)
  }
  const path = resolve(scriptPath)
  const dir = stateDir ? resolve(stateDir) : join(dirname(path), 'orca-run')
  // The arming session reads the run's outcome from this file once the
  // runner's terminal exits (SKILL.md step 4); a stale one from an earlier
  // run must never pass for this run's.
  const summaryPath = join(dir, 'summary.json')
  rmSync(summaryPath, { force: true })
  const say = runnerLog(dir, (s) => console.log(s))
  const sayError = runnerLog(dir, (s) => console.error(s))
  let summary
  try {
    const result = await runScript(readFileSync(path, 'utf8'), {
      stateDir: dir,
      fallbackObjective: `workflow ${basename(path)}`,
      resume,
      permissionMode,
    })
    say('== Result')
    say(JSON.stringify(result, null, 2))
    summary = { runner: 'orca', ok: true, result }
  } catch (e) {
    sayError(e?.stack ?? String(e))
    process.exitCode = 1
    summary = failureSummary(e)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
}
