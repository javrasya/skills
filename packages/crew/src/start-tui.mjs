// The `crew start` form at a terminal: the rows of start-form.mjs's model, one
// focused. Enter moves to the next row and, on the last, answers the form, so
// Enter all the way through takes every default. Resolves to the form's
// answers, or null when the operator cancels (Esc, Ctrl+C). A spec with no
// validation list gets one more step, the orchestrator's draft (runDraftStep).
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

export function runStartForm({ form, stdin, stdout, heading = '' }) {
  let focus = 0
  return interact({
    stdin,
    draw: () => paint(stdout, drawStartForm(form, focus, heading)),
    onData(chunk, done) {
      for (const key of keysOf(chunk)) {
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
    },
  })
}

// The form's last step when the spec has no validation list (#102): the
// orchestrator's draft, as text to edit. Ctrl+S confirms it; Esc or Ctrl+C
// cancels, and then nothing is written.
const EDIT_KEYS = [
  ['\x1b[A', 'up'], ['\x1bOA', 'up'], ['\x1b[B', 'down'], ['\x1bOB', 'down'],
  ['\x1b[C', 'right'], ['\x1bOC', 'right'], ['\x1b[D', 'left'], ['\x1bOD', 'left'],
  ['\x1b[H', 'home'], ['\x1bOH', 'home'], ['\x1b[1~', 'home'], ['\x1b[F', 'end'], ['\x1bOF', 'end'], ['\x1b[4~', 'end'], ['\x1b[3~', 'delete'],
  ['\r\n', 'enter'], ['\r', 'enter'], ['\n', 'enter'], ['\x7f', 'backspace'], ['\b', 'backspace'], ['\x13', 'confirm'], ['\x03', 'cancel'],
]

// The keys in one chunk of raw input to the draft: each a name, or { char }
// for a character typed. A tab is typed as a space.
export function editKeysOf(chunk) {
  const keys = []
  for (let i = 0; i < chunk.length;) {
    const hit = EDIT_KEYS.find(([seq]) => chunk.startsWith(seq, i))
    if (hit) {
      keys.push(hit[1])
      i += hit[0].length
    } else if (chunk[i] === '\x1b') {
      const seq = /^\x1b(\[[0-9;]*[~A-Za-z]|O[A-Za-z])?/.exec(chunk.slice(i))[0]
      if (seq.length === 1) keys.push('cancel')
      i += seq.length
    } else {
      const char = String.fromCodePoint(chunk.codePointAt(i))
      if (char === '\t' || char >= ' ') keys.push({ char: char === '\t' ? ' ' : char })
      i += char.length
    }
  }
  return keys
}

// The draft as lines and a cursor. text() is validation.md's content: its
// lines, each ended, or '' when every line is blank.
export function draftEditor(text) {
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n')
  let row = 0
  let col = 0
  const at = (r) => Math.min(col, lines[r].length)
  const editor = {
    lines: () => [...lines],
    cursor: () => ({ row, col: at(row) }),
    text: () => (lines.some((l) => l.trim()) ? `${lines.join('\n')}\n` : ''),
    key(k) {
      col = at(row)
      if (typeof k === 'object') {
        lines[row] = lines[row].slice(0, col) + k.char + lines[row].slice(col)
        col += k.char.length
      } else if (k === 'enter') {
        lines.splice(row + 1, 0, lines[row].slice(col))
        lines[row] = lines[row].slice(0, col)
        row++
        col = 0
      } else if (k === 'backspace') {
        if (col > 0) {
          lines[row] = lines[row].slice(0, col - 1) + lines[row].slice(col)
          col--
        } else if (row > 0) {
          col = lines[row - 1].length
          lines[row - 1] += lines[row]
          lines.splice(row, 1)
          row--
        }
      } else if (k === 'delete') {
        if (col < lines[row].length) lines[row] = lines[row].slice(0, col) + lines[row].slice(col + 1)
        else if (row < lines.length - 1) lines.splice(row, 2, lines[row] + lines[row + 1])
      } else if (k === 'left') {
        if (col > 0) col--
        else if (row > 0) col = lines[--row].length
      } else if (k === 'right') {
        if (col < lines[row].length) col++
        else if (row < lines.length - 1) {
          row++
          col = 0
        }
      } else if (k === 'up' && row > 0) row--
      else if (k === 'down' && row < lines.length - 1) row++
      else if (k === 'home') col = 0
      else if (k === 'end') col = lines[row].length
      return editor
    },
  }
  return editor
}

export const NO_CHECKS = "The orchestrator found no checks in this repo's CI config, workflow files, Makefile or package scripts, so the list is empty. Add the commands a change must pass, or confirm an empty list."

// `file` is where the list is written once confirmed; `empty` whether the
// orchestrator found no checks, which the step says.
export function drawDraft(editor, { heading = '', file = 'validation.md', empty = false } = {}) {
  const { row, col } = editor.cursor()
  const lines = heading ? [BOLD(heading), ''] : []
  lines.push(`Validation list, drafted by crew's orchestrator; confirming writes it to ${file}`)
  lines.push(DIM("One command a line, run from the repo's root; # starts a comment."))
  if (empty) lines.push(NO_CHECKS)
  lines.push('')
  editor.lines().forEach((l, i) => {
    lines.push(i === row ? `> ${l.slice(0, col)}${INVERSE(l[col] ?? ' ')}${l.slice(col + 1)}` : `  ${l}`)
  })
  lines.push('', DIM('Arrows: move   Enter: new line   Ctrl+S: confirm, write it and arm   Esc: cancel, nothing written or armed'))
  return lines
}

// Resolves to the confirmed text, or null when the operator cancels.
export function runDraftStep({ editor, stdin, stdout, heading = '', file, empty = false }) {
  return interact({
    stdin,
    draw: () => paint(stdout, drawDraft(editor, { heading, file, empty })),
    onData(chunk, done) {
      for (const key of editKeysOf(chunk)) {
        if (key === 'cancel') return done(null)
        if (key === 'confirm') return done(editor.text())
        editor.key(key)
      }
    },
  })
}

// What the terminal shows while the orchestrator drafts.
export function drawDrafting(stdout, { heading = '', file }) {
  paint(stdout, [...(heading ? [BOLD(heading), ''] : []), `The spec has no validation list (${file}).`, "Crew's orchestrator is drafting one from the repo's CI config, workflow files, Makefile and package scripts…"])
}
