---
name: pull-spiderman
description: >-
  Use when the user wants to triage and answer the review comments on a pull request —
  triggers include "/pull-spiderman <PR>", "review the comments on this PR", "answer the
  review on this PR", "go through the PR review comments", "triage the review on PR N". Works
  for review comments left by any reviewer — an agent (Copilot, Claude, etc.) or a human. It
  vets each comment with adversarial double-challenge and posts NOTHING (no reply, no resolve,
  no code fix) without per-comment human approval.
---

# Pull Spiderman

Drive a PR's review comments to a vetted decision and a reply. A reviewer makes a claim; we
adversarially challenge it twice (once in a subagent, once on the main agent with full
conversation context) before deciding whether it is right — two Spider-Men pointing until one
claim is confirmed. Every reply, resolve, and code fix is gated behind explicit per-comment
user approval. The reviewer may be a bot or a human; the skill treats them the same.

## Hard rules — do not violate

- **Post nothing without approval.** No `gh` reply, no thread resolve, and no code-fix
  write/commit happens until the user approves *that specific comment* in AskUserQuestion.
  "Do not comment yet" governs the whole skill.
- **Use the companion skills/tools for each step, don't inline your own analysis.** Use the
  `handover` skill for delegation, the `challenge` skill for the adversarial passes, and the
  `handover-loop` skill for fixes. Sequence them; do not replace them with ad-hoc reasoning.
- **Scope filter is mandatory:** only comments whose review thread is unresolved AND not
  already replied-to by the current `gh` user. By default every reviewer is in scope (human and
  bot); pass `--author <login>` to `scripts/fetch-comments.sh` to narrow to one reviewer.
  The script enforces the filter. Log what it skipped.
- **Fixes are gated like replies.** A code fix is *proposed* by the `handover-loop` skill; it is not
  committed until approved in the same per-comment gate.

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

### 2. First `/handover` — gather + challenge (subagent)
Invoke the `handover` skill. The subagent's task: read each in-scope comment against the actual
code, run the `challenge` skill on each one to stress whether the claim holds, and return
structured findings — per comment: what the reviewer claims, what the code actually does, whether
the claim is valid, a proposed response, and whether a real code fix is warranted. The subagent
writes its conclusions via `/handoff`; read that doc when it returns.

### 3. Adversarial re-challenge (main agent)
You hold the full conversation the handoff doc could not capture. For each finding, run the
`challenge` skill again against the subagent's decision — cold-eyes, looking for what it got wrong
or what intent it missed (the main agent holds the full conversation the handoff doc could not
capture). Produce a final per-comment verdict:
`agree-and-fix` / `agree-and-explain` / `disagree-with-reason`.

### 4. Optional fix via the `handover-loop` skill — propose fixes
For comments whose verdict is `agree-and-fix`, delegate the fix via the `handover-loop` skill, not a
plain `/handover`. Each round a fresh subagent makes the fix and the main agent adversarially reviews
the real diff — stubs, fake-done, fallbacks, weakened tests, missed edge cases — looping with a new
subagent until the review comes back clean. This hardens the fix before a human ever sees it.

The loop produces the diff but does **not** commit it — per the hard rules the fix stays uncommitted
until approved in the per-comment gate (step 5). The loop task must say: produce the fix in the working
tree, do not commit; the per-comment gate owns the commit.

Batch related `agree-and-fix` comments into one loop where they touch the same code, so the adversarial
review sees the whole change at once; keep unrelated fixes in separate loops.

### 5. Per-comment human gate (AskUserQuestion — one comment at a time)
For each in-scope comment, ask a single, well-structured question containing:
- **Reviewer said:** the original comment, quoted (note the author).
- **The code:** `path:line` plus the `diff_hunk` (or a file excerpt) it points at.
- **In plain terms:** what the code does and what the reviewer's point means, explained for a
  reader who may not know this codebase's language — avoid unexplained jargon.
- **Our response:** the drafted reply (written in the **Reply voice** above — caveman, simple,
  ≤3 short sentences, politeness floor), and the proposed fix diff if any.

Options, in exactly this order:
1. **Post reply**
2. **Post reply and resolve**
3. **Skip reply**
4. **Explain more** — re-ask the *same* question with an expanded "In plain terms" section, then
   present these four options again.

### 6. Act on the choice (`scripts/post-reply.sh`)
Write the approved reply body to a temp file, then:
- **Post reply** → `post-reply.sh <pr> <comment_id> <thread_id> <reply_file>`
- **Post reply and resolve** → add `--resolve`. If the verdict included an approved code fix,
  the `handover-loop` skill (step 4) already produced and hardened it in the working tree
  uncommitted. The **main agent** commits it now — only after the loop came back clean AND this
  comment was approved. The handover subagent never commits; that is the main agent's job here.
- **Skip reply** → record it, post nothing.

### 7. Final summary
A table: each comment → final verdict → action taken (replied / replied+resolved / skipped) →
link. State what the scope filter skipped and why.

## Common mistakes

- Posting, resolving, or committing a fix before the user approved that comment.
- Replacing the `handover` skill or the `challenge` skill with your own ad-hoc reasoning.
- Touching threads that are already resolved or already have your reply.
- Resolving a thread without posting a reply.
- Leaving unexplained jargon in the plain-language explanation — the reader may not know this codebase's language.

## Checklist
- [ ] PR resolved; `fetch-comments.sh` run; empty scope → stopped
- [ ] First `/handover` ran; subagent used the `challenge` skill; conclusions read
- [ ] Main agent re-challenged each finding with the `challenge` skill; verdicts produced
- [ ] Fixes (if any) produced via the `handover-loop` skill (reviewed until clean), NOT committed by the subagent
- [ ] Approved fix committed by the main agent in step 6, only after loop clean AND per-comment approval
- [ ] Each in-scope comment gated via AskUserQuestion with the four options in order
- [ ] Every drafted reply follows the Reply voice (caveman, simple English, ≤3 sentences, polite floor)
- [ ] Scanned each reply for fancy words and swapped them for plain ones before posting
- [ ] Only approved actions executed via `gh`; nothing posted without approval
- [ ] Final summary table reported, including scope-filter skips
