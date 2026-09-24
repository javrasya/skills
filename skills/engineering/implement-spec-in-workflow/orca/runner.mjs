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
// The Workflow runner's resumeFromRunId promises the same. When the script
// settles the runner writes summary.json to the state dir: {runner, ok, result
// | error}, and on a failure also worktrees_kept, the worktrees it retained.
// Every line it prints is also appended, timestamped, to runner.log there.
//
// Nothing is reclaimed during a run (ADR-0012): no worker is released, no tab
// closed, no worktree removed. Only after summary.json is written does the
// runner ask the operator what to reclaim (reclaim.mjs); it exits once
// answered.
//
// The run itself is recorded in the machine-wide run registry (registry.mjs,
// ~/.claude/orca-runs.jsonl): `armed` and the runner's terminal when the Run
// is created, `ended` with ok, partial or failed when the script settles, and
// `reclaimed` for what the operator reclaims at the end.
//
// No change to this directory is done until the runner contract test passes
// under both runners (README.md). The offline tests do not replace it.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs'
import { createInterface } from 'readline'
import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { checkSchema } from './schema.mjs'
import { orcaCli, launchCommand, HARNESSES, realTimer } from './orca-cli.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'
import { agentLifecycle } from './lifecycle.mjs'
import { runRegistry, REGISTRY_PATH } from './registry.mjs'
import { sessionTranscripts } from './transcript.mjs'
import { agentsOf, endOfRunPrompt, gitUnpushed } from './reclaim.mjs'

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
// `at` is an ISO timestamp from the runner's clock; `run` is the Orca Run the
// worker was dispatched into. A failed entry may also carry `retained`, the
// worktree it left, `run`, once the Run existed, and `continuations`, how often its
// session was continued; a replayed result carries `replayed: true`. retry is
// a new attempt of a call's start or of its Run's creation, with why the last
// one failed; warning, something that went wrong without failing the call. A
// nudge's `attempt` is its number since the session started or was last
// continued; a continuation's is its number, up to the cap. reattached is
// written by the behaviour that makes it: a resumed runner taking up a worker
// an earlier one started.
export const JOURNAL_ENTRIES = Object.freeze({
  started: ['at', 'key', 'n', 'title', 'run', 'dispatchId', 'harness', 'sessionId', 'worktree', 'terminal'],
  result: ['at', 'key', 'n', 'title', 'result'],
  failed: ['at', 'key', 'n', 'title', 'reason', 'attempts'],
  retained: ['at', 'retained'],
  retry: ['at', 'key', 'n', 'title', 'attempt', 'reason'],
  warning: ['at', 'key', 'n', 'title', 'reason'],
  nudge: ['at', 'key', 'n', 'title', 'dispatchId', 'reason', 'attempt'],
  continued: ['at', 'key', 'n', 'title', 'dispatchId', 'sessionId', 'terminal', 'reason', 'attempt', 'reopened'],
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

export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), timer: realTimer }

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
// limits and the retry backoff are measured against, and `transcripts` what
// measures a worker's session transcript, so tests can drive both.
// permissionMode: the orchestrating session's, which Claude workers start in
// as Workflow subagents inherit it. Without one, a Claude worker starts in
// Claude's own default mode.
// registry: the run registry's path, or null to record nothing there; project:
// the repo the run works in, recorded beside it.
export async function runScript(text, { orca = orcaCli(), stateDir, out: print = (s) => console.log(s), settings = {}, clock = realClock, transcripts = sessionTranscripts(), fallbackObjective = 'workflow run', resume = false, permissionMode = null, registry = null, project = process.cwd() }) {
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
  // An agent() that returned null makes a run that returns partial, not ok.
  let failures = 0
  const journal = (entry) => {
    if (entry.type === 'failed') failures++
    appendFileSync(journalPath, JSON.stringify({ type: entry.type, at: iso(clock), ...entry }) + '\n')
  }
  // The registry is bookkeeping for the operator: a write it refuses is
  // reported, and the run carries on.
  const runs = registry ? runRegistry(registry, clock) : null
  let armed = null
  const record = (what, entry) => {
    try {
      runs?.[what](entry)
    } catch (e) {
      out(`!! run registry: could not record ${what} for ${entry.runId}: ${e?.message ?? e}`)
    }
  }
  // Called once, when Orca creates the Run. A resume creates a Run of its own,
  // so it is armed as its own run.
  const onRun = ({ runId, terminal }) => {
    armed = runId
    record('armed', { runId, project, runDir: stateDir, spec: meta.value?.name ?? fallbackObjective })
    record('runner', { runId, terminal })
  }
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
  const life = agentLifecycle({ orca, clock, limits, out, stateDir, objective: () => objectiveOf(meta.value, fallbackObjective), journal, keep, onRun, transcripts })

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
    const result = withRetained(await script(agent, parallel, phase, log, meta), retained)
    if (armed) record('ended', { runId: armed, outcome: failures ? 'partial' : 'ok' })
    return result
  } catch (e) {
    if (armed) record('ended', { runId: armed, outcome: 'failed' })
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

// The end of a run: summary.json first, since the arming session waits for it
// and not for this tab, then the result, then the end-of-run prompt over the
// agents this run's journal names. `ask(question)` resolves to the operator's
// answer, or null once none can come; `registry` is a runRegistry writer, or
// null; `unpushed(path)` counts a worktree's unpushed commits.
export async function finish({ stateDir, summary, orca, ask, out, registry = null, unpushed = gitUnpushed }) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify(summary, null, 2))
  if (summary.ok) {
    out('== Result')
    out(JSON.stringify(summary.result, null, 2))
  }
  return endOfRunPrompt({ agents: agentsOf(join(stateDir, 'journal.jsonl')), ask, out, orca, unpushed, registry })
}

// One question at a time on this tab's stdin. Once stdin ends, every question
// is answered null.
function stdinAsker() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let closed = false
  rl.on('close', () => { closed = true })
  return {
    ask: (question) => (closed ? Promise.resolve(null) : new Promise((r) => {
      rl.once('close', () => r(null))
      rl.question(question, r)
    })),
    close: () => rl.close(),
  }
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
  // The arming session reads the run's outcome from summary.json (SKILL.md
  // step 4); a stale one from an earlier run must never pass for this run's.
  rmSync(join(dir, 'summary.json'), { force: true })
  const say = runnerLog(dir, (s) => console.log(s))
  const sayError = runnerLog(dir, (s) => console.error(s))
  const orca = orcaCli()
  let summary
  try {
    const result = await runScript(readFileSync(path, 'utf8'), {
      orca,
      stateDir: dir,
      fallbackObjective: `workflow ${basename(path)}`,
      resume,
      permissionMode,
      registry: REGISTRY_PATH,
    })
    summary = { runner: 'orca', ok: true, result }
  } catch (e) {
    sayError(e?.stack ?? String(e))
    process.exitCode = 1
    summary = failureSummary(e)
  }
  const asker = stdinAsker()
  try {
    await finish({ stateDir: dir, summary, orca, ask: asker.ask, out: say, registry: runRegistry(REGISTRY_PATH) })
  } catch (e) {
    sayError(`!! reclaim: ${e?.stack ?? e}`)
  } finally {
    asker.close()
  }
}
