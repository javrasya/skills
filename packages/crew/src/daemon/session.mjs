// One session the daemon holds: a program in a pty whose every byte of output
// goes into a headless terminal emulator, whether or not anyone watches, so
// its screen is there to repaint whenever it is entered.
import { existsSync } from 'fs'
import { delimiter, extname, isAbsolute, join, resolve } from 'path'
import pty from 'node-pty'
import xterm from '@xterm/headless'

const { Terminal } = xterm

// conpty finds a bare name on Path only with its extension given ("node.exe",
// never "node"), so a Windows command is looked up here the way a shell would.
export function resolveCommand(file, { cwd, env, platform = process.platform }) {
  if (platform !== 'win32' || isAbsolute(file) || extname(file)) return file
  if (/[\\/]/.test(file)) return resolve(cwd, file)
  const path = env.Path ?? env.PATH ?? ''
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, file + ext.toLowerCase())
      if (existsSync(candidate)) return candidate
    }
  }
  return file
}

export function ptySession({ id, command, cwd, env, cols = 120, rows = 30 }) {
  const [file, ...args] = command
  const terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  const child = pty.spawn(resolveCommand(file, { cwd, env }), args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    // node-pty's bundled conpty passes VT through better than the system's.
    ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
  })
  const watchers = new Set()
  let exit = null
  child.onData((data) => {
    terminal.write(data)
    for (const watch of watchers) watch(data)
  })
  // The emulator's answers to the program's queries (device attributes, cursor
  // position): conpty and many TUIs wait on them. While a session is entered the
  // real terminal answers too, so entering must mute these.
  terminal.onData((answer) => {
    if (exit === null) child.write(answer)
  })
  child.onExit(({ exitCode, signal }) => {
    exit = { code: exitCode, signal: signal ?? null }
  })

  return {
    id,
    terminal,
    info: () => ({ id, command, cwd, pid: child.pid, cols: terminal.cols, rows: terminal.rows, alive: exit === null, exit }),
    // The visible screen as text, once everything the program wrote so far is parsed.
    async screen() {
      await new Promise((done) => terminal.write('', done))
      const buffer = terminal.buffer.active
      const lines = []
      for (let y = 0; y < terminal.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
      return { lines, cursor: { x: buffer.cursorX, y: buffer.cursorY }, alternate: buffer.type === 'alternate' }
    },
    write: (data) => child.write(data),
    // The pty and the emulator in the same tick, or the screen kept wraps at the old width.
    resize(c, r) {
      child.resize(c, r)
      terminal.resize(c, r)
    },
    // Every byte of output from now on; returns the unsubscribe.
    onData(watch) {
      watchers.add(watch)
      return () => watchers.delete(watch)
    },
    kill() {
      if (exit !== null) return
      try {
        child.kill()
      } catch {
        // Gone between the exit check and the kill.
      }
    },
  }
}
