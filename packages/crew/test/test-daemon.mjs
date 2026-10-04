// Offline tests for the crew daemon: its start on demand, stop and restart,
// and a session it holds with nobody entered. Real daemons on real pipes or
// sockets, each under a scratch crew home, and real ptys.
//   node packages/crew/test/test-daemon.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { crewPaths, lineDecoder } from '../src/daemon/transport.mjs'
import { daemonHello, enterSession, request, stopDaemon } from '../src/daemon/client.mjs'
import { startDaemon } from '../src/daemon/daemon.mjs'
import { resolveCommand } from '../src/command.mjs'
import { runRegistry } from '../src/registry.mjs'
import { crewHost, crewMcpConfig } from '../src/crew-host.mjs'
import { MCP_SERVER, tool } from '../src/tools.mjs'
import { runsView } from '../src/run-view-model.mjs'

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
  const pid = Number(await until("the terminal's crew command", () => /pid (\d+) .*\(started\)/.exec(said)?.[1]))
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
  assert.equal(view.status, 3, "the view's own refusal: it needs a terminal")
  // Bare `crew view` is the runs list now, so a second run named is the usage error.
  const usage = crew('view', 'one', 'two')
  assert.equal(usage.status, 2, "the view's own usage error")
  const attached = crew('view', '--attached')
  assert.equal(attached.status, 2, "the view's own usage error")
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
  await assert.rejects(request(paths, { op: 'stop' }), /1 run\(s\) live: run-1; --force stops the daemon anyway, and the next one resumes them/)
  await assert.rejects(request(paths, { op: 'nope' }), /unknown op nope/)
  assert.equal((await request(paths, { op: 'stop', force: true })).ok, true)
  await until('the daemon to exit', () => exits.length)
  assert.deepEqual(exits.slice(0, 1), [0])
  assert.equal(daemon.server.listening, false)
})

test('daemon: a request that is JSON but not an object gets an error reply, and the daemon lives on', async () => {
  const paths = crewPaths({ CREW_HOME: join(mkdtempSync(join(tmpdir(), 'crew-daemon-')), 'home') })
  const daemon = await startDaemon({ paths, spawnSession: () => assert.fail('no session here'), exit: () => {}, log: () => {} })
  try {
    const socket = net.connect(paths.endpoint)
    const replies = []
    socket.on(
      'data',
      lineDecoder((m) => replies.push(m)),
    )
    const sent = ['null', '42', '"x"', '[]', 'true']
    socket.write(sent.map((line) => `${line}\n`).join(''))
    await until('a reply to each', () => replies.length === sent.length)
    for (const reply of replies) {
      assert.equal(reply.ok, false)
      assert.equal(reply.re, null)
      assert.match(reply.error, /not a JSON object request/)
    }
    socket.write('{"op":"hello","id":7}\n')
    await until('the hello on the same connection', () => replies.length === sent.length + 1)
    assert.deepEqual([replies.at(-1).re, replies.at(-1).ok], [7, true])
    socket.destroy()
    assert.equal((await daemonHello(paths))?.pid, process.pid, 'a new connection is answered too')
  } finally {
    await daemon.shutdown('test over')
  }
})

test('session: a spawned session keeps running and keeps its screen while nobody has it entered', async () => {
  const { paths, crew } = scratch()
  const program = ["process.stdout.write('header\\r\\n')", "process.stdout.write('\\x1b[5;10Hkept')", 'let n = 0', "setInterval(() => process.stdout.write('\\x1b[2;1Htick ' + (++n)), 100)"].join('\n')
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
  assert.deepEqual(
    listed.map((s) => [s.id, s.alive]),
    [[id, true]],
  )
  const printed = crew('session', 'screen', id)
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /^header\n/)
  assert.match(crew('session', 'list').stdout, new RegExp(`^${id}\\trunning\\tpid \\d+\\t\\d+x\\d+\\tnode -e`))

  assert.equal(crew('session', 'kill', id).status, 0)
  await until('the session to exit', async () => !(await request(paths, { op: 'session.list' })).sessions[0].alive)
  assert.equal(crew('session', 'spawn').status, 2)
  assert.match(crew('session', 'screen', '99').stderr, /no session 99/)
})

// A stand-in for a pty session: its program runs until killed.
function fakeSession({ id, command, cwd, env, title = null }) {
  let exit = null
  const exits = new Set()
  return {
    id,
    env,
    info: () => ({ id, title, command, cwd, pid: 1, cols: 80, rows: 24, alive: exit === null, exit, quietMs: null }),
    onExit: (watch) => exits.add(watch),
    kill() {
      if (exit) return
      exit = { code: 0, signal: null }
      for (const watch of exits) watch(exit)
    },
    write() {},
    rename() {},
    resize() {},
  }
}

// A session whose quiet the test sets, and that can be entered.
function quietSession(spawned, quiet) {
  return (s) => {
    const session = fakeSession(s)
    const { info } = session
    let title = s.title
    session.rename = (to) => (title = to)
    session.info = () => ({ ...info(), title, quietMs: quiet.get(s.command.at(-1)) ?? null })
    session.enter = () => () => {}
    spawned.push({ ...s, session })
    return session
  }
}

test('daemon: a session is ready once its harness says so, whatever its terminal draws; not before, and not once its program ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const spawned = []
  const daemon = await startDaemon({ paths, registry: join(dir, 'runs.jsonl'), spawnSession: quietSession(spawned, new Map([['busy', 10]])), exit: () => {}, log: () => {} })
  try {
    const { session } = await request(paths, { op: 'session.spawn', command: ['pi', '--approve', '--session-id', 'uuid-busy', 'busy'], cwd: dir, title: 'busy' })
    const info = async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === session.id)
    assert.deepEqual([session.ready, (await info()).ready], [false, false], 'not ready until told')
    const told = await request(paths, { op: 'session.ready', id: session.id })
    assert.deepEqual([told.session.ready, (await info()).ready, (await info()).quietMs], [true, true, 10], 'ready once told, however much it draws')
    await request(paths, { op: 'session.waiting', id: session.id, waiting: 'pi asks: Allow?' })
    assert.deepEqual([(await info()).ready, (await info()).waiting], [true, 'pi asks: Allow?'], 'a dialog does not unsay it')
    await request(paths, { op: 'session.kill', id: session.id })
    await until('the program to end', async () => !(await info()).alive)
    assert.equal((await info()).ready, false, 'an ended program is not ready')
    await assert.rejects(request(paths, { op: 'session.ready', id: '99' }), /no session 99/)
  } finally {
    daemon.shutdown('test over')
  }
})

