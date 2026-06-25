---
name: handover
description: Fully delegates a task to a subagent for complete execution. Main agent writes a handoff doc via /handoff, subagent executes the ENTIRE task, subagent writes its own handoff doc via /handoff, main agent reads and reports results. Use when user says "/handover <task>", "pass this to a subagent", "delegate this", "have a subagent do X".
---

# Handover

Fully execute a task inside a subagent. Main agent only provides context and reports results — all work happens in the subagent.

## Critical rule

**The subagent executes the complete task.** Main agent does NOT start the work, explore code, or make partial decisions before handing off. Only exception: user explicitly says "do X on main agent, then handover Y to subagent."

## Workflow

### 1. Obtain handoff doc

If a handoff doc was already written earlier in this session, decide whether it still covers the context the subagent needs. Use your judgment — if nothing meaningful changed since that doc was written (no new decisions, no significant code changes, no shifted direction), reuse it. Tell the user which doc you're reusing and why.

If context has meaningfully evolved, or no handoff doc exists yet in this session, invoke `/handoff` to produce a fresh one.

> **Override:** User can force a fresh doc with `/handover --fresh <task>` or say "create a new handoff."

### 2. Spawn subagent
Spawn a subagent using your harness's subagent tool (e.g. the `Task` or `Agent` tool). The subagent prompt must include:
- Path to the handoff doc (cached or freshly written)
- The complete task verbatim — do NOT trim or pre-solve any part of it
- Working directory (current project path)
- Instruction: "Execute this task fully and completely. At the end, invoke `/handoff` to write your conclusions and results so the parent agent can read them. Note the path it saves to."

### 3. Read conclusions
After the subagent returns, read the conclusions handoff doc path it reported.

### 4. Report to user
Summarize what was done, what changed, any blockers or follow-up needed.

## Checklist

- [ ] Decided: reuse existing handoff doc OR create fresh one (stated reasoning to user)
- [ ] If reusing: confirmed context still covers what subagent needs
- [ ] If fresh: `/handoff` invoked, new doc path noted
- [ ] Main agent did NOT start executing the task before handing off
- [ ] Subagent prompt includes: handoff doc path, full task verbatim, working dir, instruction to run `/handoff` at end
- [ ] Subagent spawned via the harness's subagent tool
- [ ] Conclusions handoff doc read after the subagent returns
- [ ] User informed of results + any required follow-up
