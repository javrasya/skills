// A patient's doctors (ADR-0014), in one place: what a doctor is told (its
// brief, nudge and continuation), the Run mailbox it reports over, and what
// the runner does with each message (mailAction), a patient's doctor rounds
// (treat) and their remedy, and the journal fold's reading of all of it
// (foldMail, heldRounds), so the runner and the fold agree on a round and a
// message by construction. The lifecycle calls it at its failure point:
// doctorRounds(…).treat(call, failure, rounds, again), and hands each worker's
// dispatch to runMailbox(…).claim. It imports no other runner module:
// lifecycle.mjs and journal.mjs both import it.
import { tool } from './tools.mjs'

// The messages a doctor that needs you can follow its escalation with; any
// other kind (a heartbeat, a status) leaves it needing you.
export const ANSWERS = Object.freeze(['handoff', 'escalation', 'worker_done'])
const answers = (kind) => ANSWERS.includes(kind)

// What the runner does with a message of `kind` (the host's message type) and `outcome`
// from the dispatch whose doctor's box is `box` (null for none): remedy (a
// round's first handoff), needsYou (an escalation before it), gaveUp or ended
// (its worker_done, failed or not), or none (no box, a round closed, a later
// handoff or escalation, or a kind that asks for nothing). A round's first
// handoff is its remedy, and ends the doctor's part: a later handoff or
// escalation from it acts on nothing, so only its worker_done, or its
// lifecycle, ends it. Its prompt says so.
export function mailAction(kind, outcome, box) {
  if (!box || box.closed) return 'none'
  if (kind === 'escalation') return box.remedied ? 'none' : 'needsYou'
  if (kind === 'handoff') return box.remedied ? 'none' : 'remedy'
  if (kind === 'worker_done') return outcome === 'failed' ? 'gaveUp' : 'ended'
  return 'none'
}

// Whether a mail line the fold reads replaces the one it keeps for that
// message id, `kept`: a message held `pending` gives way to the line that
// acted on it; otherwise the first line stands.
export const mailSupersedes = (e, kept) => !kept || (kept.action === 'pending' && e.action !== 'pending')

// A doctor's row in the journal's fold after a mail line it acted on, as the
// runner held its box: needs you from an escalation until its next handoff,
// escalation or worker_done, in order. d: the doctor's row, or null.
export function foldMail(d, e) {
  if (!d || d.state === 'done' || d.state === 'failed' || !answers(e.kind)) return
  if (e.action === 'needsYou') Object.assign(d, { state: 'needs you', reason: e.body ?? null })
  else if (d.state === 'needs you') Object.assign(d, { state: d.continuations ? 'continued' : 'running', reason: null })
}

// How a doctor reports, as its brief says: it has no submit command, so its
// nudge and continuation prompt never name one.
const REPORT = `report as your instructions say, with crew's tools when your session has them, else over Run mail: hand off your note (\`${tool('handoff').name}\`, or send it as a handoff, then worker_done); say a human is needed (\`${tool('needs_you').name}\`, or an escalation) if only a human can clear the failure; or give up (\`${tool('give_up').name}\`, or worker_done --outcome failed). If you already sent your note as mail, send worker_done`
export const DOCTOR_NUDGE = `The workflow has not received your report: your final message is not read. Finish your diagnosis, then ${REPORT}.`

// The doctor's whole brief: it gets no submit command, since its only output
// is a note, sent as Run mail (ADR-0014).
// earlier: each earlier round of this patient, { round, note, outcome }, so
// that no doctor hands it a note that already failed.
const earlierRounds = (earlier) =>
  earlier.length
    ? `

## Earlier doctor rounds
Each earlier round's note, and how that round ended. None of them cured the patient: never hand it a note that already failed.
${earlier
  .map(
    ({ round, note, outcome }) => `
### Round ${round}
Note: ${note ?? 'none'}
Outcome: ${outcome}`,
  )
  .join('\n')}`
    : ''

