// One session the daemon holds: a program in a pty whose every byte of output
// goes into a headless terminal emulator, whether or not anyone watches, so
// its screen is there to repaint whenever it is entered.
import pty from 'node-pty'
import xterm from '@xterm/headless'
import { repaint, stripHostModes, trackModes } from './modes.mjs'
import { resolveCommand } from '../command.mjs'
import { chmodSync, statSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'

const { Terminal } = xterm

// node-pty 1.1.0's prebuilds ship spawn-helper without its execute bit, and
// every spawn then fails with "posix_spawnp failed". Set it once, best-effort:
// a read-only install keeps the bit it has.
export function ensureSpawnHelper() {
  if (process.platform === 'win32') return
  try {
    const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
    const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    const { mode } = statSync(helper)
    if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755)
  } catch {}
}
ensureSpawnHelper()

// conpty finds a bare name on Path only with its extension given, so a
// Windows command is looked up first (command.mjs).
export function ptySession({ id, command, cwd, env, cols = 120, rows = 30, title = null }) {
  const [file, ...args] = command
  const terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  const modes = trackModes(terminal)
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
  const exits = new Set()
  let exit = null
  let killing = false
  let entered = 0
  let lastOutput = null
  child.onData((data) => {
    lastOutput = Date.now()
    terminal.write(data)
    for (const watch of watchers) watch(data)
  })
  // The emulator's answers to the program's queries (device attributes, cursor
  // position): conpty and many TUIs wait on them. While a session is entered the
  // real terminal answers instead, and two answers would confuse the program.
  terminal.onData((answer) => {
    if (exit === null && !entered) child.write(answer)
  })
  child.onExit(({ exitCode, signal }) => {
    exit = { code: exitCode, signal: signal ?? null }
    for (const watch of exits) watch(exit)
  })
  const onData = (watch) => {
    watchers.add(watch)
    return () => watchers.delete(watch)
  }

  return {
    id,
    terminal,
    // quietMs: how long since its last output, null before its first.
    info: () => ({ id, title, command, cwd, pid: child.pid, cols: terminal.cols, rows: terminal.rows, alive: exit === null, exit, quietMs: lastOutput === null ? null : Date.now() - lastOutput }),
    rename(to) {
      title = to
    },
    // The visible screen as text, once everything the program wrote so far is parsed.
    async screen() {
      await new Promise((done) => terminal.write('', done))
      const buffer = terminal.buffer.active
      const lines = []
      for (let y = 0; y < terminal.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
      return { lines, cursor: { x: buffer.cursorX, y: buffer.cursorY }, alternate: buffer.type === 'alternate' }
    },
    write: (data) => child.write(data),
    // Typed as the program's own terminal would paste it: bracketed when the
    // program asked for bracketed paste, so a line break in it stays in its
    // input rather than submitting what came before.
    async paste(text) {
      if (exit !== null) throw new Error(`session ${id} has exited`)
      await new Promise((done) => terminal.write('', done))
      child.write(terminal.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text)
    },
    // The pty and the emulator in the same tick, or the screen kept wraps at the old width.
    resize(c, r) {
      child.resize(c, r)
      terminal.resize(c, r)
    },
    // Every byte of output from now on; returns the unsubscribe.
    onData,
    // Called once its program ends.
    onExit(watch) {
      exits.add(watch)
    },
    // Enters the session for a real terminal fed by out: first the bytes that
    // repaint its current screen and restore its modes, then its live output.
    // Output that arrives while the emulator catches up is held and follows
    // the repaint, so nothing is shown twice or lost. onExit is called if the
    // program ends while entered. Returns leave(); the session keeps running.
    enter(out, onExit = () => {}) {
      entered++
      let held = []
      let left = false
      const forward = (data) => out(stripHostModes(data))
      const unwatch = onData((data) => (held ? held.push(data) : forward(data)))
      terminal.write('', () => {
        if (left) return
        out(repaint(terminal, modes))
        for (const data of held) forward(data)
        held = null
        if (exit !== null) onExit(exit)
      })
      const ended = (e) => {
        if (!held) onExit(e)
      }
      exits.add(ended)
      return function leave() {
        if (left) return
        left = true
        entered--
        unwatch()
        exits.delete(ended)
      }
    },
    // Once: a pty killed again while its first kill is under way (its exit
    // not in yet) takes the daemon down with it, and reclaim, a stop then a
    // close, and the orchestrator's stop then close all kill twice.
    kill() {
      if (exit !== null || killing) return
      killing = true
      try {
        child.kill()
      } catch {
        // Gone between the exit check and the kill.
      }
      // node-pty 1.1.0 with useConptyDll frees the conout worker thread only when
      // output arrives after the kill (lib/windowsPtyAgent.js, kill()); a quiet
      // program would leak it, and keep the process holding it alive.
      child._agent?._conoutSocketWorker?.dispose?.()
    },
  }
}
