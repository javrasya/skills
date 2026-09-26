// One agent's life under the Orca runner: its files, the run's Run, a live
// slot, its worker's start (or, on a resume, taking up the worker the last run
// left out), the watch until it settles or dies (its session
// nudged and continued on the way), its result, and
// what the journal, the board and the retained list learn from it. runner.mjs
// decides which calls reach here (replay does not) and names each one.
// Nothing is reclaimed here (ADR-0012): a settled worker is never released, and
// its tab and worktree stay until the operator reclaims them (reclaim.mjs).
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { validate } from './schema.mjs'
import { sessionTranscripts } from './transcript.mjs'

export const SUBMIT = fileURLToPath(new URL('./submit.mjs', import.meta.url))

// The files a worktree held before its agent, from its baseline's porcelain
// lines: named for the agent so it never commits them, since it cannot tell
// them from its own. A baseline of none adds nothing.
const baselineSection = (baseline) => (baseline?.length ? `

---
These files were in your worktree before you, left by its setup: ${baseline.map((l) => l.slice(3)).join(', ')}. They are not your work, so never stage or commit them. Stage your own changes by path (\`git add <path>\`), never with \`git add -A\`, \`git add .\` or \`git commit -a\`.` : '')

// A doctor's note for a patient whose worker never started: its start is
// retried with the note after the prompt the worker receives.
const noteSection = (note) => (note == null ? '' : `

---
An earlier start of this task failed before any worker ran, and a doctor, an agent that read what the workflow runner recorded of it, worked out why. Its note follows: keep it in mind as you work.

## The doctor's note
${note}`)

// `baseline`: the porcelain lines of the worktree it starts in, or null.
// `note`: a doctor's note for a start retried after its retries were spent.
export function workerPrompt(prompt, { schemaPath, resultPath, payloadPath, baseline = null, note = null }) {
  const what = schemaPath
    ? `Write your result to ${payloadPath} as one JSON object that matches the JSON Schema in ${schemaPath}.`
    : `Write your answer to ${payloadPath} as plain text.`
  const command = [`node "${SUBMIT}"`, schemaPath && `--schema "${schemaPath}"`, `--result "${resultPath}"`, `--payload "${payloadPath}"`,
    '--from <worker_handle> --dispatch-capability <capability> --task-id <task_id> --dispatch-id <dispatch_id>'].filter(Boolean).join(' ')
  return `${prompt}${baselineSection(baseline)}

---
How this run receives your result: your final message is not read. Your result reaches the workflow only through the submit command below, and submit sends your worker_done for you — never send worker_done yourself.
1. ${what}
2. Run this, replacing the four <placeholders> with the values from your Orca preamble, copied exactly:
   ${command}
3. If submit exits non-zero it prints every error: fix the payload and run it again until it exits 0. Then stop and idle.${noteSection(note)}`
}

// FIFO slots: a freed slot passes straight to the longest-waiting call.
function slots(max) {
  let live = 0
  const waiting = []
  return {
    async acquire(onQueue) {
      if (live < max) return void live++
      onQueue()
      await new Promise((r) => waiting.push(r))
    },
    release() {
      const next = waiting.shift()
      if (next) next()
      else live--
    },
  }
}

// A result that reports a PR its agent published: its worktree's work is on
// the stack, so its board card is done.
const published = (v) => !!v && typeof v === 'object' && typeof v.pr_url === 'string' && !!v.pr_url && v.published !== false

const slug = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60)

// An agent's files, relative to the state dir: named by its call's number and
// label when its worker starts, and journaled with that worker, so a resume
// that takes the worker up reads the files its prompt named.
export const agentDir = (n, label) => `agents/${String(n).padStart(3, '0')}-${slug(label)}`

// Marks supervise's answer for a patient that gets a doctor, which no
// script value can be mistaken for.
const SICK = Symbol('needs a doctor')

// The messages a doctor that needs you can follow its escalation with; any
// other kind (a heartbeat, a status) leaves it needing you.
const ANSWERS = ['handoff', 'escalation', 'worker_done']

const mins = (ms) => Math.round(ms / 60_000)
const wait = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 6_000) / 10} min`)

const NUDGE = 'The workflow has not received your result: your final message is not read. Finish the task, then run the submit command from your instructions until it exits 0.'

// Typed after the resume, or handed as the spec of the dispatch that adopts a
// new terminal, whose preamble then carries new IDs.
// The doctor's whole brief: it gets no submit command, since its only output
// is a note, sent as Orca mail (ADR-0014).
// earlier: each earlier round of this patient, { round, note, outcome }, so
// that no doctor hands it a note that already failed.
const earlierRounds = (earlier) => (earlier.length ? `

## Earlier doctor rounds
Each earlier round's note, and how that round ended. None of them cured the patient: never hand it a note that already failed.
${earlier.map(({ round, note, outcome }) => `
### Round ${round}
Note: ${note ?? 'none'}
Outcome: ${outcome}`).join('\n')}` : '')

export function doctorPrompt({ patient, reason, round, rounds, transcript, worktree, entries, log, earlier = [] }) {
  return `You are a doctor in a workflow run. One of its agents, the patient, failed, and its agent() call waits on you: its dependents wait with it. Work out why it failed, and write a note: guidance that lets the patient avoid that failure when it carries on. This is doctor round ${round} of ${rounds}.

Change nothing. Edit, create or delete no file, in any worktree; change no environment, configuration or installed tool; log in to or out of nothing. Read only. Your only output is the note.

