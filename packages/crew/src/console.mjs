// The crew console: a flat list of the daemon's sessions, and entering one.
// Entering stops the list drawing and hands the terminal to the session: its
// current screen and modes first (the daemon's repaint), then its live output,
// with every key but the back key passed to it byte for byte and every resize
// forwarded. The back key leaves for the list; the session keeps running.
import { enterSession, request } from './daemon/client.mjs'
import { RESET } from './daemon/modes.mjs'
import { backKeySequences } from './crew-config.mjs'

const bytes = (chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString('latin1')

// Splits raw input into what goes to the session and the back key. The keys
// before a back key in a chunk are forwarded, and back gets what follows it.
// A chunk ending partway into a back key's sequence (ESC, ESC[2 …) is held for
// holdMs, since the rest may be in the next chunk, then forwarded as it was.
export function backKeyFilter({ sequences, forward, back, holdMs = 50 }) {
  let held = ''
  let timer = null
  const send = (text) => text && forward(Buffer.from(text, 'latin1'))
  const release = () => {
    timer = null
    const text = held
    held = ''
    send(text)
  }
  return {
    push(chunk) {
      clearTimeout(timer)
      timer = null
      const text = held + bytes(chunk)
      held = ''
      let hit = -1
      let length = 0
      for (const sequence of sequences) {
        const at = text.indexOf(sequence)
        if (at >= 0 && (hit < 0 || at < hit)) [hit, length] = [at, sequence.length]
      }
      if (hit >= 0) {
        send(text.slice(0, hit))
        back(Buffer.from(text.slice(hit + length), 'latin1'))
        return
      }
      let keep = 0
      for (const sequence of sequences) {
        for (let k = Math.min(sequence.length - 1, text.length); k > keep; k--) {
          if (text.endsWith(sequence.slice(0, k))) {
            keep = k
            break
          }
        }
      }
      send(text.slice(0, text.length - keep))
      if (keep) {
        held = text.slice(text.length - keep)
        timer = setTimeout(release, holdMs)
      }
    },
    dispose() {
      clearTimeout(timer)
      timer = null
      held = ''
    },
  }
}

const describe = (s) => `${s.id}  ${s.alive ? 'running' : `exited ${s.exit?.code ?? s.exit?.signal}`}  pid ${s.pid}  ${s.cols}x${s.rows}  ${s.command.join(' ')}`

// Runs the console on a terminal's stdin and stdout until q or Ctrl+C.
// Returns { done, mode }: done settles on quit; mode() is 'list', 'entering',
// 'entered' or 'quit'.
export function runConsole({ paths, stdin, stdout, backKey = 'f12', refreshMs = 1_000, holdMs = 50 }) {
  const sequences = backKeySequences(backKey)
  let sessions = []
  let selected = 0
  let status = ''
  let mode = 'list'
  let timer = null
  // The session entered, from the moment entering starts until it is left.
  let entered = null
  let finish
  const done = new Promise((resolvePromise) => (finish = resolvePromise))
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 })

  function draw() {
    if (mode !== 'list') return
    const { cols, rows } = size()
    const fit = (line) => line.slice(0, cols)
    const lines = [fit(`crew sessions: Up/Down choose, Enter enters, ${backKey.toUpperCase()} comes back to this list, q quits`), '']
    sessions.forEach((s, i) => {
      const line = fit(`${i === selected ? '>' : ' '} ${describe(s)}`)
      lines.push(i === selected ? `\x1b[7m${line}\x1b[0m` : line)
    })
    if (!sessions.length) lines.push(fit('  no sessions yet: crew session spawn -- <command…> starts one'))
    if (status) lines.push('', fit(status))
    stdout.write(`\x1b[?25l\x1b[H\x1b[2J${lines.slice(0, rows).join('\r\n')}`)
  }

  async function refresh() {
    try {
      sessions = (await request(paths, { op: 'session.list' })).sessions
    } catch (e) {
      status = e.message
    }
    selected = Math.max(0, Math.min(selected, sessions.length - 1))
    draw()
  }

  function list() {
    mode = 'list'
    refresh()
    timer = setInterval(refresh, refreshMs)
  }

  async function enter(s) {
    mode = 'entering'
    clearInterval(timer)
    const e = { id: s.id, open: true, socket: null, filter: null, pending: [] }
    entered = e
    try {
      const { socket } = await enterSession(paths, { id: s.id, ...size() }, (output) => e.open && stdout.write(output))
      e.socket = socket
      socket.on('close', () => entered === e && leave(`left session ${s.id}: its connection closed (the program ended, or the daemon stopped)`))
      if (!e.open) return socket.destroy()
      e.filter = backKeyFilter({ sequences, holdMs, forward: (keys) => socket.write(keys), back: () => leave('') })
      mode = 'entered'
      // Keys typed while the enter was in flight go through the filter first, in order.
      for (const chunk of e.pending.splice(0)) if (entered === e) e.filter.push(chunk)
    } catch (err) {
      entered = null
      status = err.message
      list()
    }
  }

  function leave(why) {
    const e = entered
    if (!e?.open) return
    e.open = false
    entered = null
    e.filter?.dispose()
    // End, not destroy: keys forwarded just before the back key are still in flight.
    if (e.socket) {
      e.socket.end()
      setTimeout(() => e.socket.destroy(), 1000).unref()
    }
    stdout.write(RESET)
    status = why
    if (mode !== 'quit') list()
  }

  function onKey(chunk) {
    if (mode === 'entered') return entered.filter.push(chunk)
    if (mode === 'entering') return entered?.pending.push(chunk)
    if (mode !== 'list') return
    const key = bytes(chunk)
    if (key === 'q' || key === '\x03') return quit()
    if (key === '\x1b[A' || key === '\x1bOA' || key === 'k') selected = Math.max(0, selected - 1)
    else if (key === '\x1b[B' || key === '\x1bOB' || key === 'j') selected = Math.min(sessions.length - 1, selected + 1)
    else if (key === '\r' || key === '\n') {
      const s = sessions[selected]
      if (s?.alive) return enter(s)
      if (s) status = `session ${s.id} has exited`
    }
    draw()
  }

  function onResize() {
    if (mode === 'list') return draw()
    if (entered) request(paths, { op: 'session.resize', id: entered.id, ...size() }).catch(() => {})
  }

  function quit() {
    mode = 'quit'
    clearInterval(timer)
    leave('')
    stdin.off('data', onKey)
    stdout.off('resize', onResize)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
    stdout.write(RESET)
    finish()
  }

  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.on('data', onKey)
  stdin.resume()
  stdout.on('resize', onResize)
  list()
  return { done, mode: () => mode }
}
