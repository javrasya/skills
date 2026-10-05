// crew's tools (tools.mjs, ADR-0027) as a session's harness gives them: pi
// registers them in its extension (crew-pi.mjs), Claude lists them from crew's
// MCP server (crew-mcp.mjs). An agent's is one daemon op keyed by the
// session's id (CREW_SESSION, under CREW_HOME); a refusal throws the daemon's
// words, and a daemon gone throws them named, with what the agent does
// instead. The orchestrator's, a `?` session's (#194), read the run's state
// dir (run-report.mjs) and write the files the operator's p and r write
// (pause.mjs, halt.mjs's RESUME_REQUEST), the daemon asked nothing, but for
// reopen's journal line (reopen.mjs) and a resume of a run whose runner is
// gone, which starts it again as the console's r does (ADR-0032).
import { join, resolve } from 'node:path'
import { request, daemonGone } from '../daemon/client.mjs'
import { crewPaths } from '../daemon/transport.mjs'
import { crewHost } from '../crew-host.mjs'
import { readRegistry } from '../registry.mjs'
import { reopenNode } from '../reopen.mjs'
import { claudeDir } from '../transcript.mjs'
import { writeJsonAtomic } from '../fsutil.mjs'
import { RESUME_REQUEST, decisionsOf } from '../halt.mjs'
import { pauseRun, pausedAt, unpauseRun } from '../pause.mjs'
import { agentReport, runReport, runnerLogTail } from '../run-report.mjs'
import { RUNNER_PATH, runnerAlive } from '../run-view-model.mjs'
import { NOTE_MAX, submitShape, tool } from '../tools.mjs'
import { haltNoticeOf } from '../triage.mjs'
import { sleep } from '../util.mjs'

// How many lines of runner.log runner_log reads when not told, and the most.
const LOG_LINES = 50
const LOG_LINES_MAX = 500

// How long a session crew started for an agent (CREW_AGENT) waits for its
// dispatch: its runner makes it just after the session, which may start first.
const DISPATCH_MS = 5_000

// The agent the session's dispatch runs ({ role, schema }), or null: none, or
// no daemon to ask, leaves the session without tools, its prompt's CLI line
// its way. The runner's side of it is lifecycle.mjs's dispatchAgent.
export async function sessionAgent(env = process.env) {
  if (!env.CREW_SESSION) return null
  const until = Date.now() + DISPATCH_MS
  try {
    for (;;) {
      const { agent } = await request(crewPaths(env), { op: 'worker.agent', id: env.CREW_SESSION }, { timeoutMs: 2_000 })
      if (agent || env.CREW_AGENT !== '1' || Date.now() > until) return agent
      await sleep(50)
    }
  } catch {
    return null
  }
}

// The tools `agent` has, in the order a harness lists them, each with the
// table's description (`who` filters them by role) and `call(args)`, which
// answers the agent's text.
/** @returns {Array<{ name: string, label: string, description: string, parameters: object, call: (args: any) => Promise<string> }>} */
export function crewTools(agent, env = process.env) {
  const all = agent.role === 'orchestrator' ? orchestratorTools(agent.stateDir, env) : agentTools(agent, env)
  return all.filter((t) => tool(t.name).who.includes(agent.role)).map((t) => ({ ...t, description: tool(t.name).description }))
}

