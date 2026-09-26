// The one place the Orca runner and submit talk to Orca (ADR-0011). Callers
// see only the plain shapes these methods return; the JSON field names of
// Orca's `--json` output (as of 1.4.207) stay in this file. fake-orca.mjs
// implements the same methods, which is what lets the tests run offline.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { RUNNER_SETTINGS } from './settings.mjs'

export class OrcaError extends Error {
  constructor(code, message, verb) {
    super(`orca ${verb}: ${code}${message ? ': ' + message : ''}`)
    this.code = code
  }
}

const SETTLED_DISPATCH = new Set(['completed', 'failed', 'cancelled', 'canceled'])

// A clock's timer: resolves after ms unless cancelled first. The runner's
// clock carries one, so a test's clock decides when a call has taken too long.
export function realTimer(ms) {
  let id
  const promise = new Promise((r) => { id = setTimeout(r, ms) })
  return { promise, cancel: () => clearTimeout(id) }
}

// Every Orca call is bounded. One that has not answered within ms fails as
// call_timeout, never as Orca's own `timeout`, which a tui-idle wait uses to
// mean busy.
export async function withTimeout(clock, ms, p, verb) {
  const t = clock.timer(ms)
  try {
    return await Promise.race([p, t.promise.then(() => { throw new OrcaError('call_timeout', `no answer within ${Math.round(ms / 1000)}s`, verb) })])
  } finally {
    t.cancel()
  }
}

// No shell: arguments reach Orca verbatim, prompts included. Windows still
// caps a command line at 32767 characters, so one prompt must stay under it.
// A call past timeoutMs is killed, so a hung Orca leaves no process behind.
function execOrca(bin) {
  return (args, timeoutMs) => {
    const verb = args.slice(0, 2).join(' ')
    return new Promise((resolve, reject) => {
      execFile(bin, [...args, '--json'], { maxBuffer: 64 << 20, windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err?.killed) return reject(new OrcaError('call_timeout', `killed after ${Math.round(timeoutMs / 1000)}s`, verb))
        // Orca prints its JSON envelope on failure too (exit 1, ok:false), so
        // the envelope, not the exit code, says what went wrong.
        let res
        try {
          res = JSON.parse(String(stdout).replace(/^﻿/, ''))
        } catch {
          return reject(new OrcaError(err ? String(err.code ?? 'failed') : 'bad_output', String(stderr || stdout || err || '').trim(), verb))
        }
        if (!res.ok) return reject(new OrcaError(res.error?.code ?? 'unknown', res.error?.message ?? '', verb))
        resolve(res.result)
      })
    })
  }
}

function execGit(cwd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]} in ${cwd}: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout)))
  })
}

// The one git helper: a git command in `cwd`, bounded at `ms` as an Orca call
// is, so a hung git fails as call_timeout and never stalls its caller.
export function gitIn(cwd, args, { git = execGit, clock = { timer: realTimer }, ms = RUNNER_SETTINGS.orcaCallMs } = {}) {
  return withTimeout(clock, ms, git(cwd, args, ms), `git ${args[0]}`)
}