test("daemon: parks a done agent's harness once quiet past parkAfterMs, never an unsettled, failed, busy, entered or asking one, and refuses a write to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const spawned = []
  const quiet = new Map([
    ['done', 5_000],
    ['busy', 10],
    ['unsettled', 5_000],
    ['failed', 5_000],
    ['entered', 5_000],
    ['asking', 5_000],
  ])
  const daemon = await startDaemon({ paths, registry: join(dir, 'runs.jsonl'), spawnSession: quietSession(spawned, quiet), parkAfterMs: 1_000, parkSweepMs: 20, exit: () => {}, log: () => {} })
  try {
    const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
    const worker = async (name, outcome) => {
      const { session } = await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', `uuid-${name}`, name], cwd: dir, title: name })
      const { worker: w } = await request(paths, { op: 'run.worker', run: run.id, session: session.id, coordinator: 'c' })
      if (outcome) await request(paths, { op: 'mail.send', taskId: w.taskId, dispatchId: session.id, capability: w.capability, type: 'worker_done', outcome })
      return session.id
    }
    const done = await worker('done', 'succeeded')
    const busy = await worker('busy', 'succeeded')
    const unsettled = await worker('unsettled', null)
    const failed = await worker('failed', 'failed')
    const entered = await worker('entered', 'succeeded')
    const asking = await worker('asking', 'succeeded')
    await request(paths, { op: 'session.waiting', id: asking, waiting: 'a permission dialog' })
    const { socket } = await enterSession(paths, { id: entered }, () => {})
    const info = async (id) => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id)
    await until('the done agent to be parked', async () => (await info(done)).parked)
    await sleep(100)
    assert.deepEqual([(await info(done)).alive, (await info(done)).parked], [false, true])
    for (const id of [busy, unsettled, failed, entered, asking]) assert.deepEqual([(await info(id)).alive, !!(await info(id)).parked], [true, false], `session ${id} kept`)
    assert.equal((await request(paths, { op: 'worker.show', id: done })).worker.exited, true)
    await assert.rejects(request(paths, { op: 'session.write', id: done, data: 'hi' }), /session \d+ is parked: .*enter it to resume/)
    socket.destroy()
  } finally {
    daemon.shutdown('test over')
  }
})

test('daemon: entering a parked session starts its harness again on its resume line, in the same session id, cwd, env and title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const spawned = []
  const daemon = await startDaemon({ paths, registry: join(dir, 'runs.jsonl'), spawnSession: quietSession(spawned, new Map([['done', 5_000]])), parkAfterMs: 1_000, parkSweepMs: 20, exit: () => {}, log: () => {} })
  try {
    const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
    const { session } = await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', 'uuid-1', 'done'], cwd: dir, env: { A: '1' }, title: 'the agent' })
    const id = session.id
    const { worker: w } = await request(paths, { op: 'run.worker', run: run.id, session: id, coordinator: 'c' })
    await request(paths, { op: 'mail.send', taskId: w.taskId, dispatchId: id, capability: w.capability, type: 'worker_done', outcome: 'succeeded' })
    await request(paths, { op: 'session.rename', id, title: 'renamed' })
    await until('it to be parked', async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id).parked)

    const { session: back, socket } = await enterSession(paths, { id, cols: 100, rows: 40 }, () => {})
    socket.destroy()
    assert.equal(spawned.length, 2)
    const again = spawned[1]
    assert.equal(again.id, id)
    assert.deepEqual(again.command, ['claude', '--resume', 'uuid-1', 'done'])
    assert.deepEqual([again.cwd, again.env.A, again.env.CREW_SESSION, again.title, again.cols, again.rows], [dir, '1', id, 'renamed', 100, 40])
    assert.deepEqual([back.alive, !!back.parked], [true, false])
    // Its dispatch is the same one, still settled: once quiet again it parks again.
    assert.equal((await request(paths, { op: 'worker.show', id })).worker.settled, true)
    await until('it to be parked again', async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id).parked)
  } finally {
    daemon.shutdown('test over')
  }
})

test('daemon: a real pty parked and entered again runs its resume line and shows it to whoever entered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const daemon = await startDaemon({ paths, registry: join(dir, 'runs.jsonl'), parkAfterMs: 300, parkSweepMs: 50, exit: () => {}, log: () => {} })
  try {
    const harness = "process.stdout.write('ran ' + process.argv.slice(1).join(' ') + '\\r\\n'); setInterval(() => {}, 1000)"
    const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
    const { session } = await request(paths, { op: 'session.spawn', command: [process.execPath, '-e', harness, '--', '--session-id', 'u-9'], cwd: dir })
    const id = session.id
    const { worker: w } = await request(paths, { op: 'run.worker', run: run.id, session: id, coordinator: 'c' })
    await request(paths, { op: 'mail.send', taskId: w.taskId, dispatchId: id, capability: w.capability, type: 'worker_done', outcome: 'succeeded' })
    await until('it to be parked', async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id).parked)
    const { pid } = (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id)
    await until('its program to end', () => !alive(pid))

    let seen = ''
    const { socket } = await enterSession(paths, { id }, (bytes) => (seen += bytes))
    await until('its resume line to run', () => seen.includes('ran --resume u-9'))
    const back = (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id)
    assert.deepEqual([back.alive, !!back.parked], [true, false])
    assert.notEqual(back.pid, pid)
    // Entered, it is never parked, however quiet.
    await sleep(500)
    assert.equal((await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id).alive, true)
    socket.destroy()
    await until('it to park again once left', async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id).parked)
  } finally {
    daemon.shutdown('test over')
  }
})

test("daemon: after a restart every agent session comes back under its old id, parked, its env never on disk; a working one shows hostDied for its runner to continue, and entering any resumes it with crew's env", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'runs.jsonl')
  const spawned = []
  const spawnSession = quietSession(spawned, new Map())
  const exits = []
  await startDaemon({ paths, registry, spawnSession, parkAfterMs: 0, exit: () => exits.push(1), log: () => {} })
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
  const worker = async (name, outcome) => {
    const { session } = await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', `uuid-${name}`, '--model', 'opus'], cwd: join(dir, name), env: { SECRET: 's3cret' }, title: name })
    const { worker: w } = await request(paths, { op: 'run.worker', run: run.id, session: session.id, coordinator: 'c' })
    if (outcome) await request(paths, { op: 'mail.send', taskId: w.taskId, dispatchId: session.id, capability: w.capability, type: 'worker_done', outcome })
    return session.id
  }
  const done = await worker('done', 'succeeded')
  const failed = await worker('failed', 'failed')
  const working = await worker('working', null)
  const closed = await worker('closed', 'succeeded')
  await request(paths, { op: 'session.spawn', command: ['node', 'tail.mjs'], cwd: dir })
  await request(paths, { op: 'session.rename', id: done, title: 'done, renamed' })
  await request(paths, { op: 'session.close', id: closed })
  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)
  assert.doesNotMatch(readFileSync(join(paths.home, 'runs.json'), 'utf8'), /s3cret/, 'no session env on disk')

  spawned.length = 0
  const second = await startDaemon({ paths, registry, spawnSession, parkAfterMs: 0, exit: () => {}, log: () => {} })
  try {
    const { sessions } = await request(paths, { op: 'session.list' })
    assert.deepEqual(sessions.map((s) => s.id).sort(), [done, failed, working].sort(), 'every agent session but the closed one; no session of no dispatch')
    const of = (id) => sessions.find((s) => s.id === id)
    assert.deepEqual([of(done).title, of(done).cwd, of(done).command, of(done).alive, of(done).parked], ['done, renamed', join(dir, 'done'), ['claude', '--session-id', 'uuid-done', '--model', 'opus'], false, true])
    assert.equal(spawned.length, 0, 'no harness started until someone enters')
    const show = async (id) => (await request(paths, { op: 'worker.show', id })).worker
    assert.deepEqual(await show(working), { settled: false, outcome: null, submissions: 0, note: null, needsYou: null, gone: true, exited: false, waiting: null, terminal: working, hostDied: true })
    assert.deepEqual([(await show(done)).settled, (await show(done)).gone, (await show(failed)).outcome], [true, false, 'failed'])

    for (const id of [done, working]) (await enterSession(paths, { id }, () => {})).socket.destroy()
    const [a, b] = spawned
    assert.deepEqual([a.id, a.command, a.cwd], [done, ['claude', '--resume', 'uuid-done', '--model', 'opus'], join(dir, 'done')])
    assert.deepEqual([a.env.CREW_SESSION, a.env.CREW_HOST, a.env.CREW_HOME, a.env.CLAUDE_CODE_DISABLE_AGENT_VIEW, a.env.SECRET], [done, 'crew', paths.home, '1', undefined])
    assert.equal(b.id, working)
    // Revived, a working agent is a live session again: its runner watches it, nothing to continue.
    assert.deepEqual([(await show(working)).gone, (await show(working)).hostDied], [false, undefined])
  } finally {
    second.shutdown('test over')
  }
})

