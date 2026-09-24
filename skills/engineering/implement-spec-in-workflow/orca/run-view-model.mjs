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
import { agentsOf, gitUnpushed, ownWorktree, reclaimAgent, reclaimRun } from './reclaim.mjs'
import { REGISTRY_PATH, readRegistry, runRegistry } from './registry.mjs'

export const RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url))

// In the order a phase row lists its mix.
export const STATES = Object.freeze(['running', 'continued', 'stuck', 'failed', 'queued', 'done'])

// Context size bands: green below 200k, yellow from 200k to 350k, red above.
export const bandOf = (context) => (context == null ? null : context < 200_000 ? 'green' : context <= 350_000 ? 'yellow' : 'red')

const TITLE = /^\[([^\]]*)\] ([\s\S]*)$/

function journalEntries(path) {
  if (!existsSync(path)) return []
  const entries = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e && typeof e === 'object') entries.push(e)
    } catch {}
  }
  return entries
}

const timeOf = (e) => {
  const t = Date.parse(e?.at)
  return Number.isFinite(t) ? t : null
}

// Every agent() call the journal names, by n. Its state is its latest
// lifecycle entry's: queued, running once started (or retrying its start),
// stuck once nudged, continued after a continuation, done or failed once
// settled. A nudge journals no answer, so an agent stays stuck until its next
// continuation or settlement. A replayed result launched nothing this run.
function agentsIn(entries) {
  const byN = new Map()
  for (const e of entries) {
    if (!Number.isInteger(e.n)) continue
    let a = byN.get(e.n)
    if (!a) {
      const [, phase, label] = TITLE.exec(e.title ?? '') ?? [null, 'Run', e.title ?? `agent-${e.n}`]
      a = {
        n: e.n, title: e.title ?? null, phase, label, state: 'queued', continuations: 0, reason: null, replayed: false,
        runId: null, dispatchId: null, harness: null, sessionId: null, worktree: null, terminal: null, from: null, to: null,
      }
      byN.set(e.n, a)
    }
    const at = timeOf(e)
    switch (e.type) {
      case 'queued':
        break
      case 'retry':
        a.from ??= at
        a.state = 'running'
        break
      case 'started':
      case 'reattached':
        a.from ??= at
        Object.assign(a, {
          state: a.continuations ? 'continued' : 'running', runId: e.run ?? a.runId, dispatchId: e.dispatchId ?? a.dispatchId, harness: e.harness ?? a.harness,
          sessionId: e.sessionId ?? a.sessionId, worktree: e.worktree ?? a.worktree, terminal: e.terminal ?? a.terminal,
        })
        break
      case 'nudge':
        if (a.state === 'running' || a.state === 'continued' || a.state === 'stuck') Object.assign(a, { state: 'stuck', reason: e.reason ?? null })
        break
      case 'continued':
        Object.assign(a, {
          state: 'continued', reason: null, continuations: e.attempt ?? a.continuations + 1,
          dispatchId: e.dispatchId ?? a.dispatchId, terminal: e.terminal ?? a.terminal, sessionId: e.sessionId ?? a.sessionId,
        })
        break
      case 'result':
        Object.assign(a, { state: 'done', reason: null, to: at, replayed: e.replayed === true })
        break
      case 'failed':
        a.from ??= at
        Object.assign(a, {
          state: 'failed', reason: e.reason ?? null, to: at, runId: a.runId ?? e.run ?? null, worktree: a.worktree ?? e.retained?.path ?? null,
          continuations: e.continuations ?? a.continuations,
        })
        break
    }
  }
  return [...byN.values()].sort((x, y) => x.n - y.n)
}

// Whether the process runner.pid names is alive. The runner's tab outlives
// it, so the tab cannot say.
export function runnerAlive(stateDir) {
  let pid
  try {
    pid = Number(readFileSync(join(stateDir, 'runner.pid'), 'utf8').trim())
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

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

const samePath = (a, b) => !!a && !!b && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))

