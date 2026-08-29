# Frontier query

**The definition of *takeable*.** Both `/implement-next` and `/implement-all` read it from here rather than carrying a copy, because a second copy of the query is exactly how two skills come to mean different things by the same word.

A spec's tickets are a **graph**, not a list: its edges are blocking relationships, so at any moment some set of tickets has all its blockers satisfied. That set is the **frontier**.

## The query

Over the spec issue's sub-issues, keep the ones that are **open**, **`blocked_by == 0`**, **unassigned**, and carrying **`ready-for-agent`** or **`ready-for-human`**.

```bash
gh api "repos/<owner>/<repo>/issues/<spec>/sub_issues?per_page=100" --paginate \
  --jq '.[]
        | select(.state == "open")
        | select((.assignees | length) == 0)
        | select([.labels[].name] | any(. == "ready-for-agent" or . == "ready-for-human"))
        | "#\(.number) [\([.labels[].name] | join(","))] \(.title)"'
```

`blocked_by` is not on the sub-issue payload; check it per candidate, in list order, and stop at the first that passes:

```bash
gh api "repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by" \
  --jq '[.[] | select(.state == "open")] | length'      # 0 → unblocked
```

### Why each of the four conditions is doing work

- **open** — a closed ticket is done, and a reopened one is genuinely back on the frontier.
- **`blocked_by == 0`** — the graph edge. This is the only test for whether a ticket may start; see [Never talk past a block](#never-talk-past-a-block).
- **unassigned** — an assignee is a claim. Someone, or some other session, already holds it.
- **`ready-for-agent` or `ready-for-human`** — the two triage roles that mean *specified*. A ticket carrying neither has not been triaged, and its body cannot be trusted as a spec. See `docs/agents/triage-labels.md`.

### Order

**The sub-issue list is both the scope and the order.** Sub-issue order is the operator's order, dragged in the tracker's own UI. Never re-sort it, never rank, never score, never pick "the one that unblocks the most" — take the **first result in list order**.

### The `--paginate` gotcha

`--paginate` applies `--jq` **per page** and concatenates the results. So jq's `first`, `sort_by` and `.[0]` each operate on one page rather than the whole set, and quietly return the wrong row once the list exceeds a page. **Take the first line of the emitted stream** instead.

## When the frontier is empty

An empty frontier is never "nothing to do". It is **five distinct facts** wearing one face, and collapsing them is the failure this table exists to prevent. Run the discriminators over the spec's open sub-issues and say which one it is.

| Fact | What it means | What to say |
|---|---|---|
| **No open sub-issues** | The spec is finished. | Say so, and offer to close the spec issue. |
| **All open ones blocked** | Real graph edges hold the rest back. | Name the blockers holding the most back — the aggregation is below. |
| **Everything left gated by a `ready-for-human` ticket** | One human ticket is the whole obstruction. | Name **that ticket** and why its body says it needs a human. Never the generic "all open ones blocked". |
| **All open ones assigned** | Someone already holds the work. | Name who holds them. |
| **Open, unblocked, unlabelled** | A triage gap, not a dependency. | Name them and offer to triage. |

To name the blockers, aggregate across the remaining open sub-issues — the query has already dropped every blocked ticket, so an empty frontier tells you nothing on its own about *what* holds the rest:

```bash
gh api "repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by" \
  --jq '.[] | select(.state=="open") | "#\(.number) \(.title)"'
```

**Rows 2 and 3 are one aggregation apart** and collapse unless you run it. Take the first branch that matches:

- The aggregated open-blocker set is **empty** → nothing is blocked, so row 2 is simply false and must not fire. What is left is whatever the caller **skipped**, and the fact is the skip reason.
- The set is **exactly** the ticket(s) skipped as `ready-for-human` → **row 3**.
- Anything else → **row 2**.

## Fallbacks

Two ways this query answers a different question than the one you asked.

**Native dependencies not wired.** If `blocked_by` reads `0` for everything — including tickets with obvious blockers — the graph is prose-only, and the query is reporting an unblocked frontier that does not exist. Blocking edges frequently live as prose (`Blocked by #12`) rather than in the tracker's dependency API. Either wire the edges, which makes this and every other tool work:

```bash
gh api -X POST "repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by" -f issue_id=<blocker-id>
```

…or parse the prose refs — and **say that you did**, because a prose parse is a guess about formatting.

**Sub-issues not used.** If the tickets name their parent in prose instead of being wired as sub-issues, scope by that body text — and note it, because a body-text scope silently misses a ticket whose parent line was reworded.

## Never talk past a block

Two ways the block gets argued away, both forbidden:

- **"The blocker's PR is merged, so the block is stale."** `blocked_by` is the whole test. A merged PR is not a closed issue, and only closing the blocker changes the answer. If the block really is stale, say so and offer to close the blocker, then re-resolve.
- **"There must be something else I can take."** There is no wider query to fall back to. The frontier is what this query returned; a candidate you did not take leaves the frontier empty, it does not extend it. The tickets sitting directly below a declined pick are usually the ones **it blocks**.
