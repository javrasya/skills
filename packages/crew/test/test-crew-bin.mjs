// Offline tests for the crew bin and the package's pack step.
//   node packages/crew/test/test-crew-bin.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { crewPaths } from '../src/daemon/transport.mjs'
import { request, stopDaemon } from '../src/daemon/client.mjs'
import { runRegistry } from '../src/registry.mjs'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const CREW = join(PACKAGE, 'bin', 'crew.mjs')
// A scratch Claude dir, so a run started here is never recorded in the operator's run registry,
// and a scratch crew home, so the daemon these commands start is never the operator's.
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'crew-bin-claude-')), CREW_HOME: join(mkdtempSync(join(tmpdir(), 'crew-bin-home-')), 'home') }
after(() => stopDaemon(crewPaths(ENV), { force: true }))
const crew = (...args) => spawnSync(process.execPath, [CREW, ...args], { encoding: 'utf8', env: ENV })
// crew's config in that home: every Claude worker is the fake harness.
const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/crew/fake-harness.mjs', import.meta.url))
mkdirSync(ENV.CREW_HOME, { recursive: true })
writeFileSync(crewPaths(ENV).config, JSON.stringify({ harnesses: { claude: [process.execPath, FAKE_HARNESS] } }))

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function eventually(what, check, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

test('crew: no command, or an unknown one, is a usage error', () => {
  for (const r of [crew(), crew('launch')]) {
    assert.equal(r.status, 2)
    assert.match(r.stderr, /usage: crew run \[--host <host>\]/)
    assert.match(r.stderr, /\ndebug: crew session spawn .*\n +crew console \(the daemon's raw sessions/)
  }
})

test('crew run: one script, there, on a host crew knows', () => {
  const none = crew('run')
  assert.equal(none.status, 2)
  assert.match(none.stderr, /the rendered script is required/)
  const missing = crew('run', join(mkdtempSync(join(tmpdir(), 'crew-bin-')), 'w.js'))
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no script /)
  const bad = crew('run', '--host', 'tmux', 'w.js')
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /unknown host tmux/)
})

test('crew run --host orca: it is the runner, with the runner\'s own argv', () => {
  const r = crew('run', '--host', 'orca')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: node runner\.mjs/)
  const dir = mkdtempSync(join(tmpdir(), 'crew-bin-'))
  const script = join(dir, 'workflow.js')
  writeFileSync(script, 'return 7\n')
  const ran = crew('run', '--host', 'orca', script, '--state-dir', join(dir, 'state'))
  assert.equal(ran.status, 0, ran.stderr)
  const summary = JSON.parse(readFileSync(join(dir, 'state', 'summary.json'), 'utf8'))
  assert.equal(summary.ok, true)
  assert.equal(summary.result, 7)
})

