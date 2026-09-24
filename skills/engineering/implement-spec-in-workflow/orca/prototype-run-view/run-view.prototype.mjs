// PROTOTYPE — throwaway. Question: what should the Orca runner's run view look like? (#43)
// One view, three layouts over the same fake, live-ticking run. Tab cycles them instantly; the
// status bar at the bottom shows which is on (and is clickable). Everything is fake: no Orca
// calls, actions only flash the command they would run.
//
//   Tree      — htop: phases fold/unfold (click, Enter, ←→), one row per agent, detail pane
//   Lanes     — the task graph: one lane per ticket, its agents as a pipeline, needs/unblocks
//   Timeline  — runs sidebar (standalone) + Gantt of agents over time + runner.log tail
//
// Keys: Tab next layout · ↑↓←→ move · Enter/click focus tab · r reclaim · R resume
//       e end-of-run prompt · s all runs (Tree/Lanes) · q quit
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
const BLOCKS = { 1154: [1087], 1156: [1087] }
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
const VIEWS = [['A', 'Tree'], ['B', 'Lanes'], ['C', 'Timeline']]
let variant = process.env.PROTO_VIEW ?? 'A', sel = +(process.env.PROTO_SEL ?? 0), laneRow = +(process.env.PROTO_LANE ?? 0), laneCol = +(process.env.PROTO_STAGE ?? 0), pane = 'agents', runSel = 0, standalone = false
const collapsed = new Set((process.env.PROTO_FOLD ?? '').split(',').filter(Boolean))
let flash = '', modal = null, hits = []
const say = (m) => { flash = m; render() }
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const mix = (as) => ['running', 'continued', 'stuck', 'failed', 'queued', 'done']
  .map((s) => [s, as.filter((a) => a.state === s).length]).filter(([, n]) => n)
  .map(([s, n]) => c(SCOL[s], `${GLYPH[s]}${n}`)).join(' ')

function header(W) {
  const run = `${bold(RUN.meta)} ${grey('·')} ${RUN.project} ${grey('·')} ${grey(RUN.id)} ${grey('·')} spec ${RUN.spec} ${grey('·')} runner ${c('32', '● alive')} ${grey('·')} ${dur({ start: RUN.start, state: 'x' })}`
  return [fit(' ' + run, W), fit(' ' + counts(), W), fit(grey('─'.repeat(W)), W)]
}
function footer(W, H) {
  const keysBy = { A: '↑↓ move · ←→ / click a phase to fold', B: '↑↓ ticket · ←→ stage', C: '↑↓ move · ←→ runs ⇄ agents' }
  const help = grey(` ${keysBy[variant]} · ⏎/click focus tab · r reclaim · R resume · e end-of-run${variant !== 'C' ? ' · s all runs' : ''} · q quit`)
  let bar = ' ', x = 2
  for (const [key, name] of VIEWS) {
    const label = ` ${name} `
    hits.push({ y: H, x0: x, x1: x + label.length - 1, view: key })
    bar += (key === variant ? c('1;30;46', label) : c('37;100', label)) + ' '
    x += label.length + 1
  }
  bar += grey(' Tab ▸ next layout')
  const tag = c('45;30', ' PROTOTYPE ')
  return [fit(flash ? ' ' + c('1;36', flash) : '', W), fit(help, W), fit(bar + ' '.repeat(Math.max(0, W - vis(bar) - 12)) + tag, W)]
}

