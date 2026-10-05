// The ticket view's model (ADR-0031): a run's tickets as the graph agent
// returned them, each at the stage the journal says it has reached, laid out
// as a star map at a fixed spacing. No terminal here: run-view/ticket-draw.mjs
// draws it, and runView keeps the page, the selection and the camera.

// A ticket's stage, the star's colour and glyph: todo (not picked up yet),
// impl (in dispatch or implement), gate (at the gate or its fixes, or
// publishing), stacked (published, subsumed, or done in prior work), waiting
// (on a person), failed. A stage is a ticket's; a state is an agent's.

// The node a ticket's agents run under is `ticket/<n>/…` (the workflow
// template's nodes), so the number is read from there, never from a label.
const ticketOf = (node) => {
  const m = /^ticket\/(\d+)\//.exec(node ?? '')
  return m ? Number(m[1]) : null
}
const gateRound = (node) => Number(/\/gate\/r(\d+)/.exec(node)?.[1] ?? 0)

// The tickets by number.
export const byNumber = (tickets) => new Map(tickets.map((t) => [t.n, t]))

// A ticket nothing will move on its own: what holds the tickets behind it.
export const cannotMove = (t) => t.stage === 'waiting' || t.stage === 'failed'

// The agent a ticket's work is at now: its latest, a doctor only when it has
// no agent of its own. The pane names it and Enter goes to it.
export function latestAgent(t) {
  const own = t.agents.filter((a) => a.patient == null)
  return (own.length ? own : t.agents).reduce((a, b) => (!a || b.n > a.n ? b : a), null)
}

// The stage a ticket is at, and the note the star and the pane carry. work is
// its agents, each with the node it ran under (a doctor its patient's). The
// latest agent says where its work is: a gate that sends it back to dispatch
// has it implementing again.
function stageOf(g, work, published, blocker, unblocked) {
  if (published?.published === true) return ['stacked', null]
  if (published?.nothing_to_publish === true) return ['stacked', 'subsumed']
  if (g.done_in_prior_work === true) return ['stacked', 'in prior work']
  const asks = work.find(({ agent }) => agent.state === 'needs you' || agent.state === 'blocked')
  if (asks) return ['waiting', asks.agent.waiting ?? asks.agent.reason ?? asks.agent.state]
  const own = work.filter(({ agent }) => agent.patient == null)
  const failed = own.find(({ agent }) => agent.state === 'failed')
  if (failed) return ['failed', failed.agent.reason ?? 'failed']
  const latest = own.reduce((a, b) => (!a || b.agent.n > a.agent.n ? b : a), null)
  if (latest?.node.endsWith('/publish')) return ['gate', 'publishing']
  if (latest?.node.includes('/gate/')) return ['gate', `round ${gateRound(latest.node)}`]
  if (latest) return ['impl', null]
  if (g.needs_human === true) return ['waiting', g.human_reason || 'needs a human']
  if (blocker && !unblocked) return ['waiting', `blocker: ${blocker}`]
  return ['todo', null]
}

// A value per ticket that depends on its blockers' values, each worked out
// once: fn(t, up) with up(n) the value of blocker n. A cycle the graph should
// never have is cut where it closes, its value `cut`.
function overBlockers(by, fn, cut) {
  const memo = new Map()
  const of = (t, path = new Set()) => {
    if (memo.has(t.n)) return memo.get(t.n)
    if (path.has(t.n)) return cut
    path.add(t.n)
    const v = fn(t, (n) => of(by.get(n), path))
    path.delete(t.n)
    memo.set(t.n, v)
    return v
  }
  return of
}

