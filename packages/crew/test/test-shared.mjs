// The helpers every module shares: args, paths, command, keys, fsutil, util.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseFlags } from '../src/args.mjs'
import { pathKey, samePath } from '../src/paths.mjs'
import { childCommand } from '../src/command.mjs'
import { ARROW_KEYS, decodeKeys } from '../src/keys.mjs'
import { writeJsonAtomic } from '../src/fsutil.mjs'
import { slug } from '../src/util.mjs'
import { piAgentDir, piDir, transcriptPath } from '../src/transcript.mjs'
import { resumedCommand } from '../src/harness.mjs'
import { crewPaths } from '../src/daemon/transport.mjs'
import { PARK_AFTER_MS, readCrewConfig } from '../src/crew-config.mjs'

test("parseFlags: values keyed by the flag, positionals apart, errors in crew's words", () => {
  const spec = { strings: ['--state-dir'], booleans: ['--resume'] }
  assert.deepEqual(parseFlags(['w.js', '--state-dir', 'd', '--resume'], spec), { values: { '--state-dir': 'd', '--resume': true }, positionals: ['w.js'] })
  assert.deepEqual(parseFlags(['--state-dir=d'], spec).values, { '--state-dir': 'd' })
  assert.throws(
    () => parseFlags(['--nope'], spec),
    (e) => e.kind === 'unexpected' && e.message === 'unexpected --nope',
  )
  assert.throws(
    () => parseFlags(['--resume=yes'], spec),
    (e) => e.kind === 'unexpected',
  )
  assert.throws(
    () => parseFlags(['--state-dir'], spec),
    (e) => e.kind === 'value' && e.message === '--state-dir needs a value',
  )
  assert.throws(() => parseFlags(['--state-dir', '--resume'], spec), /--state-dir needs a value/)
  assert.deepEqual(parseFlags(['--body', '--not-a-flag'], { strings: ['--body'], dashValues: true }).values, { '--body': '--not-a-flag' })
  assert.deepEqual(parseFlags(['--host', '--nope'], { strings: ['--host'], lenient: true }).values, { '--host': '--nope' })
  assert.equal(parseFlags(['--host'], { strings: ['--host'], lenient: true }).values['--host'], true)
})

test('samePath: one path however it is spelled, and a missing one is no path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-paths-'))
  assert.ok(samePath(dir, `${dir}/`))
  assert.ok(samePath(dir, join(dir, 'x', '..')))
  assert.ok(!samePath(dir, join(dir, 'x')))
  assert.ok(!samePath(null, dir) && !samePath(dir, undefined))
  assert.ok(samePath('C:\\Work\\Repo\\', 'c:/work/repo', 'win32') || process.platform !== 'win32')
  assert.equal(pathKey(dir), pathKey(`${dir}/`))
})

test('childCommand: a .cmd on Windows runs through ComSpec, found on Path by PATHEXT; anything else as it is', () => {
  const bin = mkdtempSync(join(tmpdir(), 'crew-cmd-'))
  writeFileSync(join(bin, 'tool.cmd'), '')
  const env = { Path: bin, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\cmd.exe' }
  assert.deepEqual(childCommand('tool', ['a'], { env, platform: 'win32' }), ['C:\\Windows\\cmd.exe', ['/d', '/c', join(bin, 'tool.cmd'), 'a']])
  assert.deepEqual(childCommand(join(bin, 'hook.bat'), [], { env: {}, platform: 'win32' }), ['cmd.exe', ['/d', '/c', join(bin, 'hook.bat')]])
  assert.deepEqual(childCommand('tool', ['a'], { env, platform: 'linux' }), ['tool', ['a']])
  assert.deepEqual(childCommand('missing', [], { env, platform: 'win32' }), ['missing', []])
})

test("decodeKeys: a table's keys, a lone Esc as cancel, an unknown sequence skipped whole", () => {
  assert.deepEqual(decodeKeys('\x1b[A\x1bOBq\x1b\x1b[24~', [...ARROW_KEYS, ['q', 'quit']]), ['up', 'down', 'quit', 'cancel'])
  assert.deepEqual(decodeKeys('ab', [], { char: (c) => ({ char: c }) }), [{ char: 'a' }, { char: 'b' }])
})

test('writeJsonAtomic: the whole value, by rename, no temp file left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-fs-'))
  writeJsonAtomic(join(dir, 'a.json'), { a: 1 })
  writeJsonAtomic(join(dir, 'a.json'), { a: 2 })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')), { a: 2 })
  assert.deepEqual(readdirSync(dir), ['a.json'])
  assert.equal(slug('a b/c:d'), 'a_b_c_d')
})

test("pi's dir: PI_CODING_AGENT_DIR moves its settings and its sessions alike", () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-pi-'))
  const env = { PI_CODING_AGENT_DIR: join(root, 'agent') }
  assert.equal(piAgentDir({ home: root, env: {} }), join(root, '.pi', 'agent'))
  assert.equal(piAgentDir({ home: root, env }), join(root, 'agent'))
  const worktree = join(root, 'wt')
  const dir = join(root, 'agent', 'sessions', piDir(worktree))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '2026-01-01_sid-1.jsonl'), '{}\n')
  assert.equal(transcriptPath({ harness: 'pi', sessionId: 'sid-1', worktree, scan: false, home: root, env }), join(dir, '2026-01-01_sid-1.jsonl'))
})

test("resumedCommand: a launched harness's own command, carrying on its session; claude swaps --session-id for --resume, pi reopens with it as it is", () => {
  const settings = ['--settings', '{"hooks":{}}']
  assert.deepEqual(resumedCommand(['claude', '--session-id', 'u-1', '--model', 'opus', ...settings]), ['claude', '--resume', 'u-1', '--model', 'opus', ...settings])
  assert.deepEqual(resumedCommand(['node', 'fake-harness.mjs', '--session-id', 'u-1']), ['node', 'fake-harness.mjs', '--resume', 'u-1'], "a harness program crew's config put in its place")
  assert.deepEqual(resumedCommand(['claude', '--resume', 'u-1']), ['claude', '--resume', 'u-1'])
  assert.deepEqual(resumedCommand(['pi', '--approve', '--session-id', 'u-1', '-e', 'ext.ts']), ['pi', '--approve', '--session-id', 'u-1', '-e', 'ext.ts'])
  assert.equal(resumedCommand(['node', 'runner.mjs']), null, 'no session to carry on')
})

test('crew config: parkAfterMs is 15 minutes unless ~/.crew/config.json names another, 0 for never; anything else is refused', () => {
  const paths = crewPaths({ CREW_HOME: mkdtempSync(join(tmpdir(), 'crew-config-')) })
  assert.equal(PARK_AFTER_MS, 15 * 60_000)
  assert.equal(readCrewConfig(paths).parkAfterMs, PARK_AFTER_MS)
  writeFileSync(paths.config, JSON.stringify({ parkAfterMs: 0 }))
  assert.equal(readCrewConfig(paths).parkAfterMs, 0)
  writeFileSync(paths.config, JSON.stringify({ parkAfterMs: 60_000 }))
  assert.equal(readCrewConfig(paths).parkAfterMs, 60_000)
  for (const bad of [-1, 1.5, '600000', null]) {
    writeFileSync(paths.config, JSON.stringify({ parkAfterMs: bad }))
    assert.throws(() => readCrewConfig(paths), /parkAfterMs: not a whole number of milliseconds/)
  }
})
