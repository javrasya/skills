// Offline tests for the `crew start` form model: defaults, remembered
// answers, the GH Stack states, the pi and Claude difference, flag-only use.
//   node packages/crew/test/test-start-form.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crewPaths } from '../src/daemon/transport.mjs'
import { DEFAULTS } from '../src/crew-config.mjs'
import { piModels } from '../src/harness.mjs'
import {
  STACKS_DOCS,
  flagsToAnswers,
  probeStart,
  rememberAnswers,
  rememberedAnswers,
  settleStackMode,
  stackOptions,
  startForm,
} from '../src/start-form.mjs'

const scratch = (name) => mkdtempSync(join(tmpdir(), `crew-start-${name}-`))

const FACTS = {
  repo: 'acme/app',
  branch: 'develop',
  branches: ['develop', 'main', 'feature/x'],
  models: {
    claude: { last: 'opus[1m]', list: ['opus[1m]', 'opus', 'sonnet', 'haiku', 'sonnet[1m]'] },
    pi: { last: 'lmstudio/qwen3', list: ['lmstudio/qwen3', 'anthropic/claude-opus-4-6'] },
  },
  ghStack: { installed: true, api: 'enabled' },
}
const facts = (over = {}) => ({ ...FACTS, ...over })
const row = (form, name) => form.rows().find((r) => r.row === name)
const ALL_FLAGS = { harness: 'claude', model: 'sonnet', base: 'main', stackMode: 'chain', permissionMode: 'acceptEdits' }

// A program runner that answers from a table keyed by "program arg…" and
// records every call.
function fakeRun(table) {
  const calls = []
  const run = async (program, args) => {
    const line = [program, ...args].join(' ')
    calls.push(line)
    const hit = Object.entries(table).find(([k]) => line.startsWith(k))
    return hit ? { stdout: '', stderr: '', code: 0, ...hit[1] } : { code: null, stdout: '', stderr: `${program}: not found` }
  }
  return Object.assign(run, { calls })
}

test('start form: every row has its default, Claude first', () => {
  const form = startForm(facts())
  assert.deepEqual(form.answers(), { harness: 'claude', model: 'opus[1m]', base: 'develop', stackMode: 'native', permissionMode: 'auto' })
  assert.deepEqual(form.rows().map((r) => [r.row, r.flag]), [
    ['harness', '--harness'], ['model', '--model'], ['base', '--base'], ['stackMode', '--stack-mode'], ['permissionMode', '--permission-mode'],
  ])
  assert.deepEqual(row(form, 'harness').options.map((o) => o.label), ['Claude Code', 'pi'])
  assert.deepEqual(row(form, 'base').options.map((o) => o.value), ['develop', 'main', 'feature/x'])
})

test('start form: Claude cycles through the static list plus its last-used model', () => {
  assert.deepEqual(DEFAULTS.claudeModels, ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'])
  const form = startForm(facts({ models: { ...FACTS.models, claude: { last: 'claude-opus-4-6', list: ['claude-opus-4-6', ...DEFAULTS.claudeModels] } } }))
  assert.equal(form.answers().model, 'claude-opus-4-6')
  assert.deepEqual(row(form, 'model').options.map((o) => o.value), ['claude-opus-4-6', ...DEFAULTS.claudeModels])
  assert.equal(form.cycle('model').answers().model, 'opus')
  assert.equal(form.cycle('model', -1).cycle('model', -1).answers().model, 'sonnet[1m]')
})

test('start form: no last-used model falls to the first in the list', () => {
  const form = startForm(facts({ models: { ...FACTS.models, claude: { last: null, list: ['opus', 'sonnet'] } } }))
  assert.equal(form.answers().model, 'opus')
})

test('start form: permission mode is shown for Claude and hidden for pi', () => {
  const form = startForm(facts())
  assert.ok(row(form, 'permissionMode'))
  assert.deepEqual(row(form, 'permissionMode').options.map((o) => o.value), ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'default'])
  form.set('harness', 'pi')
  assert.equal(row(form, 'permissionMode'), undefined)
  assert.deepEqual(form.answers(), { harness: 'pi', model: 'lmstudio/qwen3', base: 'develop', stackMode: 'native' })
  assert.deepEqual(row(form, 'model').options.map((o) => o.value), ['lmstudio/qwen3', 'anthropic/claude-opus-4-6'])
  assert.throws(() => form.set('permissionMode', 'auto'), /--permission-mode: pi has no permission mode/)
  assert.deepEqual(form.missingFlags({}), ['--harness', '--model', '--base', '--stack-mode'])
  form.cycle('harness')
  assert.equal(form.answers().permissionMode, 'auto')
  assert.equal(form.answers().model, 'opus[1m]')
})

