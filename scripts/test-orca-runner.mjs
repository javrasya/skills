// Offline tests for the Orca runner: submit, the agent() round trip, the live
// cap, how a run is laid out in Orca, resume from the journal, and every way a
// worker dies becoming null, with the fake Orca standing in for the CLI
// adapter and a fake clock standing in for time.
//   node scripts/test-orca-runner.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { submit } from '../skills/engineering/implement-spec-in-workflow/orca/submit.mjs'
import { runScript, journalKey, failureSummary, SUBMIT, SETTINGS, realClock, JOURNAL_ENTRIES } from '../skills/engineering/implement-spec-in-workflow/orca/runner.mjs'
import { agentLifecycle } from '../skills/engineering/implement-spec-in-workflow/orca/lifecycle.mjs'
import { fakeOrca, fakeTranscripts } from '../skills/engineering/implement-spec-in-workflow/orca/fake-orca.mjs'
import { RUNNER_SETTINGS } from '../skills/engineering/implement-spec-in-workflow/orca/settings.mjs'
import { orcaCli, OrcaError } from '../skills/engineering/implement-spec-in-workflow/orca/orca-cli.mjs'
import { runRegistry, readRegistry, OUTCOMES } from '../skills/engineering/implement-spec-in-workflow/orca/registry.mjs'
import { transcriptPath, sessionTranscripts, claudeSlug, piDir } from '../skills/engineering/implement-spec-in-workflow/orca/transcript.mjs'

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
const SID = '0b7f3c2e-5d1a-4c8e-9f60-2a4b6c8d0e1f'
const journalOf = (stateDir) => readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const FAST = { pollMs: 1 }
const TEMPLATE = new URL('../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url)

// A dispatched worker as submit sees it: its preamble IDs and its files.
async function startedWorker() {
  const dir = tmp()
  const orca = fakeOrca()
  const w = await orca.workerStart({ run: 'run_fake', prompt: '', title: 't', sessionId: SID })
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
    // Fires once everything else has had its turn, so time jumps to its
    // deadline only for a call nothing answers; a cancelled one moves nothing.
    timer(ms) {
      const due = c.t + ms
      let cancelled = false
      const promise = new Promise((r) => setImmediate(() => setImmediate(async () => {
        if (cancelled) return
        if (c.t < due) await c.sleep(due - c.t)
        r()
      })))
      return { promise, cancel: () => { cancelled = true } }
    },
  }
  return c
}

const ONE = `return await agent('Do a thing.', { label: 'one', phase: 'P', schema: ${JSON.stringify(SCHEMA)} })`

// Runs a script (one agent() by default) on the default settings table, each
// worker played by `worker`.
async function runOne(worker, { script = ONE, orcaPatch = {}, permissionMode = null, faults = {}, settings = {} } = {}) {
  const clock = fakeClock()
  const lines = []
  const stateDir = tmp()
  const orca = Object.assign(fakeOrca({ worker: (w) => worker({ ...w, clock }), clock, faults }), orcaPatch)
  const result = await runScript(script, { orca, stateDir, out: (s) => lines.push(s), clock, permissionMode, settings, transcripts: fakeTranscripts(orca) })
  const of = (verb) => orca.calls.filter((c) => c.verb === verb)
  const log = readFileSync(join(stateDir, 'runner.log'), 'utf8').trimEnd().split('\n')
  return {
    result, lines, nudges: of('terminalSend'), stop: of('workerStop')[0], released: of('workerRelease').length, releases: of('workerRelease'),
    continues: of('workerContinue'), start: of('workerStart')[0], orca, journal: journalOf(stateDir), log,
  }
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
  assert.equal(RUNNER_SETTINGS.stuckNudgeMs, 20 * MIN)
  assert.equal(RUNNER_SETTINGS.stuckContinueMs, 40 * MIN)
  assert.equal(RUNNER_SETTINGS.maxContinuations, 3)
  assert.equal(RUNNER_SETTINGS.blockedFailMs, 30 * MIN)
  assert.ok(Object.isFrozen(RUNNER_SETTINGS))
})

// A continued session that finishes the job: it submits with the preamble it
// now holds, which is a new one when its tab was gone.
const submitsOnContinue = (state) => { state.onContinue = submitGood }
const oneOn = (harness, more = '') => `return await agent('Do a thing.', { label: 'one', phase: 'P', schema: ${JSON.stringify(SCHEMA)}${harness === 'pi' ? ", harness: 'pi'" : ''}${more} })`
const RESUME = { claude: (sid) => `claude --resume ${sid}`, pi: (sid) => `pi --approve --session-id ${sid}` }
const ofType = (journal, type) => journal.filter((e) => e.type === type)

for (const harness of ['claude', 'pi']) {
  test(`continuation (${harness}): a worker whose transcript and terminal have not moved is nudged at 20 minutes, then continued at 40 in its own terminal, and its result is returned`, async () => {
    const r = await runOne(async ({ state }) => {
      // The nudge lands in the transcript: that is the nudge, not the worker.
      state.onNudge = () => { state.transcript = (state.transcript ?? 0) + 120 }
      submitsOnContinue(state)
    }, { script: oneOn(harness) })
    assert.deepEqual(r.result, GOOD)
    assert.equal(r.nudges.length, 1)
    within(r.nudges[0].at, 20 * MIN, 'nudge')
    assert.equal(r.continues.length, 1)
    const [c] = r.continues
    within(c.at, 40 * MIN, 'continuation')
    const started = ofType(r.journal, 'started')[0]
    assert.equal(c.reopened, false)
    assert.equal(c.interrupted, true, 'the stalled process is stopped first')
    assert.equal(c.terminal, started.terminal, 'the same terminal')
    assert.equal(c.dispatchId, started.dispatchId)
    assert.ok(c.command.startsWith(RESUME[harness](started.sessionId)), c.command)
    assert.match(c.text, /You were interrupted/)
    assert.equal(r.stop, undefined)
    assertEntries(r.journal)
    assert.deepEqual(ofType(r.journal, 'nudge').map((e) => [e.attempt, e.dispatchId]), [[1, started.dispatchId]])
    assert.match(ofType(r.journal, 'nudge')[0].reason, /no movement in its transcript or terminal for 20 minutes/)
    const [cont] = ofType(r.journal, 'continued')
    assert.deepEqual([cont.attempt, cont.reopened, cont.sessionId, cont.terminal, cont.dispatchId], [1, false, started.sessionId, started.terminal, started.dispatchId])
    assert.match(cont.reason, /no movement in its transcript or terminal for 40 minutes/)
    assert.deepEqual(ofType(r.journal, 'result').map((e) => e.result), [GOOD])
  })

  test(`continuation (${harness}): with its tab gone, the session is resumed in a new terminal in the same worktree, and the continued agent's result is returned`, async () => {
    const r = await runOne(async ({ state }) => {
      state.gone = true
      submitsOnContinue(state)
    }, { script: oneOn(harness, ", isolation: 'worktree'") })
    assert.deepEqual(r.result, GOOD)
    assert.equal(r.nudges.length, 0, 'a gone tab is not nudged')
    const [c] = r.continues
    const started = ofType(r.journal, 'started')[0]
    assert.equal(c.reopened, true)
    assert.notEqual(started.worktree, 'C:/fake/run')
    assert.equal(c.worktree, started.worktree, 'the same worktree')
    assert.notEqual(c.terminal, started.terminal, 'a new terminal')
    assert.ok(c.command.startsWith(RESUME[harness](started.sessionId)), c.command)
    assert.equal(c.argv[c.argv.indexOf('--terminal') + 1], c.terminal, 'worker-start adopts the new terminal')
    assert.ok(c.at <= POLL, `continued at ${c.at}`)
    // The old dispatch's pane is gone, so it is stopped and released.
    assert.equal(r.stop.dispatchId, started.dispatchId)
    assert.deepEqual(r.releases.map((x) => x.dispatchId), [started.dispatchId, c.dispatchId])
    const [cont] = ofType(r.journal, 'continued')
    assert.deepEqual([cont.attempt, cont.reopened, cont.terminal, cont.dispatchId, cont.sessionId], [1, true, c.terminal, c.dispatchId, started.sessionId])
    assert.equal(cont.reason, 'its terminal is gone')
    assert.equal(r.orca.dispatches.get(c.dispatchId).tabTitle, '[P] one', 'the new tab is titled too')
  })
}