// view = runView({ stateDir, orca, … }); await view.refresh() reads the run
// again, and view.model is then:
//   header  { name, project, runId, spec, alive, elapsedMs, counts: {state: n} }
//   phases  [{ name, folded, done, total, mix: {state: n}, peakContext, agents }]
//   rows    [{ kind: 'phase', key, phase } | { kind: 'agent', key, agent, phase }],
//           the phases in the order the run reached them, each unfolded one
//           followed by its agents
//   selected  the index of the selected row
//   pane    { kind: 'agent', agent } | { kind: 'phase', phase, problems: [{ agent, reason }] },
//           a phase's problems being its failed and stuck agents
//   message the latest action's outcome, for the flash line, or null
//   latest  the last line of runner.log, the run's latest event, or null
// An agent is { n, label, title, phase, state, continuations, reason,
// replayed, runId, dispatchId, harness, sessionId, worktree, terminal,
// tabOpen, reclaimed, context, band, tokens, elapsedMs, transcript }. worktree
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
// whether the runner lives.
export function runView({ stateDir, orca, clock = { now: () => Date.now() }, transcripts = sessionTranscripts(), registry = REGISTRY_PATH, unpushed = gitUnpushed, alive = runnerAlive }) {
  const journalPath = join(stateDir, 'journal.jsonl')
  // name -> folded, only for phases the operator folded or unfolded.
  const folds = new Map()
  let phases = []
  let header = null
  let selectedKey = null
  let selected = 0
  let message = null
  let latest = null
  let logTab = null
  const view = { model: null, refresh, key, click, focus, reclaim, openLog }

  function layout() {
    const rows = []
    for (const phase of phases) {
      phase.folded = folds.get(phase.name) ?? (phase.total > 0 && phase.done === phase.total)
      rows.push({ kind: 'phase', key: `phase:${phase.name}`, phase })
      if (!phase.folded) for (const agent of phase.agents) rows.push({ kind: 'agent', key: `agent:${agent.n}`, agent, phase })
    }
    const at = rows.findIndex((r) => r.key === selectedKey)
    selected = at >= 0 ? at : Math.max(0, Math.min(selected, rows.length - 1))
    const row = rows[selected] ?? null
    selectedKey = row?.key ?? null
    const pane = !row ? null
      : row.kind === 'agent' ? { kind: 'agent', agent: row.agent }
      : { kind: 'phase', phase: row.phase, problems: row.phase.agents.filter((a) => a.state === 'failed' || a.state === 'stuck').map((agent) => ({ agent, reason: agent.reason })) }
    view.model = { header, phases, rows, selected, pane, message, latest }
    return view.model
  }

  async function refresh() {
    const entries = journalEntries(journalPath)
    latest = latestEvent(join(stateDir, 'runner.log'))
    const agents = agentsIn(entries)
    const now = clock.now()
    let open = null
    if (agents.some((a) => a.terminal)) {
      try {
        open = new Set(await orca.terminalList())
      } catch {}
    }
    const runId = [...agents].reverse().find((a) => a.runId)?.runId ?? null
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
      Object.assign(a, {
        worktree: ownWorktree(a),
        tabOpen: a.terminal && open ? open.has(a.terminal) : null,
        reclaimed: !!a.runId && (run?.reclaimed === true || reclaimedNames.has(`${a.runId}-${a.n}`)),
        context: usage?.context ?? null,
        band: bandOf(usage?.context),
        tokens: usage?.tokens ?? null,
        transcript: usage?.path ?? null,
        elapsedMs: a.from === null ? null : Math.max(0, (a.to ?? now) - a.from),
      })
    }

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

    const isAlive = (() => {
      try {
        return !!alive(stateDir)
      } catch {
        return false
      }
    })()
    const times = entries.map(timeOf).filter((t) => t !== null)
    const armedAt = run?.armedAt ? Date.parse(run.armedAt) : NaN
    const start = Number.isFinite(armedAt) ? armedAt : times.length ? Math.min(...times) : null
    const endedAt = run?.endedAt ? Date.parse(run.endedAt) : NaN
    const end = isAlive ? now : Number.isFinite(endedAt) ? endedAt : times.length ? Math.max(...times) : now
    // The registry's `spec` is the name the script's meta declared, which for
    // the template is implement-spec-<number>.
    const name = run?.spec ?? null
    const number = /spec-(\d+)/.exec(name ?? '')?.[1]
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
  // its worktree holds unpushed commits unless `force`. A reclaim is recorded
  // in the registry. What it answers names the agent as `agent: { n, title }`,
  // so a forced retry goes to the agent refused, never to whatever row the
  // selection sits on by then: a refresh that folds its phase moves it.
  async function reclaim({ n, force = false } = {}) {
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
    const agent = agentsOf(journalPath).find((x) => x.n === a.n)
    if (!agent) return { ...say(`${a.title} has nothing to reclaim: it launched nothing in this run`), agent: target }
    let r
    try {
      r = await reclaimAgent(agent, { orca, unpushed, force })
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

const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))

// runs = runsView({ orca, … }); await runs.refresh() reads the registry again,
// and runs.model is then:
//   projects  [{ key, name, path, folded, runs }], the project of the latest
//             run first, each project's runs latest first
//   rows      [{ kind: 'project', key, project } | { kind: 'run', key, run, project }]
//   selected  the index of the selected row
//   message   the latest action's outcome, or null
//   opened    { runId, view }: the run Enter opened, as a runView, or null
// A run is { runId, name, spec, project, runDir, script, permissionMode,
// terminal, outcome, alive, kept, reclaimed, armedAt, ageMs, resumable }.
// outcome is ok, partial or failed, or null while no `ended` is recorded.
// alive is whether its runner's terminal, the registry's or the one R opened,
// is in Orca's terminal list, and null when the list could not be read. kept
// counts the agents its journal names that are not reclaimed. R resumes a
// run only when it is resumable, alive being false.
//
// Only the registry's runs are listed, so a worktree no run made never is.
// Read, stop and release are not fenced to a Run's coordinator, so a reclaim
// needs no takeover. runner is the runner.mjs a resume runs; the rest is as
// runView's.
export function runsView({ orca, clock = { now: () => Date.now() }, registry = REGISTRY_PATH, transcripts = sessionTranscripts(), unpushed = gitUnpushed, alive = runnerAlive, runner = RUNNER_PATH }) {
  const folds = new Map()
  // runId -> the tab R opened: alive before its runner reaches the registry.
  const launched = new Map()
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
    let open = null
    try {
      open = new Set(await orca.terminalList())
    } catch {}
    const now = clock.now()
    const byProject = new Map()
    for (const r of entries) {
      const done = new Set(r.reclaimedAgents.map((a) => a.agent))
      const agents = r.runDir ? agentsOf(join(r.runDir, 'journal.jsonl')).filter((a) => a.runId === r.runId) : []
      const handles = [r.runner?.terminal, launched.get(r.runId)].filter(Boolean)
      const live = open ? handles.some((h) => open.has(h)) : null
      const armedAt = Date.parse(r.armedAt)
      const number = /spec-(\d+)/.exec(r.spec ?? '')?.[1]
      const run = {
        runId: r.runId, name: r.spec, spec: number ? `#${number}` : null, project: r.project, runDir: r.runDir,
        script: r.script, permissionMode: r.permissionMode, terminal: launched.get(r.runId) ?? r.runner?.terminal ?? null,
        outcome: r.state === 'running' ? null : r.state, alive: live, reclaimed: r.reclaimed,
        kept: r.reclaimed ? 0 : agents.filter((a) => !done.has(a.name)).length,
        armedAt: Number.isFinite(armedAt) ? armedAt : null, ageMs: Number.isFinite(armedAt) ? Math.max(0, now - armedAt) : null, resumable: live === false,
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
    opened = { runId, view: runView({ stateDir: run.runDir, orca, clock, transcripts, registry, unpushed, alive }) }
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

  // Every agent of the run the registry does not already record reclaimed,
  // by the reclaim rules, as the end-of-run prompt's `a` does; the run is
  // recorded reclaimed once none of its agents is left.
  async function reclaim(runId = current()?.run?.runId) {
    const run = runOf(runId)
    if (!run) return say('select a run to reclaim')
    const label = labelOf(run)
    if (run.reclaimed) return say(`${label} is already reclaimed`)
    const notes = []
    let r
    let left
    try {
      const done = new Set(readRegistry(registry).find((e) => e.runId === runId)?.reclaimedAgents.map((a) => a.agent) ?? [])
      left = run.runDir ? agentsOf(join(run.runDir, 'journal.jsonl')).filter((a) => a.runId === runId && !done.has(a.name)) : []
      const writer = runRegistry(registry, clock)
      r = await reclaimRun(left, { orca, unpushed, registry: writer, out: (s) => notes.push(s.replace(/^!! /, '')) })
      if (!left.length) writer.reclaimed({ runId })
    } catch (e) {
      return say(`could not reclaim ${label}: ${e?.message ?? e}`)
    }
    await refresh()
    const text = r.kept.length
      ? `reclaimed ${r.reclaimed.length} of ${left.length} agents of ${label}; ${r.kept.map(({ agent, reason }) => `kept ${agent.title}: ${reason}`).join('; ')}`
      : `reclaimed ${label}${left.length ? `: ${left.length} agent${left.length === 1 ? '' : 's'}` : ''}`
    return { ...say(notes.length ? `${text}; ${notes.join('; ')}` : text), reclaimed: r.reclaimed, kept: r.kept }
  }

  // A new tab in the run's worktree running the runner with --resume, which
  // takes the Run over. Refused while its runner's tab is open, or while Orca
  // cannot say whether it is.
  async function resume(runId = opened?.runId ?? current()?.run?.runId) {
    const run = runOf(runId)
    if (!run) return say('select a run to resume')
    const label = labelOf(run)
    if (run.alive === true) return say(`${label}'s runner is alive, in tab ${run.terminal}: nothing to resume`)
    if (run.alive === null) return say(`could not tell whether ${label}'s runner is alive: Orca's terminal list did not answer`)
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
    if (t.terminal) launched.set(runId, t.terminal)
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