test('daemon: every worker_done a dispatch sends is counted and taken as its outcome and last result, settled or not, and the next daemon keeps them (#173)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'runs.jsonl')
  const spawnSession = quietSession([], new Map())
  const exits = []
  await startDaemon({ paths, registry, spawnSession, parkAfterMs: 60_000, exit: () => exits.push(1), log: () => {} })
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
  const { session } = await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', 'uuid-r'], cwd: dir, title: 'held' })
  const id = session.id
  const { worker: w } = await request(paths, { op: 'run.worker', run: run.id, session: id, coordinator: 'c' })
  const show = async () => (await request(paths, { op: 'worker.show', id })).worker
  const result = () => request(paths, { op: 'worker.result', id })
  const done = (outcome, value) => request(paths, { op: 'mail.send', taskId: w.taskId, dispatchId: id, capability: w.capability, type: 'worker_done', outcome, ...(value !== undefined && { result: value }) })
  const shape = ({ result, outcome, submissions }) => ({ result, outcome, submissions })

  assert.deepEqual([(await show()).submissions, shape(await result())], [0, { result: null, outcome: null, submissions: 0 }])
  await done('succeeded', { decisions_needed: ['which?'] })
  assert.deepEqual([(await show()).settled, (await show()).submissions], [true, 1])
  await done('failed', { decisions_needed: [] })
  assert.deepEqual([(await show()).settled, (await show()).outcome, (await show()).submissions], [true, 'failed', 2])
  assert.deepEqual(shape(await result()), { result: { decisions_needed: [] }, outcome: 'failed', submissions: 2 })
  // A worker_done with no result (`crew orchestration send`) still counts, its result none.
  await done('succeeded')
  assert.deepEqual(shape(await result()), { result: null, outcome: 'succeeded', submissions: 3 })
  await done('succeeded', 'plain text')
  // The crew host hands it back as the daemon does.
  const host = crewHost({ paths, harnesses: {}, start: async () => {} })
  assert.deepEqual(await host.workerResult({ dispatch: id }), { result: 'plain text', outcome: 'succeeded', submissions: 4 })
  await assert.rejects(request(paths, { op: 'worker.result', id: 'nope' }), /dispatch_not_found/)

  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)
  const second = await startDaemon({ paths, registry, spawnSession, parkAfterMs: 60_000, exit: () => {}, log: () => {} })
  try {
    assert.deepEqual([(await show()).submissions, shape(await result())], [4, { result: 'plain text', outcome: 'succeeded', submissions: 4 }])
  } finally {
    second.shutdown('test over')
  }
})

test("daemon: a `?` session spawned with its run's state dir is the orchestrator's to worker.agent, with that dir, which the next daemon keeps; a `?` session of no state dir, and a session of no dispatch titled otherwise, have no agent (#194)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'runs.jsonl')
  const spawnSession = quietSession([], new Map())
  const exits = []
  await startDaemon({ paths, registry, spawnSession, parkAfterMs: 60_000, exit: () => exits.push(1), log: () => {} })
  const stateDir = join(dir, 'orca-run')
  mkdirSync(stateDir)
  const spawn = async (title, extra = {}) => (await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', `uuid-${title}`], cwd: dir, title, ...extra })).session.id
  const console = await spawn('orchestrator/console', { stateDir })
  const bare = await spawn('orchestrator/console')
  const other = await spawn('not a console', { stateDir })
  const agentOf = async (id) => (await request(paths, { op: 'worker.agent', id })).agent
  assert.deepEqual(await agentOf(console), { role: 'orchestrator', schema: null, stateDir })
  assert.deepEqual([await agentOf(bare), await agentOf(other)], [null, null])
  await assert.rejects(request(paths, { op: 'worker.show', id: console }), /dispatch_not_found/, 'still no dispatch of any run')

  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)
  const second = await startDaemon({ paths, registry, spawnSession, parkAfterMs: 60_000, exit: () => {}, log: () => {} })
  try {
    assert.deepEqual(await agentOf(console), { role: 'orchestrator', schema: null, stateDir }, 'the next daemon knows its run')
    assert.equal(await agentOf(bare), null)
  } finally {
    second.shutdown('test over')
  }
})

