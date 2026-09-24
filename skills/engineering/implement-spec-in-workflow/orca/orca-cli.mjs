// The one place the Orca runner and submit talk to Orca (ADR-0011). Callers
// see only the plain shapes these methods return; the JSON field names of
// Orca's `--json` output (as of 1.4.207) stay in this file. fake-orca.mjs
// implements the same methods, which is what lets the tests run offline.
import { execFile } from 'child_process'
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
  let argv
  const session = sessionId && ['--session-id', sessionId]
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

// The one worker-start argv: it adopts a terminal the runner made, so it never
// carries --agent. fake-orca.mjs builds its starts from this too.
export const workerStartArgs = ({ run, prompt, title, place, terminal }) =>
  ['orchestration', 'worker-start', '--run', run, '--spec', prompt, '--task-title', title, ...place, '--terminal', terminal]

// The path half of a `<repoId>::<path>` worktree id.
const pathOf = (id) => (typeof id === 'string' && id.includes('::') ? id.slice(id.indexOf('::') + 2) : null)

// The last segment of a worktree path: the name `worktree create --name` gave
// it, suffixed -2, -3… when that name was taken.
const nameOf = (path) => String(path).split(/[\\/]/).pop()

// call(args, timeoutMs) and git(cwd, args, timeoutMs) run one Orca or git
// command; clock.timer bounds every call at callMs, plus any wait it asks for.
export function orcaCli({ bin = process.env.ORCA_BIN || 'orca', call = execOrca(bin), git = execGit, clock = { timer: realTimer }, callMs = RUNNER_SETTINGS.orcaCallMs } = {}) {
  // Terminals this runner created for a custom launch, by dispatch. Orca's
  // release retains a terminal the worker did not create, so the runner
  // closes these itself once the worker is released.
  const ownTerminals = new Map()

  const orca = (args, waitMs = 0) => withTimeout(clock, callMs + waitMs, call(args, callMs + waitMs), args.slice(0, 2).join(' '))
  const gitIn = (cwd, args) => withTimeout(clock, callMs, git(cwd, args, callMs), `git ${args[0]}`)

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

  // The worktree an earlier attempt of this start made, if there is one to
  // take up: Orca answers a second `worktree create --name` with a new
  // <name>-2, never an error, so a retry looks its name up first. One that
  // holds work is refused for good, named on the error; one an agent still
  // runs in is refused for this attempt only.
  async function earlierWorktree(name) {
    const r = await orca(['worktree', 'list'])
    const row = (r?.worktrees ?? []).find((w) => typeof w.path === 'string' && nameOf(w.path) === name)
    if (!row) return null
    const path = row.path
    const refuse = (code, why, final) => Object.assign(new OrcaError(code, `${path} ${why}`, 'worktree reuse'), { worktree: path, final })
    // terminal list leaves closed tabs out, and agentIdentity marks an agent's pane.
    const t = await orca(['terminal', 'list', '--worktree', `path:${path}`])
    if ((t?.terminals ?? []).some((x) => x.agentIdentity && !x.orphaned)) throw refuse('worktree_held', 'still has an agent running in it', false)
    if ((await gitIn(path, ['status', '--porcelain'])).trim()) throw refuse('worktree_dirty', 'has uncommitted changes', true)
    // Commits on its branch that no other branch holds: work of its own.
    const branch = String(row.branch ?? '').replace(/^refs\/heads\//, '')
    const own = Number((await gitIn(path, ['rev-list', '--count', 'HEAD', '--not', `--exclude=${branch}`, '--branches', '--remotes'])).trim())
    if (own > 0) throw refuse('worktree_has_commits', `has ${own} commit(s) of its own`, true)
    return path
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
    // names it as the error's `worktree`; `final` marks one a retry cannot mend.
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
      if (child) {
        worktree = child.retry ? await earlierWorktree(child.name) : null
        if (!worktree) {
          const c = await orca(['worktree', 'create', '--name', child.name, '--parent-worktree', 'current'])
          worktree = createdPath(c)
          if (!worktree) throw new OrcaError('bad_output', `worktree create named no path for ${child.name}`, 'worktree create')
          // Orca opens a plain shell in a new worktree; the agent gets its own.
          if (c?.startupTerminal?.handle) await closeQuietly(c.startupTerminal.handle)
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
      try {
        const t = await orca(['terminal', 'create', ...terminalIn, '--title', title, '--command', command])
        handle = t.terminal.handle
        await waitIdle(handle, command)
        const r = await orca(workerStartArgs({ run, prompt, title, place, terminal: handle }))
        ownTerminals.set(r.dispatchId, handle)
        const effect = (r.effects || []).find((e) => e.kind === 'worktree')?.id
        return { dispatchId: r.dispatchId, taskId: r.taskId, terminal: handle, worktree: worktree ?? pathOf(effect) ?? pathOf(t.terminal.worktreeId), warnings }
      } catch (e) {
        if (handle) await closeQuietly(handle)
        // The caller names a worktree made for a worker that never started.
        if (worktree && e instanceof Object) e.worktree = worktree
        throw e
      }
    },

    // Board status of a worktree the runner created, by path: todo,
    // in-progress, in-review or completed.
    async worktreeStatus({ worktree, status }) {
      await orca(['worktree', 'set', '--worktree', `path:${worktree}`, '--workspace-status', status])
    },

    async workerShow({ dispatch }) {
      const r = await orca(['orchestration', 'worker-show', '--dispatch', dispatch])
      const handle = r.worker?.agentTerminalHandle ?? null
      // agentWait: an object is a wait only a human can answer; null means
      // Orca looked and found none; absent means it never looked.
      const wait = r.observation?.agentWait ?? r.terminal?.agentWait ?? null
      return {
        settled: r.worker?.stage === 'settled' || SETTLED_DISPATCH.has(r.dispatch?.status),
        outcome: r.projection?.outcome ?? r.worker?.state ?? null,
        terminal: handle,
        // A worker never given a terminal is not one whose terminal is gone.
        gone: Boolean(handle) && (!r.terminal || r.terminal.orphaned === true),
        exited: r.observation?.status === 'exited',
        waiting: wait && typeof wait === 'object' ? JSON.stringify(wait).slice(0, 300) : null,
        lastOutputAt: r.terminal?.lastOutputAt ?? null,
      }
    },

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

    async workerRelease({ dispatch }) {
      await orca(['orchestration', 'worker-release', '--dispatch', dispatch])
      const own = ownTerminals.get(dispatch)
      if (own) {
        ownTerminals.delete(dispatch)
        await closeQuietly(own)
      }
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
