// A run on the crew host end to end, its runner in this process so its limits
// can be short: workers are the fake harness (fixtures/crew/fake-harness.mjs)
// in real ptys held by a real daemon under a scratch crew home, and their
// submit and mail go through the real agent-side commands, with no Orca.
// `crew run` itself, the runner as a crew session, is test-crew-bin.mjs's.
//   node packages/crew/test/test-crew-run.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runScript } from '../src/runner.mjs'
import { crewHost, crewWorktrees } from '../src/crew-host.mjs'
import { sessionHost } from '../src/session-host.mjs'
import { sessionTranscripts, transcriptPath } from '../src/transcript.mjs'
import { readJournal } from '../src/journal.mjs'
import { validate } from '../src/schema.mjs'
import { pinBase } from '../src/arm.mjs'
import { renderWith } from './fixtures/render-with.mjs'
import { runView } from '../src/run-view-model.mjs'
import { draw, strip } from '../src/run-view/draw.mjs'
import { crewPaths } from '../src/daemon/transport.mjs'
import { stopDaemon } from '../src/daemon/client.mjs'

const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/crew/fake-harness.mjs', import.meta.url))
const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/crew-run/${name}`, import.meta.url)), 'utf8')

// A death is a patient at once: no nudge, no continuation, one doctor round.
const FAST = { pollMs: 100, idleProbeMs: 50, nudgeGraceMs: 500, idleNudges: 0, maxContinuations: 0, doctorRounds: 1 }

const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-run-')))
const env = { ...process.env, CREW_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PI_CODING_AGENT_SESSION_DIR: join(root, 'pi') }
const paths = crewPaths(env)
after(() => stopDaemon(paths, { force: true }).catch(() => {}))

// The run's worktree: a git repo, since a doctor runs in a worktree of its own.
function repo(name = 'repo') {
  const cwd = join(root, name)
  mkdirSync(cwd)
  const git = (...args) => assert.equal(spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`)
  git('init', '-q')
  writeFileSync(join(cwd, 'README.md'), 'crew run\n')
  git('add', 'README.md')
  git('-c', 'user.name=crew', '-c', 'user.email=crew@example.com', 'commit', '-q', '-m', 'init')
  return cwd
}