test('crew run: on the crew host, a whole run of fake-harness agents in crew sessions, registered, ends in summary.json', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'crew-bin-run-')))
  const script = join(project, 'workflow.js')
  copyFileSync(fileURLToPath(new URL('./fixtures/crew-run/two-agents.workflow.js', import.meta.url)), script)
  const r = spawnSync(process.execPath, [CREW, 'run', 'workflow.js'], { encoding: 'utf8', env: ENV, cwd: project })
  assert.equal(r.status, 0, r.stderr)
  const [, runner] = /the runner is crew session (\S+);/.exec(r.stdout)
  const runDir = join(project, 'orca-run')
  assert.ok(r.stdout.includes(`enter it from \`crew view "${runDir}"\``), `the run console, not the debug one: ${r.stdout}`)
  const summary = await eventually('summary.json', () => existsSync(join(runDir, 'summary.json')) && JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')), 120_000)
  assert.deepEqual(summary, { runner: 'session', host: 'crew', ok: true, result: { first: 'hello', second: 'world' } }, readFileSync(join(runDir, 'runner.log'), 'utf8'))
  const { sessions } = await request(crewPaths(ENV), { op: 'session.list' })
  assert.equal(sessions.find((s) => s.id === runner)?.title, 'crew run workflow.js')
  const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const workers = lines(join(runDir, 'journal.jsonl')).filter((e) => e.type === 'started')
  assert.equal(workers.length, 2)
  for (const w of workers) assert.ok(sessions.some((s) => s.id === w.terminal && s.command.includes(FAKE_HARNESS)), `${w.title} ran in a crew session of the fake harness`)
  const rows = lines(join(ENV.CLAUDE_CONFIG_DIR, 'orca-runs.jsonl'))
  const armed = rows.find((e) => e.type === 'armed')
  assert.ok(armed, 'the run is registered')
  assert.deepEqual({ project: armed.project, runDir: armed.runDir, spec: armed.spec, script: armed.script, host: armed.host }, { project, runDir, spec: 'crew-run-fixture', script, host: 'crew' })
  assert.match(armed.runId, /^run_/)
  assert.ok(rows.some((e) => e.type === 'ended' && e.runId === armed.runId && e.outcome === 'ok'))
  assert.deepEqual(rows.filter((e) => e.type === 'runner').map((e) => [e.terminal, e.host]), [[runner, 'crew']], 'the runner is its crew session, to be entered from crew view')
  const ls = crew('ls')
  assert.equal(ls.status, 0, ls.stderr)
  assert.match(ls.stdout, new RegExp(`^  ${armed.runId} +crew +crew-run-fixture +ok +runner`, 'm'))
})

test('crew start: a spec number, and with no terminal every row\'s flag, each missing one named', async () => {
  const none = crew('start')
  assert.equal(none.status, 2)
  assert.match(none.stderr, /crew start: the spec issue number is required\nusage: crew run/)
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'crew-bin-start-')))
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  const r = spawnSync(process.execPath, [CREW, 'start', '94', '--harness', 'claude'], { encoding: 'utf8', env: ENV, cwd: repo })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /missing --model, --base, --stack-mode, --permission-mode\n/)
})

test('crew run: crew killed mid-run, stop and restart refused meanwhile; started again, it resumes the run, every lost session continued uncounted, and the run completes', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'crew-bin-crash-')))
  const script = join(project, 'workflow.js')
  copyFileSync(fileURLToPath(new URL('./fixtures/crew-run/slow-agents.workflow.js', import.meta.url)), script)
  const r = spawnSync(process.execPath, [CREW, 'run', 'workflow.js'], { encoding: 'utf8', env: ENV, cwd: project })
  assert.equal(r.status, 0, r.stderr)
  const runDir = join(project, 'orca-run')
  const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const journal = () => lines(join(runDir, 'journal.jsonl'))
  const log = () => (existsSync(join(runDir, 'runner.log')) ? readFileSync(join(runDir, 'runner.log'), 'utf8') : '')
  await eventually('both workers mid-turn', () => journal().filter((e) => e.type === 'started').length === 2, 60_000)
  const { runId } = journal().find((e) => e.type === 'run')

  for (const verb of ['stop', 'restart']) {
    const refused = crew('daemon', verb)
    assert.equal(refused.status, 1, `daemon ${verb}: ${refused.stdout}`)
    assert.ok(refused.stderr.includes(`1 run(s) live: ${runId} (crew-run-slow)`), refused.stderr)
  }

  const paths = crewPaths(ENV)
  const { pid } = await request(paths, { op: 'hello' })
  process.kill(pid, 'SIGKILL')
  await eventually('the daemon gone', () => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 20_000)
  const started = crew('daemon', 'start')
  assert.equal(started.status, 0, started.stderr)

  const summary = await eventually('summary.json', () => existsSync(join(runDir, 'summary.json')) && JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')), 120_000)
  assert.deepEqual(summary, { runner: 'session', host: 'crew', ok: true, result: { first: 'hello', second: 'world' } }, log())
  const continued = journal().filter((e) => e.type === 'continued')
  assert.deepEqual(continued.map((e) => [e.title, e.hostDied, e.attempt]).sort(), [['[Greet] first', true, 0], ['[Greet] second', true, 0]], log())
  assert.match(log(), /its session died with its session host; continuing session \S+ \(not counted against the cap\)/)
  const rows = lines(join(ENV.CLAUDE_CONFIG_DIR, 'orca-runs.jsonl')).filter((e) => e.runId === runId)
  assert.equal(rows.filter((e) => e.type === 'runner').length, 2, 'a second runner took the run up')
  assert.equal(rows.at(-1).type, 'ended')
  assert.equal(rows.at(-1).outcome, 'ok')
})

