// An in-memory Orca behind the same methods as orca-cli.mjs. Each started
// worker is played by `worker`, an async function handed what a real worker
// gets — its prompt and the IDs its injected preamble would carry — plus
// `state`, the Orca-side view of it a test scripts deaths through: set `gone`,
// `exited`, `idle` or `waiting`, grow `transcript` (its session transcript's
// size in bytes, read through fakeTranscripts), set `onNudge` to react to a
// nudge and `onContinue` to play the session once it is continued. `calls`
// records every Orca call in order, stamped with `clock`'s time when one is
// given, so a test can assert on the sequence and its timing. `worktrees`
// holds every worktree Orca knows, the run's own included, by path, with the
// board `status` last set on it, the `dirty` and `commits` a retried start
// checks before taking it up, and `unpushed`, the commits a test says its
// HEAD holds that no remote-tracking ref contains (git's side, not Orca's:
// `unpushedOf` answers for it). Every worker's terminal is one the runner
// launched, so, as in real Orca, its `terminalState` is `retained` for good;
// whether its tab is open is `terminalList`'s to say.
//
// `faults` fails a step the way real Orca can: step -> ({ count, ...ctx }) =>
// an error to throw, 'hang' for a call Orca never answers (it fails as the
// adapter's call timeout does, on `clock`), or nothing. count is how many
// times that step has run, and orca this fake, so a fault can also change
// what Orca holds, a worktree's `dirty` for one. Steps: runCreate, worktreeStatus, and a start's
// worktreeCreate, worktreeSet, terminalCreate, waitIdle and workerStart, the
// order the adapter runs them in.
import { OrcaError, launchCommand, resumeCommand, workerStartArgs, withTimeout } from './orca-cli.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'

// The runner's transcript reader, over the fake's sessions: a session's size
// is its latest dispatch's `transcript`, which a continuation carries over.
export const fakeTranscripts = (orca) => ({
  size: ({ sessionId }) => [...orca.dispatches.values()].filter((d) => d.sessionId === sessionId).at(-1)?.transcript ?? null,
})

