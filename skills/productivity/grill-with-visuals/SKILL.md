---
name: grill-with-visuals
description: "Grill the user with each round shown as a published page: every option of each question, each with its own view where they differ, a recommendation box, a settled-so-far strip, and glossary terms that explain themselves on hover."
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling". They own the conversation: the design tree, each round's frontier, the recommendations, the facts you look up, and the glossary and ADR updates. This skill owns only how a round is **shown**: one page per round, published as an artifact, with a terse text copy in chat. Answers still come back in chat, and the next round is still grilling's to compute.

## Each round

1. **Compute the round** as grilling says. Number questions across the whole session: round 2 starts after round 1's last number, so a Q number names one question for good.

2. **Write the page** from [`assets/round.template.html`](assets/round.template.html). Copy it once to a scratch file in the session's working folder (`grill-<topic>.html`) and rewrite that file each round. The template's comments say what each slot holds. Fill:
   - **Title and context**: the topic and round number; one or two sentences linking the ticket, issue or doc being grilled.
   - **Legend**: one chip per colour the page uses. Red is what exists today, green is the proposal, blue is the recommendation; the fourth colour is free for one meaning the page needs.
   - **Settled so far**: every decision from earlier rounds, one line each, keyed by Q number, as the user settled it (their wording where it changed the recommendation). The strip grows every round. Round 1 has none.
   - **One card per question**, carrying everything grilling's question holds: its body, **every choice it lists**, and the recommendation in the blue box, worded so "yes" accepts it. The page shows the question; it never shrinks it to the recommendation.
   - **The choices**: when grilling lists alternatives, the card shows each one as an option card (`.opts`), lettered A, B, C as grilling lettered them, each with what it means and what it costs, the recommended one marked `.pick`. They go in every card form that has them, under the picture when there is one. When the options differ in what they would look like, draw **one view per option** (`.view` with `data-opt` matching its option card) in the Proposed pane: the page shows the recommended option's view first, and clicking or pressing Enter on another option shows its tree, diff or diagram instead. Draw each view with the same kind of picture, so switching compares like with like. Options that would look the same get no views; their cards just sit under the picture. A question with no alternatives (a yes/no on one proposal) has no option cards. Clicking only changes the view: the user still answers in chat.
   - **The picture**, if the question needs one, picks the card form by what the question is about:
     - something that exists and would change → **Today | Proposed** panes, the same kind of picture on both sides;
     - an order of steps → **flow** rows;
     - who talks to whom, or how data moves → a **diagram** card;
     - how something looks or is used (a screen, a form, a TUI, a dialog) → a **UI mockup** card;
     - how something unfolds over time (timing, ordering, a race, a retry) → an **animation** card;
     - how something moves between states, and which moves are wrong → a **statechart** card;
     - a pick between options with nothing to draw → the option cards alone;
     - a plain judgement call → text only, no picture.

   **UI mockups.** A question about UI gets the UI, before and after: Today's screen in the Today pane, and the proposed screen per option as views. Draw it in the medium it lives in: a terminal frame (`.term`) for a TUI, a plain wireframe (`.ui`) for a web or desktop screen. Use the real labels, rows and keys from today's code; check them against the code before drawing Today, since a wrong Today misleads the whole card. Mark every mockup `data-no-glossary`, so terms inside the screen stay as the screen shows them.

   **Animations.** Use one when the point is when things happen: one thing is late, two things race, a poll misses, a retry lands. Draw it on a `<canvas>` in the animation card, driven by one `draw(t)` that renders any moment from the time alone, with the template's player: Play/Pause, a scrub bar, 1×/4× speed, never autoplay. Give each lane the reader's words, put the number that matters on the canvas (`8 s late`), describe the whole animation in the canvas's `aria-label`, and show the last frame when the reader prefers reduced motion. An animation that only decorates is cut.

   **Statecharts.** Use one when the question is about behaviour: which moves a thing can make, and whether one breaks a rule. First write the rules the user agrees to, one sentence each (R1, R2), at the top of the card. Then draw one Mermaid `stateDiagram-v2` per option as its view, and mark it:
     - a state that breaks a rule: `class … breaks`; a state on the shortest path to that break: `class … bugPath`. Mermaid needs the styles inside each chart, so copy the two `classDef` lines from the template's statechart card into every chart that marks a break;
     - under the chart, one line per break: the rule, then the path in the reader's words (`R2 breaks: Running → you reopen a node while agents are working → Reopened under a working agent`), and one line per option that breaks nothing;
     - label states with what the reader sees or cares about (`Halted, nothing in flight`), never a variable name, and arrows with what happens (`you reopen a node`), a condition in brackets (`[while the publisher works]`), never a code or action name;
     - keep each chart to about 20 arrows: merge states that act the same and leave out moves the reader doesn't need, then say under the chart what it leaves out.

     A break is reasoned from the code and the decisions so far, not proven by a model checker: say so if the user asks, and check each break path against the code when the question is about code that exists.

   **Decide per question whether a picture earns its place.** Ask what the user must see to answer it. When a sentence or two settles it, the card has no picture; that is the right answer for many questions. When the question is about a shape, a layout, a flow or a change, draw that shape instead of describing it, using the **smallest view that makes the key point clear**, the way the `show-me` skill does. Pick one view per card, two only when Today | Proposed needs the same view on both sides. Choose it by what the question turns on:
     - logic or an algorithm → **pseudocode**;
     - runtime control flow → a **call tree**;
     - UI structure → a **component tree**, with the state and module boundaries that matter;
     - file responsibility or a broad refactor → a shallow **file tree**;
     - interaction or data flow between parts → a **Mermaid** diagram (`<pre class="mermaid">`; the template loads Mermaid only when a page has one);
     - what changes in a shape that already exists → a **diff** of that shape (tree, call tree, state), or Today | Proposed panes holding the same view on both sides;
     - a command → the command and its output.

   Use the real paths, names and commands from the codebase, colouring only the part that changes. Draw everything but Mermaid with `<pre>` text and HTML.

