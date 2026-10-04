# ADR-0022: A harness tells crew when it waits on the person

## Status

Accepted — 2026-10-02. Amends ADR-0019's "Sessions are native" and its readiness for pi. Applies to the **crew host only**. The Orca host and the Workflow runner are unchanged.

## Context

A pi run's graph agent never got its prompt. pi-mcp-adapter opened "Allow project MCP server "slint"?" as pi started. Crew read pi as ready once it went quiet, and a dialog that waits is quiet. The prompt was typed into the dialog. Its Enter answered the dialog "Yes", so crew approved an MCP server on the operator's behalf, and the prompt was lost. The worker then idled until its nudges, which told it to finish a task it had never been given.

Reading pi's screen for that dialog would have caught this one. But any extension can open a dialog, and each would need its own screen entry.

Mid-turn, crew could not see a worker waiting on the person at all. The crew host answered `waiting: null` for every worker. A Claude worker stopped at a permission prompt looked idle and was nudged. The Orca host reports `waiting`, and the runner already shows a worker that waits as **blocked**.

Both harnesses report these moments themselves, as tested on 2026-10-01:

- **pi** wraps every extension dialog (`select`, `confirm`, `input`, `editor`, `custom`) in `ui_prompt_start` and `ui_prompt_end` events, title included. An extension loaded with `pi -e <path>` receives them, startup dialogs included: pi-mcp-adapter's MCP approval was heard 0.3 s after `session_start`.
- **Claude** runs hooks passed with `claude --settings <json>`. A permission prompt fires `PermissionRequest` and then a `Notification` with `permission_prompt`. When the tool runs, `PostToolUse` fires. No hook fires for the workspace-trust or `.mcp.json` dialogs, which come before `SessionStart`. No hook says that a dialog has closed.

Both flags apply to that one session only. A `pi` or `claude` the operator starts outside crew is untouched.

## Decision

**Crew adds one thing to a session it starts: a way for the harness to tell the daemon, from its own events, when it waits on the person. The daemon keeps what the session waits on, and both the readiness check and `worker.show` read it.**

- **The daemon keeps `waiting` per session.** `session.waiting { id, waiting, keep }` sets it to the text of what the session waits on, or to null. With `keep`, it sets the text only while the session waits on nothing, so a vaguer event does not overwrite a precise one. A session's info, and its worker's `worker.show`, carry it. An ended session waits on nothing.
- **pi loads crew's extension** (`src/hooks/crew-pi.mjs`, `-e`). It relays `ui_prompt_start` as `pi asks: <title>`, and `ui_prompt_end` as null, in order.
- **Claude takes crew's hooks** (`src/hooks/claude-hook.mjs`, `--settings`), beside the operator's own:
  - **Set waiting:** `PermissionRequest` (`Claude asks permission to use <tool>: <command>`), `Elicitation`, `PreToolUse` of `AskUserQuestion`, and a `Notification` of `permission_prompt` or `elicitation_dialog` (with `keep`).
  - **Clear it:** the next `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `ElicitationResult`, `UserPromptSubmit` or `Stop`. Claude has no event for a dialog closing, so whatever comes next clears it.
  - The hook prints nothing and always exits 0.
- **Before the first prompt, a session that waits is at a dialog.** `ready()` treats it as one: nothing is typed, `asking` hears of it, and the row **needs you**, whatever the screen shows. For pi, these events are the only dialog check. It is ready once it is quiet and waits on nothing (amended by ADR-0026: once it has said so, and waits on nothing). Claude's startup dialogs fire no hook, so its screen reader (ADR-0019) still guards them.
- **Mid-turn, a worker that waits is blocked on a human.** `worker.show` reports `waiting`, and the runner's existing handling applies, as for Orca: the agent is not nudged, its row shows **blocked** with the question, and the blocked limit counts.
- **Outside a crew session it does nothing.** The relays send only when `CREW_SESSION` is set, and they swallow every error. A daemon that is gone never fails the harness. (Amended by ADR-0026: a failed request is reported, by the hook on stderr or by pi as an extension error, and still never fails the harness.)

## Considered options

- **A screen entry per dialog.** This was the first fix: it matched pi-mcp-adapter's "Allow project MCP server", plus pi's generic select footer. It was rejected for pi: every extension's dialog would need an entry, and nothing on the screen says when a dialog ends mid-turn. Claude keeps its screen reader for startup, because no event exists there.
- **Install the extension and hooks in the operator's own pi and Claude settings.** Rejected: they would run in every session the operator starts, crew or not, which ADR-0019's native sessions forbid.
- **Pre-answer the dialogs.** Still rejected, as in ADR-0019: approving an MCP server or trusting a folder is the operator's security decision. This ADR exists because crew made that decision by accident.

## Consequences

- A worker's harness line is no longer word for word the runner's. Crew appends `-e <crew-pi.mjs>` for pi, or `--settings <hooks JSON>` for Claude. The session is otherwise the operator's own: same settings, MCP servers, login and flags. ADR-0019's "Crew adds no flag, setting or MCP config" now has this one exception, which observes and changes nothing.
- Every Claude tool call runs crew's hook twice, once before and once after. Each run is a short node process that makes one local socket request.
- Two dialogs at once (parallel tool calls) share one `waiting`. The first event that clears it clears both.
- When the person denies a Claude permission prompt (Esc or "No"), Claude ends its turn and asks what to do instead. No hook fires, so the worker stays blocked, still showing the permission question, until the person types their answer (`UserPromptSubmit`). That is still a wait on the person, so the runner does not nudge it. Tested 2026-10-02.
