---
name: implement-spec-in-workflow
description: "Implement a whole spec as a stack of PRs — one per ticket, registered as a native GitHub stack — driven by a dynamic workflow of subagents instead of by you."
disable-model-invocation: true
---

A spec issue with tickets under it becomes a **stack of PRs — one PR per ticket** — implemented end to end by a **dynamic workflow** of subagents. The tickets are not a list of steps: they are a **task graph** with blocking relationships, so there is always a **frontier** of tickets ready to be grabbed, and the run schedules against that frontier rather than marching through phases. The stack exists so the operator reviews one small ticket-sized diff at a time, then merges the whole stack in one operation.

Your context is the scarce resource here. The spec body, the ticket bodies, the research, the diffs and the review findings all stay inside the workflow; you hold the issue number, six interpolated values, and the summary that comes back. Read no ticket body, open no source file, and run no search — a discovery agent inside the workflow does that, and it does it better with a fresh window than you do with a full one.

`workflow.template.js`, beside this file, is the script. It carries every step; you render it and launch it.

**Requires** a harness with a workflow primitive that runs a script of `agent()` calls — Claude Code's `Workflow` tool, or an equivalent. The script is plain JavaScript against four hooks: `agent()`, `parallel()`, `phase()`, `log()`. Native stack registration additionally requires the `gh-stack` extension — gated below, never auto-installed.

## Steps

1. **The stack gate.** Two probes, two different outcomes — run them before touching anything else:

   - `gh extension list | grep -q gh-stack` — **missing → stop.** Tell the user to run `gh extension install github/gh-stack` and wait. Install it yourself only if the user explicitly says to.
   - `gh api "repos/<owner>/<repo>/stacks" --silent` — **404 → stacks are not enabled for this repo** (org rollout policy, or a host without the preview; installing nothing fixes it). Put it to the user: GitHub's native stacked PRs give a stack map on every PR and a one-click atomic whole-stack merge — enabling is described at <https://docs.github.com/en/pull-requests/tutorials/roll-out-stacked-prs> — or the run can degrade to a plain `--base` chain merged bottom-up by hand. Their call, never a silent fallback. HTTP 200 (even with `[]`) → native mode.

2. Resolve six values. Use `gh issue view <n> --json title -q .title` and `git remote -v` only — titles and refs, never bodies.

   | value | how |
   |---|---|
   | `__SPEC__` | the spec issue number, from the arguments |
   | `__REPO__` | `owner/name` of the repo the spec belongs to |
   | `__REPO_DIR__` | absolute path of that checkout |
   | `__BASE_REF__` | the branch the stack merges into — the repo's default branch, unless the user named another. Prior work already sitting on a feature branch is **not** this value: the workflow's discovery agent finds that branch itself and it becomes the stack's bottom layer. |
   | `__STACK_MODE__` | `native` when both probes in step 1 passed; `chain` when the user chose the fallback |
   | `__NOTES_DIR__` | `~/.claude/spec-notes/<repo-name>-<spec>`, absolute — durable, outside every checkout, readable by every agent |

3. Render the script: copy `workflow.template.js` to `<notes-dir>/workflow.js` and substitute the six placeholders. Substitute, do not rewrite — the publish lane and the frontier scheduling are load-bearing.

4. Launch it against the rendered path. It runs in the background and notifies you when it returns; do not poll it, and do not do any of its work yourself while it runs.

5. Report what it returned: the stack bottom-to-top with each PR's url and state, the merge instructions for the mode the run ended in, tickets that failed, tickets deferred to a human and why, and the notes directory. The workflow's return value is already a summary — pass it on rather than re-deriving it from the PRs.

To iterate after a failure, edit `<notes-dir>/workflow.js` and relaunch it with the harness's resume handle: the unchanged prefix of `agent()` calls returns from cache and only the edited call onward re-runs.

## What the workflow does

