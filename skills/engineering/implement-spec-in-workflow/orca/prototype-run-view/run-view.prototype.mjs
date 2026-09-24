// PROTOTYPE — throwaway. Question: what should the Orca runner's run view look like? (#43)
// Three structurally different layouts over the same fake, live-ticking run. Switch with 1/2/3 or v.
// Everything is fake: no Orca calls, actions only flash the command they would run.
//
//   A  Phase tree   — htop: one row per agent under its phase, detail pane for the selection
//   B  Ticket lanes — the task graph: one column per ticket, its agents stacked, blockers shown
//   C  Timeline     — runs sidebar (standalone mode) + a Gantt of agents over time + runner.log tail
//
// Keys: ↑↓ (and ←→ in B) move · Enter/click focus tab · r reclaim · R resume · e end-of-run prompt
//       s standalone run list (A/B) · Tab switch pane (C) · 1/2/3/v variant · q quit
import termkit from 'terminal-kit'

const term = termkit.terminal

// ---------- fake data ----------
const NOW0 = Date.now()
const min = (m) => NOW0 - m * 60_000
const agent = (n, phase, label, ticket, state, ctx, cum, startMin, endMin, extra = {}) => ({
  n, phase, label, ticket, state, ctx, cum, start: min(startMin), end: endMin == null ? null : min(endMin),
  handle: `term_${(n * 7919).toString(16)}`, worktree: `run_55d94954c294-${n}`,
  session: n % 3 ? `e393c95d-21dd-4314-${(9000 + n).toString(16)}-c8625be22112` : null, continued: 0, ...extra,
})
const agents = [
  agent(1, 'Discover', 'discover', null, 'done', 118_400, 1_900_000, 95, 88),
  agent(2, 'Layer0', 'layer0', null, 'done', 64_000, 700_000, 88, 81),
  agent(3, 'Implement', 'impl:#1159:s1', 1159, 'done', 181_000, 5_200_000, 80, 52),
  agent(4, 'Gate', 'gate:#1159:r1', 1159, 'done', 92_000, 1_400_000, 52, 44),
  agent(5, 'Publish', 'publish:#1159', 1159, 'done', 41_000, 380_000, 44, 40, { pr: 1159 }),
  agent(6, 'Implement', 'impl:#1160:s1', 1160, 'done', 311_000, 9_100_000, 80, 38),
  agent(7, 'Implement', 'impl:#1160:s2', 1160, 'running', 152_000, 2_300_000, 38, null),
  agent(14, 'Implement', 'impl:#1087:s1', 1087, 'done', 257_736, 8_582_318, 80, 47),
  agent(17, 'Implement', 'impl:#1087:s2', 1087, 'failed', 0, 0, 47, 39, {
    reason: 'worker did not start: orca worktree create timed out after 60s (3/3 attempts)', session: null }),
  agent(18, 'Implement', 'impl:#1158:s1', 1158, 'done', 204_000, 6_000_000, 80, 50),
  agent(28, 'Gate', 'gate:#1158:r1', 1158, 'continued', 382_000, 12_400_000, 50, null, {
    continued: 1, reason: 'stalled 20m (no transcript growth, TUI idle) → nudged → continued ×1' }),
  agent(21, 'Implement', 'impl:#1162:s1', 1162, 'stuck', 291_000, 7_700_000, 64, null, {
    reason: 'no transcript growth for 22m; nudged 1/2' }),
  agent(22, 'Implement', 'impl:#1163:s1', 1163, 'running', 61_000, 900_000, 12, null),
  agent(30, 'Implement', 'impl:#1154:s1', 1154, 'queued', 0, 0, 0, null, { blockedBy: 1087 }),
  agent(31, 'Implement', 'impl:#1156:s1', 1156, 'queued', 0, 0, 0, null, { blockedBy: 1087 }),
  agent(40, 'Integrate', 'integration', null, 'queued', 0, 0, 0, null),
]
const PHASES = ['Discover', 'Layer0', 'Implement', 'Gate', 'Publish', 'Integrate']
const TICKETS = [1159, 1160, 1087, 1154, 1156, 1158, 1162, 1163]
const BLOCKS = { 1154: [1087], 1156: [1087], 1163: [1162] }
const RUN = { meta: 'implement-spec-783', project: 'controlayer', id: 'run_55d94954c294', spec: '#783 W5.2', start: min(95), runnerAlive: true }
const RUNS = [
  { project: 'controlayer', id: 'run_55d94954c294', spec: '#783 W5.2', status: 'live', note: '4 running · 1 stuck · 1 failed', age: '1h35m' },
  { project: 'controlayer', id: 'run_3e45f0206b19', spec: '#783 W5.1', status: 'ended partial', note: '2 kept, 19 reclaimable', age: '1d' },
  { project: 'controlayer', id: 'run_0eb531a8cf96', spec: 'spike-22', status: 'reclaimed', note: '', age: '2d' },
  { project: 'skills', id: 'run_8731c05085d2', spec: 'tracer', status: 'runner dead', note: '2 workers alive — resume?', age: '3h' },
  { project: 'skills', id: 'run_afe527af882c', spec: 'runner-contract', status: 'ended ok', note: '6 kept', age: '1d' },
]
const LOG = [
  '>> [Implement] impl:#1163:s1: started in terminal term_a91 (run_55d94954c294-22)',
  '!! [Implement] impl:#1162:s1: no transcript growth for 20m, TUI idle — nudge 1/2',
  '!! [Gate] gate:#1158:r1: dead after nudge — continuing session 7f3c… (1/3)',
  '<< [Implement] impl:#1160:s1: returned (311k ctx, 42m)',
]

