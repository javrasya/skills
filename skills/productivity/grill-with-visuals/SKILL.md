---
name: grill-with-visuals
description: Grill the user with each round shown as a published page: today-vs-proposed visuals per question, a recommendation box, a settled-so-far strip, and glossary terms that explain themselves on hover.
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling". They own the conversation: the design tree, each round's frontier, the recommendations, the facts you look up, and the glossary and ADR updates. This skill owns only how a round is **shown**: one page per round, published as an artifact, with a terse text copy in chat. Answers still come back in chat, and the next round is still grilling's to compute.

## Each round

1. **Compute the round** as grilling says. Number questions across the whole session: round 2 starts after round 1's last number, so a Q number names one question for good.

2. **Write the page** from [`assets/round.template.html`](assets/round.template.html). Copy it once to a scratch file in the session's working folder (`grill-<topic>.html`) and rewrite that file each round. The template's comments say what each slot holds. Fill:
   - **Title and context**: the topic and round number; one or two sentences linking the ticket, issue or doc being grilled.
   - **Legend**: one chip per colour the page uses. Red is what exists today, green is the proposal, blue is the recommendation; the fourth colour is free for one meaning the page needs.
   - **Settled so far**: every decision from earlier rounds, one line each, keyed by Q number, as the user settled it (their wording where it changed the recommendation). The strip grows every round. Round 1 has none.
   - **One card per question**, with the recommendation in the blue box, worded so "yes" accepts it. Pick the card form by what the question is about:
     - something that exists and would change → **Today | Proposed** panes, the same kind of picture on both sides;
     - a pick between options → **option cards**, the recommended one marked `.pick`;
     - an order of steps → **flow** rows;
     - a plain judgement call → text only, no picture.

   A question about shape, layout or flow gets the shape, not a paragraph about it: a directory tree, the call tree, a code snippet, a command and its output, a diff. Use the real paths, names and commands from the codebase, colouring only the part that changes. Draw with `<pre>` text and HTML; the page loads nothing but Google Fonts.

3. **Link glossary terms.** From the repo being grilled, run:

   ```bash
   node <this skill's dir>/scripts/glossary.mjs link grill-<topic>.html
   ```

   It finds `GLOSSARY.md` (or `GLOSSARY-MAP.md`, or `CONTEXT.md`) walking up from the working directory, turns the first occurrence of each term per card into a dotted link, and adds the tooltip (definition plus its _Avoid_ line, on hover, keyboard focus, or first tap), a "Terms on this page" list, and a legend chip. Code, `<pre>`, links and the legend are left alone. It prints which terms it linked in each card: read that, and re-run with `--exclude note,stop` for any term matched in its everyday sense. Re-runs replace the previous injection, so run it after every edit; terms domain-modeling added this round are picked up then. No glossary found: the page goes out without links. `terms` instead of `link` prints the parsed glossary as JSON, for checking what a term will say.

4. **Publish.** Before the session's first publish, call the artifacts `guide` tool for the topics `pages` and `design`.
   - Round 1: `publish_files` with the scratch file as `index.html`, title and icon. If it refuses to attach the file (a path outside what the client will send), call `publish_version` with the page as `content` instead.
   - Later rounds: republish **the same artifact**, with its slug and the `base_version` from the last publish result, by the same tool that worked in round 1. One grilling is one artifact: the user keeps one link open, the settled strip already carries every earlier round, and the artifact's version history keeps each round's page.

5. **Post the round in chat**: the link, then one line per question, so answers can cite them:

   ```
   Q10 Where a run's files live: yes = ~/.crew/runs/<workflow>-<UTC>-<hex4>/, registry beside it
   Q11 What replaces the arming skill: yes = native `crew wait`, the skill deleted
   ```

   Then wait for the answers.

When grilling's frontier is empty, republish once more as the settled page: every decision in the strip, no question cards, the title ending in "settled".
