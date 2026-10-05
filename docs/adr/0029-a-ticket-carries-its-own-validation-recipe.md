# ADR-0029: A ticket carries its own validation recipe, and the run reads it from there

## Status

Accepted — 2026-10-05. Amends ADR-0009: its rules on the validated sha, inheritance, foreground checks and no cache clean stand; its "validation list" is now the ticket's per-change recipe, and its timing fields, ledger and retrospective report are gone. Amends ADR-0018 and ADR-0019: the orchestrator no longer drafts a validation list, so that question, its confirm step in the arming form and its headless run are removed; halt triage and the `?` session stay. The preflight skill's Validation section is the format this ADR depends on.

## Context

Two things said what a change must pass. `validation.md`, one file per spec in the notes directory, drafted from CI config by the arming agent or by crew's orchestrator, confirmed once by the operator in the arming form, rendered into `workflow.js` as a template literal and handed to every role of every ticket. And the ticket's **Validation** section, which preflight writes per ticket: format, lint, typecheck, tests and e2e, each cut to the narrowest scope that proves that ticket, measured under a 7-minute budget, with full suites "left to review".

The run read only the first. So a preflighted ticket's recipe was advice nobody ran, every ticket ran the same spec-wide list whatever it touched, "left to review" moved full suites to nowhere, and `crew start` needed a terminal, an orchestrator and a confirm step to produce a file preflight had already made redundant. The file also forced a validation-list grammar (no backtick, no `${`, no trailing backslash) that existed only because the list lived inside a JavaScript template literal.

## Decision

**The ticket is the only place a change's checks are written, and the run reads them from the ticket.**

- **Format.** A ticket's `## Validation` section has two subsections. `### Run per change` lists the commands every implementer, fixer, gate reviewer and publisher of that ticket runs on its commit. `### Run at review` lists the full suites the whole-stack review runs once on the stack tip. Prose lines — "absent: added by #N", "not applicable: reason", "Needs: …" — are allowed in either and are not commands. Preflight writes this shape; the operator may edit it by hand.
- **Arming is deterministic.** `crew start` reads every `ready-for-agent` sub-issue's body and refuses to arm, naming the tickets, when any lacks `## Validation` with `### Run per change`. No LLM is consulted; a heading match is a string match. A stray `validation.md` is ignored with one warning.
- **Extraction is the dispatcher's.** The dispatcher, which already reads the ticket, returns the per-change and at-review commands as structured arrays. The script hands the per-change array verbatim to every role of that ticket and checks readiness against it; it unions the at-review arrays over all tickets for the whole-stack reviewer, where a red is a blocking finding.
- **The gate cross-checks.** The gate reviewer reads the ticket anyway; a per-change command on the ticket that the brief's list omits is a blocker, so a dispatcher that drops a line costs one round, not a run.
- **Every slice runs the full per-change recipe** on its commit, as every slice ran the list before; sha inheritance keeps repeats cheap.
- **A section with no commands is honest.** It is the operator's decision that nothing applies; the role is told so and reports each command it ran anyway.
- **The retrospective is gone.** No `validation-report.md`, no ledger, no `seconds`, `runs`, `other_runs` or `timed_out` fields: a role returns `checks: [{command, passed}]` and `validated_sha`. Those fields fed proposals for a file that no longer exists, and a dead field is one an agent fills with something.

## Considered options

- **Keep `validation.md` as the spec-wide floor and add the ticket's recipe on top.** Rejected: two sources of truth for one question, and the floor is what made every ticket run the whole suite.
- **Every role reads the ticket itself and reports what it ran.** Rejected: fixers are deliberately kept off the issue, and readiness by exit code needs a list the script knows before the agent answers.
- **An LLM decides at arm time whether a ticket's section is adequate.** Rejected: ADR-0018 keeps crew's arming deterministic. Adequacy was settled in preflight with the operator; arming checks only that the decision was written down.
- **Halt the ticket at dispatch when the section is missing.** Rejected: that spends agents on the other tickets first and stops the run later; the heading check costs one API read per ticket before anything starts.
- **Keep the retrospective, retargeted at tickets.** Rejected: nothing applied its proposals before and nobody read them; the recipe is now designed and timed in preflight, where the operator is present.

## Consequences

- Preflight becomes the step that makes a spec armable, not a courtesy pass.
- `crew start` arms with no terminal and no orchestrator round-trip; the only orchestrator questions left are halt triage and the operator's `?` session.
- The validation-list grammar and its module disappear: commands reach prompts at run time, never through rendered source.
- Full suites run once per run, at the whole-stack review, instead of once per ticket or never.
- A spec whose tickets predate preflight does not arm until preflight runs over it.
