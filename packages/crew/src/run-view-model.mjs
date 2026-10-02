// The run view's model and its actions (ADR-0012; design reference in
// docs/design/orca-run-view-tree.md), with no terminal in sight: a renderer
// draws `view.model` and hands each key or click to `view.key` / `view.click`.
// runView is one run's tree, the whole of attached mode; runsView is
// standalone mode, every run the registry knows, each opened into a runView.
// The model is read from the run's journal, its agents' session transcripts,
// Orca's terminal list and the run registry; the actions go to Orca, and a
// reclaim goes through reclaim.mjs, so the view keeps its rules.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'fs'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { sessionTranscripts } from './transcript.mjs'
import { pathKey, samePath } from './paths.mjs'
import { agentName, agentsOf, chainAgent, reclaimAgent, reclaimChainAfter, reclaimRun, runWorktree } from './reclaim.mjs'
import { foldJournal, journalLines, readJournal, timeOf } from './journal.mjs'
import { REGISTRY_PATH, readRegistry, runRegistry } from './registry.mjs'
import { worktreeUnpushed } from './git.mjs'
import { hostUnreachable } from './session-host.mjs'
import { isOrchestratorTitle } from './orchestrator.mjs'
import { haltNoticeOf, readTriage } from './triage.mjs'
import { RESUME_REQUEST } from './halt.mjs'
import { alreadyPaused, pauseRun, pausedAt, unpauseRun } from './pause.mjs'
import { leftOnDisk, removeRun } from './remove.mjs'
import { writeJsonAtomic } from './fsutil.mjs'
import { probesBy } from './outage.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'

export { RUNNER_PATH } from './daemon/runs.mjs'
import { RUNNER_PATH } from './daemon/runs.mjs'

// What every key that needs Orca says, and does nothing else, while Orca is
// not there (ADR-0015): the run's journal says an outage is under way, or the
// view's own call found Orca gone.
export const HOST_GONE = 'Orca unreachable — try again when it is back'

// In the order a phase row lists its mix. An agent's state is the journal
// fold's (journal.mjs), except reclaimed: one the registry records reclaimed.
export const STATES = Object.freeze(['blocked', 'needs you', 'starting', 'running', 'continued', 'stuck', 'failed', 'queued', 'done', 'reclaimed'])

// The problems a phase's pane lists, in row order: blocked and needs you
// first, since a human can answer them, then failed and stuck.
const problemsOf = (agents) => [...agents.filter((a) => a.state === 'blocked' || a.state === 'needs you'), ...agents.filter((a) => a.state === 'failed' || a.state === 'stuck')]

// Context size bands: green below 200k, yellow from 200k to 350k, red above.
export const bandOf = (context) => (context == null ? null : context < 200_000 ? 'green' : context <= 350_000 ? 'yellow' : 'red')

const TITLE = /^\[([^\]]*)\] ([\s\S]*)$/

// Every agent the journal names, by the fold reclaim and the runner's resume
// share (journal.mjs): one row per agent, its state its latest lifecycle
// entry's. An agent a resume carried forward or took up again is the one row,
// never a second one under the resumed run's call number. A failed attempt
// of a node that a later one superseded (journal.mjs) is no row either, but
// Reclaim All still takes it, with any worktree it was given. An orchestrator
// session (orchestrator.mjs) is never a row, whatever journal names one.
const agentsIn = (fold) => fold.agents.filter((a) => !isOrchestratorTitle(a.title)).map((a) => {
  const [, phase, label] = TITLE.exec(a.title ?? '') ?? [null, 'Run', a.title ?? `agent-${a.n}`]
  return { ...a, phase, label }
})

// A phase's agents in row order: each doctor right under its patient, in
// round order, though its n comes later; one whose patient is not in the
// phase stands on its own.
function treeOf(agents) {
  const byOrigin = new Map(agents.map((a) => [a.origin, a]))
  const rows = []
  const put = (agent, depth) => {
    rows.push({ agent, depth })
    for (const d of agent.doctors ?? []) if (byOrigin.get(d)?.patient === agent.origin) put(byOrigin.get(d), depth + 1)
  }
  for (const a of agents) if (a.patient == null || !byOrigin.has(a.patient)) put(a, 0)
  return rows
}

