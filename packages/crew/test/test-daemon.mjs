// Offline tests for the crew daemon: its start on demand, stop and restart,
// and a session it holds with nobody entered. Real daemons on real pipes or
// sockets, each under a scratch crew home, and real ptys.
//   node packages/crew/test/test-daemon.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { crewPaths, lineDecoder } from '../src/daemon/transport.mjs'
import { daemonHello, request, stopDaemon } from '../src/daemon/client.mjs'
import { startDaemon } from '../src/daemon/daemon.mjs'
import { resolveCommand } from '../src/daemon/session.mjs'

const CREW = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url))
const homes = []
after(async () => {
  for (const paths of homes) await stopDaemon(paths, { force: true }).catch(() => {})
})

function scratch() {
  const env = { ...process.env, CREW_HOME: join(mkdtempSync(join(tmpdir(), 'crew-daemon-')), 'home'), CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'crew-daemon-claude-')) }
  const paths = crewPaths(env)
  homes.push(paths)
  const crew = (...args) => spawnSync(process.execPath, [CREW, ...args], { encoding: 'utf8', env, timeout: 30_000 })
  return { env, paths, crew }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const pidOf = (r) => Number(/pid (\d+)/.exec(r.stdout)?.[1])
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(what, check, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

test('transport: requests are JSON lines, however the stream splits them', () => {
  const got = []
  const push = lineDecoder((m) => got.push(m))
  push('{"op":"hel')
  push('lo","id":1}\n\n{"op":"stop"}\nnot json\n{"op"')
  assert.deepEqual(got, [{ op: 'hello', id: 1 }, { op: 'stop' }, { bad: 'not json' }])
  push(':"x"}\n')
  assert.deepEqual(got.at(-1), { op: 'x' })
})

test('transport: one daemon per crew home, under ~/.crew/ unless CREW_HOME names another', () => {
  const a = crewPaths({ CREW_HOME: join(tmpdir(), 'a') })
  const b = crewPaths({ CREW_HOME: join(tmpdir(), 'b') })
  assert.notEqual(a.endpoint, b.endpoint)
  assert.equal(a.log, join(tmpdir(), 'a', 'daemon.log'))
  assert.equal(a.config, join(tmpdir(), 'a', 'config.json'))
  assert.match(crewPaths({}).home, /[\\/]\.crew$/)
  if (process.platform === 'win32') assert.match(a.endpoint, /^\\\\\.\\pipe\\crew-[0-9a-f]{16}$/)
  else assert.equal(a.endpoint, join(tmpdir(), 'a', 'crew.sock'))
})

test('session: a bare Windows command is found on Path with its extension, as conpty needs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-path-'))
  writeFileSync(join(dir, 'tool.exe'), '')
  const env = { Path: dir, PATHEXT: '.COM;.EXE' }
  assert.equal(resolveCommand('tool', { cwd: dir, env, platform: 'win32' }), join(dir, 'tool.exe'))
  assert.equal(resolveCommand('tool.exe', { cwd: dir, env, platform: 'win32' }), 'tool.exe')
  assert.equal(resolveCommand('missing', { cwd: dir, env, platform: 'win32' }), 'missing')
  assert.equal(resolveCommand('tool', { cwd: dir, env, platform: 'linux' }), 'tool')
})

test('daemon: with none running, a crew command starts one that outlives its terminal, and the next command reuses it', async () => {
  const { env, paths, crew } = scratch()
  assert.equal(await daemonHello(paths), null)

  // A terminal: a process that runs a crew command, then stays until it is closed.
  mkdirSync(paths.home, { recursive: true })
  const shell = join(paths.home, '..', 'terminal.mjs')
  writeFileSync(shell, `import { spawnSync } from 'child_process'\nconst r = spawnSync(process.execPath, [${JSON.stringify(CREW)}, 'daemon', 'status'], { encoding: 'utf8' })\nprocess.stdout.write(r.stdout)\nsetInterval(() => {}, 1000)\n`)
  const terminal = spawn(process.execPath, [shell], { env, stdio: ['ignore', 'pipe', 'inherit'], detached: process.platform !== 'win32' })
  let said = ''
  terminal.stdout.on('data', (d) => (said += d))
  const pid = Number(await until('the terminal\'s crew command', () => /pid (\d+) .*\(started\)/.exec(said)?.[1]))
  assert.ok(alive(pid))
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(terminal.pid)])
  else process.kill(-terminal.pid, 'SIGHUP')
  await until('the terminal to close', () => terminal.exitCode !== null || terminal.signalCode !== null)
  await sleep(300)
  assert.ok(alive(pid), 'the daemon outlives the terminal that started it')
  assert.equal((await daemonHello(paths))?.pid, pid)

  const again = crew('daemon', 'status')
  assert.equal(again.status, 0, again.stderr)
  assert.equal(pidOf(again), pid)
  assert.doesNotMatch(again.stdout, /started/)
  assert.equal(crew('session', 'list').status, 0)
  assert.equal((await daemonHello(paths)).pid, pid, 'one daemon, reused')
})

