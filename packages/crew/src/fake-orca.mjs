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
// board `status` last set on it, the `porcelain` lines `git status
// --porcelain` gives in it and the `commits` a retried start checks before
// taking it up, and `unpushed`, the commits a test says its
// HEAD holds that no remote-tracking ref contains (git's side, not Orca's:
// `unpushedOf` answers for it), and the `setup` policy it was created with
// (`'skip'` for a doctor's, else null). Every worker's terminal is one the runner
// launched, so, as in real Orca, its `terminalState` is `retained` for good;
// whether its tab is open is `terminalList`'s to say. `setupLeaves` is the
// porcelain every child worktree is born with, as a setup hook's output.
//
// `promptLoss({ title, count, sessionId })` says how a start's prompt fails to
// reach its worker, as a dialog on the agent's launch makes it (count: the
// how-manieth start): `dialog`, left unsent in the input box until an Enter
// (terminalEnter); `lost`, gone, until typed again into an emptied input
// (terminalSend); `never`, not at all, its tab showing the dialog
// (terminalScreen); or nothing, delivered. Its worker plays only once it is
// delivered, and promptDelivered answers whether it has been.
//
// `faults` fails a step the way real Orca can: step -> ({ count, ...ctx }) =>
// an error to throw, 'hang' for a call Orca never answers (it fails as the
// adapter's call timeout does, on `clock`), or nothing. On worktreeCreate,
// 'hang-after' is a create Orca finishes but never answers: the worktree
// exists, and the call times out at `createMs`. count is how many
// times that step has run, and orca this fake, so a fault can also change
// what Orca holds, a worktree's `porcelain` for one. Steps: runCreate, worktreeStatus, worktreeLines, and a start's
// worktreeCreate, worktreeSet, terminalCreate, waitIdle and workerStart, the
// order the adapter runs them in, and runUse.
//
// Every call is made from a terminal, as a real runner's is from its own:
// fakeOrca() answers as `coordinator`, and as(handle) is the same Orca called
// from another terminal. Like real Orca, a Run is bound to the terminal that
// created it or last took it over with runUse, and worker-start into it from
// any other is refused consumer_fenced; read, stop and release are not fenced.
// A Run this fake did not create (a test's own runCreate) is not fenced.
// closeTab(handle) closes a runner's tab: Orca still holds its Runs. `tabs`
// are other tabs open from the start, such as earlier runners' own; a closed
// tab is gone from terminalList.
//
// A worker's tab closed (`gone`, by a test or by terminalClose) is failed by
// Orca itself, as real Orca does about 5 s after the close: worker-show then
// answers dispatch `failed` on an orphaned terminal. The fake fails it at once,
// so the runner never sees the window before, and reads worker-show through
// the adapter's own workerStatus.
//
// Each Run has a mailbox, as real Orca's (1.4.209): what its workers send
// (mailSend, a worker's `orchestration send`; workerDone's worker_done too)
// waits there until its coordinator checks it (mailCheck). A check freezes
// every waiting message into a batch, and hands that same batch back, marked
// replayed, until it is acknowledged; `ack` names the batch, and the answer is
// the next one. runUse re-batches an unacknowledged batch under a new
// delivery id, its messages' ids kept. A worker_done settles the dispatch
// that sent it. `mailCheck` is a step too, handed { ack, batch }: the batch's
// messages before the ack applies, so a fault can fail an ack.
//
// down(error) takes Orca away, as an update does (ADR-0015): every call the
// runner or the run view makes fails with `error`, one of orcaUnreachable's,
// until up(). A worker's own calls (mailSend, workerDone) come from its pane,
// not from the runner, and still land. guardWith(outage) waits each call, and
// each step of a start, on the runner's outage (outage.mjs), as the adapter
// waits each command; probe() is the outage's look, recorded as `probe`.
import { existsSync } from 'fs'
import { OrcaError, orcaUnreachable, afterCreateTimeout, resumeRunnerCommand, tailCommand, workerStartArgs, withTimeout, workerStatus } from './orca-cli.mjs'
import { reuseWorktree } from './worktree.mjs'
import { chainName } from './git.mjs'
import { launchCommand, resumeCommand } from './harness.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'

