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
   | `__BASE_REF__` | the branch the stack merges into. The user naming one settles it. Otherwise check `git branch --show-current` against the repo's default branch: when they match, use the default branch silently; when the checkout sits on some other branch, **ask the user** which branch the stack merges into — the default branch, or the one they are on — and wait. A checkout parked on a long-lived branch often means the work targets that branch, and a wrong base miscuts every PR in the stack, so this is never guessed. Prior work already sitting on a feature branch is **not** this value: the workflow's discovery agent finds that branch itself and it becomes the stack's bottom layer. |
   | `__STACK_MODE__` | `native` when both probes in step 1 passed; `chain` when the user chose the fallback |
   | `__NOTES_DIR__` | `~/.claude/spec-notes/<repo-name>-<spec>`, absolute — durable, outside every checkout, readable by every agent |

3. Render the script: copy `workflow.template.js` to `<notes-dir>/workflow.js` and substitute the six placeholders. Substitute, do not rewrite — the publish lane and the frontier scheduling are load-bearing.

4. Launch it against the rendered path. It runs in the background and notifies you when it returns; do not poll it, and do not do any of its work yourself while it runs.

5. Report what it returned: the stack bottom-to-top with each PR's url and state, the merge instructions for the mode the run ended in, tickets that failed, tickets deferred to a human and why, and the notes directory. The workflow's return value is already a summary — pass it on rather than re-deriving it from the PRs.

To iterate after a failure, edit `<notes-dir>/workflow.js` and relaunch it with the harness's resume handle: the unchanged prefix of `agent()` calls returns from cache and only the edited call onward re-runs.

## What the workflow does

1. **Graph** — one agent reads the spec and every ticket and returns the task graph: blocking edges, which tickets need a human, and which branch already carries work for this spec. Blocking edges are usually **prose** in a "Blocked by" section; GitHub's sub-issue and dependency APIs are frequently empty even when the tickets exist, so the agent reads rather than queries.
2. **Explore** — parallel research agents write markdown into the notes directory, outside the repo. Notes are capped and **cite rather than quote** — a note saves later agents the search, not the reading — and later agents read only the notes whose subject bears on their ticket, not all of them.
3. **Setup** — only when prior work already sits on a branch: that branch becomes **layer 0**, the bottom of the stack, with its own draft PR whose body says plainly that it carries pre-existing work this run never gated.
4. **Dispatch** — a **dispatcher** per ticket reads the ticket and spec **once** and writes self-contained **slice briefs**; implementers read no issue and no spec. One slice is the normal verdict — the dispatcher is biased against slicing, because under-slicing self-corrects (an overrun comes back as a remainder to re-slice) while over-slicing pays a fresh agent's warm-up per slice with no corrective. It skims code structure only, never implementations, and also emits a `ticket_brief` later fix agents use instead of the issue. **The dispatcher is the only route into any work the run does** — it has a second entry point that sizes review findings into fix slices, so no agent anywhere in the run starts unsized (ADR-0004).
5. **Implement** — slices run **sequentially on the ticket branch**, each a fresh-context agent in its own worktree, cut from the stack tip as it stood, tickets still starting as early as their dependencies allow. A slice that outgrows its context (roughly 70 tool calls) commits and pushes what works and returns the remainder — the dispatcher re-slices it for a fresh agent, up to `MAX_DISPATCH_ROUNDS`; a remainder that survives the cap is carried as **unmet**, holds the spec open, and is named for the operator.
6. **Gate** — each ticket is reviewed **on its own still-unpublished branch**, against the base it was cut from, before it becomes a PR. Review and fix then alternate until a review returns nothing blocking (minors pass), **a fresh reviewer each round**, capped at `GATE_MAX_ROUNDS`; on the cap it publishes with what is unresolved and the log and summary name it, rather than stalling every ticket downstream. Set `GATE_MAX_ROUNDS = 0` to review only at the end. The fixing half of every round goes **through the dispatcher**: it sizes the blocking findings from the `ticket_brief` and the named files' structure — never the issue — and briefs fresh fix slices, each owning named findings and returning a verdict for each. The script then reconciles verdicts against findings; anything with no verdict is logged and handed to the next reviewer to check explicitly. A slice's remainder is never re-dispatched in place — the next reviewer re-derives what is still broken from the branch, so one cap governs the gate rather than two.
7. **Publish lane** — a **serial lane** turns the graph into a chain: exactly one agent at a time rebases its ticket branch onto the current stack tip and opens a draft PR based on the tip, `Closes #<ticket>` in the body. Until this moment the branch has lived **only in the shared clone**, so the rebase rewrites commits that never left it and the lane's push **creates** the branch on origin rather than overwriting it — **publish-once**: a branch reaches origin exactly once, no ref on origin is ever rewritten, and no agent is ever told to force-push. Two agents publishing concurrently would base on the same tip, which is the failure the lane exists to prevent. **The lane also registers the stack as it grows** — after opening its PR it runs `gh stack link` over the whole stack bottom-to-top, so a real stack map exists from the second layer onward rather than only after the run (ADR-0006). Each PR body opens with `Layer k of N planned`, and every layer stays **draft** until finalize: together they say the run is still adding.
8. **Frontier** — no phase barriers. Each ticket is one memoised promise awaiting its dependencies' *publishes*, so a ticket starts the instant its blockers' PRs exist and the run costs the longest chain rather than the sum of the phases.
9. **Review** — one agent reviews the whole stack (`base...tip`); its findings go through the dispatcher like any other work, and the fixes land as **one integration PR on top of the stack**, touching nothing below. A separate low-effort agent opens that PR and changes no code — publishing is the phase's one irreversible act and does not belong to whichever fixer ran last. The gate cannot replace this review: what a per-ticket review structurally cannot see is the interaction **between** tickets — two implementations of one helper, abstractions that contradict each other, a contract one ticket relies on that another quietly changed.
10. **Finalize** — in native mode, one `gh stack link` call **reconciles** the registration the lane has been maintaining all along: it picks up the integration PR (which publishes outside the lane, so nothing there ever links it) and repairs any in-lane call that failed. Every published PR is then marked ready — drafts block a stack merge, and until this step the drafts are what tell the operator the run is still adding layers. A complete run appends `Closes #<spec>` to the **top** PR, so the whole-stack merge closes everything at once; a partial run adds no spec-close anywhere and instead comments on the top PR and the spec issue naming what remains. **The workflow never merges** — merging is the operator's, once, from the top.
11. **Cleanup** — the run's worktrees are removed and pruned; branches, PRs and the user's own checkout are left alone.

