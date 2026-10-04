// crew's tools (tools.mjs, ADR-0027) as a session's harness gives them: pi
// registers them in its extension (crew-pi.mjs), Claude lists them from crew's
// MCP server (crew-mcp.mjs). Each is one daemon op keyed by the session's id
// (CREW_SESSION, under CREW_HOME); a refusal throws the daemon's words, and a
// daemon gone throws them named, with what the agent does instead.
import { request, daemonGone } from '../daemon/client.mjs'
import { crewPaths } from '../daemon/transport.mjs'
import { NOTE_MAX, submitShape, tool } from '../tools.mjs'
import { sleep } from '../util.mjs'

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
  return all.filter((t) => tool(t.name).who.includes(agent.role)).map((t) => ({ ...t, description: tool(t.name).description }))
}
