// A run on the crew host end to end, its runner in this process so its limits
// can be short: workers are the fake harness (fixtures/crew/fake-harness.mjs)
// in real ptys held by a real daemon under a scratch crew home, and their
// submit and mail go through the real agent-side commands, with no Orca.
// `crew run` itself, the runner as a crew session, is test-crew-bin.mjs's.
//   node packages/crew/test/test-crew-run.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { runScript } from '../src/runner.mjs'
import { crewHost, crewWorktrees } from '../src/crew-host.mjs'
import { sessionHost } from '../src/session-host.mjs'
import { sessionTranscripts } from '../src/transcript.mjs'
import { readJournal } from '../src/journal.mjs'
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

test('a doctor round on the crew host: the patient dies, its doctor hands off a note, and the patient carries on with it', async () => {
  const cwd = repo()
  const host = sessionHost(crewHost({ paths, env, cwd, harnesses: { claude: [process.execPath, FAKE_HARNESS] }, quietMs: 300, readyMs: 20_000, pollMs: 50 }))
  const stateDir = join(root, 'state')
  const said = []
  const result = await runScript(fixture('doctor-round.workflow.js'), { host, stateDir, out: (s) => said.push(s), settings: FAST, transcripts: sessionTranscripts({ env }), project: cwd })
  const log = said.join('\n')
  assert.deepEqual(result, { patient: 'the note carried it on' }, log)

  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
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
  const entries = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const [doctor] = entries.filter((e) => e.type === 'doctor')
  const started = entries.filter((e) => e.type === 'started')
  assert.deepEqual(started.filter((e) => e.n !== doctor.doctor).map((e) => e.worktree), [chain, chain], JSON.stringify(started))
  assert.equal(started.find((e) => e.n === doctor.doctor)?.worktree, join(crewWorktrees(cwd), `${fold.run.runId}-${doctor.doctor}`))
  assert.deepEqual(readFileSync(setupLog, 'utf8').trim().split('\n').map((p) => realpathSync(p)), [realpathSync(chain)], 'the setup hook ran once, in the chain worktree, never in the doctor\'s')
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
  assert.ok(said.some((l) => l.startsWith('?? [Trust] asker: Claude asks whether to trust this folder')), said.join('\n'))
  const { request } = await import('../src/daemon/client.mjs')
  const { sessions } = await request(paths, { op: 'session.list' })
  const session = sessions.find((s) => s.id === a.terminal)
  assert.deepEqual([session?.alive, realpathSync(session.cwd)], [true, cwd], 'the dialog is in a live session, started in the project')
  // The person enters the session and trusts the folder.
  await request(paths, { op: 'session.write', id: a.terminal, data: '\x1b[B' })
  await request(paths, { op: 'session.write', id: a.terminal, data: '\r' })
  assert.deepEqual(await running, { word: 'trusted' }, said.join('\n'))
  const types = readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type)
  assert.deepEqual(types.filter((t) => ['starting', 'dialog', 'dialogClosed', 'started'].includes(t)), ['starting', 'dialog', 'dialogClosed', 'started'])
  assert.equal(readJournal(journal).agents[0].state, 'done')
})
