// The run as the orchestrator's `?` session reads it (#194, tools.mjs
// run_status, agent_result, runner_log): the run tree's picture of one run,
// from the same files the tree reads, journal.jsonl folded as the tree folds
// it (journal.mjs), halted.json, paused.json, summary.json and runner.pid, as
// plain data, and nothing the tree needs a host for (no context size, no tab
// open or parked). Read-only: the acts (hooks/crew-tools.mjs) write the files
// the operator's keys write, through pause.mjs and halt.mjs.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { foldJournal, journalLines } from './journal.mjs'
import { pausedAt } from './pause.mjs'
import { outcomeOf, runEnded, runnerAlive } from './run-view-model.mjs'
import { haltNoticeOf } from './triage.mjs'
import { isOrchestratorTitle } from './orchestrator.mjs'

const TITLE = /^\[([^\]]*)\] ([\s\S]*)$/
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

// One agent as the report lists it, from the fold's record.
const agentRow = (a) => ({ n: a.n, title: a.title, node: a.node ?? null, state: a.state, reason: a.reason ?? null, note: a.note ?? null, worktree: a.worktree ?? null, terminal: a.terminal ?? null, from: iso(a.from), to: iso(a.to) })

// Every agent of the run but the orchestrator's sessions and a node's
// superseded attempts (journal.mjs), each with its phase from its title.
const agentsOf = (fold) =>
  fold.agents
    .filter((a) => !isOrchestratorTitle(a.title) && !a.superseded)
    .map((a) => {
      const [, phase, label] = TITLE.exec(a.title ?? '') ?? [null, 'Run', a.title ?? `agent-${a.n}`]
      return { ...a, phase, label }
    })

// The run in `stateDir`: { runId, stateDir, state, alive, ended, outcome,
// paused, halted, outage, phases }. `state` is one word, the first that
// holds: ended (its runner wrote summary.json, or the registry closed it),
// 'runner gone' (no live runner, and no summary), halted, paused, outage,
// running. `halted` is halted.json's notice while there is one, { since,
// nodes: [{ node, title, reason, questions }] }, questions null for a node
// held because it failed; `paused` { since } from paused.json; `outage` the
// fold's. `phases` are the script's declared phases first, then any the
// agents name, each with its agents in call order. `alive` is runnerAlive's,
// injected for tests.
export function runReport(stateDir, { alive = runnerAlive } = {}) {
  const fold = foldJournal(journalLines(join(stateDir, 'journal.jsonl')))
  const agents = agentsOf(fold)
  const byPhase = new Map()
  for (const a of [...agents].sort((x, y) => x.n - y.n)) {
    if (!byPhase.has(a.phase)) byPhase.set(a.phase, [])
    byPhase.get(a.phase).push(agentRow(a))
  }
  const declared = fold.phases ?? []
  const rank = (name) => (declared.includes(name) ? declared.indexOf(name) : declared.length)
  const phases = [...byPhase].sort(([x], [y]) => rank(x) - rank(y)).map(([name, list]) => ({ name, agents: list }))

  const isAlive = alive(stateDir)
  const ended = runEnded({ run: null, alive: isAlive, stateDir })
  const notice = haltNoticeOf(stateDir)
  const halted = notice
    ? { since: notice.at, nodes: notice.nodes.map((n) => ({ node: n.node, title: n.title ?? null, reason: n.reason ?? null, questions: Array.isArray(n.questions) ? n.questions : null })) }
    : fold.halted
      ? { since: fold.halted.since, nodes: fold.halted.nodes.map((node) => ({ node, title: fold.nodes.get(node)?.title ?? null, reason: fold.nodes.get(node)?.reason ?? null, questions: null })) }
      : null
  const paused = pausedAt(stateDir) ? { since: pausedSince(stateDir) } : null
  const outcome = isAlive === true ? null : outcomeOf(stateDir)
  const state = ended === true && existsSync(join(stateDir, 'summary.json')) ? 'ended' : isAlive === false ? 'runner gone' : halted ? 'halted' : paused ? 'paused' : fold.outage ? 'outage' : 'running'
  return { runId: fold.run?.runId ?? [...agents].reverse().find((a) => a.runId)?.runId ?? null, stateDir, state, alive: isAlive, ended, outcome, paused, halted, outage: fold.outage, phases }
}

const pausedSince = (stateDir) => {
  try {
    const at = JSON.parse(readFileSync(join(stateDir, 'paused.json'), 'utf8'))?.at
    return typeof at === 'string' ? at : null
  } catch {
    return null
  }
}

// How the run names its agents, for a tool told one it has not: `discover
// (1), impl:a (impl_a, 2)`.
const agentNames = (agents) => agents.map((a) => `${a.label} (${a.node ? `${a.node}, ` : ''}${a.n})`).join(', ')

// One agent, named by its node, its title (with or without its phase), its
// label or its call number: { n, title, node, state, result, decisions,
// reason, resultPath }. `result` is what it submitted, from the journal;
// `decisions` the questions a needs-decision result asked; `reason` why it
// failed; `resultPath` its result.json when its agent dir is known and the
// file is there. Throws, naming every agent, for a name no agent has.
export function agentReport(stateDir, name) {
  const fold = foldJournal(journalLines(join(stateDir, 'journal.jsonl')))
  const agents = agentsOf(fold)
  const wanted = String(name ?? '').trim()
  const a = agents.find((x) => x.node === wanted) ?? agents.find((x) => x.title === wanted || x.label === wanted) ?? agents.find((x) => String(x.n) === wanted)
  if (!a) throw new Error(`no agent of this run is ${wanted || '(nothing)'}: its agents are ${agentNames(agents) || 'none yet'}`)
  // A node's settled entry is the node's; any other agent's is the call that
  // started it, found by its origin.
  const node = a.node ? fold.nodes.get(a.node) : null
  const settled = node ?? [...fold.calls.values()].flat().find((e) => 'result' in e && e.origin === a.origin) ?? null
  const result = settled && 'result' in settled ? settled.result : null
  const dir = node?.last?.dir ?? null
  const resultPath = dir && existsSync(join(stateDir, dir, 'result.json')) ? join(stateDir, dir, 'result.json') : null
  return { n: a.n, title: a.title, node: a.node ?? null, state: a.state, result, decisions: a.decisions ?? null, reason: a.state === 'failed' ? (a.reason ?? node?.reason ?? null) : null, resultPath }
}

// The last `lines` lines of the runner's log, '' with no log yet.
export function runnerLogTail(stateDir, lines) {
  const path = join(stateDir, 'runner.log')
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
}
