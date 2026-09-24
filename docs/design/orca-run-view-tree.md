# Orca run view: the tree

The reference design for the Orca runner's [run view](../../CONTEXT.md) (spec #43, ADR-0012). It came from a throwaway prototype on branch `prototype/orca-run-view`, which you can run with `npm start` in `skills/engineering/implement-spec-in-workflow/orca/prototype-run-view/` for the live behaviour.

![The run view's tree: three phases folded, the failed agent selected](orca-run-view-tree.png)

## Check your work against this

- **Layout:**
  - A header: the run's name, project, Run id, spec, whether the runner is alive, and elapsed time. Under it, the number of agents in each state.
  - One row per phase. When the phase is unfolded, one row per agent sits under it.
  - A bottom pane that describes the selected row.
  - A key-help line.
- **Phase row:**
  - `▾` when unfolded, `▸` when folded.
  - The phase name, `done/total done`, and the mix of states as glyph and count (`●2 ◐1 ✗1 ·2 ✓4`).
  - When folded, also `peak ctx` for the phase.
  - Clicking the row, pressing Enter, or using ←/→ folds and unfolds it.
- **Agent row:**
  - The agent's number, its label, and its state as a glyph and a word (`✓ done`, `✗ failed`, `◐ stuck`, `● running`, `↻ continued ×N`, `· queued`).
  - A context bar with the context size.
  - Cumulative tokens, and elapsed time.
  - An agent that never started shows `—` for context and tokens.
- **Bottom pane for a selected agent:**
  - `[Phase] label`, then its state, context, total tokens and elapsed time.
  - `worktree`, `tab` and `session` (`—` when there is none).
  - `reason` when the agent failed or is stuck.
  - The transcript path.
- **Bottom pane for a selected phase:** its failed and blocked agents, each with its reason.

## What the image does not decide

- **Ignore the bottom status bar** (`Tree  Lanes  Timeline  Tab ▸ next layout … PROTOTYPE`). It belonged to the prototype's layout toggle, which was dropped. The run view has one layout.
- **Colours:**
  - The screenshot's terminal theme flattens them.
  - Context size and its bar are coloured by band: green below 200k, yellow from 200k to 350k, red above 350k.
  - States have their own colours. Cumulative tokens are grey. The selected row is shown inverted.
- **Exact spacing and column widths** are a guide, not a contract.

## Plain-text capture

The same screen with colour removed, from the prototype at 140 columns. The status bar is left out.

```
 implement-spec-783 · controlayer · run_55d94954c294 · spec #783 W5.2 · runner ● alive · 1h35m
 ● 2 running  ↻ 1 continued  ◐ 1 stuck  · 3 queued  ✓ 8 done  ✗ 1 failed
────────────────────────────────────────────────────────────────────────────────────────────────
   #   AGENT                    STATE            CONTEXT           TOKENS   ELAPSED
 ▸ Discover   1/1 done    ✓1   peak ctx 118k
 ▸ Layer0     1/1 done    ✓1   peak ctx 64k
 ▾ Implement  4/10 done   ●2 ◐1 ✗1 ·2 ✓4
    3   impl:#1159:s1          ✓ done           ████░░░░░░ 181k     5.2M    28m00s
    6   impl:#1160:s1          ✓ done           ██████░░░░ 311k     9.1M    42m00s
    7   impl:#1160:s2          ● running        ███░░░░░░░ 153k     2.3M    38m01s
   14   impl:#1087:s1          ✓ done           █████░░░░░ 258k     8.6M    33m00s
   17   impl:#1087:s2          ✗ failed         ░░░░░░░░░░             —     8m00s
   18   impl:#1158:s1          ✓ done           ████░░░░░░ 204k     6.0M    30m00s
   21   impl:#1162:s1          ◐ stuck          ██████░░░░ 291k     7.7M     1h04m
   22   impl:#1163:s1          ● running        █░░░░░░░░░  63k     940k    12m01s
   30   impl:#1154:s1          · queued         ░░░░░░░░░░             —         —
   31   impl:#1156:s1          · queued         ░░░░░░░░░░             —         —
 ▾ Gate       1/2 done    ↻1 ✓1
    4   gate:#1159:r1          ✓ done           ██░░░░░░░░  92k     1.4M     8m00s
   28   gate:#1158:r1          ↻ continued ×1   ████████░░ 383k    12.4M    50m01s
 ▸ Publish    1/1 done    ✓1   peak ctx 41k
 ▾ Integrate  0/1 done    ·1
   40   integration            · queued         ░░░░░░░░░░             —         —
────────────────────────────────────────────────────────────────────────────────────────────────
 [Implement] impl:#1087:s2  ✗ failed  ctx —  total —  8m00s
 worktree run_55d94954c294-17   tab term_20ddf   session —
 reason worker did not start: orca worktree create timed out after 60s (3/3 attempts)
 transcript ~/.claude/projects/…-run-55d94954c294-17/(none).jsonl

 ↑↓ move · ←→ / click a phase to fold · ⏎/click focus tab · r reclaim · R resume · e end-of-run · s all runs · q quit
```