## The stack

Ticket by ticket the lane builds an ordinary chain — each PR based on the branch below — and registers it as a **native GitHub stack** as it goes, so the operator gets the stack map on every PR from the second layer onward and merges the whole thing in **one atomic operation from the top PR** (or `PUT .../pulls/<top>/merge-async`).

`gh stack link` is the **only** `gh stack` command the run uses: it is stateless, reconciling, and pushes without force. Three rules govern how the run calls it (ADR-0006): **re-list the whole stack every time** rather than using the stack-number shortcut, which would make the run carry state between agents; **never name a branch whose PR does not already exist**, because `link` would open one outside the run's control; and **never pass `--open`**, which would ready the drafts and destroy the in-progress signal. Two layers is its minimum, so a single-PR stack is never registered — correctly, not as a failure. A `link` failure never fails a publish: a transient one is repaired for free by the next publish's re-list, and only a hard exit 9 latches, degrading the run to a plain chain that the brief names in its own field rather than in a footnote. The rest of the extension is unfit for a parallel run and stays banned — `submit` force-pushes every branch; `init`, `add`, `sync`, `rebase` and `checkout` keep their state per-worktree (`.git/gh-stack` resolves via `--git-dir`) or rewrite history the stack has already published.

What the operator should know before merging, and the brief restates:

- **Every layer must pass on its own**: required checks, required reviews and CODEOWNERS are evaluated for **each PR in the stack against the stack's base branch** — approving only the top PR is not enough.
- CI runs on every layer as if it targeted the base branch, so a deep stack multiplies CI usage.
- After a **failed** stack merge, re-read the actual state of the base branch — GitHub's own docs disagree on whether a failed merge rolls back fully, so assume nothing.
- In **chain** mode there is no stack object: merge bottom-up by hand, with **merge commits**, deleting each head branch after its merge so GitHub retargets the next PR — squash and rebase merges rewrite the shas and give every child PR a phantom diff.

## The rejection ledger

The gate loop's hazard is not slow convergence, it is **ping-pong**: a fixer judges a finding wrong and leaves the code, the next reviewer raises it again, and the pair trade the same finding until the cap — every round costing two agents and changing nothing.

So rejection is a first-class outcome. Each fix slice returns one verdict per finding it owns, `fixed` or `rejected` **with a specific checkable reason**, and every rejection accumulates into a ledger carried into all later rounds. A later reviewer may raise a rejected finding again only by **falsifying its stated reason** — naming which part is false and why. Absent that, the loop would never terminate on any disputed call.

The ledger only works if every finding comes back with *something*, so the workflow reconciles verdicts against findings **in the script, not in a prompt** — exact match on location and issue, else a location only one verdict claims. A finding with no verdict is never assumed fixed: it is logged and named to the next reviewer, which checks it on the branch. Reconciling by asking an agent what it failed to do would re-introduce the failure ADR-0004 exists to remove.

The reviewer being fresh each round is what makes "clean" a verdict rather than one reviewer running out of patience.

## Reviews

Both the gate and the final pass run the in-repo [`code-review`](../code-review/SKILL.md) skill, which reviews a diff since a fixed point on two axes — **standards** (does it follow this repo's documented standards) and **spec** (does it do what the originating issue asked for) — in parallel subagents.

They differ only in what they pin: the gate pins the base the ticket branch was cut from as the fixed point and the **ticket** as the spec, so a ticket is judged against its own acceptance criteria; the final pass pins the base ref and the **spec issue**, over the whole stack.

## Attribution

The nine-step shape — spec and tickets as a task graph, implementer subagents in their own worktrees, publication onto a shared line of work, review then ready — follows Anthropic's `implement-spec` skill. What this skill adds is the translation into one deterministic script (frontier scheduling, the serial publish lane), the stacked one-PR-per-ticket output registered as a native GitHub stack, the per-ticket gate loop with its rejection ledger, human-gated ticket exclusion, and the discipline of keeping the orchestrator's context empty.
