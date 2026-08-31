---
name: code-review-in-stack
description: >-
  Review one PR of a stack against its own ticket's acceptance criteria, sweep the rest of the
  stack before recommending any work, and give every gap a disposition. Takes a PR id.
  Suggests; never edits code, never posts or files without approval.
disable-model-invocation: true
---

# Code review in stack

Review **one slice** — a single PR of a stack — against the ticket it claims to close, then
dispose of every gap. The verdict axis is the ticket's own acceptance criteria, not taste: a
slice is done when its criteria are met, and a criterion is met when an artifact proves it.

Two things make this different from a plain diff review. A slice sits in a **stack**, so a gap
may already be closed by a later layer, and recommending work without looking is how two agents
do one job twice. And a slice has a **boundary**, so a gap that needs a decision or crosses
layers is handed forward as a ticket rather than smuggled into the PR under review.

Invoke with a PR id: `/code-review-in-stack 253`.

## Hard rules

- **Edit no code.** This skill produces a review and, on approval, a ticket. A fix is described,
  never applied.
- **Publish nothing without approval.** Posting the review to the PR, filing a ticket, and
  editing a ticket's criteria each wait for explicit approval of that specific action.
- **Every criterion gets a verdict.** Report the tally ("11 of 12 met") and account for each one.
  A criterion you could not check is its own verdict, named as such.
- **The ticket's scope wins.** Where an ADR, a design doc, or a code comment implies work the
  ticket does not ask for, the ticket governs the verdict and the surplus becomes a suggestion.

## Process

### 1. Pin the slice

Resolve the PR id to: head sha, base ref, the ticket it claims (`Closes #N`, or the ticket
named in the title/body), and the parent spec. Fetch the ticket and the spec through the repo's
issue-tracker workflow (`docs/agents/issue-tracker.md`).

Then pin the slice's **place in the stack**: which branch it is based on, which branches are
based on it, and the sibling branches of the same spec. Remote-tracking refs are enough
(`git branch -r`, `git merge-base --is-ancestor`); note it when `gh` or `fetch` fails so the
report says how fresh its facts are.

No ticket, no criteria, no review: ask the user for the ticket before going further.

### 2. Prove the head green

Check the PR head out clean (a worktree, never the user's working copy) and run the repo's own
gate. Record the numbers in the report. A red head is the first finding and it outranks every
criterion verdict, because a criterion "met" on a red build is unproven.

### 3. One verdict per criterion

Walk the criteria in order. Each verdict names its evidence: the test that pins the rule, the
symbol that implements it, the fixture that no longer needs its workaround. A plausibility
argument is not evidence, and neither is a doc comment claiming the behaviour.

Read each criterion for its **escape hatch** — a clause that hands part of the work forward
("assert at the primitive if #205 keeps compile from seeing the case, and say so in the test's
own doc"). A criterion carrying one is met by taking it, and taking it is the evidence. This is
where inference from an absolute claim in an ADR most often contradicts the ticket; the ticket
governs.

Also check the claims the PR body makes about itself, `Closes #N` first. A slice claiming to
close a ticket whose criteria are not all met is a finding of its own.

### 4. Sweep the stack before recommending anything

For every gap, look for it in the rest of the stack **before** costing a fix. Search the later
layers and the sibling branches for the construct the gap is made of — the `None` that should
be a value, the missing call, the absent test — and count it per branch rather than reading the
prose around it. A comment can move, be reworded, or be folded into a helper while the behaviour
survives untouched; behaviour is what the sweep counts.

Three outcomes, and each changes the recommendation:

- **Closed downstream.** Name the branch or PR that closes it. Recommend nothing; the gap is a
  note in the report so the next reviewer does not re-find it.
- **Open through the tip.** Say so with the evidence ("all four sites unchanged from layer 1 to
  layer 15"), which is what makes the disposition in step 5 defensible.
- **Touched but not closed.** A side branch rewrites the same lines cosmetically. Report it as a
  conflict hazard: whichever of the two lands second takes the conflict.

### 5. Dispose of every gap

Each gap gets exactly one disposition, and each carries what to do next:

- **Fix in this PR** — the fix is local to files this slice already touches, needs no decision,
  and adds no criterion. Say which symbol changes and which test pins it.
- **Fix in a child PR** — the fix is mechanical but wider than the slice, or the stack makes an
  edit at this head expensive. Name the base to branch from and the base to target.
- **Hand forward as a ticket** — the fix needs a human decision, crosses layers, or widens the
  slice past its criteria. Draft the ticket in step 6.
- **No work** — met, or closed downstream, or out of scope by the ticket's own words.

Two questions size it. Does closing the gap require a decision nobody has made? Then it is a
ticket, whatever its diff size. Does closing it here move a branch other layers are built on?
Then the mechanics belong in the report, not in a footnote.

**Say what the gap does and does not break.** A criterion can be unmet while the ticket's
headline property holds — an id that stays `null` still serialises deterministically, so the
fingerprint is stable and only the diagnostics go blind. Stating both halves is what keeps a
diagnostic-only gap from blocking a slice, and what keeps a byte-moving gap from being waved
through.

### 6. Draft what you recommend

For every **ticket** disposition, draft the issue and show it before filing: what is wrong and
where, why it is still owed, what is already settled, the decisions a human still owes, the
acceptance criteria, and the coordination hazard from step 4. State plainly that it does not
block the slice under review when it does not.

For every **fix in this PR** disposition, write the change as instructions, not as a patch.

Where a criterion needs amending — a half delivered, a half handed forward — propose the exact
new wording and let the user rule.

### 7. Report

One report, in this order: the gate result, the criteria tally, then one block per gap carrying
its verdict, its evidence, its sweep result, its disposition, and its severity. Put the blocking
question last if you have one.

Then ask, per action, before posting the review, filing a ticket, or editing a criterion.

## The standards axis

This skill owns the criteria-and-stack axis only. When the user also wants the diff judged
against the repo's conventions, invoke the `code-review` skill for that axis and report the two
side by side without merging them: a slice can meet every criterion and still read badly, and
one axis masking the other is what keeping them apart prevents.

## Traps

- **A code comment citing the wrong ticket.** A `None` filed under a ticket whose scope cannot
  cover it reads as tracked work and is not tracked at all. Check that the cited ticket's scope
  actually contains the gap; when it does not, the mis-citation is itself a finding.
- **An ADR's absolute claim.** "There is no site at which this cannot be derived" is a decision,
  not a scope. It tells you the gap is real; the ticket tells you whose slice owns it.
- **Grepping prose instead of behaviour.** A refactor that folds four literals into one helper
  changes every string you searched for and none of the behaviour. Count the behaviour.
- **A stale account or ref.** A failing `gh` call and a stale remote-tracking ref both produce
  confident wrong answers about the stack. Say which facts came from a fetch that worked.
