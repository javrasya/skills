// The ticket view's screen (ADR-0031): the run's tickets as a star map, from
// runView's model.tickets (ticket-map.mjs), in the body of the run view's
// layout; draw.mjs puts it between the header and the pane. Lines of text
// with 24-bit colour, a braille dot grid for the lines between stars.
import { marqueeOffset } from './marquee.mjs'
import { byNumber, cameraAt, cannotMove, GLIDE_MS, latestAgent } from '../ticket-map.mjs'

// Each stage's star: a glyph that tells it without colour, and the colour.
export const STAGE = Object.freeze({
  todo: { glyph: '○', rgb: [120, 128, 145], word: 'not picked up' },
  impl: { glyph: '◐', rgb: [110, 195, 255], word: 'implementing' },
  gate: { glyph: '◆', rgb: [185, 140, 255], word: 'at the gate' },
  stacked: { glyph: '★', rgb: [95, 225, 140], word: 'stacked' },
  waiting: { glyph: '✸', rgb: [255, 165, 50], word: 'needs you' },
  failed: { glyph: '✗', rgb: [240, 90, 90], word: 'failed' },
})
const LEGEND = ['todo', 'impl', 'gate', 'stacked', 'waiting', 'failed']
// The heading's counts, what a person answers first.
const COUNTED = ['waiting', 'failed', 'gate', 'impl', 'stacked', 'todo']

export const TICKETS_HELP = ' ←→ along the lines · ↑↓ nearby · click a star · ⏎ its agent in the tree · t tree · l log · p pause · r resume · x remove · q out'

const fg = (rgb, b = false) => `\x1b[${b ? 1 : 22};38;2;${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(';')}m`
const tint = (rgb, s, b = false) => `${fg(rgb, b)}${s}\x1b[0m`
const scale = (rgb, k) => rgb.map((v) => v * k)
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const lum = (rgb) => rgb[0] + rgb[1] + rgb[2]
const GREY = [110, 115, 135]
const grey = (s) => tint(GREY, s)
const BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]
// How wide the selected star's `#n title` may be under it; a longer one
// scrolls as a selected agent's name does (marqueeOffset).
const LABEL_W = 30

// The background sky: fixed stars at fractions of the map, so a resize keeps
// it, drifting at a quarter of the camera's speed as it glides.
const SKY = Array.from({ length: 160 }, (_, i) => {
  const r = (salt) => {
    let h = Math.imul((i + 1) * 7919 + salt, 2654435761) >>> 0
    h ^= h >>> 13
    return (Math.imul(h, 1274126177) >>> 0) / 4294967296
  }
  return { fx: r(1), fy: r(2), phase: r(3) * 6.28, speed: 0.3 + r(4), glyph: r(5) < 0.7 ? '·' : '˙', brightness: 35 + r(6) * 45 }
})

// The line under the header: how many tickets, and how many at each stage.
export function ticketsHeading(tm) {
  if (!tm) return grey(' TICKETS')
  const counts = COUNTED.map((s) => [s, tm.list.filter((t) => t.stage === s).length])
    .filter(([, n]) => n)
    .map(([s, n]) => tint(STAGE[s].rgb, `${STAGE[s].glyph}${n} ${STAGE[s].word}`))
  return ` ${grey('TICKETS')} ${tm.list.length}   ${counts.join('  ')}`
}