When only a human can clear the failure (a login, credentials, a sandbox permission), state the situation and what the human must do or decide, plainly. Do not question them: they handle it their own way.

Report over Orca mail to your Run's mailbox, with the IDs from your Orca preamble:
- the note: orchestration send --type handoff --subject note --body "<the note>", then worker_done --outcome succeeded;
- a human is needed: orchestration send --type escalation --subject "Blocked: <what>" --body "<what the human must do or decide>", then wait for as long as it takes: nobody hurries you. Once the human tells you in your tab that they did their part, send your note as above, or escalate again if something is still needed;
- you give up: worker_done --outcome failed, with why in the body.

## The patient
Title: ${patient.title}
Failure reason: ${reason}
Transcript: ${transcript}
Worktree: ${worktree ?? 'none: it ran in the run\'s own worktree'}${earlierRounds(earlier)}

## Its prompt
${patient.prompt}

## Its journal entries
${entries.map((e) => JSON.stringify(e)).join('\n') || '(none)'}

## Its runner log lines
${log.join('\n') || '(none)'}`
}

const continuePrompt = (why) => `You were interrupted: the workflow runner stopped this session and resumed it (${why}). Carry on where you left off and finish the task, then run the submit command from your instructions until it exits 0. If an Orca preamble came with this message, take the four IDs for submit from it, not from an earlier one.`

// A doctor's remedy: the patient's session carries on with its note.
export const notePrompt = (note) => `You were stopped: this session failed, and the workflow runner resumed it once a doctor, an agent that read your transcript, had worked out why. Its note follows. Carry on where you left off, with the note in mind, and finish the task, then run the submit command from your instructions until it exits 0. If an Orca preamble came with this message, take the four IDs for submit from it, not from an earlier one.

