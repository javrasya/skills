// The run view's model and its actions (ADR-0012; design reference in
// docs/design/orca-run-view-tree.md), with no terminal in sight: a renderer
// draws `view.model` and hands each key or click to `view.key` / `view.click`.
// runView is one run's tree, the whole of attached mode; runsView is
// standalone mode, every run the registry knows, each opened into a runView.
// The model is read from the run's journal, its agents' session transcripts,
// Orca's terminal list and the run registry; the actions go to Orca, and a
// reclaim goes through reclaim.mjs, so the view keeps the end-of-run rules.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { sessionTranscripts } from './transcript.mjs'
import { agentName, agentsOf, ownWorktree, reclaimAgent, reclaimRun } from './reclaim.mjs'
import { foldJournal, journalLines, timeOf } from './journal.mjs'
import { REGISTRY_PATH, readRegistry, runRegistry } from './registry.mjs'
import { worktreeUnpushed } from './orca-cli.mjs'

export const RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url))

// In the order a phase row lists its mix. An agent's state is the journal
// fold's (journal.mjs), except reclaimed: one the registry records reclaimed.
export const STATES = Object.freeze(['blocked', 'starting', 'running', 'continued', 'stuck', 'failed', 'queued', 'done', 'reclaimed'])

// The problems a phase's pane lists, in row order: blocked first, since a
// human can answer it, then failed and stuck.
const problemsOf = (agents) => [...agents.filter((a) => a.state === 'blocked'), ...agents.filter((a) => a.state === 'failed' || a.state === 'stuck')]

// Context size bands: green below 200k, yellow from 200k to 350k, red above.
export const bandOf = (context) => (context == null ? null : context < 200_000 ? 'green' : context <= 350_000 ? 'yellow' : 'red')

const TITLE = /^\[([^\]]*)\] ([\s\S]*)$/

// Every agent the journal names, by the fold reclaim and the runner's resume
// share (journal.mjs): one row per agent, its state its latest lifecycle
// entry's. An agent a resume carried forward or took up again is the one row,
// never a second one under the resumed run's call number.
const agentsIn = (fold) => fold.agents.map((a) => {
  const [, phase, label] = TITLE.exec(a.title ?? '') ?? [null, 'Run', a.title ?? `agent-${a.n}`]
  return { ...a, phase, label }
})

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
// header, and the standalone row, its r and its R, all read this. It is whether
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

// What an injected liveness answered, as true, false or null (does not know).
const livenessOf = (alive, stateDir) => {
  try {
    const v = alive(stateDir)
    return v === true || v === false ? v : null
  } catch {
    return null
  }
}

// One key for a path, so two spellings of it compare equal: resolved, and
// case-folded on Windows.
export const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
export const samePath = (a, b) => !!a && !!b && pathKey(a) === pathKey(b)

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

