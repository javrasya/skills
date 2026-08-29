# The per-ticket workflow

How the driver authors and runs the one `Workflow` call that turns a ticket into a green branch. Read this before step 5 of the tick.

**Stages are fixed. Fan-out width and lens choice are derived from the ticket body by the driver, before the `Workflow` call.**

| Stage | Fixed | Dynamic knob | Agents |
|---|---|---|---|
| **Understand** | parallel readers → structured map of touched modules, parent-spec decisions, relevant ADRs; also judges whether the ticket settles a decision worth an ADR | which modules — from the ticket's **What to build** | ≤ 3 |
| **Implement** | one agent, serial, TDD in the worktree | none — a code change must be one coherent hand | 1 |
| **Review** | parallel lenses; **standards** and **spec** always present, mirroring `/code-review`'s two axes | *extra lenses* from the ticket — a11y for a rendering ticket, race-safety for the poller, encoding-contract conformance for a view ticket | ≤ 4 |
| **Record** | writes the ADR and amends any existing ADR the ticket changed | skipped only when Understand judged the ticket purely mechanical — and the brief says so | 1 |
| **Verify** | one adversarial refuter per **acceptance criterion**, prompted to prove it unmet; "the ADR was written" is an implicit criterion | *count of criteria* — from the ticket | 1 per criterion |

**The verify fan-out *is* the ticket's acceptance criteria.** So the returned verdict is exactly the gate the driver needs in order to decide whether to close the issue — and it is also, verbatim, the PR body's criteria table.

### Two decisions the driver cannot make in advance

Both of the dynamic-knob rows above depend on a judgement **Understand** makes *inside* the workflow, while the script is authored *before* the call. Neither can live in the `args`; both are branches in the script, driven off the returned map.

**1. Record is skipped only when the ticket is purely mechanical.** The `MAP` schema therefore carries a boolean — *does this ticket settle a decision worth an ADR?* — because that is the only channel by which Understand's judgement can reach the Record phase. The Record phase branches on it; the driver reads the same field off the returned map and, when Record was skipped, **says so in the brief** (item 3) and in the PR body.

**2. "The ADR was written" is an implicit criterion**, and the script appends it to the Verify fan-out — the driver does not put it in `criteria`. So an N-criterion ticket runs **N+1** refuters and the PR's criteria table has **N+1** rows, and when Record was skipped the criterion is not appended and the count is N.

## Budget

The base pass is sized against the session's under-15-agent guideline: **3 + 1 + 4 + 1 + N criteria** — 15 for a six-criterion ticket, fewer for most.

**With one correction, and it binds.** The Verify fan-out is **N+1** in practice, because the implicit ADR criterion is appended inside the script; only when Record is skipped is it not appended and the fan-out exactly N. So a six-criterion ticket is really 3 + 1 + 4 + 1 + **7** = **16** — one over. The 15 in the line above is the arithmetic before the implicit criterion, not a budget a six-criterion ticket actually hits.

**When the total would exceed 15, trim Understand — never drop the extra refuter.** That is the resolution, and it is the only one: Understand is the one stage that gives ground cheaply, because its output is a map and a 3-reader map is nearly as good as a 5-reader one. Two readers instead of three brings a six-criterion ticket back to 15. Trim Understand first and, if a ticket is somehow still over, trim it again before touching anything else. **Never trim Verify** — the adversarial pass is the only thing standing between "an agent said it's done" and the gate closing an issue, and the implicit ADR criterion is the only check that the Record stage did its job.

**Repair rounds are allowed to exceed it.** A repair round only happens when something is actually wrong, and that is precisely when the agents are worth spending.

## Model and effort

All stages inherit the session model.

- **`effort: 'low'`** for the Understand readers — reading, not reasoning.
- **default effort** for Implement, Review and Record.
- **`effort: 'high'`** for the Verify refuters.

## Working directory and toolchain

Two things every agent prompt carries, verbatim. Neither is optional and neither is the driver's business alone — these agents run the repo's toolchain themselves.

**1. The absolute chain-worktree path** — `<repo-root>/.worktrees/chain`, written out in full, in the form the agents' shell expects. The driver session's cwd is the main checkout, and an agent that edits the wrong tree corrupts the stack silently. The root was resolved at the skill's arm step 0; never pass a relative path and never pass a shell variable, because shell state does not survive between tool calls.

**2. The repo's environment prerequisites**, as one literal block, with the instruction to put them in the **same shell call as every command that builds or tests** — shell state does not survive between an agent's tool calls any more than between the driver's. The driver resolves that block once at arm time; see the skill's *Local toolchain*.

