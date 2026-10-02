# ADR-0024: A done agent's harness is parked, and resumed when entered

## Status

Accepted — 2026-10-02. Amends what CONTEXT.md says of a session host, that it "keeps sessions alive", for a done agent's session. Applies to the **crew host only**. The Orca host and the Workflow runner are unchanged. Issue #161.

## Context

A crew session outlives its agent's work. Once an agent reports `worker_done`, its harness (`claude`, `pi`) sits idle at its prompt in the daemon's pty until the run is reclaimed, which may be days. A spec of many tickets leaves one idle harness per done agent, each a process and its memory, kept for a person who may never look.

The harness already keeps its session on disk, and crew already knows how to carry one on: the runner continues a session with `claude --resume <id>`, or pi's `--session-id <id>` (ADR-0013), and every worker's session id is the runner's own (`--session-id` on its launch line).

## Decision

**The daemon parks a done agent's session after it has been quiet for `parkAfterMs`: it ends the harness and keeps the session. Entering a parked session starts the harness again on its resume line, in the same session.**

- **Only a done agent is parked.** A session is parked when all of these hold: its dispatch is settled by a `worker_done` that succeeded, it waits on nobody (ADR-0022), nobody has it entered, its pty has been quiet for `parkAfterMs`, and its launch line names a session to resume. A failed or cancelled dispatch is never parked, so a person looking at why it failed still finds it as it was.
- **Parking keeps the session.** Its id, its record and its last screen stay. Its info says `parked`. To the runner it is an exited session of a settled dispatch, which it no longer watches.
- **Entering revives it.** `session.enter` on a parked session first spawns the harness's resume line in the same session id, cwd and env. That line is the session's own launch line with Claude's `--session-id` turned into `--resume`; pi's line is unchanged. The new process keeps `CREW_SESSION`, so the hooks still reach the same session. The person is then attached as usual. `crew view` and `crew console` both enter this way.
- **The tree shows it, as a tag, not a state.** A parked agent's row keeps `✓ done` and gains a grey `⏾ parked`, and its pane says `parked: Enter resumes it`. Parked describes the harness's process, not the agent's progress, so it is not counted as a state and a phase of done agents still folds. The tree learns it from `terminalsParked`, crew's own host method; Orca never parks, so its runs never show the tag.
- **Anything sent to it revives it first, then waits.** The daemon refuses a raw `session.write` to a parked session, since text typed into a harness still starting would be lost. The crew host, through which every prompt, nudge, follow-up and key the runner sends goes, answers that refusal by reviving the session in place (`session.revive`, same id, resume line), waiting for its harness to be ready (`ready()`: its input prompt steady, no dialog up) and only then typing. A session woken this way is not parked again until that write lands, or 5 minutes go by, whatever `parkAfterMs` says. (Amended 2026-10-02: a write was refused outright, so a runner's leftover follow-up to a parked chain agent was lost.)
- **The person can park at once.** Ctrl+P in the run tree offers Park Selected (only on a done agent) and Park All Done; the daemon's `session.park` parks a done agent's session whatever its quiet, and refuses any other, naming why.
- **`parkAfterMs` is 15 minutes**, set in crew's config, and `0` turns parking off. It must stay longer than the runner's `followUpMs` (10 minutes): right after a chain agent's `worker_done`, the runner may type a leftover follow-up into its session and wait that long for it (`leftoverCheck`). The daemon reads the setting when it starts.
- **Idle is judged from the pty's quiet**, not from the transcript (ADR-0017's preferred source). The daemon has no transcript reader, and a done agent's turn has ended by definition. All parking needs to know is that nothing has been drawn for a long while.

## Considered options

- **Close the session when the agent is done.** Rejected: the person loses the agent's screen in the run view, and a session that is closed cannot be entered again.
- **Revive inside the daemon on any write.** Rejected: the daemon cannot tell when a harness is ready for text; the crew host can (`ready()`), so it revives and waits before typing. The runner's own continuation (`workerContinue`) already starts a fresh session for that case, and it treats a parked session as an exited one.
- **Park in the runner, not the daemon.** Rejected: the runner exits when its run ends, while done agents are kept for days after. The daemon is the one process that outlives them all and sees every enter.
