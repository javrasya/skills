# ADR-0001: Vendor external skill dependencies instead of soft-referencing them

## Status

Accepted — 2026-06-25

## Context

The skills migrated into this repo depend on skills that originated elsewhere:

- `handover`, `handover-loop`, and `pull-spiderman` all call `/handoff` — the **handoff** skill authored by Matt Pocock. In the author's environment `handoff` was a symlink to `~/.agents/skills/handoff`, outside this repo.
- `pull-spiderman` writes PR replies in a compressed voice provided by the **caveman** skill — also an out-of-repo symlink.

A copy of a skill directory does not carry its symlinked dependencies. Published as-is, these skills would silently break for anyone who lacks the external skills.

Three options:

1. **Soft dependency** — reference the external skills as optional ("use your handoff skill if available, else summarize inline"). No republishing, but the skills degrade and behave inconsistently.
2. **Declare as prerequisite** — keep hard calls, document that the user must install the external skills separately. Simple, but breaks silently when unmet.
3. **Vendor** — copy the external skills into this repo so it is self-contained.

## Decision

**Vendor** `handoff` and `caveman` into `skills/productivity/`, with upstream attribution preserved. `pull-spiderman`'s adversarial passes were additionally repointed from the external PAL `challenge` MCP tool to the in-repo `challenge` skill, removing that external dependency too.

The repo is now self-contained: cloning it (and running the link script) installs every dependency the migrated skills need.

## Consequences

- **Self-contained and predictable.** Every skill's dependencies travel with the repo; no silent breakage.
- **We carry copies of others' work.** `handoff` is Matt Pocock's. We must preserve attribution and stay aware that upstream changes do not propagate automatically — vendored copies can drift from their origin.
- **The genericization norm applies to vendored skills too.** They were checked for leaks before inclusion (both were already audience-neutral).