test('continuation: a transcript that grows behind an idle terminal is not stuck', async () => {
  const r = await runOne(async (w) => {
    w.state.idle = true
    for (let m = 1; m <= 60; m++) w.clock.at(m * MIN, () => { w.state.transcript = m * 100 })
    w.clock.at(61 * MIN, () => submitGood(w))
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 0)
  assert.equal(r.continues.length, 0)
})

test('continuation: a terminal that keeps changing between busy and idle behind a still transcript is not stuck', async () => {
  const r = await runOne(async (w) => {
    for (let k = 1; k <= 40; k++) w.clock.at(k * 90_000, () => { w.state.idle = !w.state.idle })
    w.clock.at(61 * MIN, () => submitGood(w))
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 0)
  assert.equal(r.continues.length, 0)
})

test('continuation: a fourth death fails the agent with a reason naming the cap, and keeps its tab and worktree', async () => {
  // Every session goes idle without submitting, the continued ones included.
  const idleAgain = async ({ state }) => {
    state.idle = true
    state.onContinue = idleAgain
  }
  const r = await runOne(idleAgain, { script: oneOn('claude', ", isolation: 'worktree'") })
  assert.equal(r.result, null)
  assert.equal(r.continues.length, 3)
  assert.equal(new Set(r.continues.map((c) => c.terminal)).size, 1, 'each continued in its own terminal')
  assertEntries(r.journal)
  const started = ofType(r.journal, 'started')[0]
  assert.deepEqual(ofType(r.journal, 'continued').map((e) => e.attempt), [1, 2, 3])
  for (const e of ofType(r.journal, 'continued')) assert.equal(e.reason, 'it went idle without submitting, after 2 nudges')
  assert.deepEqual(ofType(r.journal, 'nudge').map((e) => e.attempt), [1, 2, 1, 2, 1, 2, 1, 2])
  for (const e of ofType(r.journal, 'nudge')) assert.match(e.reason, /^it went idle without submitting \(nudge [12] of 2\)$/)
  const [failed] = ofType(r.journal, 'failed')
  assert.equal(failed.reason, 'it went idle without submitting, after 2 nudges, and its session was already continued 3 times, the cap of 3, with no result')
  assert.equal(failed.continuations, 3)
  // Kept: its process is not stopped, its tab not closed, its worktree retained.
  assert.equal(r.stop, undefined)
  assert.deepEqual(r.releases.map((x) => x.keepTerminal), [true])
  assert.equal(r.orca.dispatches.get(started.dispatchId).tabClosed, false)
  assert.equal(failed.retained.path, started.worktree)
  assert.ok(r.lines.some((l) => l.startsWith(`!! kept ${started.worktree}:`)), r.lines.join('\n'))
  assert.ok(r.lines.some((l) => l.includes(`its tab ${started.terminal} is kept open`)), r.lines.join('\n'))
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
  test(`liveness: a worker that ${how === 'idle' ? 'goes idle' : 'exits'} without submitting is nudged twice, then continued`, async () => {
    const r = await runOne(async ({ state }) => {
      state[how] = true
      submitsOnContinue(state)
    })
    assert.deepEqual(r.result, GOOD)
    assert.equal(r.nudges.length, 2)
    for (const n of r.nudges) assert.match(n.text, /submit command/)
    within(r.nudges[0].at, RUNNER_SETTINGS.nudgeGraceMs, 'first nudge')
    within(r.nudges[1].at, 2 * RUNNER_SETTINGS.nudgeGraceMs, 'second nudge')
    assert.equal(r.continues.length, 1)
    within(r.continues[0].at, 3 * RUNNER_SETTINGS.nudgeGraceMs, 'continuation')
    assert.equal(r.continues[0].reopened, false)
    assert.equal(ofType(r.journal, 'continued')[0].reason, `it ${how === 'idle' ? 'went idle' : 'exited'} without submitting, after 2 nudges`)
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

test('liveness: transcript growth restarts the no-movement clock', async () => {
  const r = await runOne(async ({ state, clock }) => {
    clock.at(30 * MIN, () => { state.transcript = 500 })
    submitsOnContinue(state)
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 2)
  within(r.nudges[1].at, 50 * MIN, 'second nudge')
  within(r.continues[0].at, 70 * MIN, 'continuation')
})

test('liveness: a worker blocked on a human is logged loudly once, never nudged, and after 30 minutes fails and is kept, never continued', async () => {
  const r = await runOne(async ({ state }) => { state.waiting = '{"evidence":"prompt-text","text":"Allow this command?"}' })
  assert.equal(r.result, null)
  assert.equal(r.nudges.length, 0)
  assert.equal(r.continues.length, 0)
  assert.equal(r.stop, undefined)
  assert.deepEqual(r.releases.map((x) => [x.keepTerminal, x.at >= 30 * MIN && x.at < 30 * MIN + POLL]), [[true, true]])
  assert.equal(r.orca.dispatches.get('ctx_fake1').tabClosed, false)
  assert.equal(ofType(r.journal, 'failed')[0].reason, 'blocked on a human, unanswered for 30 minutes, with no result')
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
  const r = await runOne(async () => { throw new Error('the agent died') }, { script })
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
function recordingCli(replies = {}, { git, clock } = {}) {
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
  return { argvs, orca: orcaCli({ call, git, clock }) }
}
const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const verbsOf = (argvs) => argvs.map((a) => a.slice(0, 2).join(' '))
const START = { run: 'run_1', prompt: 'p', title: '[Implement] impl:#1', sessionId: SID }

test('orca-cli: a Claude worker with no permission mode starts from its own command line too, with its session id, never through --agent', async () => {
  const { argvs, orca } = recordingCli()
  const w = await orca.workerStart({ ...START, harness: 'claude', model: 'opus', effort: 'low' })
  assert.deepEqual(verbsOf(argvs), ['terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(flag(argvs[0], '--command'), `claude --session-id ${SID} --model opus --effort low`)
  const start = argvs[2]
  assert.deepEqual([flag(start, '--worktree'), flag(start, '--terminal')], ['current', 'term_own'])
  for (const f of ['--agent', '--model', '--effort']) assert.equal(start.includes(f), false, `worker-start refuses ${f} beside --terminal`)
  assert.equal(w.terminal, 'term_own')
})

test('orca-cli: a worker with no session id is refused before Orca is called', async () => {
  const { argvs, orca } = recordingCli()
  await assert.rejects(orca.workerStart({ ...START, sessionId: undefined }), /no session id/)
  assert.deepEqual(argvs, [])
})

test("orca-cli: a worker in the run's own worktree is named with that worktree's path, from its terminal", async () => {
  const { orca } = recordingCli({ 'terminal create': { terminal: { handle: 'term_own', worktreeId: 'repo::C:/wt/run' } } })
  assert.equal((await orca.workerStart(START)).worktree, 'C:/wt/run')
})

test('orca-cli: a Claude worker starts in the given permission mode, in a terminal worker-start then supervises', async () => {
  const { argvs, orca } = recordingCli()
  const w = await orca.workerStart({ ...START, harness: 'claude', model: 'opus', effort: 'high', permissionMode: 'auto' })
  assert.deepEqual(verbsOf(argvs), ['terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(flag(argvs[0], '--command'), `claude --session-id ${SID} --permission-mode auto --model opus --effort high`)
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
  assert.equal(flag(argvs[0], '--command'), `pi --approve --session-id ${SID} --model openai/gpt-5 --thinking low`)
  assert.equal(flag(argvs[2], '--terminal'), 'term_own')

  const bare = recordingCli()
  await bare.orca.workerStart({ ...START, harness: 'pi' })
  assert.equal(flag(bare.argvs[0], '--command'), `pi --approve --session-id ${SID}`)
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
const childCli = (replies = {}, opts) => recordingCli({ 'worktree create': { worktree: { id: `repo::${CHILD_PATH}`, path: CHILD_PATH }, startupTerminal: { handle: 'term_shell' } }, ...replies }, opts)

for (const [what, launch, command] of [
  ['a Claude worker', { harness: 'claude', model: 'opus' }, `claude --session-id ${SID} --model opus`],
  ['a Claude worker in a permission mode', { harness: 'claude', model: 'opus', permissionMode: 'auto' }, `claude --session-id ${SID} --permission-mode auto --model opus`],
  ['a pi worker', { harness: 'pi', model: 'openai/gpt-5' }, `pi --approve --session-id ${SID} --model openai/gpt-5`],
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
    for (const f of ['--name', '--display-name', '--agent']) assert.equal(start.includes(f), false, `worker-start refuses ${f} for an existing worktree`)
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

test('orca-cli: a call Orca never answers fails as call_timeout on the clock; a start it hangs closes its terminal and names its worktree', async () => {
  const clock = fakeClock()
  const { argvs, orca } = childCli({ 'orchestration worker-start': () => new Promise(() => {}) }, { clock })
  const e = await orca.workerStart({ ...START, child: CHILD }).catch((x) => x)
  assert.equal(e.code, 'call_timeout')
  assert.match(e.message, /^orca orchestration worker-start: call_timeout: no answer within 120s$/)
  assert.equal(clock.now(), RUNNER_SETTINGS.orcaCallMs)
  assert.equal(e.worktree, CHILD_PATH)
  assert.deepEqual(verbsOf(argvs).slice(-2), ['orchestration worker-start', 'terminal close'])
})

test('orca-cli: a wait is bounded by the call timeout on top of the time it asks Orca to wait', async () => {
  const clock = fakeClock()
  const { orca } = recordingCli({ 'terminal wait': () => new Promise(() => {}) }, { clock })
  await assert.rejects(orca.terminalIdle({ terminal: 'term_1', timeoutMs: 1_000 }), /call_timeout/)
  assert.equal(clock.now(), RUNNER_SETTINGS.orcaCallMs + 1_000)
})

// git as the adapter runs it in a worktree: each command's stdout, by subcommand.
function gitStub(answers = {}) {
  const runs = []
  return { runs, git: async (cwd, args) => (runs.push([cwd, ...args]), answers[args[0]] ?? '') }
}
const EARLIER = {
  'worktree list': { worktrees: [{ path: 'C:/wt/other', branch: 'refs/heads/u/other' }, { path: CHILD_PATH, branch: 'refs/heads/u/run_1-3' }] },
  'terminal list': { terminals: [{ handle: 'term_shell', title: 'Terminal 1', orphaned: false, connected: true }] },
}

test('orca-cli: a retried start takes up the clean worktree of its name, which a second create would have made <name>-2', async () => {
  const g = gitStub({ status: '', 'rev-list': '0\n' })
  const { argvs, orca } = childCli(EARLIER, { git: g.git })
  const w = await orca.workerStart({ ...START, harness: 'pi', child: { ...CHILD, retry: true } })
  assert.equal(w.worktree, CHILD_PATH)
  assert.deepEqual(verbsOf(argvs), ['worktree list', 'terminal list', 'worktree set', 'terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(flag(argvs[1], '--worktree'), `path:${CHILD_PATH}`)
  assert.equal(flag(argvs[3], '--worktree'), `path:${CHILD_PATH}`)
  assert.deepEqual(g.runs, [[CHILD_PATH, 'status', '--porcelain'], [CHILD_PATH, 'rev-list', '--count', 'HEAD', '--not', '--exclude=u/run_1-3', '--branches', '--remotes']])
  assert.deepEqual(w.warnings, [])

  const none = childCli({ ...EARLIER, 'worktree list': { worktrees: [] } }, { git: gitStub().git })
  await none.orca.workerStart({ ...START, child: { ...CHILD, retry: true } })
  assert.deepEqual(verbsOf(none.argvs).slice(0, 2), ['worktree list', 'worktree create'], 'a retry with no worktree of its name yet makes it')
})

test('orca-cli: a retry refuses a worktree of its name that holds work, for good, and one an agent still runs in, for this attempt', async () => {
  const held = { ...EARLIER, 'terminal list': { terminals: [{ handle: 'term_x', agentIdentity: 'claude', orphaned: false }] } }
  for (const [replies, answers, code, final] of [
    [EARLIER, { status: '?? notes.txt\n', 'rev-list': '0' }, 'worktree_dirty', true],
    [EARLIER, { status: '', 'rev-list': '3\n' }, 'worktree_has_commits', true],
    [held, {}, 'worktree_held', false],
  ]) {
    const { argvs, orca } = childCli(replies, { git: gitStub(answers).git })
    const e = await orca.workerStart({ ...START, child: { ...CHILD, retry: true } }).catch((x) => x)
    assert.equal(e.code, code)
    assert.equal(e.final, final, code)
    assert.equal(e.worktree, CHILD_PATH, code)
    for (const v of ['worktree create', 'terminal create']) assert.equal(verbsOf(argvs).includes(v), false, `${code}: ${v}`)
  }
})

test("orca-cli: a retry asks for Orca's whole worktree list, and a page still truncated fails the attempt, retryable, never read as 'not found'", async () => {
  const { argvs, orca } = childCli({ 'worktree list': { worktrees: [{ path: 'C:/wt/other', branch: 'refs/heads/u/other' }], truncated: true } }, { git: gitStub().git })
  const e = await orca.workerStart({ ...START, child: { ...CHILD, retry: true } }).catch((x) => x)
  assert.equal(e.code, 'worktree_list_truncated')
  assert.match(e.message, /could not be ruled out/)
  assert.notEqual(e.final, true, 'a truncated page is retried')
  assert.deepEqual(argvs, [['worktree', 'list', '--limit', '10000']], 'no create, no terminal')
})

test('orca-cli: a create Orca answers with <name>-2 fails for good, naming the new worktree and the earlier one of its name', async () => {
  const taken = `${CHILD_PATH}-2`
  const { argvs, orca } = childCli({ 'worktree create': { worktree: { id: `repo::${taken}`, path: taken }, startupTerminal: { handle: 'term_shell' } } })
  const e = await orca.workerStart({ ...START, child: CHILD }).catch((x) => x)
  assert.equal(e.code, 'worktree_name_taken')
  assert.match(e.message, /asked for run_1-3, Orca made run_1-3-2/)
  assert.equal(e.final, true)
  assert.equal(e.worktree, taken)
  assert.deepEqual(e.worktrees, [taken, CHILD_PATH])
  assert.deepEqual(verbsOf(argvs), ['worktree create', 'terminal close'], 'its startup shell is closed; no agent terminal, no worker-start')
})

test('orca-cli: a display name Orca refuses is a warning the start returns, and the start goes on', async () => {
  const { orca } = childCli({ 'worktree set': () => { throw new OrcaError('selector_not_found', 'gone', 'worktree set') } })
  const w = await orca.workerStart({ ...START, child: CHILD })
  assert.deepEqual(w.warnings, ["could not set its worktree's display name: orca worktree set: selector_not_found: gone"])
  assert.equal(w.terminal, 'term_own')
})

test('orca-cli: a worktree\'s board status is set by path', async () => {
  const { argvs, orca } = recordingCli()
  await orca.worktreeStatus({ worktree: CHILD_PATH, status: 'in-review' })
  assert.deepEqual(argvs, [['worktree', 'set', '--worktree', `path:${CHILD_PATH}`, '--workspace-status', 'in-review']])
})

// Session continuation through the real adapter.
const CONTINUE = { run: 'run_1', dispatch: 'ctx_old', terminal: 'term_old', worktree: CHILD_PATH, title: '[Implement] impl:#1', prompt: 'You were interrupted', sessionId: SID }

for (const [harness, launch, command] of [
  ['claude', { harness: 'claude', model: 'opus', permissionMode: 'auto' }, `claude --resume ${SID} --permission-mode auto --model opus`],
  ['pi', { harness: 'pi', model: 'openai/gpt-5', effort: 'low' }, `pi --approve --session-id ${SID} --model openai/gpt-5 --thinking low`],
]) {
  test(`orca-cli: continuing a ${harness} session with its tab alive stops the process, then resumes the session in the same terminal and prompts it`, async () => {
    const { argvs, orca } = recordingCli()
    const w = await orca.workerContinue({ ...CONTINUE, ...launch })
    assert.deepEqual(verbsOf(argvs), ['terminal send', 'terminal send', 'terminal send', 'terminal send', 'terminal wait', 'terminal send'])
    for (const a of argvs.slice(0, 3)) assert.deepEqual(a, ['terminal', 'send', '--terminal', 'term_old', '--interrupt'])
    assert.equal(flag(argvs[3], '--terminal'), 'term_old')
    assert.equal(flag(argvs[3], '--text'), command)
    assert.ok(argvs[3].includes('--enter'))
    assert.equal(flag(argvs[4], '--terminal'), 'term_old')
    assert.equal(flag(argvs[5], '--text'), 'You were interrupted')
    assert.deepEqual(w, { dispatchId: 'ctx_old', terminal: 'term_old', worktree: CHILD_PATH, reopened: false })
  })

  test(`orca-cli: continuing a ${harness} session with its tab gone resumes it in a new terminal in the same worktree, which worker-start adopts`, async () => {
    const { argvs, orca } = recordingCli()
    const w = await orca.workerContinue({ ...CONTINUE, ...launch, reopen: true })
    assert.deepEqual(verbsOf(argvs), ['terminal create', 'terminal wait', 'orchestration worker-start'])
    assert.equal(flag(argvs[0], '--worktree'), `path:${CHILD_PATH}`)
    assert.equal(flag(argvs[0], '--command'), command)
    const start = argvs[2]
    assert.deepEqual([flag(start, '--terminal'), flag(start, '--worktree'), flag(start, '--spec')], ['term_own', `path:${CHILD_PATH}`, 'You were interrupted'])
    assert.equal(start.includes('--agent'), false)
    assert.deepEqual(w, { dispatchId: 'ctx_1', taskId: 'task_1', terminal: 'term_own', worktree: CHILD_PATH, reopened: true })
  })
}

test('orca-cli: a tab that refuses the continuation is taken for gone, and the session resumes in a new terminal', async () => {
  const { argvs, orca } = recordingCli({ 'terminal send': () => { throw new OrcaError('terminal_not_writable', '', 'terminal send') } })
  const w = await orca.workerContinue(CONTINUE)
  assert.deepEqual(verbsOf(argvs).slice(-3), ['terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(w.reopened, true)
  const other = recordingCli({ 'terminal send': () => { throw new OrcaError('runtime_unavailable', '', 'terminal send') } })
  await assert.rejects(other.orca.workerContinue(CONTINUE), /runtime_unavailable/)
  assert.equal(verbsOf(other.argvs).includes('terminal create'), false)
})

test("orca-cli: a kept agent's release leaves its tab open", async () => {
  const { argvs, orca } = recordingCli()
  const w = await orca.workerStart(START)
  await orca.workerRelease({ dispatch: w.dispatchId, keepTerminal: true })
  assert.deepEqual(verbsOf(argvs.slice(3)), ['orchestration worker-release'])
})

// --- transcripts: where each harness writes one, found from its session id ---

test('transcripts: a Claude session is found under its worktree\'s project slug, or by scanning every project', () => {
  const home = tmp()
  const wt = join(home, 'wt', 'run_1-3')
  const projects = join(home, '.claude', 'projects')
  const at = join(projects, claudeSlug(wt), `${SID}.jsonl`)
  assert.equal(transcriptPath({ harness: 'claude', sessionId: SID, worktree: wt, home, env: {} }), null)
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, '{}\n')
  assert.ok(!claudeSlug(wt).includes('_') && !claudeSlug(wt).includes(':'))
  assert.equal(transcriptPath({ harness: 'claude', sessionId: SID, worktree: wt, home, env: {} }), at)
  const other = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
  const elsewhere = join(projects, 'shortened-slug-1a2b', `${other}.jsonl`)
  mkdirSync(dirname(elsewhere), { recursive: true })
  writeFileSync(elsewhere, '{}\n')
  assert.equal(transcriptPath({ harness: 'claude', sessionId: other, worktree: wt, home, env: {} }), elsewhere)
  assert.equal(transcriptPath({ harness: 'claude', sessionId: other, worktree: wt, scan: false, home, env: {} }), null)
})

test('transcripts: a pi session is found by its id in its worktree\'s session dir, whatever timestamp its name carries', () => {
  const home = tmp()
  const wt = join(home, 'wt', 'run_1-3')
  assert.ok(piDir(wt).startsWith('--') && piDir(wt).endsWith('run_1-3--'), piDir(wt))
  const at = join(home, '.pi', 'agent', 'sessions', piDir(wt), `2026-09-24T16-26-07-244Z_${SID}.jsonl`)
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, '{"type":"session"}\n')
  assert.equal(transcriptPath({ harness: 'pi', sessionId: SID, worktree: wt, home, env: {} }), at)
  assert.equal(transcriptPath({ harness: 'pi', sessionId: SID, worktree: null, home, env: {} }), at, 'found by scanning')
})

test("transcripts: size is the transcript's bytes as it grows, and null while none is written", () => {
  const home = tmp()
  const wt = join(home, 'wt')
  const t = sessionTranscripts({ home, env: {} })
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), null)
  const at = join(home, '.claude', 'projects', claudeSlug(wt), `${SID}.jsonl`)
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, 'abc\n')
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), 4)
  appendFileSync(at, 'defg\n')
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), 9)
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
  const result = await runScript(script, { orca, stateDir: tmp(), out: () => {}, settings: FAST, clock: fakeClock() })
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

test('one run: a Run Orca cannot create, retries included, is that agent\'s null, and the next agent() creates it', async () => {
  const lines = []
  const orca = fakeOrca({ worker: submitting() })
  const create = orca.runCreate
  let tries = 0
  const attempts = RUNNER_SETTINGS.retryBackoffMs.length + 1
  orca.runCreate = async (a) => {
    if (++tries <= attempts) throw new Error('orca orchestration run-create: runtime_unavailable')
    return create(a)
  }
  const script = `const S = ${JSON.stringify(SCHEMA)}
const a = await agent('Name a thing.', { label: 'a', schema: S })
const b = await agent('Name a thing.', { label: 'b', schema: S })
return [a, b]`
  const stateDir = tmp()
  assert.deepEqual(await runScript(script, { orca, stateDir, out: (s) => lines.push(s), settings: FAST, clock: fakeClock() }), [null, GOOD])
  assert.equal(tries, attempts + 1)
  assert.deepEqual(started(orca), ['[Run] b'])
  assert.ok(lines.some((l) => l.includes("[Run] a: Orca could not create this run's Run") && l.includes('runtime_unavailable')), lines.join('\n'))
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(journal.filter((e) => e.title === '[Run] a').map((e) => e.type), [...Array(attempts - 1).fill('retry'), 'failed'])
})

// The lifecycle module on its own: one agent call in, its value or null out,
// with the journal and the retained list as plain arrays.
function lifecycleOn(orca, settings = FAST) {
  const journal = []
  const kept = []
  const lines = []
  const life = agentLifecycle({
    orca, clock: fakeClock(), limits: { ...SETTINGS, ...settings }, out: (s) => lines.push(s), stateDir: tmp(),
    objective: () => 'the objective', journal: (e) => journal.push(e), keep: (k) => (kept.push(k), k), transcripts: fakeTranscripts(orca),
  })
  let n = 0
  const call = (label, more = {}) => {
    const i = ++n
    return { prompt: 'Name a thing.', schema: SCHEMA, isolated: false, launch: { harness: 'claude', permissionMode: 'auto' }, key: `k${i}`, n: i, label, title: `[P] ${label}`, phaseName: 'P', ...more }
  }
  return { life, call, journal, kept, lines }
}

test('lifecycle: a call journals started then its result, and returns the value once its worker is released', async () => {
  const orca = fakeOrca({ worker: submitting() })
  const { life, call, journal } = lifecycleOn(orca)
  assert.deepEqual(await life(call('a')), GOOD)
  assert.deepEqual(journal.map((e) => [e.type, e.title]), [['started', '[P] a'], ['result', '[P] a']])
  assert.deepEqual(journal[1].result, GOOD)
  const verbs = orca.calls.map((c) => c.verb)
  assert.deepEqual([verbs[0], verbs[1], verbs.at(-1)], ['runCreate', 'workerStart', 'workerRelease'])
  assert.equal(orca.calls[0].objective, 'the objective')
})

test('lifecycle: a Run Orca cannot create journals its retries and failed with no started line, and the next call asks again', async () => {
  const orca = fakeOrca({ worker: submitting() })
  const create = orca.runCreate
  let tries = 0
  orca.runCreate = async (a) => {
    if (++tries <= 4) throw new Error('runtime_unavailable')
    return create(a)
  }
  const { life, call, journal } = lifecycleOn(orca)
  assert.equal(await life(call('a')), null)
  assert.deepEqual(await life(call('b')), GOOD)
  assert.deepEqual(journal.map((e) => [e.type, e.title]), [['retry', '[P] a'], ['retry', '[P] a'], ['retry', '[P] a'], ['failed', '[P] a'], ['started', '[P] b'], ['result', '[P] b']])
  assert.equal(journal[3].attempts, 4)
})

test('lifecycle: calls waiting on the same Run share its creation and its retries', async () => {
  const orca = fakeOrca({ worker: submitting(), faults: { runCreate: ({ count }) => count === 1 && new Error('runtime_unavailable') } })
  const { life, call, journal } = lifecycleOn(orca)
  assert.deepEqual(await Promise.all([life(call('a')), life(call('b'))]), [GOOD, GOOD])
  assert.equal(orca.calls.filter((c) => c.verb === 'runCreate').length, 1)
  assert.deepEqual(journal.filter((e) => e.type === 'retry').map((e) => e.title), ['[P] a'])
})

test('lifecycle: calls share one Run and the live cap, and a queued call starts only after a release', async () => {
  const orca = fakeOrca({ worker: submitting(5) })
  const { life, call, lines } = lifecycleOn(orca, { ...FAST, MAX_LIVE: 1 })
  assert.deepEqual(await Promise.all([life(call('a')), life(call('b'))]), [GOOD, GOOD])
  assert.equal(orca.calls.filter((c) => c.verb === 'runCreate').length, 1)
  assert.equal(liveHighWater(orca.calls), 1)
  assert.deepEqual(lines.filter((l) => l.endsWith('queued, 1 agents are live')), ['.. [P] b: queued, 1 agents are live'])
})

test('lifecycle: an isolated worker that never started leaves its worktree retained, and on its failed journal line', async () => {
  const orca = fakeOrca()
  orca.workerStart = async () => { throw Object.assign(new Error('agent_not_ready'), { worktree: 'C:/fake/worktrees/orphan' }) }
  const { life, call, journal, kept } = lifecycleOn(orca)
  assert.equal(await life(call('impl', { isolated: true })), null)
  assert.deepEqual(kept.map((k) => k.path), ['C:/fake/worktrees/orphan'])
  assert.deepEqual(journal.map((e) => e.type), ['retry', 'retry', 'retry', 'failed'], 'a worker that never started has no started line')
  assert.equal(journal[3].retained, kept[0])
  assert.equal(journal[3].reason, 'its worker did not start: agent_not_ready')
})

// The CLI adapter's own workerStart, whose create names each worktree as asked.
const cliStart = (replies) => childCli({ 'worktree create': (args) => ({ worktree: { path: `C:/wt/${flag(args, '--name')}` } }), ...replies }, { git: gitStub().git }).orca.workerStart

test('lifecycle: a retry whose worktree list is truncated journals retry, then failed with that reason, and keeps the first attempt\'s worktree', async () => {
  const orca = fakeOrca()
  orca.workerStart = cliStart({ 'terminal wait': { wait: { satisfied: false } }, 'worktree list': { worktrees: [], truncated: true } })
  const { life, call, journal, kept } = lifecycleOn(orca)
  assert.equal(await life(call('impl', { isolated: true })), null)
  assert.deepEqual(journal.map((e) => e.type), ['retry', 'retry', 'retry', 'failed'])
  assert.match(journal[1].reason, /worktree_list_truncated/)
  assert.match(journal[3].reason, /worktree_list_truncated/)
  assert.equal(kept.length, 1)
  assert.equal(journal[3].retained, kept[0])
})

test('lifecycle: a create Orca answers under a suffixed name fails at once, retaining both worktrees', async () => {
  const orca = fakeOrca()
  orca.workerStart = cliStart({ 'worktree create': (args) => ({ worktree: { path: `C:/wt/${flag(args, '--name')}-2` } }) })
  const { life, call, journal, kept } = lifecycleOn(orca)
  assert.equal(await life(call('impl', { isolated: true })), null)
  assert.deepEqual(journal.map((e) => e.type), ['failed', 'retained'], 'final: never retried into a -3')
  assert.match(journal[0].reason, /worktree_name_taken/)
  const name = journal[0].reason.match(/asked for (\S+),/)[1]
  assert.deepEqual(kept.map((k) => k.path), [`C:/wt/${name}-2`, `C:/wt/${name}`])
  assert.deepEqual([journal[0].retained, journal[1].retained], kept)
})

// --- the journal and the log say what happened --------------------------------

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Every entry is timestamped and carries every field its type defines.
function assertEntries(journal) {
  for (const e of journal) {
    assert.ok(JOURNAL_ENTRIES[e.type], `unknown entry type ${e.type}`)
    for (const f of JOURNAL_ENTRIES[e.type]) assert.ok(f in e, `${e.type} entry lacks ${f}: ${JSON.stringify(e)}`)
    assert.match(e.at, ISO)
  }
}

const iso = (ms) => new Date(ms).toISOString()

test("journal: every entry is timestamped from the runner's clock", async () => {
  const r = await runOne(async () => {})
  assertEntries(r.journal)
  const at = (c) => iso(c.at)
  const [n1, n2, n3, n4] = r.nudges
  const [c1, c2, c3] = r.continues
  assert.deepEqual(r.journal.map((e) => [e.type, e.at]), [
    ['started', iso(0)], ['nudge', at(n1)], ['continued', at(c1)], ['nudge', at(n2)], ['continued', at(c2)],
    ['nudge', at(n3)], ['continued', at(c3)], ['nudge', at(n4)], ['failed', at(r.releases[0])],
  ])
  within(r.releases[0].at, 160 * MIN, 'failure')
})

test('journal: started names the dispatch, harness, runner-assigned session, worktree and terminal of Claude and pi workers alike', async () => {
  const script = `const S = ${JSON.stringify(SCHEMA)}
await agent('a', { label: 'claude', schema: S })
await agent('b', { label: 'claude-wt', schema: S, isolation: 'worktree' })
await agent('c', { harness: 'pi', piModel: 'openai/gpt-5', label: 'pi', schema: S })
return await agent('d', { harness: 'pi', label: 'pi-wt', schema: S, isolation: 'worktree' })`
  for (const permissionMode of [null, 'auto']) {
    const r = await runOne(submitGood, { script, permissionMode })
    assertEntries(r.journal)
    const starts = r.orca.calls.filter((c) => c.verb === 'workerStart')
    const journaled = r.journal.filter((e) => e.type === 'started')
    assert.equal(journaled.length, 4)
    for (const [i, e] of journaled.entries()) {
      const s = starts[i]
      const d = r.orca.dispatches.get(s.dispatchId)
      assert.deepEqual(
        { dispatchId: e.dispatchId, harness: e.harness, sessionId: e.sessionId, worktree: e.worktree, terminal: e.terminal },
        { dispatchId: d.dispatchId, harness: i < 2 ? 'claude' : 'pi', sessionId: s.sessionId, worktree: d.worktree, terminal: d.handle },
      )
      assert.match(e.sessionId, UUID)
      // The custom path, with or without a mode: the harness command carries the id.
      assert.ok(s.command.startsWith(i < 2 ? `claude --session-id ${e.sessionId}` : `pi --approve --session-id ${e.sessionId}`), s.command)
      assert.equal(s.argv.includes('--agent'), false)
      assert.equal(s.argv[s.argv.indexOf('--terminal') + 1], d.handle)
    }
    assert.equal(new Set(journaled.map((e) => e.sessionId)).size, 4, 'every worker has its own session')
    assert.deepEqual(journaled.map((e) => e.worktree === 'C:/fake/run'), [true, false, true, false])
  }
})

test('fake orca: a worker start without a runner-assigned session id is refused', async () => {
  const orca = fakeOrca()
  await assert.rejects(orca.workerStart({ run: 'run_fake', prompt: '', title: 't' }), /without a runner-assigned --session-id/)
  assert.deepEqual(orca.calls, [])
})

// Every way agent() returns null, the failed entry it leaves, and how many
// attempts it made: a start or a Run creation is retried, a started worker never.
const ATTEMPTS = RUNNER_SETTINGS.retryBackoffMs.length + 1
const FAILURES = [
  ['never started', async () => {}, { orcaPatch: { workerStart: async () => { throw new Error('orca orchestration worker-start: outcome_unknown') } } },
    /^its worker did not start: orca orchestration worker-start: outcome_unknown$/, ATTEMPTS],
  ['died past the continuation cap', async function dies({ state }) {
    state.gone = true
    state.onContinue = dies
  }, {}, /^its terminal is gone, and its session was already continued 3 times, the cap of 3, with no result$/, 1],
  ['stuck past the continuation cap', async () => {}, {}, /^no movement in its transcript or terminal for 40 minutes, and its session was already continued 3 times, the cap of 3, with no result$/, 1],
  ['blocked on a human', async ({ state }) => { state.waiting = '{"evidence":"hook"}' }, {}, /^blocked on a human, unanswered for 30 minutes, with no result$/, 1],
  ['invalid result', async ({ prompt, preamble, orca }) => {
    const argv = submitArgvIn(prompt, preamble)
    writeFileSync(argv[argv.indexOf('--result') + 1], JSON.stringify(BAD))
    await orca.workerDone({ from: preamble.handle, capability: preamble.capability, taskId: preamble.taskId, dispatchId: preamble.dispatchId, subject: 's', body: 'b' })
  }, {}, /^recorded result fails its schema: .*\$\.count: expected integer, got string.* \(outcome succeeded\)$/, 1],
  ['Run creation failed', async () => {}, { orcaPatch: { runCreate: async () => { throw new Error('orca orchestration run-create: runtime_unavailable') } } },
    /^Orca could not create this run's Run: orca orchestration run-create: runtime_unavailable$/, ATTEMPTS],
]

for (const [what, worker, opts, reason, attempts] of FAILURES) {
  test(`journal: a call that ends in null (${what}) is journaled failed with its reason and attempt count`, async () => {
    const r = await runOne(worker, opts)
    assert.equal(r.result, null)
    assertEntries(r.journal)
    const failed = r.journal.filter((e) => e.type === 'failed')
    assert.equal(failed.length, 1)
    assert.match(failed[0].reason, reason)
    assert.equal(failed[0].attempts, attempts)
    assert.equal(r.journal.filter((e) => e.type === 'retry').length, attempts - 1)
    assert.equal(r.journal.some((e) => e.type === 'started'), what !== 'never started' && what !== 'Run creation failed')
  })
}

// --- a start that fails is retried --------------------------------------------

const ISOLATED = `return await agent('Do a thing.', { label: 'one', phase: 'P', schema: ${JSON.stringify(SCHEMA)}, isolation: 'worktree' })`
const BACKOFF = RUNNER_SETTINGS.retryBackoffMs
// The one child worktree runOne's isolated agent asks for: `<runId>-<n>`.
const CHILD_WT = 'C:/fake/worktrees/run_fake1-1'
const entries = (r, type) => r.journal.filter((e) => e.type === type)
const types = (r) => r.journal.map((e) => e.type)
const atMs = (e) => Date.parse(e.at)
const verbCount = (r, verb) => r.orca.calls.filter((c) => c.verb === verb).length

test('settings: a failed start or Run creation is retried after 30s, 2 and 5 minutes; every Orca call is bounded', () => {
  assert.deepEqual(RUNNER_SETTINGS.retryBackoffMs, [30_000, 2 * MIN, 5 * MIN])
  assert.ok(Object.isFrozen(RUNNER_SETTINGS.retryBackoffMs))
  assert.equal(RUNNER_SETTINGS.orcaCallMs, 2 * MIN)
})

test('retry: a start whose Orca call never answers counts as failed once it times out, and is retried', async () => {
  const r = await runOne(submitGood, { faults: { workerStart: ({ count }) => (count === 1 ? 'hang' : null) } })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(types(r), ['retry', 'started', 'result'])
  const [retry] = entries(r, 'retry')
  assert.equal(retry.reason, 'its worker did not start: orca workerStart: call_timeout: no answer within 120s')
  assert.equal(retry.attempt, 2)
  assert.equal(atMs(retry), RUNNER_SETTINGS.orcaCallMs + BACKOFF[0])
  assert.equal(verbCount(r, 'terminalClose'), 1, 'the timed-out attempt\'s terminal is closed')
  assert.ok(r.lines.some((l) => l.endsWith('call_timeout: no answer within 120s; trying again in 30s (attempt 2 of 4)')), r.lines.join('\n'))
})

test('retry: a start that fails after its worktree was made takes that clean worktree up again and succeeds, making no second one', async () => {
  const r = await runOne(submitGood, { script: ISOLATED, faults: { waitIdle: ({ count }) => count === 1 && new OrcaError('agent_not_ready', 'never idle', 'terminal wait') } })
  assert.deepEqual(r.result, GOOD, 'nothing retained')
  assert.deepEqual(types(r), ['retry', 'started', 'result'])
  assert.equal(verbCount(r, 'worktreeCreate'), 1)
  assert.deepEqual([...r.orca.worktrees.keys()], ['C:/fake/run', CHILD_WT])
  assert.deepEqual(r.orca.calls.filter((c) => c.verb === 'worktreeReuse').map((c) => c.worktree), [CHILD_WT])
  assert.equal(entries(r, 'started')[0].worktree, CHILD_WT)
  assert.equal(r.orca.worktrees.get(CHILD_WT).displayName, '[P] one')
})

for (const [what, spoil, reason] of [
  ['uncommitted changes', (w) => { w.dirty = true }, `its worker did not start: orca worktree reuse: worktree_dirty: ${CHILD_WT} has uncommitted changes`],
  ['commits', (w) => { w.commits = 2 }, `its worker did not start: orca worktree reuse: worktree_has_commits: ${CHILD_WT} has 2 commit(s) of its own`],
]) {
  test(`retry: a retry that finds its worktree with ${what} fails with that reason, and keeps the worktree`, async () => {
    const r = await runOne(submitGood, {
      script: ISOLATED,
      faults: {
        waitIdle: ({ count, worktree, orca }) => {
          if (count > 1) return null
          spoil(orca.worktrees.get(worktree))
          return new OrcaError('agent_not_ready', 'never idle', 'terminal wait')
        },
      },
    })
    assert.equal(r.result, null)
    assert.deepEqual(types(r), ['retry', 'failed'], 'no further attempt: a retry cannot mend it')
    const [failed] = entries(r, 'failed')
    assert.equal(failed.reason, reason)
    assert.equal(failed.attempts, 2)
    assert.equal(failed.retained.path, CHILD_WT)
    assert.equal(r.orca.worktrees.get(CHILD_WT).removed, false)
    assert.equal(verbCount(r, 'worktreeCreate'), 1)
    assert.equal(verbCount(r, 'workerStart'), 0)
    assert.ok(r.lines.some((l) => l.startsWith(`!! kept ${CHILD_WT}:`)), r.lines.join('\n'))
  })
}

test('retry: a start that fails every time is null after its retries, each journaled as retry at the backoff the table sets, then failed with the last reason', async () => {
  const r = await runOne(submitGood, { script: ISOLATED, faults: { terminalCreate: ({ count }) => new OrcaError('runtime_unavailable', `try ${count}`, 'terminal create') } })
  assert.equal(r.result, null)
  assertEntries(r.journal)
  assert.deepEqual(types(r), ['retry', 'retry', 'retry', 'failed'])
  const retries = entries(r, 'retry')
  assert.deepEqual(retries.map((e) => e.attempt), [2, 3, 4])
  assert.deepEqual(retries.map((e) => e.reason), [1, 2, 3].map((i) => `its worker did not start: orca terminal create: runtime_unavailable: try ${i}`))
  assert.deepEqual(retries.map(atMs), [BACKOFF[0], BACKOFF[0] + BACKOFF[1], BACKOFF[0] + BACKOFF[1] + BACKOFF[2]])
  const [failed] = entries(r, 'failed')
  assert.equal(failed.reason, 'its worker did not start: orca terminal create: runtime_unavailable: try 4')
  assert.equal(failed.attempts, 4)
  assert.equal(failed.retained.path, CHILD_WT)
  assert.equal(verbCount(r, 'worktreeCreate'), 1, 'every retry took up the one worktree')
})

test('retry: the backoff is whatever the settings table says', async () => {
  const r = await runOne(submitGood, { settings: { retryBackoffMs: [1_000, 7_000] }, faults: { terminalCreate: () => new OrcaError('runtime_unavailable', '', 'terminal create') } })
  assert.equal(r.result, null)
  assert.deepEqual(entries(r, 'retry').map(atMs), [1_000, 8_000])
  assert.equal(entries(r, 'failed')[0].attempts, 3)
})

test('retry: a Run Orca fails to create, or never answers for, is retried under the same policy, and the agent then starts', async () => {
  const faults = { runCreate: ({ count }) => (count === 1 ? 'hang' : count === 2 && new OrcaError('runtime_unavailable', 'try 2', 'orchestration run-create')) }
  const r = await runOne(submitGood, { faults })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(types(r), ['retry', 'retry', 'started', 'result'])
  const call = RUNNER_SETTINGS.orcaCallMs
  assert.deepEqual(entries(r, 'retry').map((e) => [e.attempt, atMs(e), e.reason]), [
    [2, call + BACKOFF[0], "Orca could not create this run's Run: orca runCreate: call_timeout: no answer within 120s"],
    [3, call + BACKOFF[0] + BACKOFF[1], "Orca could not create this run's Run: orca orchestration run-create: runtime_unavailable: try 2"],
  ])
  assert.equal(verbCount(r, 'runCreate'), 1)
})

test('warnings: a display name or board status Orca refuses is logged and journaled, and the agent still delivers', async () => {
  const refused = () => new OrcaError('selector_not_found', 'no such worktree', 'worktree set')
  const r = await runOne(submitGood, { script: ISOLATED, faults: { worktreeSet: refused, worktreeStatus: refused } })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(types(r), ['warning', 'started', 'warning', 'result'])
  const reasons = entries(r, 'warning').map((e) => e.reason)
  assert.deepEqual(reasons, [
    "could not set its worktree's display name: orca worktree set: selector_not_found: no such worktree",
    "could not set its worktree's board status to in-progress: orca worktree set: selector_not_found: no such worktree",
  ])
  for (const why of reasons) assert.ok(r.log.some((l) => l.endsWith(` !! [P] one: ${why}`)), r.log.join('\n'))
})

test('runner.log: every line the runner printed, in order and timestamped, the one for a worker that never started included', async () => {
  const r = await runOne(async () => {}, { orcaPatch: { workerStart: async () => { throw new Error('orca terminal wait: agent_not_ready') } } })
  assert.ok(r.lines.some((l) => l.includes('its worker did not start')), r.lines.join('\n'))
  for (const l of r.log) assert.match(l.slice(0, 24), ISO)
  assert.deepEqual(r.log.map((l) => l.slice(25)), r.lines)
})

test("runner.log: each line carries the clock's time when it was printed", async () => {
  const r = await runOne(async ({ state }) => {
    state.idle = true
    submitsOnContinue(state)
  })
  const nudges = r.log.filter((l) => l.includes('nudging it'))
  assert.equal(nudges.length, 2)
  assert.deepEqual(nudges.map((l) => l.slice(0, 24)), r.nudges.map((n) => iso(n.at)))
})

test('entry point: what it prints itself, the result included, is in runner.log too', () => {
  const r = runEntry(`log('hi')\nreturn { n: 1 }`)
  assert.equal(r.code, 0)
  const log = readFileSync(join(dirname(r.summaryPath), 'runner.log'), 'utf8')
  assert.match(log, /^\S+ {4}hi$/m)
  assert.match(log, /^\S+ == Result$/m)
  assert.match(log, /^\S+ {3}"n": 1$/m)
})

test('resume: a journal written before entries carried timestamps and launch fields still resumes', async () => {
  const stateDir = tmp()
  const key = (p, label) => journalKey(p, { label, phase: 'Chain' })
  const old = [
    { type: 'started', key: key('Plan it.', 'a'), n: 1, title: '[Chain] a' },
    { type: 'result', key: key('Plan it.', 'a'), n: 1, title: '[Chain] a', result: 'Plan it. @old' },
    { type: 'started', key: key('Build it.', 'b'), n: 2, title: '[Chain] b' },
    { type: 'failed', key: key('Build it.', 'b'), n: 2, title: '[Chain] b', retained: { path: 'C:/old/wt', reason: 'its agent died' } },
    { type: 'started', key: key('Check it.', 'c'), n: 3, title: '[Chain] c' },
  ]
  writeFileSync(join(stateDir, 'journal.jsonl'), old.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const orca = answering(2)
  const result = await runScript(chain('Build it.'), { orca, stateDir, out: () => {}, settings: FAST, resume: true })
  assert.deepEqual(result, ['Plan it. @old', 'Build it. @2', 'Check it. @2'])
  assert.deepEqual(started(orca), ['[Chain] b', '[Chain] c'])
  const journal = journalOf(stateDir)
  assertEntries(journal)
  assert.deepEqual(journal.slice(0, 2).map((e) => [e.type, e.retained?.path ?? e.result, e.replayed]), [['retained', 'C:/old/wt', undefined], ['result', 'Plan it. @old', true]])
})

// The run registry. Every test writes a registry of its own in a temp dir;
// runScript records nothing there unless it is handed a path.
const registryIn = () => join(tmp(), 'orca-runs.jsonl')
const linesOf = (path) => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const isoAt = (t) => new Date(t).toISOString()

test('registry: the writer appends armed, the runner\'s terminal and ended, each stamped with the clock\'s time', () => {
  const path = registryIn()
  const clock = fakeClock()
  const w = runRegistry(path, clock)
  w.armed({ runId: 'run_a', project: 'C:/repo', runDir: 'C:/notes/orca-run', spec: 'implement-spec-43' })
  clock.t = 5 * MIN
  w.runner({ runId: 'run_a', terminal: 'term_1' })
  clock.t = 90 * MIN
  w.ended({ runId: 'run_a', outcome: 'partial' })
  assert.deepEqual(linesOf(path), [
    { type: 'armed', runId: 'run_a', at: isoAt(0), project: 'C:/repo', runDir: 'C:/notes/orca-run', spec: 'implement-spec-43' },
    { type: 'runner', runId: 'run_a', at: isoAt(5 * MIN), terminal: 'term_1' },
    { type: 'ended', runId: 'run_a', at: isoAt(90 * MIN), outcome: 'partial' },
  ])
  assert.throws(() => w.ended({ runId: 'run_a', outcome: 'done' }), /unknown outcome "done"/)
  assert.equal(linesOf(path).length, 3)
  assert.deepEqual(OUTCOMES, ['ok', 'partial', 'failed'])
})

test('registry: the fold gives each run its state, where its runner was last seen, and whether it or its agents are reclaimed', () => {
  const path = registryIn()
  const clock = fakeClock()
  const w = runRegistry(path, clock)
  w.armed({ runId: 'run_a', project: 'C:/repo', runDir: 'C:/a', spec: 's1' })
  w.runner({ runId: 'run_a', terminal: 'term_1' })
  w.armed({ runId: 'run_b', project: 'C:/other', runDir: 'C:/b', spec: 's2' })
  clock.t = MIN
  w.runner({ runId: 'run_a', terminal: 'term_2' })
  clock.t = 2 * MIN
  w.ended({ runId: 'run_a', outcome: 'failed' })
  const reclaim = (e) => writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ type: 'reclaimed', ...e }) + '\n')
  reclaim({ runId: 'run_a', agent: 'run_a-3', at: isoAt(3 * MIN) })
  reclaim({ runId: 'run_a', at: isoAt(4 * MIN) })
  reclaim({ runId: 'run_b', agent: 'run_b-1', at: isoAt(5 * MIN) })
  // Never armed here: a run from before the registry.
  w.runner({ runId: 'run_old', terminal: 'term_9' })
  w.ended({ runId: 'run_old', outcome: 'ok' })

  const runs = readRegistry(path)
  assert.deepEqual(runs.map((r) => r.runId), ['run_a', 'run_b'])
  assert.deepEqual(runs[0], {
    runId: 'run_a', project: 'C:/repo', runDir: 'C:/a', spec: 's1', armedAt: isoAt(0),
    state: 'failed', endedAt: isoAt(2 * MIN), runner: { terminal: 'term_2', at: isoAt(MIN) },
    reclaimed: true, reclaimedAt: isoAt(4 * MIN), reclaimedAgents: [{ agent: 'run_a-3', at: isoAt(3 * MIN) }],
  })
  assert.deepEqual(runs[1], {
    runId: 'run_b', project: 'C:/other', runDir: 'C:/b', spec: 's2', armedAt: isoAt(0),
    state: 'running', endedAt: null, runner: null,
    reclaimed: false, reclaimedAt: null, reclaimedAgents: [{ agent: 'run_b-1', at: isoAt(5 * MIN) }],
  })
  assert.deepEqual(readRegistry(join(tmp(), 'none.jsonl')), [], 'no registry yet is no runs')
})

test('registry: a torn last line is ignored, and the next entry is not welded onto it', () => {
  const path = registryIn()
  const w = runRegistry(path, fakeClock())
  w.armed({ runId: 'run_a', project: 'C:/repo', runDir: 'C:/a', spec: 's' })
  writeFileSync(path, readFileSync(path, 'utf8') + '{"type":"ended","runId":"run_a","outc')
  assert.equal(readRegistry(path)[0].state, 'running')
  w.runner({ runId: 'run_a', terminal: 'term_1' })
  const [run] = readRegistry(path)
  assert.equal(run.state, 'running')
  assert.deepEqual(run.runner, { terminal: 'term_1', at: isoAt(0) })
})

// A run of SCRIPT on the fake clock, recorded in `registry`.
async function registered(registry, { worker = submitGood, script = SCRIPT, stateDir = tmp(), clock = fakeClock(), ...fake } = {}) {
  const orca = fakeOrca({ worker: (w) => worker({ ...w, clock }), clock, ...fake })
  const result = await runScript(script, { orca, stateDir, out: () => {}, clock, registry, project: 'C:/repo' }).catch((e) => e)
  return { orca, result, stateDir }
}

test('registry: the runner arms its Run with project, run directory, spec and time, records its terminal, and ends it ok', async () => {
  const registry = registryIn()
  const clock = fakeClock()
  clock.t = 7 * MIN
  const { result, stateDir } = await registered(registry, { clock })
  assert.deepEqual(result, { r: GOOD })
  const [armed, runner, ended, ...rest] = linesOf(registry)
  assert.deepEqual(armed, { type: 'armed', runId: 'run_fake1', at: isoAt(7 * MIN), project: 'C:/repo', runDir: stateDir, spec: 'tracer' })
  assert.deepEqual(runner, { type: 'runner', runId: 'run_fake1', at: isoAt(7 * MIN), terminal: 'term_runner' })
  assert.deepEqual([ended.type, ended.runId, ended.outcome, ended.at], ['ended', 'run_fake1', 'ok', isoAt(clock.now())])
  assert.deepEqual(rest, [])
})

test('registry: a run where an agent came back null ends partial; a run that throws ends failed', async () => {
  const registry = registryIn()
  const died = await registered(registry, { worker: async () => { throw new Error('agent died') } })
  assert.deepEqual(died.result, { r: null })
  const threw = await registered(registry, { script: SCRIPT.replace(/return \{ r \}$/, "throw new Error('boom')"), runPrefix: 'run_throw' })
  assert.match(threw.result.message, /boom/)
  assert.deepEqual(readRegistry(registry).map((r) => [r.runId, r.state]), [['run_fake1', 'partial'], ['run_throw1', 'failed']])
})

test('registry: a resume that launches arms its own Run and records its runner; one that replays everything records nothing', async () => {
  const registry = registryIn()
  const stateDir = tmp()
  const go = (script, n, resume) => {
    const orca = Object.assign(answering(n), { runCreate: async () => ({ runId: `run_r${n}`, terminal: `term_r${n}` }) })
    return runScript(script, { orca, stateDir, out: () => {}, settings: FAST, resume, registry, project: 'C:/repo' })
  }
  await go(chain('Build it.'), 1, false)
  await go(chain('Build it.'), 2, true)
  assert.equal(readRegistry(registry).length, 1, 'a fully replayed resume creates no Run')
  await go(chain('Build it again.'), 3, true)
  assert.deepEqual(readRegistry(registry).map((r) => [r.runId, r.runDir, r.runner.terminal, r.state]), [
    ['run_r1', stateDir, 'term_r1', 'ok'],
    ['run_r3', stateDir, 'term_r3', 'ok'],
  ])
})

test('registry: two runs at once in one repo are two entries that never mix', async () => {
  const registry = registryIn()
  const [a, b] = await Promise.all([
    registered(registry, { runPrefix: 'run_a', coordinator: 'term_a' }),
    registered(registry, { runPrefix: 'run_b', coordinator: 'term_b', worker: async () => { throw new Error('agent died') } }),
  ])
  const runs = Object.fromEntries(readRegistry(registry).map((r) => [r.runId, r]))
  assert.deepEqual(Object.keys(runs).sort(), ['run_a1', 'run_b1'])
  assert.deepEqual([runs.run_a1.project, runs.run_a1.runDir, runs.run_a1.runner.terminal, runs.run_a1.state], ['C:/repo', a.stateDir, 'term_a', 'ok'])
  assert.deepEqual([runs.run_b1.project, runs.run_b1.runDir, runs.run_b1.runner.terminal, runs.run_b1.state], ['C:/repo', b.stateDir, 'term_b', 'partial'])
})

test('orca-cli: run-create reports the coordinator terminal the Run bound to', async () => {
  const { orca } = recordingCli({ 'orchestration run-create': { run: { id: 'run_1', coordinator_handle: 'term_me' } } })
  assert.deepEqual(await orca.runCreate({ objective: 'o' }), { runId: 'run_1', terminal: 'term_me' })
})
