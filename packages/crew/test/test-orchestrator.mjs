// Offline tests for the orchestrator (#102): a question with a schema, its
// answer validated or reported, its sessions out of every run's graph, and
// the validation-list draft, on a stand-in host and on the crew host running
// the fake harness.
//   node packages/crew/test/test-orchestrator.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { OrchestratorError, draftValidation, isOrchestratorTitle, orchestrator, validationText } from '../src/orchestrator.mjs'
import { runView } from '../src/run-view-model.mjs'
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
  return { paths, repo, orch: orchestrator({ host, harness: 'claude', model: 'opus', dir: join(root, 'orchestrator'), pollMs: 100, idleMs: 1_500, answerMs: 60_000 }) }
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
