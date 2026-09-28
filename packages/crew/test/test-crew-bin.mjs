// Offline tests for the crew bin and the package's pack step.
//   node packages/crew/test/test-crew-bin.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { crewPaths } from '../src/daemon/transport.mjs'
import { stopDaemon } from '../src/daemon/client.mjs'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const CREW = join(PACKAGE, 'bin', 'crew.mjs')
// A scratch Claude dir, so a run started here is never recorded in the operator's run registry,
// and a scratch crew home, so the daemon these commands start is never the operator's.
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'crew-bin-claude-')), CREW_HOME: join(mkdtempSync(join(tmpdir(), 'crew-bin-home-')), 'home') }
after(() => stopDaemon(crewPaths(ENV), { force: true }))
const crew = (...args) => spawnSync(process.execPath, [CREW, ...args], { encoding: 'utf8', env: ENV })

test('crew: no command, or an unknown one, is a usage error', () => {
  for (const r of [crew(), crew('launch')]) {
    assert.equal(r.status, 2)
    assert.match(r.stderr, /usage: crew run --host <host>/)
  }
})

test('crew run: the host is required, and must be one crew knows', () => {
  assert.match(crew('run', 'w.js').stderr, /--host is required/)
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

test('crew orchestration send: a worker\'s message needs its IDs and a type, and names a dispatch crew made', () => {
  const missing = crew('orchestration', 'send', '--type', 'handoff')
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /missing --task-id, --dispatch-id/)
  assert.equal(crew('orchestration', 'ask').status, 2)
  const stranger = crew('orchestration', 'send', '--task-id', 't', '--dispatch-id', 'd', '--type', 'handoff', '--subject', 's', '--body', 'b')
  assert.equal(stranger.status, 1)
  assert.match(stranger.stderr, /dispatch_not_found/)
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
