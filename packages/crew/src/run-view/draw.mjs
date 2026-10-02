// The run view's screen, as lines of text with ANSI colour, from the model
// (run-view-model.mjs), laid out as the design reference draws it
// (docs/design/orca-run-view-tree.md). No terminal here: view.mjs writes the
// lines and hands a click's row back through rowAt.
import { STATES, bandOf } from '../run-view-model.mjs'
import { worktreeName } from '../git.mjs'
import { RUNNER_SETTINGS } from '../settings.mjs'
import { LEGACY_HOST } from '../hosts.mjs'
import { backKeyLabel } from '../crew-config.mjs'

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

const GLYPH = { queued: '·', starting: '◌', running: '●', blocked: '!', 'needs you': '?', stuck: '◐', continued: '↻', done: '✓', failed: '✗', reclaimed: '○' }
const COLOUR = { queued: '90', starting: '34', running: '36', blocked: '1;91', 'needs you': '1;33', stuck: '33', continued: '35', done: '32', failed: '31', reclaimed: '2' }
// The design's order for the header counts, the states a human answers first; a phase row lists
// its mix in STATES order.
const COUNTED = ['blocked', 'needs you', 'starting', 'running', 'continued', 'stuck', 'queued', 'done', 'failed', 'reclaimed']
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
// A patient's STATE is its trail: one ✗ per failure a doctor answered, then
// its glyph and state, the last ✗ its glyph while it is failed, a remedy's
// continued drawn ● to tell it from the runner's own ↻. The count is its
// attempt, but continued counts the doctors' continuations, so that
// `continued ×n` means one thing (#77): `✗✗● continued ×2` is on attempt 3.
// The runner's own continuations are the pane's, never the label's.
function stateOf(a) {
  if (!a.failures) return c(COLOUR[a.state], `${GLYPH[a.state]} ${a.state}`)
  const count = a.state === 'continued' ? a.attempt - 1 : a.attempt
  const glyph = a.state === 'failed' ? '' : a.state === 'continued' ? GLYPH.running : GLYPH[a.state]
  return c(COLOUR.failed, '✗'.repeat(a.failures)) + c(COLOUR[a.state], `${glyph} ${a.state}${count > 1 ? ` ×${count}` : ''}`)
}
const STATE_W = 18
const banded = (a, s) => (a.band ? c(BAND[a.band], s) : s)
function contextCell(a) {
  if (a.context == null) return grey('░'.repeat(BAR)) + ' ' + '—'.padStart(4)
  const full = Math.min(BAR, Math.round((a.context / BAR_FULL) * BAR))
  return banded(a, '█'.repeat(full)) + grey('░'.repeat(BAR - full)) + ' ' + banded(a, size(a.context).padStart(4))
}
const mixOf = (mix) => STATES.filter((s) => mix[s]).map((s) => c(COLOUR[s], `${GLYPH[s]}${mix[s]}`)).join(' ')

// An ended run reads as how it ended, not as its runner gone (#157).
const OUTCOME_GLYPH = { complete: ['32', '✓ complete'], halted: ['1;33', '⏸ halted'], failed: ['31', '✗ failed'] }
const outcomeLine = (o) => {
  const [colour, label] = OUTCOME_GLYPH[o.kind]
  return c(colour, `${label}${o.detail ? ` — ${o.detail}` : ''}${o.kind === 'halted' ? ' · r to resume' : ''}`)
}

function headerLines(h, W) {
  if (!h) return [fit('', W), fit('', W)]
  const dot = grey(' · ')
  const run = [
    h.name && bold(h.name), h.project, h.runId && grey(h.runId), h.spec && `spec ${h.spec}`,
    h.outcome ? outcomeLine(h.outcome) : `runner ${h.alive === true ? c('32', '● alive') : h.alive === false ? c('31', '○ gone') : grey('? unknown')}`, duration(h.elapsedMs),
  ].filter(Boolean).join(dot)
  const counts = COUNTED.filter((s) => h.counts?.[s]).map((s) => c(COLOUR[s], `${GLYPH[s]} ${h.counts[s]} ${s}`)).join('  ')
  const halted = h.halted ? c('1;33', `⏸ halted — ${h.halted.nodes.length} node${h.halted.nodes.length === 1 ? '' : 's'} need${h.halted.nodes.length === 1 ? 's' : ''} you · r to resume`) : null
  const paused = h.paused ? c('1;33', `⏸ paused${h.paused.finishing ? ` — ${h.paused.finishing} agent${h.paused.finishing === 1 ? '' : 's'} finishing` : ''} · r to resume`) : null
  const lead = [h.outage && outageOf(h.outage), paused, halted].filter(Boolean)
  return [fit(' ' + run, W), fit(' ' + (lead.length ? lead.join(dot) + dot + counts : counts), W)]
}

