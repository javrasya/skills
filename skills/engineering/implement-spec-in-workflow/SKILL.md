---
name: implement-spec-in-workflow
description: "Implement a whole spec as one PR, driven by a dynamic workflow of subagents instead of by you."
disable-model-invocation: true
---

A spec issue with tickets under it becomes one PR on one branch, implemented end to end by a **dynamic workflow** of subagents. The tickets are not a list of steps: they are a **task graph** with blocking relationships, so there is always a **frontier** of tickets ready to be grabbed, and the run schedules against that frontier rather than marching through phases.

Your context is the scarce resource here. The spec body, the ticket bodies, the research, the diffs and the review findings all stay inside the workflow; you hold the issue number, five interpolated values, and the summary that comes back. Read no ticket body, open no source file, and run no search — a discovery agent inside the workflow does that, and it does it better with a fresh window than you do with a full one.

`workflow.template.js`, beside this file, is the script. It carries every step; you render it and launch it.

**Requires** a harness with a workflow primitive that runs a script of `agent()` calls — Claude Code's `Workflow` tool, or an equivalent. The script is plain JavaScript against four hooks: `agent()`, `parallel()`, `phase()`, `log()`.

## Steps

1. Resolve five values. Use `gh issue view <n> --json title -q .title` and `git remote -v` only — titles and refs, never bodies.

   | value | how |
   |---|---|
   | `__SPEC__` | the spec issue number, from the arguments |
   | `__REPO__` | `owner/name` of the repo the spec belongs to |
   | `__REPO_DIR__` | absolute path of that checkout |
   | `__BASE_REF__` | the branch the PR merges into — the repo's default branch, unless the user named another. Prior work already sitting on a feature branch is **not** this value: the workflow's discovery agent finds that branch itself and starts the PR branch from it. |
   | `__NOTES_DIR__` | `~/.claude/spec-notes/<repo-name>-<spec>`, absolute — durable, outside every checkout, readable by every agent |

2. Render the script: copy `workflow.template.js` to `<notes-dir>/workflow.js` and substitute the five placeholders. Substitute, do not rewrite — the merge lane and the frontier scheduling are load-bearing.

3. Launch it against the rendered path. It runs in the background and notifies you when it returns; do not poll it, and do not do any of its work yourself while it runs.

4. Report what it returned: the PR url and state, tickets merged, tickets that failed, tickets deferred to a human and why, and the notes directory. The workflow's return value is already a summary — pass it on rather than re-deriving it from the PR.

To iterate after a failure, edit `<notes-dir>/workflow.js` and relaunch it with the harness's resume handle: the unchanged prefix of `agent()` calls returns from cache and only the edited call onward re-runs.

## What the workflow does

1. **Graph** — one agent reads the spec and every ticket and returns the task graph: blocking edges, which tickets need a human, and which branch already carries work for this spec. Blocking edges are usually **prose** in a "Blocked by" section; GitHub's sub-issue and dependency APIs are frequently empty even when the tickets exist, so the agent reads rather than queries.
2. **Explore** — parallel research agents write markdown into the notes directory, outside the repo. Every later agent gets the paths as **context pointers** instead of re-deriving the same facts.
3. **Setup** — the PR branch, cut from the branch discovery found, and a draft PR closing the spec and every automated ticket.
4. **Implement** — one agent per ticket, each in its own worktree on its own branch, all starting as early as their dependencies allow.
5. **Gate** — each ticket is reviewed **on its own branch before it merges**, against its own ticket's acceptance criteria. Review and fix then alternate until a review returns nothing blocking (minors pass), **a fresh reviewer each round**, capped at `GATE_MAX_ROUNDS`; on the cap it merges with what is unresolved and the log and summary name it, rather than stalling every ticket downstream. Set `GATE_MAX_ROUNDS = 0` to review only at the end.
6. **Merge** — a **serial merge lane**: implementers stay parallel, but exactly one merger touches the PR branch at a time. Two agents pushing one branch concurrently is the failure this design exists to prevent.
7. **Frontier** — no phase barriers. Each ticket is one memoised promise awaiting its dependencies' *merges*, so a ticket starts the instant its blockers land and the run costs the longest chain rather than the sum of the phases.
8. **Review** — one agent reviews the whole merged branch, one fixer applies every finding. The gate cannot replace this: what a per-ticket review structurally cannot see is the interaction **between** tickets — two implementations of one helper, abstractions that contradict each other, a contract one ticket relies on that another quietly changed.
9. **Finalize** — the PR goes ready for review only when every ticket landed. A human-only ticket, or a ticket that failed, holds it as a draft with a comment saying what remains.
10. **Cleanup** — the run's worktrees are removed and pruned; branches and the user's own checkout are left alone.

## The rejection ledger

The gate loop's hazard is not slow convergence, it is **ping-pong**: a fixer judges a finding wrong and leaves the code, the next reviewer raises it again, and the pair trade the same finding until the cap — every round costing two agents and changing nothing.

So rejection is a first-class outcome. The fixer returns one verdict per finding, `fixed` or `rejected` **with a specific checkable reason**, and every rejection accumulates into a ledger carried into all later rounds. A later reviewer may raise a rejected finding again only by **falsifying its stated reason** — naming which part is false and why. Absent that, the loop would never terminate on any disputed call.

The reviewer being fresh each round is what makes "clean" a verdict rather than one reviewer running out of patience.

## Reviews

Both the gate and the final pass run the in-repo [`code-review`](../code-review/SKILL.md) skill, which reviews a diff since a fixed point on two axes — **standards** (does it follow this repo's documented standards) and **spec** (does it do what the originating issue asked for) — in parallel subagents.

They differ only in what they pin: the gate pins `origin/<pr-branch>` as the fixed point and the **ticket** as the spec, so a ticket is judged against its own acceptance criteria; the final pass pins the base ref and the **spec issue**.

## Attribution

The nine-step shape — spec and tickets as a task graph, implementer subagents in their own worktrees, a merger onto the PR branch, review then ready — follows Anthropic's `implement-spec` skill. What this skill adds is the translation into one deterministic script (frontier scheduling, the serial merge lane), the per-ticket gate loop with its rejection ledger, human-gated ticket exclusion, and the discipline of keeping the orchestrator's context empty.
