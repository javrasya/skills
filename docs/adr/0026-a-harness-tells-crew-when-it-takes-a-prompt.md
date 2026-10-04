# ADR-0026: A harness tells crew when it takes a prompt

## Status

Accepted — 2026-10-03. Amends ADR-0019's readiness for pi ("ready once quiet"), kept by ADR-0022. Applies to the **crew host only**.

## Context

Every pi start in a run took three minutes and then needed the person: `crew does not recognise pi's screen after 180s`. The `?` orchestrator session, which starts the same way, took the same. pi itself was at its input prompt in under a second, idle, taking keys.

Crew had no reader for pi's ready screen (ADR-0019), so pi was ready once its terminal had been quiet for five seconds (`quietOutputMs`). A pi extension installed that day, `pi-background-tasks` 2.6.9, set its status line on a one-second timer whether or not anything changed, and pi repainted on each. The longest pi's terminal ever went quiet was under a second. The quiet rule could never fire.

Removing that extension restored the old start times, but the rule stays one extension away from breaking again: any extension with a timer and a status line does the same, and pi's own footer may one day tick.

pi says when it is ready. It wires its editor's submit handler before it emits `session_start` to its extensions (`interactive-mode.js`: `setupEditorSubmitHandler()` runs before `rebindCurrentSession()`), and it runs each extension's handlers in turn, awaiting each. A prompt typed before that sits in the editor with "Startup is still in progress"; one typed after is taken. Crew's extension already runs in every pi session crew starts (ADR-0022).

## Decision

**A harness that can tell crew it takes a prompt does so, and crew types into it once told, never once quiet. pi tells crew on `session_start`.**

- **The daemon keeps `ready` per session.** `session.ready { id }` sets it; a session's info carries it. It is false until told, false once the program ends, and false again for a revived harness until that one says so. A dialog does not unsay it: a harness past its startup stays past it while it asks.
- **crew's pi extension relays `session_start`** as `session.ready`, in order with its `ui_prompt_start` and `ui_prompt_end` relays (ADR-0022). Each relay awaits its own request, so a daemon gone or refusing is pi's to report as an extension error, and the relays after it go on.
- **The screen table says who tells.** `screens.mjs` gives pi `tells: true`. A harness with a ready reader is read off its screen; one that tells is ready once told; one with neither is ready once quiet, as before. The first two are held steady for `settleMs` (one second) before anything is typed: a startup dialog may follow a harness's ready by a moment, as pi-mcp-adapter's MCP approval follows `session_start`, and ADR-0022's `waiting` check runs first on every look.
- **A pi that never says so** is `never said it was ready` at `readyMs`, and, for a worker, needs the person as an unrecognised screen, as before; `session.ready` sent by hand (or the person entering and the extension loading late) lets it go on.

## Considered options

- **Read pi's input box off its screen**, as Claude's is read: two rules with a blank row between, above pi's footer. Rejected: the box is drawn before pi takes a prompt (its editor accepts keys during startup but does not submit them), so the screen cannot tell a pi that is ready from one still starting. The event can.
- **Raise or drop the quiet rule for pi.** Rejected: a terminal that redraws every second is never quiet, at any threshold, and a shorter one would type into a pi still loading its extensions.
- **Patch the extension** to set its status only when it changes. Done upstream or not, it fixes one extension; the next timer breaks the rule again.

## Consequences

- A pi worker gets its prompt about a second after `session_start`, whatever its terminal draws. Before, with a quiet terminal, five seconds; with a ticking one, never.
- `tell(op, said)` in `hooks/tell.mjs` takes the request it makes. It no longer swallows a failed request: crew's Claude hook reports one on stderr and still exits 0; crew's pi extension lets pi report it.
- The fake harness, as pi, emits `session_start` once its input is drawn; `CREW_FAKE_MUTE=1` keeps it from saying so, and `CREW_FAKE_TICK=1` keeps its terminal redrawing, so the contract suite can start a pi that never goes quiet.
- Claude is unchanged: its hooks fire nothing at its input prompt, and its screen reader (ADR-0019) still tells its readiness and its startup dialogs.
- Found while checking idle beside this: a worker waiting on a background shell wrote nothing to its transcript, so it looked idle and was nudged, where one waiting on a background subagent did not (its subagent's transcript counts as the session's). A session's size now counts its background processes' output files too: Claude's `<tmp>/claude-<uid>/<slug>/<id>/tasks/*.output` (`CLAUDE_CODE_TMPDIR`, else `/tmp`), as Claude names them when a Bash call runs in the background, and pi-background-tasks' `<worktree>/.pi/tasks/<id>-<pid>/*.output`. A process that writes nothing for the grace still reads as idle: crew sees output, not processes.
