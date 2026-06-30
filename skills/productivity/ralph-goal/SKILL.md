---
name: ralph-goal
description: Author a Ralph Wiggum style goal prompt — a single fixed spec the user feeds to an agent CLI (Claude Code, Codex, aider, etc.) in a while-loop, where each iteration starts fresh, reads a progress file, does one verified slice of work, and writes a DONE sentinel when the whole goal passes its check. First runs a maturity gate; if the goal is not loopable yet (no checkable finish, fuzzy scope, no verify path), it grills the user on exactly the gaps before drafting. Produces three files: PROMPT.md (the looping goal, kept under 4K chars), PROGRESS.md (plan + cross-iteration memory), and ralph-loop.sh (the runner). Use when the user says "/ralph-goal <task>", wants a loopable goal prompt, asks about the Ralph Wiggum / Ralph technique, or wants a long task run unattended in a brute-force agent loop.
---

# Ralph Goal

The Ralph Wiggum technique runs **the same prompt** at an agent CLI over and over in a shell loop. The agent has no memory between runs, so the prompt must carry everything: the unchanging goal, where to find state, how to pick the next slice, how to verify it, and how to know the whole thing is finished. Each iteration is a fresh context that reads the plan, does one bounded verified slice, records it, and exits. The outer loop reruns until a sentinel says stop.

This skill produces that kit — it does not run the loop. But first it checks the goal is even loopable, and grills the user on any gap that would make the loop spin forever.

## Step 1 — Maturity gate

