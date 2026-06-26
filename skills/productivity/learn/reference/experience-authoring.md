# Authoring the interactive experience (`templates/experience.html`)

Field-by-field guide for retargeting the rich HTML mode to a new topic. The
**engine is fixed**; you edit the `CURRICULUM` data object only. The shell
layout, CSS/design tokens (incl. dark mode), zoom engine, C4 renderer, skill-tree
map layout, slot gate, scaffold-fading and persistence all carry over untouched.

```
CURRICULUM = { system, MODEL, modules:[ … ] }
```

## `MODEL` — the shared C4 backdrop

One static model rendered at three zoom levels. Keys: `context`, `container`,
`component`. Each holds `{ level, scope, boundary, nodes, edges }`. This is the
only thing you MUST rewrite for the diagram. Coordinates live in the design frame
(`FRAME_W`/`FRAME_H` constants near the top); `x,y` = top-left, give boxes room
(~108h with a hint line, ~96h otherwise); keep external nodes outside the boundary
but inside the frame.

**Node fields:**
- `id` — stable; reused across levels for the same actor so zoom keeps continuity.
- `kind` — `person` | `system` | `container` | `component` (sets glyph + type tag).
- `scope` — `in` (the thing decomposed at this level) or `ext` (external actor).
  Shown by colour AND position; never colour alone.
- `name`, `desc` — label + one-line description.
- `tech` — technology string → rendered as `[Container: tech]`. Omit at context level.
- `into` — the level id this box zooms into; makes it the clickable boundary target.
- `adr` — decision key; clicking the box flashes that ADR in the margin.
- `store:true` — draw as a data store (thick bottom border).
- `x,y,w,h` — placement in the design frame.

**Edge fields:** `from`, `to`, `label` (intent verb phrase), `tech` (protocol —
required between containers). Title, legend, person glyph, scope colours, boundary
box and zoom anchors are all DERIVED from `MODEL`; you don't touch them.

Keep it C4, not 4+1: four nested zoom levels of ONE model, not four orthogonal
views. See `[[c4-model]]` and `[[4+1 (not C4)]]` in CONTEXT.md.

## `modules` — one per concept

A module is a CONCEPT (windowing, keying, failure…), not a 1:1 C4 box.

```
{
  id, label, kick, level, capstone?, desc, prereqs:[id], x?, y?,
  scene:{ level, focus:[nodeId], zoomTo? },
  slots:{ orient:beat, confront:beat, reveal:beat, practice:[beat]?, own:[beat]? }
}
```

- `id` — stable authored id (decisions/callbacks key off these).
- `label`, `kick` (e.g. "Aspect 01"), `desc` — map-node copy.
- `level` — the module's home zoom level.
- `prereqs` — module ids that must be `mastered` before this unlocks.
- `capstone:true` — terminal, many-prereq module with a heavier Own slot.
- `x,y` — OPTIONAL nudge to the auto tiered-DAG layout; usually omit.
- `scene` — `{level, focus:[nodeId], zoomTo?}`. Orient renders `level` with `focus`
  highlighted and the rest fogged; Reveal zooms to `zoomTo`. Map-node progress
  aggregates over modules whose `focus` includes that node.

## Fixed slots + beats

Slots are the unchanging five-phase arc, engine-enforced in order:
`orient → confront → reveal → (practice) → (own)`. Orient/confront/reveal are
mandatory; practice/own optional and may hold an array of beats. Beats vary the
INTERACTION inside a slot; they never replace the slot.

A beat = `{ type, id?, …payload }`. A registry maps `type` → a generic renderer
that reads only that beat object.

**Slot → beat legality:**

| Slot     | Legal beat types          | Notes |
|----------|---------------------------|-------|
| orient   | `orient`                  | mandatory |
| confront | `quiz`, `predict`, `sketch` | mandatory; must report a commit |
| reveal   | `reveal`                  | mandatory; consumes the guess |
| practice | `breakit`, `trace`, `fixit` | optional, multiple |
| own      | `decide`, `callback`      | optional, multiple |

**Slot-owned gate:** any confront-legal beat reports "committed"; Reveal stays
locked until it does. This productive-failure gate is the heart of the method —
keep it.

**`trace` beat (folds in the dynamic/flow view):** carries its own `steps`,
drawn as numbered hops over the module's scene level with lane separation. There
is no global FLOWS map and no standalone Static/Flow toggle. A module holds **at
most one `trace`** — one runtime scenario per diagram (the C4 Dynamic rule). Two
distinct runtime stories (e.g. an authoring path and a query path) → two modules,
each with its own `trace`; never two numbered sequences in one diagram. Static
diagrams may still show all relationships at once — only runtime *ordering* splits.

**`callback` beat:** resurfaces a real prior decision from `S.decisions` by its
authored id. Use sparingly — it is the cross-concept connective tissue, not a
recap of everything.

Every referenceable `decide`/`confront` beat carries a stable authored `id` so
callbacks and ADRs survive edits.

## Map, unlock, test-out

- **Map** = skill-tree home screen: modules are nodes, `prereqs` are edges.
  Auto-laid by tiered DAG (tier = longest prereq chain to a root); even within-tier
  spread; curved edges. `x,y` overrides nudge.
- **Navigation** = one spatial metaphor: selecting an unlocked node zooms INTO it
  (transform-origin at node center) → module fills the viewport; closing zooms back
  OUT to the same node. Inside a module, Orient→Reveal zoom Context→Container→Component.
- **Unlock** = hard gate: `locked` until all `prereqs` are `mastered`.
- **Test-out** = a locked node's escape hatch: a quick calibration check
  (`depth:'quick'`, one info+verify beat). Pass = mastered + unlocks downstream;
  fail = opens the full module.
- `S.progress[moduleId]` ∈ `{locked, available, active, mastered}`.

## Scaffold fading

Hint density is keyed purely off how many modules are mastered: early modules
hand-hold, later ones go lean. Handled by the engine (`scaffoldLevel`/`showHint`);
authors don't manage it per module.

## Persistence

Progress, mastery and decisions persist via `localStorage`, wrapped in try/catch
with a silent in-memory fallback so it works from `file://` in a sandbox. The UI
has a mandatory **Reset** button and an **Export ADRs** button that offers
ADR-markdown for the user to copy — the HTML never claims to write files. Writing
the real `CONTEXT.md`/ADRs/learning-log stays the agent's job.

## Ground rules

- Single self-contained HTML file; no build step, no new dependencies (the existing
  Google Fonts link is fine). Must open from `file://`.
- Preserve dark-mode support and the existing CSS variables.
- After editing, the file MUST run with zero console errors.
- Ground every element in the real code you read.