// The pid a run dir's runner.pid names; null with no such file, undefined when
// it could not be read.
export function runnerPid(stateDir) {
  try {
    const pid = Number(readFileSync(join(stateDir, 'runner.pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (e) {
    return e?.code === 'ENOENT' ? null : undefined
  }
}

// The one rule for whether a run's runner is alive, in both modes: the attached
// header, and the standalone row, its Ctrl+R and its r, all read this. It is whether
// the process <runDir>/runner.pid names is alive. The runner's tab outlives it
// (no `; exit`), so an open tab says nothing. false with no runner.pid, or one
// naming a gone process; null when it cannot be told (no run dir, a runner.pid
// that could not be read, or a probe that fails some other way).
export function runnerAlive(stateDir) {
  if (!stateDir) return null
  const pid = runnerPid(stateDir)
  if (pid === undefined) return null
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM' ? true : e?.code === 'ESRCH' ? false : null
  }
}

// Whether a run has ended, which is not whether its runner lives: once the
// script ends the runner writes summary.json and waits on its attached view
// until the operator quits it (runner.mjs), live all the while. `run` is its
// registry run, or null; `alive` its runner's liveness. It has ended when the
// registry records `ended` with no resume after (state is not 'running'),
// when its runner is gone (nothing runs the script), or when a live runner has
// written summary.json: the runner removes a stale one before it writes the
// runner.pid that names it live, so that one is this run's. A live runner with
// no summary.json is still running the script. null when it cannot be told:
// the runner's liveness unknown and no `ended` recorded, since a summary.json
// then may be an earlier run's.
// A halted run has not ended: its runner waits in its tab to carry it on.
export function runEnded({ run, alive, stateDir }) {
  if (run && run.state !== 'running' && run.state !== 'halted') return true
  if (alive === false) return true
  if (alive === true) return existsSync(join(stateDir, 'summary.json'))
  return null
}

// What an injected liveness answered, as true, false or null (does not know).
const livenessOf = (alive, stateDir) => {
  try {
    const v = alive(stateDir)
    return v === true || v === false ? v : null
  } catch {
    return null
  }
}

// The spec number in a run's name, which for the template is
// implement-spec-<number>, or null.
export const specNumber = (name) => /spec-(\d+)/.exec(name ?? '')?.[1] ?? null

// The last line of runner.log, its timestamp dropped: the run's latest event,
// for the flash line while the runner writes to its log alone (D5 on #43).
// Only the file's end is read, however long the log grows.
function latestEvent(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(size, 8192))
    readSync(fd, buf, 0, buf.length, size - buf.length)
    const line = buf.toString('utf8').trimEnd().split('\n').at(-1) ?? ''
    return line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '') || null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// view = runView({ stateDir, host, … }); await view.refresh() reads the run
// again, and view.model is then:
//   header  { name, project, runId, spec, alive, ended, elapsedMs, counts: {state: n}, outage },
//           ended being whether the run has ended (runEnded), null when it
//           cannot be told; outage the Orca outage its live runner is in, or
//           null: { phase: 'waiting' | 'paused', since, elapsedMs, probes },
//           probes being how many it has had by the outage settings
//   phases  [{ name, folded, done, total, mix: {state: n}, peakContext, agents }]
//   rows    [{ kind: 'phase', key, phase } | { kind: 'agent', key, agent, phase, depth }]:
//           the phases in the order the script's meta declares them (the
//           journal's `phases`), then any it does not declare in the order
//           their agents were called; each unfolded one followed by its
//           agents in call order (n), a doctor's row under its patient's at
//           depth 1 (else 0)
//   selected  the index of the selected row
//   selectedAt  clock.now() when the selection last moved to another row,
//           which the selected row's scrolling name counts from (draw.mjs)
//   pane    { kind: 'agent', agent } | { kind: 'phase', phase, problems: [{ agent, reason }] },
//           a phase's problems being its blocked, needs-you, failed and stuck agents
//   message the latest action's outcome, for the flash line, or null
//   latest  the last line of runner.log, the run's latest event, or null
//   alert   while any agent is blocked on a human, or a doctor needs you,
//           the line naming each one, its tab and what it waits on (a
//           doctor's escalation, its reason), which the flash line keeps over
//           `latest` until it is answered; else null
//   dialog  null, or what Ctrl+R opened, which takes every key and click until it
//           closes (the tree keeps refreshing behind it):
//           { kind: 'choose', title, options: [{ id, label, detail, disabled, reason }], highlight }
//             the reclaim dialog, its options in RECLAIM_OPTIONS order and
//             highlight the index of the one Enter takes
//           { kind: 'confirm', title, lines }
//             a reclaim refused until the operator confirms it with `f`
// An agent is { n, origin, label, title, phase, state, continuations, reason,
// replayed, launched, runId, dispatchId, harness, sessionId, worktree, terminal,
// waiting, nextAt, workerLeft, patient, round, doctors, tabOpen, reclaimed, context, band, tokens,
// elapsedMs, transcript }. state is one of STATES: reclaimed once the registry
// records it so, whatever it was before. worktree
// is only ever one named `<runId>-<n>`, or a sequential run's `<runId>-chain`
// its agents share: any other, the run's own checkout included, is the
// operator's and never shown. tabOpen
// is whether Orca's terminal list shows its tab, never what its worker's
// state says: Orca marks every tab the runner launched retained for good. It
// is null when the agent has no tab or the list could not be read. context,
// tokens and transcript are null until its transcript has them; elapsedMs is
// null for a call that never began here.
//
// clock.now() is the time elapsed is measured to; transcripts reads session
// transcripts (transcript.mjs); registry is the run registry's path, or null;
// unpushed(path) counts a worktree's unpushed commits; alive(stateDir) says
// whether the runner lives (runnerAlive), header.alive being null when it
// cannot say. resumeHost(): attached, what r does during an outage: it asks
// the runner to probe Orca at once. While an outage is under way, Enter on an
// agent, l and Ctrl+R say HOST_GONE and ask Orca nothing; an agent keeps its state.
// resumeHalted(node): attached, what r does on a halted run with no outage:
// it asks the runner to resume that node, or with null every held one.
// Enter on an agent, or a click, brings its tab to the front (focus), except
// on a host whose sessions are entered in place (host.inPlace, crew): there it
// answers { enter: { session, title } } for the renderer to enter, when the
// renderer can (`enter`: crew view's tree, the only view of a crew run).
// header.halted is the fold's halt, { since, nodes }, nodes being every node
// still failed or needing decisions, or null. model.halt is the run's
// halted.json while it has one, { at, nodes, triage }, triage being the halt
// triage question asked about that `at` (triage.mjs), or null while none is;
// `triage()`, when given, asks it, once per `at` this view sees, and is never
// waited on.
// How an ended run ended, from the summary.json its runner wrote (#157):
// { kind: 'complete' | 'halted' | 'failed', detail }, or null with none, as
// for a runner that died before it wrote one.
export function outcomeOf(stateDir) {
  let s
  try {
    s = JSON.parse(readFileSync(join(stateDir, 'summary.json'), 'utf8'))
  } catch {
    return null
  }
  if (!s || typeof s !== 'object') return null
  if (s.ok === false) return { kind: 'failed', detail: typeof s.error === 'string' ? s.error : null }
  const r = s.result && typeof s.result === 'object' ? s.result : {}
  if (r.halted === true) return { kind: 'halted', detail: typeof r.reason === 'string' ? r.reason : null }
  return { kind: 'complete', detail: typeof r.state === 'string' ? r.state : null }
}

// The agents of a run still at work: what a pause lets finish.
const AT_WORK = ['starting', 'running', 'continued', 'stuck', 'blocked', 'needs you']
const atWork = (agents) => agents.filter((a) => AT_WORK.includes(a.state))

export function runView({ stateDir, host, clock = { now: () => Date.now() }, transcripts = sessionTranscripts(), registry = REGISTRY_PATH, unpushed = worktreeUnpushed, alive = runnerAlive, resumeHost = null, resumeHalted = null, enter = false, triage = null, remove = null }) {
  const journalPath = join(stateDir, 'journal.jsonl')
  // name -> folded, only for phases the operator folded or unfolded.
  const folds = new Map()
  let phases = []
  // The superseded attempts: no row, but Reclaim All's.
  let superseded = []
  // A sequential run's chain worktree, as the journal names it: Reclaim All's
  // alone (ADR-0020), and null once the registry records it reclaimed.
  let chain = null
  let header = null
  let selectedKey = null
  let selected = 0
  // The row the selection was on at the last layout, and since when.
  let shown = { key: null, at: null }
  let message = null
  let latest = null
  let alert = null
  let logTab = null
  // null, { kind: 'choose', highlight }, or { kind: 'confirm', n, chain, title,
  // lines, confirm, queue }, chain true when it confirms the chain worktree's: queue holds the confirmations still to ask after
  // this one, each a reclaim's answer.
  let dialog = null
  let halt = null
  const triaged = new Set()
  const view = { model: null, refresh, key, click, highlight, focus, reclaim, openLog }

  const agentsNow = () => phases.flatMap((p) => p.agents)
  // A doctor is reclaimed with its patient, and never on its own (#77): a
  // reclaim that names a doctor reclaims its patient, then its doctors, and
  // one on its own only once its patient is reclaimed.
  const patientOf = (a) => (a.patient == null ? null : agentsNow().find((p) => p.origin === a.patient) ?? null)
  const doctorsOf = (a) => agentsNow().filter((d) => d.patient === a.origin && !d.reclaimed)
  const withPatient = (a) => {
    const p = patientOf(a)
    return p && !p.reclaimed ? p : a
  }
  const withDoctors = (n) => (n ? `, with ${n === 1 ? 'its doctor' : `its ${n} doctors`}` : '')
  function optionsFor(row) {
    const done = chosen('successful', row)
    const ended = header?.ended
    const one = row?.kind === 'agent' ? withPatient(row.agent) : null
    return [
      { id: 'selected', label: 'Reclaim Selected', detail: !row ? 'nothing is selected' : one ? `${one.title}${withDoctors(doctorsOf(one).length)}` : `every agent of ${row.phase.name}`, disabled: false, reason: null },
      { id: 'successful', label: 'Reclaim Successful Ones', detail: `the ${done.length} done${done.some((a) => doctorsOf(a).length) ? ', with their doctors' : ''}`, disabled: false, reason: null },
      { id: 'all', label: 'Reclaim All', detail: 'every agent of the run', disabled: ended !== true, reason: ended === true ? null : ended === false ? 'the run is still going' : 'whether the run has ended cannot be told' },
    ]
  }
  // What view.model.dialog is, with a highlight on a disabled option moved
  // to the first one enabled: Reclaim All disables itself until the run has
  // ended.
  function dialogModel(row) {
    if (!dialog) return null
    if (dialog.kind === 'confirm') return { kind: 'confirm', title: dialog.title, lines: dialog.lines }
    const options = optionsFor(row)
    if (options[dialog.highlight]?.disabled !== false) dialog.highlight = Math.max(0, options.findIndex((o) => !o.disabled))
    return { kind: 'choose', title: 'Reclaim', options, highlight: dialog.highlight }
  }

  function layout() {
    const rows = []
    for (const phase of phases) {
      phase.folded = folds.get(phase.name) ?? (phase.total > 0 && phase.agents.every((a) => a.state === 'done' || a.state === 'reclaimed'))
      rows.push({ kind: 'phase', key: `phase:${phase.name}`, phase })
      if (!phase.folded) for (const { agent, depth } of treeOf(phase.agents)) rows.push({ kind: 'agent', key: `agent:${agent.n}`, agent, phase, depth })
    }
    const at = rows.findIndex((r) => r.key === selectedKey)
    selected = at >= 0 ? at : Math.max(0, Math.min(selected, rows.length - 1))
    const row = rows[selected] ?? null
    selectedKey = row?.key ?? null
    if (shown.key !== selectedKey) shown = { key: selectedKey, at: clock.now() }
    const pane = !row ? null
      : row.kind === 'agent' ? { kind: 'agent', agent: row.agent }
      : { kind: 'phase', phase: row.phase, problems: problemsOf(row.phase.agents).map((agent) => ({ agent, reason: agent.reason })) }
    view.model = { header, phases, rows, selected, selectedAt: shown.at, pane, message, latest, alert, dialog: dialogModel(row), halt }
    return view.model
  }

  async function refresh() {
    const entries = journalLines(journalPath)
    latest = latestEvent(join(stateDir, 'runner.log'))
    const fold = foldJournal(entries)
    const every = agentsIn(fold)
    const agents = every.filter((a) => !a.superseded)
    const now = clock.now()
    // A resume journals the Run it takes over before any agent.
    const runId = fold.run?.runId ?? [...agents].reverse().find((a) => a.runId)?.runId ?? null
    let run = null
    if (registry) {
      try {
        const runs = readRegistry(registry)
        run = (runId && runs.find((r) => r.runId === runId)) || runs.filter((r) => samePath(r.runDir, stateDir)).at(-1) || null
      } catch {}
    }
    chain = fold.chain && !run?.reclaimed && !run?.chainReclaimed ? fold.chain : null
    let open = null
    let parked = null
    if (every.some((a) => a.terminal)) {
      try {
        open = new Set(await host.terminalList())
        // Only crew parks a session (ADR-0024); any other host has none.
        parked = new Set((await host.terminalsParked?.()) ?? [])
      } catch {}
    }
    const reclaimedNames = new Set(run?.reclaimedAgents?.map((r) => r.agent) ?? [])
    for (const a of every) {
      const usage = a.sessionId ? transcripts.usage({ harness: a.harness, sessionId: a.sessionId, worktree: a.worktree }) : null
      const reclaimed = !!a.runId && (run?.reclaimed === true || reclaimedNames.has(agentName(a)))
      Object.assign(a, {
        ...(reclaimed && { state: 'reclaimed' }),
        worktree: runWorktree(a),
        tabOpen: a.terminal && open ? open.has(a.terminal) : null,
        parked: !!(a.terminal && parked?.has(a.terminal)),
        reclaimed,
        context: usage?.context ?? null,
        band: bandOf(usage?.context),
        tokens: usage?.tokens ?? null,
        transcript: usage?.path ?? null,
        elapsedMs: a.from === null ? null : Math.max(0, (a.to ?? now) - a.from),
      })
    }

    superseded = every.filter((a) => a.superseded)
    const blocked = agents.filter((a) => a.state === 'blocked')
    const needed = agents.filter((a) => a.state === 'needs you')
    alert = [
      blocked.length && `BLOCKED ON A HUMAN: ${blocked.map((a) => `${a.title} in tab ${a.terminal ?? '—'} waits on ${a.waiting ?? 'an answer'}`).join(' · ')}`,
      needed.length && `NEEDS YOU: ${needed.map((a) => `${a.title} in tab ${a.terminal ?? '—'}: ${a.reason ?? 'no reason given'}`).join(' · ')}`,
    ].filter(Boolean).join(' · ') || null

    // A resume journals its carried lines before the calls it replays, so
    // the order lines come in is no phase order: the script's is, and one it
    // does not declare follows, as its first agent was called. The fold's
    // agents are in call order.
    const byPhase = new Map()
    for (const a of [...agents].sort((x, y) => x.n - y.n)) {
      if (!byPhase.has(a.phase)) byPhase.set(a.phase, [])
      byPhase.get(a.phase).push(a)
    }
    const declared = fold.phases ?? []
    const rank = (name) => (declared.includes(name) ? declared.indexOf(name) : declared.length)
    const countOf = (list) => Object.fromEntries(STATES.map((s) => [s, list.filter((a) => a.state === s).length]))
    phases = [...byPhase].sort(([x], [y]) => rank(x) - rank(y)).map(([name, list]) => {
      const contexts = list.map((a) => a.context).filter((c) => c != null)
      return { name, folded: false, done: list.filter((a) => a.state === 'done').length, total: list.length, mix: countOf(list), peakContext: contexts.length ? Math.max(...contexts) : null, agents: list }
    })

    const isAlive = livenessOf(alive, stateDir)
    // An outage a dead runner journaled is no one's any more.
    const since = fold.outage && isAlive !== false ? Date.parse(fold.outage.since) : NaN
    const lasted = Number.isFinite(since) ? Math.max(0, now - since) : null
    const outage = lasted === null ? null : { ...fold.outage, elapsedMs: lasted, probes: probesBy(lasted, RUNNER_SETTINGS) }
    const times = entries.map(timeOf).filter((t) => t !== null)
    const armedAt = run?.armedAt ? Date.parse(run.armedAt) : NaN
    const start = Number.isFinite(armedAt) ? armedAt : times.length ? Math.min(...times) : null
    const endedAt = run?.endedAt ? Date.parse(run.endedAt) : NaN
    const end = isAlive ? now : Number.isFinite(endedAt) ? endedAt : times.length ? Math.max(...times) : now
    // The registry's `spec` is the name the script's meta declared.
    const name = run?.spec ?? null
    const number = specNumber(name)
    header = {
      name,
      project: run?.project ? basename(run.project) : null,
      runId: runId ?? run?.runId ?? null,
      spec: number ? `#${number}` : null,
      alive: isAlive,
      ended: runEnded({ run, alive: isAlive, stateDir }),
      elapsedMs: start === null ? null : Math.max(0, end - start),
      counts: countOf(agents),
      outage,
      halted: fold.halted ? { since: fold.halted.since, nodes: fold.halted.nodes } : null,
      paused: pausedAt(stateDir) ? { finishing: atWork(agents).length } : null,
      outcome: isAlive === true ? null : outcomeOf(stateDir),
    }
    const notice = haltNoticeOf(stateDir)
    if (notice && triage && !triaged.has(notice.at)) {
      triaged.add(notice.at)
      triage()
    }
    halt = notice ? { at: notice.at, nodes: notice.nodes.map((n) => n.node), triage: readTriage(stateDir, notice.at, now) } : null
    return layout()
  }

  const say = (text) => {
    message = text
    layout()
    return { message: text }
  }
  const current = () => view.model?.rows[selected] ?? null
  const hostAway = () => header?.outage != null

  function toggle(phase) {
    folds.set(phase.name, !phase.folded)
    layout()
    return { folded: phase.name, now: view.model.phases.find((p) => p.name === phase.name)?.folded }
  }

  // Brings the agent's tab, and its worktree, to the front in Orca.
  async function focus(agent) {
    if (!agent.terminal) return say(`${agent.title} has no tab: its worker never started here`)
    if (hostAway()) return say(HOST_GONE)
    try {
      await host.terminalSwitch({ terminal: agent.terminal })
      message = null
      layout()
      return { switched: agent.terminal }
    } catch (e) {
      if (hostUnreachable(host, e)) return say(HOST_GONE)
      return say(`could not focus ${agent.title}'s tab ${agent.terminal}: ${e?.message ?? e}`)
    }
  }

  function enterSession(session, title, open) {
    if (hostAway()) return say(HOST_GONE)
    if (open === false) return say(`${title}'s crew session ${session} is closed`)
    if (!enter) return say(`${title} runs in crew session ${session}: enter it from \`crew view ${header?.runId ?? stateDir}\``)
    message = null
    layout()
    return { enter: { session, title } }
  }
  const enterAgent = (agent) => (agent.terminal ? enterSession(agent.terminal, agent.title, agent.tabOpen) : say(`${agent.title} has no session: its worker never started here`))

  const activate = (row) => (!row ? {} : row.kind === 'phase' ? toggle(row.phase) : host?.inPlace ? enterAgent(row.agent) : focus(row.agent))

  // One agent's reclaim through reclaim.mjs, as the journal names it for
  // reclaim, recorded in the registry once done: reclaimAgent's answer, or
  // null for an agent that launched nothing in this run.
  async function attempt(a, { force = false, stop = false } = {}) {
    const agent = agentsOf(journalPath).find((x) => x.origin === a.origin)
    if (!agent) return null
    let r
    try {
      r = await reclaimAgent(agent, { host, unpushed, force, stop })
    } catch (e) {
      r = { reclaimed: false, reason: e?.message ?? String(e) }
    }
    if (r.reclaimed && registry) {
      try {
        runRegistry(registry, clock).reclaimed({ runId: agent.runId, agent: agent.name })
      } catch (e) {
        r.notes.push(`the run registry did not record it: ${e?.message ?? e}`)
      }
    }
    return r
  }

  // `a`'s reclaim, then, once it is reclaimed or had nothing to reclaim, each
  // of its doctors': { r, doctors: { reclaimed, kept } }, each doctor as
  // { agent: { n, title }, reclaim }. Its doctors are kept while it is.
  async function withItsDoctors(a, opts = {}) {
    const r = await attempt(a, opts)
    const doctors = { reclaimed: [], kept: [] }
    for (const d of doctorsOf(a)) {
      const target = { n: d.n, title: d.title }
      if (r && !r.reclaimed) {
        doctors.kept.push({ agent: target, reclaim: { reclaimed: false, reason: `its patient ${a.title} was kept` } })
        continue
      }
      const dr = await attempt(d)
      if (dr) (dr.reclaimed ? doctors.reclaimed : doctors.kept).push({ agent: target, reclaim: dr })
    }
    return { r, doctors }
  }

  // Reclaims agent `n`, or with no `n` the selected one, by the reclaim rules:
  // refused while it is live, or while its worktree holds unpushed commits
  // unless `force`. One that failed and was kept with its worker running is
  // refused as `stoppable` unless `stop`, which stops that worker first: both
  // are what the operator confirms with `f` in the dialog, never the choice
  // alone. What it answers names the agent as `agent: { n, title }`, so a
  // confirmed retry goes to the agent refused, never to whatever row the
  // selection sits on by then: a refresh that folds its phase moves it.
  async function reclaim({ n, force = false, stop = false } = {}) {
    if (hostAway()) return say(HOST_GONE)
    let a
    if (n === undefined) {
      const row = current()
      if (row?.kind !== 'agent') return say('select an agent to reclaim')
      a = row.agent
    } else {
      a = [...agentsNow(), ...superseded].find((x) => x.n === n)
      if (!a) return say(`no agent ${n} in this run to reclaim`)
    }
    a = withPatient(a)
    const target = { n: a.n, title: a.title }
    const family = doctorsOf(a).length > 0
    const { r, doctors } = await withItsDoctors(a, { force, stop })
    const also = family ? { doctors: { reclaimed: doctors.reclaimed.map((d) => d.agent), kept: doctors.kept } } : {}
    if (r && !r.reclaimed) return { ...say(r.unreachable ? HOST_GONE : `kept ${a.title}: ${r.reason}`), reclaim: r, agent: target, ...also }
    if (!r && !doctors.reclaimed.length && !doctors.kept.length) return { ...say(`${a.title} has nothing to reclaim: it launched nothing in this run`), agent: target }
    if (r || doctors.reclaimed.length) await refresh()
    const notes = [
      ...(r?.notes ?? []),
      ...doctors.reclaimed.flatMap(({ agent, reclaim: dr }) => dr.notes.map((note) => `${agent.title}: ${note}`)),
      ...doctors.kept.map(({ agent, reclaim: dr }) => `kept ${agent.title}: ${dr.reason}`),
    ]
    const what = r ? a.title : `${a.title}'s doctors`
    return { ...say(`reclaimed ${what}${withDoctors(r ? doctors.reclaimed.length : 0)}${notes.length ? `; ${notes.join('; ')}` : ''}`), reclaim: r, agent: target, ...also }
  }

  // Reclaim All's last step on a sequential run: its chain worktree, by the
  // one rule for it (reclaimChainAfter), `kept` the agents this reclaim kept,
  // as `reclaim` answers for an agent.
  async function reclaimTheChain(kept, { force = false } = {}) {
    const target = chainAgent(chain)
    let r
    try {
      r = await reclaimChainAfter(kept, chain, { host, journaled: agentsOf(journalPath), unpushed, force, registry: registry && runRegistry(registry, clock) })
    } catch (e) {
      r = { reclaimed: false, reason: e?.message ?? String(e) }
    }
    if (!r.reclaimed) return { ...say(r.unreachable ? HOST_GONE : `kept ${target.title}: ${r.reason}`), reclaim: r, agent: target }
    await refresh()
    return { ...say(`reclaimed ${target.title}${r.notes.length ? `; ${r.notes.join('; ')}` : ''}`), reclaim: r, agent: target }
  }

  // The confirmation a refused reclaim `res` asks for, as the dialog, or null:
  // `f` stops the worker of an agent kept running when it failed (stop), or
  // removes a worktree that holds unpushed commits (force). `confirmed` is
  // what `f` already confirmed for this agent, so a stopped agent whose
  // worktree is then refused for its commits asks again, for that.
  function confirmationOf(res, confirmed = {}) {
    const r = res?.reclaim
    if (!res?.agent || !r || r.reclaimed) return null
    const about = { kind: 'confirm', n: res.agent.n, chain: res.agent.chain === true, title: `Reclaim ${res.agent.title}?` }
    if (r.stoppable && !confirmed.stop) return { ...about, confirm: { ...confirmed, stop: true }, lines: [r.reason, '', 'f = stop its worker, then reclaim it · any other key cancels'] }
    if (r.unpushed > 0 && !confirmed.force) return { ...about, confirm: { ...confirmed, force: true }, lines: [r.reason, '', 'f = force the reclaim, and those commits are lost · any other key cancels'] }
    return null
  }
  // Remove (x): the run removed by remove.mjs, each worktree it kept for its
  // unpushed commits offered for a force-delete, one at a time; then the run
  // forgotten, naming whatever was left on disk.
  const removeHere = () => removeRun({ stateDir, runId: header?.runId ?? null, host, registry: registry && runRegistry(registry, clock), unpushed })
  function forceNext(handle, queue) {
    const [k, ...rest] = queue
    if (k) {
      dialog = { kind: 'confirm', act: 'force', handle, k, queue: rest, title: `Force-delete ${k.worktree ?? k.agent.title}?`, lines: [k.reason, '', 'f = force-delete it, and those commits are lost · any other key keeps it'] }
      layout()
      return say(`${k.agent.title}: its worktree holds unpushed commits`)
    }
    const { left } = handle.finish()
    layout()
    return { ...say(`removed the run${leftOnDisk(left)}`), removed: true }
  }

  // The first of `queue` that asks for a confirmation, holding the rest.
  function nextConfirmation(queue) {
    for (let i = 0; i < queue.length; i++) {
      const d = confirmationOf(queue[i])
      if (d) return { ...d, queue: queue.slice(i + 1) }
    }
    return null
  }

  // The agents an option names, none already reclaimed, and no doctor whose
  // patient is not: its patient's reclaim takes it.
  function chosen(id, row) {
    const list = id === 'selected' ? (row.kind === 'agent' ? [withPatient(row.agent)] : row.phase.agents) : id === 'successful' ? agentsNow().filter((a) => a.state === 'done') : [...agentsNow(), ...superseded]
    return list.filter((a) => !a.reclaimed && withPatient(a) === a)
  }

  // Enter in the reclaim dialog: every agent the highlighted option names, one
  // at a time, by the reclaim rules; each one refused for a reason the
  // operator may confirm is then asked about, one confirmation at a time.
  async function accept() {
    const row = current()
    const option = optionsFor(row)[dialog.highlight]
    dialog = null
    if (option.disabled) return say(`${option.label} is not available: ${option.reason}`)
    if (option.id === 'selected' && !row) return say('select an agent or a phase to reclaim')
    const what = option.id === 'selected' ? (row.kind === 'agent' ? row.agent.title : row.phase.name) : option.id === 'successful' ? 'the done agents' : 'the run'
    if (option.id === 'selected' && row.kind === 'agent') {
      const res = await reclaim({ n: row.agent.n })
      dialog = nextConfirmation([res, ...(res.doctors?.kept ?? [])])
      layout()
      return { ...res, option: option.id }
    }
    const list = chosen(option.id, row)
    const withChain = option.id === 'all' && !!chain
    if (!list.length && !withChain) return { ...say(`${what}: no agent left to reclaim`), option: option.id, reclaimed: [], kept: [] }
    const total = list.reduce((n, a) => n + 1 + doctorsOf(a).length, 0)
    const reclaimed = []
    const kept = []
    const notes = []
    const put = (target, r) => {
      if (r.reclaimed) {
        reclaimed.push(target)
        for (const note of r.notes) notes.push(`${target.title}: ${note}`)
      } else kept.push({ agent: target, reclaim: r })
    }
    for (const a of list) {
      const { r, doctors } = await withItsDoctors(a)
      if (r) put({ n: a.n, title: a.title }, r)
      for (const { agent, reclaim: dr } of [...doctors.reclaimed, ...doctors.kept]) put(agent, dr)
    }
    // The chain goes last.
    let chainGone = null
    if (withChain) {
      const res = await reclaimTheChain(kept)
      if (!res.reclaim.reclaimed) kept.push({ agent: res.agent, reclaim: res.reclaim })
      else {
        chainGone = res.agent
        for (const note of res.reclaim.notes) notes.push(`${res.agent.title}: ${note}`)
      }
    }
    if (reclaimed.length) await refresh()
    dialog = nextConfirmation(kept)
    const asked = kept.filter((k) => confirmationOf(k)).length
    const text = kept.some((k) => k.reclaim.unreachable) ? `${HOST_GONE}; reclaimed ${reclaimed.length} of ${total} before it went` : [
      `reclaimed ${reclaimed.length} of ${total} agent${total === 1 ? '' : 's'} of ${what}`,
      ...(chainGone ? [`removed ${chainGone.title}`] : []),
      ...kept.filter((k) => !confirmationOf(k)).map(({ agent, reclaim: r }) => `kept ${agent.title}: ${r.reason}`),
      ...(asked ? [`${asked} to confirm`] : []),
      ...notes,
    ].join('; ')
    return { ...say(text), option: option.id, reclaimed, kept: kept.map(({ agent, reclaim: r }) => ({ agent, reason: r.reason })) }
  }

  // A key while the dialog is open: the tree takes none.
  async function dialogKey(name) {
    if (dialog.act === 'remove') {
      dialog = null
      if (name !== 'y') return say('nothing removed')
      const handle = await (remove ?? removeHere)()
      return forceNext(handle, handle.kept.filter((k) => k.unpushed > 0))
    }
    if (dialog.act === 'force') {
      const { handle, k, queue } = dialog
      dialog = null
      if (name === 'f') await handle.force(k)
      return forceNext(handle, queue)
    }
    if (dialog.kind === 'confirm') {
      const { n, chain: ofChain, confirm, queue, title } = dialog
      dialog = null
      if (name !== 'f') {
        dialog = nextConfirmation(queue)
        return say(`${title.replace(/^Reclaim (.*)\?$/, '$1')}: reclaim cancelled`)
      }
      const res = ofChain ? await reclaimTheChain([], confirm) : await reclaim({ n, ...confirm })
      const again = confirmationOf(res, confirm)
      dialog = again ? { ...again, queue: [...(res.doctors?.kept ?? []), ...queue] } : nextConfirmation([...(res.doctors?.kept ?? []), ...queue])
      layout()
      return res
    }
    const options = optionsFor(current())
    switch (name) {
      case 'UP':
      case 'DOWN': {
        const step = name === 'UP' ? -1 : 1
        for (let i = dialog.highlight + step; i >= 0 && i < options.length; i += step) {
          if (!options[i].disabled) {
            dialog.highlight = i
            break
          }
        }
        layout()
        return {}
      }
      case 'ENTER':
        return accept()
      case 'ESCAPE':
        dialog = null
        return say('nothing reclaimed')
      default:
        return {}
    }
  }

  // The mouse on option `index` of the reclaim dialog, hovering or clicking:
  // it moves the highlight there, unless that option is disabled. Only Enter
  // accepts.
  function highlight(index) {
    if (dialog?.kind !== 'choose') return {}
    if (optionsFor(current())[index]?.disabled === false) dialog.highlight = index
    layout()
    return {}
  }

  // runner.log in a tab of its own that follows it (host.logTail): Orca's
  // editor opens no file outside a worktree, and the run dir is outside every
  // checkout. While that tab is open, `l` again brings it back.
  // In crew view's tree the log is a session like an agent's: entered at
  // once, and closed once left.
  async function openLog() {
    if (hostAway()) return say(HOST_GONE)
    const path = join(stateDir, 'runner.log')
    if (!existsSync(path)) return say(`could not open ${path}: the runner has not written it yet`)
    if (enter && host?.inPlace) {
      try {
        const { terminal } = await host.logTail({ path, title: 'runner.log' })
        message = null
        layout()
        return { enter: { session: terminal, title: 'runner.log', close: true } }
      } catch (e) {
        if (hostUnreachable(host, e)) return say(HOST_GONE)
        return say(`could not open ${path}: ${e?.message ?? e}`)
      }
    }
    if (logTab) {
      try {
        await host.terminalSwitch({ terminal: logTab })
        return say(`switched to the tab following ${path}`)
      } catch (e) {
        if (hostUnreachable(host, e)) return say(HOST_GONE)
        logTab = null
      }
    }
    try {
      logTab = (await host.logTail({ path, title: 'runner.log' })).terminal
      return say(`opened ${path} in a tab that follows it`)
    } catch (e) {
      if (hostUnreachable(host, e)) return say(HOST_GONE)
      return say(`could not open ${path}: ${e?.message ?? e}`)
    }
  }

  // r, attached: the runner probes Orca at once during an outage, and carries
  // on if Orca answers (runner.mjs). Else, on a halted run (ADR-0016), it
  // resumes the selected node when that failed or needs you, or every held
  // node; both go over the one channel to the runner.
  function askResume() {
    if (hostAway()) {
      resumeHost?.()
      return say('asked the runner to probe Orca now: it carries on at once if Orca answers')
    }
    const halted = header?.halted
    if (!halted || !resumeHalted) return say('Orca is there and the run is not halted: nothing to resume')
    const a = current()?.kind === 'agent' ? current().agent : null
    const node = a?.node && halted.nodes.includes(a.node) ? a.node : null
    resumeHalted(node)
    return say(node ? `asked the runner to resume ${node}` : `asked the runner to resume every held node: ${halted.nodes.join(', ') || 'none left'}`)
  }

  // Key names as terminal-kit gives them. Returns what the key did: { quit }
  // for q, which ends the view only, never the run. While the dialog is open
  // every key is its.
  async function key(name) {
    if (dialog) return dialogKey(name)
    const rows = view.model?.rows ?? []
    switch (name) {
      case 'UP':
      case 'DOWN':
        if (rows.length) {
          selected = Math.max(0, Math.min(rows.length - 1, selected + (name === 'UP' ? -1 : 1)))
          selectedKey = rows[selected].key
          layout()
        }
        return {}
      case 'ENTER':
        return activate(current())
      // Right goes in: it unfolds a folded phase and enters (or, on Orca,
      // focuses) an agent, as Enter does. Left folds an unfolded phase; in a
      // run list's tree (runsView) Left goes back to the list before this.
      case 'RIGHT': {
        const row = current()
        if (row?.kind === 'phase') return row.phase.folded ? toggle(row.phase) : {}
        return row?.kind === 'agent' ? activate(row) : {}
      }
      case 'LEFT': {
        const row = current()
        return row?.kind === 'phase' && !row.phase.folded ? toggle(row.phase) : {}
      }
      case 'CTRL_R':
        if (hostAway()) return say(HOST_GONE)
        dialog = { kind: 'choose', highlight: 0 }
        layout()
        return {}
      case 'l':
        return openLog()
      case 'p': {
        if (!pauseRun(stateDir, new Date(clock.now()))) return say(alreadyPaused('r'))
        const n = atWork(agentsNow()).length
        await refresh()
        return say(`paused: no new agent starts; ${n} agent${n === 1 ? ' is' : 's are'} finishing`)
      }
      case 'r':
        if (unpauseRun(stateDir)) {
          if (header?.halted && resumeHalted) askResume()
          await refresh()
          return say('resumed: the agents held by the pause start')
        }
        return resumeHost || resumeHalted ? askResume() : {}
      case 'x':
        dialog = { kind: 'confirm', act: 'remove', title: `Remove run ${header?.runId ?? ''}?`, lines: ['Stops its runner and every agent, reclaims its worktrees (one holding unpushed commits is asked about), forgets the run and deletes its folder. Its PRs on GitHub stay.', '', 'y = remove it · any other key cancels'] }
        layout()
        return {}
      case 'q':
        return { quit: true }
      default:
        return {}
    }
  }

  // A click on row `index` selects it and does what Enter would; none while
  // the dialog is open.
  async function click(index) {
    if (dialog) return {}
    const row = view.model?.rows[index]
    if (!row) return {}
    selected = index
    selectedKey = row.key
    layout()
    return activate(row)
  }

  return view
}

// runs = runsView({ host, … }); await runs.refresh() reads the registry again,
// and runs.model is then:
//   projects  [{ key, name, path, folded, runs }], the project of the latest
//             run first, each project's runs latest first
//   rows      [{ kind: 'project', key, project } | { kind: 'run', key, run, project }]
//   selected  the index of the selected row
//   message   the latest action's outcome, or null
//   opened    { runId, view }: the run Enter opened, as a runView, or null
// A run is { runId, name, spec, project, runDir, script, permissionMode,
// terminal, outcome, paused, alive, kept, reclaimed, closable, armedAt, ageMs,
// resumable }. outcome is ok, partial or failed, halted while its runner has
// halted it (ADR-0016), or null while no `ended` is recorded; paused is the registry's { reason, at } while its runner has
// paused it (an Orca outage past its limit), else null. alive is runnerAlive's answer for its run dir, the rule attached
// mode's header reads too: whether the process its runner.pid names is alive,
// never whether its tab is open, since the tab outlives the runner. Just after
// r, until the new runner has written its own runner.pid, the tab r opened
// counts as the runner while Orca's terminal list shows it. null when it
// cannot be told. kept counts the agents its journal names that are not reclaimed.
// closable is whether Ctrl+R may record the whole run reclaimed: only once its
// runner is known dead, ended or not, since nothing undoes that record and a
// live runner may start more agents; a dead one starts none, and r refuses a
// reclaimed run. r resumes a run only when it is resumable: alive being
// false, and the run not reclaimed.
//
// Only the registry's runs are listed, so a worktree no run made never is.
// Read, stop and release are not fenced to a Run's coordinator, so a reclaim
// needs no takeover. runner is the runner.mjs a resume runs. A run is on the
// host the registry names (run.host), and hostOf(name) is that host, which
// its tree, its reclaim and its resume go to: `host`, for every run, by
// default. orchestrator, when given, is the orchestrator's two console uses
// (arm.mjs runOrchestrator): an opened run's halt is triaged, and `?` on it
// answers { enter: { session, close } } for a fresh orchestrator session the
// renderer enters and closes on leaving it. The rest is as runView's.
export function runsView({ host, hostOf = () => host, clock = { now: () => Date.now() }, registry = REGISTRY_PATH, transcripts = sessionTranscripts(), unpushed = worktreeUnpushed, alive = runnerAlive, runner = RUNNER_PATH, enter = false, orchestrator = null }) {
  const folds = new Map()
  // runId -> { host, terminal, pid, starting }: the tab r opened, and the runner.pid
  // its run dir held then. While that file is unchanged the new runner has not
  // written its own, so the tab stands for it; once it has, the pid decides.
  const launched = new Map()
  // The registry's runs and each host's terminal list, as the last refresh read them.
  let recorded = new Map()
  let lastOpen = new Map()
  const liveOf = (r, open) => {
    const l = launched.get(r.runId)
    if (l?.starting && r.runDir) {
      const tabs = open.get(l.host) ?? null
      if (runnerPid(r.runDir) === l.pid) return tabs === null ? null : tabs.has(l.terminal) ? true : livenessOf(alive, r.runDir)
      l.starting = false
    }
    return r.runDir ? livenessOf(alive, r.runDir) : null
  }
  let projects = []
  let selectedKey = null
  let selected = 0
  let message = null
  let opened = null
  const runs = { model: null, refresh, key, click, open, reclaim, resume, opened: () => opened?.view ?? null }

  function layout() {
    const rows = []
    for (const project of projects) {
      project.folded = folds.get(project.key) ?? false
      rows.push({ kind: 'project', key: `project:${project.key}`, project })
      if (!project.folded) for (const run of project.runs) rows.push({ kind: 'run', key: `run:${run.runId}`, run, project })
    }
    selectedKey ??= rows.find((r) => r.kind === 'run')?.key ?? null
    const at = rows.findIndex((r) => r.key === selectedKey)
    selected = at >= 0 ? at : Math.max(0, Math.min(selected, rows.length - 1))
    selectedKey = rows[selected]?.key ?? null
    runs.model = { projects, rows, selected, message, opened }
    return runs.model
  }

  async function refresh() {
    let entries = []
    try {
      entries = readRegistry(registry)
    } catch (e) {
      message = `could not read the run registry ${registry}: ${e?.message ?? e}`
    }
    // A host's terminal list is read only for a tab r opened on it whose
    // runner has not written its runner.pid yet.
    const open = new Map()
    for (const name of new Set([...launched.values()].filter((l) => l.starting).map((l) => l.host))) {
      try {
        open.set(name, new Set(await hostOf(name).terminalList()))
      } catch {}
    }
    lastOpen = open
    recorded = new Map(entries.map((r) => [r.runId, r]))
    const now = clock.now()
    const byProject = new Map()
    for (const r of entries) {
      const done = new Set(r.reclaimedAgents.map((a) => a.agent))
      const agents = r.runDir ? agentsOf(join(r.runDir, 'journal.jsonl')).filter((a) => a.runId === r.runId) : []
      const live = liveOf(r, open)
      const armedAt = Date.parse(r.armedAt)
      const number = specNumber(r.spec)
      const run = {
        runId: r.runId, host: r.host, name: r.spec, spec: number ? `#${number}` : null, project: r.project, runDir: r.runDir,
        script: r.script, permissionMode: r.permissionMode, terminal: launched.get(r.runId)?.terminal ?? r.runner?.terminal ?? null,
        outcome: r.state === 'running' ? null : r.state, outagePaused: r.state === 'running' ? r.paused ?? null : null, operatorPaused: !!r.runDir && pausedAt(r.runDir), alive: live, reclaimed: r.reclaimed,
        kept: r.reclaimed ? 0 : agents.filter((a) => !done.has(a.name)).length,
        closable: !r.reclaimed && live === false,
        armedAt: Number.isFinite(armedAt) ? armedAt : null, ageMs: Number.isFinite(armedAt) ? Math.max(0, now - armedAt) : null, resumable: live === false && !r.reclaimed,
      }
      const key = r.project ? pathKey(r.project) : ''
      if (!byProject.has(key)) byProject.set(key, { key, name: r.project ? basename(r.project) : '(no project)', path: r.project, folded: false, runs: [] })
      byProject.get(key).runs.push(run)
    }
    const newest = (run) => run.armedAt ?? -Infinity
    for (const p of byProject.values()) p.runs.sort((a, b) => newest(b) - newest(a))
    projects = [...byProject.values()].sort((a, b) => newest(b.runs[0]) - newest(a.runs[0]))
    if (opened) await opened.view.refresh()
    return layout()
  }

  const say = (text) => {
    message = text
    layout()
    return { message: text }
  }
  const current = () => runs.model?.rows[selected] ?? null
  const runOf = (runId) => projects.flatMap((p) => p.runs).find((r) => r.runId === runId) ?? null
  const labelOf = (run) => `${run.name ?? 'run'} ${run.runId}`
  const where = (run, terminal = run.terminal) => (run.host === 'crew' ? `crew session ${terminal}` : `tab ${terminal}`)

  // Enter on a run: its tree, the one attached mode shows.
  async function open(runId) {
    const run = runOf(runId)
    if (!run) return say(`no run ${runId} in the run registry`)
    if (!run.runDir) return say(`${labelOf(run)} has no run directory recorded`)
    // The tree's header asks what the run's row asks, by the same rule.
    // r reaches the run's runner as a request file it takes (runner.mjs), since
    // this tree is no child of it.
    const request = (node) => writeJsonAtomic(join(run.runDir, RESUME_REQUEST), { node: node ?? null })
    opened = { runId, view: runView({ stateDir: run.runDir, host: hostOf(run.host), enter, clock, transcripts, registry, unpushed, resumeHost: () => request(null), resumeHalted: request, alive: () => (recorded.has(runId) ? liveOf(recorded.get(runId), lastOpen) : null), triage: orchestrator ? () => orchestrator.triage(run) : null }) }
    await opened.view.refresh()
    message = null
    layout()
    return { opened: runId }
  }

  function close() {
    const runId = opened?.runId
    opened = null
    layout()
    return { closed: runId }
  }

  function toggle(project) {
    folds.set(project.key, !project.folded)
    layout()
    return { folded: project.key }
  }

  // Why the run stays open after a whole-run Ctrl+R, or null when it is closable.
  const openBecause = (run) => (run.alive === true ? 'its runner is alive' : run.alive === null ? 'whether its runner is alive cannot be told' : null)

  // Every agent of the run the registry does not already record reclaimed,
  // by the reclaim rules, as the tree's Reclaim All does. The run is
  // recorded reclaimed once none of its agents is left, but only when it is
  // closable: a run whose runner is alive, or may be, stays open, so the
  // agents it starts later are kept and listed (ADR-0012); one whose runner
  // is known dead closes, ended or not. The registry
  // and Orca are read again first, so a runner resumed since is seen.
  async function reclaim(runId = current()?.run?.runId) {
    if (runId) await refresh()
    const run = runOf(runId)
    if (!run) return say('select a run to reclaim')
    const label = labelOf(run)
    if (run.reclaimed) return say(`${label} is already reclaimed`)
    const stays = openBecause(run)
    const notes = []
    let r
    let left
    try {
      const entry = readRegistry(registry).find((e) => e.runId === runId)
      const done = new Set(entry?.reclaimedAgents.map((a) => a.agent) ?? [])
      const journaled = run.runDir ? agentsOf(join(run.runDir, 'journal.jsonl')).filter((a) => a.runId === runId) : []
      left = journaled.filter((a) => !done.has(a.name))
      const ran = run.runDir ? readJournal(join(run.runDir, 'journal.jsonl')).chain : null
      const chain = ran?.runId === runId && !entry?.chainReclaimed ? ran : null
      r = await reclaimRun(left, { host: hostOf(run.host), unpushed, registry: runRegistry(registry, clock), closeRun: !stays, runId, chain, journaled, out: (s) => notes.push(s.replace(/^!! /, '')) })
    } catch (e) {
      return say(`could not reclaim ${label}: ${e?.message ?? e}`)
    }
    await refresh()
    const agents = (n) => `${n} agent${n === 1 ? '' : 's'}`
    if (r.kept.some((k) => k.unreachable)) return { ...say(`${HOST_GONE}; reclaimed ${r.reclaimed.length} of ${left.length} agents of ${label} before it went`), reclaimed: r.reclaimed, kept: r.kept }
    const text = r.kept.length
      ? `reclaimed ${r.reclaimed.length} of ${left.length} agents of ${label}; ${r.kept.map(({ agent, reason }) => `kept ${agent.title}: ${reason}`).join('; ')}`
      : stays
        ? `${left.length ? `reclaimed ${agents(left.length)} of ${label}` : `${label} has no agent left to reclaim`}; the run stays open: ${stays}`
        : `reclaimed ${label}${left.length ? `: ${agents(left.length)}` : ''}`
    return { ...say(notes.length ? `${text}; ${notes.join('; ')}` : text), reclaimed: r.reclaimed, kept: r.kept }
  }

  // A new tab in the run's worktree running the runner with --resume, which
  // takes the Run over. Refused for a run recorded reclaimed, whose agents are
  // gone and whose record nothing undoes; while its runner is alive; or while
  // that cannot be told.
  async function resume(runId = opened?.runId ?? current()?.run?.runId) {
    const run = runOf(runId)
    if (!run) return say('select a run to resume')
    const label = labelOf(run)
    if (run.reclaimed) return say(`${label} is reclaimed: its agents are gone and the registry closed it, so there is nothing to resume`)
    if (run.alive === true && run.outagePaused) {
      const host = run.outagePaused.reason === 'crew outage' ? 'crew' : 'Orca'
      return say(`${label}'s runner is alive and paused on ${host === 'crew' ? 'a' : 'an'} ${host} outage: it carries on by itself once ${host} is back, and r in its ${run.host === 'crew' ? 'tree' : where(run)} probes ${host} at once`)
    }
    if (run.alive === true && run.outcome === 'halted') return say(run.host === 'crew' ? `${label}'s runner is alive and halted: open its tree and press r there to resume it` : `${label}'s runner is alive and halted, in ${where(run)}: r there resumes it`)
    if (run.alive === true) return say(run.host === 'crew' ? `${label}'s runner is alive: nothing to resume` : `${label}'s runner is alive, in ${where(run)}: nothing to resume`)
    if (run.alive === null) return say(`could not tell whether ${label}'s runner is alive: its runner.pid, or Orca's list of the tab r opened, did not answer`)
    if (!run.project || !run.runDir) return say(`${label} has no ${run.project ? 'run directory' : 'worktree'} recorded to resume in`)
    // A run armed before the registry named its script was launched by the
    // skill, whose state dir is orca-run/ beside the rendered workflow.js.
    const script = run.script ?? join(dirname(run.runDir), 'workflow.js')
    let t
    try {
      t = await hostOf(run.host).resumeRunner({ worktree: run.project, title: `${run.name ?? run.runId} (resumed)`, runner, script, stateDir: run.runDir, permissionMode: run.permissionMode })
    } catch (e) {
      if (hostUnreachable(hostOf(run.host), e)) return say(HOST_GONE)
      return say(`could not resume ${label}: ${e?.message ?? e}`)
    }
    if (t.terminal) launched.set(runId, { host: run.host, terminal: t.terminal, pid: runnerPid(run.runDir), starting: true })
    await refresh()
    return { ...say(`resumed ${label} in ${where(run, t.terminal)}`), resumed: t.terminal }
  }

  const activate = (row) => (!row ? {} : row.kind === 'project' ? toggle(row.project) : open(row.run.runId))

  // `?` on an opened run: a fresh orchestrator session seeded with its run
  // directory, never a node of its graph.
  async function consult() {
    const run = runOf(opened.runId)
    if (!orchestrator || !enter) return say('? talks to the orchestrator in crew view only')
    if (!run?.runDir) return say(`${run ? labelOf(run) : opened.runId} has no run directory recorded`)
    try {
      return { enter: { session: await orchestrator.consult(run), close: true } }
    } catch (e) {
      return say(`could not start an orchestrator session: ${e?.message ?? e}`)
    }
  }

  // Key names as terminal-kit gives them. With a run open its tree takes the
  // keys, except r, and q or Escape, which go back to the list, unless its
  // dialog is open, which takes every key; q on the list returns { quit }.
  async function key(name) {
    if (opened) {
      // A run its tree removed (x) is gone: back to the list.
      const gone = async (res) => {
        if (!res?.removed) return res
        close()
        await refresh()
        return { ...say(res.message), removed: true }
      }
      if (opened.view.model?.dialog) return gone(await opened.view.key(name))
      if (name === 'q' || name === 'ESCAPE' || name === 'LEFT') return close()
      if (name === 'r') {
        // A paused run, or a live runner that is halted or paused on an
        // outage, is resumed from its tree; a dead one gets a new runner.
        const run = runOf(opened.runId)
        return run && (pausedAt(run.runDir) || (run.alive === true && (run.outagePaused || run.outcome === 'halted'))) ? opened.view.key('r') : resume()
      }
      if (name === '?') return consult()
      return opened.view.key(name)
    }
    const rows = runs.model?.rows ?? []
    switch (name) {
      case 'UP':
      case 'DOWN':
        if (rows.length) {
          selected = Math.max(0, Math.min(rows.length - 1, selected + (name === 'UP' ? -1 : 1)))
          selectedKey = rows[selected].key
          layout()
        }
        return {}
      case 'ENTER':
        return activate(current())
      // Right opens a run's tree, as Enter does; on a project it unfolds, and
      // Left folds.
      case 'RIGHT': {
        const row = current()
        if (row?.kind === 'project') return row.project.folded ? toggle(row.project) : {}
        return row?.kind === 'run' ? activate(row) : {}
      }
      case 'LEFT': {
        const row = current()
        return row?.kind === 'project' && !row.project.folded ? toggle(row.project) : {}
      }
      case 'CTRL_R':
        return reclaim()
      // p, r and x on a run's row act on that run as in its tree: x opens
      // the tree on its remove dialog.
      case 'p':
      case 'x': {
        const row = current()
        if (row?.kind !== 'run') return {}
        const res = await open(row.run.runId)
        if (!opened) return res
        const out = await opened.view.key(name)
        if (name === 'p') close()
        return out
      }
      case 'r': {
        const row = current()
        if (row?.kind === 'run' && row.run.runDir && pausedAt(row.run.runDir)) {
          await open(row.run.runId)
          const out = await opened.view.key('r')
          close()
          await refresh()
          return out
        }
        return resume()
      }
      case 'q':
        return { quit: true }
      default:
        return {}
    }
  }

  async function click(index) {
    if (opened) return opened.view.click(index)
    const row = runs.model?.rows[index]
    if (!row) return {}
    selected = index
    selectedKey = row.key
    layout()
    return activate(row)
  }

  return runs
}
