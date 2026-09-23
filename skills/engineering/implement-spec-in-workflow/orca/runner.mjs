#!/usr/bin/env node
// The Orca runner (ADR-0011): runs a rendered workflow script unchanged by
// supplying its four hooks, and starts each agent() as a supervised Orca
// worker. Launch it from its own Orca terminal — the Run it creates binds to
// that terminal.
//
//   node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
//
// Every settled agent() call is journaled in the state dir, which defaults
// to <notes-dir>/orca-run for the rendered <notes-dir>/workflow.js: a value as
// its result, and a null (a dead agent, one that never started, one Orca could
// not reach) as failed, with no result. --resume replays the unchanged prefix
// of agent() calls from that journal without launching anything; the first
// call not in it or journaled as failed, and every call after it, runs live.
// The Workflow runner's resumeFromRunId promises the same. On exit the runner
// writes summary.json to the state dir: {runner, ok, result | error}, and on a
// failure also worktrees_kept, the worktrees it retained.
//
// No change to this directory is done until the runner contract test passes
// under both runners (README.md). The offline tests do not replace it.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs'
import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { checkSchema, validate } from './schema.mjs'
import { orcaCli, launchCommand, HARNESSES } from './orca-cli.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'

export const SUBMIT = fileURLToPath(new URL('./submit.mjs', import.meta.url))

// The runner settings table (settings.mjs). Every limit the runner enforces
// lives there.
export const SETTINGS = RUNNER_SETTINGS

// The same loading the workflow simulator does: the script's one ESM line
// becomes a plain const, and the body runs as an async function body so its
// top-level `return` is the run's result. meta is also handed out as it is
// declared, so the Run's objective can name the spec the script is for.
export function loadScript(text) {
  const body = text.replace(/^export const meta\s*=/m, 'const meta = __meta.value =')
  return new Function('agent', 'parallel', 'phase', 'log', '__meta', 'return (async () => {' + body + '\n})()')
}

export const objectiveOf = (meta, fallback) => [meta?.name, meta?.description].filter(Boolean).join(': ') || fallback

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

// Keys sorted, so a call hashes the same whatever order its options were
// written in.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
  return v
}

export const journalKey = (prompt, opts = {}) =>
  'v1:' + createHash('sha256').update(JSON.stringify([prompt, canonical(opts)])).digest('hex')

// calls: key -> what was journaled under it, in journal order — { result }
// for a call that returned a value, { failed: true } for one that returned
// null. A failed entry holds its call's place but replays nothing, so a resume
// runs that call live again, as the Workflow runner re-runs an agent it
// journaled as failed. A `started` line with no settlement is a call the last
// run was killed during: it replays nothing. A torn last line is one it was
// killed while writing. retained: every worktree a dead agent left, from its
// failed entry or from a `retained` line an earlier resume carried forward.
export function readJournal(path) {
  const calls = new Map()
  const retained = []
  if (!existsSync(path)) return { calls, retained }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e?.retained?.path && !retained.some((k) => k.path === e.retained.path)) retained.push(e.retained)
    if (e?.type !== 'result' && e?.type !== 'failed') continue
    if (!calls.has(e.key)) calls.set(e.key, [])
    calls.get(e.key).push(e.type === 'failed' ? { failed: true } : { result: e.result })
  }
  return { calls, retained }
}

// A result that reports a PR its agent published: its worktree's work is on
// the stack, so its board card is done.
const published = (v) => !!v && typeof v === 'object' && typeof v.pr_url === 'string' && !!v.pr_url && v.published !== false

const slug = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60)
const mins = (ms) => Math.round(ms / 60_000)

export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

const NUDGE = 'The workflow has not received your result: your final message is not read. Finish the task, then run the submit command from your instructions until it exits 0.'