// ---------- A: tree ----------
function rowsA() {
  const r = []
  for (const p of PHASES) {
    const as = agents.filter((a) => a.phase === p)
    if (!as.length) continue
    r.push({ phase: p, as })
    if (!collapsed.has(p)) as.forEach((a) => r.push({ a }))
  }
  return r
}
function viewA(W, H) {
  const out = [], rows = rowsA()
  sel = clamp(sel, 0, rows.length - 1)
  const cur = rows[sel]
  out.push(fit(grey('   #   AGENT                    STATE            CONTEXT           TOKENS   ELAPSED'), W))
  rows.forEach((r, i) => {
    let line
    if (r.phase) {
      const done = r.as.filter((a) => a.state === 'done').length
      const peak = Math.max(...r.as.map((a) => a.ctx))
      line = ` ${collapsed.has(r.phase) ? '▸' : '▾'} ${bold(r.phase.padEnd(10))} ${grey(`${done}/${r.as.length} done`.padEnd(10))}  ${mix(r.as)}${collapsed.has(r.phase) && peak ? grey('   peak ctx ') + c(band(peak), k(peak)) : ''}`
    } else {
      const a = r.a
      line = `  ${String(a.n).padStart(3)}   ${a.label.padEnd(22)} ${fit(st(a), 16)} ${ctxCell(a)}   ${grey(k(a.cum).padStart(6))}   ${dur(a).padStart(7)}`
    }
    hits.push({ y: out.length + 4, row: i })
    out.push(i === sel ? inv(fit(strip(line), W)) : fit(line, W))
  })
  const body = H - 3 - 3 - 6
  while (out.length < body) out.push(fit('', W))
  out.length = Math.min(out.length, body)
  out.push(fit(grey('─'.repeat(W)), W))
  if (cur.a) out.push(...detail(cur.a, W).slice(0, 5))
  else {
    const as = cur.as
    out.push(fit(` ${bold(cur.phase)}  ${as.length} agents  ${mix(as)}`, W))
    as.filter((a) => a.reason || a.blockedBy).forEach((a) => out.push(fit(`   ${c(SCOL[a.state], GLYPH[a.state])} ${a.label}: ${grey(a.reason ?? `blocked by #${a.blockedBy}`)}`, W)))
    out.push(fit(grey(`   ${collapsed.has(cur.phase) ? '→ / Enter / click to unfold' : '← / Enter / click to fold'}`), W))
  }
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

// ---------- B: lanes ----------
const ORDER = { Implement: 0, Gate: 1, Fix: 2, Publish: 3 }
function stagesOf(t) {
  const as = agents.filter((a) => a.ticket === t).sort((a, b) => ORDER[a.phase] - ORDER[b.phase] || a.n - b.n)
  if (!as.some((a) => a.phase === 'Gate')) as.push({ placeholder: true, phase: 'Gate', label: 'gate' })
  if (!as.some((a) => a.phase === 'Publish')) as.push({ placeholder: true, phase: 'Publish', label: 'publish' })
  return as
}
const short = (a) => a.placeholder ? a.label : a.phase === 'Implement' ? `impl ${a.label.split(':')[2]}` : a.phase === 'Gate' ? `gate ${a.label.split(':')[2]}` : 'publish'
const CHIP = 23
function chip(a) {
  if (a.placeholder) return fit(grey(`○ ${a.label}`), CHIP)
  const tail = a.state === 'queued' ? grey('waiting') : `${a.ctx ? c(band(a.ctx), k(a.ctx)) : grey('—')} ${grey(dur(a))}`
  return fit(`${c(SCOL[a.state], GLYPH[a.state])} ${c(SCOL[a.state], short(a).padEnd(8))} ${tail}`, CHIP)
}
function ticketState(t) {
  const as = agents.filter((a) => a.ticket === t)
  const pub = as.find((a) => a.pr)
  if (pub) return c('32', `✓ PR #${pub.pr}`)
  if (as.some((a) => a.state === 'failed')) return c('31', '✗ failed')
  if ((BLOCKS[t] ?? []).some((b) => !agents.some((a) => a.ticket === b && a.pr))) return c('33', '⧗ blocked')
  if (as.some((a) => a.state === 'stuck')) return c('33', '◐ stuck')
  if (as.some(live)) return c('36', '● running')
  return grey('· queued')
}
function viewB(W, H) {
  const out = []
  const chain = ['discover', 'layer0'].map((l) => agents.find((a) => a.label === l))
  const integ = agents.find((a) => a.label === 'integration')
  const doneT = TICKETS.filter((t) => agents.some((a) => a.ticket === t && a.pr)).length
  out.push(fit(` ${chain.map((a) => `${c(SCOL[a.state], GLYPH[a.state])} ${a.label}`).join(grey(' ─▶ '))}${grey(' ─▶ ')}${bold(`${TICKETS.length} tickets`)} ${grey(`(${doneT} published)`)}${grey(' ─▶ ')}${c(SCOL[integ.state], GLYPH[integ.state])} integration ${grey('(waits on all tickets)')}`, W))
  out.push(fit('', W))
  out.push(fit(grey('   TICKET   STATUS        NEEDS      UNBLOCKS    PIPELINE  (implement ─▶ gate ─▶ publish)'), W))
  laneRow = clamp(laneRow, 0, TICKETS.length - 1)
  TICKETS.forEach((t, i) => {
    const stg = stagesOf(t)
    if (i === laneRow) laneCol = clamp(laneCol, 0, stg.length - 1)
    const needs = BLOCKS[t] ? BLOCKS[t].map((b) => '#' + b).join(',') : '—'
    const unblocks = Object.entries(BLOCKS).filter(([, bs]) => bs.includes(t)).map(([x]) => '#' + x).join(',') || '—'
    const pre = ` ${i === laneRow ? c('1;36', '▶') : ' '} ${bold('#' + t)}  ${fit(ticketState(t), 13)} ${fit(needs === '—' ? grey(needs) : c('33', needs), 10)} ${fit(unblocks === '—' ? grey(unblocks) : c('35', unblocks), 11)} `
    let line = pre, x = vis(pre) + 1
    stg.forEach((a, j) => {
      const ch = chip(a)
      hits.push({ y: out.length + 4, x0: x, x1: x + CHIP - 1, lane: i, stage: j })
      line += i === laneRow && j === laneCol ? inv(strip(ch)) : ch
      x += CHIP
      if (j < stg.length - 1) { line += grey(' ─▶ '); x += 4 }
    })
    out.push(fit(line, W))
    const failedDep = BLOCKS[t] && agents.some((a) => BLOCKS[t].includes(a.ticket) && a.state === 'failed')
    const note = stg.find((a) => a.reason) ?? (failedDep ? { reason: `will not start: #${BLOCKS[t].join(', #')} failed`, state: 'queued' } : null)
    out.push(fit(note ? `${' '.repeat(vis(pre))}${c(SCOL[note.state] ?? '90', '└ ' + note.reason)}` : '', W))
  })
  const body = H - 6 - 6
  while (out.length < body) out.push(fit('', W))
  out.length = Math.min(out.length, body)
  out.push(fit(grey('─'.repeat(W)), W))
  const cur = stagesOf(TICKETS[laneRow])[laneCol]
  if (cur && !cur.placeholder) out.push(...detail(cur, W).slice(0, 5))
  else out.push(fit(grey(` #${TICKETS[laneRow]} ${cur?.label ?? ''}: not started yet — runs after the stages before it`), W))
  return out
}

// ---------- C: timeline ----------
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

// ---------- standalone run list (Tree/Lanes) ----------
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
function dims() { return [Number.isFinite(term.width) ? term.width : 140, Number.isFinite(term.height) ? term.height : 40] }
function render() {
  const [W, H] = dims()
  hits = []
  let body
  if (standalone && variant !== 'C') body = viewRuns(W, H)
  else if (variant === 'A') body = viewA(W, H)
  else if (variant === 'B') body = viewB(W, H)
  else body = viewC(W, H).out
  const lines = [...header(W), ...body]
  lines.length = Math.min(lines.length, H - 3)
  while (lines.length < H - 3) lines.push(fit('', W))
  lines.push(...footer(W, H))
  if (modal) {
    const mw = Math.min(W - 8, 84), top = Math.floor(H / 2) - 3, left = Math.floor((W - mw) / 2)
    const box = [c('7', fit(' ' + modal.title, mw)), ...modal.lines.map((l) => c('100', fit(' ' + l, mw))), c('100', fit('', mw))]
    box.forEach((b, i) => { lines[top + i] = fit(' '.repeat(left) + b, W) })
  }
  process.stdout.write(`${E}H` + lines.slice(0, H).join('\r\n'))
}

// ---------- actions (stubs) ----------
function current() {
  if (variant === 'A') return rowsA()[sel]?.a
  if (variant === 'B') { const a = stagesOf(TICKETS[laneRow])[laneCol]; return a?.placeholder ? null : a }
  const [W, H] = dims(); return viewC(W, H).cur
}
function focus(a) { if (a) say(`→ orca terminal switch --terminal ${a.handle}   (would focus ${a.worktree}; stub)`) }
function reclaim(a) {
  if (!a) return
  if (live(a) || a.state === 'stuck') { say(`✗ refuse: ${a.label} is live — stop it first`); return }
  if (a.n === 14) {
    modal = { title: `Reclaim ${a.label}?`, lines: [c('33', 'worktree has 1 unpushed commit (7c756286 on ticket/1087)'), '', '[f] force reclaim — commit is lost     [any other key] cancel'], on: (key) => key === 'f' && say(`→ worker-release · terminal close · worktree rm --force ${a.worktree}   (stub)`) }
    return
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
}
const resume = () => {
  const r = RUNS[runSel]
  say(standalone || variant === 'C' ? `→ orca terminal create --command "node runner.mjs … --resume" · run-use ${r.id}   (stub)` : '→ runner is alive; Resume is offered for dead runners (try s, or the Timeline sidebar)')
}
const toggle = (p) => { if (collapsed.has(p)) collapsed.delete(p); else collapsed.add(p) }
const nextView = () => { variant = VIEWS[(VIEWS.findIndex(([key]) => key === variant) + 1) % VIEWS.length][0]; standalone = false }

// ---------- input ----------
function quit() { term.grabInput(false); term.hideCursor(false); term.fullscreen(false); process.exit(0) }
term.fullscreen(true); term.hideCursor(true); term.grabInput({ mouse: 'button' })
term.on('resize', render)
term.on('key', (name) => {
  if (name === 'CTRL_C' || (name === 'q' && !modal)) return quit()
  if (modal) { const m = modal; modal = null; flash = ''; m.on(name === 'ENTER' ? 'enter' : name); render(); return }
  flash = ''
  const runsPane = standalone || (variant === 'C' && pane === 'runs')
  if (name === 'TAB') nextView()
  else if (name === 's' && variant !== 'C') standalone = !standalone
  else if (name === 'UP' || name === 'DOWN') {
    const d = name === 'UP' ? -1 : 1
    if (runsPane) runSel = clamp(runSel + d, 0, RUNS.length - 1)
    else if (variant === 'B') laneRow += d
    else sel += d
  } else if (name === 'LEFT' || name === 'RIGHT') {
    const d = name === 'LEFT' ? -1 : 1
    if (variant === 'B' && !standalone) laneCol += d
    else if (variant === 'C') pane = d < 0 ? 'runs' : 'agents'
    else if (variant === 'A' && !standalone) {
      const rows = rowsA(), r = rows[sel]
      if (r?.phase) { if (d < 0) collapsed.add(r.phase); else collapsed.delete(r.phase) }
      else if (r?.a && d < 0) sel = rows.findIndex((x) => x.phase === r.a.phase)
    }
  } else if (name === 'ENTER') {
    if (runsPane) say(`open ${RUNS[runSel].id} (attached view of that run; stub)`)
    else if (variant === 'A' && rowsA()[sel]?.phase) toggle(rowsA()[sel].phase)
    else focus(current())
  } else if (name === 'r') reclaim(current())
  else if (name === 'R') resume()
  else if (name === 'e') endPrompt()
  render()
})
term.on('mouse', (name, d) => {
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED' || modal) return
  const h = hits.find((x) => x.y === d.y && (x.x0 == null || (d.x >= x.x0 && d.x <= x.x1)))
  if (!h) return
  flash = ''
  if (h.view) { variant = h.view; standalone = false }
  else if (h.run != null) { runSel = h.run; pane = 'runs' }
  else if (h.row != null) {
    sel = h.row
    const r = rowsA()[sel]
    if (r.phase) toggle(r.phase)
    else { render(); focus(r.a); return }
  } else if (h.lane != null) {
    laneRow = h.lane; laneCol = h.stage
    const a = stagesOf(TICKETS[laneRow])[laneCol]
    if (!a.placeholder) { render(); focus(a); return }
  } else if (h.a) {
    pane = 'agents'
    sel = agents.filter((a) => a.state !== 'queued').concat(agents.filter((a) => a.state === 'queued')).indexOf(h.a)
    render(); focus(h.a); return
  }
  render()
})
render()
