---
name: pull-spiderman
description: >-
  Use when the user wants to triage and answer the review comments on a pull request —
  triggers include "/pull-spiderman <PR>", "review the comments on this PR", "answer the
  review on this PR", "go through the PR review comments", "triage the review on PR N". Works
  for review comments left by any reviewer — an agent (Copilot, Claude, etc.) or a human. When
  the PR is one layer of a stack, it sweeps the layers above before judging any comment, never
  edits the layer, and lands agreed fixes as one PR on the stack's tip. It vets each comment
  with adversarial double-challenge and posts NOTHING (no reply, no resolve, no code fix, no
  ticket) without per-comment human approval.
---

# Pull Spiderman

Drive a PR's review comments to a vetted decision and a reply. A reviewer makes a claim; we
adversarially challenge it twice (once in a subagent, once on the main agent with full
conversation context) before deciding whether it is right — two Spider-Men pointing until one
claim is confirmed. Every reply, resolve, and code fix is gated behind explicit per-comment
user approval. The reviewer may be a bot or a human; the skill treats them the same.

A PR that is one **layer of a stack** gets one more pass before any verdict: the layers above
it may already do what the reviewer asks, and a layer that has been published is never edited
(ADR-0010). So in a stack the skill **sweeps** every comment through the later layers first,
answers what they already answer, and lands every fix it does agree to as **one PR on the tip**,
tracked by **one ticket**. A PR with no parent and no child is not in a stack, and the skill
behaves exactly as it always has.

## Hard rules — do not violate

- **Post nothing without approval.** No `gh` reply, no thread resolve, no ticket, no PR, and no
  code-fix write/commit happens until the user approves *that specific comment* in
  AskUserQuestion — and the ticket and fix PR each get their own approval. "Do not comment yet"
  governs the whole skill.
- **Use the companion skills/tools for each step, don't inline your own analysis.** Use the
  `handover` skill for delegation, the `challenge` skill for the adversarial passes, the
  `stack-sweep` skill for the stack map and the sweep, and the `handover-loop` skill for fixes.
  Sequence them; do not replace them with ad-hoc reasoning.
- **Scope filter is mandatory:** only comments whose review thread is unresolved AND not
  already replied-to by the current `gh` user. By default every reviewer is in scope (human and
  bot); pass `--author <login>` to `scripts/fetch-comments.sh` to narrow to one reviewer.
  The script enforces the filter. Log what it skipped.
- **Fixes are gated like replies.** A code fix is *proposed* by the `handover-loop` skill; it is not
  committed until approved in the same per-comment gate.
- **A layer of a stack is never edited.** When the PR has a parent or a child, no fix is
  committed to its branch. Agreed fixes go to one new PR based on the stack's tip, and the
  reply on the original comment says so. The tip itself is a layer: a comment on the tip still
  gets a PR on top of it.

## Reply voice — how every posted reply must read

The reply body posted to the PR is short, plain, and blunt-but-not-rude — concise and easy to
parse. Use the `caveman` skill's compression style for the posted reply. (This is the default
voice; adapt to the user's stated preference.) This applies ONLY to the text posted on the PR —
the AskUserQuestion explanation to the user stays in normal, clear prose.

Rules for the posted reply:

- **Caveman style, always — no reminding needed.** Drop articles (a/the), filler (just, really,
  basically, simply, I think, perhaps, it seems), and hedging. Fragments are fine.
- **Simple English. No fancy words.** Small words, short sentences. Any reader should parse it
  instantly. "Wrong field name" not "The field identifier appears to be incorrect." Before
  posting, scan the reply for any word a non-native English reader would stumble on and swap it
  for a plain one. Examples of words to avoid → use instead:
  - vestigial / superfluous → unused, leftover
  - remediation → fix
  - harden → make safe
  - surface (verb) → show
  - leverage → use
  - erroneous → wrong
  - sufficient → enough
  If unsure whether a word is plain, it isn't — pick the simpler one. Technical terms that are
  exact (identifiers, type names, protocol names) stay; fancy *English* goes.
- **Keep the three things that make a review useful:** what is wrong, why / proof, what to do.
  Caveman trims connective tissue, never the substance.
