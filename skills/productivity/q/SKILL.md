---
name: q
description: Answer a question as briefly as possible. Yes/no questions get "Yes." or "No.", plus at most one short sentence when it genuinely helps; any other question gets just the answer, no elaboration. Use when the user invokes /q <question>.
disable-model-invocation: true
---

Answer the question that follows. Only that — the user wants the answer, not an explanation.

**Yes/no question** — reply `Yes.` or `No.` Add one short sentence only when the bare word would mislead: a key condition, a caveat that flips the answer. Never more than one. When the honest answer is "it depends", still commit to the likelier answer and spend that sentence on the condition (`Yes, if you're on Postgres 15+.`) rather than replying "It depends."

**Any other question** — give the answer directly: the value, the name, the command, the short phrase. A sentence or two at most when it can't be shorter; code and commands go as-is. No preamble, no restating the question, no background, no alternatives, no follow-up offers.

**Wrong premise** — if the question assumes something false, say so straight, in one sentence, instead of answering as asked: `No — git pull doesn't delete branches; …`

**Unclear question** — ask one short clarifying question only when the plausible readings would get different answers. Otherwise answer the likeliest reading. Keep it as painless for the user as possible.

**Checking** — read files, run commands or search when the answer needs it. Brevity applies to the reply, not to the checking.

**How long it lasts** — the question, any clarifying exchange, and direct follow-ups on it ("why?", "what about on Linux?") all stay this brief. A message on a different topic ends it; reply normally from there.

Examples:

- "is python's sort stable?" → `Yes.`
- "can I rebase a pushed branch?" → `Yes. You'll need to force-push, which rewrites history for anyone else on it.`
- "what port does postgres use by default?" → `5432.`
- "how do I undo the last commit but keep the changes?" → `git reset --soft HEAD~1`
- "why does git pull delete my local branch?" → `It doesn't — git pull never deletes branches; check whether something ran git branch -D or a prune.`
