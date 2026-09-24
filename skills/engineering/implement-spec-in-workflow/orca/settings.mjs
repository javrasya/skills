// Every limit the Orca runner enforces on a worker, in one table. A worker
// that crosses one becomes `null` from agent(), as a dead subagent does on the
// Workflow runner, so the script's own null handling applies unchanged.
const MIN = 60_000

export const RUNNER_SETTINGS = Object.freeze({
  // Agents live at once — started and not yet released. Orca's own cap for
  // this runner, not the Workflow runner's; further agent() calls queue.
  MAX_LIVE: 10,
  // How often a live worker is looked at.
  pollMs: 5_000,
  // How long one look waits for the worker's TUI to report idle.
  idleProbeMs: 1_000,
  // A worker idle, or exited, without submitting is nudged this many times;
  // the next time it is found so, it is dead.
  idleNudges: 2,
  // After a start or a nudge, idle does not count for this long: the prompt
  // needs time to land and turn the TUI busy.
  nudgeGraceMs: 2 * MIN,
  // Output this soon after a nudge is taken for the nudge's own echo, not for
  // the worker coming back.
  nudgeEchoMs: 10_000,
  // No terminal output for this long: nudged once, then dead.
  silentNudgeMs: 20 * MIN,
  silentDeadMs: 40 * MIN,
  // Blocked on something only a human can answer: logged loudly on entry,
  // dead if nobody answers within this.
  blockedDeadMs: 30 * MIN,
  // Orca calls that fail in a row while watching a worker before it counts
  // as dead: one transient CLI failure must not kill a long agent.
  watchErrors: 3,
  // One Orca call, beyond any wait it asks Orca for: one that has not
  // answered by then is killed and counts as failed.
  orcaCallMs: 2 * MIN,
  // A worker start, or the Run's creation, that fails is tried again after
  // each of these waits in turn; once they are spent, agent() is null.
  retryBackoffMs: Object.freeze([30_000, 2 * MIN, 5 * MIN]),
})
