# Skills

My collection of agent skills — small, composable instruction files that coding agents load on demand. Structure and conventions follow [Matt Pocock's skills repo](https://github.com/mattpocock/skills).

## Install

Symlink every skill into your agent's local skill directories:

```bash
./scripts/link-skills.sh
```

This links each skill into `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Agent-Skills-standard harnesses). A `git pull` then keeps installed skills current.

## Reference

These split on one axis — who can invoke them. **User-invoked** skills are reachable only when you type them (e.g. `/pull-spiderman`); their job is to orchestrate. **Model-invoked** skills can be invoked by you _or_ reached for automatically by the agent when the task fits; they hold the reusable discipline. A user-invoked skill may invoke model-invoked skills, but never another user-invoked one.

### Engineering

**User-invoked**

- **[pull-spiderman](./skills/engineering/pull-spiderman/SKILL.md)** — Triage and answer the review comments on a PR (left by any reviewer — agent or human). Double-challenges each comment adversarially, drafts a short reply, and gates every reply/resolve/fix behind per-comment human approval.

### Productivity

**User-invoked**

- **[handover](./skills/productivity/handover/SKILL.md)** — Fully delegate a task to a subagent: the main agent only provides context (via a handoff doc) and reports results; the subagent does all the work.
- **[handover-loop](./skills/productivity/handover-loop/SKILL.md)** — `handover` wrapped in an adversarial review loop: each round a fresh subagent does the work, the main agent reviews the real diff, looping until the review is clean.
- **[handoff](./skills/productivity/handoff/SKILL.md)** — Compact the current conversation into a handoff document so another agent can continue the work. _Vendored from Matt Pocock's repo._

**Model-invoked**

- **[challenge](./skills/productivity/challenge/SKILL.md)** — Critically reassess a statement instead of reflexively agreeing. Pressure-tests a claim or line of reasoning.
- **[caveman](./skills/productivity/caveman/SKILL.md)** — Ultra-compressed communication mode: drops filler, articles, and pleasantries while keeping full technical accuracy.

## How these skills relate

`pull-spiderman` orchestrates the others: it delegates via `handover`, hardens fixes via `handover-loop`, runs its adversarial passes with `challenge`, and writes PR replies in the `caveman` voice. `handover-loop` builds on `handover`, which (like the subagents it spawns) uses `handoff` to pass context. See [`CONTEXT.md`](./CONTEXT.md) for the shared vocabulary and [`docs/adr/`](./docs/adr/) for design decisions.

## Attribution

`handoff` and `caveman` are vendored from [Matt Pocock's skills repo](https://github.com/mattpocock/skills) so this repo stays self-contained — see [docs/adr/0001](./docs/adr/0001-vendor-external-skill-dependencies.md).