function agentTools(agent, env) {
  const ask = async (said, instead) => {
    try {
      return await request(crewPaths(env), { ...said, id: env.CREW_SESSION })
    } catch (e) {
      if (!daemonGone(e)) throw e
      throw new Error(`crew's daemon is not reachable (${e.message}). ${instead}`)
    }
  }
  const shape = submitShape(agent.schema)
  const all = [
    {
      name: 'status',
      label: 'Status',
      parameters: { type: 'object', required: ['note'], properties: { note: { type: 'string', description: `One line, at most ${NOTE_MAX} characters.` } } },
      async call({ note }) {
        const said = await ask({ op: 'worker.status', note }, 'Your note was not posted: carry on with your task.')
        return said.note ? `Posted: the operator sees "${said.note}" on your row.` : 'Cleared your note.'
      },
    },
    {
      name: 'needs_you',
      label: 'Needs you',
      parameters: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', description: 'What the human must do or decide.' } } },
      async call({ reason }) {
        const line = tool('needs_you').fallback({ role: agent.role })
        const instead = line ? `The operator was not told. Run this instead, with the IDs your instructions give: ${line}` : 'The operator was not told, and no command line tells them for you. Wait in this session, and say in your final message what blocks you and what the human must do or decide.'
        // A doctor's needs_you is its escalation, sent as mail.
        if (agent.role === 'doctor') await ask({ op: 'worker.mail', type: 'escalation', subject: 'needs you', body: reason }, instead)
        else await ask({ op: 'worker.needsYou', reason }, instead)
        return 'The operator is told you need them, and why. Wait for them in this session, for as long as they take.'
      },
    },
    {
      name: 'handoff',
      label: 'Hand off',
      parameters: { type: 'object', required: ['note'], properties: { note: { type: 'string', description: 'Your note: the guidance the patient carries on with.' } } },
      async call({ note }) {
        await ask({ op: 'worker.handoff', note }, `Your note was not sent. Send it over Run mail instead, with the IDs your instructions give: ${tool('handoff').fallback()}`)
        return 'Handed off: the runner carries the patient on with your note, and your round is over. Nothing remains for you: stop and idle.'
      },
    },
    {
      name: 'give_up',
      label: 'Give up',
      parameters: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', description: 'Why no note of yours can cure the patient.' } } },
      async call({ reason }) {
        await ask({ op: 'worker.giveUp', reason }, `The run was not told. Send it over Run mail instead, with the IDs your instructions give: ${tool('give_up').fallback()}`)
        return 'Gave up: your round is over, with no note. Nothing remains for you: stop and idle.'
      },
    },
    {
      name: 'submit',
      label: 'Submit',
      parameters: shape.parameters,
      async call(args) {
        // Its CLI line (the table's) needs the worker's files, which its
        // prompt names and this session does not hold.
        const said = await ask({ op: 'worker.submit', payload: shape.payload(args) }, 'Your result was not submitted: submit it with the command line in your instructions instead, as they say.')
        const where = said.resultPath ? ` It is recorded at ${said.resultPath}.` : ''
        return `Submitted: the workflow has your result.${where} Nothing remains for this task: stop and idle.`
      },
    },
  ]
  return all
}

// A held node as halted.json names it, for resume and decide: what it is
// held for, and whether it is one the run holds at all.
const heldNodes = (stateDir) => haltNoticeOf(stateDir)?.nodes ?? []
const heldFor = (n) => (Array.isArray(n.questions) && n.questions.length ? 'needs decisions' : 'failed')
const named = (nodes) => nodes.map((n) => `${n.node} (${heldFor(n)})`).join(', ')