export function doctorPrompt({ patient, reason, round, rounds, transcript, worktree, entries, log, earlier = [] }) {
  return `You are a doctor in a workflow run. One of its agents, the patient, failed, and its agent() call waits on you: its dependents wait with it. Work out why it failed, and write a note: guidance that lets the patient avoid that failure when it carries on. This is doctor round ${round} of ${rounds}.

Change nothing. Edit, create or delete no file, in any worktree; change no environment, configuration or installed tool; log in to or out of nothing. Read only. Your only output is the note.

When only a human can clear the failure (a login, credentials, a sandbox permission), state the situation and what the human must do or decide, plainly. Do not question them: they handle it their own way. Never run any \`orchestration ask\` command, whatever your session host's preamble offers: nobody answers it. A question only a human can answer goes in your escalation or your note, as below.

Report with crew's tools, when your session has them:
- the note: call \`${tool('handoff').name}\` with it. Your first handoff is this round's note: the runner carries the patient on with it at once, and takes no later handoff or escalation from you, so send it only once you are done;
- a human is needed: call \`${tool('needs_you').name}\` with what the human must do or decide, then wait for as long as it takes: nobody hurries you. Once the human tells you in your tab that they did their part, send your note as above, or call it again if something is still needed;
- you give up: call \`${tool('give_up').name}\` with why.

Without those tools, or if one says crew's daemon is not reachable, report over Run mail to your Run's mailbox instead, with the IDs from your session host's preamble:
- the note: ${tool('handoff').fallback()}, only once you are done, as above;
- a human is needed: ${tool('needs_you').fallback()}, then wait as above, and escalate again if something is still needed once the human did their part;
- you give up: ${tool('give_up').fallback()}.

## The patient
Title: ${patient.title}
Failure reason: ${reason}
Transcript: ${transcript}
Worktree: ${worktree ?? "none: it ran in the run's own worktree"}${earlierRounds(earlier)}

## Its prompt
${patient.prompt}

## Its journal entries
${entries.map((e) => JSON.stringify(e)).join('\n') || '(none)'}

## Its runner log lines
${log.join('\n') || '(none)'}`
}

// A doctor's, which has no submit command.
export const doctorContinuePrompt = (why) => `You were interrupted: the workflow runner stopped this session and resumed it (${why}). Carry on with your diagnosis where you left off, then ${REPORT}. If a session host's preamble came with this message, take the IDs for Run mail from it, not from an earlier one.`

// A doctor's remedy: the patient's session carries on with its note.
export const notePrompt = (
  note,
) => `You were stopped: this session failed, and the workflow runner resumed it once a doctor, an agent that read your transcript, had worked out why. Its note follows. Carry on where you left off, with the note in mind, and finish the task, then run the submit command from your instructions until it exits 0. If a session host's preamble came with this message, take the four IDs for submit from it, not from an earlier one.

## The doctor's note
${note}`

