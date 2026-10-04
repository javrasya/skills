// A session's private terminal modes, tracked by crew itself, and the bytes
// that put a real terminal into the session's state on enter: its modes and
// its current screen. The emulator's serializer is not used for either: it
// drops the SGR mouse encoding (?1006) and cursor visibility (?25), which a
// TUI reading mouse clicks or hiding its cursor cannot do without.

// Every alternate-screen variant is replayed as ?1049: it clears the alternate
// screen and saves the cursor, which is what a clean terminal needs.
const ALT = 1049
const ALIASES = new Map([
  [47, ALT],
  [1047, ALT],
])
// Cursor keys, mouse protocols and encodings, focus reports, bracketed paste,
// cursor visibility and blink. ?9001 (conpty's win32-input-mode) is kept out
// on purpose: see stripHostModes.
export const TRACKED = new Set([1, 9, 12, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004, ALT])

// A clean, home-positioned terminal with every tracked mode off.
export const RESET =
  '\x1b[?1049l' +
  [...TRACKED]
    .filter((m) => m !== ALT && m !== 25)
    .map((m) => `\x1b[?${m}l`)
    .join('') +
  '\x1b[?25h\x1b>\x1b[0m\x1b[2J\x1b[H'

// Records each tracked mode's switches as the emulator parses them, in the
// order they last changed, so a replay in that order ends in the same state
// (?1000h then ?1002h is drag tracking, whatever each alone would be).
export function trackModes(terminal) {
  const modes = new Map()
  const record = (on) => (params) => {
    for (const param of params) {
      const mode = ALIASES.get(param) ?? param
      if (typeof mode !== 'number' || !TRACKED.has(mode)) continue
      modes.delete(mode)
      modes.set(mode, on)
    }
    // The emulator's own handler still runs.
    return false
  }
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, record(true))
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, record(false))
  // RIS (ESC c) puts every mode back to its default.
  terminal.parser.registerEscHandler({ final: 'c' }, () => {
    modes.clear()
    return false
  })
  return modes
}

const color = (base, bright, extended, isRGB, value) => {
  if (isRGB) return `${extended};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
  if (value < 8) return `${base + value}`
  if (value < 16) return `${bright + value - 8}`
  return `${extended};5;${value}`
}

function sgr(cell) {
  const params = ['0']
  if (cell.isBold()) params.push('1')
  if (cell.isDim()) params.push('2')
  if (cell.isItalic()) params.push('3')
  if (cell.isUnderline()) params.push('4')
  if (cell.isBlink()) params.push('5')
  if (cell.isInverse()) params.push('7')
  if (cell.isInvisible()) params.push('8')
  if (cell.isStrikethrough()) params.push('9')
  if (!cell.isFgDefault()) params.push(color(30, 90, 38, cell.isFgRGB(), cell.getFgColor()))
  if (!cell.isBgDefault()) params.push(color(40, 100, 48, cell.isBgRGB(), cell.getBgColor()))
  return `\x1b[${params.join(';')}m`
}

// One buffer's visible rows, painted onto a cleared screen, ending with the
// cursor where the buffer has it.
export function paintBuffer(buffer, { cols, rows }, cell = buffer.getNullCell()) {
  let out = ''
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + y)
    if (!line) continue
    // A blank default cell is already on a cleared screen: paint up to the last other one.
    let end = 0
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell)
      if (cell.getChars() || !cell.isAttributeDefault()) end = x + 1
    }
    if (!end) continue
    out += `\x1b[${y + 1};1H`
    let style = ''
    for (let x = 0; x < end; x++) {
      line.getCell(x, cell)
      // The second half of a wide character: its first half drew both.
      if (cell.getWidth() === 0) continue
      const next = sgr(cell)
      if (next !== style) out += style = next
      out += cell.getChars() || ' '
    }
    out += '\x1b[0m'
  }
  return `${out}\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`
}

// The bytes that take a real terminal, whatever state it is in, to this
// session's: its screen (under it the normal screen when the alternate one is
// up, for when the program leaves it), then its modes, the cursor's visibility last.
export function repaint(terminal, modes) {
  const size = { cols: terminal.cols, rows: terminal.rows }
  let out = RESET
  if (modes.get(ALT)) out += `${paintBuffer(terminal.buffer.normal, size)}\x1b[?${ALT}h${paintBuffer(terminal.buffer.alternate, size)}`
  else out += paintBuffer(terminal.buffer.normal, size)
  for (const [mode, on] of modes) if (mode !== ALT && mode !== 25) out += `\x1b[?${mode}${on ? 'h' : 'l'}`
  if (terminal.modes.applicationKeypadMode) out += '\x1b='
  if (modes.get(25) === false) out += '\x1b[?25l'
  return out
}

// conpty asks its host for win32-input-mode (?9001h). Passed to the real
// terminal, every key, the back key too, would arrive as a win32 input record.
export const stripHostModes = (data) => data.replace(/\x1b\[\?9001[hl]/g, '')
