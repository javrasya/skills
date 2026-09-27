# ADR-0016: A failed ticket halts the run, and a resume carries each failed node on

## Status

Accepted — 2026-09-27. Amends ADR-0013 (Resume run) and ADR-0014 (what follows a patient's final null). Applies to the shared workflow script and to the **Orca runner**; the Workflow runner keeps its own resume.

## Context

In the spec #1186 run, `impl:#1187` returned null. #1188 to #1190 wait on it in a chain, so all four failed, and the script went on to the whole-stack review anyway: its early stop fired only when nothing was published **and** there was no layer 0, and this run had a layer 0 (the pre-existing PR #1185). A review of a stack holding only pre-existing work, and a finalize that would have commented and readied PRs, came out of one failed ticket.

The resume that followed ran `impl:#1187` again from scratch, though its worker had submitted a valid `result.json` at 18:15:37, after the runner gave up on it. A resume replays the unbroken prefix of `agent()` calls by call order: the first failed call, and every call after it, runs live, because a call is known to the runner only by the hash of its prompt, and a prompt names branches (`ticket/<n>`, the tip), not commits. So a finished independent ticket whose calls came after the failure is thrown away too.

Engines that offer Airflow's "clear a node and continue downstream" were looked at again (Airflow, Dagster, Windmill, Conductor, Temporal: all servers; LangGraph.js and Mastra: in-process, but neither clears one node, and neither knows Orca's workers). ADR-0013's reasons for no engine still hold.

## Decision

**The whole-stack review and finalize are reached only when every automated ticket is implemented, gated and published.** A ticket deferred to a human at graph time is outside the run and never holds it up. A ticket that fails, or is left with an unmet remainder, **halts** the run.

- **Halting starts nothing new.** Once a ticket fails, no ticket starts. A ticket already dispatched as exactly one slice finishes that slice, its gate and its publish; every other ticket makes no new `agent()` call. Once the agents in flight settle, the run is halted: no review, no finalize, nothing more on GitHub than the PRs already published. A halted run is never a finished run with gaps.
- **The run is a graph of named nodes.** Every `agent()` call names its **node** — what it is, not when it ran (`graph`, `explore/<topic>`, `ticket/<n>/dispatch`, `ticket/<n>/impl/r<k>/s<i>`, `ticket/<n>/gate/…`, `ticket/<n>/publish`, `review`, `finalize`) — and the journal records each result under its node. **Containers** (a ticket's implement rounds and slices, its gate's fixes) have children known only at runtime, and succeed only when their last child does. The script's own structure stays the source of dependency; the node names are what the runner needs to keep a finished node's result.
- **A resume keeps every node that succeeded and carries each failed node on.** A failed node, in order: takes the `result.json` its worker submitted after the run gave up on it, if there is one (`submit` writes it only once valid); otherwise continues its session in its own worktree and tab (`claude --resume`, as session continuation already does); and only if it never started, starts fresh. Once it succeeds, every node waiting on it goes on. A node that succeeded is never run again: rerunning one would publish its ticket a second time, which publish-once (ADR-0005) forbids.
- **A halted runner stays in its tab.** In the attached run view, `R` on a failed node resumes that node, and `R` on the run resumes every failed node, in the same process. When the runner process is gone, the standalone view's Resume run starts a new runner, which rebuilds the graph from the journal by node name.

## Considered options

- **Keep the partial run** (review and finalize what was published, comment on what remains). Rejected: a later resume would have to undo a finalize, and a review of a half-built stack is wasted.
- **Airflow's "clear"** (restart the node from scratch). Rejected: a failed agent usually holds a worktree, commits and a session worth carrying on; restarting throws them away.
- **Replay any call whose prompt matches exactly.** Rejected: prompts name branches, so an identical prompt can mean different commits.
- **An engine** (LangGraph.js, Mastra, or a server). Rejected for ADR-0013's reasons; none clears or resumes one node inside a failed graph.