// graph: the graph agent's result ({ tickets: [{ number, title, blocked_by,
// needs_human, human_reason, done_in_prior_work? }], blockers }), or null
// before it returned. agents: the run view's agents (superseded attempts left
// out). resultOf(node): a node's result, for each ticket's publish.
// Returns null without tickets, else, in the graph's order:
//   { n, title, deps, kids, depth, stage, note, held, agents }
// deps and kids only between tickets of the graph. A ticket not picked up
// behind a needs-human one is waiting too: the run defers it to a human, as
// the workflow does. held: one not picked up that waits, through its
// blockers, on one that cannot move.
/** @param {(node: string) => any} [resultOf] */
export function ticketsOf(graph, agents, resultOf = () => null) {
  if (!Array.isArray(graph?.tickets) || !graph.tickets.length) return null
  const numbers = new Set(graph.tickets.map((t) => t.number))
  const byOrigin = new Map(agents.map((a) => [a.origin, a]))
  const work = new Map()
  for (const agent of agents) {
    const node = agent.node ?? byOrigin.get(agent.patient)?.node ?? null
    const n = ticketOf(node)
    if (!numbers.has(n)) continue
    if (!work.has(n)) work.set(n, [])
    work.get(n).push({ agent, node })
  }
  const blockerOf = new Map()
  for (const b of graph.blockers ?? []) for (const n of b.tickets ?? []) if (!blockerOf.has(n)) blockerOf.set(n, b.subject)
  const unblocked = agents.some((a) => a.node === 'unblock' && a.state === 'done')
  const human = new Set(graph.tickets.filter((g) => g.needs_human === true).map((g) => g.number))
  const tickets = graph.tickets.map((g) => {
    const mine = work.get(g.number) ?? []
    const [stage, note] = stageOf(g, mine, resultOf(`ticket/${g.number}/publish`), blockerOf.get(g.number), unblocked)
    const deps = [...new Set((g.blocked_by ?? []).filter((d) => numbers.has(d) && d !== g.number))]
    return { n: g.number, title: g.title || `#${g.number}`, deps, kids: [], depth: 0, stage, note, held: false, agents: mine.map(({ agent }) => agent) }
  })
  const by = byNumber(tickets)
  for (const t of tickets) for (const d of t.deps) by.get(d).kids.push(t.n)
  // Depth is the longest chain of blockers above a ticket.
  const depthOf = overBlockers(by, (t, up) => (t.deps.length ? 1 + Math.max(...t.deps.map(up)) : 0), 0)
  for (const t of tickets) t.depth = depthOf(t)
  const humanAbove = overBlockers(by, (t, up) => t.deps.map((n) => (human.has(n) ? n : up(n))).find((n) => n != null) ?? null, null)
  for (const t of tickets) {
    const behind = t.stage === 'todo' ? humanAbove(t) : null
    if (behind != null) Object.assign(t, { stage: 'waiting', note: `deferred: behind #${behind}, which needs a human` })
  }
  const heldOf = overBlockers(by, (t, up) => t.deps.some((n) => cannotMove(by.get(n)) || up(n)), false)
  for (const t of tickets) t.held = t.stage === 'todo' && heldOf(t)
  return tickets
}

// The star map's least spacing, in cells: a depth a column apart, a column's
// stars a row apart. A screen with room for more spreads the map to fill it,
// up to the most, past which a line is too long to follow; one with less
// never squeezes it: the camera moves instead.
export const COLUMN = 26
export const ROW = 5
const COLUMN_MOST = 60
const ROW_MOST = 10
// The cells kept clear at each side, for the selected title under its star.
const MARGIN = 16

// A small offset of its own for each ticket, so the map reads as a sky rather
// than a grid, and the same ticket sits in the same place every refresh.
function jitter(n, salt) {
  let h = Math.imul((n ^ salt) >>> 0, 2654435761) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 2246822519) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  return (h % 1000) / 1000 - 0.5
}

// How many times the orderings are swept, each way, looking for fewer crossings.
const SWEEPS = 12

// Sets each ticket's x and y in the map's own units, a column and a row, and
// its via: for each blocker a line skips columns from, the points it passes
// through in those columns. Depth across, never moved: it is the order work is
// picked up in. A layered layout down each column: a line that skips columns
// holds a row in each one it crosses, so it runs between stars rather than
// through them, and each column is ordered by its neighbours' mean row, swept
// back and forth, keeping the order with the fewest crossings. Each column is
// centred on row 0. mapScale turns it all into cells for a screen.
export function layoutTickets(tickets) {
  const by = byNumber(tickets)
  // A slot is a ticket or a line's waypoint; up and down, the slots it joins
  // in the columns either side.
  const cols = []
  const slot = (depth, s) => {
    Object.assign(s, { depth, up: [], down: [] })
    ;(cols[depth] ??= []).push(s)
    return s
  }
  const slots = new Map(tickets.map((t) => [t.n, slot(t.depth, { t, key: t.n })]))
  const join = (a, b) => {
    a.down.push(b)
    b.up.push(a)
  }
  const ways = []
  for (const t of tickets) {
    for (const n of t.deps) {
      const a = by.get(n)
      let prev = slots.get(a.n)
      const via = []
      for (let d = a.depth + 1; d < t.depth; d++) {
        const w = slot(d, { key: n + (t.n - n) / (t.n + n + 1) })
        via.push(w)
        join(prev, w)
        prev = w
      }
      join(prev, slots.get(t.n))
      ways.push([t, n, via])
    }
  }
  const all = cols.filter(Boolean)
  const pos = new Map()
  const rows = (col) => {
    col.forEach((s, i) => {
      pos.set(s, i - (col.length - 1) / 2)
    })
  }
  const place = () => {
    for (const col of all) rows(col)
  }
  const crossings = () => {
    let c = 0
    for (const col of all) {
      const edges = col.flatMap((s) => s.down.map((d) => [pos.get(s), pos.get(d)]))
      for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) if ((edges[i][0] - edges[j][0]) * (edges[i][1] - edges[j][1]) < 0) c++
    }
    return c
  }
  const mean = (list, own) => (list.length ? list.reduce((s, x) => s + pos.get(x), 0) / list.length : own)
  for (const col of all) col.sort((a, b) => a.key - b.key)
  place()
  let best = all.map((col) => [...col])
  let fewest = crossings()
  for (let i = 0; i < SWEEPS && fewest > 0; i++) {
    const down = i % 2 === 0
    for (const col of down ? all : [...all].reverse()) {
      const want = new Map(col.map((s) => [s, mean(down ? s.up : s.down, pos.get(s))]))
      col.sort((a, b) => want.get(a) - want.get(b) || a.key - b.key)
      rows(col)
    }
    const c = crossings()
    if (c < fewest) [best, fewest] = [all.map((col) => [...col]), c]
  }
  for (const [k, col] of all.entries()) col.splice(0, col.length, ...best[k])
  place()
  for (const t of tickets) {
    t.x = t.depth + (jitter(t.n, 1) * 3) / COLUMN
    t.y = pos.get(slots.get(t.n)) + (jitter(t.n, 2) * 2) / ROW
    t.via = new Map()
  }
  for (const [t, n, via] of ways)
    if (via.length)
      t.via.set(
        n,
        via.map((s) => ({ x: s.depth, y: pos.get(s) })),
      )
  return tickets
}