// The Run mailbox, read from the runner's own terminal while a doctor is
// out. The host hands a batch back until it is acknowledged, and a resume's
// run-use re-batches it under a new delivery id, so a message is acted on
// once by its id: journaled as `mail` with what the runner did (mailAction),
// acted on, and only then acknowledged. A doctor's box claims each dispatch
// it runs under, and an agent() call's worker claims its own, whose mail (its
// submit's worker_done) asks for nothing. A message from a dispatch nothing
// claims yet is held, never dropped: journaled `pending` with the whole
// message, and acted on in order once its dispatch is claimed. Every doctor's
// messages are then applied, whichever doctor's watch drained them: one a
// doctor sends before its worker-start returns, or one another doctor's watch
// reads first on a resume. A resume holds each pending message again.
// An escalation marks its doctor needs you (box.needsYou, what the human
// must do) until its next handoff, escalation or worker_done, in order.
// handled: the ids of the messages an earlier runner of this run journaled,
// which this one acknowledges and never acts on again; pending: those it
// held, as { id, type, dispatchId, outcome, subject, body }, held again here.
// A box, as treat makes one: { doctor, patient, round, title, terminal,
// ended, gaveUp, remedied, closed, needsYou, handoff(message) }.
// Returns { read, claim, ends }: read() reads the mailbox once, after the
// last read, so a doctor that saw its worker settle reads again and gets
// what was sent before the settle; claim(dispatchId, box) claims a dispatch
// for a doctor's box, or, with box null, for an agent() call's worker; and
// ends(box) is the mail() a doctor's watch reads at every look, which
// resolves to its worker_done once one is read.
export function runMailbox({ host, journal, out, handled: mailHandled = [], pending: mailPending = [] }) {
  const handled = new Set(mailHandled)
  const mailboxes = new Map()
  const agentsOut = new Set()
  const held = new Map()
  const hold = (m) => held.set(m.dispatchId, [...(held.get(m.dispatchId) ?? []), m])
  for (const m of mailPending) if (m?.id && m.dispatchId) hold(m)
  let reading = Promise.resolve()
  // One read at a time, each after the last.
  const read = () => {
    const r = reading.then(drain)
    reading = r.catch(() => {})
    return r
  }
  async function drain() {
    for (let r = await host.mailCheck(); r.deliveryId; r = await host.mailCheck({ ack: r.deliveryId })) {
      for (const m of r.messages) await take(m)
    }
  }
  // What was held for a dispatch is applied before any later read, so in order.
  function claim(dispatchId, box) {
    if (box) mailboxes.set(dispatchId, box)
    else agentsOut.add(dispatchId)
    const mine = held.get(dispatchId)
    if (!mine) return
    held.delete(dispatchId)
    const r = reading.then(async () => {
      for (const m of mine) await act(m, box)
    })
    reading = r.catch((e) => out(`!! could not act on held Run mail: ${e?.message ?? e}`))
  }
  async function take(m) {
    if (!m?.id || handled.has(m.id)) return
    handled.add(m.id)
    const box = mailboxes.get(m.dispatchId) ?? null
    if (!box && m.dispatchId && !agentsOut.has(m.dispatchId)) {
      hold(m)
      journal({
        type: 'mail',
        messageId: m.id,
        kind: m.type ?? null,
        action: 'pending',
        dispatchId: m.dispatchId,
        ...(m.outcome && { outcome: m.outcome }),
        ...(m.subject != null && { subject: m.subject }),
        ...(m.body != null && { body: m.body }),
      })
      return
    }
    await act(m, box)
  }
  async function act(m, box) {
    const open = !!box && !box.closed
    const action = mailAction(m.type, m.outcome, box)
    journal({
      type: 'mail',
      messageId: m.id,
      kind: m.type ?? null,
      action,
      ...(m.outcome && { outcome: m.outcome }),
      ...(box && { doctor: box.doctor, patient: box.patient, round: box.round }),
      ...(open && m.body != null && { body: m.body }),
    })
    if (open && answers(m.type)) box.needsYou = action === 'needsYou' ? m.body || m.subject || 'no reason given' : null
    if (action === 'needsYou') {
      out(`!!!!!!!! ${box.title} NEEDS YOU: ${box.needsYou}`)
      out(`!!!!!!!! ${box.title}: do it, then tell it so in its tab ${box.terminal ?? '—'}; it waits for as long as it takes`)
    } else if (action === 'remedy') {
      box.remedied = true
      await box.handoff(m)
    } else if (action === 'gaveUp') {
      box.gaveUp = m.body ?? ''
      box.ended = { outcome: 'failed' }
    } else if (action === 'ended') box.ended = { outcome: m.outcome ?? 'succeeded' }
  }
  return { read, claim, ends: (box) => async () => (await read(), box.ended) }
}

