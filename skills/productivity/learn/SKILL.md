---
name: learn
description: >-
  Guided, hands-on learning journey for a system, concept, codebase, or
  component. Use when the user runs /learn with a topic, asks to deeply
  understand or learn how something works, wants onboarding to a repo, or says
  they learn by doing rather than reading. Turns a topic into a problem-first,
  fail-forward lesson and leaves C4 diagrams and ADRs in the repo.
argument-hint: "[topic]"
---

# /learn — learn it the way you'd actually learn it

Topic: $ARGUMENTS
If empty, ask what to learn, or offer to teach this repo end to end.

Repo grounding — read this before teaching, never explain code you haven't read:
- Files:    !`git ls-files 2>/dev/null | head -60`
- Recent:   !`git log --oneline -15 2>/dev/null`
- Top level:!`ls -1 2>/dev/null | head -40`

## Run the lesson in five phases

Move ONE phase at a time and STOP at each checkpoint — wait for the user to
attempt, predict, or decide before continuing. Never dump the whole system at
once. A lecture is the failure mode this skill exists to prevent.

1. ORIENT — lowest load first.
   State the ONE problem this thing exists to solve, and its boundary: what's
   inside, what's outside, who/what talks to it. Emit a single C4 Level 1
   (System Context) Mermaid diagram, ~7 boxes max, one abstraction level only.
   No internals yet. Confirm the mental model fits before zooming in.

2. CONFRONT — let them try first (this phase is mandatory).
   Before explaining anything, hand the user a concrete problem and ask them to
   attempt it: predict what the code does, sketch how they'd build the
   component, or guess why it's designed this way. Let them produce their own
   (possibly wrong) answer. Do NOT correct yet. Encourage more than one
   attempt — generating answers, even bad ones, is what makes phase 3 stick.

3. REVEAL & CONTRAST — make the "why" visible.
   Now show how it actually works, contrasting with their attempt: name where
   their instinct was right and where reality diverged. Narrate the reasoning —
   the forces, constraints, and trade-offs — not just the answer. Surface the
   decisions: what alternatives existed, what was ruled out, and why. Zoom
   exactly ONE C4 level deeper (Container, then Component) with a NEW diagram
   per level — never a denser one. Capture each real "why" as an ADR.

4. PRACTICE — break it, predict, run (scaffold then fade).
   Give a hands-on task in the actual repo. Start with support (a hint, a
   partial diff, the file to open); remove it as they succeed. Bias toward
   failure-as-signal: "change X, predict what breaks, run it, check if you were
   right." When it fails, dig into the failure mode together — that IS the
   lesson. Loop back to phase 2 on anything that surprises them.

5. OWN IT — decide and reflect.
   Hand the user a real design decision or extension; make them make the call
   and articulate the reasoning. Help them write a short ADR for it. Close with
   a 3-line reflection: what they predicted wrong, what clicked, what's next.

## Rules (non-negotiable)

- One diagram per step. One C4 level per diagram. ~5–9 boxes max. Need more? Split it.
- **One runtime path per dynamic diagram.** A static diagram (Context/Container/Component) may show *all* relationships at once — many paths is correct. But a *runtime sequence* shows exactly ONE scenario: two runtime stories → two modules (two `trace` beats), never two numbered sequences crammed into one diagram. Only *runtime ordering* must be split; static relationships need not.
- Prefer prose when the question isn't about topology. Don't diagram for its own sake.
- Never reveal the solution before the user has attempted it. No exceptions, including time pressure.
- Think out loud; ask the user to predict before you reveal; fade help as they improve.
- Ground every claim in this repo's real code. Read the file, then explain it.

## Artifacts to leave behind (so the learning compounds)

Write these into the repo as you go — they also fix the "no context" problem for the next person:

- `docs/diagrams/*.md` — Mermaid C4 diagrams (render natively on GitHub). Example:
  ```mermaid
  flowchart TB
    user([Engineer]) --> sys[This System]
    sys --> db[(Datastore)]
    sys --> ext[External API]
  ```

- `docs/adr/NNNN-title.md` — one ADR per real decision (MADR-style):
  ```
  # NNNN. <decision title>
  Status: accepted    Date: <yyyy-mm-dd>
  ## Context
  <the problem, constraints, and forces — include real numbers>
  ## Decision
  <what was chosen, in active voice>
  ## Alternatives considered
  <options ruled out, and why>
  ## Consequences
  <trade-offs, good and bad>
  ```

- `docs/learning-log.md` — append a dated entry per session: topic, what was attempted, what was learned.

## The interactive experience (rich HTML mode)

When the user wants more than terminal output — "make it interactive", "give me a UI", "I want to click around" — emit a single self-contained HTML file from [`templates/experience.html`](./templates/experience.html). It is a working, gold-standard example (topic: rate limiting). **You retarget it by editing ONE object — the `CURRICULUM` data — never the engine.** The shell layout, CSS/design tokens, zoom engine, C4 renderer, skill-tree map layout, the slot gate, and persistence are a generic **PLAYER**; do not rebuild them. See [`reference/experience-authoring.md`](./reference/experience-authoring.md) for the full field-by-field guide.