test("daemon: a session submits and mails by its id alone, its result checked against the schema run.worker gave its dispatch, which the next daemon keeps; a session of no dispatch, a released one, and a doctor's submit are refused, saying why (#174)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'runs.jsonl')
  const spawnSession = quietSession([], new Map())
  const exits = []
  await startDaemon({ paths, registry, spawnSession, parkAfterMs: 60_000, exit: () => exits.push(1), log: () => {} })
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
  const spawn = async (title) => (await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', `uuid-${title}`], cwd: dir, title })).session.id
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false }
  const resultPath = join(dir, 'result.json')
  const [worker, text, doctor, released, bare] = [await spawn('worker'), await spawn('text'), await spawn('doctor'), await spawn('released'), await spawn('bare')]
  const dispatch = (session, extra) => request(paths, { op: 'run.worker', run: run.id, session, coordinator: 'c', ...extra })
  await assert.rejects(dispatch(worker, { agent: { role: 'boss' } }), /not an agent role: "boss"; one of worker, doctor/)
  await assert.rejects(dispatch(worker, { agent: { schema: ['x'] } }), /not a result schema/)
  const { worker: workerTask } = await dispatch(worker, { agent: { role: 'worker', schema, resultPath } })
  await dispatch(text, {})
  await dispatch(doctor, { agent: { role: 'doctor' } })
  await dispatch(released, { agent: { schema } })
  await request(paths, { op: 'worker.release', id: released })
  const submit = (id, payload) => request(paths, { op: 'worker.submit', id, payload })
  const mail = (id, m) => request(paths, { op: 'worker.mail', id, ...m })
  const result = async (id) => {
    const { result, outcome, submissions } = await request(paths, { op: 'worker.result', id })
    return { result, outcome, submissions }
  }
  // What its harness equips each session with: a session of no agent, or of
  // one released, is told it has none, not refused.
  const agents = async () => Promise.all([worker, text, doctor, released, bare, 'nope'].map(async (id) => (await request(paths, { op: 'worker.agent', id })).agent))
  const AGENTS = [{ role: 'worker', schema }, { role: 'worker', schema: null }, { role: 'doctor', schema: null }, null, null, null]
  assert.deepEqual(await agents(), AGENTS)

  // Every error at once, nothing stored or settled.
  await assert.rejects(submit(worker, { ok: 1, extra: true }), (e) => /2 validation error\(s\) against its schema\n {2}\$\.ok: expected boolean, got integer\n {2}\$: unexpected property "extra"\nFix the payload and submit again\./.test(e.message))
  await assert.rejects(submit(worker, '{ not json'), /payload is not valid JSON/)
  assert.deepEqual([existsSync(resultPath), (await request(paths, { op: 'worker.show', id: worker })).worker.settled], [false, false])
  const accepted = await submit(worker, '{"ok": true}')
  assert.deepEqual([/^msg_/.test(accepted.id), accepted.resultPath], [true, resultPath])
  assert.deepEqual([JSON.parse(readFileSync(resultPath, 'utf8')), await result(worker)], [{ ok: true }, { result: { ok: true }, outcome: 'succeeded', submissions: 1 }])
  await submit(worker, { ok: false })
  assert.deepEqual(await result(worker), { result: { ok: false }, outcome: 'succeeded', submissions: 2 })
  // A schemaless agent's result is text.
  await assert.rejects(submit(text, { ok: true }), /this agent's result is text/)
  await submit(text, 'plain words')
  assert.deepEqual(await result(text), { result: 'plain words', outcome: 'succeeded', submissions: 1 })

  await assert.rejects(submit(bare, 'x'), new RegExp(`no dispatch for session ${bare}: crew takes results only from a session it started for an agent`))
  await assert.rejects(submit('nope', 'x'), /no dispatch for session nope/)
  await assert.rejects(submit(released, { ok: true }), new RegExp(`session ${released}'s dispatch was released: its runner let its agent go, so it takes no more results`))
  await assert.rejects(submit(doctor, 'done'), new RegExp(`session ${doctor} is a doctor's: a doctor submits no result`))
  assert.equal((await result(doctor)).submissions, 0)

  // Mail, fenced alike; a worker's result never goes as mail, a doctor's worker_done does.
  await mail(doctor, { type: 'handoff', subject: 'note', body: 'carry on' })
  await mail(doctor, { type: 'worker_done', outcome: 'failed', body: 'gave up' })
  assert.deepEqual(await result(doctor), { result: null, outcome: 'failed', submissions: 1 })
  await mail(worker, { type: 'escalation', body: 'stuck' })
  await assert.rejects(mail(worker, { type: 'worker_done' }), new RegExp(`session ${worker} is a worker's: its result goes through submit`))
  await assert.rejects(mail(worker, { type: 'chatter' }), /not a message type crew takes/)
  await assert.rejects(mail(bare, { type: 'handoff' }), /no dispatch for session/)
  await assert.rejects(mail(released, { type: 'handoff' }), /dispatch was released: its runner let its agent go, so it takes no more mail/)
  const { messages } = await request(paths, { op: 'mail.check', coordinator: 'c' })
  assert.deepEqual(
    messages.map((m) => [m.type, m.dispatchId, m.body, m.outcome]),
    [
      ['worker_done', worker, 'Submitted a result that is valid against its schema. It is recorded at ' + resultPath + '. Nothing remains for this task.', 'succeeded'],
      ['worker_done', worker, 'Submitted a result that is valid against its schema. It is recorded at ' + resultPath + '. Nothing remains for this task.', 'succeeded'],
      ['worker_done', text, 'Submitted a result that is valid against its schema. Nothing remains for this task.', 'succeeded'],
      ['handoff', doctor, 'carry on', null],
      ['worker_done', doctor, 'gave up', 'failed'],
      ['escalation', worker, 'stuck', null],
    ],
  )

  // A result sent as mail, as the CLI submit sends it, is checked the same way.
  const send = (r) => request(paths, { op: 'mail.send', taskId: workerTask.taskId, dispatchId: worker, type: 'worker_done', result: r })
  await assert.rejects(send({ ok: 'yes' }), /submit rejected: 1 validation error\(s\) against its schema\n {2}\$\.ok: expected boolean, got string\nFix the payload and submit again\./)
  assert.equal((await result(worker)).submissions, 2)
  await send({ ok: true })
  assert.deepEqual(await result(worker), { result: { ok: true }, outcome: 'succeeded', submissions: 3 })

  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)
  const second = await startDaemon({ paths, registry, spawnSession, parkAfterMs: 60_000, exit: () => {}, log: () => {} })
  try {
    assert.deepEqual(await agents(), AGENTS)
    await assert.rejects(submit(worker, { ok: 'no' }), /expected boolean, got string/)
    await submit(worker, { ok: true })
    assert.deepEqual(await result(worker), { result: { ok: true }, outcome: 'succeeded', submissions: 4 })
    await assert.rejects(submit(doctor, 'done'), /is a doctor's/)
    await assert.rejects(submit(released, { ok: true }), /was released/)
  } finally {
    second.shutdown('test over')
  }
})

