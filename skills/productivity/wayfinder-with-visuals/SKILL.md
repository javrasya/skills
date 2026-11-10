---
name: wayfinder-with-visuals
description: "Run wayfinder on a map or ticket, with every grilling ticket worked as a grill-with-visuals session: each round a local HTML page instead of chat alone."
disable-model-invocation: true
---

This skill is `wayfinder` with one swap: a ticket labelled `wayfinder:grilling` is resolved through `grill-with-visuals`. Everything else (loading the map, choosing and claiming the ticket, the other ticket types, recording the resolution, graduating fog) is wayfinder's, unchanged.

Both are user-invoked skills, so the Skill tool can't reach them. Read their files and follow them as if invoked:

- **wayfinder**: `wayfinder/SKILL.md` in the installed skill directories (`~/.claude/skills/`, then `~/.agents/skills/`). Not in this repo; if neither has it, stop and tell the user to install it.
- **grill-with-visuals**: [`../grill-with-visuals/SKILL.md`](../grill-with-visuals/SKILL.md). Its asset and script paths resolve against its own folder.

## Steps

1. **Run wayfinder** with the arguments given (a map, a ticket such as `#90`, or a loose idea to chart), following its Invocation section.
2. **At the resolve step, read the ticket's `wayfinder:<type>` label.**
   - `wayfinder:grilling` → follow `grill-with-visuals` in place of wayfinder's "call grilling and domain-modeling". It still calls those two skills itself; it adds the page per round. Use the ticket's name as the grilling topic (`grill-<topic>/`) and link the ticket in each page's context line. The pages stay local files: the resolution comment records the decision in words, as wayfinder says.
   - any other type → resolve it exactly as wayfinder says.
3. **Finish as wayfinder does**: resolution comment, close, context pointer on the map, new tickets and graduated fog.

Charting a new map (wayfinder's grilling to name the destination and map the frontier) has no ticket, so it stays plain wayfinder grilling.