// `settings` overrides entries of SETTINGS; `clock` is what the liveness
// limits are measured against, so tests can drive time.
// permissionMode: the orchestrating session's, which Claude workers start in
// as Workflow subagents inherit it. Without one, Orca's setting for new agent
// tabs decides how a Claude worker runs.
export async function runScript(text, { orca = orcaCli(), stateDir, out = (s) => console.log(s), settings = {}, clock = realClock, fallbackObjective = 'workflow run', resume = false, permissionMode = null }) {
  const limits = { ...SETTINGS, ...settings }
  const { MAX_LIVE } = limits
  const script = loadScript(text)
  const meta = {}
  const live = slots(MAX_LIVE)
  // One Run per workflow run: every agent's worker is dispatched into it.
  let run = null
  let currentPhase = null
  let count = 0
  let toldNoMode = false

  mkdirSync(stateDir, { recursive: true })
  const journalPath = join(stateDir, 'journal.jsonl')
  const earlier = resume ? readJournal(journalPath) : { calls: new Map(), retained: [] }
  const journaled = earlier.calls
  // Rewritten from empty, replayed calls included, so the journal always
  // describes the latest run and a later resume replays from it alone.
  writeFileSync(journalPath, '')
  const journal = (entry) => appendFileSync(journalPath, JSON.stringify(entry) + '\n')
  const replays = new Map()
  let replaying = resume
  // A dead agent never names its worktree to the script, so the script can
  // never reclaim it; the runner created it and names it instead. A resume
  // re-runs the dead agent in a new worktree, so the one it left in the
  // earlier run stays named here, and is journaled again for the next resume.
  const retained = []
  const keep = (k) => {
    if (!retained.some((r) => r.path === k.path)) retained.push(k)
    return k
  }
  for (const k of earlier.retained) journal({ type: 'retained', retained: keep(k) })

  // The board card of a worktree the runner created. Cosmetic: a failure is
  // logged and the agent carries on.
  async function setStatus(worktree, status, title) {
    try {
      await orca.worktreeStatus({ worktree, status })
    } catch (e) {
      out(`!! ${title}: could not set its worktree's board status to ${status}: ${e?.message ?? e}`)
    }
  }

  const phase = (title) => {
    currentPhase = title
    out(`== ${title}`)
  }
  const log = (msg) => out(`   ${msg}`)
  const parallel = (fns) => Promise.all(fns.map((f, i) => Promise.resolve().then(f).catch((e) => {
    out(`!! parallel: thunk ${i} threw (${e?.message ?? e}); it resolves to null`)
    return null
  })))

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

  async function agent(prompt, opts = {}) {
    if (opts.schema) checkSchema(opts.schema)
    const harness = opts.harness ?? 'claude'
    if (!HARNESSES.includes(harness)) throw new Error(`agent(): unknown harness "${harness}": expected one of ${HARNESSES.join(', ')}`)
    const launch = { harness, model: opts.model, effort: opts.effort, permissionMode: harness === 'claude' ? permissionMode : null }
    // Refused here, before any worker, like an unsatisfiable schema.
    launchCommand(launch)
    const n = ++count
    const label = opts.label || `agent-${n}`
    const phaseName = opts.phase ?? currentPhase ?? 'Run'
    const title = `[${phaseName}] ${label}`
    const key = journalKey(prompt, opts)

    // The k-th call with a key replays the k-th entry journaled under it, so
    // identical calls each get their own; a failed entry keeps its place. One
    // miss ends the prefix for good: what follows a changed or failed call may
    // depend on it, however unchanged it reads.
    const k = replays.get(key) ?? 0
    const cached = journaled.get(key)
    const entry = replaying && cached && k < cached.length ? cached[k] : null
    if (entry && !entry.failed) {
      replays.set(key, k + 1)
      journal({ type: 'result', key, n, title, result: entry.result })
      out(`<< ${title}: replayed from the journal`)
      return entry.result
    }
    if (replaying) out(`>> ${title}: ${entry ? 'failed in the last run' : 'not in the journal'}; this call and every one after it run live`)
    replaying = false

    const dir = join(stateDir, 'agents', `${String(n).padStart(3, '0')}-${slug(label)}`)
    mkdirSync(dir, { recursive: true })
    const schemaPath = opts.schema ? join(dir, 'schema.json') : null
    const resultPath = join(dir, 'result.json')
    const payloadPath = join(dir, opts.schema ? 'payload.json' : 'payload.txt')
    if (schemaPath) writeFileSync(schemaPath, JSON.stringify(opts.schema, null, 2))
    // A state dir reused across runs must not hand this agent an older result.
    rmSync(resultPath, { force: true })

    // Like a worker that cannot start, a Run Orca cannot create is this
    // agent's null, never a throw; the next agent() asks Orca again.
    const creating = (run ??= orca.runCreate({ objective: objectiveOf(meta.value, fallbackObjective) }))
    let runId
    try {
      ;({ runId } = await creating)
    } catch (e) {
      if (run === creating) run = null
      out(`!!!!!!!! ${title}: Orca could not create this run's Run: ${e?.message ?? e}; agent() returns null, and the next agent() asks again`)
      journal({ type: 'failed', key, n, title })
      return null
    }
    await live.acquire(() => out(`.. ${title}: queued, ${MAX_LIVE} agents are live`))
    try {
      return await supervise(runId, prompt, opts, launch, { key, n, title, phaseName, schemaPath, resultPath, payloadPath })
    } finally {
      live.release()
    }
  }

  async function supervise(runId, prompt, opts, launch, { key, n, title, phaseName, schemaPath, resultPath, payloadPath }) {
    if (launch.harness === 'claude' && !permissionMode && !toldNoMode) {
      toldNoMode = true
      out("!! no --permission-mode given: Claude workers run as Orca's setting for new agent tabs says, not in the orchestrator's mode.")
    }
    journal({ type: 'started', key, n, title })
    const isolated = opts.isolation === 'worktree'
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
      const result = readResult(resultPath, opts.schema)
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

  try {
    return withRetained(await script(agent, parallel, phase, log, meta), retained)
  } catch (e) {
    // A run that throws still names what it kept: summary.json carries it.
    if (!(e instanceof Object)) e = new Error(String(e))
    e.worktrees_kept = [...retained]
    throw e
  } finally {
    for (const k of retained) out(`!! kept ${k.path}: ${k.reason}`)
  }
}

// summary.json for a run that threw: the error, and every worktree the runner
// retained, since the arming session reads this file and not the log.
export const failureSummary = (e) => ({ runner: 'orca', ok: false, error: e?.stack ?? String(e), worktrees_kept: Array.isArray(e?.worktrees_kept) ? e.worktrees_kept : [] })

// The run's result names each retained worktree beside the ones a reclaimer
// kept, in the same {path, reason} shape. A result that is not an object has
// nowhere to hold them; the log still names them.
function withRetained(result, retained) {
  if (!retained.length || !result || typeof result !== 'object' || Array.isArray(result)) return result
  const kept = Array.isArray(result.worktrees_kept) ? result.worktrees_kept : []
  const named = new Set(kept.map((k) => k?.path))
  return { ...result, worktrees_kept: [...kept, ...retained.filter((k) => !named.has(k.path))] }
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) {
  const args = process.argv.slice(2)
  let bad = false
  const r = args.indexOf('--resume')
  const resume = r >= 0 && !!args.splice(r, 1)
  const option = (name) => {
    const at = args.indexOf(name)
    if (at < 0) return null
    const [, value] = args.splice(at, 2)
    if (!value || value.startsWith('--')) bad = true
    return value ?? null
  }
  const stateDir = option('--state-dir')
  const permissionMode = option('--permission-mode')
  const [scriptPath] = args
  if (!scriptPath || args.length > 1 || bad) {
    console.error('usage: node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <orchestrator\'s Claude permission mode>]')
    process.exit(2)
  }
  const path = resolve(scriptPath)
  const dir = stateDir ? resolve(stateDir) : join(dirname(path), 'orca-run')
  // The arming session reads the run's outcome from this file once the
  // runner's terminal exits (SKILL.md step 4); a stale one from an earlier
  // run must never pass for this run's.
  const summaryPath = join(dir, 'summary.json')
  rmSync(summaryPath, { force: true })
  let summary
  try {
    const result = await runScript(readFileSync(path, 'utf8'), {
      stateDir: dir,
      fallbackObjective: `workflow ${basename(path)}`,
      resume,
      permissionMode,
    })
    console.log('== Result')
    console.log(JSON.stringify(result, null, 2))
    summary = { runner: 'orca', ok: true, result }
  } catch (e) {
    console.error(e?.stack ?? String(e))
    process.exitCode = 1
    summary = failureSummary(e)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
}
