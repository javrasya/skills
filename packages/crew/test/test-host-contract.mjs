// The host contract suite: one set of session host scenarios, each run on the
// in-memory fake host (fake-orca.mjs) and on the crew host (crew-host.mjs),
// whose workers are the fake harness (fixtures/crew/fake-harness.mjs) in real
// ptys held by a real daemon under a scratch crew home. Through the crew
// adapter it also covers the daemon's client protocol, which that adapter is
// the only client of. The Orca adapter (orca-cli.mjs) runs the worktree
// scenarios, a host's `scenarios`, against Orca's CLI played offline
// (fake-orca.mjs's fakeOrcaCli): it has no worker to play the rest. A scenario is { name, run(h) }, h being what a host's
// open() gives: { host, stopped(w), dead(w), title(w) }, `w` a started
// worker; one that needs more of a host adds it to both HOSTS: ids(w), the
// IDs a worker's preamble gave it; send(ids, message) and submit(ids, files),
// a worker's own `orchestration send` and submit (on crew the real agent-side
// commands, run with no Orca there); other(), the same host as another
// coordinator; status(path) and removed(path), what it holds of a worktree,
// and setups(path), how often a setup hook ran in it.
// Every worker starts into a run the host made (runOf). Words in a
// prompt script the worker's turn, as fake-harness.mjs reads them ([turn
// <ms>], [spin <ms>], [draw], [unrecorded], [die]); the fake host's workers
// play them too.
//   node packages/crew/test/test-host-contract.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fakeOrca, fakeOrcaCli } from '../src/fake-orca.mjs'
import { orcaCli } from '../src/orca-cli.mjs'
import { PI_EXTENSION, claudeSettings, crewHost, crewWorktrees } from '../src/crew-host.mjs'
import { repoConfig } from '../src/crew-config.mjs'
import { CREW_ONLY, RUN_METHODS, SESSION_METHODS, hostUnreachable } from '../src/session-host.mjs'
import { reclaimAgent } from '../src/reclaim.mjs'
import { hostOutage } from '../src/outage.mjs'
import { realClock } from '../src/runner.mjs'
import { openHost } from '../src/hosts.mjs'
import { launchCommand, resumeCommand } from '../src/harness.mjs'
import { RUNNER_SETTINGS } from '../src/settings.mjs'
import { sessionTranscripts, transcriptPath } from '../src/transcript.mjs'
import { worktreeName } from '../src/git.mjs'
import { submit } from '../src/submit.mjs'
import { SUBMIT } from '../src/lifecycle.mjs'
import { crewPaths } from '../src/daemon/transport.mjs'
import { request, stopDaemon } from '../src/daemon/client.mjs'
import { startDaemon } from '../src/daemon/daemon.mjs'
import crewPi from '../src/hooks/crew-pi.mjs'
import { tool } from '../src/tools.mjs'

const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/crew/fake-harness.mjs', import.meta.url))
const CREW_BIN = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url))
// What a setup hook leaves in a new worktree, on both hosts.
const SETUP_LEAVES = ['?? setup.out']

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function eventually(what, check, ms = 15_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

// One scratch crew home and daemon for every crew scenario. The run's
// worktree is a git repo whose per-repo config in that home names a setup
// hook, which writes setup.out and logs the worktree it ran in to
// setup-runs.log, or fails when its environment says so.
const homes = []
after(async () => {
  for (const paths of homes) await stopDaemon(paths, { force: true }).catch(() => {})
})
let crew = null
function crewScratch() {
  if (crew) return crew
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-contract-')))
  const env = { ...process.env, CREW_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PI_CODING_AGENT_SESSION_DIR: join(root, 'pi') }
  const paths = crewPaths(env)
  homes.push(paths)
  const cwd = join(root, 'worktree')
  mkdirSync(cwd)
  const git = (...args) => assert.equal(spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`)
  git('init', '-q')
  writeFileSync(join(cwd, 'README.md'), 'contract\n')
  git('add', 'README.md')
  git('-c', 'user.name=contract', '-c', 'user.email=contract@example.com', 'commit', '-q', '-m', 'init')
  const hook = join(root, 'setup-hook.mjs')
  const setupLog = join(root, 'setup-runs.log')
  writeFileSync(
    hook,
    `import { appendFileSync, writeFileSync } from 'fs'\nif (process.env.FAIL_SETUP) { console.error('setup refused'); process.exit(4) }\nif (process.env.BREAK_STATUS) writeFileSync('.git', 'gitdir: /no/such/gitdir\\n')\nwriteFileSync('setup.out', \`\${process.env.CREW_REPO}\\n\${process.env.CREW_WORKTREE}\\n\`)\nappendFileSync(${JSON.stringify(setupLog)}, \`\${process.env.CREW_WORKTREE}\\n\`)\n`,
  )
  mkdirSync(paths.home, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ repos: { [cwd]: { setup: hook } } }))
  // The agent-side commands' environment: crew's, with any Orca out of reach.
  const agentEnv = { ...env, CREW_HOST: 'crew', CREW_HOME: paths.home, ORCA_BIN: join(root, 'no-such-orca') }
  crew = { root, env, paths, cwd, agentEnv, setupLog }
  return crew
}
const scratchDir = () => mkdtempSync(join(crewScratch().root, 'files-'))
const harnessAs = (argv) => ({ claude: argv, pi: argv })

// A fake-host worker's turn, as the fake harness plays it: busy for the turn,
// idle after it, or exited mid-turn.
async function fakeTurn(text, state) {
  if (/\[die\]/.test(text)) {
    state.exited = true
    return
  }
  state.idle = false
  await sleep(Number(/\[(?:turn|spin) (\d+)\]/.exec(text)?.[1] ?? 0))
  state.idle = true
}
async function fakeWorker({ prompt, state }) {
  state.onNudge = (text) => {
    fakeTurn(text, state)
  }
  state.onContinue = ({ text }) => fakeTurn(text, state)
  await fakeTurn(prompt, state)
}

// A worker's submit files: a payload valid against its schema.
function submitFiles() {
  const dir = scratchDir()
  const files = { schema: join(dir, 'schema.json'), payload: join(dir, 'payload.json'), result: join(dir, 'result.json') }
  writeFileSync(files.schema, JSON.stringify({ type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }))
  writeFileSync(files.payload, JSON.stringify({ ok: true }))
  return files
}
const submitArgs = (ids, f) => ['--schema', f.schema, '--result', f.result, '--payload', f.payload, '--from', ids.from, '--dispatch-capability', ids.capability, '--task-id', ids.taskId, '--dispatch-id', ids.dispatchId]
const sendArgs = (ids, m) => ['--from', ids.from, '--dispatch-capability', ids.capability, '--task-id', ids.taskId, '--dispatch-id', ids.dispatchId, '--type', m.type, '--subject', m.subject, '--body', m.body, ...(m.outcome ? ['--outcome', m.outcome] : [])]

