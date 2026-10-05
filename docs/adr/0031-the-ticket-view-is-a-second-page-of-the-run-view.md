# ADR-0031: The ticket view is a second page of the run view, reached with g and left with t

## Status

Accepted — 2026-10-05. Amends ADR-0012's run view and the tree's design reference (`docs/design/orca-run-view-tree.md`), which said the run view has one layout: the tree stays the run view's first page and its only layout of agents, and the ticket view is a second page beside it, not a layout toggle. Numbered 0031 because 0030 is taken on an open branch.

## Context

The run tree answers "what is each agent doing". It does not answer "where is each ticket": a ticket's work is spread over several agents in several phases (dispatch and implement slices under Implement, gate rounds and their fixes under Gate, its publish under Stack), and the blocking edges between tickets, which decide what can start next, are drawn nowhere. The operator reads them off the spec by hand, or off runner.log.

Everything the answer needs is already on disk. The graph agent's result in the journal holds every ticket's title and its `blocked_by`, its `needs_human`, and the run's blockers. Every ticket agent runs under a node `ticket/<n>/…`, so the journal's fold says which stages a ticket has reached, and its publish node's result says whether it is stacked.

## Decision

**The ticket view draws a run's tickets as a star map, as a second page of the run view: `g` in the tree opens it, `t` goes back to the tree as it was left.**

- **A star per ticket, at its stage**, a glyph that tells it without colour and a colour: `○` grey not picked up, `◐` light blue in dispatch or implement, `◆` purple at the gate or its fixes (or publishing), `★` green stacked (published, subsumed, or done in prior work), `✸` orange waiting on a person (an agent of it that needs you or is blocked, a doctor of one that escalated, a `needs_human` ticket, a ticket not picked up behind one, which the run defers to a human, or a blocker's ticket before the unblock session is done), `✗` red failed. The stage is the one the ticket's **latest** agent is at, so a gate that sends a ticket back to dispatch has it implementing again. Stages are derived on every refresh (`ticket-map.mjs`), never journaled: they are a reading of the fold, as the tree's states are. The stage key is `waiting`, not `blocked`, which is an agent's state.
- **A line per blocking edge**, drawn from blocker to blocked, depth running left to right. A ticket not started that waits, through its blockers, on one waiting on a person or failed is **held**, its lines dashed.
- **Spread to fill the screen, never squeezed below a least spacing.** A depth is at least 26 columns apart and a column's stars at least 5 rows apart; a screen with room for more spreads the map to fill it, up to 60 and 10, past which a line is too long to follow. Along an axis the whole map fits, the camera sits still on the map's middle. Along one it overflows, the camera keeps the selected star in the middle and glides to the next one in 380 ms, easing in and out, and the counts at the edges say how many stars are off each side. A spec too big for one screen is a sky to move through, not a map shrunk until it cannot be read.
- **Arrows follow the lines**: → to a ticket this one blocks, ← back to a blocker, ↑↓ the nearest star that way. A click selects a star. Enter goes back to the tree on the ticket's latest agent. Esc, like `t`, goes back to the tree. The run's own keys (l, p, r, x, q) do what they do in the tree.
- **A long title scrolls** under the selected star by the selected agent name's rule (`marqueeOffset`), not a second one.
- **Both renderers write through one painter** (`run-view/paint.mjs`): only the lines that changed, inside synchronized output, so a glide at 60 frames a second does not tear, and a `tick` from `draw` says how soon to draw again (16 ms while gliding, 100 ms for the twinkle, the marquee's step while a name scrolls).

## Considered options

- **A layout toggle on the tree** (the prototype's Tree / Lanes / Timeline, dropped in #51). Rejected again: those were three ways to draw the same agents. The ticket view is a different subject, tickets rather than agents, so it is a page of its own and the tree keeps its one layout.
- **Columns of boxes or an indented tree of tickets.** Rejected after a prototype: an indented tree turns every ticket with two blockers into a footnote, and boxed columns stop fitting at five depths. The star map keeps every edge and scales by moving the camera.
- **Fit the whole graph to the screen.** Rejected below the least spacing: a 30-ticket spec squeezed into one terminal is unreadable, so the camera moves instead. Above it the map is spread to fill the screen, since a small graph huddled in the middle of a wide terminal wastes it.
- **Always keep the least spacing.** Rejected after the first real run: eight tickets on a 250-column terminal sat in a fifth of it.
- **Journal each ticket's stage from the script.** Rejected: the fold already holds the facts, and a second record of them is one that can disagree.

## Consequences

- Before the graph agent returns there are no tickets: the page says so. After a resume truncates the journal, the graph's result is read from its agent's `result.json` until the graph node replays.
- The page redraws ten times a second for as long as it is open, for the twinkle and the breathing stars, though only the lines that changed are written. The tree redraws only on a refresh, a key or a scrolling name.
- A ticket's run outcome that only `summary.json` knows (`unmet`, `stopped`) is not a stage: its agents ended `done`, so its star stays where its latest agent left it.
- Colours are 24-bit: a terminal without truecolor shows them approximated. The glyphs carry the stage either way.
- The braille lines mean nothing to a screen reader; the tree, and the pane under the map, say the same in words.
