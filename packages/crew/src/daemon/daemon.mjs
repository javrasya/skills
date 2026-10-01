// The crew daemon: one per crew home, started detached by the first crew
// command (client.mjs), holding every session's pty past the terminal that
// asked for it. Its stdout and stderr are the daemon log.
//
// Requests, one JSON line each, answered by one line { ok, re: <request id>, … }
// or { ok: false, error }:
//   hello                                  → { pid, version, endpoint }
//   stop { force }                         → refused, naming them, while runs are
//     live, unless force
//   session.spawn { command, cwd, env, cols, rows, title, runDir } → { session }:
//     its program gets its session's id as CREW_SESSION. With runDir it is that
//     run's runner, refused run_live while the run has one: a runner session
//     still running, or one this daemon is starting for it itself (recovery)
//   session.list                           → { sessions }
//   session.screen { id }                  → { screen: { lines, cursor, alternate } }
//   session.write { id, data, paste }      → { session }: data typed as keys,
//     or with paste as pasted text
//   session.rename { id, title }           → { session }
//   session.kill { id }                    → { session }: its program ends,
//     the session and its last screen stay until closed
//   session.close { id }                   → { session }: killed and forgotten
//   session.resize { id, cols, rows }      → { session }
//   session.enter { id, cols, rows }       → { session }, then the connection
//     turns into the session's raw byte stream both ways: its screen repaint
//     and live output out, the terminal's keys in. Hanging up leaves the
//     session, which keeps running; the daemon hangs up when it ends.
//   run.*, worker.*, mail.*, worktree.*    crew's Runs, their workers'
//     dispatches and their mailboxes (runs.mjs)
//
// Started after a daemon that died with runs live (a crash, a kill, a reboot,
// a forced stop), it starts each such run's runner again, resuming the run
// (#104): the runner continues every session lost with the old daemon. Such a
// run is claimed before the daemon answers anyone, so a run view's r that
// started this daemon cannot give the run a second runner.
import net from 'net'
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'fs'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import { fileURLToPath } from 'url'
import { connect, crewPaths, lineDecoder, noDaemon, send } from './transport.mjs'
import { runBook, runnerCommand, runnerTitle } from './runs.mjs'
import { REGISTRY_PATH } from '../registry.mjs'
import { pathKey } from '../paths.mjs'
import { sleep } from '../util.mjs'

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const log = (...parts) => console.log(new Date().toISOString(), ...parts)

// A daemon listening already: another client started one first.
class AlreadyRunning extends Error {}

function listen(server, endpoint) {
  return new Promise((resolvePromise, reject) => {
    const failed = (e) => {
      server.off('listening', listening)
      reject(e)
    }
    const listening = () => {
      server.off('error', failed)
      resolvePromise()
    }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen(endpoint)
  })
}