const HOSTS = [
  {
    name: 'fake',
    open() {
      const orca = fakeOrca({ worker: fakeWorker, setupLeaves: SETUP_LEAVES })
      const d = (w) => orca.dispatches.get(w.dispatchId)
      return {
        host: orca,
        stopped: async (w) => d(w)?.stopped === true,
        dead: async (w) => d(w)?.exited === true,
        title: async (w) => d(w)?.tabTitle,
        ids: async (w) => ({ from: d(w).handle, capability: d(w).capability, taskId: d(w).taskId, dispatchId: d(w).dispatchId }),
        send: (ids, m) => orca.mailSend({ ...ids, ...m }),
        submit: (ids, f) => submit(submitArgs(ids, f), { host: orca, stdout: () => {}, stderr: () => {} }),
        other: () => orca.as('term_other'),
        status: async (path) => orca.worktrees.get(path)?.status ?? null,
        removed: async (path) => orca.worktrees.get(path)?.removed === true,
        setups: async (path) => orca.calls.filter((c) => c.verb === 'worktreeCreate' && c.worktree === path && c.setup !== 'skip').length,
      }
    },
  },
  {
    name: 'crew',
    open({ harness = [process.execPath, FAKE_HARNESS], env: extra = {}, readyMs = 20_000 } = {}) {
      const { env, paths, cwd, agentEnv, setupLog } = crewScratch()
      const make = () => crewHost({ paths, env: { ...env, ...extra }, cwd, harnesses: harnessAs(harness), quietMs: 300, readyMs })
      const info = async (w) => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === w.terminal)
      const ended = async (w) => (await info(w))?.alive === false
      // As the worker reads them: from its preamble, in its session's transcript.
      const ids = async (w) => {
        const text = await eventually('the preamble in the transcript', () => {
          const path = transcriptPath({ harness: 'claude', sessionId: w.sessionId, worktree: w.worktree, env })
          return path && existsSync(path) && /--dispatch-id/.test(readFileSync(path, 'utf8')) && readFileSync(path, 'utf8')
        })
        const [, from, capability, taskId, dispatchId] = /--from ([\w-]+) --dispatch-capability ([\w-]+) --task-id ([\w-]+) --dispatch-id ([\w-]+)/.exec(text)
        return { from, capability, taskId, dispatchId }
      }
      const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', env: agentEnv })
      return {
        host: make(),
        paths,
        stopped: ended,
        dead: ended,
        title: async (w) => (await info(w))?.title,
        info,
        ids,
        async send(ids, m) {
          const r = run([CREW_BIN, 'orchestration', 'send', ...sendArgs(ids, m)])
          if (r.status !== 0) throw new Error(r.stderr)
          return { id: /(msg_\S+)/.exec(r.stdout)[1] }
        },
        submit: async (ids, f) => run([SUBMIT, ...submitArgs(ids, f)]).status,
        other: make,
        status: async (path) => (await request(paths, { op: 'worktree.statuses' })).statuses[resolve(path)] ?? null,
        removed: async (path) => !existsSync(path),
        setups: async (path) =>
          existsSync(setupLog)
            ? readFileSync(setupLog, 'utf8')
                .split('\n')
                .filter((l) => l && resolve(l) === resolve(path)).length
            : 0,
      }
    },
  },
  {
    name: 'orca',
    scenarios: /^(child|chain) worktree:/,
    open() {
      const cli = fakeOrcaCli({ setupLeaves: SETUP_LEAVES })
      return {
        host: orcaCli({ call: cli.call, git: cli.git }),
        stopped: async (w) => cli.dispatches.get(w.dispatchId)?.stopped === true,
        status: async (path) => cli.worktrees.get(path)?.status ?? null,
        removed: async (path) => cli.worktrees.get(path)?.removed === true,
        setups: async (path) => cli.worktrees.get(path)?.setups ?? 0,
      }
    },
  },
]

// The run every worker of `h` starts into, made by the host the first time.
const runOf = async (h) => (h.runId ??= (await h.host.runCreate({ objective: 'host contract' })).runId)
const shown = async (h, w) => {
  const { settled, outcome, gone, exited, terminal } = await h.host.workerShow({ dispatch: w.dispatchId })
  return { settled, outcome, gone, exited, terminal }
}
const child = (name, extra = {}) => ({ name, displayName: name, retry: false, dispatched: false, baseline: null, ...extra })

async function start(h, title, launch = {}) {
  const sessionId = randomUUID()
  const { prompt = `Contract prompt for ${title}.`, ...rest } = launch
  const run = await runOf(h)
  const w = await h.host.workerStart({ run, prompt, title, harness: 'claude', sessionId, ...rest })
  return { ...w, run, sessionId, prompt }
}
const delivered = (h, w, needle) => h.host.promptDelivered({ harness: 'claude', sessionId: w.sessionId, worktree: w.worktree, needle })
const idle = (h, w, timeoutMs = 0) => h.host.terminalIdle({ terminal: w.terminal, timeoutMs })
// Longer than the crew host's quiet-output threshold in this suite.
const PAST_QUIET = 800
async function died(h, title) {
  const w = await start(h, title, { prompt: `Contract prompt for ${title}. [die]` })
  await eventually('the harness dead', () => h.dead(w))
  const next = await h.host.workerContinue({ run: w.run, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title, prompt: 'Carry on from where you stopped.', harness: 'claude', sessionId: w.sessionId, reopen: false })
  return { w, next: { ...next, sessionId: w.sessionId } }
}

