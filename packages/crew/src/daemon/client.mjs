// A crew command's side of the daemon: one request per connection, and the
// daemon started, detached, when none answers.
import { spawn } from 'child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { connect, noDaemon, onMessages, send } from './transport.mjs'
import { sleep } from '../util.mjs'

const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url))

export class DaemonError extends Error {}

// The daemon not there at all, rather than one that answered: none listening,
// one that died mid-request, or one that would not start. A crew outage.
export const daemonGone = (e) => noDaemon(e) || e?.code === 'ECONNRESET' || e?.code === 'EPIPE' || e?.daemonGone === true
const gone = (message) => Object.assign(new DaemonError(message), { daemonGone: true })

export async function request(paths, message, { timeoutMs = 10_000 } = {}) {
  const socket = await connect(paths.endpoint)
  return new Promise((resolvePromise, reject) => {
    const fail = (e) => {
      clearTimeout(timer)
      socket.destroy()
      reject(e)
    }
    const timer = setTimeout(() => fail(new DaemonError(`crew daemon: no reply to ${message.op} within ${timeoutMs} ms`)), timeoutMs)
    socket.on('error', fail)
    socket.on('close', () => fail(gone(`crew daemon: hung up before replying to ${message.op}`)))
    onMessages(socket, (reply) => {
      clearTimeout(timer)
      socket.removeAllListeners('close')
      socket.end()
      if (reply.ok) resolvePromise(reply)
      else reject(new DaemonError(reply.error ?? `crew daemon: ${message.op} failed`))
    })
    send(socket, { id: 1, ...message })
  })
}

// The daemon's hello, or null when no daemon listens.
export async function daemonHello(paths) {
  try {
    return await request(paths, { op: 'hello' })
  } catch (e) {
    if (noDaemon(e)) return null
    throw e
  }
}

const logTail = (path) => {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-8).join('\n')
  } catch {
    return '(no log)'
  }
}

// The running daemon's hello, starting the daemon first when none answers:
// { pid, version, endpoint, started }.
export async function ensureDaemon(paths, { startMs = 10_000 } = {}) {
  const running = await daemonHello(paths)
  if (running) return { ...running, started: false }
  mkdirSync(paths.home, { recursive: true })
  const logFd = openSync(paths.log, 'a')
  // Detached, with its output in the log rather than this terminal: on Windows
  // that is a process with no console, so closing this terminal cannot reach it.
  // A crew session's own id is no daemon's: every session it spawns gets its own.
  const { CREW_SESSION, ...env } = process.env
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...env, CREW_HOME: paths.home },
  })
  closeSync(logFd)
  let exited = null
  child.on('exit', (code, signal) => {
    exited = { code, signal }
  })
  try {
    const deadline = Date.now() + startMs
    for (;;) {
      const hello = await daemonHello(paths)
      if (hello) return { ...hello, started: hello.pid === child.pid }
      // Exit 0 is a daemon that lost the race to another client's: that one answers soon.
      if (exited && exited.code !== 0) throw gone(`crew daemon failed to start (exit ${exited.code ?? exited.signal}); ${paths.log}:\n${logTail(paths.log)}`)
      if (Date.now() > deadline) throw gone(`crew daemon did not answer on ${paths.endpoint} within ${startMs} ms; ${paths.log}:\n${logTail(paths.log)}`)
      await sleep(50)
    }
  } finally {
    child.unref()
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// Stops the daemon and waits for it to be gone: { stopped: false } when none ran.
export async function stopDaemon(paths, { force = false, goneMs = 10_000 } = {}) {
  const hello = await daemonHello(paths)
  if (!hello) return { stopped: false }
  await request(paths, { op: 'stop', force })
  const deadline = Date.now() + goneMs
  while ((await daemonHello(paths).catch(() => hello)) || alive(hello.pid)) {
    if (Date.now() > deadline) throw new DaemonError(`crew daemon pid ${hello.pid} still running ${goneMs} ms after stop`)
    await sleep(50)
  }
  return { stopped: true, pid: hello.pid }
}

// Enters a session: resolves, once the daemon agrees, with the session and the
// connection, which is from then on the session's raw byte stream. onOutput
// gets every byte of its output, the repaint of its current screen first.
export async function enterSession(paths, { id, cols, rows }, onOutput) {
  const socket = await connect(paths.endpoint)
  return new Promise((resolvePromise, reject) => {
    let head = Buffer.alloc(0)
    let replied = false
    const fail = (e) => {
      socket.destroy()
      reject(e)
    }
    socket.on('error', (e) => replied || fail(e))
    socket.on('close', () => replied || fail(new DaemonError('crew daemon: hung up before replying to session.enter')))
    socket.on('data', (chunk) => {
      if (replied) return onOutput(chunk)
      head = Buffer.concat([head, chunk])
      const at = head.indexOf(10)
      if (at < 0) return
      replied = true
      let reply
      try {
        reply = JSON.parse(head.subarray(0, at).toString('utf8'))
      } catch {
        reply = { ok: false, error: 'crew daemon: session.enter got a reply that is not JSON' }
      }
      if (!reply.ok) return fail(new DaemonError(reply.error ?? 'crew daemon: session.enter failed'))
      resolvePromise({ session: reply.session, socket })
      if (head.length > at + 1) onOutput(head.subarray(at + 1))
    })
    send(socket, { op: 'session.enter', id, cols, rows })
  })
}
