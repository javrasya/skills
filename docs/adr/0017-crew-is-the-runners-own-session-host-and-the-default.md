# ADR-0017: Crew is the runner's own session host, and the default

## Status

Accepted — 2026-09-28. Renames the Orca runner to the **session runner**; Orca stays a supported session host. Amends ADR-0015's scope (see there). Amended 2026-09-30: the runner is no longer entered and has no screen on crew, the run console is walked by arrows, and its back key is Ctrl+Left (below).

## Context

The Orca runner relies on Orca for about 20 calls (`worktree`, `terminal`, `orchestration`): worktrees, launching each harness in a terminal, typing prompts, reading the screen, `tui-idle`, the Run mailbox, and focusing a tab. The run view's click takes the operator into Orca's own UI, away from the graph. Orca ships `node-pty` and `@xterm/*` itself, so the pieces to host sessions in the runner's own terminal exist without Orca.

## Decision

**The runner talks to a session host interface, and crew — a global binary published from a package in this repo — is the default session host; Orca is the other.**

- **One crew daemon per machine** owns every session's pty and every run's mailbox, and outlives any run and every screen. The first `crew` call starts it.
- **The runner is itself a session in crew**, but it is never entered (amended 2026-09-30): it draws no view there and has no row in the run console, so the operator never lands in a second copy of the tree. What its attached view used to take reaches it another way: R in the tree writes `resume-request.json` in the run dir, which the runner takes, and `l` enters runner.log as a session of its own.
- **The run console** is the run view's graph. Choosing an agent enters its live session in the same terminal, and a configurable **back key** returns to the graph. It is walked in three levels (amended 2026-09-30): the runs list, a run's tree, an agent's session. Enter, Right or a click goes in; Left goes from the tree to the list; the back key comes out of a session. `crew start` at a terminal opens the run's tree. The back key is **Ctrl+Left** by default: it never reaches the session, so pi loses Ctrl+Left (a word left, and folding its tree) and keeps both on Alt+Left, word left also on Alt+B. It replaced F12, the operator's choice for leaving a session by the arrow that walks back up; on a Mac, Ctrl+Left reaches the terminal only once the system's "Move left a space" shortcut is off. Plain Left was rejected as the back key: the agent would lose its cursor key, and a terminal sending Option+Left as ESC ESC [ D holds Left's own sequence inside it. Ctrl+] stays refused: pi binds it to jumping to a character. The console never passes Ctrl+C or Ctrl+D to a session, in their legacy, kitty or modifyOtherKeys forms, since both end pi and Claude Code; Esc still reaches it and interrupts a turn.
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
