---
name: implement-next
description: Find the next pickable ticket under a spec issue and implement it. Resolves the frontier from GitHub sub-issues and native dependencies, claims the ticket, then implements it. Use when the user says "/implement-next <spec>", "what's next on this spec", "pick up the next ticket", or wants to work the next unblocked slice of a broken-down spec.
disable-model-invocation: true
---

# Implement Next

Find the next pickable ticket under a spec issue, claim it, and implement it.

Assumes a spec that has already been broken into sub-issues wired with native dependencies; this walks that graph one ticket at a time.

The issue tracker and the triage label vocabulary live in the repo — `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`, named from its `CLAUDE.md`. Read them from there; neither is restated here.

## Arguments

`/implement-next #<spec-issue> [count] [--dry]`

- **`#<spec-issue>`** — the parent issue whose sub-issues are the tickets. Required.
- **`count`** — how many tickets to pick. Default 1. See [Picking more than one](#picking-more-than-one) before going above 1.
- **`--dry`** — resolve and report the frontier, claim nothing, implement nothing.

## Process

### 1. Resolve the frontier

**The definition of *takeable* is shared, and it lives in the repo — `docs/agents/frontier.md`.** Read it and run the query it carries: one `gh api` call over the spec's sub-issues, keeping the ones that are open, `blocked_by == 0`, unassigned, and carrying `ready-for-agent` or `ready-for-human`. The fragment states why each of those four conditions is doing work, and carries the `--paginate` gotcha. Run it from there rather than from memory — a second copy of the query is exactly how two skills come to mean different things by the same word.

The sub-issue list is both the scope and the order — **sub-issue order is the operator's order**, dragged in GitHub's own UI, so never re-sort it.

**Take the first result in list order.** Do not rank, score, or pick "the one that unblocks the most" — the order is the human's and the harness never invents a ranking.

The query trusts native dependencies. If `blocked_by` reads `0` for everything including tickets with obvious blockers, the graph is prose-only — see [Fallbacks](#fallbacks) before believing the result.

### 2. Report before acting

Print the picked ticket(s) and how many other candidates there were. If `--dry`, stop here.

If the frontier is **empty**, say **which** fact it is rather than reporting "nothing to do". The facts are listed in `docs/agents/frontier.md` under *When the frontier is empty*, with what each means and what to say — read them there. Do not restate the table here: a local copy is how one of the facts quietly goes missing.

They are distinct facts and must not collapse into one message.

### 3. Check the type before running

**`ready-for-agent`** — proceed.

**`ready-for-human`** — stop and confirm with the user first. The label exists because something in the ticket needs a human: a design decision, an acceptance bar the agent cannot see, a judgement call. Print **why** the ticket says it needs a human (read its body — a well-formed ticket states this) and ask whether to proceed anyway. Never auto-run a `ready-for-human` ticket.

**If they decline, the run is over — halt.** A declined candidate does not promote the tickets underneath it. Everything the query excluded is still excluded, and the tickets sitting directly below a `ready-for-human` pick in the operator's order are usually the ones **it blocks** — so walking down the list is not "taking the next ticket", it is taking the blocked set. Report it as the empty-frontier fact it now is: the remaining work is gated, and the gate is a human ticket. Name that ticket.

Two ways this rule gets talked around, both forbidden:

- **"The blocker's PR is merged, so the block is stale."** `blocked_by` is the whole test. A merged PR is not a closed issue, and only closing the blocker changes the answer. If the block really is stale, say so and offer to close the blocker — then re-resolve. Never proceed on the reasoning alone.
- **"The human declined *that* one, not the whole run."** There is no wider query to fall back to. The frontier is what the frontier query returned; a candidate you did not take leaves the frontier empty, it does not extend it.

**This is the one divergence from `/implement-all`**, and it is the only one: on a `ready-for-human` pick this skill asks, because a human is present; `/implement-all` skips it and looks for the next ticket **the query already returned**, because unattended there is nobody to ask. Neither skill ever reaches past that list.

### 4. Claim it

```bash
gh issue edit <n> --add-assignee @me
```

**Claim before implementing, always.** It is the first write of the session and it is what stops two sessions duplicating work. If the claim fails because someone else got there first, stop and re-resolve the frontier — do not proceed on a lost race.

### 5. Implement

Read the full ticket — `gh issue view <n> --comments` — and implement it: the repo's own implement skill if it has one, otherwise directly. The ticket's **What to build** is the spec and its **Acceptance criteria** are the definition of done; work through them rather than declaring completion by feel.

If the ticket names a parent spec, read that too where a decision is unclear. The ticket links the reasoning rather than restating it.

### 6. Resolve

Follow the tracker's resolve convention: comment the outcome on the ticket, then close it.

Report which acceptance criteria are met and which are not. **An unmet criterion is a finding, not a failure to hide** — say so plainly and leave the ticket open if the work is genuinely incomplete.

## Picking more than one

**Unblocked does not mean non-colliding.** The frontier query answers *may this start*, not *may these two run in one working tree*. Two unblocked tickets that both edit the same module will fight.

Before picking `count > 1`:

1. Read each candidate's **What to build** and judge whether they touch the same area.
2. If they might collide, **either** pick fewer **or** give each its own git worktree.
3. Say which you did. A silent narrowing reads as "covered everything" when it did not.

Worktree per ticket:

```bash
git worktree add .worktrees/<n>-<slug> -b <n>-<slug>
```

Never run two agents against one working tree because the dependency graph said they were both unblocked.

## Fallbacks

Two ways the frontier query answers a different question than the one you asked. Both are named in `docs/agents/frontier.md`, which carries the commands:

- **Native dependencies not wired.** `blocked_by` is `0` for everything, so nothing looks blocked. Wire the edges — one `POST` per edge, and it makes this and every other tool work — or parse the prose `Blocked by` refs and **say that you did**, because a prose parse is a guess about formatting.
- **Sub-issues not used.** The tickets name their parent in prose instead. Scope by that body text, and note it: a body-text scope silently misses a ticket whose parent line was reworded.

## Rules

- **Never re-rank.** Sub-issue order is the human's order.
- **Claim before work, every time.**
- **Never auto-run `ready-for-human`.** And a declined one halts the run — it never promotes the tickets below it.
- **The query is the only source of candidates.** Never implement a ticket it did not return. If you believe one should have been returned, fix the graph and re-run the query; do not reason your way past it.
- **Never modify the parent spec issue.**
- **An empty frontier is never "nothing to do".** Say which of the facts in `docs/agents/frontier.md` it is.
- **Unblocked ≠ non-colliding.** Worktrees or fewer tickets.
- **Takeable is defined in `docs/agents/frontier.md`, not here.** Read it; never restate the query.
- **Unattended and chained is `/implement-all`.** This skill picks one ticket with a human present; that one walks the whole map, stacking a green PR per ticket.
