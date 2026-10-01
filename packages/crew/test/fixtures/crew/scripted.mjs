// A small TUI for the console tests, run in a real pty: it draws a line on the
// normal screen, then switches to the alternate screen with drag mouse
// reporting in SGR encoding, bracketed paste and a hidden cursor, draws there,
// and goes quiet. After that it only answers: each key it reads is appended in
// hex to row 5, and each change of its window size is shown on row 6.
process.stdout.write('normal screen line\r\n')
process.stdout.write('\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?25l')
process.stdout.write('\x1b[H\x1b[1;32mALT SCREEN\x1b[0m\x1b[3;5Hready')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let seen = ''
process.stdin.on('data', (keys) => {
  seen += keys.toString('hex')
  process.stdout.write(`\x1b[5;1H\x1b[2Kgot ${seen}`)
})
let size = ''
setInterval(() => {
  const [cols, rows] = process.stdout.getWindowSize()
  if (`${cols}x${rows}` === size) return
  const first = !size
  size = `${cols}x${rows}`
  if (!first) process.stdout.write(`\x1b[6;1H\x1b[2Ksize ${size}`)
}, 50)