// An Orca outage is the run's, not an agent's (ADR-0015): it heads the counts,
// and every agent keeps its own state.
const outageOf = (o) => c('1;33', o.phase === 'paused'
  ? `⏸ paused: Orca outage past ${Math.round(RUNNER_SETTINGS.outageLimitMs / 60_000)}m — r to resume`
  : `⚠ Orca unreachable — waiting ${duration(o.elapsedMs)} (probe ${o.probes})`)

function phaseLine(p) {
  const peak = p.folded && p.peakContext != null ? grey('   peak ctx ') + banded({ band: bandOf(p.peakContext) }, size(p.peakContext)) : ''
  return ` ${p.folded ? '▸' : '▾'} ${bold(p.name.padEnd(10))} ${grey(`${p.done}/${p.total} done`.padEnd(10))}  ${mixOf(p.mix)}${peak}`
}

// The name column's width. A name that overflows it is cut, ending in …, on
// every row but the selected one, where it scrolls (marqueeOffset).
export const NAME_W = 34
const MARQUEE = { holdStartMs: 3000, holdEndMs: 5000, msPerChar: 250 }

// How many characters a selected name of `length` scrolls left by, `elapsedMs`
// after its row was selected, in a column `width` wide: 0 while it fits.
// Otherwise it shows its start for 3 s, scrolls left at 4 characters a
// second until its end is in view, holds its end for 5 s, and snaps back to
// its start, over and over.
export function marqueeOffset(elapsedMs, length, width) {
  const max = length - width
  if (max <= 0) return 0
  const scrollMs = max * MARQUEE.msPerChar
  const t = Math.max(0, elapsedMs) % (MARQUEE.holdStartMs + scrollMs + MARQUEE.holdEndMs)
  return t < MARQUEE.holdStartMs ? 0 : Math.min(max, Math.floor((t - MARQUEE.holdStartMs) / MARQUEE.msPerChar))
}

// A row's name, NAME_W wide. A doctor's row, under its patient's, names only
// its role, after its └: its label is `recover -> <the patient's label>`, the
// row above. `elapsed`, on the selected row only, is how long it has been
// selected, and scrolls a name that overflows; else that name is cut.
// overflows: whether it does.
function nameCell(a, depth, elapsed) {
  const prefix = depth ? `${'  '.repeat(depth - 1)}└ ` : ''
  const chars = [...(depth ? a.label.split(' -> ')[0] : a.label)]
  const w = NAME_W - prefix.length
  if (chars.length <= w) return { text: (prefix + chars.join('')).padEnd(NAME_W), overflows: false }
  if (elapsed == null) return { text: prefix + chars.slice(0, w - 1).join('') + '…', overflows: true }
  const at = marqueeOffset(elapsed, chars.length, w)
  return { text: prefix + chars.slice(at, at + w).join(''), overflows: true }
}

const agentLine = (a, depth = 0, elapsed = null) =>
  `  ${String(a.n).padStart(3)}   ${nameCell(a, depth, elapsed).text} ${fit(stateOf(a), STATE_W)} ${contextCell(a)}   ${grey(size(a.tokens).padStart(6))}   ${duration(a.elapsedMs).padStart(7)}${a.parked ? grey('   ⏾ parked') : ''}`

const PANE = 4

// A worktree by its `<runId>-<n>` name and a tab by its handle's first
// characters, as the design draws them, so the line holds the session too.
const shortHandle = (h) => h.replace(/^(term_[0-9a-f]{8})-[-0-9a-f]+$/, '$1')

