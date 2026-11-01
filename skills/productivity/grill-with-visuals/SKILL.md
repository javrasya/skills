---
name: grill-with-visuals
description: "Grill the user with each round shown as a local HTML page: every option of each question, each with its own view where they differ, a recommendation box, a settled-so-far strip, and glossary terms that open their own visual explainer pages."
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling". They own the conversation: the design tree, each round's frontier, the recommendations, the facts you look up, and the glossary and ADR updates. This skill owns only how a round is **shown**: one local HTML page per round, opened in the browser, with an explainer page for each glossary term on it, and a terse text copy in chat. The pages stay local files: never publish them as artifacts. Answers still come back in chat, and the next round is still grilling's to compute.

## Each round

1. **Compute the round** as grilling says. Number questions across the whole session: round 2 starts after round 1's last number, so a Q number names one question for good.

2. **Write the page** from [`assets/round.template.html`](assets/round.template.html). Once per grilling, make a folder `grill-<topic>/` in the session's working folder (or the job's scratch folder), and copy into it `assets/grill.css` and `assets/grill.js`, which every page links to, and the template as `index.html`. Rewrite `index.html` each round. The template's comments say what each slot holds. Fill:
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

   **Statecharts.** Use one when the question is about behaviour: which moves a thing can make, and whether one breaks a rule. pstack's `statechart` skill is the core of every statechart here; this skill only draws what it produces.
     - First write the rules the user agrees to, one sentence each (R1, R2), at the top of the card.
     - **With the `statechart` skill installed,** call it with the Skill tool for each option that needs a chart: it writes the TLA+ model, checks the rules with TLC, and gives `chart.mmd` and a report with the shortest path to each state that breaks a rule. Draw that chart as the option's view, its `breaks` and `bugPath` marks as it set them, and under it one line per break from the report: the rule, then the path in the reader's words (`R2 breaks: Running → you reopen a node while agents are working → Reopened under a working agent`), and what the report says the chart leaves out. Never add a state, a move or a break the checked chart doesn't have.
     - **Without it,** draw one Mermaid `stateDiagram-v2` per option yourself, reasoned from the code and the decisions so far, and say under each chart "reasoned, not model-checked". Check each break path against the code when the question is about code that exists.
     - Either way: label states with what the reader sees or cares about (`Halted, nothing in flight`), never a variable name, and arrows with what happens (`you reopen a node`), a condition in brackets (`[while the publisher works]`), never a code or action name; keep each chart to about 20 arrows, and say under it what it leaves out. Mermaid needs the mark styles inside each chart, so copy the two `classDef` lines from the template's statechart card into every chart that marks a break.

   **Plates, on explainer pages.** A term whose meaning is a behaviour (a doctor, a reclaim, a halt) can get a plate on its explainer: the same statechart, drawn as a picture someone reads many times. The plate is the presentation layer only. Every state, move, label, condition, break and bug path in it comes from the checked chart (or the reasoned one, labelled so); it adds nothing. Two styles, each a worked example in [`assets/plates/`](assets/plates/); read the comment at its top, keep its style, and redo the layout by hand for the chart:
     - [`worker.statechart-art.html`](assets/plates/worker.statechart-art.html), after statechart-art: one square page of cream paper, a typewriter title, states as props from the domain (tickets, signs, notes), a parent state as a container you can see into, italic ink labels on open paper, a few small props around the chart, and a break drawn as the bug plates do (`broken(id, rule, at)` and a red path).
     - [`run.colorfigures.html`](assets/plates/run.colorfigures.html), after Colorfigures: the thing as one isometric object with gauges, a drawer and a see-through window whose parts move with each step, flat colour, thick ink, a hard cobalt shadow, and callouts with leader lines.

     Save a plate as `terms/<term>.plate.html` beside the term's explainer, and link it from the explainer's picture card ("See the plate →"); it is a page of its own, so the explainer keeps its own picture too. A plate is hand-placed, so it costs far more than a card: make one only for a term central to the grilling, and only when the user wants it. Screenshot it like any page (step 5) and fix every label that touches another.

   **Decide per question whether a picture earns its place.** Ask what the user must see to answer it. When a sentence or two settles it, the card has no picture; that is the right answer for many questions. When the question is about a shape, a layout, a flow or a change, draw that shape instead of describing it, using the **smallest view that makes the key point clear**, the way the `show-me` skill does. Pick one view per card, two only when Today | Proposed needs the same view on both sides. Choose it by what the question turns on:
     - logic or an algorithm → **pseudocode**;
     - runtime control flow → a **call tree**;
     - UI structure → a **component tree**, with the state and module boundaries that matter;
     - file responsibility or a broad refactor → a shallow **file tree**;
     - interaction or data flow between parts → a **Mermaid** diagram (`<pre class="mermaid">`; `grill.js` loads Mermaid only when a page has one, laid out by ELK);
     - what changes in a shape that already exists → a **diff** of that shape (tree, call tree, state), or Today | Proposed panes holding the same view on both sides;
     - a command → the command and its output.

   Use the real paths, names and commands from the codebase, colouring only the part that changes. Draw everything but Mermaid with `<pre>` text and HTML.

   **Diagrams that read.** `grill.js` lays every Mermaid diagram out with ELK, which keeps self-loops and labels apart where Mermaid's default layout piles them up. Keep each arrow label to about six words, and a self-loop's or self-message's to three or four (Mermaid clips a long one at the chart's edge); put a condition in brackets after it, and give a chart `direction TB` when it has more than about six states side by side. Charts draw at their own size, so text reads the same in every chart, and one wider than its card scrolls sideways: when a chart scrolls, try `direction TB` or fewer states before keeping it.

