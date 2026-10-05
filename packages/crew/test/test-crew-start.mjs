// Offline tests for `crew start`: the form at a terminal, flag-only use,
// arming (resolve, render into a run folder of its own, launch), and the
// check that every ready-for-agent ticket carries its validation recipe.
//   node packages/crew/test/test-crew-start.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crewPaths } from '../src/daemon/transport.mjs'
import { request, stopDaemon } from '../src/daemon/client.mjs'
import { crewHost, waitWords } from '../src/crew-host.mjs'
import { execProgram } from '../src/git.mjs'
import { STACKS_DOCS, rememberAnswers, rememberedAnswers, startForm } from '../src/start-form.mjs'
import { preflight } from '../src/headless.mjs'
import { PLACEHOLDERS, hasValidationRecipe, launchRunner, newRunId, notesDirOf, renderRoles, renderTemplate, startCommand, templatePath } from '../src/arm.mjs'
import { launchCommand } from '../src/harness.mjs'
import { DEFAULTS } from '../src/crew-config.mjs'
import { loadScript } from '../src/runner.mjs'
import { WINDOW, drawStartForm, keysOf, runStartForm } from '../src/start-tui.mjs'

const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/crew/fake-harness.mjs', import.meta.url))
const SKILL_TEMPLATE = fileURLToPath(new URL('../../../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url))
const scratch = (name) => realpathSync(mkdtempSync(join(tmpdir(), `crew-start-${name}-`)))
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

// SKILL.md step 3 as the skill does it: each placeholder substituted in turn,
// as scripts/simulate-implement-spec-workflow.mjs renders it.
const skillRender = (template, v) => PLACEHOLDERS.reduce((s, k) => s.split(`__${k}__`).join(String(v[k])), template)

const VALUES = { SPEC: 94, REPO: 'acme/app', REPO_DIR: 'C:\\work\\app', NOTES_DIR: 'C:\\Users\\me\\.claude\\spec-notes\\app-94', BASE_REF: 'develop', START_REF: 'develop', STACK_MODE: 'native', RUN_ORDER: 'parallel' }

test('render: the template with the nine values is what the skill renders, RUNNER session', () => {
  assert.deepEqual(PLACEHOLDERS, ['SPEC', 'REPO', 'REPO_DIR', 'NOTES_DIR', 'BASE_REF', 'START_REF', 'STACK_MODE', 'RUN_ORDER', 'RUNNER'])
  const template = readFileSync(templatePath(), 'utf8')
  assert.doesNotMatch(template, /__VALIDATION__|VALIDATION_RAW|\bVALIDATION\b/)
  assert.equal(templatePath(), SKILL_TEMPLATE, "in a checkout the skill folder's template is the one rendered")
  const rendered = renderTemplate(template, { ...VALUES, RUNNER: 'session' })
  assert.equal(rendered, skillRender(template, { ...VALUES, RUNNER: 'session' }))
  assert.doesNotMatch(rendered, new RegExp(`__(${PLACEHOLDERS.join('|')})__`))
  const onWorkflow = skillRender(template, { ...VALUES, RUNNER: 'workflow' }).split('\n')
  const diff = rendered.split('\n').filter((l, i) => l !== onWorkflow[i])
  assert.equal(diff.length, 1)
  assert.match(diff[0], /^const RUNNER = 'session'/)
  assert.throws(() => renderTemplate(template, { ...VALUES }), /no value for __RUNNER__/)
})

test('render: a value is substituted as written, whatever it holds', () => {
  const out = renderTemplate('A=`__REPO_DIR__` B=__SPEC__', { ...VALUES, RUNNER: 'session', REPO_DIR: "C:\\x $& __SPEC__ $'x'" })
  assert.equal(out, "A=`C:\\x $& __SPEC__ $'x'` B=94")
})

test('form keys: arrows, Enter, Tab, Esc and Ctrl+C from raw input', () => {
  assert.deepEqual(keysOf('\x1b[A\x1b[B\x1b[C\x1b[D\r\t\x1b[Z'), ['up', 'down', 'right', 'left', 'enter', 'down', 'up'])
  assert.deepEqual(keysOf('\x1b'), ['cancel'])
  assert.deepEqual(keysOf('\x03'), ['interrupt'])
  assert.deepEqual(keysOf('\x1b[24~'), [], "an unknown sequence is no key of the form's")
  assert.deepEqual(keysOf('op\x7f'), [{ char: 'o' }, { char: 'p' }, 'backspace'], 'a letter is typed into the search')
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
  setRawMode(on) {
    this.raw.push(on)
  }
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
const fakeStdout = () => ({
  text: '',
  write(s) {
    this.text += s
  },
})
const lastScreen = (out) => strip(out.text.split('\x1b[2J\x1b[H').pop())

test('form at a terminal: every row with its default and flag, GH Stack shown disabled with the docs link', () => {
  const lines = drawStartForm(startForm(FACTS), 0, 'crew start').map(strip)
  for (const [label, value, flag] of [
    ['Harness', 'Claude Code', '--harness'],
    ['Model', 'opus', '--model'],
    ['Base branch', 'develop', '--base'],
    ['Prior work', 'None \u2014 the stack starts on develop', '--start-ref'],
    ['Stack mode', 'Basic Git stacking', '--stack-mode'],
    ['Run order', 'Parallel', '--run-order'],
    ['Permission mode', 'auto', '--permission-mode'],
  ]) {
    assert.ok(
      lines.some((l) => l.includes(label) && l.includes(value) && l.includes(flag)),
      `${label}: ${lines.join('\n')}`,
    )
  }
  assert.ok(
    lines.some((l) => l.includes('GH Stack (unavailable): not enabled for this repo') && l.includes(STACKS_DOCS)),
    lines.join('\n'),
  )
  const pi = drawStartForm(startForm(FACTS, { flags: { harness: 'pi' } }), 0).map(strip)
  assert.ok(!pi.some((l) => l.includes('Permission mode')), 'no permission mode for pi')
})

test('form at a terminal: Enter through it takes every default; arrows change a row; Esc cancels', async () => {
  const through = fakeStdout()
  const stdin = new FakeStdin(['\r', '\r', '\r', '\r', '\r', '\r', '\r'])
  assert.deepEqual(await runStartForm({ form: startForm(FACTS), stdin, stdout: through }), { harness: 'claude', model: 'opus', base: 'develop', startRef: 'develop', stackMode: 'chain', runOrder: 'parallel', permissionMode: 'auto' })
  assert.deepEqual(stdin.raw, [true, false], 'raw mode on for the form, off after')
  // Harness to pi drops the permission row: six Enters answer the form, Sequential picked on the way, prior work left at none.
  const out = fakeStdout()
  const picked = await runStartForm({ form: startForm(FACTS), stdin: new FakeStdin(['\x1b[C', '\r', '\r', '\x1b[C', '\r', '\r', '\r', '\x1b[C', '\r']), stdout: out })
  assert.deepEqual(picked, { harness: 'pi', model: 'lmstudio/qwen3', base: 'main', startRef: 'main', stackMode: 'chain', runOrder: 'sequential' })
  assert.deepEqual(await runStartForm({ form: startForm(FACTS), stdin: new FakeStdin(['\r', '\x1b']), stdout: fakeStdout() }), null)
  assert.match(lastScreen(through), /› Permission mode/)
})

const MANY = { ...FACTS, models: { ...FACTS.models, pi: { last: 'm000', list: Array.from({ length: 120 }, (_, i) => `m${String(i).padStart(3, '0')}`).concat(['lmstudio/qwen3-coder']) } } }

test('form at a terminal: a focused row lists at most WINDOW options, saying how many more', () => {
  const lines = drawStartForm(startForm(MANY, { flags: { harness: 'pi' } }), 1).map(strip)
  assert.equal(lines.filter((l) => /^\s+(●\s)?m\d{3}$/.test(l.trimEnd())).length, WINDOW, lines.join('\n'))
  assert.ok(
    lines.some((l) => l.includes(`↓ ${121 - WINDOW} more`)),
    lines.join('\n'),
  )
  const other = drawStartForm(startForm(MANY, { flags: { harness: 'pi' } }), 0).map(strip)
  assert.ok(!other.some((l) => /m05\d/.test(l)), 'an unfocused row lists none of its options')
})

test('form at a terminal: typing searches the focused row, Left/Right step through the matches, Esc clears the search before it cancels', async () => {
  const form = () => startForm(MANY, { flags: { harness: 'pi' } })
  const out = fakeStdout()
  // Down to Model, type "qwen": the only match is picked.
  assert.equal((await runStartForm({ form: form(), stdin: new FakeStdin(['\x1b[B', 'qwen', '\r', '\r', '\r', '\r', '\r']), stdout: out })).model, 'lmstudio/qwen3-coder')
  assert.match(lastScreen(out), /Stack mode/)
  // "m11" matches m110..m119; Right steps to the second, Left wraps back past the first.
  assert.equal((await runStartForm({ form: form(), stdin: new FakeStdin(['\x1b[B', 'm11', '\x1b[C', '\r', '\r', '\r', '\r', '\r']), stdout: fakeStdout() })).model, 'm111')
  assert.equal((await runStartForm({ form: form(), stdin: new FakeStdin(['\x1b[B', 'm11', '\x1b[D', '\r', '\r', '\r', '\r', '\r']), stdout: fakeStdout() })).model, 'm119')
  // Backspace widens; a query matching nothing keeps the value.
  const screen = fakeStdout()
  assert.equal((await runStartForm({ form: form(), stdin: new FakeStdin(['\x1b[B', 'zzz', '\r', '\r', '\r', '\r', '\r']), stdout: screen })).model, 'm000')
  // Esc with a query only clears it; the second one cancels.
  assert.equal((await runStartForm({ form: form(), stdin: new FakeStdin(['\x1b[B', 'qwen', '\x1b', '\r', '\r', '\r', '\r', '\r']), stdout: fakeStdout() })).model, 'lmstudio/qwen3-coder')
  assert.equal(await runStartForm({ form: form(), stdin: new FakeStdin(['\x1b[B', 'q', '\x1b', '\x1b']), stdout: fakeStdout() }), null)
  assert.equal(await runStartForm({ form: form(), stdin: new FakeStdin(['\x1b[B', 'q', '\x03']), stdout: fakeStdout() }), null, 'Ctrl+C cancels at once')
})

const daemons = []
after(async () => {
  for (const paths of daemons) await stopDaemon(paths, { force: true }).catch(() => {})
})
// The preflight as `crew start` runs it, on the fake harness.
const fakeCheck = ({ repoDir, harness, model }) => preflight({ harness, model, cwd: repoDir, program: [process.execPath, FAKE_HARNESS] })

// A ticket body as preflight leaves it, and one it never touched.
const RECIPE = '## What to build\n\nIt.\n\n## Validation\n\n### Run per change\n- Tests: `npm test`\n\n### Run at review\n- Tests: `npm test`\n'
const BARE = '## What to build\n\nIt.\n\n## Acceptance criteria\n\n- [ ] it\n'
const ticket = (number, body, label = 'ready-for-agent', state = 'open') => ({ number, title: `Ticket ${number}`, state, body, labels: [label] })
const TICKETS = [ticket(101, RECIPE), ticket(102, RECIPE)]

// A repo on disk for git, and gh and pi answered from a table. `tickets` are
// the spec's sub-issues, null for gh failing to list them; `validation`, when given, a validation.md left in
// the notes dir from before ADR-0029.
function world({ tickets = TICKETS, validation = null, stackInstalled = true } = {}) {
  const home = scratch('home')
  const repoDir = scratch('repo')
  const git = (...args) => execProgram('git', ['-C', repoDir, ...args])
  const paths = crewPaths({ CREW_HOME: join(home, '.crew') })
  const notesDir = notesDirOf('acme/app', 94, home)
  mkdirSync(notesDir, { recursive: true })
  if (validation !== null) writeFileSync(join(notesDir, 'validation.md'), validation)
  const calls = []
  const GH = {
    'repo view': { stdout: 'acme/app\n' },
    'extension list': { stdout: stackInstalled ? 'gh stack  github/gh-stack  v1\n' : '' },
    'extension install github/gh-stack': {},
    'api repos/acme/app/stacks': {},
    'api repos/acme/app/issues/94/sub_issues': tickets ? { stdout: tickets.map((t) => `${JSON.stringify(t)}\n`).join('') } : { code: 1, stderr: 'HTTP 404\n' },
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
    launches.push(o)
    return { id: 's7' }
  }
  const warnings = []
  // Each start's own run id, in order: r1, r2, …
  let armed = 0
  const start = (argv, over = {}) => startCommand({ argv, paths, cwd: repoDir, tty: false, run, home, env: {}, launch, check: fakeCheck, newRunId: (spec) => `${spec}-r${++armed}`, warn: (line) => warnings.push(line), ...over })
  return {
    home,
    repoDir,
    paths,
    notesDir,
    calls,
    launches,
    warnings,
    start,
    ready: (async () => {
      await git('init', '-q', '-b', 'develop')
      await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
      await git('branch', 'main')
    })(),
  }
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
  assert.ok(!existsSync(join(w.notesDir, 'runs')))
})

const FLAGS = ['--harness', 'claude', '--model', 'opus', '--base', 'main', '--stack-mode', 'chain', '--run-order', 'parallel', '--permission-mode', 'auto']

test('crew start: the harness is checked on the answered model, in the checkout, before anything is armed; one that cannot run there arms nothing', async () => {
  const w = world()
  await w.ready
  const checked = []
  const refused = async (c) => {
    checked.push(c)
    throw new Error('claude answered with an error: Invalid API key · Please run /login')
  }
  await assert.rejects(w.start(['94'], { tty: true, stdin: new FakeStdin(['\r', '\r', '\r', '\r', '\r', '\r', '\r']), stdout: fakeStdout(), check: refused }), (e) => e.code === 1 && /^claude on \S+ cannot run here: claude answered with an error: Invalid API key · Please run \/login; nothing armed$/.test(e.message))
  assert.deepEqual([checked[0].repoDir, checked[0].harness, typeof checked[0].model], [w.repoDir, 'claude', 'string'])
  assert.equal(w.launches.length, 0)
  assert.ok(!existsSync(join(w.notesDir, 'runs')))
})

test('validation recipe: a ## Validation heading whose section holds ### Run per change, by heading alone', () => {
  assert.equal(hasValidationRecipe(RECIPE), true)
  assert.equal(hasValidationRecipe(RECIPE.replace(/\n/g, '\r\n')), true, 'CRLF bodies too')
  assert.equal(hasValidationRecipe('## Validation\n\n### Run per change\n'), true, 'an empty recipe is still the headings; what it says is preflight’s')
  assert.equal(hasValidationRecipe(BARE), false)
  assert.equal(hasValidationRecipe(null), false)
  assert.equal(hasValidationRecipe('## Validation\n\n- Tests: `npm test`\n'), false, 'the flat list of before, no subsection')
  assert.equal(hasValidationRecipe('## Validation\n\n### Run at review\n- `npm test`\n'), false, 'only the review half')
  assert.equal(hasValidationRecipe('## Validation\n\nSee below.\n\n## Notes\n\n### Run per change\n'), false, 'the subsection under another section')
  assert.equal(hasValidationRecipe('### Run per change\n\n## Validation\n'), false, 'the subsection before the section')
  assert.equal(hasValidationRecipe('## Validation recipe\n\n### Run per change\n'), false, 'another heading')
})

const REFUSED = [ticket(101, RECIPE), ticket(102, BARE), ticket(103, BARE, 'ready-for-human')]
const refusesTicket102 = (e) => e.code === 1 && /ticket #102 \(Ticket 102\) has no "## Validation" section holding "### Run per change"; run preflight/.test(e.message) && /nothing armed$/.test(e.message) && !/#101|#103/.test(e.message)

test('crew start with no terminal: a ready-for-agent ticket without the headings is refused by number, telling to run preflight; ready-for-human ones are not checked; nothing armed', async () => {
  const w = world({ tickets: REFUSED })
  await w.ready
  let checked = 0
  await assert.rejects(w.start(['94', ...FLAGS], { check: async () => checked++ }), refusesTicket102)
  assert.equal(checked, 0, 'refused before the harness is run')
  assert.equal(w.launches.length, 0)
  assert.ok(!existsSync(join(w.notesDir, 'runs')))
  assert.deepEqual(rememberedAnswers(w.paths, w.repoDir), {}, 'nothing remembered')
})

test('crew start at a terminal: a ready-for-agent ticket without the headings is refused before the form is drawn; nothing armed', async () => {
  const w = world({ tickets: REFUSED })
  await w.ready
  const out = fakeStdout()
  await assert.rejects(w.start(['94'], { tty: true, stdin: new FakeStdin(['\r', '\r', '\r', '\r', '\r', '\r', '\r']), stdout: out }), refusesTicket102)
  assert.equal(out.text, '', 'nothing rendered')
  assert.equal(w.launches.length, 0)
  assert.ok(!existsSync(join(w.notesDir, 'runs')))
})

test('crew start: every ticket without the headings is named; a spec whose tickets cannot be read is refused', async () => {
  const w = world({ tickets: [ticket(101, BARE), ticket(102, '## Validation\n\n- `npm test`\n')] })
  await w.ready
  await assert.rejects(w.start(['94', ...FLAGS]), (e) => e.code === 1 && /tickets #101 \(Ticket 101\), #102 \(Ticket 102\) have no "## Validation" section/.test(e.message))
  const unread = world({ tickets: null })
  await unread.ready
  await assert.rejects(unread.start(['94', ...FLAGS]), /cannot read spec #94's tickets: HTTP 404/)
  assert.equal(unread.launches.length, 0)
})

test('crew start: a closed ready-for-agent ticket without the headings does not block the start; no run would take it', async () => {
  const w = world({ tickets: [ticket(101, RECIPE), ticket(102, BARE, 'ready-for-agent', 'closed')] })
  await w.ready
  await w.start(['94', ...FLAGS])
  assert.equal(w.launches.length, 1)
})

test('crew start by flags alone: tickets that all carry the headings arm headless, with no validation list anywhere and no orchestrator', async () => {
  const w = world()
  await w.ready
  let checked = 0
  const armed = await w.start(['94', ...FLAGS], { check: async (c) => (checked++, fakeCheck(c)) })
  assert.equal(w.launches.length, 1)
  assert.equal(checked, 1, 'the harness runs once, as the preflight, and for nothing else')
  assert.ok(w.calls.includes(`gh api repos/acme/app/issues/94/sub_issues?per_page=100 --paginate --jq .[] | {number, title, state, body, labels: [.labels[].name]} | @json`), w.calls.join('\n'))
  assert.ok(!existsSync(join(w.notesDir, 'validation.md')))
  assert.ok(!existsSync(join(armed.script, '..', 'validation.md')))
  assert.deepEqual(Object.keys(armed.target).sort(), ['notesDir', 'repo', 'repoDir', 'spec', 'title'])
  assert.deepEqual(w.warnings, [])
})

test('crew start: a validation.md left in the notes dir is ignored, said in one warning line; arming proceeds', async () => {
  const w = world({ validation: 'npm test\n' })
  await w.ready
  await w.start(['94', ...FLAGS])
  assert.equal(w.warnings.length, 1)
  assert.match(w.warnings[0], /^crew start: ignoring \S*validation\.md: validation recipes live on the tickets/)
  assert.doesNotMatch(w.warnings[0], /\n/)
  assert.equal(w.launches.length, 1)
})

test('crew start at a terminal: Enter through the form renders workflow.js into a run folder of its own, launches, remembers', async () => {
  const w = world()
  await w.ready
  const out = fakeStdout()
  const armed = await w.start(['94'], { tty: true, stdin: new FakeStdin(['\r', '\r', '\r', '\r', '\r', '\r', '\r']), stdout: out })
  assert.match(lastScreen(out), /crew start: acme\/app #94: Crew, the session runner/)
  const runDir = join(w.notesDir, 'runs', '94-r1')
  const script = join(runDir, 'workflow.js')
  const stateDir = join(runDir, 'orca-run')
  assert.equal(armed.script, script)
  assert.deepEqual(w.launches, [{ script, stateDir, permissionMode: 'auto', cwd: w.repoDir, title: 'implement-spec #94: Crew, the session runner' }])
  const template = readFileSync(templatePath(), 'utf8')
  assert.equal(readFileSync(script, 'utf8'), skillRender(template, { SPEC: 94, REPO: 'acme/app', REPO_DIR: w.repoDir, NOTES_DIR: runDir, BASE_REF: 'develop', START_REF: 'develop', STACK_MODE: 'native', RUN_ORDER: 'parallel', RUNNER: 'session' }))
  assert.deepEqual(rememberedAnswers(w.paths, w.repoDir), { harness: 'claude', base: 'develop', stackMode: 'native', runOrder: 'parallel', permissionMode: 'auto', models: { claude: 'opus' } }, 'prior work is never remembered')
  assert.ok(!w.calls.some((c) => c.startsWith('gh extension install')), 'the extension is installed only when chosen')
})

test('crew start by flags alone: pi takes no permission mode, Install and Use installs gh-stack and arms native, --run-order sequential is rendered and remembered', async () => {
  const w = world({ stackInstalled: false })
  await w.ready
  await w.start(['94', '--harness', 'pi', '--model', 'lmstudio/qwen3', '--base', 'main', '--stack-mode', 'install', '--run-order', 'sequential'])
  assert.ok(w.calls.includes('gh extension install github/gh-stack'))
  const [launch] = w.launches
  assert.deepEqual([launch.script, launch.permissionMode], [join(w.notesDir, 'runs', '94-r1', 'workflow.js'), null])
  const script = readFileSync(launch.script, 'utf8')
  assert.match(script, /^const STACK_MODE = 'native'/m)
  assert.match(script, /^const BASE_REF = 'main'/m)
  assert.match(script, /^const RUN_ORDER = 'sequential'/m)
  assert.equal(rememberedAnswers(w.paths, w.repoDir).stackMode, 'native')
  assert.equal(rememberedAnswers(w.paths, w.repoDir).runOrder, 'sequential')
})

test('crew start by flags alone without --run-order: the run is parallel, as before Run order existed, even where sequential was remembered', async () => {
  const w = world()
  await w.ready
  rememberAnswers(w.paths, w.repoDir, { harness: 'claude', model: 'opus', base: 'main', stackMode: 'chain', runOrder: 'sequential', permissionMode: 'auto' })
  await w.start(['94', '--harness', 'claude', '--model', 'opus', '--base', 'main', '--stack-mode', 'chain', '--permission-mode', 'auto'])
  assert.equal(w.launches.length, 1)
  assert.match(readFileSync(w.launches[0].script, 'utf8'), /^const RUN_ORDER = 'parallel'/m)
  assert.equal(rememberedAnswers(w.paths, w.repoDir).runOrder, 'parallel')
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
  await w.start(['94', '--base', 'main', '--stack-mode', 'chain', '--run-order', 'parallel', ...argv])
  return { w, script: readFileSync(w.launches[0].script, 'utf8') }
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

test("a per-role override in crew's per-repo config wins for that role only", async () => {
  const { script } = await armedWith(['--harness', 'claude', '--model', 'sonnet', '--permission-mode', 'auto'], { roles: { impl: { harness: 'pi', model: 'openai/gpt-5' }, gate: { harness: 'claude', model: 'opus' } } })
  const roles = rolesOf(script)
  assert.deepEqual(roles.impl, { harness: 'pi', piModel: 'openai/gpt-5', model: 'sonnet' }, "a pi override keeps the run default's Claude model")
  assert.deepEqual(roles.gate, { harness: 'claude', model: 'opus' })
  for (const name of ROLE_NAMES.filter((r) => r !== 'impl' && r !== 'gate')) assert.deepEqual(roles[name], { harness: 'claude', model: 'sonnet' }, name)
  const onPi = rolesOf((await armedWith(['--harness', 'pi', '--model', 'lmstudio/qwen3'], { roles: { review: { harness: 'claude', model: 'haiku' } } })).script)
  assert.deepEqual(onPi.review, { harness: 'claude', model: 'haiku' })
  assert.deepEqual(onPi.impl, { harness: 'pi', piModel: 'lmstudio/qwen3', model: 'opus' })
})

test("a per-role override naming no role of the template's is refused, and nothing is armed", async () => {
  const w = world()
  await w.ready
  configRoles(w, { implement: { harness: 'pi', model: 'x/y' } })
  await assert.rejects(w.start(['94', '--harness', 'pi', '--model', 'x/y', '--base', 'main', '--stack-mode', 'chain', '--run-order', 'parallel']), /roles: implement is no role of the workflow template's; its roles are graph, /)
  assert.equal(w.launches.length, 0)
  assert.ok(!existsSync(join(w.notesDir, 'runs')))
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
  await assert.rejects(
    loadScript(rendered)(
      agent,
      async (fns) => Promise.all(fns.map((f) => f())),
      () => {},
      () => {},
      {},
    ),
    (e) => e === stop,
  )
  assert.equal(calls.length, 1)
  assert.ok(CLAUDE_MODELS.includes(calls[0].model), calls[0].model)
  assert.equal(calls[0].harness, 'pi')
})

test('crew start arms with a [1m] model, and a worker starts on it: the crew host spawns the word as it is, and a shell line quotes it', async () => {
  const { w, script } = await armedWith(['--harness', 'claude', '--model', 'sonnet[1m]', '--permission-mode', 'auto'])
  const { impl } = rolesOf(script)
  assert.deepEqual(impl, { harness: 'claude', model: 'sonnet[1m]' })
  daemons.push(w.paths)
  const env = { ...process.env, CREW_HOME: w.paths.home, CLAUDE_CONFIG_DIR: join(w.home, '.claude') }
  const host = crewHost({ paths: w.paths, env, cwd: w.repoDir, harnesses: { claude: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000 })
  const { runId } = await host.runCreate({ objective: 'spec 94' })
  const sessionId = randomUUID()
  const started = await host.workerStart({ run: runId, prompt: 'hello', title: 'impl', ...impl, permissionMode: 'auto', sessionId })
  const { sessions } = await request(w.paths, { op: 'session.list' })
  const worker = sessions.find((s) => s.id === started.terminal)
  assert.deepEqual(worker.command.slice(2, -waitWords('claude').length), ['--session-id', sessionId, '--permission-mode', 'auto', '--model', 'sonnet[1m]'])
  assert.equal(launchCommand({ ...impl, sessionId }), `claude --session-id ${sessionId} --model 'sonnet[1m]'`, 'a host that types it into a shell quotes it')
})

// A runner.pid naming a live process: this test's own.
const liveRunner = (stateDir) => {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  writeFileSync(join(stateDir, 'halted.json'), '{}')
}

test('crew start never shares a run: each start arms a new run in its own folder, and leaves an earlier one, live or not, exactly as it was', async () => {
  const w = world()
  await w.ready
  const first = await w.start(['94', ...FLAGS])
  const firstState = join(w.notesDir, 'runs', '94-r1', 'orca-run')
  liveRunner(firstState)
  const written = readFileSync(first.script, 'utf8')
  const second = await w.start(['94', ...FLAGS])
  assert.equal(second.script, join(w.notesDir, 'runs', '94-r2', 'workflow.js'))
  assert.deepEqual(
    w.launches.map((l) => l.stateDir),
    [firstState, join(w.notesDir, 'runs', '94-r2', 'orca-run')],
  )
  assert.equal(readFileSync(first.script, 'utf8'), written)
  assert.equal(readFileSync(join(firstState, 'runner.pid'), 'utf8'), String(process.pid))
  assert.ok(existsSync(join(firstState, 'halted.json')))
})

test('a run id is its spec number and a part of its own, so two runs of one spec are told apart', () => {
  const at = new Date('2026-10-01T17:20:31Z')
  assert.match(newRunId(827, at), /^827-20261001-172031-[0-9a-f]{4}$/)
})

test('crew start whose drawn id names a run folder that exists already draws another, and arms a folder of its own', async () => {
  const w = world()
  await w.ready
  const first = await w.start(['94', ...FLAGS], { newRunId: () => '94-same' })
  const written = readFileSync(first.script, 'utf8')
  const ids = ['94-same', '94-other']
  const second = await w.start(['94', ...FLAGS], { newRunId: () => ids.shift() })
  assert.equal(second.script, join(w.notesDir, 'runs', '94-other', 'workflow.js'))
  assert.equal(readFileSync(first.script, 'utf8'), written)
  assert.equal(w.launches.length, 2)
})

test('crew start whose run folder exists already refuses, and leaves that run exactly as it was', async () => {
  const w = world()
  await w.ready
  const first = await w.start(['94', ...FLAGS], { newRunId: () => '94-same' })
  liveRunner(join(w.notesDir, 'runs', '94-same', 'orca-run'))
  const written = readFileSync(first.script, 'utf8')
  await assert.rejects(w.start(['94', ...FLAGS, '--run-order', 'sequential'], { newRunId: () => '94-same' }), /run folder .*94-same exists already: another run's, left as it is; nothing armed/)
  assert.equal(w.launches.length, 1)
  assert.equal(readFileSync(first.script, 'utf8'), written)
  assert.equal(readFileSync(join(w.notesDir, 'runs', '94-same', 'orca-run', 'runner.pid'), 'utf8'), String(process.pid))
})

test('crew run --resume on a state dir whose runner is alive: the daemon refuses a second runner, run_live, and leaves the state dir as it was', async () => {
  const w = world()
  await w.ready
  daemons.push(w.paths)
  const script = join(w.notesDir, 'workflow.js')
  writeFileSync(script, '')
  const stateDir = join(w.notesDir, 'orca-run')
  liveRunner(stateDir)
  await assert.rejects(launchRunner({ paths: w.paths, script, resume: true, cwd: w.repoDir, title: 'crew run workflow.js' }), /run_live: .* has its runner already, pid \d+/)
  const { sessions } = await request(w.paths, { op: 'session.list' })
  assert.equal(sessions.length, 0, 'no runner session started')
  assert.equal(readFileSync(join(stateDir, 'runner.pid'), 'utf8'), String(process.pid))
  assert.ok(existsSync(join(stateDir, 'halted.json')))
})

test("crew start in a linked worktree: crew's per-repo config and remembered answers are the main checkout's; the run is armed in the worktree", async () => {
  const w = world()
  await w.ready
  configRoles(w, { impl: { harness: 'pi', model: 'openai/gpt-5' } })
  const worktree = join(scratch('wt'), 'app-wt')
  const add = await execProgram('git', ['-C', w.repoDir, 'worktree', 'add', '-q', '-b', 'wt', worktree])
  assert.equal(add.code, 0, add.stderr)
  const armed = await w.start(['94', '--harness', 'claude', '--model', 'sonnet', '--base', 'main', '--stack-mode', 'chain', '--run-order', 'parallel', '--permission-mode', 'auto'], { cwd: worktree })
  const roles = rolesOf(readFileSync(armed.script, 'utf8'))
  assert.deepEqual(roles.impl, { harness: 'pi', piModel: 'openai/gpt-5', model: 'sonnet' }, 'the override keyed by the main checkout holds from its worktree')
  assert.equal(armed.target.repoDir, realpathSync(worktree))
  assert.equal(w.launches[0].cwd, realpathSync(worktree))
  assert.equal(rememberedAnswers(w.paths, w.repoDir).base, 'main', 'remembered for the repo, by its main checkout')
  assert.deepEqual(rememberedAnswers(w.paths, worktree), {})
})
