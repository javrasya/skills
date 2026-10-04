// crew's pi extension, loaded into a worker's session only (`pi -e`, crew-host
// launchWords), never installed: it tells the crew daemon when pi takes a
// prompt, and when an extension's dialog waits on the person, and when it no
// longer does (waiting.mjs). A worker's session it also gives crew's `submit`
// tool (tools.mjs, ADR-0027), its parameters its result's schema as the
// daemon holds it on the session's dispatch, so pi itself rejects a payload
// that does not match, in the turn. A session of no agent, a doctor's, or
// one outside crew gets no tool. Nothing else of pi's is changed.
import { request, daemonGone } from '../daemon/client.mjs'
import { crewPaths } from '../daemon/transport.mjs'
import { SUBMIT, submitShape, tool } from '../tools.mjs'
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
    if (agent?.role !== 'worker') return
    equipped = true
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