A Ralph loop only converges if the goal clears all six criteria. Check each against the request and the repo (explore the code to answer, don't ask what you can read):

1. **Checkable DONE** — a command/observation the *agent itself* runs that proves the goal met (tests green, build clean, script exits 0). Not a human judgement.
2. **Bounded** — a finish line, finite work. Not "improve X" / "make it better" forever.
3. **Sliceable** — work splits into increments a fresh, memoryless context can pick one of and complete. Not one monolithic step, not a chain where every step needs the last in working memory.
4. **Per-slice verify** — each slice can be checked *before the next starts*, not only at the very end. (How do we verify along the way?)
5. **Starting state** — the files/repo the loop acts on exist, or iteration 1's explicit job is to create them.
6. **Rollback-safe** — a bad iteration leaves the tree working or reverts; it can't corrupt state the next iteration depends on.

**Pass all six → go to Step 3 (draft).** **Fail any → Step 2 (grill).**

## Step 2 — Grill the gaps (only the failed criteria)

For each failed criterion, ask **one** question, **one at a time**, each seeded by that gap, each with your recommended answer. Wait for the answer before the next. Do not run a general deepening interview — the gate already located the gaps; stay on them.

| Failed criterion | The question it becomes |
|---|---|
| Checkable DONE | "What single command proves this is done? If none exists, what would we have to build to check it?" |
| Bounded | "Where is the finish line — what's true when we stop that isn't true now?" |
| Sliceable | "Can this split into independent increments, or does step N need step N-1 in memory? If chained, what's the seam?" |
| Per-slice verify | "After one slice, what cheap check confirms *that slice* before moving on?" |
| Starting state | "Do the files this acts on exist now, or is creating them iteration 1?" |
| Rollback-safe | "If one iteration goes wrong, how does the next not inherit a broken tree?" |

When a criterion resolves, it's locked — don't relitigate. Once all six hold, draft.

## Step 2.5 — Detect the iteration methodology

A memoryless iteration does work *some way* — and it will invent one if the prompt is silent (the goal might come out TDD by luck, or not at all). Pin the **dev discipline** and the **CLI directives** so every iteration runs the same way, and bake them into PROMPT.md — never leave them to chance.

- **Dev discipline** — how an iteration produces the slice. Read the repo first: a `CLAUDE.md`/`AGENTS.md`, a `tdd`/test-first norm, a `/tdd` skill, or a contributing guide. If the project is test-first, step 4 of the loop must say so — and if the agent CLI exposes it as a command (e.g. `/tdd`), name the command, don't paraphrase it. If nothing's documented and it's not obvious, ask the user one line: "what discipline does each iteration follow — TDD, spec-then-code, just-make-it-green?"
- **CLI directives / reserved keywords** — control words the target CLI acts on, passed **verbatim** in the prompt. `ultracode` (Claude Code multi-agent orchestration) is one such reserved keyword; `/tdd` is a slash command the agent invokes. If the user runs with these, the prompt must contain the literal token — paraphrasing it ("use many agents", "test first") does NOT trigger the behaviour. Ask which the loop should carry if unstated.

Both land in PROMPT.md: the discipline in loop step 4, the reserved keywords/commands inline where the agent will act on them.

## Step 3 — Draft the three files

In a directory the user names (default `./ralph/`). Keep them CLI-agnostic.

**PROMPT.md — the goal fed verbatim every iteration. Keep it UNDER 4K chars** (Claude Code's `-p` limit). It holds only the *unchanging machinery* — goal, loop steps, the two verify commands, rules. **The plan/checklist does NOT go here** — it lives in PROGRESS.md, which the agent reads as a file with no size limit. PROMPT.md stays small and constant regardless of task size. Char-count it before finishing; if over 4K, move detail into PROGRESS.md.

Write the file content directly — no wrapping tags. Never emit a `</content>` (or similar) marker into the file; it gets fed to the agent every iteration as noise. After writing, confirm the last line is real content.

```md
# Goal
<one sentence — the unchanging target>

You are one iteration of a loop. You have NO memory of previous runs.
Everything is in this file and PROGRESS.md. Do ONE slice, then exit.

## Every iteration, in order
1. Read PROGRESS.md — the plan, the log, and per-item attempt counts.
2. Run the DONE-CHECK below.
   - Passes → write file `RALPH_DONE` with a one-line summary. STOP.
   - Fails → continue.
3. Pick the SINGLE next unchecked plan item. If its attempt count is already 2,
   write `RALPH_STUCK` with the blocker. STOP. Otherwise increment its count in PROGRESS.md.
4. Do only that item, following <DISCIPLINE — e.g. TDD: invoke `/tdd`, write the failing
   test first, then implement to green>. <RESERVED-KEYWORDS the CLI needs, verbatim — e.g. ultracode>.
5. SLICE-VERIFY: run that item's "done when" check. Failed → log the failure, exit (don't tick it).
6. Append a dated log entry: what you did, what you verified, what's next. Tick the item if it passed.
7. Exit. Do not start another item.

## DONE-CHECK (whole goal)
<exact command(s), e.g. `npm test && npm run build`> — DONE only when this passes clean.

## Rules
- One item per iteration. No batching. Leave the tree working on exit.
- Never weaken a test, stub, or fake-pass to force a check green.
- SLICE-VERIFY uses the item's own "done when"; DONE-CHECK is the full gate.
```

**PROGRESS.md — plan + append-only memory. The only thing carrying state between runs.**

```md
# Progress — <goal>
Plan is the work list; Log is append-only history. Never rewrite the log.

## Plan
- [ ] slice 1 — done when: <cheap check for this slice> (attempts: 0)
- [ ] slice 2 — done when: <cheap check> (attempts: 0)

## Log
<!-- iterations append below -->
```

**ralph-loop.sh — the runner.** Don't regenerate it — copy the ready script: `cp <skill>/scripts/ralph-loop.sh <user-dir>/`. It's task-agnostic (CLI via `AGENT`, caps via `MAX`/`STALL`), so it ships verbatim. Reads `PROMPT.md`/`PROGRESS.md` and honours `RALPH_DONE`/`RALPH_STUCK` sentinels beside it.

## Step 4 — Review with the user
Walk them through running it with their CLI. Confirm: DONE-CHECK really means done; each slice's "done when" is a real check; PROMPT.md is under 4K.

## Why each piece
- **Fresh context each run** — no accumulated confusion, no doubling down on a bad earlier choice. Cost: zero memory, paid for by PROGRESS.md.
- **Two-tier verify** — slice-verify is the cheap inner check that *this* increment works; DONE-CHECK is the authoritative full gate. A memoryless agent given only a full-suite check either runs it slowly every time or fakes a weaker one.
- **Attempt counter + STALL backstop** — the agent can't remember it already failed an item, so the count lives in PROGRESS.md; the runner's no-progress diff catches a loop that churns without logging.

## Checklist
- [ ] Gate run: all six criteria checked against request + repo
- [ ] Failed criteria grilled one-at-a-time, scoped, recommend-then-confirm; passed ones skipped
- [ ] Methodology pinned: dev discipline in loop step 4; CLI reserved keywords (`ultracode`) / commands (`/tdd`) verbatim, not paraphrased
- [ ] DONE-CHECK is an agent-run command, not a human judgement
- [ ] Plan lives in PROGRESS.md with per-item "done when" + attempts; NOT in PROMPT.md
- [ ] PROMPT.md self-contained, idempotent, char-counted under 4K
- [ ] Anti-fake-done rule present; tree left working on exit
- [ ] Runner honours RALPH_DONE / RALPH_STUCK, has MAX cap and STALL backstop
- [ ] Walked the user through running it with their CLI
