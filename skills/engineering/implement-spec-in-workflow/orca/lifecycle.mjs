// One agent's life under the Orca runner: its files, the run's Run, a live
// slot, its worker's start, the watch until it settles or dies (its session
// nudged and continued on the way), its result, and
// what the journal, the board and the retained list learn from it. runner.mjs
// decides which calls reach here (replay does not) and names each one.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { validate } from './schema.mjs'
import { sessionTranscripts } from './transcript.mjs'

export const SUBMIT = fileURLToPath(new URL('./submit.mjs', import.meta.url))

export function workerPrompt(prompt, { schemaPath, resultPath, payloadPath }) {
  const what = schemaPath
    ? `Write your result to ${payloadPath} as one JSON object that matches the JSON Schema in ${schemaPath}.`
    : `Write your answer to ${payloadPath} as plain text.`
  const command = [`node "${SUBMIT}"`, schemaPath && `--schema "${schemaPath}"`, `--result "${resultPath}"`, `--payload "${payloadPath}"`,
    '--from <worker_handle> --dispatch-capability <capability> --task-id <task_id> --dispatch-id <dispatch_id>'].filter(Boolean).join(' ')
  return `${prompt}

---
How this run receives your result: your final message is not read. Your result reaches the workflow only through the submit command below, and submit sends your worker_done for you — never send worker_done yourself.
1. ${what}
2. Run this, replacing the four <placeholders> with the values from your Orca preamble, copied exactly:
   ${command}
3. If submit exits non-zero it prints every error: fix the payload and run it again until it exits 0. Then stop and idle.`
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
const mins = (ms) => Math.round(ms / 60_000)
const wait = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 6_000) / 10} min`)

const NUDGE = 'The workflow has not received your result: your final message is not read. Finish the task, then run the submit command from your instructions until it exits 0.'

// Typed after the resume, or handed as the spec of the dispatch that adopts a
// new terminal, whose preamble then carries new IDs.
const continuePrompt = (why) => `You were interrupted: the workflow runner stopped this session and resumed it (${why}). Carry on where you left off and finish the task, then run the submit command from your instructions until it exits 0. If an Orca preamble came with this message, take the four IDs for submit from it, not from an earlier one.`

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
// declared its meta. journal(entry) appends one journal line; keep({path,
// reason}) retains a worktree and returns the entry the list holds for it.
// onRun({ runId, terminal }) is called once, when Orca creates the Run.
// transcripts.size({ harness, sessionId, worktree }) measures a session's
// transcript (transcript.mjs). Returns life(call), which resolves to the
// agent's value or null, and throws only if journal or out does.
export function agentLifecycle({ orca, clock, limits, out, stateDir, objective, journal, keep, onRun = () => {}, transcripts = sessionTranscripts() }) {
  const live = slots(limits.MAX_LIVE)
  // One Run per workflow run: every agent's worker is dispatched into it.
  let run = null
  let toldNoMode = false

  // Every way a call ends in null journals one of these. attempts counts the
  // starts, or Run creations, it made; one that started a worker made one more
  // start than it retried. continuations counts how often a started worker's
  // session was continued; a continuation carries on that attempt's session.
  const fail = ({ key, n, title }, reason, retained, attempts = 1, continuations = 0) =>
    journal({ type: 'failed', key, n, title, reason, attempts, ...(continuations && { continuations }), ...(retained && { retained }) })

  // Something that went wrong without failing the agent: logged and
  // journaled, never swallowed.
  const warn = ({ key, n, title }, reason) => {
    out(`!! ${title}: ${reason}`)
    journal({ type: 'warning', key, n, title, reason })
  }

  // Runs attempt(1), attempt(2)… until one returns, one throws an error
  // marked `final`, or the settings table's backoff is spent. The last error
  // is thrown carrying `reason` (what failed, and why) and `attempts`. Each
  // new attempt is journaled as retry, with why the one before it failed.
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
        await clock.sleep(waits[i - 1])
        journal({ type: 'retry', key, n, title, attempt: i + 1, reason: e.reason })
      }
    }
  }

  // Every agent's worker is dispatched into the one Run. Concurrent calls
  // share its creation, retries included; once it has failed for good, the
  // next call asks Orca again.
  function ensureRun(call) {
    const creating = (run ??= retrying(call, "Orca could not create this run's Run", () => orca.runCreate({ objective: objective() }).then((r) => (onRun(r), r))))
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
  // each nudge.
  async function watch(w, { title, harness, sessionId, nudged }) {
    const start = clock.now()
    let errors = 0
    let nudges = 0
    let graceFrom = start
    let stillFrom = start
    let lastNudgeAt = null
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
      // session that is hung: that is the nudge, not the worker.
      const echo = lastNudgeAt !== null && now - lastNudgeAt <= limits.nudgeEchoMs
      if (moved && !echo) {
        stillFrom = now
        stuckNudged = false
      }

      if (s.waiting) {
        if (blockedAt === null) {
          blockedAt = now
          out(`!!!!!!!! ${title} is BLOCKED ON A HUMAN. Answer it in terminal ${w.terminal}.`)
          out(`!!!!!!!! waiting on: ${s.waiting}`)
          out(`!!!!!!!! if nobody answers within ${mins(limits.blockedFailMs)} minutes, it fails, is kept as it stands, and agent() returns null`)
        }
        if (now - blockedAt >= limits.blockedFailMs) return { dead: `blocked on a human, unanswered for ${mins(now - blockedAt)} minutes`, blocked: true }
        continue
      }
      if (blockedAt !== null) {
        out(`>> ${title}: no longer blocked`)
        blockedAt = null
        stillFrom = graceFrom = now
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

  async function supervise(runId, call) {
    const { prompt, schema, isolated, launch, key, n, title, phaseName, schemaPath, resultPath, payloadPath } = call
    if (launch.harness === 'claude' && !launch.permissionMode && !toldNoMode) {
      toldNoMode = true
      out("!! no --permission-mode given: Claude workers start in Claude's own default permission mode, not in the orchestrator's.")
    }
    // The child worktrees failed attempts left. Every attempt of a call asks
    // for the same `<runId>-<n>` name, so a retry takes that one up again;
    // one Orca made under a suffixed name leaves both it and that one.
    const made = new Set()
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
            prompt: workerPrompt(prompt, { schemaPath, resultPath, payloadPath }),
            title,
            ...launch,
            sessionId,
            child: isolated ? { name: `${runId}-${n}`, displayName: title, retry: attempt > 1 } : null,
          })
          return { w, sessionId }
        } catch (e) {
          for (const path of [e?.worktree, ...(Array.isArray(e?.worktrees) ? e.worktrees : [])]) if (path) made.add(path)
          throw e
        }
      }))
    } catch (e) {
      out(`!! ${title}: ${e.reason}; agent() returns null`)
      // A worktree Orca made before the start failed is named like a dead
      // agent's: the runner never removes one. The failed line carries the
      // first; a `retained` line names each other one.
      const [kept, ...more] = isolated ? [...made].map((path) => keep({ path, reason: `not in the ledger: created for ${title}, whose worker never started, so no agent ever reported it` })) : []
      fail(call, e.reason, kept ?? null, e.attempts)
      for (const retained of more) journal({ type: 'retained', retained })
      return null
    }
    for (const why of w.warnings ?? []) warn(call, why)
    journal({ type: 'started', key, n, title, dispatchId: w.dispatchId, harness: launch.harness, sessionId, worktree: w.worktree ?? null, terminal: w.terminal })
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

    let delivered = false
    let kept = null
    const retain = () => {
      if (isolated && w.worktree && !kept) kept = keep({ path: w.worktree, reason: `not in the ledger: its agent (${title}) died before reporting, so it was never removed — it may hold the only copy of that agent's work` })
      return kept
    }
    const quietly = async (what, fn) => {
      try {
        await fn()
      } catch (e) {
        out(`!! ${title}: could not ${what}: ${e.message}`)
      }
    }
    try {
      let end
      let continued = 0
      for (;;) {
        end = await watch(w, {
          title, harness: launch.harness, sessionId,
          nudged: (reason, attempt) => journal({ type: 'nudge', key, n, title, dispatchId: w.dispatchId, reason, attempt }),
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
        if (next.dispatchId !== w.dispatchId) {
          // Its old pane is gone, so nothing can settle the old dispatch.
          const old = w.dispatchId
          await quietly('stop its old worker', () => orca.workerStop({ dispatch: old }))
          await quietly('release its old worker', () => orca.workerRelease({ dispatch: old }))
          await quietly('title its new tab', () => orca.terminalRename({ terminal: next.terminal, title }))
        }
        w = { ...w, dispatchId: next.dispatchId, terminal: next.terminal, worktree: next.worktree ?? w.worktree }
      }
      // Read even for a dead worker: one that died after submit recorded its
      // result still delivered it.
      const result = readResult(resultPath, schema)
      // Failed and kept (ADR-0012): its tab and worktree stay as they stand
      // for the operator, so its process is not stopped either.
      const kept = !!(end.capped || end.blocked) && !!result.error
      if (end.dead && !kept) await quietly('stop its worker', () => orca.workerStop({ dispatch: w.dispatchId }))
      await quietly('release its worker', () => orca.workerRelease({ dispatch: w.dispatchId, keepTerminal: kept }))
      // A null is journaled as failed, as the Workflow runner journals a dead
      // agent: a resume runs the call live again. The worktree it leaves rides
      // along, so a resume still names it.
      if (result.error) {
        const reason = end.dead ? `${end.dead}, with no result` : `${result.error} (outcome ${end.outcome})`
        if (kept) out(`!! ${title}: its tab ${w.terminal} is kept open`)
        fail({ key, n, title }, reason, retain(), attempts, continued)
        out(`!! ${title}: ${reason}; agent() returns null`)
        return null
      }
      journal({ type: 'result', key, n, title, result: result.value })
      out(`<< ${title}: result received`)
      delivered = true
      if (isolated && w.worktree && published(result.value)) await setStatus(call, w.worktree, 'completed')
      return result.value
    } finally {
      if (!delivered) retain()
    }
  }

  // call: { prompt, schema, isolated, launch, key, n, label, title, phaseName }.
  return async function life(call) {
    const { schema, key, n, label, title } = call
    const dir = join(stateDir, 'agents', `${String(n).padStart(3, '0')}-${slug(label)}`)
    mkdirSync(dir, { recursive: true })
    const schemaPath = schema ? join(dir, 'schema.json') : null
    const resultPath = join(dir, 'result.json')
    const payloadPath = join(dir, schema ? 'payload.json' : 'payload.txt')
    if (schemaPath) writeFileSync(schemaPath, JSON.stringify(schema, null, 2))
    // A state dir reused across runs must not hand this agent an older result.
    rmSync(resultPath, { force: true })

    // Like a worker that cannot start, a Run Orca cannot create is this
    // agent's null, never a throw; the next agent() asks Orca again.
    let runId
    try {
      ;({ runId } = await ensureRun(call))
    } catch (e) {
      out(`!!!!!!!! ${title}: ${e.reason}; agent() returns null, and the next agent() asks again`)
      fail(call, e.reason, null, e.attempts)
      return null
    }
    // Held until the worker is released, not merely settled: an earlier
    // release lets a new worker start while this one is still live.
    await live.acquire(() => out(`.. ${title}: queued, ${limits.MAX_LIVE} agents are live`))
    try {
      return await supervise(runId, { ...call, schemaPath, resultPath, payloadPath })
    } finally {
      live.release()
    }
  }
}