- **Lead with the verdict.** "Agree.", "Disagree.", "Real bug.", "Dead code." — first word.
- **Length cap: ~3 short sentences.** If longer, cut, don't polish.
- **Politeness floor (do not cross into curt/rude).** It is a colleague's PR, permanent and public.
  No insults, no "obviously", no dismissiveness. Blunt about the *code* is fine; blunt about the
  *person* is not. "Disagree — branch is dead" good; "no, just delete this" curt.
- Keep `code identifiers`, file paths, and issue refs exact (caveman never mangles those).

Example (good): `Agree — real bug. Count comes back 0 because the handler never increments it. Use the row count instead.`
Too bloated: `I think this is a real bug. Since the handler never actually increments the counter, the value will always be 0, so we should probably use the row count instead.`

Stack-mode examples, one per verdict that points somewhere:
- `agree-addressed-downstream`: `Agree. Already fixed in #373 — \`wrap_total\` at retriever.rs:33. Nothing to change here.`
- `agree-and-ticket`: `Agree — wrong field. Tracked in #391; fix lands in a PR on top of the stack, not in this layer.`
- `agree-and-fix`: `Agree — real bug. Fixed in #392 (on the stack tip), tracked in #391. This layer stays as is.`

## Workflow

### 1. Resolve the PR and fetch in-scope comments
Get the PR number from the user's argument (number / URL / branch) or the current branch's PR.
Then:
```
scripts/fetch-comments.sh <pr>                 # all reviewers in scope
scripts/fetch-comments.sh <pr> --author Copilot  # narrow to one reviewer
```
It returns a JSON array of in-scope review comments (`comment_id`, `thread_id`, `path`, `line`,
`diff_hunk`, `body`, `html_url`, `author`) and logs skipped threads to stderr. If the array is
empty, report that nothing is in scope and stop.

### 2. Pin the stack
Run the `stack-sweep` skill's step 1 (`stack-map.sh <pr>`, from inside a clone of the repo).
Three facts from it steer the rest of the run:

- **`in_stack: false`** — single-PR mode. Skip the stack parts of every later step; fixes may
  land in this PR as before.
- **`in_stack: true`** — stack mode. Note the `tip`, whether the stack is `registered`, and the
  `fetched` flag. Read the PR body for the spec it belongs to (a `Layer k of N planned — spec
  #S` line, or the parent of the ticket its `Closes #N` names); the ticket in step 5 becomes a
  sub-issue of that spec when there is one.
- **Similar threads.** Run `fetch-comments.sh` once per other layer in the map (parents and
  children, and any fork or sibling). Keep the results: step 4 matches them.

### 3. First `/handover` — gather, sweep, challenge (subagent)
Invoke the `handover` skill. The subagent's task: read each in-scope comment against the actual
code; in stack mode, hand each comment to the `stack-sweep` skill as a construct (the lines it
marks plus what the reviewer asks of them) and record the outcome — *addressed downstream*,
*unchanged through the tip*, or *changed but not addressed* — with the layer and evidence; then
run the `challenge` skill on each comment to stress whether the claim holds. It returns
structured findings — per comment: what the reviewer claims, what the code actually does, the
sweep outcome and its evidence, whether the claim is valid, a proposed response, and whether a
real code fix is warranted. The subagent writes its conclusions via `/handoff`; read that doc
when it returns.

A question or a disagreement is swept like a requested change: both name something the
reviewer expects the code to become. If a later layer makes that change, the comment is
addressed downstream and the reply points there. If no layer does, the comment stands and gets
the same verdict it would on a lone PR.

### 4. Adversarial re-challenge (main agent)
You hold the full conversation the handoff doc could not capture. For each finding, run the
`challenge` skill again against the subagent's decision — cold-eyes, looking for what it got wrong
or what intent it missed. Challenge the sweep too: an "addressed downstream" that rests on a
renamed string rather than on behaviour is the classic miss. Produce a final per-comment verdict:

- `agree-and-fix` — the claim holds, no layer above addresses it, and we fix it now.
- `agree-and-ticket` — stack mode only: the claim holds, no layer addresses it, the fix is owed
  but not done in this run. The ticket carries it.
- `agree-and-explain` — the claim holds and a reply settles it; no code changes.
- `agree-addressed-downstream` — stack mode only: the claim holds and layer `#N` already does
  what it asks. The reply points at that layer. No ticket, no fix.
- `disagree-with-reason`.

