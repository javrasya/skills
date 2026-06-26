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

A skill **copied into this repo** that originated elsewhere, kept here so the repo is self-contained rather than depending on a symlink to an out-of-repo location. Vendored skills keep upstream attribution. `handoff` (from Matt Pocock) and `caveman` are vendored. See ADR-0001.

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

### C4 model

The diagram system the [[learn]] skill's interactive experience renders. **Four nested zoom levels of one static model**: System Context (L1) → Container (L2) → Component (L3) → Code (L4). A *Container* here is a separately-runnable app or data store (**not** a Docker container); a *Component* is a grouping of functionality inside one container. Visual grammar that makes a diagram actually C4 (not "just boxes"): every element carries a type tag (`[Person]`/`[Software System]`/`[Container: tech]`/`[Component: tech]`) + description; people use a distinct glyph; in-scope vs external is shown by colour **and** position (never colour alone); relationships are directional, labelled with intent + `[technology]`; each diagram has a title and a legend. Semantic zoom = one box becomes a dashed **boundary**, its children appear inside, neighbours project onto the edge.

### 4+1 (not C4)

Kruchten's "4+1" architecture view model — Logical, Process, Development, Physical views + Scenarios. A **trap to avoid**: it is *not* C4. 4+1 is four orthogonal *views* of one system (different concerns); C4 is four *zoom levels* of one nested hierarchy. The [[learn]] experience uses C4 semantics only; do not let diagram code drift toward 4+1.
