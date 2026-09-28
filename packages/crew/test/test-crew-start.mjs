// Offline tests for `crew start`: the form at a terminal, flag-only use,
// arming (resolve, render, clear the end signals, launch), and the
// orchestrator's draft of a missing validation list, played by the fake
// harness on the crew host.
//   node packages/crew/test/test-crew-start.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { crewPaths } from '../src/daemon/transport.mjs'
import { stopDaemon } from '../src/daemon/client.mjs'
import { crewHost } from '../src/crew-host.mjs'
import { OrchestratorError, orchestrator } from '../src/orchestrator.mjs'
import { execProgram } from '../src/git.mjs'
import { STACKS_DOCS, rememberedAnswers, startForm } from '../src/start-form.mjs'
import { END_SIGNALS, PLACEHOLDERS, notesDirOf, renderRoles, renderTemplate, startCommand, templatePath } from '../src/arm.mjs'
import { DEFAULTS } from '../src/crew-config.mjs'
import { loadScript } from '../src/runner.mjs'
import { drawStartForm, keysOf, runStartForm } from '../src/start-tui.mjs'

const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/crew/fake-harness.mjs', import.meta.url))
const SKILL_TEMPLATE = fileURLToPath(new URL('../../../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url))
const scratch = (name) => realpathSync(mkdtempSync(join(tmpdir(), `crew-start-${name}-`)))
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

// SKILL.md step 3 as the skill does it: each placeholder substituted in turn,
// as scripts/simulate-implement-spec-workflow.mjs renders it.
const skillRender = (template, v) => PLACEHOLDERS.reduce((s, k) => s.split(`__${k}__`).join(String(v[k])), template)

const VALUES = { SPEC: 94, REPO: 'acme/app', REPO_DIR: 'C:\\work\\app', NOTES_DIR: 'C:\\Users\\me\\.claude\\spec-notes\\app-94', BASE_REF: 'develop', STACK_MODE: 'native', VALIDATION: 'npm test\n# lint\nnpm run lint\n' }

test('render: the template with the eight values is what the skill renders, RUNNER session', () => {
  const template = readFileSync(templatePath(), 'utf8')
  assert.equal(templatePath(), SKILL_TEMPLATE, 'in a checkout the skill folder\'s template is the one rendered')
  const rendered = renderTemplate(template, { ...VALUES, RUNNER: 'session' })
  assert.equal(rendered, skillRender(template, { ...VALUES, RUNNER: 'session' }))
  assert.doesNotMatch(rendered, new RegExp(`__(${PLACEHOLDERS.join('|')})__`))
  const onWorkflow = skillRender(template, { ...VALUES, RUNNER: 'workflow' }).split('\n')
  const diff = rendered.split('\n').filter((l, i) => l !== onWorkflow[i])
  assert.equal(diff.length, 1)
  assert.match(diff[0], /^const RUNNER = 'session'/)
  assert.throws(() => renderTemplate(template, { ...VALUES }), /no value for __RUNNER__/)
})

test('render: a validation list is substituted as written, whatever it holds', () => {
  const out = renderTemplate('A=`__VALIDATION__` B=__SPEC__', { ...VALUES, RUNNER: 'session', VALIDATION: "echo $& __SPEC__ $'x'" })
  assert.equal(out, "A=`echo $& __SPEC__ $'x'` B=94")
})

test('form keys: arrows, Enter, Tab, Esc and Ctrl+C from raw input', () => {
  assert.deepEqual(keysOf('\x1b[A\x1b[B\x1b[C\x1b[D\r\t\x1b[Z'), ['up', 'down', 'right', 'left', 'enter', 'down', 'up'])
  assert.deepEqual(keysOf('\x1b'), ['cancel'])
  assert.deepEqual(keysOf('\x03'), ['cancel'])
  assert.deepEqual(keysOf('\x1b[24~x'), [], 'an unknown sequence and a letter are no key of the form\'s')
})

const FACTS = {
  repo: 'acme/app',
  branch: 'develop',
  branches: ['develop', 'main'],
  models: { claude: { last: 'opus', list: ['opus', 'sonnet'] }, pi: { last: 'lmstudio/qwen3', list: ['lmstudio/qwen3'] } },
  ghStack: { installed: true, api: 'disabled' },
}

// Raw input: the keys arrive while the form listens, as a keypress would, and
// wait while nothing does, as a terminal holds them.
class FakeStdin extends EventEmitter {
  constructor(chunks) {
    super()
    this.chunks = [...chunks]
    this.raw = []
  }
  setRawMode(on) { this.raw.push(on) }
  on(event, fn) {
    super.on(event, fn)
    if (event === 'data') {
      const next = () => {
        if (!this.listenerCount('data')) return
        const chunk = this.chunks.shift()
        if (chunk === undefined) return
        this.emit('data', chunk)
        setImmediate(next)
      }
      setImmediate(next)
    }
    return this
  }
}
const fakeStdout = () => ({ text: '', write(s) { this.text += s } })
const lastScreen = (out) => strip(out.text.split('\x1b[2J\x1b[H').pop())

test('form at a terminal: every row with its default and flag, GH Stack shown disabled with the docs link', () => {
  const lines = drawStartForm(startForm(FACTS), 0, 'crew start').map(strip)
  for (const [label, value, flag] of [['Harness', 'Claude Code', '--harness'], ['Model', 'opus', '--model'], ['Base branch', 'develop', '--base'], ['Stack mode', 'Basic Git stacking', '--stack-mode'], ['Permission mode', 'auto', '--permission-mode']]) {
    assert.ok(lines.some((l) => l.includes(label) && l.includes(value) && l.includes(flag)), `${label}: ${lines.join('\n')}`)
  }
  assert.ok(lines.some((l) => l.includes('GH Stack (unavailable): not enabled for this repo') && l.includes(STACKS_DOCS)), lines.join('\n'))
  const pi = drawStartForm(startForm(FACTS, { flags: { harness: 'pi' } }), 0).map(strip)
  assert.ok(!pi.some((l) => l.includes('Permission mode')), 'no permission mode for pi')
})

test('form at a terminal: Enter through it takes every default; arrows change a row; Esc cancels', async () => {
  const through = fakeStdout()
  const stdin = new FakeStdin(['\r', '\r', '\r', '\r', '\r'])
  assert.deepEqual(await runStartForm({ form: startForm(FACTS), stdin, stdout: through }), { harness: 'claude', model: 'opus', base: 'develop', stackMode: 'chain', permissionMode: 'auto' })
  assert.deepEqual(stdin.raw, [true, false], 'raw mode on for the form, off after')
  // Harness to pi drops the permission row: four Enters answer the form.
  const out = fakeStdout()
  const picked = await runStartForm({ form: startForm(FACTS), stdin: new FakeStdin(['\x1b[C', '\r', '\r', '\x1b[C', '\r', '\r']), stdout: out })
  assert.deepEqual(picked, { harness: 'pi', model: 'lmstudio/qwen3', base: 'main', stackMode: 'chain' })
  assert.deepEqual(await runStartForm({ form: startForm(FACTS), stdin: new FakeStdin(['\r', '\x1b']), stdout: fakeStdout() }), null)
  assert.match(lastScreen(through), /> Permission mode/)
})

// The orchestrator as `crew start` builds it, on the crew host of the scratch
// crew home, its harness the fake one, whose draft is FIXED_DRAFT.
const FIXED_DRAFT = '# package.json scripts.test\nnpm test\n# .github/workflows/ci.yml job lint\nnpm run lint\n'
const daemons = []
after(async () => {
  for (const paths of daemons) await stopDaemon(paths, { force: true }).catch(() => {})
})
const fakeOrchestrator = (home) => ({ paths, repoDir, harness, model, permissionMode }) => {
  daemons.push(paths)
  const env = { ...process.env, CREW_HOME: paths.home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PI_CODING_AGENT_SESSION_DIR: join(home, '.pi') }
  const host = crewHost({ paths, env, cwd: repoDir, harnesses: { claude: [process.execPath, FAKE_HARNESS], pi: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000 })
  return orchestrator({ host, harness, model, permissionMode, dir: join(paths.home, 'orchestrator'), pollMs: 100, idleMs: 2_000, answerMs: 60_000 })
}

// A repo on disk for git, and gh and pi answered from a table.
function world({ validation = 'npm test\n', stackInstalled = true } = {}) {
  const home = scratch('home')
  const repoDir = scratch('repo')
  const git = (...args) => execProgram('git', ['-C', repoDir, ...args])
  const paths = crewPaths({ CREW_HOME: join(home, '.crew') })
  const notesDir = notesDirOf('acme/app', 94, home)
  if (validation !== null) {
    mkdirSync(notesDir, { recursive: true })
    writeFileSync(join(notesDir, 'validation.md'), validation)
  }
  const calls = []
  const GH = {
    'repo view': { stdout: 'acme/app\n' },
    'extension list': { stdout: stackInstalled ? 'gh stack  github/gh-stack  v1\n' : '' },
    'extension install github/gh-stack': {},
    'api repos/acme/app/stacks': {},
    'issue view 94': { stdout: 'Crew, the session runner\n' },
  }
  const run = async (program, args, opts) => {
    calls.push([program, ...args].join(' '))
    if (program === 'git') return execProgram(program, args, opts)
    if (program === 'gh') {
      const hit = Object.entries(GH).find(([k]) => args.join(' ').startsWith(k))
      if (hit) return { code: 0, stdout: '', stderr: '', ...hit[1] }
    }
    return { code: null, stdout: '', stderr: `${program}: not found` }
  }
  const launches = []
  const launch = async (o) => {
    launches.push({ ...o, signals: END_SIGNALS.filter((f) => existsSync(join(notesDir, 'orca-run', f))) })
    return { id: 's7' }
  }
  const start = (argv, over = {}) => startCommand({ argv, paths, cwd: repoDir, tty: false, run, home, env: {}, launch, orchestrate: fakeOrchestrator(home), ...over })
  return { home, repoDir, paths, notesDir, calls, launches, start, ready: (async () => {
    await git('init', '-q', '-b', 'develop')
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
    await git('branch', 'main')
  })() }
}

test('crew start with no terminal: every missing flag is an error naming it, and nothing is armed', async () => {
  const w = world()
  await w.ready
  await assert.rejects(w.start(['94']), (e) => e.code === 2 && /missing --harness, --model, --base, --stack-mode, --permission-mode$/.test(e.message))
  await assert.rejects(w.start(['94', '--harness', 'claude', '--model', 'opus', '--base', 'main']), (e) => e.code === 2 && /missing --stack-mode, --permission-mode$/.test(e.message))
  await assert.rejects(w.start(['94', '--harness', 'pi', '--model', 'x/y', '--base', 'main']), (e) => /missing --stack-mode$/.test(e.message), 'pi has no permission mode to miss')
  await assert.rejects(w.start(['--harness', 'pi']), (e) => e.code === 2 && /spec issue number is required/.test(e.message))
  await assert.rejects(w.start(['94', '--base']), (e) => e.code === 2 && /--base needs a value/.test(e.message))
  assert.equal(w.launches.length, 0)
  assert.ok(!existsSync(join(w.notesDir, 'workflow.js')))
})

const FLAGS = ['--harness', 'claude', '--model', 'opus', '--base', 'main', '--stack-mode', 'chain', '--permission-mode', 'auto']

test('crew start with no terminal: a spec with no validation.md is an error, never a draft nobody confirmed', async () => {
  const w = world({ validation: null })
  await w.ready
  let asked = 0
  await assert.rejects(w.start(['94', ...FLAGS], { orchestrate: () => ({ ask: async () => asked++ }) }), (e) => e.code === 1 && e.message.includes(join(w.notesDir, 'validation.md')) && /no validation list, and with no terminal nobody can confirm/.test(e.message))
  assert.equal(asked, 0, 'the orchestrator is never asked')
  assert.equal(w.launches.length, 0)
  assert.ok(!existsSync(w.notesDir), 'nothing written')
})

test("crew start at a terminal, no validation.md: the orchestrator's draft is the form's last step; edited and confirmed, it is written and armed with", async () => {
  const w = world({ validation: null })
  await w.ready
  const out = fakeStdout()
  const keys = ['\r', '\r', '\r', '\r', '\r', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[F', '\r', 'make check', '\x13']
  const armed = await w.start(['94'], { tty: true, stdin: new FakeStdin(keys), stdout: out })
  const draft = out.text.split('\x1b[2J\x1b[H').map(strip).find((screen) => screen.includes("drafted by crew's orchestrator"))
  assert.ok(draft, out.text)
  for (const line of FIXED_DRAFT.trim().split('\n')) assert.ok(draft.includes(line), `${line} in the draft step:\n${draft}`)
  assert.ok(draft.includes(join(w.notesDir, 'validation.md')))
  assert.ok(!draft.includes('the list is empty'))
  const validation = `${FIXED_DRAFT}make check\n`
  assert.equal(readFileSync(join(w.notesDir, 'validation.md'), 'utf8'), validation)
  assert.equal(armed.target.validation, validation)
  assert.ok(readFileSync(armed.script, 'utf8').includes(validation), 'the run is armed with the confirmed list')
  assert.equal(w.launches.length, 1)
})

test('crew start at a terminal: cancelling the draft writes nothing and arms nothing; an orchestrator with no valid answer is reported, and writes nothing either', async () => {
  const w = world({ validation: null })
  await w.ready
  await assert.rejects(w.start(['94'], { tty: true, stdin: new FakeStdin(['\r', '\r', '\r', '\r', '\r', 'x', '\x1b']), stdout: fakeStdout() }), (e) => e.code === 130 && /no validation list written, nothing armed/.test(e.message))
  const failing = () => ({ ask: async () => { throw new OrchestratorError('validation-list', 'its session settled failed') } })
  await assert.rejects(w.start(['94'], { tty: true, stdin: new FakeStdin(['\r', '\r', '\r', '\r', '\r']), stdout: fakeStdout(), orchestrate: failing }), (e) => e.code === 1 && /the orchestrator gave no valid answer to validation-list: its session settled failed; no validation list written, nothing armed/.test(e.message))
  assert.equal(w.launches.length, 0)
  assert.ok(!existsSync(join(w.notesDir, 'validation.md')))
  assert.ok(!existsSync(join(w.notesDir, 'workflow.js')))
})

test('crew start at a terminal: a repo with no discoverable checks gets an empty draft, and the step says so', async () => {
  const w = world({ validation: null })
  await w.ready
  const out = fakeStdout()
  const none = () => ({ ask: async () => ({ checks: [] }) })
  const armed = await w.start(['94'], { tty: true, stdin: new FakeStdin(['\r', '\r', '\r', '\r', '\r', '\x13']), stdout: out, orchestrate: none })
  assert.match(lastScreen(out), /found no checks in this repo's CI config, workflow files, Makefile or package scripts, so the list is empty/)
  assert.equal(readFileSync(join(w.notesDir, 'validation.md'), 'utf8'), '')
  assert.equal(armed.target.validation, '')
})

test('crew start at a terminal: Enter through the form renders workflow.js, clears the last run\'s end signals, launches, remembers', async () => {
  const w = world({ validation: 'npm t\n' })
  await w.ready
  const stateDir = join(w.notesDir, 'orca-run')
  mkdirSync(stateDir, { recursive: true })
  for (const f of END_SIGNALS) writeFileSync(join(stateDir, f), '{}')
  writeFileSync(join(stateDir, 'journal.jsonl'), '')
  const out = fakeStdout()
  const armed = await w.start(['94'], { tty: true, stdin: new FakeStdin(['\r', '\r', '\r', '\r', '\r']), stdout: out })
  assert.match(lastScreen(out), /crew start: acme\/app #94: Crew, the session runner/)
  const script = join(w.notesDir, 'workflow.js')
  assert.equal(armed.script, script)
  assert.deepEqual(w.launches, [{ args: [script, '--permission-mode', 'auto'], cwd: w.repoDir, title: 'implement-spec #94: Crew, the session runner', signals: [] }])
  assert.ok(existsSync(join(stateDir, 'journal.jsonl')), 'only the end signals are cleared: the journal is what --resume replays')
  const template = readFileSync(templatePath(), 'utf8')
  assert.equal(readFileSync(script, 'utf8'), skillRender(template, { SPEC: 94, REPO: 'acme/app', REPO_DIR: w.repoDir, NOTES_DIR: w.notesDir, BASE_REF: 'develop', STACK_MODE: 'native', RUNNER: 'session', VALIDATION: 'npm t\n' }))
  assert.deepEqual(rememberedAnswers(w.paths, w.repoDir), { harness: 'claude', base: 'develop', stackMode: 'native', permissionMode: 'auto', models: { claude: 'opus' } })
  assert.ok(!w.calls.some((c) => c.startsWith('gh extension install')), 'the extension is installed only when chosen')
})

test('crew start by flags alone: pi takes no permission mode, Install and Use installs gh-stack and arms native', async () => {
  const w = world({ stackInstalled: false })
  await w.ready
  await w.start(['94', '--harness', 'pi', '--model', 'lmstudio/qwen3', '--base', 'main', '--stack-mode', 'install'])
  assert.ok(w.calls.includes('gh extension install github/gh-stack'))
  const [launch] = w.launches
  assert.deepEqual(launch.args, [join(w.notesDir, 'workflow.js')])
  const script = readFileSync(join(w.notesDir, 'workflow.js'), 'utf8')
  assert.match(script, /^const STACK_MODE = 'native'/m)
  assert.match(script, /^const BASE_REF = 'main'/m)
  assert.equal(rememberedAnswers(w.paths, w.repoDir).stackMode, 'native')
})

// The rendered script's role table as the script itself evaluates it.
const rolesOf = (script) => {
  const table = /^const RUN_DEFAULT = [^\n]*\n(?:[^\n]*\n)*?const ROLES = \{\r?\n(?:[^\n]*\n)*?\}/m.exec(script)
  assert.ok(table, 'the rendered script has its role table')
  return new Function(`${table[0]}\nreturn ROLES`)()
}
const ROLE_NAMES = Object.keys(rolesOf(readFileSync(SKILL_TEMPLATE, 'utf8')))
const CLAUDE_MODELS = DEFAULTS.claudeModels
const configRoles = (w, roles) => {
  mkdirSync(w.paths.home, { recursive: true })
  writeFileSync(w.paths.config, JSON.stringify({ repos: { [w.repoDir]: { roles } } }))
}
const armedWith = async (argv, { roles } = {}) => {
  const w = world()
  await w.ready
  if (roles) configRoles(w, roles)
  await w.start(['94', '--base', 'main', '--stack-mode', 'chain', ...argv])
  return { w, script: readFileSync(join(w.notesDir, 'workflow.js'), 'utf8') }
}

test('run default, Claude: every role row carries harness claude and the chosen model', async () => {
  const { script } = await armedWith(['--harness', 'claude', '--model', 'sonnet[1m]', '--permission-mode', 'auto'])
  const roles = rolesOf(script)
  assert.ok(ROLE_NAMES.length > 10)
  assert.deepEqual(Object.keys(roles), ROLE_NAMES)
  for (const name of ROLE_NAMES) assert.deepEqual(roles[name], { harness: 'claude', model: 'sonnet[1m]' }, name)
})

test('run default, pi: every role row carries harness pi, piModel the chosen model, and a Claude model', async () => {
  const { script } = await armedWith(['--harness', 'pi', '--model', "lmstudio/qwen3's"])
  const roles = rolesOf(script)
  for (const name of ROLE_NAMES) assert.deepEqual(roles[name], { harness: 'pi', piModel: "lmstudio/qwen3's", model: 'opus' }, name)
  assert.ok(CLAUDE_MODELS.includes(roles.impl.model))
})

test('a per-role override in crew\'s per-repo config wins for that role only', async () => {
  const { script } = await armedWith(['--harness', 'claude', '--model', 'sonnet', '--permission-mode', 'auto'], { roles: { impl: { harness: 'pi', model: 'openai/gpt-5' }, gate: { harness: 'claude', model: 'opus' } } })
  const roles = rolesOf(script)
  assert.deepEqual(roles.impl, { harness: 'pi', piModel: 'openai/gpt-5', model: 'sonnet' }, 'a pi override keeps the run default\'s Claude model')
  assert.deepEqual(roles.gate, { harness: 'claude', model: 'opus' })
  for (const name of ROLE_NAMES.filter((r) => r !== 'impl' && r !== 'gate')) assert.deepEqual(roles[name], { harness: 'claude', model: 'sonnet' }, name)
  const onPi = rolesOf((await armedWith(['--harness', 'pi', '--model', 'lmstudio/qwen3'], { roles: { review: { harness: 'claude', model: 'haiku' } } })).script)
  assert.deepEqual(onPi.review, { harness: 'claude', model: 'haiku' })
  assert.deepEqual(onPi.impl, { harness: 'pi', piModel: 'lmstudio/qwen3', model: 'opus' })
})

test('a per-role override naming no role of the template\'s is refused, and nothing is armed', async () => {
  const w = world()
  await w.ready
  configRoles(w, { implement: { harness: 'pi', model: 'x/y' } })
  await assert.rejects(w.start(['94', '--harness', 'pi', '--model', 'x/y', '--base', 'main', '--stack-mode', 'chain']), /roles: implement is no role of the workflow template's; its roles are graph, /)
  assert.equal(w.launches.length, 0)
  assert.ok(!existsSync(join(w.notesDir, 'workflow.js')))
  configRoles(w, { impl: { harness: 'codex', model: 'x' } })
  await assert.rejects(w.start(['94']), /roles\.impl: not \{ "harness": "claude" or "pi"/, 'a malformed override is refused before any form')
})

test('the rendered script still runs on the Workflow runner: only role rows differ, and every agent() call carries a Claude model', async () => {
  const template = readFileSync(SKILL_TEMPLATE, 'utf8')
  const values = { ...VALUES, RUNNER: 'workflow' }
  const plain = skillRender(template, values)
  const rendered = renderRoles(renderTemplate(template, values), { runDefault: { harness: 'pi', model: 'lmstudio/qwen3' }, roles: { impl: { harness: 'claude', model: 'sonnet' } } })
  const [before, after] = [plain, rendered].map((s) => s.split('\n'))
  const changed = after.filter((l, i) => l !== before[i])
  assert.equal(after.length, before.length)
  assert.equal(changed.length, 2)
  assert.match(changed[0], /^const RUN_DEFAULT = \{ harness: 'pi', piModel: 'lmstudio\/qwen3', model: 'opus' \}\r?$/)
  assert.match(changed[1], /^ {2}impl: \{ harness: 'claude', model: 'sonnet' \},/)
  // The Workflow runner reads only `model`: the first call is made, with one.
  const calls = []
  const stop = new Error('stop')
  const agent = async (prompt, opts) => {
    calls.push(opts)
    throw stop
  }
  await assert.rejects(loadScript(rendered)(agent, async (fns) => Promise.all(fns.map((f) => f())), () => {}, () => {}, {}), (e) => e === stop)
  assert.equal(calls.length, 1)
  assert.ok(CLAUDE_MODELS.includes(calls[0].model), calls[0].model)
  assert.equal(calls[0].harness, 'pi')
})
