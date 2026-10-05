# ADR-0030: A run takes its own baseline of pre-existing failures, and pins its base

## Status

Accepted — 2026-10-05. Amends ADR-0004: for a red check whose exit code is non-zero, the role judges whether it is made only of pre-existing failures; the exit code still decides every green. Amends ADR-0009: a waived check is never inherited. Amends ADR-0029: readiness reads each check's `passed`, and the recipe a role is told may carry masked commands.

## Context

A ticket's recipe runs on a codebase that may already be red: a failing test on main, a lint error nobody fixed, a typecheck that has failed for weeks. The run cannot tell that red from one the change made. Readiness sends it back to dispatch as a remainder, the gate raises it, the whole-stack review blocks on it, and agents spend rounds on code the ticket never touched — or, worse, "fix" it out of scope.

Nothing in the run knew what was already failing. Explorers run in the operator's checkout, unpinned and before any setup hook, and are asked research questions, not to run the recipe. Each ticket is cut from `origin/<base>` as it stands when the ticket starts, so even a measured baseline would describe a commit later tickets do not build on.

## Decision

**Before anything is implemented, the run measures what its recipe already fails on, on the exact commit every ticket is cut from, and every validating role reads that measurement.**

- **The base is pinned.** At the start of the run the base sha is resolved once: the prior-work branch's sha when one is named, else `origin/<base>`'s. Every ticket is cut from that sha. Rebasing onto a newer base stays the publisher's.
- **A fixed baseline agent.** The script always starts it — it is not one of the graph agent's explorations — in parallel with the explorers, as a node of the run tree the operator can enter. It runs in its own worktree at the pinned sha, with the setup hook, so it measures the tree tickets build on.
- **Its commands come from arming.** `crew start` already reads every ticket body; it extracts the `### Run per change` and `### Run at review` command lines and renders their de-duplicated set into the workflow. No agent reads the tickets for this.
- **Per-change first.** The per-change commands are baselined before dispatch, and dispatch waits for them. The at-review commands carry on in the background; only the whole-stack review waits on them.
- **A command that cannot run is a blocker, not a failure.** An exit that is not a test or check failure, or output nothing can be read from, is a broken environment a mask would hide. The baseline agent calls `needs_you`, the operator clears it in its session, and the agent carries on once the command runs. On a runner with nobody in its sessions the run halts with the blocker named.
- **The record.** The agent returns its result through `submit` against a schema; the script writes `pre-existing-failures.json` into the run folder, which is never committed and is fresh for every run. Per command: its exit code; its failures — a test by id, any other check by tool, rule, file, a five-to-six-line snippet and the message, never by line number alone since lines move; and, where the tool can skip tests, a **masked command** that deselects them.
- **Masked commands replace their originals in the recipe**, wherever validation runs: implementers, fixers, gate reviewers, publishers, the whole-stack review and the integration fixers. A role whose work is meant to fix a masked failure runs the unmasked command and says so.
- **The role judges a red; the exit code decides a green.** A check returns `{command, passed, exit_code}`. A zero exit code is `passed: true` with no judgement. A non-zero one is `passed: true` only when the role judges every failure in it pre-existing, against the record; that is a **waived check**.
- **A waived check is never inherited.** The next role re-runs it and makes its own call, whatever the sha. The publisher lists every waived check in the PR body.

## Considered options

- **Masking only, exit code always decides.** Rejected: a pre-existing lint or type error cannot be skipped without editing the code it sits in, and most tools have no deselect for one diagnostic.
- **The script matches failures against the record.** Rejected for now: matching snippets and messages across tool output formats is a parser per tool, and still guesses when the agent edited near a failure.
- **A fifth exploration the graph agent may ask for.** Rejected: the baseline must always run, and its output feeds the script, not only the notes.
- **Baseline in the operator's checkout, as explorers run.** Rejected: an unpinned tree with no setup hook measures a different codebase from the one tickets build on.
- **Keep the moving base and re-baseline when it moves.** Rejected: a run on one fixed commit keeps the record true for the whole run at one measurement's cost.
- **Inherit a waived result like any green.** Rejected: one agent's judgement would pass gate and publish unchecked; re-running only the red checks is the cheapest second opinion.
- **Re-run a red command to tell flaky from failing.** Deferred: one run decides for now.

## Consequences

- A red made only of pre-existing failures no longer costs dispatch, gate or review rounds.
- Every ticket of a run is cut from one recorded sha, not from wherever the base stood when it started.
- An agent's judgement can turn a red check green; the raw exit code and the PR body's list of waived checks are its trace.
- A flaky test that passed during the baseline reads as the change's red.
- Arming grows from checking the recipe's heading to extracting its commands.
