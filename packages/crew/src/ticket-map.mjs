// The ticket view's model (ADR-0031): a run's tickets as the graph agent
// returned them, each at the stage the journal says it has reached, laid out
// as a star map at a fixed spacing. No terminal here: run-view/ticket-draw.mjs
// draws it, and runView keeps the page, the selection and the camera.

// A ticket's stage, the star's colour and glyph: not picked up yet, in
// dispatch or implement, at the gate or its fixes (or publishing), stacked
// (published, subsumed, or done in prior work), waiting on a person, failed.
export const STAGES = Object.freeze(['todo', 'impl', 'gate', 'stacked', 'blocked', 'failed'])

// The node a ticket's agents run under is `ticket/<n>/…` (the workflow
// template's nodes), so the number is read from there, never from a label.
const ticketOf = (node) => {
  const m = /^ticket\/(\d+)\//.exec(node ?? '')
  return m ? Number(m[1]) : null
}
const gateRound = (node) => Number(/\/gate\/r(\d+)/.exec(node)?.[1] ?? 0)

// The stage a ticket is at, and the note the star and the pane carry. work is
// its agents, each with the node it ran under (a doctor its patient's).
function stageOf(g, work, published, blocker, unblocked) {
  if (published?.published === true) return ['stacked', null]
  if (published?.nothing_to_publish === true) return ['stacked', 'subsumed']
  if (g.done_in_prior_work === true) return ['stacked', 'in prior work']
  const asks = work.find(({ agent }) => agent.state === 'needs you' || agent.state === 'blocked')
  if (asks) return ['blocked', asks.agent.waiting ?? asks.agent.reason ?? asks.agent.state]
  const failed = work.find(({ agent }) => agent.state === 'failed' && agent.patient == null)
  if (failed) return ['failed', failed.agent.reason ?? 'failed']
  if (work.some(({ node }) => node.endsWith('/publish'))) return ['gate', 'publishing']
  const gates = work.filter(({ node }) => node.includes('/gate/'))
  if (gates.length) return ['gate', `round ${Math.max(...gates.map(({ node }) => gateRound(node)))}`]
  if (work.length) return ['impl', null]
  if (g.needs_human === true) return ['blocked', g.human_reason || 'needs a human']
  if (blocker && !unblocked) return ['blocked', `blocker: ${blocker}`]
  return ['todo', null]
}

// graph: the graph agent's result ({ tickets: [{ number, title, blocked_by,
// needs_human, human_reason, done_in_prior_work? }], blockers }), or null
// before it returned. agents: the run view's agents (superseded attempts left
// out). nodes: the journal fold's nodes, for each ticket's publish result.
// Returns null without tickets, else, in the graph's order:
//   { n, title, deps, kids, depth, stage, note, held, agents }
// deps and kids only between tickets of the graph; held while a ticket not
// started yet waits, through its blockers, on one blocked or failed.
export function ticketsOf(graph, agents, nodes) {
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
  const tickets = graph.tickets.map((g) => {
    const mine = work.get(g.number) ?? []
    const [stage, note] = stageOf(g, mine, nodes?.get(`ticket/${g.number}/publish`)?.result, blockerOf.get(g.number), unblocked)
    const deps = [...new Set((g.blocked_by ?? []).filter((d) => numbers.has(d) && d !== g.number))]
    return { n: g.number, title: g.title || `#${g.number}`, deps, kids: [], depth: 0, stage, note, held: false, agents: mine.map(({ agent }) => agent) }
  })
  const by = new Map(tickets.map((t) => [t.n, t]))
  for (const t of tickets) for (const d of t.deps) by.get(d).kids.push(t.n)
  // Depth is the longest chain of blockers above a ticket; a cycle the graph
  // should never have is cut where it closes.
  const depth = new Map()
  const depthOf = (t, path = new Set()) => {
    if (depth.has(t.n)) return depth.get(t.n)
    if (path.has(t.n)) return 0
    path.add(t.n)
    const d = t.deps.length ? 1 + Math.max(...t.deps.map((n) => depthOf(by.get(n), path))) : 0
    path.delete(t.n)
    depth.set(t.n, d)
    return d
  }
  for (const t of tickets) t.depth = depthOf(t)
  const held = new Map()
  const heldOf = (t, path = new Set()) => {
    if (held.has(t.n)) return held.get(t.n)
    if (path.has(t.n)) return false
    path.add(t.n)
    const h = t.deps.some((n) => {
      const d = by.get(n)
      return d.stage === 'blocked' || d.stage === 'failed' || heldOf(d, path)
    })
    path.delete(t.n)
    held.set(t.n, h)
    return h
  }
  for (const t of tickets) t.held = t.stage === 'todo' && heldOf(t)
  return tickets
}

// The star map's spacing, in cells: a depth a column apart, a column's stars
// a row apart. Never squeezed to the screen: the camera moves instead.
export const COLUMN = 26
export const ROW = 5

// A small offset of its own for each ticket, so the map reads as a sky rather
// than a grid, and the same ticket sits in the same place every refresh.
function jitter(n, salt) {
  let h = Math.imul((n ^ salt) >>> 0, 2654435761) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 2246822519) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  return (h % 1000) / 1000 - 0.5
}

// Sets each ticket's x and y, in cells, in the map's own space: depth across,
// each column centred on row 0, its stars in the order of their blockers'
// rows (so lines cross less), a root's by its number.
export function layoutTickets(tickets) {
  const cols = []
  for (const t of tickets) (cols[t.depth] ??= []).push(t)
  const by = new Map(tickets.map((t) => [t.n, t]))
  const meanY = (t) => (t.deps.length ? t.deps.reduce((s, n) => s + (by.get(n).y ?? 0), 0) / t.deps.length : 0)
  for (const col of cols) {
    if (!col) continue
    col.sort((a, b) => meanY(a) - meanY(b) || a.n - b.n)
    col.forEach((t, i) => {
      t.x = Math.round(t.depth * COLUMN + jitter(t.n, 1) * 3)
      t.y = Math.round((i - (col.length - 1) / 2) * ROW + jitter(t.n, 2) * 2)
    })
  }
  return tickets
}

// The ticket an arrow moves to from ticket `from`: → follows a line to a
// ticket it blocks, ← back to a blocker, the nearest of them; with no line
// that way, or ↑↓, the nearest star that way. None: `from` again.
export function stepTicket(tickets, from, dir) {
  const by = new Map(tickets.map((t) => [t.n, t]))
  const at = by.get(from)
  if (!at) return tickets[0]?.n ?? from
  const nearest = (list) => {
    let best = null
    let bd = Infinity
    for (const t of list) {
      const d = Math.hypot((t.x - at.x) / 2, t.y - at.y)
      if (t !== at && d < bd) [best, bd] = [t, d]
    }
    return best?.n ?? from
  }
  const lines = dir === 'RIGHT' ? at.kids : dir === 'LEFT' ? at.deps : []
  if (lines.length) return nearest(lines.map((n) => by.get(n)))
  const way = { UP: (t) => t.y < at.y, DOWN: (t) => t.y > at.y, LEFT: (t) => t.x < at.x, RIGHT: (t) => t.x > at.x }[dir]
  return way ? nearest(tickets.filter(way)) : from
}

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