3. **Link glossary terms.** From the repo being grilled, run:

   ```bash
   node <this skill's dir>/scripts/glossary.mjs link grill-<topic>.html
   ```

   It finds `GLOSSARY.md` (or `GLOSSARY-MAP.md`, or `CONTEXT.md`) walking up from the working directory, turns the first occurrence of each term per card into a dotted link, and adds the tooltip (definition plus its _Avoid_ line, on hover, keyboard focus, or first tap), a "Terms on this page" list, and a legend chip. Code, `<pre>`, links and the legend are left alone. It prints which terms it linked in each card: read that, and re-run with `--exclude note,stop` for any term matched in its everyday sense. Re-runs replace the previous injection, so run it after every edit; terms domain-modeling added this round are picked up then. No glossary found: the page goes out without links. `terms` instead of `link` prints the parsed glossary as JSON, for checking what a term will say.

4. **Publish.** Before the session's first publish, call the artifacts `guide` tool for the topics `pages` and `design`.
   - Round 1: `publish_files` with the scratch file as `index.html`, title and icon. If it refuses to attach the file (a path outside what the client will send), call `publish_version` with the page as `content` instead.
   - Later rounds: republish **the same artifact**, with its slug and the `base_version` from the last publish result, by the same tool that worked in round 1. One grilling is one artifact: the user keeps one link open, the settled strip already carries every earlier round, and the artifact's version history keeps each round's page.
   - **Open it, every round**, with the link from the publish result: `open <url>` on macOS, `xdg-open <url>` on Linux, `start "" <url>` on Windows. The user reads the round in the browser, not in the terminal. If the command fails or there is no desktop (a remote or headless session), say so in one line and go on: the link in step 5 is enough.

5. **Post the round in chat**: the link, then each question with its choices, so answers can cite a letter as well as "yes":

   ```
   Q2 Same name in several places: A nearest wins, shadowing shown · B error until qualified · C built in always wins
      yes = A
   Q11 What replaces the arming skill: yes = native `crew wait`, the skill deleted
   ```

   Then wait for the answers.

When grilling's frontier is empty, republish once more as the settled page, and open it: every decision in the strip, no question cards, the title ending in "settled".