// `git status --porcelain` as its lines, each kept whole: a line's leading
// space is its index column, so the output is never trimmed.
export const porcelainLines = (text) => String(text ?? '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)

// Whether a worktree's porcelain lines are its baseline's, in any order.
export const sameLines = (lines, baseline) => lines.length === baseline.length && [...lines].sort().join('\n') === [...baseline].sort().join('\n')

// Commits on a worktree's branch that no other branch and no remote holds:
// work of its own, which a retry never takes a worktree over with.
export async function worktreeOwnCommits(path, branch, bound) {
  const b = String(branch ?? '').replace(/^refs\/heads\//, '')
  return Number((await gitIn(path, ['rev-list', '--count', 'HEAD', '--not', `--exclude=${b}`, '--branches', '--remotes'], bound)).trim())
}

// Commits reachable from a worktree's HEAD that no remote-tracking ref holds
// (D6 on #43): what a reclaim refuses to remove unless forced. Uncommitted
// files do not count. A worktree already gone from disk holds none.
export async function worktreeUnpushed(path, bound) {
  if (!existsSync(path)) return 0
  return Number((await gitIn(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], bound)).trim())
}

export const HARNESSES = ['claude', 'pi']

// Typed into the new terminal's shell (PowerShell on Windows), so every word
// must be one no shell reads as syntax.
const WORD = /^[\w.:/@+=-]+$/

// Every worker's harness starts from this command line, never from
// worker-start's own `--agent` launch (ADR-0011): worker-start has no
// permission-mode or session-id flag, and forwards --model/--effort to Claude
// only. The session id is the runner's, so it is known before the agent runs;
// both harnesses take `--session-id`, and Claude requires a UUID. Without one
// the command is still built, which is how a call's launch words are checked
// before any worker starts.
export function launchCommand({ harness = 'claude', model, effort, permissionMode, sessionId }) {
  return commandLine(harness, sessionId && ['--session-id', sessionId], { model, effort, permissionMode })
}

// The same launch, carrying on the session it started (session continuation,
// ADR-0013). Claude refuses a --session-id already in use, so it resumes with
// --resume; pi's --session-id reopens the session it names.
export function resumeCommand({ harness = 'claude', model, effort, permissionMode, sessionId }) {
  if (!sessionId) throw new Error(`resumeCommand: no session id to continue for ${harness}`)
  return commandLine(harness, harness === 'claude' ? ['--resume', sessionId] : ['--session-id', sessionId], { model, effort, permissionMode })
}

function commandLine(harness, session, { model, effort, permissionMode }) {
  let argv
  if (harness === 'pi') {
    // --approve trusts project-local files: an unattended pi worker would
    // otherwise stop at pi's trust prompt with nobody to answer it.
    argv = ['pi', '--approve', session, model && ['--model', model], effort && ['--thinking', effort]]
  } else if (harness === 'claude') {
    argv = ['claude', session, permissionMode && ['--permission-mode', permissionMode], model && ['--model', model], effort && ['--effort', effort]]
  } else {
    throw new Error(`unknown harness "${harness}": expected one of ${HARNESSES.join(', ')}`)
  }
  const words = argv.flat().filter(Boolean)
  const bad = words.find((w) => !WORD.test(w))
  if (bad) throw new Error(`refusing to type "${bad}" into a shell to launch ${harness}: use plain model, effort and mode names`)
  return words.join(' ')
}

// The line that shows a log file's last lines and then every line added to it,
// typed into the shell `logTail` starts: PowerShell on Windows, where the path
// sits in a single-quoted literal (nothing in it expands, a quote doubles)
// and the log is read as the UTF-8 the runner writes (Windows PowerShell
// would read it as ANSI), and a POSIX shell elsewhere. A line break would submit the line early.
export function tailCommand(path, platform = process.platform) {
  if (platform === 'win32') return `Get-Content -LiteralPath ${quoted(path, platform)} -Encoding UTF8 -Tail 200 -Wait`
  return `tail -n 200 -F ${quoted(path, platform)}`
}

function quoted(path, platform) {
  const p = String(path)
  if (/[\x00-\x1f\x7f]/.test(p)) throw new Error(`refusing to type a path holding a control character into a shell: ${JSON.stringify(p)}`)
  return platform === 'win32' ? `'${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, `'\\''`)}'`
}

// The runner's own launch (SKILL.md step 4) with --resume, typed into the
// shell `resumeRunner` starts, quoted as tailCommand quotes. The state dir is
// always named, so a run armed with a state dir of its own resumes from it.
export function resumeRunnerCommand({ runner, script, stateDir, permissionMode = null }, platform = process.platform) {
  if (permissionMode && !WORD.test(permissionMode)) throw new Error(`refusing to type permission mode "${permissionMode}" into a shell`)
  const q = (p) => quoted(p, platform)
  return ['node', q(runner), q(script), '--state-dir', q(stateDir), '--resume', ...(permissionMode ? ['--permission-mode', permissionMode] : [])].join(' ')
}

// The one worker-start argv: it adopts a terminal the runner made, so it never
// carries --agent. fake-orca.mjs builds its starts from this too.
export const workerStartArgs = ({ run, prompt, title, place, terminal }) =>
  ['orchestration', 'worker-start', '--run', run, '--spec', prompt, '--task-title', title, ...place, '--terminal', terminal]

// A `worker-show` result as the runner reads it. fake-orca.mjs answers in
// Orca's shape and reads it through this too.
export function workerStatus(r) {
  const handle = r.worker?.agentTerminalHandle ?? null
  // agentWait: an object is a wait only a human can answer; null means
  // Orca looked and found none; absent means it never looked.
  const wait = r.observation?.agentWait ?? r.terminal?.agentWait ?? null
  // A worker never given a terminal is not one whose terminal is gone.
  const gone = Boolean(handle) && (!r.terminal || r.terminal.orphaned === true)
  // About 5 s after a worker's tab closes, Orca fails its dispatch itself
  // (stage process_exited; live, Orca 1.4.209). That is a death whose session
  // the runner continues, not a worker that settled without a result.
  const failedByClose = gone && r.dispatch?.status === 'failed'
  return {
    settled: !failedByClose && (r.worker?.stage === 'settled' || SETTLED_DISPATCH.has(r.dispatch?.status)),
    outcome: r.projection?.outcome ?? r.worker?.state ?? null,
    terminal: handle,
    gone,
    exited: r.observation?.status === 'exited',
    waiting: wait && typeof wait === 'object' ? JSON.stringify(wait).slice(0, 300) : null,
  }
}

// The path half of a `<repoId>::<path>` worktree id.
const pathOf = (id) => (typeof id === 'string' && id.includes('::') ? id.slice(id.indexOf('::') + 2) : null)

// The last segment of a worktree path: the name `worktree create --name` gave
// it, suffixed -2, -3… when that name was taken. Every reader of a worktree's
// name takes it from here, so the `<runId>-` ownership rule reads one name.
export const worktreeName =(path) => String(path).split(/[\\/]/).pop()

// Rows a worktree list asks for: Orca's default page is 200, counted across
// every repo, and its own UI asks for 1e4.
const WORKTREE_LIST_LIMIT = 10000

// What Orca answers a verb aimed at a tab that is closed, or never existed.
const TAB_GONE = new Set(['terminal_not_writable', 'terminal_exited', 'terminal_handle_stale'])

// call(args, timeoutMs) and git(cwd, args, timeoutMs) run one Orca or git
// command; clock.timer bounds every call at callMs, plus any wait it asks for,
// and a worktree create at createMs. `platform` is the host's, which picks the
// shell `logTail` types into.
export function orcaCli({ bin = process.env.ORCA_BIN || 'orca', call = execOrca(bin), git = execGit, clock = { timer: realTimer }, callMs = RUNNER_SETTINGS.orcaCallMs, createMs = RUNNER_SETTINGS.worktreeCreateMs, platform = process.platform } = {}) {
  const orca = (args, waitMs = 0) => withTimeout(clock, callMs + waitMs, call(args, callMs + waitMs), args.slice(0, 2).join(' '))
  const bound = { git, clock, ms: callMs }

  const closeQuietly = (handle) => orca(['terminal', 'close', '--terminal', handle]).catch(() => {})

  // A prompt typed into a TUI that is still starting is lost, so the worker is
  // dispatched only once the agent sits idle. A timed-out wait may exit 1 or
  // print satisfied:false; either way it is retried once, longer.
  async function waitIdle(handle, command) {
    for (const ms of [60000, 180000]) {
      try {
        const r = await orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(ms)], ms)
        if (r?.wait?.satisfied) return
      } catch (e) {
        if (e.code !== 'timeout') throw e
      }
    }
    throw new OrcaError('agent_not_ready', `\`${command}\` in terminal ${handle} never reached an idle prompt`, 'terminal wait')
  }

  // The path of the worktree `worktree create` made: its `path`, or the path
  // half of its `<repoId>::<path>` id.
  function createdPath(r) {
    const w = r?.worktree ?? r ?? {}
    if (typeof w.path === 'string' && w.path) return w.path
    return pathOf(w.id)
  }

  // The worktree Orca holds under this name, or null.
  // Orca pages the list at 200 rows across every repo on the machine, and
  // ADR-0012 keeps every worktree until the operator reclaims it, so the list
  // asks for as many as Orca's own UI does. A page still truncated cannot rule
  // the name out: that attempt fails, retryable, rather than make a <name>-2.
  async function findWorktree(name) {
    const r = await orca(['worktree', 'list', '--limit', String(WORKTREE_LIST_LIMIT)])
    if (r?.truncated) throw new OrcaError('worktree_list_truncated', `the list stopped at ${(r.worktrees ?? []).length} worktrees, so an earlier ${name} could not be ruled out`, 'worktree list')
    return (r?.worktrees ?? []).find((w) => typeof w.path === 'string' && worktreeName(w.path) === name) ?? null
  }

  // The worktree an earlier attempt of this start made, if there is one to
  // take up: Orca answers a second `worktree create --name` with a new
  // <name>-2, never an error, so a retry looks its name up first. One an
  // agent still runs in is refused for this attempt only. Until an attempt
  // has reached worker-start (`dispatched`), whatever it holds is Orca's own
  // making, such as a setup hook's untracked output, so it is taken up as it
  // is; after that, one that holds work is refused for good, named on the
  // error. Work is what it holds beyond its `baseline`, the porcelain lines it
  // was made with: with none (a create that timed out), any line is work.
  async function earlierWorktree(name, dispatched, baseline) {
    const row = await findWorktree(name)
    if (!row) return null
    const path = row.path
    const refuse = (code, why, final) => Object.assign(new OrcaError(code, `${path} ${why}`, 'worktree reuse'), { worktree: path, final })
    // terminal list leaves closed tabs out, and agentIdentity marks an agent's pane.
    const t = await orca(['terminal', 'list', '--worktree', `path:${path}`])
    if ((t?.terminals ?? []).some((x) => x.agentIdentity && !x.orphaned)) throw refuse('worktree_held', 'still has an agent running in it', false)
    if (!dispatched) return path
    const lines = porcelainLines(await gitIn(path, ['status', '--porcelain'], bound))
    if (!sameLines(lines, baseline ?? [])) throw refuse('worktree_dirty', baseline?.length ? 'has changed since it was made' : 'has uncommitted changes', true)
    const own = await worktreeOwnCommits(path, row.branch, bound)
    if (own > 0) throw refuse('worktree_has_commits', `has ${own} commit(s) of its own`, true)
    return path
  }

  async function workerShow({ dispatch }) {
    return workerStatus(await orca(['orchestration', 'worker-show', '--dispatch', dispatch]))
  }

  return {
    // Run from the runner's own terminal: Orca binds the Run to the caller
    // and refuses a mutation made on another terminal's behalf. `terminal` is
    // that coordinator terminal, the runner's own.
    async runCreate({ objective }) {
      const r = await orca(['orchestration', 'run-create', '--objective', objective])
      return { runId: r.run?.id ?? r.id, terminal: r.run?.coordinator_handle ?? null }
    },

    // No `child`: the worker runs in the coordinator's worktree — the runner's,
    // which is the run's. `child: { name, displayName, retry }`: in an Orca
    // child worktree of it, new unless `retry` finds the one an earlier
    // attempt made. Either way `worktree` is the path it runs in, `terminal`
    // the handle of the tab the runner made for it, and `warnings` what went
    // wrong without stopping the start. A failure after the child exists
    // names it as the error's `worktree`, and `worktrees` lists every one it
    // leaves when there are more; `final` marks one a retry cannot mend, and
    // `dispatched` one whose worker-start was sent, which may have put a
    // worker in the child. `child.dispatched`: an earlier attempt's was;
    // `child.baseline`: the porcelain lines an earlier attempt's create left,
    // or null. A child this attempt creates has its own taken before its
    // terminal opens, and handed to `child.onBaseline({ worktree, lines })`.
    // `prompt` may be a function of the child's baseline (null without one).
    async workerStart({ run, prompt, title, harness = 'claude', model, effort, permissionMode, sessionId, child = null }) {
      if (!sessionId) throw new Error(`workerStart: ${title} has no session id; the runner assigns one to every worker`)
      const command = launchCommand({ harness, model, effort, permissionMode, sessionId })
      // Orca's documented route for custom argv under supervision: create the
      // agent's terminal, then worker-start takes ownership of it. Without
      // `child` the terminal opens in the runner's worktree, which `current`
      // names. With it, a process already running cannot be moved into a
      // worktree worker-start makes, so the child is made first, the terminal
      // opens in it, and worker-start is told that is where it runs.
      let worktree = null
      let place = ['--worktree', 'current']
      let terminalIn = []
      const warnings = []
      let c = null
      if (child) {
        worktree = child.retry ? await earlierWorktree(child.name, child.dispatched, child.baseline ?? null) : null
        if (!worktree) {
          // A create Orca finishes after its answer timed out still leaves the
          // worktree, and a retry would find it; looked up now, it costs no attempt.
          // `setup: 'skip'` skips the repo's setup hook (a doctor's worktree);
          // without it Orca follows the repo's setup policy.
          try {
            c = await orca(['worktree', 'create', '--name', child.name, '--parent-worktree', 'current', ...(child.setup ? ['--setup', child.setup] : [])], Math.max(0, createMs - callMs))
          } catch (e) {
            if (e?.code !== 'call_timeout') throw e
            worktree = (await findWorktree(child.name).catch(() => null))?.path ?? null
            if (!worktree) throw e
            warnings.push(`${e.message}, but Orca had made ${worktree}, so it starts there`)
          }
        }
        if (c) {
          worktree = createdPath(c)
          if (!worktree) throw new OrcaError('bad_output', `worktree create named no path for ${child.name}`, 'worktree create')
          // Orca opens a plain shell in a new worktree; the agent gets its own.
          if (c?.startupTerminal?.handle) await closeQuietly(c.startupTerminal.handle)
          // A name Orca suffixed means a worktree of this name already exists
          // that the lookup did not take up. Both are named on the error so
          // both are retained. Final: a retry would look the name up and create
          // again, and each create that misses makes one more <name>-3, -4…
          if (worktreeName(worktree) !== child.name) {
            const earlier = worktree.slice(0, worktree.length - worktreeName(worktree).length) + child.name
            throw Object.assign(new OrcaError('worktree_name_taken', `asked for ${child.name}, Orca made ${worktreeName(worktree)}: a worktree named ${child.name} already exists`, 'worktree create'), { worktree, worktrees: [worktree, earlier], final: true })
          }
        }
        place = terminalIn = ['--worktree', `path:${worktree}`]
        // worktree create has no --display-name. Cosmetic: the start goes on.
        try {
          await orca(['worktree', 'set', ...place, '--display-name', child.displayName])
        } catch (e) {
          warnings.push(`could not set its worktree's display name: ${e?.message ?? e}`)
        }
      }
      let handle = null
      let dispatching = false
      let baseline = child?.baseline ?? null
      try {
        // Only a create answered in time: one looked up after its timeout may
        // still be running its setup, so its lines are no baseline.
        if (c) {
          baseline = porcelainLines(await gitIn(worktree, ['status', '--porcelain'], bound))
          await child.onBaseline?.({ worktree, lines: baseline })
        }
        const t = await orca(['terminal', 'create', ...terminalIn, '--title', title, '--command', command])
        handle = t.terminal.handle
        await waitIdle(handle, command)
        dispatching = true
        const r = await orca(workerStartArgs({ run, prompt: typeof prompt === 'function' ? prompt(baseline) : prompt, title, place, terminal: handle }))
        const effect = (r.effects || []).find((e) => e.kind === 'worktree')?.id
        return { dispatchId: r.dispatchId, taskId: r.taskId, terminal: handle, worktree: worktree ?? pathOf(effect) ?? pathOf(t.terminal.worktreeId), warnings }
      } catch (e) {
        if (handle) await closeQuietly(handle)
        // The caller names a worktree made for a worker that never started.
        if (worktree && e instanceof Object) e.worktree = worktree
        if (dispatching && e instanceof Object) e.dispatched = true
        throw e
      }
    },

    // Board status of a worktree the runner created, by path: todo,
    // in-progress, in-review or completed.
    async worktreeStatus({ worktree, status }) {
      await orca(['worktree', 'set', '--worktree', `path:${worktree}`, '--workspace-status', status])
    },

    // A resume from a new terminal: Orca refuses worker-start from any
    // terminal but the Run's coordinator, so the runner rebinds the Run to its
    // own. The old coordinator is fenced from then on. Read, stop and release
    // are not fenced, and a worker's worker_done from its own pane still
    // settles a dispatch issued before the takeover (live, Orca 1.4.209).
    async runUse({ runId }) {
      const r = await orca(['orchestration', 'run-use', '--id', runId])
      return { runId: r.run?.id ?? runId, terminal: r.run?.coordinator_handle ?? null }
    },

    // Also how a resume looks at a worker an earlier runner started: Orca's
    // dispatches outlive the runner, and read is not fenced to the Run's
    // coordinator.
    workerShow,

    // A short `terminal wait --for tui-idle` is a poll: satisfied means idle,
    // Orca's `timeout` error means busy.
    async terminalIdle({ terminal, timeoutMs }) {
      try {
        await orca(['terminal', 'wait', '--terminal', terminal, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs)], timeoutMs)
        return true
      } catch (e) {
        if (e.code === 'timeout') return false
        throw e
      }
    },

    // Typed into the worker's TUI as a prompt: a mailbox message would wait
    // for a check the idle agent never makes.
    async terminalSend({ terminal, text }) {
      await orca(['terminal', 'send', '--terminal', terminal, '--text', text, '--enter'])
    },

    async workerStop({ dispatch }) {
      await orca(['orchestration', 'worker-stop', '--dispatch', dispatch])
    },

    // Session continuation (decision D3 on #43). With its tab alive, the
    // stalled process is stopped, the harness resumes the same session in
    // the same terminal, and `prompt` is typed to it; the dispatch is
    // unchanged, so the worker's preamble IDs still settle it. With the tab
    // gone (`reopen`, or the tab refusing input) the resume runs in a new
    // terminal in the same worktree, and worker-start adopts it with `prompt`
    // as its spec: Orca settles a dispatch only from the pane it was issued
    // to, so the new pane needs a new dispatch, whose preamble the prompt
    // points the agent at.
    async workerContinue({ run, dispatch, terminal, worktree, title, prompt, harness = 'claude', model, effort, permissionMode, sessionId, reopen = false }) {
      const command = resumeCommand({ harness, model, effort, permissionMode, sessionId })
      if (!reopen && terminal) {
        try {
          // Claude exits only on two Ctrl-Cs close together: two sequential
          // sends a second apart were not enough (live, Orca 1.4.209). At a
          // shell prompt, as after the agent exited, they are harmless.
          const interrupt = () => orca(['terminal', 'send', '--terminal', terminal, '--interrupt'])
          await Promise.all([interrupt(), interrupt()])
          await interrupt()
          await orca(['terminal', 'send', '--terminal', terminal, '--text', command, '--enter'])
          await waitIdle(terminal, command)
          await orca(['terminal', 'send', '--terminal', terminal, '--text', prompt, '--enter'])
          return { dispatchId: dispatch, terminal, worktree, reopened: false }
        } catch (e) {
          if (!TAB_GONE.has(e?.code)) throw e
        }
      }
      const place = worktree ? ['--worktree', `path:${worktree}`] : ['--worktree', 'current']
      const t = await orca(['terminal', 'create', ...(worktree ? place : []), '--title', title, '--command', command])
      const handle = t.terminal.handle
      try {
        await waitIdle(handle, command)
        const r = await orca(workerStartArgs({ run, prompt, title, place, terminal: handle }))
        return { dispatchId: r.dispatchId, taskId: r.taskId, terminal: handle, worktree: worktree ?? pathOf(t.terminal.worktreeId), reopened: true }
      } catch (e) {
        await closeQuietly(handle)
        throw e
      }
    },

    // Orca's release keeps a terminal the worker did not create — every one
    // the runner launched — so a reclaim closes the tab itself (terminalClose).
    async workerRelease({ dispatch }) {
      await orca(['orchestration', 'worker-release', '--dispatch', dispatch])
    },

    // The handles of the tabs open now. A closed tab is absent from the list,
    // though `terminal show` still answers for it, orphaned. Never read
    // openness from a worker's `retained` state: Orca sets it for good on any
    // terminal the runner launched, closed or not (ADR-0012).
    async terminalList() {
      const r = await orca(['terminal', 'list'])
      return (r?.terminals ?? []).filter((t) => t && !t.orphaned && t.handle).map((t) => t.handle)
    },

    async terminalClose({ terminal }) {
      await orca(['terminal', 'close', '--terminal', terminal, '--tab'])
    },

    // Brings the tab to the front, and its worktree with it. A closed tab
    // fails terminal_exited; one Orca never issued, terminal_handle_stale.
    async terminalSwitch({ terminal }) {
      const r = await orca(['terminal', 'switch', '--terminal', terminal])
      return { terminal: r?.focus?.handle ?? terminal, worktreeId: r?.focus?.worktreeId ?? null }
    },

    // Opens a file in Orca's editor. Orca takes the worktree from the cwd and
    // opens only a file inside it: a path outside fails runtime_error
    // invalid_relative_path, and a missing one runtime_error (ENOENT).
    async fileOpen({ path }) {
      await orca(['file', 'open', '--path', path])
    },

    // A tab of its own, in the caller's worktree and brought to the front,
    // that shows the log's last lines and follows it as it grows. This is how
    // a file outside every worktree is shown in Orca, which fileOpen cannot:
    // the run dir, runner.log's, is outside every checkout. On Windows the tab
    // runs PowerShell whatever the operator's default shell is.
    async logTail({ path, title }) {
      const shell = platform === 'win32' ? ['--shell', 'powershell.exe'] : []
      const r = await orca(['terminal', 'create', '--worktree', 'current', '--title', title, ...shell, '--command', tailCommand(path, platform), '--focus'])
      return { terminal: r?.terminal?.handle ?? null }
    },

    // A dead runner's run taken up again: a new tab in the run's worktree,
    // brought to the front, running the runner with --resume, which takes the
    // Run over from there. A worktree Orca no longer knows fails
    // selector_not_found. PowerShell on Windows, as logTail.
    async resumeRunner({ worktree, title, runner, script, stateDir, permissionMode = null }) {
      const command = resumeRunnerCommand({ runner, script, stateDir, permissionMode }, platform)
      const shell = platform === 'win32' ? ['--shell', 'powershell.exe'] : []
      const r = await orca(['terminal', 'create', '--worktree', `path:${worktree}`, '--title', title, ...shell, '--command', command, '--focus'])
      return { terminal: r?.terminal?.handle ?? null, command }
    },

    // Always forced: Orca refuses a dirty worktree otherwise, and uncommitted
    // files never keep one (D6 on #43). Whether it holds unpushed commits is
    // the caller's check (reclaim.mjs), made before this. A worktree Orca no
    // longer knows fails `selector_not_found`.
    async worktreeRemove({ path }) {
      await orca(['worktree', 'rm', '--worktree', `path:${path}`, '--force'])
    },

    // Sets the tab label the operator sees. `terminal show` keeps reporting
    // the agent's own title, so never look a tab up by what this sets.
    async terminalRename({ terminal, title }) {
      await orca(['terminal', 'rename', '--terminal', terminal, '--title', title])
    },

    // Sent by submit from inside the worker's own pane: Orca settles a
    // Dispatch only on a worker_done from the pane it was dispatched to.
    async workerDone({ from, capability, taskId, dispatchId, subject, body }) {
      const args = ['orchestration', 'send', '--type', 'worker_done', '--outcome', 'succeeded', '--subject', subject, '--body', body, '--task-id', taskId, '--dispatch-id', dispatchId]
      if (from) args.push('--from', from)
      if (capability) args.push('--dispatch-capability', capability)
      await orca(args)
    },
  }
}