export const SCENARIOS = [
  {
    name: "start: the harness runs with the runner's session id, in a terminal of its own, and gets its prompt",
    async run(h) {
      const w = await start(h, 'start')
      assert.equal(typeof w.terminal, 'string')
      assert.equal(typeof w.dispatchId, 'string')
      assert.ok(Array.isArray(w.warnings))
      assert.ok((await h.host.terminalList()).includes(w.terminal))
      await eventually('the prompt in the session', () => delivered(h, w, w.prompt))
      await assert.rejects(h.host.workerStart({ run: w.run, prompt: 'x', title: 'no session id', harness: 'claude' }), /session id/)
    },
  },
  {
    name: 'send: text typed to the session, line breaks and all, is confirmed delivered from its transcript',
    async run(h) {
      const w = await start(h, 'send')
      await eventually('the start prompt', () => delivered(h, w, w.prompt))
      const text = 'A nudge from the runner.\nIts second line.'
      assert.equal(await delivered(h, w, text), false)
      await h.host.terminalSend({ terminal: w.terminal, text })
      await eventually('the nudge in the session', () => delivered(h, w, text))
      assert.equal(await delivered(h, w, 'never typed'), false)
    },
  },
  {
    name: 'screen: the last rows the terminal renders now, as lines of text',
    async run(h) {
      const w = await start(h, 'screen')
      await eventually('the start prompt', () => delivered(h, w, w.prompt))
      const screen = await eventually('the input line', async () => {
        const s = await h.host.terminalScreen({ terminal: w.terminal, lines: 3 })
        // The input row: last, or, in Claude's input box, above its bottom rule.
        return s.slice(-2).some((l) => l.startsWith('❯')) && s
      })
      assert.ok(screen.length <= 3)
      assert.ok(screen.every((l) => typeof l === 'string' && l === l.trimEnd()))
    },
  },
  {
    name: 'idle, from the transcript: busy through its turn however quiet its terminal, idle once the turn ends however much it still draws',
    async run(h) {
      const w = await start(h, 'idle transcript', { prompt: 'Contract prompt for idle transcript. [draw] [turn 3000]' })
      await eventually('the prompt in the session', () => delivered(h, w, w.prompt))
      await sleep(PAST_QUIET)
      assert.equal(await idle(h, w), false, 'a turn going is not idle')
      await eventually('idle once the turn ends', () => idle(h, w, 1_000))
    },
  },
  {
    name: 'idle, from quiet output: with no transcript to say, busy while its terminal draws and idle once it goes quiet',
    async run(h) {
      const w = await start(h, 'idle quiet', { prompt: 'Contract prompt for idle quiet. [unrecorded] [spin 3000]' })
      await sleep(PAST_QUIET)
      assert.equal(await delivered(h, w, 'never typed'), false)
      assert.equal(await idle(h, w), false, 'a terminal drawing is not idle')
      await eventually('idle once quiet', () => idle(h, w, 1_000))
    },
  },
  {
    name: 'continue: a session whose harness died mid-turn carries on, its transcript and all, with the continue prompt',
    async run(h) {
      const { w, next } = await died(h, 'continue')
      assert.equal(typeof next.terminal, 'string')
      assert.equal(typeof next.dispatchId, 'string')
      assert.ok((await h.host.terminalList()).includes(next.terminal))
      await eventually('the continue prompt in the session', () => delivered(h, next, 'Carry on from where you stopped.'))
      assert.ok(await delivered(h, next, w.prompt), "the turn it died in is still its session's")
      await eventually('idle once the continued turn ends', () => idle(h, next, 1_000))
      assert.equal(await h.dead(next), false)
    },
  },
  {
    name: 'stop: the worker stops, and its terminal stays until closed',
    async run(h) {
      const w = await start(h, 'stop')
      await h.host.workerStop({ dispatch: w.dispatchId })
      await eventually('the worker stopped', () => h.stopped(w))
      assert.ok((await h.host.terminalList()).includes(w.terminal))
      await h.host.terminalClose({ terminal: w.terminal })
    },
  },
  {
    name: 'list and close: every open terminal is listed; a closed one is gone and takes no input',
    async run(h) {
      const a = await start(h, 'list a')
      const b = await start(h, 'list b')
      const open = await h.host.terminalList()
      assert.ok(open.includes(a.terminal) && open.includes(b.terminal))
      await h.host.terminalClose({ terminal: a.terminal })
      const now = await h.host.terminalList()
      assert.ok(!now.includes(a.terminal))
      assert.ok(now.includes(b.terminal))
      await assert.rejects(h.host.terminalClose({ terminal: a.terminal }))
      await assert.rejects(h.host.terminalSend({ terminal: a.terminal, text: 'anyone there?' }))
    },
  },
  {
    name: 'rename: the terminal takes the title the runner sets',
    async run(h) {
      const w = await start(h, 'rename')
      await h.host.terminalRename({ terminal: w.terminal, title: 'impl_97 (running)' })
      assert.equal(await h.title(w), 'impl_97 (running)')
      await assert.rejects(h.host.terminalRename({ terminal: 'no-such-terminal', title: 'x' }))
    },
  },
  {
    name: 'run: the host makes the run id; a take-over binds the run and its unacknowledged mail to the new coordinator and fences the old',
    async run(h) {
      const run = await runOf(h)
      assert.equal(typeof run, 'string')
      const w = await start(h, 'run')
      assert.equal(w.run, run)
      const ids = await h.ids(w)
      await h.send(ids, { type: 'handoff', subject: 'note', body: 'before the take-over' })
      const batch = await h.host.mailCheck()
      const other = h.other()
      assert.equal((await other.runUse({ runId: run })).runId, run)
      const taken = await other.mailCheck()
      assert.deepEqual(
        taken.messages.map((m) => m.id),
        batch.messages.map((m) => m.id),
      )
      assert.equal((await h.host.mailCheck()).deliveryId, null, 'the old coordinator reads no run')
      await assert.rejects(start(h, 'fenced'), /consumer_fenced/)
      await assert.rejects(other.runUse({ runId: 'run_nosuch' }), /run_not_found/)
    },
  },
  {
    name: "worker show and submit: live until submit's worker_done settles it succeeded, which the mailbox then holds; submit with IDs not its own fails",
    async run(h) {
      const w = await start(h, 'show')
      assert.deepEqual(await shown(h, w), { settled: false, outcome: null, gone: false, exited: false, terminal: w.terminal })
      const ids = await h.ids(w)
      const files = submitFiles()
      assert.equal(await h.submit({ ...ids, taskId: 'task_not_its_own' }, files), 3)
      assert.equal((await shown(h, w)).settled, false)
      assert.equal(await h.submit(ids, files), 0)
      assert.deepEqual(JSON.parse(readFileSync(files.result, 'utf8')), { ok: true })
      assert.deepEqual(await shown(h, w), { settled: true, outcome: 'succeeded', gone: false, exited: false, terminal: w.terminal })
      const { messages } = await h.host.mailCheck()
      const done = messages.filter((m) => m.type === 'worker_done')
      assert.equal(done.length, 1)
      assert.equal(done[0].dispatchId, w.dispatchId)
      assert.equal(done[0].taskId, ids.taskId)
      assert.equal(done[0].outcome, 'succeeded')
    },
  },
  {
    name: 'worker show: a stopped worker is settled cancelled, a dead harness has exited unsettled, and a closed terminal is gone unsettled',
    async run(h) {
      const stopped = await start(h, 'show stopped')
      await h.host.workerStop({ dispatch: stopped.dispatchId })
      await eventually('the worker stopped', () => h.stopped(stopped))
      const s0 = await shown(h, stopped)
      assert.deepEqual([s0.settled, s0.outcome, s0.gone], [true, 'cancelled', false])
      const dead = await start(h, 'show dead', { prompt: 'Contract prompt for show dead. [die]' })
      await eventually('the harness dead', () => h.dead(dead))
      assert.deepEqual(await shown(h, dead), { settled: false, outcome: null, gone: false, exited: true, terminal: dead.terminal })
      const closed = await start(h, 'show closed')
      await h.host.terminalClose({ terminal: closed.terminal })
      const s = await shown(h, closed)
      assert.equal(s.gone, true)
      assert.equal(s.settled, false)
      await assert.rejects(h.host.workerShow({ dispatch: 'no-such-dispatch' }), /dispatch_not_found/)
    },
  },
  {
    name: "mailbox: a worker's handoff and escalation wait in order until checked; a batch comes back replayed until acknowledged, and the ack answers the next",
    async run(h) {
      const w = await start(h, 'mail')
      const ids = await h.ids(w)
      assert.equal((await h.host.mailCheck()).deliveryId, null)
      await h.send(ids, { type: 'handoff', subject: 'note', body: 'the note' })
      await h.send(ids, { type: 'escalation', subject: 'Blocked: login', body: 'log in to the registry' })
      const first = await h.host.mailCheck()
      assert.equal(typeof first.deliveryId, 'string')
      assert.equal(first.replayed, false)
      assert.deepEqual(
        first.messages.map((m) => [m.type, m.subject, m.body, m.dispatchId, m.taskId, m.outcome]),
        [
          ['handoff', 'note', 'the note', w.dispatchId, ids.taskId, null],
          ['escalation', 'Blocked: login', 'log in to the registry', w.dispatchId, ids.taskId, null],
        ],
      )
      const again = await h.host.mailCheck()
      assert.equal(again.deliveryId, first.deliveryId)
      assert.equal(again.replayed, true)
      assert.deepEqual(
        again.messages.map((m) => m.id),
        first.messages.map((m) => m.id),
      )
      await h.send(ids, { type: 'worker_done', subject: 'gave up', body: 'nothing to be done', outcome: 'failed' })
      const next = await h.host.mailCheck({ ack: first.deliveryId })
      assert.equal(next.acknowledged, first.deliveryId)
      assert.notEqual(next.deliveryId, first.deliveryId)
      assert.deepEqual(
        next.messages.map((m) => [m.type, m.outcome]),
        [['worker_done', 'failed']],
      )
      assert.deepEqual(await shown(h, w), { settled: true, outcome: 'failed', gone: false, exited: false, terminal: w.terminal })
      await assert.rejects(h.host.mailCheck({ ack: 'delivery_nosuch' }), /stale_delivery/)
      const last = await h.host.mailCheck({ ack: next.deliveryId })
      assert.equal(last.deliveryId, null)
      assert.deepEqual(last.messages, [])
      await assert.rejects(h.send({ ...ids, taskId: 'task_not_its_own' }, { type: 'handoff', subject: 'note', body: 'x' }), /consumer_fenced/)
    },
  },
  {
    name: "child worktree: named <runId>-<n>, its setup hook's output in its baseline and none with skip; its status set, and removed with its terminal",
    async run(h) {
      const run = await runOf(h)
      const baselines = []
      const w = await start(h, 'child', { prompt: (b) => `Contract prompt for child, baseline ${JSON.stringify(b)}.`, child: child(`${run}-1`, { onBaseline: (b) => baselines.push(b) }) })
      assert.equal(worktreeName(w.worktree), `${run}-1`)
      assert.deepEqual(baselines, [{ worktree: w.worktree, lines: SETUP_LEAVES }])
      const skipped = await start(h, 'doctor', { child: child(`${run}-2`, { setup: 'skip', onBaseline: (b) => baselines.push(b) }) })
      assert.deepEqual(baselines.at(-1), { worktree: skipped.worktree, lines: [] })
      await h.host.worktreeStatus({ worktree: w.worktree, status: 'in-progress' })
      assert.equal(await h.status(w.worktree), 'in-progress')
      await assert.rejects(h.host.worktreeStatus({ worktree: join(dirname(w.worktree), 'nope'), status: 'todo' }), /selector_not_found/)
      await h.host.worktreeRemove({ path: w.worktree })
      assert.equal(await h.removed(w.worktree), true)
      assert.ok(!(await h.host.terminalList()).includes(w.terminal), 'its terminal went with it')
      await assert.rejects(h.host.worktreeRemove({ path: w.worktree }), /selector_not_found/)
    },
  },
  {
    name: "chain worktree: made once as <runId>-chain, its setup hook run once and its output its baseline; workers start in it one after another, a child beside it is made as ever, and a doctor's with setup skipped; reclaimed, it is made again, its hook run once more",
    async run(h) {
      const run = await runOf(h)
      const baselines = []
      const onBaseline = (b) => baselines.push(b)
      const chain = await h.host.chainWorktree({ runId: run })
      assert.equal(worktreeName(chain.path), `${run}-chain`)
      assert.deepEqual([chain.made, chain.baseline], [true, SETUP_LEAVES])
      assert.deepEqual(await h.host.worktreeLines({ worktree: chain.path }), SETUP_LEAVES, 'what it holds now, read as its baseline was')
      const first = await start(h, 'first', { chain: chain.path })
      assert.equal(first.worktree, chain.path)
      await h.host.workerStop({ dispatch: first.dispatchId })
      await eventually('the first worker stopped', () => h.stopped(first))
      const again = await h.host.chainWorktree({ runId: run })
      assert.deepEqual([again.path, again.made, again.baseline], [chain.path, false, null])
      const second = await start(h, 'second', { chain: chain.path })
      assert.equal(second.worktree, chain.path)
      assert.equal(await h.setups(chain.path), 1, 'its setup hook ran once')
      const own = await start(h, 'own', { child: child(`${run}-1`) })
      assert.equal(worktreeName(own.worktree), `${run}-1`)
      assert.equal(await h.setups(own.worktree), 1)
      await assert.rejects(start(h, 'taken', { child: child(`${run}-1`) }), (e) => e.code === 'worktree_name_taken' && e.final === true)
      const doctor = await start(h, 'doctor', { child: child(`${run}-2`, { setup: 'skip', onBaseline }) })
      assert.equal(worktreeName(doctor.worktree), `${run}-2`)
      assert.deepEqual(baselines.at(-1), { worktree: doctor.worktree, lines: [] })
      assert.deepEqual([await h.setups(doctor.worktree), await h.setups(chain.path)], [0, 1])
      for (const path of [own.worktree, doctor.worktree]) await h.host.worktreeRemove({ path })
      // Reclaimed, then asked for again, as a resume does: made again at the
      // same path, its hook run once more, and held as ever after.
      await h.host.worktreeRemove({ path: chain.path })
      const remade = await h.host.chainWorktree({ runId: run })
      assert.deepEqual([remade.path, remade.made, remade.baseline], [chain.path, true, SETUP_LEAVES])
      assert.equal(await h.setups(chain.path), 2, 'its setup hook ran once more, for the remake')
      assert.equal((await h.host.chainWorktree({ runId: run })).made, false)
      const third = await start(h, 'third', { chain: chain.path })
      assert.equal(third.worktree, chain.path)
      assert.equal(await h.setups(chain.path), 2)
      await h.host.worktreeRemove({ path: chain.path })
    },
  },
  {
    name: 'reclaim: a failed worker kept running is stopped and its terminal closed straight after, a kill on a kill under way, and the host lives on',
    async run(h) {
      const w = await start(h, 'reclaim')
      await eventually('the start prompt', () => delivered(h, w, w.prompt))
      const agent = { runId: w.run, n: 1, title: 'reclaim', state: 'failed', workerLeft: true, dispatchId: w.dispatchId, terminal: w.terminal, worktree: w.worktree }
      assert.deepEqual(await reclaimAgent(agent, { host: h.host, stop: true, unpushed: async () => 0 }), { reclaimed: true, notes: [] })
      assert.ok(!(await h.host.terminalList()).includes(w.terminal), 'its terminal closed')
      const next = await start(h, 'after reclaim')
      assert.ok((await h.host.terminalList()).includes(next.terminal), 'the host still starts workers')
      await h.host.terminalClose({ terminal: next.terminal })
    },
  },
]

