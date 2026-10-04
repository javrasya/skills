// The daemon's runs: crew's own Runs, the dispatch each worker session runs
// under, and each Run's mailbox, the same shapes the Orca host answers in
// (orca-cli.mjs). They outlive the daemon, kept in its store (store.mjs),
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
// capability). A worker_done settles its dispatch, and every one it sends,
// settled or not, is counted (`submissions`) and taken as its outcome and its
// last result: an agent of a node its runner holds may submit again (#173).
// The result is the value submit validated, sent along with the worker_done;
// null for one that sent none (`crew orchestration send`).
//
// A dispatch also knows its agent's role (a worker, or a doctor), the schema
// its result is checked against, null for a text result, and the file its
// runner reads that result from: what the runner's run.worker named, so a
// session can submit by its id alone (worker.submit), checked again here as
// submit checks it, and send its mail (worker.mail). Either is refused a
// session of no dispatch, or of one released; a doctor submits nothing, and
// a worker's result goes only through submit. A doctor ends its round by its
// id too (#176): worker.handoff sends its note as a handoff, then its
// worker_done succeeded, and worker.giveUp its worker_done failed, the reason
// its body: the mail its prompt's CLI line sends, each in one op. A worker
// has no round, so either refuses it.
//
// A session may also set a note, what it is doing now, cut to NOTE_MAX
// (worker.status), and say it needs the person, and why (worker.needsYou), both
// kept on its dispatch for worker.show (#175). Crew acts on nothing in a note.
// Needs-you holds until the session's next note or message, any mail.send
// for its dispatch included (`crew orchestration send`). A doctor's needs-you
// is its escalation, sent as mail, so worker.needsYou refuses a doctor.
//
// A Run whose objective is an orchestrator question's title (orchestrator.mjs)
// is flagged `orchestrator` at its creation: it is crew's own question, no
// workflow run, so it is never live, and it is dropped from the book, its
// dispatches with it, once every session of it is closed, and by the next
// daemon, which none of its sessions outlive. A session of no Run titled as
// the orchestrator's `?` is (`console`): the person's conversation about a
// run, kept for the next daemon as an agent's session is (#168).
//
// The mailbox is Orca's: a check freezes every waiting message into a batch
// and hands that batch back, marked replayed, until it is acknowledged; `ack`
// names the batch, and the answer is the next one. run.use re-batches an
// unacknowledged batch, its messages' ids kept.
//
//   run.create { objective, coordinator, runner } → { run: { id, coordinator } }
//   run.use { id, coordinator, runner }         → { run: { id, coordinator } }
//   run.worker { run, session, coordinator, role, schema, resultPath } → { worker: { taskId, capability } }
//   worker.show { id }                          → { worker: { settled, outcome, submissions, note, needsYou, gone, exited, waiting, terminal, hostDied? } }
//   worker.result { id }                        → { result, outcome, submissions }: its last worker_done's
//   worker.stop { id }                          → { worker }: its program ended, unsettled ones cancelled
//   worker.release { id }                       → { worker }
//   worker.schema { id }                        → { agent: { role, schema } | null }: session id's, null for one of no dispatch or a released one
//   worker.submit { id, payload }               → { id, resultPath }: session id's result, sent as its worker_done
//   worker.mail { id, type, subject, body, outcome } → { id }: as mail.send, from session id
//   worker.handoff { id, note }                 → { id }: a doctor's note, as a handoff and its worker_done; id the handoff's
//   worker.giveUp { id, reason }                → { id }: a doctor's worker_done failed, the reason its body
//   worker.status { id, note }                  → { note }: session id's note, as kept
//   worker.needsYou { id, reason }              → { needsYou }: session id's reason
//   mail.send { from, capability, taskId, dispatchId, type, subject, body, outcome, result } → { id }
//   mail.check { coordinator, ack }             → { deliveryId, acknowledged, replayed, messages }
//   worktree.status { path, status }            → { path, status }
//   worktree.statuses                           → { statuses: { <path>: <status> } }
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRegistry } from '../registry.mjs'
import { DEFAULT_HOST } from '../hosts.mjs'
import { isOrchestratorTitle } from '../orchestrator.mjs'
import { validate } from '../schema.mjs'
import { NOTE_MAX } from '../tools.mjs'
import { writeJsonAtomic } from '../fsutil.mjs'

// The runner every launch of one starts: `crew run`, `crew start`, crew's own
// recovery and the run views' r.
export const RUNNER_PATH = fileURLToPath(new URL('../runner.mjs', import.meta.url))

