// The run's journal, journal.jsonl in its state dir: the entry types it holds
// (JOURNAL_ENTRIES), and the one fold of it that every reader shares — the
// runner's resume (runner.mjs), reclaim (reclaim.mjs) and the run view
// (run-view-model.mjs). One fold, so they never disagree about which lines
// carry a worker, or about which agents the Run holds.
import { existsSync, readFileSync } from 'fs'
import { agentDir } from './lifecycle.mjs'

// Every journal entry type and the fields it always carries, beside `type`.
// `at` is an ISO timestamp from the runner's clock; `run` is the Orca Run the
// worker was dispatched into. A failed entry may also carry `retained`, the
// worktree it left, `run`, once the Run existed, `continuations`, how often its
// session was continued, and `workerOut: true` when its worker is still out
// for the next resume to take up, and `workerLeft: true` when its worker's
// process was left running (blocked on a human, or stalled past the
// continuation cap), which only a reclaim that stops it first removes; a
// replayed result carries `replayed: true`,
// and `origin` when the call it replays launched a worker. A worker's `dir` is
// its agent's files, relative to the state dir. starting: a call has its live
// slot and its worker is being started. retry: a call's start, or its Run's
// creation, failed and is tried again: journaled before the backoff's wait,
// with why the last attempt failed and `nextAt`, when the next one begins.
// baseline: a child worktree was made for a call's worker, before its
// terminal opens: `lines`, its `git status --porcelain` lines then (none when
// clean), are what it held before any agent touched it. A create that timed
// out has none.
// blocked: its worker waits on a human, with what it waits on (`waiting`);
// unblocked: it no longer does. warning: something that went wrong without
// failing the call. A nudge's
// `attempt` is its number since the session started or was last continued; a
// continuation's is its number, up to the cap. `origin` names an agent across
// resumes: the n of the call that started its worker, which its `<runId>-<n>`
// worktree is named by — a resume numbers its calls on, but never renames an
// agent; a `started` line carries it when a resume retries a held patient's
// start. reattached: a resumed runner taking up a worker an earlier one
// started, journaled when its call is made, which it then watches, or
// continues first if it died; it also carries `continuations` when that
// worker's session was already continued, and a doctor's its `patient`, its
// `round` and, while it needs you, `needsYou`, what the human must do.
// outstanding: a worker the last run
// left out, carried forward by a resume before any call, so it stays journaled
// until a call takes it up; it carries `continuations` as reattached does, and
// a patient's its `round` and `rounds` as earlier does.
// earlier: an agent of the Run that an earlier runner of it made and that
// settled (or never started a worker, but left a worktree), carried forward
// by a resume before any call, so reclaim and the run view still name it;
// `state` and `reason` are as the fold left them, and it carries
// `continuations` as reattached does, a doctor its `patient`, since its
// patient's doctor lines are not carried, and a patient its `round` and
// `rounds`, as the fold left them. It has no key: it is no call, and a
// resume replays nothing from it. run: the Run every worker is dispatched into
// and the runner terminal it is bound to, when it is created or taken over; a
// resume carries the last one forward first, with `lastN`, the highest call
// number that Run has used. queued: a call waiting for a live slot.
// doctor: a doctor round starts for a patient, an agent whose session died
// past its continuation cap or was blocked on a human past the blocked limit,
// or whose start failed through every retry: about the patient, with its `origin`, the
// `round` (1 to 3), the failure `reason` it answers, and `doctor`, the n its
// doctor is started under. The patient's call is not settled: its agent()
// waits. A doctor's own lines are those of any agent, under its own n, with
// key null, since it is no agent() call; its failed line also names its
// `patient`, by origin, and fails no call. settled: a doctor's worker settled,
// with its `outcome`: a doctor submits no result. gaveUp: a doctor round ended
// without a remedy, about the patient, with the `round`, the `doctor` and why;
// after the last one the patient's failed line follows. mail: the runner read
// a message from its Run mailbox: its `messageId`, its `kind` (Orca's type:
// handoff, worker_done…) and the `action` the runner took on it — remedy (a
// doctor's note carried its patient on), needsYou (its doctor escalated: it
// needs a human, its body what they must do or decide), gaveUp (its doctor
// gave up: a worker_done failed), ended (its doctor's worker_done succeeded) or none (it
// came from no doctor out, or asked for nothing). It is journaled before the
// runner acts on it and acknowledges it, so a message Orca delivers again is
// never acted on twice; a doctor's also carries its `doctor` (n), `patient`
// (origin) and `round`, and its `body` (the note, or why it gave up), and a
// worker_done its `outcome`. It has no n: it is about no agent's lifecycle.
// A resume carries each one forward before any call. remedy: a doctor's
// handoff carried its patient on, about the patient, with the `round`, the
// `doctor`, `how` (continue: its session continued with the note; restart:
// its worker never started, and its start is retried with the note in its
// worker's prompt, `dispatchId` and `terminal` null until it starts), the
// `messageId` of the handoff, and the `dispatchId` and `terminal` it now runs
// under, `reopened` as a continuation's. It starts the patient's count of
// continuations afresh: its next `continued` line is attempt 1.
export const JOURNAL_ENTRIES = Object.freeze({
  queued: ['at', 'key', 'n', 'title'],
  starting: ['at', 'key', 'n', 'title', 'run'],
  started: ['at', 'key', 'n', 'title', 'run', 'dispatchId', 'harness', 'sessionId', 'worktree', 'terminal', 'dir'],
  result: ['at', 'key', 'n', 'title', 'result'],
  failed: ['at', 'key', 'n', 'title', 'reason', 'attempts'],
  retained: ['at', 'retained'],
  retry: ['at', 'key', 'n', 'title', 'attempt', 'reason', 'nextAt'],
  baseline: ['at', 'key', 'n', 'title', 'worktree', 'lines'],
  warning: ['at', 'key', 'n', 'title', 'reason'],
  nudge: ['at', 'key', 'n', 'title', 'dispatchId', 'reason', 'attempt'],
  blocked: ['at', 'key', 'n', 'title', 'dispatchId', 'terminal', 'waiting'],
  unblocked: ['at', 'key', 'n', 'title', 'dispatchId'],
  continued: ['at', 'key', 'n', 'title', 'dispatchId', 'sessionId', 'terminal', 'reason', 'attempt', 'reopened'],
  reattached: ['at', 'key', 'n', 'title', 'run', 'dispatchId', 'harness', 'sessionId', 'terminal', 'worktree', 'dir', 'origin'],
  outstanding: ['at', 'key', 'n', 'title', 'run', 'dispatchId', 'harness', 'sessionId', 'terminal', 'worktree', 'dir', 'origin'],
  earlier: ['at', 'n', 'title', 'run', 'dispatchId', 'harness', 'sessionId', 'terminal', 'worktree', 'origin', 'state', 'reason'],
  run: ['at', 'runId', 'terminal'],
  doctor: ['at', 'key', 'n', 'title', 'origin', 'round', 'reason', 'doctor'],
  settled: ['at', 'key', 'n', 'title', 'dispatchId', 'outcome'],
  gaveUp: ['at', 'key', 'n', 'title', 'origin', 'round', 'doctor', 'reason'],
  mail: ['at', 'messageId', 'kind', 'action'],
  remedy: ['at', 'key', 'n', 'title', 'origin', 'round', 'doctor', 'how', 'messageId', 'dispatchId', 'terminal', 'reopened'],
})