for (const kind of HOSTS) {
  test(`${kind.name} host: has every session-level method, and every run, worker and mailbox one`, () => {
    const { host } = kind.open()
    assert.deepEqual(
      [...SESSION_METHODS, ...RUN_METHODS].filter((m) => typeof host[m] !== 'function'),
      [],
    )
  })
  for (const scenario of SCENARIOS.filter((s) => !kind.scenarios || kind.scenarios.test(s.name))) test(`${kind.name} host: ${scenario.name}`, () => scenario.run(kind.open()))
}

// The crew host alone: what the fake host has no pty, harness or daemon for.
const crewKind = HOSTS.find((k) => k.name === 'crew')

test("crew host: has crew's own methods beyond the interface, sessionStart, mailSend and terminalsInfo", () => {
  const { host } = crewKind.open()
  assert.deepEqual(
    CREW_ONLY.filter((m) => typeof host[m] !== 'function'),
    [],
  )
})

test("crew host: the harness starts from the runner's launch line word for word, only its program swapped, and crew's hooks for that session after it", async () => {
  const h = crewKind.open()
  const launch = { harness: 'claude', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }
  const w = await start(h, 'launch line', launch)
  const [, ...words] = launchCommand({ ...launch, sessionId: w.sessionId }).split(' ')
  const s = await h.info(w)
  assert.deepEqual(s.command, [process.execPath, FAKE_HARNESS, ...words, '--settings', claudeSettings()])
  assert.equal(s.cwd, crewScratch().cwd)
  assert.equal(w.worktree, crewScratch().cwd)
  assert.equal(s.title, 'launch line')
})

test("crew host: the fake harness is a TUI on the alternate screen that echoes each prompt, crew's preamble first", async () => {
  const h = crewKind.open()
  const w = await start(h, 'tui')
  await eventually('the start prompt', () => delivered(h, w, w.prompt))
  const screen = await eventually('the echo', async () => {
    const s = (await request(h.paths, { op: 'session.screen', id: w.terminal })).screen
    return s.lines.some((l) => l.startsWith("echo: === Your session host's preamble, from crew ===")) && s
  })
  assert.equal(screen.alternate, true)
  assert.ok(screen.lines.some((l) => l.startsWith(`> ${w.prompt}`)))
  assert.ok(!screen.lines.some((l) => l.includes('starting')), 'the normal screen is not shown')
})

test("crew host: a hosted session runs with Claude's agent view off, so Left arrow cannot take the person out of it", async () => {
  const h = crewKind.open()
  const w = await start(h, 'no agent view')
  await eventually('the header', async () => (await request(h.paths, { op: 'session.screen', id: w.terminal })).screen.lines.some((l) => l.includes(`fake claude ${w.sessionId} · no agent view`)))
})

test("crew host: pi's transcript is written in pi's format, where the runner finds it by the session id", async () => {
  const h = crewKind.open()
  const w = await start(h, 'pi', { harness: 'pi', model: 'sonnet', effort: 'low' })
  const s = await h.info(w)
  assert.deepEqual(s.command.slice(2), ['--approve', '--session-id', w.sessionId, '--model', 'sonnet', '--thinking', 'low', '-e', PI_EXTENSION])
  const transcripts = sessionTranscripts({ env: crewScratch().env })
  // The reply lands in its own append, a moment after the file appears.
  const usage = await eventually("pi's transcript, its reply in", () => {
    const u = transcripts.usage({ harness: 'pi', sessionId: w.sessionId, worktree: w.worktree })
    return u?.tokens !== null && u
  })
  assert.match(usage.path, new RegExp(`_${w.sessionId}\\.jsonl$`))
  assert.equal(usage.tokens, 15)
})

