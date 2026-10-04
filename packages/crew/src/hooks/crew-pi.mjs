// crew's pi extension, loaded into a worker's session only (`pi -e`, crew-host
// launchWords), never installed: it tells the crew daemon when pi takes a
// prompt, and when an extension's dialog waits on the person, and when it no
// longer does (waiting.mjs). A worker's session it also gives crew's `submit`
// tool (tools.mjs, ADR-0027), its parameters its result's schema as the
// daemon holds it on the session's dispatch, so pi itself rejects a payload
// that does not match, in the turn. A worker's or a doctor's session gets
// `status` and `needs_you` (#175); a doctor's needs_you is its escalation,
// sent as mail. A doctor's also gets `handoff` and `give_up`, which end its
// round (#176). A session of no agent, or one outside crew, gets no tool.
// Nothing else of pi's is changed.
import { request, daemonGone } from '../daemon/client.mjs'
import { crewPaths } from '../daemon/transport.mjs'
import { NOTE_MAX, SUBMIT, submitShape, tool } from '../tools.mjs'
import { sleep } from '../util.mjs'
import { piWaiting } from '../waiting.mjs'
import { tell } from './tell.mjs'

// How long a session crew started for an agent (CREW_AGENT) waits for its
// dispatch: its runner makes it just after the session, which may start first.
const DISPATCH_MS = 5_000

export default function crewPi(pi, env = process.env) {
  // In order: an end sent before its start would leave the session waiting.
  // Each handler awaits its own request, so a daemon gone or refusing is
  // pi's to report, as an extension error. The next request waits for the
  // last to settle, not to succeed: one that failed was reported by its own
  // handler, and must not stop those after it.
  let told = Promise.resolve()
  const relay = async (op, said) => {
    const turn = Promise.allSettled([told]).then(() => tell(op, said, env))
    told = turn
    await turn
  }

  // The agent the session's dispatch runs, or null: none, or no daemon to
  // ask, leaves the session without tools, its prompt's CLI line its way.
  const agentOf = async () => {
    if (!env.CREW_SESSION) return null
    const until = Date.now() + DISPATCH_MS
    try {
      for (;;) {
        const { agent } = await request(crewPaths(env), { op: 'worker.schema', id: env.CREW_SESSION }, { timeoutMs: 2_000 })
        if (agent || env.CREW_AGENT !== '1' || Date.now() > until) return agent
        await sleep(50)
      }
    } catch {
      return null
    }
  }

  let equipped = false
  const equip = async () => {
    if (equipped) return
    const agent = await agentOf()
    if (!agent) return
    equipped = true
    // One daemon op by the session's id; a daemon gone is named, with what
    // the agent does instead.
    const ask = async (said, instead) => {
      try {
        return await request(crewPaths(env), { ...said, id: env.CREW_SESSION })
      } catch (e) {
        if (!daemonGone(e)) throw e
        throw new Error(`crew's daemon is not reachable (${e.message}). ${instead}`)
      }
    }
    const text = (t) => ({ content: [{ type: 'text', text: t }], details: undefined })
    pi.registerTool({
      name: 'status',
      label: 'Status',
      description: tool('status').description,
      parameters: { type: 'object', required: ['note'], properties: { note: { type: 'string', description: `One line, at most ${NOTE_MAX} characters.` } } },
      async execute(_toolCallId, { note }) {
        const said = await ask({ op: 'worker.status', note }, 'Your note was not posted: carry on with your task.')
        return text(said.note ? `Posted: the operator sees "${said.note}" on your row.` : 'Cleared your note.')
      },
    })
    pi.registerTool({
      name: 'needs_you',
      label: 'Needs you',
      description: tool('needs_you').description,
      parameters: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', description: 'What the human must do or decide.' } } },
      async execute(_toolCallId, { reason }) {
        const instead = `The operator was not told. Run this instead, with the IDs your instructions give: ${tool('needs_you').fallback()}`
        if (agent.role === 'doctor') await ask({ op: 'worker.mail', type: 'escalation', subject: 'needs you', body: reason }, instead)
        else await ask({ op: 'worker.needsYou', reason }, instead)
        return text('The operator is told you need them, and why. Wait for them in this session, for as long as they take.')
      },
    })
    if (agent.role === 'doctor') {
      pi.registerTool({
        name: 'handoff',
        label: 'Hand off',
        description: tool('handoff').description,
        parameters: { type: 'object', required: ['note'], properties: { note: { type: 'string', description: 'Your note: the guidance the patient carries on with.' } } },
        async execute(_toolCallId, { note }) {
          await ask({ op: 'worker.handoff', note }, `Your note was not sent. Send it over Run mail instead, with the IDs your instructions give: ${tool('handoff').fallback()}`)
          return text('Handed off: the runner carries the patient on with your note, and your round is over. Nothing remains for you: stop and idle.')
        },
      })
      pi.registerTool({
        name: 'give_up',
        label: 'Give up',
        description: tool('give_up').description,
        parameters: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', description: 'Why no note of yours can cure the patient.' } } },
        async execute(_toolCallId, { reason }) {
          await ask({ op: 'worker.giveUp', reason }, `The run was not told. Send it over Run mail instead, with the IDs your instructions give: ${tool('give_up').fallback()}`)
          return text('Gave up: your round is over, with no note. Nothing remains for you: stop and idle.')
        },
      })
      return
    }
    const shape = submitShape(agent.schema)
    pi.registerTool({
      name: 'submit',
      label: 'Submit',
      description: tool('submit').description,
      parameters: shape.parameters,
      async execute(_toolCallId, args) {
        let said
        try {
          said = await request(crewPaths(env), { op: 'worker.submit', id: env.CREW_SESSION, payload: shape.payload(args) })
        } catch (e) {
          if (!daemonGone(e)) throw e
          throw new Error(`crew's daemon is not reachable (${e.message}), so your result was not submitted. Submit it with the command line in your instructions instead (node "${SUBMIT}" …), as they say.`)
        }
        const where = said.resultPath ? ` It is recorded at ${said.resultPath}.` : ''
        return { content: [{ type: 'text', text: `Submitted: the workflow has your result.${where} Nothing remains for this task: stop and idle.` }], details: undefined }
      },
    })
  }

  // pi wires its editor's submit before it emits session_start, so a prompt
  // typed from here on is taken; one typed earlier sits in the editor with
  // "Startup is still in progress". Its terminal says nothing of this: an
  // extension's status line may keep it drawing for good. The tool goes in
  // first, so the prompt crew types once it hears is never one without it.
  pi.on('session_start', async () => {
    await equip()
    await relay('session.ready', {})
  })
  pi.on('ui_prompt_start', (event) => relay('session.waiting', piWaiting(event)))
  pi.on('ui_prompt_end', (event) => relay('session.waiting', piWaiting(event)))
}
