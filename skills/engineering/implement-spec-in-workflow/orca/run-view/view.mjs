#!/usr/bin/env node
// The run view (ADR-0012): the run as a tree that keeps updating in place, in
// the runner's own tab. The runner starts it as its child (D5 on #43):
//
//   node view.mjs --attached <run-dir>
//
// It reads the run from its run dir and Orca (run-view-model.mjs), never from
// the runner, so a crash here never touches the run; the runner restarts it.
// Over IPC it takes only the end-of-run prompt ({type: 'endPrompt', title,
// lines, question}), answered with {type: 'endChoice', answer}, and it sends
// {type: 'detach'} before the operator's quit. Exit codes: exit-codes.mjs.
//
// terminal-kit is installed beside this file on first use (npm ci), because
// the skill may be a detached copy of the repo; npm's output goes to runner.log.
import { spawnSync } from 'child_process'
import { appendFileSync, closeSync, openSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { runView } from '../run-view-model.mjs'
import { orcaCli } from '../orca-cli.mjs'
import { draw } from './draw.mjs'
import { VIEW_EXIT } from './exit-codes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REFRESH_MS = 2000

async function terminalKit(logPath) {
  try {
    return (await import('terminal-kit')).default
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e
  }
  const fd = openSync(logPath, 'a')
  try {
    const r = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: HERE, stdio: ['ignore', fd, fd], shell: process.platform === 'win32', windowsHide: true })
    if (r.status !== 0) return null
  } finally {
    closeSync(fd)
  }
  try {
    return (await import('terminal-kit')).default
  } catch {
    return null
  }
}

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (!option('--attached')) {
  console.error('usage: node view.mjs --attached <run-dir> [--registry <run registry, for a fixture run>]')
  process.exit(2)
}
const runDir = resolve(option('--attached'))
const logPath = join(runDir, 'runner.log')
const logLine = (s) => {
  try {
    appendFileSync(logPath, String(s).split('\n').map((l) => `${new Date().toISOString()} ${l}\n`).join(''))
  } catch {}
}
if (!process.stdout.isTTY || !process.stdin.isTTY) process.exit(VIEW_EXIT.unavailable)
const tk = await terminalKit(logPath)
if (!tk) {
  logLine('!! run view: terminal-kit could not be installed (npm ci, above)')
  process.exit(VIEW_EXIT.unavailable)
}

const term = tk.terminal
let restored = false
function restore() {
  if (restored) return
  restored = true
  try {
    term.grabInput(false)
    term.hideCursor(false)
    term.fullscreen(false)
  } catch {}
}
// A crash exits 1, never 0: 0 is the operator's quit, which the runner does
// not restart.
const crash = (e) => {
  restore()
  logLine(`!! run view crashed: ${e?.stack ?? e}`)
  process.exit(1)
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)
process.on('exit', restore)

const view = runView({ stateDir: runDir, orca: orcaCli(), ...(option('--registry') ? { registry: resolve(option('--registry')) } : {}) })
let modal = null
let flash = null
let rowAt = () => null

function render() {
  const screen = draw(view.model, { width: term.width, height: term.height, flash: flash ?? view.model?.latest, modal })
  rowAt = screen.rowAt
  process.stdout.write('\x1b[H' + screen.lines.join('\r\n'))
}

function quit() {
  const done = () => {
    restore()
    process.exit(VIEW_EXIT.quit)
  }
  if (process.connected) process.send({ type: 'detach' }, done)
  else done()
}

// Actions run one at a time, so a key never lands on a model another is changing.
let busy = Promise.resolve()
const act = (fn) => {
  busy = busy.then(fn).then(render).catch(crash)
  return busy
}
const said = (r) => {
  flash = r?.message ?? null
  return r
}

// Enter, a and n are the prompt's answers, as parseChoice reads them; every
// other key leaves it open.
const ANSWERS = { ENTER: '', a: 'a', n: 'n' }
term.on('key', (name) => {
  if (name === 'CTRL_C') return quit()
  if (modal?.force) {
    modal = null
    return act(async () => (name === 'f' ? said(await view.reclaim({ force: true })) : (flash = 'reclaim cancelled')))
  }
  if (modal) {
    if (!(name in ANSWERS)) return
    process.send?.({ type: 'endChoice', answer: ANSWERS[name] })
    modal = null
    flash = null
    return render()
  }
  act(async () => {
    flash = null
    const r = said(await view.key(name))
    if (r?.quit) return quit()
    if (r?.reclaim?.unpushed > 0) {
      modal = { force: true, title: `Reclaim ${view.model.pane?.agent?.title ?? 'this agent'}?`, lines: [r.reclaim.reason, '', 'f = force the reclaim, and those commits are lost · any other key cancels'] }
    }
  })
})
term.on('mouse', (name, d) => {
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED' || modal) return
  const i = rowAt(d.y)
  if (i === null) return
  act(async () => {
    flash = null
    said(await view.click(i))
  })
})
term.on('resize', () => act(() => {}))
process.on('message', (m) => {
  if (m?.type !== 'endPrompt') return
  modal = { title: m.title, lines: [...m.lines, '', m.question.trim()] }
  act(() => {})
})
// The runner is gone: nothing is left to show the run for.
process.on('disconnect', quit)

term.fullscreen(true)
term.hideCursor(true)
term.grabInput({ mouse: 'button' })
await act(() => view.refresh())
setInterval(() => act(() => view.refresh()), REFRESH_MS)
