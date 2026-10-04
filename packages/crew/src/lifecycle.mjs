// One agent's life under the session runner: its files, the run's Run, a live
// slot, its worker's start (or, on a resume, taking up the worker the last run
// left out), the watch until it settles or dies (its session
// nudged and continued on the way), its result, and
// what the journal, the board and the retained list learn from it. runner.mjs
// decides which calls reach here (replay does not) and names each one.
// Nothing is reclaimed here (ADR-0012): a settled worker is never released, and
// its tab and worktree stay until the operator reclaims them (reclaim.mjs).
// A patient, one whose session died past its cap or blocked past the limit,
// or whose start's retries are spent, is handed to its doctor rounds
// (doctor.mjs), which also hold the Run mailbox its doctors report over.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validate } from './schema.mjs'
import { slug } from './util.mjs'
import { sessionTranscripts } from './transcript.mjs'
import { agentId, extraLines, porcelainPaths, unionLines } from './git.mjs'
import { chainEntry } from './journal.mjs'
import { DOCTOR_NUDGE, doctorContinuePrompt, notePrompt, runMailbox, doctorRounds } from './doctor.mjs'
import { NOTE_MAX, submitShape, tool } from './tools.mjs'

export { doctorPrompt, notePrompt } from './doctor.mjs'
export { SUBMIT } from './tools.mjs'

const fileNames = (lines) => porcelainPaths(lines).join(', ')

// The worktree a failure names as its agent's: the one it ran in (`w`), or,
// for one that never started, the first child its start made or the run's
// chain it was to start in; never the run's own worktree, which no agent owns.
const failureWorktree = ({ isolation }, w, made = [], chainPath = null) => {
  if (isolation === 'none') return null
  if (w) return w.worktree ?? null
  return isolation === 'worktree' ? (made[0] ?? null) : chainPath
}

// The files a worktree held before its agent, from its baseline's porcelain
// lines, and in a chain worktree those an agent before it left there
// (`leftovers`, #127): named for the agent so it never commits them, since it
// cannot tell them from its own. None adds nothing.
const baselineSection = (baseline, leftovers = []) => {
  const told = [baseline?.length && `These files were in your worktree before you, left by its setup: ${fileNames(baseline)}.`, leftovers.length && `These files were left uncommitted in your worktree by an agent before you: ${fileNames(leftovers)}.`].filter(Boolean)
  return told.length
    ? `

---
${told.join(' ')} They are not your work, so never stage or commit them. Stage your own changes by path (\`git add <path>\`), never with \`git add -A\`, \`git add .\` or \`git commit -a\`.`
    : ''
}

// The one follow-up a chain agent gets when it returned leaving files
// uncommitted in the worktree the next agent starts in (#127). Its result is
// already in: anything it submitted again would be read by nobody.
export const leftoverPrompt = (lines) => `Your result is in, but you left these files uncommitted in the worktree the next agent starts in: ${fileNames(lines)}. Commit the ones that are your work and remove the rest, so nothing you made is left uncommitted. Do not submit again. Then stop and idle.`

// A doctor's note for a patient whose worker never started: its start is
// retried with the note after the prompt the worker receives.
const noteSection = (note) =>
  note == null
    ? ''
    : `

---
An earlier start of this task failed before any worker ran, and a doctor, an agent that read what the workflow runner recorded of it, worked out why. Its note follows: keep it in mind as you work.

## The doctor's note
${note}`

// Nobody answers a worker mid-task: a host's preamble may offer `orchestration
// ask`, which blocks until the coordinator replies, and this runner never does.
export const NO_ASK =
  "Never run any `orchestration ask` command, whatever your session host's preamble offers, and never wait on a reply from anyone: nobody will answer. Put a question only a human can answer in your result (in `decisions_needed`, where your schema has it), finish everything it does not block, then submit."

// An attended worker (ADR-0021) is the one a person joins: it asks them, and
// waits on them as long as they take.
export const ATTENDED = 'A person will join this session: ask them directly in it, and wait for their answer for as long as they take — nobody hurries you, and nothing fails you for waiting. Submit only once your task says you are done.'

// A worker's own subagents are its work, and the runner sees them in its
// transcript (transcript.mjs). A dynamic workflow inside a workflow run is
// another orchestrator the runner cannot see or supervise.
export const NO_WORKFLOW = 'You may use subagents, in the foreground or the background. Never start a dynamic workflow (the Workflow tool, or any workflow extension of your harness): this run is already one, and a second orchestrator inside it is one the runner cannot see.'

// `baseline`: the porcelain lines of the worktree it starts in, or null.
// `leftovers`: those an agent before it left in its chain worktree.
// `note`: a doctor's note for a start retried after its retries were spent.
// `attended`: a person joins it, so it is told to ask them, not that nobody answers.
// `schema`: the one at schemaPath, which shapes the submit tool's arguments;
// one not given is taken for an object's.
// The tool comes first (ADR-0027); the CLI line is for a session without it,
// as every one but a crew host's pi or Claude worker is, and for a daemon gone.
export function workerPrompt(prompt, { schema = null, schemaPath, resultPath, payloadPath, baseline = null, leftovers = [], note = null, attended = null }) {
  const what = schemaPath ? `Write your result to ${payloadPath} as one JSON object that matches the JSON Schema in ${schemaPath}.` : `Write your answer to ${payloadPath} as plain text.`
  const command = tool('submit').fallback({ schemaPath, resultPath, payloadPath })
  const { how } = submitShape(schemaPath ? (schema ?? { type: 'object' }) : null)
  return `${prompt}${baselineSection(baseline, leftovers)}

---
How this run receives your result: your final message is not read. Your result reaches the workflow only through submit, and submit sends your worker_done for you — never send worker_done yourself.
If your session has a tool named \`submit\`, finish with it: call it with ${how}${schemaPath ? `, which must match the JSON Schema in ${schemaPath}` : ''}. It rejects a result that does not match, saying why: fix it and call it again until it is accepted. Then stop and idle.
Without that tool, or if it says crew's daemon is not reachable, submit with the command below instead:
1. ${what}
2. Run this, replacing the four <placeholders> with the values from your session host's preamble, copied exactly:
   ${command}
3. If submit exits non-zero it prints every error: fix the payload and run it again until it exits 0. Then stop and idle.

${attended ? ATTENDED : NO_ASK}

${NO_WORKFLOW}${noteSection(note)}`
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

// An agent's files, relative to the state dir: named by its call's number and
// label when its worker starts, and journaled with that worker, so a resume
// that takes the worker up reads the files its prompt named.
export const agentDir = (n, label) => `agents/${String(n).padStart(3, '0')}-${slug(label)}`

// Marks supervise's answer for a patient that gets a doctor, which no
// script value can be mistaken for.
const SICK = Symbol('needs a doctor')

// What a call's dispatch knows of its agent, on every start and continue
// (session-host.mjs): a session submits by its id alone with it.
const agentOf = (call) => ({ role: call.patient != null ? 'doctor' : 'worker', schema: call.schema ?? null, resultPath: call.resultPath ?? null })

// A worker whose session its host lost when the host itself died (workerShow's
// `hostDied`, crew's after a crash): continued in a new session, uncounted.
const HOST_DIED = Object.freeze({ dead: 'its session died with its session host', gone: true, hostDied: true })

const mins = (ms) => Math.round(ms / 60_000)
const wait = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 6_000) / 10} min`)

// What the delivery check looks for in the session: the start of the prompt,
// whitespace collapsed, which the host types after its preamble unchanged.
const needleOf = (prompt) => String(prompt).replace(/\s+/g, ' ').trim().slice(0, 120)

// Lines of the host's preamble, which worker-start types before the prompt, and
// which the input to empty may still hold: one Ctrl-U per line, and more on
// an empty input do nothing.
const PREAMBLE_LINES = 100

// The prompt typed again, when neither worker-start's typing nor an Enter
// reached the session. The host's preamble came with the first typing and cannot
// be typed again as it was: it alone carried the dispatch capability, which
// nothing hands the runner (not worker-start's answer, nor `dispatch-show
// --preamble`). So the runner names the three IDs it holds, which the
// host's preamble also names, the worker's handle being its terminal's, and the
// capability is left out: submit sends worker_done without one (submit.mjs),
// from the worker's own pane, which the host settles a dispatch from.
const resendPrompt = (
  w,
  prompt,
) => `The workflow runner typed this message again: the one worker-start sent did not reach you, and your session host's preamble it began with did not either. Your IDs, for submit and for any Run mail: worker handle ${w.terminal}, task id ${w.taskId}, dispatch id ${w.dispatchId}. Leave out --dispatch-capability: you have none.

---
${prompt}`