test('crew host: Ctrl-U empties a typed input, and a bare Enter submits one', async () => {
  const h = crewKind.open()
  const w = await start(h, 'input')
  await eventually('the start prompt', () => delivered(h, w, w.prompt))
  const inputLine = async () => (await h.host.terminalScreen({ terminal: w.terminal, lines: 2 }))[0]
  await request(h.paths, { op: 'session.write', id: w.terminal, data: 'a draft', paste: true })
  await eventually('the draft in the input', async () => (await inputLine()) === '❯ a draft')
  await h.host.terminalClearInput({ terminal: w.terminal, lines: 2 })
  await eventually('the input emptied', async () => (await inputLine()) === '❯')
  await request(h.paths, { op: 'session.write', id: w.terminal, data: 'typed, then entered', paste: true })
  assert.equal(await delivered(h, w, 'typed, then entered'), false)
  await h.host.terminalEnter({ terminal: w.terminal })
  await eventually('the entered input in the session', () => delivered(h, w, 'typed, then entered'))
  assert.equal(await delivered(h, w, 'a draft'), false)
})

test('crew host: a harness that ends before its first prompt fails the start and leaves no session', async () => {
  const exits = join(crewScratch().root, 'exits.mjs')
  writeFileSync(exits, 'process.stdout.write("no such model\\r\\n")\nsetTimeout(() => process.exit(3), 100)\n')
  const h = crewKind.open({ harness: [process.execPath, exits] })
  const before = await h.host.terminalList()
  await assert.rejects(start(h, 'dies'), /ended before its first prompt \(exit 3\)/)
  assert.deepEqual(await h.host.terminalList(), before)
})

test("crew host: a dialog before the first prompt is the person's: asking hears of it, nothing is typed into it, and the prompt goes in once they answer it", async () => {
  const h = crewKind.open({ env: { CREW_FAKE_DIALOG: 'trust' } })
  const heard = []
  const starting = start(h, 'trusted', { asking: (seen) => heard.push(seen) })
  const shown = await eventually('the dialog heard of', () => heard[0])
  assert.deepEqual([shown.dialog, typeof shown.terminal], ['workspace trust', 'string'])
  assert.match(shown.ask, /trust this folder: enter the session/)
  await sleep(PAST_QUIET)
  assert.equal(heard.length, 1, 'a dialog that stays is heard of once')
  const screen = await h.host.terminalScreen({ terminal: shown.terminal, lines: 30 })
  assert.ok(
    screen.some((l) => l.includes('Yes, I trust this folder')),
    'nothing was typed into it',
  )
  // The person answers it in the session.
  await request(h.paths, { op: 'session.write', id: shown.terminal, data: '\x1b[B' })
  await request(h.paths, { op: 'session.write', id: shown.terminal, data: '\r' })
  const w = await starting
  assert.equal(w.terminal, shown.terminal)
  assert.deepEqual(heard.slice(1), [null], 'its going is heard of')
  await eventually('the start prompt', () => delivered(h, w, w.prompt))
})

test('crew host: a dialog nobody can answer fails the start at once, and one answered "No" ends it; neither leaves a session', async () => {
  const h = crewKind.open({ env: { CREW_FAKE_DIALOG: 'trust' } })
  const before = await h.host.terminalList()
  await assert.rejects(start(h, 'unasked'), /stopped at a dialog before its first prompt \(workspace trust\): Claude asks whether to trust this folder; answer it in a `claude` session of your own in /)
  const heard = []
  const refused = start(h, 'refused', { asking: (seen) => heard.push(seen) })
  const shown = await eventually('the dialog heard of', () => heard[0])
  await request(h.paths, { op: 'session.write', id: shown.terminal, data: '\r' })
  await assert.rejects(refused, /ended before its first prompt \(exit 1\), while it asked: workspace trust/)
  assert.deepEqual(await h.host.terminalList(), before)
})

test("crew host: pi's dialog before the first prompt is heard of from pi's own event, not its screen: nothing is typed into it, and the prompt goes in once it is answered", async () => {
  const h = crewKind.open({ env: { CREW_FAKE_DIALOG: 'pi-mcp' } })
  const heard = []
  const starting = start(h, 'pi mcp', { harness: 'pi', asking: (seen) => heard.push(seen) })
  const shown = await eventually('the dialog heard of', () => heard[0])
  assert.deepEqual([shown.dialog, shown.ask], ['a dialog', 'pi asks: Allow project MCP server “fakesrv”?: enter the session and answer it'])
  await sleep(PAST_QUIET)
  assert.equal(heard.length, 1, 'a dialog that stays is heard of once')
  const screen = await h.host.terminalScreen({ terminal: shown.terminal, lines: 30 })
  assert.ok(
    screen.some((l) => l.includes('Allow project MCP server')),
    'nothing was typed into it',
  )
  // The person answers it in the session.
  await request(h.paths, { op: 'session.write', id: shown.terminal, data: '\r' })
  const w = await starting
  assert.deepEqual(heard.slice(1), [null], 'its going is heard of')
  const transcripts = sessionTranscripts({ env: crewScratch().env })
  const path = await eventually("pi's transcript", () => transcripts.usage({ harness: 'pi', sessionId: w.sessionId, worktree: w.worktree })?.path)
  assert.ok(readFileSync(path, 'utf8').includes(w.prompt), 'the start prompt went in')
})

test('crew host: pi is ready once it says so, from its own session_start event, however much its terminal draws; one that never says so is not ready, and needs the person at readyMs', async () => {
  const ticking = crewKind.open({ env: { CREW_FAKE_TICK: '1' } })
  const w = await start(ticking, 'pi ticking', { harness: 'pi' })
  const s = (await request(ticking.paths, { op: 'session.list' })).sessions.find((x) => x.id === w.terminal)
  assert.ok(s.quietMs < 300, `its terminal never went quiet: last drew ${s.quietMs}ms ago`)
  const transcripts = sessionTranscripts({ env: crewScratch().env })
  const path = await eventually("pi's transcript", () => transcripts.usage({ harness: 'pi', sessionId: w.sessionId, worktree: w.worktree })?.path)
  assert.ok(readFileSync(path, 'utf8').includes(w.prompt), 'the start prompt went in')

  const mute = crewKind.open({ env: { CREW_FAKE_TICK: '1', CREW_FAKE_MUTE: '1' }, readyMs: 1_500 })
  await assert.rejects(start(mute, 'pi mute', { harness: 'pi' }), /never said it was ready within 2s; its screen:\n[\s\S]*❯/)
  const heard = []
  const asked = start(mute, 'pi mute asked', { harness: 'pi', asking: (seen) => heard.push(seen) })
  const shown = await eventually('the person asked', () => heard[0])
  assert.deepEqual([shown.dialog, shown.ask], ['unrecognised screen', "crew does not recognise pi's screen after 2s: enter the session and get it to its input prompt"])
  await request(mute.paths, { op: 'session.ready', id: shown.terminal })
  const w2 = await asked
  assert.deepEqual(heard.slice(1), [null], 'ready at last, the ask is withdrawn')
  const path2 = await eventually("pi's transcript", () => transcripts.usage({ harness: 'pi', sessionId: w2.sessionId, worktree: w2.worktree })?.path)
  assert.ok(readFileSync(path2, 'utf8').includes(w2.prompt), 'the start prompt went in once told')
})