test('stack mode: GH Stack when the extension is in and the stacks API answers', () => {
  const opts = stackOptions({ installed: true, api: 'enabled' })
  assert.deepEqual(opts.map((o) => [o.value, o.label, o.disabled]), [['native', 'GH Stack', false], ['chain', 'Basic Git stacking', false]])
  assert.equal(startForm(facts()).answers().stackMode, 'native')
})

test('stack mode: Install and Use GH Stack when the extension is missing, never the default', () => {
  const f = facts({ ghStack: { installed: false, api: 'enabled' } })
  const opts = stackOptions(f.ghStack)
  assert.deepEqual(opts.map((o) => [o.value, o.label, o.disabled]), [['install', 'Install and Use GH Stack', false], ['chain', 'Basic Git stacking', false]])
  const form = startForm(f)
  assert.equal(form.answers().stackMode, 'chain')
  assert.equal(form.cycle('stackMode').answers().stackMode, 'install')
})

test('stack mode: GH Stack shown disabled on a 404, with the docs link, whether or not the extension is in', () => {
  for (const installed of [true, false]) {
    const f = facts({ ghStack: { installed, api: 'disabled' } })
    const [native, chain] = stackOptions(f.ghStack)
    assert.equal(native.value, 'native')
    assert.equal(native.disabled, true)
    assert.match(native.note, /not enabled for this repo/)
    assert.ok(native.note.includes(STACKS_DOCS))
    assert.equal(chain.value, 'chain')
    const form = startForm(f)
    assert.equal(form.answers().stackMode, 'chain')
    assert.equal(form.cycle('stackMode').answers().stackMode, 'chain', 'cycling skips the disabled option')
    assert.throws(() => form.set('stackMode', 'native'), /--stack-mode: GH Stack cannot be used, not enabled for this repo/)
    assert.throws(() => startForm(f, { flags: { stackMode: 'native' } }), /--stack-mode: GH Stack cannot be used/)
  }
})

test('stack mode: a stacks API that does not answer disables GH Stack with gh\'s words', () => {
  const [native] = stackOptions({ installed: true, api: 'unknown', detail: 'HTTP 502' })
  assert.equal(native.disabled, true)
  assert.match(native.note, /did not answer: HTTP 502/)
})

test('stack mode: with the extension missing and a stacks API that does not answer, GH Stack is disabled with gh\'s words, never Install and Use', () => {
  const opts = stackOptions({ installed: false, api: 'unknown', detail: 'HTTP 502' })
  assert.deepEqual(opts.map((o) => [o.value, o.disabled]), [['native', true], ['chain', false]])
  assert.match(opts[0].note, /did not answer: HTTP 502/)
  const f = facts({ ghStack: { installed: false, api: 'unknown', detail: 'HTTP 502' } })
  assert.equal(startForm(f).answers().stackMode, 'chain')
  assert.throws(() => startForm(f, { flags: { stackMode: 'install' } }), /--stack-mode: install is not one of chain/)
})

test('stack mode: only the Install and Use answer installs the extension', async () => {
  for (const stackMode of ['native', 'chain']) {
    const run = fakeRun({})
    assert.equal(await settleStackMode({ stackMode }, run), stackMode)
    assert.deepEqual(run.calls, [])
  }
  const run = fakeRun({ 'gh extension install': {} })
  assert.equal(await settleStackMode({ stackMode: 'install' }, run), 'native')
  assert.deepEqual(run.calls, ['gh extension install github/gh-stack'])
  const failing = fakeRun({ 'gh extension install': { code: 1, stderr: 'no network' } })
  await assert.rejects(settleStackMode({ stackMode: 'install' }, failing), /gh extension install github\/gh-stack: no network/)
})

