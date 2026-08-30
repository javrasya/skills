# ADR-0005: The shared clone is the handoff medium; a branch reaches origin once, and that push creates it

## Status

Accepted — 2026-08-30. Strengthens the publish-once invariant of ADR-0003, which stands otherwise: the serial lane, the stack shape, `gh stack link`, and the integration PR are unchanged.

## Context

ADR-0003 established publish-once as *all history rewriting happens before a branch becomes a PR*. Under it, implement and gate agents pushed the ticket branch to origin after every slice, and the serial lane — which rebases a ticket onto a stack tip that may have moved since the ticket was cut — finished with `git push --force-with-lease`. The rewrite was safe by the run's own bookkeeping: the branch had no PR, and nothing was based on it yet.

Two independent failures showed the arrangement was wrong regardless of whether it was safe.

**A safety classifier blocked the publish agent**, correctly by its own lights: no user message named that force-push and that target, and the justification — "nothing is based on it" — is a property of the whole run that a sub-agent's transcript cannot show. Since the workflow generates its own prompts, no user message ever will. Every ticket whose tip moves before it reaches the lane hits the same wall, in a skill whose premise is running unattended.

**Origin was never needed as the handoff medium.** Agent worktrees are *linked* worktrees of one clone: `git rev-parse --git-common-dir` resolves to the same `.git` for all of them, and the stash stack is shared. Commits made by one agent are reachable by ref name from every other the instant they land. The pushing existed to serve a premise stated in the code — *local branch state in a throwaway worktree is meaningless* — that was simply false for this harness.

Worse, routing through origin **also broke the local handoff it was meant to replace**. Git refuses to check out a branch another worktree holds, and this run's worktrees outlive their agents (34 were still alive in an observed run, cleaned only by a finalize step that run never reached). So `git checkout -B ticket/227 origin/ticket/227` failed for later slices, and the agents invented names instead: `slice1/227`, `ticket-227-slice2`, `slice3-225`, `fix/226-gate`, `review-fix/227`. In that run, local `ticket/227` and `origin/ticket/227` diverged — one agent's commit was stranded on an unpublished ref while a later agent redid the same work under a different sha.

## Decision

**The shared clone is the handoff medium.** Implement slices, gate fixers and review fixers commit locally and push nothing. A ticket branch reaches origin exactly once, when the serial lane publishes it, and that push **creates** the ref. There is no force-push anywhere in the run, and nothing for an operator to authorize.

**Refs are split by provenance, not by locality.** A ref *this run created* is authoritative locally and may not exist on origin at all. A ref the run *inherited* — the base branch, prior work on a start ref — is authoritative on origin, where the operator or another machine may have moved it, so it is fetched and addressed there. One helper decides which, from a set the run adds to as it creates refs.

**No agent ever checks out a branch.** Agents start from `git switch --detach <ref>` and move the branch with `git update-ref refs/heads/<branch> HEAD`, which succeeds exactly where `git checkout` and `git branch -f` are refused. This makes the run immune to its own leftover worktrees rather than dependent on cleaning them up in time.

**A git refusal is a stop, not an obstacle to route around.** Agents are told never to invent a branch name in response, because a run scattered across improvised refs is worse than a run that halted — that is the failure mode already paid for.

**Publish-once is restated at full strength:** *a branch reaches origin exactly once, and the push that puts it there creates it.* Not "we only rewrite refs nothing depends on" — no ref on origin is rewritten at all.

## Consequences

- **The force-push is gone, so there is nothing to authorize.** Anyone can run the skill unattended without granting a destructive git permission, which is the outcome an allowlist could not deliver: it would have fixed one operator's session while leaving the hazard and the classifier's objection both standing.
- **In-flight work is invisible until it publishes.** Previously a dead run left pushed branches anyone could inspect; now its commits live in the operator's clone alone. The run's summary therefore names the refs that never reached origin, so a dead run is recoverable rather than merely intact.
- **The single-clone assumption becomes load-bearing.** It was already true — every agent is handed the same absolute checkout path — but a harness that isolated agents by cloning rather than by linked worktree would now break the handoff outright instead of merely slowing it. That is the trade, stated rather than assumed.
- **Leftover worktrees stop mattering for correctness.** They still cost disk and are still pruned at finalize, but no agent needs a branch name freed in order to work.
- **`--force-with-lease`'s safety check is no longer available**, and no longer needed: nothing is being overwritten for it to guard. A rejected push now means something genuinely unexpected, so it is a stop-and-report rather than a thing to retry harder.