for (const [harness, asks] of [
  ['claude', 'Claude asks permission to use Bash: touch asked.txt'],
  ['pi', 'pi asks: Allow Bash?'],
]) {
  test(`crew host: a ${harness} worker that asks the person mid-turn is waiting on them, from its own events, until they answer`, async () => {
    const h = crewKind.open()
    const w = await start(h, `asks on ${harness}`, { harness, prompt: `Contract prompt for asks on ${harness}. [ask Bash]` })
    const waiting = async () => (await h.host.workerShow({ dispatch: w.dispatchId })).waiting
    assert.equal(await eventually('it waiting on the person', waiting), asks)
    await request(h.paths, { op: 'session.write', id: w.terminal, data: '\r' })
    await eventually('it no longer waiting', async () => (await waiting()) === null)
  })
}

test("crew host: a continued session runs the runner's resume line word for word, crew's hooks after it, in the dead one's worktree, and the dead one is closed", async () => {
  const h = crewKind.open()
  const { w, next } = await died(h, 'resume line')
  const [, ...words] = resumeCommand({ harness: 'claude', sessionId: w.sessionId }).split(' ')
  const s = await h.info(next)
  assert.deepEqual(s.command, [process.execPath, FAKE_HARNESS, ...words, '--settings', claudeSettings()])
  assert.equal(s.cwd, crewScratch().cwd)
  assert.equal(next.worktree, crewScratch().cwd)
  assert.equal(s.title, 'resume line')
  assert.ok(!(await h.host.terminalList()).includes(w.terminal))
})

test('crew host: a harness still in its turn is ended before its session is continued', async () => {
  const h = crewKind.open()
  const w = await start(h, 'stalled', { prompt: 'Contract prompt for stalled. [turn 600000]' })
  await eventually('the prompt in the session', () => delivered(h, w, w.prompt))
  const next = await h.host.workerContinue({ run: w.run, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title: 'stalled', prompt: 'Carry on, stalled.', harness: 'claude', sessionId: w.sessionId })
  await eventually('the continue prompt in the session', () => delivered(h, { ...next, sessionId: w.sessionId }, 'Carry on, stalled.'))
  assert.deepEqual(
    (await h.host.terminalList()).filter((t) => t === w.terminal || t === next.terminal),
    [next.terminal],
  )
})

test("crew host: a worker's dispatch knows its agent's role, schema and result file from its start, and its continue's new dispatch from the continue: either submits by its session id alone (#174)", async () => {
  const h = crewKind.open()
  const dir = scratchDir()
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
  const resultPath = join(dir, 'result.json')
  const w = await start(h, 'submits by session', { prompt: 'Contract prompt for submits by session. [die]', role: 'worker', schema, resultPath })
  await assert.rejects(request(h.paths, { op: 'worker.submit', id: w.terminal, payload: { ok: 'yes' } }), /1 validation error\(s\)[\s\S]*\$\.ok: expected boolean, got string/)
  assert.equal(existsSync(resultPath), false)
  await request(h.paths, { op: 'worker.submit', id: w.terminal, payload: { ok: true } })
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { ok: true })
  const settled = await shown(h, w)
  assert.deepEqual([settled.settled, settled.outcome], [true, 'succeeded'])
  await eventually('the harness dead', () => h.dead(w))
  const next = await h.host.workerContinue({ run: w.run, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title: 'submits by session', prompt: 'Carry on.', harness: 'claude', sessionId: w.sessionId, role: 'worker', schema, resultPath })
  assert.notEqual(next.dispatchId, w.dispatchId)
  await assert.rejects(request(h.paths, { op: 'worker.submit', id: next.terminal, payload: {} }), /missing required property "ok"/)
  await request(h.paths, { op: 'worker.submit', id: next.terminal, payload: { ok: false } })
  assert.deepEqual(await h.host.workerResult({ dispatch: next.dispatchId }), { result: { ok: false }, outcome: 'succeeded', submissions: 1 })
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { ok: false })

  const doctor = await start(h, 'a doctor', { role: 'doctor' })
  await assert.rejects(request(h.paths, { op: 'worker.submit', id: doctor.terminal, payload: 'done' }), /is a doctor's: a doctor submits no result/)
})

// A pi as crew's extension sees it: what it registers, and its session_start.
function stubPi(env) {
  const on = new Map()
  const tools = []
  crewPi({ on: (type, fn) => on.set(type, fn), registerTool: (t) => tools.push(t) }, env)
  return { tools, start: () => on.get('session_start')({ type: 'session_start', reason: 'startup' }, {}) }
}

