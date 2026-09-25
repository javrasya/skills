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
// The Workflow runner's resumeFromRunId promises the same. A resume, from any
// terminal, takes the journaled Run over (run-use) before it starts a worker,
// and takes up each worker the last run left out: watched again if Orca still
// shows it live, its session continued if it died. When the script settles the
// runner writes summary.json to the state dir: {runner, ok, result | error},
// and on a failure also worktrees_kept, the worktrees it retained because
// their agent died or never started. Every line
// it prints is also appended, timestamped, to runner.log there.
// Launched in a terminal, it gives its tab to the run view (run-view/view.mjs)
// and writes to runner.log alone while the view lives (attachView).
//
// Nothing is reclaimed during a run (ADR-0012): no worker is released, no tab
// closed, no worktree removed. Only after summary.json is written does the
// runner ask the operator what to reclaim (reclaim.mjs); once answered it
// writes what was reclaimed and what kept to reclaim.json beside it, and exits.
//
// The run itself is recorded in the machine-wide run registry (registry.mjs,
// orca-runs.jsonl in the Claude directory): `armed` and the runner's terminal when the Run
// is created, the new runner's terminal when a resume takes it over, `ended`
// with ok, partial or failed when the script settles, and `reclaimed` for what
// the operator reclaims at the end.
//
// No change to this directory is done until the runner contract test passes
// under both runners (README.md). The offline tests do not replace it.
import { mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, realpathSync } from 'fs'
import { createInterface } from 'readline'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { checkSchema } from './schema.mjs'
import { orcaCli, launchCommand, HARNESSES, realTimer, worktreeUnpushed } from './orca-cli.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'
import { agentLifecycle } from './lifecycle.mjs'
import { JOURNAL_ENTRIES, readJournal, madeByRun } from './journal.mjs'
import { runRegistry, readRegistry, REGISTRY_PATH } from './registry.mjs'
import { sessionTranscripts } from './transcript.mjs'
import { agentsOf, endOfRunPrompt } from './reclaim.mjs'
import { VIEW_EXIT } from './run-view/exit-codes.mjs'

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
  // pi-lens-ignore: no-global-eval-js
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

