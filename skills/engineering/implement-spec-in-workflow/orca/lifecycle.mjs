// One agent's life under the Orca runner: its files, the run's Run, a live
// slot, its worker's start, the watch until it settles or dies, its result, and
// what the journal, the board and the retained list learn from it. runner.mjs
// decides which calls reach here (replay does not) and names each one.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { validate } from './schema.mjs'

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

const NUDGE = 'The workflow has not received your result: your final message is not read. Finish the task, then run the submit command from your instructions until it exits 0.'

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
// Returns life(call), which resolves to the agent's value or null, and throws
// only if journal or out does.
export function agentLifecycle({ orca, clock, limits, out, stateDir, objective, journal, keep }) {
  const live = slots(limits.MAX_LIVE)
  // One Run per workflow run: every agent's worker is dispatched into it.
  let run = null
  let toldNoMode = false

  // The board card of a worktree the runner created. Cosmetic: a failure is
  // logged and the agent carries on.
  async function setStatus(worktree, status, title) {
    try {
      await orca.worktreeStatus({ worktree, status })
    } catch (e) {
      out(`!! ${title}: could not set its worktree's board status to ${status}: ${e?.message ?? e}`)
    }
  }

  // Watches one worker until it settles ({ outcome }) or crosses a limit in
  // the settings table ({ dead: why }).
  async function watch(w, title) {
    const start = clock.now()
    let errors = 0
    let nudges = 0
    let graceFrom = start
    let quietFrom = start
    let lastNudgeAt = null
    let silenceNudged = false
    let blockedAt = null

    async function nudge(why) {
      out(`>> ${title}: ${why}; nudging it`)
      lastNudgeAt = graceFrom = clock.now()
      try {
        await orca.terminalSend({ terminal: w.terminal, text: NUDGE })
      } catch (e) {
        out(`!! ${title}: the nudge did not reach it: ${e.message}`)
      }
    }

    for (;; await clock.sleep(limits.pollMs)) {
      let s
      let idle = false
      const settling = clock.now() - graceFrom < limits.nudgeGraceMs
      try {
        s = await orca.workerShow({ dispatch: w.dispatchId })
        if (!s.settled && !s.gone && !s.waiting && !s.exited && !settling && w.terminal) {
          idle = await orca.terminalIdle({ terminal: w.terminal, timeoutMs: limits.idleProbeMs })
        }
        errors = 0
      } catch (e) {
        if (++errors >= limits.watchErrors) return { dead: `Orca failed ${errors} times in a row watching it (${e.message})` }
        out(`!! ${title}: could not look at its worker: ${e.message}`)
        continue
      }
      if (s.settled) return { outcome: s.outcome }
      if (s.gone) return { dead: 'its terminal is gone' }

      const now = clock.now()
      if (s.waiting) {
        if (blockedAt === null) {
          blockedAt = now
          out(`!!!!!!!! ${title} is BLOCKED ON A HUMAN. Answer it in terminal ${w.terminal}.`)
          out(`!!!!!!!! waiting on: ${s.waiting}`)
          out(`!!!!!!!! if nobody answers within ${mins(limits.blockedDeadMs)} minutes, it counts as dead and agent() returns null`)
        }
        if (now - blockedAt >= limits.blockedDeadMs) return { dead: `blocked on a human, unanswered for ${mins(now - blockedAt)} minutes` }
        continue
      }
      if (blockedAt !== null) {
        out(`>> ${title}: no longer blocked`)
        blockedAt = null
        quietFrom = graceFrom = now
      }

      const echo = lastNudgeAt !== null && s.lastOutputAt <= lastNudgeAt + limits.nudgeEchoMs
      if (s.lastOutputAt != null && s.lastOutputAt > quietFrom && !echo) {
        quietFrom = s.lastOutputAt
        silenceNudged = false
      }

      if ((s.exited && !settling) || idle) {
        const how = s.exited ? 'exited' : 'went idle'
        if (nudges >= limits.idleNudges) return { dead: `it ${how} without submitting, after ${nudges} nudges` }
        await nudge(`it ${how} without submitting (nudge ${++nudges} of ${limits.idleNudges})`)
        continue
      }

      const quiet = now - quietFrom
      if (quiet >= limits.silentDeadMs) return { dead: `silent for ${mins(quiet)} minutes` }
      if (quiet >= limits.silentNudgeMs && !silenceNudged) {
        silenceNudged = true
        await nudge(`silent for ${mins(quiet)} minutes`)
      }
    }
  }

  async function supervise(runId, { prompt, schema, isolated, launch, key, n, title, phaseName, schemaPath, resultPath, payloadPath }) {
    if (launch.harness === 'claude' && !launch.permissionMode && !toldNoMode) {
      toldNoMode = true
      out("!! no --permission-mode given: Claude workers run as Orca's setting for new agent tabs says, not in the orchestrator's mode.")
    }
    journal({ type: 'started', key, n, title })
    let w
    try {
      w = await orca.workerStart({
        run: runId,
        prompt: workerPrompt(prompt, { schemaPath, resultPath, payloadPath }),
        title,
        ...launch,
        child: isolated ? { name: `${runId}-${n}`, displayName: title } : null,
      })
    } catch (e) {
      out(`!! ${title}: its worker did not start: ${e.message}; agent() returns null`)
      // A worktree Orca made before the start failed is named like a dead
      // agent's: the runner never removes one.
      const kept = isolated && e?.worktree ? keep({ path: e.worktree, reason: `not in the ledger: created for ${title}, whose worker never started, so no agent ever reported it` }) : null
      journal({ type: 'failed', key, n, title, ...(kept && { retained: kept }) })
      return null
    }
    if (isolated && w.worktree) await setStatus(w.worktree, phaseName === 'Gate' ? 'in-review' : 'in-progress', title)
    const on = [launch.harness, launch.model, launch.effort && `${launch.effort} effort`, launch.permissionMode && `${launch.permissionMode} mode`].filter(Boolean).join(', ')
    out(`>> ${title}: started on ${on} as dispatch ${w.dispatchId}${w.terminal ? ` in terminal ${w.terminal}` : ''}${w.worktree ? ` in ${w.worktree}` : ''}`)
    if (w.mode !== 'terminal' || !w.terminal) {
      out(`!! ${title} has no terminal tab to watch (mode: ${w.mode ?? 'unknown'}). Orca's setting for new agent tabs decides this; set it to terminal. ${w.modeDetail}`)
    } else {
      // The agent titles its own tab and drops --task-title (ADR-0011), so the
      // tab is renamed to the title the operator finds it by.
      try {
        await orca.terminalRename({ terminal: w.terminal, title })
      } catch (e) {
        out(`!! ${title}: could not title its tab: ${e.message}`)
      }
    }

    let delivered = false
    let kept = null
    const retain = () => {
      if (isolated && w.worktree && !kept) kept = keep({ path: w.worktree, reason: `not in the ledger: its agent (${title}) died before reporting, so it was never removed — it may hold the only copy of that agent's work` })
      return kept
    }
    try {
      const end = await watch(w, title)
      // Read even for a dead worker: one that died after submit recorded its
      // result still delivered it.
      const result = readResult(resultPath, schema)
      if (end.dead) {
        try {
          await orca.workerStop({ dispatch: w.dispatchId })
        } catch (e) {
          out(`!! ${title}: could not stop its worker: ${e.message}`)
        }
      }
      try {
        await orca.workerRelease({ dispatch: w.dispatchId })
      } catch (e) {
        out(`!! ${title}: could not release its worker: ${e.message}`)
      }
      // A null is journaled as failed, as the Workflow runner journals a dead
      // agent: a resume runs the call live again. The worktree it leaves rides
      // along, so a resume still names it.
      if (result.error) {
        const k = retain()
        journal({ type: 'failed', key, n, title, ...(k && { retained: k }) })
        out(`!! ${title}: ${end.dead ? `${end.dead}, with no result` : `${result.error} (outcome ${end.outcome})`}; agent() returns null`)
        return null
      }
      journal({ type: 'result', key, n, title, result: result.value })
      out(`<< ${title}: result received`)
      delivered = true
      if (isolated && w.worktree && published(result.value)) await setStatus(w.worktree, 'completed', title)
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
    const creating = (run ??= orca.runCreate({ objective: objective() }))
    let runId
    try {
      ;({ runId } = await creating)
    } catch (e) {
      if (run === creating) run = null
      out(`!!!!!!!! ${title}: Orca could not create this run's Run: ${e?.message ?? e}; agent() returns null, and the next agent() asks again`)
      journal({ type: 'failed', key, n, title })
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