// Claude's side of crew's MCP server: started as crew's --mcp-config says,
// its env's ${VAR} expanded from the session's `env` as Claude does.
function mcpClient(env) {
  const crew = JSON.parse(crewMcpConfig()).mcpServers[MCP_SERVER]
  const expanded = Object.fromEntries(Object.entries(crew.env).map(([k, v]) => [k, v.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name, otherwise = '') => env[name] ?? otherwise)]))
  const child = spawn(crew.command, crew.args, { env: { PATH: process.env.PATH, ...expanded }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  // The notifications it sent, by method.
  const notified = []
  let next = 0
  child.stdout.setEncoding('utf8')
  child.stdout.on(
    'data',
    lineDecoder((m) => (m.id == null ? notified.push(m.method) : waiting.get(m.id)?.(m))),
  )
  const rpc = (method, params) =>
    new Promise((answer) => {
      const id = ++next
      waiting.set(id, answer)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const names = async () => (await rpc('tools/list')).result.tools.map((t) => t.name)
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result
  return { rpc, names, call, notified, close: () => child.stdin.end() }
}

test("daemon: crew's MCP server answers initialize, lists a session's tools by its agent's role with the table's descriptions, and makes each call one daemon op; a refusal, and a daemon gone, come back as error content naming it (#177)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const exits = []
  await startDaemon({ paths, registry: join(dir, 'runs.jsonl'), spawnSession: quietSession([], new Map()), parkAfterMs: 60_000, exit: () => exits.push(1), log: () => {} })
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
  const spawn_ = async (title) => (await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', `uuid-${title}`], cwd: dir, title })).session.id
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
  const resultPath = join(dir, 'result.json')
  const [worker, doctor, bare] = [await spawn_('worker'), await spawn_('doctor'), await spawn_('bare')]
  await request(paths, { op: 'run.worker', run: run.id, session: worker, coordinator: 'c', agent: { role: 'worker', schema, resultPath } })
  await request(paths, { op: 'run.worker', run: run.id, session: doctor, coordinator: 'c', agent: { role: 'doctor' } })
  const clients = []
  const client = (env) => {
    const c = mcpClient({ CREW_HOME: paths.home, ...env })
    clients.push(c)
    return c
  }
  const show = async (id) => (await request(paths, { op: 'worker.show', id })).worker
  try {
    const w = client({ CREW_SESSION: worker, CREW_AGENT: '1' })
    const init = await w.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.289' } })
    assert.deepEqual(init.result, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: MCP_SERVER, version: '1' } })
    const { tools } = (await w.rpc('tools/list')).result
    assert.deepEqual(
      tools.map((t) => [t.name, t.description]),
      ['status', 'needs_you', 'submit'].map((name) => [name, tool(name).description]),
    )
    assert.deepEqual(tools[2].inputSchema, schema)
    assert.deepEqual(await w.call('status', { note: 'reading the code' }), { content: [{ type: 'text', text: 'Posted: the operator sees "reading the code" on your row.' }] })
    await w.call('needs_you', { reason: 'log in to npm' })
    assert.deepEqual([(await show(worker)).note, (await show(worker)).needsYou], ['reading the code', 'log in to npm'])
    // The daemon's refusal is error content, Claude's to show its agent.
    const refused = await w.call('submit', { ok: 'yes' })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /submit rejected: 1 validation error\(s\)[\s\S]*\$\.ok: expected boolean, got string/)
    assert.equal((await show(worker)).settled, false)
    assert.match((await w.call('submit', { ok: true })).content[0].text, /^Submitted: the workflow has your result\. It is recorded at .*result\.json\./)
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { ok: true })
    assert.deepEqual([(await show(worker)).settled, (await request(paths, { op: 'worker.result', id: worker })).submissions], [true, 1])
    assert.equal((await w.call('handoff', { note: 'x' })).isError, true)
    assert.equal((await w.rpc('resources/list')).error.code, -32601)

    const d = client({ CREW_SESSION: doctor, CREW_AGENT: '1' })
    assert.deepEqual(await d.names(), ['status', 'needs_you', 'handoff', 'give_up'])
    assert.match((await d.call('handoff', { note: 'read the lockfile first' })).content[0].text, /^Handed off: /)
    assert.deepEqual([(await show(doctor)).settled, (await show(doctor)).outcome], [true, 'succeeded'])

    // A session of no agent, and a claude outside crew, list none.
    for (const env of [{ CREW_SESSION: bare }, {}]) {
      const none = client(env)
      assert.deepEqual(await none.names(), [], JSON.stringify(env))
      assert.equal((await none.call('status', { note: 'x' })).isError, true)
    }

    await request(paths, { op: 'stop', force: true })
    await until('the daemon to stop', () => exits.length === 1)
    const gone = await w.call('status', { note: 'still here' })
    assert.equal(gone.isError, true)
    assert.match(gone.content[0].text, /^crew's daemon is not reachable \(.*\)\. Your note was not posted: carry on with your task\.$/)
    assert.match((await w.call('submit', { ok: true })).content[0].text, /^crew's daemon is not reachable \(.*\)\. Your result was not submitted: submit it with the command line in your instructions instead, as they say\.$/)
  } finally {
    for (const c of clients) c.close()
  }
})

test("daemon: crew's MCP server in an agent's session whose dispatch comes after its first tools/list lists none, goes on looking, and tells Claude its list changed once its agent is found (#171)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  await startDaemon({ paths, registry: join(dir, 'runs.jsonl'), spawnSession: quietSession([], new Map()), parkAfterMs: 60_000, exit: () => {}, log: () => {} })
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
  const late = (await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', 'uuid-late'], cwd: dir, title: 'late' })).session.id
  const c = mcpClient({ CREW_HOME: paths.home, CREW_SESSION: late, CREW_AGENT: '1' })
  try {
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.289' } })
    assert.deepEqual(await c.names(), [])
    assert.deepEqual(c.notified, [])
    await request(paths, { op: 'run.worker', run: run.id, session: late, coordinator: 'c', agent: { role: 'worker' } })
    await until('its list changed', () => c.notified.includes('notifications/tools/list_changed'))
    assert.deepEqual(await c.names(), ['status', 'needs_you', 'submit'])
  } finally {
    c.close()
    await request(paths, { op: 'stop', force: true })
  }
})

test("daemon: a session's note and needs-you reason are kept on its dispatch, for worker.show and the next daemon; needs-you clears on its next note, submit or mail, a CLI send included; a session of no dispatch is refused (#175)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'runs.jsonl')
  const spawnSession = quietSession([], new Map())
  const exits = []
  await startDaemon({ paths, registry, spawnSession, parkAfterMs: 60_000, exit: () => exits.push(1), log: () => {} })
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
  const spawn = async (title) => (await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', `uuid-${title}`], cwd: dir, title })).session.id
  const [worker, doctor, released, bare] = [await spawn('worker'), await spawn('doctor'), await spawn('released'), await spawn('bare')]
  const { worker: w } = await request(paths, { op: 'run.worker', run: run.id, session: worker, coordinator: 'c' })
  await request(paths, { op: 'run.worker', run: run.id, session: doctor, coordinator: 'c', agent: { role: 'doctor' } })
  await request(paths, { op: 'run.worker', run: run.id, session: released, coordinator: 'c' })
  await request(paths, { op: 'worker.release', id: released })
  const status = async (id, note) => (await request(paths, { op: 'worker.status', id, note })).note
  const needsYou = async (id, reason) => (await request(paths, { op: 'worker.needsYou', id, reason })).needsYou
  const kept = async (id) => {
    const { note, needsYou } = (await request(paths, { op: 'worker.show', id })).worker
    return { note, needsYou }
  }

  assert.deepEqual(await kept(worker), { note: null, needsYou: null })
  assert.equal(await status(worker, '  reading the code  '), 'reading the code')
  assert.equal(await needsYou(worker, 'log in to npm'), 'log in to npm')
  assert.deepEqual(await kept(worker), { note: 'reading the code', needsYou: 'log in to npm' })
  // A later note replaces the last, cut to 200 characters, and clears needs-you.
  assert.equal(await status(worker, 'x'.repeat(250)), 'x'.repeat(200))
  assert.deepEqual(await kept(worker), { note: 'x'.repeat(200), needsYou: null })
  await needsYou(worker, 'again')
  await request(paths, { op: 'worker.mail', id: worker, type: 'escalation', body: 'stuck' })
  assert.equal((await kept(worker)).needsYou, null, 'mail clears it')
  await needsYou(worker, 'again')
  await request(paths, { op: 'mail.send', taskId: w.taskId, dispatchId: worker, capability: w.capability, type: 'handoff', body: 'from the CLI' })
  assert.equal((await kept(worker)).needsYou, null, '`crew orchestration send` clears it')
  await needsYou(worker, 'again')
  await request(paths, { op: 'worker.submit', id: worker, payload: 'done' })
  assert.equal((await kept(worker)).needsYou, null, 'a submit clears it')
  await status(doctor, 'reading the log')
  await needsYou(worker, 'kept')

  await assert.rejects(needsYou(worker, '  '), /not a reason/)
  await assert.rejects(status(worker, 3), /not a note: 3/)
  await assert.rejects(status(bare, 'hi'), new RegExp(`no dispatch for session ${bare}: crew takes notes only from a session it started for an agent`))
  await assert.rejects(needsYou('nope', 'hi'), /no dispatch for session nope/)
  await assert.rejects(status(released, 'hi'), /dispatch was released/)
  await assert.rejects(needsYou(doctor, 'hi'), new RegExp(`session ${doctor} is a doctor's: a doctor that needs the person says so with an escalation`))

  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)
  const second = await startDaemon({ paths, registry, spawnSession, parkAfterMs: 60_000, exit: () => {}, log: () => {} })
  try {
    assert.deepEqual(
      [await kept(worker), await kept(doctor)],
      [
        { note: 'x'.repeat(200), needsYou: 'kept' },
        { note: 'reading the log', needsYou: null },
      ],
    )
  } finally {
    second.shutdown('test over')
  }
})

