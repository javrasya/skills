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
//     or with paste as pasted text; refused for a parked session
//   session.waiting { id, waiting, keep } → { session }: what its harness
//     waits on the person for, or null, as the harness's own events tell it
//     (hooks/); with keep, set only while it waits on nothing. Its info, and
//     its worker's worker.show, carry it
//   session.ready { id }                   → { session }: its harness takes a
//     prompt now, as its own events tell it (hooks/crew-pi.mjs on pi's
//     session_start). Its info carries it as `ready`, false until told, false
//     again once its program ends or is started again
//   session.revive { id, cols, rows }      → { session }: a parked session's
//     harness started again in place, on its resume line; any other left as
//     it is. Its caller waits for the harness to be ready before typing
//   session.park { id }                    → { session }: a done agent's
//     session parked now, however recently it drew (the run tree's Ctrl+P);
//     refused, naming why, for any other
//   session.rename { id, title }           → { session }
//   session.kill { id }                    → { session }: its program ends,
//     the session and its last screen stay until closed
//   session.close { id }                   → { session }: killed and forgotten
//   session.resize { id, cols, rows }      → { session }
//   session.enter { id, cols, rows }       → { session }, then the connection
//     turns into the session's raw byte stream both ways: its screen repaint
//     and live output out, the terminal's keys in. Hanging up leaves the
//     session, which keeps running; the daemon hangs up when it ends. A
//     parked session's harness is started again first (below)
//   run.*, worker.*, mail.*, worktree.*    crew's Runs, their workers'
//     dispatches and their mailboxes (runs.mjs)
//
// A session is parked (#161) once its dispatch is done (a worker_done that
// succeeded), nobody has it entered and it has been quiet for parkAfterMs
// (crew's config): its program ends, its id, record and last screen stay, and
// its info says parked. Entering it starts the harness again in the same
// session id, cwd and env on its resume line (resumedCommand), so a done
// agent holds no process until someone looks at it. A write does not revive
// it: text typed before the harness is ready would be lost.
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
import { crewSessionEnv, resumedCommand } from '../harness.mjs'
import { PARK_AFTER_MS, readCrewConfig } from '../crew-config.mjs'
import { sleep } from '../util.mjs'

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const log = (...parts) => console.log(new Date().toISOString(), ...parts)