test('crew orchestration send: a worker\'s message needs its IDs and a type, and names a dispatch crew made', () => {
  const missing = crew('orchestration', 'send', '--type', 'handoff')
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /missing --task-id, --dispatch-id/)
  assert.equal(crew('orchestration', 'ask').status, 2)
  const stranger = crew('orchestration', 'send', '--task-id', 't', '--dispatch-id', 'd', '--type', 'handoff', '--subject', 's', '--body', 'b')
  assert.equal(stranger.status, 1)
  assert.match(stranger.stderr, /dispatch_not_found/)
})

test('crew ls: every run of the registry, crew\'s and Orca\'s, by project; crew view <run> needs a run the registry has, and a terminal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-bin-ls-'))
  const registry = join(dir, 'runs.jsonl')
  assert.equal(crew('ls', '--registry', registry).stdout.trim(), 'the run registry holds no run yet')
  const w = runRegistry(registry)
  w.armed({ runId: 'run_o1', project: join(dir, 'proj'), runDir: join(dir, 'o'), spec: 'implement-spec-12' })
  w.armed({ runId: 'run_c1', project: join(dir, 'proj'), runDir: join(dir, 'c'), spec: 'implement-spec-13', host: 'crew' })
  w.ended({ runId: 'run_o1', outcome: 'ok' })
  const r = crew('ls', '--registry', registry)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^proj {2}.*proj$/m)
  assert.match(r.stdout, /^ {2}run_o1 +orca +#12 +ok +runner ○ dead +0 kept/m)
  assert.match(r.stdout, /^ {2}run_c1 +crew +#13 +unfinished +runner ○ dead +0 kept/m)
  assert.equal(crew('ls', 'extra').status, 2)

  const none = crew('view', 'run_nope', '--registry', registry)
  assert.equal(none.status, 1)
  assert.match(none.stderr, /no run run_nope in the run registry/)
  for (const target of ['run_c1', join(dir, 'c')]) {
    const piped = crew('view', target, '--registry', registry)
    assert.equal(piped.status, 3, piped.stderr)
    assert.match(piped.stderr, /crew view: needs a terminal/)
  }
})

test('crew pause | resume <run>: by run id, run folder, its name or state dir; an unknown run is an error naming crew ls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-bin-pause-'))
  const registry = join(dir, 'runs.jsonl')
  const folder = join(dir, 'runs', '13-20261001-120000-ab12')
  const stateDir = join(folder, 'orca-run')
  mkdirSync(stateDir, { recursive: true })
  runRegistry(registry).armed({ runId: 'run_c1', project: join(dir, 'proj'), runDir: stateDir, spec: 'implement-spec-13', host: 'crew' })
  for (const target of ['run_c1', folder, '13-20261001-120000-ab12', stateDir]) {
    const p = crew('pause', target, '--registry', registry)
    assert.equal(p.status, 0, p.stderr)
    assert.match(p.stdout, /^paused run_c1: /)
    assert.ok(existsSync(join(stateDir, 'paused.json')))
    assert.match(crew('pause', target, '--registry', registry).stdout, /already paused/)
    assert.match(crew('ls', '--registry', registry).stdout, /^ {2}run_c1 +crew +#13 +paused /m)
    const r = crew('resume', target, '--registry', registry)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^resumed run_c1: /)
    assert.ok(!existsSync(join(stateDir, 'paused.json')))
  }
  for (const verb of ['pause', 'resume']) {
    const none = crew(verb, 'run_nope', '--registry', registry)
    assert.equal(none.status, 1)
    assert.match(none.stderr, /no run run_nope in the run registry: `crew ls` lists them/)
  }
  assert.equal(crew('pause', '--registry', registry).status, 2)
})

