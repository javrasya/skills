# ADR-0007: Every branch a `gh stack link` call names has its local ref mirrored from origin first

## Status

Accepted — 2026-09-03. Amends one clause of ADR-0006 — "**A `link` failure never fails a publish, and only exit 9 latches**" — by splitting its "transient" case in two. Everything else in ADR-0006 stands.

## Context

ADR-0003 and ADR-0006 rest on `gh stack link` being safe to call from a parallel run because it "pushes without force". True, and incomplete: `link` pushes **every branch it is given, by local ref name, in one atomic push**. A branch whose local ref is behind or diverged from origin is rejected non-fast-forward, the atomic push fails as a whole, and no stack is registered.

For the branches the lane publishes this cannot happen: `update-ref` then a push that creates the ref leaves local and origin equal, and publish-once (ADR-0005) keeps them equal. **Layer 0 is the exception.** It is the one branch the run inherits rather than creates — it reached origin before the run — and nothing checked its local ref. An observed run (spec #742) inherited `ticket/736` with a local ref an earlier run had left five commits down a rewritten line; every `link` in the lane died with `! [rejected] ticket/736 -> ticket/736 (non-fast-forward)`, exit 1. Exit 1 is not exit 9, so each publish reported `stack_link: "failed"`, the script logged it as transient — "next publish retries" — and the run finished with three correctly chained PRs and no stack object, its own "a `link` failure never fails a publish" rule having hidden the bug. The brief then reported "not registered — the stack never reached two layers", which was false.

Two things were wrong, not one: the inherited ref was never mirrored, and a deterministic failure was classified as weather.

## Decision

**Every `link` call mirrors origin into the local ref of every branch it names, other than the one being published, before it runs.** That is the layer-0 step (its own branch), the lane (the layers below), and finalize (every layer). The rule lives in one `mirror()` helper the three prompts share. Mirroring is `git update-ref refs/heads/<b> origin/<b>` when the two differ — never a push, never a merge. It is safe by publish-once: a published layer is never rewritten by a run, so origin is authoritative for it and a differing local ref can only be a stale shadow (an earlier run's leftover, or origin moved by the operator under an inherited branch). The sha moved off is named in the agent's note; its commits stay in the object store.

**The one branch the mirror will not move is one a worktree has checked out.** Moving a ref under a checkout is not the run's to do (the user's own checkout may sit on layer 0). The agent leaves it, names it, and lets the link fail — loudly, per the next clause.

**A push rejected non-fast-forward is its own outcome, `stack_link: "rejected"`, and is never called transient.** It does not latch — the next publish's mirror repairs the ref and its re-list repairs the stack — but the log line says `NOT REGISTERED` with the branch and both shas, the brief carries the last rejection, and finalize is told it is performing the first registration rather than a reconcile. "Transient" is reserved for what the next re-list can actually fix without anyone changing anything.

**The brief blames the layer count only when the layer count is the reason.** With two or more layers and no successful link, `stack_registration` reads `NOT REGISTERED IN THE LANE` and names the last failure.

## Considered

- **Mirror layer 0 once, at setup, and nothing else.** The hand-fix applied on the day. Necessary, not sufficient: an inherited branch can move on origin during the run, and the link that then dies is in the lane, not in setup. Mirroring at every call is one `rev-parse` per layer.
- **Fail the publish on a rejected link.** Rejected with ADR-0006's reasoning: the PR is the real output and the stack map is presentation. Stalling every downstream ticket over a map would cost more than the map is worth.
- **Latch a rejection like exit 9.** Wrong: unlike a disabled API, a stale ref is repaired by the next mirror, so later layers would be left unregistered for no reason.
- **Have the rejected publish retry the link after mirroring.** Redundant once every call mirrors first; the retry would only ever fire on the worktree-held case, where it would fail again.

## Consequences

- `gh stack link` is now called only after the run has made "pushes without force" true in the sense that matters: the push is a no-op for every branch but the new one.
- An inherited layer 0 is the only branch the run ever moves a local ref for that it did not create. That is a deliberate exception to "the run leaves inherited refs alone", and it is bounded: `update-ref` to origin's own sha, never anywhere else.
- Local-only commits on a stale layer-0 ref become unreachable by name. The note names the sha; recovering them is the operator's call, and the alternative — a run that silently registers nothing — was worse.