// ---------- live simulation ----------
const live = (a) => ['running', 'continued', 'starting'].includes(a.state)
setInterval(() => {
  for (const a of agents) if (live(a)) { a.ctx += 400 + ((a.n * 131) % 1600); a.cum += 20_000 + a.n * 900 }
  render()
}, 1000)

// ---------- ansi helpers ----------
const E = '\x1b['
const c = (code, s) => `${E}${code}m${s}${E}0m`
const grey = (s) => c('90', s), bold = (s) => c('1', s), inv = (s) => c('7', s), cyan = (s) => c('36', s)
const band = (t) => (t < 200_000 ? '32' : t <= 350_000 ? '33' : '31')
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length
function fit(s, w) { // pad or cut to exactly w visible chars, ANSI-safe
  let out = '', n = 0
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; continue }
    for (const ch of part) { if (n >= w) break; out += ch; n++ }
  }
  return out + ' '.repeat(Math.max(0, w - n)) + `${E}0m`
}
const k = (t) => (t >= 1_000_000 ? `${(t / 1e6).toFixed(1)}M` : t ? `${Math.round(t / 1000)}k` : '—')
const dur = (a) => {
  if (!a.start || a.state === 'queued') return '—'
  const s = Math.floor(((a.end ?? Date.now()) - a.start) / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(ss).padStart(2, '0')}s`
}
const GLYPH = { queued: '·', starting: '◌', running: '●', stuck: '◐', continued: '↻', done: '✓', failed: '✗', dead: '†', reclaimed: '○' }
const SCOL = { queued: '90', starting: '36', running: '36', stuck: '33', continued: '35', done: '32', failed: '31', dead: '31', reclaimed: '90' }
const st = (a) => c(SCOL[a.state], `${GLYPH[a.state]} ${a.state}${a.continued ? ` ×${a.continued}` : ''}`)
const ctxCell = (a, w = 10) => {
  if (!a.ctx) return grey('░'.repeat(w)) + '     '
  const f = Math.min(w, Math.round((a.ctx / 500_000) * w))
  return c(band(a.ctx), '█'.repeat(f)) + grey('░'.repeat(w - f)) + ' ' + c(band(a.ctx), k(a.ctx).padStart(4))
}
const counts = () => {
  const by = {}; for (const a of agents) by[a.state] = (by[a.state] ?? 0) + 1
  return ['running', 'continued', 'stuck', 'queued', 'done', 'failed'].filter((s) => by[s]).map((s) => c(SCOL[s], `${GLYPH[s]} ${by[s]} ${s}`)).join('  ')
}

// ---------- ui state ----------
let variant = 'A', sel = 0, laneCol = 0, laneRow = 0, pane = 'agents', runSel = 0, standalone = false
let flash = '', modal = null, hits = []
const say = (m) => { flash = m; render() }

function header(W) {
  const run = `${bold(RUN.meta)} ${grey('·')} ${RUN.project} ${grey('·')} ${grey(RUN.id)} ${grey('·')} spec ${RUN.spec} ${grey('·')} runner ${c('32', '● alive')} ${grey('·')} ${dur({ start: RUN.start, state: 'x' })}`
  return [fit(' ' + run, W), fit(' ' + counts(), W), fit(grey('─'.repeat(W)), W)]
}
function footer(W) {
  const keys = variant === 'B' ? '←→↑↓ move' : '↑↓ move'
  const help = grey(` ${keys} · ⏎/click focus tab · r reclaim · R resume · e end-of-run · ${variant === 'C' ? 'Tab pane' : 's runs'} · q quit`)
  const names = { A: 'Phase tree', B: 'Ticket lanes', C: 'Timeline' }
  const bar = c('45;30', ` PROTOTYPE  ◀ ${variant} (${names[variant]}) ▶  1/2/3 or v `)
  return [fit(flash ? ' ' + c('1;36', flash) : '', W), fit(help, W), fit(' '.repeat(Math.max(0, Math.floor((W - vis(bar)) / 2))) + bar, W)]
}

// ---------- variant A: phase tree ----------
function rowsA() { const r = []; for (const p of PHASES) { const as = agents.filter((a) => a.phase === p); if (as.length) { r.push({ phase: p, as }); as.forEach((a) => r.push({ a })) } } return r }
function viewA(W, H) {
  const out = [], rows = rowsA(), sels = rows.filter((r) => r.a)
  sel = Math.max(0, Math.min(sel, sels.length - 1))
  const cur = sels[sel].a
  out.push(fit(grey('   #   AGENT                    STATE            CONTEXT           TOKENS   ELAPSED'), W))
  for (const r of rows) {
    if (r.phase) {
      const done = r.as.filter((a) => a.state === 'done').length
      out.push(fit(` ${bold('▾ ' + r.phase)} ${grey(`${done}/${r.as.length}`)}`, W)); continue
    }
    const a = r.a
    const line = `  ${String(a.n).padStart(3)}   ${a.label.padEnd(22)} ${fit(st(a), 16)} ${ctxCell(a)}   ${grey(k(a.cum).padStart(6))}   ${dur(a).padStart(7)}`
    hits.push({ y: out.length + 4, a })
    out.push(a === cur ? inv(fit(vis(line) ? line.replace(/\x1b\[[0-9;]*m/g, '') : line, W)) : fit(line, W))
  }
  const body = H - 3 - 3 - 7
  while (out.length < body) out.push(fit('', W))
  out.length = Math.min(out.length, body)
  out.push(fit(grey('─'.repeat(W)), W))
  out.push(...detail(cur, W))
  return out
}
function detail(a, W) {
  return [
    fit(` ${bold(`[${a.phase}] ${a.label}`)}  ${st(a)}  ctx ${a.ctx ? c(band(a.ctx), k(a.ctx)) : '—'}  total ${grey(k(a.cum))}  ${dur(a)}`, W),
    fit(` worktree ${cyan(a.worktree)}   tab ${cyan(a.handle)}   session ${a.session ? grey(a.session) : grey('—')}`, W),
    fit(a.reason ? ` ${c('31', 'reason')} ${a.reason}` : a.blockedBy ? ` ${c('33', 'blocked by')} #${a.blockedBy}` : a.pr ? ` ${c('32', 'published')} PR #${a.pr}` : '', W),
    fit(grey(` transcript ~/.claude/projects/…-${a.worktree.replace('_', '-')}/${a.session ?? '(none)'}.jsonl`), W),
    fit('', W), fit('', W),
  ]
}

