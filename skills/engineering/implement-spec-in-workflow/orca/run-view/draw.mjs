// The run view's screen, as lines of text with ANSI colour, from the model
// (run-view-model.mjs), laid out as the design reference draws it
// (docs/design/orca-run-view-tree.md). No terminal here: view.mjs writes the
// lines and hands a click's row back through rowAt.
import { STATES, bandOf } from '../run-view-model.mjs'

const E = '\x1b['
const c = (code, s) => `${E}${code}m${s}${E}0m`
const grey = (s) => c('90', s)
const bold = (s) => c('1', s)
const cyan = (s) => c('36', s)
const ANSI = /\x1b\[[0-9;]*m/g
export const strip = (s) => s.replace(ANSI, '')

// Pads or cuts to exactly w visible characters, leaving escapes whole.
function fit(s, w) {
  let out = ''
  let n = 0
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      out += part
      continue
    }
    for (const ch of part) {
      if (n >= w) break
      out += ch
      n++
    }
  }
  return out + ' '.repeat(Math.max(0, w - n)) + `${E}0m`
}

const GLYPH = { queued: '·', running: '●', stuck: '◐', continued: '↻', done: '✓', failed: '✗' }
const COLOUR = { queued: '90', running: '36', stuck: '33', continued: '35', done: '32', failed: '31' }
// The design's order for the header counts; a phase row lists its mix in STATES order.
const COUNTED = ['running', 'continued', 'stuck', 'queued', 'done', 'failed']
const BAND = { green: '32', yellow: '33', red: '31' }
const BAR = 10
const BAR_FULL = 500_000

const size = (t) => (t == null ? '—' : t >= 1_000_000 ? `${(t / 1e6).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : String(t))
export function duration(ms) {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`
}
const stateOf = (a) => c(COLOUR[a.state], `${GLYPH[a.state]} ${a.state}${a.state === 'continued' && a.continuations ? ` ×${a.continuations}` : ''}`)
const banded = (a, s) => (a.band ? c(BAND[a.band], s) : s)
function contextCell(a) {
  if (a.context == null) return grey('░'.repeat(BAR)) + ' ' + '—'.padStart(4)
  const full = Math.min(BAR, Math.round((a.context / BAR_FULL) * BAR))
  return banded(a, '█'.repeat(full)) + grey('░'.repeat(BAR - full)) + ' ' + banded(a, size(a.context).padStart(4))
}
const mixOf = (mix) => STATES.filter((s) => mix[s]).map((s) => c(COLOUR[s], `${GLYPH[s]}${mix[s]}`)).join(' ')

function headerLines(h, W) {
  if (!h) return [fit('', W), fit('', W)]
  const dot = grey(' · ')
  const run = [
    h.name && bold(h.name), h.project, h.runId && grey(h.runId), h.spec && `spec ${h.spec}`,
    `runner ${h.alive ? c('32', '● alive') : c('31', '○ gone')}`, duration(h.elapsedMs),
  ].filter(Boolean).join(dot)
  const counts = COUNTED.filter((s) => h.counts?.[s]).map((s) => c(COLOUR[s], `${GLYPH[s]} ${h.counts[s]} ${s}`)).join('  ')
  return [fit(' ' + run, W), fit(' ' + counts, W)]
}

function phaseLine(p) {
  const peak = p.folded && p.peakContext != null ? grey('   peak ctx ') + banded({ band: bandOf(p.peakContext) }, size(p.peakContext)) : ''
  return ` ${p.folded ? '▸' : '▾'} ${bold(p.name.padEnd(10))} ${grey(`${p.done}/${p.total} done`.padEnd(10))}  ${mixOf(p.mix)}${peak}`
}

const agentLine = (a) =>
  `  ${String(a.n).padStart(3)}   ${a.label.padEnd(22)} ${fit(stateOf(a), 16)} ${contextCell(a)}   ${grey(size(a.tokens).padStart(6))}   ${duration(a.elapsedMs).padStart(7)}`

const PANE = 4

// A worktree by its `<runId>-<n>` name and a tab by its handle's first
// characters, as the design draws them, so the line holds the session too.
const nameOf = (path) => path.split(/[/\\]/).at(-1)
const shortHandle = (h) => h.replace(/^(term_[0-9a-f]{8})-[-0-9a-f]+$/, '$1')

