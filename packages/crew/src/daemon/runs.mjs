// The daemon's runs: crew's own Runs, the dispatch each worker session runs
// under, and each Run's mailbox, the same shapes the Orca host answers in
// (orca-cli.mjs). They outlive the daemon, kept in the crew home's runs.json,
// while its sessions do not: a daemon that dies (a crash, a kill, a reboot, a
// forced stop) takes every session with it. The next daemon knows which of its
// sessions were still running then: a dispatch lost that way shows `hostDied`,
// so its session is continued uncounted (#104), and a Run whose runner session
// was lost, and the run registry still has live, is one it starts a runner
// for again (recoverable). Session ids are never handed out twice, across
// daemons too, since a dispatch is its session's id.
//
// A Run is bound to the coordinator that created it or last took it over
// (run.use), and knows the session that coordinator's runner runs in, when it
// runs in one of crew's (`runner`); as Orca binds one to a terminal: a worker started into it by any
// other is refused consumer_fenced, and a check reads only the Run bound to
// the coordinator asking. A dispatch is its worker's session id; its task id
// and capability are crew's, typed to the worker in its preamble, and a
// message sent as that dispatch must name its task id, and its session and
// capability when it names them at all (a prompt typed again carries no
// capability). A worker_done settles its dispatch.
//
// A Run whose objective is an orchestrator question's title (orchestrator.mjs)
// is flagged `orchestrator` at its creation: it is crew's own question, no
// workflow run, so it is never live, and it is dropped from the book, its
// dispatches with it, once every session of it is closed, and by the next
// daemon, which none of its sessions outlive.
//
// The mailbox is Orca's: a check freezes every waiting message into a batch
// and hands that batch back, marked replayed, until it is acknowledged; `ack`
// names the batch, and the answer is the next one. run.use re-batches an
// unacknowledged batch, its messages' ids kept.
//
//   run.create { objective, coordinator, runner } → { run: { id, coordinator } }
//   run.use { id, coordinator, runner }         → { run: { id, coordinator } }
//   run.worker { run, session, coordinator }    → { worker: { taskId, capability } }
//   worker.show { id }                          → { worker: { settled, outcome, gone, exited, waiting, terminal, hostDied? } }
//   worker.stop { id }                          → { worker }: its program ended, unsettled ones cancelled
//   worker.release { id }                       → { worker }
//   mail.send { from, capability, taskId, dispatchId, type, subject, body, outcome } → { id }
//   mail.check { coordinator, ack }             → { deliveryId, acknowledged, replayed, messages }
//   worktree.status { path, status }            → { path, status }
//   worktree.statuses                           → { statuses: { <path>: <status> } }
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { basename } from 'path'
import { fileURLToPath } from 'url'
import { readRegistry } from '../registry.mjs'
import { DEFAULT_HOST } from '../hosts.mjs'
import { isOrchestratorTitle } from '../orchestrator.mjs'

// The runner every launch of one starts: `crew run`, `crew start`, crew's own
// recovery and the run views' R.
export const RUNNER_PATH = fileURLToPath(new URL('../runner.mjs', import.meta.url))

// The runner's words past its program, the one place its command line is
// built: on `host`, none named when null (a runner that names none is on
// LEGACY_HOST), always naming its state dir, and resuming from it by default,
// as the run view's R and crew's own recovery do.
export const runnerArgs = ({ runner = RUNNER_PATH, script, host = DEFAULT_HOST, stateDir, resume = true, permissionMode = null }) =>
  [runner, script, ...(host ? ['--host', host] : []), '--state-dir', stateDir, ...(resume ? ['--resume'] : []), ...(permissionMode ? ['--permission-mode', permissionMode] : [])]

// The runner's command line as a crew session runs it.
export const runnerCommand = (options) => [process.execPath, ...runnerArgs({ ...options, host: 'crew' })]

export const runnerTitle = (script) => `crew run ${basename(script)}`

// What a worker may send to its Run's mailbox: its result, and a doctor's report.
export const MAIL_TYPES = Object.freeze(['worker_done', 'handoff', 'escalation'])
const OUTCOMES = new Set(['succeeded', 'failed'])
const STATUSES = new Set(['todo', 'in-progress', 'in-review', 'completed'])

const hex = (n) => randomBytes(n).toString('hex')

