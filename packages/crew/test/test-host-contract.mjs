// The host contract suite: one set of session host scenarios, each run on the
// in-memory fake host (fake-orca.mjs) and on the crew host (crew-host.mjs),
// whose workers are the fake harness (fixtures/crew/fake-harness.mjs) in real
// ptys held by a real daemon under a scratch crew home. Through the crew
// adapter it also covers the daemon's client protocol, which that adapter is
// the only client of. A scenario is { name, run(h) }, h being what a host's
// open() gives: { host, stopped(w), title(w) }, `w` a started worker; one that
// needs more of a host adds it to both HOSTS.
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
import { launchCommand } from '../src/harness.mjs'
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

const HOSTS = [
  {
    name: 'fake',
    open() {
      const orca = fakeOrca()
      const d = (w) => orca.dispatches.get(w.dispatchId)
      return { host: orca, stopped: async (w) => d(w)?.stopped === true, title: async (w) => d(w)?.tabTitle }
    },
  },
  {
    name: 'crew',
    open({ harness = [process.execPath, FAKE_HARNESS] } = {}) {
      const { env, paths, cwd } = crewScratch()
      const host = crewHost({ paths, env, cwd, harnesses: harnessAs(harness), quietMs: 300, readyMs: 20_000 })
      const info = async (w) => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === w.terminal)
      return { host, paths, stopped: async (w) => (await info(w))?.alive === false, title: async (w) => (await info(w))?.title, info }
    },
  },
]

async function start(h, title, launch = {}) {
  const sessionId = randomUUID()
  const prompt = `Contract prompt for ${title}.`
  const w = await h.host.workerStart({ run: RUN, prompt, title, harness: 'claude', sessionId, ...launch })
  return { ...w, sessionId, prompt }
}
const delivered = (h, w, needle) => h.host.promptDelivered({ harness: 'claude', sessionId: w.sessionId, worktree: w.worktree, needle })

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
