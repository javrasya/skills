# ADR-0032: A settled node is reopened by one appended journal line, and resume starts a gone runner again

## Status

Accepted — 2026-10-05. Amends ADR-0016 (what a resume replays) and ADR-0028 (the orchestrator's tools, and its `resume` that refused a run with no runner). Applies to the **crew host's `?` sessions**; the runner's side applies to every host.

## Context

In the spec #1232 run, `impl:#1237` came back with an unmet remainder six rounds in a row: each round was asked to see CodeBuild green on a PR that only the later publish step opens. At the sixth, the template's own halt ended the script (`halted: true` in its result), so the runner wrote `summary.json` and exited. Nothing the operator could do got the run out of it:

- **`--resume` replayed the same ending.** Every `agent()` call had a result, so by ADR-0016 each node replayed from the journal, all twelve of #1237's rounds included, and the script reached the same verdict in the same second.
- **The orchestrator's `resume` refused it.** It carries a held node on through the runner (ADR-0028), and there was no runner, and no held node: a script-level halt holds none.

The operator and the orchestrator could agree on the fix (what the ticket's remainder should have been), but had no way to make the run act on it. Editing a journal line was ruled out: the journal is the record of what happened, and a resume rewrites it from empty anyway.

## Decision

**The orchestrator's `reopen` appends one `reopen` line, `{ node, note }`, to the journal of a run whose runner has ended, and the next resume carries that node on as it carries a held node on, in its own session, told the note, instead of replaying its result.** Every other node replays as before.

- **What can be reopened.** A node whose latest call settled with a result. A failed or needs-decision node is refused: a resume already carries it on. So is a node whose worker is still out (a resume takes it up), one not in the journal, and an empty note. Nothing is reopened while the run's runner is alive, or while that cannot be told: a live runner owns the journal.
- **The fold reads it.** A `reopen` line after a node's result marks that node `reopened`, `{ note, at }`, and names the worker its agent last ran, even when the result was a replay (from the agent's `earlier` line). A later result settles it. A node reopened twice takes the later note. The fold's `reopened` lists every such node, and `run_status` shows it.
- **The resume carries it on.** On the node's call the runner takes the reopened node as it takes a failed one (`carried`): the result it was reopened from is set aside as `result.reopened.json`, so the watch does not take it for a new one, and its session is continued in its own worktree (the chain worktree, for a chained node) with a prompt that names the note and says to take it as final. A node whose session is not known starts fresh. Until its call is made, the resume carries the node forward as its result line followed by its reopen line, so a resume that stops before reaching it leaves it to the next.
- **`resume` starts a gone runner again.** On a run whose runner is not running, `resume` does what the tree's `r` does: lifts a pause if there is one, and otherwise starts the runner again with `--resume`, from the run's registry record, in a crew session in its project. It does so only when there is something to carry on: a held node, a reopened node, or a runner that died without writing `summary.json`. A run that ended with nothing reopened is told so. `decide` still refuses with no runner: its answers need a held node, which only a runner holds.
- **Acts on the operator's word.** `reopen` is an act. The `?` prompt says to reopen a node only once the operator has agreed with the orchestrator what was wrong and that it is fixed, the note in their words.

## Considered options

- **Re-run the node from scratch (a `redo` line).** Rejected: a fresh worker throws away the session that knows what the node already did, which ADR-0016 already rejected for failed nodes.
- **Override the node's result (an `override` line with a value).** Rejected: the orchestrator would be writing a worker's result, which skips the schema's checks and the gate, and makes the journal say an agent submitted what none did.
- **Edit or delete the journal line.** Rejected: the journal is the record of the run, and an edit leaves no trace of who changed what.
- **Let `resume` relaunch any ended run.** Rejected: an ended run with nothing reopened replays to the same ending, as #1232's did.

## Consequences

- An ended run whose ending rested on one node's result can be carried on from that node, with every other node's work kept and no PR published twice.
- The journal gains one entry type, `reopen`, written only by the tool and by a resume carrying it forward.
- The fix that made a node's result wrong is still the operator's: a reopened node whose agent hits the same wall (a ticket asking for what it cannot do) comes back the same way. The note has to say how the agent finishes.
- A runner that dies while a reopened node's continued session is at work leaves that node unsettled with no worker named, as a carried failed node is today, so the next resume starts it fresh.