// The ticket an arrow moves to from ticket `from`: → follows a line to a
// ticket it blocks, ← back to a blocker, the nearest of them; with no line
// that way, or ↑↓, the nearest star that way. None: `from` again.
export function stepTicket(tickets, from, dir) {
  const by = byNumber(tickets)
  const at = by.get(from)
  if (!at) return tickets[0]?.n ?? from
  const nearest = (list) => {
    let best = null
    let bd = Infinity
    for (const t of list) {
      const d = Math.hypot(((t.x - at.x) * COLUMN) / 2, (t.y - at.y) * ROW)
      if (t !== at && d < bd) [best, bd] = [t, d]
    }
    return best?.n ?? from
  }
  const lines = dir === 'RIGHT' ? at.kids : dir === 'LEFT' ? at.deps : []
  if (lines.length) return nearest(lines.map((n) => by.get(n)))
  const way = { UP: (t) => t.y < at.y, DOWN: (t) => t.y > at.y, LEFT: (t) => t.x < at.x, RIGHT: (t) => t.x > at.x }[dir]
  return way ? nearest(tickets.filter(way)) : from
}

// The map on a screen W cells wide and H high: { column, row }, the cells a
// map unit spans each way, as many as fill the screen, from COLUMN and ROW up
// to their most; fits, along each axis, whether the whole map is on screen
// at that spacing; centre, the map's middle, in map units.
export function mapScale(tickets, W, H) {
  const points = tickets.flatMap((t) => [t, ...[...(t.via?.values() ?? [])].flat()])
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const span = (vs) => Math.max(...vs) - Math.min(...vs)
  const middle = (vs) => (Math.max(...vs) + Math.min(...vs)) / 2
  const [wide, high] = [span(xs), span(ys)]
  const roomX = W - 2 * MARGIN
  const roomY = H - 3
  const column = wide > 0 ? Math.max(COLUMN, Math.min(COLUMN_MOST, Math.floor(roomX / wide))) : COLUMN
  const row = high > 0 ? Math.max(ROW, Math.min(ROW_MOST, Math.floor(roomY / high))) : ROW
  return { column, row, fits: { x: wide * column <= roomX, y: high * row <= roomY }, centre: { x: middle(xs), y: middle(ys) } }
}

// Where the camera looks, in map units: at the map's middle along an axis the
// whole map fits, so it sits still and centred; along one it overflows, at
// cam, the camera that follows the selected star.
export const lookAt = (scale, cam) => ({ x: scale.fits.x ? scale.centre.x : cam.x, y: scale.fits.y ? scale.centre.y : cam.y })

// How long the camera takes to glide to a newly selected star. A fixed time
// with ease-in-out, never a chase that creeps its last cell.
export const GLIDE_MS = 380
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

// Where the camera is at `now`: on `to`, the selected star, unless a glide
// that started at glide.at from glide.from is still under way.
export function cameraAt(glide, to, now) {
  if (!glide) return { x: to.x, y: to.y }
  const t = Math.max(0, Math.min(1, (now - glide.at) / GLIDE_MS))
  if (t === 1) return { x: to.x, y: to.y }
  const e = easeInOut(t)
  return { x: glide.from.x + (to.x - glide.from.x) * e, y: glide.from.y + (to.y - glide.from.y) * e }
}
