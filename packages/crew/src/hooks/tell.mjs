// A harness's side of its own events: tells the crew daemon, for the session
// the harness runs in (CREW_SESSION, under CREW_HOME), one request `op` about
// it: session.waiting with what a reader of waiting.mjs made of one event, or
// session.ready. Outside a crew session, or with nothing to say, it does
// nothing. A daemon gone or refusing throws: each caller reports that its
// own way, since a hook or extension must never fail the harness it runs in.
import { request } from '../daemon/client.mjs'
import { crewPaths } from '../daemon/transport.mjs'

export async function tell(op, said, env = process.env) {
  if (!said || !env.CREW_SESSION) return
  await request(crewPaths(env), { op, id: env.CREW_SESSION, ...said }, { timeoutMs: 2_000 })
}