test('remembered answers: kept per repo, and they pre-fill the next form over the harness defaults', () => {
  const paths = crewPaths({ CREW_HOME: join(scratch('home'), 'crew') })
  const repo = join(scratch('repo'), 'app')
  const other = join(scratch('repo'), 'other')
  assert.deepEqual(rememberedAnswers(paths, repo), {})
  rememberAnswers(paths, repo, { harness: 'claude', model: 'sonnet', base: 'main', stackMode: 'chain', permissionMode: 'bypassPermissions' })
  rememberAnswers(paths, other, { harness: 'pi', model: 'anthropic/claude-opus-4-6', base: 'develop', stackMode: 'native' })

  const form = startForm(facts(), { remembered: rememberedAnswers(paths, repo) })
  assert.deepEqual(form.answers(), { harness: 'claude', model: 'sonnet', base: 'main', stackMode: 'chain', permissionMode: 'bypassPermissions' })
  assert.deepEqual(startForm(facts(), { remembered: rememberedAnswers(paths, other) }).answers(), { harness: 'pi', model: 'anthropic/claude-opus-4-6', base: 'develop', stackMode: 'native' })

  // A model is remembered per harness; pi's answers leave Claude's permission mode be.
  rememberAnswers(paths, repo, { harness: 'pi', model: 'anthropic/claude-opus-4-6', base: 'main', stackMode: 'chain' })
  const again = startForm(facts(), { remembered: rememberedAnswers(paths, repo) })
  assert.equal(again.answers().model, 'anthropic/claude-opus-4-6')
  again.set('harness', 'claude')
  assert.deepEqual(again.answers(), { harness: 'claude', model: 'sonnet', base: 'main', stackMode: 'chain', permissionMode: 'bypassPermissions' })
})

test('remembered answers: a repo path is one repo however it is spelled on Windows', { skip: process.platform !== 'win32' }, () => {
  const paths = crewPaths({ CREW_HOME: join(scratch('home'), 'crew') })
  const repo = join(scratch('repo'), 'App')
  rememberAnswers(paths, repo, { harness: 'claude', model: 'haiku', base: 'main', stackMode: 'chain', permissionMode: 'auto' })
  assert.equal(rememberedAnswers(paths, repo.toLowerCase().replace(/\\/g, '/')).models.claude, 'haiku')
})

test('remembered answers the facts no longer allow fall back to the defaults', () => {
  const remembered = { harness: 'claude', models: { claude: 'opus' }, base: 'gone', stackMode: 'native', permissionMode: 'nonsense' }
  const form = startForm(facts({ ghStack: { installed: true, api: 'disabled' } }), { remembered })
  assert.deepEqual(form.answers(), { harness: 'claude', model: 'opus', base: 'develop', stackMode: 'chain', permissionMode: 'auto' })
  // Install and Use, remembered from before the extension went in, is GH Stack now.
  assert.equal(startForm(facts(), { remembered: { stackMode: 'install' } }).answers().stackMode, 'native')
})

test('remembered answers: an unreadable answer file only loses the pre-fill', () => {
  const paths = crewPaths({ CREW_HOME: join(scratch('home'), 'crew') })
  mkdirSync(paths.home, { recursive: true })
  writeFileSync(join(paths.home, 'start.json'), '{nope')
  assert.deepEqual(rememberedAnswers(paths, 'C:/repo'), {})
})

test('remembered answers: a repo entry that is not an object only loses the pre-fill', () => {
  const paths = crewPaths({ CREW_HOME: join(scratch('home'), 'crew') })
  const repo = join(scratch('repo'), 'app')
  mkdirSync(paths.home, { recursive: true })
  for (const entry of [null, 'claude', ['claude'], 7]) {
    writeFileSync(join(paths.home, 'start.json'), JSON.stringify({ [repo]: entry }))
    assert.deepEqual(rememberedAnswers(paths, repo), {}, JSON.stringify(entry))
    assert.deepEqual(startForm(facts(), { remembered: rememberedAnswers(paths, repo) }).answers(), { harness: 'claude', model: 'opus[1m]', base: 'develop', stackMode: 'native', permissionMode: 'auto' })
  }
  // Answering the form again replaces the bad entry.
  rememberAnswers(paths, repo, { harness: 'claude', model: 'haiku', base: 'main', stackMode: 'chain', permissionMode: 'auto' })
  assert.deepEqual(rememberedAnswers(paths, repo), { harness: 'claude', base: 'main', stackMode: 'chain', permissionMode: 'auto', models: { claude: 'haiku' } })
})

