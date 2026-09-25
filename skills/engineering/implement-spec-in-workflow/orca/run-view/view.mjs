#!/usr/bin/env node
// The run view (ADR-0012): runs as trees that keep updating in place. Two
// modes (D5 and D8 on #43):
//
//   node view.mjs --attached <run-dir>   the runner starts it as its child, in
//                                        its own tab, on that one run
//   node view.mjs --standalone           every run in the run registry, by
//                                        project; the orca-runs skill opens it
//                                        in a tab of its own
//
// It reads runs from their run dirs, the registry and Orca (run-view-model.mjs),
// never from a runner, so a crash here never touches a run; the runner restarts
// an attached view. Over IPC an attached view takes only the end-of-run prompt
// ({type: 'endPrompt', title, lines, question}), answered with {type:
// 'endChoice', answer}, and it sends {type: 'detach'} before the operator's
// quit. Exit codes: exit-codes.mjs.
//
// terminal-kit is installed beside this file on first use (npm ci), because
// the skill may be a detached copy of the repo; npm's output goes to the log:
// the run's runner.log attached, orca-runs-view.log beside the registry standalone.
import { spawnSync } from 'child_process'
import { appendFileSync, closeSync, openSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { runView, runsView } from '../run-view-model.mjs'
import { REGISTRY_PATH } from '../registry.mjs'
import { orcaCli } from '../orca-cli.mjs'
import { TREE_HELP, draw, drawRuns } from './draw.mjs'
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
const standalone = args.includes('--standalone')
if (!standalone && !option('--attached')) {
  console.error('usage: node view.mjs --attached <run-dir> | --standalone [--registry <run registry, for a fixture>]')
  process.exit(2)
}
const registry = option('--registry') ? resolve(option('--registry')) : REGISTRY_PATH
const runDir = standalone ? null : resolve(option('--attached'))
const logPath = standalone ? join(dirname(registry), 'orca-runs-view.log') : join(runDir, 'runner.log')
const logLine = (s) => {
  try {
    appendFileSync(logPath, String(s).split('\n').map((l) => `${new Date().toISOString()} ${l}\n`).join(''))
  } catch {}
}
if (!process.stdout.isTTY || !process.stdin.isTTY) {
  if (standalone) console.error('the run view needs a terminal: run it in an Orca tab')
  process.exit(VIEW_EXIT.unavailable)
}
const tk = await terminalKit(logPath)
if (!tk) {
  logLine('!! run view: terminal-kit could not be installed (npm ci, above)')
  if (standalone) console.error(`the run view could not install terminal-kit: see ${logPath}`)
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

const orca = orcaCli()
// Standalone, `runs` takes every key and click, and hands them to the run it
// opened; `tree()` is the run tree on screen, or null on the list.
const runs = standalone ? runsView({ orca, registry }) : null
const view = standalone ? null : runView({ stateDir: runDir, orca, registry })
const top = runs ?? view
const tree = () => (runs ? runs.opened() : view)
let modal = null
let flash = null
let rowAt = () => null

function render() {
  const t = tree()
  const size = { width: term.width, height: term.height }
  // A blocked agent's alert stays on the flash line until it is answered: only
  // an action's own outcome, until the next key, goes over it.
  const screen = t ? draw(t.model, { ...size, flash: flash ?? (t.model?.alert ? null : t.model?.latest), alert: t.model?.alert, modal, ...(runs && { help: TREE_HELP }) }) : drawRuns(runs.model, { ...size, flash: flash ?? runs.model?.message })
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

// The confirmation a refused reclaim asks for, or null: `f` stops the worker
// of an agent kept running when it failed (stop), or removes a worktree that
// holds unpushed commits (force). `confirmed` is what `f` already confirmed
// for this agent, so a stopped agent whose worktree is then refused for its
// commits asks again, for that.
function confirmation(r, t, confirmed = {}) {
  if (!r?.agent || !t || !r.reclaim) return null
  const about = { n: r.agent.n, in: t, title: `Reclaim ${r.agent.title}?` }
  if (r.reclaim.stoppable && !confirmed.stop) {
    return { ...about, confirm: { ...confirmed, stop: true }, lines: [r.reclaim.reason, '', 'f = stop its worker, then reclaim it · any other key cancels'] }
  }
  if (r.reclaim.unpushed > 0 && !confirmed.force) {
    return { ...about, confirm: { ...confirmed, force: true }, lines: [r.reclaim.reason, '', 'f = force the reclaim, and those commits are lost · any other key cancels'] }
  }
  return null
}
term.on('key', (name) => {
  if (name === 'CTRL_C') return quit()
  // `f` confirms the reclaim of the agent the modal names, the one `r` was
  // refused for, wherever the selection has moved since, in the tree it was
  // refused in.
  if (modal?.confirm) {
    const { n, in: t, confirm } = modal
    modal = null
    return act(async () => {
      if (name !== 'f') return (flash = 'reclaim cancelled')
      modal = confirmation(said(await t.reclaim({ n, ...confirm })), t, confirm) ?? modal
    })
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
    const t = tree()
    const r = said(await top.key(name))
    if (r?.quit) return quit()
    modal = confirmation(r, t) ?? modal
  })
})
term.on('mouse', (name, d) => {
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED' || modal) return
  const i = rowAt(d.y)
  if (i === null) return
  act(async () => {
    flash = null
    said(await top.click(i))
  })
})
term.on('resize', () => act(() => {}))
if (!standalone) {
  process.on('message', (m) => {
    if (m?.type !== 'endPrompt') return
    modal = { title: m.title, lines: [...m.lines, '', m.question.trim()] }
    act(() => {})
  })
  // The runner is gone: nothing is left to show the run for.
  process.on('disconnect', quit)
}

term.fullscreen(true)
term.hideCursor(true)
term.grabInput({ mouse: 'button' })
await act(() => top.refresh())
setInterval(() => act(() => top.refresh()), REFRESH_MS)
