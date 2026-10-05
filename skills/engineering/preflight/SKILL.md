---
name: preflight
description: Preflight a spec and its tickets before an unattended run — audit, drill, grill, then rewrite the tickets so the run never stops to ask.
disable-model-invocation: true
argument-hint: "#<spec>"
---

# Preflight

An unattended run stops for one of a handful of reasons: a ticket needs one that comes after it, a ticket leaves a decision to the agent, the app can't be driven end to end, a call hits production, a prompt wants an admin, or validation takes so long the run crawls. **Preflight finds every one of them now, with the operator at the keyboard, and fixes the tickets so the run never meets them.**

Two kinds of finding, kept apart throughout:

- A **fact** is the agent's to find — by reading, by sub-agent, or by a **drill**: a small, harmless, real execution that proves a claim instead of asserting it. Never ask the operator for a fact you can look up or drill.
- A **decision** is the operator's. Put each one to them; never settle one silently.

A **validation recipe** is the optimal set of checks one ticket runs to prove itself — format, lint, typecheck, tests, e2e — each cut to the narrowest scope that still proves the ticket. The whole recipe fits the **validation budget**: 7 minutes per ticket, because a run carries 5–30 tickets and a 30-minute suite per ticket makes it crawl. Preflight designs the recipe; it does not settle for whatever the repo happens to run today. A **kind of check the repo lacks** (no formatter, no linter, no type check, no end-to-end run) is a gap in the recipe, never a line that reads "none": preflight measures the cheapest fitting tool on today's code and proposes the **prefactor ticket** that adds it, blocking every other ticket; the operator decides whether it lands first or the gap is accepted in writing. A **repo gate**, a rule in the repo's own docs that says what gates a change, is part of the recipe until the operator defers it; a deferral is a decision, named in every Validation section it touches.

A **blocker** is a prerequisite the operator supplies once — a credential, a test account, an admin approval, a device — after which agents do the rest (ADR-0021). Preflight names each blocker with a command that shows it cleared.

## 1. Load