async function claim(server, endpoint) {
  try {
    return await listen(server, endpoint)
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e
  }
  // A pipe in use is a live daemon; a Unix socket file may be one a dead daemon left.
  try {
    ;(await connect(endpoint)).destroy()
    throw new AlreadyRunning()
  } catch (e) {
    if (process.platform === 'win32' || !noDaemon(e)) throw e
  }
  unlinkSync(endpoint)
  return listen(server, endpoint)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

const pidIn = (runDir) => {
  try {
    return Number(readFileSync(join(runDir, 'runner.pid'), 'utf8')) || null
  } catch {
    return null
  }
}

// A run dir as one key, however it is spelled.
const runKey = (dir) => pathKey(dir)

// liveRuns: the runs this daemon is host to that are not over, which stop
// refuses over (runs.mjs). registry: the run registry, which says which runs
// are; a lost runner still running after `runnerGoneMs` (a pty's children may
// trail their owner by a moment) is left alone, never run twice.
export async function startDaemon({ paths = crewPaths(), registry = REGISTRY_PATH, liveRuns = null, spawnSession, exit = (code) => process.exit(code), log: say = log, runnerGoneMs = 10_000 } = {}) {
  const open = spawnSession ?? (await import('./session.mjs')).ptySession
  const sessions = new Map()
  const book = runBook({ sessions, file: paths.runs ?? join(paths.home, 'runs.json'), registry })
  liveRuns ??= book.liveRuns
  const sockets = new Set()
  let stopping = false
  // Session id -> the run dir it is the runner of; run dir -> the run recover()
  // is starting a runner for, claimed until that runner's session holds it.
  const runnerDirs = new Map()
  const recovering = new Map()

  // A run has one runner at a time.
  function vacant(runDir) {
    const key = runKey(runDir)
    if (recovering.has(key)) throw new Error(`run_live: crew is resuming run ${recovering.get(key)} itself, its runner lost with the last daemon; that runner carries it on`)
    for (const [id, dir] of runnerDirs) {
      if (dir === key && sessions.get(id)?.info().alive) throw new Error(`run_live: ${runDir} has its runner already, in crew session ${id}`)
    }
    // A runner this daemon did not start, an Orca one or a trailing one, is
    // known by the runner.pid it writes.
    const pid = pidIn(runDir)
    if (pid && alive(pid)) throw new Error(`run_live: ${runDir} has its runner already, pid ${pid}`)
  }

  function spawnOne({ command, cwd, env, cols, rows, title, runDir = null }) {
    const id = book.sessionId()
    // Always the directory it was asked for, never the daemon's own: that is
    // wherever the crew command that started the daemon happened to run.
    if (typeof cwd !== 'string' || !cwd) throw new Error(`session.spawn needs the directory to start ${command[0]} in`)
    const session = open({ id, command, cwd, env: { ...(env ?? process.env), CREW_SESSION: id }, cols, rows, title })
    sessions.set(id, session)
    if (runDir !== null) runnerDirs.set(id, runKey(runDir))
    book.started(id)
    // A session a stopping daemon ends died with the daemon, as in a crash.
    session.onExit?.(() => stopping || book.ended(id))
    say(`session ${id} spawned: ${command.join(' ')} (pid ${session.info().pid})`)
    return session
  }

  async function recover(runs) {
    for (const run of runs) {
      const { runId, script, runDir, project, permissionMode } = run
      try {
        if (!script || !runDir || !existsSync(script)) {
          say(`run ${runId} was live, but its script ${script} is not there: not resumed`)
          continue
        }
        const pid = pidIn(runDir)
        for (const deadline = Date.now() + runnerGoneMs; pid && alive(pid) && Date.now() < deadline; ) await sleep(100)
        if (pid && alive(pid)) {
          say(`run ${runId}: its runner, pid ${pid}, still runs: not resumed`)
          continue
        }
        if (!project) {
          say(`run ${runId} was live, but the registry names no project to run it in: not resumed`)
          continue
        }
        const session = spawnOne({ command: runnerCommand({ script, stateDir: runDir, permissionMode }), cwd: project, title: runnerTitle(script), runDir })
        book.recovered(runId, session.id)
        say(`run ${runId} was live when the last daemon went: its runner resumes it in session ${session.id}`)
      } catch (e) {
        say(`run ${runId}: could not resume it: ${e?.stack ?? e}`)
      } finally {
        if (runDir) recovering.delete(runKey(runDir))
      }
    }
  }

  const sessionOf = (id) => {
    const session = sessions.get(String(id))
    if (!session) throw new Error(`no session ${id}`)
    return session
  }

  function shutdown(why) {
    if (stopping) return
    stopping = true
    say(`stopping: ${why}`)
    for (const session of sessions.values()) session.kill()
    for (const socket of sockets) socket.end()
    server.close(() => exit(0))
    // A client that never hangs up must not keep a stopped daemon alive.
    setTimeout(() => exit(0), 2_000).unref()
  }

  const ops = {
    ...book.ops,
    hello: () => ({ pid: process.pid, version: VERSION, endpoint: paths.endpoint }),
    stop: ({ force }) => {
      const runs = liveRuns()
      if (runs.length && !force) throw new Error(`${runs.length} run(s) live: ${runs.join(', ')}; --force stops the daemon anyway, and the next one resumes them`)
      setImmediate(() => shutdown(force ? 'stop --force' : 'stop'))
      return { pid: process.pid }
    },
    'session.spawn': ({ command, cwd, env, cols, rows, title = null, runDir = null }) => {
      if (!Array.isArray(command) || !command.length || !command.every((a) => typeof a === 'string')) throw new Error('session.spawn needs a command: a non-empty list of strings')
      if (runDir !== null) vacant(text(runDir, 'run dir'))
      return { session: spawnOne({ command, cwd, env, cols, rows, title: title === null ? null : text(title, 'title'), runDir }).info() }
    },
    'session.list': () => ({ sessions: [...sessions.values()].map((s) => s.info()) }),
    'session.screen': async ({ id }) => ({ screen: await sessionOf(id).screen() }),
    'session.write': async ({ id, data, paste = false }) => {
      const session = sessionOf(id)
      if (!session.info().alive) throw new Error(`session ${id} has exited`)
      if (paste) await session.paste(text(data, 'data'))
      else session.write(text(data, 'data'))
      return { session: session.info() }
    },
    'session.rename': ({ id, title }) => {
      const session = sessionOf(id)
      session.rename(text(title, 'title'))
      return { session: session.info() }
    },
    'session.kill': ({ id }) => {
      const session = sessionOf(id)
      session.kill()
      return { session: session.info() }
    },
    'session.close': ({ id }) => {
      const session = sessionOf(id)
      session.kill()
      sessions.delete(session.id)
      book.closed(session.id)
      say(`session ${id} closed`)
      return { session: session.info() }
    },
    'session.resize': ({ id, cols, rows }) => {
      const session = sessionOf(id)
      session.resize(size(cols), size(rows))
      return { session: session.info() }
    },
    'session.enter': ({ id, cols, rows }, connection) => {
      const session = sessionOf(id)
      if (cols !== undefined || rows !== undefined) session.resize(size(cols), size(rows))
      return { session: session.info(), afterReply: () => connection.enter(session) }
    },
  }

  const text = (s, what) => {
    if (typeof s !== 'string') throw new Error(`not a ${what}: ${JSON.stringify(s)?.slice(0, 80)}`)
    return s
  }

  const size = (n) => {
    if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new Error(`not a terminal size: ${n}`)
    return n
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    // Until a session is entered the connection carries JSON lines; after, raw bytes.
    let raw = null
    const text = new StringDecoder('utf8')
    const connection = {
      enter(session) {
        raw = (keys) => session.write(keys)
        const leave = session.enter(
          (bytes) => socket.write(bytes),
          // The last output may trail the exit by a moment.
          () => setTimeout(() => socket.end(), 100),
        )
        socket.on('close', leave)
        say(`session ${session.id} entered`)
      },
    }
    const lines = lineDecoder(async (request) => {
      if (raw) return
      let reply
      let afterReply = null
      try {
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
          throw new Error(`not a JSON object request: ${JSON.stringify(request).slice(0, 80)}`)
        }
        if (request.bad !== undefined) throw new Error(`not a JSON request: ${String(request.bad).slice(0, 80)}`)
        const op = Object.hasOwn(ops, request.op) ? ops[request.op] : null
        if (!op) throw new Error(`unknown op ${request.op}`)
        if (stopping) throw new Error('the daemon is stopping')
        ;({ afterReply = null, ...reply } = { ok: true, ...(await op(request, connection)) })
      } catch (e) {
        reply = { ok: false, error: e.message }
      }
      if (socket.destroyed) return
      send(socket, { re: request?.id ?? null, ...reply })
      afterReply?.()
    })
    socket.on('data', (chunk) => {
      try {
        raw ? raw(chunk) : lines(text.write(chunk))
      } catch (e) {
        // A write to a pty that just ended must not take the daemon and its other sessions down.
        say(`connection input dropped: ${e.message}`)
      }
    })
  })

  // Claimed before the first request can be answered: a runner started for one
  // of these by anyone else meanwhile would be its second.
  const lost = book.recoverable()
  for (const { runId, runDir } of lost) if (runDir) recovering.set(runKey(runDir), runId)
  mkdirSync(paths.home, { recursive: true })
  await claim(server, paths.endpoint)
  say(`crew daemon ${VERSION} pid ${process.pid} listening on ${paths.endpoint}`)
  const recovered = recover(lost).catch((e) => say(`could not resume the runs live when the last daemon went: ${e?.stack ?? e}`))
  return { server, sessions, shutdown, recovered }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  // Started detached, it has no terminal to lose; a hangup is not a reason to stop.
  process.on('SIGHUP', () => {})
  // One bad request must never take every session down with the daemon.
  process.on('unhandledRejection', (e) => log(`crew daemon: unhandled rejection: ${e?.stack ?? e}`))
  try {
    const daemon = await startDaemon()
    process.on('SIGTERM', () => daemon.shutdown('SIGTERM'))
    process.on('SIGINT', () => daemon.shutdown('SIGINT'))
  } catch (e) {
    if (e instanceof AlreadyRunning) {
      log('another crew daemon is listening already; this one exits')
      process.exit(0)
    }
    log(`crew daemon failed to start: ${e.stack ?? e}`)
    process.exit(1)
  }
}
