// The run's journal, journal.jsonl in its state dir: the entry types it holds
// (JOURNAL_ENTRIES), and the one fold of it that every reader shares — the
// runner's resume (runner.mjs), reclaim (reclaim.mjs) and the run view
// (run-view-model.mjs). One fold, so they never disagree about which lines
// carry a worker, or about which agents the Run holds.
import { existsSync, readFileSync } from 'fs'
import { agentDir } from './lifecycle.mjs'
import { foldMail, heldRounds, mailSupersedes } from './doctor.mjs'
import { unionLines } from './git.mjs'

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
// unblocked: it no longer does. dialog: its worker's harness, started or
// continued, shows a dialog before its prompt goes in (the crew host reads
// its screen: screens.mjs), which only the person answers: which `dialog`,
// what they must do (`ask`) and the `terminal` they answer it in; its row
// needs you meanwhile. dialogClosed: the dialog is gone, and the prompt goes
// in once the harness is ready. moving: a worker nudged since it last moved
// moves again, past its nudge's echo, so it is no longer stuck. warning: something that went wrong without
// failing the call. A nudge's
// `attempt` is its number since the session started or was last continued; a
// continuation's is its number, up to the cap; one with `hostDied`, the session
// lost with its host, leaves the number as it was. `origin` names an agent across
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
// number that Run has used; a line also carries `phases`, the titles of the
// phases the script's meta declares, in its order, when it declares any, and
// the carried line the last ones journaled. queued: a call waiting for a live slot.
// doctor: a doctor round starts for a patient, an agent whose session died
// past its continuation cap or was blocked on a human past the blocked limit,
// or whose start failed through every retry: about the patient, with its `origin`, the
// `round` (1 to 3), the failure `reason` it answers, and `doctor`, the n its
// doctor is started under. The patient's call is not settled: its agent()
// waits. A doctor's own lines are those of any agent, under its own n, with
// key null, since it is no agent() call; its failed line also names its
// `patient`, by origin, and fails no call. settled: a doctor's worker settled,
// with its `outcome` (and, when failed, a `reason`: it gave up), a doctor
// submitting no result; one that settled failed folds to failed, never done.
// gaveUp: a doctor round ended without a remedy, about the patient, with the
// `round`, the `doctor` and why;
// after the last one the patient's failed line follows. mail: the runner read
// a message from its Run mailbox: its `messageId`, its `kind` (Orca's type:
// handoff, worker_done…) and the `action` the runner took on it — remedy (a
// doctor's note carried its patient on), needsYou (its doctor escalated: it
// needs a human, its body what they must do or decide), gaveUp (its doctor
// gave up: a worker_done failed), ended (its doctor's worker_done succeeded),
// none (it came from no doctor out, or asked for nothing) or pending (no box
// had claimed its dispatch yet: held with its `dispatchId`, `subject` and
// `body`, and journaled again once acted on; the fold keeps the acting line
// over the pending one). It is journaled before the
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
// continuations afresh: its next `continued` line is attempt 1. outage: Orca
// itself was not there (ADR-0015), a `phase` of the run's, not of any agent:
// start (every Orca call now waits on it; with `reason`, the error that found
// it), paused (still going at the outage limit: the run is paused, and fails
// no agent) and end (Orca answered again; with `ms`, its length); `since` is
// when it began. It has no n, and a resume carries none forward.
// node (ADR-0016): a call's lines carry its `node`, the stable name the script
// gives it (opts.node), when it names one: starting, started, reattached,
// outstanding, continued, result, failed and held. A node's result that needs
// the operator (a non-empty `decisions_needed`) carries `needsDecision: true`:
// it was held, never handed to the script. A resume carries each failed or
// needs-decision node forward as its failed or result line, with `carried:
// true`, `origin` and `worker`, the worker it last ran, so the next resume
// still carries it on. halted: the run halted on `node`, failed or needing
// decisions, with its `reason`; unhalted: no failed or needs-decision node is
// left, and every held call goes on. held: a new call made while the run was
// halted, not started until it is released. halted and unhalted have no n.
// chain (ADR-0020): the session host made the run's chain worktree,
// `<runId>-chain`, which every code agent of a sequential run works in:
// `lines`, its porcelain lines then, as a baseline line holds a child's, or
// null when the host made it but could not take them. It has no n: the
// worktree is the run's, no agent's. A resume carries it forward with
// `leftovers`, the leftover lines so far. chainEntry writes it.
// followUp (#127): a chain agent returned leaving `lines` in the chain
// worktree beyond what it was told was there before it, and was sent back
// once to commit or remove them; leftover: the `lines` still there after,
// which every later chain agent is told never to commit.
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
  dialog: ['at', 'key', 'n', 'title', 'terminal', 'dialog', 'ask'],
  dialogClosed: ['at', 'key', 'n', 'title'],
  moving: ['at', 'key', 'n', 'title', 'dispatchId'],
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
  outage: ['at', 'phase', 'since'],
  halted: ['at', 'node', 'reason'],
  unhalted: ['at'],
  held: ['at', 'key', 'n', 'node', 'title'],
  chain: ['at', 'runId', 'worktree', 'lines'],
  followUp: ['at', 'key', 'n', 'title', 'worktree', 'lines'],
  leftover: ['at', 'key', 'n', 'title', 'worktree', 'lines'],
})

