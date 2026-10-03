# ADR-0019: A harness dialog is the person's, and orchestrator questions run headless

## Status

Accepted — 2026-09-30. Amends ADR-0018's orchestrator and ADR-0017's readiness. Amended 2026-10-02 by ADR-0022: crew adds one thing to a worker's launch, a pi extension or Claude hooks that tell the daemon when the harness waits on the person; pi's dialogs are known from those events, not its screen.

## Context

The crew host typed a worker's prompt once its terminal had been quiet for five seconds. Claude Code no longer goes quiet: its TUI redraws every 100–200 ms at its input prompt. So every start waited out its 180 s and failed. `crew start` could not draft a validation list: `claude … never went quiet within 180s`.

Claude also shows dialogs before its first prompt, and they go quiet. The two met on real runs:

- **Workspace trust**, in any folder not yet trusted. Every crew worktree is one: `<repo>.crew/<runId>-<n>` sits beside the repo, not inside it.
- **Project MCP servers**, for a `.mcp.json` server not yet approved. The repo's approvals may live in its git-ignored `.claude/settings.local.json`, which a new worktree does not have.

Typed into either, the prompt's Enter picks the default answer: "No, exit" for trust, and "Continue without using this MCP server" for MCP.

No flag turns these dialogs off in an interactive session. The operator wants each session to be exactly the harness session they would start themselves, with the same settings, MCP servers and flags.

## Decision

**Crew reads the screen before a worker's first prompt, and never types into a dialog. A dialog is the person's to answer, and the agent needs them until they do. Questions nobody answers live run headless.**

- **Ready is read off the screen.** Each harness has a screen reader (`screens.mjs`): what its ready screen looks like, and the dialogs it may show. Claude's ready screen is its input box, a `❯` row between two rules. The reader names Claude's trust, MCP, external-import, bypass-permissions, settings-error, login and first-run dialogs, and treats any other `Enter to confirm` screen as a dialog. A harness whose ready screen crew cannot read, pi for now, is still ready once quiet. (Amended by ADR-0026: pi tells crew itself when it takes a prompt, and is ready once told; the quiet rule is for a harness that neither shows nor tells.) A new CLI, or a changed screen, is a new table entry.
- **A dialog needs you.** The runner journals `dialog` and the agent's row shows `needs you`, with what to do, in the session showing the dialog. The person enters it from `crew view` and answers. When the dialog goes (`dialogClosed`), the row goes back to what it was, and the prompt goes in once the input box shows. A screen still unrecognised after 180 s needs the person the same way. None of this has a deadline, as a halt has none. An answer that ends the harness ("No, exit") fails that start attempt as any start failure does.
- **Sessions are native.** Crew adds no flag, setting or MCP config to a worker's launch. It does drop the variables a Claude Code session marks its children with (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`…). A Claude started under those marks saves no transcript, so it would not be the session a person starts. Every session starts in the directory crew names: the project, or a worktree of it. The daemon refuses a spawn that names none, rather than use its own directory.
- **Orchestrator questions run headless.** The validation-list draft and halt triage are one `claude -p --output-format json --json-schema …` run each (`pi -p` for pi), in the project, with the user's own settings and login. The answer is the run's structured output, checked against the question's schema. There is no session, readiness, submit command or nudge, and print mode shows no trust dialog. Quitting the asker kills the run. The console's `?` stays a session, since a person talks to it.
- **`crew start` checks the harness first.** Before it drafts or arms anything, one short headless turn on the answered harness and model proves the login and the model. When it fails, `crew start` says so in the harness's own words and arms nothing.

## Considered options

- **Pre-answer the dialogs**: `--settings` with `enabledMcpjsonServers`, `--strict-mcp-config`, or writing trust into `~/.claude.json`. Rejected: the session would differ from the operator's own. Trust has no setting, and `~/.claude.json` is Claude's internal file.
- **Accept the dialogs for the operator.** Rejected: trusting a folder or enabling an MCP server is a security decision.
- **Keep the orchestrator a session, with the new readiness.** Rejected: nobody is there to answer a dialog, and a question with a schema needs no TUI.
- **`--ax-screen-reader`, for a flat screen without redraws.** Rejected: it changes how the session looks.