// The runner's words past its program, the one place its command line is
// built: on `host`, none named when null (a runner that names none is on
// LEGACY_HOST), always naming its state dir, and resuming from it by default,
// as the run view's r and crew's own recovery do.
export const runnerArgs = ({ runner = RUNNER_PATH, script, host = DEFAULT_HOST, stateDir, resume = true, permissionMode = null }) => [runner, script, ...(host ? ['--host', host] : []), '--state-dir', stateDir, ...(resume ? ['--resume'] : []), ...(permissionMode ? ['--permission-mode', permissionMode] : [])]

// The runner's command line as a crew session runs it.
export const runnerCommand = (options) => [process.execPath, ...runnerArgs({ ...options, host: 'crew' })]

export const runnerTitle = (script) => `crew run ${basename(script)}`

// What a worker may send to its Run's mailbox: its result, and a doctor's report.
export const MAIL_TYPES = Object.freeze(['worker_done', 'handoff', 'escalation'])
const OUTCOMES = new Set(['succeeded', 'failed'])
const STATUSES = new Set(['todo', 'in-progress', 'in-review', 'completed'])
export const ROLES = Object.freeze(['worker', 'doctor'])

const hex = (n) => randomBytes(n).toString('hex')

// sessions: the daemon's, by id, each with info(). store: where the book is
// kept (store.mjs), null for nowhere; registry: the run registry, which says
// whether a Run is live, null for none.
/** @param {{ sessions: Map<string, any>, now?: () => string, store?: import('./store.mjs').Store | null, registry?: string | null }} options */
export function runBook({ sessions, now = () => new Date().toISOString(), store = null, registry = null }) {
  const runs = new Map()
  const dispatches = new Map()
  const statuses = new Map()
  // Session id -> { command, cwd, title }: what an agent's session ran, so the
  // next daemon can bring it back. Never its env, which holds the person's keys.
  const specs = new Map()
  let messages = 0
  let deliveries = 0
  let nextSession = 1
  // Sessions running now; `died`, those an earlier daemon had running when it went.
  const running = new Set()
  let died = new Set()

  if (store) {
    for (const [id, r] of store.list('runs')) if (!r.orchestrator) runs.set(id, { ...r, acked: new Set(r.acked) })
    for (const [id, d] of store.list('dispatches')) if (runs.has(d.run)) dispatches.set(id, d)
    for (const [path, status] of store.list('statuses')) statuses.set(path, status)
    // An agent's session comes back, and a `?` session; any other of no
    // dispatch was a log tail or a runner, which is started again its own
    // way, or not at all.
    for (const [id, spec] of store.list('sessions')) if (dispatches.has(id) || isOrchestratorTitle(spec?.title)) specs.set(id, spec)
    messages = store.read('meta', 'messages') ?? 0
    deliveries = store.read('meta', 'deliveries') ?? 0
    nextSession = store.read('meta', 'nextSession') ?? 1
    died = new Set(store.read('meta', 'running') ?? [])
  }
  // Every record at once: the store writes them whole or not at all.
  const save = () =>
    store?.write({
      runs: [...runs.values()].map((r) => [r.id, { ...r, acked: [...r.acked] }]),
      dispatches: [...dispatches],
      statuses: [...statuses],
      sessions: [...specs],
      meta: [
        ['messages', messages],
        ['deliveries', deliveries],
        ['nextSession', nextSession],
        ['running', [...running, ...died]],
      ],
    })
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

  // The dispatch session `id` runs, for a message it sends by its id alone.
  const sessionDispatch = (id, what) => {
    const d = dispatches.get(String(id))
    if (!d) throw new Error(`no dispatch for session ${id}: crew takes ${what} only from a session it started for an agent, under the dispatch its runner made`)
    if (d.released) throw new Error(`session ${id}'s dispatch was released: its runner let its agent go, so it takes no more ${what}`)
    return d
  }

  // A message to the dispatch's Run's mailbox; a worker_done settles it.
  const post = (d, { type, subject = '', body = '', outcome = null, result = null }) => {
    if (!MAIL_TYPES.includes(type)) throw new Error(`not a message type crew takes: ${JSON.stringify(type)}; one of ${MAIL_TYPES.join(', ')}`)
    if (outcome != null && (type !== 'worker_done' || !OUTCOMES.has(outcome))) throw new Error(`not an outcome for ${type}: ${JSON.stringify(outcome)}`)
    const m = {
      id: `msg_${++messages}_${hex(3)}`,
      type,
      from: d.id,
      subject: String(subject),
      body: String(body),
      taskId: d.taskId,
      dispatchId: d.id,
      outcome: type === 'worker_done' ? (outcome ?? 'succeeded') : null,
      createdAt: now(),
    }
    runOf(d.run).pending.push(m)
    d.needsYou = null
    if (type === 'worker_done') Object.assign(d, { settled: true, outcome: m.outcome, submissions: (d.submissions ?? 0) + 1, result })
    return { id: m.id }
  }

  // The payload as its dispatch's result: a value valid against its schema
  // (JSON text parsed first), or text when it has none.
  const resultOf = (d, payload) => {
    if (d.schema == null) {
      if (typeof payload !== 'string') throw new Error(`submit rejected: this agent's result is text, not ${JSON.stringify(payload)?.slice(0, 80)}`)
      return payload
    }
    let value = payload
    if (typeof payload === 'string') {
      try {
        value = JSON.parse(payload)
      } catch (e) {
        throw new Error(`submit rejected: payload is not valid JSON: ${e.message}\nFix the payload and submit again.`)
      }
    }
    const errors = validate(d.schema, value)
    if (errors.length) throw new Error([`submit rejected: ${errors.length} validation error(s) against its schema`, ...errors.map((e) => `  ${e}`), 'Fix the payload and submit again.'].join('\n'))
    return value
  }

  // An unsettled agent's session restored from an earlier daemon and not yet
  // revived is, to its runner, the session that daemon lost: gone, its host died, so the runner
  // continues it as it would one never restored.
  const show = (d) => {
    const s = sessions.get(d.id)?.info() ?? null
    const lost = !s || (!!s.restored && !s.alive && !d.settled)
    return { settled: d.settled, outcome: d.outcome, submissions: d.submissions ?? 0, note: d.note ?? null, needsYou: d.needsYou ?? null, gone: lost, exited: !lost && !s.alive, waiting: s?.waiting ?? null, terminal: d.id, ...(lost && !d.settled && died.has(d.id) && { hostDied: true }) }
  }

  const ops = {
    'run.create': ({ objective = '', coordinator, runner = null }) => {
      const r = {
        id: `run_${hex(6)}`,
        objective: String(objective),
        coordinator: word(coordinator, 'coordinator'),
        runner: runnerOf(runner),
        pending: [],
        batch: null,
        acked: new Set(),
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
    'run.worker': ({ run, session, coordinator, role = 'worker', schema = null, resultPath = null }) => {
      const r = runOf(run)
      if (!ROLES.includes(role)) throw new Error(`not an agent role: ${JSON.stringify(role)}; one of ${ROLES.join(', ')}`)
      if (schema !== null && (typeof schema !== 'object' || Array.isArray(schema))) throw new Error(`not a result schema: ${JSON.stringify(schema)?.slice(0, 80)}`)
      if (resultPath !== null) word(resultPath, 'result path')
      if (r.coordinator !== coordinator) throw new Error(`consumer_fenced: this coordinator is no longer bound to run ${r.id}`)
      if (!sessions.has(String(session))) throw new Error(`no session ${session}`)
      if (dispatches.has(String(session))) throw new Error(`session ${session} already runs a dispatch`)
      const d = { id: String(session), run: r.id, taskId: `task_${hex(6)}`, capability: `cap_${hex(12)}`, settled: false, outcome: null, released: false, submissions: 0, result: null, role, schema, resultPath }
      dispatches.set(d.id, d)
      return { worker: { taskId: d.taskId, capability: d.capability } }
    },
    'worker.show': ({ id }) => ({ worker: show(dispatchOf(id)) }),
    'worker.result': ({ id }) => {
      const d = dispatchOf(id)
      return { result: d.result ?? null, outcome: d.outcome, submissions: d.submissions ?? 0 }
    },
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
    'mail.send': ({ from = null, capability = null, taskId, dispatchId, type, subject = '', body = '', outcome = null, result = null }) => {
      const d = dispatchOf(dispatchId)
      if (d.taskId !== taskId || (from != null && from !== d.id) || (capability != null && capability !== d.capability)) {
        throw new Error(`consumer_fenced: a message from ${dispatchId} does not match its preamble`)
      }
      return post(d, { type, subject, body, outcome, result })
    },
    // What a session's harness equips it with (hooks/crew-pi.mjs): asked as
    // it starts, so a session crew started for no agent is told so, not refused.
    'worker.schema': ({ id }) => {
      const d = dispatches.get(String(id))
      return { agent: d && !d.released ? { role: d.role ?? 'worker', schema: d.schema ?? null } : null }
    },
    'worker.submit': ({ id, payload }) => {
      const d = sessionDispatch(id, 'results')
      if (d.role === 'doctor') throw new Error(`session ${id} is a doctor's: a doctor submits no result, it reports with a handoff or an escalation`)
      const result = resultOf(d, payload)
      // Written before it settles, whole or not at all: the runner reads this
      // file once it sees the worker settle.
      if (d.resultPath) writeJsonAtomic(d.resultPath, result)
      const { id: message } = post(d, {
        type: 'worker_done',
        subject: 'result submitted',
        body: d.resultPath ? `Submitted a result that is valid against its schema. It is recorded at ${d.resultPath}. Nothing remains for this task.` : 'Submitted a result that is valid against its schema. Nothing remains for this task.',
        result,
      })
      return { id: message, resultPath: d.resultPath ?? null }
    },
    'worker.mail': ({ id, type, subject = '', body = '', outcome = null }) => {
      const d = sessionDispatch(id, 'mail')
      if (type === 'worker_done' && d.role !== 'doctor') throw new Error(`session ${id} is a worker's: its result goes through submit, which checks it against its schema, never as mail`)
      return post(d, { type, subject, body, outcome })
    },
    'worker.handoff': ({ id, note }) => {
      const d = sessionDispatch(id, 'handoffs')
      if (d.role !== 'doctor') throw new Error(`session ${id} is a worker's: a handoff is a doctor's note, which ends its round, and a worker has no round to end; it finishes with submit`)
      const body = word(typeof note === 'string' ? note.trim() : note, 'note')
      const handoff = post(d, { type: 'handoff', subject: 'note', body })
      post(d, { type: 'worker_done', subject: 'note handed off', body: 'Handed off its note.', outcome: 'succeeded' })
      return handoff
    },
    'worker.giveUp': ({ id, reason }) => {
      const d = sessionDispatch(id, 'give-ups')
      if (d.role !== 'doctor') throw new Error(`session ${id} is a worker's: give_up ends a doctor's round, and a worker has no round to end; it finishes with submit, or says it needs the person`)
      return post(d, { type: 'worker_done', subject: 'gave up', body: word(typeof reason === 'string' ? reason.trim() : reason, 'reason'), outcome: 'failed' })
    },
    'worker.status': ({ id, note }) => {
      const d = sessionDispatch(id, 'notes')
      if (typeof note !== 'string') throw new Error(`not a note: ${JSON.stringify(note)?.slice(0, 80)}`)
      Object.assign(d, { note: note.trim().slice(0, NOTE_MAX) || null, needsYou: null })
      return { note: d.note }
    },
    'worker.needsYou': ({ id, reason }) => {
      const d = sessionDispatch(id, 'needs-you')
      if (d.role === 'doctor') throw new Error(`session ${id} is a doctor's: a doctor that needs the person says so with an escalation, as mail`)
      d.needsYou = word(typeof reason === 'string' ? reason.trim() : reason, 'reason')
      return { needsYou: d.needsYou }
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
    if (name === 'worker.show' || name === 'worker.result' || name === 'worker.schema' || name === 'worktree.statuses') continue
    // Reflect.apply, since the ops differ in arity and this wraps them all alike.
    ops[name] = (...args) => {
      const reply = Reflect.apply(op, null, args)
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
    return [...runs.values()]
      .filter((r) => {
        if (r.orchestrator) return false
        const e = book.get(r.id)
        return e ? unfinished(e) && (alive(r.runner) || working.has(r.id)) : working.has(r.id)
      })
      .map((r) => named(r, book.get(r.id)))
  }

  // The runs whose runner session died with an earlier daemon while the
  // registry still has them running or halted: { runId, script, runDir,
  // project, permissionMode }, what starting their runner again takes.
  function recoverable() {
    const book = registered()
    return [...runs.values()]
      .filter((r) => r.runner && died.has(r.runner) && book.get(r.id) && unfinished(book.get(r.id)))
      .map((r) => {
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
    // What session `id` runs, kept for the next daemon; its title as renamed.
    spawned(id, { command, cwd, title }) {
      specs.set(id, { command, cwd, title })
      save()
    },
    renamed(id, title) {
      if (!specs.has(id)) return
      specs.get(id).title = title
      save()
    },
    // The agent sessions an earlier daemon held and never closed: { id,
    // command, cwd, title }.
    restorable: () => [...specs].map(([id, spec]) => ({ id, ...spec })),
    // Session `id` is closed: forgotten, and the orchestrator Run it was a
    // dispatch of goes, once no session of it is left.
    closed(id) {
      if (specs.delete(String(id))) save()
      const r = runs.get(dispatches.get(String(id))?.run)
      if (!r?.orchestrator) return
      const own = [...dispatches.values()].filter((d) => d.run === r.id)
      if (own.some((d) => sessions.has(d.id))) return
      for (const d of own) dispatches.delete(d.id)
      runs.delete(r.id)
      save()
    },
    // Whether session `id` runs a dispatch marked done: settled by a
    // worker_done that succeeded, never a failed or cancelled one.
    done(id) {
      const d = dispatches.get(String(id))
      return !!d && d.settled && d.outcome === 'succeeded'
    },
    // Whether session `id` is a `?` session: titled as the orchestrator's,
    // of no dispatch.
    console(id) {
      return !dispatches.has(String(id)) && isOrchestratorTitle(specs.get(String(id))?.title)
    },
    // A recovered run's runner is its new session from now on: recovered once.
    recovered(runId, session) {
      runs.get(runId).runner = session
      save()
    },
  }
}
