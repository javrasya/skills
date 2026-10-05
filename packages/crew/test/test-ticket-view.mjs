// The ticket view (ADR-0031): a run's tickets as a star map, g from the run
// tree and t back. The model (ticket-map.mjs) from the graph agent's result
// and the journal's agents; the page in runView and runsView; the star map's
// drawing (draw.mjs); and the painter both renderers write it through.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ticketsOf, layoutTickets, stepTicket, cameraAt, latestAgent, GLIDE_MS, COLUMN, ROW } from '../src/ticket-map.mjs'
import { runView, runsView } from '../src/run-view-model.mjs'
import { draw, strip, TICKETS_HELP } from '../src/run-view/draw.mjs'
import { painter } from '../src/run-view/paint.mjs'
import { runRegistry } from '../src/registry.mjs'

// An agent as the run view's fold gives it, with only what the ticket model reads.
let next = 1
const agent = (node, state, more = {}) => ({ origin: next, n: next++, node, state, label: node, reason: null, waiting: null, patient: null, ...more })
const graphOf = (tickets, more = {}) => ({ tickets: tickets.map(([number, blocked_by = [], extra = {}]) => ({ number, title: `ticket ${number}`, blocked_by, needs_human: false, human_reason: '', ...extra })), explorations: [], blockers: [], ...more })
const nodesWith = (results) => (node) => results[node] ?? null
const stagesOf = (tickets) => Object.fromEntries(tickets.map((t) => [t.n, [t.stage, t.note]]))

test('ticket model: no graph result yet is no tickets', () => {
  assert.equal(ticketsOf(null, []), null)
  assert.equal(ticketsOf({ tickets: [] }, []), null)
})

test('ticket model: each ticket is at the furthest stage its agents and its publish reached', () => {
  const graph = graphOf([[1], [2, [1]], [3, [1]], [4, [2]], [5, [3]], [6], [7]])
  const agents = [
    agent('ticket/2/dispatch', 'done'),
    agent('ticket/2/impl/r1/s1', 'done'),
    agent('ticket/2/gate/r1', 'done'),
    agent('ticket/2/gate/r1/fix/s1', 'done'),
    agent('ticket/2/gate/r2', 'running'),
    agent('ticket/3/dispatch', 'done'),
    agent('ticket/3/impl/r1/s1', 'running'),
    agent('ticket/1/publish', 'done'),
    agent('ticket/6/impl/r1/s1', 'failed', { reason: 'tests did not pass' }),
    agent('ticket/7/gate/r1', 'done'),
    agent('ticket/7/publish', 'running'),
  ]
  const nodes = nodesWith({ 'ticket/1/publish': { published: true, pr_number: 11 } })
  assert.deepEqual(stagesOf(ticketsOf(graph, agents, nodes)), {
    1: ['stacked', null],
    2: ['gate', 'round 2'],
    3: ['impl', null],
    4: ['todo', null],
    5: ['todo', null],
    6: ['failed', 'tests did not pass'],
    7: ['gate', 'publishing'],
  })
})

test('ticket model: a ticket waiting on a person is waiting, whichever way it waits', () => {
  const graph = graphOf([[1], [2, [], { needs_human: true, human_reason: 'a device on the desk' }], [3], [4], [5, [], { done_in_prior_work: true }]], { blockers: [{ subject: 'signing key', tickets: [3], why: '', evidence: '', check: '' }] })
  const agents = [agent('ticket/1/impl/r1/s1', 'needs you', { reason: 'decisions needed: which API' })]
  const nodes = nodesWith({ 'ticket/4/publish': { published: false, nothing_to_publish: true } })
  assert.deepEqual(stagesOf(ticketsOf(graph, agents, nodes)), {
    1: ['waiting', 'decisions needed: which API'],
    2: ['waiting', 'a device on the desk'],
    3: ['waiting', 'blocker: signing key'],
    4: ['stacked', 'subsumed'],
    5: ['stacked', 'in prior work'],
  })
  // Once the unblock session is done, a blocker's ticket is the run's again.
  assert.deepEqual(stagesOf(ticketsOf(graph, [...agents, agent('unblock', 'done')], nodes))[3], ['todo', null])
})

