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
// The tools themselves are crew-tools.mjs's, shared with Claude's MCP server.
// Nothing else of pi's is changed.
import { piWaiting } from '../waiting.mjs'
import { sessionAgent, crewTools } from './crew-tools.mjs'
import { tell } from './tell.mjs'

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

  let equipped = false
  const equip = async () => {
    if (equipped) return
    const agent = await sessionAgent(env)
    if (!agent) return
    equipped = true
    for (const { call, ...t } of crewTools(agent, env)) {
      pi.registerTool({ ...t, execute: async (_toolCallId, args) => ({ content: [{ type: 'text', text: await call(args) }], details: undefined }) })
    }
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
