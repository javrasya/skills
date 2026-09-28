# ADR-0017: Crew is the runner's own session host, and the default

## Status

Accepted — 2026-09-28. Renames the Orca runner to the **session runner**; Orca stays a supported session host. Amends ADR-0015's scope (see there).

## Context

The Orca runner relies on Orca for about 20 calls (`worktree`, `terminal`, `orchestration`): worktrees, launching each harness in a terminal, typing prompts, reading the screen, `tui-idle`, the Run mailbox, and focusing a tab. The run view's click takes the operator into Orca's own UI, away from the graph. Orca ships `node-pty` and `@xterm/*` itself, so the pieces to host sessions in the runner's own terminal exist without Orca.

## Decision

**The runner talks to a session host interface, and crew — a global binary published from a package in this repo — is the default session host; Orca is the other.**

- **One crew daemon per machine** owns every session's pty and every run's mailbox, and outlives any run and every screen. The first `crew` call starts it.
- **The runner is itself a session in crew**, entered like any agent.
- **The run console** is the run view's graph. Choosing an agent enters its live session in the same terminal, and a configurable **back key** (F12 by default) returns to the graph. Ctrl+Left and Ctrl+] were rejected: pi binds both, to moving a word left and to jumping to a character.
- **Crew makes worktrees** at `<repo-parent>/<repo>.crew/<runId>-<n>`, then runs a per-repo setup hook from crew config. The hook is skipped for doctors.
- **Idle** comes from the session transcript, with quiet pty output as the fallback.
- **A crew crash kills its sessions**; this was verified on Windows, where a hard-killed pty owner takes its children with it. When crew comes back, every session a live run lost is carried on by session continuation, charged to no agent. Crew refuses to restart while runs are live unless forced. A daemon brings those runs back only as it starts, so the skill's crew path, finding its runner dead with no `summary.json`, starts one (`crew daemon start`) and waits for a runner to come back before it calls the run dead.
- **The run console is the operator's way in.** `crew console`, a flat list of the daemon's raw sessions from before the run console, is kept as a debug view, beside `crew session spawn|list|screen|kill`; `crew run`, `crew start` and the skill point the operator at `crew view <run>`.

## Deviations

Two deliberate departures from the tickets:

- **`crew ls` starts no daemon**, though #96 has every `crew` command start one. It reads only the run registry, where each run's liveness is its `runner.pid`'s to say, so a look at the list never starts a daemon, nor the run recovery a starting daemon does. `crew daemon stop` starts none either.
- **Without crew, no session runner is offered**, though #105 has the offer unchanged without crew. The runner is crew's package (#95), on Orca too, so the skill's Orca probe needs the crew probe: without crew the run goes on the Workflow runner, nothing is asked, and the skill says once that the session runner needs crew installed.

## Considered options

- **Keep Orca and only replace its UI.** Rejected: Orca exposes terminals only by polling (`terminal read`, `terminal send`), not as a live stream, so entering a session in place would lag.
- **WezTerm or tmux as the engine.** Rejected: WezTerm is another app to install, and tmux does not run natively on Windows.
- **In-process sessions with no daemon.** Rejected: closing the terminal would kill every agent in the run.
- **A mux package from npm** (aimux, amux, cmux and others). Not surveyed for reliability or Windows support. The glue is small beside the host work, so it was built rather than bought.
