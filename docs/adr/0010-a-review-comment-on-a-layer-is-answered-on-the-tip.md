# ADR-0010: A review comment on a stacked layer is answered by a PR on the tip, never by a commit into the layer

## Status

Accepted — 2026-09-16. Applies the publish-once invariant of ADR-0005 to review comments and to the dispositions of `code-review-in-stack`. ADR-0005 stands unchanged; this records the consequence its authors did not have to face, because the run it governed never answered a reviewer.

## Context

`pull-spiderman` answered review comments on one PR and, when it agreed with the reviewer, fixed the code in that PR's branch. `code-review-in-stack` reviewed one layer of a stack and its first disposition for a gap was *fix in this PR*. Both were written for a PR that is the whole change.

A layer of a stack is not the whole change. Every layer above it is based on its head, GitHub's stack merge takes the layers as they stand, and a stack built by `implement-spec-in-workflow` was published under the rule that **no ref on origin is ever rewritten** (ADR-0005). Appending a commit to a layer is not a rewrite, but it is worse in the way that matters: the children were cut before it, so the tip — the tree the operator merges — does not contain it until every child is rebased or merged forward, and a stack of nineteen layers pays nineteen restacks for a one-line fix. Meanwhile a reviewer reading the layer sees the fix; a reviewer reading the tip does not.

Two agents working the same stack made the second problem visible. A gap found at layer 5 by one review was already closed at layer 9 by another ticket's work; a reply that "fixed" it in layer 5 would have landed the same change twice. Recommending or answering without looking at the layers above is how a stack accumulates duplicate work.

Three options:

1. **Fix in the layer** and restack every child. Keeps the fix where the reviewer looked; costs a restack per child, and each restack rewrites a published ref — exactly what ADR-0005 forbids a run to do, and what a human should not have to do nineteen times for a nit.
2. **Fix at the tip silently**, appending to the tip branch. Cheap; but the tip is itself a published layer with its own PR and its own reviewer, and a fix for layer 5 buried in layer 19's diff is invisible to both reviewers.
3. **Fix as a new PR on the tip**, one per run, tracked by one ticket, with the reply on the original comment pointing at both. Every published ref stays untouched, the tip moves forward by one node, and the reviewer who asked is told where the answer went.

## Decision

**A published layer is immutable, the tip included.** No skill in this repo commits to a branch that has a PR with a parent or a child. That is the test — having a parent or a child — not the size of the fix.

**Every comment is swept before it is judged.** The `stack-sweep` skill asks, for each comment, whether a later layer already makes the change the reviewer expects. A question and a disagreement are swept the same way as a requested change: each names something the code should become, and a later layer either makes it so or does not. The three outcomes — *addressed downstream*, *unchanged through the tip*, *changed but not addressed* — are the same three `code-review-in-stack` uses for a gap, from the same skill, so the two callers cannot come to mean different things by the same word.

**Agreed fixes land as one PR on the tip per run, tracked by one ticket.** The ticket is filed first, as a sub-issue of the spec the stack implements when there is one, so the reply "will be fixed in a PR on top of the stack" is true whether the fix is made in that run (`agree-and-fix`) or deferred (`agree-and-ticket`). One PR for all of a run's fixes is deliberate: ten nits are not ten layers. When the stack is a registered GitHub Stack, the new PR is linked in by re-listing every layer (ADR-0006, ADR-0007), or it sits outside the atomic merge.

**`code-review-in-stack`'s *fix in this PR* disposition is restricted to a PR that is not in a stack.** In a stack the same local, decision-free fix is *fix in a PR on the tip*. The *fix in a child PR* disposition is gone; there is no child a fix may go into other than a new one on the tip.

## Consequences

- **Every published ref stays where it was.** Nothing in either skill needs a force-push, a restack, or a permission to rewrite, and a stack under review can be merged at any moment without anyone's fix being half-applied.
- **The reviewer is told where the answer went.** A reply that says "fixed in #392 on the tip, tracked in #391" costs the reviewer one click; a fix they cannot find in the PR they commented on costs them a second review.
- **The tip moves forward with each run.** A stack that receives three rounds of review grows three fix PRs on top. That is the visible cost, and it is the one the operator can see and squash, unlike nineteen invisible restacks.
- **A fix is written against the tip's tree, not the layer's.** Where a later layer rewrote the lines the comment marked (*changed but not addressed*), the fix has to be made where the code now is; the sweep's conflict-hazard line is what tells the fixer so.
- **A PR with no parent and no child is untouched by any of this.** Both skills behave as they did: the fix goes in the PR.
