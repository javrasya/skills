# ADR-0008: ADR fit is not a gate blocker; the acceptance contract is the ticket, the spec, and the ADRs the spec creates

## Status

Accepted — 2026-09-05. Narrows what the per-ticket gate in `implement-spec-in-workflow` may block on. Amends nothing in ADR-0004; the dispatcher, the rejection ledger and script-side reconciliation all stand.

## Context

The gate ran the `code-review` skill with both axes at full weight. Its standards axis judges "this repo's documented standards", which in a repo with ADRs means every ADR. So every ticket was re-checked against every architectural decision ever recorded, and any mismatch was a blocker.

An observed run (spec #339, 45 child calls for four tickets) spent most of its gate rounds this way. Findings such as "public type lacks `#[non_exhaustive]` per ADR 0007" and "provisional interpretation conflicts with ADR 0057" blocked tickets whose own criteria were met, and one dispatcher, told to satisfy an ADR the ticket did not name, chose a reading of it and asked the implementer to "record the tension as a gap for the human" — work review could not legitimately pass. The same run relabelled a required test the implementer had not written as a "gap" and sent it to the gate, where a fixer rediscovered it a round later.

Three causes, one shape: the run had no single definition of done. Dispatcher, implementer, fixer and reviewer each held a different one, and the gate became the place implementation finished rather than the place it was verified.

## Decision

**The acceptance contract of a ticket is its own criteria, the spec's decisions that bear on it, and any ADR the spec itself creates or amends. Nothing else binds.** Existing ADRs were checked when the spec was designed — while grilling, wayfinding, writing the spec. Re-proving them ticket by ticket repeats that work at the most expensive point in the run, and a mismatch found there is an ADR-drift question for the spec's author, not a defect in the ticket. The same sentence is put to the dispatcher, every implementer, every fixer and every gate reviewer.

**What may block at the gate is exactly three things**: an acceptance criterion the diff does not meet; a red command from the project's validation list; and a correctness bug — a panic or crash reachable from input, an unhandled variant, silent data loss, a check that only runs in debug builds. Everything else the standards axis notices — ADR fit, architecture, naming, style, a documented convention — is reported as `minor`, which passes the gate. It stays visible on the PR; it costs no round.

**Work not done is a remainder, never a gap.** A criterion, a test or a file the brief asked for and the slice did not deliver goes back to the dispatcher, up to `MAX_DISPATCH_ROUNDS` (raised from 3 to 6, because a readiness red now spends a round too). The only thing a slice may hand forward is a question a human must answer, in `decisions_needed`, and it may never pick a reading in the meantime: it stops that criterion, leaves no code for it, and goes on. **The dispatcher does not look for such questions.** It is a router, not a planner — it reads the ticket and a structural skim of the code, says how many slices and which criteria each owns, and writes a brief under 3K characters with no design in it. The ticket was cut from the spec by a human and is trusted as written; a gap is met by the implementer at the line where it lives. The first version of this decision put `decisions_needed` on the dispatcher too, and the observed result (#360) was a dispatcher that thought for 40 minutes before its first tool call, simulated the whole implementation to find five design questions, and cost $17 — design the implementer then redid with the code open. Whatever survives the cap still publishes, with `unmet`, so the run stays robust; the reviewer is told about it and does not block on it.

**Round 1 reviews the whole diff; later rounds verify the claimed fixes and the lines the fixer touched.** A fresh reviewer each round is what makes "clean" a verdict, but a fresh reviewer given the whole diff also finds new things every round. That is discovery, not repair, and it is the whole-stack review's job.

## Considered

- **Keep both axes at full weight and raise the round cap.** Funds the same failure pattern; rejected.
- **Drop the standards axis from the gate entirely.** Loses the correctness catches that axis made — a `debug_assert` silently keeping a bad node in release was one. Kept, narrowed.
- **Bind every ADR the dispatcher cites.** Makes the dispatcher's citation list the contract and the run still re-proves ADRs, just fewer. Rejected in favour of the explicit rule that existing ADRs are guidance.

## Consequences

- **A latent bug that round 1 misses now reaches the PR.** The cycle crash in #342 was found in round 2 by a reviewer re-reading the whole diff; under this decision the whole-stack review or the operator is the last net for that class. Accepted knowingly.
- **ADR drift becomes a PR-level concern**, handled after the stack exists, by a procedure that does not yet exist. The gate's `minor` findings are where that procedure would start.
- **Readiness is checked by exit code, not judgement**: every implementer, fixer and reviewer runs the same user-confirmed validation list and returns one result per command. Running a command is not the self-assessment ADR-0004 forbids.
- **Complete fails closed.** A dead reviewer, a whole-stack review that never ran, an unfixed gate finding or an open question each keep `Closes #<spec>` off the top PR.
