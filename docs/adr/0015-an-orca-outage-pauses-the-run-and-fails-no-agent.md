# ADR-0015: An Orca outage pauses the run and fails no agent

## Status

Accepted — 2026-09-27. Extends ADR-0013. Applies to the **session runner** on either session host (amended 2026-09-28 by ADR-0017): an outage of crew is a session host outage like Orca's, except that crew takes its sessions down with it, and they are carried on by session continuation when it comes back.

## Context

In the spec #1186 run, Orca auto-updated at 18:10. The updater closed the app, which removed `orca-runtime.json`, and replaced its install folder, so the `orca` CLI did not exist for about 20 seconds. The app was back by 18:10:59. The runner's watch loop counted three failed `worker-show` calls, five seconds apart, as `watchErrors: 3` and failed `impl:#1187` at 18:10:31. The worker was fine: Orca's terminal daemon was not restarted, its session kept working, and its dispatch settled `succeeded` at 18:15:37. Because `impl:#1187` returned null, #1188 to #1190 were failed with it. Orca's promise that an update breaks nothing held for everything inside Orca. It did not hold for a script outside Orca that needs the CLI throughout.

Each Orca call site handled failure on its own terms: the watch loop had its error count, a start had its backoff (and spent an attempt on the outage), and `worker-stop`, continuation, the mailbox and doctor launches had nothing. An outage takes Orca away from all of them at once.

## Decision

**An Orca outage is one event for the whole run, waited out and never charged to an agent.**

- **Only "Orca is not there" is an outage**: `runtime_unavailable`, the CLI failing to start (`Unable to start the Orca CLI`), and `spawn orca ENOENT`. A timeout, or an error from an Orca that answered, keeps its existing handling, so an Orca that hangs cannot stall the run forever.
- **Every Orca call waits on the same outage.** No watch error, start attempt, nudge, continuation or doctor round is spent on it.
- **The runner's clocks stop for its length.** No agent is seen while Orca is gone, so none goes stuck, blocked past its limit, or through its backoff because of it.
- **It is waited out with a probe**: every 5s, doubling to every 30s, for up to 10 minutes. The one restart measured took about 40 seconds. Waiting costs almost nothing, and giving up costs tickets.
- **An outage past 10 minutes pauses the run; it never fails anyone.** The runner stays in its tab (the tab survives an Orca restart, since terminals live in Orca's daemon), probes every 2 minutes, and carries on in the same process once Orca is back. `R` in the attached view (`r` since ADR-0020) probes at once. A paused run is recorded in the run registry and listed as `paused (Orca outage)`, not `running`. The standalone view's Resume run remains the path when the runner process itself is gone.
- **The journal records it** with an `outage` entry when it starts and when it ends, and the run view's header says so while it lasts. A view key that needs Orca during an outage says so and does nothing.

## Considered options

- **A longer `watchErrors` count, or a 5-minute cap that fails agents.** Rejected: a count is still charged to one agent for a run-wide event, and failing work because the tool that watches it is down is the bug itself.
- **Waiting forever.** Rejected in favour of a pause: the operator should see that the run has stopped, and why.
- **Counting timeouts as an outage.** Rejected: a slow Orca is still answering, and an Orca that hangs would stall the run without limit.
