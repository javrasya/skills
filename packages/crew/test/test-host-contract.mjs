// The host contract suite: one set of session host scenarios, each run on the
// in-memory fake host (fake-orca.mjs) and on the crew host (crew-host.mjs),
// whose workers are the fake harness (fixtures/crew/fake-harness.mjs) in real
// ptys held by a real daemon under a scratch crew home. Through the crew
// adapter it also covers the daemon's client protocol, which that adapter is
// the only client of. A scenario is { name, run(h) }, h being what a host's
// open() gives: { host, stopped(w), dead(w), title(w) }, `w` a started
// worker; one that needs more of a host adds it to both HOSTS. Words in a
// prompt script the worker's turn, as fake-harness.mjs reads them ([turn
// <ms>], [spin <ms>], [draw], [unrecorded], [die]); the fake host's workers
// play them too.
//   node packages/crew/test/test-host-contract.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { fakeOrca } from '../src/fake-orca.mjs'
import { crewHost } from '../src/crew-host.mjs'
import { SESSION_METHODS } from '../src/session-host.mjs'
import { launchCommand, resumeCommand } from '../src/harness.mjs'
import { RUNNER_SETTINGS } from '../src/settings.mjs'
import { sessionTranscripts } from '../src/transcript.mjs'
import { crewPaths } from '../src/daemon/transport.mjs'
import { request, stopDaemon } from '../src/daemon/client.mjs'

const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/crew/fake-harness.mjs', import.meta.url))
const RUN = 'run_contract'

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

// One scratch crew home and daemon for every crew scenario.
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
  crew = { root, env, paths, cwd }
  return crew
}
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

const HOSTS = [
  {
    name: 'fake',
    open() {
      const orca = fakeOrca({ worker: fakeWorker })
      const d = (w) => orca.dispatches.get(w.dispatchId)
      return { host: orca, stopped: async (w) => d(w)?.stopped === true, dead: async (w) => d(w)?.exited === true, title: async (w) => d(w)?.tabTitle }
    },
  },
  {
    name: 'crew',
    open({ harness = [process.execPath, FAKE_HARNESS] } = {}) {
      const { env, paths, cwd } = crewScratch()
      const host = crewHost({ paths, env, cwd, harnesses: harnessAs(harness), quietMs: 300, readyMs: 20_000 })
      const info = async (w) => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === w.terminal)
      const ended = async (w) => (await info(w))?.alive === false
      return { host, paths, stopped: ended, dead: ended, title: async (w) => (await info(w))?.title, info }
    },
  },
]

async function start(h, title, launch = {}) {
  const sessionId = randomUUID()
  const { prompt = `Contract prompt for ${title}.`, ...rest } = launch
  const w = await h.host.workerStart({ run: RUN, prompt, title, harness: 'claude', sessionId, ...rest })
  return { ...w, sessionId, prompt }
}
const delivered = (h, w, needle) => h.host.promptDelivered({ harness: 'claude', sessionId: w.sessionId, worktree: w.worktree, needle })
const idle = (h, w, timeoutMs = 0) => h.host.terminalIdle({ terminal: w.terminal, timeoutMs })
// Longer than the crew host's quiet-output threshold in this suite.
const PAST_QUIET = 800
async function died(h, title) {
  const w = await start(h, title, { prompt: `Contract prompt for ${title}. [die]` })
  await eventually('the harness dead', () => h.dead(w))
  const next = await h.host.workerContinue({ run: RUN, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title, prompt: 'Carry on from where you stopped.', harness: 'claude', sessionId: w.sessionId, reopen: false })
  return { w, next: { ...next, sessionId: w.sessionId } }
}

