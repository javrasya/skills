---
name: grill-with-visuals
description: "Grill the user with each round shown as a local HTML page: every option of each question, each with its own view where they differ, a recommendation box, a settled-so-far strip, glossary terms that open their own visual explainer pages, and answers picked on the page and copied to the chat in one go."
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling". They own the conversation: the design tree, each round's frontier, the recommendations, the facts you look up, and the glossary and ADR updates. This skill owns only how a round is **shown**: one local HTML page per round, opened in the browser, with an explainer page for each glossary term on it, and a terse text copy in chat. The pages stay local files: never publish them as artifacts. Answers still come back in chat (the user answers on the page and pastes them all at once, or types them), and the next round is still grilling's to compute.

## Each round

1. **Compute the round** as grilling says. Number questions across the session: a Q number always names the same question. Carry forward every settled decision, in the user's wording where it changed the recommendation.
2. **Write `round.json`**, not page HTML. Start the session in a fresh `grill-<topic>/` folder (add a suffix if it exists) and reuse the folder for later rounds. Follow [round input](ROUND-INPUT.md). Include the context and link, every frontier question and option, and recommendations worded so “yes” accepts them. Leave plain questions text-only. When the user needs a picture to decide, author only that fragment; follow [visuals](VISUALS.md) for diffs, mockups, diagrams, animations, or statecharts.
3. **Render** from the repo being grilled:

   ```bash
   node <this skill's dir>/scripts/render-round.mjs grill-<topic>/round.json
   ```

   The command writes `index.html` and prints the matching chat copy. It discovers the repo glossary, creates missing explainer pages, and links terms in one pass. Read its term report: put everyday matches in `exclude` and rerun. For each `needs its picture` line, replace the explainer's `data-stub` section with the smallest picture that shows the term at work in this codebase. Keep authored explainers across rounds; add to one only when a later round uses the term in a new way. Rerun the renderer after editing explainer pictures to refresh their links.
4. **Inspect new or changed visuals** before asking for a decision: run `node <this skill's dir>/scripts/shoot.mjs <page.html>` for a round with new or changed pictures and for each new or changed explainer picture or plate. Open the PNG; check every option for clipped or overlapping labels, and verify Today against the code. Skip text-only rounds and unchanged pictures. If Chrome or Chromium is unavailable, set `CHROME` to its path or say the visual check could not run. A PR approval card must show its full draft and relevant visual before the user approves it.
5. **Open the local page and post the chat copy.** Run `open grill-<topic>/index.html` on macOS, `xdg-open` on Linux, or `start "" grill-<topic>/index.html` on Windows. If there is no desktop or the command fails, say so and give the local path. Post the renderer's stdout in chat and wait for answers. Keep the pages local; never publish them as artifacts.

The page lets the user pick, add notes, and copy their answers as one block. Drafts survive a reload of the same round; new rounds start blank. A choice with no note is a plain pick; a note can change or condition it. A note alone is the answer in the user's words. A missing Q stays open and keeps its number next round.

When the frontier is empty, render with `questions: []` and all decisions in `settled`, then open the settled page. A caller with a final summary table supplies `closingTable` in the same input.