function agentPane(a) {
  const tab = a.terminal ? `${cyan(shortHandle(a.terminal))}${a.parked ? grey(' (parked: Enter resumes it)') : a.tabOpen === true ? grey(' (open)') : a.tabOpen === false ? grey(' (closed)') : ''}` : grey('—')
  return [
    ` ${bold(a.title ?? `[${a.phase}] ${a.label}`)}  ${stateOf(a)}  ctx ${a.context == null ? '—' : banded(a, size(a.context))}  total ${grey(size(a.tokens))}  ${duration(a.elapsedMs)}`,
    ` worktree ${a.worktree ? cyan(worktreeName(a.worktree)) : grey('—')}   tab ${tab}   session ${grey(a.sessionId ?? '—')}${a.continuations ? `   ${c(COLOUR.continued, `the runner continued it ${a.continuations} time${a.continuations === 1 ? '' : 's'}`)}` : ''}`,
    a.reason ? ` ${c(a.state === 'failed' || a.state === 'blocked' ? '31' : '33', 'reason')} ${a.reason}${a.state === 'starting' && a.nextAt ? grey(`; next attempt at ${a.nextAt.slice(11, 19)}`) : ''}` : '',
    grey(` transcript ${a.transcript ?? '—'}`),
  ]
}

function phasePane(p, problems) {
  const lines = [` ${bold(p.name)}  ${p.total} agent${p.total === 1 ? '' : 's'}  ${mixOf(p.mix)}`]
  const room = PANE - 2
  const shown = problems.length > room ? room - 1 : room
  for (const { agent, reason } of problems.slice(0, shown)) lines.push(`   ${c(COLOUR[agent.state], GLYPH[agent.state])} ${agent.label}: ${grey(reason ?? agent.state)}`)
  if (problems.length > shown) lines.push(grey(`   … ${problems.length - shown} more`))
  lines.push(grey(`   ${p.folded ? '→ / Enter / click to unfold' : 'Enter / click to fold'}`))
  return lines
}

const HELP = ' ↑↓ move · ⏎/click a phase to fold · ⏎/→/click focus tab · Ctrl+R reclaim · l log · q quit'
const TOP = 4

// An agent row's width: the halt panel takes what is right of it, or 30 columns.
// A terminal too narrow to leave ROW_MIN columns of rows beside that draws no panel.
const ROW_W = 97
const PANEL_MIN = 30
const ROW_MIN = 40

// `text` in lines of at most `w` characters (at least 1), broken at spaces where it can.
function wrap(text, w) {
  w = Math.max(1, w)
  const lines = []
  for (const para of String(text).split(/\r?\n/)) {
    let line = ''
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > w) {
        if (line) lines.push(line)
        lines.push(word.slice(0, w))
        word = word.slice(w)
        line = ''
      }
      if (!word) continue
      if (line && line.length + 1 + word.length > w) {
        lines.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    lines.push(line)
  }
  return lines
}

// The halt panel (#103): the run's halted.json, and the orchestrator's triage
// of it (model.halt), in `h` lines `w` wide, drawn right of the tree's rows.
// A triage asking, failed or never asked says so; r is the run's either way.
export function haltPanel(halt, w, h) {
  const tw = w - 2
  const body = []
  const add = (text, colour = null, indent = '') => {
    for (const l of wrap(text, tw - indent.length)) body.push(indent + (colour ? c(colour, l) : l))
  }
  const t = halt.triage
  if (!t) add(`not triaged: ${halt.nodes.join(', ')}`, '90')
  else if (t.state === 'asking') add(`asking the orchestrator about ${halt.nodes.join(', ')}…`, '36')
  else if (t.state === 'failed') {
    add('the triage question failed:', '31')
    add(t.error ?? 'no reason given', null, '  ')
    add('r resumes the run all the same', '90')
  } else {
    add(t.answer.summary)
    for (const n of t.answer.nodes) {
      body.push('')
      add(n.node, '1')
      add(`why: ${n.reason}`, null, '  ')
      for (const q of n.questions) add(`? ${q}`, '33', '  ')
      add(`decide: ${n.decide}`, '1;33', '  ')
    }
  }
  const room = h - 1
  const shown = body.length > room ? [...body.slice(0, room - 1), grey(`… ${body.length - room + 1} more lines`)] : body
  const bar = grey('│') + ' '
  return [bar + c('1;33', `⏸ halt triage · ${halt.at.slice(11, 19)}`), ...shown.map((l) => bar + l)].slice(0, h)
}

