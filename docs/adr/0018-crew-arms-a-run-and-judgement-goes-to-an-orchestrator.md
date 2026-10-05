# ADR-0018: Crew arms a run itself, and judgement goes to an orchestrator that never schedules

## Status

Accepted — 2026-09-28. Its orchestrator's questions run headless since ADR-0019. Amended 2026-10-05 by ADR-0029: the orchestrator no longer drafts a validation list, and the form has no confirm step for one; each ticket's Validation section is checked by a deterministic heading match at arm.

## Context

A run is armed today by an agent session running the skill. That session runs the stack gate probes, picks the base branch, drafts `validation.md` from CI config, renders `workflow.js` and launches the runner. So starting a run needs an agent. `crew start <spec#>` should start one from a terminal.

## Decision

**Crew arms a run in deterministic code, from a form; anything needing judgement goes to an orchestrator agent that returns answers and never decides what runs next.**

- **The arming form.** Every row has a default and a matching flag. The last answers are remembered per repo.

  | Row | Default and options |
  |---|---|
  | Harness | Claude Code or pi |
  | Model | The harness's last-used model, cycling through its others |
  | Base branch | The current branch |
  | Stack mode | GH Stack; "Install and Use GH Stack" when the extension is missing; shown disabled, with the reason and a link, when the repo's stacks API returns 404. Or Basic Git stacking |
  | Permission mode | Auto; Claude only |

  A missing flag is asked for only when stdin is a terminal.
- **The run default.** The chosen harness and model are the run default for the orchestrator and for every role. The role table in crew config overrides it per role.
- **The orchestrator** runs in fresh sessions outside the run's graph, and crew shows what it returns. In v1 it:
  - drafts a missing validation list, which the operator confirms in the form;
  - lays out a halted run's questions;
  - answers the operator's own questions about a run, in a session opened from the console with `?`.

  Its questions are crew's, not runs: the Run each is asked in is flagged at creation, never counts as live for `crew daemon stop`, and is dropped from the daemon's book once its session is closed. Whoever asks closes a question it stops waiting for — quitting `crew view`, Ctrl+C while `crew start` drafts — so no orchestrator session outlives its asker.
- **Halt triage is the run console's.** `crew view` asks it, once per `halted.json` `at`, while it shows the run. A run that halts with nobody watching it there, or watched only from the runner's attached view, is triaged when it is next opened in `crew view`; a triage given up because its console quit is asked again by the next. The runner does not ask it: the run carries on without an answer, and R resumes it whatever became of the question.
- **The skill keeps both paths.** On the crew path it calls `crew start` with flags and waits on `summary.json` and `halted.json` as today. The template stays in the skill folder, and crew's publish step bundles a copy.

## Considered options

- **Crew opens an agent session that arms as the skill does today.** Rejected: the operator would wait on an agent for choices that are mostly probes and defaults.
- **An orchestrator that also schedules.** Rejected: scheduling stays in the script and the runner (ADR-0002, ADR-0013). The doctor keeps its own narrower job (ADR-0014).
