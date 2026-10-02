# ADR-0025: Agent sessions survive a daemon restart, parked

## Status

Accepted — 2026-10-02. Amends ADR-0017, under which a session dies with its daemon and only an unsettled agent's comes back, through its runner. Builds on ADR-0024's parking. Applies to the **crew host only**. Issue #164.

## Context

A session is a pty the daemon holds in memory, so a daemon that dies (a crash, a kill, a reboot, `crew daemon stop --force`) takes every session with it. The next daemon restarts each live run's runner, and that runner continues each unsettled agent in a new session (`hostDied`). Every other agent was lost to the person: a done or failed agent's row showed `(closed)`, its conversation reachable only by running `claude --resume` by hand in the right directory. An unsettled agent whose runner was not restarted (the run halted, its script gone) was lost the same way.

The harness keeps every conversation on disk. All a session needs to come back is the line it ran and where it ran it.

## Decision

**The daemon's book keeps each agent session's command, cwd and title, and the next daemon restores every one of them as a parked session (ADR-0024) under its old id. Entering it resumes its harness in a pty.**

- **Every agent session comes back**: done, failed, cancelled or still working. A session of no dispatch (a runner, a log tail) does not: a runner is started again by recovery, and a log tail is the person's to reopen. A closed session is forgotten.
- **No program runs until it is entered.** A restored session is its record only: its info says `parked` and `restored`. Entering it starts the harness on its resume line (`claude --resume <id>`, pi's `--session-id`), in its cwd, under the same session id.
- **A working agent is still its runner's.** Until it is entered, an unsettled agent's restored session shows as `gone` with `hostDied`, the session the old daemon lost. The recovered runner continues it as before: in a new session, on its resume line, with its continue prompt, spending none of its continuations. Entered first, it is a live session again, and the runner watches it like any other.
- **The env is never written to disk.** It holds the person's whole shell environment, keys included. A restored session runs in the daemon's own environment with crew's on top (`CREW_SESSION`, `CREW_HOST`, `CREW_HOME`, `HOSTED_ENV`), as a session crew starts does. So a restored agent gets the env of the shell that started the new daemon, not the one that started it first.

## Considered options

- **Start every restored harness at once.** Rejected: a daemon restart would start one `claude` per agent of every run kept, most of them done, and a working one would then run twice: once restored, once continued by its runner.
- **Write the env to the book.** Rejected: `runs.json` would then hold API keys in plain text.
- **Leave unsettled agents to the runner only.** Rejected: a run whose runner is not restarted would lose them, and the person could not even look.
