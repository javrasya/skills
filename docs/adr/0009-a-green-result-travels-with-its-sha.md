# ADR-0009: A green result travels with its sha; a check runs once per tree, in the foreground

## Status

Accepted — 2026-09-13. Amends the readiness rule of ADR-0008 — "the reviewer's first act is to re-run the validation list" — into "the reviewer's first act is to establish readiness, by inheritance when the sha is unchanged". Everything else in ADR-0008 stands; ADR-0004's rule that no agent judges its own work is untouched, because a sha match is an exit code, not a judgement.

## Context

`implement-spec-in-workflow` gave every role the same validation list and told each to run it: the implementer on its final commit, the gate reviewer before reading a line, every fixer, and the publisher. The template's own comments explained the arrangement as ADR-0004 applied to validation — nothing trusts an upstream agent's account — and the publisher's step was written against a field, `impl.tests_run`, that no schema ever carried, so publishers were told to run `undefined` and improvised.

A dataset mined from 1025 transcripts of one project's runs (4821 validation calls, 42.8 h of summed wall time) put numbers on what that cost:

- The full suite ran 193 times at a 1.4 min median. On tickets, 153 of those runs were traceable through the pipeline; **36 were provably on a tree unchanged since the previous run** (same sha observed, no edit in between) and 52 more could not be determined either way. Gate, gate-fix and publish re-ran what the implementer had just proven.
- **55% of the summed wall time was waiting**: 1432 poll calls (sleep/pgrep/until loops and harness waits) around tests the agents had launched in the background, 16.7 h of it in explicit loops, against 19.3 h of foreground test, format and build time. One publisher spent 5.0 h polling a suite that had deadlocked.
- Implementers ran the full suite mid-slice rather than a scoped one: 85 full-suite runs by implementers, 13 to 16 on single tickets, where a scoped run of the touched crate cost 11 s.
- 46 `cargo clean` calls, 37 of them an agent's last act — disk reclaim by an agent whose worktree was about to be removed anyway — deleting a build cache the next agent in the same tree could have used.

None of this is a tuning problem inside one prompt. The ECONOMY block already said "re-run only after you changed something" and had no way to know whether anything changed; the readiness rule said "re-run" without qualification; and no field carried the one fact that would settle it — which commit the list was green on.

## Decision

**A green result travels with the sha it was green on.** Every agent that runs the list returns `validated_sha` — `git rev-parse HEAD` at the moment the whole list last passed — beside the per-command results. The script carries the newest one downstream: implementer to gate reviewer, fixer to the next reviewer, gate to publisher.

**A downstream agent inherits the result when the tree is the one already proven.** It runs `git rev-parse HEAD`; if that equals the validated sha and it has edited nothing, it reports every check green with `runs: 0`, `seconds: 0` and the same sha, and does not re-run. If the sha differs, or it edited anything, it runs the list. The proof is the sha match — one command, one exit code — never the upstream agent's word, which is what keeps this inside ADR-0004: the agent does not judge whether the tree is good, it checks whether the tree is the same.

**A rebase yields a tree nobody has validated, so the publisher runs the list after one**, and inherits only when the tip has not moved. The PR body then carries one provenance line, `Validated green at <sha> by <role>`, so a human reviewer and the whole-stack review can see which tree was proven and by whom. `impl.tests_run` is gone; the publisher runs the same list as everyone else.

**A check runs once per tree, in the foreground, as written.** While iterating, an agent runs the narrowest scope its build tool supports and runs the full list once, after its last edit. No agent launches a check in the background; if the harness moves a long command to the background on its own, the agent waits on it once with the harness's wait primitive, never with a sleep or polling loop. No agent runs a build-cache clean — the worktree remove at reclaim is the only disk reclaim the run does.

**Every agent times what it ran, and the run reports it.** `checks` carries wall seconds and run count per command; `other_runs` carries every build or test command that is not on the list, with a `timed_out` flag, so a scoped run and a hang are both visible. The script sums them (per command, role and ticket; results inherited; checks re-run on an unchanged sha) and one low-effort agent writes `validation-report.md` in the notes directory with proposals for the validation list. **Nothing applies a proposal**: the next run reads `validation.md` exactly as the operator left it. The report is for a human, or for a separate session the human points at it.

## Considered

- **Let the script compare shas and drop the list from the brief when they match.** Rejected: the runtime has no shell, so the script cannot rev-parse; it would have to trust the upstream agent's claim of its own HEAD, which is the self-report ADR-0004 exists to remove. The downstream agent checking the tree itself costs one command and trusts nothing.
- **Trust by role rather than by sha** ("the gate never re-runs"). Rejected: a fixer between them moves the tree, and a rule keyed on role cannot see that. Keyed on sha, a fix round invalidates the inheritance by construction.
- **Put the validation result on the ticket or in a file in the shared clone.** Rejected: the gate runs before any PR exists, a file in the clone is a second source of truth beside the structured return the script already reconciles, and the PR body is where a human looks — so the sha goes there at publish and nowhere else.
- **Mine transcripts after the run instead of having agents self-report.** Kept as a project-side audit tool, not as the mechanism: transcript formats are harness-specific and this skill runs on any harness with the four hooks. Self-reported seconds are approximate; they are also portable.
- **Cap the round counts or the parallelism.** Not the problem: the waste was inside each round, not in how many there were, and the runs with no dependency chain already finished in wall time equal to their summed validation.

## Consequences

- **Gate, gate-fix and publish stop paying for the implementer's proof.** On the measured runs that is at least 36 full-suite runs, and every inherited result is one fewer place a background launch could turn into a poll loop.
- **A publisher always validates a rebased tree.** That is new work on a chain whose tip moved — one full-suite run per layer — and it is the one place the old design could publish an unproven tree.
- **A hang becomes a reported fact rather than a stall.** `timed_out` in `other_runs` names the command; the retrospective lists it; the operator learns of a deadlocked suite from the report, not from a 5 h poll in a transcript.
- **The validation list gains a feedback channel that cannot act on its own.** Proposals reach the operator with the numbers behind them, and the list changes only by the operator's hand. A run that tuned its own list would be a run whose checks nobody confirmed.
- **Self-reported timings are approximate and harness-neutral.** Where a project wants exact numbers it mines its own transcripts; the report's job is to be right about which command is the sink, not about the second decimal.