1. **Graph** — one agent reads the spec and every ticket and returns the task graph: blocking edges, which tickets need a human, and which branch already carries work for this spec. Blocking edges are usually **prose** in a "Blocked by" section; GitHub's sub-issue and dependency APIs are frequently empty even when the tickets exist, so the agent reads rather than queries.
2. **Explore** — parallel research agents write markdown into the notes directory, outside the repo. Every later agent gets the paths as **context pointers** instead of re-deriving the same facts.
3. **Setup** — only when prior work already sits on a branch: that branch becomes **layer 0**, the bottom of the stack, with its own draft PR whose body says plainly that it carries pre-existing work this run never gated.
4. **Implement** — one agent per ticket, each in its own worktree on its own branch, cut from the stack tip as it stood, all starting as early as their dependencies allow.
5. **Gate** — each ticket is reviewed **on its own still-unpublished branch**, against the base it was cut from, before it becomes a PR. Review and fix then alternate until a review returns nothing blocking (minors pass), **a fresh reviewer each round**, capped at `GATE_MAX_ROUNDS`; on the cap it publishes with what is unresolved and the log and summary name it, rather than stalling every ticket downstream. Set `GATE_MAX_ROUNDS = 0` to review only at the end.
6. **Publish lane** — a **serial lane** turns the graph into a chain: exactly one agent at a time rebases its ticket branch onto the current stack tip, pushes, and opens a draft PR based on the tip, `Closes #<ticket>` in the body. The rebase is legal because the branch has no PR yet — **publish-once**: all history rewriting happens before a branch becomes a PR, and nothing ever pushes to a published one. Two agents publishing concurrently would base on the same tip, which is the failure the lane exists to prevent.
7. **Frontier** — no phase barriers. Each ticket is one memoised promise awaiting its dependencies' *publishes*, so a ticket starts the instant its blockers' PRs exist and the run costs the longest chain rather than the sum of the phases.
8. **Review** — one agent reviews the whole stack (`base...tip`); its fixes land as **one integration PR on top of the stack**, touching nothing below. The gate cannot replace this: what a per-ticket review structurally cannot see is the interaction **between** tickets — two implementations of one helper, abstractions that contradict each other, a contract one ticket relies on that another quietly changed.
9. **Finalize** — in native mode, one `gh stack link` call registers the whole chain as a GitHub stack, bottom to top. Every published PR is then marked ready — drafts block a stack merge. A complete run appends `Closes #<spec>` to the **top** PR, so the whole-stack merge closes everything at once; a partial run adds no spec-close anywhere and instead comments on the top PR and the spec issue naming what remains. **The workflow never merges** — merging is the operator's, once, from the top.
10. **Cleanup** — the run's worktrees are removed and pruned; branches, PRs and the user's own checkout are left alone.

## The stack

Ticket by ticket the lane builds an ordinary chain — each PR based on the branch below — and finalize registers it as a **native GitHub stack** so the operator gets the stack map on every PR and merges the whole thing in **one atomic operation from the top PR** (or `PUT .../pulls/<top>/merge-async`).

`gh stack link` is the **only** `gh stack` command the run uses: it is stateless, append-only, and pushes without force. The rest of the extension is unfit for a parallel run and stays banned — `submit` force-pushes every branch; `init`, `add`, `sync`, `rebase` and `checkout` keep their state per-worktree (`.git/gh-stack` resolves via `--git-dir`) or rewrite history the stack has already published.

What the operator should know before merging, and the brief restates:

- **Every layer must pass on its own**: required checks, required reviews and CODEOWNERS are evaluated for **each PR in the stack against the stack's base branch** — approving only the top PR is not enough.
- CI runs on every layer as if it targeted the base branch, so a deep stack multiplies CI usage.
- After a **failed** stack merge, re-read the actual state of the base branch — GitHub's own docs disagree on whether a failed merge rolls back fully, so assume nothing.
- In **chain** mode there is no stack object: merge bottom-up by hand, with **merge commits**, deleting each head branch after its merge so GitHub retargets the next PR — squash and rebase merges rewrite the shas and give every child PR a phantom diff.

## The rejection ledger

The gate loop's hazard is not slow convergence, it is **ping-pong**: a fixer judges a finding wrong and leaves the code, the next reviewer raises it again, and the pair trade the same finding until the cap — every round costing two agents and changing nothing.

So rejection is a first-class outcome. The fixer returns one verdict per finding, `fixed` or `rejected` **with a specific checkable reason**, and every rejection accumulates into a ledger carried into all later rounds. A later reviewer may raise a rejected finding again only by **falsifying its stated reason** — naming which part is false and why. Absent that, the loop would never terminate on any disputed call.

The reviewer being fresh each round is what makes "clean" a verdict rather than one reviewer running out of patience.

## Reviews

Both the gate and the final pass run the in-repo [`code-review`](../code-review/SKILL.md) skill, which reviews a diff since a fixed point on two axes — **standards** (does it follow this repo's documented standards) and **spec** (does it do what the originating issue asked for) — in parallel subagents.

They differ only in what they pin: the gate pins the base the ticket branch was cut from as the fixed point and the **ticket** as the spec, so a ticket is judged against its own acceptance criteria; the final pass pins the base ref and the **spec issue**, over the whole stack.

## Attribution

The nine-step shape — spec and tickets as a task graph, implementer subagents in their own worktrees, publication onto a shared line of work, review then ready — follows Anthropic's `implement-spec` skill. What this skill adds is the translation into one deterministic script (frontier scheduling, the serial publish lane), the stacked one-PR-per-ticket output registered as a native GitHub stack, the per-ticket gate loop with its rejection ledger, human-gated ticket exclusion, and the discipline of keeping the orchestrator's context empty.