// The journal's entry types and its one fold live in journal.mjs.
export { JOURNAL_ENTRIES, readJournal }

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
// the repo the run works in, and script the rendered script's path, recorded
// beside it with permissionMode, so the standalone run view can resume the run.
export async function runScript(text, { orca = orcaCli(), stateDir, out: print = (s) => console.log(s), settings = {}, clock = realClock, transcripts = sessionTranscripts(), fallbackObjective = 'workflow run', resume = false, permissionMode = null, registry = null, project = process.cwd(), script: scriptPath = null }) {
  const limits = { ...SETTINGS, ...settings }
  const out = runnerLog(stateDir, print, clock)
  const script = loadScript(text)
  const meta = {}
  let currentPhase = null

  const journalPath = join(stateDir, 'journal.jsonl')
  const earlier = resume ? readJournal(journalPath) : { calls: new Map(), retained: [], run: null, lastN: 0, agents: [] }
  const journaled = earlier.calls
  // A resume numbers its calls on from the last run's: the Run it takes over
  // already holds a `<runId>-<n>` child worktree for each n used, and Orca
  // answers a create of a taken name with <name>-2.
  let count = earlier.lastN
  // Rewritten from empty, replayed calls included, so the journal always
  // describes the latest run and a later resume replays from it alone. It
  // still names every agent of the Run: the ones earlier runners made are
  // carried forward below, as `earlier` or `outstanding` lines.
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
  // Called once, when Orca creates the Run, or hands the journaled one over to
  // a resume: that Run was armed by the runner that created it, and gains
  // this runner's terminal.
  const onRun = ({ runId, terminal, takenOver = false }) => {
    armed = runId
    journal({ type: 'run', runId, terminal })
    if (!takenOver) record('armed', { runId, project, runDir: stateDir, spec: meta.value?.name ?? fallbackObjective, script: scriptPath, permissionMode })
    record('runner', { runId, terminal })
  }
  // How many calls with each key this run has made.
  const seen = new Map()
  let replaying = resume
  // A dead agent never names its worktree to the script, so the script can
  // never reclaim it; the runner created it and names it instead. A resume
  // re-runs the dead agent in a new worktree, so the one it left in the
  // earlier run stays named here, and is journaled again for the next resume.
  const retained = []
  const retainWorktree = (k) => {
    if (!retained.some((r) => r.path === k.path)) retained.push(k)
    return k
  }
  // A worker the last run left out stays journaled until a call takes it up,
  // so a resume that stops, or cannot take the Run over, before then never
  // loses it, and the next resume never starts a second one for its call.
  const outstanding = [...journaled].flatMap(([key, entries]) => entries.filter((e) => e.worker).map((e) => ({ key, ...e.worker })))
  // A worktree retained while its worker was still out is named by that
  // worker until its call takes it up; one no call takes up is named at the end.
  const held = new Set(outstanding.map((w) => w.worktree).filter(Boolean))
  const aside = new Map()
  for (const k of earlier.retained) {
    if (held.has(k.path)) aside.set(k.path, k)
    else journal({ type: 'retained', retained: retainWorktree(k) })
  }
  const unclaimed = () => {
    for (const k of aside.values()) journal({ type: 'retained', retained: retainWorktree(k) })
    aside.clear()
  }
  // So a resume that makes no live call still leaves the Run to the next one.
  if (earlier.run) journal({ type: 'run', ...earlier.run, lastN: earlier.lastN })
  // Every other agent an earlier runner of this Run made: it launched
  // nothing in this run, but its tab and `<runId>-<n>` worktree stay the Run's
  // until the operator reclaims them, so this run's journal still names it.
  const stillOut = new Set(outstanding.map((w) => w.origin))
  for (const a of earlier.agents) {
    if (!madeByRun(a) || stillOut.has(a.origin)) continue
    const { n, title, runId: run, dispatchId, harness, sessionId, terminal, worktree, origin, state, reason, continuations, workerLeft } = a
    journal({ type: 'earlier', n, title, run, dispatchId, harness, sessionId, terminal, worktree, origin, state, reason, ...(continuations && { continuations }), ...(workerLeft && { workerLeft }) })
  }
  for (const { key, n, title, run, dispatchId, harness, sessionId, terminal, worktree, dir, origin, continuations } of outstanding) {
    journal({ type: 'outstanding', key, n, title, run, dispatchId, harness, sessionId, terminal, worktree, dir, origin, ...(continuations && { continuations }) })
  }
  const life = agentLifecycle({ orca, clock, limits, out, stateDir, objective: () => objectiveOf(meta.value, fallbackObjective), journal, retainWorktree, onRun, takeOver: earlier.run?.runId ?? null, transcripts })

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

    // The k-th call with a key is the k-th journaled under it, so identical
    // calls each get their own; a failed entry keeps its place. One miss ends
    // the prefix for good: what follows a changed or failed call may depend
    // on it, however unchanged it reads. A call the last run left unsettled
    // gave the script nothing to depend on, so it leaves the prefix standing.
    const k = seen.get(key) ?? 0
    seen.set(key, k + 1)
    const cached = journaled.get(key)
    const entry = cached && k < cached.length ? cached[k] : null
    if (replaying && entry && 'result' in entry) {
      // Its origin makes it the agent the journal already names, not another.
      journal({ type: 'result', key, n, title, result: entry.result, replayed: true, ...(entry.origin != null && { origin: entry.origin }) })
      out(`<< ${title}: replayed from the journal`)
      return entry.result
    }
    const unsettled = !!(entry?.worker || entry?.unsettled)
    if (replaying && !unsettled) {
      out(`>> ${title}: ${entry ? 'failed in the last run' : 'not in the journal'}; this call and every one after it run live`)
      replaying = false
    }
    if (entry?.unsettled) out(`>> ${title}: its worker never started in the last run; it starts now`)

    const call = { prompt, schema: opts.schema, isolated: opts.isolation === 'worktree', launch, key, n, label, title, phaseName }
    // Its worker is its own whatever came before it: it runs this very call.
    if (entry?.worker) {
      aside.delete(entry.worker.worktree)
      return life({ ...call, adopt: entry.worker })
    }
    return life(call)
  }

  try {
    const value = await script(agent, parallel, phase, log, meta)
    unclaimed()
    const result = withRetained(value, retained)
    if (armed) record('ended', { runId: armed, outcome: failures ? 'partial' : 'ok' })
    return result
  } catch (e) {
    unclaimed()
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
// retained because its agent died or never started, since the arming session
// reads this file and not the log. What the operator then keeps of every
// agent is reclaim.json's (finish).
export const failureSummary = (e) => ({ runner: 'orca', ok: false, error: e?.stack ?? String(e), worktrees_kept: Array.isArray(e?.worktrees_kept) ? e.worktrees_kept : [] })

// The run's result names each worktree retained because its agent died or
// never started beside the ones a reclaimer kept, in the same {path, reason}
// shape. A result that is not an object has
// nowhere to hold them; the log still names them.
function withRetained(result, retained) {
  if (!retained.length || !result || typeof result !== 'object' || Array.isArray(result)) return result
  const kept = Array.isArray(result.worktrees_kept) ? result.worktrees_kept : []
  const named = new Set(kept.map((k) => k?.path))
  return { ...result, worktrees_kept: [...kept, ...retained.filter((k) => !named.has(k.path))] }
}

// The end of a run: summary.json first, since the arming session waits for it
// and not for this tab, then the result, then the end-of-run prompt over the
// agents this run's journal names: every agent of its Run, the ones earlier
// runners of it made included, except those the registry already records
// reclaimed. `ask(question)` resolves to the operator's answer, or null once
// none can come; `registry` is a runRegistry writer, or null; `unpushed(path)`
// counts a worktree's unpushed commits. Once the prompt is answered (or there
// was none to ask), reclaim.json beside summary.json records the outcome:
//   { choice, answered, reclaimed: [agent], kept: [agent + reason] }
// with choice null and both lists empty when no agent was left to ask about,
// and each agent as { name, title, worktree, terminal }. It is the prompt's
// answer only: a later reclaim from the run view is the registry's.
export async function finish({ stateDir, summary, orca, ask, out, registry = null, unpushed = worktreeUnpushed }) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify(summary, null, 2))
  if (summary.ok) {
    out('== Result')
    out(JSON.stringify(summary.result, null, 2))
  }
  let agents = agentsOf(join(stateDir, 'journal.jsonl'))
  if (registry?.path) {
    try {
      const runs = readRegistry(registry.path).filter((r) => agents.some((a) => a.runId === r.runId))
      // A name is `<runId>-<n>`, so it names one agent across runs.
      const done = new Set(runs.flatMap((r) => r.reclaimedAgents.map((x) => x.agent)))
      agents = agents.filter((a) => !done.has(a.name))
    } catch (e) {
      out(`!! run registry: could not read what is already reclaimed: ${e?.message ?? e}`)
    }
  }
  const outcome = await endOfRunPrompt({ agents, ask, out, orca, unpushed, registry })
  const named = ({ name, title, worktree, terminal }) => ({ name, title, worktree: worktree ?? null, terminal: terminal ?? null })
  const record = {
    choice: outcome?.choice ?? null,
    answered: outcome?.answered ?? false,
    reclaimed: (outcome?.reclaimed ?? []).map(named),
    kept: (outcome?.kept ?? []).map(({ agent, reason }) => ({ ...named(agent), reason })),
  }
  try {
    writeFileSync(join(stateDir, 'reclaim.json'), JSON.stringify(record, null, 2))
  } catch (e) {
    out(`!! could not write reclaim.json: ${e?.message ?? e}`)
  }
  return outcome
}