// Longer than any caller waits for a woken harness to be ready (crew-host's readyMs).
const WAKE_HOLD_MS = 5 * 60_000

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
// trail their owner by a moment) is left alone, never run twice. parkAfterMs:
// crew's config's unless given, 0 for never; looked for every `parkSweepMs`.
export async function startDaemon({ paths = crewPaths(), registry = REGISTRY_PATH, liveRuns = null, spawnSession, restoreSession, exit = (code) => process.exit(code), log: say = log, runnerGoneMs = 10_000, parkAfterMs = null, parkSweepMs = 30_000 } = {}) {
  parkAfterMs ??= configuredParkAfterMs(paths, say)
  const open = spawnSession ?? (await import('./session.mjs')).ptySession
  const restore = restoreSession ?? (await import('./session.mjs')).restoredSession
  const sessions = new Map()
  const book = runBook({ sessions, file: paths.runs ?? join(paths.home, 'runs.json'), registry })
  liveRuns ??= book.liveRuns
  const sockets = new Set()
  let stopping = false
  // Session id -> the run dir it is the runner of; run dir -> the run recover()
  // is starting a runner for, claimed until that runner's session holds it.
  const runnerDirs = new Map()
  const recovering = new Map()
  // Session id -> what it was spawned with, to start it again once parked; the
  // parked ones; and how many connections have each entered.
  const spawnedWith = new Map()
  const parked = new Set()
  const entered = new Map()
  // Session id -> when session.revive woke it for a caller about to type: not
  // parked again before that write lands, or WAKE_HOLD_MS goes by, whatever
  // parkAfterMs says, since the caller waits for its harness to be ready first.
  const woken = new Map()
  let parking = null

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

  // What the session's harness waits on the person for, as its own events
  // told (session.waiting), and whether it takes a prompt (session.ready),
  // in its info; neither once its program has ended. A dialog does not
  // unsay ready: a harness past its startup stays past it while it asks.
  function waitsOn(session) {
    const { info } = session
    let waiting = null
    let ready = false
    return Object.assign(session, {
      info: () => {
        const i = info()
        return { ...i, waiting: i.alive ? waiting : null, ready: i.alive && ready, ...(parked.has(i.id) && { parked: true }) }
      },
      wait(what, keep = false) {
        if (!(keep && waiting)) waiting = what
      },
      readyNow() {
        ready = true
      },
    })
  }

  function spawnOne({ command, cwd, env, cols, rows, title, runDir = null }) {
    const id = book.sessionId()
    // Always the directory it was asked for, never the daemon's own: that is
    // wherever the crew command that started the daemon happened to run.
    if (typeof cwd !== 'string' || !cwd) throw new Error(`session.spawn needs the directory to start ${command[0]} in`)
    const session = openOne(id, { command, cwd, env: { ...(env ?? process.env), CREW_SESSION: id }, cols, rows, title })
    if (runDir !== null) runnerDirs.set(id, runKey(runDir))
    say(`session ${id} spawned: ${command.join(' ')} (pid ${session.info().pid})`)
    return session
  }

  function openOne(id, spec) {
    const session = waitsOn(open({ id, ...spec }))
    sessions.set(id, session)
    spawnedWith.set(id, spec)
    book.spawned(id, spec)
    book.started(id)
    // A session a stopping daemon ends died with the daemon, as in a crash.
    // A parked one revived before its old program's exit came in is the new
    // session's id now: that late exit is not the new session ending.
    session.onExit?.(() => stopping || sessions.get(id) !== session || book.ended(id))
    return session
  }

  // A done agent's harness, quiet past parkAfterMs, waiting on nobody, with
  // nobody in it, that has a session to resume.
  function parkable(id, session) {
    if (parked.has(id) || entered.get(id) || !book.done(id)) return false
    if (woken.has(id) && Date.now() - woken.get(id) < WAKE_HOLD_MS) return false
    const i = session.info()
    return i.alive && !i.waiting && i.quietMs !== null && i.quietMs >= parkAfterMs && !!resumedCommand(i.command)
  }

  function parkIdle() {
    for (const [id, session] of sessions) {
      if (parkable(id, session)) park(id, session, `its agent is done and was quiet ${Math.round(session.info().quietMs / 1000)}s`)
    }
  }

  function park(id, session, why) {
    parked.add(id)
    session.kill()
    say(`session ${id} parked: ${why}`)
  }

  // A parked session's harness again, on its resume line, in its own id, cwd
  // and env, at the size it is entered at.
  function revive(id, { cols, rows }) {
    const old = sessionOf(id)
    const { command, title, cols: wasCols, rows: wasRows } = old.info()
    const spec = { ...spawnedWith.get(id), command: resumedCommand(command), title, cols: cols ?? wasCols, rows: rows ?? wasRows }
    const session = openOne(id, spec)
    parked.delete(id)
    say(`session ${id} resumed: ${spec.command.join(' ')} (pid ${session.info().pid})`)
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
    clearInterval(parking)
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
      if (parked.has(session.id)) throw new Error(`session ${id} is parked: its harness is not running; revive it (session.revive) or enter it to resume`)
      if (!session.info().alive) throw new Error(`session ${id} has exited`)
      woken.delete(session.id)
      if (paste) await session.paste(text(data, 'data'))
      else session.write(text(data, 'data'))
      return { session: session.info() }
    },
    'session.waiting': ({ id, waiting = null, keep = false }) => {
      const session = sessionOf(id)
      session.wait(waiting === null ? null : text(waiting, 'waiting'), keep === true)
      return { session: session.info() }
    },
    'session.ready': ({ id }) => {
      const session = sessionOf(id)
      session.readyNow()
      return { session: session.info() }
    },
    'session.rename': ({ id, title }) => {
      const session = sessionOf(id)
      session.rename(text(title, 'title'))
      book.renamed(session.id, title)
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
      spawnedWith.delete(session.id)
      parked.delete(session.id)
      entered.delete(session.id)
      woken.delete(session.id)
      book.closed(session.id)
      say(`session ${id} closed`)
      return { session: session.info() }
    },
    'session.resize': ({ id, cols, rows }) => {
      const session = sessionOf(id)
      session.resize(size(cols), size(rows))
      return { session: session.info() }
    },
    'session.park': ({ id }) => {
      const session = sessionOf(id)
      if (!parked.has(session.id)) {
        const i = session.info()
        const why = !book.done(session.id) ? 'its agent is not done' : entered.get(session.id) ? 'someone has it entered' : !i.alive ? 'its program has ended' : !resumedCommand(i.command) ? 'it has no session to resume' : null
        if (why) throw new Error(`session ${id} is not parked: ${why}`)
        park(session.id, session, 'asked to')
      }
      return { session: session.info() }
    },
    'session.revive': ({ id, cols, rows }) => {
      const session = wake(id, cols, rows)
      woken.set(session.id, Date.now())
      return { session: session.info() }
    },
    'session.enter': ({ id, cols, rows }, connection) => {
      const session = wake(id, cols, rows)
      connection.hold(session.id)
      return { session: session.info(), afterReply: () => connection.enter(session) }
    },
  }

  // The session, its harness started again first if it is parked, sized as asked.
  function wake(id, cols, rows) {
    const sized = cols !== undefined || rows !== undefined ? [size(cols), size(rows)] : null
    const session = parked.has(String(id)) ? revive(String(id), { cols, rows }) : sessionOf(id)
    if (sized) session.resize(...sized)
    return session
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
    // Entered from the request on, not from the attach after its reply, so no
    // sweep in between parks the session being entered.
    let held = null
    socket.on('close', () => {
      if (held !== null && entered.has(held)) entered.set(held, entered.get(held) - 1)
    })
    const connection = {
      hold(id) {
        held = id
        entered.set(id, (entered.get(id) ?? 0) + 1)
      },
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

  // Every agent session the last daemon held comes back parked, under its
  // own id: entering it resumes its harness (#164). Its env was never kept,
  // so it runs in this daemon's, with crew's own on top. One with no session
  // to resume is forgotten.
  for (const { id, command, cwd, title } of book.restorable()) {
    if (!resumedCommand(command)) {
      book.closed(id)
      continue
    }
    sessions.set(id, waitsOn(restore({ id, command, cwd, title })))
    spawnedWith.set(id, { command, cwd, title, env: crewSessionEnv(process.env, { home: paths.home, session: id }) })
    parked.add(id)
  }

  // Claimed before the first request can be answered: a runner started for one
  // of these by anyone else meanwhile would be its second.
  const lost = book.recoverable()
  for (const { runId, runDir } of lost) if (runDir) recovering.set(runKey(runDir), runId)
  mkdirSync(paths.home, { recursive: true })
  await claim(server, paths.endpoint)
  say(`crew daemon ${VERSION} pid ${process.pid} listening on ${paths.endpoint}`)
  if (parkAfterMs > 0) parking = setInterval(parkIdle, parkSweepMs)
  parking?.unref?.()
  const recovered = recover(lost).catch((e) => say(`could not resume the runs live when the last daemon went: ${e?.stack ?? e}`))
  return { server, sessions, shutdown, recovered }
}

// A config that does not read still leaves the daemon able to start.
function configuredParkAfterMs(paths, say) {
  try {
    return readCrewConfig(paths).parkAfterMs
  } catch (e) {
    say(`${e.message}; parking done agents after ${PARK_AFTER_MS / 60_000} minutes`)
    return PARK_AFTER_MS
  }
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