// sessions: the daemon's, by id, each with info(). file: where the book is
// kept, null for nowhere; registry: the run registry, which says whether a Run
// is live, null for none.
export function runBook({ sessions, now = () => new Date().toISOString(), file = null, registry = null }) {
  const runs = new Map()
  const dispatches = new Map()
  const statuses = new Map()
  let messages = 0
  let deliveries = 0
  let nextSession = 1
  // Sessions running now; `died`, those an earlier daemon had running when it went.
  const running = new Set()
  let died = new Set()

  let kept = null
  try {
    kept = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  } catch {
    // Written whole by rename, so only a hand-edited book fails to parse: the
    // daemon still starts, with no runs.
  }
  if (kept) {
    for (const r of kept.runs ?? []) if (!r.orchestrator) runs.set(r.id, { ...r, acked: new Set(r.acked) })
    for (const d of kept.dispatches ?? []) if (runs.has(d.run)) dispatches.set(d.id, d)
    for (const [path, status] of Object.entries(kept.statuses ?? {})) statuses.set(path, status)
    ;({ messages = 0, deliveries = 0, nextSession = 1 } = kept)
    died = new Set(kept.running ?? [])
  }
  const save = () => {
    if (!file) return
    const book = {
      runs: [...runs.values()].map((r) => ({ ...r, acked: [...r.acked] })), dispatches: [...dispatches.values()],
      statuses: Object.fromEntries(statuses), messages, deliveries, nextSession, running: [...running, ...died],
    }
    // Whole or not at all: a daemon killed mid-write must not lose the book.
    writeFileSync(`${file}.tmp`, JSON.stringify(book))
    renameSync(`${file}.tmp`, file)
  }
  const runnerOf = (runner) => (runner == null ? null : String(runner))

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
    return { settled: d.settled, outcome: d.outcome, gone: !s, exited: !!s && !s.alive, waiting: null, terminal: d.id, ...(!s && !d.settled && died.has(d.id) && { hostDied: true }) }
  }

  const ops = {
    'run.create': ({ objective = '', coordinator, runner = null }) => {
      const r = {
        id: `run_${hex(6)}`, objective: String(objective), coordinator: word(coordinator, 'coordinator'), runner: runnerOf(runner), pending: [], batch: null, acked: new Set(),
        ...(isOrchestratorTitle(objective) && { orchestrator: true }),
      }
      runs.set(r.id, r)
      return { run: shown(r) }
    },
    'run.use': ({ id, coordinator, runner = null }) => {
      const r = runOf(id)
      r.coordinator = word(coordinator, 'coordinator')
      r.runner = runnerOf(runner)
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

  for (const [name, op] of Object.entries(ops)) {
    if (name === 'worker.show' || name === 'worktree.statuses') continue
    ops[name] = (...args) => {
      const reply = op(...args)
      save()
      return reply
    }
  }

  const alive = (id) => !!id && sessions.get(id)?.info().alive === true
  const registered = () => new Map((registry ? readRegistry(registry) : []).map((e) => [e.runId, e]))
  const unfinished = (e) => (e.state === 'running' || e.state === 'halted') && !e.reclaimed
  const named = (r, e) => (e?.spec ? `${r.id} (${e.spec})` : r.id)

  // The runs not over, each named with its spec when the registry has it: a
  // run the registry has, while it is running or halted and its runner or a
  // worker of it still runs; any other but an orchestrator's, while a worker
  // of it does.
  function liveRuns() {
    const book = registered()
    const working = new Set([...dispatches.values()].filter((d) => alive(d.id)).map((d) => d.run))
    return [...runs.values()].filter((r) => {
      if (r.orchestrator) return false
      const e = book.get(r.id)
      return e ? unfinished(e) && (alive(r.runner) || working.has(r.id)) : working.has(r.id)
    }).map((r) => named(r, book.get(r.id)))
  }

  // The runs whose runner session died with an earlier daemon while the
  // registry still has them running or halted: { runId, script, runDir,
  // project, permissionMode }, what starting their runner again takes.
  function recoverable() {
    const book = registered()
    return [...runs.values()].filter((r) => r.runner && died.has(r.runner) && book.get(r.id) && unfinished(book.get(r.id))).map((r) => {
      const { script, runDir, project, permissionMode } = book.get(r.id)
      return { runId: r.id, script, runDir, project, permissionMode }
    })
  }

  return {
    ops,
    liveRuns,
    recoverable,
    // A new session's id: never one an earlier daemon handed out.
    sessionId() {
      const id = String(nextSession++)
      save()
      return id
    },
    started(id) {
      running.add(id)
      save()
    },
    ended(id) {
      if (running.delete(id)) save()
    },
    // Session `id` is closed: the orchestrator Run it was a dispatch of goes,
    // once no session of it is left.
    closed(id) {
      const r = runs.get(dispatches.get(String(id))?.run)
      if (!r?.orchestrator) return
      const own = [...dispatches.values()].filter((d) => d.run === r.id)
      if (own.some((d) => sessions.has(d.id))) return
      for (const d of own) dispatches.delete(d.id)
      runs.delete(r.id)
      save()
    },
    // A recovered run's runner is its new session from now on: recovered once.
    recovered(runId, session) {
      runs.get(runId).runner = session
      save()
    },
  }
}
