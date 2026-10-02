# ADR-0023: Prior work is named by the operator at arm time, never found by an agent

## Status

Accepted — 2026-10-02. Amends ADR-0003's "Prior work on a branch becomes layer 0": the layer stays, who chooses it changes.

## Context

ADR-0003 made prior work the stack's layer 0 and left finding it to the workflow's graph agent: its schema had a `start_ref`, and its brief said "if a branch exists whose commits are for this spec, return that branch". The operator's form (`crew start`, SKILL.md step 2) asked for the base branch and said prior work was *not* that value — the discovery agent would find it.

Spec #827, 2026-10-01, is what that produces. A first run published `ticket/1199`, a branch of prior work, as layer 0 (PR 1217). Its whole-stack review then fixed that one-layer stack on `spec/827-integration`, the review's fix branch, and the run ended before the integration PR was opened. The operator closed PR 1217 and armed again. The new run's graph agent found a local `spec/827-integration` carrying spec work, returned it as `start_ref`, and the run opened PR 1218 on it as "pre-existing work". It then dispatched, implemented and gated #1199 — whose work was the first two commits of that branch — and the implementer, finding everything done, moved `ticket/1199` onto the tip. The publisher could open no PR ("No commits between") and halted the run. Its push also fast-forwarded `origin/ticket/1199`, which PR 1217 had left on origin, from PR 1217's head to the tip: a published ref moved, without force, because the publish step assumed its push *creates* the branch.

Four agents and an hour spent on a ticket that was done, a layer-0 PR the operator never chose, and a published ref rewritten. The operator's words: the workflow "does not respect what is selected on the interactive UI when starting the run."

## Decision

**Prior work is an input of the run, given by the operator when it is armed, like the base branch, the stack mode and the run order. No agent of the run chooses it, looks for it, or proposes it.**

- **`crew start` gets a Prior work row**, `--start-ref <branch>`, after Base branch. Its default is none, spelled as the base branch itself; every other branch of the checkout is offered, a `spec/<n>-integration` branch marked as a run's review fixes. It is never remembered between starts: prior work is a fact about this run. Flag-only use may leave it out, which is none. The skill's non-crew path asks the operator the same question (SKILL.md step 1) and renders the answer.
- **The template takes `__START_REF__`** beside `__BASE_REF__`; `hasLayer0` is `START_REF !== BASE_REF`. The graph schema loses `start_ref`, and the graph brief says, when there is no prior work, not to look for any: "which branch the stack starts on is the operator's call, made when the run was armed, never yours."
- **When prior work is named, the graph agent says which tickets it already finishes.** Each ticket carries `done_in_prior_work` and `prior_work_evidence`, judged against `base..start_ref` with the commits and diffs, never titles alone, and only when every criterion is met. Such a ticket is **subsumed**: it gets no agent, blocks nothing, is outside the planned layer count, and the layer-0 PR body carries its `Closes #<n>` with the evidence. If every automatable ticket is subsumed the run returns an error naming the way out instead of opening a stack of nothing.
- **A publisher whose branch adds nothing to the tip reports `nothing_to_publish`** (`git rev-list --count <base>..<branch>` is 0) instead of failing or asking. The script records the ticket subsumed: the tip stays, dependants go on, the run is not halted, and finalize lists the ticket as still open, since no PR closes it; `complete` is false.
- **The lane checks origin before its one push.** `git ls-remote --exit-code --heads origin <branch>` finding the branch already there is a stop and a decision for the operator — the branch is an earlier run's, and this run may not move it, not even fast-forward. Publish-once (ADR-0005) now has a check, not an assumption.

## Consequences

- **The form asks one more question.** Enter through it keeps the default, none, so an operator with no prior work pays one keystroke. Scripts rendered before this ADR have no `__START_REF__` and still run: the placeholder is only in the template.
- **Prior work can no longer be discovered by accident**, and can no longer be discovered at all: an operator who forgets a branch gets a stack that redoes its work, which is visible, instead of a stack built on a branch nobody chose, which was not. The row listing every branch is the reminder.
- **A re-arm after an aborted run needs the operator to know what the run left**: an integration branch with no PR is review fixes on top of the old tip, not a ticket's work. The form marks it; CONTEXT.md and the skill say what it is.
- **The graph agent reads more when prior work is named** — the log and diffs of `base..start_ref` — and that cost buys the agents it saves per subsumed ticket. With no prior work it reads nothing extra.
- **A subsumed-at-publish ticket is a smell, not an error**: the graph agent should have caught it when prior work was named, and with no prior work it means the base already held the work. Either way the brief names it and the operator closes the ticket by hand.
