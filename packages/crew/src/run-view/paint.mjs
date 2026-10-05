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
      // A frame shorter than the last leaves no line of it behind.
      for (let i = lines.length; i < last.length; i++) out += `\x1b[${i + 1};1H\x1b[2K`
      last = lines.slice()
      if (out) write(`\x1b[?2026h\x1b[?25l${out}\x1b[?2026l`)
    },
    // The screen was cleared, resized or drawn over: the next frame writes every line.
    reset() {
      last = []
    },
  }
}

// Draws the screen again, by calling fire, every `ms` while it changes with
// time alone (draw's tick: the ticket view's glide and twinkle, a scrolling
// name); tickEvery(null) stops it. A fire still drawing when the next is due
// skips that one, so a slow action holds the screen still rather than piling
// draws up behind it. fire returns the draw's promise, or nothing.
export function ticker(fire) {
  let timer = null
  let every = null
  let drawing = false
  return function tickEvery(ms) {
    if (ms === every) return
    clearInterval(timer)
    timer = null
    every = ms
    if (!ms) return
    timer = setInterval(() => {
      if (drawing) return
      drawing = true
      Promise.resolve(fire()).finally(() => {
        drawing = false
      })
    }, ms)
  }
}
