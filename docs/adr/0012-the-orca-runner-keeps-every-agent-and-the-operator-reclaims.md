# ADR-0012: The Orca runner keeps every agent, and the operator reclaims from the run view

## Status

Accepted — 2026-09-24. Amended by #71: the end-of-run prompt is gone, and an agent is reclaimed only from the run view. Amends ADR-0011's consequence "it releases every worker it started". Applies to the **Orca runner only**; the Workflow runner, and the shared workflow script, are unchanged.

## Context

The first real Orca-runner run (spec #783, milestone W5.2) ended partial: #1087's second slice failed, and #1154 and #1156, which it blocks, never ran. When the operator came to look, there was nothing to look at:

- the runner's own tab was launched with `--command "node runner.mjs …; exit"`, so it closed at the end and took the runner's only log with it;
- every worker's tab was released or stopped the moment its agent returned;
- worktrees were reclaimed by the publish lane and by finalize, per the glossary's "reclaimed the moment its PR exists".

The Orca runner's reason to exist (ADR-0011) is that every agent is a live session the operator can watch. A runner that tears all of that down on return gives the operator a live view only while nothing has gone wrong, and none afterwards, when it matters most.

Tracking what to keep had to be settled too. The operator may run several workflows at once, in several repos, alongside worktrees made by hand. An Orca Run carries only an immutable `--objective`, no status, and cannot be closed or deleted individually (`orchestration reset --all` wipes every Run on the machine). A worktree carries no run field. But every child worktree the runner creates is named `<runId>-<n>`, and `worker-list --run` joins a Run to each worker's worktree and terminal. Orca's own `retained` terminal state cannot say whether a tab is open: it is permanent for any terminal the runner launched itself (`terminal create` then `worker-start --terminal`), released or not.

Three places for the operator's view were weighed: a native Orca plugin panel (not viable: panels are sandboxed with `connect-src 'none'` and can neither read orchestration state, focus a terminal nor remove a worktree), a local web page opened in Orca's browser, and a full-screen terminal view in the runner's own tab.

## Decision

**Nothing is reclaimed during an Orca-runner run.** Workers are not released on return, worktrees are not removed by the publish lane or finalize, and the runner's tab does not `exit`.

**Reclaim is the operator's act, and only the run view's.** The runner asks nothing at the run's end: it writes `summary.json` and stays in its tab until the operator quits the view. On a run's tree, `r` opens the reclaim dialog, which takes every key and click while it is open: *Reclaim Selected* (the agent under the cursor, or every agent of the phase under it), *Reclaim Successful Ones* (the agents that are done), and *Reclaim All*, available once the run has ended — though the runner is still alive then, waiting on the view — and greyed out with its reason while the run is still going. Arrow keys and the mouse move the highlight, only Enter accepts, and Esc reclaims nothing. The standalone runs list keeps its own `r`, which reclaims a whole run. Reclaim never touches a live agent, and never removes a worktree holding commits that were not pushed without being forced.

**The run view is a terminal UI, not a web page.** It is an htop-style tree of phases and agents with each agent's state, context size (green under 200k tokens, yellow to 350k, red above), and elapsed time. Arrow keys move, and Enter or a mouse click focuses the agent's Orca tab and worktree (`orca terminal switch`). It is built on **terminal-kit**, whose SGR mouse input was confirmed to reach Node in an Orca tab. It runs in two modes: **attached**, as a child process in the runner's tab showing that run, and **standalone**, listing every run on the machine by project, where a run can be reclaimed or resumed (ADR-0013).

**A machine-wide run registry** (`~/.claude/orca-runs.jsonl`, or under `CLAUDE_CONFIG_DIR` when that is set) records each run: its Run id, project, run directory, spec, and whether it has been reclaimed. Orca stays the truth for live workers, joined by Run id. A worktree belongs to a run by its `<runId>-<n>` name; one without the prefix is the operator's own and is never touched. Tab liveness comes from `orca terminal list`, never from `retained`. A runner's liveness does not come from its tab, which outlives it: it comes from the process `<runDir>/runner.pid` names, by one rule in both of the view's modes.

## Consequences

- **A failed run leaves its evidence where the operator can see it**: the runner's tab and log, the failed agent's tab and transcript, and its worktree.
- **Disk and tabs accumulate until reclaimed.** A run of seven tickets keeps dozens of worktrees if the operator never reclaims them from the run view; the standalone view is how they are found again.
- **The two runners now differ in reclaim.** The shared script still names each worktree's path. The Workflow runner reclaims as before, and the Orca runner defers to the operator. The glossary's Worktree reclaim entry records the exception.
- **The view's first start needs npm and the network.** terminal-kit is pinned in `run-view/package.json` with a committed lockfile, and installed beside `view.mjs` with `npm ci` the first time a view starts. It is not vendored, so this departs from ADR-0001's promise that cloning the repo and running the link script installs every dependency. It is not vendored because the installed skill may be a detached copy of the repo, and the copy is where the view runs. Vendoring would also mean committing terminal-kit's whole dependency tree for one screen. A failed install costs only the view: it exits as unavailable, and the runner prints its log in the tab.
- **The view depends on the Orca CLI's output shapes** (`worker-list`, `terminal list`, `worktree ps`). An Orca upgrade that changes them breaks the view, not the run.
- **ADR-0011's release statements now hold only at reclaim.** Its "Orca's release retains a terminal the worker did not create, so the runner closes it after release" describes what a reclaim does, not what happens when an agent returns. Checked in the #53 contract pass (Orca 1.4.209): through a fresh run and a resume from a new terminal, no worker was released. All 8 were `retained` with `releaseState: not_requested`, every settled worker's tab stayed open, and every child worktree stayed. Orca did settle one kind of worker by itself: one whose tab was closed, as `failed`. That settles it but does not release it, and the tab is already gone.
- **A native Orca panel stays the better long-term home** once Orca's plugin API grows exec, focus and wide panels (stablyai/orca #18214, #19020, #19826). Nothing here blocks moving there.
