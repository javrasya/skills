#!/usr/bin/env node
// The session runner (ADR-0011, ADR-0017): runs a rendered workflow script
// unchanged by supplying its four hooks, and starts each agent() as a
// supervised worker on its session host (hosts.mjs: crew, the default, or
// Orca). Launch it from its own terminal on that host — the Run it creates
// binds to that terminal.
//
//   node runner.mjs <rendered-script.js> [--host <name>] [--state-dir <dir>] [--resume] [--permission-mode <mode>]
//
// Every settled agent() call is journaled in the state dir, which defaults
// to <notes-dir>/orca-run for the rendered <notes-dir>/workflow.js: a value as
// its result, and a null (a dead agent, one that never started, one its host could
// not reach) as failed, with no result. --resume replays the unchanged prefix
// of agent() calls from that journal without launching anything; the first
// call not in it or journaled as failed, and every call after it, runs live.
// The Workflow runner's resumeFromRunId promises the same. A call that names
// its node (opts.node, ADR-0016) is found by its node instead, wherever it
// falls: its result replays while its key is unchanged, whatever failed
// before it, and a failed or needs-decision node is carried on (resumeNode);
// a node whose key changed runs live, and ends replay for every later call.
// Such a call is never handed null: a node that fails, or whose result needs
// decisions only the operator can make, is held, and the run halts (halt.mjs)
// until r carries it on, in this process; halted.json in the state dir names
// the held nodes for the arming session meanwhile. A resume, from any
// terminal, takes the journaled Run over (run-use) before it starts a worker,
// and takes up each worker the last run left out: watched again if its host still
// shows it live, its session continued if it died. A patient whose agent()
// waited on its doctor stays pending: its round goes on, its doctor taken up
// like any worker, never a second one started, and a handoff journaled but not
// yet applied is applied once. When the script settles the
// runner writes summary.json to the state dir: {runner: 'session', host, ok,
// result | error}, host the session host's id,
// and on a failure also worktrees_kept, the worktrees it retained because
// their agent died or never started. Every line
// it prints is also appended, timestamped, to runner.log there.
// Launched in a terminal, it gives its tab to the run view (run-view/view.mjs)
// and writes to runner.log alone while the view lives (attachView).
//
// Nothing is reclaimed during a run (ADR-0012): no worker is released, no tab
// closed, no worktree removed. The runner reclaims nothing at the end either:
// it writes summary.json and stays in its tab until the operator quits the run
// view, whose reclaim dialog is the only place an agent is reclaimed.
//
// The run itself is recorded in the machine-wide run registry (registry.mjs,
// orca-runs.jsonl in the Claude directory): `armed` and the runner's terminal when the Run
// is created, the new runner's terminal when a resume takes it over, `ended`
// with ok, partial or failed when the script settles, and `reclaimed` for what
// the operator reclaims from the run view.
//
// A session host outage, the host itself not there (Orca while it updates,
// crew's daemon gone), is waited out by every host call and charged to no
// agent (ADR-0015, outage.mjs): it is journaled (`outage`), and one past its
// limit pauses the run, recorded in the registry as `paused` until the host
// answers again. The runner stays in its tab meanwhile, and r in the attached
// view has it probe the host at once.
//
// No change to this directory is done until the runner contract test passes
// under both runners (README.md). The offline tests do not replace it.
import { mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, realpathSync } from 'fs'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { checkSchema } from './schema.mjs'
import { parseFlags } from './args.mjs'
import { sleep } from './util.mjs'
import { launchCommand, HARNESSES } from './harness.mjs'
import { realTimer } from './git.mjs'
import { hostUnreachable } from './session-host.mjs'
import { HOST_NAMES, LEGACY_HOST, openHost } from './hosts.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'
import { agentLifecycle, readResult, decisionsNeeded, setAside } from './lifecycle.mjs'
import { hostOutage } from './outage.mjs'
import { RESUME_REQUEST, runHalt } from './halt.mjs'
import { JOURNAL_ENTRIES, readJournal, madeByRun, journalLines, chainEntry } from './journal.mjs'
import { runRegistry, REGISTRY_PATH } from './registry.mjs'
import { sessionTranscripts } from './transcript.mjs'
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

