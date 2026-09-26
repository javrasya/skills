// Offline tests for the Orca runner: submit, the agent() round trip, the live
// cap, how a run is laid out in Orca, resume from the journal, and every way a
// worker dies becoming null, with the fake Orca standing in for the CLI
// adapter and a fake clock standing in for time.
//   node scripts/test-orca-runner.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, appendFileSync, copyFileSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { submit } from '../skills/engineering/implement-spec-in-workflow/orca/submit.mjs'
import { runScript, journalKey, failureSummary, finish, SUBMIT, SETTINGS, realClock, JOURNAL_ENTRIES, readJournal, attachView, runnerLog } from '../skills/engineering/implement-spec-in-workflow/orca/runner.mjs'
import { agentLifecycle, notePrompt } from '../skills/engineering/implement-spec-in-workflow/orca/lifecycle.mjs'
import { foldJournal } from '../skills/engineering/implement-spec-in-workflow/orca/journal.mjs'
import { fakeOrca, fakeTranscripts } from '../skills/engineering/implement-spec-in-workflow/orca/fake-orca.mjs'
import { RUNNER_SETTINGS } from '../skills/engineering/implement-spec-in-workflow/orca/settings.mjs'
import { orcaCli, OrcaError, tailCommand, resumeRunnerCommand, worktreeUnpushed } from '../skills/engineering/implement-spec-in-workflow/orca/orca-cli.mjs'
import { runRegistry, readRegistry, OUTCOMES } from '../skills/engineering/implement-spec-in-workflow/orca/registry.mjs'
import { transcriptPath, sessionTranscripts, claudeSlug, piDir } from '../skills/engineering/implement-spec-in-workflow/orca/transcript.mjs'
import { agentsOf, reclaimAgent, reclaimRun } from '../skills/engineering/implement-spec-in-workflow/orca/reclaim.mjs'
import { runView, runsView, bandOf, RUNNER_PATH, runnerAlive, runEnded } from '../skills/engineering/implement-spec-in-workflow/orca/run-view-model.mjs'
import { draw, drawRuns, strip, TREE_HELP } from '../skills/engineering/implement-spec-in-workflow/orca/run-view/draw.mjs'
import { EventEmitter } from 'events'

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
  assert.deepEqual(verbs.slice(-1), ['workerShow'], 'its last look found it settled, and it was never released')
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

