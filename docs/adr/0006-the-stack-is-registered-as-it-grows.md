# ADR-0006: The stack is registered as it grows, not at finalize

## Status

Accepted — 2026-09-01. Supersedes one clause of ADR-0003 — "**The stack is registered once, at finalize**". Everything else in ADR-0003 stands: `gh stack link` is still the only `gh stack` command the run uses, the rest of the extension is still banned, the serial lane, publish-once, the integration PR and the arm-time availability gate are unchanged.

## Context

Under ADR-0003 the run published a draft PR per ticket as each one landed, but registered them as a **Stack** object only in the Finalize step. So for the whole length of a run the operator saw a scatter of draft PRs with no stack map and no way to tell how many more were coming — the stack, as a thing they could look at, existed only after the run was over. The operator asked for the opposite: the stack visible as early as possible, growing as tickets land, with a clear signal that it is not finished.

Reading `gh stack link --help` (extension v0.1.0) settled the mechanics:

- **It grows an existing stack.** "If some of the PRs are already in a stack, the existing stack is updated to include the new PRs (existing PRs are never removed)." So repeated calls reconcile rather than replace.
- **It takes a minimum of two arguments.** `link <stack-number | branch-or-pr> <branch-or-pr> [...]`. A one-layer stack cannot be registered at all.
- **It has a shortcut that carries state.** Passing a stack number as the first argument appends to that stack without re-listing it.
- **It opens PRs for branches that lack them.** "For branches without PRs, new PRs are created automatically with the correct base branch chaining."
- **`--open` marks PRs ready for review.**

## Decision

**The publish agent registers the stack, in the lane, immediately after opening its draft PR.** The lane is the only place this can happen: two concurrent `gh stack link` calls against one stack is exactly the race the lane exists to prevent, and the lane already runs one agent at a time with the full stack in its prompt.

**Every call re-lists the whole stack bottom-to-top; the stack-number shortcut is banned.** The shortcut would make the run discover a stack number and carry it between agents — the class of remembered state this design has kept out everywhere else (the tip is derived from GitHub every time, never remembered, because a stale one silently corrupts the run's output). Re-listing needs no number, no state, and no ordering assumption, and it makes every call a repair of every call before it. The cost is a quadratic argument count, which is nothing at spec scale.

**Registration starts at the second layer.** A run with a layer-0 PR registers at its first ticket; a run without one registers at its second. A single-ticket spec never registers, and the brief reports that as the correct outcome rather than as a failure.

**Only branches whose PR this run has just opened may be named in a `link` call, and `--open` is never passed.** Both follow from the help text: naming a bare branch would have `link` open a PR outside the run's control, and `--open` would ready the drafts, destroying the in-progress signal below.

**Each PR body opens with `Layer k of N planned`.** `N` is layer 0 plus the automatable tickets, known before the first PR is opened. `k` is the **actual** position in the stack, not the ticket's index in the plan — so the map's fourth box says "layer 4", and a run that lost three tickets ends on "Layer 4 of 7 planned", announcing its own shortfall. The word *planned* is load-bearing: tickets fail and get deferred, and a stack that lands short must read as short rather than broken. The line is written once at creation and never edited. The integration PR carries no index, because whether it exists at all is unknown until the whole-stack review returns; it says it is the integration layer on top of N planned layers.

**Drafts remain the completion signal.** Every layer stays draft until Finalize readies them, so "all draft, layer 3 of 7" reads unambiguously as in-flight and Finalize's ready-flip is what says the run is done adding.

**A `link` failure never fails a publish, and only exit 9 latches.** A transient failure (rate limit, 5xx) is deliberately left alone: the next publish re-lists the whole stack and repairs it for free, so retrying in place would burn a call per layer for something one call already fixes. A hard **exit 9** — the stacks API disabled mid-run — sets a flag, and no later publish spends a call on it.

**Finalize keeps its `link` call as the reconciler.** It is no longer the first registration. It exists to pick up the integration PR, which publishes outside the lane so nothing there ever links it, and to repair any in-lane call that failed.

## Consequences

- **The operator gets a stack map from the second PR onward.** The stated goal. The per-publish log line carries the state alongside it — `stacked #12 → <url> — 3/7 (stack registered)`, or `(stack: not yet — needs 2 layers)`, or `(stack: unregistered — link failed, next publish retries)`.
- **A run can now lose native mode mid-flight, with nobody to ask.** ADR-0003 gates availability at arm time and insists the fallback to a plain chain is never silent. That gate cannot cover stacks being disabled *after* arming, and the run is unattended. The choice taken is to **degrade and report loudly** rather than stop: the completed, gated, publishable ticket work is worth more than the stack map. "Loudly" is what keeps faith with ADR-0003 — the brief's `mode` becomes `chain (degraded mid-run from native)`, `stack_registration` states what was lost in its own field, and `merge_how` switches to the bottom-up-by-hand instructions. Stopping the run over a presentation layer was rejected.
- **`link` is called once per published layer instead of once per run.** Bounded by the ticket count and each one cheap; the alternative bought nothing but a smaller call count.
- **Two constraints are now one ordering slip from breaking.** "Only link branches whose PR already exists" and "never pass `--open`" were true by construction when registration happened once, after everything. They now live inside the publish prompt as explicit rules, because a lane that links mid-run can violate either.
- **`implement-all` is untouched.** It builds a base-chain and registers no stack at all; giving it one would change how its operator merges, not just what they see. That is a separate decision.
