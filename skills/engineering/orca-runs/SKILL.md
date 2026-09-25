---
name: orca-runs
description: "Open the Orca run view in standalone mode: every Orca-runner run on this machine, by project, to look into, reclaim, or resume one whose runner died."
disable-model-invocation: true
---

The **run view** is the operator's terminal screen for runs of [`implement-spec-in-workflow`](../implement-spec-in-workflow/SKILL.md) on the Orca runner (ADR-0012). The runner shows it attached, in its own tab, on its own run. This skill opens it **standalone**: every run in the run registry (`~/.claude/orca-runs.jsonl`), finished, paused or dead, with no runner needed.

The view is code of `implement-spec-in-workflow`, not of this skill: one copy, beside the runner that also starts it. Both skills are installed side by side, so it is reached from this skill's directory.

**Requires** Node, and a session inside an Orca terminal (`TERM_PROGRAM` is `Orca`). On its first start the view installs its one dependency, terminal-kit, beside itself with `npm ci`, which needs npm and the network once.

## Steps

1. **Open it in a new Orca tab.** `<skill-dir>` is the directory holding this file:

   ```
   orca terminal create --title "Orca runs" --command "node \"<skill-dir>/../implement-spec-in-workflow/orca/run-view/view.mjs\" --standalone" --focus --json
   ```

   If the command fails, or `result.terminal.surface` is not `visible`, tell the operator the view has no visible tab, and stop. Outside Orca, say the view needs an Orca terminal, and stop.

2. **Hand it over.** The operator works the view themselves; do not read its tab. Tell them its keys:

   - The list holds each run with its spec, its outcome, whether its runner is alive (its tab is in Orca's terminal list), how many agents it still keeps, and its age. Runs are grouped by project.
   - **Enter** or a click opens a run into the same tree the runner's tab shows. **q** or Escape goes back to the list, and **q** on the list closes the view.
   - **r** on a run reclaims every agent it keeps, under the reclaim rules: an agent still live is kept, and so is one whose worktree holds commits no remote has. The run itself is marked reclaimed only once it has ended and its runner is dead; a run still going stays open, so the agents it starts later are kept. Inside a run, **r** reclaims one agent, and **f** forces one holding unpushed commits.
   - **R** resumes a run whose runner is dead. It opens a new tab in the run's worktree, running the runner with `--resume`, which takes the run over. It is not offered while the runner is alive, nor on a run already reclaimed.

The view touches only worktrees a run made, named `<runId>-<n>`; any other worktree is never shown or touched. Reading, stopping and releasing a run's workers needs no takeover, so reclaiming works on any run. Details are in `implement-spec-in-workflow/orca/README.md`, *The run view standalone*.
