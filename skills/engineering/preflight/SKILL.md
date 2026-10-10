---
name: preflight
description: Preflight a spec and its tickets before an unattended run — audit, drill, grill, then rewrite the tickets so the run never stops to ask.
disable-model-invocation: true
argument-hint: "#<spec>"
---

# Preflight

An unattended run stops for one of a handful of reasons: a ticket needs one that comes after it, a ticket leaves a decision to the agent, the app can't be driven end to end, a call hits production, or a prompt wants an admin. **Preflight finds every one of them now, with the operator at the keyboard, and fixes the tickets so the run never meets them.**

Two kinds of finding, kept apart throughout:

- A **fact** is the agent's to find — by reading, by sub-agent, or by a **drill**: a small, harmless, real execution that proves a claim instead of asserting it. Never ask the operator for a fact you can look up or drill.
- A **decision** is the operator's. Put each one to them; never settle one silently.

Preflight does not write a ticket's validation: the run works out which checks each ticket runs, in its own Methods phase, from the repo's validation catalogue (crew ADR-0035).

A **blocker** is a prerequisite the operator supplies once — a credential, a test account, an admin approval, a device — after which agents do the rest (ADR-0021). Preflight names each blocker with a command that shows it cleared.

## 1. Load

Read the spec, every sub-issue in list order with its body and comments, each one's `blocked_by` edges (see `docs/agents/frontier.md`, including its fallbacks for prose-only edges), and the repo's agent docs (`CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `docs/adr/`), CI config and task runner. Done when you can list every ticket with its current blockers.

## 2. Audit

Dispatch the six audits in [AUDITS.md](AUDITS.md) as parallel, read-only sub-agents, each handed the spec number, the ticket list and only its own section of that file. Each returns findings in the shape that section names, every finding tagged **fact**, **decision**, or **blocker**, with the ticket(s) it touches and its evidence.

Done when all six have reported. An audit that returns nothing states what it checked.

## 3. Drill

Turn every claim the audits make about the environment into a drill. Run them yourself or by sub-agent; record the command, its output and wall time.

- **Smoke e2e** — the thinnest end-to-end path the repo already supports: build, launch, one interaction, one assertion. If none exists, that is a finding, not a pass. An offline harness that drives the whole system with fakes at its edges (a fake agent in a real pty, a fake upstream) counts as end to end; name it.
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

Settled architecture or vocabulary goes into an ADR or `CONTEXT.md` as `domain-modeling` says. Done when the grilling frontier is empty and the operator confirms shared understanding.

## 5. Rewrite

Show the operator the full change set before touching the tracker: per ticket, the body diff; every new ticket; every edge added or removed; the new sub-issue order. Publish only on their approval.

Then wire the changes on the tracker: new tickets as sub-issues of the spec labelled `ready-for-agent` (or `ready-for-human` where the work itself needs a person), native `blocked_by` edges, sub-issue order matching dependency order.

## 6. Clear

Walk the operator through every blocker, one at a time: explain it, guide them, then run its check. Never clear one yourself.

## Done

Preflight is done when every line below holds — check each and report it:

- Every ticket's `blocked_by` names every ticket its e2e path needs, and sub-issue order respects the edges.
- Every external dependency has a decision, and every chosen mock has its ticket.
- Every confirmed elevation prompt has a workaround or a cleared blocker.
- The smoke e2e passed, and — for a UI — the driving drill passed.
- No open decision, spec gap or contradiction remains in any ticket.
- Every blocker's check passes.

Anything that does not hold is named in the report as what the run will stop on.