Where a repo has such prerequisites, an agent running without them gets results that **are a lie** — including a TDD "red" that is really a broken build — and, where the prerequisite pins a build-output directory, leaves artefacts that poison the tree for the pre-flight and for every later ticket of the run. A repo with no prerequisites passes an empty block, and the rule costs nothing.

**Implement and Verify are exactly the agents this is about.** Implement is one serial TDD loop, which means running the test suite over and over; the Verify refuters build and run in the same tree to prove a criterion unmet. The bad state this guards against is a thing *these agents produce*, not the driver, so a rule that reaches only the driver's own tool calls leaves the guard inert.

## Reference script shape

```js
export const meta = {
  name: 'implement-ticket',
  description: 'Implement one spec ticket: understand, build, review, record, verify',
  phases: [
    { title: 'Understand' }, { title: 'Implement' },
    { title: 'Review' }, { title: 'Record' }, { title: 'Verify' },
  ],
}

// `worktree` is the absolute chain-worktree path; `env` is the repo's environment
// prerequisites as one literal block, pasted into every prompt whose agent builds or
// tests. See above — an agent without them reports lies for the rest of the run.
const { ticket, worktree, env, modules, lenses, criteria } = args

phase('Understand')
const map = (await parallel(modules.map(m => () =>
  agent(`In ${worktree}, read ${m} …`, { phase: 'Understand', effort: 'low', schema: MAP })
))).filter(Boolean)

phase('Implement')
await agent(`In ${worktree}, implement #${ticket.number} TDD …
Run every build/test command in the same shell call as this block:\n${env}`,
  { phase: 'Implement' })

phase('Review')
const findings = (await parallel(lenses.map(l => () =>
  agent(`Review the diff in ${worktree} through the ${l} lens …`, { phase: 'Review', schema: FINDINGS })
))).filter(Boolean)

phase('Record')
// Understand's judgement, not the driver's — the map is the only channel it can arrive through.
const mechanical = map.length > 0 && map.every(m => m.worthAnAdr === false)
if (!mechanical) {
  await agent(`In ${worktree}, write the ADR … number = max in docs/adr + 1 …`, { phase: 'Record' })
}

phase('Verify')
// "the ADR was written" is an implicit criterion — appended here, never passed in `criteria`.
const toVerify = mechanical ? criteria : [...criteria, 'the ADR was written']
const verdicts = (await parallel(toVerify.map(c => () =>
  agent(`Prove criterion "${c}" is NOT met in ${worktree}. Default to unmet if uncertain.
Run every build/test command in the same shell call as this block:\n${env}`,
        { phase: 'Verify', effort: 'high', schema: VERDICT })
))).filter(Boolean)

// `map` is returned so a repair round can be handed it instead of re-reading the modules.
return { verdicts, findings, map, recordSkipped: mechanical }
```

**The barriers between phases are correct.** Implement needs the whole map; Verify needs the finished tree.

**`Date.now()`, `Math.random()` and argless `new Date()` are unavailable in scripts.** Stamp anything time-based after the workflow returns.

## Repair rounds

**A repair round is a new `Workflow` call that carries the previous one's output forward.** There is no continuation or resume facility — do not go looking for one.

What makes a round cheap is not that a workflow is still running; it is that **the driver still holds everything a fresh session would have to rebuild**: Understand's map, because the workflow returned it; the worktree on disk, with its warm build cache and installed dependencies and the ticket's branch already cut and already carrying the work; and the refuters' evidence, verbatim. A re-arm has none of that. So the round must pass all of it in explicitly, or it starts blind and is a re-arm wearing a workflow's clothes.

A round carries, in `args`:

- **Understand's map from the first call** — the script returns it for exactly this reason — and the round therefore **declares and runs no Understand phase**; re-reading the modules is the expensive half of a re-arm and the whole thing the map exists to avoid;
- the criteria the refuters returned as **unmet**, verbatim;
- the refuters' evidence, or the failing CI job name and log excerpt;
- the same `worktree` path and the same environment block.

Verify runs its **full** fan-out again, not only the previously-unmet criteria — a repair that breaks a criterion which used to pass has to be caught, and the returned verdict is also the PR's criteria table.

**Two rounds maximum, counted per ticket and shared with every other kind of red** — an unmet criterion, a red pre-flight and a red CI build all draw on the same two. That counter lives in the driver; see the skill's *Failure and repair*. After it is spent the ticket is more likely wrong than the code — hand it back to the operator per the skill's failure path.