test('daemon: run and view start it too, before their own work', async () => {
  const { paths, crew } = scratch()
  const view = crew('view')
  assert.equal(view.status, 2, 'the view\'s own usage error')
  assert.ok(await daemonHello(paths))
  assert.equal(crew('--help').status, 0)
})

test('daemon: stop and restart work, --force is accepted, and stop with none running starts none', async () => {
  const { paths, crew } = scratch()
  const first = pidOf(crew('daemon', 'start'))
  assert.ok(alive(first))

  const restarted = crew('daemon', 'restart')
  assert.equal(restarted.status, 0, restarted.stderr)
  assert.match(restarted.stdout, new RegExp(`pid ${first} stopped`))
  const second = (await daemonHello(paths)).pid
  assert.notEqual(second, first)
  assert.ok(!alive(first))

  const forced = crew('daemon', 'restart', '--force')
  assert.equal(forced.status, 0, forced.stderr)
  const third = (await daemonHello(paths)).pid
  assert.notEqual(third, second)

  const stopped = crew('daemon', 'stop', '--force')
  assert.equal(stopped.status, 0, stopped.stderr)
  assert.match(stopped.stdout, new RegExp(`pid ${third} stopped`))
  assert.ok(!alive(third))
  assert.equal(await daemonHello(paths), null)

  const none = crew('daemon', 'stop')
  assert.equal(none.status, 0)
  assert.match(none.stdout, /not running/)
  assert.equal(await daemonHello(paths), null)

  assert.equal(crew('daemon', 'status', '--force').status, 2)
  assert.equal(crew('daemon', 'stop', '--now').status, 2)
})

test('daemon: stop refuses while runs are live, unless forced', async () => {
  const paths = crewPaths({ CREW_HOME: join(mkdtempSync(join(tmpdir(), 'crew-daemon-')), 'home') })
  const exits = []
  const daemon = await startDaemon({ paths, liveRuns: () => ['run-1'], spawnSession: () => assert.fail('no session here'), exit: (code) => exits.push(code), log: () => {} })
  await assert.rejects(request(paths, { op: 'stop' }), /1 run\(s\) live \(run-1\); --force stops the daemon anyway/)
  await assert.rejects(request(paths, { op: 'nope' }), /unknown op nope/)
  assert.equal((await request(paths, { op: 'stop', force: true })).ok, true)
  await until('the daemon to exit', () => exits.length)
  assert.deepEqual(exits.slice(0, 1), [0])
  assert.equal(daemon.server.listening, false)
})

test('session: a spawned session keeps running and keeps its screen while nobody has it entered', async () => {
  const { paths, crew } = scratch()
  const program = [
    "process.stdout.write('header\\r\\n')",
    "process.stdout.write('\\x1b[5;10Hkept')",
    'let n = 0',
    "setInterval(() => process.stdout.write('\\x1b[2;1Htick ' + (++n)), 100)",
  ].join('\n')
  const spawned = crew('session', 'spawn', '--', 'node', '-e', program)
  assert.equal(spawned.status, 0, spawned.stderr)
  const id = spawned.stdout.trim()
  assert.match(id, /^\d+$/)

  const ticks = async () => {
    const { screen } = await request(paths, { op: 'session.screen', id })
    const tick = /^tick (\d+)/.exec(screen.lines[1])
    return tick ? { screen, tick: Number(tick[1]) } : null
  }
  const before = await until('the first ticks', ticks)
  await sleep(600)
  const later = await ticks()
  assert.ok(later.tick > before.tick, `still running: tick ${before.tick} then ${later.tick}`)
  assert.equal(later.screen.lines[0], 'header')
  assert.equal(later.screen.lines[4], '         kept', 'the screen as the program drew it, kept with nobody watching')

  const listed = (await request(paths, { op: 'session.list' })).sessions
  assert.deepEqual(listed.map((s) => [s.id, s.alive]), [[id, true]])
  const printed = crew('session', 'screen', id)
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /^header\n/)
  assert.match(crew('session', 'list').stdout, new RegExp(`^${id}\\trunning\\tpid \\d+\\tnode -e`))

  assert.equal(crew('session', 'kill', id).status, 0)
  await until('the session to exit', async () => !(await request(paths, { op: 'session.list' })).sessions[0].alive)
  assert.equal(crew('session', 'spawn').status, 2)
  assert.match(crew('session', 'screen', '99').stderr, /no session 99/)
})