// A needs-decision result's questions, for the run view.
const questionsOf = (result) => (Array.isArray(result?.decisions_needed) ? result.decisions_needed.map((q) => (typeof q === 'string' ? q : JSON.stringify(q))) : [])

// The lines that name a call's worker.
const WORKER_LINES = ['started', 'reattached', 'outstanding']

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

// The chain line for a chain as the fold reads it back, { runId, worktree,
// baseline, leftovers }.
export function chainEntry({ runId, worktree, baseline, leftovers = [] }) {
  return { type: 'chain', runId, worktree, lines: baseline, ...(leftovers.length && { leftovers }) }
}

// The fold of a journal's entries: { calls, retained, run, lastN, phases, agents, mail, outage, chain }.
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
// the highest call number the journal holds; phases: the phase titles the
// last `run` line that names any declares, in the script's order, or null. A journal written before entries
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
// { origin, round, reason, open, doctor, worker, unlaunched, remedy,
// needsYou, gaveUp, ended, restart }, where doctor is that round's doctor, by
// origin, worker its worker, in a call's worker's shape, while it is still
// out, unlaunched, for a doctor whose worker never launched and that neither
// failed nor said anything (its runner died while it was queued for a live
// slot, or starting), { made, baseline }: the worktree an attempt of its start
// left, as journaled, and that worktree's baseline, so the round is started
// afresh rather than spent; remedy { id, body } the handoff journaled as
// mail that no remedy line applied, needsYou what its doctor needs a human
// for, gaveUp the body of a worker_done failed, ended { outcome } a
// worker_done succeeded, and restart, for a patient whose worker never
// started, { made, baseline }: the worktree its start left and its baseline.
//
// agents, every agent the journal names, one per `origin`, by the n of its
// latest line: { origin, n, title, state, reason, continuations, replayed,
// launched, runId, dispatchId, harness, sessionId, worktree, terminal, from,
// to, waiting, nextAt, workerLeft, baseline, patient, round, doctors, rounds, failures,
// attempt }, and originGuessed: true when only a take-up written before
// take-ups carried their origin names it, so origin is that call's n. patient: a
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
// or failed once settled. An agent stays stuck until its worker moves again
// (`moving`: running, or continued once it has continuations or a remedy, as
// unblocked picks), or its next continuation or settlement; blocked lasts
// until unblocked or settled. workerLeft: it failed with its worker's process left running.
// baseline: the porcelain lines its worktree was made with, or null. launched: a worker was started for it,
// whatever its dispatch now reads. from and to are when it began and settled
// here, or null: a replayed result or a carried agent launched nothing here.
// mail: every `mail` line, one per message id, the first kept, in order.
// outage: the Orca outage under way at the journal's end, or null: { phase:
// 'waiting' | 'paused', since }. No agent's state is changed by it.
// chain: the run's chain worktree as last journaled, { runId, worktree,
// baseline, leftovers }, or null: leftovers, every leftover line since, once.
//
// nodes (ADR-0016): node -> its call's entry as `calls` holds it, the latest
// call to name that node winning, with `key`, `node`, `n` and `title`; a failed
// one also `reason`, and a settled one `last`, the worker it last ran, in a
// call's worker's shape. A needs-decision result also has `needsDecision`. A
// call's `starting`, `started` or `reattached` after its failed line makes it
// live again: a halted node resumed in the same run. halted: the run's halt
// under way at the journal's end, or null: { since, node, reason, nodes }, nodes
// being every node still failed or needing decisions. An agent of a node has
// `node`; a needs-decision one is `needs you`, its reason its questions, which
// it also holds as `decisions`; a held call is queued, its reason saying so.
// A failed agent of a node that a later agent of the same node carried on
// has `superseded: true`: the run view draws the node's latest attempt alone.
export function foldJournal(entries) {
  const calls = new Map()
  const nodes = new Map()
  const retained = []
  const mail = new Map()
  let run = null
  let lastN = 0
  let phases = null
  let outage = null
  let halted = null
  let chain = null
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

  // What a worker that runs again is: continued once its session was, or a
  // remedy carried it on; else running.
  const carriedOn = (a) => (a.continuations || a.rounds.at(-1)?.outcome === 'remedy' ? 'continued' : 'running')

  // The lines that leave a dialog the agent is held at as it is.
  const DIALOG_KEEPS = ['dialog', 'dialogClosed', 'warning', 'baseline', 'nudge', 'moving']

  // Folds one line into its agent's record, and returns that agent's origin.
  function agent(e) {
    const worker = WORKER_LINES.includes(e.type) || e.type === 'earlier'
    // A take-up written before take-ups carried their origin, of a worker no
    // earlier line names: its origin is only this call's n.
    const guessed = worker && e.type !== 'started' && !Number.isInteger(e.origin) && !(e.dispatchId && byDispatch.has(e.dispatchId))
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
        waiting: null, nextAt: null, workerLeft: false, baseline: null, patient: null, round: 0, doctors: [], rounds: [], failures: 0, attempt: 1, dialog: null, beforeDialog: null,
      }
      if (guessed) a.originGuessed = true
      agents.set(id, a)
    }
    a.n = e.n
    if (typeof e.title === 'string') a.title = e.title
    if (typeof e.node === 'string') a.node = e.node
    const at = timeOf(e)
    // Anything that moves the agent on ends a dialog it was held at: its
    // session ended at it (a retry, a failure) or got past it.
    if (a.dialog && !DIALOG_KEEPS.includes(e.type)) Object.assign(a, { dialog: null, beforeDialog: null })
    switch (e.type) {
      case 'held':
        Object.assign(a, { state: 'queued', reason: 'held: the run is halted' })
        break
      case 'starting':
        a.from ??= at
        // A held call released, or a halted node started afresh.
        Object.assign(a, { state: 'starting', runId: e.run ?? a.runId, ...((a.state === 'queued' || a.state === 'failed') && { reason: null }) })
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
        if (a.state === 'blocked') Object.assign(a, { state: carriedOn(a), waiting: null, reason: null })
        break
      case 'dialog':
        // Its state before the first dialog of a run of them is what it goes back to.
        if (a.state !== 'needs you' || a.dialog) {
          Object.assign(a, { beforeDialog: a.dialog ? a.beforeDialog : a.state, dialog: e.dialog ?? 'a dialog', state: 'needs you', reason: e.ask ?? `its harness asks something: ${e.dialog}`, terminal: e.terminal ?? a.terminal })
        }
        break
      case 'dialogClosed':
        if (a.dialog) Object.assign(a, { state: a.state === 'needs you' ? a.beforeDialog ?? 'starting' : a.state, reason: a.state === 'needs you' ? null : a.reason, dialog: null, beforeDialog: null })
        break
      case 'moving':
        if (a.state === 'stuck') Object.assign(a, { state: carriedOn(a), reason: null })
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
        // A doctor that gave up (worker_done --outcome failed) is no done row.
        if (e.outcome === 'failed') Object.assign(a, { state: 'failed', reason: e.reason ?? 'it gave up', waiting: null, to: at })
        else Object.assign(a, { state: 'done', reason: null, waiting: null, to: at })
        break
      case 'result':
        if (e.needsDecision === true) {
          const decisions = questionsOf(e.result)
          Object.assign(a, { state: 'needs you', reason: `decisions needed: ${decisions.join(' · ') || 'none named'}`, decisions, waiting: null, to: at })
          if (Number.isInteger(e.worker?.continuations)) a.continuations = e.worker.continuations
          break
        }
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
    if (e.type === 'run' && Array.isArray(e.phases) && e.phases.length) phases = e.phases.filter((p) => typeof p === 'string')
    if (e.type === 'outage') outage = e.phase === 'end' ? null : { phase: e.phase === 'paused' ? 'paused' : 'waiting', since: e.since ?? e.at ?? null }
    if (e.type === 'halted') halted = { since: e.at ?? null, node: e.node ?? null, reason: e.reason ?? null }
    if (e.type === 'unhalted') halted = null
    if (e.type === 'chain' && typeof e.worktree === 'string') chain = { runId: e.runId ?? null, worktree: e.worktree, baseline: Array.isArray(e.lines) ? e.lines : null, leftovers: Array.isArray(e.leftovers) ? e.leftovers : [] }
    if (e.type === 'leftover' && chain && Array.isArray(e.lines)) chain = { ...chain, leftovers: unionLines(chain.leftovers, e.lines) }
    // Read as the runner acted on it (doctor.mjs).
    if (e.type === 'mail' && typeof e.messageId === 'string' && mailSupersedes(e, mail.get(e.messageId))) {
      mail.set(e.messageId, e)
      foldMail(Number.isInteger(e.doctor) ? agents.get(agentOfCall.get(e.doctor) ?? e.doctor) : null, e)
    }
    const numbered = Number.isInteger(e.n)
    const id = numbered && JOURNAL_ENTRIES[e.type] && e.type !== 'run' && e.type !== 'retained' ? agent(e) : null
    if (typeof e.key !== 'string') continue
    if (!numbered && e.type !== 'result' && e.type !== 'failed') continue
    const callId = numbered ? e.n : `line ${i}`
    if (!byCall.has(callId)) byCall.set(callId, { key: e.key, n: numbered ? e.n : null, order: numbered ? e.n : i, carried: false, worker: null, settled: null, origin: null, node: null, title: null, reason: null })
    const c = byCall.get(callId)
    if (typeof e.node === 'string') c.node = e.node
    if (typeof e.title === 'string') c.title = e.title
    // A carried failed or needs-decision node names the worker it last ran.
    if ((e.type === 'result' || e.type === 'failed') && e.worker && typeof e.worker === 'object' && typeof e.worker.dispatchId === 'string') c.worker ??= { ...e.worker }
    if (e.type === 'result') {
      c.settled = { result: e.result, ...(e.needsDecision === true && { needsDecision: true }) }
      if (Number.isInteger(e.origin)) c.origin = e.origin
    } else if (e.type === 'failed') {
      if (!e.workerOut) c.settled = { failed: true }
      c.reason = e.reason ?? null
      if (Number.isInteger(e.origin)) c.origin = e.origin
    } else if (e.type === 'starting') {
      c.settled = null
    } else if (WORKER_LINES.includes(e.type) && e.dispatchId && e.sessionId) {
      if (e.type !== 'outstanding') c.settled = null
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
    const entry = settled ?? { ...(c.worker ? { worker: c.worker } : { unsettled: true }), ...(p?.rounds.length && heldRounds(p, { agents, mail, agentDir })) }
    calls.get(c.key).push(c.node ? { ...entry, node: c.node } : entry)
    if (c.node) {
      nodes.set(c.node, {
        ...entry, key: c.key, node: c.node, n: c.n, title: c.title, ...(c.origin !== null && { origin: c.origin }),
        ...(settled?.failed && { reason: c.reason }), ...(settled && c.worker && { last: c.worker }),
      })
    }
  }
  // A failed node a later call of the same node carried on under a new n (a
  // dead runner's --resume starting it afresh) is superseded: the node's
  // latest attempt is its row. It stays an agent of the Run, since a
  // worktree it was given is still the operator's to reclaim.
  const latestOfNode = new Map()
  for (const a of agents.values()) if (a.node && a.patient == null && (latestOfNode.get(a.node)?.n ?? -Infinity) < a.n) latestOfNode.set(a.node, a)
  for (const a of agents.values()) if (a.node && a.patient == null && a.state === 'failed' && latestOfNode.get(a.node) !== a) a.superseded = true
  const outstandingNodes = [...nodes.values()].filter((x) => x.failed || x.needsDecision).map((x) => x.node)
  return { calls, nodes, retained, run, lastN, phases, agents: [...agents.values()].sort((x, y) => x.n - y.n), mail: [...mail.values()], outage, chain, halted: halted && { ...halted, nodes: outstandingNodes } }
}
