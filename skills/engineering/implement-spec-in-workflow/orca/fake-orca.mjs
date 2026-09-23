// An in-memory Orca behind the same methods as orca-cli.mjs. Each started
// worker is played by `worker`, an async function handed what a real worker
// gets: its prompt and the IDs its injected preamble would carry. `calls`
// records every Orca call in order, so a test can assert on the sequence.
import { OrcaError } from './orca-cli.mjs'

export function fakeOrca({ worker = async () => {} } = {}) {
  const calls = []
  const dispatches = new Map()
  let seq = 0
  let runs = 0

  function dispatch(id, verb) {
    const d = dispatches.get(id)
    if (!d) throw new OrcaError('dispatch_not_found', `no dispatch ${id}`, verb)
    return d
  }

  const orca = {
    calls,
    dispatches,

    async runCreate({ objective }) {
      calls.push({ verb: 'runCreate', objective })
      return { runId: `run_fake${++runs}` }
    },

    async workerStart({ run, prompt, title, agent = 'claude' }) {
      const n = ++seq
      const preamble = { handle: `term_fake${n}`, capability: `cap_fake${n}`, taskId: `task_fake${n}`, dispatchId: `ctx_fake${n}` }
      // Like Claude Code, the agent titles its own tab from its prompt.
      const d = { ...preamble, run, title, agent, prompt, tabTitle: prompt.slice(0, 30), settled: false, outcome: null, released: false }
      dispatches.set(d.dispatchId, d)
      calls.push({ verb: 'workerStart', dispatchId: d.dispatchId, title })
      // A worker that throws is an agent that died: its Dispatch fails.
      d.finished = Promise.resolve()
        .then(() => worker({ prompt, preamble, orca }))
        .catch((e) => {
          d.error = e
          if (!d.settled) Object.assign(d, { settled: true, outcome: 'failed' })
        })
      return { dispatchId: d.dispatchId, taskId: d.taskId, mode: 'terminal', modeDetail: '', terminal: d.handle }
    },

    async workerShow({ dispatch: id }) {
      const d = dispatch(id, 'orchestration worker-show')
      calls.push({ verb: 'workerShow', dispatchId: id, settled: d.settled })
      return { settled: d.settled, outcome: d.outcome, terminal: d.handle }
    },

    async workerRelease({ dispatch: id }) {
      const d = dispatch(id, 'orchestration worker-release')
      calls.push({ verb: 'workerRelease', dispatchId: id })
      d.released = true
    },

    async terminalRename({ terminal, title }) {
      const d = [...dispatches.values()].find((x) => x.handle === terminal && !x.released)
      if (!d) throw new OrcaError('terminal_handle_stale', `no terminal ${terminal}`, 'terminal rename')
      calls.push({ verb: 'terminalRename', dispatchId: d.dispatchId, title })
      d.tabTitle = title
    },

    // Real Orca settles a Dispatch only for the exact pane and IDs it issued.
    async workerDone({ from, capability, taskId, dispatchId, subject, body }) {
      const d = dispatch(dispatchId, 'orchestration send')
      if (d.taskId !== taskId || d.handle !== from || d.capability !== capability) {
        throw new OrcaError('consumer_fenced', `worker_done for ${dispatchId} does not match its preamble`, 'orchestration send')
      }
      calls.push({ verb: 'workerDone', dispatchId, subject, body })
      Object.assign(d, { settled: true, outcome: 'succeeded' })
    },
  }
  return orca
}
