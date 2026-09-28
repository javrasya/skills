// How the run view tells the runner why it exited (D5 on #43). Any other exit
// is a crash, which the runner answers by restarting the view.
export const VIEW_EXIT = Object.freeze({
  // The operator quit it (q, or Ctrl-C with no prompt open): never restarted.
  quit: 0,
  // It cannot run here: no terminal, or terminal-kit could not be installed.
  // Restarting would fail the same way, so the runner prints its log at once.
  unavailable: 3,
})