3. **Explain the terms.** From the repo being grilled, run:

   ```bash
   node <this skill's dir>/scripts/glossary.mjs explainers grill-<topic>/index.html
   ```

   It finds `GLOSSARY.md` (or `GLOSSARY-MAP.md`, or `CONTEXT.md`) walking up from the working directory, and writes `grill-<topic>/terms/<term>.html` for each glossary term on the page that has none yet, from [`assets/term.template.html`](assets/term.template.html): the glossary's definition and _Avoid_ line, and links back to the questions that use the term. It lists every explainer that still needs its picture. Give each one the picture that makes the term click, drawn with the same card kinds as the round page (Today | Proposed, flow, diagram, UI mockup, animation, statechart), showing the term at work in this codebase with its real names, and replace the stub card. An explainer is written once and kept across rounds; add to it only when a later round uses the term in a new way.

4. **Link glossary terms**, on the round page and on every explainer:

   ```bash
   node <this skill's dir>/scripts/glossary.mjs link grill-<topic>/index.html
   node <this skill's dir>/scripts/glossary.mjs link grill-<topic>/terms/<term>.html   # each explainer
   ```

   It turns the first occurrence of each term per card into a dotted link to the term's explainer, adds the tooltip (definition plus its _Avoid_ line, and "Open the explainer", on hover, keyboard focus, or first tap; a second tap opens the explainer), puts a "Terms on this page" list right after the header, each term linking to its explainer, and adds a legend chip. Code, `<pre>`, links, mockups and the legend are left alone. It prints which terms it linked in each card: read that, and re-run with `--exclude note,stop` for any term matched in its everyday sense. Re-runs replace the previous injection, so run it after every edit; terms domain-modeling added this round are picked up then, and so are new explainers. No glossary found: the pages go out without links. `terms` instead of `link` prints the parsed glossary as JSON, for checking what a term will say.

5. **Look before you show.** Screenshot the round page, and each explainer you wrote or changed this round:

   ```bash
   node <this skill's dir>/scripts/shoot.mjs grill-<topic>/index.html
   ```

   It shows every option's view at once, so one image holds every diagram, mockup and chart. Read the PNG once and fix what reads wrong: labels on top of each other, a chart wider than its card, text cut off, a Today that doesn't match the code. It needs an installed Chrome or Chromium; set `CHROME` to its path if it isn't found, and say so in one line if there is none.

6. **Open it, every round**: `open grill-<topic>/index.html` on macOS, `xdg-open` on Linux, `start ""` on Windows. The user reads the round in the browser, not in the terminal, and goes from a term to its explainer and back there. If the command fails or there is no desktop (a remote or headless session), say so in one line and go on: the path in step 7 is enough.

7. **Post the round in chat**: the page's path, then each question with its choices, so answers can cite a letter as well as "yes":

   ```
   Q2 Same name in several places: A nearest wins, shadowing shown · B error until qualified · C built in always wins
      yes = A
   Q11 What replaces the arming skill: yes = native `crew wait`, the skill deleted
   ```

   Then wait for the answers.

When grilling's frontier is empty, rewrite `index.html` once more as the settled page, and open it: every decision in the strip, no question cards, the title ending in "settled".