// ---------- variant B: ticket lanes ----------
function viewB(W, H) {
  const out = [], colW = Math.max(16, Math.floor((W - 2) / TICKETS.length))
  const runLevel = agents.filter((a) => !a.ticket)
  out.push(fit(' ' + runLevel.map((a) => `${c(SCOL[a.state], GLYPH[a.state])} ${a.label} ${a.ctx ? c(band(a.ctx), k(a.ctx)) : ''}`).join(grey('  ──▶  ')), W))
  out.push(fit('', W))
  laneCol = Math.max(0, Math.min(laneCol, TICKETS.length - 1))
  const lanes = TICKETS.map((t) => agents.filter((a) => a.ticket === t))
  laneRow = Math.max(0, Math.min(laneRow, lanes[laneCol].length - 1))
  const tstate = (as) => as.some((a) => a.state === 'failed') ? c('31', '✗') : as.every((a) => a.state === 'done') ? c('32', '✓') : as.some((a) => a.state === 'stuck') ? c('33', '◐') : as.some(live) ? c('36', '●') : grey('·')
  out.push(fit(' ' + TICKETS.map((t, i) => fit(`${tstate(lanes[i])} ${i === laneCol ? bold(c('4', '#' + t)) : bold('#' + t)}`, colW)).join(''), W))
  out.push(fit(' ' + TICKETS.map((t) => fit(BLOCKS[t] ? c('33', `◀ #${BLOCKS[t].join(',#')}`) : grey('—'), colW)).join(''), W))
  const depth = Math.max(...lanes.map((l) => l.length))
  for (let r = 0; r < depth; r++) {
    for (const line of [0, 1, 2]) {
      let s = ' '
      lanes.forEach((l, i) => {
        const a = l[r]
        if (!a) { s += fit('', colW); return }
        const short = a.label.split(':').slice(2).join(':') || a.label.split(':')[0]
        const txt = line === 0 ? `┌ ${a.phase[0]} ${short} ${c(SCOL[a.state], GLYPH[a.state])}`
          : line === 1 ? `│ ${a.ctx ? c(band(a.ctx), k(a.ctx).padStart(4)) : grey('   —')} ${grey(dur(a))}`
          : `└${grey('─'.repeat(colW - 3))}`
        const cell = fit(txt, colW - 1) + ' '
        if (line === 0) hits.push({ y: out.length + 4, x0: 2 + i * colW, x1: 1 + (i + 1) * colW, a, col: i, row: r })
        s += i === laneCol && r === laneRow && line < 2 ? inv(cell.replace(/\x1b\[[0-9;]*m/g, '')) : cell
      })
      out.push(fit(s, W))
    }
  }
  const body = H - 6 - 5
  while (out.length < body) out.push(fit('', W))
  out.length = Math.min(out.length, body)
  const cur = lanes[laneCol][laneRow]
  out.push(fit(grey('─'.repeat(W)), W))
  out.push(...detail(cur, W).slice(0, 4))
  return out
}

// ---------- variant C: runs sidebar + timeline ----------
function viewC(W, H) {
  const out = [], SW = 30, GW = W - SW - 1
  const side = []
  let lastP = null
  RUNS.forEach((r, i) => {
    if (r.project !== lastP) { side.push(bold(` ${r.project}`)); lastP = r.project }
    const col = { live: '36', 'ended partial': '33', reclaimed: '90', 'runner dead': '31', 'ended ok': '32' }[r.status]
    const s1 = ` ${c(col, '■')} ${r.spec} ${grey(r.age)}`
    side.push(pane === 'runs' && i === runSel ? inv(fit(s1.replace(/\x1b\[[0-9;]*m/g, ''), SW)) : s1)
    side.push(`   ${c(col, r.status)}${r.note ? grey(' · ' + r.note) : ''}`)
  })
  const t0 = RUN.start, span = Date.now() - t0 + 5 * 60_000, LW = 16, BW = GW - LW - 16
  const axis = ' '.repeat(LW) + Array.from({ length: 5 }, (_, i) => fit(grey(`|${Math.round((span / 60_000) * i / 4)}m`), Math.floor(BW / 4))).join('')
  const gantt = [grey(fit(' AGENT', LW)) + axis]
  const list = agents.filter((a) => a.state !== 'queued').concat(agents.filter((a) => a.state === 'queued'))
  sel = Math.max(0, Math.min(sel, list.length - 1))
  list.forEach((a, i) => {
    const x = (t) => Math.round(((t - t0) / span) * BW)
    let bar = ' '.repeat(BW)
    if (a.state !== 'queued') {
      const s = x(a.start), e = Math.max(s + 1, x(a.end ?? Date.now()))
      const colr = a.state === 'failed' ? '31' : a.ctx ? band(a.ctx) : '90'
      bar = ' '.repeat(s) + c(colr, (a.state === 'failed' ? '✗' : '█').repeat(e - s)) + ' ' + c(SCOL[a.state], GLYPH[a.state]) + ' '.repeat(Math.max(0, BW - e - 2))
    } else bar = grey(`  queued${a.blockedBy ? ' — blocked by #' + a.blockedBy : ''}`)
    const line = `${fit(' ' + a.label, LW)}${fit(bar, BW)} ${a.ctx ? c(band(a.ctx), k(a.ctx).padStart(5)) : '     '} ${grey(dur(a).padStart(7))}`
    gantt.push(pane === 'agents' && i === sel ? inv(fit(line.replace(/\x1b\[[0-9;]*m/g, ''), GW)) : line)
    hits.push({ y: gantt.length + 3, x0: SW + 2, x1: W, a })
  })
  const body = H - 6 - 6
  for (let i = 0; i < body; i++) out.push(fit(side[i] ?? '', SW) + grey('│') + fit(gantt[i] ?? '', GW))
  out.push(fit(grey('─'.repeat(SW) + '┴' + '─'.repeat(GW) + ' runner.log'), W))
  LOG.slice(-4).forEach((l) => out.push(fit(grey(' ' + l), W)))
  out.push(fit('', W))
  RUNS.forEach((r, i) => { /* sidebar hit rows */ })
  let y = 4; lastP = null
  RUNS.forEach((r, i) => { if (r.project !== lastP) { y++; lastP = r.project } hits.push({ y, x0: 1, x1: SW, run: i }); y += 2 })
  const cur = list[sel]
  return { out, cur }
}

// ---------- standalone run list (A/B) ----------
function viewRuns(W, H) {
  const out = [fit(bold(' All Orca-runner runs on this machine') + grey('  (standalone mode)'), W), fit('', W)]
  let lastP = null
  RUNS.forEach((r, i) => {
    if (r.project !== lastP) { out.push(fit(bold(` ▾ ${r.project}`), W)); lastP = r.project }
    const col = { live: '36', 'ended partial': '33', reclaimed: '90', 'runner dead': '31', 'ended ok': '32' }[r.status]
    const line = `    ${c(col, '■')} ${r.spec.padEnd(18)} ${grey(r.id)}  ${fit(c(col, r.status), 15)} ${grey(r.note)}  ${grey(r.age)}`
    hits.push({ y: out.length + 4, run: i })
    out.push(i === runSel ? inv(fit(line.replace(/\x1b\[[0-9;]*m/g, ''), W)) : fit(line, W))
  })
  while (out.length < H - 6) out.push(fit('', W))
  return out
}

// ---------- render ----------
function render() {
  const W = Number.isFinite(term.width) ? term.width : 140, H = Number.isFinite(term.height) ? term.height : 40
  hits = []
  let body
  if (standalone && variant !== 'C') body = viewRuns(W, H)
  else if (variant === 'A') body = viewA(W, H)
  else if (variant === 'B') body = viewB(W, H)
  else body = viewC(W, H).out
  let lines = [...header(W), ...body]
  lines.length = Math.min(lines.length, H - 3)
  while (lines.length < H - 3) lines.push(fit('', W))
  lines.push(...footer(W))
  if (modal) {
    const mw = Math.min(W - 8, 78), top = Math.floor(H / 2) - 3, left = Math.floor((W - mw) / 2)
    const box = [c('7', fit(' ' + modal.title, mw)), ...modal.lines.map((l) => c('100', fit(' ' + l, mw))), c('100', fit('', mw))]
    box.forEach((b, i) => { lines[top + i] = fit(' '.repeat(left) + b, W) })
  }
  process.stdout.write(`${E}H` + lines.slice(0, H).join('\r\n'))
}

// ---------- actions (stubs) ----------
function current() {
  if (variant === 'A') return rowsA().filter((r) => r.a)[sel]?.a
  if (variant === 'B') return agents.filter((a) => a.ticket === TICKETS[laneCol])[laneRow]
  return viewC(Number.isFinite(term.width) ? term.width : 140, Number.isFinite(term.height) ? term.height : 40).cur
}
function focus(a) { if (a) say(`→ orca terminal switch --terminal ${a.handle}   (would focus ${a.worktree}; stub)`) }
function reclaim(a) {
  if (!a) return
  if (live(a) || a.state === 'stuck') { say(`✗ refuse: ${a.label} is live — stop it first`); return }
  if (a.n === 14) {
    modal = { title: `Reclaim ${a.label}?`, lines: [c('33', 'worktree has 1 unpushed commit (7c756286 on ticket/1087)'), '', '[f] force reclaim — commit is lost     [any other key] cancel'], on: (key) => key === 'f' && say(`→ worker-release · terminal close · worktree rm --force ${a.worktree}   (stub)`) }
    render(); return
  }
  say(`→ worker-release ${a.handle} · terminal close · worktree rm ${a.worktree}   (stub)`)
}
function endPrompt() {
  const kept = agents.filter((a) => ['failed', 'dead', 'stuck', 'continued'].includes(a.state))
  modal = {
    title: 'Run ended — partial (4 PRs, 1 failed, 2 blocked). Reclaim what?',
    lines: ['[Enter] keep failed/dead, reclaim the rest (default)', `        keeps: ${kept.map((a) => a.label).join(', ')}`,
      `        reclaims: ${agents.filter((a) => a.state === 'done').length} done agents`, '[a] reclaim everything      [n] keep everything      then: open run view · exit'],
    on: (key) => say(key === 'a' ? 'reclaim everything (stub)' : key === 'n' ? 'kept everything (stub)' : `kept ${kept.length}, reclaimed the rest (stub)`),
  }
  render()
}
const resume = () => {
  const r = RUNS[runSel]
  say(standalone || variant === 'C' ? `→ orca terminal create --command "node runner.mjs … --resume" · run-use ${r.id}   (stub)` : '→ runner is alive; Resume is offered for dead runners (try s / C sidebar)')
}

// ---------- input ----------
function quit() { term.grabInput(false); term.hideCursor(false); term.fullscreen(false); process.exit(0) }
term.fullscreen(true); term.hideCursor(true); term.grabInput({ mouse: 'button' })
term.on('resize', render)
term.on('key', (name) => {
  if (name === 'CTRL_C' || (name === 'q' && !modal)) return quit()
  if (modal) { const m = modal; modal = null; flash = ''; m.on(name === 'ENTER' ? 'enter' : name); render(); return }
  flash = ''
  if (name === '1' || name === '2' || name === '3') { variant = 'ABC'[+name - 1]; standalone = false }
  else if (name === 'v') { variant = 'ABC'['ABC'.indexOf(variant) === 2 ? 0 : 'ABC'.indexOf(variant) + 1]; standalone = false }
  else if (name === 's' && variant !== 'C') standalone = !standalone
  else if (name === 'TAB' && variant === 'C') pane = pane === 'agents' ? 'runs' : 'agents'
  else if (name === 'UP' || name === 'DOWN') {
    const d = name === 'UP' ? -1 : 1
    if (standalone || (variant === 'C' && pane === 'runs')) runSel = Math.max(0, Math.min(RUNS.length - 1, runSel + d))
    else if (variant === 'B') laneRow += d
    else sel += d
  } else if ((name === 'LEFT' || name === 'RIGHT') && variant === 'B') { laneCol += name === 'LEFT' ? -1 : 1; laneRow = 0 }
  else if (name === 'ENTER') standalone || (variant === 'C' && pane === 'runs') ? say(`open ${RUNS[runSel].id} (attached view of that run; stub)`) : focus(current())
  else if (name === 'r') reclaim(current())
  else if (name === 'R') resume()
  else if (name === 'e') endPrompt()
  render()
})
term.on('mouse', (name, d) => {
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED' || modal) return
  const h = hits.find((x) => x.y === d.y && (x.x0 == null || (d.x >= x.x0 && d.x <= x.x1)))
  if (!h) return
  if (h.run != null) { runSel = h.run; pane = 'runs'; render(); return }
  if (variant === 'A') sel = rowsA().filter((r) => r.a).findIndex((r) => r.a === h.a)
  else if (variant === 'B') { laneCol = h.col; laneRow = h.row }
  else { pane = 'agents'; sel = agents.filter((a) => a.state !== 'queued').concat(agents.filter((a) => a.state === 'queued')).indexOf(h.a) }
  render(); focus(h.a)
})
render()
