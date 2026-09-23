// An in-memory Orca behind the same methods as orca-cli.mjs. Each started
// worker is played by `worker`, an async function handed what a real worker
// gets — its prompt and the IDs its injected preamble would carry — plus
// `state`, the Orca-side view of it a test scripts deaths through: set `gone`,
// `exited`, `idle`, `waiting` or `lastOutputAt`, and `onNudge` to react to a
// nudge. `calls` records every Orca call in order, stamped with `clock`'s time
// when one is given, so a test can assert on the sequence and its timing.
// `worktrees` holds every worktree Orca knows, the run's own included, by path.
import { OrcaError } from './orca-cli.mjs'

export function fakeOrca({ worker = async () => {}, clock = null, runWorktree = 'C:/fake/run' } = {}) {
  const calls = []
  const dispatches = new Map()
  const worktrees = new Map([[runWorktree, { parent: null, name: null, displayName: null, removed: false }]])
  let seq = 0
  let runs = 0
  const record = (c) => calls.push(clock ? { ...c, at: clock.now() } : c)

  function dispatch(id, verb) {
    const d = dispatches.get(id)
    if (!d) throw new OrcaError('dispatch_not_found', `no dispatch ${id}`, verb)
    return d
  }

  function terminal(handle, verb) {
    const d = [...dispatches.values()].find((x) => x.handle === handle)
    if (!d || d.gone) throw new OrcaError('terminal_handle_stale', 'terminal_handle_stale', verb)
    return d
  }

  const orca = {
    calls,
    dispatches,
    worktrees,

    async runCreate({ objective }) {
      record({ verb: 'runCreate', objective })
      return { runId: `run_fake${++runs}` }
    },

    async workerStart({ run, prompt, title, harness = 'claude', model, effort, permissionMode, child = null }) {
      const n = ++seq
      const preamble = { handle: `term_fake${n}`, capability: `cap_fake${n}`, taskId: `task_fake${n}`, dispatchId: `ctx_fake${n}` }
      const launch = { harness, model, effort, permissionMode }
      let worktree = runWorktree
      if (child) {
        worktree = `C:/fake/worktrees/${child.name}`
        if (worktrees.has(worktree)) throw new OrcaError('worktree_exists', `${worktree} already exists`, 'orchestration worker-start')
        worktrees.set(worktree, { parent: runWorktree, name: child.name, displayName: child.displayName, removed: false })
      }
      // Like Claude Code, the agent titles its own tab from its prompt.
      const d = {
        ...preamble, run, title, ...launch, prompt, worktree, tabTitle: prompt.slice(0, 30), settled: false, outcome: null, released: false, stopped: false,
        gone: false, exited: false, idle: false, waiting: null, lastOutputAt: null, onNudge: null, nudges: [],
      }
      dispatches.set(d.dispatchId, d)
      record({ verb: 'workerStart', dispatchId: d.dispatchId, title, ...launch, placement: child ? 'new-child' : 'current', worktree })
      // A worker that throws is an agent that died: its Dispatch fails.
      d.finished = Promise.resolve()
        .then(() => worker({ prompt, preamble, worktree, orca, state: d }))
        .catch((e) => {
          d.error = e
          if (!d.settled) Object.assign(d, { settled: true, outcome: 'failed' })
        })
      return { dispatchId: d.dispatchId, taskId: d.taskId, mode: 'terminal', modeDetail: '', terminal: d.handle, worktree }
    },

    async workerShow({ dispatch: id }) {
      const d = dispatch(id, 'orchestration worker-show')
      record({ verb: 'workerShow', dispatchId: id, settled: d.settled })
      return { settled: d.settled, outcome: d.outcome, terminal: d.handle, gone: d.gone, exited: d.exited, waiting: d.waiting, lastOutputAt: d.lastOutputAt }
    },

    async terminalIdle({ terminal: handle }) {
      return terminal(handle, 'terminal wait').idle
    },

    async terminalSend({ terminal: handle, text }) {
      const d = terminal(handle, 'terminal send')
      record({ verb: 'terminalSend', dispatchId: d.dispatchId, text })
      d.nudges.push(text)
      await d.onNudge?.(text)
    },

    async workerStop({ dispatch: id }) {
      const d = dispatch(id, 'orchestration worker-stop')
      record({ verb: 'workerStop', dispatchId: id })
      d.stopped = true
    },

    async workerRelease({ dispatch: id }) {
      const d = dispatch(id, 'orchestration worker-release')
      record({ verb: 'workerRelease', dispatchId: id })
      d.released = true
    },

    async terminalRename({ terminal, title }) {
      const d = [...dispatches.values()].find((x) => x.handle === terminal && !x.released)
      if (!d) throw new OrcaError('terminal_handle_stale', `no terminal ${terminal}`, 'terminal rename')
      record({ verb: 'terminalRename', dispatchId: d.dispatchId, title })
      d.tabTitle = title
    },

    // Real Orca settles a Dispatch only for the exact pane and IDs it issued.
    async workerDone({ from, capability, taskId, dispatchId, subject, body }) {
      const d = dispatch(dispatchId, 'orchestration send')
      if (d.taskId !== taskId || d.handle !== from || d.capability !== capability) {
        throw new OrcaError('consumer_fenced', `worker_done for ${dispatchId} does not match its preamble`, 'orchestration send')
      }
      record({ verb: 'workerDone', dispatchId, subject, body })
      Object.assign(d, { settled: true, outcome: 'succeeded' })
    },

    // Not an adapter method: the runner never removes a worktree. This is the
    // `orca worktree rm --worktree path:<path> --force` a reclaimer runs itself.
    async worktreeRemove({ path }) {
      const w = worktrees.get(path)
      if (!w || w.removed) throw new OrcaError('selector_not_found', `no worktree ${path}`, 'worktree rm')
      record({ verb: 'worktreeRemove', path })
      w.removed = true
    },
  }
  return orca
}
