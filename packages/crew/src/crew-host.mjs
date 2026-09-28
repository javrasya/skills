// The crew session host (ADR-0017): every worker a session the crew daemon
// holds in a real pty, reached through the daemon's client protocol
// (daemon/daemon.mjs), which this adapter is the only client of. A worker's
// terminal handle and its dispatch are both its daemon session's id: crew has
// no dispatch apart from the session it runs in.
//
// It implements the session-level methods (SESSION_METHODS in
// session-host.mjs); a run's worktrees and mailbox are not crew's yet, so it
// is not one of hosts.mjs's hosts.
import { crewPaths } from './daemon/transport.mjs'
import { ensureDaemon, request } from './daemon/client.mjs'
import { launchCommand, launchedSession, resumeCommand } from './harness.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'
import { sessionTranscripts } from './transcript.mjs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// `cwd` is the run's worktree, where a worker without a child worktree runs;
// `env` the environment its harness gets. `harnesses` maps a harness to the
// program words its launch line starts with in place of the harness's own
// name, as the contract suite puts its fake harness there; the rest of the
// line is the runner's launch command, word for word. A harness is ready for
// its prompt once it has drawn and then been quiet for `quietMs`, and a start
// fails if it is not ready within `readyMs`. A worker is idle once its session
// transcript says its latest turn ended, or, where the transcript does not
// say, once its terminal has been quiet for `quietMs`.
export function crewHost({ paths = crewPaths(), env = process.env, cwd = process.cwd(), harnesses = {}, transcripts = sessionTranscripts({ env }), quietMs = RUNNER_SETTINGS.quietOutputMs, readyMs = 180_000, endMs = 10_000, pollMs = 100 } = {}) {
  let daemon = null
  async function call(message) {
    daemon ??= ensureDaemon(paths).catch((e) => {
      daemon = null
      throw e
    })
    await daemon
    return request(paths, message)
  }
  const sessionOf = async (id) => (await call({ op: 'session.list' })).sessions.find((s) => s.id === id) ?? null

  async function screen(id, lines) {
    const rows = (await call({ op: 'session.screen', id })).screen.lines.map((l) => l.trimEnd())
    while (rows.length && !rows.at(-1)) rows.pop()
    return rows.slice(-lines)
  }

  // A prompt typed into a TUI still starting is lost, as on Orca.
  async function ready(id, command) {
    const deadline = Date.now() + readyMs
    for (;;) {
      const s = await sessionOf(id)
      if (!s?.alive) throw new Error(`\`${command.join(' ')}\` in crew session ${id} ended before its first prompt${s?.exit ? ` (exit ${s.exit.code})` : ''}; its screen:\n${(await screen(id, 15).catch(() => [])).join('\n')}`)
      if (s.quietMs !== null && s.quietMs >= quietMs) return
      if (Date.now() > deadline) throw new Error(`\`${command.join(' ')}\` in crew session ${id} never went quiet within ${Math.round(readyMs / 1000)}s`)
      await sleep(pollMs)
    }
  }

  const type = (terminal, data, paste = false) => call({ op: 'session.write', id: terminal, data, paste })

  async function terminalSend({ terminal, text }) {
    await type(terminal, text, true)
    await type(terminal, '\r')
  }

  // The harness from `line` (launchCommand's or resumeCommand's) in a new
  // session, typed its prompt once ready; a session that fails that is closed.
  async function launch(line, { harness, dir, title, prompt }) {
    const [program, ...args] = line.split(' ')
    const command = [...(harnesses[harness] ?? [program]), ...args]
    const { session } = await call({ op: 'session.spawn', command, cwd: dir, env, title })
    try {
      await ready(session.id, command)
      await terminalSend({ terminal: session.id, text: typeof prompt === 'function' ? prompt(null) : prompt })
    } catch (e) {
      await call({ op: 'session.close', id: session.id }).catch(() => {})
      throw e
    }
    return session.id
  }

  async function idleNow(terminal) {
    const s = await sessionOf(terminal)
    if (!s) throw new Error(`no crew session ${terminal}`)
    // An ended program has no turn going.
    if (!s.alive) return true
    const { harness, sessionId } = launchedSession(s.command)
    const ended = sessionId ? transcripts.idle({ harness, sessionId, worktree: s.cwd }) : null
    return ended ?? (s.quietMs !== null && s.quietMs >= quietMs)
  }

  return {
    id: 'crew',
    name: 'crew',

    // `child` (a worktree of the worker's own) is not crew's yet.
    async workerStart({ prompt, title, harness = 'claude', model, effort, permissionMode, sessionId, child = null }) {
      if (!sessionId) throw new Error(`workerStart: ${title} has no session id; the runner assigns one to every worker`)
      if (child) throw new Error(`workerStart: ${title} asks for a child worktree, which the crew host does not make yet`)
      const id = await launch(launchCommand({ harness, model, effort, permissionMode, sessionId }), { harness, dir: cwd, title, prompt })
      return { dispatchId: id, taskId: null, terminal: id, worktree: cwd, warnings: [] }
    },

    // The session carried on in a new crew session running the harness's
    // resume line, in the same worktree; the old session, its harness ended
    // first if still running (two harnesses on one session id would both
    // write its transcript), is closed once the new one has its prompt. A pty
    // whose program ended cannot take another, and a harness run straight in
    // its pty has no shell to type a resume line into.
    async workerContinue({ dispatch, terminal = dispatch, worktree = null, title, prompt, harness = 'claude', model, effort, permissionMode, sessionId }) {
      const line = resumeCommand({ harness, model, effort, permissionMode, sessionId })
      const old = await sessionOf(terminal)
      if (old?.alive) {
        await call({ op: 'session.kill', id: old.id })
        const deadline = Date.now() + endMs
        while ((await sessionOf(old.id))?.alive) {
          if (Date.now() > deadline) throw new Error(`workerContinue: ${title}'s harness in crew session ${old.id} did not end within ${Math.round(endMs / 1000)}s`)
          await sleep(pollMs)
        }
      }
      const dir = old?.cwd ?? worktree ?? cwd
      const id = await launch(line, { harness, dir, title: old?.title ?? title, prompt })
      if (old) await call({ op: 'session.close', id: old.id }).catch(() => {})
      return { dispatchId: id, taskId: null, terminal: id, worktree: dir, reopened: true }
    },

    // The harness ends; its session and last screen stay until closed.
    async workerStop({ dispatch }) {
      await call({ op: 'session.kill', id: dispatch })
    },

    // Whether the worker is idle, waiting up to `timeoutMs` for it to be.
    async terminalIdle({ terminal, timeoutMs = 0 }) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (await idleNow(terminal)) return true
        if (Date.now() >= deadline) return false
        await sleep(pollMs)
      }
    },
    terminalSend,
    async terminalEnter({ terminal }) {
      await type(terminal, '\r')
    },
    // Ctrl-U once per line, as on Orca (orca-cli.mjs says why never Ctrl-C or Esc).
    async terminalClearInput({ terminal, lines = 1 }) {
      await type(terminal, '\x15'.repeat(Math.max(1, lines)))
    },
    // The last `lines` rows of the screen, its blank rows below the last drawn one left out.
    terminalScreen: ({ terminal, lines = 15 }) => screen(terminal, lines),
    promptDelivered: ({ harness, sessionId, worktree, needle }) => transcripts.delivered({ harness, sessionId, worktree, needle }) === true,

    // Every session the daemon holds, its program ended or not, until closed.
    async terminalList() {
      return (await call({ op: 'session.list' })).sessions.map((s) => s.id)
    },
    async terminalClose({ terminal }) {
      await call({ op: 'session.close', id: terminal })
    },
    async terminalRename({ terminal, title }) {
      await call({ op: 'session.rename', id: terminal, title })
    },
  }
}
