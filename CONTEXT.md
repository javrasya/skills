# Context

Glossary for this repo. This repo is a **collection of agent skills** — its "domain" is skills themselves, not application code. Skills are small, composable instruction files an agent loads on demand.

## Glossary

### Skill

A directory containing a `SKILL.md` (frontmatter `name` + `description`, then instructions). Lives under `skills/<category>/<name>/`. Categories follow the upstream convention: `engineering`, `productivity`, `misc`.

### User-invoked skill

A skill reached **only** when the user types it (e.g. `/pull-spiderman`). Its job is to orchestrate. A user-invoked skill may invoke model-invoked skills, but never another user-invoked one.

### Model-invoked skill

A skill the agent may reach for **automatically** when the task fits, as well as on explicit request. Holds reusable discipline (e.g. [[challenge]], [[caveman]]).

### Vendored skill

A skill **copied into this repo** that originated elsewhere, kept here so the repo is self-contained rather than depending on a symlink to an out-of-repo location. Vendored skills keep upstream attribution. `handoff` and `code-review` (from Matt Pocock) and `caveman` are vendored. See ADR-0001.

A vendored copy **drifts** as upstream moves. `vendor.tsv` pins, per file, where it came from and the upstream sha last reviewed; `scripts/check-vendored.sh` reports, diffs or pulls when upstream moves past that pin. The pin tracks **upstream**, not our copy — a vendored file is expected to differ locally (attribution headers, [[genericization]]), so comparing the two would report drift forever.

### Handoff doc

A compacted summary of a conversation written to the OS temp dir so a fresh agent can continue work. Produced by the `handoff` skill. The unit of context passed from a main agent to a subagent and back.

### Handover

Full delegation of a task to a subagent: the main agent only provides context (via a handoff doc) and reports results; the subagent does all the work.

### Handover loop

A handover wrapped in an **adversarial review loop**: each round a fresh subagent does the work, the main agent reviews the real diff trying to disprove "done", and a new fresh subagent takes the next round until the review is clean.

### Reviewer

The author of a PR review comment — **any** agent (Copilot, Claude, etc.) or human. The `pull-spiderman` skill is reviewer-agnostic; it is not specific to GitHub Copilot.

### Genericization

The norm that every skill in this repo must be free of personal info (individual traits, language background), company/proprietary identifiers (internal service names, domain identifiers), and over-narrow framing (one tool/language when the skill is broader). Skills here are for a broad audience.

### Ralph (Wiggum) loop