// The titles of the phases a script's meta declares, in its order, for the
// run view to draw its phases by, or null when it declares none.
export function phaseTitles(meta) {
  const titles = (Array.isArray(meta?.phases) ? meta.phases : []).map((p) => (typeof p === 'string' ? p : p?.title)).filter((t) => typeof t === 'string' && t)
  return titles.length ? titles : null
}

export const objectiveOf = (meta, fallback) => [meta?.name, meta?.description].filter(Boolean).join(': ') || fallback

// Keys sorted, so a call hashes the same whatever order its options were
// written in.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
  return v
}

// `inFlight` is left out: it says only whether the call was made while the
// run was halting (ADR-0016), never what the call is, so a resume that makes
// the same call without it still finds its node's result.
export const journalKey = (prompt, { inFlight, ...opts } = {}) =>
  'v1:' + createHash('sha256').update(JSON.stringify([prompt, canonical(opts)])).digest('hex')

// The journal's entry types and its one fold live in journal.mjs.
export { JOURNAL_ENTRIES, readJournal }

export const realClock = { now: () => Date.now(), sleep, timer: realTimer }

const iso = (clock) => new Date(clock.now()).toISOString()
const took = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 6_000) / 10} min`)

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
// beside it with permissionMode, so the standalone run view can resume the run;
// runnerTerminal, where the runner is when the host's Run terminal is not
// the runner's own (crew's session): the registry, the journal and
// halted.json name it.
// control: filled in with resumeHost(), which probes the host at once during an
// outage, and resume({ node }), the attached view's r: resumeHost while an
// outage is on, else the halted run's node, or with none every held node.
// onHalt({ node, nodes }): told each time a node is held and the run halts.
export async function runScript(text, { host, stateDir, out: print = (s) => console.log(s), settings = {}, clock = realClock, transcripts = sessionTranscripts(), fallbackObjective = 'workflow run', resume = false, permissionMode = null, registry = null, project = process.cwd(), script: scriptPath = null, control = {}, onHalt = () => {}, runnerTerminal = null }) {
  const limits = { ...SETTINGS, ...settings }
  const out = runnerLog(stateDir, print, clock)
  const script = loadScript(text)
  const meta = {}
  let currentPhase = null

  const journalPath = join(stateDir, 'journal.jsonl')
  const earlier = resume ? readJournal(journalPath) : { calls: new Map(), nodes: new Map(), retained: [], run: null, lastN: 0, phases: null, agents: [], mail: [] }
  const journaled = earlier.calls
  // A resume numbers its calls on from the last run's: the Run it takes over
  // already holds a `<runId>-<n>` child worktree for each n used, and a
  // host may answer a create of a taken name with <name>-2 (Orca does).
  let count = earlier.lastN
  // Rewritten from empty, replayed calls included, so the journal always
  // describes the latest run and a later resume replays from it alone. It
  // still names every agent of the Run: the ones earlier runners made are
  // carried forward below, as `earlier` or `outstanding` lines.
  writeFileSync(journalPath, '')
  // halted.json is the arming session's notice of a halt (SKILL.md step 4): a
  // halted run writes no summary.json, since its script has not ended, and the
  // session waits on files, never on this tab. { at, runId, terminal (this
  // runner's tab), nodes: [{ node, title, reason, questions?, tab (its
  // worker's) }] }, rewritten with a new `at` whenever the held nodes change,
  // so the session reports each change once, and removed once the run leaves
  // halted. A stale one from an earlier run must never pass for this run's.
  const noticePath = join(stateDir, 'halted.json')
  rmSync(noticePath, { force: true })
  let noticeAt = 0
  const haltNotice = (held) => {
    try {
      if (!held.length) return rmSync(noticePath, { force: true })
      // Strictly later than the last, so two holds in one millisecond are two notices.
      noticeAt = Math.max(clock.now(), noticeAt + 1)
      const fold = readJournal(journalPath)
      const terminal = [...journalLines(journalPath)].reverse().find((e) => e.type === 'run' && e.terminal)?.terminal ?? null
      const tabOf = (node) => fold.nodes.get(node)?.last?.terminal ?? fold.agents.filter((a) => a.node === node).at(-1)?.terminal ?? null
      writeFileSync(noticePath, JSON.stringify({ at: new Date(noticeAt).toISOString(), runId: runIdNow(), terminal, nodes: held.map((h) => ({ ...h, tab: tabOf(h.node) })) }, null, 2))
    } catch (e) {
      out(`!! could not write halted.json: ${e?.message ?? e}`)
    }
  }
  // An agent() that returned null makes a run that returns partial, not ok.
  // A doctor that fails is no agent() call, and a node's failure is held, never
  // returned; a carried line is an earlier run's.
  let failures = 0
  const journal = (entry) => {
    if (entry.type === 'failed' && entry.patient == null && !entry.node && !entry.carried) failures++
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
  // Called once, when the host creates the Run, or hands the journaled one over to
  // a resume: that Run was armed by the runner that created it, and gains
  // this runner's terminal. The script has run by then, so its meta names
  // its phases. The runner's terminal is journaled, and so named in
  // halted.json, as the one an operator enters: on crew its own session
  // (runnerTerminal), not the adapter's side of the Run.
  const onRun = ({ runId, terminal, takenOver = false }) => {
    armed = runId
    const phases = phaseTitles(meta.value) ?? earlier.phases
    journal({ type: 'run', runId, terminal: runnerTerminal ?? terminal, ...(phases && { phases }) })
    if (!takenOver) record('armed', { runId, project, runDir: stateDir, spec: meta.value?.name ?? fallbackObjective, script: scriptPath, permissionMode, host: host.id })
    record('runner', { runId, terminal: runnerTerminal ?? terminal, host: host.id })
  }
  // The run's one outage of its session host (ADR-0015, ADR-0017: Orca's, or
  // crew's daemon unreachable): every host call waits on it, so no agent is
  // charged for it. It is journaled and logged as it starts, pauses
  // and ends, and a pause is recorded in the registry until the host is back.
  // A resume's Run is paused under its id before its takeover lands.
  const runIdNow = () => armed ?? earlier.run?.runId ?? null
  const outage = hostOutage({
    clock, limits, probe: () => host.probe(), unreachable: (e) => hostUnreachable(host, e),
    on: ({ phase, since, ms, reason, paused }) => {
      journal({ type: 'outage', phase, since: new Date(since).toISOString(), ...(reason && { reason }), ...(ms != null && { ms }) })
      if (phase === 'start') out(`!! ${host.name} unreachable (${reason}): every ${host.name} call waits for it, and no agent is charged for it; probing it for up to ${took(limits.outageLimitMs)} before the run pauses`)
      if (phase === 'paused') {
        out(`!!!!!!!! ${host.name} unreachable for ${Math.round(limits.outageLimitMs / 60_000)}m: run paused; r to resume (or it resumes itself once ${host.name} is back)`)
        if (runIdNow()) record('paused', { runId: runIdNow(), reason: `${host.id} outage` })
      }
      if (phase === 'end') {
        out(`>> ${host.name} is back after ${took(ms)}: the run carries on`)
        if (paused && runIdNow()) record('unpaused', { runId: runIdNow() })
      }
    },
  })
  host.guardWith?.(outage)
  control.resumeHost = async () => {
    const was = outage.state()
    const r = await outage.resume()
    if (!r.outage) out(`>> ${host.name} is there: nothing is waiting on it`)
    else if (!r.back) out(was?.phase === 'paused' ? `!! ${host.name} is still unreachable: the run stays paused, and probes it again every ${took(limits.pausedProbeMs)}` : `!! ${host.name} is still unreachable: every ${host.name} call still waits for it`)
    return r
  }
  // The run's halt (ADR-0016). r in the attached view reaches resume(): an
  // outage's r takes precedence while one is on.
  const halt = runHalt({ journal, out, record, runId: runIdNow, onHalt, onChange: haltNotice })
  control.resume = async ({ node = null } = {}) => (outage.state() ? control.resumeHost() : halt.resume(node))
  // How many calls with each key this run has made.
  const seen = new Map()
  let replaying = resume
  // Replay by node: on until a node's key is found changed.
  let nodeReplay = resume
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
  const outstanding = [...journaled].flatMap(([key, entries]) => entries.filter((e) => e.worker).map((e) => ({ key, ...(e.node && { node: e.node }), ...e.worker })))
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
  if (earlier.run) journal({ type: 'run', ...earlier.run, lastN: earlier.lastN, ...(earlier.phases && { phases: earlier.phases }) })
  // The run's chain worktree, and what earlier agents left in it, still told
  // to every chain agent the resume starts.
  const { chain } = earlier
  if (chain) journal(chainEntry(chain))
  // Every Run mailbox message an earlier runner acted on, as it journaled it:
  // the host delivers a batch again until it is acknowledged, and it is never
  // acted on twice.
  for (const m of earlier.mail) journal(m)
  // Every other agent an earlier runner of this Run made: it launched
  // nothing in this run, but its tab and `<runId>-<n>` worktree stay the Run's
  // until the operator reclaims them, so this run's journal still names it.
  const stillOut = new Set(outstanding.map((w) => w.origin))
  for (const a of earlier.agents) {
    if (!madeByRun(a) || stillOut.has(a.origin)) continue
    const { n, title, runId: run, dispatchId, harness, sessionId, terminal, worktree, origin, state, reason, continuations, workerLeft, patient, round, rounds } = a
    journal({ type: 'earlier', n, title, run, dispatchId, harness, sessionId, terminal, worktree, origin, state, reason, ...(continuations && { continuations }), ...(workerLeft && { workerLeft }), ...(patient != null && { patient }), ...(rounds.length && { round, rounds }) })
  }
  for (const { key, node, n, title, run, dispatchId, harness, sessionId, terminal, worktree, dir, origin, continuations } of outstanding) {
    // A patient's rounds ride along: a resume goes on from them.
    const rounds = earlier.agents.find((a) => a.origin === origin)?.rounds ?? []
    journal({ type: 'outstanding', key, n, ...(node && { node }), title, run, dispatchId, harness, sessionId, terminal, worktree, dir, origin, ...(continuations && { continuations }), ...(rounds.length && { round: rounds.at(-1).round, rounds }) })
  }
  // Every node an earlier run halted on, failed or needing decisions, as its
  // failed or result line, so a resume that stops before its call is made
  // still leaves it to the next one to carry on.
  for (const e of earlier.nodes.values()) {
    if (!e.failed && !e.needsDecision) continue
    const origin = e.last?.origin ?? e.origin
    const carried = { key: e.key, n: e.n, node: e.node, title: e.title, carried: true, ...(Number.isInteger(origin) && { origin }), ...(e.last && { worker: e.last }) }
    journal(e.failed ? { type: 'failed', ...carried, reason: e.reason ?? 'failed in an earlier run', attempts: 0 } : { type: 'result', ...carried, result: e.result, needsDecision: true })
  }
  // A patient's lines are the ones of its call or of its agent; its log lines
  // the ones the runner printed under its title, in this run or an earlier one.
  const history = ({ n, origin, title }) => {
    let log = []
    try {
      log = readFileSync(join(stateDir, 'runner.log'), 'utf8').split('\n').filter((l) => l.includes(` ${title}:`) || l.includes(` ${title} `))
    } catch {}
    return { entries: journalLines(journalPath).filter((e) => e.n === n || e.origin === origin), log }
  }
  // The script's role table, when it hands one over (meta.roles): a doctor is
  // started by the runner, not by an agent() call, so its role is read here,
  // and checked at the first agent(), before any worker, as agent() checks
  // its own launch: a bad row is refused up front, never at the first doctor.
  let recover = null
  const doctorLaunch = () => (recover ??= launchOf(meta.value?.roles?.recover ?? {}, permissionMode, 'the role table\'s recover row'))
  const life = agentLifecycle({
    host, clock, limits, out, stateDir, objective: () => objectiveOf(meta.value, fallbackObjective), journal, retainWorktree, onRun, takeOver: earlier.run?.runId ?? null, transcripts,
    nextN: () => ++count, doctorLaunch, history, outage, mailHandled: earlier.mail.map((m) => m.messageId),
    mailPending: earlier.mail.filter((m) => m.action === 'pending').map((m) => ({ id: m.messageId, type: m.kind, dispatchId: m.dispatchId, outcome: m.outcome ?? null, subject: m.subject, body: m.body })),
    chainBefore: chain ?? null,
  })

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
    // Refused here, before any worker, like an unsatisfiable schema; so is a
    // bad recover row, when the run has doctor rounds.
    const launch = launchOf(opts, permissionMode)
    if (limits.doctorRounds) doctorLaunch()
    const n = ++count
    const label = opts.label || `agent-${n}`
    const phaseName = opts.phase ?? currentPhase ?? 'Run'
    const title = `[${phaseName}] ${label}`
    const key = journalKey(prompt, opts)
    const node = typeof opts.node === 'string' && opts.node ? opts.node : null
    const replayed = (entry) => {
      // Its origin makes it the agent the journal already names, not another.
      journal({ type: 'result', key, n, ...(node && { node }), title, result: entry.result, replayed: true, ...(entry.origin != null && { origin: entry.origin }) })
      out(`<< ${title}: replayed from the journal`)
      return entry.result
    }

    let entry = null
    // A failed or needs-decision node of an earlier run, carried on.
    let carried = null
    if (node) {
      // By node (ADR-0016): a finished node replays wherever it falls. One
      // whose key changed runs live and ends replay for every later call, as
      // the prefix rule would.
      const e = earlier.nodes.get(node) ?? null
      if (e && e.key !== key) {
        if (nodeReplay) out(`>> ${title}: node ${node} changed since the last run; this call and every one after it run live`)
        nodeReplay = replaying = false
      } else if (e && nodeReplay && 'result' in e && !e.needsDecision) return replayed(e)
      else if (e && nodeReplay && (e.failed || e.needsDecision)) carried = e
      else if (e && (e.worker || nodeReplay)) entry = e
      else if (resume && nodeReplay) out(`>> ${title}: node ${node} is not in the journal; it runs live`)
    } else {
      // The k-th call with a key is the k-th journaled under it, so identical
      // calls each get their own; a failed entry keeps its place. One miss ends
      // the prefix for good: what follows a changed or failed call may depend
      // on it, however unchanged it reads. A call the last run left unsettled
      // gave the script nothing to depend on, so it leaves the prefix standing.
      const k = seen.get(key) ?? 0
      seen.set(key, k + 1)
      const cached = journaled.get(key)
      entry = cached && k < cached.length ? cached[k] : null
      if (replaying && entry && 'result' in entry) return replayed(entry)
      const unsettled = !!(entry?.worker || entry?.unsettled)
      if (replaying && !unsettled) {
        out(`>> ${title}: ${entry ? 'failed in the last run' : 'not in the journal'}; this call and every one after it run live`)
        replaying = false
      }
    }
    if (entry?.unsettled && !entry.held) out(`>> ${title}: its worker never started in the last run; it starts now`)

    const call = { prompt, schema: opts.schema, isolation: ['worktree', 'chain'].includes(opts.isolation) ? opts.isolation : 'none', launch, key, n, label, title, phaseName, ...(node && { node }) }
    // A patient's doctor rounds so far, and, while its agent() waited on
    // them, the round the resume goes on with: it is not started again.
    const treated = entry?.rounds ? { rounds: entry.rounds, ...(entry.held && { held: entry.held, origin: entry.held.origin }) } : {}
    // Its worker is its own whatever came before it: it runs this very call,
    // halted or not.
    if (entry?.worker) {
      aside.delete(entry.worker.worktree)
      return settle(call, await life({ ...call, ...treated, adopt: entry.worker }))
    }
    // While the run is halted, a new call waits, unless it is in flight.
    if (!opts.inFlight) await halt.gate(call)
    return settle(call, await (carried ? resumeNode(call, carried) : life({ ...call, ...treated })))
  }

  // What a call returns to the script. A node that failed, or whose result
  // needs decisions only the operator can make, is held instead, and the run
  // halts, until r carries it on (resumeNode); it returns once it succeeds.
  async function settle(call, value) {
    if (!call.node) return value
    let v = value
    let wasHeld = false
    for (;;) {
      const questions = v === null ? null : decisionsNeeded(v)
      if (v !== null && !questions) break
      wasHeld = true
      const reason = questions ? questions.join(' · ') : readJournal(journalPath).nodes.get(call.node)?.reason ?? 'it failed'
      await halt.hold({ node: call.node, title: call.title, needsDecision: !!questions, reason, ...(questions && { questions }) })
      v = await resumeNode(call, readJournal(journalPath).nodes.get(call.node) ?? {})
    }
    if (wasHeld) {
      // The worktree its failure retained is its agent's own again, reported.
      const worktree = readJournal(journalPath).nodes.get(call.node)?.last?.worktree
      const at = retained.findIndex((k) => k.path === worktree)
      if (at >= 0) retained.splice(at, 1)
      halt.settle(call.node)
    }
    return v
  }

  // A held node carried on (ADR-0016), as the journal names it (the fold's
  // nodes entry): the result.json its worker submitted after the run gave up
  // on it, validated again; else its session continued in its own worktree
  // and tab (carryHalted); else, if its worker never started, a fresh start.
  // A worker still out is taken up as a resume takes one up.
  async function resumeNode(call, e) {
    const { key, n, node, title, schema } = call
    if (e.worker) {
      aside.delete(e.worker.worktree)
      return life({ ...call, adopt: e.worker })
    }
    const last = e.last ?? null
    if (last?.dir) {
      const got = readResult(join(stateDir, last.dir, 'result.json'), schema)
      if (!got.error) {
        const questions = decisionsNeeded(got.value)
        if (questions) setAside(join(stateDir, last.dir, 'result.json'))
        journal({ type: 'result', key, n, node, title, result: got.value, ...(questions && { needsDecision: true }), ...(Number.isInteger(last.origin) && { origin: last.origin }), resumedFrom: 'result.json' })
        out(`<< ${title}: resuming node ${node}: took the result its worker submitted after the run gave up on it`)
        return got.value
      }
    }
    if (last?.sessionId && last.dispatchId) return life({ ...call, adopt: last, halted: { needsDecision: !!e.needsDecision } })
    out(`>> ${title}: resuming node ${node}: its worker never started, so it starts now`)
    return life({ ...call, startAgain: { made: [], dispatched: false, baseline: null } })
  }

  try {
    const value = await script(agent, parallel, phase, log, meta)
    // A doctor still out after its note carried its patient on ends first.
    await life.doctors()
    unclaimed()
    const result = withRetained(value, retained)
    if (armed) record('ended', { runId: armed, outcome: failures ? 'partial' : 'ok' })
    return result
  } catch (e) {
    await life.doctors().catch(() => {})
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

// A role's launch, from an agent() call's options or a role table row. A pi
// worker's model is `piModel`, never `model`: `model` stays a Claude model the
// Workflow runner can take, since it ignores the harness and runs every role
// on Claude. Both are in the call's journal key, as every option is. Throws
// for a harness or launch no worker can start with, naming `who`.
function launchOf(opts, permissionMode, who = 'agent()') {
  const harness = opts.harness ?? 'claude'
  if (!HARNESSES.includes(harness)) throw new Error(`${who}: unknown harness "${harness}": expected one of ${HARNESSES.join(', ')}`)
  const launch = { harness, model: harness === 'pi' ? opts.piModel : opts.model, effort: opts.effort, permissionMode: harness === 'claude' ? permissionMode : null }
  try {
    launchCommand(launch)
  } catch (e) {
    throw new Error(`${who}: ${e.message}`)
  }
  return launch
}

// summary.json for a run that threw, on the host `host` names: the error, and every worktree the runner
// retained because its agent died or never started, since the arming session
// reads this file and not the log.
export const failureSummary = (e, host) => ({ runner: 'session', host, ok: false, error: e?.stack ?? String(e), worktrees_kept: Array.isArray(e?.worktrees_kept) ? e.worktrees_kept : [] })

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

// The end of a run: summary.json, since the arming session waits for it and
// not for this tab, then the result in the log. Nothing is asked and nothing
// reclaimed: the operator reclaims from the run view (ADR-0012).
export function finish({ stateDir, summary, out }) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify(summary, null, 2))
  if (summary.ok) {
    out('== Result')
    out(JSON.stringify(summary.result, null, 2))
  }
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
//   tail()       runner.log's last lines
//   restore()    puts the tab back after a view exits, as a crashed one cannot
//   guard(on)    ignores a Ctrl-C that reaches the runner while a view lives:
//                one that dies outside raw mode lets Ctrl-C reach every
//                process on the console
//   resume(m)    the view's r, sent as {type: 'resume', node?}: probe the host
//                now during an outage, else resume the halted run's node, or
//                every held one (runScript's control.resume)
// Returns { start(), gate(print), closed, crashes() }. gate wraps a print so
// it reaches the tab only once no view is attached. closed resolves once no
// view is attached.
export function attachView({ spawnView, tab, log, tail = () => [], clock = realClock, limits = SETTINGS, restore = () => {}, guard = () => {}, resume = () => {} }) {
  let attached = true
  let crashes = 0
  let child = null
  let close
  const closed = new Promise((r) => {
    close = r
  })
  function fallBack(why) {
    attached = false
    child = null
    guard(false)
    for (const line of tail()) tab(line)
    log(`!! ${why}; the runner prints its log in this tab again`)
    close()
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
      if (m?.type === 'resume') Promise.resolve().then(() => resume({ node: typeof m.node === 'string' ? m.node : null })).catch((e) => log(`!! r: could not resume: ${e?.message ?? e}`))
    })
    c.on('exit', ended)
    c.on('error', (e) => {
      log(`!! the run view: ${e?.message ?? e}`)
      if (c.pid === undefined) ended(null, null)
    })
  }

  return {
    start() {
      guard(true)
      start()
    },
    gate: (print) => (s) => {
      if (!attached) print(s)
    },
    closed,
    crashes: () => crashes,
  }
}

// The tree's r reaches the runner as a file: the run console's tree is no
// child of the runner's, so it writes RESUME_REQUEST in the state dir
// ({ node }, node null for every held one) and the runner, polling, takes it
// (deletes it) and resumes as the attached view's IPC r does.
export function watchResumeRequests({ stateDir, resume, log = () => {}, pollMs = 1_000 }) {
  const file = join(stateDir, RESUME_REQUEST)
  const take = () => {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }
    rmSync(file, { force: true })
    let node = null
    try {
      const m = JSON.parse(text)
      node = typeof m?.node === 'string' ? m.node : null
    } catch {}
    Promise.resolve().then(() => resume({ node })).catch((e) => log(`!! r: could not resume: ${e?.message ?? e}`))
  }
  const timer = setInterval(take, pollMs)
  timer.unref?.()
  return { take, stop: () => clearInterval(timer) }
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

// realpathSync: a symlinked install (e.g. pi's ~/.pi/agent/skills entries) is
// still this file's main — resolve() would not dereference the link.
const isMain = process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) {
  let parsed = null
  try {
    parsed = parseFlags(process.argv.slice(2), { strings: ['--state-dir', '--permission-mode', '--host'], booleans: ['--resume'] })
  } catch {}
  const { values = {}, positionals = [] } = parsed ?? {}
  const resume = !!values['--resume']
  const stateDir = values['--state-dir'] ?? null
  const permissionMode = values['--permission-mode'] ?? null
  const hostName = values['--host']
  const [scriptPath] = positionals
  if (!parsed || !scriptPath || positionals.length > 1 || (hostName && !HOST_NAMES.includes(hostName))) {
    console.error(`usage: node runner.mjs <rendered-script.js> [--host <${HOST_NAMES.join('|')}>] [--state-dir <dir>] [--resume] [--permission-mode <orchestrator's Claude permission mode>]`)
    process.exit(2)
  }
  const path = resolve(scriptPath)
  const dir = stateDir ? resolve(stateDir) : join(dirname(path), 'orca-run')
  // The arming session reads the run's outcome from summary.json (SKILL.md
  // step 4); a stale one from an earlier run must never pass for this run's.
  // The session clears it before launch too; this is defence in depth.
  rmSync(join(dir, 'summary.json'), { force: true })
  // runner.pid lets the arming session tell a runner that died before writing
  // summary.json (killed, OOM) from one still running: the tab outlives the
  // runner, so the tab cannot say. Written before anything else can fail.
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runner.pid'), String(process.pid))
  const ignore = () => {}
  const control = {}
  // With no terminal (the offline tests, a redirected launch) there is no view,
  // and the runner prints as it always did. On crew there is none either: the
  // operator's one tree is `crew view`'s, and nobody enters the runner's session.
  const view = process.stdout.isTTY && process.stdin.isTTY && hostName !== 'crew'
    ? attachView({
      spawnView: () => spawn(process.execPath, [VIEW, '--attached', dir, '--host', hostName ?? LEGACY_HOST], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }),
      tab: (s) => console.log(s),
      log: (s) => say(s),
      tail: () => logTail(dir),
      restore: restoreTab,
      guard: (on) => (on ? process.on('SIGINT', ignore) : process.off('SIGINT', ignore)),
      resume: (m) => control.resume?.(m),
    })
    : null
  const gate = view ? view.gate : (print) => print
  const say = runnerLog(dir, gate((s) => console.log(s)))
  const sayError = runnerLog(dir, gate((s) => console.error(s)))
  view?.start()
  watchResumeRequests({ stateDir: dir, resume: (m) => control.resume?.(m), log: (s) => say(s) })
  const host = await openHost(hostName)
  // A halted run waits on its held promises alone, which keep no process
  // alive: this does, so the runner stays in its tab, halted, as the registry
  // says (ADR-0016).
  let halted = null
  let summary
  try {
    const result = await runScript(readFileSync(path, 'utf8'), {
      onHalt: () => {
        halted ??= setInterval(() => {}, 60_000)
      },
      host,
      stateDir: dir,
      out: gate((s) => console.log(s)),
      fallbackObjective: `workflow ${basename(path)}`,
      resume,
      permissionMode,
      registry: REGISTRY_PATH,
      script: path,
      control,
      // On crew the Run's terminal is this adapter's, not the runner's: the
      // operator enters the runner by its own session, which the daemon names.
      runnerTerminal: host.id === 'crew' ? process.env.CREW_SESSION ?? null : null,
    })
    summary = { runner: 'session', host: host.id, ok: true, result }
  } catch (e) {
    sayError(e?.stack ?? String(e))
    process.exitCode = 1
    summary = failureSummary(e, host.id)
  }
  clearInterval(halted)
  try {
    finish({ stateDir: dir, summary, out: say })
  } catch (e) {
    sayError(`!! could not write summary.json: ${e?.stack ?? e}`)
  }
  // The view stays on the ended run until the operator quits it: its reclaim
  // dialog is where the operator reclaims.
  await view?.closed
}