A *changed but not addressed* outcome does not change the verdict; it adds one sentence to the
reply naming what the later layer did instead, and a conflict-hazard line to the fix task.

Then match **similar threads** from step 2: same reviewer, same file, overlapping hunk lines,
and a body that asks the same thing — judged by you, not by a script. A match on a parent or a
child layer means the same reply is true there; record the matches per comment for the gate.

### 5. Stack mode only — draft the ticket
Every `agree-and-fix` and `agree-and-ticket` comment in stack mode is owed a fix that will not
land in the PR the reviewer commented on, so one **ticket** carries all of them: it is what makes
"will be fixed in a PR on the tip" a true sentence even if nobody fixes it today. Draft it per
the target repo's issue-tracker workflow (`docs/agents/issue-tracker.md`), as a sub-issue of the
spec found in step 2 when there is one:

- title: review fixes for `#<pr>` (`<layer head>`), one line;
- body: one bullet per comment — its `html_url`, the reviewer's ask in one line, the sweep
  outcome, and whether it is fixed in this run or deferred;
- acceptance: each bullet's fix present on the tip, pinned by a test where one applies;
- a line naming the tip it is to be based on and any conflict hazard the sweep found.

Show the draft and ask **one** approval to file it. File it before the fix loop starts, because
the fix branch is named for it (`ticket/<M>`) and the drafted replies name its number. If the
user declines, the fix branch is named `review-fix/<pr>` instead, and every `agree-and-fix` and
`agree-and-ticket` reply loses its ticket line and says so plainly ("not tracked yet").

### 6. Optional fix via the `handover-loop` skill — propose fixes
For comments whose verdict is `agree-and-fix`, delegate the fix via the `handover-loop` skill, not a
plain `/handover`. Each round a fresh subagent makes the fix and the main agent adversarially reviews
the real diff — stubs, fake-done, fallbacks, weakened tests, missed edge cases — looping with a new
subagent until the review comes back clean. This hardens the fix before a human ever sees it.

The loop produces the diff but does **not** commit it — per the hard rules the fix stays uncommitted
until approved in the per-comment gate (step 7). The loop task must say: produce the fix in the working
tree, do not commit; the per-comment gate owns the commit.

**Single-PR mode:** the fix is made on the PR's own branch, as before. Batch related `agree-and-fix`
comments into one loop where they touch the same code, so the adversarial review sees the whole
change at once; keep unrelated fixes in separate loops.

**Stack mode:** **all** `agree-and-fix` comments of this run go into **one** loop, on **one**
branch, in a **worktree** — never the user's working copy and never the layer's branch. The
branch is cut from `origin/<tip head>` and named for the ticket step 5 filed (`ticket/<M>`), so
the loop task states: base `origin/<tip>`, branch `ticket/<M>`, worktree path, do not push, do
not commit. The fix is written against the tip's tree, not the layer's — a *changed but not
addressed* outcome says exactly where those differ. One PR for all the fixes of one run is
deliberate: ten nits are not ten layers.

### 7. Per-comment human gate (AskUserQuestion — one comment at a time)
For each in-scope comment, ask a single, well-structured question containing:
- **Reviewer said:** the original comment, quoted (note the author).
- **The code:** `path:line` plus the `diff_hunk` (or a file excerpt) it points at.
- **In plain terms:** what the code does and what the reviewer's point means, explained for a
  reader who may not know this codebase's language — avoid unexplained jargon.
- **Stack:** (stack mode) the sweep outcome in one line, with the layer it names.
- **Our response:** the drafted reply (written in the **Reply voice** above — caveman, simple,
  ≤3 short sentences, politeness floor), and the proposed fix diff if any. In stack mode the
  reply names the artifact it points at: the layer (`#N`) for `agree-addressed-downstream`, the
  ticket (`#M`) for `agree-and-ticket`, the ticket and the fix PR for `agree-and-fix` — written
  as `<fix PR>` until step 8 opens it.
- **Similar threads:** (when any) the list of matched threads, one line each with PR number,
  path and line, so the user sees exactly which other PRs option 3 touches.

Options, in exactly this order (option 3 only when similar threads were matched):
1. **Post reply**
2. **Post reply and resolve**
3. **Post reply here and on the N similar threads** — the same reply on every matched thread.
   Resolving is not offered across PRs: a thread on a PR the user did not name is resolved by
   that PR's own pass.
