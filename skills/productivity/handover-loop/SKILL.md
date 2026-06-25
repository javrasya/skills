---
name: handover-loop
description: Delegate a code-changing task to a fresh subagent, then adversarially review the result on the main agent and loop — re-delegating to a new fresh subagent each round until the review comes back clean. Use when the user says "/handover-loop <task>", wants delegated work hardened by rounds of adversarial review, or wants a fix/implementation handed off and checked until it holds up. For pure investigation/research tasks that produce no code changes, use the plain `handover` skill instead — there is nothing to review, so no loop.
---

# Handover Loop

Wraps the `handover` skill in an adversarial review loop. Each round: a fresh subagent does the work, then the main agent tears the result apart looking for what is broken, faked, or unfinished. If the review finds real remaining work, a new fresh subagent takes another pass. The loop ends the moment a review comes back clean — often round 1.

Why a fresh subagent each round: an agent that just spent its whole context arguing a solution into existence is the worst possible reviewer of that solution. Every new round of work starts in an unpolluted context instead of one already committed to the first approach.

Why the review runs on the main agent: it reviews with cold eyes (it did not write the code, so it has nothing to defend) and — crucially — it holds the full conversation, not just the trimmed handoff doc the subagent worked from. Intent that was discussed but never made it into the handoff is exactly what a subagent working from a narrower brief will miss. The main agent is the only party that can catch that gap, because it remembers what the doc left out.

## Step 0: Should this even loop?

Classify the task before touching anything.

**Investigation / research** — the deliverable is knowledge, not a diff. "Find out why X happens", "where is Y handled", "audit Z", "explain how W works". Invoke the `handover` skill once, report, done. There is nothing to adversarially review: a finding either answers the question or it does not, and that is a conversation, not a review loop.

**Change-producing** — the deliverable is a diff. "Fix the crash", "implement X", "troubleshoot and resolve Y", "refactor Z". This is where the loop earns its keep: these are exactly the tasks where a subagent declares victory while leaving a fallback, a half-fix, a weakened test, or a broken edge case behind.

If genuinely ambiguous ("diagnose the deadlock" — diagnose only, or diagnose and fix?), ask the user one short question rather than guessing. Never loop on something that produced no diff — there is nothing to review.

## The loop

### Round N — delegate
Invoke the `handover` skill with the task for this round.
- Round 1: the original task, verbatim. Do not pre-solve or trim it.
- Round 2+: the remaining work the previous review surfaced, framed as its own task — see "Re-delegating" below.

The `handover` skill owns the handoff doc, the spawn, and reading the subagent's conclusions. Let it. The main agent does not start the work itself.

### Round N — adversarially review (on the main agent)
The subagent reported "done." Treat that as a claim to disprove, not a fact to accept. You are well placed to do this: you did not write the code, so you owe it no loyalty.

Read the actual diff, not the subagent's prose about the diff (commands below assume git; use your VCS equivalent):
```
git diff            # working-tree changes
git diff <base>     # the round's changes against where it started
```

Then attack it:
- **Does it do what the task asked?** Map each requirement to a concrete changed line. A requirement with no line behind it is unfinished, no matter what the summary says.
- **Intent the handoff doc dropped.** You remember constraints, decisions, and "by the way also" asks from the conversation that may never have reached the handoff doc. Check the diff against what was actually discussed, not just what was written down — a subagent cannot satisfy a requirement it never received.
- **Fake done.** Stubs, `TODO`, `pass`, commented-out assertions, tests loosened until they pass, a "fix" that only mutes the symptom while the cause survives.
- **Fallbacks and hacks.** Check against the project's own conventions (its `CLAUDE.md`, `AGENTS.md`, or contributing guide, if present). A silent fallback, a grace-period shim, or a defensive default that papers over the real problem is usually a finding, not a solution — flag it against whatever the project actually forbids.
- **Edge cases and regressions.** What input breaks it? What did this change rename, move, or delete that something else depended on?
- **Verified, not asserted.** If the subagent says tests pass, confirm the command ran and the output exists. "Should work" is not evidence — run it.

Produce a short verdict: either **CLEAN**, or a concrete list of remaining problems, each specific enough to seed the next round.

### Decide
- **Clean** → stop. Report to the user. **Do not manufacture work to justify another round.** Terminating on round 1 is the success case, not a shortcut you skipped — a clean first pass means the handoff was good.
- **Real remaining problems** → go to Round N+1.
- **The same problem surviving multiple rounds, or churn without convergence** → stop and bring it to the user. Past roughly 3–4 rounds the bottleneck is usually an underspecified task or a wrong approach, and that is a human decision, not another subagent.

### Re-delegating (Round 2+)
The next subagent is fresh and knows nothing. Its handover task must carry:
- The original goal, in one line.
- What the previous round actually changed — so it neither redoes nor silently undoes it.
- The review findings to address — the verdict list, verbatim.
- What the review confirmed is correct and must NOT be touched.

Context has meaningfully evolved (the review found issues), so let the `handover` skill write a fresh handoff doc for this round rather than reusing an earlier one.

## Report to user
When the loop ends, state: how many rounds ran, what each round fixed, what the final review confirmed, and any follow-up the loop deliberately left to a human. If it stopped on the round cap rather than a clean verdict, say so plainly — do not dress up a non-converging loop as a finished one.

## Checklist
- [ ] Step 0: task classified; investigation → plain `handover`, no loop
- [ ] Round task delegated via the `handover` skill, not executed on the main agent
- [ ] Adversarial review read the real diff, not the subagent's summary
- [ ] Each requirement mapped to changed lines; fallbacks / hacks / fake-done hunted; "tests pass" re-run not trusted
- [ ] Verdict produced: CLEAN or a concrete remaining-work list
- [ ] Clean verdict → stopped without inventing new work
- [ ] Round 2+ handoff carried original goal + prior changes + verbatim findings + do-not-touch list
- [ ] Stopped and escalated to the user on non-convergence or past the round cap
- [ ] Final report: rounds, fixes per round, final verdict, leftover follow-up