// The dialog's box lines, each already fitted to mw and coloured, and the
// index among them of its first option.
function dialogBox(d, mw) {
  const plain = (l) => c('100', fit(' ' + l, mw))
  const head = c('7', fit(' ' + d.title, mw))
  if (d.kind === 'confirm') return { box: [head, ...d.lines.map(plain), plain('')], first: null }
  const options = d.options.map((o, i) =>
    o.disabled ? c('100;90', fit(`   ${o.label} — ${o.reason}`, mw))
      : i === d.highlight ? c('7', fit(` ▸ ${o.label} — ${o.detail}`, mw))
      : plain(`  ${o.label} — ${o.detail}`))
  return { box: [head, ...options, plain(''), plain('↑↓ or the mouse moves · Enter reclaims · Esc closes'), plain('')], first: 1 }
}

// model: runView's model, its dialog drawn over the middle, and its halt, while
// halted.json names one, in the halt panel right of the rows. flash: the flash
// line's text (an action's outcome, or the latest event); alert: a blocked
// agent's line, drawn loud in its place when there is no flash. help: the key
// line, for a tree the standalone view opened.
// now: the time the selected row's name scrolls to, measured from
// model.selectedAt, when that row was selected; without one it shows its start.
// Returns the screen's lines, height of them; rowAt(y), the index in
// model.rows of the row drawn on terminal line y (1-based), or null;
// optionAt(y), the index of the dialog's option drawn there, or null; and
// scrolling, whether the selected row's name overflows, and so scrolls: the
// screen changes with `now` alone only then.
export function draw(model, { width: W = 140, height: H = 40, flash = null, alert = null, help = HELP, now = null } = {}) {
  const rows = model?.rows ?? []
  const selected = model?.selected ?? 0
  const body = Math.max(1, H - TOP - 1 - PANE - 2)
  const top = Math.max(0, Math.min(selected - body + 1, rows.length - body))
  const lines = [...headerLines(model?.header, W), fit(grey('─'.repeat(W)), W), fit(grey(`   #   ${'AGENT'.padEnd(NAME_W + 1)}  STATE              CONTEXT           TOKENS   ELAPSED`), W)]
  const since = model?.selectedAt ?? null
  const elapsed = now === null || since === null ? 0 : now - since
  const chosen = rows[selected]
  const scrolling = chosen?.kind === 'agent' && nameCell(chosen.agent, chosen.depth, elapsed).overflows
  for (let i = top; i < Math.min(rows.length, top + body); i++) {
    const r = rows[i]
    const line = r.kind === 'phase' ? phaseLine(r.phase) : agentLine(r.agent, r.depth, i === selected ? elapsed : null)
    lines.push(i === selected ? c('7', fit(strip(line), W)) : fit(line, W))
  }
  while (lines.length < TOP + body) lines.push(fit('', W))
  const pw = Math.min(W, Math.max(PANEL_MIN, W - ROW_W))
  if (model?.halt && W - pw >= ROW_MIN) {
    const panel = haltPanel(model.halt, pw, body)
    for (let i = 0; i < body; i++) lines[TOP + i] = fit(lines[TOP + i], W - pw) + fit(panel[i] ?? grey('│'), pw)
  }
  lines.push(fit(grey('─'.repeat(W)), W))
  const pane = model?.pane
  const paneLines = !pane ? [grey(' no agent has started yet')] : pane.kind === 'agent' ? agentPane(pane.agent) : phasePane(pane.phase, pane.problems)
  for (let i = 0; i < PANE; i++) lines.push(fit(paneLines[i] ?? '', W))
  lines.push(fit(flash ? ' ' + c('1;36', flash) : alert ? ' ' + c(COLOUR[alert.startsWith('NEEDS YOU') ? 'needs you' : 'blocked'], alert) : '', W))
  lines.push(fit(grey(help), W))

  const dialog = model?.dialog ?? null
  let optionsAt = null
  if (dialog) {
    const mw = Math.min(W - 4, 100)
    const left = Math.max(0, Math.floor((W - mw) / 2))
    const { box, first } = dialogBox(dialog, mw)
    const at = Math.max(0, Math.floor((H - box.length) / 2))
    if (first !== null) optionsAt = at + first + 1
    box.forEach((b, i) => {
      if (at + i < lines.length) lines[at + i] = fit(' '.repeat(left) + b, W)
    })
  }
  return {
    lines: lines.slice(0, H),
    scrolling,
    rowAt: (y) => {
      const i = top + (y - TOP - 1)
      // The dialog takes every click: the tree behind it takes none.
      return !dialog && y > TOP && y <= TOP + body && i < rows.length ? i : null
    },
    optionAt: (y) => {
      const k = optionsAt === null ? -1 : y - optionsAt
      return k >= 0 && k < dialog.options.length ? k : null
    },
  }
}

