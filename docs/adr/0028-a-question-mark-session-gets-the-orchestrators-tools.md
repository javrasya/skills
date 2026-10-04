# ADR-0028: A `?` session gets the orchestrator's tools, and acts on the run only as the operator's keys do

## Status

Accepted — 2026-10-05. Amends ADR-0027, whose tool table named workers and doctors only, and ADR-0026, whose `?` session the daemon knew by its title alone. Applies to the **crew host only**: `?` is the run console's. Issue #194.

## Context

A `?` session (ADR-0026) is started by crew with crew's extension or MCP server on its line, as every session crew starts is (ADR-0027), but it got no tool: the table had no row for it, and the daemon's `worker.agent`, which both harness paths ask, answered null for a session of no dispatch. Asked what crew gave it, an orchestrator session rightly said "none". It read the run's files by hand from a prompt that named them, and anything it was asked to do to the run it could not: pausing, resuming a halted node, and answering a held node's questions were the operator's keys in the run console, or a comment on the ticket followed by `r`.

The daemon could not have equipped it: it knew a `?` session by its title, `orchestrator/console`, and nothing of which run it was about. A title cannot carry the run (ADR-0026's considered options), and the console that opens the session is the one thing that knows.

## Decision

**The console tells the daemon which run a `?` session is about, the daemon answers the orchestrator's agent for it, and the tool table gains the orchestrator's rows: three that read the run, three that act on it as `p` and `r` do, through the same files.**

- **The run follows the session.** `consultSession` passes the run's state dir to the crew host's `sessionStart`, which passes it to `session.spawn` as `stateDir`. The daemon keeps it in the session's record beside its command, directory and title, so the next daemon restores it with the session (ADR-0025). `worker.agent` answers `{ role: 'orchestrator', schema: null, stateDir }` for a session of no dispatch titled as the orchestrator's with a state dir, and null for one without: a `?` session about no run has no tools.
- **The orchestrator's rows.** `run_status`, `agent_result` and `runner_log` read the run: the run as the tree shows it (running, paused, halted, ended, or without its runner; each held node with its reason and the questions it asked; every agent by phase with its state), one agent's result, decisions or failure, and the runner's last lines. They are a plain-data fold of the files the tree reads (`run-report.mjs`), and nothing that needs a host. `pause`, `resume` and `decide` act: `pause` writes `paused.json` as `p` does; `resume` writes `resume-request.json` as the tree's `r` does, for the runner to lift a pause and carry a held node on, or every one; `decide` writes the same request with the operator's answers, `[{ question, answer }]`, for a node held because its result needed decisions. None has a CLI fallback: an orchestrator without the tool reads the files, and the operator acts in the console.
- **The runner carries the answers.** `watchResumeRequests` reads `decisions` off the request, `control.resume` hands them to the halt, and the held node's session is continued with a prompt that names each question and its answer and says to take them as final, instead of being sent to re-read the ticket. The attached view's `r` and the console's `r` carry none and read as before. A resume request a runner is not there to take is refused by the tool, naming `r` in `crew view`, so the file never waits for a runner that may never come.
- **Acts only on the operator's word.** The `?` prompt is rendered from the table: it names the readers first, says to start with `run_status`, and says to use `pause`, `resume` and `decide` only when the operator asks, giving `decide` only the answers they gave. Claude's per-session settings allow the six by exact name, as they allow a worker's five (ADR-0027): they do to the run what the operator's own keys do, and nothing a repo server's tool could.

## Considered options

- **Carry the run in the session's title or environment.** Rejected: the title is the tree's and the daemon's to park by (ADR-0026); the environment is never kept, so a restored session would have lost its run (ADR-0025).
- **Let the orchestrator answer a held node by commenting on the ticket.** Rejected as the only way: it needs the ticket's number, which the run's files do not carry per node, and it publishes the operator's words outside the run. Kept as what a plain `resume` of a needs-decision node still assumes.
- **A scheduling tool: start a node, skip a node, change the graph.** Rejected: the orchestrator never schedules (ADR-0018); `resume` and `decide` only carry on what the script already called.
- **Lift a pause directly from the tool.** Rejected: the tree's `r` asks the runner, which journals the unpause; a file removed behind its back would leave the journal without it.

## Consequences

- A `?` session reads the run through tools before it reads files, and can pause, resume and answer a held node for the operator without leaving the conversation.
- The resume request has one more field, `decisions`, read by the runner and written only by `decide`.
- A `?` session opened before this change, restored by a later daemon, has no state dir in its record and so no tools: the operator opens a new one.
