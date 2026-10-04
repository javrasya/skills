// Where the crew daemon lives and how its clients talk to it: one daemon per
// crew home (~/.crew/, or CREW_HOME), reached on a named pipe on Windows and a
// Unix socket elsewhere, carrying newline-delimited JSON.
import net from 'net'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join, resolve } from 'path'

export function crewPaths(env = process.env) {
  const home = resolve(env.CREW_HOME || join(homedir(), '.crew'))
  // Named pipes are machine-global, so the name is keyed on the home: each
  // user, and each test's scratch home, gets its own daemon.
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? home.toLowerCase() : home)
    .digest('hex')
    .slice(0, 16)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\crew-${key}` : join(home, 'crew.sock')
  return { home, endpoint, log: join(home, 'daemon.log'), config: join(home, 'config.json'), runs: join(home, 'runs.json') }
}

// No daemon listens there: a missing pipe, or a Unix socket file left behind.
export const noDaemon = (e) => e?.code === 'ENOENT' || e?.code === 'ECONNREFUSED'

export function connect(endpoint, timeoutMs = 2_000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(endpoint)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error(`crew daemon: no answer on ${endpoint} within ${timeoutMs} ms`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeAllListeners('error')
      resolvePromise(socket)
    })
    socket.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

export const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`)

// Calls onMessage with each JSON line of a byte stream, however its chunks
// split the lines; a line that is not JSON arrives as { bad: line }.
export function lineDecoder(onMessage) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        message = { bad: line }
      }
      onMessage(message)
    }
  }
}

export function onMessages(socket, onMessage) {
  socket.setEncoding('utf8')
  socket.on('data', lineDecoder(onMessage))
}