// A patient's doctor rounds. life(call) is the lifecycle's, which a doctor is
// started through as any agent is; failAgent(call, failure, how) its one
// point where a call ends in null; nextN() the run's next agent number, which
// a doctor is started under; doctorLaunch() the recover role's launch;
// history({ n, origin, title }) the patient's journal entries and runner log
// lines ({ entries, log }); transcripts.path(…) names a session's transcript.
// Returns { roundsOf, treat, settled }: roundsOf(call) a patient's rounds so
// far, as treat counts them, treat as below, and settled() resolves once
// every doctor still out has ended: a patient's agent() never waits on its
// doctor once its own result is in, so the runner awaits them before it ends.
export function doctorRounds({ limits, journal, out, life, failAgent, nextN, doctorLaunch, history, transcripts }) {
  // Every doctor still out once its note carried its patient on, whichever
  // patient's.
  const doctorsOut = new Set()
  const track = (p) => {
    doctorsOut.add(p)
    p.then(
      () => doctorsOut.delete(p),
      () => {},
    )
  }

  // Each round's note and outcome (trail), from the fold on a resume. A held
  // patient's open round is counted again as treat goes on with it.
  const roundsOf = ({ rounds = null, held = null }) => ({ round: (rounds?.round ?? 0) - (held?.open ? 1 : 0), trail: (rounds?.trail ?? []).map((t) => ({ ...t })) })

  // A patient, a session dead past its cap or blocked past the limit, or a
  // start whose retries are spent: up to limits.doctorRounds doctors, one after
  // another, while its agent() stays pending (ADR-0014). A doctor's handoff
  // is its remedy, taken as its message is read: treat then resolves to
  // what supervise carries the patient on from, once the patient holds a
  // live slot again, or null once every round is spent. A
  // doctor that ends without one, by giving up, settling or failing itself,
  // spends its round; once every round is spent, the call is failed and
  // kept, as without a doctor. rounds: the call's rounds so far. Each round
  // builds on the ones before it: its doctor is handed their notes and
  // outcomes, and a remedy carries the patient on with a fresh count of
  // continuations. again: a held patient's open round, as the fold names it,
  // which a resume goes on with: its doctor taken up, never a second started,
  // and a handoff journaled but not yet applied applied now, once. A doctor
  // that never launched (queued or starting when its runner died) spent
  // nothing: that round's doctor is started afresh, in the same round.
  async function treat(call, failure, rounds, again = null) {
    const { key, n, title, label, phaseName, prompt } = call
    const origin = call.adopt?.origin ?? call.origin ?? n
    const max = limits.doctorRounds
    // Back here after a remedy: that round's note carried it on, and it died again.
    const last = rounds.trail.at(-1)
    if (last && last.outcome === null) last.outcome = `its note carried the patient on, and it failed again: ${failure.reason}`
    const transcript = failure.sessionId == null ? 'none: its worker never started' : (transcripts.path?.({ harness: failure.harness, sessionId: failure.sessionId, worktree: failure.worktree }) ?? `none found for ${failure.harness} session ${failure.sessionId}`)
    while (rounds.round < max) {
      const round = ++rounds.round
      // A doctor taken up runs under a new n, as a resumed call does; one that
      // ended keeps its own, and so does one that never launched, whose start
      // then asks for the `<runId>-<n>` worktree an earlier attempt made.
      const doctor = again && !again.worker && again.doctor != null ? again.doctor : nextN()
      const dLabel = `recover -> ${label}`
      const dTitle = `[${phaseName}] ${dLabel}`
      journal({ type: 'doctor', key, n, title, origin, round, reason: failure.reason, doctor })
      out(
        again
          ? `>> ${title}: doctor round ${round} of ${max} goes on after the resume: ${dTitle} ${again.worker ? 'is taken up' : again.unlaunched ? 'never launched, so it starts now' : 'ended while no runner watched it'}, and its agent() waits`
          : `>> ${title}: ${failure.reason}; doctor round ${round} of ${max}: ${dTitle} diagnoses it, and its agent() waits`,
      )
      let handed
      const handoff = new Promise((r) => {
        handed = r
      })
      const box = {
        doctor,
        patient: origin,
        round,
        title: dTitle,
        terminal: null,
        ended: again?.gaveUp != null ? { outcome: 'failed' } : (again?.ended ?? null),
        gaveUp: again?.gaveUp ?? null,
        remedied: !!again?.remedy,
        closed: false,
        needsYou: again?.needsYou ?? null,
        handoff: async (m) => {
          rounds.trail.push({ round, note: m.body ?? '', outcome: null })
          handed(await remedy(call, failure, { round, doctor, message: m }))
        },
      }
      const dCall = { schema: null, isolation: 'worktree', setup: 'skip', launch: doctorLaunch(), key: null, n: doctor, label: dLabel, title: dTitle, phaseName, patient: origin, patientTitle: title, round, box }
      let doctoring
      if (!again || again.unlaunched) {
        const { entries, log } = history({ n, origin, title })
        // Its worker may have been sent its start before its runner died: a
        // worktree it left is judged against its baseline.
        const startAgain = again?.unlaunched ? { ...again.unlaunched, dispatched: true } : null
        doctoring = life({ ...dCall, prompt: doctorPrompt({ patient: { title, prompt }, reason: failure.reason, round, rounds: max, transcript, worktree: failure.worktree, entries, log, earlier: rounds.trail.map((t) => ({ ...t })) }), ...(startAgain && { startAgain }) })
      } else doctoring = again.worker ? life({ ...dCall, adopt: again.worker }) : Promise.resolve(undefined)
      const ended = doctoring.then((end) => {
        box.closed = true
        return end
      })
      if (again?.remedy) await box.handoff({ id: again.remedy.id, body: again.remedy.body })
      again = null
      // A handoff is taken before its doctor's life resolves: that life reads
      // the mailbox one last time before it ends.
      const first = await Promise.race([handoff, ended.then((end) => ({ end }))])
      if (!('end' in first)) {
        track(ended)
        return first.from
      }
      const { end } = first
      const why = box.gaveUp !== null ? `it gave up: ${box.gaveUp}` : end ? `its worker settled ${end.outcome} with no remedy` : end === undefined ? 'it ended while no runner watched it' : 'it failed itself'
      rounds.trail.push({ round, note: null, outcome: `no remedy: ${why}` })
      journal({ type: 'gaveUp', key, n, title, origin, round, doctor, reason: why })
      out(`!! ${title}: doctor round ${round} of ${max} ended without a remedy: ${why}`)
    }
    return failAgent(call, { ...failure, ...failure.keep() }, { said: `, after ${max} doctor rounds without a remedy` })
  }

  // A doctor's handoff: the patient's session carries on in its own session
  // and worktree, in its own tab, or a new one in its worktree once that tab
  // is gone, with the note in its continuation prompt (carryOn). A patient
  // whose worker never started has its start retried instead, with the note
  // in its worker's prompt. Either is applied once the patient has a live
  // slot again, by supervise, under the same call, so its journal key stays
  // the original call's. It resolves to what supervise carries the patient
  // on from. A new round starts a new count of continuations: one carried on
  // past its cap would otherwise die past it again at its first death.
  async function remedy(call, failure, { round, doctor, message }) {
    const { key, n, title } = call
    const origin = call.adopt?.origin ?? call.origin ?? n
    if (failure.restart) {
      out(`>> ${title}: doctor round ${round} handed off a note; retrying its start with it`)
      journal({ type: 'remedy', key, n, title, origin, round, doctor, how: 'restart', messageId: message.id, dispatchId: null, terminal: null, reopened: false })
      return { from: { restart: { ...failure.restart, note: message.body ?? '' } } }
    }
    return { from: { carry: { failure, round, doctor, messageId: message.id, note: message.body ?? '' } } }
  }

  return {
    roundsOf,
    treat,
    settled: async () => {
      while (doctorsOut.size) await Promise.all([...doctorsOut])
    },
  }
}