// The orchestrator's tools, on the run in `stateDir`: what a `?` session
// reads and does. `resume` does what the tree's r does (run-view-model.mjs):
// a pause it lifts itself, removing paused.json, which the runner journals as
// it finds the file gone; a halt it asks the runner about, through the file
// its watchResumeRequests takes (runner.mjs), so a node is carried on by the
// runner itself. `decide` asks the same way. Neither writes the file for a
// runner that is not there to take it: a resume of a run whose runner is gone
// starts it again instead, as the tree's r does (ADR-0032), and that runner
// carries on every held and reopened node; `reopen` writes the one journal
// line that makes the next resume carry a settled node on (reopen.mjs).
function orchestratorTools(stateDir, env) {
  // The runner a request is for, refused when none is there to take it.
  const runner = () => {
    const report = runReport(stateDir, { alive: runnerAlive })
    if (report.alive === false) throw new Error("the run's runner is not running, so nothing would take the answers. resume starts it again, and once the node is held again decide answers it.")
    return { send: (request) => writeJsonAtomic(join(stateDir, RESUME_REQUEST), request) }
  }
  // A new runner for the run, with --resume, in a crew session in its
  // project, as the standalone view's r starts one (run-view-model.mjs
  // resume), from the run's registry record; the daemon refuses it while the
  // run has a runner already. Returns its crew session's id.
  const relaunch = async () => {
    const run = readRegistry(join(claudeDir({ env }), 'orca-runs.jsonl')).find((r) => r.runDir && resolve(r.runDir) === resolve(stateDir))
    if (!run) throw new Error("the run has no record in crew's run registry, so its runner cannot be started again: the operator resumes it with r in `crew view`.")
    if (run.reclaimed) throw new Error('the run is reclaimed: its agents are gone and the registry closed it, so there is nothing to resume.')
    if (!run.project) throw new Error('the run has no project recorded to resume it in.')
    const script = run.script ?? join(resolve(stateDir, '..'), 'workflow.js')
    const paths = crewPaths(env)
    const t = await crewHost({ paths, env, cwd: run.project }).resumeRunner({ worktree: run.project, title: `${run.spec ?? run.runId} (resumed)`, runner: RUNNER_PATH, script, stateDir, permissionMode: run.permissionMode })
    return t.terminal
  }
  return [
    {
      name: 'run_status',
      label: 'Run status',
      parameters: { type: 'object', properties: {} },
      async call() {
        return JSON.stringify(runReport(stateDir), null, 2)
      },
    },
    {
      name: 'agent_result',
      label: 'Agent result',
      parameters: { type: 'object', required: ['agent'], properties: { agent: { type: 'string', description: "The agent's node, its title (with or without its [Phase]), or its call number, as run_status lists them." } } },
      async call({ agent }) {
        return JSON.stringify(agentReport(stateDir, agent), null, 2)
      },
    },
    {
      name: 'runner_log',
      label: 'Runner log',
      parameters: { type: 'object', properties: { lines: { type: 'integer', minimum: 1, maximum: LOG_LINES_MAX, description: `How many of its last lines, ${LOG_LINES} when not given.` } } },
      async call({ lines = LOG_LINES } = {}) {
        const n = Number.isInteger(lines) ? Math.min(Math.max(lines, 1), LOG_LINES_MAX) : LOG_LINES
        return runnerLogTail(stateDir, n)
      },
    },
    {
      name: 'pause',
      label: 'Pause',
      parameters: { type: 'object', properties: {} },
      async call() {
        return pauseRun(stateDir, new Date()) ? 'Paused: no new agent starts, and every agent at work finishes. resume lifts it.' : 'Already paused: resume lifts it.'
      },
    },
    {
      name: 'resume',
      label: 'Resume',
      parameters: { type: 'object', properties: { node: { type: 'string', description: 'One held node to carry on, as run_status names it under halted. Every held node when not given.' } } },
      async call({ node = null } = {}) {
        const held = heldNodes(stateDir)
        const paused = pausedAt(stateDir)
        const report = runReport(stateDir, { alive: runnerAlive })
        if (report.alive !== true) {
          // As the tree's r on a run with no runner: a pause is lifted, and
          // only then is a runner started again.
          const pending = held.length || report.reopened.length || report.state === 'runner gone'
          if (paused) {
            unpauseRun(stateDir)
            return `Lifted the pause, as r in the run console does: the agents it held start.${pending ? " The run's runner is not running: resume again starts it." : ''}`
          }
          if (report.alive === null) throw new Error("whether the run's runner is alive cannot be told (its runner.pid did not answer), so nothing was started.")
          if (!pending) return 'Nothing to resume: the run ended, and no node of it is reopened. reopen one first, once the operator has agreed its fix with you.'
          const carried = [...held.map((n) => `${n.node} (${heldFor(n)})`), ...report.reopened.map((n) => `${n.node} (reopened)`)]
          if (node !== null && !carried.some((c) => c.startsWith(`${node} (`))) throw new Error(`${node} is neither held nor reopened: ${carried.length ? `the run's are ${carried.join(', ')}` : 'the run has none'}. Nothing was started.`)
          const id = await relaunch()
          return `Started the run's runner again with --resume, in crew session ${id}, as r in the run console does: it replays every node that succeeded${carried.length ? `, and carries on ${carried.join(', ')}` : ', and goes on from where its last runner stopped'}.`
        }
        if (!held.length && !paused) return 'Nothing to resume: the run is neither paused nor halted.'
        if (node !== null && !held.some((n) => n.node === node)) throw new Error(`${node} is not held: ${held.length ? `the held nodes are ${named(held)}` : 'the run is not halted'}. Nothing was asked of the runner.`)
        // A halt is the runner's to carry on: refused before anything is done when it is gone.
        const { send } = held.length ? runner() : { send: null }
        if (paused) unpauseRun(stateDir)
        if (send) send({ node })
        const lifted = paused ? 'Lifted the pause, as r in the run console does: the agents it held start.' : ''
        if (!held.length) return lifted
        const then = node
          ? heldFor(held.find((n) => n.node === node)) === 'needs decisions'
            ? ' Its worker is told the operator answered its questions on the ticket: use decide to hand it the answers instead.'
            : ' Its worker is told the run was halted here and to finish.'
          : held.some((n) => heldFor(n) === 'needs decisions')
            ? ' A node that needs decisions is told the operator answered them on the ticket: use decide to hand its worker the answers instead.'
            : ' Each worker is told the run was halted here and to finish.'
        return `${lifted ? `${lifted} ` : ''}Asked the runner to carry ${node ? `node ${node}` : `every held node (${held.map((n) => n.node).join(', ')})`} on, as r in the run console does.${then}`
      },
    },
    {
      name: 'decide',
      label: 'Decide',
      parameters: {
        type: 'object',
        required: ['node', 'decisions'],
        properties: {
          node: { type: 'string', description: 'The held node that asked, as run_status names it under halted.' },
          decisions: {
            type: 'array',
            minItems: 1,
            items: { type: 'object', required: ['question', 'answer'], properties: { question: { type: 'string', description: 'The question, as the node asked it.' }, answer: { type: 'string', description: "The operator's answer, in their words." } } },
            description: 'Every question the node asked, each with its answer.',
          },
        },
      },
      async call({ node, decisions }) {
        const given = decisionsOf(decisions)
        if (!given || given.length !== decisions.length) throw new Error('decide needs at least one decision, each a question and its answer.')
        const { send } = runner()
        const held = heldNodes(stateDir)
        const asking = held.filter((n) => heldFor(n) === 'needs decisions')
        const it = held.find((n) => n.node === node)
        if (!it) throw new Error(`${node} is not held: ${held.length ? `the held nodes are ${named(held)}` : 'the run is not halted'}. Nothing was asked of the runner.`)
        if (heldFor(it) !== 'needs decisions') throw new Error(`${node} is held because it failed, not for decisions: resume carries it on. ${asking.length ? `The nodes that need decisions are ${asking.map((n) => n.node).join(', ')}.` : 'No node needs decisions.'}`)
        send({ node, decisions: given })
        return `Answered ${given.length} decision${given.length === 1 ? '' : 's'} for node ${node} and asked the runner to carry it on: its worker is told your answers and finishes with them.`
      },
    },
    {
      name: 'reopen',
      label: 'Reopen',
      parameters: {
        type: 'object',
        required: ['node', 'note'],
        properties: {
          node: { type: 'string', description: 'The node to reopen, as run_status names it: one that settled with a result.' },
          note: { type: 'string', description: 'What was fixed, and how its agent finishes, as agreed with the operator. Its agent takes it as final.' },
        },
      },
      async call({ node, note }) {
        const { title } = reopenNode(stateDir, { node, note })
        return `Reopened node ${node}${title ? ` (${title})` : ''}: the next resume carries it on in its own session with your note, instead of replaying its result, and replays every other node that succeeded. resume starts the run's runner again.`
      },
    },
  ]
}
