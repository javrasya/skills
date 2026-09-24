// Offline tests for the Orca runner: submit, the agent() round trip, the live
// cap, how a run is laid out in Orca, resume from the journal, and every way a
// worker dies becoming null, with the fake Orca standing in for the CLI
// adapter and a fake clock standing in for time.
//   node scripts/test-orca-runner.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { submit } from '../skills/engineering/implement-spec-in-workflow/orca/submit.mjs'
import { runScript, journalKey, failureSummary, SUBMIT, SETTINGS } from '../skills/engineering/implement-spec-in-workflow/orca/runner.mjs'
import { fakeOrca } from '../skills/engineering/implement-spec-in-workflow/orca/fake-orca.mjs'
import { RUNNER_SETTINGS } from '../skills/engineering/implement-spec-in-workflow/orca/settings.mjs'
import { orcaCli } from '../skills/engineering/implement-spec-in-workflow/orca/orca-cli.mjs'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'count', 'kind'],
  properties: {
    name: { type: 'string' },
    count: { type: 'integer' },
    kind: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', minItems: 1, items: { type: 'string' } },
  },
}
const GOOD = { name: 'n', count: 2, kind: 'a', tags: ['x'] }
const BAD = { count: '2', kind: 'c', tags: [1], extra: true }
const BAD_ERRORS = [
  '  $: missing required property "name"',
  '  $.count: expected integer, got string',
  '  $.kind: "c" is not one of ["a","b"]',
  '  $.tags[0]: expected string, got integer',
  '  $: unexpected property "extra"',
]

