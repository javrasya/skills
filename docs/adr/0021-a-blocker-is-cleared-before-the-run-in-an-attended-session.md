# ADR-0021: A blocker is cleared before the run, in an attended session

## Status

Accepted — 2026-10-01. Amends the graph's `needs_human` in ADR-0002's discovery step, and ADR-0013's nudges for one agent.

## Context

A run of spec #827 automated one ticket of nineteen. The graph agent found that the build host had no Developer ID signing identity or profile, which two tickets need. It marked both tickets `needs_human`, and every ticket downstream of them was deferred with them: eighteen tickets, all labeled `ready-for-agent`. The run implemented #1199 and went straight to the whole-stack review of a one-ticket stack. Two earlier runs of the same spec had judged the same tickets automatable and would have failed at the signing step instead.

The finding was right and useful. What was wrong is what it did. A missing certificate is not a ticket that needs a person's hands throughout; it is a prerequisite a person supplies once, after which every ticket is an agent's. The operator was at the machine and could have installed it in ten minutes. Nothing asked them to.

Every agent in a run is told nobody will answer it (`NO_ASK`), and the runner nudges, continues and finally fails an agent that sits idle. The one exception is a doctor's escalation (ADR-0014), which needs you and waits without a deadline.

## Decision

**What discovery finds missing from the environment is a blocker, not a human ticket. A run with blockers clears them first, in one attended session where an agent guides the person, and starts implementing only once every blocker is verified clear.**

- **A blocker** is a prerequisite a person can supply once so that agents can do the rest: a credential, a signing identity or profile, a device or service set up and running, an account or permission. The graph agent and each explorer return the blockers they find, each with what is missing, which tickets need it, the evidence they saw, and a command that shows it cleared. `needs_human` stays for a ticket whose work itself needs a person, judged as before. A ticket a blocker touches is still automated.
- **The unblock phase** comes after Explore and before Setup, and only when there are blockers. It is one agent call, `attended: true`, in the project with no worktree. The agent is handed the blockers and told never to fix them itself: it explains, asks, guides the person, and runs each blocker's check to verify it. It ends the way every agent ends, by submitting its result, and only when every blocker is verified clear or the person tells it to stop.
- **An unresolved blocker halts the run.** The agent returns blockers it could not clear as `decisions_needed`, so the node is held and the run halts as for a decision (ADR-0016). Resuming the run continues the same session, with the person, where it stopped. Nothing is implemented until the unblock node succeeds with nothing unresolved.
- **An attended agent has no clocks.** On the session runner, `attended: true` puts the agent under the same exemption as an escalated doctor for its whole life: it is never nudged, never counted stuck, and the blocked limit does not count. It shows `needs you` from its start, with the blockers as the reason, and the runner logs `NEEDS YOU`. Its prompt drops `NO_ASK` and says a person will join. Session continuation still applies, so a session that dies is carried on, not lost.
- **The Workflow runner has nobody in its sessions.** There the run halts at the unblock phase with the blockers listed, for the operator to clear before resuming.

## Considered options

- **Make the triage label authoritative**, so a `ready-for-agent` ticket is never `needs_human`. Rejected: the graph's finding was correct, and the ticket would have been started and failed at signing. The label says the ticket is an agent's; it cannot say the machine is ready.
- **Halt at discovery with the blockers listed**, no session. Rejected: the person then works through them alone, and the next run's discovery is the only check that they are clear.
- **Hold only the tickets a blocker touches** while the rest build. Rejected for now: blockers found at discovery are cheap to clear before anything starts, and a run with one waiting branch of its graph is harder to read than a run that has not started.
- **An escalation from a running agent**, as a doctor does. That stays for what nobody could foresee; this is for what discovery already found.
