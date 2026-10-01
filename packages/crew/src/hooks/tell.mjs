// A harness's side of what it waits on: tells the crew daemon, for the
// session the harness runs in (CREW_SESSION, under CREW_HOME), what a
// reader of waiting.mjs made of one event. Outside a crew session, or with no
// daemon there, it does nothing: a hook or extension must never fail the
// harness it runs in.
import { request } from '../daemon/client.mjs'
import { crewPaths } from '../daemon/transport.mjs'

export async function tell(said, env = process.env) {
  if (!said || !env.CREW_SESSION) return
  try {
    await request(crewPaths(env), { op: 'session.waiting', id: env.CREW_SESSION, ...said }, { timeoutMs: 2_000 })
  } catch {}
}
