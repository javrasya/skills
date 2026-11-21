---
name: pull-spiderman-with-visuals
description: "Run pull-spiderman on a PR, with every question to the user asked as a grill-with-visuals card: each verdict that owes work, the ticket and each reply gate on a local HTML page."
disable-model-invocation: true
---

This skill is `pull-spiderman` with its questions moved onto `grill-with-visuals` round pages, and one question added: a verdict that owes work is put to the user before the work is done. Everything else (the scope filter, the stack map, the handover, both challenges, the ticket, the fix loop, posting, the summary, every hard rule and the Reply voice) is pull-spiderman's, unchanged.

- **pull-spiderman**: call it with the Skill tool.
- **grill-with-visuals**: user-invoked, so the Skill tool can't reach it. Read its `SKILL.md` and follow it as if invoked: `../grill-with-visuals/SKILL.md` where skills are installed, [`../../productivity/grill-with-visuals/SKILL.md`](../../productivity/grill-with-visuals/SKILL.md) in this repo. Its asset and script paths resolve against its own folder.

## Who owns what

pull-spiderman owns the conversation: its steps decide what is asked, where grill-with-visuals gives that to `grilling` and `domain-modeling`. From `grilling` take the round: the frontier, Q numbers that run across the whole run, and on every card a recommendation worded so "yes" accepts it. Leave `domain-modeling` out: the glossary is read as it stands, for the term links and explainers.

**Approval is the user's answer to a card**, pasted from the page or typed. It stands where pull-spiderman says "approves in AskUserQuestion". A card with no answer stays open, and nothing is posted, filed, committed or pushed for it.

## The cards

A card is on the **frontier** when everything it shows exists. Use `grill-review-<pr>/` as the topic folder, and link the PR in each page's context line.

- **Verdict card**: one per comment whose step 4 verdict owes work (`agree-and-fix`, `agree-and-ticket`). On the frontier right after step 4, so no ticket is drafted and no fix loop runs for work the user would not take. Its options are the verdicts open to that comment, each with what it changes and what it costs; the recommendation is step 4's verdict. Picture: Today | Proposed, one view per option, on the smallest case that shows the reviewer's point.
- **Ticket card** (stack mode, step 5): put the complete draft in a `sections` entry, yes or no to filing it. On the frontier once every verdict card is answered.
- **Gate card**: one per in-scope comment (step 7). Its options are pull-spiderman's, in its order, lettered from A. Put the gate's content in `sections` in this order: Reviewer said, The code, In plain terms, Stack, Our response, Similar threads. Attach the fix diff as a visual fragment to Our response. On the frontier once the ticket its reply names is filed and the fix it shows is made; a comment whose reply names neither is on the first round's frontier.

On verdict and gate cards, mark what was **run** (a reproduction, a test, the script on made-up input) apart from what was only read, with the legend's fourth colour.

Two answers put a card back on the next round's frontier under the same Q number: **Explain more**, with a longer In plain terms; and a note that changes the reply, with the new draft. Wait for a fresh answer to the revised card. Post only the reply shown on the card the user approves.

## Steps

1. **Run pull-spiderman's steps 1 to 4** as written. Empty scope stops here, with no page.
2. **Ask in rounds**, each round the whole frontier. Follow grill-with-visuals to render the round, inspect new or changed visuals, open the page, and post the matching chat copy. Show the complete draft and any visual the user needs to approve it; wait for their answer.
3. **Between rounds, do what the answers unblock**, as pull-spiderman says: take each answered verdict as final, file the ticket on its card's yes (step 5), run the fix loop for the comments settled as `agree-and-fix` (step 6), act on each answered gate (step 8).
4. **Finish as pull-spiderman does**: when no card is left, the settled page carries step 9's table, and the same summary goes in chat.