// view = runView({ stateDir, orca, … }); await view.refresh() reads the run
// again, and view.model is then:
//   header  { name, project, runId, spec, alive, elapsedMs, counts: {state: n} }
//   phases  [{ name, folded, done, total, mix: {state: n}, peakContext, agents }]
//   rows    [{ kind: 'phase', key, phase } | { kind: 'agent', key, agent, phase }],
//           the phases in the order the run reached them, each unfolded one
//           followed by its agents
//   selected  the index of the selected row
//   pane    { kind: 'agent', agent } | { kind: 'phase', phase, problems: [{ agent, reason }] },
//           a phase's problems being its blocked, failed and stuck agents
//   message the latest action's outcome, for the flash line, or null
//   latest  the last line of runner.log, the run's latest event, or null
//   alert   while any agent is blocked on a human, the line naming each one,
//           its tab and what it waits on, which the flash line keeps over
//           `latest` until it is answered; else null
// An agent is { n, origin, label, title, phase, state, continuations, reason,
// replayed, launched, runId, dispatchId, harness, sessionId, worktree, terminal,
// waiting, nextAt, workerLeft, tabOpen, reclaimed, context, band, tokens,
// elapsedMs, transcript }. state is one of STATES: reclaimed once the registry
// records it so, whatever it was before. worktree
// is only ever one named `<runId>-<n>`: any other, the run's own checkout
// included, is the operator's and never shown. tabOpen
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
// cannot say.
export function runView({ stateDir, orca, clock = { now: () => Date.now() }, transcripts = sessionTranscripts(), registry = REGISTRY_PATH, unpushed = worktreeUnpushed, alive = runnerAlive }) {
  const journalPath = join(stateDir, 'journal.jsonl')
  // name -> folded, only for phases the operator folded or unfolded.
  const folds = new Map()
  let phases = []
  let header = null
  let selectedKey = null
  let selected = 0
  let message = null
  let latest = null
  let alert = null
  let logTab = null
  const view = { model: null, refresh, key, click, focus, reclaim, openLog }

  function layout() {
    const rows = []
    for (const phase of phases) {
      phase.folded = folds.get(phase.name) ?? (phase.total > 0 && phase.agents.every((a) => a.state === 'done' || a.state === 'reclaimed'))
      rows.push({ kind: 'phase', key: `phase:${phase.name}`, phase })
      if (!phase.folded) for (const agent of phase.agents) rows.push({ kind: 'agent', key: `agent:${agent.n}`, agent, phase })
    }
    const at = rows.findIndex((r) => r.key === selectedKey)
    selected = at >= 0 ? at : Math.max(0, Math.min(selected, rows.length - 1))
    const row = rows[selected] ?? null
    selectedKey = row?.key ?? null
    const pane = !row ? null
      : row.kind === 'agent' ? { kind: 'agent', agent: row.agent }
      : { kind: 'phase', phase: row.phase, problems: problemsOf(row.phase.agents).map((agent) => ({ agent, reason: agent.reason })) }
    view.model = { header, phases, rows, selected, pane, message, latest, alert }
    return view.model
  }

  async function refresh() {
    const entries = journalLines(journalPath)
    latest = latestEvent(join(stateDir, 'runner.log'))
    const fold = foldJournal(entries)
    const agents = agentsIn(fold)
    const now = clock.now()
    let open = null
    if (agents.some((a) => a.terminal)) {
      try {
        open = new Set(await orca.terminalList())
      } catch {}
    }
    // A resume journals the Run it takes over before any agent.
    const runId = fold.run?.runId ?? [...agents].reverse().find((a) => a.runId)?.runId ?? null
    let run = null
    if (registry) {
      try {
        const runs = readRegistry(registry)
        run = (runId && runs.find((r) => r.runId === runId)) || runs.filter((r) => samePath(r.runDir, stateDir)).at(-1) || null
      } catch {}
    }
    const reclaimedNames = new Set(run?.reclaimedAgents?.map((r) => r.agent) ?? [])
    for (const a of agents) {
      const usage = a.sessionId ? transcripts.usage({ harness: a.harness, sessionId: a.sessionId, worktree: a.worktree }) : null
      const reclaimed = !!a.runId && (run?.reclaimed === true || reclaimedNames.has(agentName(a)))
      Object.assign(a, {
        ...(reclaimed && { state: 'reclaimed' }),
        worktree: ownWorktree(a),
        tabOpen: a.terminal && open ? open.has(a.terminal) : null,
        reclaimed,
        context: usage?.context ?? null,
        band: bandOf(usage?.context),
        tokens: usage?.tokens ?? null,
        transcript: usage?.path ?? null,
        elapsedMs: a.from === null ? null : Math.max(0, (a.to ?? now) - a.from),
      })
    }

    const blocked = agents.filter((a) => a.state === 'blocked')
    alert = blocked.length
      ? `BLOCKED ON A HUMAN: ${blocked.map((a) => `${a.title} in tab ${a.terminal ?? '—'} waits on ${a.waiting ?? 'an answer'}`).join(' · ')}`
      : null

    const byPhase = new Map()
    for (const a of agents) {
      if (!byPhase.has(a.phase)) byPhase.set(a.phase, [])
      byPhase.get(a.phase).push(a)
    }
    const countOf = (list) => Object.fromEntries(STATES.map((s) => [s, list.filter((a) => a.state === s).length]))
    phases = [...byPhase].map(([name, list]) => {
      const contexts = list.map((a) => a.context).filter((c) => c != null)
      return { name, folded: false, done: list.filter((a) => a.state === 'done').length, total: list.length, mix: countOf(list), peakContext: contexts.length ? Math.max(...contexts) : null, agents: list }
    })

    const isAlive = livenessOf(alive, stateDir)
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
      elapsedMs: start === null ? null : Math.max(0, end - start),
      counts: countOf(agents),
    }
    return layout()
  }

  const say = (text) => {
    message = text
    layout()
    return { message: text }
  }
  const current = () => view.model?.rows[selected] ?? null

  function toggle(phase) {
    folds.set(phase.name, !phase.folded)
    layout()
    return { folded: phase.name, now: view.model.phases.find((p) => p.name === phase.name)?.folded }
  }

  // Brings the agent's tab, and its worktree, to the front in Orca.
  async function focus(agent) {
    if (!agent.terminal) return say(`${agent.title} has no tab: its worker never started here`)
    try {
      await orca.terminalSwitch({ terminal: agent.terminal })
      message = null
      layout()
      return { switched: agent.terminal }
    } catch (e) {
      return say(`could not focus ${agent.title}'s tab ${agent.terminal}: ${e?.message ?? e}`)
    }
  }

  const activate = (row) => (!row ? {} : row.kind === 'phase' ? toggle(row.phase) : focus(row.agent))

  // Reclaims agent `n`, or with no `n` the selected one, through reclaim.mjs,
  // as the journal names it for reclaim: refused while it is live, or while
  // its worktree holds unpushed commits unless `force`. One that failed and
  // was kept with its worker running is refused as `stoppable` unless `stop`,
  // which stops that worker first: both are the operator's confirmed `f`
  // (view.mjs), never the plain `r`. A reclaim is recorded
  // in the registry. What it answers names the agent as `agent: { n, title }`,
  // so a forced retry goes to the agent refused, never to whatever row the
  // selection sits on by then: a refresh that folds its phase moves it.
  async function reclaim({ n, force = false, stop = false } = {}) {
    let a
    if (n === undefined) {
      const row = current()
      if (row?.kind !== 'agent') return say('select an agent to reclaim')
      a = row.agent
    } else {
      a = phases.flatMap((p) => p.agents).find((x) => x.n === n)
      if (!a) return say(`no agent ${n} in this run to reclaim`)
    }
    const target = { n: a.n, title: a.title }
    const agent = agentsOf(journalPath).find((x) => x.origin === a.origin)
    if (!agent) return { ...say(`${a.title} has nothing to reclaim: it launched nothing in this run`), agent: target }
    let r
    try {
      r = await reclaimAgent(agent, { orca, unpushed, force, stop })
    } catch (e) {
      r = { reclaimed: false, reason: e?.message ?? String(e) }
    }
    if (!r.reclaimed) return { ...say(`kept ${a.title}: ${r.reason}`), reclaim: r, agent: target }
    let note = r.notes.length ? `; ${r.notes.join('; ')}` : ''
    if (registry) {
      try {
        runRegistry(registry, clock).reclaimed({ runId: agent.runId, agent: agent.name })
      } catch (e) {
        note += `; the run registry did not record it: ${e?.message ?? e}`
      }
    }
    await refresh()
    return { ...say(`reclaimed ${a.title}${note}`), reclaim: r, agent: target }
  }

  // runner.log in a tab of its own that follows it (orca.logTail): Orca's
  // editor opens no file outside a worktree, and the run dir is outside every
  // checkout. While that tab is open, `l` again brings it back.
  async function openLog() {
    const path = join(stateDir, 'runner.log')
    if (!existsSync(path)) return say(`could not open ${path}: the runner has not written it yet`)
    if (logTab) {
      try {
        await orca.terminalSwitch({ terminal: logTab })
        return say(`switched to the tab following ${path}`)
      } catch {
        logTab = null
      }
    }
    try {
      logTab = (await orca.logTail({ path, title: 'runner.log' })).terminal
      return say(`opened ${path} in a tab that follows it`)
    } catch (e) {
      return say(`could not open ${path}: ${e?.message ?? e}`)
    }
  }

  // Key names as terminal-kit gives them. Returns what the key did: { quit }
  // for q, which ends the view only, never the run.
  async function key(name) {
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
      case 'LEFT':
      case 'RIGHT':
        return current()?.kind === 'phase' ? toggle(current().phase) : {}
      case 'r':
        return reclaim()
      case 'l':
        return openLog()
      case 'q':
        return { quit: true }
      default:
        return {}
    }
  }

  // A click on row `index` selects it and does what Enter would.
  async function click(index) {
    const row = view.model?.rows[index]
    if (!row) return {}
    selected = index
    selectedKey = row.key
    layout()
    return activate(row)
  }

  return view
}

