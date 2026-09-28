// The crew console: a page drawn on the terminal, and entering a session from
// it. Entering stops the page drawing and hands the terminal to the session:
// its current screen and modes first (the daemon's repaint), then its live
// output, with every key but the back key passed to it byte for byte and every
// resize forwarded. The back key leaves for the page; the session keeps
// running. Two pages: `crew console`'s flat list of the daemon's sessions
// (runConsole), and `crew view`'s runs and their trees (runsConsole), where
// Enter on a crew run's agent, or on its runner, enters that session.
import { enterSession, request } from './daemon/client.mjs'
import { RESET } from './daemon/modes.mjs'
import { backKeySequences } from './crew-config.mjs'
import { consoleRunsHelp, consoleTreeHelp, draw, drawRuns } from './run-view/draw.mjs'

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

// Raw input as the key names the run view's model takes (terminal-kit's), and
// a left click as { click: { x, y } } (1-based, from SGR mouse reports).
const CSI_KEYS = { A: 'UP', B: 'DOWN', C: 'RIGHT', D: 'LEFT', H: 'HOME', F: 'END' }
export function keyNames(text) {
  const keys = []
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i)
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest)
    const csi = /^\x1b(?:\[[0-9;]*|O)([A-Za-z~])/.exec(rest)
    if (mouse) {
      if (mouse[1] === '0' && mouse[4] === 'M') keys.push({ click: { x: Number(mouse[2]), y: Number(mouse[3]) } })
      i += mouse[0].length
    } else if (csi) {
      if (CSI_KEYS[csi[1]]) keys.push(CSI_KEYS[csi[1]])
      i += csi[0].length
    } else {
      const ch = rest[0]
      keys.push(ch === '\r' || ch === '\n' ? 'ENTER' : ch === '\x1b' ? 'ESCAPE' : ch === '\x03' ? 'CTRL_C' : ch === '\x7f' || ch === '\b' ? 'BACKSPACE' : ch === '\t' ? 'TAB' : ch)
      i += 1
    }
  }
  return keys
}

// The console loop on a terminal's stdin and stdout, around `page`:
//   page.show(status)  starts drawing, status being why it is back ('' for none)
//   page.hide()        stops drawing, for a session entered or a quit
//   page.key(chunk)    a chunk of keys, answering (or resolving to) { enter:
//                      <session id>, close? }, { quit: true } or nothing; a
//                      session entered with close is closed once left
//   page.resize()      the terminal's new size
// Returns { done, mode }: done settles on quit; mode() is 'list' (the page),
// 'entering', 'entered' or 'quit'.
function consoleOn({ paths, stdin, stdout, backKey = 'f12', holdMs = 50, page }) {
  const sequences = backKeySequences(backKey)
  let mode = 'list'
  // The session entered, from the moment entering starts until it is left.
  let entered = null
  let finish
  const done = new Promise((resolvePromise) => (finish = resolvePromise))
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 })

  function show(why) {
    mode = 'list'
    page.show(why)
  }

  async function enter(id, close = false) {
    mode = 'entering'
    page.hide()
    const e = { id, close, open: true, socket: null, filter: null, pending: [] }
    entered = e
    try {
      const { socket } = await enterSession(paths, { id, ...size() }, (output) => e.open && stdout.write(output))
      e.socket = socket
      socket.on('close', () => entered === e && leave(`left session ${id}: its connection closed (the program ended, or the daemon stopped)`))
      if (!e.open) return socket.destroy()
      e.filter = backKeyFilter({ sequences, holdMs, forward: (keys) => socket.write(keys), back: () => leave('') })
      mode = 'entered'
      // Keys typed while the enter was in flight go through the filter first, in order.
      for (const chunk of e.pending.splice(0)) if (entered === e) e.filter.push(chunk)
    } catch (err) {
      entered = null
      if (close) request(paths, { op: 'session.close', id }).catch(() => {})
      if (mode !== 'quit') show(err.message)
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
    if (e.close) request(paths, { op: 'session.close', id: e.id }).catch(() => {})
    stdout.write(RESET)
    if (mode !== 'quit') show(why)
  }

  function onKey(chunk) {
    if (mode === 'entered') return entered.filter.push(chunk)
    if (mode === 'entering') return entered?.pending.push(chunk)
    if (mode !== 'list') return
    const then = (r) => {
      if (r?.quit) quit()
      else if (r?.enter && mode === 'list') enter(r.enter, !!r.close)
    }
    // A page that answers at once enters at once: keys typed next are the session's.
    const r = page.key(chunk)
    if (typeof r?.then === 'function') r.then(then)
    else then(r)
  }

  function onResize() {
    if (mode === 'list') return page.resize()
    if (entered) request(paths, { op: 'session.resize', id: entered.id, ...size() }).catch(() => {})
  }

  function quit() {
    mode = 'quit'
    page.hide()
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
  show('')
  return { done, mode: () => mode }
}

const describe = (s) => `${s.id}  ${s.alive ? 'running' : `exited ${s.exit?.code ?? s.exit?.signal}`}  pid ${s.pid}  ${s.cols}x${s.rows}  ${s.command.join(' ')}`

// `crew console`: the daemon's sessions in a flat list, until q or Ctrl+C.
export function runConsole({ paths, stdin, stdout, backKey = 'f12', refreshMs = 1_000, holdMs = 50 }) {
  let sessions = []
  let selected = 0
  let status = ''
  let timer = null
  let shown = false
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 })

  function paint() {
    if (!shown) return
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
    paint()
  }

  return consoleOn({
    paths, stdin, stdout, backKey, holdMs,
    page: {
      show(why) {
        status = why
        shown = true
        refresh()
        timer = setInterval(refresh, refreshMs)
      },
      hide() {
        shown = false
        clearInterval(timer)
      },
      resize: paint,
      key(chunk) {
        const key = bytes(chunk)
        if (key === 'q' || key === '\x03') return { quit: true }
        if (key === '\x1b[A' || key === '\x1bOA' || key === 'k') selected = Math.max(0, selected - 1)
        else if (key === '\x1b[B' || key === '\x1bOB' || key === 'j') selected = Math.min(sessions.length - 1, selected + 1)
        else if (key === '\r' || key === '\n') {
          const s = sessions[selected]
          if (s?.alive) return { enter: s.id }
          if (s) status = `session ${s.id} has exited`
        }
        paint()
        return null
      },
    },
  })
}