## The doctor's note
${note}`

// Re-reads what submit recorded: the script is handed a value only if it is
// valid now, whatever the worker claimed when it settled.
function readResult(resultPath, schema) {
  if (!existsSync(resultPath)) return { error: 'settled without submitting a result' }
  let value
  try {
    value = JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch (e) {
    return { error: `recorded result is not JSON: ${e.message}` }
  }
  const errors = schema ? validate(schema, value) : typeof value === 'string' ? [] : ['$: expected text']
  return errors.length ? { error: `recorded result fails its schema: ${errors.join('; ')}` } : { value }
}

// Built once per run: the Run and the live cap are shared by every agent it
// starts. objective() is read at the first live agent, once the script has
// declared its meta. journal(entry) appends one journal line;
// retainWorktree({path, reason}) retains a worktree and returns the entry the
// list holds for it.
// takeOver: the id of a Run an earlier runner of this run created, which this
// one takes over (run-use) instead of creating one. onRun({ runId, terminal,
// takenOver }) is called once, when Orca creates the Run or hands it over.
// transcripts.size({ harness, sessionId, worktree }) measures a session's
// transcript (transcript.mjs), and transcripts.path(…) names it.
// nextN() is the run's next agent number, which a doctor is started under;
// doctorLaunch() the recover role's launch; history({ n, origin, title }) the
// patient's journal entries and runner log lines ({ entries, log }).
// mailHandled: the ids of the Run mailbox's messages an earlier runner of
// this run journaled, which this one acknowledges and never acts on again.
// Returns life(call), which resolves to the agent's value or null, and throws
// only if journal or out does.
export function agentLifecycle({ orca, clock, limits, out, stateDir, objective, journal, retainWorktree, onRun = () => {}, takeOver = null, transcripts = sessionTranscripts(), nextN, doctorLaunch = () => ({ harness: 'claude' }), history = () => ({ entries: [], log: [] }), mailHandled = [] }) {
  const live = slots(limits.MAX_LIVE)
  // One Run per workflow run: every agent's worker is dispatched into it.
  let run = null
  let toldNoMode = false

  // The one point where a call ends in null: a start whose retries are spent,
  // the end of supervision, and a Run it could not take over or create all
  // come here, and nothing else writes `failed` or returns an agent() null.
  // A session dead past its cap or blocked past the limit, and a start whose
  // retries are spent, first get their doctor rounds (treat), and come here
  // only once they are spent. retained: the worktree it left, or null;
  // alsoRetained: each other one, journaled after it as `retained` lines.
  // attempts counts the starts, or Run creations, it made; one that started a
  // worker made one more start than it retried. continuations counts how
  // often a started worker's session was continued; a
  // continuation carries on that attempt's session. `run` is the Run it failed
  // in, once there is one: reclaim names a retained worktree by it. workerOut:
  // its worker is still out, so the call stays unsettled for the next resume,
  // which takes that worker up again. workerLeft: its worker's process was
  // left running (kept, ADR-0012), so only a reclaim that stops it first
  // removes it (reclaim.mjs). mark and said: the log line's prefix, and what
  // it adds after `agent() returns null`. A doctor's failed line names its
  // patient, and fails no agent() call: the runner does not count it.
  const failAgent = ({ key, n, title, patient = null }, { reason, retained = null, alsoRetained = [], attempts = 1, continuations = 0, run = null, workerOut = false, workerLeft = false }, { mark = '!!', said = '' } = {}) => {
    journal({ type: 'failed', key, n, title, reason, attempts, ...(patient != null && { patient }), ...(run && { run }), ...(continuations && { continuations }), ...(retained && { retained }), ...(workerOut && { workerOut }), ...(workerLeft && { workerLeft }) })
    for (const also of alsoRetained) journal({ type: 'retained', retained: also })
    out(`${mark} ${title}: ${reason}; agent() returns null${said}`)
    return null
  }

  // Something that went wrong without failing the agent: logged and
  // journaled, never swallowed.
  const warn = ({ key, n, title }, reason) => {
    out(`!! ${title}: ${reason}`)
    journal({ type: 'warning', key, n, title, reason })
  }

  const quietly = async (title, what, fn) => {
    try {
      await fn()
    } catch (e) {
      out(`!! ${title}: could not ${what}: ${e.message}`)
    }
  }

  // The worktree a dead agent leaves, retained, or null.
  const keep = ({ isolated, title }, w) => (isolated && w?.worktree
    ? retainWorktree({ path: w.worktree, reason: `retained because its agent (${title}) died before reporting its path: it may hold the only copy of that agent's work` })
    : null)

  // A session continued under a new dispatch runs in a new tab: its old pane
  // is gone, so nothing can settle the old dispatch.
  async function moveTo(title, w, next) {
    if (next.dispatchId !== w.dispatchId) {
      await quietly(title, 'stop its old worker', () => orca.workerStop({ dispatch: w.dispatchId }))
      await quietly(title, 'title its new tab', () => orca.terminalRename({ terminal: next.terminal, title }))
    }
    return { ...w, dispatchId: next.dispatchId, terminal: next.terminal, worktree: next.worktree ?? w.worktree }
  }

  // The Run mailbox, read from the runner's own terminal while a doctor is
  // out. Orca hands a batch back until it is acknowledged, and a resume's
  // run-use re-batches it under a new delivery id, so a message is acted on
  // once by its id: journaled as `mail` with what the runner did, acted on,
  // and only then acknowledged. mailboxes: a doctor's box, by each dispatch
  // it ran under; a message from no open box is journaled and acts on nothing.
  // An escalation marks its doctor needs you (box.needsYou, what the human
  // must do) until its next handoff, escalation or worker_done, in order.
  const handled = new Set(mailHandled)
  const mailboxes = new Map()
  let reading = Promise.resolve()
  // One read at a time, each after the last: a doctor that saw its worker
  // settle reads again, and gets what was sent before the settle.
  const readMail = () => {
    const r = reading.then(drain)
    reading = r.catch(() => {})
    return r
  }
  async function drain() {
    for (let r = await orca.mailCheck(); r.deliveryId; r = await orca.mailCheck({ ack: r.deliveryId })) {
      for (const m of r.messages) await take(m)
    }
  }
  async function take(m) {
    if (!m?.id || handled.has(m.id)) return
    handled.add(m.id)
    const box = mailboxes.get(m.dispatchId) ?? null
    const open = !!box && !box.closed
    const action = !open ? 'none'
      : m.type === 'escalation' ? 'needsYou'
      : m.type === 'handoff' ? (box.remedied ? 'none' : 'remedy')
      : m.type === 'worker_done' ? (m.outcome === 'failed' ? 'gaveUp' : 'ended')
      : 'none'
    journal({
      type: 'mail', messageId: m.id, kind: m.type ?? null, action, ...(m.outcome && { outcome: m.outcome }),
      ...(box && { doctor: box.doctor, patient: box.patient, round: box.round }), ...(open && m.body != null && { body: m.body }),
    })
    if (open && ANSWERS.includes(m.type)) box.needsYou = m.type === 'escalation' ? (m.body || m.subject || 'no reason given') : null
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

  // Runs attempt(1), attempt(2)… until one returns, one throws an error
  // marked `final`, or the settings table's backoff is spent. The last error
  // is thrown carrying `reason` (what failed, and why) and `attempts`. Each
  // new attempt is journaled as retry before its wait, with why the one before
  // it failed and when it begins, so the reason is on the journal through the
  // wait, even if the runner dies in it.
  async function retrying({ key, n, title }, what, attempt) {
    const waits = limits.retryBackoffMs
    for (let i = 1; ; i++) {
      try {
        return await attempt(i)
      } catch (err) {
        const e = err instanceof Object ? err : new Error(String(err))
        Object.assign(e, { reason: `${what}: ${e.message}`, attempts: i })
        if (e.final || i > waits.length) throw e
        out(`!! ${title}: ${e.reason}; trying again in ${wait(waits[i - 1])} (attempt ${i + 1} of ${waits.length + 1})`)
        journal({ type: 'retry', key, n, title, attempt: i + 1, reason: e.reason, nextAt: new Date(clock.now() + waits[i - 1]).toISOString() })
        await clock.sleep(waits[i - 1])
      }
    }
  }

  // Every agent's worker is dispatched into the one Run. Concurrent calls
  // share its creation, or its takeover, retries included; once it has failed
  // for good, the next call asks Orca again. A takeover precedes every
  // worker-start, which Orca refuses from any terminal but the Run's.
  function ensureRun(call) {
    const creating = (run ??= takeOver
      ? retrying(call, `Orca could not hand this run's Run ${takeOver} over to this runner`, () => orca.runUse({ runId: takeOver }).then((r) => (onRun({ ...r, takenOver: true }), r)))
      : retrying(call, "Orca could not create this run's Run", () => orca.runCreate({ objective: objective() }).then((r) => (onRun(r), r))))
    return creating.catch((e) => {
      if (run === creating) run = null
      throw e
    })
  }

  // The board card of a worktree the runner created. Cosmetic: a failure is
  // a warning and the agent carries on.
  async function setStatus(call, worktree, status) {
    try {
      await orca.worktreeStatus({ worktree, status })
    } catch (e) {
      warn(call, `could not set its worktree's board status to ${status}: ${e?.message ?? e}`)
    }
  }

  // The session's transcript size, or null: a reader that throws is a signal
  // missing, never a dead worker.
  function measure(w, harness, sessionId) {
    try {
      return transcripts.size({ harness, sessionId, worktree: w.worktree ?? null })
    } catch {
      return null
    }
  }

  // Watches one worker until it settles ({ outcome }) or crosses a limit in
  // the settings table ({ dead: why }, with `gone`, `blocked` or `unseen`
  // saying which kind). Liveness is two signals (ADR-0013): the session's
  // transcript growing, and the terminal's busy or idle state changing. The
  // worker is stuck only while neither moves. nudged(why, attempt) journals
  // each nudge; blocked(waiting) and unblocked() journal a wait on a human
  // beginning and ending, so the run view shows it while it lasts. mail(), a
  // doctor's, reads the Run mailbox at every look, and ends the watch with
  // what it returns: the doctor's worker_done, read before Orca shows it.
  // held(), a doctor's, is whether it needs you: while it does, it waits on
  // a human for as long as it takes, so no idle, stillness or blocked limit
  // counts against it; each counts afresh from its next message.
  async function watch(w, { title, harness, sessionId, nudged, blocked = () => {}, unblocked = () => {}, mail = null, held = () => false }) {
    const start = clock.now()
    let errors = 0
    let nudges = 0
    let graceFrom = start
    let stillFrom = start
    let lastNudgeAt = null
    let lastLookAt = start
    let stuckNudged = false
    let blockedAt = null
    let size = null
    let busy = null

    async function nudge(why, attempt) {
      out(`>> ${title}: ${why}; nudging it`)
      lastNudgeAt = graceFrom = clock.now()
      nudged(why, attempt)
      try {
        await orca.terminalSend({ terminal: w.terminal, text: NUDGE })
      } catch (e) {
        out(`!! ${title}: the nudge did not reach it: ${e.message}`)
      }
    }

    for (;; await clock.sleep(limits.pollMs)) {
      if (mail) {
        try {
          const ended = await mail()
          if (ended) return ended
        } catch (e) {
          out(`!! ${title}: could not read the Run's mailbox: ${e.message}`)
        }
      }
      const hold = held()
      let s
      let idle = null
      try {
        s = await orca.workerShow({ dispatch: w.dispatchId })
        if (!s.settled && !s.gone && !s.waiting && !s.exited && w.terminal) {
          idle = await orca.terminalIdle({ terminal: w.terminal, timeoutMs: limits.idleProbeMs })
        }
        errors = 0
      } catch (e) {
        if (++errors >= limits.watchErrors) return { dead: `Orca failed ${errors} times in a row watching it (${e.message})`, unseen: true }
        out(`!! ${title}: could not look at its worker: ${e.message}`)
        continue
      }
      if (s.settled) return { outcome: s.outcome }
      if (s.gone) return { dead: 'its terminal is gone', gone: true }

      const now = clock.now()
      const bytes = measure(w, harness, sessionId)
      let moved = bytes !== null && bytes !== size
      if (bytes !== null) size = bytes
      if (idle !== null) {
        if (busy !== null && busy === idle) moved = true
        busy = !idle
      }
      // A nudge lands in the transcript and turns the TUI busy even in a
      // session that is hung: that is the nudge, not the worker. What moved
      // since a look taken before the echo settled is dated by that earlier
      // look, never by how late this one came: it only re-baselines.
      const echo = lastNudgeAt !== null && lastLookAt < lastNudgeAt + limits.nudgeEchoMs
      lastLookAt = now
      if (moved && !echo) {
        stillFrom = now
        stuckNudged = false
      }

      if (s.waiting) {
        if (blockedAt === null) {
          blockedAt = now
          out(`!!!!!!!! ${title} is BLOCKED ON A HUMAN. Answer it in terminal ${w.terminal}.`)
          out(`!!!!!!!! waiting on: ${s.waiting}`)
          if (!hold) out(`!!!!!!!! ${title}: if nobody answers within ${mins(limits.blockedFailMs)} minutes, it fails and is kept as it stands, and ${limits.doctorRounds ? 'a doctor diagnoses it while its agent() waits' : 'agent() returns null'}`)
          blocked(s.waiting)
        }
        if (hold) blockedAt = now
        if (now - blockedAt >= limits.blockedFailMs) return { dead: `blocked on a human, unanswered for ${mins(now - blockedAt)} minutes`, blocked: true }
        continue
      }
      if (blockedAt !== null) {
        out(`>> ${title}: no longer blocked`)
        unblocked()
        blockedAt = null
        stillFrom = graceFrom = now
      }
      if (hold) {
        stillFrom = graceFrom = now
        stuckNudged = false
        continue
      }

      // Idle counts only once neither signal has moved for the grace: a
      // transcript still growing behind an idle TUI is a worker at work.
      const calm = now - Math.max(graceFrom, stillFrom) >= limits.nudgeGraceMs
      if ((s.exited || idle) && calm) {
        const how = s.exited ? 'exited' : 'went idle'
        if (nudges >= limits.idleNudges) return { dead: `it ${how} without submitting, after ${nudges} nudges` }
        ++nudges
        await nudge(`it ${how} without submitting (nudge ${nudges} of ${limits.idleNudges})`, nudges)
        continue
      }

      const still = now - stillFrom
      if (still >= limits.stuckContinueMs) return { dead: `no movement in its transcript or terminal for ${mins(still)} minutes` }
      if (still >= limits.stuckNudgeMs && !stuckNudged) {
        stuckNudged = true
        await nudge(`no movement in its transcript or terminal for ${mins(still)} minutes`, 1)
      }
    }
  }

  // How a worker the last run started fared while no runner watched it: null
  // to watch it again (live, settled, blocked, or one Orca could not show,
  // which the watch gives up on as on any other), or the death to continue
  // its session from.
  async function lookBack(w) {
    let s
    try {
      s = await orca.workerShow({ dispatch: w.dispatchId })
    } catch {
      return null
    }
    if (s.settled || s.waiting) return null
    if (s.gone) return { dead: 'its terminal closed while no runner was watching it', gone: true }
    if (s.exited) return { dead: 'it exited while no runner was watching it' }
    return null
  }

  // A resume takes up the worker the last run started for this call and
  // never starts a second one: watched, or continued first if it died
  // meanwhile. life() has journaled it as reattached.
  async function takeUp({ title, adopt }) {
    const w = { dispatchId: adopt.dispatchId, terminal: adopt.terminal, worktree: adopt.worktree }
    const continued = adopt.continuations
    const end = await lookBack(w)
    out(`>> ${title}: took up its worker from the last run: dispatch ${w.dispatchId}, session ${adopt.sessionId}, in terminal ${w.terminal}${w.worktree ? ` in ${w.worktree}` : ''}${end ? `; ${end.dead}` : ''}`)
    return { w, sessionId: adopt.sessionId, attempts: 0, continued, end }
  }

  // Starts the call's worker, retried as the settings table says. Once it
  // has failed for good, the call's null, or, for an agent() call, its
  // patient's failure, handed to its doctors. again: a doctor's remedy, the
  // start retried with its `note`, carrying on from the `made`, `dispatched`
  // and `baseline` the spent start left, so its first attempt is a retry.
  async function start(runId, call, again = null) {
    const { prompt, isolated, launch, key, n, title, phaseName, dir, schemaPath, resultPath, payloadPath, patient = null, setup = null } = call
    // The child worktrees failed attempts left. Every attempt of a call asks
    // for the same `<runId>-<n>` name, so a retry takes that one up again;
    // one Orca made under a suffixed name leaves both it and that one.
    const made = new Set(again?.made)
    // Once any attempt has sent its worker-start, a worker may have run in
    // that worktree, and a retry no longer takes it up whatever it holds.
    let dispatched = again?.dispatched ?? false
    // The porcelain lines its worktree was made with, journaled before its
    // terminal opens: what a retry judges it against, and what its agent is
    // told is not its own. None for a create that timed out.
    let baseline = again?.baseline ?? null
    const onBaseline = ({ worktree, lines }) => {
      baseline = lines
      journal({ type: 'baseline', key, n, title, worktree, lines })
    }
    let w, sessionId
    let attempts = 0
    try {
      ;({ w, sessionId } = await retrying(call, 'its worker did not start', async (attempt) => {
        // Assigned, not discovered: the harness is started with it (decision
        // D2 on #43). A new one per attempt: a failed attempt's harness may
        // already have taken the last one.
        const sessionId = randomUUID()
        attempts = attempt
        try {
          const w = await orca.workerStart({
            run: runId,
            prompt: patient != null ? prompt : (baseline) => workerPrompt(prompt, { schemaPath, resultPath, payloadPath, baseline, note: again?.note ?? null }),
            title,
            ...launch,
            sessionId,
            child: isolated ? { name: `${runId}-${n}`, displayName: title, retry: attempt > 1 || !!again, dispatched, baseline, onBaseline, ...(setup && { setup }) } : null,
          })
          return { w, sessionId }
        } catch (e) {
          for (const path of [e?.worktree, ...(Array.isArray(e?.worktrees) ? e.worktrees : [])]) if (path) made.add(path)
          if (e?.dispatched) dispatched = true
          throw e
        }
      }))
    } catch (e) {
      // A worktree Orca made before the start failed is named like a dead
      // agent's: the runner never removes one. The failed line carries the
      // first; a `retained` line names each other one. A patient's are
      // retained only once its doctor rounds end in null.
      const retainMade = () => {
        const [kept, ...more] = isolated ? [...made].map((path) => retainWorktree({ path, reason: `retained because it was created for ${title}, whose worker never started, so no agent ever reported it` })) : []
        return { retained: kept ?? null, alsoRetained: more }
      }
      const failure = { reason: e.reason, attempts: e.attempts, run: runId }
      if (patient == null) {
        return { [SICK]: { ...failure, harness: launch.harness, sessionId: null, worktree: isolated ? [...made][0] ?? null : null, keep: retainMade, restart: { made: [...made], dispatched, baseline } } }
      }
      return failAgent(call, { ...failure, ...retainMade() })
    }
    for (const why of w.warnings ?? []) warn(call, why)
    journal({ type: 'started', key, n, title, run: runId, dispatchId: w.dispatchId, harness: launch.harness, sessionId, worktree: w.worktree ?? null, terminal: w.terminal, dir })
    if (isolated && w.worktree) await setStatus(call, w.worktree, phaseName === 'Gate' ? 'in-review' : 'in-progress')
    const on = [launch.harness, launch.model, launch.effort && `${launch.effort} effort`, launch.permissionMode && `${launch.permissionMode} mode`].filter(Boolean).join(', ')
    out(`>> ${title}: started on ${on} as dispatch ${w.dispatchId}, session ${sessionId}, in terminal ${w.terminal}${w.worktree ? ` in ${w.worktree}` : ''}`)
    // The agent titles its own tab and drops --task-title (ADR-0011), so the
    // tab is renamed to the title the operator finds it by.
    try {
      await orca.terminalRename({ terminal: w.terminal, title })
    } catch (e) {
      out(`!! ${title}: could not title its tab: ${e.message}`)
    }
    return { w, sessionId, attempts, continued: 0, end: null }
  }

  // call.from: a patient carried on by its doctor's remedy, { w, sessionId,
  // attempts, continued }, watched again without a start, or { restart }, the
  // start of a patient whose worker never started, retried with the note.
  // call.box: a doctor's mailbox, which take() fills from its messages.
  async function supervise(runId, call) {
    const { schema, isolated, launch, key, n, title, resultPath, patient = null, box = null } = call
    if (launch.harness === 'claude' && !launch.permissionMode && !toldNoMode) {
      toldNoMode = true
      out("!! no --permission-mode given: Claude workers start in Claude's own default permission mode, not in the orchestrator's.")
    }
    const { from = null } = call
    const got = from?.restart ? await start(runId, call, from.restart) : from ?? (call.adopt ? await takeUp(call) : await start(runId, call))
    if (!got || got[SICK]) return got
    const { sessionId, attempts } = got
    let { w, end = null, continued } = got
    const post = () => {
      if (!box) return
      box.terminal = w.terminal
      mailboxes.set(w.dispatchId, box)
    }
    post()
    const mail = box ? async () => (await readMail(), box.ended) : null

    let delivered = false
    // A patient handed to its doctors: its worktree is retained only if
    // their rounds end in null.
    let sick = false
    let kept = null
    const retain = () => (kept ??= keep(call, w))
    try {
      for (;;) {
        end ??= await watch(w, {
          title, harness: launch.harness, sessionId,
          nudged: (reason, attempt) => journal({ type: 'nudge', key, n, title, dispatchId: w.dispatchId, reason, attempt }),
          blocked: (waiting) => journal({ type: 'blocked', key, n, title, dispatchId: w.dispatchId, terminal: w.terminal, waiting: String(waiting) }),
          unblocked: () => journal({ type: 'unblocked', key, n, title, dispatchId: w.dispatchId }),
          mail,
          held: () => box?.needsYou != null,
        })
        // A dead session is continued in its own session (ADR-0013), unless
        // it waits on a human, Orca cannot see it, or it already submitted.
        if (!end.dead || end.blocked || end.unseen || existsSync(resultPath)) break
        if (continued >= limits.maxContinuations) {
          end = { ...end, dead: `${end.dead}, and its session was already continued ${continued} times, the cap of ${limits.maxContinuations}`, capped: true }
          break
        }
        const attempt = ++continued
        const reopen = !!end.gone
        out(`>> ${title}: ${end.dead}; continuing session ${sessionId} (continuation ${attempt} of ${limits.maxContinuations}) ${reopen ? `in a new terminal in ${w.worktree ?? 'its worktree'}` : `in terminal ${w.terminal}`}`)
        let next
        try {
          next = await orca.workerContinue({ run: runId, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title, prompt: continuePrompt(end.dead), ...launch, sessionId, reopen })
        } catch (e) {
          end = { dead: `${end.dead}, and continuing its session failed: ${e?.message ?? e}` }
          break
        }
        journal({ type: 'continued', key, n, title, dispatchId: next.dispatchId, sessionId, terminal: next.terminal, reason: end.dead, attempt, reopened: next.dispatchId !== w.dispatchId })
        w = await moveTo(title, w, next)
        post()
        end = null
      }
      // A doctor's last messages can land after its worker settled or died.
      if (box) await readMail().catch((e) => out(`!! ${title}: could not read the Run's mailbox: ${e.message}`))
      // A doctor submits nothing: its worker_done, or its worker settling, is its end.
      if (patient != null && !end.dead) {
        journal({ type: 'settled', key, n, title, dispatchId: w.dispatchId, outcome: end.outcome ?? null })
        out(`<< ${title}: its worker settled ${end.outcome}`)
        delivered = true
        return { outcome: end.outcome ?? null }
      }
      // Read even for a dead worker: one that died after submit recorded its
      // result still delivered it.
      const result = patient != null ? { error: 'a doctor submits no result' } : readResult(resultPath, schema)
      // Failed and kept (ADR-0012): its process is not stopped either. No
      // worker is released during the run: its tab and worktree stay for the
      // operator to reclaim at the end (reclaim.mjs).
      const kept = !!(end.capped || end.blocked) && !!result.error
      if (end.dead && !kept) await quietly(title, 'stop its worker', () => orca.workerStop({ dispatch: w.dispatchId }))
      // A null is journaled as failed, as the Workflow runner journals a dead
      // agent: a resume runs the call live again. The worktree it leaves rides
      // along, so a resume still names it.
      if (result.error) {
        const reason = end.dead ? `${end.dead}, with no result` : `${result.error} (outcome ${end.outcome})`
        if (kept) out(`!! ${title}: its tab ${w.terminal} is kept open`)
        const failure = { reason, attempts, continuations: continued, run: runId, workerLeft: kept }
        // A doctor is never itself doctored: its failure spends its round.
        if (kept && patient == null) {
          sick = true
          return { [SICK]: { ...failure, harness: launch.harness, sessionId, worktree: isolated ? w.worktree ?? null : null, w, gone: !!end.gone, keep: () => ({ retained: keep(call, w) }) } }
        }
        return failAgent(call, { ...failure, retained: retain() })
      }
      journal({ type: 'result', key, n, title, result: result.value })
      out(`<< ${title}: result received`)
      delivered = true
      if (isolated && w.worktree && published(result.value)) await setStatus(call, w.worktree, 'completed')
      return result.value
    } finally {
      if (!delivered && !sick) retain()
    }
  }

  // call: { prompt, schema, isolated, launch, key, n, label, title, phaseName },
  // and on a resume `adopt`, the worker the last run left out for it, as the
  // journal's fold names it: { dir, run, dispatchId, harness, sessionId,
  // terminal, worktree, continuations, origin }. A doctor's call also has
  // `patient`, its patient's origin, `round`, and `setup: 'skip'`, and key null:
  // it is no agent() call, so a resume replays nothing from it.
  async function life(call) {
    const { schema, key, n, label, title, adopt } = call
    // A worker taken up submits to the files its prompt named: the dir
    // journaled with it, however many resumes ago it started.
    const rel = adopt?.dir ?? agentDir(n, label)
    const dir = join(stateDir, rel)
    // Journaled before any wait on the Run or on a live slot, so a runner
    // that dies before it watches the worker still leaves it to the next
    // resume, which takes it up in turn. With every field `started` gives a
    // worker, and its origin, so reclaim and the run view read it as the
    // agent it is, never as a new one with no worker.
    if (adopt) {
      journal({
        type: 'reattached', key, n, title, run: adopt.run ?? takeOver, dispatchId: adopt.dispatchId, harness: adopt.harness ?? call.launch?.harness ?? null,
        sessionId: adopt.sessionId, terminal: adopt.terminal, worktree: adopt.worktree, dir: rel, origin: adopt.origin ?? n, ...(adopt.continuations && { continuations: adopt.continuations }),
      })
    }
    mkdirSync(dir, { recursive: true })
    const schemaPath = schema ? join(dir, 'schema.json') : null
    const resultPath = join(dir, 'result.json')
    const payloadPath = join(dir, schema ? 'payload.json' : 'payload.txt')
    if (schemaPath) writeFileSync(schemaPath, JSON.stringify(schema, null, 2))
    // A state dir reused across runs must not hand this agent an older
    // result. One taken up may have submitted while no runner watched it.
    if (!adopt) rmSync(resultPath, { force: true })

    // Like a worker that cannot start, a Run Orca cannot create is this
    // agent's null, never a throw; the next agent() asks Orca again.
    let runId
    try {
      ;({ runId } = await ensureRun(call))
    } catch (e) {
      if (adopt) {
        // Its worker is still out: the call stays unsettled for the next
        // resume, which takes that worker up, and its worktree is named.
        const kept = call.isolated && adopt.worktree ? retainWorktree({ path: adopt.worktree, reason: `retained because its agent (${title}) was still at work when this runner could not take its Run over, so it never reported — the next resume takes that agent up again` }) : null
        return failAgent(call, { reason: e.reason, retained: kept, attempts: e.attempts, continuations: adopt.continuations, run: adopt.run ?? takeOver, workerOut: true }, { mark: '!!!!!!!!', said: `, its worker ${adopt.dispatchId} is left out for the next resume to take up, and the next agent() asks again` })
      }
      return failAgent(call, { reason: e.reason, attempts: e.attempts }, { mark: '!!!!!!!!', said: ', and the next agent() asks again' })
    }
    // Held until the worker settles or is stopped. It is never released during
    // the run, so its tab stays open, but a settled worker no longer works.
    // Journaled so the run view can show a call that waits here: nothing
    // else about it is written until its worker starts.
    // A patient's doctor rounds so far, each one's note and outcome (trail),
    // and each doctor whose note carried it on: watched to its end before the
    // call returns, so none outlives it.
    const rounds = { round: 0, doctors: [], trail: [] }
    let from = null
    let got
    for (;;) {
      await live.acquire(() => {
        out(`.. ${title}: queued, ${limits.MAX_LIVE} agents are live`)
        journal({ type: 'queued', key: call.key, n, title })
      })
      // Its row from here on: nothing else is journaled until its worker starts,
      // or its first attempt fails. A worker taken up is journaled already.
      if (!adopt && !from) journal({ type: 'starting', key: call.key, n, title, run: runId })
      try {
        got = await supervise(runId, { ...call, dir: rel, schemaPath, resultPath, payloadPath, from })
      } finally {
        live.release()
      }
      // Its slot is freed first: a doctor needs one, and one held by a patient
      // that waits on its own doctor would starve the run, or deadlock it at a
      // cap of one. A remedy carries it on, and it takes a slot again.
      if (!got?.[SICK]) break
      from = await treat(call, got[SICK], rounds)
      if (!from) {
        got = null
        break
      }
    }
    await Promise.all(rounds.doctors)
    return got
  }

  // A patient, a session dead past its cap or blocked past the limit, or a
  // start whose retries are spent: up to limits.doctorRounds doctors, one after
  // another, while its agent() stays pending (ADR-0014). A doctor's handoff
  // is its remedy, applied as its message is read: treat then resolves to
  // what supervise carries the patient on from, or null if that failed. A
  // doctor that ends without one, by giving up, settling or failing itself,
  // spends its round; once every round is spent, the call is failed and
  // kept, as without a doctor. rounds: the call's rounds so far. Each round
  // builds on the ones before it: its doctor is handed their notes and
  // outcomes, and a remedy carries the patient on with a fresh count of
  // continuations.
  async function treat(call, failure, rounds) {
    const { key, n, title, label, phaseName, prompt } = call
    const origin = call.adopt?.origin ?? n
    const max = limits.doctorRounds
    // Back here after a remedy: that round's note carried it on, and it died again.
    const last = rounds.trail.at(-1)
    if (last && last.outcome === null) last.outcome = `its note carried the patient on, and it failed again: ${failure.reason}`
    const transcript = failure.sessionId == null ? 'none: its worker never started'
      : transcripts.path?.({ harness: failure.harness, sessionId: failure.sessionId, worktree: failure.worktree }) ?? `none found for ${failure.harness} session ${failure.sessionId}`
    while (rounds.round < max) {
      const round = ++rounds.round
      const doctor = nextN()
      const dLabel = `recover -> ${label}`
      const dTitle = `[${phaseName}] ${dLabel}`
      journal({ type: 'doctor', key, n, title, origin, round, reason: failure.reason, doctor })
      out(`>> ${title}: ${failure.reason}; doctor round ${round} of ${max}: ${dTitle} diagnoses it, and its agent() waits`)
      const { entries, log } = history({ n, origin, title })
      let handed
      const handoff = new Promise((r) => { handed = r })
      const box = {
        doctor, patient: origin, round, title: dTitle, terminal: null, ended: null, gaveUp: null, remedied: false, closed: false, needsYou: null,
        handoff: async (m) => {
          rounds.trail.push({ round, note: m.body ?? '', outcome: null })
          handed(await remedy(call, failure, { round, doctor, message: m }))
        },
      }
      const ended = life({
        prompt: doctorPrompt({ patient: { title, prompt }, reason: failure.reason, round, rounds: max, transcript, worktree: failure.worktree, entries, log, earlier: rounds.trail.map((t) => ({ ...t })) }),
        schema: null, isolated: true, setup: 'skip', launch: doctorLaunch(), key: null, n: doctor, label: dLabel, title: dTitle, phaseName, patient: origin, round, box,
      }).then((end) => {
        box.closed = true
        return end
      })
      // A handoff is taken before its doctor's life resolves: that life reads
      // the mailbox one last time before it ends.
      const first = await Promise.race([handoff, ended.then((end) => ({ end }))])
      if (!('end' in first)) {
        rounds.doctors.push(ended)
        return first.from
      }
      const { end } = first
      const why = box.gaveUp !== null ? `it gave up: ${box.gaveUp}` : end ? `its worker settled ${end.outcome} with no remedy` : 'it failed itself'
      rounds.trail.push({ round, note: null, outcome: `no remedy: ${why}` })
      journal({ type: 'gaveUp', key, n, title, origin, round, doctor, reason: why })
      out(`!! ${title}: doctor round ${round} of ${max} ended without a remedy: ${why}`)
    }
    return failAgent(call, { ...failure, ...failure.keep() }, { said: `, after ${max} doctor rounds without a remedy` })
  }

  // A doctor's handoff: the patient's session carries on in its own session
  // and worktree, in its own tab, or a new one in its worktree once that tab
  // is gone, with the note in its continuation prompt. A patient whose worker
  // never started has its start retried instead, with the note in its
  // worker's prompt, once it has a live slot again: under the same call, so
  // its journal key stays the original call's. It resolves to what
  // supervise carries the patient on from, or { from: null } once a
  // continuation that failed has failed the call. A new round starts a new
  // count of continuations: one carried on past its cap would otherwise die
  // past it again at its first death.
  async function remedy(call, failure, { round, doctor, message }) {
    const { key, n, title, launch } = call
    const origin = call.adopt?.origin ?? n
    if (failure.restart) {
      out(`>> ${title}: doctor round ${round} handed off a note; retrying its start with it`)
      journal({ type: 'remedy', key, n, title, origin, round, doctor, how: 'restart', messageId: message.id, dispatchId: null, terminal: null, reopened: false })
      return { from: { restart: { ...failure.restart, note: message.body ?? '' } } }
    }
    const { w, sessionId } = failure
    out(`>> ${title}: doctor round ${round} handed off a note; continuing session ${sessionId} with it ${failure.gone ? `in a new terminal in ${w.worktree ?? 'its worktree'}` : `in terminal ${w.terminal}`}`)
    let next
    try {
      next = await orca.workerContinue({ run: failure.run, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title, prompt: notePrompt(message.body ?? ''), ...launch, sessionId, reopen: failure.gone })
    } catch (e) {
      failAgent(call, { ...failure, reason: `${failure.reason}, and continuing its session with its doctor's note failed: ${e?.message ?? e}`, retained: keep(call, w) })
      return { from: null }
    }
    journal({ type: 'remedy', key, n, title, origin, round, doctor, how: 'continue', messageId: message.id, dispatchId: next.dispatchId, terminal: next.terminal, reopened: next.dispatchId !== w.dispatchId })
    return { from: { w: await moveTo(title, w, next), sessionId, attempts: failure.attempts, continued: 0 } }
  }

  return life
}