test("daemon: a doctor's session hands off its note as a handoff then its worker_done succeeded, and gives up as its worker_done failed, the reason its body, each in one op; a worker's session is refused either, saying why (#176)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const spawnSession = quietSession([], new Map())
  const daemon = await startDaemon({ paths, registry: join(dir, 'runs.jsonl'), spawnSession, parkAfterMs: 60_000, exit: () => {}, log: () => {} })
  try {
    const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
    const spawn = async (title) => (await request(paths, { op: 'session.spawn', command: ['pi', '--session-id', `uuid-${title}`], cwd: dir, title })).session.id
    const [healer, quitter, worker, released, bare] = [await spawn('healer'), await spawn('quitter'), await spawn('worker'), await spawn('released'), await spawn('bare')]
    for (const [session, role] of [
      [healer, 'doctor'],
      [quitter, 'doctor'],
      [worker, 'worker'],
      [released, 'doctor'],
    ])
      await request(paths, { op: 'run.worker', run: run.id, session, coordinator: 'c', agent: { role } })
    await request(paths, { op: 'worker.release', id: released })
    const handoff = (id, note) => request(paths, { op: 'worker.handoff', id, note })
    const giveUp = (id, reason) => request(paths, { op: 'worker.giveUp', id, reason })
    const result = async (id) => {
      const { outcome, submissions } = await request(paths, { op: 'worker.result', id })
      return { outcome, submissions }
    }

    const sent = await handoff(healer, '  read the lockfile first  ')
    assert.match(sent.id, /^msg_/)
    assert.deepEqual(await result(healer), { outcome: 'succeeded', submissions: 1 })
    // A second is taken as mail as any is: the runner acts on no later handoff.
    await handoff(healer, 'another note')
    await giveUp(quitter, 'only a human can grant the sandbox')
    assert.deepEqual(await result(quitter), { outcome: 'failed', submissions: 1 })

    await assert.rejects(handoff(quitter, '  '), /not a note/)
    await assert.rejects(giveUp(quitter, 3), /not a reason: 3/)
    await assert.rejects(handoff(worker, 'x'), new RegExp(`session ${worker} is a worker's: a handoff is a doctor's note, which ends its round, and a worker has no round to end; it finishes with submit`))
    await assert.rejects(giveUp(worker, 'x'), new RegExp(`session ${worker} is a worker's: give_up ends a doctor's round, and a worker has no round to end; it finishes with submit, or says it needs the person`))
    assert.deepEqual(await result(worker), { outcome: null, submissions: 0 })
    await assert.rejects(handoff(bare, 'x'), new RegExp(`no dispatch for session ${bare}: crew takes handoffs only from a session it started for an agent`))
    await assert.rejects(giveUp(released, 'x'), /dispatch was released: its runner let its agent go, so it takes no more give-ups/)

    const { messages } = await request(paths, { op: 'mail.check', coordinator: 'c' })
    assert.deepEqual(
      messages.map((m) => [m.type, m.dispatchId, m.subject, m.body, m.outcome]),
      [
        ['handoff', healer, 'note', 'read the lockfile first', null],
        ['worker_done', healer, 'note handed off', 'Handed off its note.', 'succeeded'],
        ['handoff', healer, 'note', 'another note', null],
        ['worker_done', healer, 'note handed off', 'Handed off its note.', 'succeeded'],
        ['worker_done', quitter, 'gave up', 'only a human can grant the sandbox', 'failed'],
      ],
    )
    assert.equal(messages[0].id, sent.id)
  } finally {
    daemon.shutdown('test over')
  }
})

test("daemon: session.revive starts a parked session's harness again in place and holds it unparked until written to; a live one is left as it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const spawned = []
  const daemon = await startDaemon({ paths, registry: join(dir, 'runs.jsonl'), spawnSession: quietSession(spawned, new Map([['done', 5_000]])), parkAfterMs: 1_000, parkSweepMs: 20, exit: () => {}, log: () => {} })
  try {
    const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
    const { session } = await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', 'uuid-r', 'done'], cwd: dir })
    const { worker: w } = await request(paths, { op: 'run.worker', run: run.id, session: session.id, coordinator: 'c' })
    await request(paths, { op: 'mail.send', taskId: w.taskId, dispatchId: session.id, capability: w.capability, type: 'worker_done', outcome: 'succeeded' })
    await request(paths, { op: 'session.ready', id: session.id })
    await until('it to be parked', async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === session.id).parked)
    const { session: back } = await request(paths, { op: 'session.revive', id: session.id })
    assert.deepEqual([back.id, back.alive, !!back.parked, back.command, back.ready], [session.id, true, false, ['claude', '--resume', 'uuid-r', 'done'], false], 'a revived harness has yet to say it is ready')
    await request(paths, { op: 'session.revive', id: session.id })
    assert.equal(spawned.length, 2, 'a live session is not started twice')
    // Woken for a caller about to type, it is not parked again before that write, however quiet.
    await sleep(200)
    assert.equal((await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === session.id).parked, undefined)
    await request(paths, { op: 'session.write', id: session.id, data: 'follow up' })
    await until('it to park again once written to', async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === session.id).parked)
    await assert.rejects(request(paths, { op: 'session.revive', id: '999' }), /no session 999/)
  } finally {
    daemon.shutdown('test over')
  }
})

test("daemon: session.park parks a done agent's session at once, however recently it drew; anything else is refused, naming why", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const spawned = []
  const daemon = await startDaemon({
    paths,
    registry: join(dir, 'runs.jsonl'),
    spawnSession: quietSession(
      spawned,
      new Map([
        ['done', 10],
        ['working', 10],
      ]),
    ),
    parkAfterMs: 0,
    exit: () => {},
    log: () => {},
  })
  try {
    const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c', runner: null })
    const worker = async (name, outcome) => {
      const { session } = await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', `uuid-${name}`, name], cwd: dir })
      const { worker: w } = await request(paths, { op: 'run.worker', run: run.id, session: session.id, coordinator: 'c' })
      if (outcome) await request(paths, { op: 'mail.send', taskId: w.taskId, dispatchId: session.id, capability: w.capability, type: 'worker_done', outcome })
      return session.id
    }
    const done = await worker('done', 'succeeded')
    const working = await worker('working', null)
    const { session: park } = await request(paths, { op: 'session.park', id: done })
    assert.deepEqual([park.alive, park.parked], [false, true])
    await request(paths, { op: 'session.park', id: done })
    await assert.rejects(request(paths, { op: 'session.park', id: working }), /session \d+ is not parked: its agent is not done/)
  } finally {
    daemon.shutdown('test over')
  }
})