const NUDGE = 'The workflow has not received your result: your final message is not read. Finish the task, then run the submit command from your instructions until it exits 0.'

// Typed after the resume, or handed as the spec of the dispatch that adopts a
// new terminal, whose preamble then carries new IDs.
const continuePrompt = (why) =>
  `You were interrupted: the workflow runner stopped this session and resumed it (${why}). Carry on where you left off and finish the task, then run the submit command from your instructions until it exits 0. If a session host's preamble came with this message, take the four IDs for submit from it, not from an earlier one.`

// A node resumed after the run halted on it (ADR-0016): its session carried
// on, told why. One that needed decisions is told the operator has answered,
// on the ticket. `remade`: the baseline of the run's chain worktree, made
// again because it was reclaimed while the run was halted (ADR-0020).
// `attended`: a person joins it (ADR-0021), so its answers come from them.
export const haltedPrompt = (needsDecision, remade = null, attended = false) =>
  `${
    attended
      ? 'The workflow run was halted here and has been resumed. The person is back in this session: pick up with them where you stopped, and finish the task'
      : needsDecision
        ? 'The workflow run was halted here: your result named decisions only the operator can make, and the operator has answered them. Re-read the ticket, its body and its comments, for the answers, then finish the task'
        : 'The workflow run was halted here, and the operator has resumed it. Carry on from where you are and finish the task'
  }, then run the submit command from your instructions until it exits 0. If a session host's preamble came with this message, take the four IDs for submit from it, not from an earlier one.${
    remade ? ` Your worktree was reclaimed while the run was halted and has been made again, its setup hook run again: anything you left uncommitted in it is gone, and it is no longer on the ref you were on, so switch back to your work's ref first.${baselineSection(remade)}` : ''
  }`

// The convention a result needs the operator by (ADR-0016): a non-empty
// `decisions_needed` array, its questions. Null for any other value.
export const decisionsNeeded = (v) => (v && typeof v === 'object' && Array.isArray(v.decisions_needed) && v.decisions_needed.length ? v.decisions_needed.map((q) => (typeof q === 'string' ? q : JSON.stringify(q))) : null)

// A needs-decision result is journaled and held, and its result.json set
// aside, so a resume that finds a result.json knows it for a new one.
export function setAside(resultPath) {
  try {
    if (existsSync(resultPath)) renameSync(resultPath, resultPath.replace(/\.json$/, '.needs-decision.json'))
  } catch {}
}

// Its node on an agent() call's lines, when it names one.
const nodeOf = (call) => (call.node ? { node: call.node } : {})

// Re-reads what submit recorded: the script is handed a value only if it is
// valid now, whatever the worker claimed when it settled.
export function readResult(resultPath, schema) {
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
// takenOver }) is called once, when the host creates the Run or hands it over.
// transcripts.size({ harness, sessionId, worktree }) measures a session's
// transcript (transcript.mjs), and transcripts.path(…) names it.
// nextN() is the run's next agent number, which a doctor is started under;
// doctorLaunch() the recover role's launch; history({ n, origin, title }) the
// patient's journal entries and runner log lines ({ entries, log }).
// mailHandled: the ids of the Run mailbox's messages an earlier runner of
// this run journaled, which this one acknowledges and never acts on again;
// mailPending: those it held, since no box had claimed their dispatch, as
// { id, type, dispatchId, outcome, subject, body }, held again here.
// outage: the run's session host outage (outage.mjs), which every host call already
// waits on: its lost() is taken off the watch's clocks, and a retry's backoff
// is waited as its sleep(), so no clock the runner keeps runs while the host is gone.
// Returns life(call), which resolves to the agent's value or null, and throws
// only if journal or out does. life.chain(call) resolves to the run's chain
// worktree, the host's chainWorktree answer, in the Run it ensures for call;
// chainBefore is the chain an earlier runner of the run journaled, as the
// journal folds it, { runId, worktree, baseline, leftovers }, which a chain the host hands back as it is still holds, and lends its baseline to an unmade one at the same path. life.doctors() resolves once every doctor
// still out has ended: a patient's agent() never waits on its doctor once its
// own result is in, so the runner awaits them before it ends.
export function agentLifecycle({
  host,
  clock,
  limits,
  out,
  stateDir,
  objective,
  journal,
  retainWorktree,
  onRun = /** @type {(run: { runId: string, terminal?: string, takenOver?: boolean }) => unknown} */ (() => {}),
  takeOver = null,
  transcripts = sessionTranscripts(),
  nextN,
  doctorLaunch = () => ({ harness: 'claude' }),
  history = () => ({ entries: [], log: [] }),
  mailHandled = [],
  mailPending = [],
  outage = { lost: () => 0, sleep: (ms) => clock.sleep(ms) },
  chainBefore = null,
}) {
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
  // patient, and fails no agent() call: the runner does not count it, and its
  // log line says its round is spent, naming the patient (patientTitle).
  // A call with a node (ADR-0016) is held rather than handed its null: the
  // runner halts the run on it, so its line says so.
  const failAgent = ({ key, n, title, node = null, patient = null, patientTitle = null }, { reason, retained = null, alsoRetained = [], attempts = 1, continuations = 0, run = null, workerOut = false, workerLeft = false }, { mark = '!!', said = '' } = {}) => {
    journal({ type: 'failed', key, n, ...(node && patient == null && { node }), title, reason, attempts, ...(patient != null && { patient }), ...(run && { run }), ...(continuations && { continuations }), ...(retained && { retained }), ...(workerOut && { workerOut }), ...(workerLeft && { workerLeft }) })
    for (const also of alsoRetained) journal({ type: 'retained', retained: also })
    out(patient != null ? `${mark} ${title}: ${reason}; its doctor round for ${patientTitle ?? `agent ${patient}`} is spent` : node ? `${mark} ${title}: ${reason}; its node ${node} is held and the run halts${said}` : `${mark} ${title}: ${reason}; agent() returns null${said}`)
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

  // The worktree a dead agent leaves, retained, or null. A doctor's never is:
  // it changes nothing, so its worktree holds no work, and it stays
  // reclaimable through the journal and the run view.
  const keep = ({ isolation, title, patient = null }, w) => (isolation === 'worktree' && w?.worktree && patient == null ? retainWorktree({ path: w.worktree, reason: `retained because its agent (${title}) died before reporting its path: it may hold the only copy of that agent's work` }) : null)

  // The worktrees a start that never started a worker made, retained: the
  // failed line carries the first; a `retained` line names each other one.
  const keepMade = ({ isolation, title, patient = null }, made) => {
    const [kept, ...more] = isolation === 'worktree' && patient == null ? made.map((path) => retainWorktree({ path, reason: `retained because it was created for ${title}, whose worker never started, so no agent ever reported it` })) : []
    return { retained: kept ?? null, alsoRetained: more }
  }

  // A session continued under a new dispatch runs in a new tab: its old pane
  // is gone, so nothing can settle the old dispatch.
  async function moveTo(title, w, next) {
    if (next.dispatchId !== w.dispatchId) {
      await quietly(title, 'stop its old worker', () => host.workerStop({ dispatch: w.dispatchId }))
      await quietly(title, 'title its new tab', () => host.terminalRename({ terminal: next.terminal, title }))
    }
    return { ...w, dispatchId: next.dispatchId, terminal: next.terminal, worktree: next.worktree ?? w.worktree }
  }

  // The Run mailbox a doctor reports over, and a patient's doctor rounds,
  // which its life() hands its failure to (doctor.mjs).
  const mailbox = runMailbox({ host, journal, out, handled: mailHandled, pending: mailPending })
  const doctors = doctorRounds({ limits, journal, out, life, failAgent, nextN, doctorLaunch, history, transcripts })

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
        await outage.sleep(waits[i - 1])
      }
    }
  }

  // Every agent's worker is dispatched into the one Run. Concurrent calls
  // share its creation, or its takeover, retries included; once it has failed
  // for good, the next call asks the host again. A takeover precedes every
  // worker-start, which the host refuses from any terminal but the Run's.
  function ensureRun(call) {
    const creating = (run ??= takeOver
      ? retrying(call, `${host.name} could not hand this run's Run ${takeOver} over to this runner`, () => host.runUse({ runId: takeOver }).then((r) => (onRun({ ...r, takenOver: true }), r)))
      : retrying(call, `${host.name} could not create this run's Run`, () => host.runCreate({ objective: objective() }).then((r) => (onRun(r), r))))
    return creating.catch((e) => {
      if (run === creating) run = null
      throw e
    })
  }

  // The board card of a worktree the runner created. Cosmetic: a failure is
  // a warning and the agent carries on.
  async function setStatus(call, worktree, status) {
    try {
      await host.worktreeStatus({ worktree, status })
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
  // each nudge, and moving() the worker moving again, past a nudge's echo,
  // once after each nudge; blocked(waiting) and unblocked() journal a wait on a human
  // beginning and ending, so the run view shows it while it lasts. mail(), a
  // doctor's, reads the Run mailbox at every look, and ends the watch with
  // what it returns: the doctor's worker_done, read before the host shows it.
  // held(), a doctor's or an attended agent's, is whether it needs you: while
  // it does, it waits on a human for as long as it takes, so no idle,
  // stillness or blocked limit counts against it; each counts afresh from its
  // next message. noted(note) journals the note its agent posts (#175) as it
  // changes, never movement, and needs(reason) its agent's own needs-you,
  // null once it clears: while set, it is held as above, as a doctor is.
  // told, { note, asked }, is what was last journaled of them, kept across
  // the watches of one call so a continuation journals neither again.
  // attended: an attended agent's session that exits is dead, to be
  // continued, since a held one is otherwise never read as dead, as is one
  // whose agent said it needs you. nudgeText:
  // what a nudge types, a doctor's its own, and owes what an idle death
  // says it went without, a doctor's its report.
  async function watch(
    w,
    {
      title,
      harness,
      sessionId,
      nudged,
      moving = () => {},
      blocked = /** @type {(waiting: string) => unknown} */ (() => {}),
      unblocked = () => {},
      noted = /** @type {(note: string | null) => unknown} */ (() => {}),
      needs = /** @type {(reason: string | null) => unknown} */ (() => {}),
      told = { note: null, asked: null },
      mail = null,
      held = () => false,
      attended = false,
      nudgeText = NUDGE,
      owes = 'submitting',
    },
  ) {
    const start = clock.now()
    let errors = 0
    let nudges = 0
    let graceFrom = start
    let stillFrom = start
    let lastNudgeAt = null
    let lastLookAt = start
    let stuckNudged = false
    // Nudged since it last moved: the run view shows it stuck until it moves.
    let stuck = false
    let blockedAt = null
    let size = null
    let busy = null
    // The run's time lost to host outages as of the last look: whatever it
    // has grown by since moves every clock of this watch on by as much, since
    // nothing of the worker could be seen meanwhile (ADR-0015).
    let lostAt = outage.lost()
    const skipOutages = () => {
      const gone = outage.lost() - lostAt
      if (!gone) return
      lostAt += gone
      graceFrom += gone
      stillFrom += gone
      lastLookAt += gone
      if (lastNudgeAt !== null) lastNudgeAt += gone
      if (blockedAt !== null) blockedAt += gone
    }

    async function nudge(why, attempt) {
      out(`>> ${title}: ${why}; nudging it`)
      lastNudgeAt = graceFrom = clock.now()
      stuck = true
      nudged(why, attempt)
      try {
        await host.terminalSend({ terminal: w.terminal, text: nudgeText })
      } catch (e) {
        out(`!! ${title}: the nudge did not reach it: ${e.message}`)
      }
    }

    for (; ; await clock.sleep(limits.pollMs)) {
      if (mail) {
        try {
          const ended = await mail()
          if (ended) return ended
        } catch (e) {
          out(`!! ${title}: could not read the Run's mailbox: ${e.message}`)
        }
      }
      let s
      let idle = null
      try {
        s = await host.workerShow({ dispatch: w.dispatchId })
        if (!s.settled && !s.gone && !s.waiting && !s.exited && w.terminal) {
          idle = await host.terminalIdle({ terminal: w.terminal, timeoutMs: limits.idleProbeMs })
        }
        errors = 0
      } catch (e) {
        if (++errors >= limits.watchErrors) return { dead: `${host.name} failed ${errors} times in a row watching it (${e.message})`, unseen: true }
        out(`!! ${title}: could not look at its worker: ${e.message}`)
        continue
      }
      skipOutages()
      // Read before a settle, so a note its agent posted just before
      // submitting is still journaled. The note first: a needs-you seen
      // beside a new note came after it, since a note clears needs-you.
      const nowNote = typeof s.note === 'string' && s.note ? s.note.slice(0, NOTE_MAX) : null
      if (nowNote !== told.note) {
        told.note = nowNote
        if (nowNote) out(`>> ${title} notes: ${nowNote}`)
        noted(nowNote)
      }
      const nowAsked = typeof s.needsYou === 'string' && s.needsYou ? s.needsYou : null
      if (nowAsked !== told.asked) {
        told.asked = nowAsked
        if (nowAsked) out(`!!!!!!!! ${title} NEEDS YOU in terminal ${w.terminal}: ${nowAsked}`)
        else out(`>> ${title}: no longer needs you`)
        needs(nowAsked)
      }
      const hold = held() || told.asked !== null
      if (s.settled) return { outcome: s.outcome }
      if (s.gone) return s.hostDied ? HOST_DIED : { dead: 'its terminal is gone', gone: true }

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
        if (stuck) {
          stuck = false
          moving()
        }
      }

      if (s.waiting) {
        if (blockedAt === null) {
          blockedAt = now
          out(`!!!!!!!! ${title} is BLOCKED ON A HUMAN. Answer it in terminal ${w.terminal}.`)
          out(`!!!!!!!! waiting on: ${s.waiting}`)
          if (!hold) out(`!!!!!!!! ${title}: if nobody answers within ${mins(limits.blockedFailMs)} minutes, it fails and is kept as it stands, and ${limits.doctorRounds ? 'a doctor diagnoses it while its agent() waits' : 'agent() returns null'}`)
          // Blocked is its state now, not stuck.
          stuck = false
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
      if (hold && (attended || told.asked !== null) && s.exited) return { dead: 'its session exited' }
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
        if (nudges >= limits.idleNudges) return { dead: `it ${how} without ${owes}, after ${nudges} nudges` }
        ++nudges
        await nudge(`it ${how} without ${owes} (nudge ${nudges} of ${limits.idleNudges})`, nudges)
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
  // to watch it again (live, settled, blocked, or one the host could not show,
  // which the watch gives up on as on any other), or the death to continue
  // its session from.
  async function lookBack(w) {
    let s
    try {
      s = await host.workerShow({ dispatch: w.dispatchId })
    } catch {
      return null
    }
    if (s.settled || s.waiting) return null
    if (s.gone) return s.hostDied ? HOST_DIED : { dead: 'its terminal closed while no runner was watching it', gone: true }
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

  // The prompt worker-start typed must reach the session. A dialog the TUI
  // opens on launch, such as Claude's "New MCP server found in this project"
  // (mcp-answers.mjs), passes the host's idle wait and eats worker-start's
  // Enter, leaving the prompt unsent in the input box, or gone: the worker
  // then idles until a nudge. So once worker-start returns, the prompt (`sent`)
  // must show as a user message in the session within promptDeliveryMs.
  // Missing, the runner presses Enter; still missing, it empties the input
  // (Ctrl-U, which can neither exit Claude nor interrupt it) and types the
  // prompt again; still missing, the start fails with the terminal's last
  // lines, stops its worker and closes its tab, and is retried like any failed
  // start. pi is not checked: it writes its transcript only at its first
  // assistant message, so a prompt it took would not show within the wait, and
  // an adapter with no promptDelivered checks nothing.
  async function deliver({ title, isolation, launch }, w, sessionId, sent) {
    if (launch.harness !== 'claude' || !host.promptDelivered || !sent) return
    const ms = limits.promptDeliveryMs
    const step = Math.max(1, Math.round(ms / 10))
    const arrives = () => awaitDelivered({ harness: launch.harness, sessionId, worktree: w.worktree ?? null, needle: needleOf(sent) }, clock.now() + ms, step)
    try {
      if (await arrives()) return
      out(`!! ${title}: its prompt is not in its session ${wait(ms)} after worker-start; pressing Enter in its terminal ${w.terminal}`)
      await host.terminalEnter({ terminal: w.terminal })
      if (await arrives()) return void out(`>> ${title}: its prompt reached its session after the Enter`)
      out(`!! ${title}: its prompt is still not in its session; emptying its input and typing the prompt again`)
      const text = resendPrompt(w, sent)
      await host.terminalClearInput({ terminal: w.terminal, lines: text.split('\n').length + PREAMBLE_LINES })
      await host.terminalSend({ terminal: w.terminal, text })
      if (await arrives()) return void out(`>> ${title}: its prompt reached its session when typed again`)
      const screen = await host.terminalScreen({ terminal: w.terminal, lines: 15 }).catch((e) => [`(its screen could not be read: ${e?.message ?? e})`])
      throw new Error(`its prompt never reached its session, after an Enter and a second typing; its terminal's last lines:\n${screen.join('\n')}`)
    } catch (e) {
      await quietly(title, 'stop the worker its prompt never reached', () => host.workerStop({ dispatch: w.dispatchId }))
      await quietly(title, 'close its tab', () => host.terminalClose({ terminal: w.terminal }))
      throw Object.assign(e instanceof Object ? e : new Error(String(e)), { dispatched: true, ...(isolation === 'worktree' && w.worktree && { worktree: w.worktree }) })
    }
  }

  // What a host that can see its harness's screen calls while the worker's
  // prompt waits on a dialog only the person can answer (the crew host's
  // ready): its row needs you, entered at `terminal`, until the dialog is
  // gone, `null`, and the prompt goes in.
  const asking =
    ({ key, n, title }) =>
    (seen) => {
      if (!seen) return void journal({ type: 'dialogClosed', key, n, title })
      out(`?? ${title}: ${seen.ask}${seen.detail ? ` (its screen: ${seen.detail})` : ''}: crew session ${seen.terminal}`)
      journal({ type: 'dialog', key, n, title, terminal: seen.terminal, dialog: seen.dialog, ask: seen.ask })
    }

  // Starts the call's worker, retried as the settings table says. Once it
  // has failed for good, the call's null, or, for an agent() call, its
  // patient's failure, handed to its doctors. again: a doctor's remedy, the
  // start retried with its `note`, carrying on from the `made`, `dispatched`
  // and `baseline` the spent start left, so its first attempt is a retry.
  async function start(runId, call, again = null) {
    const { prompt, isolation, launch, key, n, title, phaseName, dir, schemaPath, resultPath, payloadPath, patient = null, setup = null } = call
    // The child worktrees failed attempts left. Every attempt of a call asks
    // for the same `<runId>-<n>` name, so a retry takes that one up again;
    // one the host made under a suffixed name leaves both it and that one.
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
    // The chain worktree a chained call starts in: what its failure names
    // as its worktree, never one it made, so never kept or retained.
    let chainPath = null
    try {
      ;({ w, sessionId } = await retrying(call, 'its worker did not start', async (attempt) => {
        // Assigned, not discovered: the harness is started with it (decision
        // D2 on #43). A new one per attempt: a failed attempt's harness may
        // already have taken the last one.
        const sessionId = randomUUID()
        attempts = attempt
        // The text worker-start sends as its spec, which the delivery check
        // looks for in the session.
        let sent = prompt
        try {
          // A chained call (ADR-0020) makes no worktree: it starts in the
          // run's chain worktree, whose setup leftovers its agent is told of
          // as a child's. A doctor's call is never chained: it keeps a
          // `<runId>-<n>` of its own.
          const chain = isolation === 'chain' ? await life.chain(call) : null
          chainPath = chain?.path ?? null
          const w = await host.workerStart({
            run: runId,
            asking: asking(call),
            prompt:
              patient != null
                ? prompt
                : (baseline) => (sent = workerPrompt(prompt, { schema: call.schema ?? null, schemaPath, resultPath, payloadPath, baseline: baseline ?? (chain ? (chainState?.baseline ?? null) : null), leftovers: chain ? (chainState?.leftovers ?? []) : [], note: again?.note ?? null, attended: call.attended ?? null })),
            title,
            ...launch,
            ...agentOf(call),
            sessionId,
            ...(chain && { chain: chain.path }),
            child: isolation === 'worktree' ? { name: agentId(runId, call.origin ?? n), displayName: title, retry: attempt > 1 || !!again, dispatched, baseline, onBaseline, ...(setup && { setup }) } : null,
          })
          // Logged at once: a start that then fails its delivery check made them too.
          for (const why of w.warnings ?? []) warn(call, why)
          await deliver(call, w, sessionId, sent)
          return { w, sessionId }
        } catch (e) {
          for (const path of [e?.worktree, ...(Array.isArray(e?.worktrees) ? e.worktrees : [])]) if (path) made.add(path)
          if (e?.dispatched) dispatched = true
          throw e
        }
      }))
    } catch (e) {
      // A worktree the host made before the start failed is named like a dead
      // agent's: the runner never removes one. A patient's are retained only
      // once its doctor rounds end in null.
      const retainMade = () => keepMade(call, [...made])
      const failure = { reason: e.reason, attempts: e.attempts, run: runId }
      if (patient == null) {
        return { [SICK]: { ...failure, harness: launch.harness, sessionId: null, worktree: failureWorktree(call, null, [...made], chainPath), keep: retainMade, restart: { made: [...made], dispatched, baseline } } }
      }
      return failAgent(call, { ...failure, ...retainMade() })
    }
    journal({ type: 'started', key, n, ...nodeOf(call), title, run: runId, dispatchId: w.dispatchId, harness: launch.harness, sessionId, worktree: w.worktree ?? null, terminal: w.terminal, dir, ...(call.origin != null && { origin: call.origin }), ...(call.attended && { attended: call.attended }) })
    if (isolation === 'worktree' && w.worktree) await setStatus(call, w.worktree, phaseName === 'Gate' ? 'in-review' : 'in-progress')
    const on = [launch.harness, launch.model, launch.effort && `${launch.effort} effort`, launch.permissionMode && `${launch.permissionMode} mode`].filter(Boolean).join(', ')
    out(`>> ${title}: started on ${on} as dispatch ${w.dispatchId}, session ${sessionId}, in terminal ${w.terminal}${w.worktree ? ` in ${w.worktree}` : ''}`)
    if (call.attended) out(`!!!!!!!! ${title} NEEDS YOU in terminal ${w.terminal}: ${call.attended}`)
    // The agent titles its own tab and drops --task-title (ADR-0011), so the
    // tab is renamed to the title the operator finds it by.
    try {
      await host.terminalRename({ terminal: w.terminal, title })
    } catch (e) {
      out(`!! ${title}: could not title its tab: ${e.message}`)
    }
    return { w, sessionId, attempts, continued: 0, end: null }
  }

  // call.from: a patient carried on by its doctor's remedy, once it holds a
  // live slot again, so a live worker is always a watched one inside the cap:
  // { carry }, its session continued with the note (carryOn), or { restart },
  // the start of a patient whose worker never started, retried with the note.
  // call.box: a doctor's mailbox, which take() fills from its messages.
  // call.startAgain: a doctor whose worker never launched before its runner
  // died, started afresh under its own n: { made, dispatched, baseline }, as
  // start's `again`, so it takes up the `<runId>-<n>` worktree an earlier
  // attempt of its start made rather than orphan it.
  async function supervise(runId, call) {
    const { schema, isolation, launch, key, n, title, resultPath, patient = null, box = null } = call
    if (launch.harness === 'claude' && !launch.permissionMode && !toldNoMode) {
      toldNoMode = true
      out("!! no --permission-mode given: Claude workers start in Claude's own default permission mode, not in the orchestrator's.")
    }
    const { from = null } = call
    const got = from?.restart ? await start(runId, call, from.restart) : from?.carry ? await carryOn(call, from.carry) : call.halted ? await carryHalted(runId, call) : call.adopt ? await takeUp(call) : await start(runId, call, call.startAgain ?? null)
    if (!got || got[SICK]) return got
    const { sessionId, attempts } = got
    let { w, end = null, continued } = got
    const post = () => {
      if (box) box.terminal = w.terminal
      mailbox.claim(w.dispatchId, box)
    }
    post()
    const mail = box ? mailbox.ends(box) : null

    let delivered = false
    const told = { note: null, asked: null }
    // A patient handed to its doctors: its worktree is retained only if
    // their rounds end in null.
    let sick = false
    let kept = null
    const retain = () => (kept ??= keep(call, w))
    try {
      for (;;) {
        end ??= await watch(w, {
          title,
          harness: launch.harness,
          sessionId,
          nudged: (reason, attempt) => journal({ type: 'nudge', key, n, title, dispatchId: w.dispatchId, reason, attempt }),
          moving: () => journal({ type: 'moving', key, n, title, dispatchId: w.dispatchId }),
          blocked: (waiting) => journal({ type: 'blocked', key, n, title, dispatchId: w.dispatchId, terminal: w.terminal, waiting: String(waiting) }),
          unblocked: () => journal({ type: 'unblocked', key, n, title, dispatchId: w.dispatchId }),
          noted: (note) => journal({ type: 'note', key, n, title, dispatchId: w.dispatchId, note }),
          needs: (reason) => journal(reason === null ? { type: 'needsYouCleared', key, n, title, dispatchId: w.dispatchId } : { type: 'needsYou', key, n, title, dispatchId: w.dispatchId, terminal: w.terminal, reason }),
          told,
          mail,
          held: () => !!call.attended || box?.needsYou != null,
          attended: !!call.attended,
          nudgeText: patient != null ? DOCTOR_NUDGE : NUDGE,
          owes: patient != null ? 'reporting' : 'submitting',
        })
        // A dead session is continued in its own session (ADR-0013), unless
        // it waits on a human, the host cannot see it, or it already submitted.
        if (!end.dead || end.blocked || end.unseen || existsSync(resultPath)) break
        // A session that died with its host is no death of the agent's, and
        // spends none of its continuations (#104).
        if (!end.hostDied && continued >= limits.maxContinuations) {
          end = { ...end, dead: `${end.dead}, and its session was already continued ${continued} times, the cap of ${limits.maxContinuations}`, capped: true }
          break
        }
        const attempt = end.hostDied ? continued : ++continued
        const reopen = !!end.gone
        out(`>> ${title}: ${end.dead}; continuing session ${sessionId} (${end.hostDied ? 'not counted against the cap' : `continuation ${attempt} of ${limits.maxContinuations}`}) ${reopen ? `in a new terminal in ${w.worktree ?? 'its worktree'}` : `in terminal ${w.terminal}`}`)
        let next
        try {
          next = await host.workerContinue({ run: runId, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title, prompt: (patient != null ? doctorContinuePrompt : continuePrompt)(end.dead), ...launch, ...agentOf(call), sessionId, reopen, asking: asking(call) })
        } catch (e) {
          end = { dead: `${end.dead}, and continuing its session failed: ${e?.message ?? e}` }
          break
        }
        journal({ type: 'continued', key, n, title, dispatchId: next.dispatchId, sessionId, terminal: next.terminal, reason: end.dead, attempt, reopened: next.dispatchId !== w.dispatchId, ...(end.hostDied && { hostDied: true }) })
        w = await moveTo(title, w, next)
        post()
        end = null
      }
      // A doctor's last messages can land after its worker settled or died.
      if (box) await mailbox.read().catch((e) => out(`!! ${title}: could not read the Run's mailbox: ${e.message}`))
      // A doctor submits nothing: its worker_done, or its worker settling, is
      // its end. One that gave up (worker_done --outcome failed) says why.
      if (patient != null && !end.dead) {
        const gaveUp = end.outcome === 'failed' ? { reason: box?.gaveUp != null ? `it gave up: ${box.gaveUp}` : 'its worker settled failed' } : {}
        journal({ type: 'settled', key, n, title, dispatchId: w.dispatchId, outcome: end.outcome ?? null, ...gaveUp })
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
      if (end.dead && !kept) await quietly(title, 'stop its worker', () => host.workerStop({ dispatch: w.dispatchId }))
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
          return { [SICK]: { ...failure, harness: launch.harness, sessionId, worktree: failureWorktree(call, w), w, gone: !!end.gone, keep: () => ({ retained: keep(call, w) }) } }
        }
        return failAgent(call, { ...failure, retained: retain() })
      }
      // A node's result that needs the operator is held by the runner (ADR-0016).
      const questions = call.node ? decisionsNeeded(result.value) : null
      if (questions) setAside(resultPath)
      journal({ type: 'result', key, n, ...nodeOf(call), title, result: result.value, ...(questions && { needsDecision: true }) })
      out(questions ? `?? ${title}: result received; it needs decisions only the operator can make: ${questions.join(' · ')}` : `<< ${title}: result received`)
      delivered = true
      if (isolation === 'worktree' && w.worktree && published(result.value)) await setStatus(call, w.worktree, 'completed')
      // Before agent() returns, so before the script can start the next agent.
      if (isolation === 'chain' && patient == null) await leftoverCheck(call, w, sessionId, { stopped: !!end.dead })
      return result.value
    } finally {
      if (!delivered && !sick) retain()
    }
  }

  // call: { prompt, schema, isolation ('none' | 'worktree' | 'chain'), launch, key, n, label, title, phaseName },
  // and on a resume `adopt`, the worker the last run left out for it, as the
  // journal's fold names it: { dir, run, dispatchId, harness, sessionId,
  // terminal, worktree, continuations, origin }. A doctor's call also has
  // `patient`, its patient's origin, `round`, and `setup: 'skip'`, and key null:
  // it is no agent() call, so a resume replays nothing from it. A patient's
  // call on a resume has `rounds`, its doctor rounds so far, and, while its
  // agent() waited on them, `held`, where they stood, and `origin`, its
  // agent's (both as the journal's fold names them): it is not supervised
  // again, but goes on with its round. An agent() call that names its node
  // has `node`, journaled on its lines; one the run halted on and a resume
  // carries on has `adopt`, the worker it last ran, and `halted`, {
  // needsDecision }: its session is continued (carryHalted), not taken up.
  async function life(call) {
    const { schema, key, n, label, title, adopt, held = null } = call
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
        type: 'reattached',
        key,
        n,
        ...nodeOf(call),
        title,
        run: adopt.run ?? takeOver,
        dispatchId: adopt.dispatchId,
        harness: adopt.harness ?? call.launch?.harness ?? null,
        sessionId: adopt.sessionId,
        terminal: adopt.terminal,
        worktree: adopt.worktree,
        dir: rel,
        origin: adopt.origin ?? n,
        ...(adopt.continuations && { continuations: adopt.continuations }),
        ...(call.patient != null && { patient: call.patient, round: call.round }),
        ...(call.box?.needsYou != null && { needsYou: call.box.needsYou }),
        ...(call.attended && { attended: call.attended }),
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

    // Like a worker that cannot start, a Run the host cannot create is this
    // agent's null, never a throw; the next agent() asks the host again.
    let runId
    try {
      ;({ runId } = await ensureRun(call))
    } catch (e) {
      if (adopt) {
        // Its worker is still out: the call stays unsettled for the next
        // resume, which takes that worker up, and its worktree is named.
        const kept = call.isolation === 'worktree' && adopt.worktree && call.patient == null ? retainWorktree({ path: adopt.worktree, reason: `retained because its agent (${title}) was still at work when this runner could not take its Run over, so it never reported — the next resume takes that agent up again` }) : null
        return failAgent(call, { reason: e.reason, retained: kept, attempts: e.attempts, continuations: adopt.continuations, run: adopt.run ?? takeOver, workerOut: true }, { mark: '!!!!!!!!', said: `, its worker ${adopt.dispatchId} is left out for the next resume to take up, and the next agent() asks again` })
      }
      return failAgent(call, { reason: e.reason, attempts: e.attempts }, { mark: '!!!!!!!!', said: ', and the next agent() asks again' })
    }
    // Held until the worker settles or is stopped. It is never released during
    // the run, so its tab stays open, but a settled worker no longer works.
    // Journaled so the run view can show a call that waits here: nothing
    // else about it is written until its worker starts.
    // A patient's doctor rounds so far (doctor.mjs). A doctor whose note
    // carried it on goes on in the background: its agent() returns once its
    // own result is in.
    const rounds = doctors.roundsOf(call)
    let from = null
    let got
    let failure = held ? await heldFailure(call, runId) : null
    let again = held?.open ? held : null
    for (;;) {
      if (!failure) {
        await live.acquire(() => {
          out(`.. ${title}: queued, ${limits.MAX_LIVE} agents are live`)
          journal({ type: 'queued', key: call.key, n, title })
        })
        // Its row from here on: nothing else is journaled until its worker starts,
        // or its first attempt fails. A worker taken up is journaled already.
        if (!adopt && !from) journal({ type: 'starting', key: call.key, n, ...nodeOf(call), title, run: runId })
        try {
          got = await supervise(runId, { ...call, dir: rel, schemaPath, resultPath, payloadPath, from })
        } finally {
          live.release()
        }
        // Its slot is freed first: a doctor needs one, and one held by a patient
        // that waits on its own doctor would starve the run, or deadlock it at a
        // cap of one. A remedy carries it on only once it holds a slot again,
        // at the top of this loop: supervise applies it.
        if (!got?.[SICK]) break
        failure = got[SICK]
      }
      from = await doctors.treat(call, failure, rounds, again)
      failure = again = null
      if (!from) {
        got = null
        break
      }
    }
    return got
  }

  // A held patient's failure, as supervise or start hands a patient to its
  // doctors, rebuilt from what the journal kept: its worker, still out and
  // kept, or, for one whose worker never started, the worktree its start left.
  async function heldFailure(call, runId) {
    const { adopt, held, isolation, launch } = call
    if (!adopt) {
      const made = held.restart?.made ?? []
      // A chained patient made none: it was to start in the run's chain, as
      // journaled; never asked of the host, which may make it again.
      const chainPath = isolation === 'chain' ? (chainState?.worktree ?? null) : null
      // Its worker may have run in that worktree before its start failed: a
      // retry judges it against its baseline.
      return {
        reason: held.reason,
        attempts: 0,
        run: runId,
        harness: launch.harness,
        sessionId: null,
        worktree: failureWorktree(call, null, made, chainPath),
        keep: () => keepMade(call, made),
        restart: { made, dispatched: true, baseline: held.restart?.baseline ?? null },
      }
    }
    const w = { dispatchId: adopt.dispatchId, terminal: adopt.terminal, worktree: adopt.worktree }
    const end = await lookBack(w)
    return {
      reason: held.reason,
      attempts: 0,
      continuations: adopt.continuations,
      run: adopt.run ?? runId,
      workerLeft: true,
      harness: adopt.harness ?? launch.harness,
      sessionId: adopt.sessionId,
      worktree: failureWorktree(call, w),
      w,
      gone: !!end?.gone,
      keep: () => ({ retained: keep(call, w) }),
    }
  }

  // A node the run halted on, resumed (ADR-0016): its session continued in its
  // own worktree, in its own tab, or in a new one there once that is gone, with
  // haltedPrompt, then watched as any worker, its continuations counted
  // afresh. call.adopt is the worker it last ran; call.halted { needsDecision }.
  async function carryHalted(runId, call) {
    const { key, n, title, launch, adopt, halted, isolation } = call
    // A chained node (ADR-0020) carries on in the run's chain worktree, asked
    // of the host afresh: the operator may have reclaimed it while the run
    // was halted, and then the host makes it again.
    let chain = null
    if (isolation === 'chain') {
      try {
        chain = await life.chain(call, { recheck: true })
      } catch (e) {
        return failAgent(call, { reason: `resuming it needs the run's chain worktree, which could not be made again: ${e?.message ?? e}`, attempts: 0, run: runId })
      }
    }
    const w = { dispatchId: adopt.dispatchId, terminal: adopt.terminal, worktree: chain?.path ?? adopt.worktree }
    // A dispatch that settled cannot be watched again: its session is
    // continued under a new one, in a new tab, its old tab closed first so no
    // second process holds the session. One kept running (blocked, or past its
    // cap) is interrupted and continued in its own tab.
    let gone = true
    try {
      const s = await host.workerShow({ dispatch: w.dispatchId })
      if (s.settled && !s.gone) await quietly(title, 'close its settled tab', () => host.terminalClose({ terminal: w.terminal }))
      gone = !!(s.gone || s.settled)
    } catch {}
    out(`>> ${title}: resuming node ${call.node}: continuing session ${adopt.sessionId} ${gone ? `in a new terminal in ${w.worktree ?? 'its worktree'}` : `in terminal ${w.terminal}`}`)
    let next
    try {
      next = await host.workerContinue({
        run: runId,
        dispatch: w.dispatchId,
        terminal: w.terminal,
        worktree: w.worktree,
        title,
        prompt: haltedPrompt(!!halted.needsDecision, chain?.made ? (chain.baseline ?? []) : null, !!call.attended),
        ...launch,
        ...agentOf(call),
        sessionId: adopt.sessionId,
        reopen: gone || !!chain?.made,
        asking: asking(call),
      })
    } catch (e) {
      return failAgent(call, { reason: `resuming its session failed: ${e?.message ?? e}`, attempts: 0, run: runId, retained: keep(call, w) })
    }
    journal({ type: 'continued', key, n, ...nodeOf(call), title, dispatchId: next.dispatchId, sessionId: adopt.sessionId, terminal: next.terminal, reason: 'the run was resumed', attempt: 0, reopened: next.dispatchId !== w.dispatchId, ...(call.attended && { attended: call.attended }) })
    return { w: await moveTo(title, w, next), sessionId: adopt.sessionId, attempts: 0, continued: 0 }
  }

  // A remedy's continuation, applied once the patient holds its live slot:
  // what supervise watches, or null once a continuation that failed has
  // failed the call.
  async function carryOn(call, { failure, round, doctor, messageId, note }) {
    const { key, n, title, launch } = call
    const origin = call.adopt?.origin ?? call.origin ?? n
    const { w, sessionId } = failure
    out(`>> ${title}: doctor round ${round} handed off a note; continuing session ${sessionId} with it ${failure.gone ? `in a new terminal in ${w.worktree ?? 'its worktree'}` : `in terminal ${w.terminal}`}`)
    let next
    try {
      next = await host.workerContinue({ run: failure.run, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title, prompt: notePrompt(note), ...launch, ...agentOf(call), sessionId, reopen: failure.gone, asking: asking(call) })
    } catch (e) {
      return failAgent(call, { ...failure, reason: `${failure.reason}, and continuing its session with its doctor's note failed: ${e?.message ?? e}`, retained: keep(call, w) })
    }
    journal({ type: 'remedy', key, n, title, origin, round, doctor, how: 'continue', messageId, dispatchId: next.dispatchId, terminal: next.terminal, reopened: next.dispatchId !== w.dispatchId })
    return { w: await moveTo(title, w, next), sessionId, attempts: failure.attempts, continued: 0 }
  }

  // The run's chain worktree (ADR-0020), asked of the host once per runner
  // however many calls ask at once, and journaled whenever the host made it,
  // with its baseline or none; one that failed is asked for again by the
  // next call, and so is any with `recheck`, which a halted node carries on
  // in. One the host hands back unmade has the baseline journaled when it was made.
  let chain = null
  // The chain as the journal folds it, { runId, worktree, baseline,
  // leftovers }: what it holds that no agent starting in it owns, its
  // baseline and every file an agent before left there past its follow-up.
  let chainState = chainBefore
  life.chain = (call, { recheck = false } = {}) => {
    if (recheck) chain = null
    const making = (chain ??= ensureRun(call)
      .then(async ({ runId }) => ({ runId, c: await host.chainWorktree({ runId }) }))
      .then(({ runId, c }) => {
        for (const why of c.warnings ?? []) warn(call, why)
        if (c.made) {
          chainState = { runId, worktree: c.path, baseline: c.baseline, leftovers: [] }
          journal(chainEntry(chainState))
          if (!c.baseline) warn(call, 'the chain worktree was made with no baseline, its setup maybe still running, so no chain agent is checked for leftovers')
        }
        return c.made || c.baseline ? c : { ...c, baseline: chainState?.worktree === c.path ? chainState.baseline : null }
      }))
    return making.catch((e) => {
      if (chain === making) chain = null
      throw e
    })
  }

  // The leftover check (#127): a chain agent that returned leaving files
  // uncommitted beyond what it was told was there is sent back once, in its
  // own session, to commit or remove them; whatever is still there is logged,
  // and told to every later chain agent as files never to commit. A worker
  // the runner stopped (it died after submitting) is past any follow-up.
  async function leftoverCheck(call, w, sessionId, { stopped }) {
    const { key, n, title } = call
    const worktree = w.worktree
    // With no baseline an agent's leftovers cannot be told from its setup's.
    if (!worktree || !chainState?.baseline) return
    const extra = async () => extraLines(await host.worktreeLines({ worktree }), [...chainState.baseline, ...chainState.leftovers])
    let left
    try {
      left = await extra()
    } catch (e) {
      return warn(call, `could not read the chain worktree's status for leftovers: ${e?.message ?? e}`)
    }
    if (!left.length) return
    if (!stopped) {
      journal({ type: 'followUp', key, n, title, worktree, lines: left })
      out(`>> ${title}: it left ${fileNames(left)} uncommitted in the chain worktree; asking it once to commit or remove them`)
      try {
        // One still busy is stopped: the next chain agent starts in its worktree.
        if (!(await followUp(call, w, sessionId, leftoverPrompt(left)))) {
          out(`!! ${title}: still busy with its follow-up after ${mins(limits.followUpMs)} minutes; stopping it, and reading its leftovers as they stand`)
          await host.workerStop({ dispatch: w.dispatchId })
        }
        left = await extra()
      } catch (e) {
        out(`!! ${title}: its follow-up did not run: ${e?.message ?? e}`)
      }
      if (!left.length) return void out(`>> ${title}: the chain worktree is clean after its follow-up`)
    }
    journal({ type: 'leftover', key, n, title, worktree, lines: left })
    out(`!! ${title}: left ${fileNames(left)} uncommitted in the chain worktree${stopped ? '' : ' after its follow-up'}; every later chain agent is told never to commit them`)
    chainState = { ...chainState, leftovers: unionLines(chainState.leftovers, left) }
  }

  // Types `text` into a returned worker's session and waits, up to
  // followUpMs, for the turn it starts to end: true once it has. The worker's
  // dispatch is settled already, so only its terminal and transcript say.
  async function followUp({ launch }, w, sessionId, text) {
    await host.terminalSend({ terminal: w.terminal, text })
    const until = clock.now() + limits.followUpMs
    // An idle look before the text has turned the session busy is the turn before.
    if (launch.harness === 'claude' && host.promptDelivered) {
      if (!(await awaitDelivered({ harness: launch.harness, sessionId, worktree: w.worktree ?? null, needle: needleOf(text) }, until, limits.pollMs))) return false
    } else await outage.sleep(limits.nudgeEchoMs)
    return awaitQuietTurn(w, launch.harness, sessionId, until)
  }

  // Polls the session every `step` for the prompt `q` names: true once it
  // shows as a user message there, false once the clock passes `until`.
  async function awaitDelivered(q, until, step) {
    for (;;) {
      if (await host.promptDelivered(q)) return true
      if (clock.now() >= until) return false
      await outage.sleep(step)
    }
  }

  // Waits for a returned worker's turn to end: true once its terminal is
  // idle and its transcript did not grow since the last look, or its worker
  // is gone; false once the clock passes `until`.
  async function awaitQuietTurn(w, harness, sessionId, until) {
    let size = measure(w, harness, sessionId)
    for (;;) {
      const s = await host.workerShow({ dispatch: w.dispatchId })
      if (s.gone || s.exited) return true
      const idle = await host.terminalIdle({ terminal: w.terminal, timeoutMs: limits.idleProbeMs })
      const now = measure(w, harness, sessionId)
      if (idle && now === size) return true
      size = now
      if (clock.now() >= until) return false
      await outage.sleep(limits.pollMs)
    }
  }

  life.doctors = doctors.settled
  return life
}