test('ticket model: a doctor that needs you makes its patient’s ticket wait on you', () => {
  const patient = agent('ticket/1/impl/r1/s1', 'failed', { reason: 'session died' })
  const doctor = agent(undefined, 'needs you', { patient: patient.origin, reason: 'a human must restart the emulator' })
  assert.deepEqual(stagesOf(ticketsOf(graphOf([[1]]), [patient, doctor])), { 1: ['waiting', 'a human must restart the emulator'] })
})

test('ticket model: a gate that sends a ticket back to dispatch has it implementing again', () => {
  const agents = [agent('ticket/1/dispatch', 'done'), agent('ticket/1/impl/r1/s1', 'done'), agent('ticket/1/gate/r1', 'done'), agent('ticket/1/dispatch/r2', 'done'), agent('ticket/1/impl/r2/s1', 'running')]
  assert.deepEqual(stagesOf(ticketsOf(graphOf([[1]]), agents)), { 1: ['impl', null] })
  assert.deepEqual(stagesOf(ticketsOf(graphOf([[1]]), [...agents, agent('ticket/1/gate/r2', 'running')])), { 1: ['gate', 'round 2'] })
})

test('ticket model: a ticket not picked up behind a needs-human one waits too, deferred as the run defers it', () => {
  const graph = graphOf([[1, [], { needs_human: true, human_reason: 'a device' }], [2, [1]], [3, [2]], [4]])
  assert.deepEqual(stagesOf(ticketsOf(graph, [])), {
    1: ['waiting', 'a device'],
    2: ['waiting', 'deferred: behind #1, which needs a human'],
    3: ['waiting', 'deferred: behind #1, which needs a human'],
    4: ['todo', null],
  })
})

test('ticket model: the latest agent is the ticket’s own latest, a doctor only when it has none of its own', () => {
  const own = agent('ticket/1/impl/r1/s1', 'failed')
  const doctor = agent(undefined, 'running', { patient: own.origin })
  const [t] = ticketsOf(graphOf([[1]]), [own, doctor])
  assert.equal(latestAgent(t), own)
  assert.equal(latestAgent({ agents: [doctor] }), doctor)
  assert.equal(latestAgent({ agents: [] }), null)
})

test('ticket model: edges, depth, and what a waiting ticket holds up', () => {
  // 9 is not in the graph: an edge to it is dropped, as is 4's edge to itself.
  const graph = graphOf([[1], [2, [1, 9]], [3, [2]], [4, [3, 4]], [5, [1]]])
  const agents = [agent('ticket/2/impl/r1/s1', 'needs you', { reason: 'which API' })]
  const tickets = ticketsOf(graph, agents)
  const by = new Map(tickets.map((t) => [t.n, t]))
  assert.deepEqual(by.get(2).deps, [1])
  assert.deepEqual(by.get(4).deps, [3])
  assert.deepEqual(by.get(1).kids, [2, 5])
  assert.deepEqual(
    tickets.map((t) => t.depth),
    [0, 1, 2, 3, 1],
  )
  assert.deepEqual(
    tickets.filter((t) => t.held).map((t) => t.n),
    [3, 4],
  )
})

test('ticket model: a cycle in the graph does not hang the depth', () => {
  const tickets = ticketsOf(
    graphOf([
      [1, [2]],
      [2, [1]],
    ]),
    [],
  )
  assert.equal(tickets.length, 2)
  assert.ok(tickets.every((t) => Number.isInteger(t.depth)))
})

test('ticket layout: depth is a fixed column apart and a column’s stars a fixed row apart, never squeezed', () => {
  const tickets = ticketsOf(graphOf([[1], [2, [1]], [3, [1]], [4, [1]], [5, [2]]]), [])
  layoutTickets(tickets)
  const by = new Map(tickets.map((t) => [t.n, t]))
  for (const t of tickets) assert.ok(Math.abs(t.x - t.depth * COLUMN) <= 2, `#${t.n} at x ${t.x}`)
  const col = [2, 3, 4].map((n) => by.get(n).y).sort((a, b) => a - b)
  assert.ok(col[1] - col[0] >= ROW - 2 && col[2] - col[1] >= ROW - 2, `rows ${col}`)
  // The same graph lays out the same way every time.
  const again = ticketsOf(graphOf([[1], [2, [1]], [3, [1]], [4, [1]], [5, [2]]]), [])
  layoutTickets(again)
  assert.deepEqual(
    again.map((t) => [t.x, t.y]),
    tickets.map((t) => [t.x, t.y]),
  )
})

