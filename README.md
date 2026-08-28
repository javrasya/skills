# Skills

My collection of agent skills — small, composable instruction files that coding agents load on demand. Structure and conventions follow [Matt Pocock's skills repo](https://github.com/mattpocock/skills).

## Install

Symlink every skill into your agent's local skill directories:

```bash
./scripts/link-skills.sh
```

This links each skill into `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Agent-Skills-standard harnesses). A `git pull` then keeps installed skills current.

## Prerequisites

Skills that depend on other skills carry them in-repo, so the link script installs everything they need (see [ADR-0001](./docs/adr/0001-vendor-external-skill-dependencies.md)). What cannot be vendored is the **environment**:

| skill | needs |
|---|---|
| [pull-spiderman](./skills/engineering/pull-spiderman/SKILL.md) | the [`gh`](https://cli.github.com) CLI, authenticated against the repo |
| [code-review](./skills/engineering/code-review/SKILL.md) | a `docs/agents/issue-tracker.md` in the target repo, so it can fetch the originating issue |
| [implement-spec-in-workflow](./skills/engineering/implement-spec-in-workflow/SKILL.md) | `gh`; git **worktree** support; and a harness with a **workflow primitive** that runs a script of `agent()` calls — Claude Code's `Workflow` tool, or an equivalent |
| [ralph-goal](./skills/productivity/ralph-goal/SKILL.md) | an agent CLI runnable headlessly in a shell loop |

## Reference

These split on one axis — who can invoke them. **User-invoked** skills are reachable only when you type them (e.g. `/pull-spiderman`); their job is to orchestrate. **Model-invoked** skills can be invoked by you _or_ reached for automatically by the agent when the task fits; they hold the reusable discipline. A user-invoked skill may invoke model-invoked skills, but never another user-invoked one.

### Engineering

**User-invoked**

- **[pull-spiderman](./skills/engineering/pull-spiderman/SKILL.md)** — Triage and answer the review comments on a PR (left by any reviewer — agent or human). Double-challenges each comment adversarially, drafts a short reply, and gates every reply/resolve/fix behind per-comment human approval.
- **[implement-spec-in-workflow](./skills/engineering/implement-spec-in-workflow/SKILL.md)** — Implement a whole spec issue and its tickets as one PR, driven by a dynamic workflow of subagents. Schedules against the ticket graph's frontier, gives each ticket its own worktree, reviews every ticket before it merges, and serialises the merges — while the orchestrating agent reads nothing but the summary.

**Model-invoked**

- **[code-review](./skills/engineering/code-review/SKILL.md)** — Review a diff since a fixed point on two axes — standards and spec — in parallel subagents, reported side by side. _Vendored from Matt Pocock's repo._

### Productivity

**User-invoked**

- **[handover](./skills/productivity/handover/SKILL.md)** — Fully delegate a task to a subagent: the main agent only provides context (via a handoff doc) and reports results; the subagent does all the work.
- **[handover-loop](./skills/productivity/handover-loop/SKILL.md)** — `handover` wrapped in an adversarial review loop: each round a fresh subagent does the work, the main agent reviews the real diff, looping until the review is clean.
- **[handoff](./skills/productivity/handoff/SKILL.md)** — Compact the current conversation into a handoff document so another agent can continue the work. _Vendored from Matt Pocock's repo._
- **[learn](./skills/productivity/learn/SKILL.md)** — Problem-first, fail-forward lesson on a system, concept, or codebase: five phases (orient, confront, reveal, practice, own it), leaving C4 diagrams and ADRs in the repo.

**Model-invoked**

- **[challenge](./skills/productivity/challenge/SKILL.md)** — Critically reassess a statement instead of reflexively agreeing. Pressure-tests a claim or line of reasoning.
- **[caveman](./skills/productivity/caveman/SKILL.md)** — Ultra-compressed communication mode: drops filler, articles, and pleasantries while keeping full technical accuracy.

## How these skills relate

`pull-spiderman` orchestrates the others: it delegates via `handover`, hardens fixes via `handover-loop`, runs its adversarial passes with `challenge`, and writes PR replies in the `caveman` voice. `handover-loop` builds on `handover`, which (like the subagents it spawns) uses `handoff` to pass context.

`implement-spec-in-workflow` is the other orchestrator, and it delegates to a script rather than to itself: every subagent it spawns lives inside one workflow run, and `code-review` is what its reviewers invoke — once per ticket before that ticket merges, then once over the whole merged branch. Where `handover-loop` reviews **after** the work lands and re-delegates the whole task each round, its gate reviews **before** each merge and re-fixes only the finding.

See [`CONTEXT.md`](./CONTEXT.md) for the shared vocabulary and [`docs/adr/`](./docs/adr/) for design decisions.

## Attribution

`handoff`, `caveman` and `code-review` are vendored from [Matt Pocock's skills repo](https://github.com/mattpocock/skills) so this repo stays self-contained — see [docs/adr/0001](./docs/adr/0001-vendor-external-skill-dependencies.md).

A vendored copy drifts as upstream moves. [`vendor.tsv`](./vendor.tsv) records where each vendored file came from and the upstream sha we last reviewed; the check reports when upstream has moved past it:

```bash
./scripts/check-vendored.sh          # report
./scripts/check-vendored.sh --diff   # show what changed upstream
./scripts/check-vendored.sh --update # pull it in and re-pin
```

The pin tracks **upstream**, not our copy — a vendored file is expected to differ locally (attribution headers, genericization), so what matters is whether upstream changed since we last looked. `--update` overwrites those local edits, so read the diff and restore the attribution header before committing. `caveman` has no discoverable upstream in that repo and is not tracked.