// runs = runsView({ orca, … }); await runs.refresh() reads the registry again,
// and runs.model is then:
//   projects  [{ key, name, path, folded, runs }], the project of the latest
//             run first, each project's runs latest first
//   rows      [{ kind: 'project', key, project } | { kind: 'run', key, run, project }]
//   selected  the index of the selected row
//   message   the latest action's outcome, or null
//   opened    { runId, view }: the run Enter opened, as a runView, or null
// A run is { runId, name, spec, project, runDir, script, permissionMode,
// terminal, outcome, alive, kept, reclaimed, closable, armedAt, ageMs,
// resumable }. outcome is ok, partial or failed, or null while no `ended` is
// recorded. alive is runnerAlive's answer for its run dir, the rule attached
// mode's header reads too: whether the process its runner.pid names is alive,
// never whether its tab is open, since the tab outlives the runner. Just after
// R, until the new runner has written its own runner.pid, the tab R opened
// counts as the runner while Orca's terminal list shows it. null when it
// cannot be told. kept counts the agents its journal names that are not reclaimed.
// closable is whether r may record the whole run reclaimed: only once its
// runner is known dead, ended or not, since nothing undoes that record and a
// live runner may start more agents; a dead one starts none, and R refuses a
// reclaimed run. R resumes a run only when it is resumable: alive being
// false, and the run not reclaimed.
//
// Only the registry's runs are listed, so a worktree no run made never is.
// Read, stop and release are not fenced to a Run's coordinator, so a reclaim
// needs no takeover. runner is the runner.mjs a resume runs; the rest is as
// runView's.
export function runsView({ orca, clock = { now: () => Date.now() }, registry = REGISTRY_PATH, transcripts = sessionTranscripts(), unpushed = worktreeUnpushed, alive = runnerAlive, runner = RUNNER_PATH }) {
  const folds = new Map()
  // runId -> { terminal, pid, starting }: the tab R opened, and the runner.pid
  // its run dir held then. While that file is unchanged the new runner has not
  // written its own, so the tab stands for it; once it has, the pid decides.
  const launched = new Map()
  // The registry's runs and Orca's terminal list, as the last refresh read them.
  let recorded = new Map()
  let lastOpen = null
  const liveOf = (r, open) => {
    const l = launched.get(r.runId)
    if (l?.starting && r.runDir) {
      if (runnerPid(r.runDir) === l.pid) return open === null ? null : open.has(l.terminal) ? true : livenessOf(alive, r.runDir)
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
    // Orca's terminal list is read only for a tab R opened whose runner has
    // not written its runner.pid yet.
    let open = null
    if ([...launched.values()].some((l) => l.starting)) {
      try {
        open = new Set(await orca.terminalList())
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
        runId: r.runId, name: r.spec, spec: number ? `#${number}` : null, project: r.project, runDir: r.runDir,
        script: r.script, permissionMode: r.permissionMode, terminal: launched.get(r.runId)?.terminal ?? r.runner?.terminal ?? null,
        outcome: r.state === 'running' ? null : r.state, alive: live, reclaimed: r.reclaimed,
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

  // Enter on a run: its tree, the one attached mode shows.
  async function open(runId) {
    const run = runOf(runId)
    if (!run) return say(`no run ${runId} in the run registry`)
    if (!run.runDir) return say(`${labelOf(run)} has no run directory recorded`)
    // The tree's header asks what the run's row asks, by the same rule.
    opened = { runId, view: runView({ stateDir: run.runDir, orca, clock, transcripts, registry, unpushed, alive: () => (recorded.has(runId) ? liveOf(recorded.get(runId), lastOpen) : null) }) }
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

  // Why the run stays open after a whole-run r, or null when it is closable.
  const openBecause = (run) => (run.alive === true ? 'its runner is alive' : run.alive === null ? 'whether its runner is alive cannot be told' : null)

  // Every agent of the run the registry does not already record reclaimed,
  // by the reclaim rules, as the end-of-run prompt's `a` does. The run is
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
      const done = new Set(readRegistry(registry).find((e) => e.runId === runId)?.reclaimedAgents.map((a) => a.agent) ?? [])
      left = run.runDir ? agentsOf(join(run.runDir, 'journal.jsonl')).filter((a) => a.runId === runId && !done.has(a.name)) : []
      const writer = runRegistry(registry, clock)
      r = await reclaimRun(left, { orca, unpushed, registry: writer, closeRun: !stays, out: (s) => notes.push(s.replace(/^!! /, '')) })
      if (!left.length && !stays) writer.reclaimed({ runId })
    } catch (e) {
      return say(`could not reclaim ${label}: ${e?.message ?? e}`)
    }
    await refresh()
    const agents = (n) => `${n} agent${n === 1 ? '' : 's'}`
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
    if (run.alive === true) return say(`${label}'s runner is alive, in tab ${run.terminal}: nothing to resume`)
    if (run.alive === null) return say(`could not tell whether ${label}'s runner is alive: its runner.pid, or Orca's list of the tab R opened, did not answer`)
    if (!run.project || !run.runDir) return say(`${label} has no ${run.project ? 'run directory' : 'worktree'} recorded to resume in`)
    // A run armed before the registry named its script was launched by the
    // skill, whose state dir is orca-run/ beside the rendered workflow.js.
    const script = run.script ?? join(dirname(run.runDir), 'workflow.js')
    let t
    try {
      t = await orca.resumeRunner({ worktree: run.project, title: `${run.name ?? run.runId} (resumed)`, runner, script, stateDir: run.runDir, permissionMode: run.permissionMode })
    } catch (e) {
      return say(`could not resume ${label}: ${e?.message ?? e}`)
    }
    if (t.terminal) launched.set(runId, { terminal: t.terminal, pid: runnerPid(run.runDir), starting: true })
    await refresh()
    return { ...say(`resumed ${label} in tab ${t.terminal}`), resumed: t.terminal }
  }

  const activate = (row) => (!row ? {} : row.kind === 'project' ? toggle(row.project) : open(row.run.runId))

  // Key names as terminal-kit gives them. With a run open its tree takes the
  // keys, except R, and q or Escape, which go back to the list; q on the
  // list returns { quit }.
  async function key(name) {
    if (opened) {
      if (name === 'q' || name === 'ESCAPE') return close()
      if (name === 'R') return resume()
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
      case 'LEFT':
      case 'RIGHT':
        return current()?.kind === 'project' ? toggle(current().project) : {}
      case 'r':
        return reclaim()
      case 'R':
        return resume()
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
