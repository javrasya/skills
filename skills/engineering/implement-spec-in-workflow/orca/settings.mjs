// Every limit the Orca runner enforces on a worker, in one table. A worker
// that crosses one is nudged, then its session is continued (ADR-0013); one
// past the continuation cap, or blocked on a human too long, becomes `null`
// from agent(), as a dead subagent does on the Workflow runner, so the
// script's own null handling applies unchanged.
const MIN = 60_000

export const RUNNER_SETTINGS = Object.freeze({
  // Agents live at once — started and not yet settled or stopped. Orca's own
  // cap for this runner, not the Workflow runner's; further agent() calls
  // queue. A settled worker's tab stays open until reclaimed, and costs no slot.
  MAX_LIVE: 10,
  // How often a live worker is looked at.
  pollMs: 5_000,
  // How long one look waits for the worker's TUI to report idle.
  idleProbeMs: 1_000,
  // A worker idle, or exited, without submitting is nudged this many times;
  // the next time it is found so, its session is continued.
  idleNudges: 2,
  // Idle counts only once the worker has been idle, with its transcript and
  // terminal unmoved, for this long since its start or its last nudge: the
  // prompt needs time to land and turn the TUI busy.
  nudgeGraceMs: 2 * MIN,
  // A nudge takes this long to land in the transcript and the TUI. Movement
  // seen by a look whose previous look came before this long after the nudge
  // is taken for the nudge landing, not for the worker coming back, however
  // late that look came.
  nudgeEchoMs: 10_000,
  // Neither the worker's transcript nor its terminal's busy or idle state has
  // moved for this long: nudged once, then its session is continued.
  stuckNudgeMs: 20 * MIN,
  stuckContinueMs: 40 * MIN,
  // Sessions continued per agent; the next death fails it, and its tab and
  // worktree are kept.
  maxContinuations: 3,
  // Blocked on something only a human can answer: logged loudly on entry,
  // failed and kept if nobody answers within this. Never continued:
  // continuing does not answer the question it waits on.
  blockedFailMs: 30 * MIN,
  // Orca calls that fail in a row while watching a worker before it counts
  // as dead: one transient CLI failure must not kill a long agent.
  watchErrors: 3,
  // One Orca call, beyond any wait it asks Orca for: one that has not
  // answered by then is killed and counts as failed.
  orcaCallMs: 2 * MIN,
  // A worker start, or the Run's creation, that fails is tried again after
  // each of these waits in turn; once they are spent, agent() is null. So it
  // is attempted at most four times: the first attempt, then one after each
  // of the three waits.
  retryBackoffMs: Object.freeze([30_000, 2 * MIN, 5 * MIN]),
  // The run view in the runner's tab (D5 on #43): a view that crashes is
  // started again after this wait; at this many crashes in one run the runner
  // stops restarting it and prints its log in the tab instead.
  viewRestartMs: 1_000,
  viewCrashes: 3,
})
