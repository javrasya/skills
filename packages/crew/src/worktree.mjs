// A worker's child worktree, as every session host prepares and takes it up:
// the rules here are the host-neutral part, and each adapter reads and makes
// its worktrees its own way (orca-cli.mjs, crew-host.mjs, fake-orca.mjs).
import { copyMcpAnswers } from './mcp-answers.mjs'
import { gitIn, porcelainLines, sameLines, worktreeOwnCommits } from './git.mjs'

// A take-up refused: no session host's error, so no host's outage handling
// ever reads it as its host gone. `code` says why; `final`, whether a retry
// can mend it; `worktree`, the path it keeps.
export class WorktreeError extends Error {
  constructor(code, message, extra = {}) {
    super(`worktree reuse: ${code}: ${message}`)
    Object.assign(this, { code, ...extra })
  }
}

// Whether a retry takes up the worktree at `path` an earlier attempt of its
// start made: its path, or a refusal naming it. One an agent still runs in
// (held()) is refused for this attempt only. Until an attempt has reached
// worker-start (`dispatched`), whatever it holds is its host's own making,
// such as a setup hook's untracked output, so it is taken up as it is; after
// that, one that holds work is refused for good (`final`). Work is what it
// holds beyond its `baseline`, the porcelain lines it was made with (lines()):
// with none (a create that timed out), any line is work; and any commit of its
// own (commits()). Every host decides by this one rule, each reading the
// worktree its own way, and only as far as the rule needs.
export async function reuseWorktree(path, { dispatched, baseline }, { held, lines, commits }) {
  const refuse = (code, why, final) => new WorktreeError(code, `${path} ${why}`, { worktree: path, final })
  if (await held()) throw refuse('worktree_held', 'still has an agent running in it', false)
  if (!dispatched) return path
  if (!sameLines(await lines(), baseline ?? [])) throw refuse('worktree_dirty', baseline?.length ? 'has changed since it was made' : 'has uncommitted changes', true)
  const own = await commits()
  if (own > 0) throw refuse('worktree_has_commits', `has ${own} commit(s) of its own`, true)
  return path
}

// What the worktree at `path` holds uncommitted, as `git status --porcelain` lines.
export const worktreeLines = async (path, bound) => porcelainLines(await gitIn(path, ['status', '--porcelain'], bound))

// The two probes reuseWorktree reads through git, the same on every host:
// what the worktree at `path` holds uncommitted, and its commits on `branch`.
export const gitProbes = (path, branch, bound) => ({
  lines: () => worktreeLines(path, bound),
  commits: () => worktreeOwnCommits(path, branch, bound),
})

// A child worktree this attempt made, readied for its worker: the project's
// MCP answers go in first, so what they change is part of the baseline, as a
// setup hook's output is; then its baseline, the porcelain lines it holds,
// is taken and handed to child.onBaseline. A failure to copy the answers is a
// warning, and leaves the worker to the prompt-delivery check (lifecycle.mjs).
// Returns the baseline.
export async function prepareChildWorktree({ project, worktree, bound, child, warnings, fs }) {
  try {
    const m = copyMcpAnswers({ project, worktree, ...(fs && { fs }) })
    if (m.added.length) warnings.push(`the project has no answer for MCP server(s) ${m.added.join(', ')} of .mcp.json, so its worktree disables them`)
  } catch (e) {
    warnings.push(`could not copy the project's MCP server answers into its worktree: ${e?.message ?? e}`)
  }
  const baseline = await worktreeLines(worktree, bound)
  await child.onBaseline?.({ worktree, lines: baseline })
  return baseline
}

// The run's chain worktree, just made, readied as a child's is. Its baseline
// unread is a warning, never a failure: the worktree is made all the same,
// and the runner journals it with no baseline. Returns the baseline or null.
export async function prepareChainWorktree({ project, worktree, bound, warnings, fs }) {
  try {
    return await prepareChildWorktree({ project, worktree, bound, child: {}, warnings, fs })
  } catch (e) {
    warnings.push(`could not read its baseline: ${e?.message ?? e}`)
    return null
  }
}
