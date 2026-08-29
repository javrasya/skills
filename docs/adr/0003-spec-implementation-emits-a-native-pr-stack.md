# ADR-0003: Spec implementation emits a native PR stack, registered with `gh stack link` only

## Status

Accepted — 2026-08-29. Amends ADR-0002, whose output shape (one PR per spec) this supersedes; everything else in ADR-0002 — the workflow script, the gate loop, the rejection ledger, the serial lane — stands.

## Context

ADR-0002 collapses a whole spec into one PR. That PR carries every ticket's diff at once, which is exactly the thing the per-ticket gate exists to avoid *during* the run and then hands the operator anyway *after* it: one review, at the largest possible size. The operator wanted the run's output to match how it was built — one small reviewable PR per ticket — and wanted to merge the result in one operation rather than by hand, bottom-up.

GitHub shipped native **stacked pull requests** (public preview, 2026-07): a registered Stack object over a chain of base-linked PRs, a stack map on every PR, and an atomic whole-stack merge from the top PR (`merge-async`). The CLI is the `gh-stack` extension (v0.1.x). Three findings from its source shaped this decision:

- Its local state (`.git/gh-stack`) resolves via `git rev-parse --git-dir`, so in a **linked worktree it is per-worktree** — invisible across the parallel worktree agents this workflow runs on.
- `gh stack submit` **force-pushes** every branch (`--force-with-lease`); `init`/`add`/`sync`/`rebase`/`checkout` need that per-worktree state, rewrite history, or check branches out.
- `gh stack link` needs **no local state**, pushes **without force**, reuses existing PRs, leaves correctly-based PRs untouched, and registers append-only.

Four questions had to be settled: how a parallel task graph becomes a linear stack; where fixes land once a PR is published; what closes the spec; and what happens where native stacks are missing.

## Decision

**The graph is linearized at the serial lane, not at scheduling.** Implementers stay parallel and frontier-scheduled; the lane — the same single-slot queue ADR-0002 serialised merges through — now *publishes*: one agent at a time rebases its ticket branch onto the current stack tip, pushes, and opens a draft PR based on the tip, `Closes #<ticket>` in the body.

**Publish-once.** All history rewriting happens before a branch becomes a PR; nothing ever pushes to a published one. The gate runs on the still-unpublished branch, the lane's rebase is the last rewrite, and the whole-stack review's fixes land as one **integration PR on top** — never as pushes into published layers, which would force-update every PR above and hand the operator phantom diffs mid-review.

**The stack is registered once, at finalize, with `gh stack link` and nothing else from the extension.** The lane builds a plain base-chain; one `link` call registers it bottom-to-top. `submit` and the stateful/rewriting commands are banned for the reasons above.

**The operator merges once, atomically, from the top PR; the workflow never merges.** Every PR is drafted during the run and made ready at finalize (drafts block a stack merge). A complete run appends `Closes #<spec>` to the top PR — the atomic merge makes "top PR merged" imply "everything merged", so the close is honest. A partial run (failed or human-gated tickets are dropped along with their dependency-downstream) readies what landed, adds no spec-close, and comments on the top PR and the spec issue naming what remains.

**Prior work on a branch becomes layer 0** — the bottom of the stack, its own draft PR, its body stating it carries pre-existing work the run never gated. `Closes` only fires on a merge into the default branch, so prior work must ride *in* the stack, not be the branch the stack merges into.

**Availability is gated at arm time, in two different ways.** Extension not installed → stop and hand the operator the install command; never auto-install. Stacks API not enabled for the repo (404 / extension exit 9 — no install fixes it) → put the choice to the operator: enable it, or degrade to a plain `--base` chain merged bottom-up by hand with merge commits, deleting each head branch so GitHub retargets the next PR. Never a silent fallback.

## Consequences

- **The operator reviews ticket-sized diffs and merges once.** The stated goal.
- **Both unattended skills now emit stacks.** The axis separating `implement-all` from this skill is how the stack is built — serial prose loop vs parallel scripted run — recorded in `CONTEXT.md`.
- **The gate reviews a diff that is not byte-for-byte the PR's diff.** The lane's rebase (and its conflict resolutions) happens after the gate. Accepted: the whole-stack review sees the final state, and the alternative — gating published PRs — breaks publish-once.
- **A reviewer approving a lower layer may be approving code the integration PR later corrects.** Loud, not hidden: the integration PR names itself as the cross-ticket fixes.
- **The merge bar is per-layer.** Required checks, reviews and CODEOWNERS are evaluated for every PR in the stack against the trunk; CI runs on every layer, so a deep stack multiplies CI usage. Approving the top PR alone is not enough.
- **Atomicity of a failed stack merge is not trusted.** GitHub's own pages disagree on whether a failed merge rolls back fully; the brief tells the operator to re-read the base branch rather than assume.
- **The feature is a public preview and the extension is v0.1.x.** The chain-mode fallback is the hedge: the PR shape survives even if the Stack object, its API, or the extension changes under us.