// The lines that name a call's worker.
const WORKER_LINES = ['started', 'reattached', 'outstanding']

// The mail kinds that end a doctor's needs you, as the runner's own list does.
const ANSWERS = ['handoff', 'escalation', 'worker_done']

// Every entry of a journal, in order. A line that does not parse is skipped:
// a torn last line is one the runner was killed while writing.
export function journalLines(path) {
  if (!existsSync(path)) return []
  const entries = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e && typeof e === 'object') entries.push(e)
    } catch {}
  }
  return entries
}

export const timeOf = (e) => {
  const t = Date.parse(e?.at)
  return Number.isFinite(t) ? t : null
}

// Whether the Run made the agent: it started a worker, or Orca made it a
// worktree before its start failed. Only such an agent has anything to reclaim.
export const madeByRun = (a) => !!a.runId && (a.launched || !!a.worktree)

export const readJournal = (path) => foldJournal(journalLines(path))

// The fold of a journal's entries: { calls, retained, run, lastN, agents, mail }.
//
// calls, what a resume replays and takes up: key -> what each call made under
// it, in call order — { result } for a call that returned a value (with
// `origin` when it launched a worker, or replayed one that did), { failed:
// true } for one that returned null, { worker } for one whose worker was still
// out when the last run stopped (its Run, dispatch, harness, session, terminal
// and worktree as last journaled, how often its session was continued, the
// `dir` of the files its prompt named, its `origin`, and the `n` and `title`
// of its latest line), { unsettled: true } for one that had no worker out and
// no settlement. A failed entry holds its call's place but replays nothing,
// so a resume runs that call live again, as the Workflow runner re-runs an
// agent it journaled as failed. retained: every worktree a dead agent left,
// from its failed entry or from a `retained` line an earlier resume carried
// forward. run: the last Run journaled, { runId, terminal }, or null; lastN:
// the highest call number the journal holds. A journal written before entries
// carried timestamps and launch fields resumes the same way, its `started`
// lines without a dispatch or session as calls with no worker out, and a
// worker line without a `dir` as named by that line's n and title. An
// `outstanding` line is its call's place until a `reattached` line for its
// dispatch takes it over; one still standing is a call that run never made,
// so it follows every call that run made under its key. An unsettled entry of
// a patient also has `rounds`, { round, trail }: its latest round, and each
// ended round as the doctor prompt names it, { round, note, outcome }. One
// whose latest round gave no remedy that carried it on is `held`: its agent()
// waits on its doctors, so a resume answers it with its next round, or, when
// that round is `open` (its doctor not yet ended), goes on with it: held is
// { origin, round, reason, open, doctor, worker, remedy, needsYou, gaveUp,
// ended, restart }, where doctor is that round's doctor, by origin, worker
// its worker, in a call's worker's shape, while it is still out, remedy { id, body } the handoff journaled as
// mail that no remedy line applied, needsYou what its doctor needs a human
// for, gaveUp the body of a worker_done failed, ended { outcome } a
// worker_done succeeded, and restart, for a patient whose worker never
// started, { made, baseline }: the worktree its start left and its baseline.
//
// agents, every agent the journal names, one per `origin`, by the n of its
// latest line: { origin, n, title, state, reason, continuations, replayed,
// launched, runId, dispatchId, harness, sessionId, worktree, terminal, from,
// to, waiting, nextAt, workerLeft, baseline, patient, round, doctors, rounds, failures,
// attempt }. patient: a
// doctor's patient, by origin, or null; round: a patient's latest doctor
// round, or 0; doctors: the origins of its doctors, in round order; rounds:
// each of its rounds, { round, doctor (origin), reason (the failure it
// answered), outcome, note, why }, where outcome is remedy (its doctor's note,
// `note`, carried it on), gaveUp (it ended without one, `why`) or null while
// it runs. A round after a remedy is that remedy failing: its continuations
// count afresh from it. failures: how many of its failures a doctor answered,
// a round after one that gave up answering the same failure; attempt: the
// attempt it is on, 1 + its remedies, each remedy carrying it into the next.
// A patient is failed while a round answers its failure, and continued once a
// remedy carries it on, until it settles. The journal of a resumed run holds every agent of its Run, the ones
// earlier runners made included: a resume carries each forward (`earlier`,
// `outstanding`), and a line of the call that takes one up again
// (`reattached`, or a replayed `result` with its `origin`) is that same agent,
// never another. A line with no origin is its call's agent, or, for a worker
// line, the agent whose dispatch it names. state is its latest lifecycle
// entry's: queued, starting once it has its slot or while its start is
// retried (reason: why the last attempt failed; nextAt: when the next begins),
// running once started, carried or taken up, blocked while it waits on a human
// (waiting: on what), needs you once a doctor escalated, until its next
// handoff, escalation or worker_done (reason: what the human must do; a
// second escalation replaces it), stuck once nudged, continued after a continuation, done
// or failed once settled. A nudge journals no answer, so an agent stays stuck
// until its next continuation or settlement; blocked lasts until unblocked or
// settled. workerLeft: it failed with its worker's process left running.
// baseline: the porcelain lines its worktree was made with, or null. launched: a worker was started for it,
// whatever its dispatch now reads. from and to are when it began and settled
// here, or null: a replayed result or a carried agent launched nothing here.
// mail: every `mail` line, one per message id, the first kept, in order.
export function foldJournal(entries) {
  const calls = new Map()
  const retained = []
  const mail = new Map()
  let run = null
  let lastN = 0
  // One per call, by its n: a call's lines share it, and no two calls do.
  const byCall = new Map()
  // The call id of each outstanding line, by its dispatch.
  const carried = new Map()
  // One per agent, by its origin; a call's n -> its agent's origin; a
  // dispatch -> the origin of the agent it runs.
  const agents = new Map()
  const agentOfCall = new Map()
  const byDispatch = new Map()

  // A patient's record of the round a line names, made at its first line.
  function roundOf(a, e) {
    let r = a.rounds.find((x) => x.round === e.round)
    if (!r) {
      r = { round: e.round ?? a.rounds.length + 1, doctor: Number.isInteger(e.doctor) ? e.doctor : null, reason: null, outcome: null, note: null, why: null }
      a.rounds.push(r)
    }
    return r
  }

  // A patient's rounds, as a carried line names them.
  function carryRounds(a, e) {
    if (!Array.isArray(e.rounds)) return
    a.rounds = e.rounds.map((r) => ({ ...r }))
    a.round = Number.isInteger(e.round) ? e.round : a.rounds.length
    a.doctors = a.rounds.map((r) => r.doctor).filter(Number.isInteger)
  }

  // Folds one line into its agent's record, and returns that agent's origin.
  function agent(e) {
    const worker = WORKER_LINES.includes(e.type) || e.type === 'earlier'
    const id = Number.isInteger(e.origin) ? e.origin
      : worker && e.dispatchId && byDispatch.has(e.dispatchId) ? byDispatch.get(e.dispatchId)
      : worker ? e.n : agentOfCall.get(e.n) ?? e.n
    agentOfCall.set(e.n, id)
    if (e.dispatchId) byDispatch.set(e.dispatchId, id)
    let a = agents.get(id)
    if (!a) {
      a = {
        origin: id, n: e.n, title: null, state: 'queued', continuations: 0, reason: null, replayed: false, launched: false,
        runId: null, dispatchId: null, harness: null, sessionId: null, worktree: null, terminal: null, from: null, to: null,
        waiting: null, nextAt: null, workerLeft: false, baseline: null, patient: null, round: 0, doctors: [], rounds: [], failures: 0, attempt: 1,
      }
      agents.set(id, a)
    }
    a.n = e.n
    if (typeof e.title === 'string') a.title = e.title
    const at = timeOf(e)
    switch (e.type) {
      case 'starting':
        a.from ??= at
        Object.assign(a, { state: 'starting', runId: e.run ?? a.runId })
        break
      case 'retry':
        a.from ??= at
        Object.assign(a, { state: 'starting', reason: e.reason ?? null, nextAt: e.nextAt ?? null })
        break
      case 'baseline':
        Object.assign(a, { worktree: e.worktree ?? a.worktree, baseline: Array.isArray(e.lines) ? e.lines : a.baseline })
        break
      case 'started':
      case 'reattached':
      case 'outstanding': {
        if (e.type !== 'outstanding') a.from ??= at
        const continuations = e.continuations ?? a.continuations
        Object.assign(a, {
          state: continuations ? 'continued' : 'running', continuations, launched: true, reason: null, waiting: null, nextAt: null, runId: e.run ?? a.runId, dispatchId: e.dispatchId ?? a.dispatchId,
          harness: e.harness ?? a.harness, sessionId: e.sessionId ?? a.sessionId, worktree: e.worktree ?? a.worktree, terminal: e.terminal ?? a.terminal,
        })
        if (typeof e.needsYou === 'string') Object.assign(a, { state: 'needs you', reason: e.needsYou })
        carryRounds(a, e)
        // A patient carried while a round answers its failure.
        const last = e.type === 'outstanding' ? a.rounds.at(-1) : null
        if (last && last.outcome !== 'remedy') Object.assign(a, { state: 'failed', reason: last.reason ?? null })
        break
      }
      case 'earlier':
        Object.assign(a, {
          state: typeof e.state === 'string' ? e.state : a.state, reason: e.reason ?? null, continuations: e.continuations ?? a.continuations, workerLeft: e.workerLeft === true || a.workerLeft,
          launched: a.launched || !!e.dispatchId, runId: e.run ?? a.runId, dispatchId: e.dispatchId ?? a.dispatchId, harness: e.harness ?? a.harness,
          sessionId: e.sessionId ?? a.sessionId, worktree: e.worktree ?? a.worktree, terminal: e.terminal ?? a.terminal,
        })
        if (e.patient != null) a.patient = e.patient
        carryRounds(a, e)
        break
      case 'nudge':
        if (a.state === 'running' || a.state === 'continued' || a.state === 'stuck') Object.assign(a, { state: 'stuck', reason: e.reason ?? null })
        break
      case 'blocked':
        if (a.state === 'running' || a.state === 'continued' || a.state === 'stuck') {
          Object.assign(a, { state: 'blocked', waiting: e.waiting ?? null, reason: `blocked on a human: ${e.waiting ?? 'no question given'}`, terminal: e.terminal ?? a.terminal })
        }
        break
      case 'unblocked':
        if (a.state === 'blocked') Object.assign(a, { state: a.continuations || a.rounds.at(-1)?.outcome === 'remedy' ? 'continued' : 'running', waiting: null, reason: null })
        break
      case 'remedy':
        // Its start retried: nothing runs until its worker starts.
        if (e.how === 'restart') {
          Object.assign(a, { state: 'starting', reason: null, waiting: null, nextAt: null })
          break
        }
      // falls through
      case 'continued':
        // A continued session may run under a new dispatch in a new tab: that
        // is the worker a reclaim releases and the tab it closes. A remedy
        // starts a fresh count against the cap.
        Object.assign(a, {
          state: 'continued', reason: null, waiting: null, continuations: e.type === 'remedy' ? 0 : e.attempt ?? a.continuations + 1,
          dispatchId: e.dispatchId ?? a.dispatchId, terminal: e.terminal ?? a.terminal, sessionId: e.sessionId ?? a.sessionId,
        })
        if (e.type === 'remedy') Object.assign(roundOf(a, e), { outcome: 'remedy', note: mail.get(e.messageId)?.body ?? null })
        break
      case 'doctor':
        Object.assign(a, { state: 'failed', reason: e.reason ?? null, waiting: null, round: e.round ?? a.round })
        if (Number.isInteger(e.doctor) && !a.doctors.includes(e.doctor)) a.doctors.push(e.doctor)
        roundOf(a, e).reason = e.reason ?? null
        break
      case 'gaveUp':
        Object.assign(roundOf(a, e), { outcome: 'gaveUp', why: e.reason ?? null })
        break
      case 'settled':
        Object.assign(a, { state: 'done', reason: null, waiting: null, to: at })
        break
      case 'result':
        Object.assign(a, { state: 'done', reason: null, waiting: null, to: at, replayed: e.replayed === true })
        break
      case 'failed':
        a.from ??= at
        Object.assign(a, {
          state: 'failed', reason: e.reason ?? null, waiting: null, workerLeft: e.workerLeft === true, to: at, runId: a.runId ?? e.run ?? null, worktree: a.worktree ?? e.retained?.path ?? null,
          continuations: e.continuations ?? a.continuations,
        })
        break
    }
    return id
  }

  for (const [i, e] of entries.entries()) {
    if (e.retained?.path && !retained.some((k) => k.path === e.retained.path)) retained.push(e.retained)
    for (const n of [e.n, e.lastN]) if (Number.isInteger(n)) lastN = Math.max(lastN, n)
    if (e.type === 'run' && typeof e.runId === 'string') run = { runId: e.runId, terminal: e.terminal ?? null }
    if (e.type === 'mail' && typeof e.messageId === 'string' && !mail.has(e.messageId)) {
      mail.set(e.messageId, e)
      const d = Number.isInteger(e.doctor) ? agents.get(agentOfCall.get(e.doctor) ?? e.doctor) : null
      if (d && d.state !== 'done' && d.state !== 'failed' && ANSWERS.includes(e.kind)) {
        if (e.action === 'needsYou') Object.assign(d, { state: 'needs you', reason: e.body ?? null })
        else if (d.state === 'needs you') Object.assign(d, { state: d.continuations ? 'continued' : 'running', reason: null })
      }
    }
    const numbered = Number.isInteger(e.n)
    const id = numbered && JOURNAL_ENTRIES[e.type] && e.type !== 'run' && e.type !== 'retained' ? agent(e) : null
    if (typeof e.key !== 'string') continue
    if (!numbered && e.type !== 'result' && e.type !== 'failed') continue
    const callId = numbered ? e.n : `line ${i}`
    if (!byCall.has(callId)) byCall.set(callId, { key: e.key, n: numbered ? e.n : null, order: numbered ? e.n : i, carried: false, worker: null, settled: null, origin: null })
    const c = byCall.get(callId)
    if (e.type === 'result') {
      c.settled = { result: e.result }
      if (Number.isInteger(e.origin)) c.origin = e.origin
    } else if (e.type === 'failed') {
      if (!e.workerOut) c.settled = { failed: true }
    } else if (WORKER_LINES.includes(e.type) && e.dispatchId && e.sessionId) {
      const title = typeof e.title === 'string' ? e.title : null
      const dir = typeof e.dir === 'string' ? e.dir : agentDir(e.n, title?.replace(/^\[[^\]]*\] /, '') || `agent-${e.n}`)
      c.origin = id
      c.worker = {
        n: e.n, title, dir, run: e.run ?? run?.runId ?? null, dispatchId: e.dispatchId, harness: e.harness ?? null, sessionId: e.sessionId,
        terminal: e.terminal ?? null, worktree: e.worktree ?? null, continuations: e.continuations ?? 0, origin: id,
      }
      if (e.type === 'outstanding') {
        c.carried = true
        carried.set(e.dispatchId, callId)
      } else if (e.type === 'reattached' && carried.has(e.dispatchId) && carried.get(e.dispatchId) !== callId) {
        byCall.delete(carried.get(e.dispatchId))
        carried.delete(e.dispatchId)
      }
    } else if (e.type === 'continued' && c.worker && e.dispatchId) {
      c.worker = { ...c.worker, dispatchId: e.dispatchId, terminal: e.terminal ?? c.worker.terminal, continuations: Number.isInteger(e.attempt) ? e.attempt : c.worker.continuations + 1 }
    } else if (e.type === 'remedy' && c.worker && e.dispatchId) {
      c.worker = { ...c.worker, dispatchId: e.dispatchId, terminal: e.terminal ?? c.worker.terminal, continuations: 0 }
    }
  }
  // A patient's doctor line names the n its doctor was started under; the
  // doctor is the agent that n's lines made.
  for (const a of agents.values()) {
    a.doctors = a.doctors.map((d) => agentOfCall.get(d) ?? d)
    for (const r of a.rounds) if (r.doctor != null) r.doctor = agentOfCall.get(r.doctor) ?? r.doctor
    for (const d of a.doctors) if (agents.has(d)) agents.get(d).patient = a.origin
    a.failures = a.rounds.filter((r, i) => i === 0 || a.rounds[i - 1].outcome === 'remedy').length
    a.attempt = 1 + a.rounds.filter((r) => r.outcome === 'remedy').length
  }
  // A doctor an earlier runner started is carried forward with its patient,
  // whose doctor lines are not.
  for (const d of agents.values()) {
    const p = d.patient != null ? agents.get(d.patient) : null
    if (p && !p.doctors.includes(d.origin)) p.doctors.push(d.origin)
  }
  for (const c of [...byCall.values()].sort((a, b) => a.carried - b.carried || a.order - b.order)) {
    if (!calls.has(c.key)) calls.set(c.key, [])
    const settled = c.settled && 'result' in c.settled && c.origin !== null ? { ...c.settled, origin: c.origin } : c.settled
    const p = settled ? null : agents.get(c.origin ?? agentOfCall.get(c.n) ?? c.n)
    calls.get(c.key).push(settled ?? { ...(c.worker ? { worker: c.worker } : { unsettled: true }), ...(p?.rounds.length && treatment(p)) })
  }
  return { calls, retained, run, lastN, agents: [...agents.values()].sort((x, y) => x.n - y.n), mail: [...mail.values()] }

  // An unsettled patient's rounds, and, while its agent() waits on them, where
  // they stand.
  function treatment(p) {
    const { rounds } = p
    const trail = rounds.flatMap((r, i) => (r.outcome === 'remedy'
      ? [{ round: r.round, note: r.note, outcome: rounds[i + 1] ? `its note carried the patient on, and it failed again: ${rounds[i + 1].reason}` : null }]
      : r.outcome === 'gaveUp' ? [{ round: r.round, note: null, outcome: `no remedy: ${r.why}` }] : []))
    const last = rounds.at(-1)
    if (last.outcome === 'remedy') return { rounds: { round: p.round, trail } }
    const open = last.outcome === null
    const d = open && last.doctor != null ? agents.get(last.doctor) : null
    const out = !!d && d.launched && !!d.dispatchId && !!d.sessionId && d.state !== 'done' && d.state !== 'failed'
    const said = open ? [...mail.values()].filter((m) => m.patient === p.origin && m.round === last.round) : []
    const remedy = said.find((m) => m.action === 'remedy')
    const gaveUp = said.find((m) => m.action === 'gaveUp')
    const ended = said.find((m) => m.action === 'ended')
    return {
      rounds: { round: p.round, trail },
      held: {
        origin: p.origin, round: last.round, reason: last.reason, open,
        doctor: last.doctor ?? null,
        worker: out ? {
          n: d.n, title: d.title, dir: agentDir(d.origin, d.title?.replace(/^\[[^\]]*\] /, '') || `agent-${d.origin}`), run: d.runId, dispatchId: d.dispatchId, harness: d.harness,
          sessionId: d.sessionId, terminal: d.terminal, worktree: d.worktree, continuations: d.continuations, origin: d.origin,
        } : null,
        remedy: remedy ? { id: remedy.messageId, body: remedy.body ?? '' } : null,
        needsYou: out && d.state === 'needs you' ? d.reason : null,
        gaveUp: gaveUp ? gaveUp.body ?? '' : null,
        ended: ended ? { outcome: ended.outcome ?? 'succeeded' } : null,
        restart: p.launched ? null : { made: p.worktree ? [p.worktree] : [], baseline: p.baseline },
      },
    }
  }
}
