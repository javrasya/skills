// The `crew start` form at a terminal: the rows of start-form.mjs's model, one
// focused. Enter moves to the next row and, on the last, answers the form, so
// Enter all the way through takes every default. Resolves to the form's
// answers, or null when the operator cancels (Esc, Ctrl+C).
const KEYS = [
  ['\x1b[A', 'up'], ['\x1bOA', 'up'], ['\x1b[B', 'down'], ['\x1bOB', 'down'],
  ['\x1b[C', 'right'], ['\x1bOC', 'right'], ['\x1b[D', 'left'], ['\x1bOD', 'left'],
  ['\x1b[Z', 'up'], ['\r\n', 'enter'], ['\r', 'enter'], ['\n', 'enter'], ['\t', 'down'], [' ', 'right'], ['\x03', 'cancel'],
]

// The keys in one chunk of raw input. An escape no sequence above starts is
// Esc: the chunk carries the whole sequence, as raw input delivers a keypress.
export function keysOf(chunk) {
  const keys = []
  for (let i = 0; i < chunk.length;) {
    const hit = KEYS.find(([seq]) => chunk.startsWith(seq, i))
    if (hit) {
      keys.push(hit[1])
      i += hit[0].length
    } else if (chunk[i] === '\x1b') {
      const seq = /^\x1b(\[[0-9;]*[~A-Za-z]|O[A-Za-z])?/.exec(chunk.slice(i))[0]
      if (seq.length === 1) keys.push('cancel')
      i += seq.length
    } else {
      i++
    }
  }
  return keys
}

const BOLD = (s) => `\x1b[1m${s}\x1b[22m`
const DIM = (s) => `\x1b[2m${s}\x1b[22m`
const INVERSE = (s) => `\x1b[7m${s}\x1b[27m`

export function drawStartForm(form, focus, heading = '') {
  const rows = form.rows()
  const width = Math.max(...rows.map((r) => r.label.length))
  const lines = heading ? [BOLD(heading), ''] : []
  rows.forEach((r, i) => {
    const current = r.options.find((o) => o.value === r.value)
    const value = current?.label ?? r.value ?? '(none)'
    lines.push(`${i === focus ? '>' : ' '} ${r.label.padEnd(width)}  ${i === focus ? INVERSE(` ${value} `) : ` ${value} `}  ${DIM(r.flag)}`)
    // The stack modes are few, and a disabled one says why, so they are
    // always listed; any other row's options only while it has the focus.
    if (i !== focus && r.row !== 'stackMode') return
    for (const o of r.options) {
      if (o.value === r.value && !o.note) continue
      const text = `${o.label}${o.disabled ? ' (unavailable)' : ''}${o.note ? `: ${o.note}` : ''}`
      lines.push(`    ${o.disabled ? DIM(text) : text}`)
    }
  })
  lines.push('', DIM('Up/Down: row   Left/Right: change   Enter: next row, and on the last arm and launch   Esc: cancel'))
  return lines
}

export function runStartForm({ form, stdin, stdout, heading = '' }) {
  let focus = 0
  const draw = () => stdout.write(`\x1b[2J\x1b[H${drawStartForm(form, focus, heading).join('\r\n')}\r\n`)
  return new Promise((resolve) => {
    const done = (answers) => {
      stdin.off('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause?.()
      resolve(answers)
    }
    function onData(data) {
      for (const key of keysOf(String(data))) {
        const rows = form.rows()
        if (key === 'cancel') return done(null)
        if (key === 'enter') {
          if (focus >= rows.length - 1) return done(form.answers())
          focus++
        } else if (key === 'up') focus = Math.max(0, focus - 1)
        else if (key === 'down') focus = Math.min(rows.length - 1, focus + 1)
        else form.cycle(rows[focus].row, key === 'left' ? -1 : 1)
        focus = Math.min(focus, form.rows().length - 1)
      }
      draw()
    }
    stdin.setRawMode?.(true)
    stdin.setEncoding?.('utf8')
    stdin.on('data', onData)
    stdin.resume?.()
    draw()
  })
}