**Mental model: data vs engine.** `CURRICULUM` is the content the author edits; everything that draws it is a fixed player that reads only the data. `CURRICULUM = { system, MODEL, modules:[…] }`.

- **`MODEL`** — the shared C4 backdrop (one static model, three zoom levels: `context`/`container`/`component`). This is the **only** thing you must rewrite for the diagram. Use genuine C4 grammar (see `[[c4-model]]` in CONTEXT.md): every node carries `kind` (`person`/`system`/`container`/`component`) + `scope` (`in` = decomposed here, `ext` = external actor) + description; `tech` renders as `[Container: tech]` (omit at context); people get a distinct glyph; in-scope vs external shown by colour **and** position; `into` makes a box the clickable boundary target for the next level; `store:true` draws a data store; `x,y,w,h` place it. Edges: `from`/`to`/`label` (intent verb) + `tech` (protocol, required between containers). Title, legend, glyph, colours, boundary box and zoom anchors are all **derived** — you don't touch them. **Do not** drift toward Kruchten's 4+1 views — this is C4 (four nested zoom levels of one model), not four orthogonal views (`[[4+1 (not C4)]]`).
- **`modules`** — each module is a **concept** (windowing, keying, failure…), NOT a 1:1 C4 box. A module declares `scene:{level, focus:[nodeId], zoomTo?}` pointing INTO the shared `MODEL`: Orient renders that level with `focus` highlighted and the rest dimmed (fog); Reveal zooms to `zoomTo`. Map-node progress aggregates over modules whose `focus` includes that C4 node.

**Fixed slots + beats (the lesson arc).** Each module has FIXED SLOTS `{orient, confront, reveal, practice?, own?}` in engine-enforced order; orient/confront/reveal are mandatory, practice/own optional and may hold several beats. Slots are the unchanging five-phase arc; **beats vary the interaction inside a slot**, never replacing it. A beat = `{type, id?, …payload}`; a registry maps type → a generic renderer that reads only the beat. Slot→beat legality: `orient`={orient}; `confront`={quiz,predict,sketch}; `reveal`={reveal}; `practice`={breakit,trace,fixit}; `own`={decide,callback}. The **gate is slot-owned**: any confront-legal beat must report a commit, and Reveal stays locked until it does (productive failure — the heart of the method; keep it). The dynamic/flow view is folded into the `trace` beat (numbered steps over the scene); there is no standalone Static/Flow toggle. A module holds **at most one `trace`** — one runtime scenario per diagram (C4 Dynamic rule). When a topic has two distinct runtime stories (e.g. an authoring path *and* a query path), split them into two modules, each with its own `trace`; never put two numbered sequences in one diagram.

**Map, unlock, test-out.** The home screen is a skill-tree **map** (modules = nodes, prereq edges = lines), auto-laid by tiered DAG (tier = longest prereq chain to a root). Selecting an unlocked node zooms INTO it; closing zooms back out — one spatial metaphor end to end. Unlock is a **hard gate**: a module is `locked` until its `prereqs` are `mastered`. A locked node offers a **test-out** escape hatch — a quick calibration check; pass = mastered + unlocks downstream, fail = opens the full module. `S.progress[moduleId]` ∈ {locked, available, active, mastered}.

**Connective tissue.** A terminal **capstone** module (`capstone:true`, many prereqs, heavier Own) makes the learner hold all concepts at once. **Scaffold fades** automatically as more modules are mastered (hints thin out). A **`callback` beat** (own slot) resurfaces a real prior decision — use sparingly. Every referenceable decide/confront beat carries a stable authored `id`; `S.decisions` is keyed by those ids so callbacks and ADRs stay stable across edits.

**Persistence.** Progress/mastery/decisions persist via `localStorage`, wrapped in try/catch with a silent in-memory fallback (works from `file://` in a sandbox). There is a mandatory **Reset** button and an **Export ADRs** button that offers ADR-markdown — but the HTML never claims to write files. Writing the real `CONTEXT.md`/ADRs/learning-log stays the agent's job (below); HTML mode complements those artifacts, it does not replace them.

To retarget: edit `CURRICULUM` (rewrite `MODEL`, then author each module's `scene` + slot beats). Ground every element in real code you read. Save the file where the user can open it (e.g. `docs/diagrams/<topic>.html` or a temp path) and tell them the path.

## Notes

- Terminal UI is limited: diagrams render best opened in your IDE or on GitHub.
  For a richer, clickable explainer, emit the interactive HTML experience above.
- Keep this file lean — it reloads every turn. If it grows, move long rationale
  and extra templates into `./reference/` and `./templates/` beside this
  SKILL.md and link to them.
