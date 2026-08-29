# ADR-0004: Every fix is routed through the dispatcher; context overflow is never self-declared

## Status

Accepted — 2026-08-30. Extends the dispatcher introduced for `implement-spec-in-workflow`'s implementation phase to every fix the run makes. Amends nothing in ADR-0003; publish-once, the serial lane and the integration PR all stand.

## Context

The dispatcher was introduced to solve one measured problem: a single long-lived implementer accumulates every read and every thought for its whole life and pays for all of it again on each turn (276 turns, 362K peak context in the run that prompted it). It reads a ticket once, sizes the work, and briefs fresh-context agents.

The **gate fixer** was left outside that arrangement. It received the dispatcher's `ticket_brief` instead of the issue — a real saving — but still owned the whole batch of blocking findings itself, and reached the dispatcher only through an escape hatch: a prompt instruction telling it that, past roughly 70 tool calls, it should fix what it could and return the rest as `overflow` for the dispatcher to slice. The dispatcher was, in the words of the glossary at the time, the run's *universal overflow handler*.

That hatch does not fire. In an observed run of spec #225 the gate fixers reached **205.2K and 344.8K tokens** (35m and 49m, one of them after a harness retry) and handed nothing off. This is not a tuning problem. The instruction asks an agent to notice, from inside a context it has already filled, that it should stop — and self-assessment is the first faculty context pressure degrades. An agent that is drowning does not file a report saying so; it keeps swimming.

Two related defects came from the same design. The overflow path discarded its own result (`await runSlices(...)` with the return value dropped), so a dispatched finding produced **no verdict** — it never entered the rejection ledger, never registered as fixed, and the next reviewer had no stated reason to falsify. And the overflow dispatcher and its slices were hardcoded to `phase: 'Implement'`, so gate-time work rendered in the wrong phase of the run's own progress display — the reason the failure was hard to see from the outside.

The whole-stack review's **integration fixer** had no hatch at all: one agent, the widest diff in the run, every finding, plus opening the PR at the end.

## Decision

**The dispatcher is the only route into any work this run does.** Two entry points, one role: `dispatch()` sizes a ticket into implementation slices; `dispatchFix()` sizes a batch of review findings into fix slices. Nothing reaches an implementer or a fixer unsized. There is no monolithic fixer anywhere in the run, and `overflow` is deleted from the schema — there is nothing left for an agent to self-declare.

**Routing is unconditional, not threshold-gated.** A finding count is a poor proxy for context cost: "rename this" and "extract this" read alike in one line and differ by orders of magnitude. The dispatcher is already biased against slicing — one slice is its normal verdict — so an always-on route costs one `medium`-effort agent per fix round and usually returns a single slice, exactly the bargain already accepted for every ticket in the Implement phase.

**Fix slices return one verdict per finding, and the script reconciles them.** Each slice's brief names the findings it owns; each slice returns `fixed`/`rejected` verdicts plus any it did not reach. The workflow then matches verdicts back to findings **in JavaScript** — exact match on location and issue, else a location only one verdict claims — and any finding with no verdict is named in the log and handed to the next round's reviewer with an explicit instruction to check it on the branch. Reconciling in a prompt would re-introduce the failure this ADR exists to remove.

**A fix round is never re-dispatched in place.** Whatever a slice does not reach falls to the next gate round, whose reviewer re-derives what is still broken from the branch itself. `MAX_DISPATCH_ROUNDS` governs re-slicing in the Implement phase only, where no reviewer exists to re-derive anything. One cap governs the gate, not two multiplying ones.

**Publishing is separated from fixing.** The integration PR is opened by its own `low`-effort agent that changes no code, rather than by whichever fix slice happened to run last and hold the most context. Publishing is the only irreversible act of the Review phase.

## Consequences

- **An extra agent per fix round**, at `medium` effort. Ticket-sizing stays `high`: it reads an issue, a spec and unfamiliar code. Fix-sizing reads a finding list in which the reviewer already named `path:line` and a proposed fix.
- **Gate and Review agents now render in their own phases.** The `phase` is threaded through the fix path rather than hardcoded, so the progress display stops attributing gate work to Implement.
- **A dropped finding is now visible.** Previously it vanished; now it is logged and the next reviewer is told to check it by name. The run still trusts the fresh review as the final word — that is the loop's correctness mechanism — but it no longer depends on the reviewer independently rediscovering something the run already knew about.
- **A dead fix slice stops its round rather than failing the ticket.** The branch may be mid-change, so later slices do not build on it; the next reviewer reads the branch rather than anyone's account of it.
- **The generalisable claim, beyond this workflow: context economy has to be structural.** Any budget an agent is asked to enforce on itself, from inside the context being spent, is a budget with no enforcement. Size the work before the agent starts, or do not size it at all.