test('daemon: one that died with a run live is followed by one that starts its runner again; a worker lost with it shows hostDied, one that ended before does not, and stop names the live run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'orca-runs.jsonl')
  const project = join(dir, 'project')
  mkdirSync(project)
  const script = join(project, 'workflow.js')
  writeFileSync(script, 'return 1\n')
  const runDir = join(project, 'orca-run')
  const spawned = []
  const spawnSession = (s) => {
    const session = fakeSession(s)
    spawned.push(session)
    return session
  }
  const exits = []
  await startDaemon({ paths, registry, spawnSession, exit: () => exits.push(1), log: () => {} })
  const spawn = async (command) => (await request(paths, { op: 'session.spawn', command, cwd: project })).session.id
  const runner = await spawn(['node', 'runner.mjs'])
  assert.equal(spawned[0].env.CREW_SESSION, runner, 'a session knows its own id')
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c1', runner })
  const { run: over } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c2', runner })
  const rows = runRegistry(registry)
  rows.armed({ runId: run.id, project, runDir, spec: 'the-spec', script })
  rows.armed({ runId: over.id, project, runDir, spec: 'done-spec', script })
  rows.ended({ runId: over.id, outcome: 'ok' })
  const lost = await spawn(['claude'])
  const ended = await spawn(['claude'])
  await request(paths, { op: 'run.worker', run: run.id, session: lost, coordinator: 'c1' })
  await request(paths, { op: 'run.worker', run: run.id, session: ended, coordinator: 'c1' })
  await request(paths, { op: 'session.kill', id: ended })
  await assert.rejects(request(paths, { op: 'stop' }), (e) => e.message.includes(`1 run(s) live: ${run.id} (the-spec);`))
  // Forced, it takes every session down with it, as a crash does.
  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)

  const second = await startDaemon({ paths, registry, spawnSession, exit: () => exits.push(2), log: () => {} })
  try {
    await second.recovered
    const { sessions } = await request(paths, { op: 'session.list' })
    assert.equal(sessions.length, 1, 'one runner started again, for the run the registry has live')
    const [again] = sessions
    assert.ok(Number(again.id) > Number(ended), 'no session id handed out twice')
    assert.deepEqual(again.command.slice(2), [script, '--host', 'crew', '--state-dir', runDir, '--resume'])
    assert.deepEqual([again.cwd, again.title], [project, 'crew run workflow.js'])
    const show = async (id) => (await request(paths, { op: 'worker.show', id })).worker
    assert.deepEqual(await show(lost), { settled: false, outcome: null, submissions: 0, note: null, needsYou: null, gone: true, exited: false, waiting: null, terminal: lost, hostDied: true })
    assert.equal((await show(ended)).hostDied, undefined, 'it had ended before the daemon went')
    assert.deepEqual((await request(paths, { op: 'run.use', id: run.id, coordinator: 'c3', runner: again.id })).run, { id: run.id, coordinator: 'c3' })
    await assert.rejects(request(paths, { op: 'stop' }), (e) => e.message.includes(`live: ${run.id} (the-spec)`))
  } finally {
    second.shutdown('test over')
  }
  await until('the second daemon to stop', () => exits.includes(2))
  // Recovered once: its new runner is the one a next daemon would look for.
  const third = await startDaemon({ paths, registry, spawnSession, exit: () => {}, log: () => {} })
  try {
    await third.recovered
    assert.equal((await request(paths, { op: 'session.list' })).sessions.length, 1)
  } finally {
    third.shutdown('test over')
  }
})

// The run list asks nothing of crew until r: with the daemon down, its r is the
// call that starts the daemon, whose recovery starts the run's runner. The run
// still gets one runner, and r tells why it started none.
test('daemon: r on a run whose runner died with the daemon, starting the daemon, leaves the run one runner, the recovered one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'orca-runs.jsonl')
  const project = join(dir, 'project')
  const runDir = join(project, 'orca-run')
  mkdirSync(runDir, { recursive: true })
  const script = join(project, 'workflow.js')
  writeFileSync(script, 'return 1\n')
  // Its runner died with the daemon: runner.pid names a process gone.
  writeFileSync(join(runDir, 'runner.pid'), String(spawnSync(process.execPath, ['-e', '0']).pid))
  const spawnSession = fakeSession
  const exits = []
  await startDaemon({ paths, registry, spawnSession, exit: () => exits.push(1), log: () => {} })
  const { session: first } = await request(paths, { op: 'session.spawn', command: ['node', 'runner.mjs'], cwd: project, runDir })
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c1', runner: first.id })
  runRegistry(registry).armed({ runId: run.id, project, runDir, spec: 'the-spec', script })
  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)

  let second = null
  const start = async () => {
    second ??= await startDaemon({ paths, registry, spawnSession, exit: () => {}, log: () => {} })
    return { started: true }
  }
  const view = () => runsView({ host: crewHost({ paths, cwd: project, harnesses: {}, start }), registry, clock: { now: () => Date.parse('2026-01-01T00:00:00Z') }, transcripts: { usage: () => null }, unpushed: () => 0, runner: 'runner.mjs' })
  const runs = view()
  try {
    await runs.refresh()
    assert.equal(runs.model.rows.find((r) => r.kind === 'run').run.alive, false, 'its runner looks dead to the list')
    const refused = await runs.resume(run.id)
    assert.ok(second, 'R started the daemon')
    await second.recovered
    const runners = async () => (await request(paths, { op: 'session.list' })).sessions.filter((s) => s.alive && s.command.includes('--resume'))
    const [recovered, ...more] = await runners()
    assert.deepEqual(more, [], 'one runner for the run')
    assert.equal(recovered.title, 'crew run workflow.js', "crew's own, recovering it")
    assert.match(refused.message, new RegExp(`could not resume the-spec .*: run_live: .* has its runner already, in crew session ${recovered.id}`))
    assert.equal(refused.resumed, undefined)
    // The recovered runner has not written its runner.pid yet: r still starts none.
    assert.match((await runs.resume(run.id)).message, new RegExp(`run_live: .* has its runner already, in crew session ${recovered.id}`))
    assert.equal((await runners()).length, 1)
    // Once it ends, r starts the run's runner, and the next r, from another list, none.
    await request(paths, { op: 'session.kill', id: recovered.id })
    const resumed = await runs.resume(run.id)
    assert.ok(resumed.resumed, resumed.message)
    const other = view()
    await other.refresh()
    assert.match((await other.resume(run.id)).message, new RegExp(`has its runner already, in crew session ${resumed.resumed}`))
    assert.deepEqual(
      (await runners()).map((s) => s.id),
      [resumed.resumed],
    )
  } finally {
    second?.shutdown('test over')
  }
})

