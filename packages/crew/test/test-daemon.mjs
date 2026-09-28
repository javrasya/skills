// Offline tests for the crew daemon: its start on demand, stop and restart,
// and a session it holds with nobody entered. Real daemons on real pipes or
// sockets, each under a scratch crew home, and real ptys.
//   node packages/crew/test/test-daemon.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import net from 'net'
import { fileURLToPath } from 'url'
import { crewPaths, lineDecoder } from '../src/daemon/transport.mjs'
import { daemonHello, request, stopDaemon } from '../src/daemon/client.mjs'
import { startDaemon } from '../src/daemon/daemon.mjs'
import { resolveCommand } from '../src/daemon/session.mjs'
import { runRegistry } from '../src/registry.mjs'
import { crewHost } from '../src/crew-host.mjs'
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
    socket.on('data', lineDecoder((m) => replies.push(m)))
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

// A stand-in for a pty session: its program runs until killed.
function fakeSession({ id, command, cwd, env, title = null }) {
  let exit = null
  const exits = new Set()
  return {
    id, env,
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
    assert.deepEqual(await show(lost), { settled: false, outcome: null, gone: true, exited: false, waiting: null, terminal: lost, hostDied: true })
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

// The run list asks nothing of crew until R: with the daemon down, its R is the
// call that starts the daemon, whose recovery starts the run's runner. The run
// still gets one runner, and R tells why it started none.
test('daemon: R on a run whose runner died with the daemon, starting the daemon, leaves the run one runner, the recovered one', async () => {
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
    // The recovered runner has not written its runner.pid yet: R still starts none.
    assert.match((await runs.resume(run.id)).message, new RegExp(`run_live: .* has its runner already, in crew session ${recovered.id}`))
    assert.equal((await runners()).length, 1)
    // Once it ends, R starts the run's runner, and the next R, from another list, none.
    await request(paths, { op: 'session.kill', id: recovered.id })
    const resumed = await runs.resume(run.id)
    assert.ok(resumed.resumed, resumed.message)
    const other = view()
    await other.refresh()
    assert.match((await other.resume(run.id)).message, new RegExp(`has its runner already, in crew session ${resumed.resumed}`))
    assert.deepEqual((await runners()).map((s) => s.id), [resumed.resumed])
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
  assert.deepEqual(book().runs.map((r) => r.id), [pending.run, plain.id], 'the closed question is dropped')
  assert.ok(!book().dispatches.some((d) => d.id === answered.session), 'its dispatch with it')
  await request(paths, { op: 'session.close', id: worker })
  assert.deepEqual(book().runs.map((r) => r.id), [pending.run, plain.id], 'a workflow Run is kept however its sessions end')
  first.shutdown('test over')
  await until('the first daemon to stop', () => exits.length === 1)
  const second = await startDaemon({ paths, registry: join(dir, 'orca-runs.jsonl'), spawnSession: fakeSession, exit: () => {}, log: () => {} })
  try {
    await second.recovered
    await spawn()
    assert.deepEqual(book().runs.map((r) => r.id), [plain.id], 'a question none of whose sessions outlived its daemon is dropped')
    assert.deepEqual(book().dispatches.map((d) => d.id), [worker])
  } finally {
    second.shutdown('test over')
  }
})