// The star map, W wide and H high. tm: model.tickets, or null before the
// graph agent returned. now: the time the camera, the twinkle and the
// selected title's scroll are drawn at; without one, still, as at the last
// selection. Returns { lines, at(x, y), gliding }: at, the ticket whose star
// (or number) is at 0-based (x, y) of the map, or near enough, else null;
// gliding, whether the camera is still on its way.
export function starMap(tm, { width: W, height: H, now = null }) {
  const N = W * H
  const mask = new Uint8Array(N)
  const dotRgb = new Array(N).fill(null)
  const text = new Array(N).fill(null)
  const sky = new Array(N).fill(null)
  const put = (x, y, s, rgb, b = false) => {
    ;[...s].forEach((g, i) => {
      const X = x + i
      if (X >= 0 && X < W && y >= 0 && y < H) text[y * W + X] = [g, rgb, b]
    })
  }
  const dot = (px, py, rgb) => {
    px = Math.round(px)
    py = Math.round(py)
    const x = px >> 1
    const y = py >> 2
    if (px < 0 || py < 0 || x >= W || y >= H) return
    const k = y * W + x
    mask[k] |= BITS[py & 3][px & 1]
    if (!dotRgb[k] || lum(rgb) > lum(dotRgb[k])) dotRgb[k] = rgb
  }
  const out = () => {
    const lines = []
    for (let y = 0; y < H; y++) {
      let line = ''
      let last = null
      for (let x = 0; x < W; x++) {
        const k = y * W + x
        const [g, rgb, b] = text[k] ?? (mask[k] ? [String.fromCharCode(0x2800 + mask[k]), dotRgb[k], false] : (sky[k] ?? [' ', null, false]))
        const code = rgb ? fg(rgb, b) : '\x1b[0m'
        if (code !== last) line += code
        last = code
        line += g
      }
      lines.push(line + '\x1b[0m')
    }
    return lines
  }

  const t0 = now ?? tm?.selectedAt ?? 0
  const sel = tm?.list.find((t) => t.n === tm.selected) ?? tm?.list[0] ?? null
  const cam = sel ? cameraAt(tm.glide, sel, t0) : { x: 0, y: 0 }
  const mod = (a, m) => ((a % m) + m) % m
  for (const s of SKY) {
    const x = mod(Math.floor(s.fx * W - cam.x * 0.25), W)
    const y = mod(Math.floor(s.fy * H - cam.y * 0.25), H)
    const v = s.brightness * (now === null ? 0.8 : 0.6 + 0.4 * Math.sin((now / 1000) * s.speed + s.phase))
    sky[y * W + x] = [s.glyph, [v, v, v * 1.25], false]
  }
  if (!sel) {
    const say = 'no ticket graph yet: the Graph phase has not returned the run’s tickets'
    put(Math.max(0, Math.floor((W - say.length) / 2)), Math.floor(H / 2), say, GREY)
    return { lines: out(), at: () => null, gliding: false }
  }

  // The camera keeps the selected star in the middle. Lines and halos move by
  // braille dot (half a cell across, a quarter down); glyphs and text snap to
  // whole cells.
  const fx = W / 2 - cam.x
  const fy = Math.floor((H - 1) / 2) - cam.y
  const ox = Math.round(fx)
  const oy = Math.round(fy)
  const by = byNumber(tm.list)
  const centre = (t) => [Math.round((t.x + fx) * 2) + 1, Math.round((t.y + fy) * 4) + 2]

  // A line from each blocker to what it blocks, a curve that leaves and
  // arrives level, fading from one star's colour to the other's; lit while
  // either end is selected, dashed out of a ticket that cannot move.
  for (const b of tm.list) {
    for (const n of b.deps) {
      const a = by.get(n)
      const k = a === sel || b === sel ? 1 : 0.33
      const dashed = cannotMove(a) || a.held
      const [x1, y1] = centre(a)
      const [x2, y2] = centre(b)
      const len = Math.hypot(x2 - x1, y2 - y1)
      if (len < 1) continue
      const gap = 5 / len
      const steps = Math.ceil(len * 1.5)
      const dx = (x2 - x1) * 0.5
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        if (t < gap || t > 1 - gap || (dashed && Math.floor(i / 4) % 2)) continue
        const u = 1 - t
        const px = u ** 3 * x1 + 3 * u * u * t * (x1 + dx) + 3 * u * t * t * (x2 - dx) + t ** 3 * x2
        const py = u ** 3 * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y2
        dot(px, py, scale(mix(STAGE[a.stage].rgb, STAGE[b.stage].rgb, t), k))
      }
    }
  }

  // Where each star is drawn, in cells of the map, for the edge counts and clicks.
  const spot = new Map(tm.list.map((t) => [t.n, { x: t.x + ox, y: t.y + oy }]))
  const SPIN = ['◐', '◓', '◑', '◒']
  // A ticket at work breathes, one waiting on a person faster; still without a time.
  const live = (t) => t.stage === 'impl' || t.stage === 'gate' || t.stage === 'waiting'
  const pulseOf = (t) => (now === null ? 0.5 : 0.5 + 0.5 * Math.sin(now / (t.stage === 'waiting' ? 220 : 520) + t.n))
  for (const t of tm.list) {
    const s = STAGE[t.stage]
    const pulse = pulseOf(t)
    const [cx, cy] = centre(t)
    const rings = []
    if (live(t)) rings.push([5, 4, 0.12 + 0.2 * pulse])
    if (t === sel) rings.push([7, 6, 0.55], [10, 8, 0.2])
    for (const [rx, ry, k] of rings) {
      const count = Math.round(rx * 4)
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + t0 / 1500
        dot(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, scale(s.rgb, k))
      }
    }
  }
  for (const t of tm.list) {
    const s = STAGE[t.stage]
    const { x: sx, y: sy } = spot.get(t.n)
    const glyph = t.stage === 'impl' && now !== null ? SPIN[Math.floor(now / 300 + t.n) % 4] : s.glyph
    put(sx, sy, glyph, scale(s.rgb, t.stage === 'todo' ? 0.85 : live(t) ? 0.75 + 0.25 * pulseOf(t) : 1), true)
    let label = String(t.n)
    if (t === sel) {
      const chars = [...`#${t.n} ${t.title}`]
      const at = marqueeOffset(t0 - (tm.selectedAt ?? t0), chars.length, LABEL_W)
      label = chars.slice(at, at + LABEL_W).join('')
    }
    put(sx - Math.floor([...label].length / 2), sy + 1, label, t === sel ? [245, 245, 255] : scale(s.rgb, 0.55), t === sel)
    const tag = t.held ? 'held' : cannotMove(t) ? (t.note ?? '') : ''
    if (tag && t !== sel) {
      const short = [...tag].length > 16 ? `${[...tag].slice(0, 15).join('')}…` : tag
      put(sx - Math.floor([...short].length / 2), sy + 2, short, scale(s.rgb, 0.5))
    }
  }

  // How many stars lie off each edge, so the rest of the sky is never a
  // mystery; one off a corner counts on both its edges.
  const off = { left: 0, right: 0, up: 0, down: 0 }
  for (const { x, y } of spot.values()) {
    if (x < 0) off.left++
    if (x >= W) off.right++
    if (y < 0) off.up++
    if (y >= H) off.down++
  }
  const hint = [130, 135, 170]
  const mid = Math.floor((H - 1) / 2)
  if (off.left) put(1, mid, `‹ ${off.left}`, hint, true)
  if (off.right) put(W - 3 - String(off.right).length, mid, `${off.right} ›`, hint, true)
  if (off.up) put(Math.floor(W / 2) - 2, 0, `˄ ${off.up}`, hint, true)
  if (off.down) put(Math.floor(W / 2) - 2, H - 1, `˅ ${off.down}`, hint, true)

  const at = (x, y) => {
    let best = null
    let bd = Infinity
    for (const [n, s] of spot) {
      const dx = Math.abs(s.x - x)
      const dy = y - s.y
      if (dx > 3 || dy < -1 || dy > 1) continue
      const d = dx + Math.abs(dy) * 2
      if (d < bd) [best, bd] = [n, d]
    }
    return best
  }
  return { lines: out(), at, gliding: !!tm.glide && t0 - tm.glide.at < GLIDE_MS }
}