// The worktree table both offline Orcas keep, the in-memory one (fakeOrca)
// and the CLI one (fakeOrcaCli), so the two cannot come to disagree on how
// Orca makes and removes a worktree: by path, each made from the run's
// worktree as `name` was asked, or suffixed -2, -3… when that path is taken,
// as Orca does; the repo's setup policy leaving `setupLeaves` in it unless its
// `setup` is 'skip', and `setups` counting how often the policy ran at its
// path, a remake after a removal included. A removed one stays, marked so.
// The rest of an entry, `status`, `displayName`, `commits` and `unpushed`, is
// set by whichever Orca holds it, or by a test.
function fakeWorktrees({ runWorktree, setupLeaves }) {
  const table = new Map()
  const live = (path) => !!table.get(path) && !table.get(path).removed
  return {
    table,
    live,
    find: (name) => [...table].find(([, w]) => w.name === name && !w.removed) ?? null,
    create(asked, setup = null) {
      let name = asked
      for (let i = 2; live(`C:/fake/worktrees/${name}`); i++) name = `${asked}-${i}`
      const path = `C:/fake/worktrees/${name}`
      const skip = setup === 'skip'
      const setups = (table.get(path)?.setups ?? 0) + (skip ? 0 : 1)
      table.set(path, { parent: runWorktree, name, displayName: name, removed: false, status: null, porcelain: skip ? [] : [...setupLeaves], commits: 0, unpushed: 0, setup, setups })
      return { path, name }
    },
    remove(path) {
      table.get(path).removed = true
    },
  }
}

// The runner's transcript reader, over the fake's sessions: a session's size
// is its latest dispatch's `transcript`, which a continuation carries over.
export const fakeTranscripts = (orca) => ({
  size: ({ sessionId }) => [...orca.dispatches.values()].filter((d) => d.sessionId === sessionId).at(-1)?.transcript ?? null,
  path: ({ sessionId }) => `C:/fake/transcripts/${sessionId}.jsonl`,
})

