// The `crew start` form at a terminal: the rows of start-form.mjs's model, one
// focused. Enter moves to the next row and, on the last, answers the form, so
// Enter all the way through takes every default. Resolves to the form's
// answers, or null when the operator cancels (Esc, Ctrl+C).
import { ARROW_KEYS, ENTER_KEYS, decodeKeys } from './keys.mjs'

const KEYS = [...ARROW_KEYS, ['\x1b[Z', 'up'], ...ENTER_KEYS, ['\t', 'down'], [' ', 'right'], ['\x7f', 'backspace'], ['\b', 'backspace'], ['\x03', 'interrupt']]

// The keys in one chunk of raw input (keys.mjs): each a name, or { char } for
// a character typed into the focused row's search. Esc is 'cancel', Ctrl+C
// 'interrupt'; an unknown sequence is no key of the form's.
export const keysOf = (chunk) => decodeKeys(chunk, KEYS, { char: (c) => (c > ' ' ? { char: c } : null) })

const BOLD = (s) => `\x1b[1m${s}\x1b[22m`
const DIM = (s) => `\x1b[2m${s}\x1b[22m`
const INVERSE = (s) => `\x1b[7m${s}\x1b[27m`
const CYAN = (s) => `\x1b[36m${s}\x1b[39m`

// How many of a row's options the focused row lists at once.
export const WINDOW = 10

// The options of `row` whose label or value holds `query`, any case: all of
// them when the query is empty.
export function matching(row, query = '') {
  const q = query.toLowerCase()
  return q ? row.options.filter((o) => `${o.label}\n${o.value}`.toLowerCase().includes(q)) : row.options
}

// The slice of `matches` to list: WINDOW of them, holding the current value.
export function windowOf(matches, value, size = WINDOW) {
  const at = Math.max(
    0,
    matches.findIndex((o) => o.value === value),
  )
  const start = Math.max(0, Math.min(at - Math.floor(size / 2), matches.length - size))
  return { start, shown: matches.slice(start, start + size) }
}

const optionText = (o) => `${o.label}${o.disabled ? ' (unavailable)' : ''}${o.note ? `: ${o.note}` : ''}`

export function drawStartForm(form, focus, heading = '', query = '') {
  const rows = form.rows()
  const width = Math.max(...rows.map((r) => r.label.length))
  const labelOf = (r) => r.options.find((o) => o.value === r.value)?.label ?? r.value ?? '(none)'
  const valueWidth = Math.min(40, Math.max(...rows.map((r) => labelOf(r).length)))
  const indent = ' '.repeat(width + 3)
  const lines = heading ? [BOLD(heading), ''] : []
  rows.forEach((r, i) => {
    const value = labelOf(r)
    const focused = i === focus
    const shownValue = focused ? INVERSE(` ${value} `) + ' '.repeat(Math.max(0, valueWidth - value.length)) : ` ${value.padEnd(valueWidth)} `
    lines.push(`${focused ? CYAN('›') : ' '} ${focused ? BOLD(r.label.padEnd(width)) : r.label.padEnd(width)}  ${shownValue}  ${DIM(r.flag)}`)
    if (!focused) {
      // A disabled stack mode says why even while its row is not focused.
      for (const o of r.options) if (o.note && r.row === 'stackMode') lines.push(`${indent}${DIM(optionText(o))}`)
      return
    }
    const matches = matching(r, query)
    if (r.options.length > 2 || query) {
      const count = query ? `${matches.length} of ${r.options.length}` : `${r.options.length}`
      lines.push(`${indent}${DIM('search')} ${query}${INVERSE(' ')}  ${DIM(count)}`)
    }
    if (!matches.length) {
      lines.push(`${indent}  ${DIM('no match, Backspace to widen')}`)
      return
    }
    const { start, shown } = windowOf(matches, r.value)
    if (start > 0) lines.push(`${indent}  ${DIM(`↑ ${start} more`)}`)
    for (const o of shown) {
      const text = optionText(o)
      if (o.value === r.value) lines.push(`${indent}${CYAN('●')} ${BOLD(text)}`)
      else lines.push(`${indent}  ${o.disabled ? DIM(text) : text}`)
    }
    const after = matches.length - start - shown.length
    if (after > 0) lines.push(`${indent}  ${DIM(`↓ ${after} more, type to narrow`)}`)
  })
  lines.push('', DIM('Type: search   Left/Right: pick   Up/Down: row   Enter: next row, on the last arm and launch   Esc: clear search, then cancel'))
  return lines
}

// Raw input from `stdin` to `onData` until it calls the `done` it is handed,
// redrawn after each chunk; resolves to what `done` was given.
function interact({ stdin, draw, onData }) {
  return new Promise((resolve) => {
    let over = false
    const done = (value) => {
      over = true
      stdin.off('data', listen)
      stdin.setRawMode?.(false)
      stdin.pause?.()
      resolve(value)
    }
    function listen(data) {
      if (over) return
      onData(String(data), done)
      if (!over) draw()
    }
    stdin.setRawMode?.(true)
    stdin.setEncoding?.('utf8')
    stdin.on('data', listen)
    stdin.resume?.()
    draw()
  })
}

const paint = (stdout, lines) => stdout.write(`\x1b[2J\x1b[H${lines.join('\r\n')}\r\n`)

// Typing narrows the focused row's options to those holding the query and
// picks the first usable one, unless the current one still matches; Left and
// Right step through the matches only. Leaving the row drops its query.
export function runStartForm({ form, stdin, stdout, heading = '' }) {
  let focus = 0
  let query = ''
  const usable = (row) => matching(row, query).filter((o) => !o.disabled)
  const narrow = () => {
    const row = form.rows()[focus]
    const opts = usable(row)
    if (opts.length && !opts.some((o) => o.value === row.value)) form.set(row.row, opts[0].value)
  }
  const step = (dir) => {
    const row = form.rows()[focus]
    const opts = usable(row)
    if (!opts.length) return
    const i = opts.findIndex((o) => o.value === row.value)
    form.set(row.row, opts[i < 0 ? 0 : (i + dir + opts.length) % opts.length].value)
  }
  const move = (to) => {
    focus = Math.max(0, Math.min(form.rows().length - 1, to))
    query = ''
  }
  return interact({
    stdin,
    draw: () => paint(stdout, drawStartForm(form, focus, heading, query)),
    onData(chunk, done) {
      for (const key of keysOf(chunk)) {
        const rows = form.rows()
        if (key === 'interrupt') return done(null)
        if (key === 'cancel') {
          if (!query) return done(null)
          query = ''
        } else if (typeof key === 'object') {
          query += key.char
          narrow()
        } else if (key === 'backspace') {
          query = query.slice(0, -1)
          narrow()
        } else if (key === 'enter') {
          if (focus >= rows.length - 1) return done(form.answers())
          move(focus + 1)
        } else if (key === 'up') move(focus - 1)
        else if (key === 'down') move(focus + 1)
        else step(key === 'left' ? -1 : 1)
        focus = Math.min(focus, form.rows().length - 1)
      }
    },
  })
}
