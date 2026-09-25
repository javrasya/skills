# ADR-0013: The Orca runner is its own reliable orchestrator, with no durability engine

## Status

Accepted — 2026-09-24. Extends ADR-0011. Applies to the **Orca runner only**; the Workflow runner, and the shared workflow script, are unchanged.

## Context

In the spec #783 W5.2 run, one transient start failure killed three tickets. Worker n=17 (#1087 slice 2) failed inside `workerStart`, after `orca worktree create` had made `run_55d94954c294-17` and before `worker-start` was called. Gate n=28 failed the same way. The journal's `failed` entry held no reason, the error went only to stdout in a tab that then closed, `execOrca` had no timeout, and nothing retried. Slice 1 had already committed on a local branch, so one start failure lost a half-done ticket and the two it blocks. The machine was under memory pressure that night. Under the Workflow runner the host retries a failed start, which hides this class of failure.

Orca workers are real Claude or pi sessions with transcripts, so a session that dies or stalls can be carried on (`claude --resume`) instead of restarted, and a runner that dies can come back to workers still running.

A durable-execution engine was weighed first, since retries, heartbeats and crash-proof step records are exactly what they sell:

- **Temporal** (single binary with SQLite, web UI): the best fit on paper, but a second system to run beside Orca, and it does not know Orca's workers.
- **Inngest**: a single binary, but steps run over HTTP, and hours-long agents need a workaround. The server licence is SSPL-style.
- **DBOS**: a library with no server, but SQLite is Python-only; the TypeScript version needs Postgres, and its dashboard is a paid hosted service.
- **Restate** and **Hatchet embedded**: no Windows build. **Prefect** re-runs instead of resuming. **Airflow**, **Dagster** and **Trigger.dev** are too heavy.

The hard parts here are Orca-specific: reattaching to a worker, continuing a session, and telling a stalled agent from a busy one. No engine knows them. What an engine would add is persistence, which Orca's Run store and the runner's journal already give.

Orca also constrains where the orchestrator may live. It identifies the caller by environment variables the terminal sets, and binds a Run to its coordinator's pane. Once that tab closes, `worker-start` and `dispatch` are refused (`consumer_fenced`). A new terminal takes the Run over with `orchestration run-use --id`. `worker-list`, `worker-show`, `worker-stop` and `worker-release` are not fenced at all.

## Decision

**`runner.mjs` is the orchestrator, and it is made reliable in itself.** No durability engine and no second system.

- **Orca is the truth for live workers, and the journal is the truth for the run.** Each journal entry carries a timestamp. `started` records the dispatch id, the Claude or pi session id, the worktree and the tab. `failed` records the reason. The runner copies everything it prints to a `runner.log` in the run directory.
- **Starting is idempotent, keyed by `<runId>-<n>`.** A clean worktree of that name with no worker is reused. A dirty one fails the start and is kept.
- **A start that fails is retried**, 3 times with backoff (about 30s, 2m, 5m), before the agent returns null. **Every `orca` call has a timeout**, so a hung call is a failure to retry rather than a silent stall.
- **An agent is stuck when neither its transcript nor its terminal's busy or idle state has moved for a set time.** It is nudged, and then its session is continued.
- **Session continuation** carries a dead or stalled session on in the same session, worktree and tab, capped at 3. An agent past the cap is failed and kept (ADR-0012). An agent that never started has no session, so it is retried, not continued.
- **Resume run relaunches the runner in a new tab**, which takes the Run over with `run-use`, reattaches to the workers still alive, continues the dead ones, and replays finished agents from the journal. It is started from the run view (ADR-0012) or by hand.
- **The run view is a separate process.** It is a child of the runner in the runner's tab, so a crash in the view never touches the run.

## Consequences

- **A transient start failure costs a retry, not a ticket**, and when a failure does stick, its reason is on disk.
- **Everything reliable is our code.** The retry policy, heartbeat thresholds and continuation cap live in `settings.mjs`, and they are checked twice. The runner contract test (orca/README.md) runs on real Orca, and covers a start failure, a killed worker continued in a new terminal, and a resume through `run-use`. The offline suite (`scripts/test-orca-runner.mjs`) runs on the fake Orca, and also covers a stalled session. Continuing a stalled session in its own tab (interrupt, `claude --resume`, same dispatch) and interrupting a pi worker are not yet confirmed against live Orca; the pass record lists them as a known risk.
- **The runner cannot outlive its tab as coordinator.** A dead tab pauses the run rather than ending it. Workers keep running unsupervised until Resume run reattaches, and that is by design in Orca.
- **Continuation trusts the session.** A session that dies from its own context comes back with that context. The cap of 3 bounds the cost, and the context-size colour in the run view shows it coming.
- **Revisit an engine** if runs need to span machines, or if Orca gains a native durable workflow. Today neither is true.