test("crew host: crew's pi extension gives a worker's session `status`, `needs_you` and `submit`, the table's descriptions and its schema as parameters, which submits by session; a doctor's gets `status`, `needs_you`, `handoff` and `give_up`, one of no dispatch and an operator's own pi none; a daemon gone is named (#174, #175, #176)", async () => {
  const h = crewKind.open()
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
  const resultPath = join(scratchDir(), 'result.json')
  const w = await start(h, 'stub pi', { prompt: 'Contract prompt for stub pi. [turn 600000]', role: 'worker', schema, resultPath })
  const env = { CREW_HOME: h.paths.home, CREW_SESSION: w.terminal }
  const pi = stubPi(env)
  await pi.start()
  assert.deepEqual(
    pi.tools.map((t) => [t.name, t.description]),
    ['status', 'needs_you', 'submit'].map((name) => [name, tool(name).description]),
  )
  const [status, needsYou, submit] = pi.tools
  assert.deepEqual(submit.parameters, schema)
  const kept = async (a) => {
    const { note, needsYou } = await h.host.workerShow({ dispatch: a.dispatchId })
    return { note, needsYou }
  }
  assert.match((await status.execute('call_0', { note: 'reading the code' })).content[0].text, /^Posted: the operator sees "reading the code" on your row\.$/)
  await needsYou.execute('call_0', { reason: 'log in to npm' })
  assert.deepEqual(await kept(w), { note: 'reading the code', needsYou: 'log in to npm' })
  const said = await submit.execute('call_1', { ok: true })
  assert.equal((await kept(w)).needsYou, null)
  assert.match(said.content[0].text, /^Submitted: the workflow has your result\. It is recorded at .*result\.json\. Nothing remains for this task: stop and idle\.$/)
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { ok: true })
  assert.deepEqual(await h.host.workerResult({ dispatch: w.dispatchId }), { result: { ok: true }, outcome: 'succeeded', submissions: 1 })
  // The daemon checks it again, and says why it refuses.
  await assert.rejects(submit.execute('call_2', { ok: 'yes' }), /submit rejected: 1 validation error\(s\)/)
  env.CREW_HOME = join(crewScratch().root, 'no-daemon-here')
  await assert.rejects(status.execute('call_3', { note: 'x' }), /^Error: crew's daemon is not reachable \(.*\)\. Your note was not posted: carry on with your task\.$/)
  await assert.rejects(submit.execute('call_3', { ok: true }), (e) => /^crew's daemon is not reachable \(.*\), so your result was not submitted\. Submit it with the command line in your instructions instead \(node ".*submit\.mjs" …\)/.test(e.message))

  const text = await start(h, 'stub pi text', { prompt: 'Contract prompt for stub pi text. [turn 600000]', role: 'worker' })
  const textPi = stubPi({ CREW_HOME: h.paths.home, CREW_SESSION: text.terminal })
  await textPi.start()
  assert.deepEqual(textPi.tools[2].parameters.required, ['text'])
  await textPi.tools[2].execute('call_1', { text: 'plain words' })
  assert.equal((await h.host.workerResult({ dispatch: text.dispatchId })).result, 'plain words')

  const doctor = await start(h, 'stub pi doctor', { prompt: 'Contract prompt for stub pi doctor. [turn 600000]', role: 'doctor' })
  const doctorPi = stubPi({ CREW_HOME: h.paths.home, CREW_SESSION: doctor.terminal })
  await doctorPi.start()
  assert.deepEqual(
    doctorPi.tools.map((t) => [t.name, t.description]),
    ['status', 'needs_you', 'handoff', 'give_up'].map((name) => [name, tool(name).description]),
  )
  // A doctor's needs_you is its escalation, as mail; its row's needs-you is the runner's.
  await doctorPi.tools[1].execute('call_1', { reason: 'grant the sandbox' })
  assert.equal((await kept(doctor)).needsYou, null)
  // handoff and give_up each end its round in one op: its dispatch settles.
  assert.match((await doctorPi.tools[2].execute('call_2', { note: 'read the lockfile first' })).content[0].text, /^Handed off: the runner carries the patient on with your note, and your round is over\. Nothing remains for you: stop and idle\.$/)
  assert.deepEqual(await h.host.workerResult({ dispatch: doctor.dispatchId }), { result: null, outcome: 'succeeded', submissions: 1 })
  const quitter = await start(h, 'stub pi quitter', { prompt: 'Contract prompt for stub pi quitter. [turn 600000]', role: 'doctor' })
  const quitterEnv = { CREW_HOME: h.paths.home, CREW_SESSION: quitter.terminal }
  const quitterPi = stubPi(quitterEnv)
  await quitterPi.start()
  assert.match((await quitterPi.tools[3].execute('call_1', { reason: 'only a human can fix it' })).content[0].text, /^Gave up: your round is over, with no note\. Nothing remains for you: stop and idle\.$/)
  assert.deepEqual(await h.host.workerResult({ dispatch: quitter.dispatchId }), { result: null, outcome: 'failed', submissions: 1 })
  quitterEnv.CREW_HOME = join(crewScratch().root, 'no-daemon-here')
  await assert.rejects(quitterPi.tools[2].execute('call_2', { note: 'x' }), (e) => e.message.endsWith(`Your note was not sent. Send it over Run mail instead, with the IDs your instructions give: ${tool('handoff').fallback()}`))
  await assert.rejects(quitterPi.tools[3].execute('call_2', { reason: 'x' }), (e) => e.message.endsWith(`The run was not told. Send it over Run mail instead, with the IDs your instructions give: ${tool('give_up').fallback()}`))
  for (const none of [{ CREW_HOME: h.paths.home, CREW_SESSION: 'no-such-session' }, { CREW_HOME: h.paths.home }]) {
    const other = stubPi(none)
    // Its ready is pi's to report, for a session the daemon does not hold.
    await other.start().catch((e) => assert.match(e.message, /^no session no-such-session$/))
    assert.deepEqual(other.tools, [], JSON.stringify(none))
  }
})

test("crew host: a pi worker calls crew's submit tool: pi rejects a payload that fails its schema in the turn, and the one it repairs settles its dispatch (#174)", async () => {
  const h = crewKind.open()
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
  const resultPath = join(scratchDir(), 'result.json')
  const w = await start(h, 'pi submits', { harness: 'pi', prompt: 'Contract prompt for pi submits. [call submit {"ok":"yes"}] [call submit {"ok":true}]', role: 'worker', schema, resultPath })
  await eventually('it settled', async () => (await shown(h, w)).settled)
  assert.deepEqual(await h.host.workerResult({ dispatch: w.dispatchId }), { result: { ok: true }, outcome: 'succeeded', submissions: 1 })
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { ok: true })
  const results = await eventually("both tool results in pi's transcript", () => {
    const path = transcriptPath({ harness: 'pi', sessionId: w.sessionId, worktree: w.worktree, env: crewScratch().env })
    const r =
      path && existsSync(path)
        ? readFileSync(path, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l).message)
            .filter((m) => m?.role === 'toolResult')
        : []
    return r.length === 2 && r
  })
  assert.deepEqual(
    results.map((m) => [m.toolName, m.isError]),
    [
      ['submit', true],
      ['submit', false],
    ],
  )
  assert.match(results[0].content[0].text, /^Validation failed for tool "submit":\n {2}- \$\.ok: expected boolean, got string/)
})

test('crew host: an ended harness is idle, and a session the daemon does not hold is refused', async () => {
  const h = crewKind.open()
  const w = await start(h, 'ended idle', { prompt: 'Contract prompt for ended idle. [turn 600000]' })
  await eventually('the prompt in the session', () => delivered(h, w, w.prompt))
  assert.equal(await idle(h, w), false)
  await h.host.workerStop({ dispatch: w.dispatchId })
  await eventually('the worker stopped', () => h.stopped(w))
  assert.equal(await idle(h, w), true)
  await assert.rejects(h.host.terminalIdle({ terminal: 'no-such-terminal' }), /no crew session/)
})

