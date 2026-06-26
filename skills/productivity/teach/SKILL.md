---
name: teach
description: >-
  Guided, hands-on learning journey for a system, concept, codebase, or
  component. Use when the user types /teach <topic>, asks to deeply understand
  or learn how something works, wants to be onboarded to a repo, or says they
  learn by doing rather than by reading. Turns a topic into a problem-first,
  fail-forward lesson and leaves C4 diagrams and ADRs in the repo.
---

# /teach — learn it the way you'd actually learn it

Topic: $ARGUMENTS
If empty, ask what to teach, or offer to teach this repo end to end.

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

## Notes

- Terminal UI is limited: diagrams render best opened in your IDE or on GitHub.
  For a richer, clickable explainer, offer to emit a standalone HTML file the
  user can open in a browser.
- Keep this file lean — it reloads every turn. If it grows, move long rationale
  and extra templates into `./reference/` and `./templates/` beside this
  SKILL.md and link to them.
