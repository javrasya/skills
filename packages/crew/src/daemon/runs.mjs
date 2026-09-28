// The daemon's runs: crew's own Runs, the dispatch each worker session runs
// under, and each Run's mailbox, the same shapes the Orca host answers in
// (orca-cli.mjs). They live as long as the daemon, as its sessions do: a
// daemon restart ends every session, so no Run outlives it either.
//
// A Run is bound to the coordinator that created it or last took it over
// (run.use), as Orca binds one to a terminal: a worker started into it by any
// other is refused consumer_fenced, and a check reads only the Run bound to
// the coordinator asking. A dispatch is its worker's session id; its task id
// and capability are crew's, typed to the worker in its preamble, and a
// message sent as that dispatch must name its task id, and its session and
// capability when it names them at all (a prompt typed again carries no
// capability). A worker_done settles its dispatch.
//
// The mailbox is Orca's: a check freezes every waiting message into a batch
// and hands that batch back, marked replayed, until it is acknowledged; `ack`
// names the batch, and the answer is the next one. run.use re-batches an
// unacknowledged batch, its messages' ids kept.
//
//   run.create { objective, coordinator }       → { run: { id, coordinator } }
//   run.use { id, coordinator }                 → { run: { id, coordinator } }
//   run.worker { run, session, coordinator }    → { worker: { taskId, capability } }
//   worker.show { id }                          → { worker: { settled, outcome, gone, exited, waiting, terminal } }
//   worker.stop { id }                          → { worker }: its program ended, unsettled ones cancelled
//   worker.release { id }                       → { worker }
//   mail.send { from, capability, taskId, dispatchId, type, subject, body, outcome } → { id }
//   mail.check { coordinator, ack }             → { deliveryId, acknowledged, replayed, messages }
//   worktree.status { path, status }            → { path, status }
//   worktree.statuses                           → { statuses: { <path>: <status> } }
import { randomBytes } from 'crypto'

// What a worker may send to its Run's mailbox: its result, and a doctor's report.
export const MAIL_TYPES = Object.freeze(['worker_done', 'handoff', 'escalation'])
const OUTCOMES = new Set(['succeeded', 'failed'])
const STATUSES = new Set(['todo', 'in-progress', 'in-review', 'completed'])

const hex = (n) => randomBytes(n).toString('hex')