test("a doctor round on the crew host: the patient dies, its doctor, without crew's tools, hands off a note over Run mail, and the patient carries on with it", async () => {
  const cwd = repo()
  // CREW_FAKE_MCP=0: its Claude starts no MCP server, so it reports by the CLI its prompt falls back to.
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0' }, cwd, harnesses: { claude: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'state')
  const said = []
  const result = await runScript(fixture('doctor-round.workflow.js'), { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')
  assert.deepEqual(result, { patient: 'the note carried it on' }, log)

  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const of = (type) => entries.filter((e) => e.type === type)
  assert.equal(of('doctor').length, 1, log)
  const [doctor] = of('doctor')
  assert.match(doctor.reason, /exited without submitting/)
  const [handoff] = of('mail').filter((m) => m.action === 'remedy')
  assert.ok(handoff, log)
  assert.equal(handoff.body, 'the note carried it on')
  // The patient's session carried on with the note, in a new crew session,
  // since its program had ended.
  const started = of('started')
  const patientStart = started.find((e) => e.n === doctor.n)
  const [remedy] = of('remedy')
  assert.equal(remedy?.how, 'continue', log)
  assert.equal(remedy.messageId, handoff.messageId)
  assert.equal(remedy.reopened, true)
  assert.notEqual(remedy.terminal, patientStart.terminal)
  // The doctor ran in a `<runId>-<n>` worktree of crew's.
  const doctorStart = started.find((e) => e.n === doctor.doctor)
  assert.ok(doctorStart?.worktree?.startsWith(crewWorktrees(cwd)), JSON.stringify(started))
  const fold = readJournal(join(stateDir, 'journal.jsonl'))
  assert.equal(fold.agents.find((a) => a.n === doctor.n)?.state, 'done', JSON.stringify(fold.agents))
})

// The [name, isError, first line] of each tool result in a session's
// transcript, as its harness writes them; a Claude tool its name on crew's
// MCP server.
function toolResults({ harness, sessionId, worktree }) {
  const lines = readFileSync(transcriptPath({ harness, sessionId, worktree, env }), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).message)
  const first = (content) => content[0].text.split('\n')[0]
  if (harness === 'pi') return lines.filter((m) => m?.role === 'toolResult').map((m) => [m.toolName, m.isError, first(m.content)])
  const uses = new Map(
    lines
      .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
      .filter((c) => c.type === 'tool_use')
      .map((c) => [c.id, c.name.replace(/^mcp__crew-agent-tools__/, '')]),
  )
  return lines
    .flatMap((m) => (m?.role === 'user' && Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => [uses.get(c.tool_use_id), c.is_error, first(c.content)])
}

// A run whose doctor is the recover role's harness, journal and the doctor's
// tool results from its transcript.
async function doctorRun(name, script) {
  const cwd = repo(`${name}-repo`)
  const host = sessionHost(crewHost({ paths, env, cwd, harnesses: { claude: [process.execPath, FAKE_HARNESS], pi: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, `${name}-state`)
  const said = []
  const result = await runScript(fixture(script), { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const of = (type) => entries.filter((e) => e.type === type)
  const [doctor] = of('doctor')
  const doctorStart = of('started').find((e) => e.n === doctor?.doctor)
  const toolCalls = doctorStart ? toolResults(doctorStart).map(([name, isError]) => [name, isError]) : []
  return { result, of, doctor, doctorStart, toolCalls, log: said.join('\n') }
}

// pi's tools from crew's extension, Claude's from crew's MCP server: the
// same doctor rounds on each.
for (const [harness, prefix, ticket] of [
  ['pi', '', '#176'],
  ['claude', 'claude-', '#177'],
]) {
  test(`a ${harness} doctor ends its round with crew's handoff tool: its note is the remedy and its patient carries on with it; a second handoff acts on nothing (${ticket})`, async () => {
    const { result, of, doctorStart, toolCalls, log } = await doctorRun(`${harness}-handoff-tool`, `${prefix}doctor-handoff-tool.workflow.js`)
    assert.deepEqual(result, { patient: 'the note carried it on' }, log)
    assert.equal(doctorStart?.harness, harness, log)
    assert.deepEqual(toolCalls[0], ['handoff', false], log)
    const remedies = of('mail').filter((m) => m.action === 'remedy')
    assert.deepEqual(
      remedies.map((m) => m.body),
      ['the note carried it on'],
      log,
    )
    const [remedy] = of('remedy')
    assert.equal(remedy?.how, 'continue', log)
    assert.equal(remedy.messageId, remedies[0].messageId)
    assert.equal(of('remedy').length, 1)
    // The second note, if the daemon took it before the runner let its doctor go, acted on nothing.
    assert.deepEqual(
      of('mail')
        .filter((m) => m.kind === 'handoff' && m.action !== 'remedy')
        .map((m) => m.action)
        .filter((a) => a !== 'none'),
      [],
      log,
    )
    assert.equal(of('gaveUp').length, 0, log)
  })

  test(`a ${harness} doctor ends its round with crew's give_up tool: no remedy, the reason journaled, and its patient's agent() fails once its rounds are spent (${ticket})`, async () => {
    const { result, of, doctor, doctorStart, toolCalls, log } = await doctorRun(`${harness}-give-up-tool`, `${prefix}doctor-give-up-tool.workflow.js`)
    assert.equal(doctorStart?.harness, harness, log)
    assert.deepEqual(result, { patient: null }, log)
    assert.deepEqual(toolCalls, [['give_up', false]], log)
    const gaveUp = of('mail').filter((m) => m.action === 'gaveUp')
    assert.deepEqual(
      gaveUp.map((m) => [m.kind, m.outcome, m.body]),
      [['worker_done', 'failed', 'only a human can fix this']],
      log,
    )
    assert.deepEqual(
      of('gaveUp').map((e) => [e.round, e.doctor, e.reason]),
      [[1, doctor.doctor, 'it gave up: only a human can fix this']],
      log,
    )
    assert.equal(of('remedy').length, 0, log)
    assert.equal(of('mail').filter((m) => m.action === 'remedy').length, 0, log)
  })
}

test('a sequential run on the crew host: its code agents one after another in <runId>-chain, its setup hook run once, and a doctor in a <runId>-<n> of its own, setup skipped', async () => {
  const cwd = repo('chain-repo')
  const hook = join(root, 'chain-setup.mjs')
  const setupLog = join(root, 'chain-setup.log')
  writeFileSync(hook, `import { appendFileSync } from 'fs'\nappendFileSync(${JSON.stringify(setupLog)}, process.env.CREW_WORKTREE + '\\n')\n`)
  mkdirSync(env.CREW_HOME, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ repos: { [cwd]: { setup: hook } } }))
  const host = sessionHost(crewHost({ paths, env, cwd, harnesses: { claude: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'chain-state')
  const said = []
  const result = await runScript(fixture('chain.workflow.js'), { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')
  assert.deepEqual(result, { first: 'hello', patient: 'the note carried it on' }, log)
  const fold = readJournal(join(stateDir, 'journal.jsonl'))
  const chain = join(crewWorktrees(cwd), `${fold.run.runId}-chain`)
  assert.equal(fold.chain?.worktree, chain, log)
  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const [doctor] = entries.filter((e) => e.type === 'doctor')
  const started = entries.filter((e) => e.type === 'started')
  assert.deepEqual(
    started.filter((e) => e.n !== doctor.doctor).map((e) => e.worktree),
    [chain, chain],
    JSON.stringify(started),
  )
  assert.equal(started.find((e) => e.n === doctor.doctor)?.worktree, join(crewWorktrees(cwd), `${fold.run.runId}-${doctor.doctor}`))
  assert.deepEqual(
    readFileSync(setupLog, 'utf8')
      .trim()
      .split('\n')
      .map((p) => realpathSync(p)),
    [realpathSync(chain)],
    "the setup hook ran once, in the chain worktree, never in the doctor's",
  )
  assert.ok(existsSync(chain))
})

test('a harness dialog before the prompt: the agent needs you in the session showing it, nothing is typed into it, and once answered its prompt goes in and it finishes', async () => {
  const cwd = join(root, 'dialog-repo')
  mkdirSync(cwd)
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_DIALOG: 'trust' }, cwd, harnesses: { claude: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'dialog-state')
  const said = []
  const running = runScript(fixture('dialog.workflow.js'), { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const journal = join(stateDir, 'journal.jsonl')
  const asker = () => {
    try {
      return readJournal(journal).agents[0] ?? null
    } catch {
      return null
    }
  }
  for (const until = Date.now() + 20_000; asker()?.state !== 'needs you'; await new Promise((done) => setTimeout(done, 50))) {
    if (Date.now() > until) assert.fail(`the agent never needed you: ${JSON.stringify(asker())}\n${said.join('\n')}`)
  }
  const a = asker()
  assert.match(a.reason, /Claude asks whether to trust this folder: enter the session and answer it/)
  assert.ok(
    said.some((l) => l.startsWith('?? [Trust] asker: Claude asks whether to trust this folder')),
    said.join('\n'),
  )
  const { request } = await import('../src/daemon/client.mjs')
  const { sessions } = await request(paths, { op: 'session.list' })
  const session = sessions.find((s) => s.id === a.terminal)
  assert.deepEqual([session?.alive, realpathSync(session.cwd)], [true, cwd], 'the dialog is in a live session, started in the project')
  // The person enters the session and trusts the folder.
  await request(paths, { op: 'session.write', id: a.terminal, data: '\x1b[B' })
  await request(paths, { op: 'session.write', id: a.terminal, data: '\r' })
  assert.deepEqual(await running, { word: 'trusted' }, said.join('\n'))
  const types = readFileSync(journal, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).type)
  assert.deepEqual(
    types.filter((t) => ['starting', 'dialog', 'dialogClosed', 'started'].includes(t)),
    ['starting', 'dialog', 'dialogClosed', 'started'],
  )
  assert.equal(readJournal(journal).agents[0].state, 'done')
})

test("pi agents on the crew host finish with crew's submit tool: one's value reaches the script, and one whose payload pi rejected in the turn repairs it and its repaired value does (#174)", async () => {
  const cwd = join(root, 'submit-tool-repo')
  mkdirSync(cwd)
  const host = sessionHost(crewHost({ paths, env, cwd, harnesses: { claude: [process.execPath, FAKE_HARNESS], pi: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'submit-tool-state')
  const said = []
  const result = await runScript(fixture('submit-tool.workflow.js'), { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')
  assert.deepEqual(result, { first: 'tool', second: 'repaired' }, log)
  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const started = entries.filter((e) => e.type === 'started')
  assert.deepEqual(
    started.map((e) => e.harness),
    ['pi', 'pi'],
    JSON.stringify(started),
  )
  // No CLI submit: each settled on its tool call alone, pi's rejection never reaching the daemon.
  const toolResults = (label) => {
    const s = started.find((e) => e.dir.endsWith(`-${label}`))
    return readFileSync(transcriptPath({ harness: 'pi', sessionId: s.sessionId, worktree: s.worktree, env }), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).message)
      .filter((m) => m?.role === 'toolResult')
      .map((m) => [m.toolName, m.isError, m.content[0].text.split('\n')[0]])
  }
  assert.deepEqual(
    toolResults('caller').map(([name, isError]) => [name, isError]),
    [['submit', false]],
    log,
  )
  const repairs = toolResults('repairer')
  assert.deepEqual(
    repairs.map(([name, isError]) => [name, isError]),
    [
      ['submit', true],
      ['submit', false],
    ],
    log,
  )
  assert.equal(repairs[0][2], 'Validation failed for tool "submit":')
  assert.deepEqual(
    entries.filter((e) => ['continued', 'remedy', 'doctor'].includes(e.type)),
    [],
    log,
  )
})

test('a resubmit on the crew host: a node whose result needs decisions is held, its agent submits again through the CLI, and the script gets the value with no resume request', async () => {
  const cwd = join(root, 'resubmit-repo')
  mkdirSync(cwd)
  const host = sessionHost(crewHost({ paths, env, cwd, harnesses: { claude: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'resubmit-state')
  const said = []
  const halts = []
  const result = await runScript(fixture('resubmit.workflow.js'), { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd, onHalt: (h) => halts.push(h) })
  const log = said.join('\n')
  assert.deepEqual(result, { word: 'carried' }, log)
  assert.deepEqual(
    halts.map((h) => h.node),
    ['decide'],
    log,
  )
  assert.ok(!existsSync(join(stateDir, 'resume-request.json')), 'no resume request was written')
  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const results = entries.filter((e) => e.type === 'result')
  assert.deepEqual(
    results.map((e) => [!!e.needsDecision, !!e.resubmitted]),
    [
      [true, false],
      [false, true],
    ],
    log,
  )
  assert.deepEqual(
    entries.filter((e) => ['continued', 'remedy'].includes(e.type)),
    [],
    'its session was never continued',
  )
  assert.equal(entries.filter((e) => e.type === 'unhalted').length, 1)
})

test("a resubmit on the crew host through crew's submit tool: a held node's pi agent calls submit again, the daemon records its result, and the script gets the value with no resume request (#173, #174)", async () => {
  const cwd = join(root, 'resubmit-tool-repo')
  mkdirSync(cwd)
  const host = sessionHost(crewHost({ paths, env, cwd, harnesses: { pi: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'resubmit-tool-state')
  const said = []
  const halts = []
  const result = await runScript(fixture('resubmit-tool.workflow.js'), { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd, onHalt: (h) => halts.push(h) })
  const log = said.join('\n')
  assert.deepEqual(result, { word: 'carried' }, log)
  assert.deepEqual(
    halts.map((h) => h.node),
    ['decide'],
    log,
  )
  assert.ok(!existsSync(join(stateDir, 'resume-request.json')), 'no resume request was written')
  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  assert.deepEqual(
    entries.filter((e) => e.type === 'result').map((e) => [!!e.needsDecision, !!e.resubmitted, e.submissions]),
    [
      [true, false, 1],
      [false, true, undefined],
    ],
    log,
  )
  // Both through the tool, each accepted: no CLI submit, and the file the
  // runner took is the one the daemon's worker.submit wrote.
  const [started] = entries.filter((e) => e.type === 'started')
  const toolResults = readFileSync(transcriptPath({ harness: 'pi', sessionId: started.sessionId, worktree: started.worktree, env }), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).message)
    .filter((m) => m?.role === 'toolResult')
    .map((m) => [m.toolName, m.isError])
  assert.deepEqual(
    toolResults,
    [
      ['submit', false],
      ['submit', false],
    ],
    log,
  )
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, started.dir, 'result.json'), 'utf8')), { word: 'carried' })
  assert.deepEqual(
    entries.filter((e) => ['continued', 'remedy'].includes(e.type)),
    [],
    'its session was never continued',
  )
  assert.equal(entries.filter((e) => e.type === 'unhalted').length, 1)
})

// pi's tools from crew's extension, Claude's from crew's MCP server. Claude
// checks no arguments, so its bad submit is the daemon's to reject, as error
// content its agent repairs.
for (const [harness, prefix, ticket, answer, calls] of [
  [
    'pi',
    '',
    '#175',
    '[call submit {"word":"answered"}]',
    [
      ['status', false],
      ['needs_you', false],
      ['submit', false],
    ],
  ],
  [
    'claude',
    'claude-',
    '#177',
    '[call submit {"wrd":"oops"}] [call submit {"word":"answered"}]',
    [
      ['status', false],
      ['needs_you', false],
      ['submit', true],
      ['submit', false],
    ],
  ],
]) {
  test(`a ${harness} agent's note and needs-you on the crew host, from crew's tools: journaled, drawn on its row, never nudged while it needs you, and cleared by its submit (${ticket})`, async () => {
    const cwd = join(root, `${harness}-needs-you-repo`)
    mkdirSync(cwd)
    const host = sessionHost(crewHost({ paths, env, cwd, harnesses: { [harness]: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
    const stateDir = join(root, `${harness}-needs-you-state`)
    const journal = join(stateDir, 'journal.jsonl')
    const said = []
    // Without its needs-you, an agent idle this long is nudged within a second.
    const running = runScript(fixture(`${prefix}needs-you.workflow.js`), { host, stateDir, out: (s) => said.push(s), settings: { ...FAST, idleNudges: 1 }, transcripts: sessionTranscripts({ env }), project: cwd })
    const asker = () => {
      try {
        return readJournal(journal).agents[0] ?? null
      } catch {
        return null
      }
    }
    for (const until = Date.now() + 20_000; asker()?.state !== 'needs you'; await new Promise((done) => setTimeout(done, 50))) {
      if (Date.now() > until) assert.fail(`the agent never needed you: ${JSON.stringify(asker())}\n${said.join('\n')}`)
    }
    const view = runView({ stateDir, host, transcripts: sessionTranscripts({ env }) })
    await view.refresh()
    const W = 200
    const row = draw(view.model, { width: W, height: 30 })
      .lines.map(strip)
      .find((l) => /^ +1 +asker +\? needs you /.test(l))
    assert.ok(row, said.join('\n'))
    assert.equal(row.length, W)
    assert.match(row, / {3}reading the spec +$/)
    assert.equal(view.model.alert, `NEEDS YOU: [Ask] asker in tab ${asker().terminal}: Log in to the registry`)
    // Idle past the nudge grace, it is never nudged; the person then answers it in its session.
    await new Promise((done) => setTimeout(done, 3000))
    assert.equal(asker().state, 'needs you', said.join('\n'))
    const { request } = await import('../src/daemon/client.mjs')
    await request(paths, { op: 'session.write', id: asker().terminal, data: `Logged in. ${answer}` })
    await request(paths, { op: 'session.write', id: asker().terminal, data: '\r' })

    assert.deepEqual(await running, { word: 'answered' }, said.join('\n'))
    const entries = readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    assert.deepEqual(
      entries.filter((e) => ['note', 'needsYou', 'needsYouCleared', 'nudge', 'continued', 'result'].includes(e.type)).map((e) => [e.type, e.note ?? e.reason ?? null]),
      [
        ['note', 'reading the spec'],
        ['needsYou', 'Log in to the registry'],
        ['needsYouCleared', null],
        ['result', null],
      ],
      said.join('\n'),
    )
    assert.equal(readJournal(journal).agents[0].state, 'done')
    const [started] = entries.filter((e) => e.type === 'started')
    assert.equal(started.harness, harness)
    assert.deepEqual(
      toolResults(started).map(([name, isError]) => [name, isError]),
      calls,
      said.join('\n'),
    )
    // The tool is named first, the CLI line its fallback.
    const prompt = readFileSync(transcriptPath({ harness, sessionId: started.sessionId, worktree: started.worktree, env }), 'utf8')
    const tool = prompt.indexOf('If your session has a tool named `submit`, finish with it')
    assert.ok(tool !== -1 && tool < prompt.indexOf('submit.mjs'), 'the prompt names the tool before the CLI line')
  })
}

// ADR-0030, ADR-0021: a baseline command that cannot run is a blocker, and on
// the crew host the baseline agent clears it with the operator in its session.
test('a baseline that cannot run a command on the crew host: it needs you on its row, is never nudged while it does, and dispatch is held until it submits', async () => {
  const cwd = repo('baseline-needs-you-repo')
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'baseline-needs-you-state')
  const journal = join(stateDir, 'journal.jsonl')
  const said = []
  const running = runScript(fixture('baseline-needs-you.workflow.js'), { host, stateDir, out: (s) => said.push(s), settings: { ...FAST, idleNudges: 1 }, transcripts: sessionTranscripts({ env }), project: cwd })
  const agentOf = (label) => {
    try {
      return readJournal(journal).agents.find((a) => a.title?.includes(label)) ?? null
    } catch {
      return null
    }
  }
  const entries = () =>
    readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  for (const until = Date.now() + 20_000; agentOf('baseline:per-change')?.state !== 'needs you' || agentOf('explore:code paths')?.state !== 'done'; await new Promise((done) => setTimeout(done, 50))) {
    if (Date.now() > until) assert.fail(`the baseline never needed you beside a finished explorer: ${JSON.stringify([agentOf('baseline:per-change'), agentOf('explore:code paths')])}\n${said.join('\n')}`)
  }
  const baseline = () => agentOf('baseline:per-change')
  assert.ok(baseline().worktree && realpathSync(baseline().worktree) !== realpathSync(cwd), 'the baseline is in a worktree of its own')
  const view = runView({ stateDir, host, transcripts: sessionTranscripts({ env }) })
  await view.refresh()
  const row = draw(view.model, { width: 200, height: 30 })
    .lines.map(strip)
    .find((l) => / baseline:per-change +\? needs you /.test(l))
  assert.ok(row, `the baseline's row shows needs you:\n${said.join('\n')}`)
  assert.equal(view.model.alert, `NEEDS YOU: [Explore] baseline:per-change in tab ${baseline().terminal}: npm is not installed — evidence: npm test: command not found (exit 127); check: \`npm --version\``)

  // Past the nudge grace, with the explorer long done: never nudged, nothing dispatched.
  await new Promise((done) => setTimeout(done, 3000))
  assert.equal(baseline().state, 'needs you', said.join('\n'))
  assert.ok(!entries().some((e) => e.type === 'nudge'), 'never nudged while it needs you')
  assert.ok(!entries().some((e) => e.type === 'started' && e.title?.includes('dispatch:#101')), `dispatch is held while the baseline needs you:\n${said.join('\n')}`)

  const record = { command: 'npm test', exit_code: 0 }
  const { request } = await import('../src/daemon/client.mjs')
  await request(paths, { op: 'session.write', id: baseline().terminal, data: `Installed npm. [call submit ${JSON.stringify(record)}]` })
  await request(paths, { op: 'session.write', id: baseline().terminal, data: '\r' })

  assert.deepEqual(await running, { measured: record, note: 'notes', sized: 'one slice' }, said.join('\n'))
  const all = entries()
  const at = (type, label) => all.findIndex((e) => e.type === type && e.title?.includes(label))
  const ofBaseline = all.filter((e) => e.title?.includes('baseline:per-change'))
  assert.deepEqual(
    ofBaseline.filter((e) => ['needsYou', 'needsYouCleared', 'nudge', 'result'].includes(e.type)).map((e) => e.type),
    ['needsYou', 'needsYouCleared', 'result'],
    said.join('\n'),
  )
  assert.ok(at('result', 'baseline:per-change') < at('started', 'dispatch:#101'), `dispatch starts only after the baseline's submit:\n${said.join('\n')}`)
  assert.equal(baseline().state, 'done')
})

// The prompt a label's session was told in a run, from its transcript: the
// last session of exactly that label, else the first whose title holds it.
const promptsOf = (stateDir, log) => {
  const started = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'started')
  return (label) => {
    const s = started.findLast((e) => e.title?.endsWith(`] ${label}`)) ?? started.find((e) => e.title?.includes(label))
    assert.ok(s, `no agent ${label} started: ${started.map((e) => e.title).join(', ')}\n${log}`)
    return readFileSync(transcriptPath({ harness: s.harness, sessionId: s.sessionId, worktree: s.worktree, env }), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'user' && typeof e.message?.content === 'string')
      .map((e) => e.message.content)
      .join('\n')
  }
}

// The skill's own template, rendered as `crew start` renders it, run on the
// crew host: its prompts hold no [answer], so each agent's answer is keyed by
// its label (CREW_FAKE_ANSWERS). What a fake dispatcher copies out of the
// ticket's `## Validation` is what the implementer and the whole-stack review
// are told, word for word — the review each at-review command once, however
// many tickets list it and however they space it.
test("the skill's template on the crew host: a dispatcher's validation reaches the implementer's prompt verbatim, the union of every ticket's review_validation the whole-stack review's", async () => {
  const cwd = repo('template-repo')
  const perChange = ['cd packages/app && node --test test/test-a.mjs "test/b c.mjs"', "npm run lint -- --max-warnings=0 'src/**/*.js'"]
  const atReview = ['cd packages/app && npm test -- --coverage']
  const respaced = 'cd  packages/app &&  npm test -- --coverage '
  const e2e = 'npm run e2e'
  const checks = perChange.map((command) => ({ command, passed: true, exit_code: 0 }))
  const answers = join(root, 'template-answers.json')
  const slices = [{ title: 'all of it', brief: 'do it', effort: 'medium' }]
  const published = (n) => ({ published: true, pr_url: `https://github.com/acme/app/pull/${n + 100}`, pr_number: n + 100, checks, validated_sha: 'abc123', stack_link: 'registered' })
  writeFileSync(
    answers,
    JSON.stringify({
      '^graph': {
        tickets: [
          { number: 101, title: 'The ticket', blocked_by: [], needs_human: false, human_reason: '' },
          { number: 102, title: 'Another ticket', blocked_by: [101], needs_human: false, human_reason: '' },
        ],
      },
      // Agent dirs are slugged labels: `dispatch:#101` is `dispatch_101`.
      '^dispatch_101': { ticket_brief: 'the ticket in brief', validation: perChange, review_validation: atReview, slices },
      '^dispatch_102': { ticket_brief: 'another ticket in brief', validation: [perChange[0]], review_validation: [respaced, e2e], slices },
      '^impl_101': { branch: 'ticket/101', summary: 'done', checks, validated_sha: 'abc123' },
      '^impl_102': { branch: 'ticket/102', summary: 'done', checks, validated_sha: 'abc123' },
      '^gate': { checks, validated_sha: 'abc123' },
      '^publish_101': published(101),
      '^publish_102': published(102),
      '^finalize': { summary: 'stack ready' },
    }),
  )
  const script = renderWith({ REPO_DIR: cwd, NOTES_DIR: join(root, 'template-notes') })
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0', CREW_FAKE_ANSWERS: answers }, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'template-state')
  const said = []
  await runScript(script, { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const promptOf = promptsOf(stateDir, said.join('\n'))
  const impl = promptOf('impl:#101')
  for (const command of perChange) assert.ok(impl.includes(command), `the implementer is told ${command}`)
  for (const command of atReview) assert.ok(!impl.includes(command), `the implementer is not told the at-review ${command}`)
  const review = promptOf('review:spec-94')
  const listed = (command) => review.split('\n').filter((l) => l === `- \`${command}\``).length
  assert.equal(listed(atReview[0]), 1, `the whole-stack review is told ${atReview[0]} once:\n${review}`)
  assert.equal(listed(respaced), 0, 'the respaced copy is the same command')
  assert.equal(listed(e2e), 1, `the whole-stack review is told the second ticket's ${e2e}`)
})

// ADR-0030: the base pinned as `crew start` pins it, then origin/main moved
// before any ticket starts. Both tickets on the stack's bottom are still cut
// from the pinned sha; the one stacked on them from the tip's branch; and the
// second publish still replays onto the moved tip and re-runs the recipe.
test("the skill's template on the crew host: two tickets started after origin/<base> moved both cut from the pinned sha; a stacked one from the tip", async () => {
  const cwd = repo('pinned-repo')
  const git = (...args) => {
    const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=crew', '-c', 'user.email=crew@example.com', ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const origin = join(root, 'pinned-origin.git')
  assert.equal(spawnSync('git', ['init', '-q', '--bare', origin]).status, 0)
  git('branch', '-M', 'main')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main')
  const pinned = await pinBase({ repoDir: cwd, base: 'main', startRef: 'main' })
  assert.equal(pinned, git('rev-parse', 'main'))
  git('commit', '-q', '--allow-empty', '-m', 'main moves on')
  git('push', '-q', 'origin', 'HEAD:main')
  const moved = git('rev-parse', 'origin/main')
  assert.notEqual(moved, pinned)

  const validation = ['npm test']
  const checks = validation.map((command) => ({ command, passed: true, exit_code: 0 }))
  const slices = [{ title: 'all of it', brief: 'do it', effort: 'medium' }]
  const ticket = (n) => ({ ticket_brief: `#${n} in brief`, validation, review_validation: [], slices })
  const impl = (n) => ({ branch: `ticket/${n}`, summary: 'done', checks, validated_sha: 'abc123' })
  const published = (n) => ({ published: true, pr_url: `https://github.com/acme/app/pull/${n}`, pr_number: n, checks, validated_sha: 'abc123', stack_link: 'registered' })
  const answers = join(root, 'pinned-answers.json')
  writeFileSync(
    answers,
    JSON.stringify({
      '^graph': {
        tickets: [
          { number: 101, title: 'One', blocked_by: [], needs_human: false, human_reason: '' },
          { number: 102, title: 'Two', blocked_by: [], needs_human: false, human_reason: '' },
          { number: 103, title: 'Three', blocked_by: [101, 102], needs_human: false, human_reason: '' },
        ],
      },
      ...Object.fromEntries(
        [101, 102, 103].flatMap((n) => [
          [`^dispatch_${n}`, ticket(n)],
          [`^impl_${n}`, impl(n)],
          [`^publish_${n}`, published(n)],
        ]),
      ),
      '^gate': { checks, validated_sha: 'abc123' },
      '^finalize': { summary: 'stack ready' },
    }),
  )
  const script = renderWith({ REPO_DIR: cwd, NOTES_DIR: join(root, 'pinned-notes'), BASE_SHA: pinned })
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0', CREW_FAKE_ANSWERS: answers }, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'pinned-state')
  const said = []
  await runScript(script, { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const promptOf = promptsOf(stateDir, said.join('\n'))

  for (const n of [101, 102]) {
    const prompt = promptOf(`impl:#${n}`)
    assert.ok(prompt.includes(`git switch --detach ${pinned}\``), `#${n} is cut from the pinned sha:\n${prompt}`)
    assert.ok(!prompt.includes('git switch --detach origin/main'), `#${n} is not cut from the moving ref`)
  }
  const stackedOn = /git switch --detach (ticket\/10[12])`/.exec(promptOf('impl:#103'))
  assert.ok(stackedOn, `#103 is cut from the tip's branch:\n${promptOf('impl:#103')}`)
  assert.ok(!promptOf('impl:#103').includes(`git switch --detach ${pinned}`))
  const rebased = [101, 102].map((n) => promptOf(`publish:#${n}`)).filter((p) => p.includes('git rebase --onto ticket/'))
  const first = [101, 102].map((n) => promptOf(`publish:#${n}`)).find((p) => !p.includes('git rebase --onto ticket/'))
  assert.ok(first.includes(`git rev-parse origin/main\``) && first.includes(`git rebase --onto origin/main ${pinned}\``), `the first to publish checks origin/main against the pinned sha, which moved, and replays onto it:\n${first}`)
  assert.equal(rebased.length, 1, 'the second of the two to publish replays onto the first')
  assert.match(rebased[0], new RegExp(`git rebase --onto ticket/10[12] ${pinned}\``))
  assert.match(rebased[0], /The rebase produced a tree nobody has validated/)
  assert.ok(rebased[0].includes('npm test'), 'and re-runs the recipe')
})

// ADR-0030: whatever the graph agent asks to explore, the script starts the
// baseline agent beside the explorers, in a worktree of its own with the setup
// hook run, told the pinned sha and the per-change commands. Its record lands
// in the run folder before anything is dispatched, and a resume keeps it.
test("the skill's template on the crew host: the baseline runs beside the explorers in a set-up worktree of its own, its record is written before dispatch, and a resume keeps it", async () => {
  const cwd = repo('baseline-repo')
  const pinned = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const hook = join(root, 'baseline-setup.mjs')
  const setupLog = join(root, 'baseline-setup.log')
  writeFileSync(hook, `import { appendFileSync } from 'fs'\nappendFileSync(${JSON.stringify(setupLog)}, process.env.CREW_WORKTREE + '\\n')\n`)
  mkdirSync(env.CREW_HOME, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ repos: { [cwd]: { setup: hook } } }))

  const perChange = ['npm test', 'npm run lint -- --max-warnings=0']
  const checks = perChange.map((command) => ({ command, passed: true, exit_code: 0 }))
  const green = perChange.map((command) => ({ command, exit_code: 0, masked_command: '', failures: { tests: [], diagnostics: [] } }))
  const notesDir = join(root, 'baseline-notes')
  const answers = join(root, 'baseline-answers.json')
  writeFileSync(
    answers,
    JSON.stringify({
      // The explorer's turn is long enough for the baseline to start and finish inside it.
      '^graph': { tickets: [{ number: 101, title: 'One', blocked_by: [], needs_human: false, human_reason: '' }], explorations: [{ label: 'code paths', question: 'Where does it live? [turn 6000]' }] },
      '^explore': { path: join(notesDir, '01-code-paths.md') },
      '^baseline': { commands: green },
      '^dispatch_101': { ticket_brief: '#101 in brief', validation: perChange, review_validation: [], slices: [{ title: 'all of it', brief: 'do it', effort: 'medium' }] },
      '^impl_101': { branch: 'ticket/101', summary: 'done', checks, validated_sha: 'abc123' },
      '^gate': { checks, validated_sha: 'abc123' },
      '^publish_101': { published: true, pr_url: 'https://github.com/acme/app/pull/101', pr_number: 101, checks, validated_sha: 'abc123', stack_link: 'registered' },
      '^finalize': { summary: 'stack ready' },
    }),
  )
  const script = renderWith({ REPO_DIR: cwd, NOTES_DIR: notesDir, BASE_SHA: pinned, PER_CHANGE_COMMANDS: JSON.stringify(perChange) })
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0', CREW_FAKE_ANSWERS: answers }, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'baseline-state')
  const journalPath = join(stateDir, 'journal.jsonl')
  const said = []
  await runScript(script, { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')
  const entries = () =>
    readFileSync(journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const at = (type, label) => entries().findIndex((e) => e.type === type && e.title?.includes(label))

  assert.ok(at('started', 'baseline:per-change') < at('result', 'explore:code paths'), `the baseline starts while the explorer runs:\n${log}`)
  assert.ok(at('started', 'explore:code paths') < at('result', 'baseline:per-change'), `the explorer starts while the baseline runs:\n${log}`)
  assert.ok(at('result', 'baseline:per-change') < at('started', 'dispatch:#101'), `dispatch waits on the baseline:\n${log}`)

  const started = entries().find((e) => e.type === 'started' && e.title?.includes('baseline:per-change'))
  assert.equal(started.node, 'baseline/per-change')
  assert.ok(started.worktree && realpathSync(started.worktree) !== realpathSync(cwd), 'the baseline has a worktree of its own')
  assert.ok(
    readFileSync(setupLog, 'utf8')
      .trim()
      .split('\n')
      .map((p) => realpathSync(p))
      .includes(realpathSync(started.worktree)),
    'the setup hook ran in it',
  )
  assert.equal(realpathSync(entries().find((e) => e.type === 'started' && e.title?.includes('explore:code paths')).worktree), realpathSync(cwd), 'the explorer still runs in the checkout')

  const prompt = promptsOf(stateDir, log)('baseline:per-change')
  assert.ok(prompt.includes(`git switch --detach ${pinned}\``), `the baseline is told the pinned sha:\n${prompt}`)
  for (const command of perChange) assert.ok(prompt.includes(`- \`${command}\``), `the baseline is told ${command}`)
  assert.match(prompt, /Never a line number alone/)
  const impl = promptsOf(stateDir, log)('impl:#101')
  assert.ok(impl.includes(join(notesDir, 'pre-existing-failures.json')), 'the implementer is pointed at the record')
  for (const command of perChange) assert.ok(impl.includes(`- \`${command}\``), `nothing masked: the implementer is told ${command} as it is`)
  assert.ok(!impl.includes('Masked:'), 'and no unmasking rule')

  const record = join(notesDir, 'pre-existing-failures.json')
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { base_sha: pinned, commands: green }, 'a green base: every command exits 0 with no failures')

  // The schema the baseline submitted against, as submit checks it.
  const schema = JSON.parse(readFileSync(join(stateDir, started.dir, 'schema.json'), 'utf8'))
  const accepted = { commands: green, blockers: [], decisions_needed: [], worktree: started.worktree }
  assert.deepEqual(validate(schema, accepted), [])
  const red = (failures) => ({ ...accepted, commands: [{ ...green[0], exit_code: 1, failures }, green[1]] })
  assert.deepEqual(validate(schema, red({ tests: [{ id: 'test/a.mjs > adds' }], diagnostics: [{ tool: 'biome', rule: 'lint/style/useConst', file: 'src/a.js', snippet: 'let a = 1\n', message: 'use const' }] })), [])
  assert.notDeepEqual(validate(schema, red({ tests: [], diagnostics: [{ tool: 'biome', file: 'src/a.js', line: 12, message: 'use const' }] })), [], 'a diagnostic by line number alone is rejected')
  assert.notDeepEqual(validate(schema, { ...accepted, commands: [green[0]] }), [], 'a command left out is rejected')
  assert.notDeepEqual(validate(schema, { ...accepted, commands: [green[0], { ...green[1], command: 'npm run lint' }] }), [], 'a command not in the set is rejected')

  const view = runView({ stateDir, host, transcripts: sessionTranscripts({ env }) })
  await view.refresh()
  const node = view.model.phases.find((p) => p.name === 'Explore')?.agents.find((a) => a.label === 'baseline:per-change')
  assert.ok(node?.terminal, `the baseline is a node under Explore, entered by its session: ${JSON.stringify(view.model.phases.map((p) => [p.name, p.agents.map((a) => a.label)]))}`)

  rmSync(record)
  const resumed = []
  await runScript(script, { host, stateDir, out: (s) => resumed.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd, resume: true })
  assert.ok(resumed.includes('<< [Explore] baseline:per-change: replayed from the journal'), resumed.join('\n'))
  assert.ok(!entries().some((e) => e.type === 'started' && e.title?.includes('baseline:per-change')), 'the resume starts no worker to measure again')
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { base_sha: pinned, commands: green }, 'the record is written again from the kept result')
})

// ADR-0030: a baseline record with one command masked. Every role that runs
// the per-change recipe is told the masked command in the original's place,
// the record's path and the unmasking rule; the unmasked lint reaches each as
// it is. #101's gate reports the unmasked command, its implementer and fixer
// the masked one, and both satisfy readiness. #102's dispatcher drops the
// masked command; the gate's cross-check adds it back, and the next round is
// told it masked.
test("the skill's template on the crew host: a masked command replaces its original in every recipe a role is told, and readiness takes a check on either form", async () => {
  const cwd = repo('masked-repo')
  const pinned = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const unit = 'cd packages/app && node --test test/*.mjs'
  const masked = `${unit} --test-skip-pattern="adds two numbers"`
  const lint = 'npm run lint'
  const notesDir = join(root, 'masked-notes')
  const record = join(notesDir, 'pre-existing-failures.json')
  const none = { tests: [], diagnostics: [] }
  const ok = (...commands) => commands.map((command) => ({ command, passed: true, exit_code: 0 }))
  const slices = [{ title: 'all of it', brief: 'do it', effort: 'medium' }]
  const published = (n) => ({ published: true, pr_url: `https://github.com/acme/app/pull/${n}`, pr_number: n, checks: ok(masked, lint), validated_sha: 'abc123', stack_link: 'registered' })
  const finding = { severity: 'blocker', location: 'src/a.js:1', issue: 'wrong sum', fix: 'add them' }
  const answers = join(root, 'masked-answers.json')
  writeFileSync(
    answers,
    JSON.stringify({
      '^graph': {
        tickets: [
          { number: 101, title: 'One', blocked_by: [], needs_human: false, human_reason: '' },
          { number: 102, title: 'Two', blocked_by: [101], needs_human: false, human_reason: '' },
        ],
      },
      '^baseline': {
        commands: [
          { command: unit, exit_code: 1, masked_command: masked, failures: { tests: [{ id: 'test/a.mjs > adds two numbers' }], diagnostics: [] } },
          { command: lint, exit_code: 0, masked_command: '', failures: none },
        ],
      },
      '^dispatch_101': { ticket_brief: '#101 in brief', validation: [unit, lint], review_validation: [], slices },
      '^dispatch_102': { ticket_brief: '#102 in brief', validation: [lint], review_validation: [], slices },
      '^impl_101': { branch: 'ticket/101', summary: 'done', checks: ok(masked, lint), validated_sha: 'abc123' },
      '^impl_102': { branch: 'ticket/102', summary: 'done', checks: ok(masked, lint), validated_sha: 'abc123' },
      '^gate-fix_101_r1_dispatch': { slices: [{ title: 'the sum', brief: 'fix the sum', findings: [finding.location], effort: 'medium' }] },
      '^gate-fix_101_r1': { verdicts: [], checks: ok(masked, lint), validated_sha: 'def456' },
      '^gate_101_r1': { checks: ok(unit, lint), validated_sha: 'abc123', findings: [finding] },
      '^gate_101': { checks: ok(masked, lint), validated_sha: 'def456' },
      // Reported every round: once the recipe holds it, the run counts it present.
      '^gate_102': { checks: ok(masked, lint), validated_sha: 'abc123', missing_validation: [unit] },
      '^publish_101': published(101),
      '^publish_102': published(102),
      '^finalize': { summary: 'stack ready' },
    }),
  )
  const script = renderWith({ REPO_DIR: cwd, NOTES_DIR: notesDir, BASE_SHA: pinned, PER_CHANGE_COMMANDS: JSON.stringify([unit, lint]) })
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0', CREW_FAKE_ANSWERS: answers }, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'masked-state')
  const said = []
  const result = await runScript(script, { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')
  const promptOf = promptsOf(stateDir, log)
  const lines = (prompt) => prompt.split('\n')

  assert.ok(!/validation red/.test(log), `a check on either form is green:\n${log}`)
  assert.match(log, /#102 gate round 1: not ready — the recipe omits the ticket's /)
  assert.ok(!/#101 gate round \d: not ready/.test(log), `#101's gate checked the unmasked command, and that satisfies the masked line:\n${log}`)
  assert.equal(result.halted, false, JSON.stringify(result))
  assert.equal(result.stack_bottom_to_top.length, 2, 'both tickets publish')

  for (const label of ['impl:#101', 'gate-fix:#101:r1', 'gate:#101:r1', 'gate:#101:r2', 'publish:#101', 'impl:#102:r2', 'gate:#102:r1', 'publish:#102']) {
    const prompt = promptOf(label)
    assert.ok(lines(prompt).includes(`- \`${masked}\``), `${label} is told the masked command:\n${prompt}`)
    assert.ok(!lines(prompt).includes(`- \`${unit}\``), `${label} is not told the original as a recipe line`)
    assert.ok(lines(prompt).includes(`- \`${lint}\``), `${label} is told the unmasked lint as it is`)
    assert.ok(prompt.includes(`Research notes: ${notesDir}. What the recipe's commands already failed on at the run's pinned base: ${record}.`), `${label} is pointed at the record beside the notes`)
    assert.ok(prompt.includes(`\`${masked}\` is \`${unit}\` with the tests that already failed`) && prompt.includes('run the unmasked command in place of the masked one'), `${label} is told the unmasking rule`)
  }
  const first = promptOf('impl:#102')
  assert.ok(lines(first).includes(`- \`${lint}\``) && !first.includes(masked), "#102's first round runs only the dispatcher's copy")
  assert.match(promptOf('gate:#101:r1'), /A command shown above in its masked form stands for the ticket's unmasked one/)
})

// ADR-0030: a non-zero check judged pre-existing is a waived check. Readiness
// counts it green, so the ticket goes on to its gate with no re-dispatch; the
// gate reviewer, its HEAD on the validated sha, still re-runs it rather than
// inheriting it; and the publisher is told to list it, with its exit code,
// beside the provenance line. A check that omits its exit code is refused.
test("the skill's template on the crew host: a waived check counts green, the gate re-runs it rather than inheriting it, and the publisher lists it in the PR body", async () => {
  const cwd = repo('waived-repo')
  const pinned = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const perChange = ['npm test', 'npm run lint']
  const notesDir = join(root, 'waived-notes')
  const record = join(notesDir, 'pre-existing-failures.json')
  const lintRed = { tool: 'biome', rule: 'lint/style/useConst', file: 'src/a.js', snippet: 'let a = 1\n', message: 'use const' }
  const baseline = [
    { command: perChange[0], exit_code: 0, masked_command: '', failures: { tests: [], diagnostics: [] } },
    { command: perChange[1], exit_code: 1, masked_command: '', failures: { tests: [], diagnostics: [lintRed] } },
  ]
  const checks = [
    { command: perChange[0], passed: true, exit_code: 0 },
    { command: perChange[1], passed: true, exit_code: 1 },
  ]
  const answers = join(root, 'waived-answers.json')
  writeFileSync(
    answers,
    JSON.stringify({
      '^graph': { tickets: [{ number: 101, title: 'One', blocked_by: [], needs_human: false, human_reason: '' }] },
      '^baseline': { commands: baseline },
      '^dispatch_101': { ticket_brief: '#101 in brief', validation: perChange, review_validation: [], slices: [{ title: 'all of it', brief: 'do it', effort: 'medium' }] },
      '^impl_101': { branch: 'ticket/101', summary: 'done', checks, validated_sha: 'abc123' },
      '^gate': { checks, validated_sha: 'abc123' },
      '^publish_101': { published: true, pr_url: 'https://github.com/acme/app/pull/101', pr_number: 101, checks, validated_sha: 'abc123', stack_link: 'registered' },
      '^finalize': { summary: 'stack ready' },
    }),
  )
  const script = renderWith({ REPO_DIR: cwd, NOTES_DIR: notesDir, BASE_SHA: pinned, PER_CHANGE_COMMANDS: JSON.stringify(perChange) })
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0', CREW_FAKE_ANSWERS: answers }, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'waived-state')
  const said = []
  await runScript(script, { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')
  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const started = (label) => entries.filter((e) => e.type === 'started' && e.title?.includes(label))
  const promptOf = promptsOf(stateDir, log)

  const impl = promptOf('impl:#101')
  assert.ok(impl.includes(record), `the implementer judges a red against the record:\n${impl}`)
  assert.match(impl, /A zero exit is `passed: true`, with no judgement/)
  assert.match(impl, /only when every failure in its output is pre-existing/)

  assert.equal(started('impl:#101').length, 1, `the waived check counts green: no remainder, no second implementer:\n${log}`)
  assert.ok(!log.includes('validation red'), `nothing reads it red:\n${log}`)
  assert.equal(started('gate:#101').length, 1, 'one gate round')

  const gate = promptOf('gate:#101')
  assert.ok(gate.includes('validated green at `abc123` by the implementer'), `the gate may inherit by sha:\n${gate}`)
  assert.match(gate, /report every other check with `passed: true`, `exit_code` 0/)
  assert.ok(gate.includes('Never inherit a waived check: whatever your HEAD, re-run each one below'), `but not the waived one:\n${gate}`)
  assert.ok(gate.includes('- `npm run lint` exited 1'), 'the waived check is named with its exit code')
  assert.ok(!gate.includes('- `npm test` exited'), 'a green over exit 0 is inherited')

  const publish = promptOf('publish:#101')
  assert.ok(publish.includes('- `npm run lint` exited 1'), `the publisher re-runs it too:\n${publish}`)
  assert.ok(publish.includes('Directly under it, one line per waived check you return'), 'and lists it in the PR body beside the provenance line')
  assert.ok(publish.includes('`Waived: <command> exited <exit_code>`'))
  assert.ok(publish.includes('with none, add nothing'), 'a ticket with none lists nothing extra')
  assert.ok(log.includes('stacked #101'), `the ticket published:\n${log}`)

  // The schema the implementer submitted against, as submit checks it.
  const schema = JSON.parse(readFileSync(join(stateDir, started('impl:#101')[0].dir, 'schema.json'), 'utf8'))
  const accepted = { branch: 'ticket/101', summary: 'done', checks, validated_sha: 'abc123', unmet: [], decisions_needed: [], decided: [], worktree: cwd }
  assert.deepEqual(validate(schema, accepted), [])
  assert.notDeepEqual(validate(schema, { ...accepted, checks: [{ command: 'npm test', passed: true }] }), [], 'a check without its exit code is refused')
})

// ADR-0030: the at-review commands are measured in the background. Dispatch
// goes on from the per-change record while the at-review baseline is still
// held; the ticket publishes; only the whole-stack review waits, and starts
// once the at-review record has joined the per-change one. Its masked command
// reaches the review and the integration fixer in the original's place; a
// waived at-review check reaches the integration PR; a resume keeps both.
test("the skill's template on the crew host: dispatch does not wait on the at-review baseline, the whole-stack review does, and its record, masks and waivers reach the review and the integration PR", async () => {
  const cwd = repo('at-review-repo')
  const pinned = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const release = join(root, 'at-review-release')
  const unit = 'npm test'
  // The fake holds the at-review baseline's turn until the test writes `release`.
  const e2e = `npm run e2e -- --suite full [until ${release}]`
  const maskedE2e = `${e2e} --skip "checkout flow"`
  const typecheck = 'npm run typecheck:full'
  const typeRed = { tool: 'tsc', rule: 'TS2322', file: 'src/a.ts', snippet: 'const a: number = "1"\n', message: 'not assignable' }
  const perChangeRecord = [{ command: unit, exit_code: 0, masked_command: '', failures: { tests: [], diagnostics: [] } }]
  const atReviewRecord = [
    { command: e2e, exit_code: 1, masked_command: maskedE2e, failures: { tests: [{ id: 'e2e/checkout.spec.ts > checkout flow' }], diagnostics: [] } },
    { command: typecheck, exit_code: 2, masked_command: '', failures: { tests: [], diagnostics: [typeRed] } },
  ]
  const ok = (...commands) => commands.map((command) => ({ command, passed: true, exit_code: 0 }))
  const notesDir = join(root, 'at-review-notes')
  const record = join(notesDir, 'pre-existing-failures.json')
  const finding = { severity: 'major', location: 'src/a.js:1', issue: 'two sums', fix: 'one helper' }
  const answers = join(root, 'at-review-answers.json')
  writeFileSync(
    answers,
    JSON.stringify({
      '^graph': { tickets: [{ number: 101, title: 'One', blocked_by: [], needs_human: false, human_reason: '' }] },
      '^baseline.per': { commands: perChangeRecord },
      '^baseline.at': { commands: atReviewRecord },
      '^dispatch_101': { ticket_brief: '#101 in brief', validation: [unit], review_validation: [e2e, typecheck, unit], slices: [{ title: 'all of it', brief: 'do it', effort: 'medium' }] },
      '^impl_101': { branch: 'ticket/101', summary: 'done', checks: ok(unit), validated_sha: 'abc123' },
      '^gate': { checks: ok(unit), validated_sha: 'abc123' },
      '^publish_101': { published: true, pr_url: 'https://github.com/acme/app/pull/101', pr_number: 101, checks: ok(unit), validated_sha: 'abc123', stack_link: 'registered' },
      '^review': { checks: [...ok(maskedE2e, unit), { command: typecheck, passed: true, exit_code: 2 }], findings: [finding] },
      '^integration_dispatch': { slices: [{ title: 'one helper', brief: 'merge the sums', findings: [finding.location], effort: 'medium' }] },
      '^integration': { verdicts: [], checks: [...ok(unit, maskedE2e), { command: typecheck, passed: true, exit_code: 2 }], validated_sha: 'fed987' },
      '^publish_integration': { pr_url: 'https://github.com/acme/app/pull/102', pr_number: 102, branch: 'spec/94-integration' },
      '^finalize': { summary: 'stack ready' },
    }),
  )
  const script = renderWith({ REPO_DIR: cwd, NOTES_DIR: notesDir, BASE_SHA: pinned, PER_CHANGE_COMMANDS: JSON.stringify([unit]), AT_REVIEW_COMMANDS: JSON.stringify([e2e, typecheck, unit]) })
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0', CREW_FAKE_ANSWERS: answers }, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'at-review-state')
  const journalPath = join(stateDir, 'journal.jsonl')
  const said = []
  const running = runScript(script, { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const entries = () =>
    existsSync(journalPath)
      ? readFileSync(journalPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  const at = (type, label) => entries().findIndex((e) => e.type === type && e.title?.includes(label))

  for (const until = Date.now() + 60_000; at('result', 'publish:#101') < 0; await new Promise((done) => setTimeout(done, 50))) {
    if (Date.now() > until) assert.fail(`the ticket never published while the at-review baseline was held:\n${said.join('\n')}`)
  }
  assert.ok(at('result', 'baseline:per-change') < at('started', 'baseline:at-review'), `the at-review baseline starts after the per-change one:\n${said.join('\n')}`)
  assert.ok(at('started', 'baseline:at-review') >= 0 && at('result', 'baseline:at-review') < 0, 'it is still running once the ticket has published: dispatch, implementation and publish never waited on it')
  assert.equal(at('started', 'review:spec-94'), -1, 'the whole-stack review waits on it')
  const before = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(before, { base_sha: pinned, commands: perChangeRecord }, 'the record holds the per-change half meanwhile')

  writeFileSync(release, '')
  const result = await running
  const log = said.join('\n')
  assert.equal(result.halted, false, `${JSON.stringify(result)}\n${log}`)
  assert.ok(at('result', 'baseline:at-review') < at('started', 'review:spec-94'), `the review starts once the at-review baseline has succeeded:\n${log}`)
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { base_sha: pinned, commands: [...perChangeRecord, ...atReviewRecord] }, 'the at-review record joins the per-change one')
  assert.deepEqual(result.review_waived, [{ command: typecheck, exit_code: 2 }])

  const view = runView({ stateDir, host, transcripts: sessionTranscripts({ env }) })
  await view.refresh()
  const explore = view.model.phases.find((p) => p.name === 'Explore')?.agents.map((a) => a.label) ?? []
  assert.ok(explore.includes('baseline:per-change') && explore.includes('baseline:at-review'), `both measurements are nodes of the run tree: ${JSON.stringify(explore)}`)

  const promptOf = promptsOf(stateDir, log)
  const lines = (prompt) => prompt.split('\n')
  const measured = promptOf('baseline:at-review')
  for (const command of [e2e, typecheck]) assert.ok(lines(measured).includes(`- \`${command}\``), `the at-review baseline is told ${command}`)
  assert.ok(!lines(measured).includes(`- \`${unit}\``), 'but not a command the per-change baseline measured')
  for (const label of ['review:spec-94', 'integration']) {
    const prompt = promptOf(label)
    assert.ok(lines(prompt).includes(`- \`${maskedE2e}\``), `${label} is told the masked at-review command:\n${prompt}`)
    assert.ok(!lines(prompt).includes(`- \`${e2e}\``), `${label} is not told the original`)
    assert.ok(lines(prompt).includes(`- \`${typecheck}\``), `${label} is told the unmasked typecheck as it is`)
    assert.ok(prompt.includes(record) && /only when every failure in its output is pre-existing/.test(prompt), `${label} judges a red against the record`)
  }
  assert.match(promptOf('review:spec-94'), /A waived check is no finding/)
  const integration = promptOf('publish:integration')
  assert.ok(integration.includes('`Waived: <command> exited <exit_code>`'), `the integration PR lists waived checks:\n${integration}`)
  assert.ok(lines(integration).includes(`- \`${typecheck}\` exited 2`), 'the waived at-review check among them')
  assert.ok(!integration.includes(`\`${maskedE2e}\` exited`), 'a check green over exit 0 is not waived')

  rmSync(record)
  const resumed = []
  await runScript(script, { host, stateDir, out: (s) => resumed.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd, resume: true })
  for (const label of ['baseline:per-change', 'baseline:at-review']) assert.ok(resumed.includes(`<< [Explore] ${label}: replayed from the journal`), `${label} is kept:\n${resumed.join('\n')}`)
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { base_sha: pinned, commands: [...perChangeRecord, ...atReviewRecord] }, 'the record is written again, both halves, from the kept results')
})

// ADR-0030, ADR-0021: an at-review command that cannot run is a blocker, as in
// the per-change baseline. Every ticket still publishes; the run halts before
// the whole-stack review with the blocker named.
test("the skill's template on the crew host: an at-review baseline returning a blocker halts the run before the whole-stack review, naming it", async () => {
  const cwd = repo('at-review-blocked-repo')
  const pinned = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const unit = 'npm test'
  const e2e = 'npm run e2e'
  const blocker = { subject: 'no browser for e2e', tickets: [], why: 'the e2e suite drives a browser', evidence: 'npm run e2e: chromium not found (exit 1)', check: 'npx playwright --version' }
  const ok = (...commands) => commands.map((command) => ({ command, passed: true, exit_code: 0 }))
  const answers = join(root, 'at-review-blocked-answers.json')
  writeFileSync(
    answers,
    JSON.stringify({
      '^graph': { tickets: [{ number: 101, title: 'One', blocked_by: [], needs_human: false, human_reason: '' }] },
      '^baseline.per': { commands: [{ command: unit, exit_code: 0, masked_command: '', failures: { tests: [], diagnostics: [] } }] },
      '^baseline.at': { commands: [{ command: e2e, exit_code: 1, masked_command: '', failures: { tests: [], diagnostics: [] } }], blockers: [blocker] },
      '^dispatch_101': { ticket_brief: '#101 in brief', validation: [unit], review_validation: [e2e], slices: [{ title: 'all of it', brief: 'do it', effort: 'medium' }] },
      '^impl_101': { branch: 'ticket/101', summary: 'done', checks: ok(unit), validated_sha: 'abc123' },
      '^gate': { checks: ok(unit), validated_sha: 'abc123' },
      '^publish_101': { published: true, pr_url: 'https://github.com/acme/app/pull/101', pr_number: 101, checks: ok(unit), validated_sha: 'abc123', stack_link: 'registered' },
    }),
  )
  const script = renderWith({ REPO_DIR: cwd, NOTES_DIR: join(root, 'at-review-blocked-notes'), BASE_SHA: pinned, PER_CHANGE_COMMANDS: JSON.stringify([unit]), AT_REVIEW_COMMANDS: JSON.stringify([e2e]) })
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0', CREW_FAKE_ANSWERS: answers }, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'at-review-blocked-state')
  const said = []
  const result = await runScript(script, { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')
  assert.equal(result.halted, true, `${JSON.stringify(result)}\n${log}`)
  assert.match(result.reason, /the at-review baseline did not succeed, a blocker: no browser for e2e — evidence: npm run e2e: chromium not found \(exit 1\); check: `npx playwright --version`/)
  assert.deepEqual(result.blockers, [blocker])
  assert.deepEqual(result.published, ['#101: https://github.com/acme/app/pull/101'], 'every ticket published first')
  assert.match(log, /HALTED before Review — the at-review baseline did not succeed/)
  assert.ok(!readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').includes('review:spec-94'), 'no whole-stack review')
  assert.match(promptsOf(stateDir, log)('baseline:at-review'), /it is a \*\*blocker\*\*/)
})
