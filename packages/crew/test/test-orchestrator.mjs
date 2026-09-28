// Offline tests for the orchestrator (#102): a question with a schema, its
// answer validated or reported, its sessions out of every run's graph, and
// the validation-list draft, on a stand-in host and on the crew host running
// the fake harness.
//   node packages/crew/test/test-orchestrator.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { OrchestratorError, consultSession, draftValidation, isOrchestratorTitle, orchestrator, validationText } from '../src/orchestrator.mjs'
import { runView, runsView } from '../src/run-view-model.mjs'
import { TRIAGE_STALE_MS, readTriage, triageHalt } from '../src/triage.mjs'
import { runDefaultOf, runOrchestrator } from '../src/arm.mjs'
import { runRegistry } from '../src/registry.mjs'
import { draw, haltPanel, strip } from '../src/run-view/draw.mjs'
import { crewHost } from '../src/crew-host.mjs'
import { crewPaths } from '../src/daemon/transport.mjs'
import { request, stopDaemon } from '../src/daemon/client.mjs'

const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/crew/fake-harness.mjs', import.meta.url))
const scratch = (name) => realpathSync(mkdtempSync(join(tmpdir(), `crew-orch-${name}-`)))
const SCHEMA = { type: 'object', required: ['n'], additionalProperties: false, properties: { n: { type: 'integer' } } }

// A host whose one worker is played by `play({ start, resultPath, state })`:
// it writes the result file as submit would, and sets the state workerShow
// reports ({ settled, outcome, exited, gone }) and whether it is idle.
function standIn(play = () => {}) {
  const calls = []
  let state = { settled: false, outcome: null, gone: false, exited: false, idle: false }
  const host = {
    async runCreate({ objective }) {
      calls.push(['runCreate', objective])
      return { runId: 'run_o1', terminal: 'coord' }
    },
    async workerStart(start) {
      calls.push(['workerStart', start])
      const resultPath = /--result "([^"]+)"/.exec(start.prompt)[1]
      await play({ start, resultPath, state, set: (s) => { state = { ...state, ...s } } })
      return { dispatchId: 'd1', terminal: 't1', taskId: 'task1', worktree: null, warnings: [] }
    },
    async workerShow() {
      return state
    },
    async terminalIdle() {
      return state.idle
    },
    async terminalSend({ text }) {
      calls.push(['terminalSend', text])
    },
    async workerStop() {
      calls.push(['workerStop'])
    },
    async terminalClose() {
      calls.push(['terminalClose'])
    },
  }
  return { host, calls }
}
const ask = (host, over = {}) => orchestrator({ host, harness: 'pi', model: 'lm/qwen', dir: scratch('files'), pollMs: 1, idleMs: 20, endMs: 5, ...over })
const submitted = (value, outcome = 'succeeded') => ({ resultPath, set }) => {
  writeFileSync(resultPath, JSON.stringify(value))
  set({ settled: true, outcome })
}

test('ask: a fresh session on the given harness and model, titled orchestrator/<question>, prompted to submit against the schema; a valid answer is returned and the session closed', async () => {
  const { host, calls } = standIn(submitted({ n: 7 }))
  assert.deepEqual(await ask(host).ask({ name: 'count', prompt: 'How many?', schema: SCHEMA }), { n: 7 })
  const [, start] = calls.find(([c]) => c === 'workerStart')
  assert.equal(start.title, 'orchestrator/count')
  assert.ok(isOrchestratorTitle(start.title))
  assert.deepEqual([start.harness, start.model, start.child], ['pi', 'lm/qwen', undefined])
  assert.match(start.sessionId, /^[0-9a-f-]{36}$/)
  assert.match(start.prompt, /^How many\?/)
  const schemaPath = /--schema "([^"]+)"/.exec(start.prompt)[1]
  assert.deepEqual(JSON.parse(readFileSync(schemaPath, 'utf8')), SCHEMA)
  assert.match(start.prompt, /submit\.mjs" --schema/)
  assert.deepEqual(calls.map(([c]) => c), ['runCreate', 'workerStart', 'workerStop', 'terminalClose'])
  assert.equal(calls[0][1], 'orchestrator/count')
})