// The run view attached to the runner's tab (D5 on #43): a child process that
// owns the tab's screen and keys while it lives. The runner then writes to
// runner.log alone, and the view shows the log's latest line. A crash of the
// view never touches the run: the view is started again after viewRestartMs
// on the clock. At viewCrashes crashes, once the operator quits it, or when
// it cannot run here, the runner prints in the tab again, the log's last lines
// first.
//   spawnView()  starts one view: an emitter of 'message', 'exit' and 'error'
//                with send(); a view that cannot be spawned throws or emits
//                'error' with no pid
//   tab(s)       prints to the tab; log(s) appends to runner.log, and prints
//                to the tab too once no view is attached
//   ask(q)       the end-of-run question on the tab's own stdin, for when no
//                view is left to ask it in
//   tail()       runner.log's last lines
//   restore()    puts the tab back after a view exits, as a crashed one cannot
//   guard(on)    ignores a Ctrl-C that reaches the runner while a view lives:
//                one that dies outside raw mode lets Ctrl-C reach every
//                process on the console
// Returns { start(), gate(print), ask(question, prompt), closed, crashes() }.
// gate wraps a print so it reaches the tab only once no view is attached. ask
// puts the end-of-run prompt ({ title, lines }, from endOfRunPrompt) in the
// view as its modal, again in each view restarted before it is answered.
// closed resolves once no view is attached.
export function attachView({ spawnView, tab, log, ask: askTab, tail = () => [], clock = realClock, limits = SETTINGS, restore = () => {}, guard = () => {} }) {
  let attached = true
  let crashes = 0
  let pending = null
  let child = null
  let close
  const closed = new Promise((r) => {
    close = r
  })
  const send = (m) => {
    try {
      child?.send(m)
    } catch {}
  }

  function fallBack(why) {
    attached = false
    child = null
    guard(false)
    for (const line of tail()) tab(line)
    log(`!! ${why}; the runner prints its log in this tab again`)
    close()
    if (pending) {
      const p = pending
      pending = null
      askTab(p.question).then(p.resolve, () => p.resolve(null))
    }
  }

  function start() {
    let c
    try {
      c = spawnView()
    } catch (e) {
      return fallBack(`the run view could not start: ${e?.message ?? e}`)
    }
    child = c
    let over = false
    let detached = false
    const ended = (code, signal) => {
      if (over) return
      over = true
      child = null
      restore()
      if (detached || code === VIEW_EXIT.quit) return fallBack('the run view was closed')
      if (code === VIEW_EXIT.unavailable) return fallBack('the run view cannot run in this tab (see runner.log)')
      crashes++
      const how = signal ? `signal ${signal}` : code == null ? 'it could not start' : `exit code ${code}`
      if (crashes >= limits.viewCrashes) return fallBack(`the run view crashed ${crashes} times, the last with ${how}`)
      log(`!! the run view crashed with ${how}; restarting it (crash ${crashes} of ${limits.viewCrashes})`)
      clock.sleep(limits.viewRestartMs).then(start)
    }
    c.on('message', (m) => {
      if (m?.type === 'detach') detached = true
      if (m?.type === 'endChoice' && pending) {
        const p = pending
        pending = null
        p.resolve(m.answer ?? '')
      }
    })
    c.on('exit', ended)
    c.on('error', (e) => {
      log(`!! the run view: ${e?.message ?? e}`)
      if (c.pid === undefined) ended(null, null)
    })
    if (pending) send(pending.prompt)
  }

  return {
    start() {
      guard(true)
      start()
    },
    gate: (print) => (s) => {
      if (!attached) print(s)
    },
    ask(question, prompt = {}) {
      if (!attached) return askTab(question)
      return new Promise((resolve) => {
        pending = { question, resolve, prompt: { type: 'endPrompt', title: prompt.title ?? 'The run ended', lines: prompt.lines ?? [], question } }
        send(pending.prompt)
      })
    },
    closed,
    crashes: () => crashes,
  }
}