const tmp = () => mkdtempSync(join(tmpdir(), 'orca-runner-test-'))
const FAST = { pollMs: 1 }
const TEMPLATE = new URL('../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url)

// A dispatched worker as submit sees it: its preamble IDs and its files.
async function startedWorker() {
  const dir = tmp()
  const orca = fakeOrca()
  const w = await orca.workerStart({ run: 'run_fake', prompt: '', title: 't' })
  const d = orca.dispatches.get(w.dispatchId)
  const paths = { schema: join(dir, 'schema.json'), result: join(dir, 'result.json'), payload: join(dir, 'payload.json') }
  writeFileSync(paths.schema, JSON.stringify(SCHEMA))
  const argv = ['--schema', paths.schema, '--result', paths.result, '--payload', paths.payload,
    '--from', d.handle, '--dispatch-capability', d.capability, '--task-id', d.taskId, '--dispatch-id', d.dispatchId]
  return { orca, d, paths, argv }
}

async function runSubmit(argv, orca) {
  const out = []
  const err = []
  const code = await submit(argv, { orca, stdout: (s) => out.push(s), stderr: (s) => err.push(s) })
  return { code, out, err }
}

const doneCalls = (orca) => orca.calls.filter((c) => c.verb === 'workerDone')

test('submit: a valid result exits 0, is recorded, and signals the worker done', async () => {
  const { orca, d, paths, argv } = await startedWorker()
  writeFileSync(paths.payload, JSON.stringify(GOOD))
  const r = await runSubmit(argv, orca)
  assert.equal(r.code, 0, r.err.join('\n'))
  assert.deepEqual(JSON.parse(readFileSync(paths.result, 'utf8')), GOOD)
  assert.equal(doneCalls(orca).length, 1)
  assert.equal(d.settled, true)
  assert.equal(d.outcome, 'succeeded')
})

test('submit: an invalid result exits non-zero with the exact errors, records nothing, signals nothing', async () => {
  const { orca, d, paths, argv } = await startedWorker()
  writeFileSync(paths.payload, JSON.stringify(BAD))
  const r = await runSubmit(argv, orca)
  assert.equal(r.code, 1)
  assert.deepEqual(r.err.slice(1, -1), BAD_ERRORS)
  assert.equal(existsSync(paths.result), false)
  assert.equal(doneCalls(orca).length, 0)
  assert.equal(d.settled, false)
})

test('submit: a payload that is not JSON is rejected, not crashed on', async () => {
  const { orca, paths, argv } = await startedWorker()
  writeFileSync(paths.payload, '{ name: ')
  const r = await runSubmit(argv, orca)
  assert.equal(r.code, 1)
  assert.match(r.err[0], /payload is not valid JSON/)
})

test('submit: a repaired result is accepted after the rejected one, and signals done once', async () => {
  const { orca, d, paths, argv } = await startedWorker()
  writeFileSync(paths.payload, JSON.stringify(BAD))
  assert.equal((await runSubmit(argv, orca)).code, 1)
  assert.equal(d.settled, false)
  writeFileSync(paths.payload, JSON.stringify(GOOD))
  assert.equal((await runSubmit(argv, orca)).code, 0)
  assert.deepEqual(JSON.parse(readFileSync(paths.result, 'utf8')), GOOD)
  assert.equal(doneCalls(orca).length, 1)
  assert.equal(d.outcome, 'succeeded')
})

test('submit: a schema file it cannot read or parse is a usage error (exit 2), not a crash', async () => {
  const { orca, d, paths, argv } = await startedWorker()
  writeFileSync(paths.payload, JSON.stringify(GOOD))
  for (const [schema, what] of [[join(dirname(paths.schema), 'missing.json'), 'missing'], [paths.schema, 'not JSON']]) {
    if (what === 'not JSON') writeFileSync(paths.schema, '{ type: ')
    const r = await runSubmit(argv.map((a) => (a === paths.schema ? schema : a)), orca)
    assert.equal(r.code, 2, what)
    assert.match(r.err[0], /^submit: cannot read schema /, what)
  }
  assert.equal(existsSync(paths.result), false)
  assert.equal(doneCalls(orca).length, 0)
  assert.equal(d.settled, false)
})

test('submit: as a process, a bad result exits 1 and prints the errors on stderr', async () => {
  const { paths, argv } = await startedWorker()
  writeFileSync(paths.payload, JSON.stringify(BAD))
  const p = spawnSync(process.execPath, [SUBMIT, ...argv], { encoding: 'utf8' })
  assert.equal(p.status, 1)
  for (const line of BAD_ERRORS) assert.ok(p.stderr.includes(line), `stderr lacks ${line}\n${p.stderr}`)
})

// A rendered script as the Workflow runner would take it — meta export,
// hooks used as globals, a top-level return — with no Orca in it.
const SCRIPT = `export const meta = { name: 'tracer', description: 'one agent', phases: [{ title: 'Tracer' }] }
const SCHEMA = ${JSON.stringify(SCHEMA)}
phase('Tracer')
log('asking one agent')
const r = await agent('Name a thing.', { label: 'tracer:thing', phase: 'Tracer', schema: SCHEMA })
log('agent returned ' + JSON.stringify(r))
return { r }`

// The submit command the runner's prompt tells a worker to run, with the
// placeholders filled from the worker's preamble.
function submitArgvIn(prompt, preamble) {
  const line = prompt.split('\n').find((l) => l.includes('submit.mjs"'))
  const fill = { '<worker_handle>': preamble.handle, '<capability>': preamble.capability, '<task_id>': preamble.taskId, '<dispatch_id>': preamble.dispatchId }
  const words = line.trim().match(/"[^"]*"|\S+/g).map((w) => fill[w] ?? w.replace(/^"|"$/g, ''))
  assert.equal(words[1], SUBMIT)
  return words.slice(2)
}

test('agent(): a worker that repairs its payload returns a schema-valid object to the script', async () => {
  const lines = []
  const orca = fakeOrca({
    worker: async ({ prompt, preamble, orca }) => {
      assert.match(prompt, /^Name a thing\./)
      const argv = submitArgvIn(prompt, preamble)
      const payload = argv[argv.indexOf('--payload') + 1]
      writeFileSync(payload, JSON.stringify(BAD))
      assert.equal((await runSubmit(argv, orca)).code, 1)
      writeFileSync(payload, JSON.stringify(GOOD))
      assert.equal((await runSubmit(argv, orca)).code, 0)
    },
  })
  const result = await runScript(SCRIPT, { orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.deepEqual(result, { r: GOOD })

  const verbs = orca.calls.map((c) => c.verb)
  assert.deepEqual(verbs.slice(0, 2), ['runCreate', 'workerStart'])
  assert.equal(verbs.filter((v) => v === 'workerDone').length, 1)
  const done = verbs.indexOf('workerDone')
  assert.ok(orca.calls.slice(0, done).every((c) => c.verb !== 'workerShow' || !c.settled), 'settled before worker_done')
  assert.deepEqual(verbs.slice(-1), ['workerRelease'])
  assert.equal(orca.calls[1].title, '[Tracer] tracer:thing')

  assert.ok(lines.includes('== Tracer'), lines.join('\n'))
  assert.ok(lines.includes('   asking one agent'), lines.join('\n'))
  assert.ok(lines.includes('   agent returned ' + JSON.stringify(GOOD)), lines.join('\n'))
})

test('agent(): the runner re-validates, so a result that skipped submit reaches the script as null', async () => {
  const lines = []
  const orca = fakeOrca({
    worker: async ({ prompt, preamble, orca }) => {
      const argv = submitArgvIn(prompt, preamble)
      writeFileSync(argv[argv.indexOf('--result') + 1], JSON.stringify(BAD))
      await orca.workerDone({ from: preamble.handle, capability: preamble.capability, taskId: preamble.taskId, dispatchId: preamble.dispatchId, subject: 's', body: 'b' })
    },
  })
  const result = await runScript(SCRIPT, { orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.deepEqual(result, { r: null })
  assert.ok(lines.some((l) => l.includes('recorded result fails its schema') && l.includes('$.count: expected integer, got string')), lines.join('\n'))
})

test('agent(): a schema no result can satisfy throws before any worker starts', async () => {
  const orca = fakeOrca()
  const script = `return await agent('x', { schema: { type: 'object', required: ['a'], properties: {} } })`
  await assert.rejects(runScript(script, { orca, stateDir: tmp(), out: () => {} }), /requires properties it does not define: a/)
  assert.equal(orca.calls.length, 0)
})

// Each worker answers with its prompt's first line and which run it served,
// so a result shows whether it came from this run or from the journal.
function answering(run) {
  return fakeOrca({
    worker: async ({ prompt, preamble, orca }) => {
      const argv = submitArgvIn(prompt, preamble)
      writeFileSync(argv[argv.indexOf('--payload') + 1], `${prompt.split('\n')[0]} @${run}`)
      assert.equal((await runSubmit(argv, orca)).code, 0)
    },
  })
}

const chain = (second) => `phase('Chain')
const a = await agent('Plan it.', { label: 'a', phase: 'Chain' })
const b = await agent(${JSON.stringify(second)}, { label: 'b', phase: 'Chain' })
const c = await agent('Check it.', { label: 'c', phase: 'Chain' })
return [a, b, c]`

const started = (orca) => orca.calls.filter((c) => c.verb === 'workerStart').map((c) => c.title)

test('resume: the unchanged prefix replays from the journal without launching; the first changed call onward runs live', async () => {
  const stateDir = tmp()
  const go = (script, run, resume) => {
    const orca = answering(run)
    return runScript(script, { orca, stateDir, out: () => {}, settings: FAST, resume }).then((result) => ({ orca, result }))
  }

  const first = await go(chain('Build it.'), 1, false)
  assert.deepEqual(first.result, ['Plan it. @1', 'Build it. @1', 'Check it. @1'])
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(
    journal.filter((e) => e.type === 'result').map((e) => [e.key, e.result]),
    [
      [journalKey('Plan it.', { label: 'a', phase: 'Chain' }), 'Plan it. @1'],
      [journalKey('Build it.', { label: 'b', phase: 'Chain' }), 'Build it. @1'],
      [journalKey('Check it.', { label: 'c', phase: 'Chain' }), 'Check it. @1'],
    ],
  )

  const same = await go(chain('Build it.'), 2, true)
  assert.deepEqual(same.result, first.result)
  assert.deepEqual(same.orca.calls, [], 'an unchanged script touches no Orca at all')

  const edited = await go(chain('Build it twice.'), 3, true)
  assert.deepEqual(edited.result, ['Plan it. @1', 'Build it twice. @3', 'Check it. @3'])
  assert.deepEqual(started(edited.orca), ['[Chain] b', '[Chain] c'], 'c is unchanged but follows a changed call')

  const again = await go(chain('Build it twice.'), 4, true)
  assert.deepEqual(again.result, edited.result, 'the journal describes the latest run')
  assert.deepEqual(started(again.orca), [])

  const fresh = await go(chain('Build it twice.'), 5, false)
  assert.deepEqual(fresh.result, ['Plan it. @5', 'Build it twice. @5', 'Check it. @5'])
})

test('resume: the key covers every option, in any order', () => {
  const opts = { label: 'a', phase: 'P', schema: { type: 'object', properties: { x: { type: 'string' } } } }
  assert.equal(journalKey('p', opts), journalKey('p', { schema: { properties: { x: { type: 'string' } }, type: 'object' }, phase: 'P', label: 'a' }))
  assert.notEqual(journalKey('p', opts), journalKey('p', { ...opts, model: 'opus' }))
  assert.notEqual(journalKey('p', opts), journalKey('q', opts))
})

// A worker that holds its slot for `hold` ms, then submits a valid result.
const submitting = (hold = 0) => async ({ prompt, preamble, orca }) => {
  await new Promise((r) => setTimeout(r, hold))
  const argv = submitArgvIn(prompt, preamble)
  writeFileSync(argv[argv.indexOf('--payload') + 1], JSON.stringify(GOOD))
  assert.equal((await runSubmit(argv, orca)).code, 0)
}

// Liveness. Time only moves when the runner sleeps between looks, and `at`
// runs a callback once the clock passes a given time.
const MIN = 60_000
const POLL = RUNNER_SETTINGS.pollMs

function fakeClock() {
  const timers = []
  const c = {
    t: 0,
    now: () => c.t,
    at: (t, fn) => timers.push({ t, fn }),
    async sleep(ms) {
      c.t += ms
      for (const due of timers.filter((x) => x.t <= c.t)) {
        timers.splice(timers.indexOf(due), 1)
        await due.fn()
      }
      await new Promise((r) => setImmediate(r))
    },
  }
  return c
}

const ONE = `return await agent('Do a thing.', { label: 'one', phase: 'P', schema: ${JSON.stringify(SCHEMA)} })`

// Runs a script (one agent() by default) on the default settings table, each
// worker played by `worker`.
async function runOne(worker, { script = ONE, orcaPatch = {} } = {}) {
  const clock = fakeClock()
  const lines = []
  const orca = Object.assign(fakeOrca({ worker: (w) => worker({ ...w, clock }), clock }), orcaPatch)
  const result = await runScript(script, { orca, stateDir: tmp(), out: (s) => lines.push(s), clock })
  const of = (verb) => orca.calls.filter((c) => c.verb === verb)
  return { result, lines, nudges: of('terminalSend'), stop: of('workerStop')[0], released: of('workerRelease').length }
}

async function submitGood({ prompt, preamble, orca }) {
  const argv = submitArgvIn(prompt, preamble)
  writeFileSync(argv[argv.indexOf('--payload') + 1], JSON.stringify(GOOD))
  assert.equal((await runSubmit(argv, orca)).code, 0)
}

// Most workers live at once over the run: started and not yet released.
function liveHighWater(calls) {
  let live = 0
  let max = 0
  for (const c of calls) {
    if (c.verb === 'workerStart') max = Math.max(max, ++live)
    if (c.verb === 'workerRelease') live--
  }
  return max
}

const fanOut = (n, phase) => `const S = ${JSON.stringify(SCHEMA)}
return await parallel(Array.from({ length: ${n} }, (_, i) => () => agent('Name a thing.', { label: 'fan:' + i, phase: '${phase}', schema: S })))`

test('live cap: at most MAX_LIVE workers are live at once; the rest queue and run as slots free', async () => {
  assert.equal(SETTINGS.MAX_LIVE, 10)
  const lines = []
  const orca = fakeOrca({ worker: submitting(5) })
  const result = await runScript(fanOut(25, 'Fan'), { orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.deepEqual(result, Array(25).fill(GOOD))
  assert.equal(liveHighWater(orca.calls), 10)
  assert.equal(orca.calls.filter((c) => c.verb === 'workerStart').length, 25)
  assert.equal(lines.filter((l) => l.endsWith(': queued, 10 agents are live')).length, 15, lines.join('\n'))
})

test('live cap: a worker that dies frees its slot for the next queued call', async () => {
  let n = 0
  const orca = fakeOrca({
    worker: async (w) => {
      if (++n === 1) throw new Error('agent died')
      return submitting()(w)
    },
  })
  const result = await runScript(fanOut(2, 'Fan'), { orca, stateDir: tmp(), out: () => {}, settings: { ...FAST, MAX_LIVE: 1 } })
  assert.deepEqual(result, [null, GOOD])
  assert.equal(liveHighWater(orca.calls), 1)
})

test('one run: every agent of a workflow run is dispatched into one Orca Run whose objective names the spec', async () => {
  const orca = fakeOrca({ worker: submitting() })
  const script = `export const meta = { name: 'implement-spec-21', description: 'Implement spec #21 as a stack of PRs', phases: [] }
const S = ${JSON.stringify(SCHEMA)}
await parallel([1, 2, 3].map((i) => () => agent('Name a thing.', { label: 'impl:#' + i, phase: 'Implement', schema: S })))
return await agent('Name a thing.', { label: 'finalize', phase: 'Finalize', schema: S })`
  assert.deepEqual(await runScript(script, { orca, stateDir: tmp(), out: () => {}, settings: FAST }), GOOD)
  const creates = orca.calls.filter((c) => c.verb === 'runCreate')
  assert.equal(creates.length, 1)
  assert.equal(creates[0].objective, 'implement-spec-21: Implement spec #21 as a stack of PRs')
  assert.equal(orca.dispatches.size, 4)
  assert.deepEqual([...new Set([...orca.dispatches.values()].map((d) => d.run))], ['run_fake1'])
})

test('one run: the rendered workflow template names its spec in the Run objective', async () => {
  const text = readFileSync(TEMPLATE, 'utf8').replace(/__SPEC__/g, '227').replace(/__[A-Z_]+__/g, 'x')
  const orca = fakeOrca({ worker: async () => { throw new Error('agent died') } })
  await runScript(text, { orca, stateDir: tmp(), out: () => {}, settings: FAST }).catch(() => {})
  const creates = orca.calls.filter((c) => c.verb === 'runCreate')
  assert.equal(creates.length, 1)
  assert.match(creates[0].objective, /spec #227\b/)
})

test('titles: every agent is titled [Phase] label, on its task and on its tab', async () => {
  const orca = fakeOrca({ worker: submitting() })
  const script = `const S = ${JSON.stringify(SCHEMA)}
phase('Implement')
await agent('Name a thing.', { label: 'impl:#227', schema: S })
await agent('Name a thing.', { label: 'gate:#227:r2', phase: 'Gate', schema: S })
await agent('Name a thing.', { schema: S })
return null`
  await runScript(script, { orca, stateDir: tmp(), out: () => {}, settings: FAST })
  const want = ['[Implement] impl:#227', '[Gate] gate:#227:r2', '[Implement] agent-3']
  const ds = [...orca.dispatches.values()]
  assert.deepEqual(ds.map((d) => d.title), want)
  assert.deepEqual(ds.map((d) => d.tabTitle), want)
})

test('titles: a tab that cannot be renamed is reported, and the agent still runs', async () => {
  const lines = []
  const orca = fakeOrca({ worker: submitting() })
  orca.terminalRename = async () => { throw new Error('terminal_handle_stale') }
  const result = await runScript(SCRIPT, { orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.deepEqual(result, { r: GOOD })
  assert.ok(lines.some((l) => l.startsWith('!! [Tracer] tracer:thing: could not title its tab')), lines.join('\n'))
})

const within = (at, from, what) => assert.ok(at >= from && at < from + POLL, `${what} at ${at / MIN} min, expected ${from / MIN} min`)

test('settings: the liveness limits are the ticket\'s, in one table', () => {
  assert.equal(RUNNER_SETTINGS.idleNudges, 2)
  assert.equal(RUNNER_SETTINGS.silentNudgeMs, 20 * MIN)
  assert.equal(RUNNER_SETTINGS.silentDeadMs, 40 * MIN)
  assert.equal(RUNNER_SETTINGS.blockedDeadMs, 30 * MIN)
  assert.ok(Object.isFrozen(RUNNER_SETTINGS))
})

test('liveness: a worker whose terminal is gone with no result is null at the next look, never nudged', async () => {
  const r = await runOne(async ({ state }) => { state.gone = true })
  assert.equal(r.result, null)
  assert.equal(r.nudges.length, 0)
  assert.ok(r.stop && r.stop.at <= POLL, `stopped at ${r.stop?.at}`)
  assert.equal(r.released, 1)
  assert.ok(r.lines.some((l) => l.includes('its terminal is gone, with no result; agent() returns null')), r.lines.join('\n'))
})

test('liveness: a worker whose terminal is gone after submit recorded its result still delivers it', async () => {
  const r = await runOne(async ({ prompt, state }) => {
    const argv = submitArgvIn(prompt, { handle: 'h', capability: 'c', taskId: 't', dispatchId: 'd' })
    writeFileSync(argv[argv.indexOf('--result') + 1], JSON.stringify(GOOD))
    state.gone = true
  })
  assert.deepEqual(r.result, GOOD)
})

for (const how of ['idle', 'exited']) {
  test(`liveness: a worker that ${how === 'idle' ? 'goes idle' : 'exits'} without submitting is nudged twice, then null`, async () => {
    const r = await runOne(async ({ state }) => { state[how] = true })
    assert.equal(r.result, null)
    assert.equal(r.nudges.length, 2)
    for (const n of r.nudges) assert.match(n.text, /submit command/)
    within(r.nudges[0].at, RUNNER_SETTINGS.nudgeGraceMs, 'first nudge')
    within(r.nudges[1].at, 2 * RUNNER_SETTINGS.nudgeGraceMs, 'second nudge')
    within(r.stop.at, 3 * RUNNER_SETTINGS.nudgeGraceMs, 'death')
    assert.ok(r.lines.some((l) => l.includes('without submitting, after 2 nudges, with no result')), r.lines.join('\n'))
  })
}

test('liveness: an idle worker that answers its nudge by submitting returns its result', async () => {
  const r = await runOne(async (w) => {
    w.state.idle = true
    w.state.onNudge = async () => {
      w.state.idle = false
      await submitGood(w)
    }
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 1)
  assert.equal(r.stop, undefined)
})

test('liveness: a silent worker is nudged at 20 minutes and is null at 40', async () => {
  const r = await runOne(async ({ state, clock }) => {
    // The nudge's own echo is not the worker coming back.
    state.onNudge = () => { state.lastOutputAt = clock.now() + 1000 }
  })
  assert.equal(r.result, null)
  assert.equal(r.nudges.length, 1)
  within(r.nudges[0].at, 20 * MIN, 'silence nudge')
  within(r.stop.at, 40 * MIN, 'death')
  assert.ok(r.lines.some((l) => l.includes('silent for 40 minutes, with no result')), r.lines.join('\n'))
})

test('liveness: output from the worker restarts the silence clock', async () => {
  const r = await runOne(async ({ state, clock }) => {
    clock.at(30 * MIN, () => { state.lastOutputAt = 30 * MIN })
  })
  assert.equal(r.result, null)
  assert.equal(r.nudges.length, 2)
  within(r.nudges[1].at, 50 * MIN, 'second silence nudge')
  within(r.stop.at, 70 * MIN, 'death')
})

test('liveness: a worker blocked on a human is logged loudly once, never nudged, and is null after 30 minutes', async () => {
  const r = await runOne(async ({ state }) => { state.waiting = '{"evidence":"prompt-text","text":"Allow this command?"}' })
  assert.equal(r.result, null)
  assert.equal(r.nudges.length, 0)
  within(r.stop.at, 30 * MIN, 'death')
  const loud = r.lines.filter((l) => l.includes('BLOCKED ON A HUMAN'))
  assert.equal(loud.length, 1, r.lines.join('\n'))
  assert.ok(loud[0].includes('[P] one') && loud[0].includes('term_fake1'), loud[0])
  assert.ok(r.lines.some((l) => l.includes('Allow this command?')), r.lines.join('\n'))
})

test('liveness: a blocked worker the operator answers in time returns its result', async () => {
  const r = await runOne(async (w) => {
    w.state.waiting = '{"evidence":"hook"}'
    w.clock.at(29 * MIN, async () => {
      w.state.waiting = null
      await submitGood(w)
    })
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 0)
})

test('liveness: a worker Orca cannot start, or cannot be watched, is null', async () => {
  const start = await runOne(async () => {}, { orcaPatch: { workerStart: async () => { throw new Error('orca orchestration worker-start: outcome_unknown') } } })
  assert.equal(start.result, null)
  assert.ok(start.lines.some((l) => l.includes('its worker did not start')), start.lines.join('\n'))

  const watch = await runOne(async () => {}, { orcaPatch: { workerShow: async () => { throw new Error('orca orchestration worker-show: 1') } } })
  assert.equal(watch.result, null)
  within(watch.stop.at, (RUNNER_SETTINGS.watchErrors - 1) * POLL, 'death')
})

test('parallel(): a throwing thunk resolves to null and the call never rejects', async () => {
  const script = `return await parallel([
    () => { throw new Error('sync boom') },
    async () => { throw new Error('async boom') },
    () => 7,
    () => agent('Do a thing.', { label: 'dies' }),
  ])`
  const r = await runOne(async ({ state }) => { state.gone = true }, { script })
  assert.deepEqual(r.result, [null, null, 7, null])
  assert.ok(r.lines.some((l) => l.includes('thunk 0 threw (sync boom)')), r.lines.join('\n'))
})

// A worker that submits a schema-valid result, whatever it is asked.
const submittingValue = (value) => async ({ prompt, preamble, orca }) => {
  const argv = submitArgvIn(prompt, preamble)
  writeFileSync(argv[argv.indexOf('--payload') + 1], JSON.stringify(value))
  assert.equal((await runSubmit(argv, orca)).code, 0)
}

test('agent(): the harness, model and effort of each call (a pi worker takes piModel, never model) and the permission mode, reach the worker start', async () => {
  const orca = fakeOrca({ worker: submittingValue(GOOD) })
  const script = `const S = ${JSON.stringify(SCHEMA)}
await agent('a', { harness: 'claude', model: 'opus', effort: 'high', label: 'hard', schema: S })
await agent('b', { harness: 'pi', piModel: 'openai/gpt-5', model: 'sonnet', effort: 'low', label: 'cheap', schema: S })
await agent('c', { harness: 'claude', piModel: 'openai/gpt-5', model: 'haiku', label: 'claude-ignores-piModel', schema: S })
return await agent('d', { label: 'plain', schema: S })`
  await runScript(script, { orca, stateDir: tmp(), out: () => {}, settings: FAST, permissionMode: 'auto' })
  const starts = orca.calls.filter((c) => c.verb === 'workerStart').map(({ harness, model, effort, permissionMode }) => ({ harness, model, effort, permissionMode }))
  assert.deepEqual(starts, [
    { harness: 'claude', model: 'opus', effort: 'high', permissionMode: 'auto' },
    { harness: 'pi', model: 'openai/gpt-5', effort: 'low', permissionMode: null },
    { harness: 'claude', model: 'haiku', effort: undefined, permissionMode: 'auto' },
    { harness: 'claude', model: undefined, effort: undefined, permissionMode: 'auto' },
  ])
})

test('agent(): an unknown harness, or a launch word a shell could misread, throws before any worker starts', async () => {
  for (const opts of ["{ harness: 'codex' }", "{ harness: 'pi', piModel: 'opus; rm -rf /' }"]) {
    const orca = fakeOrca()
    await assert.rejects(runScript(`return await agent('x', ${opts})`, { orca, stateDir: tmp(), out: () => {} }), /unknown harness "codex"|refusing to type/)
    assert.equal(orca.calls.length, 0)
  }
})

// The CLI adapter with Orca's process replaced: every argv it would run is
// recorded, and each verb answers with the shape real Orca returns.
function recordingCli(replies = {}) {
  const argvs = []
  const defaults = {
    'terminal create': { terminal: { handle: 'term_own' } },
    'terminal wait': { wait: { satisfied: true } },
    'orchestration worker-start': { dispatchId: 'ctx_1', taskId: 'task_1', mode: { mode: 'terminal', detail: '' }, effects: [{ kind: 'terminal', role: 'agent', id: 'term_orca' }] },
  }
  const call = async (args) => {
    argvs.push(args)
    const verb = args.slice(0, 2).join(' ')
    const reply = verb in replies ? replies[verb] : defaults[verb]
    return typeof reply === 'function' ? reply(args) : reply ?? {}
  }
  return { argvs, orca: orcaCli({ call }) }
}
const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const verbsOf = (argvs) => argvs.map((a) => a.slice(0, 2).join(' '))
const START = { run: 'run_1', prompt: 'p', title: '[Implement] impl:#1' }

test('orca-cli: a Claude worker with no permission mode starts through worker-start, model and effort forwarded', async () => {
  const { argvs, orca } = recordingCli()
  const w = await orca.workerStart({ ...START, harness: 'claude', model: 'opus', effort: 'low' })
  assert.deepEqual(verbsOf(argvs), ['orchestration worker-start'])
  const [argv] = argvs
  assert.deepEqual([flag(argv, '--agent'), flag(argv, '--model'), flag(argv, '--effort'), flag(argv, '--worktree')], ['claude', 'opus', 'low', 'current'])
  assert.equal(w.terminal, 'term_orca')
})

test('orca-cli: a Claude worker starts in the given permission mode, in a terminal worker-start then supervises', async () => {
  const { argvs, orca } = recordingCli()
  const w = await orca.workerStart({ ...START, harness: 'claude', model: 'opus', effort: 'high', permissionMode: 'auto' })
  assert.deepEqual(verbsOf(argvs), ['terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(flag(argvs[0], '--command'), 'claude --permission-mode auto --model opus --effort high')
  assert.equal(flag(argvs[0], '--title'), START.title)
  assert.equal(flag(argvs[1], '--for'), 'tui-idle')
  const start = argvs[2]
  assert.equal(flag(start, '--terminal'), 'term_own')
  assert.equal(flag(start, '--spec'), 'p')
  for (const f of ['--agent', '--model', '--effort']) assert.equal(start.includes(f), false, `worker-start refuses ${f} beside --terminal`)
  assert.equal(w.terminal, 'term_own')

  // Orca's release keeps a terminal the worker did not create; the runner closes its own.
  await orca.workerRelease({ dispatch: w.dispatchId })
  assert.deepEqual(verbsOf(argvs.slice(3)), ['orchestration worker-release', 'terminal close'])
  assert.equal(flag(argvs[4], '--terminal'), 'term_own')
})

test('orca-cli: a pi worker starts with project-local files trusted, its model and effort on its own command line', async () => {
  const { argvs, orca } = recordingCli()
  await orca.workerStart({ ...START, harness: 'pi', model: 'openai/gpt-5', effort: 'low' })
  assert.equal(flag(argvs[0], '--command'), 'pi --approve --model openai/gpt-5 --thinking low')
  assert.equal(flag(argvs[2], '--terminal'), 'term_own')

  const bare = recordingCli()
  await bare.orca.workerStart({ ...START, harness: 'pi' })
  assert.equal(flag(bare.argvs[0], '--command'), 'pi --approve')
})

test('orca-cli: an agent whose TUI never goes idle is not dispatched, and its terminal is closed', async () => {
  const { argvs, orca } = recordingCli({ 'terminal wait': { wait: { satisfied: false } } })
  await assert.rejects(orca.workerStart({ ...START, harness: 'pi' }), /agent_not_ready/)
  assert.deepEqual(verbsOf(argvs), ['terminal create', 'terminal wait', 'terminal wait', 'terminal close'])
})

// Worktrees: the template's ledger and reclaim in miniature. Each isolated
// agent names its worktree; a non-isolated reclaimer removes exactly the named
// ones through Orca, as the Orca-runner reclaim wording tells it to.
const WT_SCHEMA = { type: 'object', required: ['worktree'], properties: { worktree: { type: 'string' } } }
const RECLAIM_SCHEMA = { type: 'object', required: ['removed'], properties: { removed: { type: 'integer' } } }
const WT_SCRIPT = `const WT = ${JSON.stringify(WT_SCHEMA)}
const a = await agent('Build a.', { label: 'impl:a', phase: 'Implement', schema: WT, isolation: 'worktree' })
const b = await agent('Build b.', { label: 'impl:b', phase: 'Implement', schema: WT, isolation: 'worktree' })
const named = [a, b].filter(Boolean).map((r) => r.worktree)
const r = await agent('Reclaim ' + JSON.stringify(named), { label: 'reclaim', phase: 'Finalize', schema: ${JSON.stringify(RECLAIM_SCHEMA)} })
return { a, b, removed: r.removed, worktrees_kept: [] }`

async function submitValue(prompt, preamble, orca, value) {
  const argv = submitArgvIn(prompt, preamble)
  writeFileSync(argv[argv.indexOf('--payload') + 1], JSON.stringify(value))
  assert.equal((await runSubmit(argv, orca)).code, 0)
}


// impl:b dies; impl:a names its worktree; the reclaimer removes what it is handed.
const worktreeOrca = () =>
  fakeOrca({
    worker: async ({ prompt, preamble, worktree, orca }) => {
      if (prompt.startsWith('Build b.')) throw new Error('the agent died')
      if (prompt.startsWith('Build a.')) return submitValue(prompt, preamble, orca, { worktree })
      const paths = JSON.parse(prompt.split('\n')[0].slice('Reclaim '.length))
      for (const path of paths) await orca.worktreeRemove({ path })
      return submitValue(prompt, preamble, orca, { removed: paths.length })
    },
  })

const startedAs = (orca, title) => orca.calls.find((c) => c.verb === 'workerStart' && c.title === title)

test('worktrees: an isolated agent runs in an Orca child of the run\'s worktree, a non-isolated one in the run\'s own', async () => {
  const orca = worktreeOrca()
  await runScript(WT_SCRIPT, { orca, stateDir: tmp(), out: () => {}, settings: FAST })
  for (const title of ['[Implement] impl:a', '[Implement] impl:b']) {
    const s = startedAs(orca, title)
    assert.equal(s.placement, 'new-child', title)
    assert.notEqual(s.worktree, 'C:/fake/run', title)
    assert.equal(orca.worktrees.get(s.worktree).parent, 'C:/fake/run', title)
    assert.equal(orca.worktrees.get(s.worktree).displayName, title)
  }
  assert.notEqual(startedAs(orca, '[Implement] impl:a').worktree, startedAs(orca, '[Implement] impl:b').worktree)
  const reclaim = startedAs(orca, '[Finalize] reclaim')
  assert.equal(reclaim.placement, 'current')
  assert.equal(reclaim.worktree, 'C:/fake/run')
})

test('worktrees: a dead agent\'s worktree is retained and named in the run\'s result, never removed', async () => {
  const lines = []
  const orca = worktreeOrca()
  const result = await runScript(WT_SCRIPT, { orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  const aPath = startedAs(orca, '[Implement] impl:a').worktree
  const bPath = startedAs(orca, '[Implement] impl:b').worktree

  assert.deepEqual(result.a, { worktree: aPath })
  assert.equal(result.b, null)
  assert.equal(result.removed, 1)
  assert.deepEqual(orca.calls.filter((c) => c.verb === 'worktreeRemove').map((c) => c.path), [aPath])
  assert.equal(orca.worktrees.get(aPath).removed, true)
  assert.equal(orca.worktrees.get(bPath).removed, false)
  assert.equal(orca.worktrees.get('C:/fake/run').removed, false)

  assert.equal(result.worktrees_kept.length, 1)
  assert.equal(result.worktrees_kept[0].path, bPath)
  assert.match(result.worktrees_kept[0].reason, /impl:b\) died before reporting, so it was never removed/)
  assert.ok(lines.some((l) => l.startsWith(`!! kept ${bPath}:`)), lines.join('\n'))
})

// The entry point the skill launches in its own terminal. A script that starts
// no agent never reaches Orca, so the real adapter is safe here.
const RUNNER = fileURLToPath(new URL('../skills/engineering/implement-spec-in-workflow/orca/runner.mjs', import.meta.url))
function runEntry(body) {
  const dir = tmp()
  const script = join(dir, 'workflow.js')
  writeFileSync(script, body)
  const code = spawnSync(process.execPath, [RUNNER, script], { encoding: 'utf8' }).status
  const summaryPath = join(dir, 'orca-run', 'summary.json')
  return { code, summaryPath, script, summary: () => JSON.parse(readFileSync(summaryPath, 'utf8')) }
}

test('entry point: the run\'s result is written to summary.json in the state dir, naming the runner', () => {
  const r = runEntry(`log('hi')\nreturn { stack: [], n: 1 }`)
  assert.equal(r.code, 0)
  assert.deepEqual(r.summary(), { runner: 'orca', ok: true, result: { stack: [], n: 1 } })
})

test('entry point: a script that throws still leaves a summary, with the error, and exits non-zero', () => {
  const r = runEntry(`throw new Error('boom')`)
  assert.equal(r.code, 1)
  assert.equal(r.summary().ok, false)
  assert.match(r.summary().error, /boom/)
  assert.deepEqual(r.summary().worktrees_kept, [])
})

test('entry point: a summary left by an earlier run never passes for this one', () => {
  const r = runEntry(`return 1`)
  assert.ok(existsSync(r.summaryPath))
  writeFileSync(r.script, `process.exit(3)`)
  assert.equal(spawnSync(process.execPath, [RUNNER, r.script]).status, 3)
  assert.equal(existsSync(r.summaryPath), false)
})

// --- seams between the runner's pieces ---------------------------------------

// A custom launch (a permission mode, or pi) into a child worktree: the child
// is made first and the agent's terminal opens in it, since a running process
// cannot be moved into a worktree worker-start makes afterwards.
const CHILD = { name: 'run_1-3', displayName: '[Implement] impl:#1' }
const CHILD_PATH = 'C:/wt/run_1-3'
const childCli = (replies = {}) => recordingCli({ 'worktree create': { worktree: { id: `repo::${CHILD_PATH}`, path: CHILD_PATH }, startupTerminal: { handle: 'term_shell' } }, ...replies })

for (const [what, launch, command] of [
  ['a Claude worker in a permission mode', { harness: 'claude', model: 'opus', permissionMode: 'auto' }, 'claude --permission-mode auto --model opus'],
  ['a pi worker', { harness: 'pi', model: 'openai/gpt-5' }, 'pi --approve --model openai/gpt-5'],
]) {
  test(`orca-cli: ${what} isolated in a child worktree runs its terminal in that child, made first`, async () => {
    const { argvs, orca } = childCli()
    const w = await orca.workerStart({ ...START, ...launch, child: CHILD })
    assert.deepEqual(verbsOf(argvs), ['worktree create', 'terminal close', 'worktree set', 'terminal create', 'terminal wait', 'orchestration worker-start'])
    const [create, close, set, term, , start] = argvs
    assert.equal(flag(create, '--name'), CHILD.name)
    assert.equal(flag(create, '--parent-worktree'), 'current')
    assert.equal(flag(close, '--terminal'), 'term_shell')
    assert.equal(flag(set, '--display-name'), CHILD.displayName)
    assert.equal(flag(term, '--worktree'), `path:${CHILD_PATH}`)
    assert.equal(flag(term, '--command'), command)
    assert.equal(flag(start, '--worktree'), `path:${CHILD_PATH}`)
    assert.equal(flag(start, '--terminal'), 'term_own')
    for (const f of ['--name', '--display-name']) assert.equal(start.includes(f), false, `worker-start refuses ${f} for an existing worktree`)
    assert.equal(w.worktree, CHILD_PATH)
    assert.equal(w.terminal, 'term_own')
  })
}

test('orca-cli: a custom launch that fails after its child worktree was made names that worktree on the error', async () => {
  const { argvs, orca } = childCli({ 'terminal wait': { wait: { satisfied: false } } })
  const e = await orca.workerStart({ ...START, harness: 'pi', child: CHILD }).catch((x) => x)
  assert.match(e.message, /agent_not_ready/)
  assert.equal(e.worktree, CHILD_PATH)
  assert.equal(flag(argvs.at(-1), '--terminal'), 'term_own', 'its agent terminal is closed')
})

test('orca-cli: a worktree\'s board status is set by path', async () => {
  const { argvs, orca } = recordingCli()
  await orca.worktreeStatus({ worktree: CHILD_PATH, status: 'in-review' })
  assert.deepEqual(argvs, [['worktree', 'set', '--worktree', `path:${CHILD_PATH}`, '--workspace-status', 'in-review']])
})

// Board status: in progress while an isolated agent works, in review for a
// Gate agent, completed once an agent reports the PR it published.
const PUB_SCHEMA = { type: 'object', required: ['worktree', 'pr_url', 'published'], properties: { worktree: { type: 'string' }, pr_url: { type: 'string' }, published: { type: 'boolean' } } }
const BOARD_SCRIPT = `const WT = ${JSON.stringify(WT_SCHEMA)}
const PUB = ${JSON.stringify(PUB_SCHEMA)}
await agent('Build.', { label: 'impl', phase: 'Implement', schema: WT, isolation: 'worktree' })
await agent('Die.', { label: 'dead', phase: 'Implement', schema: WT, isolation: 'worktree' })
await agent('Gate.', { label: 'gate', phase: 'Gate', schema: WT, isolation: 'worktree' })
await agent('Publish.', { label: 'publish', phase: 'Stack', schema: PUB, isolation: 'worktree' })
await agent('Refuse.', { label: 'held', phase: 'Stack', schema: PUB, isolation: 'worktree' })
return await agent('Plain.', { label: 'plain', phase: 'Finalize', schema: WT })`

const boardOrca = () => fakeOrca({
  worker: async ({ prompt, preamble, worktree, orca }) => {
    if (prompt.startsWith('Die.')) throw new Error('the agent died')
    const pub = prompt.startsWith('Publish.') || prompt.startsWith('Refuse.')
    return submitValue(prompt, preamble, orca, pub ? { worktree, pr_url: 'https://x/pull/1', published: prompt.startsWith('Publish.') } : { worktree })
  },
})

test('board status: in-progress while an isolated agent works, in-review for Gate, completed once it published', async () => {
  const orca = boardOrca()
  await runScript(BOARD_SCRIPT, { orca, stateDir: tmp(), out: () => {}, settings: FAST })
  const history = (title) => orca.calls.filter((c) => c.verb === 'worktreeStatus' && c.worktree === startedAs(orca, title).worktree).map((c) => c.status)
  assert.deepEqual(history('[Implement] impl'), ['in-progress'])
  assert.deepEqual(history('[Implement] dead'), ['in-progress'], 'a dead agent\'s worktree is retained as it stood')
  assert.deepEqual(history('[Gate] gate'), ['in-review'])
  assert.deepEqual(history('[Stack] publish'), ['in-progress', 'completed'])
  assert.deepEqual(history('[Stack] held'), ['in-progress'], 'a publisher that did not publish is not done')
  assert.deepEqual(history('[Finalize] plain'), [], 'the run\'s own worktree is never touched')
  assert.equal(orca.worktrees.get(startedAs(orca, '[Stack] publish').worktree).status, 'completed')
})

test('board status: a status Orca refuses is logged, and the agent still delivers', async () => {
  const lines = []
  const orca = boardOrca()
  orca.worktreeStatus = async () => { throw new Error('orca worktree set: selector_not_found') }
  const result = await runScript(BOARD_SCRIPT, { orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.equal(result.worktree, 'C:/fake/run')
  assert.ok(lines.some((l) => l.startsWith("!! [Gate] gate: could not set its worktree's board status to in-review")), lines.join('\n'))
})

// Resume, as the Workflow runner does it: a dead agent is journaled as failed,
// and a resume runs it live again instead of replaying its null.
async function submitText(prompt, preamble, orca, text) {
  const argv = submitArgvIn(prompt, preamble)
  writeFileSync(argv[argv.indexOf('--payload') + 1], text)
  assert.equal((await runSubmit(argv, orca)).code, 0)
}

test('resume: an agent that died runs live again on resume, and every call after it', async () => {
  const stateDir = tmp()
  const first = fakeOrca({
    worker: async ({ prompt, preamble, orca }) => {
      if (prompt.startsWith('Build it.')) throw new Error('the agent died')
      return submitText(prompt, preamble, orca, `${prompt.split('\n')[0]} @1`)
    },
  })
  assert.deepEqual(await runScript(chain('Build it.'), { orca: first, stateDir, out: () => {}, settings: FAST }), ['Plan it. @1', null, 'Check it. @1'])
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const b = journal.filter((e) => e.key === journalKey('Build it.', { label: 'b', phase: 'Chain' }) && e.type !== 'started')
  assert.deepEqual(b.map((e) => [e.type, 'result' in e]), [['failed', false]])

  const lines = []
  const second = answering(2)
  const result = await runScript(chain('Build it.'), { orca: second, stateDir, out: (s) => lines.push(s), settings: FAST, resume: true })
  assert.deepEqual(result, ['Plan it. @1', 'Build it. @2', 'Check it. @2'])
  assert.deepEqual(started(second), ['[Chain] b', '[Chain] c'])
  assert.ok(lines.includes('>> [Chain] b: failed in the last run; this call and every one after it run live'), lines.join('\n'))
})

test('resume: a failed call keeps its place among identical calls, so a later one\'s result is never replayed into it', async () => {
  const stateDir = tmp()
  const script = `const x = await agent('Same.', { label: 's' })
const y = await agent('Same.', { label: 's' })
return [x, y]`
  let n = 0
  const first = fakeOrca({
    worker: async ({ prompt, preamble, orca }) => {
      if (++n === 1) throw new Error('the agent died')
      return submitText(prompt, preamble, orca, 'Same. @1')
    },
  })
  assert.deepEqual(await runScript(script, { orca: first, stateDir, out: () => {}, settings: FAST }), [null, 'Same. @1'])
  const second = answering(2)
  assert.deepEqual(await runScript(script, { orca: second, stateDir, out: () => {}, settings: FAST, resume: true }), ['Same. @2', 'Same. @2'])
  assert.equal(started(second).length, 2)
})

test('resume: a dead agent\'s worktree from the earlier run stays named in the result, resume after resume', async () => {
  const stateDir = tmp()
  const one = worktreeOrca()
  const r1 = await runScript(WT_SCRIPT, { orca: one, stateDir, out: () => {}, settings: FAST })
  const deadPath = startedAs(one, '[Implement] impl:b').worktree
  assert.deepEqual(r1.worktrees_kept.map((k) => k.path), [deadPath])

  // impl:b re-runs live in a new worktree and delivers; its old one is still on disk.
  const two = fakeOrca({
    worker: async ({ prompt, preamble, worktree, orca }) =>
      submitValue(prompt, preamble, orca, prompt.startsWith('Reclaim') ? { removed: 0 } : { worktree }),
  })
  two.runCreate = async () => ({ runId: 'run_second' })
  const lines = []
  const r2 = await runScript(WT_SCRIPT, { orca: two, stateDir, out: (s) => lines.push(s), settings: FAST, resume: true })
  assert.notEqual(r2.b.worktree, deadPath)
  assert.deepEqual(r2.worktrees_kept.map((k) => k.path), [deadPath])
  assert.match(r2.worktrees_kept[0].reason, /impl:b\) died before reporting/)
  assert.ok(lines.some((l) => l.startsWith(`!! kept ${deadPath}:`)), lines.join('\n'))

  const three = fakeOrca()
  const r3 = await runScript(WT_SCRIPT, { orca: three, stateDir, out: () => {}, settings: FAST, resume: true })
  assert.deepEqual(three.calls, [], 'everything replays')
  assert.deepEqual(r3.worktrees_kept.map((k) => k.path), [deadPath])
})

test('worktrees: a worktree made for a worker that never started is retained and named', async () => {
  const orca = fakeOrca()
  orca.workerStart = async () => { throw Object.assign(new Error('orca terminal wait: agent_not_ready'), { worktree: 'C:/fake/worktrees/orphan' }) }
  const script = `const a = await agent('Build.', { label: 'impl', phase: 'Implement', isolation: 'worktree' })
return { a, worktrees_kept: [] }`
  const result = await runScript(script, { orca, stateDir: tmp(), out: () => {}, settings: FAST })
  assert.equal(result.a, null)
  assert.deepEqual(result.worktrees_kept.map((k) => k.path), ['C:/fake/worktrees/orphan'])
  assert.match(result.worktrees_kept[0].reason, /whose worker never started/)
})

test('worktrees: a run that throws still names what it kept, and its failure summary carries it', async () => {
  const orca = worktreeOrca()
  const script = `const b = await agent('Build b.', { label: 'layer0', phase: 'Setup', schema: ${JSON.stringify(WT_SCHEMA)}, isolation: 'worktree' })
if (!b) throw new Error('layer-0 PR failed')
return b`
  const e = await runScript(script, { orca, stateDir: tmp(), out: () => {}, settings: FAST }).catch((x) => x)
  assert.match(e.message, /layer-0 PR failed/)
  const deadPath = startedAs(orca, '[Setup] layer0').worktree
  const summary = failureSummary(e)
  assert.equal(summary.ok, false)
  assert.match(summary.error, /layer-0 PR failed/)
  assert.deepEqual(summary.worktrees_kept.map((k) => k.path), [deadPath])
  assert.match(summary.worktrees_kept[0].reason, /layer0\) died before reporting/)
})

test('one run: a Run Orca cannot create is that agent\'s null, and the next agent() creates it', async () => {
  const lines = []
  const orca = fakeOrca({ worker: submitting() })
  const create = orca.runCreate
  let tries = 0
  orca.runCreate = async (a) => {
    if (++tries === 1) throw new Error('orca orchestration run-create: runtime_unavailable')
    return create(a)
  }
  const script = `const S = ${JSON.stringify(SCHEMA)}
const a = await agent('Name a thing.', { label: 'a', schema: S })
const b = await agent('Name a thing.', { label: 'b', schema: S })
return [a, b]`
  const stateDir = tmp()
  assert.deepEqual(await runScript(script, { orca, stateDir, out: (s) => lines.push(s), settings: FAST }), [null, GOOD])
  assert.equal(tries, 2)
  assert.deepEqual(started(orca), ['[Run] b'])
  assert.ok(lines.some((l) => l.includes("[Run] a: Orca could not create this run's Run") && l.includes('runtime_unavailable')), lines.join('\n'))
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(journal.find((e) => e.title === '[Run] a').type, 'failed')
})