test('ask: every answer short of a valid one is an OrchestratorError naming why, and the session is closed all the same', async () => {
  const cases = [
    [submitted({ n: 'seven' }), /recorded result fails its schema: \$\.n: expected integer, got string/],
    [submitted({ n: 7 }, 'failed'), /its session settled failed/],
    [({ set }) => set({ settled: true, outcome: 'succeeded' }), /settled without submitting a result/],
    [({ set }) => set({ exited: true }), /its session ended without submitting an answer/],
    [({ set }) => set({ gone: true }), /its session ended without submitting an answer/],
  ]
  for (const [play, reason] of cases) {
    const { host, calls } = standIn(play)
    await assert.rejects(ask(host).ask({ name: 'count', prompt: 'How many?', schema: SCHEMA }), (e) => e instanceof OrchestratorError && reason.test(e.message) && /^the orchestrator gave no valid answer to count: /.test(e.message))
    assert.deepEqual(calls.slice(-2).map(([c]) => c), ['workerStop', 'terminalClose'])
  }
})

test('ask: an orchestrator idle without an answer is nudged once, then given up on; one that answers after the nudge is heard', async () => {
  const idle = standIn(({ set }) => set({ idle: true }))
  await assert.rejects(ask(idle.host).ask({ name: 'q', prompt: 'p', schema: SCHEMA }), /went idle without submitting an answer, after a nudge/)
  assert.equal(idle.calls.filter(([c]) => c === 'terminalSend').length, 1)
  assert.match(idle.calls.find(([c]) => c === 'terminalSend')[1], /run the submit command/i)
  const late = standIn(({ set }) => set({ idle: true }))
  late.host.terminalSend = async () => {
    late.calls.push(['terminalSend'])
    const resultPath = /--result "([^"]+)"/.exec(late.calls.find(([c]) => c === 'workerStart')[1].prompt)[1]
    writeFileSync(resultPath, JSON.stringify({ n: 1 }))
    const show = late.host.workerShow
    late.host.workerShow = async () => ({ ...(await show()), settled: true, outcome: 'succeeded' })
  }
  assert.deepEqual(await ask(late.host).ask({ name: 'q', prompt: 'p', schema: SCHEMA }), { n: 1 })
})

test('ask: a session that never starts, or a question with no answer bound, is reported', async () => {
  const { host } = standIn()
  host.workerStart = async () => {
    throw new Error('crew: agent_not_ready')
  }
  await assert.rejects(ask(host).ask({ name: 'q', prompt: 'p', schema: SCHEMA }), /its session did not start: crew: agent_not_ready/)
  const slow = standIn()
  await assert.rejects(ask(slow.host, { answerMs: 30, idleMs: 1e9 }).ask({ name: 'q', prompt: 'p', schema: SCHEMA }), /no answer within 0 min/)
  await assert.rejects(ask(slow.host).ask({ name: 'q', prompt: 'p', schema: { type: 'string' } }), /schema needs \{type: "object", properties\}/)
})

test('draft: the checks as validation.md, each under its source; none is an empty list, said to be empty; a command of two lines is no answer', async () => {
  assert.equal(validationText({ checks: [{ command: 'npm test', source: 'package.json' }, { command: ' make lint ', source: 'Makefile\nlint' }] }), '# package.json\nnpm test\n# Makefile lint\nmake lint\n')
  const none = standIn(submitted({ checks: [] }))
  assert.deepEqual(await draftValidation(ask(none.host), { repoDir: 'C:/repo' }), { text: '', empty: true })
  const prompt = none.calls.find(([c]) => c === 'workerStart')[1].prompt
  assert.match(prompt, /repo at C:\/repo/)
  assert.match(prompt, /Never read source files/)
  assert.match(prompt, /empty checks list/)
  const twoLines = standIn(submitted({ checks: [{ command: 'a\nb', source: 's' }] }))
  await assert.rejects(draftValidation(ask(twoLines.host), { repoDir: 'C:/repo' }), (e) => e instanceof OrchestratorError && /not one line/.test(e.message))
  const invalid = standIn(submitted({ checks: [{ command: 'npm test' }] }))
  await assert.rejects(draftValidation(ask(invalid.host), { repoDir: 'C:/repo' }), /missing required property "source"/)
})