test('ticket navigation: → follows a line to what it blocks, ← back to a blocker, ↑↓ the nearest star that way', () => {
  const tickets = ticketsOf(graphOf([[1], [2, [1]], [3, [1]], [4, [2, 3]]]), [])
  layoutTickets(tickets)
  const by = new Map(tickets.map((t) => [t.n, t]))
  assert.ok([2, 3].includes(stepTicket(tickets, 1, 'RIGHT')))
  assert.equal(stepTicket(tickets, 2, 'RIGHT'), 4)
  assert.ok([2, 3].includes(stepTicket(tickets, 4, 'LEFT')))
  const [upper, lower] = by.get(2).y < by.get(3).y ? [2, 3] : [3, 2]
  assert.equal(stepTicket(tickets, upper, 'DOWN'), lower)
  assert.equal(stepTicket(tickets, lower, 'UP'), upper)
  // Nothing that way keeps the selection where it is.
  assert.equal(stepTicket(tickets, 1, 'LEFT'), 1)
})

test('ticket camera: glides from where it was to the selected star in GLIDE_MS, easing in and out', () => {
  const to = { x: 100, y: 10 }
  const glide = { from: { x: 0, y: 0 }, at: 1000 }
  assert.deepEqual(cameraAt(null, to, 5000), to)
  assert.deepEqual(cameraAt(glide, to, 1000), { x: 0, y: 0 })
  const mid = cameraAt(glide, to, 1000 + GLIDE_MS / 2)
  assert.ok(Math.abs(mid.x - 50) < 1e-9 && Math.abs(mid.y - 5) < 1e-9)
  // Slow to leave: a tenth of the way in, it has covered far less than a tenth.
  assert.ok(cameraAt(glide, to, 1000 + GLIDE_MS / 10).x < 2)
  assert.deepEqual(cameraAt(glide, to, 1000 + GLIDE_MS), to)
  assert.deepEqual(cameraAt(glide, to, 1000 + GLIDE_MS * 3), to)
})

test('painter: writes only the lines that changed, inside synchronized output, all of them after a reset', () => {
  const out = []
  const p = painter((s) => out.push(s))
  p.paint(['a', 'b', 'c'])
  assert.equal(out.length, 1)
  assert.ok(out[0].startsWith('\x1b[?2026h') && out[0].endsWith('\x1b[?2026l'))
  assert.ok(['\x1b[1;1Ha', '\x1b[2;1Hb', '\x1b[3;1Hc'].every((l) => out[0].includes(l)))
  p.paint(['a', 'B', 'c'])
  assert.ok(out[1].includes('\x1b[2;1HB') && !out[1].includes('\x1b[1;1H') && !out[1].includes('\x1b[3;1H'))
  p.paint(['a', 'B', 'c'])
  assert.equal(out.length, 2, 'an unchanged frame writes nothing')
  p.reset()
  p.paint(['a', 'B', 'c'])
  assert.ok(out[2].includes('\x1b[1;1Ha') && out[2].includes('\x1b[3;1Hc'))
  // A shorter frame clears the lines it no longer has.
  p.paint(['a'])
  assert.ok(out[3].includes('\x1b[2;1H\x1b[2K') && out[3].includes('\x1b[3;1H\x1b[2K'))
})

// --- the page, in a real run's journal ------------------------------------