// The pane under the map: the selected ticket, its stage and note; its lines
// to other tickets; what its latest agent is doing, or what holds it; the key
// to the colours.
export function ticketPane(tm) {
  const legend = ' ' + LEGEND.map((s) => tint(STAGE[s].rgb, `${STAGE[s].glyph} ${STAGE[s].word}`)).join('   ')
  if (!tm) return [grey(' the graph agent returns the run’s tickets and the lines between them; t goes back to the tree'), '', '', legend]
  const t = tm.list.find((x) => x.n === tm.selected) ?? tm.list[0]
  const s = STAGE[t.stage]
  const by = byNumber(tm.list)
  const list = (ns) => (ns.length ? ns.map((n) => tint(STAGE[by.get(n).stage].rgb, `${STAGE[by.get(n).stage].glyph} #${n}`)).join('  ') : grey('—'))
  const latest = latestAgent(t)
  const holder = t.held ? t.deps.map((n) => by.get(n)).find((d) => cannotMove(d) || d.held) : null
  return [
    ` ${tint(s.rgb, `${s.glyph} #${t.n}`, true)} \x1b[1m${t.title}\x1b[0m  ${tint(s.rgb, `${s.word}${t.note ? ` · ${t.note}` : ''}${t.held ? ' · held' : ''}`)}`,
    ` blocked by  ${list(t.deps)}      blocks  ${list(t.kids)}`,
    holder ? ` ${grey('held:')} waits on #${holder.n}, ${holder.held ? 'itself held' : STAGE[holder.stage].word}` : latest ? ` ${grey('latest agent')} ${latest.label}  ${latest.state}${latest.reason ? grey(` — ${latest.reason}`) : ''}` : grey(' no agent has worked on it yet'),
    legend,
  ]
}
