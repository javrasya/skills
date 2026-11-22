# Visual fragments

Copy only the picture markup from [`assets/visual-examples.html`](assets/visual-examples.html). The renderer adds the `.visual` wrapper, comparison panes, and option-view wrappers. See [round input](ROUND-INPUT.md) for the slots.

- Pick the smallest picture that answers the question.
  - something that exists and would change → **Today | Proposed** panes, the same kind of picture on both sides; when it is text (a tree, a snippet, config, a command's output), draw it as a git-style **diff** (`pre.diff`): one `<span>` per line, `.del` on Today's lines that change or go (red), `.add` on the proposal's lines that change or appear (green), unchanged lines plain, and the characters that actually change wrapped in `<del>` / `<ins>`, so they show darker within the line;
  - an order of steps → **flow** rows;
  - who talks to whom, or how data moves → a **diagram** card;
  - how something looks or is used (a screen, a form, a TUI, a dialog) → a **UI mockup** card;
  - how something unfolds over time (timing, ordering, a race, a retry) → an **animation** card;
  - how something moves between states, and which moves are wrong → a **statechart** card;
  - a pick between options with nothing to draw → the option cards alone;
  - a plain judgement call → text only, no picture.

**UI mockups.** A question about UI gets the UI, before and after: Today's screen in the Today pane, and the proposed screen per option as views. Draw it in the medium it lives in: a terminal frame (`.term`) for a TUI, a plain wireframe (`.ui`) for a web or desktop screen. Use the real labels, rows and keys from today's code; check them against the code before drawing Today, since a wrong Today misleads the whole card. Mark every mockup `data-no-glossary`, so terms inside the screen stay as the screen shows them.

**Animations.** Use one when the point is when things happen: one thing is late, two things race, a poll misses, a retry lands. Draw it on a `<canvas>` in the animation card, driven by one `draw(t)` that renders any moment from the time alone, with the visual example's player: Play/Pause, a scrub bar, 1×/4× speed, never autoplay. Give each lane the reader's words, put the number that matters on the canvas (`8 s late`), describe the whole animation in the canvas's `aria-label`, and show the last frame when the reader prefers reduced motion. An animation that only decorates is cut.

**Statecharts.** Use one when the question is about behaviour: which moves a thing can make, and whether one breaks a rule. pstack's `statechart` skill is the core of every statechart here; this skill only draws what it produces.
  - First write the rules the user agrees to, one sentence each (R1, R2), at the top of the card.
  - **With the `statechart` skill installed,** call it with the Skill tool for each option that needs a chart: it writes the TLA+ model, checks the rules with TLC, and gives `chart.mmd` and a report with the shortest path to each state that breaks a rule. Draw that chart as the option's view, its `breaks` and `bugPath` marks as it set them, and under it one line per break from the report: the rule, then the path in the reader's words (`R2 breaks: Running → you reopen a node while agents are working → Reopened under a working agent`), and what the report says the chart leaves out. Never add a state, a move or a break the checked chart doesn't have.
  - **Without it,** draw one Mermaid `stateDiagram-v2` per option yourself, reasoned from the code and the decisions so far. Check each break path against the code when the question is about code that exists.
  - **Say which it was, under every statechart card.** Once per grilling, run `node <this skill's dir>/scripts/chartcheck.mjs --html`: it checks for pstack's `statechart` skill, a runtime for its TypeScript (Node 22.18+ or 23.6+, Bun 1.1.5+, Deno 2+), and mise or `TLA2TOOLS`, and prints the `.chartsrc` line: "Model-checked · pstack statechart", or "Reasoned, not model-checked" with what is missing (the skill isn't installed, mise is missing, …) and the command that installs it. Paste it as the last thing in the card's picture. Run it without `--html` for the same as JSON. When it says checked but you drew a chart by hand anyway (the skill failed on this model), use the reasoned line and say why in its `.why`.
  - Either way: label states with what the reader sees or cares about (`Halted, nothing in flight`), never a variable name, and arrows with what happens (`you reopen a node`), a condition in brackets (`[while the publisher works]`), never a code or action name; keep each chart to about 20 arrows, and say under it what it leaves out. Mermaid needs the mark styles inside each chart, so copy the two `classDef` lines from the visual example's statechart card into every chart that marks a break.

**Plates, on explainer pages.** A term whose meaning is a behaviour (a doctor, a reclaim, a halt) can get a plate on its explainer: the same statechart, drawn as a picture someone reads many times. The plate is the presentation layer only. Every state, move, label, condition, break and bug path in it comes from the checked chart (or the reasoned one, labelled so); it adds nothing. Two styles, each a worked example in [`assets/plates/`](assets/plates/); read the comment at its top, keep its style, and redo the layout by hand for the chart:
  - [`worker.statechart-art.html`](assets/plates/worker.statechart-art.html), after statechart-art: one square page of cream paper, a typewriter title, states as props from the domain (tickets, signs, notes), a parent state as a container you can see into, italic ink labels on open paper, a few small props around the chart, and a break drawn as the bug plates do (`broken(id, rule, at)` and a red path).
  - [`run.colorfigures.html`](assets/plates/run.colorfigures.html), after Colorfigures: the thing as one isometric object with gauges, a drawer and a see-through window whose parts move with each step, flat colour, thick ink, a hard cobalt shadow, and callouts with leader lines.

  Save a plate as `terms/<term>.plate.html` beside the term's explainer, and link it from the explainer's picture card ("See the plate →"); it is a page of its own, so the explainer keeps its own picture too. A plate is hand-placed, so it costs far more than a card: make one only for a term central to the grilling, and only when the user wants it. Screenshot it like any new visual and fix every label that touches another.

**Decide per question whether a picture earns its place.** Ask what the user must see to answer it. When a sentence or two settles it, the card has no picture; that is the right answer for many questions. When the question is about a shape, a layout, a flow or a change, draw that shape instead of describing it, using the **smallest view that makes the key point clear**, the way the `show-me` skill does. Use one kind of picture per question, including across its alternative views. Choose it by what the question turns on:
  - logic or an algorithm → **pseudocode**;
  - runtime control flow → a **call tree**;
  - UI structure → a **component tree**, with the state and module boundaries that matter;
  - file responsibility or a broad refactor → a shallow **file tree**;
  - interaction or data flow between parts → a **Mermaid** diagram (`<pre class="mermaid">`; `grill.js` loads Mermaid only when a page has one, laid out by ELK);
  - what changes in a shape that already exists → a **diff** of that shape (tree, call tree, state), or Today | Proposed panes holding the same view on both sides;
  - a command → the command and its output.

Use the real paths, names and commands from the codebase, colouring only the part that changes. Draw everything but Mermaid with `<pre>` text and HTML.

**Diagrams that read.** `grill.js` lays every Mermaid diagram out with ELK, which keeps self-loops and labels apart where Mermaid's default layout piles them up. Keep each arrow label to about six words, and a self-loop's or self-message's to three or four (Mermaid clips a long one at the chart's edge); put a condition in brackets after it, and give a chart `direction TB` when it has more than about six states side by side. Charts draw at their own size, so text reads the same in every chart, and one wider than its card scrolls sideways: when a chart scrolls, try `direction TB` or fewer states before keeping it.