export function fakeOrca({ worker = async () => {}, clock = null, runWorktree = 'C:/fake/run', runPrefix = 'run_fake', coordinator = 'term_runner', faults = {}, callMs = RUNNER_SETTINGS.orcaCallMs } = {}) {
  const calls = []
  const dispatches = new Map()
  const worktrees = new Map([[runWorktree, { parent: null, name: null, displayName: null, removed: false, status: null, dirty: false, commits: 0, unpushed: 0 }]])
  const counts = {}
  let seq = 0
  let runs = 0
  const record = (c) => calls.push(clock ? { ...c, at: clock.now() } : c)

  async function step(name, ctx = {}) {
    counts[name] = (counts[name] ?? 0) + 1
    const f = faults[name]?.({ ...ctx, count: counts[name], orca })
    if (f === 'hang') {
      if (!clock) throw new Error(`fake orca: ${name} hangs, but no clock was given to time it out`)
      await withTimeout(clock, callMs, new Promise(() => {}), name)
    }
    if (f) throw f
  }

  function dispatch(id, verb) {
    const d = dispatches.get(id)
    if (!d) throw new OrcaError('dispatch_not_found', `no dispatch ${id}`, verb)
    return d
  }

  // Real Orca still knows a closed tab: a verb aimed at it is refused with
  // `closed`, and only a handle it never issued is stale.
  function terminal(handle, verb, closed = 'terminal_handle_stale') {
    const d = [...dispatches.values()].find((x) => x.handle === handle)
    if (!d) throw new OrcaError('terminal_handle_stale', 'terminal_handle_stale', verb)
    if (d.gone) throw new OrcaError(closed, closed, verb)
    return d
  }

  // As the real adapter decides it: the worktree a retry takes up, by name.
  function earlierWorktree(name) {
    const found = [...worktrees].find(([, w]) => w.name === name && !w.removed)
    if (!found) return null
    const [path, w] = found
    const refuse = (code, why, final) => Object.assign(new OrcaError(code, `${path} ${why}`, 'worktree reuse'), { worktree: path, final })
    if ([...dispatches.values()].some((d) => d.worktree === path && !d.released)) throw refuse('worktree_held', 'still has an agent running in it', false)
    if (w.dirty) throw refuse('worktree_dirty', 'has uncommitted changes', true)
    if (w.commits > 0) throw refuse('worktree_has_commits', `has ${w.commits} commit(s) of its own`, true)
    record({ verb: 'worktreeReuse', worktree: path })
    return path
  }

  // Plays a started or continued session: a worker that throws is an agent
  // that died, so its Dispatch fails.
  function play(d, fn) {
    d.finished = Promise.resolve()
      .then(fn)
      .catch((e) => {
        d.error = e
        if (!d.settled) Object.assign(d, { settled: true, outcome: 'failed' })
      })
  }

  const preambleOf = (n) => ({ handle: `term_fake${n}`, capability: `cap_fake${n}`, taskId: `task_fake${n}`, dispatchId: `ctx_fake${n}` })
  const preambleIn = (d) => ({ handle: d.handle, capability: d.capability, taskId: d.taskId, dispatchId: d.dispatchId })
  const fresh = () => ({ settled: false, outcome: null, released: false, stopped: false, gone: false, exited: false, idle: false, waiting: null, nudges: [] })

  const orca = {
    calls,
    dispatches,
    worktrees,

    async runCreate({ objective }) {
      await step('runCreate', { objective })
      record({ verb: 'runCreate', objective })
      return { runId: `${runPrefix}${++runs}`, terminal: coordinator }
    },

    // Only the custom launch exists: the harness command, carrying the
    // runner's session id, in a terminal worker-start then adopts. `command`
    // and `argv` are what the real adapter would type and run.
    async workerStart({ run, prompt, title, harness = 'claude', model, effort, permissionMode, sessionId, child = null }) {
      if (!sessionId) throw new Error(`fake orca: ${title} was started without a runner-assigned --session-id`)
      const command = launchCommand({ harness, model, effort, permissionMode, sessionId })
      const preamble = preambleOf(++seq)
      const launch = { harness, model, effort, permissionMode }
      const warnings = []
      let worktree = runWorktree
      let made = null
      if (child) {
        made = child.retry ? earlierWorktree(child.name) : null
        if (!made) {
          await step('worktreeCreate', { name: child.name })
          // Real Orca never refuses a taken name: it makes <name>-2.
          let name = child.name
          for (let i = 2; worktrees.has(`C:/fake/worktrees/${name}`); i++) name = `${child.name}-${i}`
          made = `C:/fake/worktrees/${name}`
          worktrees.set(made, { parent: runWorktree, name, displayName: name, removed: false, status: null, dirty: false, commits: 0, unpushed: 0 })
          record({ verb: 'worktreeCreate', name: child.name, worktree: made })
        }
        worktree = made
        try {
          await step('worktreeSet', { worktree })
          worktrees.get(worktree).displayName = child.displayName
        } catch (e) {
          warnings.push(`could not set its worktree's display name: ${e?.message ?? e}`)
        }
      }
      let opened = false
      try {
        await step('terminalCreate', { title, worktree: made })
        opened = true
        await step('waitIdle', { title, worktree: made })
        await step('workerStart', { title, worktree: made })
      } catch (e) {
        if (opened) record({ verb: 'terminalClose', terminal: preamble.handle })
        if (made && e instanceof Object) e.worktree = made
        throw e
      }
      const argv = workerStartArgs({ run, prompt, title, place: ['--worktree', child ? `path:${worktree}` : 'current'], terminal: preamble.handle })
      if (argv.includes('--agent')) throw new Error(`fake orca: worker-start for ${title} was called with --agent`)
      // Like Claude Code, the agent titles its own tab from its prompt.
      const d = {
        ...preamble, run, title, ...launch, sessionId, command, prompt, worktree, tabTitle: prompt.slice(0, 30), ...fresh(), transcript: null, onNudge: null, onContinue: null, terminalState: 'retained',
      }
      dispatches.set(d.dispatchId, d)
      record({ verb: 'workerStart', dispatchId: d.dispatchId, title, ...launch, sessionId, command, argv, placement: child ? 'new-child' : 'current', worktree })
      play(d, () => worker({ prompt, preamble, worktree, orca, state: d }))
      return { dispatchId: d.dispatchId, taskId: d.taskId, terminal: d.handle, worktree, warnings }
    },

    // The session resumed with the harness's resume command: in the same
    // terminal and dispatch while the tab is alive, else in a new terminal in
    // the same worktree that a new dispatch adopts. The continued session is
    // played by the `onContinue` its state carries, handed the worker's
    // original prompt and the preamble it now holds.
    async workerContinue({ run, dispatch: id, terminal: handle, worktree, title, prompt: text, harness = 'claude', model, effort, permissionMode, sessionId, reopen = false }) {
      const d = dispatch(id, 'terminal send')
      if (sessionId !== d.sessionId) throw new Error(`fake orca: ${title} was continued with session ${sessionId}, not its own ${d.sessionId}`)
      const command = resumeCommand({ harness, model, effort, permissionMode, sessionId })
      const continued = d.continued ?? 0
      let c = d
      if (!reopen && !d.gone) {
        if (handle !== d.handle) throw new Error(`fake orca: ${title} was continued in ${handle}, not its own terminal ${d.handle}`)
        // The stalled process is interrupted, and the resume typed after it.
        record({ verb: 'workerContinue', dispatchId: id, terminal: d.handle, worktree: d.worktree, command, text, reopened: false, interrupted: true })
        Object.assign(d, { gone: false, exited: false, idle: false, waiting: null })
      } else {
        const preamble = preambleOf(++seq)
        c = { ...d, ...preamble, run, title, command, worktree, ...fresh(), from: id }
        dispatches.set(c.dispatchId, c)
        const argv = workerStartArgs({ run, prompt: text, title, place: ['--worktree', worktree ? `path:${worktree}` : 'current'], terminal: c.handle })
        record({ verb: 'workerContinue', dispatchId: c.dispatchId, from: id, terminal: c.handle, worktree, command, text, argv, reopened: true, interrupted: false })
      }
      c.continued = continued + 1
      play(c, () => c.onContinue?.({ prompt: d.prompt, text, preamble: preambleIn(c), worktree: c.worktree, orca, state: c }))
      return { dispatchId: c.dispatchId, taskId: c.taskId, terminal: c.handle, worktree: c.worktree, reopened: c !== d }
    },

    async workerShow({ dispatch: id }) {
      const d = dispatch(id, 'orchestration worker-show')
      record({ verb: 'workerShow', dispatchId: id, settled: d.settled })
      return { settled: d.settled, outcome: d.outcome, terminal: d.handle, gone: d.gone, exited: d.exited, waiting: d.waiting }
    },

    async terminalIdle({ terminal: handle }) {
      return terminal(handle, 'terminal wait').idle
    },

    async terminalSend({ terminal: handle, text }) {
      const d = terminal(handle, 'terminal send', 'terminal_not_writable')
      record({ verb: 'terminalSend', dispatchId: d.dispatchId, text })
      d.nudges.push(text)
      await d.onNudge?.(text)
    },

    // A stopped Dispatch is cancelled: settled, so no longer live.
    async workerStop({ dispatch: id }) {
      const d = dispatch(id, 'orchestration worker-stop')
      record({ verb: 'workerStop', dispatchId: id })
      d.stopped = true
      if (!d.settled) Object.assign(d, { settled: true, outcome: 'cancelled' })
    },

    // Orca keeps a tab the worker did not create: releasing closes nothing.
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

    async worktreeStatus({ worktree, status }) {
      await step('worktreeStatus', { worktree, status })
      const w = worktrees.get(worktree)
      if (!w || w.removed) throw new OrcaError('selector_not_found', `no worktree ${worktree}`, 'worktree set')
      record({ verb: 'worktreeStatus', worktree, status })
      w.status = status
    },

    // Open tabs only: the runner's own, and every worker's whose tab is
    // neither gone nor closed. No row names a run or a dispatch.
    async terminalList() {
      record({ verb: 'terminalList' })
      return [coordinator, ...[...dispatches.values()].filter((d) => !d.gone).map((d) => d.handle)]
    },

    async terminalClose({ terminal: handle }) {
      const d = [...dispatches.values()].find((x) => x.handle === handle)
      if (!d) throw new OrcaError('terminal_handle_stale', `no terminal ${handle}`, 'terminal close')
      if (d.gone) throw new OrcaError('terminal_exited', `terminal ${handle} has exited`, 'terminal close')
      record({ verb: 'terminalClose', dispatchId: d.dispatchId, terminal: handle })
      d.gone = true
    },

    // `orca worktree rm --force`: it also kills every terminal in the worktree.
    async worktreeRemove({ path }) {
      const w = worktrees.get(path)
      if (!w || w.removed) throw new OrcaError('selector_not_found', `no worktree ${path}`, 'worktree rm')
      record({ verb: 'worktreeRemove', path })
      w.removed = true
      for (const d of dispatches.values()) if (d.worktree === path) d.gone = true
    },

    // Not Orca: git's answer for a fake worktree, in reclaim's `unpushed` shape.
    unpushedOf: async (path) => worktrees.get(path)?.unpushed ?? 0,
  }
  return orca
}