function agentPane(a) {
  const tab = a.terminal ? `${cyan(shortHandle(a.terminal))}${a.tabOpen === true ? grey(' (open)') : a.tabOpen === false ? grey(' (closed)') : ''}` : grey('—')
  return [
    ` ${bold(a.title ?? `[${a.phase}] ${a.label}`)}  ${stateOf(a)}  ctx ${a.context == null ? '—' : banded(a, size(a.context))}  total ${grey(size(a.tokens))}  ${duration(a.elapsedMs)}${a.reclaimed ? grey('  reclaimed') : ''}`,
    ` worktree ${a.worktree ? cyan(nameOf(a.worktree)) : grey('—')}   tab ${tab}   session ${grey(a.sessionId ?? '—')}`,
    a.reason ? ` ${c(a.state === 'failed' ? '31' : '33', 'reason')} ${a.reason}` : '',
    grey(` transcript ${a.transcript ?? '—'}`),
  ]
}

function phasePane(p, problems) {
  const lines = [` ${bold(p.name)}  ${p.total} agent${p.total === 1 ? '' : 's'}  ${mixOf(p.mix)}`]
  const room = PANE - 2
  const shown = problems.length > room ? room - 1 : room
  for (const { agent, reason } of problems.slice(0, shown)) lines.push(`   ${c(COLOUR[agent.state], GLYPH[agent.state])} ${agent.label}: ${grey(reason ?? agent.state)}`)
  if (problems.length > shown) lines.push(grey(`   … ${problems.length - shown} more`))
  lines.push(grey(`   ${p.folded ? '→ / Enter / click to unfold' : '← / Enter / click to fold'}`))
  return lines
}

const HELP = ' ↑↓ move · ←→ / click a phase to fold · ⏎/click focus tab · r reclaim · l log · q quit'
const TOP = 4

// model: runView's model. flash: the flash line's text (an action's outcome,
// or the latest event). modal: { title, lines } drawn over the middle.
// Returns the screen's lines, height of them, and rowAt(y), the index in
// model.rows of the row drawn on terminal line y (1-based), or null.
export function draw(model, { width: W = 140, height: H = 40, flash = null, modal = null } = {}) {
  const rows = model?.rows ?? []
  const selected = model?.selected ?? 0
  const body = Math.max(1, H - TOP - 1 - PANE - 2)
  const top = Math.max(0, Math.min(selected - body + 1, rows.length - body))
  const lines = [...headerLines(model?.header, W), fit(grey('─'.repeat(W)), W), fit(grey('   #   AGENT                    STATE            CONTEXT           TOKENS   ELAPSED'), W)]
  for (let i = top; i < Math.min(rows.length, top + body); i++) {
    const r = rows[i]
    const line = r.kind === 'phase' ? phaseLine(r.phase) : agentLine(r.agent)
    lines.push(i === selected ? c('7', fit(strip(line), W)) : fit(line, W))
  }
  while (lines.length < TOP + body) lines.push(fit('', W))
  lines.push(fit(grey('─'.repeat(W)), W))
  const pane = model?.pane
  const paneLines = !pane ? [grey(' no agent has started yet')] : pane.kind === 'agent' ? agentPane(pane.agent) : phasePane(pane.phase, pane.problems)
  for (let i = 0; i < PANE; i++) lines.push(fit(paneLines[i] ?? '', W))
  lines.push(fit(flash ? ' ' + c('1;36', flash) : '', W))
  lines.push(fit(grey(HELP), W))

  if (modal) {
    const mw = Math.min(W - 4, 100)
    const left = Math.max(0, Math.floor((W - mw) / 2))
    const box = [c('7', fit(' ' + modal.title, mw)), ...modal.lines.map((l) => c('100', fit(' ' + l, mw))), c('100', fit('', mw))]
    const at = Math.max(0, Math.floor((H - box.length) / 2))
    box.forEach((b, i) => {
      if (at + i < lines.length) lines[at + i] = fit(' '.repeat(left) + b, W)
    })
  }
  return {
    lines: lines.slice(0, H),
    rowAt: (y) => {
      const i = top + (y - TOP - 1)
      return y > TOP && y <= TOP + body && i < rows.length && !modal ? i : null
    },
  }
}