Read the spec, every sub-issue in list order with its body and comments, each one's `blocked_by` edges (see `docs/agents/frontier.md`, including its fallbacks for prose-only edges), and the repo's agent docs (`CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `docs/adr/`), CI config and task runner. Done when you can list every ticket with its current blockers.

## 2. Audit

Dispatch the six audits in [AUDITS.md](AUDITS.md) as parallel, read-only sub-agents, each handed the spec number, the ticket list and only its own section of that file. Each returns findings in the shape that section names, every finding tagged **fact**, **decision**, or **blocker**, with the ticket(s) it touches and its evidence.

Done when all six have reported. An audit that returns nothing states what it checked.

## 3. Drill

Turn every claim the audits make about the environment into a drill. Run them yourself or by sub-agent; record the command, its output and wall time.

- **Validation recipe** — for each ticket, pick per layer the narrowest form the Validation audit found: format and lint on changed files, incremental typecheck, tests for the modules the ticket touches, e2e for the ticket's own flow only. Run the whole recipe end to end against the code the ticket will touch, under `timeout 8m`; over 7 minutes fails the budget. Cut a failing recipe until it fits — narrower scope, test filters or tags, a build reused across steps, parallel runs, caching — and move what still doesn't fit (full suites, full e2e) to the ticket's `### Run at review`, run once on the stack tip, not per change.
- **Smoke e2e** — the thinnest end-to-end path the repo already supports: build, launch, one interaction, one assertion. If none exists, that is a finding, not a pass. An offline harness that drives the whole system with fakes at its edges (a fake agent in a real pty, a fake upstream) counts as the e2e the tickets run per ticket; name it.
- **Absent check kinds** — for each kind the Validation audit reports absent, run the cheapest fitting tool once on today's code and record its baseline: error count by rule, wall time. That baseline is the prefactor ticket's finish line.
- **UI driving** — when the app has a UI, prove an agent can drive it with the chosen tool (a browser automation MCP, a toolkit-specific MCP, an accessibility driver): launch, send input, read state, take a screenshot. If the real app can't be launched yet, build a throwaway app on the **same UI toolkit** in the scratchpad and drill that.
- **Elevation** — for each suspected admin, UAC, sudo, keychain or OS-permission prompt, run the smallest harmless action that would trigger the same prompt, and observe whether it does.

A drill waiting on a decision (which UI tool, which mock) runs after that decision, in step 4. Done when every environment claim has a drill result, or a stated reason it cannot be drilled.

## 4. Grill

Invoke the `grilling` and `domain-modeling` skills and work the decisions as a design tree. The frontier of the first round usually carries:

- Each **order** finding: new blocking edge, moved ticket, or new prerequisite ticket.
- **E2E or not** — full end-to-end, component-level only, or both; per surface (UI, backend, CLI).
- The **UI driving tool**, then its drill.
- Each **external dependency**: production endpoint, a sandbox, or a mock server the agents control. A mock becomes a new ticket that blocks every ticket calling the dependency.
- Each **credential** e2e needs, and where it comes from (env var, secret store, test account) — never pasted into a ticket.
- Each **elevation** prompt the drill confirmed: how to avoid it (pre-approve, run unelevated, test-only install path, run once by hand as a blocker).
- Each **open decision** an implementer would otherwise make mid-run.
- Each **spec gap** and **contradiction**: amend the spec, amend the ticket, or declare it out of scope.
- Each recipe that only fits the budget by dropping coverage: which checks move to review.
- Each **absent check kind**: a prefactor ticket that adds it and blocks every other ticket, or the gap accepted in writing.
- Each **repo gate** the recipe does not run as written: run it per ticket, or defer it to review, by decision.

Settled architecture or vocabulary goes into an ADR or `CONTEXT.md` as `domain-modeling` says. Done when the grilling frontier is empty and the operator confirms shared understanding.

## 5. Rewrite

Show the operator the full change set before touching the tracker: per ticket, the body diff; every new ticket; every edge added or removed; the new sub-issue order. Publish only on their approval.

Every ticket leaves preflight with its validation recipe written as a **Validation** section beside its acceptance criteria, in two subsections. `### Run per change` holds the commands every implementer, fixer, gate reviewer and publisher of the ticket runs on its commit. `### Run at review` holds the full suites the whole-stack review runs once on the stack tip. Each command is one line holding one backticked command. Prose lines — "absent: …", "not applicable: …", "Recipe measured …", "Needs: …", a deferred repo gate — are allowed in either subsection and are never run as commands.

A recipe line may already be red. The run baselines every recipe command once on its pinned base before it dispatches anything, and a check that already fails there is a **pre-existing failure**: a role whose red is made only of those may judge it green, a **waived check**, listed on the PR (ADR-0030). So write the command the ticket needs, not one trimmed until it passes on today's code; a known red is worth a line in the ticket's acceptance criteria only when the ticket is meant to fix it.

```
## Validation

### Run per change
- Format/lint: `<command scoped to changed files>` — or "absent: added by #<prefactor ticket>"
- Typecheck: `<command>` — or "absent: added by #<prefactor ticket>"
- Tests: `<command scoped to this ticket's modules>`
- E2E: `<command for this ticket's flow>` — or "absent: added by #<prefactor ticket>", or "not applicable: <reason the operator accepted>"
- Recipe measured <m:ss> in total, budget 7m
- Needs: <blockers this ticket depends on, each with its check command>

### Run at review
- `<full suite>` — one line per suite; or "not applicable: <reason>"
- Deferred repo gate: <gate>, decided <date>
```

Then wire the changes on the tracker: new tickets as sub-issues of the spec labelled `ready-for-agent` (or `ready-for-human` where the work itself needs a person), native `blocked_by` edges, sub-issue order matching dependency order.

## 6. Clear

Walk the operator through every blocker, one at a time: explain it, guide them, then run its check. Never clear one yourself.

## Done

Preflight is done when every line below holds — check each and report it:

- Every ticket has a Validation section with both `### Run per change` and `### Run at review`; a ticket without `### Run per change` will not arm — `crew start` refuses the spec and names the ticket.
- Every ticket's `### Run per change` was run end to end, in total under the 7-minute budget.
- Every kind of check exists in the repo or has its prefactor ticket; no Validation line reads "none" without a reason the operator accepted, and every deferred repo gate is named as a deferral in `### Run at review`.
- Every ticket's `blocked_by` names every ticket its e2e path needs, and sub-issue order respects the edges.
- Every external dependency has a decision, and every chosen mock has its ticket.
- Every confirmed elevation prompt has a workaround or a cleared blocker.
- The smoke e2e passed, and — for a UI — the driving drill passed.
- No open decision, spec gap or contradiction remains in any ticket.
- Every blocker's check passes.

Anything that does not hold is named in the report as what the run will stop on.