// Each worker answers with its prompt's first line and which run it served
// (a number, or a function giving the run under way when one Orca serves
// several), so a result shows whether it came from this run or the journal.
function answering(run) {
  return fakeOrca({
    worker: async ({ prompt, preamble, orca }) => {
      const argv = submitArgvIn(prompt, preamble)
      writeFileSync(argv[argv.indexOf('--payload') + 1], `${prompt.split('\n')[0]} @${typeof run === 'function' ? run() : run}`)
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
// What one runner did, of all an Orca several runners share has seen.
const since = (orca, from) => ({ calls: orca.calls.slice(from) })

test('resume: the unchanged prefix replays from the journal without launching; the first changed call onward runs live', async () => {
  const stateDir = tmp()
  // One Orca throughout, as on a machine: each run's runner in a terminal of its own.
  let tag = 0
  const shared = answering(() => tag)
  const go = async (script, run, resume) => {
    tag = run
    const from = shared.calls.length
    const result = await runScript(script, { orca: shared.as(`term_${run}`), stateDir, out: () => {}, settings: FAST, resume })
    return { orca: since(shared, from), result }
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
  assert.deepEqual(edited.orca.calls.map((c) => c.verb).slice(0, 2), ['runUse', 'workerStart'], 'it takes the Run over first')
  assert.deepEqual([edited.orca.calls[0].runId, edited.orca.calls[0].terminal], ['run_fake1', 'term_3'])

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

// Doctors (ADR-0014). A doctor's worker is played like any other, told apart
// by its prompt, and reports over its Run's mailbox with the IDs of its
// preamble: `givesUp` sends worker_done --outcome failed at once, which also
// settles its dispatch failed, and handsOff(note) a handoff with the note, then
// worker_done --outcome succeeded. withDoctor(patient, doctor) plays both.
// NO_DOCTOR: a run whose tests are not about doctors, with no rounds.
const IS_DOCTOR = /^You are a doctor/
const idsOf = (p) => ({ from: p.handle, capability: p.capability, taskId: p.taskId, dispatchId: p.dispatchId })
const GIVE_UP = 'Its transcript shows nothing a note could change.'
const givesUp = async ({ orca, preamble }) => { await orca.mailSend({ ...idsOf(preamble), type: 'worker_done', outcome: 'failed', subject: 'giving up', body: GIVE_UP }) }
const handsOff = (note) => async ({ orca, preamble }) => {
  await orca.mailSend({ ...idsOf(preamble), type: 'handoff', subject: 'note', body: note })
  await orca.mailSend({ ...idsOf(preamble), type: 'worker_done', outcome: 'succeeded', subject: 'done', body: 'handed off' })
}
const withDoctor = (patient, doctor = givesUp) => (w) => (IS_DOCTOR.test(w.prompt) ? doctor(w) : patient(w))
const NO_DOCTOR = { doctorRounds: 0 }

// Runs a script (one agent() by default) on the default settings table, each
// worker played by `worker`.
async function runOne(worker, { script = ONE, orcaPatch = {}, permissionMode = null, faults = {}, settings = {}, setupLeaves = [] } = {}) {
  const clock = fakeClock()
  const lines = []
  const stateDir = tmp()
  const orca = Object.assign(fakeOrca({ worker: (w) => worker({ ...w, clock }), clock, faults, setupLeaves }), orcaPatch)
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

// Most workers live at once over the run: started, and neither seen settled
// nor stopped. None is ever released during a run.
function liveHighWater(calls) {
  let live = 0
  let max = 0
  for (const c of calls) {
    if (c.verb === 'workerStart') max = Math.max(max, ++live)
    if ((c.verb === 'workerShow' && c.settled) || c.verb === 'workerStop') live--
    assert.notEqual(c.verb, 'workerRelease')
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

test("doctor: the rendered template's recover row is the doctor's harness and model on the Orca runner", async () => {
  const text = readFileSync(TEMPLATE, 'utf8').replace(/__RUNNER__/g, 'orca').replace(/__SPEC__/g, '227').replace(/__[A-Z_]+__/g, 'x')
  const clock = fakeClock()
  const orca = fakeOrca({ worker: withDoctor(diesPastCap), clock })
  await runScript(text, { orca, stateDir: tmp(), out: () => {}, clock, transcripts: fakeTranscripts(orca) }).catch(() => {})
  const doctors = orca.calls.filter((c) => c.verb === 'workerStart' && c.title.includes('recover ->'))
  assert.equal(doctors.length, 3)
  for (const d of doctors) assert.deepEqual([d.title, d.harness, d.model], ['[Graph] recover -> graph:spec-227', 'claude', 'opus'])
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
    // The old dispatch's pane is gone, so it is stopped; nothing is released during a run.
    assert.equal(r.stop.dispatchId, started.dispatchId)
    assert.equal(r.released, 0)
    const [cont] = ofType(r.journal, 'continued')
    assert.deepEqual([cont.attempt, cont.reopened, cont.terminal, cont.dispatchId, cont.sessionId], [1, true, c.terminal, c.dispatchId, started.sessionId])
    assert.equal(cont.reason, 'its terminal is gone')
    assert.equal(r.orca.dispatches.get(c.dispatchId).tabTitle, '[P] one', 'the new tab is titled too')
  })
}

test('continuation: a hung worker is still continued at 40 minutes when every look lands late after its nudge', async () => {
  const LAG = 6_000
  const r = await runOne(async (w) => {
    // Each look costs LAG more than the poll: Orca slow under load.
    const show = w.orca.workerShow
    w.orca.workerShow = async (a) => {
      await w.clock.sleep(LAG)
      return show.call(w.orca, a)
    }
    // The nudge lands in the hung session's transcript, in two writes: that
    // is the nudge, not the worker.
    w.state.onNudge = () => {
      w.state.transcript = (w.state.transcript ?? 0) + 120
      w.clock.at(w.clock.now() + 9_000, () => { w.state.transcript += 40 })
    }
    submitsOnContinue(w.state)
    // A runner that keeps renudging never continues it: end the run anyway.
    w.clock.at(90 * MIN, () => submitGood(w))
  })
  const late =(at, from, what) => assert.ok(at >= from && at < from + POLL + LAG, `${what} at ${at / MIN} min, expected ${from / MIN} min`)
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 1, `nudged at ${r.nudges.map((n) => n.at / MIN).join(', ')} min`)
  late(r.nudges[0].at, 20 * MIN, 'nudge')
  assert.equal(r.continues.length, 1)
  late(r.continues[0].at, 40 * MIN, 'continuation')
  const [cont] = ofType(r.journal, 'continued')
  assert.equal(cont.attempt, 1)
  assert.match(cont.reason, /no movement in its transcript or terminal for 40 minutes/)
})

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
  const r = await runOne(withDoctor(idleAgain), { script: oneOn('claude', ", isolation: 'worktree'") })
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
  assert.equal(r.released, 0)
  assert.equal(r.orca.dispatches.get(started.dispatchId).gone, false)
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
  assert.equal(r.released, 0)
  assert.equal(r.orca.dispatches.get('ctx_fake1').gone, false)
  const failedAt = Date.parse(ofType(r.journal, 'failed')[0].at)
  assert.ok(failedAt >= 30 * MIN && failedAt < 30 * MIN + POLL, `failed at ${failedAt}`)
  assert.equal(ofType(r.journal, 'failed')[0].reason, 'blocked on a human, unanswered for 30 minutes, with no result')
  const loud = r.lines.filter((l) => l.includes('BLOCKED ON A HUMAN'))
  assert.equal(loud.length, 1, r.lines.join('\n'))
  assert.ok(loud[0].includes('[P] one') && loud[0].includes('term_fake1'), loud[0])
  assert.ok(r.lines.some((l) => l.includes('Allow this command?')), r.lines.join('\n'))
  // Every line of the banner names the agent, the last one included.
  assert.ok(r.lines.some((l) => l.startsWith('!!!!!!!! [P] one: if nobody answers within 30 minutes')), r.lines.join('\n'))
  // Journaled too, with what it waits on, so the run view shows it while it lasts.
  assertEntries(r.journal)
  assert.deepEqual(ofType(r.journal, 'blocked').map((e) => [e.title, e.dispatchId, e.terminal, e.waiting]), [['[P] one', 'ctx_fake1', 'term_fake1', '{"evidence":"prompt-text","text":"Allow this command?"}']])
  assert.deepEqual(ofType(r.journal, 'unblocked'), [])
  // Its process is left running: the failed line says so, for reclaim.
  assert.equal(ofType(r.journal, 'failed')[0].workerLeft, true)
  const [agent] = foldJournal(r.journal).agents
  assert.deepEqual([agent.state, agent.workerLeft, agent.waiting], ['failed', true, null])
})

test('liveness: a blocked worker the operator answers in time is journaled unblocked, and returns its result', async () => {
  const r = await runOne(async (w) => {
    w.state.waiting = '{"evidence":"hook"}'
    w.clock.at(29 * MIN, () => { w.state.waiting = null })
    w.clock.at(35 * MIN, () => submitGood(w))
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 0)
  assertEntries(r.journal)
  assert.deepEqual(r.journal.filter((e) => e.type !== 'run').map((e) => e.type), ['starting', 'started', 'blocked', 'unblocked', 'result'])
  const unblocked = ofType(r.journal, 'unblocked')[0]
  assert.ok(Date.parse(unblocked.at) >= 29 * MIN, unblocked.at)
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
function recordingCli(replies = {}, { git, clock, platform } = {}) {
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
  return { argvs, orca: orcaCli({ call, git, clock, ...(platform ? { platform } : {}) }) }
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

  // A release only releases: the tab it keeps is closed by reclaim, from the terminal list.
  await orca.workerRelease({ dispatch: w.dispatchId })
  assert.deepEqual(verbsOf(argvs.slice(3)), ['orchestration worker-release'])
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
// ones through Orca.
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
async function worktreeWorker({ prompt, preamble, worktree, orca }) {
  if (prompt.startsWith('Build b.')) throw new Error('the agent died')
  if (prompt.startsWith('Build a.')) return submitValue(prompt, preamble, orca, { worktree })
  const paths = JSON.parse(prompt.split('\n')[0].slice('Reclaim '.length))
  for (const path of paths) await orca.worktreeRemove({ path })
  return submitValue(prompt, preamble, orca, { removed: paths.length })
}
const worktreeOrca = () => fakeOrca({ worker: worktreeWorker })

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
  assert.match(result.worktrees_kept[0].reason, /^retained because its agent \(\[Implement\] impl:b\) died before reporting its path/)
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

// SKILL.md step 4 waits on summary.json OR a dead runner.pid; the tab outlives
// the runner, so the pid is the only death signal. The liveness probe is the
// one the skill runs, and it must see Windows pids.
test('entry point: runner.pid names this run\'s runner, and the skill\'s probe sees it dead once it exits', () => {
  const r = runEntry(`return process.pid`)
  const pidPath = join(dirname(r.summaryPath), 'runner.pid')
  const pid = readFileSync(pidPath, 'utf8')
  assert.equal(Number(pid), r.summary().result)
  const probe = (p) => spawnSync(process.execPath, ['-e', 'process.kill(+process.argv[1],0)', p]).status
  assert.notEqual(probe(pid), 0)
  assert.equal(probe(String(process.pid)), 0)
  writeFileSync(pidPath, '1')
  assert.equal(spawnSync(process.execPath, [RUNNER, r.script]).status, 0)
  assert.notEqual(readFileSync(pidPath, 'utf8'), '1', 'a stale runner.pid is replaced')
})

// --- seams between the runner's pieces ---------------------------------------

// A custom launch (a permission mode, or pi) into a child worktree: the child
// is made first and the agent's terminal opens in it, since a running process
// cannot be moved into a worktree worker-start makes afterwards.
const CHILD = { name: 'run_1-3', displayName: '[Implement] impl:#1' }
const CHILD_PATH = 'C:/wt/run_1-3'
const childCli = (replies = {}, opts) => recordingCli({ 'worktree create': { worktree: { id: `repo::${CHILD_PATH}`, path: CHILD_PATH }, startupTerminal: { handle: 'term_shell' } }, ...replies }, { git: gitStub().git, ...opts })

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

test("orca-cli: a doctor's child worktree is created with setup skipped; any other follows the repo's setup policy", async () => {
  for (const [child, setup] of [[{ ...CHILD, setup: 'skip' }, 'skip'], [CHILD, null]]) {
    const { argvs, orca } = childCli()
    await orca.workerStart({ ...START, harness: 'claude', child })
    const [create] = argvs
    assert.deepEqual(verbsOf([create]), ['worktree create'])
    assert.equal(create.includes('--setup') ? flag(create, '--setup') : null, setup)
  }
})

test("orca-cli: the Run mailbox is checked from the runner's own terminal, each message tied to its dispatch by its payload, and an ack is answered with the next batch", async () => {
  const row = (id, type, payload) => ({ id, run_id: 'run_1', delivery_contract: 'current_delivery', from_handle: 'term_d', to_handle: 'run:run_1', subject: 's', body: `body ${id}`, type, priority: 'normal', thread_id: null, payload, created_at: 'at', delivered_at: null })
  const { argvs, orca } = recordingCli({
    'orchestration check': (a) => (a.includes('--ack')
      ? { runId: 'run_1', deliveryId: null, messages: [], count: 0, acknowledged: 'delivery_A' }
      : { runId: 'run_1', deliveryId: 'delivery_A', replayed: true, acknowledged: null, count: 4, messages: [
        row('msg_1', 'handoff', JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1' })),
        row('msg_2', 'worker_done', JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'failed' })),
        row('msg_3', 'status', JSON.stringify({ _orcaLifecycleRejection: { code: 'sender_not_assignee' } })),
        row('msg_4', 'heartbeat', 'not json'),
      ] }),
  })
  const got = await orca.mailCheck()
  assert.deepEqual(argvs.at(-1), ['orchestration', 'check'])
  assert.deepEqual([got.deliveryId, got.replayed, got.acknowledged], ['delivery_A', true, null])
  assert.deepEqual(got.messages.map((m) => [m.id, m.type, m.from, m.body, m.taskId, m.dispatchId, m.outcome]), [
    ['msg_1', 'handoff', 'term_d', 'body msg_1', 'task_1', 'ctx_1', null],
    ['msg_2', 'worker_done', 'term_d', 'body msg_2', 'task_1', 'ctx_1', 'failed'],
    ['msg_3', 'status', 'term_d', 'body msg_3', null, null, null],
    ['msg_4', 'heartbeat', 'term_d', 'body msg_4', null, null, null],
  ])
  const next = await orca.mailCheck({ ack: 'delivery_A' })
  assert.deepEqual(argvs.at(-1), ['orchestration', 'check', '--ack', 'delivery_A'])
  assert.deepEqual([next.deliveryId, next.acknowledged, next.messages], [null, 'delivery_A', []])
})

test('orca-cli: a custom launch that fails after its child worktree was made names that worktree on the error', async () => {
  const { argvs, orca } = childCli({ 'terminal wait': { wait: { satisfied: false } } })
  const e = await orca.workerStart({ ...START, harness: 'pi', child: CHILD }).catch((x) => x)
  assert.match(e.message, /agent_not_ready/)
  assert.equal(e.worktree, CHILD_PATH)
  assert.equal(e.dispatched, undefined, 'it failed before its worker-start was sent')
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
  assert.equal(e.dispatched, true, 'Orca may have put a worker in it')
  assert.deepEqual(verbsOf(argvs).slice(-2), ['orchestration worker-start', 'terminal close'])
})

test('orca-cli: a worktree create is bounded by its own timeout; one that runs out after Orca made the worktree finds it by name, and the start carries on in it', async () => {
  const clock = fakeClock()
  const hung = () => new Promise(() => {})
  const { argvs, orca } = childCli({ 'worktree create': hung, 'worktree list': { worktrees: [{ path: 'C:/wt/other' }, { path: CHILD_PATH, branch: 'refs/heads/u/run_1-3' }] } }, { clock })
  const w = await orca.workerStart({ ...START, child: CHILD })
  assert.equal(clock.now(), RUNNER_SETTINGS.worktreeCreateMs)
  assert.deepEqual(verbsOf(argvs), ['worktree create', 'worktree list', 'worktree set', 'terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(flag(argvs[3], '--worktree'), `path:${CHILD_PATH}`)
  assert.equal(w.worktree, CHILD_PATH)
  assert.deepEqual(w.warnings, [`orca worktree create: call_timeout: no answer within 600s, but Orca had made ${CHILD_PATH}, so it starts there`])

  const none = childCli({ 'worktree create': hung, 'worktree list': { worktrees: [{ path: 'C:/wt/other' }] } }, { clock: fakeClock() })
  const e = await none.orca.workerStart({ ...START, child: CHILD }).catch((x) => x)
  assert.equal(e.code, 'call_timeout', 'no worktree of its name: the attempt fails as the create did')
  assert.equal(e.worktree, undefined)
  assert.deepEqual(verbsOf(none.argvs), ['worktree create', 'worktree list'])
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
  const w = await orca.workerStart({ ...START, harness: 'pi', child: { ...CHILD, retry: true, dispatched: true } })
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

test('orca-cli: a retry no earlier attempt of which sent its worker-start takes up its worktree whatever it holds, reading none of it', async () => {
  const g = gitStub({ status: '?? node_modules/\n?? package-lock.json\n', 'rev-list': '2\n' })
  const { argvs, orca } = childCli(EARLIER, { git: g.git })
  const w = await orca.workerStart({ ...START, child: { ...CHILD, retry: true, dispatched: false } })
  assert.equal(w.worktree, CHILD_PATH)
  assert.deepEqual(verbsOf(argvs).slice(0, 3), ['worktree list', 'terminal list', 'worktree set'])
  assert.deepEqual(g.runs, [])
  const held = childCli({ ...EARLIER, 'terminal list': { terminals: [{ handle: 'term_x', agentIdentity: 'claude', orphaned: false }] } }, { git: g.git })
  const e = await held.orca.workerStart({ ...START, child: { ...CHILD, retry: true } }).catch((x) => x)
  assert.equal(e.code, 'worktree_held', 'one an agent runs in is still refused')
})

test('orca-cli: a retry after a worker-start was sent refuses a worktree of its name that holds work, for good, and one an agent still runs in, for this attempt', async () => {
  const held = { ...EARLIER, 'terminal list': { terminals: [{ handle: 'term_x', agentIdentity: 'claude', orphaned: false }] } }
  for (const [replies, answers, code, final] of [
    [EARLIER, { status: '?? notes.txt\n', 'rev-list': '0' }, 'worktree_dirty', true],
    [EARLIER, { status: '', 'rev-list': '3\n' }, 'worktree_has_commits', true],
    [held, {}, 'worktree_held', false],
  ]) {
    const { argvs, orca } = childCli(replies, { git: gitStub(answers).git })
    const e = await orca.workerStart({ ...START, child: { ...CHILD, retry: true, dispatched: true } }).catch((x) => x)
    assert.equal(e.code, code)
    assert.equal(e.final, final, code)
    assert.equal(e.worktree, CHILD_PATH, code)
    for (const v of ['worktree create', 'terminal create']) assert.equal(verbsOf(argvs).includes(v), false, `${code}: ${v}`)
  }
})

// A setup hook's output, as `git status --porcelain` prints it.
const SETUP = ['?? node_modules/', ' M package-lock.json']

test("orca-cli: a child it creates has its porcelain taken as its baseline and handed on before the agent's terminal opens, and the prompt is made from it", async () => {
  const g = gitStub({ status: `${SETUP.join('\n')}\n` })
  const { argvs, orca } = childCli({}, { git: g.git })
  const handed = []
  const w = await orca.workerStart({
    ...START,
    prompt: (baseline) => `baseline: ${JSON.stringify(baseline)}`,
    child: { ...CHILD, onBaseline: (b) => handed.push({ ...b, verbs: verbsOf(argvs) }) },
  })
  assert.equal(w.worktree, CHILD_PATH)
  assert.deepEqual(handed, [{ worktree: CHILD_PATH, lines: SETUP, verbs: ['worktree create', 'terminal close', 'worktree set'] }], 'its index column kept, before terminal create')
  assert.deepEqual(g.runs, [[CHILD_PATH, 'status', '--porcelain']])
  assert.equal(flag(argvs.at(-1), '--spec'), `baseline: ${JSON.stringify(SETUP)}`)

  const late = childCli({ 'worktree create': () => new Promise(() => {}), 'worktree list': { worktrees: [{ path: CHILD_PATH }] } }, { clock: fakeClock(), git: gitStub({ status: '?? node_modules/\n' }).git })
  const none = []
  await late.orca.workerStart({ ...START, prompt: (b) => `baseline: ${JSON.stringify(b)}`, child: { ...CHILD, onBaseline: (b) => none.push(b) } })
  assert.deepEqual(none, [], 'a create that timed out has no baseline')
  assert.equal(flag(late.argvs.at(-1), '--spec'), 'baseline: null')
})

test('orca-cli: a retry after a worker-start was sent takes up a worktree whose porcelain is still its baseline, and refuses one changed since, for good', async () => {
  for (const [status, code] of [
    [` M package-lock.json\n?? node_modules/\n`, null],
    [`${SETUP.join('\n')}\n?? notes.txt\n`, 'worktree_dirty'],
    ['?? node_modules/\n', 'worktree_dirty'],
  ]) {
    const { argvs, orca } = childCli(EARLIER, { git: gitStub({ status, 'rev-list': '0\n' }).git })
    const got = await orca.workerStart({ ...START, prompt: (b) => `baseline: ${JSON.stringify(b)}`, child: { ...CHILD, retry: true, dispatched: true, baseline: SETUP } }).catch((x) => x)
    if (!code) {
      assert.equal(got.worktree, CHILD_PATH, 'the same lines in another order are its baseline')
      assert.equal(flag(argvs.at(-1), '--spec'), `baseline: ${JSON.stringify(SETUP)}`, "a worktree taken up keeps the baseline it was made with")
      continue
    }
    assert.equal(got.code, code, status)
    assert.equal(got.final, true)
    assert.equal(got.message, `orca worktree reuse: worktree_dirty: ${CHILD_PATH} has changed since it was made`)
  }
  const commits = childCli(EARLIER, { git: gitStub({ status: `${SETUP.join('\n')}\n`, 'rev-list': '1\n' }).git })
  const e = await commits.orca.workerStart({ ...START, child: { ...CHILD, retry: true, dispatched: true, baseline: SETUP } }).catch((x) => x)
  assert.equal(e.code, 'worktree_has_commits', 'its baseline spares no commit')
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
  let run = 1
  const first = fakeOrca({
    worker: async ({ prompt, preamble, orca }) => {
      if (run === 1 && prompt.startsWith('Build it.')) throw new Error('the agent died')
      return submitText(prompt, preamble, orca, `${prompt.split('\n')[0]} @${run}`)
    },
  })
  assert.deepEqual(await runScript(chain('Build it.'), { orca: first, stateDir, out: () => {}, settings: FAST }), ['Plan it. @1', null, 'Check it. @1'])
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const b = journal.filter((e) => e.key === journalKey('Build it.', { label: 'b', phase: 'Chain' }) && e.type !== 'started' && e.type !== 'starting')
  assert.deepEqual(b.map((e) => [e.type, 'result' in e]), [['failed', false]])

  const lines = []
  run = 2
  const from = first.calls.length
  const result = await runScript(chain('Build it.'), { orca: first.as('term_2'), stateDir, out: (s) => lines.push(s), settings: FAST, resume: true })
  assert.deepEqual(result, ['Plan it. @1', 'Build it. @2', 'Check it. @2'])
  assert.deepEqual(started(since(first, from)), ['[Chain] b', '[Chain] c'])
  assert.ok(lines.includes('>> [Chain] b: failed in the last run; this call and every one after it run live'), lines.join('\n'))
})

test('resume: a failed call keeps its place among identical calls, so a later one\'s result is never replayed into it', async () => {
  const stateDir = tmp()
  const script = `const x = await agent('Same.', { label: 's' })
const y = await agent('Same.', { label: 's' })
return [x, y]`
  let n = 0
  let run = 1
  const orca = fakeOrca({
    worker: async ({ prompt, preamble, orca }) => {
      if (++n === 1) throw new Error('the agent died')
      return submitText(prompt, preamble, orca, `Same. @${run}`)
    },
  })
  assert.deepEqual(await runScript(script, { orca, stateDir, out: () => {}, settings: FAST }), [null, 'Same. @1'])
  run = 2
  const from = orca.calls.length
  assert.deepEqual(await runScript(script, { orca: orca.as('term_2'), stateDir, out: () => {}, settings: FAST, resume: true }), ['Same. @2', 'Same. @2'])
  assert.equal(started(since(orca, from)).length, 2)
})

test('resume: a dead agent\'s worktree from the earlier run stays named in the result, resume after resume', async () => {
  const stateDir = tmp()
  let run = 1
  const one = fakeOrca({
    worker: async (w) => (run === 1 ? worktreeWorker(w) : submitValue(w.prompt, w.preamble, w.orca, w.prompt.startsWith('Reclaim') ? { removed: 0 } : { worktree: w.worktree })),
  })
  const r1 = await runScript(WT_SCRIPT, { orca: one, stateDir, out: () => {}, settings: FAST })
  const deadPath = startedAs(one, '[Implement] impl:b').worktree
  assert.deepEqual(r1.worktrees_kept.map((k) => k.path), [deadPath])

  // impl:b re-runs live in a new worktree of the same Run, numbered past the
  // last run's calls so its name is never the dead one's, and delivers; its
  // old one is still on disk.
  run = 2
  const lines = []
  const r2 = await runScript(WT_SCRIPT, { orca: one.as('term_2'), stateDir, out: (s) => lines.push(s), settings: FAST, resume: true })
  assert.notEqual(r2.b.worktree, deadPath)
  assert.equal(one.worktrees.get(deadPath).removed, false)
  assert.deepEqual(r2.worktrees_kept.map((k) => k.path), [deadPath])
  assert.match(r2.worktrees_kept[0].reason, /impl:b\) died before reporting/)
  assert.ok(lines.some((l) => l.startsWith(`!! kept ${deadPath}:`)), lines.join('\n'))

  const from = one.calls.length
  const r3 = await runScript(WT_SCRIPT, { orca: one.as('term_3'), stateDir, out: () => {}, settings: FAST, resume: true })
  assert.deepEqual(since(one, from).calls, [], 'everything replays')
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
    objective: () => 'the objective', journal: (e) => journal.push(e), retainWorktree: (k) => (kept.push(k), k), transcripts: fakeTranscripts(orca),
  })
  let n = 0
  const call = (label, more = {}) => {
    const i = ++n
    return { prompt: 'Name a thing.', schema: SCHEMA, isolated: false, launch: { harness: 'claude', permissionMode: 'auto' }, key: `k${i}`, n: i, label, title: `[P] ${label}`, phaseName: 'P', ...more }
  }
  return { life, call, journal, kept, lines }
}

test('lifecycle: a call journals started then its result, and returns the value once its worker settles, never releasing it', async () => {
  const orca = fakeOrca({ worker: submitting() })
  const { life, call, journal } = lifecycleOn(orca)
  assert.deepEqual(await life(call('a')), GOOD)
  assert.deepEqual(journal.map((e) => [e.type, e.title]), [['starting', '[P] a'], ['started', '[P] a'], ['result', '[P] a']])
  assert.deepEqual(journal[2].result, GOOD)
  const verbs = orca.calls.map((c) => c.verb)
  assert.deepEqual([verbs[0], verbs[1], verbs.at(-1)], ['runCreate', 'workerStart', 'workerShow'])
  assert.equal(verbs.includes('workerRelease'), false)
  assert.deepEqual([journal[0].run, journal[1].run], ['run_fake1', 'run_fake1'])
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
  assert.deepEqual(journal.map((e) => [e.type, e.title]), [['retry', '[P] a'], ['retry', '[P] a'], ['retry', '[P] a'], ['failed', '[P] a'], ['starting', '[P] b'], ['started', '[P] b'], ['result', '[P] b']])
  assert.equal(journal[3].attempts, 4)
})

test('lifecycle: calls waiting on the same Run share its creation and its retries', async () => {
  const orca = fakeOrca({ worker: submitting(), faults: { runCreate: ({ count }) => count === 1 && new Error('runtime_unavailable') } })
  const { life, call, journal } = lifecycleOn(orca)
  assert.deepEqual(await Promise.all([life(call('a')), life(call('b'))]), [GOOD, GOOD])
  assert.equal(orca.calls.filter((c) => c.verb === 'runCreate').length, 1)
  assert.deepEqual(journal.filter((e) => e.type === 'retry').map((e) => e.title), ['[P] a'])
})

test('lifecycle: calls share one Run and the live cap, and a queued call starts only once the live one settles', async () => {
  const orca = fakeOrca({ worker: submitting(5) })
  const { life, call, lines, journal } = lifecycleOn(orca, { ...FAST, MAX_LIVE: 1 })
  assert.deepEqual(await Promise.all([life(call('a')), life(call('b'))]), [GOOD, GOOD])
  assert.equal(orca.calls.filter((c) => c.verb === 'runCreate').length, 1)
  assert.equal(liveHighWater(orca.calls), 1)
  assert.deepEqual(lines.filter((l) => l.endsWith('queued, 1 agents are live')), ['.. [P] b: queued, 1 agents are live'])
  assert.deepEqual(journal.filter((e) => e.title === '[P] b').map((e) => e.type), ['queued', 'starting', 'started', 'result'])
  assert.equal(journal.some((e) => e.title === '[P] a' && e.type === 'queued'), false)
})

test('lifecycle: an isolated worker that never started leaves its worktree retained, and on its failed journal line', async () => {
  const orca = fakeOrca()
  orca.workerStart = async () => { throw Object.assign(new Error('agent_not_ready'), { worktree: 'C:/fake/worktrees/orphan' }) }
  const { life, call, journal, kept } = lifecycleOn(orca)
  assert.equal(await life(call('impl', { isolated: true })), null)
  assert.deepEqual(kept.map((k) => k.path), ['C:/fake/worktrees/orphan'])
  assert.deepEqual(journal.map((e) => e.type), ['starting', 'retry', 'retry', 'retry', 'failed'], 'a worker that never started has no started line')
  assert.equal(journal[4].retained, kept[0])
  assert.equal(journal[4].reason, 'its worker did not start: agent_not_ready')
})

// The CLI adapter's own workerStart, whose create names each worktree as asked.
const cliStart = (replies) => childCli({ 'worktree create': (args) => ({ worktree: { path: `C:/wt/${flag(args, '--name')}` } }), ...replies }, { git: gitStub().git }).orca.workerStart

test('lifecycle: a retry whose worktree list is truncated journals retry, then failed with that reason, and keeps the first attempt\'s worktree', async () => {
  const orca = fakeOrca()
  orca.workerStart = cliStart({ 'terminal wait': { wait: { satisfied: false } }, 'worktree list': { worktrees: [], truncated: true } })
  const { life, call, journal, kept } = lifecycleOn(orca)
  assert.equal(await life(call('impl', { isolated: true })), null)
  assert.deepEqual(journal.map((e) => e.type), ['starting', 'baseline', 'retry', 'retry', 'retry', 'failed'])
  assert.match(journal[3].reason, /worktree_list_truncated/)
  assert.match(journal[4].reason, /worktree_list_truncated/)
  assert.equal(kept.length, 1)
  assert.equal(journal[5].retained, kept[0])
})

test('lifecycle: a create Orca answers under a suffixed name fails at once, retaining both worktrees', async () => {
  const orca = fakeOrca()
  orca.workerStart = cliStart({ 'worktree create': (args) => ({ worktree: { path: `C:/wt/${flag(args, '--name')}-2` } }) })
  const { life, call, journal, kept } = lifecycleOn(orca)
  assert.equal(await life(call('impl', { isolated: true })), null)
  assert.deepEqual(journal.map((e) => e.type), ['starting', 'failed', 'retained'], 'final: never retried into a -3')
  assert.match(journal[1].reason, /worktree_name_taken/)
  const name = journal[1].reason.match(/asked for (\S+),/)[1]
  assert.deepEqual(kept.map((k) => k.path), [`C:/wt/${name}-2`, `C:/wt/${name}`])
  assert.deepEqual([journal[1].retained, journal[2].retained], kept)
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
  const r = await runOne(async () => {}, { settings: NO_DOCTOR })
  assertEntries(r.journal)
  const at = (c) => iso(c.at)
  const [n1, n2, n3, n4] = r.nudges
  const [c1, c2, c3] = r.continues
  assert.deepEqual(r.journal.map((e) => [e.type, e.at]), [
    ['run', iso(0)], ['starting', iso(0)], ['started', iso(0)], ['nudge', at(n1)], ['continued', at(c1)], ['nudge', at(n2)], ['continued', at(c2)],
    ['nudge', at(n3)], ['continued', at(c3)], ['nudge', at(n4)], ['failed', r.journal.at(-1).at],
  ])
  within(Date.parse(r.journal.at(-1).at), 160 * MIN, 'failure')
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
    const r = await runOne(withDoctor(worker), opts)
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

// --- a failed agent gets a doctor (ADR-0014) --------------------------------------

// A session dead past its cap: its tab gone again in every continuation.
const diesPastCap = ({ state }) => {
  state.gone = true
  state.onContinue = diesPastCap
}
const indexOf = (journal, pred) => journal.findIndex(pred)

test('doctor: an agent dead past its cap starts a doctor and its agent() stays pending; a dependent waits for it, an independent agent runs meanwhile', async () => {
  const script = `const S = ${JSON.stringify(SCHEMA)}
const [p, i] = await parallel([
  async () => {
    const p = await agent('Patient.', { label: 'patient', phase: 'P', schema: S })
    const d = await agent('Dependent.', { label: 'dependent', phase: 'P', schema: S })
    return { p, d }
  },
  () => agent('Independent.', { label: 'independent', phase: 'P', schema: S }),
])
return { ...p, i }`
  // Each doctor works 15 minutes, then gives up; the independent agent
  // submits at 30, while the second doctor works.
  const doctor = async (w) => { w.clock.at(w.clock.now() + 15 * MIN, () => givesUp(w)) }
  const r = await runOne(withDoctor(async (w) => {
    if (w.prompt.startsWith('Patient.')) return diesPastCap(w)
    if (w.prompt.startsWith('Independent.')) return void w.clock.at(30 * MIN, () => submitGood(w))
    return submitGood(w)
  }, doctor), { script })
  assert.deepEqual(r.result, { p: null, d: GOOD, i: GOOD })
  assertEntries(r.journal)
  const titled = (title, type) => indexOf(r.journal, (e) => e.title === title && e.type === type)
  const rounds = ofType(r.journal, 'doctor')
  assert.deepEqual(rounds.map((e) => [e.n, e.title, e.round]), [1, 2, 3].map((round) => [1, '[P] patient', round]))
  // Pending: the patient's call fails only once its last doctor gave up.
  const failed = titled('[P] patient', 'failed')
  assert.ok(indexOf(r.journal, (e) => e.type === 'gaveUp' && e.round === 3) < failed)
  assert.equal(indexOf(r.journal, (e) => e.type === 'failed' && e.title === '[P] patient'), failed)
  assert.ok(titled('[P] patient', 'doctor') < titled('[P] independent', 'result'), 'the independent agent delivered while a doctor worked')
  assert.ok(titled('[P] independent', 'result') < failed)
  assert.ok(failed < titled('[P] dependent', 'starting'), 'the dependent started only once the patient resolved')
  // The fold links each doctor to its patient.
  const agents = foldJournal(r.journal).agents
  const patient = agents.find((a) => a.title === '[P] patient')
  assert.deepEqual(patient.doctors, rounds.map((e) => e.doctor))
  assert.equal(patient.round, 3)
  for (const n of patient.doctors) assert.equal(agents.find((a) => a.origin === n).patient, patient.origin)
})

test('doctor: a resume carries each earlier doctor forward with its patient, resume after resume, and the run view keeps it under that patient', async () => {
  const stateDir = tmp()
  const clock = fakeClock()
  const orca = fakeOrca({ worker: (w) => withDoctor(diesPastCap)({ ...w, clock }), clock })
  const script = `return await agent('Patient.', { label: 'patient', phase: 'P', schema: ${JSON.stringify(SCHEMA)} })`
  const opts = { stateDir, out: () => {}, clock, transcripts: fakeTranscripts(orca) }
  assert.equal(await runScript(script, { ...opts, orca }), null)
  for (const [i, from] of ['term_2', 'term_3'].entries()) {
    assert.equal(await runScript(script, { ...opts, orca: orca.as(from), resume: true }), null)
    const agents = foldJournal(journalOf(stateDir)).agents
    const patients = agents.filter((a) => a.title === '[P] patient')
    assert.equal(patients.length, i + 2, 'the patient runs live again on each resume')
    for (const p of patients) {
      assert.equal(p.doctors.length, 3)
      for (const d of p.doctors) assert.equal(agents.find((a) => a.origin === d).patient, p.origin)
    }
    const view = runView({ stateDir, orca, clock, transcripts: sessionTranscripts({ home: tmp(), env: {} }), registry: null, alive: () => false })
    await view.refresh()
    assert.deepEqual(view.model.rows.slice(1).map((r) => [r.depth, r.agent.patient]), patients.flatMap((p) => [[0, null], ...p.doctors.map(() => [1, p.origin])]))
  }
})

for (const [what, roles, launch] of [
  ['a pi recover row', "{ recover: { harness: 'pi', piModel: 'openai/gpt-5', model: 'opus' } }", { harness: 'pi', model: 'openai/gpt-5' }],
  ['a Claude recover row', "{ recover: { harness: 'claude', model: 'sonnet', effort: 'high' } }", { harness: 'claude', model: 'sonnet', effort: 'high' }],
  ['no role table', null, { harness: 'claude', model: undefined }],
]) {
  test(`doctor: its worktree is created with setup skipped under the run's next <runId>-<n>, titled recover -> <patient label>, on the recover role (${what})`, async () => {
    const script = `export const meta = { name: 'implement-spec-9', description: 'd', phases: [] }
${roles ? `meta.roles = ${roles}` : ''}
const S = ${JSON.stringify(SCHEMA)}
await agent('Build a.', { label: 'a', phase: 'Implement', schema: S, isolation: 'worktree' })
return await agent('Patient.', { label: 'impl:#7', phase: 'Implement', schema: S, isolation: 'worktree' })`
    const r = await runOne(withDoctor((w) => (w.prompt.startsWith('Patient.') ? diesPastCap(w) : submitGood(w))), { script })
    assert.equal(r.result, null)
    const creates = r.orca.calls.filter((c) => c.verb === 'worktreeCreate')
    assert.deepEqual(creates.map((c) => [c.name, c.setup]), [['run_fake1-1', null], ['run_fake1-2', null], ['run_fake1-3', 'skip'], ['run_fake1-4', 'skip'], ['run_fake1-5', 'skip']])
    const doctors = r.orca.calls.filter((c) => c.verb === 'workerStart').slice(2)
    assert.equal(doctors.length, 3)
    for (const [i, d] of doctors.entries()) {
      assert.equal(d.title, '[Implement] recover -> impl:#7')
      assert.equal(d.worktree, `C:/fake/worktrees/run_fake1-${i + 3}`)
      assert.equal(r.orca.worktrees.get(d.worktree).displayName, '[Implement] recover -> impl:#7')
      assert.deepEqual({ harness: d.harness, model: d.model, ...(launch.effort && { effort: d.effort }) }, launch)
    }
    assert.deepEqual(ofType(r.journal, 'doctor').map((e) => e.doctor), [3, 4, 5])
  })
}

test("doctor: its prompt carries the patient's title, prompt, failure reason, journal entries, log lines, transcript and worktree, and the round of three", async () => {
  const PROMPT = 'Patient: build the frobnicator.'
  for (const isolation of ['worktree', null]) {
    const script = `return await agent(${JSON.stringify(PROMPT)}, { label: 'impl:#7', phase: 'Implement', schema: ${JSON.stringify(SCHEMA)}${isolation ? ", isolation: 'worktree'" : ''} })`
    const r = await runOne(withDoctor(diesPastCap), { script })
    const started = ofType(r.journal, 'started')[0]
    const [reason] = ofType(r.journal, 'doctor').map((e) => e.reason)
    assert.match(reason, /the cap of 3, with no result$/)
    const doctors = [...r.orca.dispatches.values()].filter((d) => d.title.includes('recover ->'))
    assert.equal(doctors.length, 3)
    for (const [i, { prompt }] of doctors.entries()) {
      assert.match(prompt, IS_DOCTOR)
      assert.ok(prompt.includes(`doctor round ${i + 1} of 3`), prompt)
      assert.ok(prompt.includes('Title: [Implement] impl:#7'), prompt)
      assert.ok(prompt.includes(`## Its prompt\n${PROMPT}\n`), prompt)
      assert.ok(prompt.includes(`Failure reason: ${reason}`), prompt)
      assert.ok(prompt.includes(`Transcript: C:/fake/transcripts/${started.sessionId}.jsonl`), prompt)
      assert.ok(prompt.includes(isolation ? `Worktree: ${started.worktree}` : "Worktree: none: it ran in the run's own worktree"), prompt)
      // Its journal entries, whole, and the runner's log lines about it.
      assert.ok(prompt.includes(JSON.stringify(started)), prompt)
      for (const e of ofType(r.journal, 'continued')) assert.ok(prompt.includes(JSON.stringify(e)), prompt)
      const log = r.log.filter((l) => l.includes(' [Implement] impl:#7: started on '))
      assert.equal(log.length, 1)
      assert.ok(prompt.includes(log[0]), prompt)
      // Earlier rounds are in its patient's journal entries.
      assert.equal(prompt.includes('"type":"gaveUp"'), i > 0)
      assert.ok(prompt.includes('Change nothing.') && /no file/.test(prompt) && /environment/.test(prompt) && /log in/.test(prompt), prompt)
      assert.ok(prompt.includes('Your only output is the note.'), prompt)
      assert.ok(prompt.includes('state the situation and what the human must do or decide') && prompt.includes('Do not question them'), prompt)
      // Its only output is a note: it is given no submit command.
      assert.equal(prompt.includes(SUBMIT), false)
    }
  }
})

test('doctor: three doctors that each give up leave the patient null, failed and kept', async () => {
  const r = await runOne(withDoctor(diesPastCap), { script: ISOLATED })
  assert.equal(r.result, null)
  assertEntries(r.journal)
  assert.deepEqual(ofType(r.journal, 'gaveUp').map((e) => [e.n, e.round, e.reason]), [1, 2, 3].map((round) => [1, round, `it gave up: ${GIVE_UP}`]))
  assert.deepEqual(ofType(r.journal, 'settled').map((e) => [e.n, e.outcome]), [[2, 'failed'], [3, 'failed'], [4, 'failed']])
  const [failed, ...more] = ofType(r.journal, 'failed')
  assert.deepEqual(more, [])
  assert.equal(failed.n, 1)
  assert.match(failed.reason, /the cap of 3, with no result$/)
  assert.equal(failed.workerLeft, true)
  // Kept: its process not stopped, its tab open, its worktree retained.
  const started = ofType(r.journal, 'started')[0]
  assert.equal(r.orca.calls.some((c) => c.verb === 'workerStop' && c.dispatch === started.dispatchId), false)
  assert.equal(r.released, 0)
  assert.equal(failed.retained.path, started.worktree)
  assert.ok(r.lines.some((l) => l.startsWith(`!! kept ${started.worktree}:`)), r.lines.join('\n'))
  assert.ok(r.lines.some((l) => l.includes('after 3 doctor rounds without a remedy')), r.lines.join('\n'))
})

for (const [what, doctor, startFails] of [
  ['dies past its own cap', diesPastCap, false],
  ['never starts', givesUp, true],
]) {
  test(`doctor: a doctor that ${what} fails itself and uses up its round, and no doctor is started for it`, async () => {
    let round = 0
    // The first doctor fails itself; the next two give up.
    const clock = fakeClock()
    const stateDir = tmp()
    const registry = registryIn()
    const orca = fakeOrca({ worker: (w) => withDoctor(diesPastCap, (d) => (++round === 1 ? doctor(d) : givesUp(d)))({ ...w, clock }), clock })
    if (startFails) {
      const real = orca.workerStart
      orca.workerStart = async (a) => {
        if (a.title.includes('recover ->') && ofType(journalOf(stateDir), 'doctor').length === 1) throw new Error('orca orchestration worker-start: outcome_unknown')
        return real(a)
      }
    }
    const result = await runScript(ISOLATED, { orca, stateDir, out: () => {}, clock, transcripts: fakeTranscripts(orca), registry })
    const journal = journalOf(stateDir)
    assert.equal(result, null)
    assertEntries(journal)
    const rounds = ofType(journal, 'doctor')
    assert.deepEqual(rounds.map((e) => [e.n, e.round]), [[1, 1], [1, 2], [1, 3]], 'three rounds, all for the patient')
    const own = ofType(journal, 'failed').filter((e) => e.n === rounds[0].doctor)
    assert.equal(own.length, 1)
    assert.equal(own[0].patient, 1)
    assert.equal(own[0].key, null)
    assert.equal(own[0].attempts, startFails ? ATTEMPTS : 1)
    assert.deepEqual(ofType(journal, 'gaveUp').map((e) => e.reason), ['it failed itself', `it gave up: ${GIVE_UP}`, `it gave up: ${GIVE_UP}`])
    // Its failure is no agent() null: only the patient's is, and the run ends partial for it alone.
    assert.deepEqual(ofType(journal, 'failed').filter((e) => e.patient == null).map((e) => e.n), [1])
    assert.equal(linesOf(registry).find((e) => e.type === 'ended').outcome, 'partial')
  })
}

// --- a doctor's handoff over Orca mail carries its patient on ---------------------

const NOTE = 'Run the suite with --runInBand: the parallel run is what hangs.'
// A patient that dies past its cap, gone or stuck in each continuation, and
// submits once a continuation carries `note`.
const curedBy = (note, death) => function dies(w) {
  if (death === 'gone') w.state.gone = true
  w.state.onContinue = (c) => (c.text.includes(note) ? submitGood(c) : dies(c))
}
const sentWith = (orca, body) => orca.calls.find((c) => c.verb === 'mailSend' && c.body === body)
// The mailbox check that acknowledged the batch holding message `id`.
const ackOf = (calls, id) => {
  const batch = calls.find((c) => c.verb === 'mailCheck' && c.ids.includes(id)).deliveryId
  return calls.findIndex((c) => c.verb === 'mailCheck' && c.ack === batch)
}

for (const death of ['gone', 'stuck']) {
  test(`doctor: a handoff continues the patient (${death}) in its own session, worktree and ${death === 'gone' ? 'worktree, in a new tab, its own being gone' : 'tab'}, with the note in its continuation prompt, and its result is what agent() returns`, async () => {
    const r = await runOne(withDoctor(curedBy(NOTE, death), handsOff(NOTE)), { script: ISOLATED })
    assert.deepEqual(r.result, GOOD)
    assertEntries(r.journal)
    assert.deepEqual(ofType(r.journal, 'result').map((e) => [e.n, e.result]), [[1, GOOD]])
    assert.deepEqual(ofType(r.journal, 'failed'), [])
    assert.deepEqual(ofType(r.journal, 'gaveUp'), [])

    const started = ofType(r.journal, 'started')[0]
    const last = ofType(r.journal, 'continued').filter((e) => e.n === 1).at(-1)
    const handoff = sentWith(r.orca, NOTE)
    const [remedy, ...more] = ofType(r.journal, 'remedy')
    assert.deepEqual(more, [])
    assert.deepEqual([remedy.n, remedy.origin, remedy.round, remedy.doctor, remedy.how, remedy.messageId, remedy.reopened], [1, 1, 1, 2, 'continue', handoff.id, death === 'gone'])
    const noted = r.continues.filter((c) => c.text.includes(NOTE))
    assert.equal(noted.length, 1)
    const [c] = noted
    assert.equal(c.text, notePrompt(NOTE))
    assert.ok(c.command.startsWith(`claude --resume ${started.sessionId}`), c.command)
    assert.equal(c.worktree, started.worktree)
    assert.equal(c.reopened, death === 'gone')
    if (death === 'gone') assert.notEqual(c.terminal, last.terminal)
    else assert.equal(c.terminal, last.terminal)
    assert.deepEqual([remedy.dispatchId, remedy.terminal], [c.dispatchId, c.terminal])

    // The handoff is journaled, then acted on, then acknowledged.
    const mail = ofType(r.journal, 'mail')
    const note = mail.find((e) => e.messageId === handoff.id)
    assert.deepEqual([note.kind, note.action, note.body, note.doctor, note.patient, note.round], ['handoff', 'remedy', NOTE, 2, 1, 1])
    assert.ok(r.journal.indexOf(note) < r.journal.indexOf(remedy))
    assert.ok(r.orca.calls.indexOf(c) < ackOf(r.orca.calls, handoff.id), 'acknowledged only once acted on')
    // Its worker_done after the handoff ends the doctor normally.
    const done = r.orca.calls.find((x) => x.verb === 'mailSend' && x.type === 'worker_done')
    assert.deepEqual(mail.filter((e) => e.messageId === done.id).map((e) => [e.kind, e.outcome, e.action]), [['worker_done', 'succeeded', 'ended']])
    assert.deepEqual(ofType(r.journal, 'settled').map((e) => [e.n, e.outcome]), [[2, 'succeeded']])
    assert.equal(r.orca.calls.filter((x) => x.verb === 'workerStart').length, 2, 'one doctor, and no second start of the patient')
    const agents = foldJournal(r.journal).agents
    assert.deepEqual(agents.map((a) => [a.origin, a.state]), [[1, 'done'], [2, 'done']])
  })
}

test('doctor: a batch Orca delivers again before its acknowledgement is acknowledged, and its handoff applied once', async () => {
  let failed = 0
  const faults = { mailCheck: ({ ack, batch }) => (ack && batch?.some((m) => m.type === 'handoff') && !failed++ ? new OrcaError('runtime_unavailable', 'not now', 'orchestration check') : null) }
  const r = await runOne(withDoctor(curedBy(NOTE, 'gone'), handsOff(NOTE)), { script: ISOLATED, faults })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  const handoff = sentWith(r.orca, NOTE)
  const checks = r.orca.calls.filter((c) => c.verb === 'mailCheck')
  const held = checks.filter((c) => c.ids.includes(handoff.id))
  assert.ok(held.length >= 2, 'delivered again')
  assert.equal(new Set(held.map((c) => c.deliveryId)).size, 1)
  assert.equal(held.at(-1).replayed, true)
  assert.ok(checks.some((c) => c.ack === held[0].deliveryId), 'acknowledged in the end')
  assert.ok(r.lines.some((l) => l.includes("could not read the Run's mailbox") && l.includes('runtime_unavailable')), r.lines.join('\n'))
  const mail = ofType(r.journal, 'mail')
  assert.equal(new Set(mail.map((e) => e.messageId)).size, mail.length, 'one mail line per message')
  assert.equal(ofType(r.journal, 'remedy').length, 1)
  assert.equal(r.continues.filter((c) => c.text.includes(NOTE)).length, 1)
})

test('doctor: a runner that dies after journaling a handoff and before acknowledging it has applied it once; the resume acknowledges the batch Orca delivers again and never applies it twice', async () => {
  const clock = fakeClock()
  const stateDir = tmp()
  const first = mortalOn(clock)
  const NOTE2 = 'Stub the network: the registry is down.'
  // The ack of the batch holding the handoff never lands: its runner dies.
  const faults = {
    mailCheck: ({ ack, batch }) => {
      if (!ack || first.dead || !batch?.some((m) => m.type === 'handoff')) return null
      first.dead = true
      return new OrcaError('call_timeout', 'no answer within 120s', 'orchestration check')
    },
  }
  // The first note carries it on, but it dies again 10 minutes later, under
  // the resume, whose own doctor's note cures it.
  let doctors = 0
  const patient = function dies(w) {
    w.state.gone = true
    w.state.onContinue = (c) => (c.text.includes(NOTE2) ? submitGood(c) : c.text.includes(NOTE) ? void clock.at(clock.now() + 10 * MIN, () => dies(c)) : dies(c))
  }
  const orca = fakeOrca({ clock, faults, worker: (w) => withDoctor(patient, (d) => handsOff(++doctors === 1 ? NOTE : NOTE2)(d))({ ...w, clock }) })
  const opts = { stateDir, out: () => {}, transcripts: fakeTranscripts(orca) }
  runScript(ISOLATED, { ...opts, orca, clock: first }).catch(() => {})
  await first.hung
  const before = orca.calls.length
  const handoff = sentWith(orca, NOTE)
  const died = journalOf(stateDir)
  assert.equal(ofType(died, 'mail').find((e) => e.messageId === handoff.id).action, 'remedy')
  assert.equal(ofType(died, 'remedy').length, 1)
  const batch = orca.calls.find((c) => c.verb === 'mailCheck' && c.ids.includes(handoff.id)).deliveryId
  assert.equal(orca.calls.some((c) => c.verb === 'mailCheck' && c.ack === batch), false, 'never acknowledged')

  assert.deepEqual(await runScript(ISOLATED, { ...opts, orca: orca.as('term_2'), clock, resume: true }), GOOD)
  const journal = journalOf(stateDir)
  assertEntries(journal)
  const after = orca.calls.slice(before)
  // Orca delivered it again, under a new delivery id, and the resume acknowledged it.
  const again = after.find((c) => c.verb === 'mailCheck' && c.ids.includes(handoff.id))
  assert.ok(again, 'delivered again to the resume')
  assert.ok(after.some((c) => c.verb === 'mailCheck' && c.ack === again.deliveryId))
  // The first note was applied once, by the first runner; the resume applied only its own doctor's.
  assert.equal(orca.calls.filter((c) => c.verb === 'workerContinue' && c.text.includes(NOTE)).length, 1)
  assert.equal(orca.calls.filter((c) => c.verb === 'workerContinue' && c.text.includes(NOTE2)).length, 1)
  assert.deepEqual(ofType(journal, 'remedy').map((e) => e.messageId), [sentWith(orca, NOTE2).id])
  const mail = ofType(journal, 'mail')
  assert.equal(new Set(mail.map((e) => e.messageId)).size, mail.length, 'one mail line per message, the carried ones included')
  assert.deepEqual(mail.filter((e) => e.messageId === handoff.id).map((e) => e.action), ['remedy'])
})

test('doctor: a worker_done --outcome failed over mail ends its round with no remedy, its body the reason', async () => {
  const r = await runOne(withDoctor(diesPastCap), { script: ISOLATED })
  assert.equal(r.result, null)
  assertEntries(r.journal)
  const gave = ofType(r.journal, 'mail').filter((e) => e.action === 'gaveUp')
  assert.deepEqual(gave.map((e) => [e.kind, e.outcome, e.body, e.doctor, e.patient, e.round]), [2, 3, 4].map((d, i) => ['worker_done', 'failed', GIVE_UP, d, 1, i + 1]))
  for (const e of gave) assert.ok(ackOf(r.orca.calls, e.messageId) >= 0, 'acknowledged')
  assert.deepEqual(ofType(r.journal, 'gaveUp').map((e) => [e.round, e.reason]), [1, 2, 3].map((round) => [round, `it gave up: ${GIVE_UP}`]))
  assert.deepEqual(ofType(r.journal, 'remedy'), [])
  const firstDoctor = r.journal.findIndex((e) => e.type === 'doctor')
  assert.equal(r.journal.slice(firstDoctor).some((e) => e.type === 'continued'), false)
  assert.equal(r.continues.length, 3, 'only the continuations before the cap')
})

test("fake orca: a Run's mailbox holds what its workers send, hands its coordinator the same batch until acknowledged, and a run-use delivers it again under a new id", async () => {
  const orca = fakeOrca()
  const { runId } = await orca.runCreate({ objective: 'o' })
  await orca.workerStart({ run: runId, prompt: 'p', title: 't', sessionId: SID })
  const [preamble] = orca.dispatches.values()
  const send = (body, type = 'handoff') => orca.mailSend({ ...idsOf(preamble), type, subject: 's', body })
  assert.deepEqual(await orca.mailCheck(), { deliveryId: null, acknowledged: null, replayed: false, messages: [] })
  const { id: a } = await send('one')
  const batch = await orca.mailCheck()
  assert.deepEqual([batch.replayed, batch.messages.map((m) => [m.id, m.type, m.body, m.dispatchId])], [false, [[a, 'handoff', 'one', preamble.dispatchId]]])
  const { id: b } = await send('two')
  const again = await orca.mailCheck()
  assert.deepEqual([again.deliveryId, again.replayed, again.messages.map((m) => m.id)], [batch.deliveryId, true, [a]], 'frozen when first issued')
  await assert.rejects(orca.mailCheck({ ack: 'delivery_nope' }), /stale_delivery/)
  const next = await orca.mailCheck({ ack: batch.deliveryId })
  assert.deepEqual([next.acknowledged, next.messages.map((m) => m.id)], [batch.deliveryId, [b]])
  await orca.as('term_2').runUse({ runId })
  assert.deepEqual((await orca.mailCheck()).messages, [], 'the old coordinator reads nothing')
  const taken = await orca.as('term_2').mailCheck()
  assert.notEqual(taken.deliveryId, next.deliveryId)
  assert.deepEqual([taken.replayed, taken.messages.map((m) => m.id)], [false, [b]])
  await send('done', 'worker_done')
  assert.equal(orca.dispatches.get(preamble.dispatchId).outcome, 'succeeded', 'a worker_done settles its dispatch')
})

// --- a start that fails is retried --------------------------------------------

const ISOLATED = `return await agent('Do a thing.', { label: 'one', phase: 'P', schema: ${JSON.stringify(SCHEMA)}, isolation: 'worktree' })`
const BACKOFF = RUNNER_SETTINGS.retryBackoffMs
// The one child worktree runOne's isolated agent asks for: `<runId>-<n>`.
const CHILD_WT = 'C:/fake/worktrees/run_fake1-1'
const entries = (r, type) => r.journal.filter((e) => e.type === type)
// The Run's own line aside: these are about one call's entries.
const types = (r) => r.journal.filter((e) => e.type !== 'run').map((e) => e.type)
const atMs = (e) => Date.parse(e.at)
const verbCount = (r, verb) => r.orca.calls.filter((c) => c.verb === verb).length

test('settings: a failed start or Run creation is retried after 30s, 2 and 5 minutes; every Orca call is bounded, and worktreeCreateMs bounds a worktree create at 10 minutes', () => {
  assert.deepEqual(RUNNER_SETTINGS.retryBackoffMs, [30_000, 2 * MIN, 5 * MIN])
  assert.ok(Object.isFrozen(RUNNER_SETTINGS.retryBackoffMs))
  assert.equal(RUNNER_SETTINGS.orcaCallMs, 2 * MIN)
  assert.equal(RUNNER_SETTINGS.worktreeCreateMs, 10 * MIN)
  assert.ok(RUNNER_SETTINGS.worktreeCreateMs > RUNNER_SETTINGS.orcaCallMs)
})

test('retry: a worktree create that times out after Orca made the worktree finds it by name, and the agent starts in it on the same attempt', async () => {
  const r = await runOne(submitGood, { script: ISOLATED, faults: { worktreeCreate: () => 'hang-after' } })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(types(r), ['starting', 'warning', 'started', 'result'], 'no retry')
  assert.equal(entries(r, 'warning')[0].reason, `orca worktreeCreate: call_timeout: no answer within 600s, but Orca had made ${CHILD_WT}, so it starts there`)
  assert.equal(atMs(entries(r, 'started')[0]), RUNNER_SETTINGS.worktreeCreateMs)
  assert.equal(entries(r, 'started')[0].worktree, CHILD_WT)
  assert.equal(verbCount(r, 'worktreeCreate'), 1)
  assert.equal(verbCount(r, 'worktreeList'), 1)

  const none = await runOne(submitGood, { script: ISOLATED, faults: { worktreeCreate: ({ count }) => (count === 1 ? 'hang' : null) } })
  assert.deepEqual(none.result, GOOD)
  assert.deepEqual(types(none), ['starting', 'retry', 'baseline', 'started', 'result'], 'with no worktree made, the attempt fails as the create did')
  assert.equal(entries(none, 'retry')[0].reason, 'its worker did not start: orca worktreeCreate: call_timeout: no answer within 600s')
})

test('retry: a start whose Orca call never answers counts as failed once it times out, and is retried', async () => {
  const r = await runOne(submitGood, { faults: { workerStart: ({ count }) => (count === 1 ? 'hang' : null) } })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(types(r), ['starting', 'retry', 'started', 'result'])
  const [retry] = entries(r, 'retry')
  assert.equal(retry.reason, 'its worker did not start: orca workerStart: call_timeout: no answer within 120s')
  assert.equal(retry.attempt, 2)
  // Journaled as the attempt fails, before the wait, with when the next begins.
  assert.equal(atMs(retry), RUNNER_SETTINGS.orcaCallMs)
  assert.equal(Date.parse(retry.nextAt), RUNNER_SETTINGS.orcaCallMs + BACKOFF[0])
  assert.equal(verbCount(r, 'terminalClose'), 1, 'the timed-out attempt\'s terminal is closed')
  assert.ok(r.lines.some((l) => l.endsWith('call_timeout: no answer within 120s; trying again in 30s (attempt 2 of 4)')), r.lines.join('\n'))
})

test('retry: a start that fails after its worktree was made takes that clean worktree up again and succeeds, making no second one', async () => {
  const r = await runOne(submitGood, { script: ISOLATED, faults: { waitIdle: ({ count }) => count === 1 && new OrcaError('agent_not_ready', 'never idle', 'terminal wait') } })
  assert.deepEqual(r.result, GOOD, 'nothing retained')
  assert.deepEqual(types(r), ['starting', 'baseline', 'retry', 'started', 'result'])
  assert.equal(verbCount(r, 'worktreeCreate'), 1)
  assert.deepEqual([...r.orca.worktrees.keys()], ['C:/fake/run', CHILD_WT])
  assert.deepEqual(r.orca.calls.filter((c) => c.verb === 'worktreeReuse').map((c) => c.worktree), [CHILD_WT])
  assert.equal(entries(r, 'started')[0].worktree, CHILD_WT)
  assert.equal(r.orca.worktrees.get(CHILD_WT).displayName, '[P] one')
})

for (const [what, spoil] of [
  ['untracked setup output', (w) => { w.porcelain.push('?? node_modules/') }],
  ['commits', (w) => { w.commits = 2 }],
]) {
  test(`retry: a retry that finds its worktree holding ${what}, with no worker ever dispatched, takes it up and the agent delivers`, async () => {
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
    assert.deepEqual(r.result, GOOD)
    assert.deepEqual(types(r), ['starting', 'baseline', 'retry', 'started', 'result'])
    assert.equal(verbCount(r, 'worktreeCreate'), 1)
    assert.deepEqual(r.orca.calls.filter((c) => c.verb === 'worktreeReuse').map((c) => c.worktree), [CHILD_WT])
    assert.equal(entries(r, 'started')[0].worktree, CHILD_WT)
  })
}

for (const [what, spoil, reason] of [
  ['uncommitted changes', (w) => { w.porcelain.push('?? notes.txt') }, `its worker did not start: orca worktree reuse: worktree_dirty: ${CHILD_WT} has uncommitted changes`],
  ['commits', (w) => { w.commits = 2 }, `its worker did not start: orca worktree reuse: worktree_has_commits: ${CHILD_WT} has 2 commit(s) of its own`],
]) {
  test(`retry: a retry after a worker-start was sent that finds its worktree with ${what} fails with that reason, and keeps the worktree`, async () => {
    const r = await runOne(submitGood, {
      script: ISOLATED,
      faults: {
        workerStart: ({ count, worktree, orca }) => {
          if (count > 1) return null
          spoil(orca.worktrees.get(worktree))
          return new OrcaError('call_timeout', 'no answer within 120s', 'orchestration worker-start')
        },
      },
    })
    assert.equal(r.result, null)
    assert.deepEqual(types(r), ['starting', 'baseline', 'retry', 'failed'], 'no further attempt: a retry cannot mend it')
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

// --- a worktree judged against its baseline -----------------------------------

const BORN = ['?? node_modules/', '?? package-lock.json']

test("baseline: a worktree born with setup output has that output journaled as its baseline before the agent's terminal opens", async () => {
  let atTerminal = null
  const orca = fakeOrca({ worker: submitting(), setupLeaves: BORN, faults: { terminalCreate: () => { atTerminal = journal.map((e) => e.type) } } })
  const { life, call, journal } = lifecycleOn(orca)
  assert.deepEqual(await life(call('impl', { isolated: true })), GOOD)
  assert.deepEqual(atTerminal, ['starting', 'baseline'])
  const [b] = journal.filter((e) => e.type === 'baseline')
  assertEntries([{ ...b, at: new Date(0).toISOString() }])
  assert.deepEqual([b.n, b.title, b.worktree, b.lines], [1, '[P] impl', CHILD_WT, BORN])
  assert.deepEqual(foldJournal(journal).agents[0].baseline, BORN)

  const clean = await runOne(submitGood, { script: ISOLATED })
  assert.deepEqual(entries(clean, 'baseline').map((e) => e.lines), [[]], 'a clean one is journaled with none')
  const late = await runOne(submitGood, { script: ISOLATED, setupLeaves: BORN, faults: { worktreeCreate: () => 'hang-after' } })
  assert.deepEqual(entries(late, 'baseline'), [], 'a create that timed out has no baseline')
})

// A worker-start that fails once it was sent, so a worker may have run.
const failsOnceSent = (spoil = () => {}) => ({
  workerStart: ({ count, worktree, orca }) => {
    if (count > 1) return null
    spoil(orca.worktrees.get(worktree))
    return new OrcaError('call_timeout', 'no answer within 120s', 'orchestration worker-start')
  },
})

test('baseline: a retry after a dispatched worker takes up a worktree unchanged since its baseline, and refuses one changed since', async () => {
  const same = await runOne(submitGood, { script: ISOLATED, setupLeaves: BORN, faults: failsOnceSent() })
  assert.deepEqual(same.result, GOOD)
  assert.deepEqual(types(same), ['starting', 'baseline', 'retry', 'started', 'result'], 'one baseline, from its create')
  assert.deepEqual(same.orca.calls.filter((c) => c.verb === 'worktreeReuse').map((c) => c.worktree), [CHILD_WT])
  assert.equal(verbCount(same, 'worktreeCreate'), 1)

  const changed = await runOne(submitGood, { script: ISOLATED, setupLeaves: BORN, faults: failsOnceSent((w) => w.porcelain.push('?? notes.txt')) })
  assert.equal(changed.result, null)
  assert.deepEqual(types(changed), ['starting', 'baseline', 'retry', 'failed'])
  const [failed] = entries(changed, 'failed')
  assert.equal(failed.reason, `its worker did not start: orca worktree reuse: worktree_dirty: ${CHILD_WT} has changed since it was made`)
  assert.equal(failed.retained.path, CHILD_WT)
})

test("baseline: the agent's prompt names its worktree's baseline files with the staging rule, and carries no such section with none", async () => {
  const rule = /These files were in your worktree before you, left by its setup: node_modules\/, package-lock\.json\. They are not your work, so never stage or commit them\. Stage your own changes by path/
  const promptOf = (r) => [...r.orca.dispatches.values()][0].prompt
  const born = await runOne(submitGood, { script: ISOLATED, setupLeaves: BORN })
  assert.match(promptOf(born), rule)
  assert.ok(promptOf(born).startsWith('Do a thing.\n\n---\nThese files'), promptOf(born))
  const retried = await runOne(submitGood, { script: ISOLATED, setupLeaves: BORN, faults: failsOnceSent() })
  assert.match(promptOf(retried), rule, 'a worktree taken up again keeps its baseline')
  for (const r of [await runOne(submitGood, { script: ISOLATED }), await runOne(submitGood, { script: ISOLATED, setupLeaves: BORN, faults: { worktreeCreate: () => 'hang-after' } }), await runOne(submitGood, { setupLeaves: BORN })]) {
    assert.doesNotMatch(promptOf(r), /before you|stage/i)
    assert.ok(promptOf(r).startsWith('Do a thing.\n\n---\nHow this run receives your result'))
  }
})

test('retry: a start that fails every time is null after its retries, each journaled as retry at the backoff the table sets, then failed with the last reason', async () => {
  const r = await runOne(submitGood, { script: ISOLATED, faults: { terminalCreate: ({ count }) => new OrcaError('runtime_unavailable', `try ${count}`, 'terminal create') } })
  assert.equal(r.result, null)
  assertEntries(r.journal)
  assert.deepEqual(types(r), ['starting', 'baseline', 'retry', 'retry', 'retry', 'failed'])
  const retries = entries(r, 'retry')
  assert.deepEqual(retries.map((e) => e.attempt), [2, 3, 4])
  assert.deepEqual(retries.map((e) => e.reason), [1, 2, 3].map((i) => `its worker did not start: orca terminal create: runtime_unavailable: try ${i}`))
  // Each journaled as its attempt fails, so a runner that dies in the wait
  // still leaves why; nextAt is when the next attempt begins.
  assert.deepEqual(retries.map(atMs), [0, BACKOFF[0], BACKOFF[0] + BACKOFF[1]])
  assert.deepEqual(retries.map((e) => Date.parse(e.nextAt)), [BACKOFF[0], BACKOFF[0] + BACKOFF[1], BACKOFF[0] + BACKOFF[1] + BACKOFF[2]])
  const [failed] = entries(r, 'failed')
  assert.equal(failed.reason, 'its worker did not start: orca terminal create: runtime_unavailable: try 4')
  assert.equal(failed.attempts, 4)
  assert.equal(failed.retained.path, CHILD_WT)
  assert.equal(verbCount(r, 'worktreeCreate'), 1, 'every retry took up the one worktree')
})

test('retry: the backoff is whatever the settings table says', async () => {
  const r = await runOne(submitGood, { settings: { retryBackoffMs: [1_000, 7_000] }, faults: { terminalCreate: () => new OrcaError('runtime_unavailable', '', 'terminal create') } })
  assert.equal(r.result, null)
  assert.deepEqual(entries(r, 'retry').map((e) => [atMs(e), Date.parse(e.nextAt)]), [[0, 1_000], [1_000, 8_000]])
  assert.equal(entries(r, 'failed')[0].attempts, 3)
})

test('retry: a Run Orca fails to create, or never answers for, is retried under the same policy, and the agent then starts', async () => {
  const faults = { runCreate: ({ count }) => (count === 1 ? 'hang' : count === 2 && new OrcaError('runtime_unavailable', 'try 2', 'orchestration run-create')) }
  const r = await runOne(submitGood, { faults })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(types(r), ['retry', 'retry', 'starting', 'started', 'result'])
  const call = RUNNER_SETTINGS.orcaCallMs
  assert.deepEqual(entries(r, 'retry').map((e) => [e.attempt, atMs(e), Date.parse(e.nextAt), e.reason]), [
    [2, call, call + BACKOFF[0], "Orca could not create this run's Run: orca runCreate: call_timeout: no answer within 120s"],
    [3, call + BACKOFF[0], call + BACKOFF[0] + BACKOFF[1], "Orca could not create this run's Run: orca orchestration run-create: runtime_unavailable: try 2"],
  ])
  assert.equal(verbCount(r, 'runCreate'), 1)
})

test('warnings: a display name or board status Orca refuses is logged and journaled, and the agent still delivers', async () => {
  const refused = () => new OrcaError('selector_not_found', 'no such worktree', 'worktree set')
  const r = await runOne(submitGood, { script: ISOLATED, faults: { worktreeSet: refused, worktreeStatus: refused } })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(types(r), ['starting', 'baseline', 'warning', 'started', 'warning', 'result'])
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
  w.armed({ runId: 'run_a', project: 'C:/repo', runDir: 'C:/a', spec: 's1', script: 'C:/notes/workflow.js', permissionMode: 'auto' })
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
    runId: 'run_a', project: 'C:/repo', runDir: 'C:/a', spec: 's1', script: 'C:/notes/workflow.js', permissionMode: 'auto', armedAt: isoAt(0),
    state: 'failed', endedAt: isoAt(2 * MIN), runner: { terminal: 'term_2', at: isoAt(MIN) },
    reclaimed: true, reclaimedAt: isoAt(4 * MIN), reclaimedAgents: [{ agent: 'run_a-3', at: isoAt(3 * MIN) }],
  })
  assert.deepEqual(runs[1], {
    runId: 'run_b', project: 'C:/other', runDir: 'C:/b', spec: 's2', script: null, permissionMode: null, armedAt: isoAt(0),
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

test('runner liveness: one rule, by runner.pid, never by the tab; null when it cannot be told', () => {
  const dir = tmp()
  assert.equal(runnerAlive(dir), false, 'no runner.pid: never started, or gone before writing it')
  writeFileSync(join(dir, 'runner.pid'), String(process.pid))
  assert.equal(runnerAlive(dir), true)
  writeFileSync(join(dir, 'runner.pid'), 'garbage')
  assert.equal(runnerAlive(dir), false)
  assert.equal(runnerAlive(null), null, 'no run dir recorded: nobody can say')
})

test('registry: a resume after `ended` reopens the run, and one after a whole-run `reclaimed` takes the reclaim back, keeping the agents already reclaimed', () => {
  const path = registryIn()
  const clock = fakeClock()
  const w = runRegistry(path, clock)
  w.armed({ runId: 'run_a', project: 'C:/repo', runDir: 'C:/a', spec: 's' })
  w.runner({ runId: 'run_a', terminal: 'term_1' })
  clock.t = MIN
  w.ended({ runId: 'run_a', outcome: 'failed' })
  clock.t = 2 * MIN
  w.runner({ runId: 'run_a', terminal: 'term_2' })
  const fact = () => {
    const [r] = readRegistry(path)
    return [r.state, r.endedAt, r.runner.terminal, r.reclaimed, r.reclaimedAt, r.reclaimedAgents.map((a) => a.agent)]
  }
  assert.deepEqual(fact(), ['running', null, 'term_2', false, null, []], 'resumed after it ended: running, with no outcome')

  // The iterate-after-failure flow: the operator reclaims it all from the run view, then --resume.
  clock.t = 3 * MIN
  w.ended({ runId: 'run_a', outcome: 'partial' })
  w.reclaimed({ runId: 'run_a', agent: 'run_a-1' })
  w.reclaimed({ runId: 'run_a' })
  assert.deepEqual(fact(), ['partial', isoAt(3 * MIN), 'term_2', true, isoAt(3 * MIN), ['run_a-1']])
  clock.t = 4 * MIN
  w.runner({ runId: 'run_a', terminal: 'term_3' })
  assert.deepEqual(fact(), ['running', null, 'term_3', false, null, ['run_a-1']], 'resumed after a whole-run reclaim: open again')
  // A resumed runner's torn `runner` line changes nothing.
  writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ type: 'ended', runId: 'run_a', at: isoAt(5 * MIN), outcome: 'ok' }) + '\n{"type":"runner","runId":"run_a","term')
  assert.deepEqual(fact().slice(0, 3), ['ok', isoAt(5 * MIN), 'term_3'])
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

test('registry: the runner arms its Run with the script and permission mode a resume relaunches it with', async () => {
  const registry = registryIn()
  const orca = fakeOrca({ worker: submitGood })
  await runScript(SCRIPT, { orca, stateDir: tmp(), out: () => {}, registry, project: 'C:/repo', script: 'C:/notes/workflow.js', permissionMode: 'acceptEdits' })
  const [armed] = linesOf(registry)
  assert.deepEqual([armed.type, armed.script, armed.permissionMode], ['armed', 'C:/notes/workflow.js', 'acceptEdits'])
  assert.deepEqual([readRegistry(registry)[0].script, readRegistry(registry)[0].permissionMode], ['C:/notes/workflow.js', 'acceptEdits'])
})

test('registry: a run where an agent came back null ends partial; a run that throws ends failed', async () => {
  const registry = registryIn()
  const died = await registered(registry, { worker: async () => { throw new Error('agent died') } })
  assert.deepEqual(died.result, { r: null })
  const threw = await registered(registry, { script: SCRIPT.replace(/return \{ r \}$/, "throw new Error('boom')"), runPrefix: 'run_throw' })
  assert.match(threw.result.message, /boom/)
  assert.deepEqual(readRegistry(registry).map((r) => [r.runId, r.state]), [['run_fake1', 'partial'], ['run_throw1', 'failed']])
})

test("registry: a resume that launches takes its Run over and records the new runner's terminal; one that replays everything records nothing", async () => {
  const registry = registryIn()
  const stateDir = tmp()
  let tag = 0
  const orca = answering(() => tag)
  const go = (script, n, resume) => {
    tag = n
    return runScript(script, { orca: orca.as(`term_r${n}`), stateDir, out: () => {}, settings: FAST, resume, registry, project: 'C:/repo' })
  }
  await go(chain('Build it.'), 1, false)
  await go(chain('Build it.'), 2, true)
  assert.deepEqual(linesOf(registry).map((e) => e.type), ['armed', 'runner', 'ended'], 'a fully replayed resume takes nothing over')
  await go(chain('Build it again.'), 3, true)
  assert.deepEqual(readRegistry(registry).map((r) => [r.runId, r.runDir, r.runner.terminal, r.state]), [['run_fake1', stateDir, 'term_r3', 'ok']])
  assert.deepEqual(linesOf(registry).map((e) => [e.type, e.runId]).slice(3), [['runner', 'run_fake1'], ['ended', 'run_fake1']], 'armed once, by the runner that created it')
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

// --- nothing is reclaimed during a run; the operator reclaims from the view ---

// a: isolated, delivers. b: isolated, its tab gone with no result, and gone
// again in each of its 3 continuations (ctx_fake3-5), so dead. c: in the run's
// own worktree, delivers (ctx_fake6).
const END = `const S = ${JSON.stringify(SCHEMA)}
const a = await agent('Build a.', { label: 'a', phase: 'P', schema: S, isolation: 'worktree' })
const b = await agent('Build b.', { label: 'b', phase: 'P', schema: S, isolation: 'worktree' })
const c = await agent('Check it.', { label: 'c', phase: 'P', schema: S })
return [a, b, c]`
const goneAgain = ({ state }) => {
  state.gone = true
  state.onContinue = goneAgain
}
const endWorker = async (w) => {
  if (w.prompt.startsWith('Build b.')) goneAgain(w)
  else await submitGood(w)
}
const A_WT = 'C:/fake/worktrees/run_fake1-1'
const B_WT = 'C:/fake/worktrees/run_fake1-2'

// A run of END on the fake clock, recorded in its own registry.
async function endedRun({ script = END, worker = endWorker } = {}) {
  const clock = fakeClock()
  const stateDir = tmp()
  const registry = registryIn()
  const orca = fakeOrca({ worker: (w) => worker({ ...w, clock }), clock })
  const result = await runScript(script, { orca, stateDir, out: () => {}, clock, registry, project: 'C:/repo', settings: NO_DOCTOR })
  return { orca, stateDir, clock, registry, result, during: orca.calls.length }
}

const MUTATING = ['workerRelease', 'terminalClose', 'worktreeRemove']

test('keep every agent: during a run Orca is asked for no worker release, no terminal close and no worktree removal', async () => {
  const script = `${END.replace(/return \[a, b, c\]$/, '')}
const d = await agent('Idle.', { label: 'd', phase: 'P', schema: S, isolation: 'worktree' })
return [a, b, c, d]`
  const run = await endedRun({ script, worker: async (w) => (w.prompt.startsWith('Idle.') ? (w.state.idle = true) : endWorker(w)) })
  assert.deepEqual(run.result, [GOOD, null, GOOD, null])
  assert.deepEqual(run.orca.calls.filter((c) => MUTATING.includes(c.verb)), [])
  assert.ok(run.orca.calls.some((c) => c.verb === 'workerStop'), 'the idle one died and was stopped, not released')
  for (const d of run.orca.dispatches.values()) assert.equal(d.released, false, d.title)
  for (const [path, w] of run.orca.worktrees) assert.equal(w.removed, false, path)
})

test('reclaim: a worktree with unpushed commits is kept unless forced, and nothing of its agent is touched first', async () => {
  const run = await endedRun()
  run.orca.worktrees.get(A_WT).unpushed = 2
  const agents = agentsOf(join(run.stateDir, 'journal.jsonl'))
  const r = await reclaimRun(agents, { orca: run.orca, unpushed: run.orca.unpushedOf, registry: runRegistry(run.registry, run.clock) })
  assert.deepEqual(r.kept.map((k) => [k.agent.title, k.reason]), [['[P] a', `${A_WT} holds 2 unpushed commits; only a forced reclaim removes it`]])
  assert.equal(run.orca.calls.slice(run.during).some((c) => c.verb === 'workerRelease' && c.dispatchId === 'ctx_fake1'), false)
  assert.equal(run.orca.worktrees.get(A_WT).removed, false)
  assert.equal(linesOf(run.registry).some((e) => e.type === 'reclaimed' && !e.agent), false, 'a run with an agent kept is not reclaimed whole')

  const [a] = agents
  assert.deepEqual(await reclaimAgent(a, { orca: run.orca, unpushed: run.orca.unpushedOf, force: true }), { reclaimed: true, notes: [] })
  assert.equal(run.orca.worktrees.get(A_WT).removed, true)
})

test('reclaim: a live agent is refused and left untouched; once settled it is reclaimed, its open tab closed', async () => {
  const orca = fakeOrca({ worker: () => new Promise(() => {}) })
  const w = await orca.workerStart({ run: 'run_x', prompt: 'p', title: '[P] live', sessionId: SID, child: { name: 'run_x-1', displayName: '[P] live' } })
  const agent = { runId: 'run_x', n: 1, name: 'run_x-1', title: '[P] live', dispatchId: w.dispatchId, terminal: w.terminal, worktree: w.worktree, state: 'running' }
  const before = orca.calls.length
  assert.deepEqual(await reclaimAgent(agent, { orca, unpushed: orca.unpushedOf, force: true }), { reclaimed: false, reason: 'it is still live' })
  assert.deepEqual(orca.calls.slice(before).filter((c) => MUTATING.includes(c.verb)), [])

  orca.dispatches.get(w.dispatchId).settled = true
  assert.equal((await reclaimAgent(agent, { orca, unpushed: orca.unpushedOf })).reclaimed, true)
  assert.deepEqual(orca.calls.slice(before).filter((c) => [...MUTATING, 'terminalList'].includes(c.verb)).map((c) => c.verb), ['terminalList', 'workerRelease', 'terminalClose', 'worktreeRemove'])
})

test('reclaim: the journal names each agent this run launched, with its Run, dispatch, tab, worktree and state', async () => {
  const run = await endedRun()
  // b's is the dispatch and tab of its last continuation.
  assert.deepEqual(agentsOf(join(run.stateDir, 'journal.jsonl')).map(({ name, dispatchId, terminal, worktree, state }) => ({ name, dispatchId, terminal, worktree, state })), [
    { name: 'run_fake1-1', dispatchId: 'ctx_fake1', terminal: 'term_fake1', worktree: A_WT, state: 'ok' },
    { name: 'run_fake1-2', dispatchId: 'ctx_fake5', terminal: 'term_fake5', worktree: B_WT, state: 'failed' },
    { name: 'run_fake1-3', dispatchId: 'ctx_fake6', terminal: 'term_fake6', worktree: 'C:/fake/run', state: 'ok' },
  ])
})

test('reclaim: unpushed counts commits no remote-tracking ref contains; uncommitted files do not count', async () => {
  const dir = tmp()
  const git = (...args) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'one')
  assert.equal(await worktreeUnpushed(dir), 1)
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  writeFileSync(join(dir, 'dirty.txt'), 'x')
  assert.equal(await worktreeUnpushed(dir), 0)
  git('commit', '-q', '--allow-empty', '-m', 'two')
  assert.equal(await worktreeUnpushed(dir), 1)
  assert.equal(await worktreeUnpushed(join(dir, 'gone')), 0, 'a worktree already gone holds none')
})

test('orca-cli: tab liveness is the terminal list without orphans; a reclaim closes the whole tab and force-removes the worktree by path', async () => {
  const { argvs, orca } = recordingCli({ 'terminal list': { terminals: [{ handle: 'term_a', orphaned: false }, { handle: 'term_b', orphaned: true, title: null }] } })
  assert.deepEqual(await orca.terminalList(), ['term_a'])
  await orca.terminalClose({ terminal: 'term_a' })
  await orca.worktreeRemove({ path: 'C:/wt/run_1-3' })
  assert.deepEqual(argvs, [
    ['terminal', 'list'],
    ['terminal', 'close', '--terminal', 'term_a', '--tab'],
    ['worktree', 'rm', '--worktree', 'path:C:/wt/run_1-3', '--force'],
  ])
})

// Resume from a new terminal. The first runner is killed once b's and c's
// workers are out: like a runner whose tab died, it never wakes from its next
// wait. Its Orca, dispatches and all, lives on, and the resume runs from
// another terminal of that Orca.
const TAKEOVER = `const S = ${JSON.stringify(SCHEMA)}
phase('P')
const a = await agent('A', { label: 'a', schema: S })
const bc = await parallel([
  () => agent('B', { label: 'b', schema: S, isolation: 'worktree' }),
  () => agent('C', { label: 'c', schema: S, isolation: 'worktree' }),
])
const d = await agent('D', { label: 'd', schema: S })
return [a, ...bc, d]`

// b submits at 10 minutes, long after the takeover; c dies while no runner
// watches (its tab closed, or its agent exited) and submits once continued.
async function takenOver({ oldTab, death }) {
  const clock = fakeClock()
  const stateDir = tmp()
  const registry = registryIn()
  let killed = false
  let hung = 0
  let bothHung
  const gone = new Promise((r) => { bothHung = r })
  const mortal = { now: clock.now, timer: clock.timer, sleep: (ms) => (killed ? (++hung === 2 && bothHung(), new Promise(() => {})) : clock.sleep(ms)) }
  const orca = fakeOrca({
    clock,
    coordinator: 'term_old',
    worker: async (w) => {
      if (w.prompt.startsWith('B')) return void clock.at(10 * MIN, () => submitGood(w))
      if (w.prompt.startsWith('C')) {
        w.state.onContinue = submitGood
        killed = true
        return
      }
      return submitGood(w)
    },
  })
  const opts = { stateDir, clock, registry, project: 'C:/repo', transcripts: fakeTranscripts(orca) }
  runScript(TAKEOVER, { ...opts, orca, out: () => {}, clock: mortal }).catch(() => {})
  await gone

  const first = orca.calls.slice()
  const startOf = (label) => first.find((c) => c.verb === 'workerStart' && c.title === `[P] ${label}`)
  const c = orca.dispatches.get(startOf('c').dispatchId)
  if (death === 'gone') c.gone = true
  else c.exited = true
  if (oldTab === 'closed') orca.closeTab('term_old')

  const lines = []
  const result = await runScript(TAKEOVER, { ...opts, orca: orca.as('term_new'), out: (s) => lines.push(s), resume: true })
  return { result, orca, first, startOf, calls: orca.calls.slice(first.length), journal: journalOf(stateDir), registry, lines }
}

for (const [oldTab, death] of [['open', 'gone'], ['closed', 'gone'], ['open', 'exited']]) {
  test(`takeover (old tab ${oldTab}, c's agent ${death === 'gone' ? 'tab closed' : 'exited'}): a resume from a new terminal takes the Run over before any start, reattaches to the live worker, continues the dead one, replays the finished one, and starts only the one never started`, async () => {
    const r = await takenOver({ oldTab, death })
    assert.deepEqual(r.result, [GOOD, GOOD, GOOD, GOOD], r.lines.join('\n'))
    assertEntries(r.journal)
    const verbs = r.calls.map((c) => c.verb)

    // run-use on the recorded Run, from the new terminal, before any worker-start.
    const use = verbs.indexOf('runUse')
    assert.deepEqual([r.calls[use].runId, r.calls[use].terminal], ['run_fake1', 'term_new'])
    assert.equal(verbs.includes('runCreate'), false)
    for (const v of ['workerStart', 'workerContinue']) assert.ok(verbs.indexOf(v) > use, `${v} before run-use: ${verbs.join(' ')}`)
    assert.deepEqual(ofType(r.journal, 'run').map((e) => [e.runId, e.terminal]), [['run_fake1', 'term_old'], ['run_fake1', 'term_new']])

    // a replays, and only d, never reached before, starts a worker.
    assert.deepEqual(started({ calls: r.calls }), ['[P] d'])
    assert.equal(ofType(r.journal, 'result').find((e) => e.title === '[P] a').replayed, true)

    // b: reattached, never started again, its result returned once it submits.
    const b = r.startOf('b')
    const bd = r.orca.dispatches.get(b.dispatchId)
    const reB = ofType(r.journal, 'reattached').find((e) => e.title === '[P] b')
    assert.deepEqual([reB.dispatchId, reB.sessionId, reB.terminal, reB.worktree], [b.dispatchId, b.sessionId, bd.handle, b.worktree])
    assert.equal([...r.orca.dispatches.values()].filter((d) => d.title === '[P] b').length, 1)
    within(r.calls.find((c) => c.verb === 'workerDone' && c.dispatchId === b.dispatchId).at, 10 * MIN, "b's submit")
    assert.equal(r.calls.filter((c) => c.verb === 'workerRelease' && c.dispatchId === b.dispatchId).length, 0, 'nothing is released during a run')

    // c: continued in its own session and worktree; a new terminal only if its tab was gone.
    const c = r.startOf('c')
    const [cont] = r.calls.filter((x) => x.verb === 'workerContinue')
    assert.equal(cont.worktree, c.worktree)
    assert.ok(cont.command.startsWith(`claude --resume ${c.sessionId}`), cont.command)
    assert.equal(cont.reopened, death === 'gone')
    if (death === 'gone') assert.notEqual(cont.terminal, r.orca.dispatches.get(c.dispatchId).handle)
    else assert.equal(cont.terminal, r.orca.dispatches.get(c.dispatchId).handle)
    const [jc] = ofType(r.journal, 'continued')
    assert.deepEqual([jc.title, jc.sessionId, jc.attempt, jc.reopened], ['[P] c', c.sessionId, 1, death === 'gone'])
    assert.match(jc.reason, death === 'gone' ? /closed while no runner was watching/ : /exited while no runner was watching/)

    // The registry: armed once, then the resumed runner's terminal.
    assert.deepEqual(linesOf(r.registry).map((e) => [e.type, e.runId, e.terminal]), [
      ['armed', 'run_fake1', undefined], ['runner', 'run_fake1', 'term_old'], ['runner', 'run_fake1', 'term_new'], ['ended', 'run_fake1', undefined],
    ])
    assert.deepEqual(readRegistry(r.registry).map((x) => [x.runner.terminal, x.state]), [['term_new', 'ok']])

    // The old coordinator, its tab still open, is fenced from the Run.
    if (oldTab === 'open') await assert.rejects(r.orca.as('term_old').workerStart({ run: 'run_fake1', prompt: 'p', title: 't', sessionId: SID }), /consumer_fenced/)
  })
}

test('resume: the journal gives each call left out its worker as last journaled, a call never started its place, and the Run to take over', () => {
  const path = join(tmp(), 'journal.jsonl')
  const out = (key, n, name, dispatchId, extra = {}) => ({ type: 'outstanding', key, n, title: `[P] ${name}`, dispatchId, sessionId: SID, terminal: `term_${n}`, worktree: null, dir: `agents/00${n}-${name}`, ...extra })
  const lines = [
    { type: 'run', runId: 'run_1', terminal: 'term_a', lastN: 4 },
    // Carried forward from the resume before: b and e are taken up below, d never is.
    out('kb', 2, 'b', 'ctx_1', { worktree: 'C:/wt/run_1-2', continuations: 1 }),
    out('kd', 3, 'd', 'ctx_4'),
    out('ke', 4, 'e', 'ctx_5'),
    { type: 'result', key: 'ka', n: 5, result: 1, replayed: true },
    { type: 'reattached', key: 'kb', n: 6, title: '[P] b', dispatchId: 'ctx_1', sessionId: SID, terminal: 'term_1', worktree: 'C:/wt/run_1-2', dir: 'agents/002-b', continuations: 1 },
    { type: 'continued', key: 'kb', n: 6, dispatchId: 'ctx_2', sessionId: SID, terminal: 'term_2', attempt: 2, reopened: true },
    { type: 'retry', key: 'kc', n: 7, attempt: 2, reason: 'x' },
    { type: 'started', key: 'kc', n: 8, dispatchId: 'ctx_3', sessionId: SID, terminal: 'term_3', worktree: null, dir: 'agents/008-c' },
    { type: 'failed', key: 'kc', n: 8, reason: 'dead', attempts: 1 },
    { type: 'result', key: 'kd', n: 9, result: 2 },
    // A reattached line from before workers carried their dir: named by its own n and title.
    { type: 'reattached', key: 'kf', n: 10, title: '[Q] f', dispatchId: 'ctx_6', sessionId: SID, terminal: 'term_6', worktree: null },
    // e's Run could not be taken over: its call returned null, its worker still out.
    { type: 'reattached', key: 'ke', n: 11, title: '[P] e', dispatchId: 'ctx_5', sessionId: SID, terminal: 'term_4', worktree: 'C:/wt/run_1-4', dir: 'agents/004-e' },
    { type: 'failed', key: 'ke', n: 11, reason: 'run-use refused', attempts: 5, workerOut: true, retained: { path: 'C:/wt/run_1-4', reason: 'still out' } },
    { type: 'run', runId: 'run_1', terminal: 'term_b' },
  ]
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const j = readJournal(path)
  assert.deepEqual(j.run, { runId: 'run_1', terminal: 'term_b' })
  assert.equal(j.lastN, 11)
  assert.deepEqual(j.calls.get('ka'), [{ result: 1 }])
  // One worker per call: a reattached line takes over the outstanding one for its dispatch, and keeps its dir.
  // A worker line with no Run or origin of its own, as journaled before they
  // carried them, is in the journal's Run, and is the agent its dispatch names.
  assert.deepEqual(j.calls.get('kb'), [{ worker: { n: 6, title: '[P] b', dir: 'agents/002-b', run: 'run_1', dispatchId: 'ctx_2', harness: null, sessionId: SID, terminal: 'term_2', worktree: 'C:/wt/run_1-2', continuations: 2, origin: 2 } }])
  assert.deepEqual(j.calls.get('kc'), [{ unsettled: true }, { failed: true }])
  // An outstanding line no call took up follows the calls this run made under its key.
  assert.deepEqual(j.calls.get('kd'), [{ result: 2 }, { worker: { n: 3, title: '[P] d', dir: 'agents/003-d', run: 'run_1', dispatchId: 'ctx_4', harness: null, sessionId: SID, terminal: 'term_3', worktree: null, continuations: 0, origin: 3 } }])
  assert.deepEqual(j.calls.get('ke'), [{ worker: { n: 11, title: '[P] e', dir: 'agents/004-e', run: 'run_1', dispatchId: 'ctx_5', harness: null, sessionId: SID, terminal: 'term_4', worktree: 'C:/wt/run_1-4', continuations: 0, origin: 4 } }])
  assert.equal(j.calls.get('kf')[0].worker.dir, 'agents/010-f')
  assert.deepEqual(j.retained, [{ path: 'C:/wt/run_1-4', reason: 'still out' }])
})

// b's worker is still out when its runner dies, and submits only when the
// test calls submitB.
const LEFT_OUT = `const S = ${JSON.stringify(SCHEMA)}
phase('P')
const a = await agent('A', { label: 'a', schema: S })
const b = await agent('B', { label: 'b', schema: S, isolation: 'worktree' })
return { a, b }`

// A runner killed on its clock: once `dead`, its every sleep hangs, as a
// runner's whose tab died does, and `hung` resolves.
function mortalOn(clock, dead = false) {
  let died
  const hung = new Promise((r) => { died = r })
  const m = { dead, hung, now: clock.now, timer: clock.timer, sleep: (ms) => (m.dead ? (died(), new Promise(() => {})) : clock.sleep(ms)) }
  return m
}

async function leftOut({ registry = null } = {}) {
  const clock = fakeClock()
  const stateDir = tmp()
  const faults = {}
  const first = mortalOn(clock)
  let bw = null
  const orca = fakeOrca({
    clock,
    coordinator: 'term_1',
    faults,
    worker: async (w) => {
      if (!w.prompt.startsWith('B')) return submitGood(w)
      bw = w
      first.dead = true
    },
  })
  const opts = { stateDir, project: 'C:/repo', transcripts: fakeTranscripts(orca), out: () => {}, registry }
  runScript(LEFT_OUT, { ...opts, orca, clock: first }).catch(() => {})
  await first.hung
  // A resume from terminal `from`, to its end, or on a `mortal` clock until it dies.
  const resume = async (from, mortal = null) => {
    const run = runScript(LEFT_OUT, { ...opts, orca: orca.as(from), clock: mortal ?? clock, resume: true })
    if (!mortal) return run
    run.catch(() => {})
    await mortal.hung
    return null
  }
  return { clock, stateDir, faults, orca, b: startedAs(orca, '[P] b'), submitB: () => submitGood(bw), resume }
}

test('takeover: a worker still out through one resume, and submitting during the next, has its result returned from the files its prompt named', async () => {
  const r = await leftOut()
  await r.resume('term_2', mortalOn(r.clock, true))
  const reB = ofType(journalOf(r.stateDir), 'reattached').find((e) => e.title === '[P] b')
  assert.deepEqual([reB.dispatchId, reB.dir], [r.b.dispatchId, 'agents/002-b'])
  assert.notEqual(reB.n, 2)

  r.clock.at(r.clock.now() + 2 * MIN, r.submitB)
  const before = r.orca.calls.length
  assert.deepEqual(await r.resume('term_3'), { a: GOOD, b: GOOD })
  assert.deepEqual(started(r.orca), ['[P] a', '[P] b'])
  assert.deepEqual([...new Set(r.orca.calls.slice(before).filter((c) => c.verb === 'workerShow').map((c) => c.dispatchId))], [r.b.dispatchId])
  const journal = journalOf(r.stateDir)
  assertEntries(journal)
  assert.deepEqual(ofType(journal, 'failed'), [])
  assert.deepEqual(ofType(journal, 'result').map((e) => [e.title, e.result, e.replayed]), [['[P] a', GOOD, true], ['[P] b', GOOD, undefined]])
})

for (const how of ['refused', 'dies']) {
  test(`takeover: a resume ${how === 'refused' ? 'whose run-use Orca refuses for good' : 'that dies retrying its run-use'} leaves the worker still out to the next resume, which takes that same dispatch up and starts none`, async () => {
    const r = await leftOut()
    r.faults.runUse = () => new OrcaError('run_busy', 'not now', 'run-use')
    if (how === 'refused') {
      const once = await r.resume('term_2')
      assert.deepEqual([once.a, once.b], [GOOD, null])
      assert.deepEqual(once.worktrees_kept.map((k) => k.path), [r.b.worktree])
      const journal = journalOf(r.stateDir)
      assertEntries(journal)
      // A failed line, so the run ends partial, but one that leaves the worker out.
      assert.deepEqual(ofType(journal, 'failed').map((e) => [e.title, e.workerOut, e.retained?.path]), [['[P] b', true, r.b.worktree]])
    } else await r.resume('term_2', mortalOn(r.clock, true))
    // Either way the journal still holds b's worker, and only it.
    const out = [...readJournal(join(r.stateDir, 'journal.jsonl')).calls.values()].flat().filter((e) => e.worker)
    assert.deepEqual(out.map((e) => [e.worker.dispatchId, e.worker.dir]), [[r.b.dispatchId, 'agents/002-b']])
    delete r.faults.runUse

    r.clock.at(r.clock.now() + 2 * MIN, r.submitB)
    const before = r.orca.calls.length
    const result = await r.resume('term_3')
    assert.deepEqual(result, { a: GOOD, b: GOOD })
    const calls = r.orca.calls.slice(before)
    assert.deepEqual(calls.filter((c) => c.verb === 'workerStart'), [])
    assert.deepEqual([...new Set(calls.filter((c) => c.verb === 'workerShow').map((c) => c.dispatchId))], [r.b.dispatchId])
    const journal = journalOf(r.stateDir)
    assertEntries(journal)
    assert.deepEqual(ofType(journal, 'retained'), [])
  })
}

test('reclaim: a worker a resume took up, then kept blocked on a human with its process left running, is refused unless a confirmed reclaim stops it first', async () => {
  const r = await leftOut()
  r.orca.dispatches.get(r.b.dispatchId).waiting = JSON.stringify({ question: 'Which branch?' })
  const result = await r.resume('term_2')
  assert.deepEqual([result.a, result.b], [GOOD, null])
  const journal = journalOf(r.stateDir)
  assertEntries(journal)
  const runId = ofType(journal, 'run')[0].runId
  // Taken up with every field `started` gives a worker, and the call that started it.
  const reB = ofType(journal, 'reattached').find((e) => e.title === '[P] b')
  assert.deepEqual([reB.run, reB.harness, reB.origin], [runId, 'claude', 2])
  const b = agentsOf(join(r.stateDir, 'journal.jsonl')).find((a) => a.title === '[P] b')
  assert.deepEqual([b.name, b.dispatchId, b.state, b.launched, b.workerLeft], [`${runId}-2`, r.b.dispatchId, 'failed', true, true])
  assert.equal(ofType(journal, 'failed').find((e) => e.title === '[P] b').workerLeft, true)
  const before = r.orca.calls.length
  // Forcing past unpushed commits is not stopping it: refused, and told how.
  const refused = await reclaimAgent(b, { orca: r.orca, unpushed: r.orca.unpushedOf, force: true })
  assert.equal(refused.stoppable, true)
  assert.match(refused.reason, /^it failed and was kept with its worker still running, so Orca shows it live: only a reclaim that stops that worker first removes it \(r, then f, in the run view\), or close its tab \S+ in Orca and reclaim it again$/)
  // A worker started for it, but no dispatch named: never proof it is not live.
  assert.match((await reclaimAgent({ ...b, dispatchId: null }, { orca: r.orca, unpushed: r.orca.unpushedOf, force: true, stop: true })).reason, /could not tell whether it is live/)
  assert.deepEqual(r.orca.calls.slice(before).filter((c) => MUTATING.includes(c.verb) || c.verb === 'workerStop'), [])
  // Confirmed: its worker is stopped before anything is removed.
  assert.deepEqual(await reclaimAgent(b, { orca: r.orca, unpushed: r.orca.unpushedOf, stop: true }), { reclaimed: true, notes: [] })
  const done = r.orca.calls.slice(before).filter((c) => MUTATING.includes(c.verb) || c.verb === 'workerStop').map((c) => c.verb)
  assert.equal(done[0], 'workerStop')
  assert.ok(done.includes('workerRelease'), done.join(' '))

  // The same from a journal written before `reattached` carried its Run: the
  // agent is still the worker that line names.
  const path = join(tmp(), 'journal.jsonl')
  writeFileSync(path, [
    { type: 'run', runId: 'run_1', terminal: 'term_a', lastN: 8 },
    { type: 'reattached', key: 'kb', n: 9, title: '[P] b', dispatchId: 'ctx_1', sessionId: SID, terminal: 'term_1', worktree: 'C:/wt/run_1-2', dir: 'agents/002-b' },
    { type: 'failed', key: 'kb', n: 9, title: '[P] b', reason: 'blocked on a human', attempts: 0, run: 'run_1', retained: { path: 'C:/wt/run_1-2', reason: 'kept' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  const [old] = agentsOf(path)
  assert.deepEqual([old.name, old.dispatchId, old.terminal, old.state], ['run_1-2', 'ctx_1', 'term_1', 'failed'])
  const asked = []
  const waiting = { workerShow: async ({ dispatch }) => (asked.push(dispatch), { settled: false, gone: false, exited: false, waiting: 'Which branch?' }) }
  assert.deepEqual(await reclaimAgent(old, { orca: waiting, unpushed: async () => 0 }), { reclaimed: false, reason: 'it is still live' })
  // Its failed line never said its worker was left running: no stop is offered.
  assert.deepEqual(await reclaimAgent(old, { orca: waiting, unpushed: async () => 0, stop: true }), { reclaimed: false, reason: 'it is still live' })
  assert.deepEqual(asked, ['ctx_1', 'ctx_1'])
})

test('resume: every agent of the Run is named across resumes, once each in the run view and to a standalone r, under its worktree\'s name', async () => {
  const registry = registryIn()
  const r = await leftOut({ registry })
  const a = startedAs(r.orca, '[P] a')
  // A resume that dies once it has taken b up: its journal holds b both as
  // carried forward (outstanding) and as taken up (reattached).
  await r.resume('term_2', mortalOn(r.clock, true))
  const runId = ofType(journalOf(r.stateDir), 'run')[0].runId
  const view = runView({ stateDir: r.stateDir, orca: r.orca, clock: r.clock, transcripts: { usage: () => null }, registry, alive: () => false })
  await view.refresh()
  assert.deepEqual(view.model.phases.flatMap((p) => p.agents).map((x) => [x.title, x.state, x.dispatchId]), [['[P] a', 'done', a.dispatchId], ['[P] b', 'running', r.b.dispatchId]])
  assert.equal(view.model.header.runId, runId)
  assert.equal(view.model.header.counts.queued, 0)

  r.clock.at(r.clock.now() + 2 * MIN, r.submitB)
  const result = await r.resume('term_3')
  assert.deepEqual(result, { a: GOOD, b: GOOD })
  assertEntries(journalOf(r.stateDir))
  const names = [`${runId}-1`, `${runId}-2`]
  // a, replayed twice, is still the agent the fresh run started; b the worker two resumes took up.
  assert.deepEqual(agentsOf(join(r.stateDir, 'journal.jsonl')).map((x) => [x.title, x.name, x.dispatchId, x.state]), [['[P] a', names[0], a.dispatchId, 'ok'], ['[P] b', names[1], r.b.dispatchId, 'ok']])

  const runs = runsView({ orca: r.orca, clock: r.clock, registry, transcripts: { usage: () => null }, unpushed: r.orca.unpushedOf })
  await runs.refresh()
  const run = () => runs.model.projects.flatMap((p) => p.runs).find((x) => x.runId === runId)
  assert.equal(run().kept, 2)
  const reclaimed = await runs.reclaim(runId)
  assert.deepEqual(reclaimed.reclaimed.map((x) => x.name), names)
  const entry = readRegistry(registry).find((x) => x.runId === runId)
  assert.deepEqual(entry.reclaimedAgents.map((x) => x.agent), names)
  assert.equal(entry.reclaimed, true)
  assert.equal(run().kept, 0)
})

test('fake orca: a Run takes worker-starts only from the terminal it is bound to, and run-use rebinds it', async () => {
  const orca = fakeOrca({ coordinator: 'term_a' })
  const { runId } = await orca.runCreate({ objective: 'o' })
  const b = orca.as('term_b')
  const start = (o) => o.workerStart({ run: runId, prompt: 'p', title: 't', sessionId: SID })
  await assert.rejects(start(b), /consumer_fenced/)
  await assert.rejects(b.runUse({ runId: 'run_nope' }), /run_not_found/)
  assert.deepEqual(await b.runUse({ runId }), { runId, terminal: 'term_b' })
  assert.equal(orca.runs.get(runId).generation, 2)
  await start(b)
  await assert.rejects(start(orca), /consumer_fenced/)
})

test('orca-cli: run-use takes the Run over from this terminal and reports the terminal it is now bound to', async () => {
  const { orca, argvs } = recordingCli({ 'orchestration run-use': { run: { id: 'run_1', coordinator_handle: 'term_new', consumer_generation: 2 } } })
  assert.deepEqual(await orca.runUse({ runId: 'run_1' }), { runId: 'run_1', terminal: 'term_new' })
  assert.deepEqual(argvs, [['orchestration', 'run-use', '--id', 'run_1']])
})

test('orca-cli: a worker taken up from an earlier runner is shown as Orca sees it, by worker-show, and a release leaves its tab to reclaim', async () => {
  const { orca, argvs } = recordingCli({ 'orchestration worker-show': { worker: { agentTerminalHandle: 'term_w', stage: 'running' }, terminal: { orphaned: false }, observation: { status: 'live' } } })
  const s = await orca.workerShow({ dispatch: 'ctx_9' })
  assert.deepEqual([s.settled, s.gone, s.exited, s.terminal], [false, false, false, 'term_w'])
  await orca.workerRelease({ dispatch: 'ctx_9' })
  assert.deepEqual(argvs.slice(-1), [['orchestration', 'worker-release', '--dispatch', 'ctx_9']])
})

// --- the run view: its model and what each key does --------------------------

const VIEW_SID = { claude: 'c1a0de00-0000-4000-8000-000000000001', pi: '01a01ad8-220c-76a3-8c00-2ed3657f9e05' }
const fixture = (name) => fileURLToPath(new URL(`./fixtures/run-view/${name}`, import.meta.url))
const wt = (n) => `C:/fake/worktrees/run_fake1-${n}`

// A home holding the Claude fixture as the transcript of a session run in
// worktree `claude`, and the pi fixture as one run in worktree `pi`.
function transcriptHome({ claude, pi }) {
  const home = tmp()
  const dirC = join(home, '.claude', 'projects', claudeSlug(claude))
  const dirP = join(home, '.pi', 'agent', 'sessions', piDir(pi))
  mkdirSync(dirC, { recursive: true })
  mkdirSync(dirP, { recursive: true })
  const paths = { claude: join(dirC, `${VIEW_SID.claude}.jsonl`), pi: join(dirP, `2026-08-19T16-26-07-244Z_${VIEW_SID.pi}.jsonl`) }
  copyFileSync(fixture('claude-transcript.jsonl'), paths.claude)
  copyFileSync(fixture('pi-transcript.jsonl'), paths.pi)
  return { home, paths }
}

test('transcripts: context is the last main-chain turn, each message counted once and sidechains skipped; tokens add up every message once', () => {
  const { home, paths } = transcriptHome({ claude: wt(1), pi: wt(2) })
  const t = sessionTranscripts({ home, env: {} })
  // msg_A on 2 lines and msg_B on 3; the sidechain turns msg_S and msg_S2,
  // the last one written, leave the context alone but spent their tokens.
  assert.deepEqual(t.usage({ harness: 'claude', sessionId: VIEW_SID.claude, worktree: wt(1) }), { path: paths.claude, context: 5 + 150000 + 60000, tokens: 1530 + 900100 + 210045 + 400001 })
  assert.deepEqual(t.usage({ harness: 'pi', sessionId: VIEW_SID.pi, worktree: wt(2) }), { path: paths.pi, context: 2000 + 360000 + 1000, tokens: 361050 + 363100 })
  assert.equal(t.usage({ harness: 'claude', sessionId: SID, worktree: wt(1) }), null, 'no transcript, no usage')

  // Read on from where it stopped: a torn line waits for its end, and a
  // message repeated later is still counted once.
  const line = JSON.stringify({ isSidechain: false, type: 'assistant', message: { id: 'msg_C', role: 'assistant', usage: { input_tokens: 1, cache_read_input_tokens: 99, cache_creation_input_tokens: 0, output_tokens: 10 } } }) + '\n'
  appendFileSync(paths.claude, line.slice(0, 40))
  assert.equal(t.usage({ harness: 'claude', sessionId: VIEW_SID.claude, worktree: wt(1) }).context, 210005)
  appendFileSync(paths.claude, line.slice(40) + line)
  assert.deepEqual(t.usage({ harness: 'claude', sessionId: VIEW_SID.claude, worktree: wt(1) }), { path: paths.claude, context: 100, tokens: 1511676 + 110 })
})

test('transcripts: context bands are green below 200k, yellow from 200k to 350k, red above', () => {
  assert.deepEqual([null, 0, 199_999, 200_000, 350_000, 350_001].map(bandOf), [null, 'green', 'green', 'yellow', 'yellow', 'red'])
})

const at = (min) => isoAt(min * MIN)
const J = (type, n, title, min, more = {}) => ({ type, at: at(min), key: `k${n}`, n, title, ...more })
const startedJ = (n, title, min, harness, sessionId) =>
  J('started', n, title, min, { run: 'run_fake1', dispatchId: `ctx_fake${n}`, harness, sessionId, worktree: wt(n), terminal: `term_fake${n}` })

// Every check on a run's tree runs twice: on the tree attached mode shows in
// the runner's tab, and on the one Enter opens from standalone mode's list.
const viewTest = (name, fn) => {
  for (const mode of ['attached', 'standalone']) test(`${name} [${mode}]`, () => fn(mode))
}
// The runs list a standalone tree was opened from: its keys and clicks reach
// the tree through it, as view.mjs hands them over.
const listOf = new WeakMap()
const pressOn = (view) => (name) => (listOf.get(view) ?? view).key(name)
const clickOn = (view) => (i) => (listOf.get(view) ?? view).click(i)
async function treeIn(mode, { stateDir, ...rest }) {
  if (mode === 'attached') {
    const view = runView({ stateDir, ...rest })
    await view.refresh()
    return view
  }
  const runs = runsView(rest)
  await runs.refresh()
  const target = runs.model.rows.findIndex((r) => r.kind === 'run' && r.run.runDir === stateDir)
  while (runs.model.selected < target) await runs.key('DOWN')
  const r = await runs.key('ENTER')
  assert.deepEqual(r, { opened: runs.model.rows[target].run.runId })
  listOf.set(runs.opened(), runs)
  return runs.opened()
}

// A run half way through, as its journal tells it, over a fake Orca that
// holds a tab for each of the five workers it started (all still live) and
// the one a continuation opened, with the Claude and pi fixtures as the
// transcripts of agents 1 and 2, and the runner alive. At 30 minutes:
//   Discover   1 done
//   Implement  2 running (pi), 3 stuck, 4 continued twice, 5 queued, 6 failed before it started
//   Gate       7 done, replayed from an earlier run's journal
async function viewedRun(mode = 'attached') {
  const clock = fakeClock()
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock })
  for (let n = 1; n <= 5; n++) await orca.workerStart({ run: 'run_fake1', prompt: 'p', title: `t${n}`, sessionId: SID, child: { name: `run_fake1-${n}`, displayName: `t${n}` } })
  const stateDir = tmp()
  const journal = [
    J('result', 7, '[Gate] gate:a', 0, { result: GOOD, replayed: true }),
    startedJ(1, '[Discover] discover', 0, 'claude', VIEW_SID.claude),
    startedJ(2, '[Implement] impl:a', 1, 'pi', VIEW_SID.pi),
    startedJ(3, '[Implement] impl:b', 2, 'claude', 'sid-3'),
    startedJ(4, '[Implement] impl:c', 3, 'claude', 'sid-4'),
    J('retry', 6, '[Implement] impl:e', 4, { attempt: 2, reason: 'its worker did not start: orca worktree create: call_timeout' }),
    J('queued', 5, '[Implement] impl:d', 5),
    J('result', 1, '[Discover] discover', 10, { result: GOOD }),
    J('failed', 6, '[Implement] impl:e', 12, { reason: 'its worker did not start: orca worktree create: call_timeout', attempts: 4, run: 'run_fake1', retained: { path: wt(6), reason: 'not in the ledger' } }),
    J('continued', 4, '[Implement] impl:c', 13, { dispatchId: 'ctx_fake4', sessionId: 'sid-4', terminal: 'term_fake4', reason: 'it exited', attempt: 1, reopened: false }),
    J('nudge', 4, '[Implement] impl:c', 20, { dispatchId: 'ctx_fake4', reason: 'it went idle without submitting (nudge 1 of 3)', attempt: 1 }),
    J('nudge', 3, '[Implement] impl:b', 22, { dispatchId: 'ctx_fake3', reason: 'no movement in its transcript or terminal for 20 minutes', attempt: 1 }),
    J('continued', 4, '[Implement] impl:c', 25, { dispatchId: 'ctx_fake5', sessionId: 'sid-4', terminal: 'term_fake5', reason: 'its terminal is gone', attempt: 2, reopened: true }),
  ]
  writeFileSync(join(stateDir, 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  writeFileSync(join(stateDir, 'runner.log'), `${at(0)} == Discover\n`)
  const registry = registryIn()
  runRegistry(registry, { now: () => 0 }).armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783' })
  const { home } = transcriptHome({ claude: wt(1), pi: wt(2) })
  clock.t = 30 * MIN
  const view = await treeIn(mode, { stateDir, orca, clock, transcripts: sessionTranscripts({ home, env: {} }), registry, unpushed: orca.unpushedOf })
  const agent = (n) => view.model.phases.flatMap((p) => p.agents).find((a) => a.n === n)
  const rowOf = (key) => view.model.rows.findIndex((r) => r.key === key)
  const since = orca.calls.length
  return { orca, clock, stateDir, registry, view, agent, rowOf, after: () => orca.calls.slice(since) }
}

viewTest('run view: the journal gives each agent its row, its state and its phase, phases in the order the run reached them', async (mode) => {
  const { view, agent } = await viewedRun(mode)
  const m = view.model
  assert.deepEqual(m.header, { name: 'implement-spec-783', project: 'controlayer', runId: 'run_fake1', spec: '#783', alive: true, ended: false, elapsedMs: 30 * MIN, counts: { blocked: 0, starting: 0, running: 1, continued: 1, stuck: 1, failed: 1, queued: 1, done: 2, reclaimed: 0 } })
  assert.deepEqual(m.phases.map((p) => [p.name, p.agents.map((a) => a.n)]), [['Discover', [1]], ['Implement', [2, 3, 4, 5, 6]], ['Gate', [7]]])
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [agent(n).label, agent(n).state]), [
    ['discover', 'done'], ['impl:a', 'running'], ['impl:b', 'stuck'], ['impl:c', 'continued'], ['impl:d', 'queued'], ['impl:e', 'failed'], ['gate:a', 'done'],
  ])
  assert.equal(agent(3).reason, 'no movement in its transcript or terminal for 20 minutes')
  assert.equal(agent(4).continuations, 2)
  assert.equal(agent(4).terminal, 'term_fake5', 'a continuation that reopened runs in its new tab')
  assert.equal(agent(4).reason, null, 'a continuation clears the nudge before it')
  assert.deepEqual([agent(6).reason, agent(6).worktree, agent(6).terminal, agent(6).tabOpen], ['its worker did not start: orca worktree create: call_timeout', wt(6), null, null])
  assert.equal(agent(7).replayed, true)
  assert.deepEqual([agent(2).harness, agent(2).sessionId, agent(2).worktree, agent(2).dispatchId], ['pi', VIEW_SID.pi, wt(2), 'ctx_fake2'])
  // A phase whose every agent is done starts folded: its agents have no rows.
  assert.deepEqual(m.rows.map((r) => r.key), ['phase:Discover', 'phase:Implement', 'agent:2', 'agent:3', 'agent:4', 'agent:5', 'agent:6', 'phase:Gate'])
  assert.equal(m.selected, 0)
  assert.equal(m.pane.kind, 'phase')
})

viewTest('run view: a folded phase sums its agents up: done of total, its mix of states and its peak context', async (mode) => {
  const { view } = await viewedRun(mode)
  const [discover, implement, gate] = view.model.phases
  assert.deepEqual([discover.folded, discover.done, discover.total, discover.peakContext], [true, 1, 1, 210005])
  assert.deepEqual(discover.mix, { blocked: 0, starting: 0, running: 0, continued: 0, stuck: 0, failed: 0, queued: 0, done: 1, reclaimed: 0 })
  assert.deepEqual([implement.folded, implement.done, implement.total, implement.peakContext], [false, 0, 5, 363000])
  assert.deepEqual(implement.mix, { blocked: 0, starting: 0, running: 1, continued: 1, stuck: 1, failed: 1, queued: 1, done: 0, reclaimed: 0 })
  assert.deepEqual([gate.folded, gate.done, gate.total, gate.peakContext], [true, 1, 1, null], 'a replayed agent ran no session here')
  // A selected phase's pane names its failed and stuck agents, each with its reason.
  await view.key('DOWN')
  assert.deepEqual(view.model.pane.problems.map((p) => [p.agent.n, p.reason]), [
    [3, 'no movement in its transcript or terminal for 20 minutes'],
    [6, 'its worker did not start: orca worktree create: call_timeout'],
  ])
})

// An agent blocked on a human, one starting, one whose start is being
// retried, one answered in time, and one reclaimed, as the journal and the
// registry tell them.
viewTest('run view: blocked, starting and reclaimed are row states; a blocked agent is counted, listed first in its phase and held on the flash line until answered', async (mode) => {
  const clock = fakeClock()
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock })
  for (let n = 1; n <= 5; n++) await orca.workerStart({ run: 'run_fake1', prompt: 'p', title: `t${n}`, sessionId: SID, child: { name: `run_fake1-${n}`, displayName: `t${n}` } })
  const stateDir = tmp()
  const journalPath = join(stateDir, 'journal.jsonl')
  const put = (...entries) => appendFileSync(journalPath, entries.map((e) => JSON.stringify(e) + '\n').join(''))
  put(
    { type: 'run', at: at(0), runId: 'run_fake1', terminal: 'term_runner' },
    startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'),
    J('starting', 2, '[Implement] impl:b', 1, { run: 'run_fake1' }),
    J('starting', 3, '[Implement] impl:c', 1, { run: 'run_fake1' }),
    J('retry', 3, '[Implement] impl:c', 2, { attempt: 2, reason: 'its worker did not start: orca terminal create: runtime_unavailable', nextAt: at(2.5) }),
    startedJ(4, '[Implement] impl:d', 1, 'claude', 'sid-4'),
    J('blocked', 4, '[Implement] impl:d', 3, { dispatchId: 'ctx_fake4', terminal: 'term_fake4', waiting: 'Allow this command?' }),
    J('unblocked', 4, '[Implement] impl:d', 4, { dispatchId: 'ctx_fake4' }),
    startedJ(5, '[Implement] impl:e', 1, 'claude', 'sid-5'),
    J('result', 5, '[Implement] impl:e', 5, { result: GOOD }),
    J('failed', 6, '[Implement] impl:f', 6, { reason: 'its worker did not start: x', attempts: 4, run: 'run_fake1' }),
    J('blocked', 1, '[Implement] impl:a', 6, { dispatchId: 'ctx_fake1', terminal: 'term_fake1', waiting: 'Which branch?' }),
  )
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  writeFileSync(join(stateDir, 'runner.log'), `${at(6)} >> [Implement] impl:e: result received\n`)
  const registry = registryIn()
  const writer = runRegistry(registry, { now: () => 0 })
  writer.armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783' })
  writer.reclaimed({ runId: 'run_fake1', agent: 'run_fake1-5' })
  clock.t = 7 * MIN
  const view = await treeIn(mode, { stateDir, orca, clock, transcripts: sessionTranscripts({ home: tmp(), env: {} }), registry, unpushed: orca.unpushedOf })
  const agent = (n) => view.model.phases.flatMap((p) => p.agents).find((a) => a.n === n)
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => agent(n).state), ['blocked', 'starting', 'starting', 'running', 'reclaimed', 'failed'])
  assert.deepEqual([agent(1).waiting, agent(1).reason], ['Which branch?', 'blocked on a human: Which branch?'])
  assert.deepEqual([agent(3).reason, agent(3).nextAt], ['its worker did not start: orca terminal create: runtime_unavailable', at(2.5)])
  assert.deepEqual([agent(4).waiting, agent(4).reason], [null, null], 'answered: no longer blocked')
  assert.equal(agent(5).reclaimed, true)
  assert.deepEqual(view.model.header.counts, { blocked: 1, starting: 2, running: 1, continued: 0, stuck: 0, failed: 1, queued: 0, done: 0, reclaimed: 1 })
  const [implement] = view.model.phases
  assert.equal(implement.folded, false)
  assert.equal(view.model.pane.kind, 'phase')
  assert.deepEqual(view.model.pane.problems.map((p) => [p.agent.n, p.reason]), [[1, 'blocked on a human: Which branch?'], [6, 'its worker did not start: x']])
  assert.equal(view.model.alert, 'BLOCKED ON A HUMAN: [Implement] impl:a in tab term_fake1 waits on Which branch?')

  // Drawn: its glyph and word, counted in the header, and on the flash line
  // over the log's latest event.
  const lines = draw(view.model, { width: 140, height: 30, flash: null, alert: view.model.alert }).lines.map(strip)
  assert.match(lines[1], /^ ! 1 blocked {2}◌ 2 starting {2}● 1 running {2}✓? ?.*✗ 1 failed {2}○ 1 reclaimed/)
  assert.match(lines.at(-2), /BLOCKED ON A HUMAN: \[Implement\] impl:a in tab term_fake1 waits on Which branch\?/)
  assert.match(lines[4], /!1 ◌2 ●1 ✗1 ○1/)
  const rows = draw(view.model, { width: 140, height: 30 }).lines.map(strip)
  assert.ok(rows.some((l) => /^ +1 +impl:a +! blocked /.test(l)), rows.join('\n'))
  assert.ok(rows.some((l) => /^ +2 +impl:b +◌ starting /.test(l)), rows.join('\n'))
  assert.ok(rows.some((l) => /^ +5 +impl:e +○ reclaimed /.test(l)), rows.join('\n'))

  // Answered: the alert goes, and the log's latest event is back.
  put(J('unblocked', 1, '[Implement] impl:a', 7, { dispatchId: 'ctx_fake1' }))
  await view.refresh()
  assert.deepEqual([agent(1).state, view.model.alert, view.model.latest], ['running', null, '>> [Implement] impl:e: result received'])
})

// A patient in its second doctor round, as the runner journals it: the
// doctors' n come after an agent started meanwhile, and their own lines have
// no call key.
viewTest('run view: a doctor\'s row is indented under its patient\'s, in round order, whatever its number', async (mode) => {
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock: fakeClock() })
  const stateDir = tmp()
  const doctorJ = (type, n, min, more = {}) => ({ ...J(type, n, '[Implement] recover -> impl:a', min, more), key: null })
  const doctorStarted = (n, min) => ({ ...startedJ(n, '[Implement] recover -> impl:a', min, 'claude', `sid-${n}`), key: null })
  const reason = 'its session died past its continuation cap, with no result'
  const journal = [
    { type: 'run', at: at(0), runId: 'run_fake1', terminal: 'term_runner' },
    startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'),
    startedJ(2, '[Implement] impl:b', 1, 'claude', 'sid-2'),
    J('doctor', 1, '[Implement] impl:a', 2, { origin: 1, round: 1, reason, doctor: 3 }),
    doctorJ('starting', 3, 2, { run: 'run_fake1' }),
    doctorStarted(3, 2),
    J('queued', 5, '[Implement] impl:c', 3),
    doctorJ('settled', 3, 4, { dispatchId: 'ctx_fake3', outcome: 'failed' }),
    J('gaveUp', 1, '[Implement] impl:a', 4, { origin: 1, round: 1, doctor: 3, reason: 'its worker settled failed with no remedy' }),
    J('doctor', 1, '[Implement] impl:a', 4, { origin: 1, round: 2, reason, doctor: 4 }),
    doctorJ('starting', 4, 4, { run: 'run_fake1' }),
    doctorStarted(4, 5),
  ]
  writeFileSync(join(stateDir, 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  writeFileSync(join(stateDir, 'runner.log'), `${at(5)} >> [Implement] impl:a: doctor round 2 of 3\n`)
  const registry = registryIn()
  runRegistry(registry, { now: () => 0 }).armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783' })
  const view = await treeIn(mode, { stateDir, orca, clock: fakeClock(), transcripts: sessionTranscripts({ home: tmp(), env: {} }), registry, unpushed: orca.unpushedOf })
  assert.deepEqual(view.model.rows.map((r) => [r.key, r.depth ?? null]), [
    ['phase:Implement', null], ['agent:1', 0], ['agent:3', 1], ['agent:4', 1], ['agent:2', 0], ['agent:5', 0],
  ])
  const row = (n) => view.model.rows.find((r) => r.key === `agent:${n}`).agent
  assert.deepEqual([row(3).patient, row(4).patient, row(1).doctors, row(1).round], [1, 1, [3, 4], 2])
  assert.deepEqual([row(3).state, row(4).state], ['done', 'running'])

  const lines = () => draw(view.model, { width: 140, height: 30 }).lines.map(strip)
  assert.match(lines()[5], /^ +1 +impl:a +● running /)
  assert.match(lines()[6], /^ +3 +└ recover +✓ done /, 'under its patient, named by its role')
  assert.match(lines()[7], /^ +4 +└ recover +● running /)
  assert.match(lines()[8], /^ +2 +impl:b /)
  // Selected, its pane has its whole title.
  while (view.model.rows[view.model.selected].key !== 'agent:4') await view.key('DOWN')
  assert.match(lines().at(-6), /\[Implement\] recover -> impl:a {2}● running/)
})

viewTest('run view: context size, its band and tokens come from each agent\'s Claude or pi transcript', async (mode) => {
  const { view, agent } = await viewedRun(mode)
  assert.deepEqual([agent(1).context, agent(1).band, agent(1).tokens], [210005, 'yellow', 1511676])
  assert.deepEqual([agent(2).context, agent(2).band, agent(2).tokens], [363000, 'red', 724150])
  assert.match(agent(1).transcript, new RegExp(`${VIEW_SID.claude}\\.jsonl$`))
  assert.match(agent(2).transcript, new RegExp(`_${VIEW_SID.pi}\\.jsonl$`))
  for (const n of [3, 5, 6, 7]) assert.deepEqual([agent(n).context, agent(n).band, agent(n).tokens, agent(n).transcript], [null, null, null, null], `agent ${n}`)
  // The selected agent's pane is the agent itself.
  await view.click(3)
  assert.equal(view.model.pane.kind, 'agent')
  assert.equal(view.model.pane.agent.n, 3)
})

viewTest('run view: elapsed time runs on the clock for a live agent and the run, and stops at settlement', async (mode) => {
  const { view, agent, clock, stateDir } = await viewedRun(mode)
  assert.deepEqual([1, 2, 3, 5, 6, 7].map((n) => agent(n).elapsedMs), [10 * MIN, 29 * MIN, 28 * MIN, null, 8 * MIN, null])
  clock.t += 5 * MIN
  await view.refresh()
  assert.deepEqual([1, 2, 3, 6].map((n) => agent(n).elapsedMs), [10 * MIN, 34 * MIN, 33 * MIN, 8 * MIN])
  assert.equal(view.model.header.elapsedMs, 35 * MIN)
  // A runner that is gone: the run's time stops at its last journal entry.
  rmSync(join(stateDir, 'runner.pid'))
  await view.refresh()
  assert.deepEqual([view.model.header.alive, view.model.header.elapsedMs], [false, 25 * MIN])
})

viewTest('run view: a tab is open or closed as Orca\'s terminal list says, whatever its worker\'s state', async (mode) => {
  const { view, agent, orca } = await viewedRun(mode)
  assert.deepEqual([1, 2, 3, 4].map((n) => agent(n).tabOpen), [true, true, true, true], "a done agent's tab stays open")
  await orca.terminalClose({ terminal: 'term_fake2' })
  await view.refresh()
  const d = orca.dispatches.get('ctx_fake2')
  assert.deepEqual([d.settled, d.terminalState], [false, 'retained'], 'Orca still calls its worker live and its terminal retained')
  assert.equal(agent(2).state, 'running')
  assert.equal(agent(2).tabOpen, false)
  assert.equal(agent(1).tabOpen, true)
})

viewTest('run view: Enter or a click on an agent switches to its tab; a closed tab says why it could not', async (mode) => {
  const { view, rowOf, after, orca } = await viewedRun(mode)
  await view.key('DOWN')
  await view.key('DOWN')
  assert.equal(view.model.rows[view.model.selected].key, 'agent:2')
  assert.deepEqual(await view.key('ENTER'), { switched: 'term_fake2' })
  assert.deepEqual(await view.click(rowOf('agent:4')), { switched: 'term_fake5' })
  assert.equal(view.model.pane.agent.n, 4)
  assert.deepEqual(after().filter((c) => c.verb === 'terminalSwitch').map((c) => c.terminal), ['term_fake2', 'term_fake5'])

  await orca.terminalClose({ terminal: 'term_fake3' })
  const r = await view.click(rowOf('agent:3'))
  assert.match(r.message, /could not focus \[Implement\] impl:b's tab term_fake3: .*terminal_exited/)
  assert.equal(view.model.message, r.message)
  const none = await view.click(rowOf('agent:5'))
  assert.match(none.message, /has no tab/)
  assert.equal(after().filter((c) => c.verb === 'terminalSwitch').length, 2)
})

viewTest('run view: a click, Enter, ← or → on a phase toggles its fold, and switches to no tab', async (mode) => {
  const { view, rowOf, after } = await viewedRun(mode)
  const folded = (name) => view.model.phases.find((p) => p.name === name).folded
  await view.click(rowOf('phase:Implement'))
  assert.equal(folded('Implement'), true)
  assert.deepEqual(view.model.rows.map((r) => r.key), ['phase:Discover', 'phase:Implement', 'phase:Gate'])
  assert.equal(view.model.rows[view.model.selected].key, 'phase:Implement')
  await view.key('ENTER')
  assert.equal(folded('Implement'), false)
  await view.key('LEFT')
  assert.equal(folded('Implement'), true)
  await view.key('RIGHT')
  assert.equal(folded('Implement'), false)
  await view.click(rowOf('phase:Discover'))
  assert.equal(folded('Discover'), false)
  assert.deepEqual(view.model.rows.slice(0, 3).map((r) => r.key), ['phase:Discover', 'agent:1', 'phase:Implement'])
  // The operator's fold outlives a refresh.
  await view.refresh()
  assert.deepEqual([folded('Discover'), folded('Implement')], [false, false])
  assert.equal(view.model.rows[view.model.selected].key, 'phase:Discover')
  assert.deepEqual(after().filter((c) => c.verb === 'terminalSwitch'), [])
})

// --- the reclaim dialog `r` opens ---------------------------------------------

const reclaimedIn = (registry) => linesOf(registry).filter((e) => e.type === 'reclaimed').map((e) => e.agent ?? null)
const mutations = (calls) => calls.filter((c) => MUTATING.includes(c.verb))
const touched = (calls) => mutations(calls).map((c) => [c.verb, c.verb === 'workerRelease' ? c.dispatchId : c.terminal ?? c.path])
// The terminal lines (1-based) its options are drawn on, in option order.
const optionLines = (screen) => screen.lines.map((_, i) => i + 1).filter((y) => screen.optionAt(y) !== null)

viewTest('reclaim dialog: r opens it over the tree, its options in order; Reclaim All is greyed out with its reason while the run is still going, and selectable once it has ended, though its runner lives on', async (mode) => {
  const { view, stateDir, registry, after } = await viewedRun(mode)
  const press = pressOn(view)
  assert.equal(view.model.dialog, null)
  assert.deepEqual(await press('r'), {})
  const d = view.model.dialog
  assert.deepEqual([d.kind, d.title, d.highlight], ['choose', 'Reclaim', 0])
  assert.deepEqual(d.options.map((o) => [o.id, o.label, o.disabled]), [
    ['selected', 'Reclaim Selected', false], ['successful', 'Reclaim Successful Ones', false], ['all', 'Reclaim All', true],
  ])
  assert.equal(d.options[2].reason, 'the run is still going')
  assert.equal(d.options[0].detail, 'every agent of Discover', 'the selected row is the Discover phase')

  const screen = draw(view.model, { width: 140, height: 30 })
  const ys = optionLines(screen)
  assert.deepEqual(ys.map((y) => screen.optionAt(y)), [0, 1, 2])
  const shown = ys.map((y) => strip(screen.lines[y - 1]))
  assert.match(shown[0], /▸ Reclaim Selected — every agent of Discover/)
  assert.match(shown[1], /Reclaim Successful Ones — the 2 done/)
  assert.match(shown[2], /Reclaim All — the run is still going/)
  assert.ok(screen.lines[ys[2] - 1].includes('\x1b[100;90m'), 'greyed out')
  assert.ok(screen.lines.map(strip).some((l) => l.includes('Enter reclaims · Esc closes')))

  // Not selectable: neither the arrows nor the mouse reach it.
  await press('DOWN')
  await press('DOWN')
  assert.equal(view.model.dialog.highlight, 1)
  view.highlight(2)
  assert.equal(view.model.dialog.highlight, 1)

  // The run has ended, its runner still waiting on the view, as runner.mjs's
  // does once the script ends: the dialog, still open, offers it.
  const all = () => [view.model.dialog.options[2].disabled, view.model.dialog.options[2].reason]
  runRegistry(registry, { now: () => 0 }).ended({ runId: 'run_fake1', outcome: 'partial' })
  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify({ runner: 'orca', ok: true, result: {} }))
  await view.refresh()
  assert.equal(view.model.header.alive, true, 'the runner is still live')
  assert.equal(view.model.header.ended, true)
  assert.deepEqual(all(), [false, null])
  await press('DOWN')
  assert.equal(view.model.dialog.highlight, 2)
  assert.match(strip(draw(view.model, { width: 140, height: 30 }).lines[ys[2] - 1]), /▸ Reclaim All — every agent of the run/)

  // A resume after `ended` runs the script again: greyed out again, the
  // highlight moved off it.
  rmSync(join(stateDir, 'summary.json'))
  runRegistry(registry, { now: () => 0 }).runner({ runId: 'run_fake1', terminal: 'term_resume' })
  await view.refresh()
  assert.deepEqual(all(), [true, 'the run is still going'])
  assert.equal(view.model.dialog.highlight, 0)

  // summary.json alone, a live runner having written it, says the run ended:
  // the runner removes a stale one before it writes its runner.pid.
  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify({ runner: 'orca', ok: false, error: 'x' }))
  await view.refresh()
  assert.deepEqual(all(), [false, null])

  // A runner gone, summary.json or not: nothing runs the script.
  rmSync(join(stateDir, 'summary.json'))
  rmSync(join(stateDir, 'runner.pid'))
  await view.refresh()
  assert.deepEqual(all(), [false, null])
  assert.deepEqual(mutations(after()), [])
})

test('run ended: by the registry\'s `ended` with no resume after, a gone runner, or a live runner\'s summary.json; never by whether the runner lives; null when it cannot be told', () => {
  const dir = tmp()
  const running = { state: 'running' }
  assert.equal(runEnded({ run: running, alive: true, stateDir: dir }), false, 'a live runner with no summary.json runs the script')
  assert.equal(runEnded({ run: null, alive: true, stateDir: dir }), false)
  assert.equal(runEnded({ run: { state: 'ok' }, alive: true, stateDir: dir }), true, 'ended, its runner waiting on the view')
  assert.equal(runEnded({ run: { state: 'failed' }, alive: null, stateDir: dir }), true)
  assert.equal(runEnded({ run: running, alive: false, stateDir: dir }), true)
  assert.equal(runEnded({ run: running, alive: null, stateDir: dir }), null, 'no `ended` and no telling whether a runner lives')
  assert.equal(runEnded({ run: null, alive: null, stateDir: dir }), null)
  writeFileSync(join(dir, 'summary.json'), '{}')
  assert.equal(runEnded({ run: running, alive: true, stateDir: dir }), true)
  assert.equal(runEnded({ run: running, alive: null, stateDir: dir }), null, 'a summary.json no live runner vouches for may be an earlier run\'s')
})

// view.mjs hands both a hover and a click on an option to view.highlight.
viewTest('reclaim dialog: the arrows, a hover and a click move the highlight; only Enter accepts, and Esc closes it having reclaimed nothing', async (mode) => {
  const { view, after, registry } = await viewedRun(mode)
  const press = pressOn(view)
  await press('r')
  await press('DOWN')
  assert.equal(view.model.dialog.highlight, 1)
  await press('UP')
  await press('UP')
  assert.equal(view.model.dialog.highlight, 0, 'the arrows stop at the first option')
  const ys = optionLines(draw(view.model, { width: 140, height: 30 }))
  view.highlight(draw(view.model, { width: 140, height: 30 }).optionAt(ys[1]))
  assert.equal(view.model.dialog.highlight, 1)
  const screen = draw(view.model, { width: 140, height: 30 })
  assert.ok(screen.lines[ys[1] - 1].includes('\x1b[7m'), 'the highlighted option is inverted')
  assert.match(strip(screen.lines[ys[1] - 1]), /▸ Reclaim Successful Ones/)
  view.highlight(0)
  assert.equal(view.model.dialog.highlight, 0)
  assert.equal(view.model.dialog.kind, 'choose', 'a move accepts nothing')

  assert.deepEqual(await press('ESCAPE'), { message: 'nothing reclaimed' })
  assert.equal(view.model.dialog, null)
  assert.equal(view.model.message, 'nothing reclaimed')
  assert.deepEqual(mutations(after()), [])
  assert.deepEqual(reclaimedIn(registry), [])
  if (mode === 'standalone') assert.notEqual(listOf.get(view).opened(), null, 'Esc closed the dialog, not the run')
})

viewTest('reclaim dialog: while it is open, keys and clicks on the tree do nothing; the tree keeps refreshing behind it', async (mode) => {
  const { view, rowOf, after, orca } = await viewedRun(mode)
  const press = pressOn(view)
  const click = clickOn(view)
  await press('DOWN')
  await press('DOWN')
  const selected = view.model.rows[view.model.selected].key
  assert.equal(selected, 'agent:2')
  await press('r')
  const calls = after().length
  for (const k of ['LEFT', 'RIGHT', 'l', 'q', 'r', 'R', 'x']) assert.deepEqual(await press(k), {}, k)
  assert.deepEqual(await click(rowOf('phase:Implement')), {})
  assert.deepEqual(await click(rowOf('agent:4')), {})
  assert.equal(view.model.rows[view.model.selected].key, selected)
  assert.equal(view.model.phases.find((p) => p.name === 'Implement').folded, false)
  assert.equal(after().length, calls, 'no tab switched, no log opened')
  const screen = draw(view.model, { width: 140, height: 30 })
  assert.deepEqual(screen.lines.map((_, i) => screen.rowAt(i + 1)).filter((i) => i !== null), [], 'no row takes a click')
  if (mode === 'standalone') assert.notEqual(listOf.get(view).opened(), null, 'q did not close the run')

  await orca.terminalClose({ terminal: 'term_fake2' })
  await view.refresh()
  assert.equal(view.model.phases.flatMap((p) => p.agents).find((a) => a.n === 2).tabOpen, false)
  assert.equal(view.model.dialog.kind, 'choose')
})

viewTest('reclaim dialog: Enter reclaims per the option, by the reclaim rules: Selected the agent under the cursor, Successful Ones the done agents, All every agent once the run has ended', async (mode) => {
  // Reclaim Selected on an agent row: that agent only.
  let run = await viewedRun(mode)
  let press = pressOn(run.view)
  run.orca.dispatches.get('ctx_fake1').settled = true
  await run.view.click(run.rowOf('phase:Discover'))
  await run.view.key('DOWN')
  assert.equal(run.view.model.rows[run.view.model.selected].key, 'agent:1')
  await press('r')
  assert.equal(run.view.model.dialog.options[0].detail, '[Discover] discover')
  const one = await press('ENTER')
  assert.deepEqual([one.option, one.reclaim, one.agent], ['selected', { reclaimed: true, notes: [] }, { n: 1, title: '[Discover] discover' }])
  assert.equal(run.view.model.dialog, null)
  assert.deepEqual(touched(run.after()), [['workerRelease', 'ctx_fake1'], ['terminalClose', 'term_fake1'], ['worktreeRemove', wt(1)]])
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-1'])

  // Reclaim Successful Ones: the done agents, a live one never touched.
  run = await viewedRun(mode)
  press = pressOn(run.view)
  run.orca.dispatches.get('ctx_fake1').settled = true
  await press('r')
  await press('DOWN')
  const done = await press('ENTER')
  assert.equal(done.option, 'successful')
  assert.deepEqual(done.reclaimed, [{ n: 1, title: '[Discover] discover' }])
  assert.deepEqual(done.kept, [])
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-1'])
  assert.deepEqual(touched(run.after()), [['workerRelease', 'ctx_fake1'], ['terminalClose', 'term_fake1'], ['worktreeRemove', wt(1)]])

  // Reclaim All once the run has ended, its runner still waiting on the view:
  // every agent, the live ones refused.
  run = await viewedRun(mode)
  press = pressOn(run.view)
  run.orca.dispatches.get('ctx_fake1').settled = true
  run.orca.dispatches.get('ctx_fake3').settled = true
  runRegistry(run.registry, { now: () => 0 }).ended({ runId: 'run_fake1', outcome: 'partial' })
  await run.view.refresh()
  await press('r')
  await press('DOWN')
  await press('DOWN')
  const all = await press('ENTER')
  assert.equal(all.option, 'all')
  assert.deepEqual(all.reclaimed.map((a) => a.n), [1, 3, 6])
  assert.deepEqual(all.kept.map((k) => [k.agent.n, k.reason]), [[2, 'it is still live'], [4, 'it is still live']])
  assert.match(run.view.model.message, /^reclaimed 3 of \d+ agents of the run; kept \[Implement\] impl:a: it is still live; kept \[Implement\] impl:c: it is still live$/)
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-1', 'run_fake1-3', 'run_fake1-6'])
  for (const d of ['ctx_fake2', 'ctx_fake5']) assert.equal(run.orca.dispatches.get(d).released, false, d)
})

viewTest('reclaim dialog: Reclaim Selected on a phase row reclaims that phase\'s agents, and no other', async (mode) => {
  const { view, rowOf, orca, registry, after } = await viewedRun(mode)
  const press = pressOn(view)
  for (const n of [1, 2, 3]) orca.dispatches.get(`ctx_fake${n}`).settled = true
  await view.click(rowOf('phase:Implement'))
  await view.click(rowOf('phase:Implement'))
  assert.equal(view.model.rows[view.model.selected].key, 'phase:Implement')
  await press('r')
  assert.equal(view.model.dialog.options[0].detail, 'every agent of Implement')
  const r = await press('ENTER')
  assert.equal(r.option, 'selected')
  // impl:e never started, but Orca made it a worktree: that is removed too.
  assert.deepEqual(r.reclaimed.map((a) => a.n), [2, 3, 6])
  assert.deepEqual(r.kept.map((k) => [k.agent.n, k.reason]), [[4, 'it is still live']])
  assert.deepEqual(reclaimedIn(registry), ['run_fake1-2', 'run_fake1-3', 'run_fake1-6'])
  assert.equal(orca.dispatches.get('ctx_fake1').released, false, "Discover's agent is not the phase's")
  assert.deepEqual(after().filter((c) => c.verb === 'workerRelease').map((c) => c.dispatchId), ['ctx_fake2', 'ctx_fake3'])
})

// Implement: impl:a failed and was kept with its worker running, and its
// worktree holds a commit; impl:b is done, with 3 unpushed commits. Gate:
// gate:a is done, with 5.
async function confirmingRun(mode) {
  const clock = fakeClock()
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock })
  for (let n = 1; n <= 3; n++) await orca.workerStart({ run: 'run_fake1', prompt: 'p', title: `t${n}`, sessionId: SID, child: { name: `run_fake1-${n}`, displayName: `t${n}` } })
  const stateDir = tmp()
  const put = (...entries) => appendFileSync(join(stateDir, 'journal.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  put(
    startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'),
    startedJ(2, '[Implement] impl:b', 1, 'claude', 'sid-2'),
    startedJ(3, '[Gate] gate:a', 2, 'claude', 'sid-3'),
    J('result', 2, '[Implement] impl:b', 8, { result: GOOD }),
    J('result', 3, '[Gate] gate:a', 9, { result: GOOD }),
  )
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  const registry = registryIn()
  runRegistry(registry, { now: () => 0 }).armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783' })
  clock.t = 10 * MIN
  const view = await treeIn(mode, { stateDir, orca, clock, transcripts: { usage: () => null }, registry, unpushed: orca.unpushedOf })
  const rowOf = (key) => view.model.rows.findIndex((r) => r.key === key)
  for (const n of [2, 3]) orca.dispatches.get(`ctx_fake${n}`).settled = true
  orca.worktrees.get(wt(2)).unpushed = 3
  orca.worktrees.get(wt(3)).unpushed = 5
  return { orca, clock, stateDir, registry, view, rowOf, put, press: pressOn(view) }
}

viewTest('reclaim dialog: the choice alone never stops a worker left running nor loses commits: each asks its confirmation after it, one at a time, and f confirms it', async (mode) => {
  const { orca, registry, view, rowOf, put, press } = await confirmingRun(mode)
  put(J('failed', 1, '[Implement] impl:a', 10, { reason: 'it died past the continuation cap', attempts: 1, run: 'run_fake1', workerLeft: true }))
  orca.worktrees.get(wt(1)).unpushed = 1
  await view.refresh()
  await view.click(rowOf('phase:Implement'))
  await view.click(rowOf('phase:Implement'))
  await press('r')
  const r = await press('ENTER')
  assert.deepEqual([r.reclaimed, r.kept.map((k) => k.agent.n)], [[], [1, 2]])
  assert.match(r.message, /^reclaimed 0 of 2 agents of Implement; 2 to confirm$/)
  assert.deepEqual(mutations(orca.calls), [])
  assert.equal(orca.calls.some((c) => c.verb === 'workerStop'), false)

  // impl:a's worker first: drawn over the tree, which takes no click.
  assert.deepEqual(view.model.dialog.kind, 'confirm')
  assert.equal(view.model.dialog.title, 'Reclaim [Implement] impl:a?')
  let screen = draw(view.model, { width: 140, height: 30 })
  let text = screen.lines.map(strip)
  assert.ok(text.some((l) => l.includes('Reclaim [Implement] impl:a?')))
  assert.ok(text.some((l) => l.includes('f = stop its worker, then reclaim it · any other key cancels')))
  assert.deepEqual(screen.lines.map((_, i) => screen.rowAt(i + 1)).filter((i) => i !== null), [])
  assert.deepEqual(await clickOn(view)(rowOf('agent:2')), {})
  // f confirms the stop; its unpushed commit then asks again, for that,
  // before anything is stopped.
  await press('f')
  assert.equal(orca.calls.some((c) => c.verb === 'workerStop'), false)
  assert.equal(view.model.dialog.title, 'Reclaim [Implement] impl:a?')
  assert.ok(draw(view.model, { width: 140, height: 30 }).lines.map(strip).some((l) => l.includes('f = force the reclaim, and those commits are lost')))
  await press('f')
  assert.deepEqual(orca.calls.filter((c) => c.verb === 'workerStop').map((c) => c.dispatchId), ['ctx_fake1'])
  assert.equal(orca.worktrees.get(wt(1)).removed, true)
  // Then impl:b's commits; any other key cancels it, and the dialog closes.
  assert.equal(view.model.dialog.title, 'Reclaim [Implement] impl:b?')
  assert.match((await press('x')).message, /impl:b: reclaim cancelled/)
  assert.equal(view.model.dialog, null)
  assert.equal(orca.worktrees.get(wt(2)).removed, false)
  assert.deepEqual(reclaimedIn(registry), ['run_fake1-1'])
  assert.equal(orca.worktrees.get(wt(3)).removed, false, "gate:a is Gate's")
})

viewTest('reclaim dialog: f forces the reclaim of the agent refused, even once a refresh has folded its phase and moved the selection', async (mode) => {
  const { orca, registry, view, rowOf, put, press } = await confirmingRun(mode)
  await view.click(rowOf('phase:Gate'))
  assert.deepEqual(view.model.rows.map((r) => r.key), ['phase:Implement', 'agent:1', 'agent:2', 'phase:Gate', 'agent:3'])
  await view.click(rowOf('agent:2'))
  await press('r')
  const refused = await press('ENTER')
  assert.deepEqual([refused.reclaim.unpushed, refused.agent], [3, { n: 2, title: '[Implement] impl:b' }])
  assert.equal(view.model.dialog.title, 'Reclaim [Implement] impl:b?')

  // impl:a finishes while the force question is open: Implement folds, and
  // the selection falls on gate:a's row.
  orca.dispatches.get('ctx_fake1').settled = true
  put(J('result', 1, '[Implement] impl:a', 11, { result: GOOD }))
  await view.refresh()
  assert.deepEqual(view.model.rows.map((r) => r.key), ['phase:Implement', 'phase:Gate', 'agent:3'])
  assert.equal(view.model.rows[view.model.selected].key, 'agent:3')

  const since = orca.calls.length
  const forced = await press('f')
  assert.deepEqual([forced.reclaim, forced.agent], [{ reclaimed: true, notes: [] }, { n: 2, title: '[Implement] impl:b' }])
  assert.deepEqual(orca.calls.slice(since).filter((c) => c.verb === 'worktreeRemove').map((c) => c.path), [wt(2)])
  assert.deepEqual([orca.worktrees.get(wt(2)).removed, orca.worktrees.get(wt(3)).removed], [true, false], "gate:a's 5 commits stay")
  assert.equal(orca.dispatches.get('ctx_fake3').released, false)
  assert.deepEqual(reclaimedIn(registry), ['run_fake1-2'])
  assert.match(view.model.message, /reclaimed \[Implement\] impl:b/)
  assert.equal(view.model.dialog, null)
})

viewTest('run view: l follows runner.log in a tab of its own, as Orca\'s editor opens no file outside a worktree; q quits the view only', async (mode) => {
  const { view, stateDir, after, orca } = await viewedRun(mode)
  const log = join(stateDir, 'runner.log')
  // The run dir is outside every worktree, so `file open` can never show it.
  await assert.rejects(orca.fileOpen({ path: log }), (e) => e.code === 'runtime_error' && /invalid_relative_path/.test(e.message))
  assert.match((await view.key('l')).message, /opened .*runner\.log in a tab that follows it/)
  const tails = () => after().filter((c) => c.verb === 'logTail')
  assert.deepEqual(tails().map((c) => [c.path, c.title, c.command]), [[log, 'runner.log', tailCommand(log)]])
  const tab = tails()[0].terminal
  // Again while that tab is open: it comes back to the front, no second tab.
  assert.match((await view.key('l')).message, /switched to the tab following/)
  assert.deepEqual(after().filter((c) => c.verb === 'terminalSwitch').map((c) => c.terminal), [tab])
  assert.equal(tails().length, 1)
  assert.deepEqual(after().filter((c) => MUTATING.includes(c.verb)), [])
  // Closed by the operator: the next l opens a new one.
  await orca.terminalClose({ terminal: tab })
  await view.key('l')
  assert.equal(tails().length, 2)
  assert.notEqual(tails()[1].terminal, tab)
  rmSync(log)
  assert.match((await view.key('l')).message, /could not open .*runner\.log: the runner has not written it yet/)
  assert.equal(tails().length, 2)
  assert.deepEqual(await view.key('q'), { quit: true })
})

test('orca-cli: the view switches to a tab by handle, opens a file by path, and follows a log in a tab of its own', async () => {
  const { argvs, orca } = recordingCli({ 'terminal switch': { focus: { handle: 'term_a', tabId: 't', worktreeId: 'repo::C:/wt', navigated: true } }, 'terminal create': { terminal: { handle: 'term_log' } } }, { platform: 'win32' })
  assert.deepEqual(await orca.terminalSwitch({ terminal: 'term_a' }), { terminal: 'term_a', worktreeId: 'repo::C:/wt' })
  await orca.fileOpen({ path: 'C:/wt/notes.md' })
  // PowerShell, whatever the default shell: the path a single-quoted literal.
  assert.deepEqual(await orca.logTail({ path: "C:\\Users\\o'neil\\.claude\\spec-notes\\s-43\\orca-run\\runner.log", title: 'runner.log' }), { terminal: 'term_log' })
  assert.deepEqual(argvs, [
    ['terminal', 'switch', '--terminal', 'term_a'],
    ['file', 'open', '--path', 'C:/wt/notes.md'],
    ['terminal', 'create', '--worktree', 'current', '--title', 'runner.log', '--shell', 'powershell.exe', '--command', "Get-Content -LiteralPath 'C:\\Users\\o''neil\\.claude\\spec-notes\\s-43\\orca-run\\runner.log' -Encoding UTF8 -Tail 200 -Wait", '--focus'],
  ])
  const posix = recordingCli({}, { platform: 'linux' })
  await posix.orca.logTail({ path: "/home/o'neil/runner.log", title: 'runner.log' })
  assert.deepEqual(posix.argvs, [['terminal', 'create', '--worktree', 'current', '--title', 'runner.log', '--command', "tail -n 200 -F '/home/o'\\''neil/runner.log'", '--focus']])
  assert.throws(() => tailCommand('C:/notes/runner.log\nRemove-Item C:/'), /control character/)
})

// --- the run view in the runner's tab (D5 on #43) -----------------------------

// The run view as the runner spawns it: a fake child per start, stamped with
// the clock's time, recording what it is sent.
function fakeViews(clock) {
  const spawned = []
  const spawn = () => {
    const c = new EventEmitter()
    Object.assign(c, { pid: 1000 + spawned.length, at: clock.now(), sent: [], send: (m) => c.sent.push(m) })
    spawned.push(c)
    return c
  }
  return { spawned, spawn, last: () => spawned.at(-1) }
}
const turns = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}
const logged = (stateDir) => readFileSync(join(stateDir, 'runner.log'), 'utf8').trimEnd().split('\n').map((l) => l.replace(/^\S+ /, ''))

// END with a view attached, wired as the entry point wires it; `onStart(views,
// w)` runs as each worker starts. Unattached, the same run prints to `tab`.
async function attachedRun({ onStart = () => {}, attached = true } = {}) {
  const clock = fakeClock()
  const stateDir = tmp()
  const tab = []
  const guards = []
  const views = fakeViews(clock)
  let say
  const view = attachView({
    spawnView: views.spawn, tab: (s) => tab.push(s), log: (s) => say(s), clock, guard: (on) => guards.push(on),
    tail: () => readFileSync(join(stateDir, 'runner.log'), 'utf8').trimEnd().split('\n').slice(-20),
  })
  const gate = attached ? view.gate : (print) => print
  say = runnerLog(stateDir, gate((s) => tab.push(s)), clock)
  if (attached) view.start()
  const registry = registryIn()
  const orca = fakeOrca({ worker: async (w) => {
    await onStart(views, { ...w, clock })
    await endWorker({ ...w, clock })
  }, clock })
  const result = await runScript(END, { orca, stateDir, out: gate((s) => tab.push(s)), clock, registry, project: 'C:/repo', settings: NO_DOCTOR })
  // As the entry point ends a run: summary.json, then it waits on the view.
  const end = () => finish({ stateDir, summary: { runner: 'orca', ok: true, result }, out: say })
  return { clock, stateDir, tab, guards, views, view, orca, registry, result, end, verbs: () => orca.calls.map((c) => c.verb) }
}

test('run view: with the view attached the runner prints nothing to the tab, and runner.log has every line it would have printed', async () => {
  const plain = await attachedRun({ attached: false })
  const run = await attachedRun()
  assert.equal(run.views.spawned.length, 1)
  assert.deepEqual(run.guards, [true], 'a Ctrl-C reaching the runner is ignored while the view lives')
  assert.deepEqual(run.tab, [])
  assert.ok(plain.tab.length > 3, plain.tab.join('\n'))
  // Session ids are generated afresh for every start.
  const same = (lines) => lines.map((l) => l.replace(new RegExp(UUID.source.slice(1, -1), 'g'), '<sid>'))
  assert.deepEqual(same(logged(run.stateDir)), same(plain.tab.flatMap((s) => s.split('\n'))))
  assert.deepEqual(run.result, plain.result)
})

test('run view: a crash restarts the view on the clock without touching the run; at the third crash the runner prints its log in the tab again', async () => {
  const plain = await attachedRun({ attached: false })
  let crashedAt = null
  const run = await attachedRun({ onStart: async (views, w) => {
    if (!w.prompt.startsWith('Build a.')) return
    crashedAt = w.clock.now()
    views.last().emit('exit', 1, null)
  } })
  assert.deepEqual(run.result, plain.result, 'the run returns what it returns with no view')
  assert.deepEqual(run.verbs(), plain.verbs(), 'and asks Orca for exactly the same')
  await turns()
  assert.equal(run.views.spawned.length, 2)
  assert.ok(run.views.spawned[1].at >= crashedAt + SETTINGS.viewRestartMs, `restarted at ${run.views.spawned[1].at}, crashed at ${crashedAt}`)
  assert.deepEqual(run.tab, [])
  assert.ok(logged(run.stateDir).includes(`!! the run view crashed with exit code 1; restarting it (crash 1 of ${SETTINGS.viewCrashes})`), logged(run.stateDir).join('\n'))

  run.views.last().emit('exit', null, 'SIGKILL')
  await turns()
  assert.equal(run.views.spawned.length, 3, 'a view killed by a signal is a crash too')
  assert.deepEqual(run.tab, [])
  run.views.last().emit('exit', 7, null)
  await turns()
  assert.equal(run.views.spawned.length, 3, 'the third crash is not restarted')
  assert.equal(run.view.crashes(), 3)
  assert.deepEqual(run.guards, [true, false])
  const log = readFileSync(join(run.stateDir, 'runner.log'), 'utf8').trimEnd().split('\n')
  assert.deepEqual(run.tab.slice(0, -1), log.slice(-21, -1), "the log's last lines are printed first")
  assert.match(run.tab.at(-1), /the run view crashed 3 times, the last with exit code 7; the runner prints its log in this tab again/)
  run.tab.length = 0
  await run.end()
  assert.ok(run.tab.includes('== Result'), 'what follows is printed in the tab')
})

test('run view: q quits the view for good, and a view that cannot run here is not restarted either', async () => {
  for (const [code, words] of [[0, 'was closed'], [3, 'cannot run in this tab']]) {
    const clock = fakeClock()
    const views = fakeViews(clock)
    const tab = []
    const view = attachView({ spawnView: views.spawn, tab: (s) => tab.push(s), log: (s) => tab.push(s), clock })
    view.start()
    views.last().emit('exit', code, null)
    await turns()
    await view.closed
    assert.equal(views.spawned.length, 1, `exit ${code}`)
    assert.equal(view.crashes(), 0)
    assert.match(tab.at(-1), new RegExp(words))
  }
})

test('end of run: the runner writes summary.json, asks nothing, reclaims nothing and writes no reclaim record, and stays until the view is quit', async () => {
  const run = await attachedRun()
  const since = run.orca.calls.length
  run.end()
  assert.deepEqual(JSON.parse(readFileSync(join(run.stateDir, 'summary.json'), 'utf8')), { runner: 'orca', ok: true, result: [GOOD, null, GOOD] })
  assert.deepEqual(readdirSync(run.stateDir).filter((f) => f.endsWith('.json')), ['summary.json'])
  let closed = false
  run.view.closed.then(() => (closed = true))
  await turns()
  assert.deepEqual(run.views.last().sent, [], 'the view is sent no question')
  assert.deepEqual(run.tab, [], 'nor is the tab')
  assert.deepEqual(run.orca.calls.slice(since), [])
  assert.deepEqual(linesOf(run.registry).filter((e) => e.type === 'reclaimed'), [])
  assert.ok(logged(run.stateDir).includes('== Result'))

  // The runner stays until the operator quits the view.
  await turns()
  assert.equal(closed, false)
  run.views.last().emit('message', { type: 'detach' })
  run.views.last().emit('exit', 0, null)
  await turns()
  assert.equal(closed, true)
})

viewTest('run view: the screen is the design\'s tree, a click lands on the row drawn under it, and the flash line shows the latest event', async (mode) => {
  const { view, rowOf } = await viewedRun(mode)
  const plain = () => draw(view.model, { width: 140, height: 30, flash: view.model.latest }).lines.map(strip)
  let lines = plain()
  assert.equal(view.model.latest, '== Discover')
  assert.equal(lines.length, 30)
  assert.match(lines[0], /^ implement-spec-783 · controlayer · run_fake1 · spec #783 · runner ● alive · 30m00s/)
  assert.match(lines[1], /● 1 running {2}↻ 1 continued {2}◐ 1 stuck {2}· 1 queued {2}✓ 2 done {2}✗ 1 failed/)
  assert.match(lines[4], /^ ▸ Discover +1\/1 done +✓1 +peak ctx 210k/, 'a folded phase')
  assert.match(lines[5], /^ ▾ Implement +0\/5 done +●1 ↻1 ◐1 ✗1 ·1 *$/, 'an unfolded phase')
  assert.match(lines[6], /^ +2 +impl:a +● running +█+░* 363k +724k +29m00s/)
  assert.match(lines[8], /^ +4 +impl:c +↻ continued ×2 /)
  assert.match(lines[10], /^ +6 +impl:e +✗ failed +░{10} +— +— /, 'an agent that never started')
  assert.ok(!lines.some((l) => /PROTOTYPE|Tab ▸|Timeline/.test(l)), 'no status bar')
  assert.match(lines.at(-2), /== Discover/)
  assert.match(lines.at(-1), /↑↓ move · ←→ \/ click a phase to fold · ⏎\/click focus tab · r reclaim · l log · q quit/)

  // The selected row is inverted; a selected phase's pane names its problems.
  await view.key('DOWN')
  const screen = draw(view.model, { width: 140, height: 30 })
  assert.ok(screen.lines[5].startsWith('\x1b[7m'), 'selected, inverted')
  lines = plain()
  const pane = lines.slice(-6, -2)
  assert.match(pane[0], /Implement {2}5 agents/)
  assert.match(pane[1], /◐ impl:b: no movement/)
  assert.match(pane[2], /✗ impl:e: its worker did not start/)
  assert.equal(screen.rowAt(5), 0)
  assert.equal(screen.rowAt(7), rowOf('agent:2'))
  assert.equal(screen.rowAt(3), null)

  // A selected agent's pane: title, state, context, tokens, elapsed, then
  // its worktree, tab (open or closed), session, reason and transcript.
  await view.key('DOWN')
  await view.key('DOWN')
  lines = plain()
  assert.match(lines.at(-6), /\[Implement\] impl:b {2}◐ stuck {2}ctx — {2}total — {2}28m00s/)
  assert.ok(lines.at(-5).includes('worktree run_fake1-3   tab term_fake3 (open)   session sid-3'), lines.at(-5))
  assert.match(lines.at(-4), /reason no movement in its transcript or terminal for 20 minutes/)
  assert.match(lines.at(-3), /transcript —/)

})

test('orca-cli: a dispatch Orca failed because its tab closed is a gone worker, not a settled one; one that completed before its tab closed is settled', async () => {
  // As worker-show answers about 5 s after `terminal close` (live, Orca 1.4.209, #53).
  const closed = (status, stage) => ({ worker: { agentTerminalHandle: 'term_w', stage, state: status === 'completed' ? 'succeeded' : 'failed' }, dispatch: { status }, projection: { outcome: status === 'completed' ? 'succeeded' : 'failed' }, terminal: { orphaned: true }, observation: { status: 'live', agentWait: null } })
  for (const verb of ['workerShow']) {
    const failed = await recordingCli({ 'orchestration worker-show': closed('failed', 'process_exited') }).orca[verb]({ dispatch: 'ctx_9', terminal: 'term_w' })
    assert.deepEqual([failed.settled, failed.gone], [false, true], verb)
    const done = await recordingCli({ 'orchestration worker-show': closed('completed', 'settled') }).orca[verb]({ dispatch: 'ctx_9', terminal: 'term_w' })
    assert.deepEqual([done.settled, done.gone, done.outcome], [true, true, 'succeeded'], verb)
    // Orca 1.4.212 fails it at once, and can answer so before the terminal reads orphaned (live, #72).
    const early = { ...closed('failed', 'process_exited'), dispatch: { status: 'failed', terminationReason: 'operator_close' }, terminal: { orphaned: false } }
    const racing = await recordingCli({ 'orchestration worker-show': early }).orca[verb]({ dispatch: 'ctx_9', terminal: 'term_w' })
    assert.deepEqual([racing.settled, racing.gone], [false, true], verb)
  }
})

test('continuation: a worker whose tab is closed, and whose dispatch Orca then fails, is continued in a new terminal and returns its result', async () => {
  const r = await runOne(async ({ state, orca, clock }) => {
    submitsOnContinue(state)
    clock.at(5 * MIN, () => orca.terminalClose({ terminal: state.handle }))
  }, { script: oneOn('claude', ", isolation: 'worktree'") })
  assert.deepEqual(r.result, GOOD)
  const [c] = r.continues
  assert.equal(c.reopened, true)
  assert.equal(ofType(r.journal, 'continued')[0].reason, 'its terminal is gone')
  assert.equal(ofType(r.journal, 'failed').length, 0)
})

// --- the run view standalone: every run in the registry (D8 on #43) -----------

const RUNS_AT = Date.parse('2026-09-20T12:00:00.000Z')
const PROJECT = 'C:/repos/controlayer'
const HAND_MADE = 'C:/fake/worktrees/my-feature'
const blankWorktree = () => ({ parent: null, name: null, displayName: null, removed: false, status: null, porcelain: [], commits: 0, unpushed: 0 })

// The registry fixture's three runs at noon, on a fake Orca, their journals
// written beside it:
//   controlayer  run_a2 #790  running, its runner's tab open; impl:a still live
//                run_a1 #783  ended partial, its runner's tab closed; impl:a done
//                             and reclaimed, impl:b failed, check done in the
//                             run's own checkout, not a worktree of its own
//   skills       run_b1 #43   ended ok and reclaimed whole
// plus a worktree the operator made by hand, with a tab open in it.
async function standaloneRuns() {
  const clock = fakeClock()
  clock.t = RUNS_AT
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock, runWorktree: PROJECT, tabs: ['term_runA2', 'term_runA1', 'term_mine'] })
  orca.worktrees.set('C:/repos/skills', blankWorktree())
  orca.worktrees.set(HAND_MADE, blankWorktree())
  const start = (run, n, child = true) => orca.workerStart({ run, prompt: 'p', title: 't', sessionId: SID, ...(child && { child: { name: `${run}-${n}`, displayName: 't' } }) })
  const a1 = [await start('run_a1', 1), await start('run_a1', 2), await start('run_a1', 3, false)]
  const a2 = [await start('run_a2', 1)]
  const b1 = [await start('run_b1', 1)]
  const settle = (s, { gone = false, reclaimed = false } = {}) => {
    Object.assign(orca.dispatches.get(s.dispatchId), { settled: true, gone: gone || reclaimed, released: reclaimed })
    if (reclaimed) orca.worktrees.get(s.worktree).removed = true
  }
  settle(a1[0], { reclaimed: true })
  settle(a1[1], { gone: true })
  settle(a1[2])
  settle(b1[0], { reclaimed: true })

  const dir = tmp().replace(/\\/g, '/')
  const began = (run, n, label, s) => J('started', n, `[Implement] ${label}`, n, { run, dispatchId: s.dispatchId, harness: 'claude', sessionId: `sid-${n}`, worktree: s.worktree, terminal: s.terminal })
  const put = (name, entries) => {
    mkdirSync(join(dir, name, 'orca-run'), { recursive: true })
    writeFileSync(join(dir, name, 'orca-run', 'journal.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  }
  put('controlayer-783', [
    began('run_a1', 1, 'impl:a', a1[0]), began('run_a1', 2, 'impl:b', a1[1]), began('run_a1', 3, 'check', a1[2]),
    J('result', 1, '[Implement] impl:a', 5, { result: GOOD }), J('failed', 2, '[Implement] impl:b', 6, { reason: 'it died' }), J('result', 3, '[Implement] check', 7, { result: GOOD }),
  ])
  put('controlayer-790', [began('run_a2', 1, 'impl:a', a2[0])])
  put('skills-43', [began('run_b1', 1, 'impl:a', b1[0]), J('result', 1, '[Implement] impl:a', 5, { result: GOOD })])
  const registry = registryIn()
  writeFileSync(registry, readFileSync(fixture('orca-runs.jsonl'), 'utf8').replaceAll('@RUNS@', dir))

  // Whose runner.pid names a live process, by run dir: run_a2's alone. Every
  // runner's tab stays open after it dies (no `; exit`), so a runner is killed
  // here by its pid, never by closing its tab. `unknown`: the probe cannot tell.
  const runners = { live: new Set(['controlayer-790']), unknown: false }
  const alive = (runDir) => (runners.unknown ? null : runners.live.has(runDir.split(/[\\/]/).at(-2)))
  const runs = runsView({ orca, clock, registry, transcripts: { usage: () => null }, unpushed: orca.unpushedOf, alive })
  await runs.refresh()
  const run = (id) => runs.model.projects.flatMap((p) => p.runs).find((r) => r.runId === id)
  const select = async (key) => {
    while (runs.model.rows[runs.model.selected].key !== key) await runs.key(runs.model.rows.findIndex((r) => r.key === key) > runs.model.selected ? 'DOWN' : 'UP')
  }
  return { orca, clock, dir, registry, runs, run, select, runners, a1, a2, b1 }
}
const screenOf = (model) => drawRuns(model, { width: 140, height: 30 }).lines.map(strip)

test('standalone: runs from a registry fixture are listed by project, with outcome, runner alive or dead, kept count and age', async () => {
  const { runs, run, clock, orca, runners } = await standaloneRuns()
  assert.deepEqual(runs.model.projects.map((p) => [p.name, p.path, p.runs.map((r) => r.runId)]), [['controlayer', PROJECT, ['run_a2', 'run_a1']], ['skills', 'C:/repos/skills', ['run_b1']]])
  const facts = () => ['run_a2', 'run_a1', 'run_b1'].map((id) => [run(id).spec, run(id).outcome, run(id).alive, run(id).kept, run(id).ageMs, run(id).reclaimed])
  assert.deepEqual(facts(), [
    ['#790', null, true, 1, 30 * MIN, false],
    ['#783', 'partial', false, 2, 120 * MIN, false],
    ['#43', 'ok', false, 0, 180 * MIN, true],
  ])
  assert.equal(runs.model.rows[runs.model.selected].key, 'run:run_a2', 'the latest run is selected first')

  const lines = screenOf(runs.model)
  assert.match(lines[0], /^ Orca runs · 3 runs · 2 projects/)
  assert.match(lines[1], /● 1 alive {2}○ 2 dead {2}1 reclaimed/)
  assert.match(lines[4], /^ ▾ controlayer {2}C:\/repos\/controlayer {2}2 runs/)
  assert.match(lines[5], /^ +run_a2 +#790 +running +● alive +1 +30m/)
  assert.match(lines[6], /^ +run_a1 +#783 +partial +○ dead +2 +2h00m/)
  assert.match(lines[7], /^ ▾ skills/)
  assert.match(lines[8], /^ +run_b1 +#43 +ok +○ dead +0 +3h00m +reclaimed/)

  // Age runs on the clock.
  clock.t += 25 * 60 * MIN
  await runs.refresh()
  assert.deepEqual(['run_a2', 'run_a1', 'run_b1'].map((id) => run(id).ageMs), [25.5 * 60 * MIN, 27 * 60 * MIN, 28 * 60 * MIN])
  assert.match(screenOf(runs.model)[5], / 1d01h/)

  // run_a1's runner is dead though its tab is still open: the tab outlives it.
  assert.ok((await orca.terminalList()).includes('term_runA1'))
  // run_a2's runner is killed, its tab left open: dead, and the tree opened
  // from its row says the same. A terminal list Orca does not answer changes
  // nothing; a runner.pid nobody can read: nobody can say, so nothing is resumable.
  runners.live.clear()
  await runs.refresh()
  assert.deepEqual([run('run_a2').alive, run('run_a2').resumable, run('run_a2').closable], [false, true, true])
  assert.ok((await orca.terminalList()).includes('term_runA2'))
  await runs.key('ENTER')
  assert.equal(runs.opened().model.header.alive, false)
  await runs.key('q')
  orca.terminalList = async () => {
    throw new OrcaError('call_timeout', 'no answer within 60s', 'terminal list')
  }
  await runs.refresh()
  assert.deepEqual([run('run_a2').alive, run('run_a2').resumable], [false, true])
  runners.unknown = true
  await runs.refresh()
  assert.deepEqual(['run_a2', 'run_a1'].map((id) => [run(id).alive, run(id).resumable]), [[null, false], [null, false]])
  assert.match(screenOf(runs.model)[5], /\? unknown/)
})

test('standalone: two concurrent runs in one repo are separate rows, and a hand-made worktree with no run prefix never appears', async () => {
  const { runs, run, select, orca } = await standaloneRuns()
  const rows = runs.model.rows.filter((r) => r.kind === 'run' && r.project.name === 'controlayer')
  assert.deepEqual(rows.map((r) => r.key), ['run:run_a2', 'run:run_a1'])
  assert.notEqual(run('run_a2').runDir, run('run_a1').runDir)
  const shown = () => JSON.stringify(runs.model.projects) + screenOf(runs.model).join('\n')
  assert.ok(!/my-feature|term_mine/.test(shown()), 'no row, and no line, names it')

  // Inside a run: an agent that ran in the run's own checkout shows no worktree.
  await select('run:run_a1')
  assert.deepEqual(await runs.key('ENTER'), { opened: 'run_a1' })
  const tree = runs.opened()
  const rowOf = (key) => tree.model.rows.findIndex((r) => r.key === key)
  await tree.click(rowOf('agent:3'))
  assert.equal(tree.model.pane.agent.worktree, null)
  const lines = draw(tree.model, { width: 140, height: 30, help: TREE_HELP }).lines.map(strip)
  assert.ok(lines.some((l) => /^ worktree — +tab term_fake3/.test(l)), 'the checkout is not named as its worktree')
  assert.ok(!lines.some((l) => /my-feature/.test(l)))
  assert.match(lines.at(-1), /R resume · q back to the runs/)
  assert.deepEqual(orca.calls.filter((c) => MUTATING.includes(c.verb)), [])
})

test('standalone: Enter or a click opens a run into its tree, q or Escape goes back to the list, and q there quits', async () => {
  const { runs, select } = await standaloneRuns()
  await select('run:run_a1')
  assert.deepEqual(await runs.key('ENTER'), { opened: 'run_a1' })
  assert.equal(runs.model.opened.runId, 'run_a1')
  assert.deepEqual(runs.opened().model.header.runId, 'run_a1')
  await runs.key('DOWN')
  assert.equal(runs.opened().model.rows[runs.opened().model.selected].key, 'agent:1', 'the tree takes the keys')
  assert.deepEqual(await runs.key('q'), { closed: 'run_a1' })
  assert.equal(runs.opened(), null)
  assert.equal(runs.model.rows[runs.model.selected].key, 'run:run_a1')
  assert.deepEqual(await runs.click(runs.model.rows.findIndex((r) => r.key === 'run:run_b1')), { opened: 'run_b1' })
  assert.deepEqual(await runs.key('ESCAPE'), { closed: 'run_b1' })
  // A click on a project folds it.
  await runs.click(0)
  assert.deepEqual(runs.model.rows.map((r) => r.key).filter((k) => k.startsWith('run:')), ['run:run_b1'])
  assert.deepEqual(await runs.key('q'), { quit: true })
})

test('standalone: r reclaims a whole run, each agent by the reclaim rules, and records the run reclaimed once none is left', async () => {
  const { runs, run, select, orca, registry, a1, a2 } = await standaloneRuns()
  const since = orca.calls.length
  const mutations = () => orca.calls.slice(since).filter((c) => MUTATING.includes(c.verb))
  const reclaimedLines = (runId) => readFileSync(registry, 'utf8').split('\n').flatMap((l) => {
    try {
      const e = JSON.parse(l)
      return e.type === 'reclaimed' && e.runId === runId ? [e.agent ?? 'the run'] : []
    } catch {
      return [] // the fixture's torn last line
    }
  })

  // run_a2's one agent is live: kept, nothing touched, the run not reclaimed.
  const live = await runs.key('r')
  assert.deepEqual(live.kept.map((k) => [k.agent.n, k.reason]), [[1, 'it is still live']])
  assert.match(live.message, /^reclaimed 0 of 1 agents of implement-spec-790 run_a2; kept \[Implement\] impl:a: it is still live/)
  assert.deepEqual(mutations(), [])
  assert.deepEqual(reclaimedLines('run_a2'), [])
  assert.equal(orca.dispatches.get(a2[0].dispatchId).released, false)

  // run_a1: impl:a was reclaimed already; impl:b's worktree holds a commit no
  // remote has; check ran in the run's own checkout.
  await select('run:run_a1')
  orca.worktrees.get(a1[1].worktree).unpushed = 1
  const held = await runs.key('r')
  assert.deepEqual(held.reclaimed.map((a) => a.n), [3])
  assert.deepEqual(held.kept.map((k) => [k.agent.n, k.reason]), [[2, `${a1[1].worktree} holds 1 unpushed commit; only a forced reclaim removes it`]])
  assert.deepEqual(mutations().map((c) => [c.verb, c.dispatchId ?? c.path]), [['workerRelease', a1[2].dispatchId], ['terminalClose', a1[2].dispatchId]])
  assert.deepEqual(reclaimedLines('run_a1'), ['run_a1-1', 'run_a1-3'])
  assert.deepEqual([run('run_a1').kept, run('run_a1').reclaimed], [1, false])

  // Pushed: the last agent goes, and with it the run.
  orca.worktrees.get(a1[1].worktree).unpushed = 0
  const all = await runs.key('r')
  assert.deepEqual([all.reclaimed.map((a) => a.n), all.kept], [[2], []])
  assert.match(all.message, /^reclaimed implement-spec-783 run_a1: 1 agent$/)
  assert.deepEqual(reclaimedLines('run_a1'), ['run_a1-1', 'run_a1-3', 'run_a1-2', 'the run'])
  assert.equal(readRegistry(registry).find((r) => r.runId === 'run_a1').reclaimed, true)
  assert.deepEqual([run('run_a1').kept, run('run_a1').reclaimed], [0, true])
  assert.deepEqual(mutations().filter((c) => c.verb === 'worktreeRemove').map((c) => c.path), [a1[1].worktree], 'only a worktree named <runId>-<n>')
  assert.ok(!mutations().some((c) => c.dispatchId === a1[0].dispatchId), 'an agent reclaimed before is not reclaimed again')
  assert.deepEqual([PROJECT, HAND_MADE].map((p) => orca.worktrees.get(p).removed), [false, false])
  assert.ok((await orca.terminalList()).includes('term_mine'))
  assert.match((await runs.key('r')).message, /implement-spec-783 run_a1 is already reclaimed/)
})

test('standalone: r on a run still going reclaims its settled agents but never records the run reclaimed, so an agent it starts later is kept', async () => {
  const { runs, run, select, orca, registry, dir, a2, runners } = await standaloneRuns()
  const pane = () => screenOf(runs.model).slice(-6, -2).join('\n')
  const reclaimedLines = (runId) => readFileSync(registry, 'utf8').split('\n').flatMap((l) => {
    try {
      const e = JSON.parse(l)
      return e.type === 'reclaimed' && e.runId === runId ? [e.agent ?? 'the run'] : []
    } catch {
      return [] // the fixture's torn last line
    }
  })

  // run_a2's runner is alive, and its one agent has settled with nothing
  // unpushed: the run is between phases.
  orca.dispatches.get(a2[0].dispatchId).settled = true
  await runs.refresh()
  assert.deepEqual([run('run_a2').alive, run('run_a2').outcome, run('run_a2').closable], [true, null, false])
  assert.match(pane(), /r reclaims every agent it may; the run stays open/)
  const r = await runs.key('r')
  assert.deepEqual([r.reclaimed.map((a) => a.n), r.kept], [[1], []])
  assert.equal(r.message, 'reclaimed 1 agent of implement-spec-790 run_a2; the run stays open: its runner is alive')
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1'], 'the agent, never the run')
  assert.deepEqual([run('run_a2').reclaimed, run('run_a2').kept], [false, 0])
  assert.equal((await runs.key('r')).message, 'implement-spec-790 run_a2 has no agent left to reclaim; the run stays open: its runner is alive')
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1'])

  // The runner starts its next agent: listed, kept, and live in the tree.
  const s = await orca.workerStart({ run: 'run_a2', prompt: 'p', title: 't', sessionId: SID, child: { name: 'run_a2-2', displayName: 't' } })
  appendFileSync(join(dir, 'controlayer-790', 'orca-run', 'journal.jsonl'), JSON.stringify(J('started', 2, '[Implement] impl:b', 40, { run: 'run_a2', dispatchId: s.dispatchId, harness: 'claude', sessionId: 'sid-2', worktree: s.worktree, terminal: s.terminal })) + '\n')
  await runs.refresh()
  assert.deepEqual([run('run_a2').reclaimed, run('run_a2').kept], [false, 1])
  assert.match((await runs.key('r')).message, /^reclaimed 0 of 1 agents of implement-spec-790 run_a2; kept \[Implement\] impl:b: it is still live/)
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1'])
  await runs.key('ENTER')
  assert.deepEqual(runs.opened().model.phases.flatMap((p) => p.agents).map((a) => [a.n, a.reclaimed]), [[1, true], [2, false]])
  await runs.key('q')

  // run_a1 has ended, but while nobody can say whether its runner lives it is
  // not taken for dead: its agents may go, the run stays open.
  await select('run:run_a1')
  assert.equal(run('run_a1').closable, true)
  assert.match(pane(), /r reclaims every agent and closes the run/)
  runners.unknown = true
  await runs.refresh()
  assert.deepEqual([run('run_a1').alive, run('run_a1').closable], [null, false])
  await runs.key('r')
  assert.ok(!reclaimedLines('run_a1').includes('the run'))
  assert.equal(run('run_a1').reclaimed, false)
})

test('standalone: r on a run whose runner was killed before it recorded `ended` reclaims its agents and records the run reclaimed, and R then refuses it', async () => {
  const { runs, run, orca, registry, a2, runners } = await standaloneRuns()
  const resumes = () => orca.calls.filter((c) => c.verb === 'resumeRunner')
  const pane = () => screenOf(runs.model).slice(-6, -2).join('\n')
  const reclaimedLines = (runId) => readFileSync(registry, 'utf8').split('\n').flatMap((l) => {
    try {
      const e = JSON.parse(l)
      return e.type === 'reclaimed' && e.runId === runId ? [e.agent ?? 'the run'] : []
    } catch {
      return [] // the fixture's torn last line
    }
  })

  // run_a2's runner is killed (out of memory, say): its tab stays open, no
  // `ended` is recorded, and its one agent has settled with nothing unpushed.
  runners.live.delete('controlayer-790')
  orca.dispatches.get(a2[0].dispatchId).settled = true
  await runs.refresh()
  assert.equal(runs.model.rows[runs.model.selected].key, 'run:run_a2')
  assert.deepEqual(['alive', 'outcome', 'closable', 'resumable'].map((k) => run('run_a2')[k]), [false, null, true, true])
  assert.match(pane(), /r reclaims every agent and closes the run/)

  const r = await runs.key('r')
  assert.deepEqual([r.reclaimed.map((a) => a.n), r.kept], [[1], []])
  assert.equal(r.message, 'reclaimed implement-spec-790 run_a2: 1 agent')
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1', 'the run'], 'the agent, then the whole run')
  assert.equal(readRegistry(registry).find((e) => e.runId === 'run_a2').reclaimed, true)
  assert.deepEqual(['reclaimed', 'kept', 'resumable', 'closable'].map((k) => run('run_a2')[k]), [true, 0, false, false])

  // Reclaimed: R is neither offered nor carried out, and r has nothing left.
  assert.ok(!/R resumes/.test(pane()))
  assert.match((await runs.key('R')).message, /^implement-spec-790 run_a2 is reclaimed: .*nothing to resume$/)
  assert.deepEqual(resumes(), [])
  assert.match((await runs.key('r')).message, /implement-spec-790 run_a2 is already reclaimed/)
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1', 'the run'])
})

test("standalone: R on a run whose runner is dead opens one terminal in the run's worktree running the runner with --resume; never while its runner lives", async () => {
  const { runs, run, select, orca, dir, runners } = await standaloneRuns()
  const resumes = () => orca.calls.filter((c) => c.verb === 'resumeRunner')
  const pane = () => screenOf(runs.model).slice(-6, -2).join('\n')

  // run_a2's runner is alive: not offered, and R opens nothing.
  assert.equal(run('run_a2').resumable, false)
  assert.ok(!/R resumes/.test(pane()))
  assert.match((await runs.key('R')).message, /runner is alive, in tab term_runA2: nothing to resume/)
  assert.deepEqual(resumes(), [])

  // run_a1's is dead: the runner as the skill launched it, with --resume.
  await select('run:run_a1')
  assert.equal(run('run_a1').resumable, true)
  assert.match(pane(), /R resumes it: its runner is dead/)
  const r = await runs.key('R')
  const stateDir = `${dir}/controlayer-783/orca-run`
  assert.deepEqual(resumes().map((c) => [c.worktree, c.command]), [
    [PROJECT, resumeRunnerCommand({ runner: RUNNER_PATH, script: `${dir}/controlayer-783/workflow.js`, stateDir, permissionMode: 'auto' })],
  ])
  assert.match(resumes()[0].command, /^node '.*runner\.mjs' '.*workflow\.js' --state-dir '.*orca-run' --resume --permission-mode auto$/)
  assert.equal(r.resumed, resumes()[0].terminal)
  // Its new runner is alive before it reaches the registry: a second R opens nothing.
  assert.deepEqual([run('run_a1').alive, run('run_a1').resumable], [true, false])
  assert.match((await runs.key('R')).message, /runner is alive/)
  assert.equal(resumes().length, 1)
  // Once the new runner has written its runner.pid, that pid decides, whatever
  // the tab: here it names a process that is gone, the tab still open.
  runners.live.add('controlayer-783')
  writeFileSync(join(stateDir, 'runner.pid'), '4242')
  await runs.refresh()
  assert.equal(run('run_a1').alive, true)
  runners.live.delete('controlayer-783')
  await runs.refresh()
  assert.ok((await orca.terminalList()).includes(resumes()[0].terminal))
  assert.deepEqual([run('run_a1').alive, run('run_a1').resumable], [false, true])

  // run_b1 is recorded reclaimed: its agents are gone, so R is neither offered
  // nor carried out, from the list or from inside its tree, and the flash says why.
  await select('run:run_b1')
  assert.deepEqual([run('run_b1').alive, run('run_b1').resumable], [false, false])
  assert.ok(!/R resumes/.test(pane()))
  assert.match((await runs.key('R')).message, /^implement-spec-43 run_b1 is reclaimed: .*nothing to resume$/)
  await runs.key('ENTER')
  assert.match((await runs.key('R')).message, /run_b1 is reclaimed/)
  assert.equal(resumes().length, 1)
  await runs.key('q')

  // From inside a run's tree too. run_a2 was armed before the registry named
  // its script: the skill's layout gives it. Its runner dies, its tab left open.
  runners.live.delete('controlayer-790')
  await runs.refresh()
  await select('run:run_a2')
  await runs.key('ENTER')
  await runs.key('R')
  assert.deepEqual(resumes().slice(1).map((c) => [c.worktree, c.command]), [
    [PROJECT, resumeRunnerCommand({ runner: RUNNER_PATH, script: join(dir, 'controlayer-790', 'workflow.js'), stateDir: `${dir}/controlayer-790/orca-run` })],
  ])

  // A worktree Orca no longer knows: nothing opens, and the flash says why.
  await runs.key('q')
  orca.worktrees.get(PROJECT).removed = true
  orca.closeTab(resumes()[0].terminal)
  await runs.refresh()
  await select('run:run_a1')
  assert.match((await runs.key('R')).message, /could not resume implement-spec-783 run_a1: .*selector_not_found/)
  assert.equal(resumes().length, 2)
})

test('orca-cli: resuming a runner creates a tab in its worktree running the runner with --resume, every path a quoted literal', async () => {
  const { argvs, orca } = recordingCli({ 'terminal create': { terminal: { handle: 'term_r' } } }, { platform: 'win32' })
  const runner = "C:\\Users\\o'neil\\.claude\\skills\\implement-spec-in-workflow\\orca\\runner.mjs"
  const r = await orca.resumeRunner({ worktree: PROJECT, title: 'implement-spec-783 (resumed)', runner, script: 'C:/notes/workflow.js', stateDir: 'C:/notes/orca-run', permissionMode: 'auto' })
  const command = "node 'C:\\Users\\o''neil\\.claude\\skills\\implement-spec-in-workflow\\orca\\runner.mjs' 'C:/notes/workflow.js' --state-dir 'C:/notes/orca-run' --resume --permission-mode auto"
  assert.deepEqual(r, { terminal: 'term_r', command })
  assert.deepEqual(argvs, [['terminal', 'create', '--worktree', `path:${PROJECT}`, '--title', 'implement-spec-783 (resumed)', '--shell', 'powershell.exe', '--command', command, '--focus']])
  assert.equal(resumeRunnerCommand({ runner: "/home/o'neil/runner.mjs", script: '/n/workflow.js', stateDir: '/n/orca-run' }, 'linux'), "node '/home/o'\\''neil/runner.mjs' '/n/workflow.js' --state-dir '/n/orca-run' --resume")
  assert.throws(() => resumeRunnerCommand({ runner: 'r', script: 's', stateDir: 'd', permissionMode: 'auto; rm -rf /' }), /permission mode/)
  assert.throws(() => resumeRunnerCommand({ runner: 'r', script: 's\nRemove-Item C:/', stateDir: 'd' }), /control character/)
})

const SKILLS = fileURLToPath(new URL('../skills/engineering/', import.meta.url))
const VIEW_MJS = join(SKILLS, 'implement-spec-in-workflow', 'orca', 'run-view', 'view.mjs')

test('orca-runs: the skill opens the standalone view in a new Orca tab, and implement-spec-in-workflow links it', () => {
  const skill = readFileSync(join(SKILLS, 'orca-runs', 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\r?\nname: orca-runs\r?\ndescription: ".+"\r?\ndisable-model-invocation: true\r?\n---/)
  const command = /orca terminal create .*--command "(.*)" .*--json/.exec(skill)
  assert.ok(command, 'it launches the view with orca terminal create')
  assert.match(command[0], /--focus/)
  assert.match(command[1], /^node \\"<skill-dir>\/\.\.\/implement-spec-in-workflow\/orca\/run-view\/view\.mjs\\" --standalone$/)
  assert.ok(existsSync(join(SKILLS, 'orca-runs', '..', 'implement-spec-in-workflow', 'orca', 'run-view', 'view.mjs')))
  assert.match(readFileSync(join(SKILLS, 'implement-spec-in-workflow', 'SKILL.md'), 'utf8'), /\]\(\.\.\/orca-runs\/SKILL\.md\)/)
})

test('run view: standalone with no terminal exits as unavailable, and with no mode it is a usage error', () => {
  const alone = spawnSync(process.execPath, [VIEW_MJS, '--standalone', '--registry', registryIn()], { encoding: 'utf8' })
  assert.equal(alone.status, 3)
  assert.match(alone.stderr, /needs a terminal/)
  assert.equal(spawnSync(process.execPath, [VIEW_MJS], { encoding: 'utf8' }).status, 2)
})