// sessions: the daemon's, by id, each with info().
export function runBook({ sessions, now = () => new Date().toISOString() }) {
  const runs = new Map()
  const dispatches = new Map()
  const statuses = new Map()
  let messages = 0
  let deliveries = 0

  const runOf = (id) => {
    const r = runs.get(String(id))
    if (!r) throw new Error(`run_not_found: no crew run ${id}`)
    return r
  }
  const dispatchOf = (id) => {
    const d = dispatches.get(String(id))
    if (!d) throw new Error(`dispatch_not_found: no dispatch ${id}`)
    return d
  }
  const word = (s, what) => {
    if (typeof s !== 'string' || !s) throw new Error(`not a ${what}: ${JSON.stringify(s)?.slice(0, 80)}`)
    return s
  }
  const shown = (r) => ({ id: r.id, coordinator: r.coordinator })

  const show = (d) => {
    const s = sessions.get(d.id)?.info() ?? null
    return { settled: d.settled, outcome: d.outcome, gone: !s, exited: !!s && !s.alive, waiting: null, terminal: d.id }
  }

  const ops = {
    'run.create': ({ objective = '', coordinator }) => {
      const r = { id: `run_${hex(6)}`, objective: String(objective), coordinator: word(coordinator, 'coordinator'), pending: [], batch: null, acked: new Set() }
      runs.set(r.id, r)
      return { run: shown(r) }
    },
    'run.use': ({ id, coordinator }) => {
      const r = runOf(id)
      r.coordinator = word(coordinator, 'coordinator')
      if (r.batch) {
        r.pending.unshift(...r.batch.messages)
        r.batch = null
      }
      return { run: shown(r) }
    },
    'run.worker': ({ run, session, coordinator }) => {
      const r = runOf(run)
      if (r.coordinator !== coordinator) throw new Error(`consumer_fenced: this coordinator is no longer bound to run ${r.id}`)
      if (!sessions.has(String(session))) throw new Error(`no session ${session}`)
      if (dispatches.has(String(session))) throw new Error(`session ${session} already runs a dispatch`)
      const d = { id: String(session), run: r.id, taskId: `task_${hex(6)}`, capability: `cap_${hex(12)}`, settled: false, outcome: null, released: false }
      dispatches.set(d.id, d)
      return { worker: { taskId: d.taskId, capability: d.capability } }
    },
    'worker.show': ({ id }) => ({ worker: show(dispatchOf(id)) }),
    'worker.stop': ({ id }) => {
      const d = dispatchOf(id)
      sessions.get(d.id)?.kill()
      if (!d.settled) Object.assign(d, { settled: true, outcome: 'cancelled' })
      return { worker: show(d) }
    },
    'worker.release': ({ id }) => {
      const d = dispatchOf(id)
      d.released = true
      return { worker: show(d) }
    },
    'mail.send': ({ from = null, capability = null, taskId, dispatchId, type, subject = '', body = '', outcome = null }) => {
      const d = dispatchOf(dispatchId)
      if (d.taskId !== taskId || (from != null && from !== d.id) || (capability != null && capability !== d.capability)) {
        throw new Error(`consumer_fenced: a message from ${dispatchId} does not match its preamble`)
      }
      if (!MAIL_TYPES.includes(type)) throw new Error(`not a message type crew takes: ${JSON.stringify(type)}; one of ${MAIL_TYPES.join(', ')}`)
      if (outcome != null && (type !== 'worker_done' || !OUTCOMES.has(outcome))) throw new Error(`not an outcome for ${type}: ${JSON.stringify(outcome)}`)
      const m = {
        id: `msg_${++messages}_${hex(3)}`, type, from: d.id, subject: String(subject), body: String(body),
        taskId: d.taskId, dispatchId: d.id, outcome: type === 'worker_done' ? outcome ?? 'succeeded' : null, createdAt: now(),
      }
      runOf(d.run).pending.push(m)
      if (type === 'worker_done' && !d.settled) Object.assign(d, { settled: true, outcome: m.outcome })
      return { id: m.id }
    },
    'mail.check': ({ coordinator, ack = null }) => {
      const r = [...runs.values()].reverse().find((x) => x.coordinator === coordinator) ?? null
      let acknowledged = null
      if (r && ack) {
        if (r.batch?.id !== ack && !r.acked.has(ack)) throw new Error('stale_delivery: --ack requires a delivery id a check returned')
        if (r.batch?.id === ack) r.batch = null
        r.acked.add(ack)
        acknowledged = ack
      }
      const replayed = !!r?.batch
      if (r && !r.batch && r.pending.length) r.batch = { id: `delivery_${++deliveries}_${hex(3)}`, messages: r.pending.splice(0) }
      const b = r?.batch ?? null
      return { deliveryId: b?.id ?? null, acknowledged, replayed, messages: b ? b.messages.map((m) => ({ ...m })) : [] }
    },
    'worktree.status': ({ path, status }) => {
      if (!STATUSES.has(status)) throw new Error(`not a worktree status: ${JSON.stringify(status)}; one of ${[...STATUSES].join(', ')}`)
      statuses.set(word(path, 'worktree path'), status)
      return { path, status }
    },
    'worktree.statuses': () => ({ statuses: Object.fromEntries(statuses) }),
  }

  // The runs not over: those with a worker whose program still runs.
  const liveRuns = () => [...new Set([...dispatches.values()].filter((d) => sessions.get(d.id)?.info().alive).map((d) => d.run))]

  return { ops, liveRuns }
}
