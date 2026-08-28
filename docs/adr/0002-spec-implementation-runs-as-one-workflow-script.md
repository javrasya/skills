# ADR-0002: Spec implementation runs as one workflow script, with a review gate per ticket

## Status

Accepted — 2026-08-28

## Context

Implementing a spec issue with tickets under it is orchestration work: read the spec and its tickets, understand the blocking relationships, run implementers concurrently where the graph allows, merge each onto one PR branch, review, ready the PR.

Done by a main agent, that loop degrades in a specific way. The orchestrator reads the spec, then every ticket, then research, then diffs, then review findings — and by the time it is scheduling the last ticket it is the least capable participant in its own run, having spent its context on material it needed only to pass along. The concurrency also has to be hand-managed, which is where the merge collisions come from.

`implement-spec` (Anthropic's skill) describes the loop well but leaves both problems with the orchestrator: it is prose the agent follows, so scheduling is a judgement call each time, and it reviews only once, at the end, after every ticket has merged.

Three questions had to be settled:

1. **Who schedules** — the agent, reading the tickets and deciding what to start, or a deterministic script?
2. **When code is reviewed** — only at the end, per ticket, or both?
3. **What happens to a ticket no agent can do** — a live hardware run, credentials only a person holds.

## Decision

**The whole loop is one workflow script**, and the orchestrating agent renders and launches it. A discovery agent *inside* the run reads the spec and tickets and returns the task graph as data; the orchestrator never reads a ticket body. Scheduling is then plain control flow: each ticket is a memoised promise awaiting its dependencies' merges, so the frontier is emergent rather than decided, and the run costs the longest chain rather than the sum of the phases.

**Mergers are serialised while implementers stay parallel.** One agent touches the PR branch at a time, through a single-slot queue. Concurrency is the point of the design everywhere except here, where it is the failure mode.

**Every ticket is reviewed before it merges**, on its own branch, against its own ticket's acceptance criteria — and the whole merged branch is reviewed again at the end. Review and fix alternate until a review returns nothing blocking, a fresh reviewer each round, capped; on the cap the ticket merges with what is unresolved, named in the log and the summary.

A fixer may **reject** a finding it judges wrong, with a checkable reason, and those rejections accumulate into a ledger carried into every later round — a later reviewer may raise a rejected finding again only by falsifying its stated reason.

**A ticket needing a human is excluded, along with everything downstream of it**, and the PR is held as a draft with a comment naming what remains.

`code-review` is **vendored** from Matt Pocock's repo for this, extending ADR-0001's decision to the skill this one calls. ADR-0001 named upstream drift as a consequence but shipped nothing to catch it, so vendoring now carries provenance: `vendor.tsv` pins the upstream sha last reviewed for each vendored file, and `scripts/check-vendored.sh` reports, diffs, or pulls when upstream moves past it. The pin tracks upstream rather than our copy, because a vendored file is *expected* to differ locally — attribution headers, genericization — so comparing the two would report drift forever.

## Consequences

- **The orchestrator stays sharp.** Its context holds an issue number, five interpolated values and a summary, so the last decision of a run is made as well as the first.
- **The schedule is reproducible and resumable.** The same graph produces the same order every time, and a failed run resumes from its own script — the unchanged prefix of agent calls returns from cache.
- **Defects are cheapest where they are found.** A ticket's own diff, reviewed while its author's reasoning is still recoverable, is a far smaller thing to fix than the same defect found under six other tickets. The final review is not redundant: only it can see the interaction *between* tickets.
- **The gate loop needs the ledger to terminate.** Without it, a fixer and a reviewer who disagree trade one finding until the cap on every run — the loop's real hazard is ping-pong, not slow convergence.
- **The cap can let a known finding through.** Merging with unresolved findings is deliberate: refusing would stall every ticket branching off the PR branch behind one disputed call. It is loud rather than silent, and the final review sees it again.
- **A run can finish without finishing the spec.** When a human-only ticket exists, the PR is deliberately left as a draft. That is a correct outcome, not a failure.
- **It needs a harness with a workflow primitive.** Unlike every other skill here, this one cannot run on prose alone — see the prerequisites table in the README.
- **Vendored drift is now visible.** The first run of `check-vendored.sh` found `handoff` already behind upstream, which is the argument for the manifest in one line. Visible, not automatic: pulling an upstream change is still a judgement call.
