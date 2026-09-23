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

// What worker-start cannot carry: it has no permission-mode flag, it forwards
// --model/--effort to Claude only, and --effort only beside --model — pi's
// trust, model and thinking never reach pi through it (ADR-0011). A worker
// needing any of that starts from this command line instead; null means
// worker-start's own `--agent` launch carries everything asked for.
export function launchCommand({ harness = 'claude', model, effort, permissionMode }) {
  let argv
  if (harness === 'pi') {
    // --approve trusts project-local files: an unattended pi worker would
    // otherwise stop at pi's trust prompt with nobody to answer it.
    argv = ['pi', '--approve', model && ['--model', model], effort && ['--thinking', effort]]
  } else if (harness === 'claude') {
    if (!permissionMode && (model || !effort)) return null
    argv = ['claude', permissionMode && ['--permission-mode', permissionMode], model && ['--model', model], effort && ['--effort', effort]]
  } else {
    throw new Error(`unknown harness "${harness}": expected one of ${HARNESSES.join(', ')}`)
  }
  const words = argv.flat().filter(Boolean)
  const bad = words.find((w) => !WORD.test(w))
  if (bad) throw new Error(`refusing to type "${bad}" into a shell to launch ${harness}: use plain model, effort and mode names`)
  return words.join(' ')
}

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

  function receipt(r) {
    const tab = (r.effects || []).find((e) => e.kind === 'terminal' && e.role === 'agent')
    return { dispatchId: r.dispatchId, taskId: r.taskId, mode: r.mode?.mode ?? null, modeDetail: r.mode?.detail ?? '', terminal: tab?.id ?? null }
  }

  return {
    // Run from the runner's own terminal: Orca binds the Run to the caller
    // and refuses a mutation made on another terminal's behalf.
    async runCreate({ objective }) {
      const r = await call(['orchestration', 'run-create', '--objective', objective])
      return { runId: r.run?.id ?? r.id }
    },

    async workerStart({ run, prompt, title, harness = 'claude', model, effort, permissionMode }) {
      const command = launchCommand({ harness, model, effort, permissionMode })
      const start = ['orchestration', 'worker-start', '--run', run, '--spec', prompt, '--task-title', title, '--worktree', 'current']
      if (!command) {
        const launch = [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])]
        return receipt(await call([...start, '--agent', harness, ...launch]))
      }
      // Orca's documented route for custom argv under supervision: create the
      // agent's terminal, then worker-start takes ownership of it. The
      // terminal opens in the runner's worktree, which `current` names.
      const t = await call(['terminal', 'create', '--title', title, '--command', command])
      const handle = t.terminal.handle
      try {
        await waitIdle(handle, command)
        const r = await call([...start, '--terminal', handle])
        ownTerminals.set(r.dispatchId, handle)
        return { ...receipt(r), mode: 'terminal', terminal: handle }
      } catch (e) {
        await closeQuietly(handle)
        throw e
      }
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