// crew rm waits on the runner it ends, so the test's event loop must be free
// to reap that runner: spawnSync would leave it a zombie, alive to a probe.
const crewAsync = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CREW, ...args], { env: ENV })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  child.stdin.end()
  child.once('close', (status) => resolve({ status, stdout, stderr }))
})

test('crew rm <run>: asks first, and any answer but y removes nothing; y, or --yes, ends the runner its runner.pid names, forgets the run and deletes its run folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-bin-rm-'))
  const registry = join(dir, 'runs.jsonl')
  const folder = join(dir, 'runs', '13-20261001-120000-ab12')
  const stateDir = join(folder, 'orca-run')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'journal.jsonl'), '')
  runRegistry(registry).armed({ runId: 'run_c1', project: join(dir, 'proj'), runDir: stateDir, spec: 'implement-spec-13', host: 'crew' })
  const none = crew('rm', 'run_nope', '--registry', registry)
  assert.equal(none.status, 1)
  assert.match(none.stderr, /no run run_nope in the run registry: `crew ls` lists them/)
  assert.equal(crew('rm', '--registry', registry).status, 2)
  const no = spawnSync(process.execPath, [CREW, 'rm', 'run_c1', '--registry', registry], { encoding: 'utf8', env: ENV, input: 'n\n' })
  assert.equal(no.status, 0, no.stderr)
  assert.match(no.stdout, /Remove run run_c1\? .*\[y\/N\] nothing removed/s)
  assert.ok(existsSync(folder))
  assert.match(crew('ls', '--registry', registry).stdout, /run_c1/)
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const ended = new Promise((r) => runner.once('exit', (code, signal) => r(signal)))
  writeFileSync(join(stateDir, 'runner.pid'), String(runner.pid))
  const yes = await crewAsync('rm', 'run_c1', '--yes', '--registry', registry)
  assert.equal(yes.status, 0, yes.stderr)
  assert.match(yes.stdout, /^removed run_c1$/m)
  assert.equal(await ended, 'SIGTERM')
  assert.ok(!existsSync(folder), 'its run folder is deleted')
  assert.equal(crew('ls', '--registry', registry).stdout.trim(), 'the run registry holds no run yet')
})

test('crew view: with no run, the runs list; --attached and --standalone are the run view\'s own argv', () => {
  const list = crew('view', '--registry', join(mkdtempSync(join(tmpdir(), 'crew-bin-')), 'runs.jsonl'))
  assert.equal(list.status, 3, 'no run named: the runs list, which needs a terminal')
  assert.match(list.stderr, /crew view: needs a terminal/)
  assert.equal(crew('view', 'a', 'b').status, 2)
  assert.equal(crew().status, 2, 'bare crew with no terminal: the usage')
  const alone = crew('view', '--standalone', '--registry', join(mkdtempSync(join(tmpdir(), 'crew-bin-')), 'runs.jsonl'))
  assert.equal(alone.status, 3)
  assert.match(alone.stderr, /needs a terminal/)
})

test('npm pack: the package carries the workflow template, copied from the skill folder at pack time', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: PACKAGE, encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(r.status, 0, r.stderr)
  const files = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0].files.map((f) => f.path)
  assert.ok(files.includes('workflow.template.js'), files.join('\n'))
  assert.ok(files.includes('bin/crew.mjs'))
  assert.ok(files.includes('src/runner.mjs'))
  assert.ok(files.includes('src/run-view/view.mjs'))
  assert.ok(!files.some((f) => f.startsWith('test/')))
  assert.ok(!existsSync(join(PACKAGE, 'workflow.template.js')), 'postpack removes the copy')
})