// --- standalone: every run the registry knows (runsView's model) ----------

// The tree's key line once the standalone view opened it.
export const TREE_HELP = ' ↑↓ move · ⏎/→/click focus tab · ⏎/click a phase to fold · ← back to the runs · Ctrl+R reclaim · l log · p pause · r resume · x remove'
const RUNS_HELP = ' ↑↓ move · ⏎/→/click open a run · ←→ fold a project · Ctrl+R reclaim the run · p pause · r resume · x remove · q quit'

// The key lines of `crew view`, which enters a crew run's sessions in place
// and comes back from one with `backKey`; an Orca run's agent is its tab.
// `?` is crew's orchestrator whatever the run's host.
export const consoleTreeHelp = (host, backKey) => host === 'crew'
  ? ` ↑↓ move · ⏎/→/click enter · ${backKeyLabel(backKey)} out of a session · ← runs · Ctrl+R reclaim · l log · p pause · r resume · x remove · ? orchestrator`
  : `${TREE_HELP} · ? orchestrator`
export const consoleRunsHelp = (backKey) => `${RUNS_HELP} · ${backKeyLabel(backKey)} leaves an entered session`

export function age(ms) {
  if (ms == null) return '—'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`
}

const outageHost = (paused) => (paused.reason === 'crew outage' ? 'crew' : 'Orca')
const OUTCOME = { ok: '32', partial: '33', failed: '31', halted: '1;33' }
// A run its live runner paused on an outage of its host, Orca or crew, is not running (ADR-0015).
const outcomeOf = (r) => (r.outcome ? c(OUTCOME[r.outcome], r.outcome) : r.outagePaused && r.alive !== false ? c('33', `paused (${outageHost(r.outagePaused)} outage)`) : r.operatorPaused ? c('33', 'paused') : r.alive ? c('36', 'running') : grey('unfinished'))
const runnerOf = (r) => (r.alive === true ? c('32', '● alive') : r.alive === false ? c('31', '○ dead') : grey('? unknown'))

const projectLine = (p) => ` ${p.folded ? '▸' : '▾'} ${bold(p.name)}  ${grey(p.path ?? '')}  ${grey(`${p.runs.length} run${p.runs.length === 1 ? '' : 's'}`)}`
const runLine = (r) =>
  `   ${r.runId.padEnd(20)} ${(r.spec ?? r.name ?? '—').padEnd(8)} ${fit(outcomeOf(r), 20)} ${fit(runnerOf(r), 10)} ${String(r.kept).padStart(4)}   ${age(r.ageMs).padStart(7)}${r.reclaimed ? grey('   reclaimed') : ''}`

function runPane(r) {
  // The tab outlives its runner, so whether it is open says nothing of the runner.
  const tab = r.terminal ? cyan(shortHandle(r.terminal)) : grey('—')
  const does = ['Enter / → opens its tree', r.reclaimed ? null : r.closable ? 'Ctrl+R reclaims every agent and closes the run' : 'Ctrl+R reclaims every agent it may; the run stays open', r.resumable ? 'r resumes it: its runner is dead' : null].filter(Boolean).join(' · ')
  return [
    ` ${bold(r.name ?? r.runId)}  ${grey(r.runId)}${r.spec ? `  spec ${r.spec}` : ''}  ${outcomeOf(r)}  ${r.kept} kept${r.reclaimed ? grey('  reclaimed') : ''}`,
    // A crew run's runner has no screen of its own to go to: its tree is the run.
    r.host === 'crew' ? ` project ${grey(r.project ?? '—')}` : ` runner tab ${tab}   project ${grey(r.project ?? '—')}`,
    grey(` run dir ${r.runDir ?? '—'}`),
    grey(`   ${does}`),
  ]
}

// model: runsView's, with no run opened. As draw: the lines, and rowAt(y).
// title: what the runs are, help: the key line.
export function drawRuns(model, { width: W = 140, height: H = 40, flash = null, title = 'Orca runs', help = RUNS_HELP } = {}) {
  const rows = model?.rows ?? []
  const selected = model?.selected ?? 0
  const body = Math.max(1, H - TOP - 1 - PANE - 2)
  const top = Math.max(0, Math.min(selected - body + 1, rows.length - body))
  const projects = model?.projects ?? []
  const all = projects.flatMap((p) => p.runs)
  const dot = grey(' · ')
  const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`
  const lines = [
    fit(` ${bold(title)}${dot}${count(all.length, 'run')}${dot}${count(projects.length, 'project')}`, W),
    fit(` ${c('32', `● ${all.filter((r) => r.alive === true).length} alive`)}  ${c('31', `○ ${all.filter((r) => r.alive === false).length} dead`)}  ${grey(`${all.filter((r) => r.reclaimed).length} reclaimed`)}`, W),
    fit(grey('─'.repeat(W)), W),
    fit(grey('   RUN                  SPEC     OUTCOME              RUNNER     KEPT       AGE'), W),
  ]
  for (let i = top; i < Math.min(rows.length, top + body); i++) {
    const r = rows[i]
    const line = r.kind === 'project' ? projectLine(r.project) : runLine(r.run)
    lines.push(i === selected ? c('7', fit(strip(line), W)) : fit(line, W))
  }
  while (lines.length < TOP + body) lines.push(fit('', W))
  lines.push(fit(grey('─'.repeat(W)), W))
  const row = rows[selected]
  const paneLines = !row ? [grey(' the run registry holds no run yet')]
    : row.kind === 'run' ? runPane(row.run)
    : [` ${bold(row.project.name)}  ${grey(row.project.path ?? '')}`, grey(`   ${count(row.project.runs.length, 'run')} · ${row.project.folded ? '→ / Enter to unfold' : '← / Enter to fold'}`)]
  for (let i = 0; i < PANE; i++) lines.push(fit(paneLines[i] ?? '', W))
  lines.push(fit(flash ? ' ' + c('1;36', flash) : '', W))
  lines.push(fit(grey(help), W))
  return {
    lines: lines.slice(0, H),
    rowAt: (y) => {
      const i = top + (y - TOP - 1)
      return y > TOP && y <= TOP + body && i < rows.length ? i : null
    },
  }
}

// `crew ls`: runsView's runs as plain lines, by project as the standalone
// list draws them, each run with its host, spec, outcome, runner, kept
// agents and age.
export function listRuns(model) {
  const projects = model?.projects ?? []
  if (!projects.length) return ['the run registry holds no run yet']
  const lines = []
  for (const p of projects) {
    lines.push(`${p.name}  ${p.path ?? ''}`.trimEnd())
    for (const r of p.runs) {
      lines.push(`  ${r.runId.padEnd(20)} ${(r.host ?? LEGACY_HOST).padEnd(5)} ${(r.spec ?? r.name ?? '—').padEnd(8)} ${strip(outcomeOf(r)).padEnd(20)} ${`runner ${strip(runnerOf(r))}`.padEnd(17)} ${String(r.kept).padStart(3)} kept  ${age(r.ageMs).padStart(7)}${r.reclaimed ? '  reclaimed' : ''}`)
    }
  }
  return lines
}
