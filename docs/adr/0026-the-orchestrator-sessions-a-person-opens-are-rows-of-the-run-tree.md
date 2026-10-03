# ADR-0026: The orchestrator sessions a person opens with `?` are rows of the run tree, and are kept

## Status

Accepted — 2026-10-03. Amends ADR-0018, under which a `?` session is closed by whoever opened it as they go, and ADR-0024 and ADR-0025, whose parking and restoring applied to a done agent's session only. Applies to the **crew host only**: `?` is the run console's. Issue #168.

## Context

`?` in the run console starts an orchestrator session for a conversation with the operator about one run (ADR-0018). It was closed the moment the back key left it, was never a row of the tree, and its Run was dropped from the daemon's book at the next restart. Once left it was gone: nothing on the screen named it, nothing could enter it again, and a daemon restart forgot it. The conversation was the operator's, and crew threw it away.

An agent's session is kept because two things record it: the run's journal, written by the runner, names it, and the daemon's book keeps its command and directory so the next daemon restores it (ADR-0025). A `?` session had neither: the runner never knows of it, and the book kept only sessions of a dispatch.

The headless questions crew asks the orchestrator itself, halt triage and the validation draft (ADR-0019), run in no session and are not this: they are crew's, not the person's.

## Decision

**A `?` session is recorded in the run's state dir by the console that opens it, listed by the run tree under an Orchestrator phase drawn first, kept when left, and parked and restored by the daemon as a done agent's session is.**

- **The record is the console's, in the state dir.** `orchestrator.jsonl` beside the journal: `starting` as a `?` begins, `started` with its session id once the harness has its prompt, `failed` with why when the start fails, `closed` once the operator closes it. The runner never writes it: its journal is rewritten by every resume, and a `?` session is no call of the script. Numbered from 1 in the order opened, never as an agent of the run. A `starting` with nothing after it, past fifteen minutes, is read as failed: its console died mid-start, and nothing else records that.
- **The tree lists them as rows of one phase, Orchestrator, before the run's phases**, each shaped like an agent's row so it is drawn, selected and entered as one: `console 1`, its state, context and tokens from its transcript, its age. Its state is crew's session's, read through the crew host's `terminalsInfo`: `starting` and `failed` as the record says; `running`; `needs you` with what its harness waits on the person for (ADR-0022); `done`, with the `⏾ parked` tag, once parked; `failed` with why when its session is gone from crew or its harness ended unparked. The header's counts, a pause's "agents finishing" and the run's alert line count the run's agents only; the phase folds by itself once every session in it is parked, as a phase of done agents folds.
- **Leaving keeps it.** The back key returns to the tree with the session running on; Enter on its row enters it again.
- **The daemon treats it as a done agent's session.** It is parked once quiet past `parkAfterMs`, waiting on nobody, with nobody in it (ADR-0024), by Ctrl+P at once, and as soon as its harness ends on its own (the person's `/exit`, a crash), so entering it always resumes the conversation rather than finding a dead pty. The daemon's book keeps its command, directory and title, so the next daemon restores it parked under its old id (ADR-0025). The daemon knows it by its title, `orchestrator/console`, and by its having no dispatch.
- **Closing is the operator's.** Ctrl+R's Reclaim Selected on its row closes its session and records `closed`, so the tree drops it; on the Orchestrator row, every one. Reclaim All closes every one left, and removing the run closes them with it. A `?` session has no worktree: its reclaim is its session's close, and nothing else.

## Considered options

- **Journal it, as the runner journals an agent.** Rejected: the console cannot write the runner's journal (a resume rewrites it from empty, and two writers would race), and the runner does not know a `?` session exists.
- **Derive the rows from the daemon alone, by title.** Rejected: a title cannot tell one run's `?` sessions from another's in the same project without encoding the run in it, the daemon keeps no start time, and a start that failed, or a console that died mid-start, would leave no trace for the tree to explain.
- **Keep closing it on leaving, and offer a new one each time.** Rejected: the conversation is the point. Its context is what the operator built up, and the harness keeps it on disk whatever crew does with the pty.
- **Leave an ended harness unparked, as an agent's is.** Rejected for a `?` session: an agent's exit is its runner's to continue, but nobody continues a conversation except the person, and a parked session is the one Enter can resume.
