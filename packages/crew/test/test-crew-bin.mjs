// Offline tests for the crew bin and the package's pack step.
//   node packages/crew/test/test-crew-bin.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
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
  const summary = await eventually('summary.json', () => existsSync(join(runDir, 'summary.json')) && JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')), 120_000)
  assert.deepEqual(summary, { runner: 'orca', ok: true, result: { first: 'hello', second: 'world' } }, readFileSync(join(runDir, 'runner.log'), 'utf8'))
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

test('crew view: it is the run view, with the view\'s own argv', () => {
  assert.equal(crew('view').status, 2)
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
