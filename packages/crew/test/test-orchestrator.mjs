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
import { preflight, runHeadless } from '../src/headless.mjs'
import { CONSULT_FILE, CONSULT_START_MS, OrchestratorError, closeConsult, consultSession, consultSessions, draftValidation, isOrchestratorTitle, orchestrator, validationText } from '../src/orchestrator.mjs'
import { STATES, runView, runsView } from '../src/run-view-model.mjs'
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

// A headless run played by `answer(call)`: the value it answers, or a throw.
// Every call is kept, as runHeadless was given it.
function standIn(answer = () => ({ n: 1 })) {
  const calls = []
  const run = async (call) => {
    calls.push(call)
    return answer(call)
  }
  return { run, calls }
}
const ask = (run, over = {}) => orchestrator({ run, harness: 'pi', model: 'lm/qwen', cwd: 'C:/repo', ...over })
const answering = (value) => standIn(() => value).run

test('ask: one headless run on the given harness and model, in the project, with the question\'s prompt and schema; its answer is returned', async () => {
  const { run, calls } = standIn(() => ({ n: 7 }))
  assert.deepEqual(await ask(run, { permissionMode: 'acceptEdits', program: ['node', 'fake.mjs'] }).ask({ name: 'count', prompt: 'How many?', schema: SCHEMA, dirs: ['C:/state'] }), { n: 7 })
  const [c] = calls
  assert.deepEqual([c.harness, c.model, c.permissionMode, c.cwd, c.prompt, c.schema, c.dirs, c.program], ['pi', 'lm/qwen', 'acceptEdits', 'C:/repo', 'How many?', SCHEMA, ['C:/state'], ['node', 'fake.mjs']])
  assert.ok(c.signal instanceof AbortSignal)
})

test('ask: a run that gives no valid answer is an OrchestratorError naming why; a question with no answer bound is refused', async () => {
  const failing = standIn(() => {
    throw new Error('its answer fails its schema: $.n: expected integer, got string')
  })
  await assert.rejects(ask(failing.run).ask({ name: 'count', prompt: 'p', schema: SCHEMA }), (e) => e instanceof OrchestratorError && !e.stopped && e.message === 'the orchestrator gave no valid answer to count: its answer fails its schema: $.n: expected integer, got string')
  await assert.rejects(ask(failing.run).ask({ name: 'q', prompt: 'p', schema: { type: 'string' } }), /schema needs \{type: "object", properties\}/)
})

test('ask: close() ends every run still asked, which is given up as stopped, and asks nothing more', async () => {
  const run = ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { stopped: true }))))
  const orch = ask(run)
  const asked = orch.ask({ name: 'q', prompt: 'p', schema: SCHEMA })
  await orch.close()
  await assert.rejects(asked, (e) => e instanceof OrchestratorError && e.stopped)
  await assert.rejects(orch.ask({ name: 'late', prompt: 'p', schema: SCHEMA }), (e) => e instanceof OrchestratorError && e.stopped)
})

test('draft: the checks as validation.md, each under its source; none is an empty list, said to be empty; a command of two lines is no answer', async () => {
  assert.equal(validationText({ checks: [{ command: 'npm test', source: 'package.json' }, { command: ' make lint ', source: 'Makefile\nlint' }] }), '# package.json\nnpm test\n# Makefile lint\nmake lint\n')
  const none = standIn(() => ({ checks: [] }))
  assert.deepEqual(await draftValidation(ask(none.run), { repoDir: 'C:/repo' }), { text: '', empty: true })
  const { prompt } = none.calls[0]
  assert.match(prompt, /repo at C:\/repo/)
  assert.match(prompt, /Never read source files/)
  assert.match(prompt, /empty checks list/)
  await assert.rejects(draftValidation(ask(answering({ checks: [{ command: 'a\nb', source: 's' }] })), { repoDir: 'C:/repo' }), (e) => e instanceof OrchestratorError && /not one line/.test(e.message))
})

