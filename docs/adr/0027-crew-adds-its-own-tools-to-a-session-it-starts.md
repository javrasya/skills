# ADR-0027: Crew adds its own tools to a session it starts

## Status

Accepted — 2026-10-04. Amends ADR-0019's "Sessions are native", as ADR-0022 did before it. Applies to the **crew host only**: the Orca host and the Workflow runner keep the CLI. Issue #171; the tool table landed with #172, the tools themselves follow in its later tickets.

## Context

An agent finishes by running a command. A worker writes its payload and runs `node ".../submit.mjs" … --from <worker_handle> --dispatch-capability <capability> --task-id <task_id> --dispatch-id <dispatch_id>`, copying four IDs out of its session host's preamble into the placeholders. A doctor reports with `orchestration send --type handoff|escalation …` and `worker_done`, with the same IDs. An agent that copies one ID wrong, loses the preamble to a resend or a resume, or forgets the command after a long turn fails its dispatch for nothing it did wrong. The words it reads about finishing were written by hand in two places, `workerPrompt` and `doctorPrompt`, and the nudges and continuations repeat them in their own words.

Crew starts every session of a crew run, and knows which dispatch it runs: the daemon sets `CREW_SESSION`, and a dispatch's id is its session's (ADR-0022's relays already use it). An agent of crew needs no IDs to say who it is.

## Decision

**Crew adds its tools to a session it starts, as ADR-0022 added its hooks, and nothing else. One table names those tools, and the prompts are rendered from it.**

- **One tool table** (`src/tools.mjs`) names `submit`, `status`, `needs_you`, `handoff` and `give_up`. Each row says who uses it (worker, doctor), what it does in two sentences, and its CLI fallback: the line an agent runs while its session has no such tool, as every agent does today. The worker prompt's finishing section and the doctor prompt's mail instructions take their command lines from the rows, so a tool and the prompt that names it cannot drift apart. `status` has no fallback: Run mail has no status type, and a handoff is a doctor's note, so a session without the tool sends none.
- **The tools are crew's, added and nothing else.** pi gets them from crew's extension (`-e`), Claude from crew's MCP config on its launch line, beside the operator's own servers, settings and flags, which stay untouched. That is the whole of what crew adds beyond ADR-0022's hooks: no setting of the operator's is changed, no dialog of theirs answered.
- **The agent side becomes a tool; the daemon-to-runner side stays the Run mailbox.** A tool call is keyed by the session it comes from, so the agent copies no IDs. What it does in the daemon is what the CLI does: the same dispatch settles, the same `worker_done`, `handoff` or `escalation` lands in the run's mailbox, and the runner reads it as it does now, through `worker.show` and `mail.check`. The runner, the journal's fold of a doctor's mail (`mailAction`, `foldMail`), a resume's reading of the mailbox and the Orca host all stay one protocol. Moving the runner's side to something new would fork it by host, for no gain to the agent.
- **Crew allows its own tools.** In the per-session Claude settings it already passes (`--settings`, ADR-0022), crew adds `permissions.allow` entries for its tools and only its tools. They are crew's own tools over a local socket to crew's own daemon, acting on the session's own dispatch, as the CLI the agent could already run does. Asking the person first is no security decision of theirs; ADR-0019's dialogs still are, and crew still answers none of them.

## Numbering

Two ADRs carry 0026: `0026-a-harness-tells-crew-when-it-takes-a-prompt.md` and `0026-the-orchestrator-sessions-a-person-opens-are-rows-of-the-run-tree.md`, written the same day on parallel branches. Both are cited as ADR-0026 elsewhere, so neither is renumbered: a reference to ADR-0026 names its subject alongside. This one takes 0027, the next free number, and the next ADR checks for a collision before it lands.

## Considered options

- **Keep the CLI only, and render its words from one place.** Rejected as the end state: the IDs an agent copies are the failure, and one source of words does not remove them. Kept as the fallback, and as the Orca host's only path.
- **Make the runner read tool calls instead of the mailbox.** Rejected: the mailbox is the protocol the runner, the journal and both hosts share, and a tool changes only how an agent enters it.
- **Let the person approve crew's tools on first use.** Rejected: nothing about them is the operator's to weigh, and a worker that waits on an approval nobody is there for fails as a dialog would.
- **`--strict-mcp-config`, so crew's server is the only one.** Rejected: it drops the operator's servers, and the session would not be theirs.

## Consequences

- An agent of a crew run finishes by calling a tool, and its prompt still names the CLI line, rendered from the same row, for a session without it.
- A new tool, or a changed fallback, is one row of the table; the prompts follow it.
- The nudges, continuations and the doctor's `REPORT` still say "the submit command from your instructions" in their own words; moving them onto the table is later work.