test('flags: each row has one, and flag-only use answers the whole form', () => {
  const { answers, rest } = flagsToAnswers(['94', '--harness', 'claude', '--model', 'sonnet', '--base', 'main', '--stack-mode', 'chain', '--permission-mode', 'acceptEdits'])
  assert.deepEqual(answers, ALL_FLAGS)
  assert.deepEqual(rest, ['94'])
  const form = startForm(facts(), { flags: answers, remembered: { harness: 'pi', base: 'feature/x' } })
  assert.deepEqual(form.answers(), ALL_FLAGS)
  assert.deepEqual(form.missingFlags(), [])
})

test('flags: a flag beats the remembered answer, and every missing one is named', () => {
  const form = startForm(facts(), { flags: { base: 'feature/x' }, remembered: { base: 'main' } })
  assert.equal(form.answers().base, 'feature/x')
  assert.deepEqual(form.missingFlags(), ['--harness', '--model', '--stack-mode', '--permission-mode'])
  assert.deepEqual(startForm(facts(), { flags: { harness: 'pi' } }).missingFlags(), ['--model', '--base', '--stack-mode'])
})

test('flags: a value the form does not allow is an error naming the flag', () => {
  assert.throws(() => flagsToAnswers(['--model']), /--model needs a value/)
  assert.throws(() => flagsToAnswers(['--base', '--harness', 'pi']), /--base needs a value/)
  assert.throws(() => startForm(facts(), { flags: { harness: 'codex' } }), /--harness: codex is not one of claude, pi/)
  assert.throws(() => startForm(facts(), { flags: { base: 'nope' } }), /--base: no branch nope/)
  assert.throws(() => startForm(facts(), { flags: { stackMode: 'install' } }), /--stack-mode: install is not one of native, chain/)
  assert.throws(() => startForm(facts(), { flags: { permissionMode: 'yolo' } }), /--permission-mode: yolo is not one of auto/)
  assert.throws(() => startForm(facts(), { flags: { harness: 'pi', permissionMode: 'auto' } }), /--permission-mode: pi has no permission mode/)
  // Any model a harness takes can be named, listed or not.
  assert.equal(startForm(facts(), { flags: { model: 'claude-haiku-4-5' } }).answers().model, 'claude-haiku-4-5')
})

test('probeStart: the facts from git, gh, pi and each harness\'s settings', async () => {
  const home = scratch('userhome')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet[1m]' }))
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  writeFileSync(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'lmstudio', defaultModel: 'qwen/qwen3.8-27b' }))
  const paths = crewPaths({ CREW_HOME: join(scratch('home'), 'crew') })
  const table = (stacks) => ({
    'git -C /r branch --show-current': { stdout: 'develop\n' },
    'git -C /r for-each-ref': { stdout: 'refs/heads/develop\nrefs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/remotes/origin/release\n' },
    'gh repo view': { stdout: 'acme/app\n' },
    'gh extension list': { stdout: 'gh stack\tgithub/gh-stack\tv0.3.0\n' },
    'gh api repos/acme/app/stacks': stacks,
    'pi --list-models': { stdout: 'provider   model   context\nanthropic  claude-opus-4-6  1M\nlmstudio   qwen/qwen3.8-27b  32K\n' },
  })
  const f = await probeStart({ cwd: '/r', paths, home, env: {}, run: fakeRun(table({})) })
  assert.deepEqual(f, {
    repo: 'acme/app',
    branch: 'develop',
    branches: ['develop', 'main', 'release'],
    models: {
      claude: { last: 'sonnet[1m]', list: ['sonnet[1m]', 'opus', 'sonnet', 'haiku', 'opus[1m]'] },
      pi: { last: 'lmstudio/qwen/qwen3.8-27b', list: ['lmstudio/qwen/qwen3.8-27b', 'anthropic/claude-opus-4-6'] },
    },
    ghStack: { installed: true, api: 'enabled' },
  })
  const disabled = await probeStart({ cwd: '/r', paths, home, env: {}, run: fakeRun(table({ code: 1, stderr: 'gh: Not Found (HTTP 404)' })) })
  assert.deepEqual(disabled.ghStack, { installed: true, api: 'disabled' })
  const down = await probeStart({ cwd: '/r', paths, home, env: {}, run: fakeRun(table({ code: 1, stderr: 'HTTP 502' })) })
  assert.deepEqual(down.ghStack, { installed: true, api: 'unknown', detail: 'HTTP 502' })
})