A brute-force agent pattern: feed **the same fixed prompt** to an agent CLI in a shell `while`-loop. The agent has **no memory between runs** — each iteration is a fresh context. All state lives in files the prompt points at. Produced by the [[ralph-goal]] skill as three artifacts: a **goal prompt** (the unchanging spec, kept under 4K chars — Claude Code's `-p` limit), a **progress file** (plan + append-only log, the only cross-iteration memory), and a **runner** (the loop). An iteration does **one verified slice** then exits. Two-tier verification: a cheap **slice-verify** ("done when" per plan item) proves the increment; a **DONE-CHECK** (full command, agent-run not human-judged) gates the **sentinel** file (`RALPH_DONE`) that stops the loop. Convergence is not assumed — the runner has a `MAX` cap, a `STALL` no-progress backstop, and an attempt counter per slice that trips `RALPH_STUCK` for a human.

### Maturity gate

The readiness check [[ralph-goal]] runs **before** drafting a Ralph loop. A goal is loopable only if all six hold: **checkable DONE** (agent-run command), **bounded** (a finish line), **sliceable** (a memoryless context can do one increment), **per-slice verify** (checkable before the next slice, not only at the end), **starting state** (target files exist or iteration 1 creates them), **rollback-safe** (a bad iteration can't corrupt what the next depends on). Fail any → the skill grills the user on **only the failed criteria**, one at a time. Contrast with [[challenge]]/grill skills that interview unconditionally; the gate grills only to close a gap that would make the loop spin forever.

### C4 model

The diagram system the [[learn]] skill's interactive experience renders. **Four nested zoom levels of one static model**: System Context (L1) → Container (L2) → Component (L3) → Code (L4). A *Container* here is a separately-runnable app or data store (**not** a Docker container); a *Component* is a grouping of functionality inside one container. Visual grammar that makes a diagram actually C4 (not "just boxes"): every element carries a type tag (`[Person]`/`[Software System]`/`[Container: tech]`/`[Component: tech]`) + description; people use a distinct glyph; in-scope vs external is shown by colour **and** position (never colour alone); relationships are directional, labelled with intent + `[technology]`; each diagram has a title and a legend. Semantic zoom = one box becomes a dashed **boundary**, its children appear inside, neighbours project onto the edge. **Static vs dynamic:** a static diagram (Context/Container/Component) shows *all* relationships at once — many paths is correct. A **Dynamic** diagram shows runtime *ordering*, and C4 allows only **one scenario per dynamic diagram**; never fake runtime sequence on a static diagram, and never cram two numbered sequences into one. In the [[learn]] experience a runtime scenario is depicted by a module's single `trace` — two runtime stories become two modules, not two flows in one diagram.

### 4+1 (not C4)

Kruchten's "4+1" architecture view model — Logical, Process, Development, Physical views + Scenarios. A **trap to avoid**: it is *not* C4. 4+1 is four orthogonal *views* of one system (different concerns); C4 is four *zoom levels* of one nested hierarchy. The [[learn]] experience uses C4 semantics only; do not let diagram code drift toward 4+1.

### Task graph, and its frontier

A spec's tickets are **not** a list of steps: they are a graph whose edges are blocking relationships, so at any moment some set of tickets has all its blockers satisfied — the **frontier**. **The definition of *takeable* lives in one place** — `docs/agents/frontier.md`, named from `CLAUDE.md` — and every skill that walks the graph reads it from there rather than restating it, because a second copy of the query is how two skills come to mean different things by the same word. That fragment also carries the fact that **an empty frontier is never "nothing to do"**: it is five distinct facts (finished / all blocked / gated by a human ticket / all assigned / a triage gap), and a skill halting on one says which. [[implement-spec-in-workflow]] schedules against the frontier rather than in phases: each ticket is one memoised promise awaiting its dependencies' *publishes*, so a ticket starts the instant its blockers' PRs exist and a run costs the longest chain rather than the sum of the phases. Blocking edges usually live as **prose** ("Blocked by #12") rather than in GitHub's sub-issue or dependency APIs, which are frequently empty even when the tickets exist — so they are read by an agent, not queried. A ticket needing a human (hardware, a running game, credentials only a person holds) is excluded along with everything downstream of it, and what was dropped is named rather than silently skipped.

### Serial lane

The single-slot queue through which parallel work reaches the run's shared line — whatever that line is. In [[implement-spec-in-workflow]] the lane **publishes**: it takes each finished ticket branch in turn, rebases it onto the current stack tip (legal, because the branch has no PR yet — see [[publish-once]]), pushes, opens the next PR of the stack, and **registers the stack as it now stands** (see [[native-stack]]). Two agents publishing concurrently would base on the same tip, which is the failure the arrangement exists to prevent — it is the one part of the run that must not be parallelised for speed. Registration lives here for the same reason: two concurrent `gh stack link` calls against one stack is that same race, so the lane is the only place in a parallel run that may hold it.

### The shared clone, and run-created vs inherited refs

Every agent of a run works in a worktree **linked to one clone** — one object store, one ref namespace — so a commit any agent makes is reachable by name from every other the moment it lands. **The shared clone, not origin, is how work passes between agents**, which is why a ticket branch stays local until it is published.

That splits refs in two, and the split is what every agent's instructions turn on. A ref **this run created** is authoritative locally and may not exist on origin at all. A ref the run **inherited** — the base branch, prior work on a start ref — is authoritative on origin, where the operator or another machine may have moved it, so it is fetched and addressed there.

Two consequences an agent cannot guess and is therefore told. Git **refuses to check out a branch another worktree holds**, and a run's worktrees outlive the agents that made them — so an agent starts from a detached HEAD and moves the branch with `update-ref`, which succeeds exactly where `checkout` and `branch -f` are refused. And a **refusal is a stop**, never something to route around by inventing a branch name: an observed run answered that refusal with `slice1/227` and `ticket-227-slice2`, stranding one agent's work on a ref nobody published and paying a second agent to redo it.

### Publish-once

The invariant that keeps a stack safe to build in parallel: **a branch reaches origin exactly once, and the push that puts it there creates it.** Every agent before the serial lane commits locally; the lane's rebase-onto-the-tip rewrites only commits that have never left the clone, and its single push creates a ref that did not exist. So **no ref on origin is ever rewritten by a run** — not narrowed to "only ones nothing depends on", but never — and there is no force-push anywhere to authorize. Rewriting published history in a stack gives every child PR a phantom diff, so the line between "may rewrite" and "may not touch" is the moment a commit leaves the clone, not anyone's care. Cross-ticket fixes from the whole-stack review land as a new **integration PR** on top, never as pushes into the layers below. See ADR-0005.

The cost is that in-flight work is invisible until it publishes: a run that dies leaves its commits in the operator's clone under refs the run's summary names, not on origin where anyone could look.

### Gate loop, and the rejection ledger

Reviewing a change **before** it merges, on its own branch, against its own ticket — while the diff is small and its author's reasoning is still recoverable. Review and fix alternate until a review returns nothing blocking, **a fresh reviewer each round**, so "clean" is a verdict rather than one reviewer running out of patience; a round cap merges what is unresolved and names it rather than stalling everything downstream. The fixing half of the round goes through the [[dispatcher]] like any other work.

The loop's hazard is not slow convergence but **ping-pong**: a fixer judges a finding wrong and leaves the code, the next reviewer raises it again, and the pair trade it until the cap. The **rejection ledger** is the cure — a fix slice returns one verdict per finding it owns, `fixed` or `rejected` with a specific checkable reason; rejections accumulate across rounds, and a later reviewer may raise one again only by **falsifying its stated reason**. Without the ledger the loop cannot terminate on a disputed call.

A finding that comes back with **no verdict** — dropped by the dispatcher, or owned by a slice that died — is reconciled **by the script, never by a prompt**: it is named in the log and handed to the next round's reviewer to check explicitly on the branch. Silently assuming it fixed is how a real finding leaves the run. The round is never re-dispatched in place; whatever a slice did not reach falls to the next reviewer, which re-derives what is still broken from the branch itself, so one cap governs the gate rather than two multiplying ones.

Distinct from the [[handover-loop]], which reviews *after* the work lands and re-delegates the whole task each round.

### Attended, unattended, and what comes back

Three skills walk the same ticket graph and differ in **what they hand the operator**. [[implement-next]] is attended: it takes *one* ticket, and a `ready-for-human` pick is a question. [[implement-all]] is unattended: the same pick is a **skip**, because there is nobody to ask, and it walks the whole map serially, one green PR per tick. [[implement-spec-in-workflow]] is unattended too, and emits a stack as well — but built in parallel by a workflow script, one run for the whole spec, registered as a [[native-stack]]. Both unattended skills hand the operator a stack of one-ticket PRs; the axis that separates them is **how the stack is built** — serially by a prose loop that dies and re-arms, or in one frontier-scheduled scripted run — not the unit of output.

### Stack, and the chain worktree

PRs **stack**: each ticket branches from the previous ticket's branch, *unmerged*, so ticket N+1 sees N's work without waiting for a merge. The operator merges; the loop **never merges and never touches `main`** — and published history is never rewritten (see [[publish-once]]). In [[implement-all]] the operator merges bottom-up by hand, and one **chain worktree** serves the whole run (`.worktrees/chain`, cut off the stack tip at arm time), not one per ticket: a fresh worktree pays a cold dependency install and a cold build cache every time, and the tip only ever moves *forward*, so `switch -c` from where it stands is correct by construction. [[implement-spec-in-workflow]] has no chain worktree — its agents are parallel, each in a throwaway worktree, and its stack order is the serial lane's publish order.

### Worktree reclaim

A throwaway worktree in [[implement-spec-in-workflow]] is **per agent, not per ticket** — every slice, reviewer, fixer and publisher gets its own — and all of them link to one clone, so a commit lives in the shared store and the worktree is only a checkout of it. A ticket's worktrees are **reclaimed the moment its PR exists**: [[publish-once]] seals the branch at that instant, so nothing later needs them, and the branch is how the work comes back if it is ever needed again. A worktree is identified by the agent that used it **naming its own path** — never by guessing from git state, because an agent for the next ticket sits clean at the same commit and would be indistinguishable. A worktree goes **dirty or not**: an agent that returned committed what it meant to keep, and the rest is build output — a repo whose build rewrites tracked files makes every worktree dirty, and a rule that spared them would reclaim nothing. What is never removed is the worktree of an agent that **died** before naming its path: it may hold the only copy of that agent's work, so it is named for the operator instead.

### Native stack

GitHub's first-class stacked-PR object (public preview since 2026-07): a registered **Stack** whose members are **layers** over a **trunk**, giving every PR a stack map and the operator **one atomic whole-stack merge from the top PR** — which is what lets `Closes` lines on the layers close every ticket, and the spec, in one operation. **Only [[implement-spec-in-workflow]] registers one** — [[implement-all]] emits the same base-chain PR shape with no Stack object at all, so "both unattended skills emit stacks" is true of the *shape*, not of registration. Registration goes through **`gh stack link` only**: it is stateless, **reconciling** ("existing PRs are never removed"), and pushes without force — every named branch **by local ref**, atomically, so a layer's local ref must **mirror origin** before any call (ADR-0007) — where the rest of the `gh-stack` extension force-pushes (`submit`) or keeps per-worktree state (`.git/gh-stack` resolves via `--git-dir`) — unusable under parallel worktree agents. Every layer must independently satisfy required checks, reviews and CODEOWNERS *against the trunk* before the whole stack merges.

**The stack is registered as it grows, not at the end** (ADR-0006). The [[serial lane]] links after each PR it opens, re-listing the whole stack bottom-to-top every time — because `link`'s stack-number shortcut would make the run carry a number between agents, the same remembered state the derived tip exists to avoid, and re-listing makes every call a repair of every call before it. **Two arguments is `link`'s minimum**, so a single-layer stack is never registered, correctly rather than as a failure. Two constraints hold the arrangement together and are stated in the prompt rather than left to construction: never name a branch whose PR does not already exist (`link` would open one outside the run's control), and never pass `--open` (it readies the drafts, and the drafts are half the in-progress signal — see [[layer line]]).

Where the stacks API is not enabled, a run degrades — by the operator's explicit choice, never silently — to a plain `--base` **chain**: the same PR shape with no Stack object, merged bottom-up by hand with merge commits, deleting each head branch so GitHub retargets the next PR. Registering in the lane adds a case the arm-time gate cannot cover: the API going away **mid-run**, with nobody to ask. There the run degrades and says so **loudly** — the brief's mode reads `chain (degraded mid-run from native)` and its merge instructions switch — because gated, publishable ticket work outweighs a stack map. A `link` failure never fails a publish, and only exit 9 latches: a transient one is repaired for free by the next publish's re-list.

### Layer line

The one-line preamble every PR of a [[stack]] opens with: `Layer k of N planned — spec #S is still being implemented; more layers may follow.` It exists because a growing stack of drafts cannot otherwise say *how many more are coming*, and it is written once at creation and never edited.

Three things it gets exactly right or not at all. **`k` is the actual position in the stack, not the ticket's index in the plan** — the map's fourth box must say "layer 4", so a run that lost three tickets ends on "Layer 4 of 7 planned" and announces its own shortfall before the [[brief]] does. **`N` counts layer 0 plus the automatable tickets**, which is what the operator sees in the map. And **"planned" is load-bearing**: tickets fail and get deferred, so a stack that lands short must read as short rather than broken.

The **integration PR carries no index** — whether it exists at all is unknown until the whole-stack review returns — and says instead that it is the integration layer on top of N planned layers. The line is only half the signal: every layer stays **draft** until finalize, and the ready-flip is what says the run is done adding.

**Tip derivation is from GitHub, never remembered** — the open PR whose head branch is nobody else's base — and is re-derived every tick, because after a green tick the tip is that tick's own PR. A base frozen at arm time builds a flat fan of PRs all rooted at one commit, each carrying every earlier ticket's diff: silent corruption of the run's whole output, not a pause condition.

### Arm and tick

The two-part shape of an unattended loop. **Arming** happens once — fetch, sweep for a previous run's abandoned claim, derive the tip, check the tip's gate, prepare the worktree. A **tick** is one ticket becoming one green PR, and it re-derives everything it needs rather than inheriting shell state, because shell state does not survive between tool calls. The loop is continuous *through tickets*, not through the operator's interventions: **dying is cheap by design**, since a re-armed run derives everything from GitHub and holds no local state.

### Pause condition

A named fact that kills the loop, as opposed to a condition it works around. [[implement-all]] has **fourteen**, and the point of enumerating them is that they must never collapse into "nothing to do" — a brief that says *which* fact it is turns a halt into the operator's to-do list. Five of the fourteen are the empty-frontier facts, discriminated in `docs/agents/frontier.md` rather than locally.

### The brief

The single checkpoint of an unattended run, pushed **all the way out** — there is none inside the loop. Everything the loop did reaches the operator through it: why it stopped, the stack bottom-up in merge order, what needs a human, any flake re-run taken, and the re-arm command. Printed to the session **and** posted as a comment on the map issue, so it survives the dead session and is readable on a phone.

### Flake registry

A hand-seeded list of known-intermittent tests (`docs/known-flakes.md`), checked **before** any CI re-run. It exists because both defaults are wrong: a loop treating every red as a regression burns its repair rounds "fixing" timing tests, and a loop re-running every red hands a genuine regression a free second roll. The re-run licence needs *both* halves — the failing test is named in the registry **and** the branch touched nothing under that test's component. **The loop never writes to the registry**: a driver that appends an entry to make a red go away has granted itself its own licence, so a red that is not already named is real.

### Slice

One PR of a [[stack]], and the unit [[code-review-in-stack]] reviews: the diff of a single
ticket, judged against *that* ticket's acceptance criteria rather than against the spec as a
whole. A slice is done when its criteria are met; work the criteria do not ask for is surplus,
however obviously owed it looks from an ADR.

### Verdict, evidence, and the escape hatch

A review of a slice returns one **verdict** per acceptance criterion, and a tally over them
("11 of 12"). **Evidence** is what makes a verdict *met*: the test that pins the rule, the
symbol that implements it, the workaround a fixture no longer needs — never a doc comment
claiming the behaviour, and never a plausibility argument. An **escape hatch** is a clause
inside a criterion that hands part of its work forward ("assert at the primitive if compile
cannot see the case, and say so in the test's own doc"); a criterion carrying one is met by
taking it, which is why the ticket's own scope outranks any absolute claim inferred from an ADR.

### Gap, its sweep, and its disposition

A **gap** is a criterion the slice leaves unmet. Before a gap costs anyone work it gets a
**sweep**: search the later layers and sibling branches for the *behaviour* the gap is made of
(a `None` that should be a value, an absent call), counted per branch — because a refactor can
move or reword every string you searched for and leave the behaviour untouched. A gap is then
given exactly one **disposition**: *fix in this PR* (local, no decision owed), *fix in a child
PR* (mechanical but wider than the slice), *hand forward as a ticket* (needs a decision, or
widens the slice past its criteria), or *no work* (met, closed downstream, or out of scope by
the ticket's own words). Reported with it: what the gap does **and does not** break — a
diagnostic-only gap must not block a slice, and a byte-moving one must not be waved through.

### Reporting to a screen

The output discipline of a review a human reads under time pressure: the verdict in the first
sentence, met criteria collapsed to one line, a block *only* per [[gap]], drafts named and
offered rather than pasted, and the blocking question last with nothing after it. The budget is
a screen plus one block per gap. What does not fit is **named and offered, never silently
dropped** — a warning, a number, a scoped condition and a conflict hazard survive every cut,
because a reader who acts on a trimmed version acts wrong. Written for the skim: an exhaustive
report nobody reaches the end of loses its findings exactly as surely as an incomplete one.
