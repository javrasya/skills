---
name: stack-sweep
description: >-
  Pin one PR's place in its stack of PRs (parents, children, siblings, tip, registered or plain
  chain), then, for each construct you are asked about — a behaviour a gap is made of, or the
  lines and request of a review comment — say whether a later layer addresses it, leaves it
  unchanged through the tip, or changes it without addressing it. Read-only; produces evidence,
  never edits or posts. Use whenever a finding on one PR of a stack could already be answered by
  another layer, before any fix is recommended or any reply is drafted.
---

# Stack sweep

A PR that sits in a stack is never the whole story: what looks missing at layer 5 may exist at
layer 9, and what looks wrong may be rewritten at the tip. Recommending work, or answering a
reviewer, without looking at the layers above is how two agents do one job twice, or how a fix
lands twice in two places. This skill does the looking, and nothing else.

Two things come out of it. A **stack map**: where the PR sits, what is below and above it, what
the tip is, and whether GitHub knows the stack as a registered Stack or only as a chain of base
branches. And, for each **construct** the caller hands in, one of three **outcomes** with the
evidence that produced it.

Both are facts about the repo at the moment of the call. Every consumer of this skill states
whether it fetched fresh refs, because a stale remote-tracking ref gives a confident wrong answer.

## Vocabulary

- **Layer**: one PR of the stack. Layer k+1's base branch is layer k's head branch.
- **Trunk**: the first base branch below the PR that has no open PR of its own — the default
  branch when the whole stack is open, a merged layer's branch when the bottom has already landed.
- **Tip**: the top layer along the main line above the PR. A fix for anything in the stack lands
  as a new PR based on the tip, never as a commit into a layer (ADR-0010).
- **Construct**: the thing being looked for. For a gap, the behaviour it is made of — the
  `None` that should be a value, the missing call, the absent test. For a review comment, the
  lines it points at plus what the reviewer asks of them.
- **Outcome**: *addressed downstream* / *unchanged through the tip* / *changed but not addressed*.

## Step 1 — pin the stack

```
scripts/stack-map.sh <pr>            # from inside a clone of the repo, so it can fetch
```

It returns one JSON object: `layers` bottom-to-top with the PR's `position`, `parents`,
`children` along the main line, `siblings` (other open PRs on the same base), `tip`, `forks` (a
layer with more than one child — sweep every branch of a fork, the script's pick of a main line
is a convenience, not a verdict), `registered` (the GitHub Stack number and size, or `null`),
`trunk` with `trunk_is_default_branch`, and `fetched`.

Read three things off it before anything else:

- **`in_stack` false** — no parent, no child. There is nothing to sweep; tell the caller so and
  stop. The caller's single-PR behaviour applies.
- **`registered` non-null** — the stack is a GitHub Stack. Anything a caller adds on the tip
  has to be linked in (`gh stack link`, re-listing every layer bottom-to-top, per ADR-0006 and
  ADR-0007) or it sits outside the atomic merge. Report the stack number so the caller can.
- **`fetched` false, or the script itself failed** — say so in the first line of the output.
  Facts about the stack then come from GitHub's PR list alone, and facts about code come from
  whatever refs the clone last fetched.

A registered stack's `size` can exceed the number of open layers: merged layers stay in the
registration. That is not a discrepancy to chase.

## Step 2 — sweep each construct

For each construct, walk the layers **above** the PR along the main line, then every branch of
every fork, then the siblings. At each layer, look for the construct in that layer's tree and in
that layer's own diff:

```
git show origin/<head>:<path>                         # what the layer's tree holds
git diff origin/<base>..origin/<head> -- <path>       # what the layer itself changed there
```

**Count behaviour, not prose.** A comment can move, be reworded, or be folded into a helper
while the behaviour it described survives untouched; a refactor can rename every literal you
grepped for and change nothing. The question at each layer is *does the code do the thing*, and
the evidence is the symbol, the call, the test, the value — per branch, so the report can say
"unchanged at layers 6 through 12" rather than "seems fine".

For a **review comment**, the construct is the reviewer's request, read as a change to the
lines they marked. A question ("why is this `None` here?") and a disagreement ("this should be a
value") both name a change the reviewer expects; the sweep asks whether a later layer makes
that change. A layer that rewrites those lines in a different direction is not an answer to the
comment, it is a second fact the reply has to state.

### The three outcomes

- **Addressed downstream.** A later layer does what the construct asks. Name the first layer
  that does and the evidence in it (`ticket/362` adds the `owner_id` binding at
  `validate.rs:88`, pinned by `test_owner_id_present`). The caller recommends no work here and
  points at that layer.
- **Unchanged through the tip.** No layer above the PR, on any branch of the stack, changes
  the construct. Say it with the count ("all four sites unchanged from layer 5 to layer 12,
  tip `spec/339-integration-4`"). This is what makes the caller's disposition, or
  verdict, defensible.
- **Changed but not addressed.** A later layer touches the same lines and does something
  else — a cosmetic rewrite, a move, a rename, a partial fix. Report which layer and what it
  did instead, and flag the **conflict hazard**: whichever of the two changes lands second
  takes the conflict, and a fix written against the PR's tree will not apply cleanly at the tip.

## Output

Lead with freshness when it is not clean, then the map in one line, then one line per construct:

```
Stack: layer 5 of 12 (#366, ticket/363), tip #379 spec/339-integration-4,
       registered Stack 350, trunk ticket/357 (not the default branch — layers below have merged).
C1 (validate.rs:88 `None` → value): unchanged through the tip — 4 sites, layers 6–12 identical.
C2 (comment on retriever.rs:41, "extract a helper"): addressed downstream — #373 ticket/370
    extracts `wrap_total` at retriever.rs:33, used at both sites.
C3 (comment on model.rs:12, "rename to owner_id"): changed but not addressed — #369 moves the
    field to model.rs:40 unrenamed. Conflict hazard: a rename here collides with that move.
```

Evidence stays with the line that needs it. A construct's verdict without its per-layer count is
an opinion; with it, the next agent can re-check in one command.

## Traps

- **Grepping prose instead of behaviour.** Four literals folded into one helper changes every
  string you searched for and none of the behaviour. Count the behaviour.
- **A stale ref.** `fetched: false` means every code fact is as old as the clone's last fetch.
  Say so; do not let the map's confidence leak into the code verdict.
- **A fork you did not walk.** The script picks a main line; a sibling branch off the same layer
  is where a parallel run parks its fix. `forks` and `siblings` are part of the sweep, not
  context.
- **Trunk that is not the default branch.** Layers below have merged; the construct may already
  be on the default branch. Check `origin/<default>` once when the trunk is a merged layer.
- **A closed layer.** A child PR that was merged or closed no longer appears; if the caller
  expected it (a PR body said "fixed in #N"), look it up by number rather than assuming it is
  gone from the stack because it is gone from the map.