export function fakeOrca({ worker = async () => {}, clock = null, runWorktree = 'C:/fake/run', runPrefix = 'run_fake', coordinator = 'term_runner', tabs = [], faults = {}, callMs = RUNNER_SETTINGS.hostCallMs, createMs = RUNNER_SETTINGS.worktreeCreateMs, setupLeaves = [], promptLoss = () => null } = {}) {
  const calls = []
  const dispatches = new Map()
  const table = fakeWorktrees({ runWorktree, setupLeaves })
  const worktrees = table.table
  worktrees.set(runWorktree, { parent: null, name: null, displayName: null, removed: false, status: null, porcelain: [], commits: 0, unpushed: 0 })
  // handle -> { path, title, open }: the tabs logTail opened.
  const logTabs = new Map()
  const counts = {}
  // runId -> { coordinator, generation }
  const runs = new Map()
  const closedTabs = new Set()
  const openTabs = new Set(tabs)
  let resumes = 0
  let seq = 0
  // runId -> { pending, batch: { id, messages } | null, acked }
  const mailboxes = new Map()
  let messages = 0
  let deliveries = 0
  const mailOf = (run) => {
    if (!mailboxes.has(run)) mailboxes.set(run, { pending: [], batch: null, acked: new Set() })
    return mailboxes.get(run)
  }
  const record = (c) => calls.push(clock ? { ...c, at: clock.now() } : c)
  let outage = null
  let gone = null
  // Where every call from the runner or the view meets Orca, there or not;
  // only while Orca is away, so a call with Orca there takes no extra turn.
  const away = () => !!gone || !!outage?.state()
  const reach = () => {
    const there = async () => {
      if (gone) throw gone
    }
    return outage ? outage.guard(there) : there()
  }

  async function hang(name, ms) {
    if (!clock) throw new Error(`fake orca: ${name} hangs, but no clock was given to time it out`)
    await withTimeout(clock, ms, new Promise(() => {}), name)
  }

  // Resolves 'hang-after' for its caller to act on; throws every other fault.
  async function step(name, ctx = {}, ms = callMs) {
    if (away()) await reach()
    counts[name] = (counts[name] ?? 0) + 1
    const f = faults[name]?.({ ...ctx, count: counts[name], orca })
    if (f === 'hang') await hang(name, ms)
    if (f === 'hang-after') return f
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

  // No process runs in a closed tab, so nothing calls Orca from one.
  function from(caller, verb) {
    if (closedTabs.has(caller)) throw new Error(`fake orca: ${verb} called from ${caller}, a tab that was closed`)
  }

  function fence(caller, run, verb) {
    from(caller, verb)
    const r = runs.get(run)
    if (r && r.coordinator !== caller) throw new OrcaError('consumer_fenced', `This coordinator terminal is no longer bound to Run ${run}`, verb)
  }

  // The worktree list, looked up by name as the adapter does.
  function findWorktree(name) {
    record({ verb: 'worktreeList', name })
    return table.find(name)
  }

  // The worktree a retry takes up, by name, decided by the rule every host shares
  // (worktree.mjs's reuseWorktree) on what this Orca holds.
  async function earlierWorktree(name, dispatched, baseline) {
    const found = findWorktree(name)
    if (!found) return null
    const [path, w] = found
    await reuseWorktree(path, { dispatched, baseline }, {
      // As the adapter's: an agent's tab still open in it.
      held: () => [...dispatches.values()].some((d) => d.worktree === path && !d.released && !d.gone),
      lines: () => w.porcelain,
      commits: () => w.commits,
    })
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
  const fresh = () => ({ settled: false, outcome: null, released: false, stopped: false, gone: false, exited: false, idle: false, waiting: null, nudges: [], delivery: null })

  // worker-show's answer, in real Orca's shape (live, Orca 1.4.209).
  const STATUS = { succeeded: 'completed', failed: 'failed', cancelled: 'cancelled' }
  const show = (d) => {
    const failedByClose = !d.settled && d.gone
    return workerStatus({
      worker: { agentTerminalHandle: d.handle, stage: d.settled ? 'settled' : failedByClose ? 'process_exited' : 'running' },
      dispatch: { status: d.settled ? STATUS[d.outcome] : failedByClose ? 'failed' : 'running' },
      projection: { outcome: d.settled ? d.outcome : failedByClose ? 'failed' : null },
      terminal: { orphaned: d.gone },
      observation: { status: d.exited ? 'exited' : 'live', agentWait: d.waiting ? JSON.parse(d.waiting) : null },
    })
  }
  const live = table.live

  // Only the exact pane and IDs Orca issued a dispatch send as it.
  function sender({ from, capability, taskId, dispatchId }) {
    const d = dispatch(dispatchId, 'orchestration send')
    if (d.taskId !== taskId || d.handle !== from || d.capability !== capability) {
      throw new OrcaError('consumer_fenced', `a message from ${dispatchId} does not match its preamble`, 'orchestration send')
    }
    return d
  }

  function post(d, { type, subject = '', body = '', outcome = null }) {
    const m = { id: `msg_fake${++messages}`, type, from: d.handle, subject, body, taskId: d.taskId, dispatchId: d.dispatchId, outcome, createdAt: clock ? clock.now() : null }
    mailOf(d.run).pending.push(m)
    if (type === 'worker_done' && !d.settled) Object.assign(d, { settled: true, outcome: outcome ?? 'succeeded' })
    return m
  }

  const as = (caller) => ({
    id: 'orca',
    name: 'Orca',
    unreachable: orcaUnreachable,
    calls,
    dispatches,
    worktrees,
    runs,
    as,
    closeTab: (handle) => closedTabs.add(handle),
    down: (error) => { gone = error },
    up: () => { gone = null },
    guardWith: (o) => { outage = o },
    async probe() {
      record({ verb: 'probe', ok: !gone })
      if (gone) throw gone
    },

    async runCreate({ objective }) {
      await step('runCreate', { objective })
      record({ verb: 'runCreate', objective })
      const runId = `${runPrefix}${runs.size + 1}`
      runs.set(runId, { coordinator: caller, generation: 1 })
      return { runId, terminal: caller }
    },

    async runUse({ runId }) {
      from(caller, 'orchestration run-use')
      await step('runUse', { runId })
      const r = runs.get(runId)
      if (!r) throw new OrcaError('run_not_found', `Run ${runId} not found or is inspect-only`, 'orchestration run-use')
      Object.assign(r, { coordinator: caller, generation: r.generation + 1 })
      const box = mailboxes.get(runId)
      if (box?.batch) {
        box.pending.unshift(...box.batch.messages)
        box.batch = null
      }
      record({ verb: 'runUse', runId, terminal: caller })
      return { runId, terminal: caller }
    },

    // Only the custom launch exists: the harness command, carrying the
    // runner's session id, in a terminal worker-start then adopts. `command`
    // and `argv` are what the real adapter would type and run.
    // `chain`: a chain worktree this Orca made (chainWorktree), which the
    // worker runs in, nothing made.
    async workerStart({ run, prompt, title, harness = 'claude', model, effort, permissionMode, sessionId, child = null, chain = null }) {
      if (!sessionId) throw new Error(`fake orca: ${title} was started without a runner-assigned --session-id`)
      if (away()) await reach()
      const command = launchCommand({ harness, model, effort, permissionMode, sessionId })
      const preamble = preambleOf(++seq)
      const launch = { harness, model, effort, permissionMode }
      const warnings = []
      let worktree = runWorktree
      let made = null
      let created = false
      if (chain) {
        if (!live(chain)) throw new OrcaError('selector_not_found', `no worktree ${chain}`, 'terminal create')
        worktree = chain
      }
      if (child) {
        made = child.retry ? await earlierWorktree(child.name, child.dispatched, child.baseline ?? null) : null
        let timedOut = null
        let late = null
        if (!made) {
          try {
            late = await step('worktreeCreate', { name: child.name }, createMs)
          } catch (e) {
            if (e?.code !== 'call_timeout') throw e
            timedOut = e
          }
        }
        if (!made && !timedOut) {
          // Real Orca never refuses a taken name: it makes <name>-2, which
          // the adapter refuses for good, naming both.
          // A child made with setup skipped runs no setup hook, so it is born clean.
          const { path, name } = table.create(child.name, child.setup ?? null)
          made = path
          created = !late
          record({ verb: 'worktreeCreate', name: child.name, worktree: made, setup: child.setup ?? null })
          if (name !== child.name) {
            const earlier = `C:/fake/worktrees/${child.name}`
            throw Object.assign(new OrcaError('worktree_name_taken', `asked for ${child.name}, Orca made ${name}: a worktree named ${child.name} already exists`, 'worktree create'), { worktree: made, worktrees: [made, earlier], final: true })
          }
          if (late) timedOut = await hang('worktreeCreate', createMs).catch((e) => e)
        }
        if (timedOut) {
          made = afterCreateTimeout(timedOut, findWorktree(child.name)?.[0] ?? null, warnings)
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
      let dispatching = false
      let baseline = child?.baseline ?? null
      try {
        if (created) {
          baseline = [...worktrees.get(made).porcelain]
          await child.onBaseline?.({ worktree: made, lines: baseline })
        }
        await step('terminalCreate', { title, worktree: made })
        opened = true
        await step('waitIdle', { title, worktree: made })
        dispatching = true
        fence(caller, run, 'orchestration worker-start')
        await step('workerStart', { title, worktree: made })
      } catch (e) {
        if (opened) record({ verb: 'terminalClose', terminal: preamble.handle })
        if (made && e instanceof Object) e.worktree = made
        if (dispatching && e instanceof Object) e.dispatched = true
        throw e
      }
      const text = typeof prompt === 'function' ? prompt(baseline) : prompt
      const argv = workerStartArgs({ run, prompt: text, title, place: ['--worktree', child || chain ? `path:${worktree}` : 'current'], terminal: preamble.handle })
      if (argv.includes('--agent')) throw new Error(`fake orca: worker-start for ${title} was called with --agent`)
      // Like Claude Code, the agent titles its own tab from its prompt.
      const d = {
        ...preamble, run, title, ...launch, sessionId, command, prompt: text, worktree, tabTitle: text.slice(0, 30), ...fresh(), transcript: null, onNudge: null, onContinue: null, terminalState: 'retained',
      }
      dispatches.set(d.dispatchId, d)
      record({ verb: 'workerStart', dispatchId: d.dispatchId, title, ...launch, sessionId, command, argv, placement: child ? 'new-child' : chain ? 'chain' : 'current', worktree })
      // The worker plays only once its prompt reaches it (promptLoss).
      counts.promptLoss = (counts.promptLoss ?? 0) + 1
      d.delivery = promptLoss({ title, count: counts.promptLoss, sessionId }) ?? null
      d.deliver = () => {
        d.delivery = null
        play(d, () => worker({ prompt: text, preamble, worktree, orca, state: d }))
      }
      if (!d.delivery) d.deliver()
      return { dispatchId: d.dispatchId, taskId: d.taskId, terminal: d.handle, worktree, warnings }
    },

    // The session resumed with the harness's resume command: in the same
    // terminal and dispatch while the tab is alive, else in a new terminal in
    // the same worktree that a new dispatch adopts. The continued session is
    // played by the `onContinue` its state carries, handed the worker's
    // original prompt and the preamble it now holds.
    async workerContinue({ run, dispatch: id, terminal: handle, worktree, title, prompt: text, harness = 'claude', model, effort, permissionMode, sessionId, reopen = false }) {
      if (away()) await reach()
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
        fence(caller, run, 'orchestration worker-start')
        if (worktree && worktrees.get(worktree)?.removed) throw new OrcaError('selector_not_found', `no worktree ${worktree}`, 'terminal create')
        const preamble = preambleOf(++seq)
        c = { ...d, ...preamble, run, title, command, worktree, ...fresh(), from: id }
        dispatches.set(c.dispatchId, c)
        const argv = workerStartArgs({ run, prompt: text, title, place: ['--worktree', worktree ? `path:${worktree}` : 'current'], terminal: c.handle })
        record({ verb: 'workerContinue', dispatchId: c.dispatchId, from: id, terminal: c.handle, worktree, command, text, argv, reopened: true, interrupted: false })
      }
      c.continued = continued + 1
      c.resumedWith = [...(c.resumedWith ?? []), text]
      play(c, () => c.onContinue?.({ prompt: d.prompt, text, preamble: preambleIn(c), worktree: c.worktree, orca, state: c }))
      return { dispatchId: c.dispatchId, taskId: c.taskId, terminal: c.handle, worktree: c.worktree, reopened: c !== d }
    },

    async workerShow({ dispatch: id }) {
      if (away()) await reach()
      const s = show(dispatch(id, 'orchestration worker-show'))
      record({ verb: 'workerShow', dispatchId: id, settled: s.settled })
      return s
    },

    async terminalIdle({ terminal: handle }) {
      if (away()) await reach()
      return terminal(handle, 'terminal wait').idle
    },

    async terminalSend({ terminal: handle, text }) {
      if (away()) await reach()
      const d = terminal(handle, 'terminal send', 'terminal_not_writable')
      record({ verb: 'terminalSend', dispatchId: d.dispatchId, text })
      // The prompt typed again into an empty input reaches a worker whose
      // first one was lost.
      if (d.delivery === 'lost') return d.deliver()
      d.nudges.push(text)
      await d.onNudge?.(text)
    },

    // Whether the worker's prompt reached it. A `dialog` holds it unsent in
    // the input box until an Enter; one `lost` needs typing again; `never`
    // takes nothing. Not recorded: the adapter reads it from the session's
    // transcript, never from Orca. As in a transcript, `needle` must be in
    // its prompt or in something typed to it since, a continuation's prompt included.
    async promptDelivered({ sessionId, needle }) {
      const d = [...dispatches.values()].filter((x) => x.sessionId === sessionId).at(-1)
      const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
      return !!d && !d.delivery && (!flat(needle) || [d.prompt, ...d.nudges, ...(d.resumedWith ?? [])].some((t) => flat(t).includes(flat(needle))))
    },

    async terminalEnter({ terminal: handle }) {
      if (away()) await reach()
      const d = terminal(handle, 'terminal send', 'terminal_not_writable')
      record({ verb: 'terminalEnter', dispatchId: d.dispatchId })
      if (d.delivery === 'dialog') d.deliver()
    },

    // Emptying the input drops a prompt a dialog held unsent.
    async terminalClearInput({ terminal: handle, lines = 1 }) {
      if (away()) await reach()
      const d = terminal(handle, 'terminal send', 'terminal_not_writable')
      record({ verb: 'terminalClearInput', dispatchId: d.dispatchId, lines })
      if (d.delivery === 'dialog') d.delivery = 'lost'
    },

    // What the tab renders: a worker whose prompt never arrives sits at a
    // dialog, the rest at an idle prompt.
    async terminalScreen({ terminal: handle, lines = 15 }) {
      if (away()) await reach()
      const d = terminal(handle, 'terminal read')
      record({ verb: 'terminalScreen', dispatchId: d.dispatchId, lines })
      const screen = d.delivery === 'never'
        ? ['New MCP server found in this project: slint', '❯ 1. Use this and all future MCP servers in this project', '  2. Use this MCP server', '  3. Continue without using this MCP server', 'Enter to confirm · Esc to cancel']
        : ['❯']
      return screen.slice(-lines)
    },

    // A stopped Dispatch is cancelled: settled, so no longer live.
    async workerStop({ dispatch: id }) {
      if (away()) await reach()
      const d = dispatch(id, 'orchestration worker-stop')
      record({ verb: 'workerStop', dispatchId: id })
      d.stopped = true
      if (!d.settled) Object.assign(d, { settled: true, outcome: 'cancelled' })
    },

    // Orca keeps a tab the worker did not create: releasing closes nothing.
    async workerRelease({ dispatch: id }) {
      if (away()) await reach()
      const d = dispatch(id, 'orchestration worker-release')
      record({ verb: 'workerRelease', dispatchId: id })
      d.released = true
    },

    async terminalRename({ terminal, title }) {
      if (away()) await reach()
      const d = [...dispatches.values()].find((x) => x.handle === terminal && !x.released)
      if (!d) throw new OrcaError('terminal_handle_stale', `no terminal ${terminal}`, 'terminal rename')
      record({ verb: 'terminalRename', dispatchId: d.dispatchId, title })
      d.tabTitle = title
    },

    // Real Orca settles a Dispatch only for the exact pane and IDs it issued.
    async workerDone({ from, capability, taskId, dispatchId, subject, body }) {
      const d = sender({ from, capability, taskId, dispatchId })
      record({ verb: 'workerDone', dispatchId, subject, body })
      post(d, { type: 'worker_done', outcome: 'succeeded', subject, body })
      Object.assign(d, { settled: true, outcome: 'succeeded' })
    },

    // Not the runner's: a worker's `orchestration send` to its Run's mailbox,
    // with the IDs from its preamble. Returns the message's id.
    async mailSend({ from, capability, taskId, dispatchId, type, subject, body, outcome = null }) {
      const d = sender({ from, capability, taskId, dispatchId })
      const m = post(d, { type, subject, body, outcome: type === 'worker_done' ? outcome ?? 'succeeded' : null })
      record({ verb: 'mailSend', id: m.id, type, dispatchId, outcome: m.outcome, body })
      return { id: m.id }
    },

    // The mailbox of the Run bound to this terminal; none for any other.
    async mailCheck({ ack = null } = {}) {
      from(caller, 'orchestration check')
      const run = [...runs].reverse().find(([, r]) => r.coordinator === caller)?.[0] ?? null
      const box = run ? mailOf(run) : null
      await step('mailCheck', { ack, batch: box?.batch?.messages.map((m) => ({ ...m })) ?? null })
      let acknowledged = null
      if (box && ack) {
        if (box.batch?.id !== ack && !box.acked.has(ack)) throw new OrcaError('stale_delivery', '--ack requires a delivery_* ID returned by orchestration check', 'orchestration check')
        if (box.batch?.id === ack) box.batch = null
        box.acked.add(ack)
        acknowledged = ack
      }
      const replayed = !!box?.batch
      if (box && !box.batch && box.pending.length) box.batch = { id: `delivery_fake${++deliveries}`, messages: box.pending.splice(0) }
      const b = box?.batch ?? null
      record({ verb: 'mailCheck', ack, deliveryId: b?.id ?? null, ids: b ? b.messages.map((m) => m.id) : [], replayed })
      return { deliveryId: b?.id ?? null, acknowledged, replayed, messages: b ? b.messages.map((m) => ({ ...m })) : [] }
    },

    // The run's chainName(runId), made as a child is, setup hook and all,
    // whenever none is held: the first time it is asked for, and again after
    // a reclaim removed it; the same one, as it is, every time in between.
    async chainWorktree({ runId }) {
      const name = chainName(runId)
      const found = findWorktree(name)
      if (found) return { path: found[0], made: false, baseline: null, warnings: [] }
      await step('worktreeCreate', { name }, createMs)
      const { path } = table.create(name)
      record({ verb: 'worktreeCreate', name, worktree: path, setup: null })
      return { path, made: true, baseline: [...setupLeaves], warnings: [] }
    },

    async worktreeLines({ worktree }) {
      await step('worktreeLines', { worktree })
      if (!live(worktree)) throw new OrcaError('selector_not_found', `no worktree ${worktree}`, 'git status')
      record({ verb: 'worktreeLines', worktree })
      return [...worktrees.get(worktree).porcelain]
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
      if (away()) await reach()
      record({ verb: 'terminalList' })
      return [coordinator, ...openTabs, ...[...logTabs].filter(([, t]) => t.open).map(([h]) => h), ...[...dispatches.values()].filter((d) => !d.gone).map((d) => d.handle)]
        .filter((h) => !closedTabs.has(h))
    },

    async terminalClose({ terminal: handle }) {
      if (away()) await reach()
      if (logTabs.get(handle)?.open) {
        record({ verb: 'terminalClose', terminal: handle })
        logTabs.get(handle).open = false
        return
      }
      const d = [...dispatches.values()].find((x) => x.handle === handle)
      if (!d) throw new OrcaError('terminal_handle_stale', `no terminal ${handle}`, 'terminal close')
      if (d.gone) throw new OrcaError('terminal_exited', `terminal ${handle} has exited`, 'terminal close')
      record({ verb: 'terminalClose', dispatchId: d.dispatchId, terminal: handle })
      d.gone = true
    },

    // The runner's own tab, a log's, or a worker's; a closed one is refused as exited.
    async terminalSwitch({ terminal: handle }) {
      if (away()) await reach()
      if (logTabs.has(handle)) {
        if (!logTabs.get(handle).open) throw new OrcaError('terminal_exited', 'terminal_exited', 'terminal switch')
      } else if (handle !== coordinator) terminal(handle, 'terminal switch', 'terminal_exited')
      record({ verb: 'terminalSwitch', terminal: handle })
      return { terminal: handle, worktreeId: null }
    },

    // As real Orca: only a file inside the worktree, the cwd's unless
    // `worktree` names one, whatever exists outside it.
    async fileOpen({ path, worktree = runWorktree }) {
      if (away()) await reach()
      const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      if (!norm(path).startsWith(norm(worktree) + '/')) throw new OrcaError('runtime_error', 'invalid_relative_path', 'file open')
      if (!existsSync(path)) throw new OrcaError('runtime_error', `ENOENT: no such file or directory, open '${path}'`, 'file open')
      record({ verb: 'fileOpen', path })
    },

    // A tab in the run's worktree following `path`: `command` is what the
    // real adapter types into it. Orca reads no path here; the shell does.
    async logTail({ path, title }) {
      if (away()) await reach()
      const handle = `term_log${logTabs.size + 1}`
      logTabs.set(handle, { path, title, open: true })
      record({ verb: 'logTail', path, title, command: tailCommand(path), terminal: handle })
      return { terminal: handle }
    },

    // A tab in a worktree Orca knows, running the runner's resume: `command`
    // is what the real adapter types into it.
    async resumeRunner({ worktree, title, runner, script, stateDir, permissionMode = null }) {
      if (away()) await reach()
      const command = resumeRunnerCommand({ runner, script, stateDir, permissionMode })
      const w = worktrees.get(worktree)
      if (!w || w.removed) throw new OrcaError('selector_not_found', `no worktree ${worktree}`, 'terminal create')
      const handle = `term_resumed${++resumes}`
      openTabs.add(handle)
      record({ verb: 'resumeRunner', worktree, title, command, terminal: handle })
      return { terminal: handle, command }
    },

    // `orca worktree rm --force`: it also kills every terminal in the worktree.
    async worktreeRemove({ path }) {
      if (away()) await reach()
      const w = worktrees.get(path)
      if (!w || w.removed) throw new OrcaError('selector_not_found', `no worktree ${path}`, 'worktree rm')
      record({ verb: 'worktreeRemove', path })
      table.remove(path)
      for (const d of dispatches.values()) if (d.worktree === path) d.gone = true
    },

    // Not Orca: git's answer for a fake worktree, in reclaim's `unpushed` shape.
    unpushedOf: async (path) => worktrees.get(path)?.unpushed ?? 0,
  })
  const orca = as(coordinator)
  return orca
}

// Orca's CLI itself, offline, for the real adapter (orca-cli.mjs) to run
// against: `call(args)` answers an argv as `orca <args> --json` would, with
// its `result`, or fails as OrcaError, and `git(cwd, args)` answers the git
// the adapter runs in a worktree. Only the verbs a worktree's life takes: a
// Run; a worktree created from the run's (`--name` as asked, or suffixed -2,
// -3… when taken, as Orca does; the repo's setup policy leaving `setupLeaves`
// in it unless `--setup skip`), listed, set and removed with every terminal in
// it; a terminal created, waited on, listed and closed; a worker started in
// one and stopped. Any other verb fails, so no test passes on an answer real
// Orca was never asked for. `worktrees` holds each by path, in the table
// fakeOrca keeps too (fakeWorktrees), with `setups`, how often the setup
// policy ran in it; `dispatches`, each worker by id. It stays a second fake
// beside fakeOrca because it answers Orca's argv, so the real adapter's own
// parsing runs, where fakeOrca stands in for that adapter.
export function fakeOrcaCli({ setupLeaves = [], runWorktree = 'C:/fake/run', coordinator = 'term_runner' } = {}) {
  const table = fakeWorktrees({ runWorktree, setupLeaves })
  const worktrees = table.table
  const terminals = new Map()
  const dispatches = new Map()
  let runs = 0
  let seq = 0
  const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const live = table.live
  const selected = (args, verb) => {
    const at = flag(args, '--worktree')
    const path = at === 'current' || at === undefined ? runWorktree : at.replace(/^path:/, '')
    if (path !== runWorktree && !live(path)) throw new OrcaError('selector_not_found', `no worktree ${path}`, verb)
    return path
  }
  const open = (worktree, extra = {}) => {
    const handle = `term_cli${++seq}`
    terminals.set(handle, { worktree, closed: false, agent: false, ...extra })
    return handle
  }
  const VERBS = {
    'orchestration run-create': () => ({ run: { id: `run_cli${++runs}`, coordinator_handle: coordinator } }),
    'worktree list': () => ({ worktrees: [...worktrees].filter(([, w]) => !w.removed).map(([path, w]) => ({ path, branch: `refs/heads/${w.name}` })), truncated: false }),
    'worktree create': (args) => {
      // A path made again after its rm keeps its count: its hook ran there before.
      const { path } = table.create(flag(args, '--name'), flag(args, '--setup') ?? null)
      return { worktree: { id: `repo::${path}`, path }, startupTerminal: { handle: open(path) } }
    },
    'worktree set': (args) => {
      const w = worktrees.get(selected(args, 'worktree set'))
      if (args.includes('--display-name')) w.displayName = flag(args, '--display-name')
      if (args.includes('--workspace-status')) w.status = flag(args, '--workspace-status')
      return {}
    },
    'worktree rm': (args) => {
      const path = selected(args, 'worktree rm')
      table.remove(path)
      for (const t of terminals.values()) if (t.worktree === path) t.closed = true
      return {}
    },
    'terminal create': (args) => {
      const path = selected(args, 'terminal create')
      const handle = open(path, { title: flag(args, '--title'), command: flag(args, '--command') })
      return { terminal: { handle, worktreeId: `repo::${path}` } }
    },
    'terminal wait': () => ({ wait: { satisfied: true } }),
    'terminal close': (args) => {
      const t = terminals.get(flag(args, '--terminal'))
      if (!t || t.closed) throw new OrcaError('terminal_handle_stale', 'terminal_handle_stale', 'terminal close')
      t.closed = true
      return {}
    },
    'terminal list': (args) => {
      const path = args.includes('--worktree') ? selected(args, 'terminal list') : null
      return { terminals: [...terminals].filter(([, t]) => !t.closed && (!path || t.worktree === path)).map(([handle, t]) => ({ handle, orphaned: false, ...(t.agent && { agentIdentity: 'claude' }) })) }
    },
    'orchestration worker-start': (args) => {
      const handle = flag(args, '--terminal')
      const t = terminals.get(handle)
      if (!t || t.closed) throw new OrcaError('terminal_handle_stale', 'terminal_handle_stale', 'orchestration worker-start')
      t.agent = true
      const dispatchId = `ctx_cli${++seq}`
      dispatches.set(dispatchId, { terminal: handle, worktree: t.worktree, run: flag(args, '--run'), spec: flag(args, '--spec'), stopped: false })
      return { dispatchId, taskId: `task_cli${seq}`, effects: [{ kind: 'terminal', role: 'agent', id: handle }] }
    },
    'orchestration worker-stop': (args) => {
      const d = dispatches.get(flag(args, '--dispatch'))
      if (!d) throw new OrcaError('dispatch_not_found', `no dispatch ${flag(args, '--dispatch')}`, 'orchestration worker-stop')
      d.stopped = true
      return {}
    },
  }
  return {
    worktrees,
    dispatches,
    async call(args) {
      const verb = args.slice(0, 2).join(' ')
      if (!VERBS[verb]) throw new OrcaError('unknown_command', `the offline Orca CLI plays no ${verb}`, verb)
      return VERBS[verb](args)
    },
    async git(cwd, args) {
      if (args[0] === 'status' && worktrees.has(cwd)) return worktrees.get(cwd).porcelain.map((l) => `${l}\n`).join('')
      throw new Error(`git ${args[0]} in ${cwd}: the offline Orca CLI plays no such git`)
    },
  }
}
