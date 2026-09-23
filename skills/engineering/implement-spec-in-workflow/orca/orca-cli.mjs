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

export function orcaCli({ bin = process.env.ORCA_BIN || 'orca' } = {}) {
  // No shell: arguments reach Orca verbatim, prompts included. Windows still
  // caps a command line at 32767 characters, so one prompt must stay under it.
  function call(args) {
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

  return {
    // Run from the runner's own terminal: Orca binds the Run to the caller
    // and refuses a mutation made on another terminal's behalf.
    async runCreate({ objective }) {
      const r = await call(['orchestration', 'run-create', '--objective', objective])
      return { runId: r.run?.id ?? r.id }
    },

    async workerStart({ run, prompt, title, agent = 'claude' }) {
      const r = await call(['orchestration', 'worker-start', '--run', run, '--spec', prompt, '--task-title', title, '--agent', agent, '--worktree', 'current'])
      const tab = (r.effects || []).find((e) => e.kind === 'terminal' && e.role === 'agent')
      return { dispatchId: r.dispatchId, taskId: r.taskId, mode: r.mode?.mode ?? null, modeDetail: r.mode?.detail ?? '', terminal: tab?.id ?? null }
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
