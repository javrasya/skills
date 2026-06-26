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

When the user wants more than terminal output — "make it interactive", "give me a UI", "I want to click around" — emit a single self-contained HTML file built from the template at [`templates/experience.html`](./templates/experience.html). It is a working, gold-standard example (topic: rate limiting). Copy it, then swap the data for the real topic. Do not rebuild the shell from scratch.

What the experience carries (all five phases live in one screen):

- **Three columns:** left = chapter rail (the 5 phases), center = stage, right = margin holding the **path** (history of what was tried) and the **decision log** (ADRs).
- **One real C4 diagram that deepens by zoom**, not five separate diagrams. It uses genuine C4 grammar (see `[[c4-model]]` in CONTEXT.md): every box carries a type tag (`[Person]`/`[Software System]`/`[Container: tech]`/`[Component: tech]`) + description; people use a distinct glyph; in-scope is blue, external grey; relationships are directional dashed arrows labelled with intent + `[technology]`; each level auto-renders a **title** and a **legend**. Diving into a box turns it into a dashed **boundary** with its children inside and outside actors projected onto the edge (Context → Container → Component). Breadcrumbs + "zoom out" go back. **Do not** drift toward Kruchten's 4+1 views — this is C4 (four nested zoom levels of one model), not four orthogonal views.
- **The reveal is gated:** the user must commit a guess in CONFRONT before REVEAL unlocks (productive failure). Keep this — it is the heart of the method.
- **A live simulator in PRACTICE** that lets them break it and watch the failure mode.
- **Every decision becomes an ADR** in the margin as they go; the OWN-IT choice writes their own ADR with their reasoning.

To retarget it to a new topic, edit only the data — the shell, CSS, zoom engine, and gating logic stay:

1. `MODEL` — the **only** thing you must rewrite for the C4 diagram. It is one object with three keys (`context`/`container`/`component`), each holding `level`, `scope`, an optional `boundary` ({name,type}), `nodes`, and `edges`. Per node: `kind` (`person`/`system`/`container`/`component`), `scope` (`in` = the thing being decomposed at this level, `ext` = external actor), `tech` (rendered as `[Container: tech]`; omit at context level), `into` (the level id this box zooms into — makes it the clickable boundary target), `adr` (clicking flashes that ADR), `store:true` (draw as a data store), and `x,y,w,h` in the 680×380 frame. Per edge: `from`, `to`, `label` (intent verb phrase), `tech` (protocol — required between containers). Ground every element in the real code you read. The title, legend, person glyph, scope colours, boundary box, and zoom anchors are all **derived from `MODEL`** — you don't touch them.
2. `CHAPTERS` — usually leave as the five phases.
3. `CHOICES` + `paneConfront`/`paneReveal` — the prediction options and the contrast against reality.
4. The simulator (`fireBurst`, `updateReadout`, `panePractice`) — rebuild the "break it" interaction for this topic, or simplify to a stepped trace if a live sim doesn't fit.
5. `ADR_LIB` + `paneOwn` — the decisions, including the one the user makes. Keys here must match the `adr:` keys you used in `MODEL`.

Save the result somewhere the user can open it (e.g. `docs/diagrams/<topic>.html` or a temp path) and tell them the path. The HTML mode complements the artifacts above — it does not replace the `CONTEXT.md`/ADR/learning-log writing.

## Notes

- Terminal UI is limited: diagrams render best opened in your IDE or on GitHub.
  For a richer, clickable explainer, emit the interactive HTML experience above.
- Keep this file lean — it reloads every turn. If it grows, move long rationale
  and extra templates into `./reference/` and `./templates/` beside this
  SKILL.md and link to them.