test("crew host: a child worktree is at <repo-parent>/<repo>.crew/<runId>-<n>, on a branch of that name, set up by the repo's hook after it is made", async () => {
  const h = crewKind.open()
  const { cwd, root } = crewScratch()
  const run = await runOf(h)
  const w = await start(h, 'layout', { child: child(`${run}-1`) })
  assert.equal(w.worktree, join(root, 'worktree.crew', `${run}-1`))
  assert.equal(crewWorktrees(cwd), join(root, 'worktree.crew'))
  assert.equal((await h.info(w)).cwd, w.worktree)
  assert.equal(spawnSync('git', ['-C', w.worktree, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim(), `${run}-1`)
  const [repo, worktree] = readFileSync(join(w.worktree, 'setup.out'), 'utf8').trim().split('\n')
  assert.equal(resolve(repo), resolve(cwd))
  assert.equal(resolve(worktree), w.worktree)
})

test('crew host: a retry takes the worktree an earlier attempt made up again, hook not rerun; a start that did not ask to retry is refused it for good', async () => {
  const h = crewKind.open()
  const run = await runOf(h)
  const w = await start(h, 'first', { child: child(`${run}-1`) })
  await h.host.workerStop({ dispatch: w.dispatchId })
  await eventually('the worker stopped', () => h.stopped(w))
  writeFileSync(join(w.worktree, 'setup.out'), 'left as it was\n')
  const again = await start(h, 'retried', { child: child(`${run}-1`, { retry: true }) })
  assert.equal(again.worktree, w.worktree)
  assert.equal(readFileSync(join(w.worktree, 'setup.out'), 'utf8'), 'left as it was\n')
  await assert.rejects(start(h, 'taken', { child: child(`${run}-1`) }), (e) => e.code === 'worktree_name_taken' && e.final === true && e.worktree === w.worktree)
})

test('crew host: a chain worktree whose folder was deleted by hand, still listed by git, is made again at its path, its hook run once more', async () => {
  const h = crewKind.open()
  const run = await runOf(h)
  const chain = await h.host.chainWorktree({ runId: run })
  rmSync(chain.path, { recursive: true, force: true })
  const remade = await h.host.chainWorktree({ runId: run })
  assert.deepEqual([remade.path, remade.made], [chain.path, true])
  assert.ok(existsSync(chain.path))
  assert.equal(await h.setups(chain.path), 2)
})

test("crew host: a chain worktree reclaimed and made again starts from the run's HEAD, as the first did, never from where its branch was left", async () => {
  const h = crewKind.open()
  const run = await runOf(h)
  const chain = await h.host.chainWorktree({ runId: run })
  const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).stdout.trim()
  const base = git(crewScratch().cwd, 'rev-parse', 'HEAD')
  assert.equal(git(chain.path, 'rev-parse', 'HEAD'), base)
  git(chain.path, 'commit', '--allow-empty', '-m', 'left on the chain branch')
  const left = git(chain.path, 'rev-parse', 'HEAD')
  await h.host.worktreeRemove({ path: chain.path })
  const remade = await h.host.chainWorktree({ runId: run })
  assert.deepEqual([remade.path, remade.made, git(remade.path, 'rev-parse', 'HEAD')], [chain.path, true, base])
  assert.equal(git(crewScratch().cwd, 'rev-parse', `refs/heads/${run}-chain`), left, 'the branch reclaim left keeps what it holds')
  await h.host.worktreeRemove({ path: chain.path })
})

test('crew host: a chain worktree whose baseline cannot be read once it is made is made all the same, with a warning and no baseline', async () => {
  const h = crewKind.open({ env: { BREAK_STATUS: '1' } })
  const run = await runOf(h)
  const chain = await h.host.chainWorktree({ runId: run })
  assert.deepEqual([worktreeName(chain.path), chain.made, chain.baseline], [`${run}-chain`, true, null])
  assert.match(chain.warnings.join('\n'), /could not read its baseline/)
})

test('crew host: a setup hook that fails fails the start and leaves no worktree or branch behind', async () => {
  const h = crewKind.open({ env: { FAIL_SETUP: '1' } })
  const run = await runOf(h)
  const path = join(crewWorktrees(crewScratch().cwd), `${run}-1`)
  await assert.rejects(start(h, 'unset', { child: child(`${run}-1`) }), /setup_failed: the setup hook .* failed[\s\S]*setup refused/)
  assert.equal(existsSync(path), false)
  assert.equal(spawnSync('git', ['-C', crewScratch().cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${run}-1`]).status, 1)
})

test("crew host: remove takes only a worktree crew made, never the operator's own", async () => {
  const h = crewKind.open()
  await assert.rejects(h.host.worktreeRemove({ path: crewScratch().cwd }), /not a worktree crew made/)
  assert.ok(existsSync(join(crewScratch().cwd, 'README.md')))
})

test("crew config: a repo's setup hook is keyed by its path in crew's home, and a repo it does not name has none", () => {
  const { paths, cwd, root } = crewScratch()
  assert.equal(repoConfig(paths, cwd).setup, join(root, 'setup-hook.mjs'))
  assert.equal(repoConfig(paths, process.platform === 'win32' ? cwd.toUpperCase().replace(/\\/g, '/') : cwd).setup, join(root, 'setup-hook.mjs'))
  assert.deepEqual(repoConfig(paths, join(root, 'elsewhere')), {})
  assert.ok(!existsSync(join(cwd, '.crew')), "nothing of crew's in the repo")
})

test('crew host: a whole session host by its name, whose agent-side send refuses a dispatch crew never made', async () => {
  const { paths } = crewScratch()
  const host = await openHost('crew', { paths })
  assert.equal(host.id, 'crew')
  const r = spawnSync(process.execPath, [CREW_BIN, 'orchestration', 'send', '--task-id', 't', '--dispatch-id', 'no-such', '--type', 'handoff', '--subject', 's', '--body', 'b'], { encoding: 'utf8', env: crewScratch().agentEnv })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /dispatch_not_found/)
})

test('crew host: crew dead is an outage through the host interface: a call that finds its daemon gone waits for a probe to find crew back, then goes on, and a session lost with the daemon is shown hostDied and continues', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-outage-')))
  const env = { ...process.env, CREW_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PI_CODING_AGENT_SESSION_DIR: join(root, 'pi') }
  const paths = crewPaths(env)
  homes.push(paths)
  const host = crewHost({ paths, env, cwd: root, harnesses: harnessAs([process.execPath, FAKE_HARNESS]), transcripts: sessionTranscripts({ env }), quietMs: 300, readyMs: 20_000, pollMs: 50 })
  const phases = []
  const limits = { outageProbeMs: 200, outageProbeMaxMs: 400, outageLimitMs: 60_000, pausedProbeMs: 1_000 }
  host.guardWith(hostOutage({ clock: realClock, limits, probe: () => host.probe(), unreachable: (e) => hostUnreachable(host, e), on: (e) => phases.push(e.phase) }))
  const { runId } = await host.runCreate({ objective: 'crew outage' })
  const sessionId = randomUUID()
  const w = await host.workerStart({ run: runId, prompt: 'Say hello.', title: 'lost', sessionId })
  const { pid } = await request(paths, { op: 'hello' })
  process.kill(pid, 'SIGKILL')
  await eventually('the daemon gone', () => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  })
  const shown = await host.workerShow({ dispatch: w.dispatchId })
  assert.deepEqual(phases, ['start', 'end'])
  assert.deepEqual([shown.gone, shown.settled, shown.hostDied], [true, false, true])
  const next = await host.workerContinue({ run: runId, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title: 'lost', prompt: 'Say it again.', sessionId })
  assert.notEqual(next.terminal, w.terminal)
  assert.equal((await host.workerShow({ dispatch: next.dispatchId })).hostDied, undefined)
})

test('the quiet-output threshold is a runner setting, 5 seconds by default', () => {
  assert.equal(RUNNER_SETTINGS.quietOutputMs, 5_000)
})

test('crew daemon protocol: an ended session takes no keys, and a title must be text', async () => {
  const h = crewKind.open()
  const w = await start(h, 'protocol')
  await h.host.workerStop({ dispatch: w.dispatchId })
  await eventually('the worker stopped', () => h.stopped(w))
  await assert.rejects(h.host.terminalEnter({ terminal: w.terminal }), /session \S+ has exited/)
  await assert.rejects(request(h.paths, { op: 'session.rename', id: w.terminal, title: 7 }), /not a title/)
  await assert.rejects(request(h.paths, { op: 'session.write', id: w.terminal }), /has exited|not a data/)
  assert.deepEqual((await h.host.terminalScreen({ terminal: w.terminal, lines: 1 })).length, 1, 'its last screen stays')
  await h.host.terminalClose({ terminal: w.terminal })
  await assert.rejects(request(h.paths, { op: 'session.screen', id: w.terminal }), /no session/)
})

// Its own daemon, in this process, so it parks within the test (ADR-0024).
test('crew host: anything sent to a parked session revives it first, under its own id, and waits for its prompt before typing', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-revive-')))
  const env = { ...process.env, CREW_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude') }
  const paths = crewPaths(env)
  const cwd = join(root, 'worktree')
  mkdirSync(cwd, { recursive: true })
  const daemon = await startDaemon({ paths, registry: join(root, 'runs.jsonl'), parkAfterMs: 600, parkSweepMs: 50, exit: () => {}, log: () => {} })
  try {
    const host = crewHost({ paths, env, cwd, harnesses: harnessAs([process.execPath, FAKE_HARNESS]), quietMs: 300, readyMs: 20_000, start: async () => {} })
    const { runId } = await host.runCreate({ objective: 'revive' })
    const sessionId = randomUUID()
    const w = await host.workerStart({ run: runId, prompt: 'First prompt.', title: 'sleeper', harness: 'claude', sessionId })
    const transcript = () => readFileSync(transcriptPath({ harness: 'claude', sessionId, worktree: cwd, env }), 'utf8')
    const text = await eventually('the preamble in the transcript', () => existsSync(transcriptPath({ harness: 'claude', sessionId, worktree: cwd, env }) ?? '') && /--dispatch-id/.test(transcript()) && transcript())
    const [, , capability, taskId, dispatchId] = /--from ([\w-]+) --dispatch-capability ([\w-]+) --task-id ([\w-]+) --dispatch-id ([\w-]+)/.exec(text)
    await request(paths, { op: 'mail.send', taskId, dispatchId, capability, type: 'worker_done', outcome: 'succeeded' })
    const info = async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === w.terminal)
    await eventually('it to be parked', async () => (await info())?.parked)
    const { pid } = await info()

    await host.terminalSend({ terminal: w.terminal, text: 'Follow up after parking.' })
    const now = await info()
    assert.deepEqual([now.alive, !!now.parked], [true, false])
    assert.notEqual(now.pid, pid, 'a new harness, in the same session')
    assert.ok(now.command.includes('--resume') && now.command.includes(sessionId), now.command.join(' '))
    await eventually('the follow-up delivered whole, after the resume', () => host.promptDelivered({ harness: 'claude', sessionId, worktree: cwd, needle: 'Follow up after parking.' }))
  } finally {
    daemon.shutdown('test over')
  }
})