const MIN = 60_000
const T0 = Date.parse('2026-10-05T10:00:00Z')
const iso = (min) => new Date(T0 + min * MIN).toISOString()
const LONG = 'a ticket whose title runs on far longer than any label beside a star could hold'
const GRAPH = graphOf([[201], [202, [201]], [203, [201]], [204, [202, 203]], [205, [], { title: LONG }]])
let call = 0
const line = (type, node, title, min, more = {}) => {
  const n = more.n ?? ++call
  return { type, at: iso(min), key: `k${n}`, n, node, title, ...more }
}
function runDir() {
  call = 0
  const dir = mkdtempSync(join(tmpdir(), 'ticket-view-test-'))
  const lines = [
    { type: 'run', at: iso(0), runId: 'run_tickets', phases: ['Graph', 'Implement', 'Gate', 'Stack'] },
    line('started', 'graph', '[Graph] graph:spec-195', 0, { n: 1 }),
    line('result', 'graph', '[Graph] graph:spec-195', 1, { n: 1, result: GRAPH }),
    line('started', 'ticket/201/dispatch', '[Implement] dispatch:#201', 2, { n: 2 }),
    line('result', 'ticket/201/dispatch', '[Implement] dispatch:#201', 3, { n: 2, result: {} }),
    line('started', 'ticket/201/publish', '[Stack] publish:#201', 4, { n: 3 }),
    line('result', 'ticket/201/publish', '[Stack] publish:#201', 5, { n: 3, result: { published: true, pr_number: 11 } }),
    line('started', 'ticket/202/gate/r1', '[Gate] gate:#202:r1', 6, { n: 4 }),
    line('started', 'ticket/203/impl/r1/s1', '[Implement] impl:#203', 6, { n: 5 }),
  ]
  writeFileSync(join(dir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return dir
}
const clockAt = (min) => {
  const clock = { t: T0 + min * MIN, now: () => clock.t }
  return clock
}
const viewOf = (stateDir, clock = clockAt(10)) => runView({ stateDir, host: {}, clock, transcripts: { usage: () => null }, registry: null, alive: () => false })

test('ticket page: g opens it on the run’s tickets at their stages, t goes back to the tree as it was', async () => {
  const view = viewOf(runDir())
  await view.refresh()
  await view.key('DOWN')
  const treeAt = view.model.selected
  assert.equal(view.model.page, 'tree')
  await view.key('g')
  assert.equal(view.model.page, 'tickets')
  assert.deepEqual(
    view.model.tickets.list.map((t) => [t.n, t.stage]),
    [
      [201, 'stacked'],
      [202, 'gate'],
      [203, 'impl'],
      [204, 'todo'],
      [205, 'todo'],
    ],
  )
  // It opens on a ticket at work, the gate's before the implementing one's.
  assert.equal(view.model.tickets.selected, 202)
  await view.key('t')
  assert.equal(view.model.page, 'tree')
  assert.equal(view.model.selected, treeAt)
  // Esc goes back too.
  await view.key('g')
  await view.key('ESCAPE')
  assert.equal(view.model.page, 'tree')
})

test('ticket page: arrows move along the lines and the camera glides there; Enter shows the ticket’s agent in the tree', async () => {
  const clock = clockAt(10)
  const view = viewOf(runDir(), clock)
  await view.refresh()
  await view.key('g')
  assert.equal(view.model.tickets.glide, null, 'opening the page puts the camera on the selection at once')
  await view.key('RIGHT')
  assert.equal(view.model.tickets.selected, 204)
  assert.equal(view.model.tickets.glide.at, clock.t)
  await view.key('LEFT')
  assert.ok([202, 203].includes(view.model.tickets.selected))
  await view.key('UP')
  await view.key('DOWN')
  // 203 has an agent at work; 205 none yet, so Enter there stays on the page and says so.
  await view.clickTicket(205)
  assert.equal((await view.key('ENTER')).message, '#205 has no agent yet')
  assert.equal(view.model.page, 'tickets')
  await view.clickTicket(203)
  await view.key('ENTER')
  assert.equal(view.model.page, 'tree')
  const row = view.model.rows[view.model.selected]
  assert.equal(row.kind, 'agent')
  assert.equal(row.agent.node, 'ticket/203/impl/r1/s1')
})

test('ticket page: a click on a star selects it', async () => {
  const view = viewOf(runDir())
  await view.refresh()
  await view.key('g')
  await view.clickTicket(205)
  assert.equal(view.model.tickets.selected, 205)
  await view.clickTicket(999)
  assert.equal(view.model.tickets.selected, 205, 'a ticket the run does not have changes nothing')
})

test('ticket page: before the graph agent returns, g says so and shows no stars', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-view-test-'))
  writeFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ type: 'run', at: iso(0), runId: 'run_none', phases: ['Graph'] }) + '\n' + JSON.stringify(line('started', 'graph', '[Graph] graph:spec-195', 0, { n: 1 })) + '\n')
  const view = viewOf(dir)
  await view.refresh()
  await view.key('g')
  assert.equal(view.model.page, 'tickets')
  assert.equal(view.model.tickets, null)
  const text = draw(view.model, { width: 120, height: 34, now: T0 }).lines.map(strip).join('\n')
  assert.match(text, /no ticket graph yet/)
})