// While recovery waits out the old runner, the run is claimed from before the
// daemon answers anyone: a runner started for it then is refused.
test('daemon: a run it is recovering takes no other runner while its old runner trails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'orca-runs.jsonl')
  const project = join(dir, 'project')
  const runDir = join(project, 'orca-run')
  mkdirSync(runDir, { recursive: true })
  const script = join(project, 'workflow.js')
  writeFileSync(script, 'return 1\n')
  const exits = []
  await startDaemon({ paths, registry, spawnSession: fakeSession, exit: () => exits.push(1), log: () => {} })
  const { session: first } = await request(paths, { op: 'session.spawn', command: ['node', 'runner.mjs'], cwd: project, runDir })
  const { run } = await request(paths, { op: 'run.create', objective: 'o', coordinator: 'c1', runner: first.id })
  runRegistry(registry).armed({ runId: run.id, project, runDir, spec: 'the-spec', script })
  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)
  // The old runner outlives its session a moment.
  const trailing = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(join(runDir, 'runner.pid'), String(trailing.pid))
  const second = await startDaemon({ paths, registry, spawnSession: fakeSession, exit: () => {}, log: () => {}, runnerGoneMs: 30_000 })
  try {
    const again = { op: 'session.spawn', command: ['node', 'runner.mjs', '--resume'], cwd: project, runDir: join(project, '.', 'orca-run') }
    await assert.rejects(request(paths, again), new RegExp(`run_live: crew is resuming run ${run.id} itself`))
    assert.deepEqual((await request(paths, { op: 'session.list' })).sessions, [])
    trailing.kill()
    await second.recovered
    const { sessions } = await request(paths, { op: 'session.list' })
    assert.equal(sessions.length, 1)
    await assert.rejects(request(paths, again), new RegExp(`has its runner already, in crew session ${sessions[0].id}`))
    // A session with no run dir is no runner, and is never refused as one.
    assert.ok((await request(paths, { op: 'session.spawn', command: ['node', 'runner.mjs', '--resume'], cwd: project })).session)
  } finally {
    trailing.kill()
    second.shutdown('test over')
  }
})

test('daemon: a ? session, titled orchestrator/console and of no dispatch (#168), is parked once quiet past parkAfterMs, or at once by session.park, and when its harness ends, so Enter resumes it; it comes back parked after a restart, where a session of no dispatch and no such title does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const registry = join(dir, 'runs.jsonl')
  const spawned = []
  const quiet = new Map([
    ['quiet', 5_000],
    ['tail', 5_000],
    ['fresh', 10],
    ['ending', 10],
  ])
  const spawnSession = quietSession(spawned, quiet)
  const exits = []
  await startDaemon({ paths, registry, spawnSession, parkAfterMs: 1_000, parkSweepMs: 20, exit: () => exits.push(1), log: () => {} })
  const console = async (name) => (await request(paths, { op: 'session.spawn', command: ['claude', '--session-id', `uuid-${name}`, name], cwd: dir, title: 'orchestrator/console' })).session.id
  const info = async (id) => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === id)
  const quietOne = await console('quiet')
  const { session: tail } = await request(paths, { op: 'session.spawn', command: ['node', 'tail.mjs', 'tail'], cwd: dir, title: 'runner.log' })
  await until('the quiet ? session to be parked', async () => (await info(quietOne)).parked)
  assert.deepEqual([(await info(quietOne)).alive, (await info(tail.id)).alive, !!(await info(tail.id)).parked], [false, true, false], 'a log tail of no dispatch is never parked')

  const fresh = await console('fresh')
  const { session: parkedNow } = await request(paths, { op: 'session.park', id: fresh })
  assert.deepEqual([parkedNow.alive, parkedNow.parked], [false, true], 'session.park parks a ? session however recently it drew')

  const ending = await console('ending')
  spawned.find((s) => s.id === ending).session.kill()
  await until('the ended ? session to be parked', async () => (await info(ending)).parked)
  assert.equal((await info(ending)).alive, false)
  ;(await enterSession(paths, { id: ending }, () => {})).socket.destroy()
  const revived = spawned.filter((s) => s.id === ending).at(-1)
  assert.deepEqual([revived.command, revived.title], [['claude', '--resume', 'uuid-ending', 'ending'], 'orchestrator/console'], 'entering it starts its harness again on its resume line')

  await request(paths, { op: 'stop', force: true })
  await until('the first daemon to stop', () => exits.length === 1)
  spawned.length = 0
  const second = await startDaemon({ paths, registry, spawnSession, parkAfterMs: 0, exit: () => {}, log: () => {} })
  try {
    const { sessions } = await request(paths, { op: 'session.list' })
    assert.deepEqual(sessions.map((s) => s.id).sort(), [quietOne, fresh, ending].sort(), 'every ? session, never the log tail')
    assert.deepEqual(
      sessions.map((s) => [s.title, s.parked, s.restored, s.alive]),
      sessions.map(() => ['orchestrator/console', true, true, false]),
    )
    ;(await enterSession(paths, { id: quietOne }, () => {})).socket.destroy()
    assert.deepEqual([spawned[0].id, spawned[0].command, spawned[0].cwd], [quietOne, ['claude', '--resume', 'uuid-quiet', 'quiet'], dir])
  } finally {
    second.shutdown('test over')
  }
})

test("daemon: an orchestrator question's Run is never live, and is dropped from runs.json once its session is closed, or by the next daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  homes.push(paths)
  const book = () => JSON.parse(readFileSync(join(paths.home, 'runs.json'), 'utf8'))
  const exits = []
  const first = await startDaemon({ paths, registry: join(dir, 'orca-runs.jsonl'), spawnSession: fakeSession, exit: () => exits.push(1), log: () => {} })
  const spawn = async () => (await request(paths, { op: 'session.spawn', command: ['claude'], cwd: dir })).session.id
  const ask = async () => {
    const { run } = await request(paths, { op: 'run.create', objective: 'orchestrator/halt-triage', coordinator: 'c1' })
    const session = await spawn()
    await request(paths, { op: 'run.worker', run: run.id, session, coordinator: 'c1' })
    return { run: run.id, session }
  }
  const answered = await ask()
  const pending = await ask()
  const { run: plain } = await request(paths, { op: 'run.create', objective: 'a workflow run', coordinator: 'c2' })
  const worker = await spawn()
  await request(paths, { op: 'run.worker', run: plain.id, session: worker, coordinator: 'c2' })
  await assert.rejects(request(paths, { op: 'stop' }), (e) => e.message.includes(`1 run(s) live: ${plain.id};`), 'a live question never holds stop up')
  await request(paths, { op: 'worker.stop', id: answered.session })
  await request(paths, { op: 'session.close', id: answered.session })
  assert.deepEqual(
    book().runs.map((r) => r.id),
    [pending.run, plain.id],
    'the closed question is dropped',
  )
  assert.ok(!book().dispatches.some((d) => d.id === answered.session), 'its dispatch with it')
  await request(paths, { op: 'session.close', id: worker })
  assert.deepEqual(
    book().runs.map((r) => r.id),
    [pending.run, plain.id],
    'a workflow Run is kept however its sessions end',
  )
  first.shutdown('test over')
  await until('the first daemon to stop', () => exits.length === 1)
  const second = await startDaemon({ paths, registry: join(dir, 'orca-runs.jsonl'), spawnSession: fakeSession, exit: () => {}, log: () => {} })
  try {
    await second.recovered
    await spawn()
    assert.deepEqual(
      book().runs.map((r) => r.id),
      [plain.id],
      'a question none of whose sessions outlived its daemon is dropped',
    )
    assert.deepEqual(
      book().dispatches.map((d) => d.id),
      [worker],
    )
  } finally {
    second.shutdown('test over')
  }
})