// `crew view`: runsView's runs (run-view-model.mjs), drawn as the standalone
// run view draws them, and a run's tree once opened, until q on the runs or
// Ctrl+C. The model takes every key and click; an action that answers
// { enter: { session } } (Enter on a crew run's agent or runner) enters that
// session, and the back key returns to the tree as it was left, its selected
// row and all. `?` on an opened run enters a fresh orchestrator session,
// closed once left (runsView's consult). Actions run one at a time, as the run
// view's do.
export function runsConsole({ paths, stdin, stdout, runs, backKey = 'f12', refreshMs = 2_000, holdMs = 50, now = () => Date.now(), onError = () => {} }) {
  let flash = null
  let shown = false
  let timer = null
  let rowAt = () => null
  let optionAt = () => null
  let busy = Promise.resolve()
  const size = () => ({ width: stdout.columns || 80, height: stdout.rows || 24 })

  function paint() {
    if (!shown) return
    const t = runs.opened()
    const host = t ? runs.model.projects.flatMap((p) => p.runs).find((r) => r.runId === runs.model.opened?.runId)?.host : null
    const screen = t
      ? draw(t.model, { ...size(), flash: flash ?? (t.model?.alert ? null : t.model?.latest), alert: t.model?.alert, now: now(), help: consoleTreeHelp(host, backKey) })
      : drawRuns(runs.model, { ...size(), flash: flash ?? runs.model?.message, title: 'crew runs', help: consoleRunsHelp(backKey) })
    rowAt = screen.rowAt
    optionAt = screen.optionAt ?? (() => null)
    stdout.write('\x1b[?25l\x1b[H' + screen.lines.join('\r\n'))
  }

  // One that throws is an error on the flash line, never a crash, as in view.mjs.
  const act = (fn) => {
    const next = busy.then(fn).catch((e) => {
      onError(e)
      flash = `error: ${e?.message ?? e}`
      return null
    })
    busy = next.then(paint).catch(onError)
    return next
  }

  async function one(key) {
    const t = runs.opened()
    if (key.click) {
      const { y } = key.click
      if (t?.model?.dialog) {
        const k = optionAt(y)
        return k === null ? null : t.highlight(k)
      }
      const i = rowAt(y)
      if (i === null) return null
      flash = null
      return runs.click(i)
    }
    flash = null
    if (key === '?' && t && !t.model?.dialog) {
      flash = 'starting an orchestrator session on this run…'
      paint()
    }
    return runs.key(key)
  }

  return consoleOn({
    paths, stdin, stdout, backKey, holdMs,
    page: {
      show(why) {
        flash = why || null
        shown = true
        // Clicks come as SGR mouse reports; the reset on entering turns them off again.
        stdout.write('\x1b[?1000h\x1b[?1006h\x1b[2J')
        act(() => runs.refresh())
        timer = setInterval(() => act(() => runs.refresh()), refreshMs)
      },
      hide() {
        shown = false
        clearInterval(timer)
      },
      resize: () => act(() => {}),
      key(chunk) {
        const keys = keyNames(bytes(chunk))
        if (keys.includes('CTRL_C')) return { quit: true }
        return act(async () => {
          for (const key of keys) {
            const r = await one(key)
            flash = r?.message ?? flash
            if (r?.quit) return { quit: true }
            if (r?.enter) return { enter: r.enter.session, close: !!r.enter.close }
          }
          return null
        })
      },
    },
  })
}