export const SCENARIOS = [
  {
    name: 'start: the harness runs with the runner\'s session id, in a terminal of its own, and gets its prompt',
    async run(h) {
      const w = await start(h, 'start')
      assert.equal(typeof w.terminal, 'string')
      assert.equal(typeof w.dispatchId, 'string')
      assert.ok(Array.isArray(w.warnings))
      assert.ok((await h.host.terminalList()).includes(w.terminal))
      await eventually('the prompt in the session', () => delivered(h, w, w.prompt))
      await assert.rejects(h.host.workerStart({ run: RUN, prompt: 'x', title: 'no session id', harness: 'claude' }), /session id/)
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
        return s.at(-1)?.startsWith('❯') && s
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
      assert.ok(await delivered(h, next, w.prompt), 'the turn it died in is still its session\'s')
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
]

for (const kind of HOSTS) {
  test(`${kind.name} host: has every session-level method`, () => {
    const { host } = kind.open()
    assert.deepEqual(SESSION_METHODS.filter((m) => typeof host[m] !== 'function'), [])
  })
  for (const scenario of SCENARIOS) test(`${kind.name} host: ${scenario.name}`, () => scenario.run(kind.open()))
}

// The crew host alone: what the fake host has no pty, harness or daemon for.
const crewKind = HOSTS.find((k) => k.name === 'crew')

test('crew host: the harness starts from the runner\'s launch line word for word, only its program swapped', async () => {
  const h = crewKind.open()
  const launch = { harness: 'claude', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }
  const w = await start(h, 'launch line', launch)
  const [, ...words] = launchCommand({ ...launch, sessionId: w.sessionId }).split(' ')
  const s = await h.info(w)
  assert.deepEqual(s.command, [process.execPath, FAKE_HARNESS, ...words])
  assert.equal(s.cwd, crewScratch().cwd)
  assert.equal(w.worktree, crewScratch().cwd)
  assert.equal(s.title, 'launch line')
})

test('crew host: the fake harness is a TUI on the alternate screen that echoes each prompt', async () => {
  const h = crewKind.open()
  const w = await start(h, 'tui')
  await eventually('the start prompt', () => delivered(h, w, w.prompt))
  const screen = await eventually('the echo', async () => {
    const s = (await request(h.paths, { op: 'session.screen', id: w.terminal })).screen
    return s.lines.some((l) => l.includes(`echo: ${w.prompt}`)) && s
  })
  assert.equal(screen.alternate, true)
  assert.ok(screen.lines.some((l) => l.startsWith(`> ${w.prompt}`)))
  assert.ok(!screen.lines.some((l) => l.includes('starting')), 'the normal screen is not shown')
})

test('crew host: pi\'s transcript is written in pi\'s format, where the runner finds it by the session id', async () => {
  const h = crewKind.open()
  const w = await start(h, 'pi', { harness: 'pi', model: 'sonnet', effort: 'low' })
  const s = await h.info(w)
  assert.deepEqual(s.command.slice(2), ['--approve', '--session-id', w.sessionId, '--model', 'sonnet', '--thinking', 'low'])
  const transcripts = sessionTranscripts({ env: crewScratch().env })
  const usage = await eventually('pi\'s transcript', () => transcripts.usage({ harness: 'pi', sessionId: w.sessionId, worktree: w.worktree }))
  assert.match(usage.path, new RegExp(`_${w.sessionId}\\.jsonl$`))
  assert.equal(usage.tokens, 15)
})

test('crew host: Ctrl-U empties a typed input, and a bare Enter submits one', async () => {
  const h = crewKind.open()
  const w = await start(h, 'input')
  await eventually('the start prompt', () => delivered(h, w, w.prompt))
  const inputLine = async () => (await h.host.terminalScreen({ terminal: w.terminal, lines: 1 }))[0]
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

test('crew host: a continued session runs the runner\'s resume line word for word, in the dead one\'s worktree, and the dead one is closed', async () => {
  const h = crewKind.open()
  const { w, next } = await died(h, 'resume line')
  const [, ...words] = resumeCommand({ harness: 'claude', sessionId: w.sessionId }).split(' ')
  const s = await h.info(next)
  assert.deepEqual(s.command, [process.execPath, FAKE_HARNESS, ...words])
  assert.equal(s.cwd, crewScratch().cwd)
  assert.equal(next.worktree, crewScratch().cwd)
  assert.equal(s.title, 'resume line')
  assert.ok(!(await h.host.terminalList()).includes(w.terminal))
})

test('crew host: a harness still in its turn is ended before its session is continued', async () => {
  const h = crewKind.open()
  const w = await start(h, 'stalled', { prompt: 'Contract prompt for stalled. [turn 600000]' })
  await eventually('the prompt in the session', () => delivered(h, w, w.prompt))
  const next = await h.host.workerContinue({ run: RUN, dispatch: w.dispatchId, terminal: w.terminal, worktree: w.worktree, title: 'stalled', prompt: 'Carry on, stalled.', harness: 'claude', sessionId: w.sessionId })
  await eventually('the continue prompt in the session', () => delivered(h, { ...next, sessionId: w.sessionId }, 'Carry on, stalled.'))
  assert.deepEqual((await h.host.terminalList()).filter((t) => t === w.terminal || t === next.terminal), [next.terminal])
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