test("draft: a command the workflow's String.raw list cannot hold (backtick, ${, trailing backslash) is no answer; a source holding one is only a comment, so it is cleaned", async () => {
  for (const [command, why] of [['echo `date`', /holds a backtick/], ['npm test -- --shard=${{ matrix.shard }}', /holds \$\{/], ['make \\', /ends in a backslash/]]) {
    await assert.rejects(draftValidation(ask(answering({ checks: [{ command: 'npm test', source: 'package.json' }, { command, source: 'ci.yml' }] })), { repoDir: 'C:/repo' }), (e) => e instanceof OrchestratorError && why.test(e.message) && e.message.includes(JSON.stringify(command)), command)
  }
  assert.equal(validationText({ checks: [{ command: 'npm test', source: 'ci.yml `test` ${{ matrix.os }} \\' }] }), "# ci.yml 'test' $ {{ matrix.os }}\nnpm test\n")
  const prompt = standIn(() => ({ checks: [] }))
  await draftValidation(ask(prompt.run), { repoDir: 'C:/repo' })
  assert.match(prompt.calls[0].prompt, /resolve every CI expression \(a GitHub Actions \$\{\{ matrix\.x \}\}.*no command holding a backtick, a \$\{ or a trailing backslash/)
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

// A run dir with one agent of Implement, and the ? sessions `consults`
// records as orchestrator.jsonl lines.
function runWithConsults(consults) {
  const stateDir = scratch('consults')
  const at = '2026-09-28T10:00:00.000Z'
  const journal = [
    { type: 'run', at, runId: 'run_1', terminal: 'coord_1' },
    { type: 'started', n: 1, key: 'k1', title: '[Implement] impl:a', at, run: 'run_1', dispatchId: 'term_1', harness: 'claude', sessionId: 'sid-1', worktree: null, terminal: 'term_1' },
  ]
  writeFileSync(join(stateDir, 'journal.jsonl'), journal.map((e) => `${JSON.stringify(e)}\n`).join(''))
  writeFileSync(join(stateDir, 'runner.log'), '')
  writeFileSync(join(stateDir, CONSULT_FILE), consults.map((e) => `${JSON.stringify({ at, ...e })}\n`).join(''))
  return { stateDir, at }
}
const consult = (n, terminal, ...more) => [{ type: 'starting', n, harness: 'claude', model: 'opus', dir: 'C:/repo' }, ...(terminal ? [{ type: 'started', n, terminal, sessionId: `sid-${terminal}` }] : []), ...more]

test('graph: the ? sessions the run dir records are the rows of an Orchestrator phase drawn first (#168), each in the state crew has its session in, none counted as an agent; Enter enters one; a closed one is no row', async () => {
  const { stateDir, at } = runWithConsults([
    ...consult(1, 'c1'), ...consult(2, 'c2'), ...consult(3, 'c3'), ...consult(4, 'c4', { type: 'closed', n: 4 }), ...consult(5, null),
    ...consult(6, null, { type: 'failed', n: 6, reason: 'crew: agent_not_ready' }), ...consult(7, 'c7'),
  ])
  const infos = [
    { terminal: 'c1', alive: true, parked: false, waiting: null }, { terminal: 'c2', alive: true, parked: false, waiting: 'a permission dialog' },
    { terminal: 'c3', alive: false, parked: true, waiting: null }, { terminal: 'term_1', alive: true, parked: false, waiting: null },
  ]
  const host = { inPlace: true, terminalList: async () => infos.map((i) => i.terminal), terminalsParked: async () => ['c3'], terminalsInfo: async () => infos }
  const now = Date.parse(at) + 90_000
  const usage = ({ harness, sessionId, worktree }) => (sessionId === 'sid-c1' && harness === 'claude' && worktree === 'C:/repo' ? { context: 1_000, tokens: 5_000, path: 'C:/t/c1.jsonl' } : null)
  const view = runView({ stateDir, host, registry: null, transcripts: { usage }, alive: () => true, clock: { now: () => now }, enter: true })
  await view.refresh()
  const { model } = view
  assert.deepEqual(model.phases.map((p) => p.name), ['Orchestrator', 'Implement'])
  assert.deepEqual(model.rows.map((r) => r.key), ['phase:Orchestrator', 'console:1', 'console:2', 'console:3', 'console:5', 'console:6', 'console:7', 'phase:Implement', 'agent:1'])
  const rows = model.rows.filter((r) => r.key.startsWith('console:')).map((r) => r.agent)
  assert.deepEqual(rows.map((a) => [a.n, a.state, a.reason, a.parked, a.tabOpen, a.terminal]), [
    [1, 'running', null, false, true, 'c1'],
    [2, 'needs you', 'a permission dialog', false, true, 'c2'],
    [3, 'done', null, true, true, 'c3'],
    [5, 'starting', null, false, null, null],
    [6, 'failed', 'crew: agent_not_ready', false, null, null],
    [7, 'failed', 'its crew session is gone', false, false, 'c7'],
  ])
  const [one] = rows
  assert.deepEqual([one.label, one.title, one.phase, one.console, one.worktree, one.harness, one.sessionId, one.context, one.tokens, one.transcript, one.elapsedMs], ['console 1', '[Orchestrator] console 1', 'Orchestrator', true, null, 'claude', 'sid-c1', 1_000, 5_000, 'C:/t/c1.jsonl', 90_000])
  const orch = model.phases[0]
  assert.deepEqual([orch.console, orch.total, orch.folded, orch.mix.running, orch.mix['needs you'], orch.mix.done, orch.mix.starting, orch.mix.failed], [true, 6, false, 1, 1, 1, 1, 2])
  assert.deepEqual(model.header.counts, { ...Object.fromEntries(STATES.map((s) => [s, 0])), running: 1 }, 'the header counts the run\'s agents only')
  const screen = draw(model, { width: 140, height: 30 }).lines.map(strip)
  assert.match(screen[4], /^ ▾ Orchestrator 6 sessions\s+\?1 ◌1 ●1 ✗2 ✓1\s*$/, 'the phase row counts sessions, not done ones')
  assert.match(screen[5], /^\s+1   console 1\s+● running/)
  assert.equal(model.alert, null, 'a console waiting on the person is no run alert')

  assert.deepEqual(await view.click(1), { enter: { session: 'c1', title: '[Orchestrator] console 1' } })
  assert.match((await view.click(4)).message, /console 5 has no session: it is still starting/)
  assert.match((await view.click(6)).message, /console 7's crew session c7 is closed/)
  assert.deepEqual([view.model.pane.kind, view.model.pane.agent.title], ['agent', '[Orchestrator] console 7'])

  // Every ? session parked folds the phase, as a phase of done agents folds.
  const parked = runWithConsults([...consult(1, 'c1')])
  const quiet = runView({ stateDir: parked.stateDir, host: { inPlace: true, terminalList: async () => ['c1'], terminalsParked: async () => ['c1'], terminalsInfo: async () => [{ terminal: 'c1', alive: false, parked: true, waiting: null }] }, registry: null, transcripts: { usage: () => null }, alive: () => true, clock: { now: () => now } })
  await quiet.refresh()
  assert.deepEqual(quiet.model.rows.map((r) => r.key), ['phase:Orchestrator', 'phase:Implement', 'agent:1'])
  // Crew's sessions not readable: a started one stays running, saying so.
  const unread = runView({ stateDir: parked.stateDir, host: { inPlace: true, terminalList: async () => ['c1'], terminalsParked: async () => [], terminalsInfo: async () => { throw new Error('crew: ECONNREFUSED') } }, registry: null, transcripts: { usage: () => null }, alive: () => true, clock: { now: () => now } })
  await unread.refresh()
  assert.deepEqual([unread.model.rows[1].agent.state, unread.model.rows[1].agent.reason], ['running', "crew's sessions could not be read: crew: ECONNREFUSED"])
  // A run with no ? session has no Orchestrator phase.
  const none = runWithConsults([])
  const plain = runView({ stateDir: none.stateDir, host: { terminalList: async () => [] }, registry: null, transcripts: { usage: () => null }, alive: () => true, clock: { now: () => now } })
  await plain.refresh()
  assert.deepEqual(plain.model.rows.map((r) => r.key), ['phase:Implement', 'agent:1'])
})

test('tree: Ctrl+R on a ? session\'s row closes its session and drops the row (#168), on the Orchestrator row or Reclaim All every one; Ctrl+P parks a running one at once', async () => {
  const { stateDir, at } = runWithConsults([...consult(1, 'c1'), ...consult(2, 'c2'), ...consult(3, null, { type: 'failed', n: 3, reason: 'crew: agent_not_ready' }), ...consult(4, 'c4')])
  const closed = []
  const parked = new Set()
  const infos = () => ['c1', 'c2', 'c4'].filter((t) => !closed.includes(t)).map((terminal) => ({ terminal, alive: !parked.has(terminal), parked: parked.has(terminal), waiting: null }))
  const host = {
    inPlace: true, terminalList: async () => infos().map((i) => i.terminal), terminalsParked: async () => [...parked], terminalsInfo: async () => infos(),
    terminalClose: async ({ terminal }) => closed.push(terminal), terminalPark: async ({ terminal }) => parked.add(terminal),
  }
  const view = runView({ stateDir, host, registry: null, transcripts: { usage: () => null }, alive: () => false, clock: { now: () => Date.parse(at) + 1000 }, enter: true })
  await view.refresh()
  const keys = () => view.model.rows.map((r) => r.key)
  assert.deepEqual(keys(), ['phase:Orchestrator', 'console:1', 'console:2', 'console:3', 'console:4', 'phase:Implement', 'agent:1'])

  await view.key('DOWN')
  await view.key('CTRL_R')
  assert.deepEqual(view.model.dialog.options[0], { id: 'selected', label: 'Reclaim Selected', detail: 'console 1: closes its session', disabled: false, reason: null })
  assert.match((await view.key('ENTER')).message, /^closed \[Orchestrator\] console 1$/)
  assert.deepEqual([closed, keys()], [['c1'], ['phase:Orchestrator', 'console:2', 'console:3', 'console:4', 'phase:Implement', 'agent:1']])
  assert.deepEqual(consultSessions(stateDir).map((s) => s.state), ['closed', 'started', 'failed', 'started'])

  // Ctrl+P: Park Selected on a running one; a parked one is refused with why.
  await view.key('CTRL_P')
  assert.deepEqual(view.model.dialog.options[0], { id: 'park-selected', label: 'Park Selected', detail: '[Orchestrator] console 2', disabled: false, reason: null })
  assert.match((await view.key('ENTER')).message, /parked 1 of 1/)
  assert.deepEqual([[...parked], view.model.rows[1].agent.state, view.model.rows[1].agent.parked], [['c2'], 'done', true])
  await view.key('CTRL_P')
  assert.deepEqual([view.model.dialog.options[0].disabled, view.model.dialog.options[0].reason], [true, 'it is parked already'])
  await view.key('ESCAPE')

  // A failed start has no session to close: its row goes all the same.
  await view.key('DOWN')
  await view.key('CTRL_R')
  assert.deepEqual(view.model.dialog.options[0].detail, 'console 3: drops it, its start having failed')
  assert.match((await view.key('ENTER')).message, /^closed \[Orchestrator\] console 3$/)
  assert.deepEqual([closed, keys()], [['c1'], ['phase:Orchestrator', 'console:2', 'console:4', 'phase:Implement', 'agent:1']])

  // Reclaim All, the run ended: every ? session left is closed too, the parked one included.
  await view.key('CTRL_R')
  await view.key('DOWN')
  await view.key('DOWN')
  assert.equal(view.model.dialog.options[view.model.dialog.highlight].id, 'all')
  const all = await view.key('ENTER')
  assert.match(all.message, /closed 2 orchestrator sessions/)
  assert.deepEqual([closed, keys()], [['c1', 'c2', 'c4'], ['phase:Implement', 'agent:1']])
})

// The crew host, and the fake harness run headless, in a scratch crew home
// and Claude dir; crew's config names the fake harness as Claude.
const homes = []
after(async () => {
  for (const paths of homes) await stopDaemon(paths, { force: true }).catch(() => {})
})
function crewScratch({ program = [process.execPath, FAKE_HARNESS] } = {}) {
  const root = scratch('crew')
  const env = { ...process.env, CREW_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PI_CODING_AGENT_SESSION_DIR: join(root, 'pi') }
  const paths = crewPaths(env)
  homes.push(paths)
  mkdirSync(paths.home, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ harnesses: { claude: program } }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  const host = crewHost({ paths, env, cwd: repo, harnesses: { claude: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000 })
  return { paths, repo, root, host, orch: orchestrator({ harness: 'claude', model: 'opus', cwd: repo, env, program, answerMs: 60_000 }) }
}

test('headless: the fake-harness orchestrator answers in the project, drafts its fixed list, and opens no session', async () => {
  const { paths, repo, orch } = crewScratch()
  assert.deepEqual(await orch.ask({ name: 'count', prompt: 'How many? [answer {"n":7}]', schema: SCHEMA }), { n: 7 })
  assert.deepEqual(await draftValidation(orch, { repoDir: repo }), { text: '# package.json scripts.test\nnpm test\n# .github/workflows/ci.yml job lint\nnpm run lint\n', empty: false })
  assert.equal((await request(paths, { op: 'session.list' }).catch(() => null)), null, 'no daemon was started: no session was needed')
})

test('headless: an answer that fails its schema, an error result, and a run past its time are each reported', async () => {
  const { orch, repo } = crewScratch()
  await assert.rejects(orch.ask({ name: 'count', prompt: 'How many? [answer {"n":"seven"}]', schema: SCHEMA }), (e) => e instanceof OrchestratorError && /its answer fails its schema: \$\.n: expected integer, got string/.test(e.message))
  await assert.rejects(orch.ask({ name: 'count', prompt: '[error Invalid API key · Please run /login]', schema: SCHEMA }), /claude answered with an error: Invalid API key · Please run \/login/)
  const slow = orchestrator({ harness: 'claude', cwd: repo, program: [process.execPath, FAKE_HARNESS], answerMs: 300 })
  await assert.rejects(slow.ask({ name: 'q', prompt: '[hang]', schema: SCHEMA }), /no answer within 0 min/)
})

test('preflight: a harness that answers passes; one whose login or model fails is refused in its own words; it runs in the project', async () => {
  const { repo } = crewScratch()
  const program = [process.execPath, FAKE_HARNESS]
  await preflight({ harness: 'claude', model: 'opus', cwd: repo, program })
  await preflight({ harness: 'pi', model: 'lm/qwen', cwd: repo, program })
  const seen = []
  await preflight({ harness: 'claude', model: 'opus', cwd: repo, run: async (c) => (seen.push(c), 'ok') })
  assert.deepEqual([seen[0].cwd, seen[0].model, seen[0].schema], [repo, 'opus', undefined])
  await assert.rejects(preflight({ harness: 'claude', model: 'nope', cwd: repo, run: () => runHeadless({ harness: 'claude', prompt: '[error model nope not found]', cwd: repo, program }) }), /claude answered with an error: model nope not found/)
  await assert.rejects(preflight({ harness: 'claude', cwd: repo, program: [join(repo, 'no-such-claude')] }), /could not be started/)
})

// --- halt triage and ? (#103) ---------------------------------------------

test('?: consultSession records each session in the run dir (#168), starting then started, numbered on; a start that fails is recorded failed with why; a starting line left by a console that went away is failed once stale; closeConsult records closed', async () => {
  const stateDir = scratch('consult')
  const starts = []
  const host = { sessionStart: async (s) => (starts.push(s), { terminal: String(starts.length) }) }
  assert.deepEqual(await consultSession({ host, stateDir, harness: 'claude', model: 'opus', dir: 'C:/repo' }), { terminal: '1', n: 1 })
  assert.deepEqual(await consultSession({ host, stateDir, harness: 'pi', dir: 'C:/repo' }), { terminal: '2', n: 2 })
  const failing = { sessionStart: async () => { throw new Error('crew: agent_not_ready') } }
  await assert.rejects(consultSession({ host: failing, stateDir, dir: 'C:/repo' }), /agent_not_ready/)
  const lines = readFileSync(join(stateDir, CONSULT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => [l.type, l.n]), [['starting', 1], ['started', 1], ['starting', 2], ['started', 2], ['starting', 3], ['failed', 3]])
  const sessions = consultSessions(stateDir)
  assert.deepEqual(sessions.map((s) => [s.n, s.state, s.terminal, s.harness, s.model, s.sessionId, s.dir, s.reason]), [
    [1, 'started', '1', 'claude', 'opus', starts[0].sessionId, 'C:/repo', null],
    [2, 'started', '2', 'pi', null, starts[1].sessionId, 'C:/repo', null],
    [3, 'failed', null, 'claude', null, null, 'C:/repo', 'crew: agent_not_ready'],
  ])
  assert.ok(sessions.every((s) => typeof s.at === 'string' && !Number.isNaN(Date.parse(s.at))))
  closeConsult(stateDir, 1)
  assert.deepEqual(consultSessions(stateDir).map((s) => s.state), ['closed', 'started', 'failed'])
  assert.deepEqual(consultSessions(scratch('none')), [])

  // A console that died between starting and started leaves a starting line: shown so until stale, then failed.
  const at = '2026-09-28T10:00:00.000Z'
  writeFileSync(join(stateDir, CONSULT_FILE), `${JSON.stringify({ type: 'starting', at, n: 1, harness: 'claude', model: null, dir: 'C:/repo' })}\n`)
  assert.equal(consultSessions(stateDir, { now: Date.parse(at) + CONSULT_START_MS - 1 })[0].state, 'starting')
  const stale = consultSessions(stateDir, { now: Date.parse(at) + CONSULT_START_MS })[0]
  assert.deepEqual([stale.state, stale.reason], ['failed', 'its start was never recorded as done: the console that started it went away'])
})

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
  const { run, calls } = standIn(() => ANSWER)
  const orchestrate = () => ask(run)
  const starts = () => calls
  const both = await Promise.all([triageHalt({ stateDir, orchestrate }), triageHalt({ stateDir, orchestrate })])
  assert.deepEqual(both.map((r) => r.asked).sort(), [false, true])
  assert.deepEqual(await triageHalt({ stateDir, orchestrate }), { asked: false, state: null }, 'asked about that at already')
  assert.equal(starts().length, 1)
  assert.deepEqual(starts()[0].dirs, [stateDir], 'it may read the run directory')
  assert.match(starts()[0].prompt, /held until the operator resumes it with r: impl:a/)
  assert.ok(starts()[0].prompt.includes(stateDir), 'the question names the run directory')
  const recorded = readTriage(stateDir, AT)
  assert.deepEqual(recorded, { at: AT, since: recorded.since, state: 'answered', answer: ANSWER })

  // The runner rewrites halted.json with a new at when its held nodes change.
  notice(stateDir, '2026-09-28T10:05:00.000Z', ['impl:a', 'impl:b'])
  assert.equal((await triageHalt({ stateDir, orchestrate })).asked, true)
  assert.equal(starts().length, 2)
  assert.match(starts()[1].prompt, /2 nodes are held until the operator resumes them with r: impl:a, impl:b/)
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

test('triage: a question that fails says so in the panel, and r resumes the run all the same, while it is asked and after it failed', async () => {
  const stateDir = haltedRun()
  const held = heldAnswer()
  const resumed = []
  const view = treeOf(stateDir, { resumeHalted: (node) => resumed.push(node), triage: () => triageHalt({ stateDir, orchestrate: held.orchestrate }) })
  await view.refresh()
  assert.equal(view.model.halt.triage.state, 'asking')
  assert.match((await view.key('r')).message, /asked the runner to resume/)
  assert.equal(resumed.length, 1, 'R goes to the runner while the question is still asked')

  held.give.reject(new OrchestratorError('halt-triage', 'its session ended without submitting an answer'))
  await settle()
  await view.refresh()
  assert.equal(view.model.halt.triage.state, 'failed')
  assert.match(view.model.halt.triage.error, /no valid answer to halt-triage: its session ended without submitting an answer/)
  const panel = panelOf(view).map((l) => l.trimEnd())
  assert.equal(panel[1], '│ the triage question failed:')
  assert.match(panel.slice(2).join(' '), /the orchestrator gave no valid answer/)
  assert.ok(panel.includes('│ r resumes the run all the same'))
  assert.match((await view.key('r')).message, /asked the runner to resume/)
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

test('?: on an opened run, a fresh orchestrator session seeded with its run directory, entered and kept on leaving, a row of the Orchestrator phase from then on (#168); its halt triaged once', async () => {
  const stateDir = haltedRun()
  const registry = join(scratch('registry'), 'runs.jsonl')
  runRegistry(registry).armed({ runId: 'run_1', project: 'C:/repos/app', runDir: stateDir, spec: 'implement-spec-103', host: 'crew' })
  const consulted = []
  const triaged = []
  let n = 0
  const sessionHost = { sessionStart: async () => ({ terminal: `sess_${++n}` }) }
  const orchestrator = { triage: async (run) => triaged.push(run.runDir), consult: async (run) => (consulted.push(run.runDir), consultSession({ host: sessionHost, stateDir: run.runDir, dir: run.project })) }
  const open = []
  const host = { inPlace: true, terminalList: async () => open, terminalsParked: async () => [], terminalsInfo: async () => open.map((terminal) => ({ terminal, alive: true, parked: false, waiting: null })) }
  const runs = runsView({ host, registry, enter: true, transcripts: { usage: () => null }, alive: () => true, orchestrator })
  await runs.refresh()
  await runs.open('run_1')
  const keys = () => runs.opened().model.rows.map((r) => r.key)
  const rows = keys()
  await runs.refresh()
  assert.deepEqual(triaged, [stateDir], 'the opened run\'s halt, once')
  open.push('sess_1')
  assert.deepEqual(await runs.key('?'), { enter: { session: 'sess_1', title: '[Orchestrator] console 1' } }, 'entered, and never closed on leaving')
  assert.deepEqual(keys(), ['phase:Orchestrator', 'console:1', ...rows], 'its row is there as the session is entered')
  open.push('sess_2')
  assert.deepEqual(await runs.key('?'), { enter: { session: 'sess_2', title: '[Orchestrator] console 2' } }, 'each ? a fresh session')
  assert.deepEqual(consulted, [stateDir, stateDir])
  await runs.refresh()
  assert.deepEqual(keys(), ['phase:Orchestrator', 'console:1', 'console:2', ...rows])
  assert.deepEqual(runs.opened().model.rows[1].agent.state, 'running')

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
  mkdirSync(runDir)
  assert.deepEqual(await orch.consult({ runDir, script, project: 'C:/repos/app', permissionMode: 'acceptEdits' }), { terminal: '42', n: 1 })
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
  const stateDir = join(root, 'orca-run')
  mkdirSync(stateDir)
  const { terminal: id } = await consultSession({ host, stateDir, harness: 'claude', model: 'opus', dir: repo })
  const s = (await request(paths, { op: 'session.list' })).sessions.find((x) => x.id === id)
  assert.deepEqual([s.title, s.alive, realpathSync(s.cwd)], ['orchestrator/console', true, repo])
  assert.deepEqual((await host.terminalsInfo()).find((i) => i.terminal === id), { terminal: id, alive: true, parked: false, waiting: null, exit: null }, 'what the tree reads its state from')
  await assert.rejects(request(paths, { op: 'worker.show', id }), /dispatch_not_found/, 'no dispatch of any run: never a node')
  const transcripts = () => (existsSync(join(root, 'claude')) ? readdirSync(join(root, 'claude'), { recursive: true }).filter((f) => f.endsWith('.jsonl')).map((f) => readFileSync(join(root, 'claude', f), 'utf8')) : [])
  for (const until = Date.now() + 10_000; !transcripts().length && Date.now() < until;) await new Promise((done) => setTimeout(done, 50))
  const told = transcripts()
  assert.ok(told.some((t) => t.includes('opened from the run console') && t.includes(stateDir)), 'its first prompt names the run directory')
  assert.ok(!told.some((t) => t.includes("Your session host's preamble")), 'no worker preamble')
  await request(paths, { op: 'session.close', id })
})

test('headless: a console quit with its halt triage still asked ends its run, and the next console asks again', async () => {
  const root = scratch('hang')
  const pidFile = join(root, 'pid')
  const hang = join(root, 'hang.mjs')
  writeFileSync(hang, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`.replace("require('fs')", "(await import('fs'))"))
  const { paths, repo } = crewScratch({ program: [process.execPath, hang] })
  const stateDir = haltedRun()
  const orch = runOrchestrator({ paths })
  const triaged = orch.triage({ runDir: stateDir, script: null, project: repo, permissionMode: null })
  for (const until = Date.now() + 20_000; !existsSync(pidFile); await new Promise((done) => setTimeout(done, 50))) {
    if (Date.now() > until) assert.fail('the triage question never started')
  }
  assert.equal(readTriage(stateDir, AT).state, 'asking')
  await orch.close()
  assert.deepEqual(await triaged, { asked: true, state: null })
  const alive = (pid) => {
    try {
      return process.kill(pid, 0)
    } catch {
      return false
    }
  }
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false, 'its run ended, not left running')
  assert.equal(readTriage(stateDir, AT), null, 'no answer and no failure: the next console asks it again')
})
