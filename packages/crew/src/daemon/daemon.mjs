// The crew daemon: one per crew home, started detached by the first crew
// command (client.mjs), holding every session's pty past the terminal that
// asked for it. Its stdout and stderr are the daemon log.
//
// Requests, one JSON line each, answered by one line { ok, re: <request id>, … }
// or { ok: false, error }:
//   hello                                  → { pid, version, endpoint }
//   stop { force }                         → refused while runs are live, unless force
//   session.spawn { command, cwd, env, cols, rows, title } → { session }
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
import net from 'net'
import { mkdirSync, readFileSync, realpathSync, unlinkSync } from 'fs'
import { StringDecoder } from 'string_decoder'
import { fileURLToPath } from 'url'
import { connect, crewPaths, lineDecoder, noDaemon, send } from './transport.mjs'

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

// liveRuns: the runs this daemon is host to that are not over. No run runs on
// the daemon yet, so it is none, and stop never has one to refuse over.
export async function startDaemon({ paths = crewPaths(), liveRuns = () => [], spawnSession, exit = (code) => process.exit(code), log: say = log } = {}) {
  const open = spawnSession ?? (await import('./session.mjs')).ptySession
  const sessions = new Map()
  const sockets = new Set()
  let next = 1
  let stopping = false

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
    hello: () => ({ pid: process.pid, version: VERSION, endpoint: paths.endpoint }),
    stop: ({ force }) => {
      const runs = liveRuns()
      if (runs.length && !force) throw new Error(`${runs.length} run(s) live (${runs.join(', ')}); --force stops the daemon anyway`)
      setImmediate(() => shutdown(force ? 'stop --force' : 'stop'))
      return { pid: process.pid }
    },
    'session.spawn': ({ command, cwd, env, cols, rows, title = null }) => {
      if (!Array.isArray(command) || !command.length || !command.every((a) => typeof a === 'string')) throw new Error('session.spawn needs a command: a non-empty list of strings')
      const id = String(next++)
      const session = open({ id, command, cwd: cwd ?? process.cwd(), env: env ?? process.env, cols, rows, title: title === null ? null : text(title, 'title') })
      sessions.set(id, session)
      say(`session ${id} spawned: ${command.join(' ')} (pid ${session.info().pid})`)
      return { session: session.info() }
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

  mkdirSync(paths.home, { recursive: true })
  await claim(server, paths.endpoint)
  say(`crew daemon ${VERSION} pid ${process.pid} listening on ${paths.endpoint}`)
  return { server, sessions, shutdown }
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