test("draft: a command the workflow's String.raw list cannot hold (backtick, ${, trailing backslash) is no answer; a source holding one is only a comment, so it is cleaned", async () => {
  for (const [command, why] of [['echo `date`', /holds a backtick/], ['npm test -- --shard=${{ matrix.shard }}', /holds \$\{/], ['make \\', /ends in a backslash/]]) {
    const bad = standIn(submitted({ checks: [{ command: 'npm test', source: 'package.json' }, { command, source: 'ci.yml' }] }))
    await assert.rejects(draftValidation(ask(bad.host), { repoDir: 'C:/repo' }), (e) => e instanceof OrchestratorError && why.test(e.message) && e.message.includes(JSON.stringify(command)), command)
  }
  assert.equal(validationText({ checks: [{ command: 'npm test', source: 'ci.yml `test` ${{ matrix.os }} \\' }] }), "# ci.yml 'test' $ {{ matrix.os }}\nnpm test\n")
  const prompt = standIn(submitted({ checks: [] }))
  await draftValidation(ask(prompt.host), { repoDir: 'C:/repo' })
  assert.match(prompt.calls.find(([c]) => c === 'workerStart')[1].prompt, /resolve every CI expression \(a GitHub Actions \$\{\{ matrix\.x \}\}.*no command holding a backtick, a \$\{ or a trailing backslash/)
})

test("graph: a journal naming an orchestrator session shows no row for it, in any phase", async () => {
  const stateDir = scratch('run')
  const started = (n, title) => ({ type: 'started', n, title, at: new Date(0).toISOString(), run: 'run_1', dispatchId: `ctx_${n}`, harness: 'claude', sessionId: `sid-${n}`, worktree: null, terminal: `term_${n}` })
  writeFileSync(join(stateDir, 'journal.jsonl'), [started(1, '[Implement] impl:a'), started(2, 'orchestrator/validation-list'), started(3, '[Implement] orchestrator/x')].map((e) => `${JSON.stringify(e)}\n`).join(''))
  writeFileSync(join(stateDir, 'runner.log'), '')
  const view = runView({ stateDir, host: { terminalList: async () => [] }, registry: null, transcripts: { usage: () => null }, alive: () => false })
  await view.refresh()
  const titles = view.model.phases.flatMap((p) => p.agents.map((a) => a.title))
  assert.deepEqual(titles, ['[Implement] impl:a', '[Implement] orchestrator/x'])
})

// The crew host, its harness the fake one, in a scratch crew home and Claude dir.
const homes = []
after(async () => {
  for (const paths of homes) await stopDaemon(paths, { force: true }).catch(() => {})
})
function crewScratch() {
  const root = scratch('crew')
  const env = { ...process.env, CREW_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PI_CODING_AGENT_SESSION_DIR: join(root, 'pi') }
  const paths = crewPaths(env)
  homes.push(paths)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  const host = crewHost({ paths, env, cwd: repo, harnesses: { claude: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000 })
  return { paths, repo, root, host, orch: orchestrator({ host, harness: 'claude', model: 'opus', dir: join(root, 'orchestrator'), pollMs: 100, idleMs: 1_500, answerMs: 60_000 }) }
}

test('crew host: the fake-harness orchestrator answers through submit, drafts its fixed list, and leaves no session open', async () => {
  const { paths, repo, orch } = crewScratch()
  assert.deepEqual(await orch.ask({ name: 'count', prompt: 'How many? [answer {"n":7}]', schema: SCHEMA }), { n: 7 })
  assert.deepEqual(await draftValidation(orch, { repoDir: repo }), { text: '# package.json scripts.test\nnpm test\n# .github/workflows/ci.yml job lint\nnpm run lint\n', empty: false })
  const { sessions } = await request(paths, { op: 'session.list' })
  assert.deepEqual(sessions.filter((s) => s.alive), [], 'each question\'s session is closed once answered')
})

test('crew host: an answer submit rejects never reaches crew; the orchestrator is nudged, then reported', async () => {
  const { orch } = crewScratch()
  await assert.rejects(orch.ask({ name: 'count', prompt: 'How many? [answer {"n":"seven"}]', schema: SCHEMA }), (e) => e instanceof OrchestratorError && /went idle without submitting an answer, after a nudge/.test(e.message))
})

// --- halt triage and ? (#103) ---------------------------------------------

const AT = '2026-09-28T10:00:00.000Z'
const ANSWER = { summary: 'impl:a failed its tests', nodes: [{ node: 'impl:a', reason: 'its tests fail on Windows', questions: ['keep the new API?'], decide: 'whether to keep the new API or revert it' }] }

const notice = (stateDir, at, nodes) => writeFileSync(join(stateDir, 'halted.json'), JSON.stringify({ at, runId: 'run_1', terminal: null, nodes: nodes.map((node) => ({ node, title: `[Implement] ${node}`, reason: 'its tests fail', tab: null })) }))
// A halted run's state dir: impl:a held, halted.json naming `nodes` at `at`.
function haltedRun(at = AT, nodes = ['impl:a']) {
  const stateDir = scratch('halted')
  const t = new Date(0).toISOString()
  const journal = [
    { type: 'started', n: 1, key: 'k1', node: 'impl:a', title: '[Implement] impl:a', at: t, run: 'run_1', dispatchId: 'ctx_1', harness: 'claude', sessionId: 'sid-1', worktree: null, terminal: 'term_1' },
    { type: 'failed', n: 1, key: 'k1', node: 'impl:a', at: t, reason: 'its tests fail' },
    { type: 'halted', at: t, node: 'impl:a', reason: 'its tests fail' },
  ]
  writeFileSync(join(stateDir, 'journal.jsonl'), journal.map((e) => `${JSON.stringify(e)}\n`).join(''))
  writeFileSync(join(stateDir, 'runner.log'), '')
  notice(stateDir, at, nodes)
  return stateDir
}
const treeOf = (stateDir, over = {}) => runView({ stateDir, host: { terminalList: async () => [] }, registry: null, transcripts: { usage: () => null }, alive: () => true, ...over })
// An orchestrator whose one answer the test gives when it likes.
function heldAnswer() {
  let give
  const asked = []
  const answer = new Promise((resolve, reject) => (give = { resolve, reject }))
  return { asked, give, orchestrate: () => ({ ask: (q) => (asked.push(q), answer) }) }
}
const settle = () => new Promise((done) => setImmediate(done))
// The panel's column of the body lines, at 140 wide: right of the 97-wide rows.
const panelOf = (view) => draw(view.model, { width: 140, height: 30 }).lines.map(strip).slice(4, 23).map((l) => l.slice(97))

test('triage: a new halted.json at is asked exactly once, however often and by however many it is triggered; a new at is a new question', async () => {
  const stateDir = haltedRun()
  const { host, calls } = standIn(submitted(ANSWER))
  const orchestrate = () => ask(host)
  const starts = () => calls.filter(([c]) => c === 'workerStart').map(([, s]) => s)
  const both = await Promise.all([triageHalt({ stateDir, orchestrate }), triageHalt({ stateDir, orchestrate })])
  assert.deepEqual(both.map((r) => r.asked).sort(), [false, true])
  assert.deepEqual(await triageHalt({ stateDir, orchestrate }), { asked: false, state: null }, 'asked about that at already')
  assert.equal(starts().length, 1)
  assert.equal(starts()[0].title, 'orchestrator/halt-triage')
  assert.match(starts()[0].prompt, /held until the operator resumes it with R: impl:a/)
  assert.ok(starts()[0].prompt.includes(stateDir), 'the question names the run directory')
  const recorded = readTriage(stateDir, AT)
  assert.deepEqual(recorded, { at: AT, since: recorded.since, state: 'answered', answer: ANSWER })

  // The runner rewrites halted.json with a new at when its held nodes change.
  notice(stateDir, '2026-09-28T10:05:00.000Z', ['impl:a', 'impl:b'])
  assert.equal((await triageHalt({ stateDir, orchestrate })).asked, true)
  assert.equal(starts().length, 2)
  assert.match(starts()[1].prompt, /2 nodes are held until the operator resumes them with R: impl:a, impl:b/)
  // No halted.json, no question.
  assert.deepEqual(await triageHalt({ stateDir: scratch('running'), orchestrate }), { asked: false, state: null })
})

test('triage: the run view asks once per at it sees, shows the question asking at once, and its answer in the halt panel beside the halted nodes', async () => {
  const stateDir = haltedRun()
  const held = heldAnswer()
  let triggered = 0
  const view = treeOf(stateDir, { triage: () => (triggered++, triageHalt({ stateDir, orchestrate: held.orchestrate })) })
  await view.refresh()
  await view.refresh()
  assert.equal(triggered, 1)
  assert.equal(held.asked.length, 1)
  assert.deepEqual([view.model.halt.at, view.model.halt.nodes, view.model.halt.triage.state], [AT, ['impl:a'], 'asking'])
  let panel = panelOf(view)
  assert.match(panel[0], /^│ ⏸ halt triage · 10:00:00/)
  assert.match(panel[1], /^│ asking the orchestrator about impl:a…/)

  held.give.resolve(ANSWER)
  await settle()
  await view.refresh()
  assert.equal(view.model.halt.triage.state, 'answered')
  panel = panelOf(view)
  assert.deepEqual(panel.slice(0, 8).map((l) => l.trimEnd()), [
    '│ ⏸ halt triage · 10:00:00',
    '│ impl:a failed its tests',
    '│',
    '│ impl:a',
    '│   why: its tests fail on Windows',
    '│   ? keep the new API?',
    '│   decide: whether to keep the new API or',
    '│   revert it',
  ])
  const screen = draw(view.model, { width: 140, height: 30 }).lines.map(strip)
  const row = screen.findIndex((l, i) => i >= 4 && l.slice(0, 97).includes('impl:a'))
  assert.ok(row >= 4 && row < 23, 'the halted node is drawn left of the panel')
  assert.equal(screen[row].length, 140)

  // A panel with more than its lines ends in how many are left.
  const short = draw(view.model, { width: 140, height: 14 }).lines.map(strip)
  assert.ok(short.some((l) => /^│ … \d+ more lines/.test(l.slice(97))))

  // Once the run leaves halted, halted.json goes, and the panel with it.
  rmSync(join(stateDir, 'halted.json'))
  await view.refresh()
  assert.equal(view.model.halt, null)
  assert.ok(!draw(view.model, { width: 140, height: 30 }).lines.map(strip).some((l) => l.includes('halt triage')))
})

test('halt panel: any width, however narrow, draws every triage state in its height at once; a terminal too narrow for rows beside it draws the rows alone', async () => {
  const halt = (triage) => ({ at: AT, nodes: ['impl:a', 'impl:b'], triage })
  const states = {
    untriaged: halt(null),
    asking: halt({ state: 'asking' }),
    failed: halt({ state: 'failed', error: 'the orchestrator gave no valid answer' }),
    answered: halt({ state: 'answered', answer: ANSWER }),
  }
  for (const [name, h] of Object.entries(states)) {
    for (const w of [0, 1, 2, 4]) {
      const started = Date.now()
      assert.equal(haltPanel(h, w, 5).length, 5, `${name} at ${w} wide`)
      assert.ok(Date.now() - started < 500, `${name} at ${w} wide is drawn at once`)
    }
  }

  const view = treeOf(haltedRun(), { triage: () => triageHalt({ stateDir: haltedRun(), orchestrate: () => ({ ask: () => new Promise(() => {}) }) }) })
  await view.refresh()
  assert.ok(view.model.halt)
  for (const width of [20, 4, 1]) {
    const screen = draw(view.model, { width, height: 30 }).lines.map(strip)
    assert.ok(screen.every((l) => l.length === width), `${width} wide`)
    assert.ok(!screen.some((l) => l.includes('│ ⏸')), `no panel at ${width} wide`)
  }
  const narrow = draw(view.model, { width: 20, height: 30 }).lines.map(strip)
  assert.ok(narrow.slice(4).some((l) => l.includes('impl:a')), "the halted node's row is still drawn")
  // Wide enough for the rows beside it, the panel is drawn as before.
  assert.ok(draw(view.model, { width: 70, height: 30 }).lines.map(strip).some((l) => l.includes('⏸ halt triage')))
})

test('triage: a question that fails says so in the panel, and R resumes the run all the same, while it is asked and after it failed', async () => {
  const stateDir = haltedRun()
  const held = heldAnswer()
  const resumed = []
  const view = treeOf(stateDir, { resumeHalted: (node) => resumed.push(node), triage: () => triageHalt({ stateDir, orchestrate: held.orchestrate }) })
  await view.refresh()
  assert.equal(view.model.halt.triage.state, 'asking')
  assert.match((await view.key('R')).message, /asked the runner to resume/)
  assert.equal(resumed.length, 1, 'R goes to the runner while the question is still asked')

  held.give.reject(new OrchestratorError('halt-triage', 'its session ended without submitting an answer'))
  await settle()
  await view.refresh()
  assert.equal(view.model.halt.triage.state, 'failed')
  assert.match(view.model.halt.triage.error, /no valid answer to halt-triage: its session ended without submitting an answer/)
  const panel = panelOf(view).map((l) => l.trimEnd())
  assert.equal(panel[1], '│ the triage question failed:')
  assert.match(panel.slice(2).join(' '), /the orchestrator gave no valid answer/)
  assert.ok(panel.includes('│ R resumes the run all the same'))
  assert.match((await view.key('R')).message, /asked the runner to resume/)
  assert.equal(resumed.length, 2)

  // An orchestrator that cannot even be made fails the question the same way.
  const other = haltedRun()
  assert.deepEqual(await triageHalt({ stateDir: other, orchestrate: () => { throw new Error('no harness to run it on') } }), { asked: true, state: 'failed' })
  assert.match(readTriage(other, AT).error, /no harness to run it on/)
  // A question left asking by an asker that went away is failed once stale.
  const stale = haltedRun()
  triageHalt({ stateDir: stale, orchestrate: () => ({ ask: () => new Promise(() => {}) }) })
  const asking = readTriage(stale, AT)
  assert.equal(asking.state, 'asking')
  const aged = readTriage(stale, AT, Date.parse(asking.since) + TRIAGE_STALE_MS + 1)
  assert.equal(aged.state, 'failed')
  assert.match(aged.error, /no answer was recorded/)
})

test('?: on an opened run, a fresh orchestrator session seeded with its run directory, entered and closed on leaving; its halt triaged once; the graph unchanged', async () => {
  const stateDir = haltedRun()
  const registry = join(scratch('registry'), 'runs.jsonl')
  runRegistry(registry).armed({ runId: 'run_1', project: 'C:/repos/app', runDir: stateDir, spec: 'implement-spec-103', host: 'crew' })
  const consulted = []
  const triaged = []
  let n = 0
  const orchestrator = { triage: async (run) => triaged.push(run.runDir), consult: async (run) => (consulted.push(run.runDir), `sess_${++n}`) }
  const runs = runsView({ host: { terminalList: async () => [] }, registry, enter: true, transcripts: { usage: () => null }, alive: () => true, orchestrator })
  await runs.refresh()
  await runs.open('run_1')
  const rows = runs.opened().model.rows.map((r) => r.key)
  await runs.refresh()
  assert.deepEqual(triaged, [stateDir], 'the opened run\'s halt, once')
  assert.deepEqual(await runs.key('?'), { enter: { session: 'sess_1', close: true } })
  assert.deepEqual(await runs.key('?'), { enter: { session: 'sess_2', close: true } }, 'each ? a fresh session')
  assert.deepEqual(consulted, [stateDir, stateDir])
  await runs.refresh()
  assert.deepEqual(runs.opened().model.rows.map((r) => r.key), rows)

  orchestrator.consult = async () => {
    throw new Error('crew: agent_not_ready')
  }
  assert.match((await runs.key('?')).message, /could not start an orchestrator session: crew: agent_not_ready/)
  const plain = runsView({ host: { terminalList: async () => [] }, registry, transcripts: { usage: () => null }, alive: () => true })
  await plain.refresh()
  await plain.open('run_1')
  assert.match((await plain.key('?')).message, /crew view only/)
})

test('run default: the orchestrator of an armed run runs on the harness and model its script\'s RUN_DEFAULT names, in its project, with the runner\'s permission mode', async () => {
  assert.deepEqual(runDefaultOf("x\r\nconst RUN_DEFAULT = { harness: 'claude', model: 'opus' }\r\n"), { harness: 'claude', model: 'opus' })
  assert.deepEqual(runDefaultOf("const RUN_DEFAULT = { harness: 'pi', piModel: 'lm/q\\'wen', model: 'sonnet' }"), { harness: 'pi', model: "lm/q'wen" })
  assert.equal(runDefaultOf('no table here'), null)
  const dir = scratch('armed')
  const script = join(dir, 'workflow.js')
  writeFileSync(script, "const RUN_DEFAULT = { harness: 'pi', piModel: 'lm/qwen', model: 'opus' }\n")
  const starts = []
  const cwds = []
  const orch = runOrchestrator({ paths: { home: dir }, host: (cwd) => (cwds.push(cwd), { sessionStart: async (s) => (starts.push(s), { terminal: '42' }) }) })
  const runDir = join(dir, 'orca-run')
  assert.equal(await orch.consult({ runDir, script, project: 'C:/repos/app', permissionMode: 'acceptEdits' }), '42')
  const [s] = starts
  assert.deepEqual([s.title, s.harness, s.model, s.permissionMode, s.dir, cwds[0]], ['orchestrator/console', 'pi', 'lm/qwen', 'acceptEdits', 'C:/repos/app', 'C:/repos/app'])
  assert.ok(isOrchestratorTitle(s.title))
  assert.ok(s.prompt.includes(runDir), 'seeded with the run directory')
  assert.match(s.prompt, /halted\.json.*journal\.jsonl.*agents\/\*\/result\.json.*summary\.json/)
  await orch.consult({ runDir, script: join(dir, 'gone.js'), project: null, permissionMode: null })
  assert.deepEqual([starts[1].harness, starts[1].model, starts[1].dir], ['claude', null, runDir], 'a script it cannot read runs it on Claude')
})

test('crew host: ? starts the fake harness in a session of no run, titled orchestrator/console, in the project, told the run directory', async () => {
  const { paths, repo, root, host } = crewScratch()
  const id = await consultSession({ host, stateDir: 'C:/runs/app/orca-run', harness: 'claude', model: 'opus', dir: repo })
  const s = (await request(paths, { op: 'session.list' })).sessions.find((x) => x.id === id)
  assert.deepEqual([s.title, s.alive, realpathSync(s.cwd)], ['orchestrator/console', true, repo])
  await assert.rejects(request(paths, { op: 'worker.show', id }), /dispatch_not_found/, 'no dispatch of any run: never a node')
  const transcripts = () => (existsSync(join(root, 'claude')) ? readdirSync(join(root, 'claude'), { recursive: true }).filter((f) => f.endsWith('.jsonl')).map((f) => readFileSync(join(root, 'claude', f), 'utf8')) : [])
  for (const until = Date.now() + 10_000; !transcripts().length && Date.now() < until;) await new Promise((done) => setTimeout(done, 50))
  const told = transcripts()
  assert.ok(told.some((t) => t.includes('opened from the run console') && t.includes('C:/runs/app/orca-run')), 'its first prompt names the run directory')
  assert.ok(!told.some((t) => t.includes("Your session host's preamble")), 'no worker preamble')
  await request(paths, { op: 'session.close', id })
})

test('crew host: a console quit with its halt triage still asked leaves no orchestrator session running, holds no `crew daemon stop` up, and the next console asks again', async () => {
  const { paths, repo, host } = crewScratch()
  await host.probe()
  const stateDir = haltedRun()
  const orch = runOrchestrator({ paths, host: () => host })
  const triaged = orch.triage({ runDir: stateDir, script: null, project: repo, permissionMode: null })
  const questions = async () => (await request(paths, { op: 'session.list' })).sessions.filter((s) => isOrchestratorTitle(s.title))
  for (const until = Date.now() + 20_000; !(await questions()).some((s) => s.alive); await new Promise((done) => setTimeout(done, 100))) {
    if (Date.now() > until) assert.fail('the triage question never started')
  }
  assert.equal(readTriage(stateDir, AT).state, 'asking')
  await orch.close()
  assert.deepEqual(await triaged, { asked: true, state: null })
  assert.deepEqual(await questions(), [], 'its session closed, not left running')
  assert.equal(readTriage(stateDir, AT), null, 'no answer and no failure: the next console asks it again')
  const closed = orchestrator({ host, dir: scratch('files') })
  await closed.close()
  await assert.rejects(closed.ask({ name: 'late', prompt: 'x', schema: SCHEMA }), (e) => e instanceof OrchestratorError && e.stopped, 'a closed orchestrator asks nothing more')
  assert.ok((await request(paths, { op: 'stop' })).pid, 'crew daemon stop is not refused')
})