const VIEW = join(dirname(fileURLToPath(import.meta.url)), 'run-view', 'view.mjs')

// Mouse reporting off, cursor shown, the main screen back, the keyboard out
// of raw mode: what a view that crashed left set.
function restoreTab() {
  process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[?1049l')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}

function logTail(stateDir, n = 20) {
  try {
    return readFileSync(join(stateDir, 'runner.log'), 'utf8').trimEnd().split('\n').slice(-n)
  } catch {
    return []
  }
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

// realpathSync: a symlinked install (e.g. pi's ~/.pi/agent/skills entries) is
// still this file's main — resolve() would not dereference the link.
const isMain = process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
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
  // The session clears it before launch too; this is defence in depth.
  rmSync(join(dir, 'summary.json'), { force: true })
  rmSync(join(dir, 'reclaim.json'), { force: true })
  // runner.pid lets the arming session tell a runner that died before writing
  // summary.json (killed, OOM) from one still running: the tab outlives the
  // runner, so the tab cannot say. Written before anything else can fail.
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runner.pid'), String(process.pid))
  // The tab's stdin is the view's while one is attached, so it is read only
  // once a question has to be asked there.
  let asker = null
  const askTab = (question) => (asker ??= stdinAsker()).ask(question)
  const ignore = () => {}
  // With no terminal (the offline tests, a redirected launch) there is no view,
  // and the runner prints as it always did.
  const view = process.stdout.isTTY && process.stdin.isTTY
    ? attachView({
      spawnView: () => spawn(process.execPath, [VIEW, '--attached', dir], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }),
      tab: (s) => console.log(s),
      log: (s) => say(s),
      ask: askTab,
      tail: () => logTail(dir),
      restore: restoreTab,
      guard: (on) => (on ? process.on('SIGINT', ignore) : process.off('SIGINT', ignore)),
    })
    : null
  const gate = view ? view.gate : (print) => print
  const say = runnerLog(dir, gate((s) => console.log(s)))
  const sayError = runnerLog(dir, gate((s) => console.error(s)))
  view?.start()
  const orca = orcaCli()
  let summary
  try {
    const result = await runScript(readFileSync(path, 'utf8'), {
      orca,
      stateDir: dir,
      out: gate((s) => console.log(s)),
      fallbackObjective: `workflow ${basename(path)}`,
      resume,
      permissionMode,
      registry: REGISTRY_PATH,
      script: path,
    })
    summary = { runner: 'orca', ok: true, result }
  } catch (e) {
    sayError(e?.stack ?? String(e))
    process.exitCode = 1
    summary = failureSummary(e)
  }
  try {
    await finish({ stateDir: dir, summary, orca, ask: view ? view.ask : askTab, out: say, registry: runRegistry(REGISTRY_PATH) })
    // The view stays on the ended run until the operator quits it.
    await view?.closed
  } catch (e) {
    sayError(`!! reclaim: ${e?.stack ?? e}`)
  } finally {
    asker?.close()
  }
}