4. **Skip reply**
5. **Explain more** — re-ask the *same* question with an expanded "In plain terms" section, then
   present these options again.

### 8. Act on the choice (`scripts/post-reply.sh`)
**Stack mode, once, after the last gate and before any reply that names it:** if at least one
`agree-and-fix` was approved, the **main agent** commits the loop's fix on `ticket/<M>` in the
worktree, pushes it (the push *creates* the branch on origin — publish-once, ADR-0005; there is
no force anywhere), and opens the PR with base `<tip head>` and `Closes #<M>` in the body. When
the stack is `registered`, link the new PR in: `git fetch origin`, mirror every layer's local ref
from origin (ADR-0007), then `gh stack link <every layer bottom-to-top> <new branch> --base
<trunk> --remote origin` — never `--open`, never the stack-number shortcut (ADR-0006). Substitute
the real number for `<fix PR>` in every approved reply. The new PR is now the tip.

Then, per approved comment, write the reply body to a temp file and:
- **Post reply** → `post-reply.sh <pr> <comment_id> <thread_id> <reply_file>`
- **Post reply and resolve** → add `--resolve`. **Single-PR mode:** if the verdict included an
  approved code fix, the `handover-loop` skill (step 6) already produced and hardened it in the
  working tree uncommitted; the **main agent** commits it now — only after the loop came back
  clean AND this comment was approved. The handover subagent never commits; that is the main
  agent's job here.
- **Post reply here and on the N similar threads** → `post-reply.sh` once per thread, each with
  its own PR number, comment id and thread id, no `--resolve`.
- **Skip reply** → record it, post nothing.

### 9. Final summary
A table: each comment → sweep outcome (stack mode) → final verdict → action taken (replied /
replied+resolved / replied on N threads / skipped) → link. Below it, in stack mode: the ticket
number, the fix PR number and its base, whether it was linked into the registered stack, and the
sweep's freshness line. State what the scope filter skipped and why.

## Common mistakes

- Posting, resolving, filing, or committing a fix before the user approved that comment.
- Replacing the `handover` skill, the `challenge` skill, or the `stack-sweep` skill with your
  own ad-hoc reasoning.
- Committing to a layer's branch because the fix was small. Small is not the test; having a
  parent or a child is.
- Calling a comment "addressed downstream" because a later layer renamed the string it mentions.
  The sweep counts behaviour.
- Opening one fix PR per comment in stack mode. One run, one ticket, one PR.
- Touching threads that are already resolved or already have your reply.
- Resolving a thread without posting a reply, or resolving a thread on a PR the user did not name.
- Leaving unexplained jargon in the plain-language explanation — the reader may not know this codebase's language.

## Checklist
- [ ] PR resolved; `fetch-comments.sh` run; empty scope → stopped
- [ ] `stack-map.sh` run; mode (single-PR / stack) and, in stack mode, tip, registered flag, spec and freshness noted
- [ ] Stack mode: `fetch-comments.sh` run per other layer for similar-thread matching
- [ ] First `/handover` ran; subagent used `stack-sweep` (stack mode) and the `challenge` skill; conclusions read
- [ ] Main agent re-challenged each finding (and each sweep outcome) with the `challenge` skill; verdicts produced
- [ ] Fixes (if any) produced via the `handover-loop` skill (reviewed until clean), NOT committed by the subagent; stack mode: one loop, branch `ticket/<M>` off `origin/<tip>`, in a worktree
- [ ] Stack mode: ticket drafted, shown, and filed only on approval, before the fix loop
- [ ] Each in-scope comment gated via AskUserQuestion with the options in order; similar threads listed when offered
- [ ] Every drafted reply follows the Reply voice (caveman, simple English, ≤3 sentences, polite floor)
- [ ] Scanned each reply for fancy words and swapped them for plain ones before posting
- [ ] Stack mode: fix PR opened once on the tip with `Closes #<M>`, linked when the stack is registered, before any reply naming it
- [ ] Single-PR mode: approved fix committed by the main agent in step 8, only after loop clean AND per-comment approval
- [ ] Only approved actions executed via `gh`; nothing posted, filed, or pushed without approval
- [ ] Final summary table reported, including sweep outcomes, ticket/PR numbers and scope-filter skips
