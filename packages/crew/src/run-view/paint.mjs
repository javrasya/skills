// Writes a screen's lines to the terminal for both renderers (view.mjs and
// console.mjs): only the lines that changed since the last frame, and the
// whole frame at once inside synchronized output (DEC mode 2026), so a
// terminal never shows half of one. The ticket view's glide draws ~60 frames
// a second; a full rewrite of every line each time is what made it tear.
// A terminal without mode 2026 ignores it and still gets only the changes.
export function painter(write) {
  let last = []
  return {
    paint(lines) {
      let out = ''
      for (const [i, l] of lines.entries()) if (last[i] !== l) out += `\x1b[${i + 1};1H${l}`
      last = lines.slice()
      if (out) write(`\x1b[?2026h\x1b[?25l${out}\x1b[?2026l`)
    },
    // The screen was cleared, resized or drawn over: the next frame writes every line.
    reset() {
      last = []
    },
  }
}