test('ticket page: draws stars with their numbers, the selected one’s title, the pane, and the page’s keys', async () => {
  const view = viewOf(runDir())
  await view.refresh()
  await view.key('g')
  const screen = draw(view.model, { width: 140, height: 36, now: T0 + 10 * MIN })
  const text = screen.lines.map(strip)
  assert.equal(screen.lines.length, 36)
  assert.ok(
    text.every((l) => [...l].length === 140),
    'every line is the screen’s width',
  )
  const body = text.join('\n')
  assert.match(body, /★/)
  assert.match(body, /◆/)
  assert.match(body, /#202 ticket 202/)
  assert.match(body, /\b204\b/)
  assert.match(body, /at the gate · round 1/)
  assert.match(body, /blocked by .*#201/)
  assert.equal(text.at(-1).trim(), TICKETS_HELP.trim())
  assert.equal(screen.rowAt(10), null, 'no tree row is under a click on this page')
  assert.ok(screen.tick > 0, 'the page asks to be drawn again: its stars twinkle')
})

test('ticket page: a click lands on the star drawn under it', async () => {
  const view = viewOf(runDir())
  await view.refresh()
  await view.key('g')
  const screen = draw(view.model, { width: 140, height: 36, now: T0 + 10 * MIN })
  const text = screen.lines.map(strip)
  // The selected star sits at the middle of the map: find 203's number under its star.
  const number = /(?<![#\d])203(?!\d)/
  const y = text.findIndex((l, i) => i > 3 && number.test(l))
  assert.ok(y > 0, 'ticket 203 is on screen')
  // Its number is under its star: the middle digit's column, 1-based, and the star's row.
  const x = text[y].search(number) + 2
  assert.equal(screen.ticketAt(x, y), 203)
  assert.equal(screen.ticketAt(1, 2), null)
})

test('ticket page: a long title on the selected star scrolls as an agent’s name does, and is cut in the pane', async () => {
  const clock = clockAt(10)
  const view = viewOf(runDir(), clock)
  await view.refresh()
  await view.key('g')
  await view.clickTicket(205)
  const at = view.model.tickets.selectedAt
  const label = (now) =>
    draw(view.model, { width: 140, height: 36, now })
      .lines.map(strip)
      .find((l) => l.includes('a ticket whose') || l.includes('runs on') || /title/.test(l)) ?? ''
  const start = label(at)
  assert.match(start, /#205 a ticket whose/)
  // Past its 3 s hold it has scrolled left.
  const later = label(at + 3000 + 20 * 250)
  assert.notEqual(later, start)
  assert.doesNotMatch(later, /#205 a ticket/)
})

test('ticket page in the runs list: ← moves along the lines and Esc goes back to the tree, rather than leaving the run; q still goes back to the list', async () => {
  const stateDir = runDir()
  const registry = join(mkdtempSync(join(tmpdir(), 'ticket-view-reg-')), 'runs.jsonl')
  runRegistry(registry).armed({ runId: 'run_tickets', name: 'spec-195', spec: 'spec-195', project: '/tmp/project', runDir: stateDir, script: join(stateDir, 'script.js'), host: 'crew' })
  const runs = runsView({ host: {}, registry, clock: clockAt(10), transcripts: { usage: () => null }, alive: () => false })
  await runs.refresh()
  const at = runs.model.rows.findIndex((r) => r.kind === 'run')
  while (runs.model.selected < at) await runs.key('DOWN')
  await runs.key('ENTER')
  await runs.key('g')
  assert.equal(runs.opened().model.page, 'tickets')
  await runs.key('RIGHT')
  assert.equal(runs.opened().model.tickets.selected, 204)
  await runs.key('LEFT')
  assert.ok(runs.opened(), 'still in the run')
  assert.ok([202, 203].includes(runs.opened().model.tickets.selected))
  await runs.clickTicket(201)
  assert.equal(runs.opened().model.tickets.selected, 201)
  // Esc goes back to the tree, not out of the run; on the tree it leaves the run.
  await runs.key('ESCAPE')
  assert.equal(runs.opened().model.page, 'tree')
  await runs.key('g')
  await runs.key('q')
  assert.equal(runs.opened(), null)
})
