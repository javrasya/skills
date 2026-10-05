// A run on the crew host end to end, its runner in this process so its limits
// can be short: workers are the fake harness (fixtures/crew/fake-harness.mjs)
// in real ptys held by a real daemon under a scratch crew home, and their
// submit and mail go through the real agent-side commands, with no Orca.
// `crew run` itself, the runner as a crew session, is test-crew-bin.mjs's.
//   node packages/crew/test/test-crew-run.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runScript } from '../src/runner.mjs'
import { crewHost, crewWorktrees } from '../src/crew-host.mjs'
import { sessionHost } from '../src/session-host.mjs'
import { sessionTranscripts, transcriptPath } from '../src/transcript.mjs'
import { readJournal } from '../src/journal.mjs'
import { renderTemplate, templatePath } from '../src/arm.mjs'
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
  const checks = perChange.map((command) => ({ command, passed: true }))
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
  const template = readFileSync(templatePath(), 'utf8')
  const script = renderTemplate(template, { SPEC: 94, REPO: 'acme/app', REPO_DIR: cwd, NOTES_DIR: join(root, 'template-notes'), BASE_REF: 'main', START_REF: 'main', STACK_MODE: 'native', RUN_ORDER: 'parallel', RUNNER: 'session' })
  const fake = [process.execPath, FAKE_HARNESS]
  const host = sessionHost(crewHost({ paths, env: { ...env, CREW_FAKE_MCP: '0', CREW_FAKE_ANSWERS: answers }, cwd, harnesses: { claude: fake, pi: fake }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'template-state')
  const said = []
  await runScript(script, { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')

  const started = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'started')
  // The prompt a label's session was told, from its transcript.
  const promptOf = (label) => {
    const s = started.find((e) => e.title?.includes(label))
    assert.ok(s, `no agent ${label} started: ${started.map((e) => e.title).join(', ')}\n${log}`)
    return readFileSync(transcriptPath({ harness: s.harness, sessionId: s.sessionId, worktree: s.worktree, env }), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'user' && typeof e.message?.content === 'string')
      .map((e) => e.message.content)
      .join('\n')
  }
  const impl = promptOf('impl:#101')
  for (const command of perChange) assert.ok(impl.includes(command), `the implementer is told ${command}`)
  for (const command of atReview) assert.ok(!impl.includes(command), `the implementer is not told the at-review ${command}`)
  const review = promptOf('review:spec-94')
  const listed = (command) => review.split('\n').filter((l) => l === `- \`${command}\``).length
  assert.equal(listed(atReview[0]), 1, `the whole-stack review is told ${atReview[0]} once:\n${review}`)
  assert.equal(listed(respaced), 0, 'the respaced copy is the same command')
  assert.equal(listed(e2e), 1, `the whole-stack review is told the second ticket's ${e2e}`)
})