// The journal fold's side of an unsettled patient p's rounds (foldJournal),
// from its row and the fold's `agents` (by origin) and `mail` (by message
// id): { rounds }, and, while its agent() waits on them, `held`, where they
// stand, which treat goes on from as its `again`. agentDir(n, label) names a
// worker's files, as the lifecycle does.
export function heldRounds(p, { agents, mail, agentDir }) {
  const { rounds } = p
  const trail = rounds.flatMap((r, i) => (r.outcome === 'remedy' ? [{ round: r.round, note: r.note, outcome: rounds[i + 1] ? `its note carried the patient on, and it failed again: ${rounds[i + 1].reason}` : null }] : r.outcome === 'gaveUp' ? [{ round: r.round, note: null, outcome: `no remedy: ${r.why}` }] : []))
  const last = rounds.at(-1)
  if (last.outcome === 'remedy') return { rounds: { round: p.round, trail } }
  const open = last.outcome === null
  const d = open && last.doctor != null ? agents.get(last.doctor) : null
  const out = !!d && d.launched && !!d.dispatchId && !!d.sessionId && d.state !== 'done' && d.state !== 'failed'
  const said = open ? [...mail.values()].filter((m) => m.patient === p.origin && m.round === last.round) : []
  const remedy = said.find((m) => m.action === 'remedy')
  const gaveUp = said.find((m) => m.action === 'gaveUp')
  const ended = said.find((m) => m.action === 'ended')
  // Nothing ran for the round: its doctor was queued, or starting, when its
  // runner died. One that failed its start, or said anything, has ended.
  const unlaunched = open && !remedy && !gaveUp && !ended && (!d || (!d.launched && d.state !== 'done' && d.state !== 'failed'))
  return {
    rounds: { round: p.round, trail },
    held: {
      origin: p.origin,
      round: last.round,
      reason: last.reason,
      open,
      doctor: last.doctor ?? null,
      worker: out
        ? {
            n: d.n,
            title: d.title,
            dir: agentDir(d.origin, d.title?.replace(/^\[[^\]]*\] /, '') || `agent-${d.origin}`),
            run: d.runId,
            dispatchId: d.dispatchId,
            harness: d.harness,
            sessionId: d.sessionId,
            terminal: d.terminal,
            worktree: d.worktree,
            continuations: d.continuations,
            origin: d.origin,
          }
        : null,
      unlaunched: unlaunched ? { made: d?.worktree ? [d.worktree] : [], baseline: d?.baseline ?? null } : null,
      remedy: remedy ? { id: remedy.messageId, body: remedy.body ?? '' } : null,
      needsYou: out && d.state === 'needs you' ? d.reason : null,
      gaveUp: gaveUp ? (gaveUp.body ?? '') : null,
      ended: ended ? { outcome: ended.outcome ?? 'succeeded' } : null,
      restart: p.launched ? null : { made: p.worktree ? [p.worktree] : [], baseline: p.baseline },
    },
  }
}
