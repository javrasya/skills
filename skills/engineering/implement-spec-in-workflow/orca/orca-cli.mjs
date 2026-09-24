// The one place the Orca runner and submit talk to Orca (ADR-0011). Callers
// see only the plain shapes these methods return; the JSON field names of
// Orca's `--json` output (as of 1.4.207) stay in this file. fake-orca.mjs
// implements the same methods, which is what lets the tests run offline.
import { execFile } from 'child_process'

export class OrcaError extends Error {
  constructor(code, message, verb) {
    super(`orca ${verb}: ${code}${message ? ': ' + message : ''}`)
    this.code = code
  }
}

const SETTLED_DISPATCH = new Set(['completed', 'failed', 'cancelled', 'canceled'])

// No shell: arguments reach Orca verbatim, prompts included. Windows still
// caps a command line at 32767 characters, so one prompt must stay under it.
function execOrca(bin) {
  return (args) => {
    const verb = args.slice(0, 2).join(' ')
    return new Promise((resolve, reject) => {
      execFile(bin, [...args, '--json'], { maxBuffer: 64 << 20, windowsHide: true }, (err, stdout, stderr) => {
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

export function orcaCli({ bin = process.env.ORCA_BIN || 'orca', call = execOrca(bin) } = {}) {
  // Terminals this runner created for a custom launch, by dispatch. Orca's
  // release retains a terminal the worker did not create, so the runner
  // closes these itself once the worker is released.
  const ownTerminals = new Map()

  const closeQuietly = (handle) => call(['terminal', 'close', '--terminal', handle]).catch(() => {})

  // A prompt typed into a TUI that is still starting is lost, so the worker is
  // dispatched only once the agent sits idle. A timed-out wait may exit 1 or
  // print satisfied:false; either way it is retried once, longer.
  async function waitIdle(handle, command) {
    for (const ms of [60000, 180000]) {
      try {
        const r = await call(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(ms)])
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

  return {
    // Run from the runner's own terminal: Orca binds the Run to the caller
    // and refuses a mutation made on another terminal's behalf.
    async runCreate({ objective }) {
      const r = await call(['orchestration', 'run-create', '--objective', objective])
      return { runId: r.run?.id ?? r.id }
    },

    // No `child`: the worker runs in the coordinator's worktree — the runner's,
    // which is the run's. `child: { name, displayName }`: in a new Orca child
    // worktree of it. Either way `worktree` is the path it runs in, and
    // `terminal` the handle of the tab the runner made for it.
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
      if (child) {
        const c = await call(['worktree', 'create', '--name', child.name, '--parent-worktree', 'current'])
        worktree = createdPath(c)
        if (!worktree) throw new OrcaError('bad_output', `worktree create named no path for ${child.name}`, 'worktree create')
        place = terminalIn = ['--worktree', `path:${worktree}`]
        // Orca opens a plain shell in a new worktree; the agent gets its own.
        if (c?.startupTerminal?.handle) await closeQuietly(c.startupTerminal.handle)
        // worktree create has no --display-name.
        await call(['worktree', 'set', ...place, '--display-name', child.displayName]).catch(() => {})
      }
      let handle = null
      try {
        const t = await call(['terminal', 'create', ...terminalIn, '--title', title, '--command', command])
        handle = t.terminal.handle
        await waitIdle(handle, command)
        const r = await call(workerStartArgs({ run, prompt, title, place, terminal: handle }))
        ownTerminals.set(r.dispatchId, handle)
        const effect = (r.effects || []).find((e) => e.kind === 'worktree')?.id
        return { dispatchId: r.dispatchId, taskId: r.taskId, terminal: handle, worktree: worktree ?? pathOf(effect) ?? pathOf(t.terminal.worktreeId) }
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
      await call(['worktree', 'set', '--worktree', `path:${worktree}`, '--workspace-status', status])
    },

    async workerShow({ dispatch }) {
      const r = await call(['orchestration', 'worker-show', '--dispatch', dispatch])
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
        await call(['terminal', 'wait', '--terminal', terminal, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs)])
        return true
      } catch (e) {
        if (e.code === 'timeout') return false
        throw e
      }
    },

    // Typed into the worker's TUI as a prompt: a mailbox message would wait
    // for a check the idle agent never makes.
    async terminalSend({ terminal, text }) {
      await call(['terminal', 'send', '--terminal', terminal, '--text', text, '--enter'])
    },

    async workerStop({ dispatch }) {
      await call(['orchestration', 'worker-stop', '--dispatch', dispatch])
    },

    async workerRelease({ dispatch }) {
      await call(['orchestration', 'worker-release', '--dispatch', dispatch])
      const own = ownTerminals.get(dispatch)
      if (own) {
        ownTerminals.delete(dispatch)
        await closeQuietly(own)
      }
    },

    // Sets the tab label the operator sees. `terminal show` keeps reporting
    // the agent's own title, so never look a tab up by what this sets.
    async terminalRename({ terminal, title }) {
      await call(['terminal', 'rename', '--terminal', terminal, '--title', title])
    },

    // Sent by submit from inside the worker's own pane: Orca settles a
    // Dispatch only on a worker_done from the pane it was dispatched to.
    async workerDone({ from, capability, taskId, dispatchId, subject, body }) {
      const args = ['orchestration', 'send', '--type', 'worker_done', '--outcome', 'succeeded', '--subject', subject, '--body', body, '--task-id', taskId, '--dispatch-id', dispatchId]
      if (from) args.push('--from', from)
      if (capability) args.push('--dispatch-capability', capability)
      await call(args)
    },
  }
}
