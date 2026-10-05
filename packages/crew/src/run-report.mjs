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
import { pausedAt, pausedSince } from './pause.mjs'
import { agentsIn, outcomeOf, phaseGroups, runEnded, runnerAlive } from './run-view-model.mjs'
import { haltNoticeOf } from './triage.mjs'

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

// One agent as the report lists it, from the fold's record.
const agentRow = (a) => ({ n: a.n, title: a.title, node: a.node ?? null, state: a.state, reason: a.reason ?? null, note: a.note ?? null, worktree: a.worktree ?? null, terminal: a.terminal ?? null, from: iso(a.from), to: iso(a.to) })

// The agents the tree draws (run-view-model.mjs agentsIn), less a node's
// superseded attempts (journal.mjs), which the tree draws as no row either.
const agentsOf = (fold) => agentsIn(fold).filter((a) => !a.superseded)

// The run in `stateDir`: { runId, stateDir, state, alive, ended, outcome,
// paused, halted, outage, phases }. `state` is one of, the first that holds:
// 'ended' (its runner wrote summary.json), 'runner gone' (no live runner, and
// no summary), 'halted', 'paused', 'outage', 'running'. `halted` is halted.json's notice while there is one, { since,
// nodes: [{ node, title, reason, questions }] }, questions null for a node
// held because it failed; `paused` { since } from paused.json; `outage` the
// fold's. `reopened` every node reopened since its result (ADR-0032), { node,
// title, note, at }, which the next resume carries on. `phases` are the script's declared phases first, then any the
// agents name, each with its agents in call order. `alive` is runnerAlive's,
// injected for tests.
export function runReport(stateDir, { alive = runnerAlive } = {}) {
  const fold = foldJournal(journalLines(join(stateDir, 'journal.jsonl')))
  const agents = agentsOf(fold)
  const phases = phaseGroups(agents, fold.phases ?? []).map(([name, list]) => ({ name, agents: list.map(agentRow) }))

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
  return { runId: fold.run?.runId ?? [...agents].reverse().find((a) => a.runId)?.runId ?? null, stateDir, state, alive: isAlive, ended, outcome, paused, halted, outage: fold.outage, reopened: fold.reopened, phases }
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