test('probeStart: no pi, no gh-stack, no settings still makes a form', async () => {
  const run = fakeRun({
    'git -C /r branch --show-current': { stdout: '\n' },
    'git -C /r for-each-ref': { stdout: 'refs/heads/main\n' },
    'gh repo view': { stdout: 'acme/app\n' },
    'gh extension list': { stdout: '' },
    'gh api repos/acme/app/stacks': {},
  })
  const f = await probeStart({ cwd: '/r', paths: crewPaths({ CREW_HOME: join(scratch('home'), 'crew') }), home: scratch('userhome'), env: {}, run })
  assert.deepEqual(f.models, { claude: { last: null, list: DEFAULTS.claudeModels }, pi: { last: null, list: [] } })
  assert.deepEqual(f.ghStack, { installed: false, api: 'enabled' })
  assert.equal(f.branch, null)
  assert.deepEqual(startForm(f).answers(), { harness: 'claude', model: 'opus', base: 'main', stackMode: 'chain', permissionMode: 'auto' })
  assert.ok(!run.calls.some((c) => c.startsWith('gh extension install')), 'probing never installs')
})

test('pi models: on Windows pi is found on Path as a shell finds it, and a pi.cmd shim is run through ComSpec', async () => {
  const list = { stdout: 'provider   model   context\nanthropic  claude-opus-4-6  1M\n' }
  const bin = mkdtempSync(join(tmpdir(), 'crew-pi-'))
  writeFileSync(join(bin, 'pi.cmd'), '@echo off\n')
  const env = { Path: bin, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\cmd.exe' }
  const shim = fakeRun({ [`C:\\Windows\\cmd.exe /d /c ${join(bin, 'pi.cmd')} --list-models`]: list })
  assert.deepEqual(await piModels(shim, { platform: 'win32', env }), ['anthropic/claude-opus-4-6'])
  assert.deepEqual(shim.calls, [`C:\\Windows\\cmd.exe /d /c ${join(bin, 'pi.cmd')} --list-models`], 'asked once, through the shell, by its path')
  // A pi.exe is run as it is; elsewhere pi is run by its name.
  writeFileSync(join(bin, 'pi.exe'), '')
  const exe = fakeRun({ [`${join(bin, 'pi.exe')} --list-models`]: list })
  assert.deepEqual(await piModels(exe, { platform: 'win32', env }), ['anthropic/claude-opus-4-6'])
  assert.deepEqual(exe.calls, [`${join(bin, 'pi.exe')} --list-models`])
  const linux = fakeRun({ 'pi --list-models': list })
  assert.deepEqual(await piModels(linux, { platform: 'linux', env }), ['anthropic/claude-opus-4-6'])
  assert.deepEqual(linux.calls, ['pi --list-models'])
  // No pi on Path: asked by its name, once, and it cannot say.
  const none = fakeRun({})
  assert.deepEqual(await piModels(none, { platform: 'win32', env: { Path: '' } }), [])
  assert.deepEqual(none.calls, ['pi --list-models'])
})

test('crew config: claudeModels replaces the static Claude list, and must be model names', async () => {
  const paths = crewPaths({ CREW_HOME: join(scratch('home'), 'crew') })
  mkdirSync(paths.home, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ claudeModels: ['opus', 'claude-opus-4-6'] }))
  const run = fakeRun({ 'git -C /r branch --show-current': { stdout: 'main\n' }, 'git -C /r for-each-ref': { stdout: 'refs/heads/main\n' } })
  const f = await probeStart({ cwd: '/r', paths, home: scratch('userhome'), env: {}, run })
  assert.deepEqual(f.models.claude.list, ['opus', 'claude-opus-4-6'])
  writeFileSync(paths.config, JSON.stringify({ claudeModels: 'opus' }))
  await assert.rejects(probeStart({ cwd: '/r', paths, home: scratch('userhome'), env: {}, run }), /claudeModels: not a list of model names/)
})
