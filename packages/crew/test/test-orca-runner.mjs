// Offline tests for the Orca runner: submit, the agent() round trip, the live
// cap, how a run is laid out in Orca, resume from the journal, and every way a
// worker dies becoming null, with the fake Orca standing in for the CLI
// adapter and a fake clock standing in for time.
//   node packages/crew/test/test-orca-runner.mjs (or scripts/test-orca-runner.mjs)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, appendFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { submit } from '../src/submit.mjs'
import { runScript, journalKey, failureSummary, finish, SUBMIT, SETTINGS, JOURNAL_ENTRIES, readJournal, attachView, runnerLog, watchResumeRequests } from '../src/runner.mjs'
import { agentLifecycle, notePrompt, workerPrompt, doctorPrompt, NO_ASK, NO_WORKFLOW, ATTENDED as ATTENDED_TEXT } from '../src/lifecycle.mjs'
import { mergeMcpAnswers, copyMcpAnswers } from '../src/mcp-answers.mjs'
import { foldJournal } from '../src/journal.mjs'
import { fakeOrca, fakeTranscripts } from '../src/fake-orca.mjs'
import { RUNNER_SETTINGS } from '../src/settings.mjs'
import { orcaCli, OrcaError, tailCommand, resumeRunnerCommand, orcaUnreachable } from '../src/orca-cli.mjs'
import { worktreeUnpushed } from '../src/git.mjs'
import { reuseWorktree, prepareWorktree, WorktreeError } from '../src/worktree.mjs'
import { hostOutage, probesBy } from '../src/outage.mjs'
import { sessionHost, missingMethods } from '../src/session-host.mjs'
import { runRegistry, readRegistry, OUTCOMES } from '../src/registry.mjs'
import { transcriptPath, sessionTranscripts, claudeSlug, piDir, promptDelivered, turnEnded } from '../src/transcript.mjs'
import { agentsOf, reclaimAgent, reclaimRun } from '../src/reclaim.mjs'
import { removeRun, stopRunnerOf } from '../src/remove.mjs'
import { CONSULT_FILE } from '../src/orchestrator.mjs'
import { tool } from '../src/tools.mjs'
import { findRun, pauseCommand, resumeCommand, removeCommand } from '../src/run-commands.mjs'
import { holdQueue } from '../src/hold.mjs'
import { runHalt, RESUME_REQUEST } from '../src/halt.mjs'
import { reopenNode } from '../src/reopen.mjs'
import { runPause, pauseRun as pauseRunIn, unpauseRun } from '../src/pause.mjs'
import { runView, runsView, bandOf, STATES, RUNNER_PATH, runnerAlive, runEnded } from '../src/run-view-model.mjs'
import { consoleRunsHelp, consoleTreeHelp, draw, drawRuns, helpLine, listRuns, strip, TREE_HELP, marqueeOffset, NAME_W } from '../src/run-view/draw.mjs'
import { EventEmitter } from 'node:events'
import { daemonGone } from '../src/daemon/client.mjs'

// Every orca-cli: and fake orca: test is skipped for this reason; scripts/runner-contract-orca.workflow.js refuses to run for it.
const ORCA_SKIPPED = 'Orca leg skipped: new work (#171) does not target Orca; Orca stays, its tests and contract are not run'

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
const BAD_ERRORS = ['  $: missing required property "name"', '  $.count: expected integer, got string', '  $.kind: "c" is not one of ["a","b"]', '  $.tags[0]: expected string, got integer', '  $: unexpected property "extra"']

const tmp = () => mkdtempSync(join(tmpdir(), 'orca-runner-test-'))
const SID = '0b7f3c2e-5d1a-4c8e-9f60-2a4b6c8d0e1f'
const journalOf = (stateDir) =>
  readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
const FAST = { pollMs: 1 }
const TEMPLATE = new URL('../../../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url)

// A dispatched worker as submit sees it: its preamble IDs and its files.
async function startedWorker() {
  const dir = tmp()
  const orca = fakeOrca()
  const w = await orca.workerStart({ run: 'run_fake', prompt: '', title: 't', sessionId: SID })
  const d = orca.dispatches.get(w.dispatchId)
  const paths = { schema: join(dir, 'schema.json'), result: join(dir, 'result.json'), payload: join(dir, 'payload.json') }
  writeFileSync(paths.schema, JSON.stringify(SCHEMA))
  const argv = ['--schema', paths.schema, '--result', paths.result, '--payload', paths.payload, '--from', d.handle, '--dispatch-capability', d.capability, '--task-id', d.taskId, '--dispatch-id', d.dispatchId]
  return { orca, d, paths, argv }
}

async function runSubmit(argv, orca) {
  const out = []
  const err = []
  const code = await submit(argv, { host: orca, stdout: (s) => out.push(s), stderr: (s) => err.push(s) })
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
  for (const [schema, what] of [
    [join(dirname(paths.schema), 'missing.json'), 'missing'],
    [paths.schema, 'not JSON'],
  ]) {
    if (what === 'not JSON') writeFileSync(paths.schema, '{ type: ')
    const r = await runSubmit(
      argv.map((a) => (a === paths.schema ? schema : a)),
      orca,
    )
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
  const words = line
    .trim()
    .match(/"[^"]*"|\S+/g)
    .map((w) => fill[w] ?? w.replace(/^"|"$/g, ''))
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
  const result = await runScript(SCRIPT, { host: orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.deepEqual(result, { r: GOOD })

  const verbs = orca.calls.map((c) => c.verb)
  assert.deepEqual(verbs.slice(0, 2), ['runCreate', 'workerStart'])
  assert.equal(verbs.filter((v) => v === 'workerDone').length, 1)
  const done = verbs.indexOf('workerDone')
  assert.ok(
    orca.calls.slice(0, done).every((c) => c.verb !== 'workerShow' || !c.settled),
    'settled before worker_done',
  )
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
  const result = await runScript(SCRIPT, { host: orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.deepEqual(result, { r: null })
  assert.ok(
    lines.some((l) => l.includes('recorded result fails its schema') && l.includes('$.count: expected integer, got string')),
    lines.join('\n'),
  )
})

test('agent(): a schema no result can satisfy throws before any worker starts', async () => {
  const orca = fakeOrca()
  const script = `return await agent('x', { schema: { type: 'object', required: ['a'], properties: {} } })`
  await assert.rejects(runScript(script, { host: orca, stateDir: tmp(), out: () => {} }), /requires properties it does not define: a/)
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
    const result = await runScript(script, { host: shared.as(`term_${run}`), stateDir, out: () => {}, settings: FAST, resume })
    return { orca: since(shared, from), result }
  }

  const first = await go(chain('Build it.'), 1, false)
  assert.deepEqual(first.result, ['Plan it. @1', 'Build it. @1', 'Check it. @1'])
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
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
const submitting =
  (hold = 0) =>
  async ({ prompt, preamble, orca }) => {
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
      const promise = new Promise((r) =>
        setImmediate(() =>
          setImmediate(async () => {
            if (cancelled) return
            if (c.t < due) await c.sleep(due - c.t)
            r()
          }),
        ),
      )
      return {
        promise,
        cancel: () => {
          cancelled = true
        },
      }
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
const givesUp = async ({ orca, preamble }) => {
  await orca.mailSend({ ...idsOf(preamble), type: 'worker_done', outcome: 'failed', subject: 'giving up', body: GIVE_UP })
}
const handsOff =
  (note) =>
  async ({ orca, preamble }) => {
    await orca.mailSend({ ...idsOf(preamble), type: 'handoff', subject: 'note', body: note })
    await orca.mailSend({ ...idsOf(preamble), type: 'worker_done', outcome: 'succeeded', subject: 'done', body: 'handed off' })
  }
const withDoctor =
  (patient, doctor = givesUp) =>
  (w) =>
    IS_DOCTOR.test(w.prompt) ? doctor(w) : patient(w)
const NO_DOCTOR = { doctorRounds: 0 }

// Runs a script (one agent() by default) on the default settings table, each
// worker played by `worker`.
async function runOne(worker, { script = ONE, orcaPatch = {}, permissionMode = null, faults = {}, settings = {}, setupLeaves = [], promptLoss, crew = false } = {}) {
  const clock = fakeClock()
  const lines = []
  const stateDir = tmp()
  const made = fakeOrca({ worker: (w) => worker({ ...w, clock }), clock, faults, setupLeaves, promptLoss, crew })
  const orca = Object.assign(made, typeof orcaPatch === 'function' ? orcaPatch(made) : orcaPatch)
  const result = await runScript(script, { host: orca, stateDir, out: (s) => lines.push(s), clock, permissionMode, settings, transcripts: fakeTranscripts(orca) })
  const of = (verb) => orca.calls.filter((c) => c.verb === verb)
  const log = readFileSync(join(stateDir, 'runner.log'), 'utf8').trimEnd().split('\n')
  return {
    result,
    lines,
    nudges: of('terminalSend'),
    stop: of('workerStop')[0],
    released: of('workerRelease').length,
    releases: of('workerRelease'),
    continues: of('workerContinue'),
    start: of('workerStart')[0],
    orca,
    journal: journalOf(stateDir),
    log,
    stateDir,
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
  const result = await runScript(fanOut(25, 'Fan'), { host: orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
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
  const result = await runScript(fanOut(2, 'Fan'), { host: orca, stateDir: tmp(), out: () => {}, settings: { ...FAST, MAX_LIVE: 1 } })
  assert.deepEqual(result, [null, GOOD])
  assert.equal(liveHighWater(orca.calls), 1)
})

test('one run: every agent of a workflow run is dispatched into one Orca Run whose objective names the spec', async () => {
  const orca = fakeOrca({ worker: submitting() })
  const script = `export const meta = { name: 'implement-spec-21', description: 'Implement spec #21 as a stack of PRs', phases: [] }
const S = ${JSON.stringify(SCHEMA)}
await parallel([1, 2, 3].map((i) => () => agent('Name a thing.', { label: 'impl:#' + i, phase: 'Implement', schema: S })))
return await agent('Name a thing.', { label: 'finalize', phase: 'Finalize', schema: S })`
  assert.deepEqual(await runScript(script, { host: orca, stateDir: tmp(), out: () => {}, settings: FAST }), GOOD)
  const creates = orca.calls.filter((c) => c.verb === 'runCreate')
  assert.equal(creates.length, 1)
  assert.equal(creates[0].objective, 'implement-spec-21: Implement spec #21 as a stack of PRs')
  assert.equal(orca.dispatches.size, 4)
  assert.deepEqual([...new Set([...orca.dispatches.values()].map((d) => d.run))], ['run_fake1'])
})

// A run's end, or its halt (ADR-0016), whichever comes first: a halted run
// waits on its held node, and never settles by itself.
const haltsOrEnds = (start) =>
  new Promise((resolve) => {
    start((h) => resolve({ halted: h })).then(
      (result) => resolve({ result }),
      (error) => resolve({ error }),
    )
  })

test('one run: the rendered workflow template names its spec in the Run objective', async () => {
  const text = readFileSync(TEMPLATE, 'utf8')
    .replace(/__SPEC__/g, '227')
    .replace(/__RUN_ORDER__/g, 'parallel')
    .replace(/__[A-Z_]+__/g, 'x')
  const orca = fakeOrca({
    worker: async () => {
      throw new Error('agent died')
    },
  })
  // Its graph node fails, is held, and the run halts: it never settles.
  await haltsOrEnds((onHalt) => runScript(text, { host: orca, stateDir: tmp(), out: () => {}, settings: FAST, onHalt }))
  const creates = orca.calls.filter((c) => c.verb === 'runCreate')
  assert.equal(creates.length, 1)
  assert.match(creates[0].objective, /spec #227\b/)
})

test("RUNNER: a script rendered with 'orca', RUNNER's value before 'session', runs as one rendered with 'session' does, and resumes", async () => {
  const render = (runner) =>
    readFileSync(TEMPLATE, 'utf8')
      .replace(/__RUNNER__/g, runner)
      .replace(/__SPEC__/g, '227')
      .replace(/__RUN_ORDER__/g, 'parallel')
      .replace(/__[A-Z_]+__/g, 'x')
  const trace = (orca) => orca.calls.filter((c) => ['runCreate', 'runUse', 'workerStart'].includes(c.verb)).map((c) => [c.verb, c.title ?? c.objective ?? null, c.placement ?? null])
  const runOn = async (runner, { clock = fakeClock(), orca = fakeOrca({ worker: withDoctor(diesPastCap), clock }), stateDir = tmp(), resume = false } = {}) => {
    await haltsOrEnds((onHalt) => runScript(render(runner), { host: orca, stateDir, out: () => {}, clock, transcripts: fakeTranscripts(orca), onHalt, resume }))
    return { clock, orca, stateDir }
  }
  const session = await runOn('session')
  const orca = await runOn('orca')
  assert.ok(trace(session.orca).some(([verb]) => verb === 'workerStart'))
  assert.deepEqual(trace(orca.orca), trace(session.orca))
  const before = orca.orca.calls.length
  await runOn('orca', { ...orca, resume: true })
  const resumed = orca.orca.calls.slice(before)
  assert.deepEqual(
    resumed.filter((c) => c.verb === 'runUse').map((c) => c.runId),
    [...orca.orca.runs.keys()].slice(0, 1),
  )
  assert.ok(!resumed.some((c) => c.verb === 'runCreate'))
})

test('session host: the Orca adapter and the fake Orca both implement every method of the interface', () => {
  assert.deepEqual(missingMethods(orcaCli()), [])
  assert.deepEqual(missingMethods(fakeOrca()), [])
  for (const host of [orcaCli(), fakeOrca()]) assert.equal(sessionHost(host), host)
  assert.throws(() => sessionHost({ ...fakeOrca(), workerShow: undefined }), /not a session host: workerShow missing/)
})

test('session host: no runner module names Orca in its code; only the Orca adapter, the fake Orca and the host list do', () => {
  const SRC = new URL('../src/', import.meta.url)
  const ADAPTERS = new Set(['orca-cli.mjs', 'fake-orca.mjs', 'hosts.mjs'])
  const modules = [
    ...readdirSync(SRC).filter((f) => f.endsWith('.mjs')),
    ...readdirSync(new URL('run-view/', SRC))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => `run-view/${f}`),
  ]
  assert.ok(modules.includes('runner.mjs') && modules.includes('run-view/view.mjs'))
  // Text an operator or a worker reads, and the names a run's files carry, are
  // left: only code — imports, identifiers, calls — is looked at.
  const code = (text) =>
    text
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/`(?:\\.|[^`\\])*`/gs, '``')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/\s\/\/.*$/gm, '')
  const naming = modules.filter((m) => !ADAPTERS.has(m)).filter((m) => /orca/i.test(code(readFileSync(new URL(m, SRC), 'utf8'))))
  assert.deepEqual(naming, [])
})

test("doctor: the rendered template's recover row is the doctor's harness and model on the Orca runner", async () => {
  const text = readFileSync(TEMPLATE, 'utf8')
    .replace(/__RUNNER__/g, 'orca')
    .replace(/__SPEC__/g, '227')
    .replace(/__RUN_ORDER__/g, 'parallel')
    .replace(/__[A-Z_]+__/g, 'x')
  const clock = fakeClock()
  const orca = fakeOrca({ worker: withDoctor(diesPastCap), clock })
  await haltsOrEnds((onHalt) => runScript(text, { host: orca, stateDir: tmp(), out: () => {}, clock, transcripts: fakeTranscripts(orca), onHalt }))
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
  await runScript(script, { host: orca, stateDir: tmp(), out: () => {}, settings: FAST })
  const want = ['[Implement] impl:#227', '[Gate] gate:#227:r2', '[Implement] agent-3']
  const ds = [...orca.dispatches.values()]
  assert.deepEqual(
    ds.map((d) => d.title),
    want,
  )
  assert.deepEqual(
    ds.map((d) => d.tabTitle),
    want,
  )
})

test('titles: a tab that cannot be renamed is reported, and the agent still runs', async () => {
  const lines = []
  const orca = fakeOrca({ worker: submitting() })
  orca.terminalRename = async () => {
    throw new Error('terminal_handle_stale')
  }
  const result = await runScript(SCRIPT, { host: orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.deepEqual(result, { r: GOOD })
  assert.ok(
    lines.some((l) => l.startsWith('!! [Tracer] tracer:thing: could not title its tab')),
    lines.join('\n'),
  )
})

const within = (at, from, what) => assert.ok(at >= from && at < from + POLL, `${what} at ${at / MIN} min, expected ${from / MIN} min`)

test("settings: the liveness limits are the ticket's, in one table", () => {
  assert.equal(RUNNER_SETTINGS.idleNudges, 2)
  assert.equal(RUNNER_SETTINGS.stuckNudgeMs, 20 * MIN)
  assert.equal(RUNNER_SETTINGS.stuckContinueMs, 40 * MIN)
  assert.equal(RUNNER_SETTINGS.maxContinuations, 3)
  assert.equal(RUNNER_SETTINGS.blockedFailMs, 30 * MIN)
  assert.ok(Object.isFrozen(RUNNER_SETTINGS))
})

// A continued session that finishes the job: it submits with the preamble it
// now holds, which is a new one when its tab was gone.
const submitsOnContinue = (state) => {
  state.onContinue = submitGood
}
const oneOn = (harness, more = '') => `return await agent('Do a thing.', { label: 'one', phase: 'P', schema: ${JSON.stringify(SCHEMA)}${harness === 'pi' ? ", harness: 'pi'" : ''}${more} })`
const RESUME = { claude: (sid) => `claude --resume ${sid}`, pi: (sid) => `pi --approve --session-id ${sid}` }
const ofType = (journal, type) => journal.filter((e) => e.type === type)

for (const harness of ['claude', 'pi']) {
  test(`continuation (${harness}): a worker whose transcript and terminal have not moved is nudged at 20 minutes, then continued at 40 in its own terminal, and its result is returned`, async () => {
    const r = await runOne(
      async ({ state }) => {
        // The nudge lands in the transcript: that is the nudge, not the worker.
        state.onNudge = () => {
          state.transcript = (state.transcript ?? 0) + 120
        }
        submitsOnContinue(state)
      },
      { script: oneOn(harness) },
    )
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
    assert.deepEqual(
      ofType(r.journal, 'nudge').map((e) => [e.attempt, e.dispatchId]),
      [[1, started.dispatchId]],
    )
    assert.match(ofType(r.journal, 'nudge')[0].reason, /no movement in its transcript or terminal for 20 minutes/)
    const [cont] = ofType(r.journal, 'continued')
    assert.deepEqual([cont.attempt, cont.reopened, cont.sessionId, cont.terminal, cont.dispatchId], [1, false, started.sessionId, started.terminal, started.dispatchId])
    assert.match(cont.reason, /no movement in its transcript or terminal for 40 minutes/)
    assert.deepEqual(
      ofType(r.journal, 'result').map((e) => e.result),
      [GOOD],
    )
  })

  test(`continuation (${harness}): with its tab gone, the session is resumed in a new terminal in the same worktree, and the continued agent's result is returned`, async () => {
    const r = await runOne(
      async ({ state }) => {
        state.gone = true
        submitsOnContinue(state)
      },
      { script: oneOn(harness, ", isolation: 'worktree'") },
    )
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
      w.clock.at(w.clock.now() + 9_000, () => {
        w.state.transcript += 40
      })
    }
    submitsOnContinue(w.state)
    // A runner that keeps renudging never continues it: end the run anyway.
    w.clock.at(90 * MIN, () => submitGood(w))
  })
  const late = (at, from, what) => assert.ok(at >= from && at < from + POLL + LAG, `${what} at ${at / MIN} min, expected ${from / MIN} min`)
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
    for (let m = 1; m <= 60; m++)
      w.clock.at(m * MIN, () => {
        w.state.transcript = m * 100
      })
    w.clock.at(61 * MIN, () => submitGood(w))
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 0)
  assert.equal(r.continues.length, 0)
})

test('continuation: a terminal that keeps changing between busy and idle behind a still transcript is not stuck', async () => {
  const r = await runOne(async (w) => {
    for (let k = 1; k <= 40; k++)
      w.clock.at(k * 90_000, () => {
        w.state.idle = !w.state.idle
      })
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
  assert.deepEqual(
    ofType(r.journal, 'continued').map((e) => e.attempt),
    [1, 2, 3],
  )
  for (const e of ofType(r.journal, 'continued')) assert.equal(e.reason, 'it went idle without submitting, after 2 nudges')
  assert.deepEqual(
    ofType(r.journal, 'nudge').map((e) => e.attempt),
    [1, 2, 1, 2, 1, 2, 1, 2],
  )
  for (const e of ofType(r.journal, 'nudge')) assert.match(e.reason, /^it went idle without submitting \(nudge [12] of 2\)$/)
  const [failed] = ofType(r.journal, 'failed')
  assert.equal(failed.reason, 'it went idle without submitting, after 2 nudges, and its session was already continued 3 times, the cap of 3, with no result')
  assert.equal(failed.continuations, 3)
  // Kept: its process is not stopped, its tab not closed, its worktree retained.
  assert.equal(r.stop, undefined)
  assert.equal(r.released, 0)
  assert.equal(r.orca.dispatches.get(started.dispatchId).gone, false)
  assert.equal(failed.retained.path, started.worktree)
  assert.ok(
    r.lines.some((l) => l.startsWith(`!! kept ${started.worktree}:`)),
    r.lines.join('\n'),
  )
  assert.ok(
    r.lines.some((l) => l.includes(`its tab ${started.terminal} is kept open`)),
    r.lines.join('\n'),
  )
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
    clock.at(30 * MIN, () => {
      state.transcript = 500
    })
    submitsOnContinue(state)
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 2)
  within(r.nudges[1].at, 50 * MIN, 'second nudge')
  within(r.continues[0].at, 70 * MIN, 'continuation')
})

test('liveness: a worker blocked on a human is logged loudly once, never nudged, and after 30 minutes fails and is kept, never continued', async () => {
  const r = await runOne(
    async ({ state }) => {
      state.waiting = '{"evidence":"prompt-text","text":"Allow this command?"}'
    },
    { settings: NO_DOCTOR },
  )
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
  assert.ok(
    r.lines.some((l) => l.includes('Allow this command?')),
    r.lines.join('\n'),
  )
  // Every line of the banner names the agent, the last one included.
  assert.ok(
    r.lines.some((l) => l.startsWith('!!!!!!!! [P] one: if nobody answers within 30 minutes')),
    r.lines.join('\n'),
  )
  // Journaled too, with what it waits on, so the run view shows it while it lasts.
  assertEntries(r.journal)
  assert.deepEqual(
    ofType(r.journal, 'blocked').map((e) => [e.title, e.dispatchId, e.terminal, e.waiting]),
    [['[P] one', 'ctx_fake1', 'term_fake1', '{"evidence":"prompt-text","text":"Allow this command?"}']],
  )
  assert.deepEqual(ofType(r.journal, 'unblocked'), [])
  // Its process is left running: the failed line says so, for reclaim.
  assert.equal(ofType(r.journal, 'failed')[0].workerLeft, true)
  const [agent] = foldJournal(r.journal).agents
  assert.deepEqual([agent.state, agent.workerLeft, agent.waiting], ['failed', true, null])
})

test('liveness: a blocked worker the operator answers in time is journaled unblocked, and returns its result', async () => {
  const r = await runOne(async (w) => {
    w.state.waiting = '{"evidence":"hook"}'
    w.clock.at(29 * MIN, () => {
      w.state.waiting = null
    })
    w.clock.at(35 * MIN, () => submitGood(w))
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 0)
  assertEntries(r.journal)
  assert.deepEqual(
    r.journal.filter((e) => e.type !== 'run').map((e) => e.type),
    ['starting', 'started', 'blocked', 'unblocked', 'result'],
  )
  const unblocked = ofType(r.journal, 'unblocked')[0]
  assert.ok(Date.parse(unblocked.at) >= 29 * MIN, unblocked.at)
})

// An attended agent (ADR-0021): a person joins its session, so it waits for
// them as long as they take.
const ATTENDED = `return await agent('Help the person clear these blockers.', { label: 'unblock', phase: 'Unblock', node: 'unblock', attended: 'blockers: no signing identity', schema: ${JSON.stringify(SCHEMA)} })`

test('attended: an agent a person joins is never nudged, continued or failed for idling, and shows needs you until it submits five hours on', async () => {
  const r = await runOne(
    async (w) => {
      w.state.idle = true
      w.clock.at(5 * 60 * MIN, () => submitGood(w))
    },
    { script: ATTENDED, settings: NO_DOCTOR },
  )
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 0)
  assert.equal(r.continues.length, 0)
  assertEntries(r.journal)
  const started = ofType(r.journal, 'started')[0]
  assert.equal(started.attended, 'blockers: no signing identity')
  const live = foldJournal(r.journal.filter((e) => e.type !== 'result')).agents[0]
  assert.deepEqual([live.state, live.reason], ['needs you', 'blockers: no signing identity'])
  assert.ok(
    r.lines.some((l) => l.includes('NEEDS YOU') && l.includes('[Unblock] unblock') && l.includes('blockers: no signing identity')),
    r.lines.join('\n'),
  )
  assert.equal(foldJournal(r.journal).agents[0].state, 'done')
})

test('attended: a blocked attended agent is never failed for waiting on its human', async () => {
  const r = await runOne(
    async (w) => {
      w.state.waiting = '{"evidence":"prompt-text","text":"Allow this command?"}'
      w.clock.at(3 * 60 * MIN, () => {
        w.state.waiting = null
      })
      w.clock.at(3 * 60 * MIN + 5 * MIN, () => submitGood(w))
    },
    { script: ATTENDED, settings: NO_DOCTOR },
  )
  assert.deepEqual(r.result, GOOD)
  assert.equal(ofType(r.journal, 'failed').length, 0)
})

test('attended: an attended session that exits is continued, and still needs you', async () => {
  const r = await runOne(
    async (w) => {
      w.clock.at(10 * MIN, () => {
        w.state.exited = true
      })
      submitsOnContinue(w.state)
    },
    { script: ATTENDED, settings: NO_DOCTOR },
  )
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.continues.length, 1)
  assert.equal(r.nudges.length, 0)
  const live = foldJournal(r.journal.filter((e) => e.type !== 'result')).agents[0]
  assert.equal(live.state, 'needs you')
})

test('attended: true is a person needed with the default reason; its session silent for hours is never nudged, and NEEDS YOU names its terminal', async () => {
  const r = await runOne(
    async (w) => {
      w.clock.at(4 * 60 * MIN, () => submitGood(w))
    },
    { script: `return await agent('Help.', { label: 'unblock', phase: 'Unblock', attended: true, schema: ${JSON.stringify(SCHEMA)} })`, settings: NO_DOCTOR },
  )
  assert.deepEqual(r.result, GOOD)
  assert.equal(r.nudges.length, 0)
  assert.equal(r.continues.length, 0)
  assert.equal(ofType(r.journal, 'failed').length, 0)
  const started = ofType(r.journal, 'started')[0]
  assert.equal(started.attended, 'a person is needed in this session')
  assert.ok(
    r.lines.some((l) => l.includes(`[Unblock] unblock NEEDS YOU in terminal ${started.terminal}: a person is needed in this session`)),
    r.lines.join('\n'),
  )
})

test('attended: it is part of the call, so its journal key differs from the same call unattended', () => {
  const opts = { label: 'unblock', phase: 'Unblock', schema: SCHEMA }
  assert.notEqual(journalKey('p', opts), journalKey('p', { ...opts, attended: 'blockers: x' }))
  assert.notEqual(journalKey('p', { ...opts, attended: 'blockers: x' }), journalKey('p', { ...opts, attended: 'blockers: y' }))
})

test('attended: an unattended agent that idles is still nudged and never needs you', async () => {
  const r = await runOne(
    async (w) => {
      w.state.idle = true
      w.clock.at(10 * MIN, () => submitGood(w))
    },
    { settings: NO_DOCTOR },
  )
  assert.deepEqual(r.result, GOOD)
  assert.ok(r.nudges.length > 0)
  assert.equal(ofType(r.journal, 'started')[0].attended, undefined)
  assert.ok(!r.lines.some((l) => l.includes('NEEDS YOU')), r.lines.join('\n'))
})

// --- an agent's own note and needs-you (#175) --------------------------------

test('note: each note its agent posts is journaled, a later one replacing it and one over 200 characters cut; it is no movement, so an idle agent is still nudged', async () => {
  const long = 'x'.repeat(250)
  const r = await runOne(
    async (w) => {
      w.state.idle = true
      w.state.note = 'reading the spec'
      w.clock.at(2 * MIN, () => (w.state.note = long))
      w.clock.at(10 * MIN, () => submitGood(w))
    },
    { settings: NO_DOCTOR, crew: true },
  )
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  const notes = ofType(r.journal, 'note')
  assert.deepEqual(
    notes.map((e) => e.note),
    ['reading the spec', 'x'.repeat(200)],
  )
  const upTo = (e) => foldJournal(r.journal.slice(0, r.journal.indexOf(e) + 1)).agents[0]
  assert.equal(upTo(notes[0]).note, 'reading the spec')
  assert.equal(upTo(notes[1]).note, 'x'.repeat(200), 'the later note replaces it')
  assert.equal(foldJournal(r.journal).agents[0].note, null, 'a settled agent shows no note')
  assert.ok(r.nudges.length > 0, 'a note is no movement')
  assert.ok(
    r.lines.some((l) => l.endsWith('notes: reading the spec')),
    r.lines.join('\n'),
  )
})

for (const how of ['idle', 'waiting']) {
  test(`needs you: an agent that says it needs you (then ${how}) shows needs you with its reason, is never nudged, continued or failed by the blocked limit, and its submit clears it`, async () => {
    const r = await runOne(
      async (w) => {
        w.state.needsYou = ASK
        if (how === 'idle') w.state.idle = true
        else w.state.waiting = '{"evidence":"prompt-text","text":"Allow this command?"}'
        w.clock.at(4 * 60 * MIN, () => submitGood(w))
      },
      { settings: NO_DOCTOR, crew: true },
    )
    assert.deepEqual(r.result, GOOD)
    assertEntries(r.journal)
    assert.deepEqual(r.nudges, [], 'never nudged')
    assert.deepEqual(r.continues, [], 'never continued')
    assert.deepEqual(ofType(r.journal, 'failed'), [])
    const [asked] = ofType(r.journal, 'needsYou')
    assert.deepEqual([asked.reason, asked.terminal], [ASK, ofType(r.journal, 'started')[0].terminal])
    const upTo = (e) => foldJournal(r.journal.slice(0, r.journal.indexOf(e) + 1)).agents[0]
    assert.deepEqual([upTo(asked).state, upTo(asked).reason], ['needs you', ASK])
    // Its submit cleared it, before its result.
    const cleared = ofType(r.journal, 'needsYouCleared')
    assert.equal(cleared.length, 1)
    assert.ok(r.journal.indexOf(cleared[0]) < r.journal.indexOf(ofType(r.journal, 'result')[0]))
    if (how === 'waiting') {
      const blocked = ofType(r.journal, 'blocked')[0]
      assert.equal(upTo(blocked).state, 'blocked')
      assert.ok(!r.lines.some((l) => l.includes('if nobody answers within')), r.lines.join('\n'))
    }
    assert.ok(
      r.lines.some((l) => l.includes(`NEEDS YOU in terminal ${asked.terminal}: ${ASK}`)),
      r.lines.join('\n'),
    )
  })
}

test('needs you: its next mail clears it, and an idle agent is nudged again only after', async () => {
  const r = await runOne(
    async (w) => {
      w.state.needsYou = ASK
      w.state.idle = true
      w.clock.at(60 * MIN, () => w.orca.mailSend({ ...idsOf(w.preamble), type: 'handoff', subject: 'progress', body: 'logged in, carrying on' }))
      w.clock.at(120 * MIN, () => submitGood(w))
    },
    { settings: NO_DOCTOR, crew: true },
  )
  assert.deepEqual(r.result, GOOD)
  const [cleared] = ofType(r.journal, 'needsYouCleared')
  assert.ok(cleared, JSON.stringify(r.journal))
  assert.ok(Date.parse(cleared.at) >= 60 * MIN)
  const nudges = ofType(r.journal, 'nudge')
  assert.ok(nudges.length > 0)
  assert.ok(nudges.every((e) => r.journal.indexOf(e) > r.journal.indexOf(cleared)))
  assert.equal(foldJournal(r.journal.slice(0, r.journal.indexOf(cleared) + 1)).agents[0].state, 'running')
})

test("needs you: a doctor's needs_you is its escalation, journaled as such, and it waits as a doctor's escalation does", async () => {
  const doctor = async (w) => {
    await w.orca.mailSend({ ...idsOf(w.preamble), type: 'escalation', subject: 'needs you', body: ASK })
    w.state.idle = true
    w.clock.at(w.clock.now() + 180 * MIN, () => handsOff(NOTE)(w))
  }
  const r = await runOne(withDoctor(curedBy(NOTE, 'gone'), doctor), { script: ISOLATED, crew: true })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  const d = doctorOf(r.journal)
  assert.deepEqual(
    ofType(r.journal, 'mail')
      .filter((e) => e.doctor === d.n)
      .map((e) => [e.kind, e.action]),
    [
      ['escalation', 'needsYou'],
      ['handoff', 'remedy'],
      ['worker_done', 'ended'],
    ],
  )
  assert.equal(ofType(r.journal, 'mail').find((e) => e.doctor === d.n).body, ASK)
  assert.deepEqual(ofType(r.journal, 'needsYou'), [], 'no needs-you of its own: its escalation is')
  assert.deepEqual(
    r.journal.filter((e) => e.n === d.n && ['nudge', 'continued', 'failed'].includes(e.type)),
    [],
  )
})

test('liveness: a worker Orca cannot start, or cannot be watched, is null', async () => {
  const start = await runOne(async () => {}, {
    settings: NO_DOCTOR,
    orcaPatch: {
      workerStart: async () => {
        throw new Error('orca orchestration worker-start: outcome_unknown')
      },
    },
  })
  assert.equal(start.result, null)
  assert.ok(
    start.lines.some((l) => l.includes('its worker did not start')),
    start.lines.join('\n'),
  )

  const watch = await runOne(async () => {}, {
    orcaPatch: {
      workerShow: async () => {
        throw new Error('orca orchestration worker-show: 1')
      },
    },
  })
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
  const r = await runOne(
    async () => {
      throw new Error('the agent died')
    },
    { script },
  )
  assert.deepEqual(r.result, [null, null, 7, null])
  assert.ok(
    r.lines.some((l) => l.includes('thunk 0 threw (sync boom)')),
    r.lines.join('\n'),
  )
})

// A worker that submits a schema-valid result, whatever it is asked.
const submittingValue =
  (value) =>
  async ({ prompt, preamble, orca }) => {
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
  await runScript(script, { host: orca, stateDir: tmp(), out: () => {}, settings: FAST, permissionMode: 'auto' })
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
    await assert.rejects(runScript(`return await agent('x', ${opts})`, { host: orca, stateDir: tmp(), out: () => {} }), /unknown harness "codex"|refusing to type/)
    assert.equal(orca.calls.length, 0)
  }
})

// The CLI adapter with Orca's process replaced: every argv it would run is
// recorded, and each verb answers with the shape real Orca returns.
function recordingCli(replies = {}, { git, clock, platform, ...more } = {}) {
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
    return typeof reply === 'function' ? reply(args) : (reply ?? {})
  }
  return { argvs, orca: orcaCli({ call, git, clock, ...(platform ? { platform } : {}), ...more }) }
}
const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const verbsOf = (argvs) => argvs.map((a) => a.slice(0, 2).join(' '))
const START = { run: 'run_1', prompt: 'p', title: '[Implement] impl:#1', sessionId: SID }

test('orca-cli: a Claude worker with no permission mode starts from its own command line too, with its session id, never through --agent', { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = recordingCli()
  const w = await orca.workerStart({ ...START, harness: 'claude', model: 'opus', effort: 'low' })
  assert.deepEqual(verbsOf(argvs), ['terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(flag(argvs[0], '--command'), `claude --session-id ${SID} --model opus --effort low`)
  const start = argvs[2]
  assert.deepEqual([flag(start, '--worktree'), flag(start, '--terminal')], ['current', 'term_own'])
  for (const f of ['--agent', '--model', '--effort']) assert.equal(start.includes(f), false, `worker-start refuses ${f} beside --terminal`)
  assert.equal(w.terminal, 'term_own')
})

test('orca-cli: a worker with no session id is refused before Orca is called', { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = recordingCli()
  await assert.rejects(orca.workerStart({ ...START, sessionId: undefined }), /no session id/)
  assert.deepEqual(argvs, [])
})

test("orca-cli: a worker in the run's own worktree is named with that worktree's path, from its terminal", { skip: ORCA_SKIPPED }, async () => {
  const { orca } = recordingCli({ 'terminal create': { terminal: { handle: 'term_own', worktreeId: 'repo::C:/wt/run' } } })
  assert.equal((await orca.workerStart(START)).worktree, 'C:/wt/run')
})

test('orca-cli: a Claude worker starts in the given permission mode, in a terminal worker-start then supervises', { skip: ORCA_SKIPPED }, async () => {
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

test('orca-cli: a pi worker starts with project-local files trusted, its model and effort on its own command line', { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = recordingCli()
  await orca.workerStart({ ...START, harness: 'pi', model: 'openai/gpt-5', effort: 'low' })
  assert.equal(flag(argvs[0], '--command'), `pi --approve --session-id ${SID} --model openai/gpt-5 --thinking low`)
  assert.equal(flag(argvs[2], '--terminal'), 'term_own')

  const bare = recordingCli()
  await bare.orca.workerStart({ ...START, harness: 'pi' })
  assert.equal(flag(bare.argvs[0], '--command'), `pi --approve --session-id ${SID}`)
})

test('orca-cli: an agent whose TUI never goes idle is not dispatched, and its terminal is closed', { skip: ORCA_SKIPPED }, async () => {
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

test("worktrees: an isolated agent runs in an Orca child of the run's worktree, a non-isolated one in the run's own", async () => {
  const orca = worktreeOrca()
  await runScript(WT_SCRIPT, { host: orca, stateDir: tmp(), out: () => {}, settings: FAST })
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

test("worktrees: a dead agent's worktree is retained and named in the run's result, never removed", async () => {
  const lines = []
  const orca = worktreeOrca()
  const result = await runScript(WT_SCRIPT, { host: orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  const aPath = startedAs(orca, '[Implement] impl:a').worktree
  const bPath = startedAs(orca, '[Implement] impl:b').worktree

  assert.deepEqual(result.a, { worktree: aPath })
  assert.equal(result.b, null)
  assert.equal(result.removed, 1)
  assert.deepEqual(
    orca.calls.filter((c) => c.verb === 'worktreeRemove').map((c) => c.path),
    [aPath],
  )
  assert.equal(orca.worktrees.get(aPath).removed, true)
  assert.equal(orca.worktrees.get(bPath).removed, false)
  assert.equal(orca.worktrees.get('C:/fake/run').removed, false)

  assert.equal(result.worktrees_kept.length, 1)
  assert.equal(result.worktrees_kept[0].path, bPath)
  assert.match(result.worktrees_kept[0].reason, /^retained because its agent \(\[Implement\] impl:b\) died before reporting its path/)
  assert.ok(
    lines.some((l) => l.startsWith(`!! kept ${bPath}:`)),
    lines.join('\n'),
  )
})

// The entry point the skill launches in its own terminal. A script that starts
// no agent never reaches Orca, so the real adapter is safe here.
const RUNNER = fileURLToPath(new URL('../src/runner.mjs', import.meta.url))
function runEntry(body) {
  const dir = tmp()
  const script = join(dir, 'workflow.js')
  writeFileSync(script, body)
  const code = spawnSync(process.execPath, [RUNNER, script], { encoding: 'utf8' }).status
  const summaryPath = join(dir, 'orca-run', 'summary.json')
  return { code, summaryPath, script, summary: () => JSON.parse(readFileSync(summaryPath, 'utf8')) }
}

test("entry point: the run's result is written to summary.json in the state dir, naming the runner", () => {
  const r = runEntry(`log('hi')\nreturn { stack: [], n: 1 }`)
  assert.equal(r.code, 0)
  assert.deepEqual(r.summary(), { runner: 'session', host: 'orca', ok: true, result: { stack: [], n: 1 } })
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
test("entry point: runner.pid names this run's runner, and the skill's probe sees it dead once it exits", () => {
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
  test(`orca-cli: ${what} isolated in a child worktree runs its terminal in that child, made first`, { skip: ORCA_SKIPPED }, async () => {
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

test("orca-cli: a doctor's child worktree is created with setup skipped; any other follows the repo's setup policy", { skip: ORCA_SKIPPED }, async () => {
  for (const [child, setup] of [
    [{ ...CHILD, setup: 'skip' }, 'skip'],
    [CHILD, null],
  ]) {
    const { argvs, orca } = childCli()
    await orca.workerStart({ ...START, harness: 'claude', child })
    const [create] = argvs
    assert.deepEqual(verbsOf([create]), ['worktree create'])
    assert.equal(create.includes('--setup') ? flag(create, '--setup') : null, setup)
  }
})

// The run's chain worktree, as Orca holds it once made.
const CHAIN = 'C:/wt/run_1-chain'
function chainCli(create = () => ({ worktree: { id: `repo::${CHAIN}`, path: CHAIN }, startupTerminal: { handle: 'term_shell' } })) {
  let held = []
  return recordingCli(
    {
      'worktree list': () => ({ worktrees: held }),
      'worktree create': (args) => {
        held = [{ path: CHAIN, branch: 'refs/heads/run_1-chain' }]
        return create(args)
      },
    },
    { git: gitStub({ status: '?? setup.out\n' }).git },
  )
}

test("orca-cli: the run's chain worktree is made once, as <runId>-chain from the run's worktree under the repo's setup policy, its baseline taken; asked again, the same one", { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = chainCli()
  assert.deepEqual(await orca.chainWorktree({ runId: 'run_1' }), { path: CHAIN, made: true, baseline: ['?? setup.out'], warnings: [] })
  assert.deepEqual(verbsOf(argvs), ['worktree list', 'worktree create', 'terminal close'])
  const create = argvs[1]
  assert.deepEqual([flag(create, '--name'), flag(create, '--parent-worktree'), create.includes('--setup')], ['run_1-chain', 'current', false])
  argvs.length = 0
  assert.deepEqual(await orca.chainWorktree({ runId: 'run_1' }), { path: CHAIN, made: false, baseline: null, warnings: [] })
  assert.deepEqual(verbsOf(argvs), ['worktree list'])
})

test('orca-cli: a chain create answered too late is taken up as made, with a warning and no baseline, its setup maybe still running', { skip: ORCA_SKIPPED }, async () => {
  const { orca } = chainCli(() => {
    throw new OrcaError('call_timeout', 'killed after 120s', 'worktree create')
  })
  const r = await orca.chainWorktree({ runId: 'run_1' })
  assert.deepEqual([r.path, r.made, r.baseline, r.warnings.length], [CHAIN, true, null, 1])
})

test('orca-cli: a worker started in the chain runs its terminal there, making and setting no worktree, and a failed start never names the chain as its own', { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = chainCli()
  const w = await orca.workerStart({ ...START, harness: 'claude', chain: CHAIN })
  assert.deepEqual(verbsOf(argvs), ['terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.deepEqual([flag(argvs[0], '--worktree'), flag(argvs[2], '--worktree'), w.worktree], [`path:${CHAIN}`, `path:${CHAIN}`, CHAIN])
  const { orca: failing } = recordingCli({
    'orchestration worker-start': () => {
      throw new OrcaError('boom', '', 'orchestration worker-start')
    },
  })
  const e = await failing.workerStart({ ...START, harness: 'claude', chain: CHAIN }).catch((x) => x)
  assert.deepEqual([e.code, e.worktree, e.dispatched], ['boom', undefined, true])
})

test("orca-cli: the Run mailbox is checked from the runner's own terminal, each message tied to its dispatch by its payload, and an ack is answered with the next batch", { skip: ORCA_SKIPPED }, async () => {
  const row = (id, type, payload) => ({ id, run_id: 'run_1', delivery_contract: 'current_delivery', from_handle: 'term_d', to_handle: 'run:run_1', subject: 's', body: `body ${id}`, type, priority: 'normal', thread_id: null, payload, created_at: 'at', delivered_at: null })
  const { argvs, orca } = recordingCli({
    'orchestration check': (a) =>
      a.includes('--ack')
        ? { runId: 'run_1', deliveryId: null, messages: [], count: 0, acknowledged: 'delivery_A' }
        : {
            runId: 'run_1',
            deliveryId: 'delivery_A',
            replayed: true,
            acknowledged: null,
            count: 4,
            messages: [
              row('msg_1', 'handoff', JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1' })),
              row('msg_2', 'worker_done', JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'failed' })),
              row('msg_3', 'status', JSON.stringify({ _orcaLifecycleRejection: { code: 'sender_not_assignee' } })),
              row('msg_4', 'heartbeat', 'not json'),
            ],
          },
  })
  const got = await orca.mailCheck()
  assert.deepEqual(argvs.at(-1), ['orchestration', 'check'])
  assert.deepEqual([got.deliveryId, got.replayed, got.acknowledged], ['delivery_A', true, null])
  assert.deepEqual(
    got.messages.map((m) => [m.id, m.type, m.from, m.body, m.taskId, m.dispatchId, m.outcome]),
    [
      ['msg_1', 'handoff', 'term_d', 'body msg_1', 'task_1', 'ctx_1', null],
      ['msg_2', 'worker_done', 'term_d', 'body msg_2', 'task_1', 'ctx_1', 'failed'],
      ['msg_3', 'status', 'term_d', 'body msg_3', null, null, null],
      ['msg_4', 'heartbeat', 'term_d', 'body msg_4', null, null, null],
    ],
  )
  const next = await orca.mailCheck({ ack: 'delivery_A' })
  assert.deepEqual(argvs.at(-1), ['orchestration', 'check', '--ack', 'delivery_A'])
  assert.deepEqual([next.deliveryId, next.acknowledged, next.messages], [null, 'delivery_A', []])
})

test('orca-cli: a custom launch that fails after its child worktree was made names that worktree on the error', { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = childCli({ 'terminal wait': { wait: { satisfied: false } } })
  const e = await orca.workerStart({ ...START, harness: 'pi', child: CHILD }).catch((x) => x)
  assert.match(e.message, /agent_not_ready/)
  assert.equal(e.worktree, CHILD_PATH)
  assert.equal(e.dispatched, undefined, 'it failed before its worker-start was sent')
  assert.equal(flag(argvs.at(-1), '--terminal'), 'term_own', 'its agent terminal is closed')
})

test('orca-cli: a call Orca never answers fails as call_timeout on the clock; a start it hangs closes its terminal and names its worktree', { skip: ORCA_SKIPPED }, async () => {
  const clock = fakeClock()
  const { argvs, orca } = childCli({ 'orchestration worker-start': () => new Promise(() => {}) }, { clock })
  const e = await orca.workerStart({ ...START, child: CHILD }).catch((x) => x)
  assert.equal(e.code, 'call_timeout')
  assert.match(e.message, /^orca orchestration worker-start: call_timeout: no answer within 120s$/)
  assert.equal(clock.now(), RUNNER_SETTINGS.hostCallMs)
  assert.equal(e.worktree, CHILD_PATH)
  assert.equal(e.dispatched, true, 'Orca may have put a worker in it')
  assert.deepEqual(verbsOf(argvs).slice(-2), ['orchestration worker-start', 'terminal close'])
})

test('orca-cli: a worktree create is bounded by its own timeout; one that runs out after Orca made the worktree finds it by name, and the start carries on in it', { skip: ORCA_SKIPPED }, async () => {
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

test('orca-cli: a wait is bounded by the call timeout on top of the time it asks Orca to wait', { skip: ORCA_SKIPPED }, async () => {
  const clock = fakeClock()
  const { orca } = recordingCli({ 'terminal wait': () => new Promise(() => {}) }, { clock })
  await assert.rejects(orca.terminalIdle({ terminal: 'term_1', timeoutMs: 1_000 }), /call_timeout/)
  assert.equal(clock.now(), RUNNER_SETTINGS.hostCallMs + 1_000)
})

// git as the adapter runs it in a worktree: each command's stdout, by subcommand.
function gitStub(answers = {}) {
  const runs = []
  return { runs, git: async (cwd, args) => (runs.push([cwd, ...args]), answers[args[0]] ?? '') }
}
const EARLIER = {
  'worktree list': {
    worktrees: [
      { path: 'C:/wt/other', branch: 'refs/heads/u/other' },
      { path: CHILD_PATH, branch: 'refs/heads/u/run_1-3' },
    ],
  },
  'terminal list': { terminals: [{ handle: 'term_shell', title: 'Terminal 1', orphaned: false, connected: true }] },
}

test('orca-cli: a retried start takes up the clean worktree of its name, which a second create would have made <name>-2', { skip: ORCA_SKIPPED }, async () => {
  const g = gitStub({ status: '', 'rev-list': '0\n' })
  const { argvs, orca } = childCli(EARLIER, { git: g.git })
  const w = await orca.workerStart({ ...START, harness: 'pi', child: { ...CHILD, retry: true, dispatched: true } })
  assert.equal(w.worktree, CHILD_PATH)
  assert.deepEqual(verbsOf(argvs), ['worktree list', 'terminal list', 'worktree set', 'terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(flag(argvs[1], '--worktree'), `path:${CHILD_PATH}`)
  assert.equal(flag(argvs[3], '--worktree'), `path:${CHILD_PATH}`)
  assert.deepEqual(g.runs, [
    [CHILD_PATH, 'status', '--porcelain'],
    [CHILD_PATH, 'rev-list', '--count', 'HEAD', '--not', '--exclude=u/run_1-3', '--branches', '--remotes'],
  ])
  assert.deepEqual(w.warnings, [])

  const none = childCli({ ...EARLIER, 'worktree list': { worktrees: [] } }, { git: gitStub().git })
  await none.orca.workerStart({ ...START, child: { ...CHILD, retry: true } })
  assert.deepEqual(verbsOf(none.argvs).slice(0, 2), ['worktree list', 'worktree create'], 'a retry with no worktree of its name yet makes it')
})

test('orca-cli: a retry no earlier attempt of which sent its worker-start takes up its worktree whatever it holds, reading none of it', { skip: ORCA_SKIPPED }, async () => {
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

test('orca-cli: a retry after a worker-start was sent refuses a worktree of its name that holds work, for good, and one an agent still runs in, for this attempt', { skip: ORCA_SKIPPED }, async () => {
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

test("orca-cli: a child it creates has its porcelain taken as its baseline and handed on before the agent's terminal opens, and the prompt is made from it", { skip: ORCA_SKIPPED }, async () => {
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

test('orca-cli: a retry after a worker-start was sent takes up a worktree whose porcelain is still its baseline, and refuses one changed since, for good', { skip: ORCA_SKIPPED }, async () => {
  for (const [status, code] of [
    [` M package-lock.json\n?? node_modules/\n`, null],
    [`${SETUP.join('\n')}\n?? notes.txt\n`, 'worktree_dirty'],
    ['?? node_modules/\n', 'worktree_dirty'],
  ]) {
    const { argvs, orca } = childCli(EARLIER, { git: gitStub({ status, 'rev-list': '0\n' }).git })
    const got = await orca.workerStart({ ...START, prompt: (b) => `baseline: ${JSON.stringify(b)}`, child: { ...CHILD, retry: true, dispatched: true, baseline: SETUP } }).catch((x) => x)
    if (!code) {
      assert.equal(got.worktree, CHILD_PATH, 'the same lines in another order are its baseline')
      assert.equal(flag(argvs.at(-1), '--spec'), `baseline: ${JSON.stringify(SETUP)}`, 'a worktree taken up keeps the baseline it was made with')
      continue
    }
    assert.equal(got.code, code, status)
    assert.equal(got.final, true)
    assert.equal(got.message, `worktree reuse: worktree_dirty: ${CHILD_PATH} has changed since it was made`)
  }
  const commits = childCli(EARLIER, { git: gitStub({ status: `${SETUP.join('\n')}\n`, 'rev-list': '1\n' }).git })
  const e = await commits.orca.workerStart({ ...START, child: { ...CHILD, retry: true, dispatched: true, baseline: SETUP } }).catch((x) => x)
  assert.equal(e.code, 'worktree_has_commits', 'its baseline spares no commit')
})

test("orca-cli: a retry asks for Orca's whole worktree list, and a page still truncated fails the attempt, retryable, never read as 'not found'", { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = childCli({ 'worktree list': { worktrees: [{ path: 'C:/wt/other', branch: 'refs/heads/u/other' }], truncated: true } }, { git: gitStub().git })
  const e = await orca.workerStart({ ...START, child: { ...CHILD, retry: true } }).catch((x) => x)
  assert.equal(e.code, 'worktree_list_truncated')
  assert.match(e.message, /could not be ruled out/)
  assert.notEqual(e.final, true, 'a truncated page is retried')
  assert.deepEqual(argvs, [['worktree', 'list', '--limit', '10000']], 'no create, no terminal')
})

test('orca-cli: a create Orca answers with <name>-2 fails for good, naming the new worktree and the earlier one of its name', { skip: ORCA_SKIPPED }, async () => {
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

test('orca-cli: a display name Orca refuses is a warning the start returns, and the start goes on', { skip: ORCA_SKIPPED }, async () => {
  const { orca } = childCli({
    'worktree set': () => {
      throw new OrcaError('selector_not_found', 'gone', 'worktree set')
    },
  })
  const w = await orca.workerStart({ ...START, child: CHILD })
  assert.deepEqual(w.warnings, ["could not set its worktree's display name: orca worktree set: selector_not_found: gone"])
  assert.equal(w.terminal, 'term_own')
})

test("orca-cli: a worktree's board status is set by path", { skip: ORCA_SKIPPED }, async () => {
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
  test(`orca-cli: continuing a ${harness} session with its tab alive stops the process, then resumes the session in the same terminal and prompts it`, { skip: ORCA_SKIPPED }, async () => {
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

  test(`orca-cli: continuing a ${harness} session with its tab gone resumes it in a new terminal in the same worktree, which worker-start adopts`, { skip: ORCA_SKIPPED }, async () => {
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

test('orca-cli: a tab that refuses the continuation is taken for gone, and the session resumes in a new terminal', { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = recordingCli({
    'terminal send': () => {
      throw new OrcaError('terminal_not_writable', '', 'terminal send')
    },
  })
  const w = await orca.workerContinue(CONTINUE)
  assert.deepEqual(verbsOf(argvs).slice(-3), ['terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(w.reopened, true)
  const other = recordingCli({
    'terminal send': () => {
      throw new OrcaError('runtime_unavailable', '', 'terminal send')
    },
  })
  await assert.rejects(other.orca.workerContinue(CONTINUE), /runtime_unavailable/)
  assert.equal(verbsOf(other.argvs).includes('terminal create'), false)
})

// --- transcripts: where each harness writes one, found from its session id ---

test("transcripts: a Claude session is found under its worktree's project slug, or by scanning every project", () => {
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

test("transcripts: a pi session is found by its id in its worktree's session dir, whatever timestamp its name carries", () => {
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

test("transcripts: a Claude session's size counts its subagents' transcripts, so a background agent at work is movement", () => {
  const home = tmp()
  const wt = join(home, 'wt')
  const t = sessionTranscripts({ home, env: {} })
  const at = join(home, '.claude', 'projects', claudeSlug(wt), `${SID}.jsonl`)
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, 'abc\n')
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), 4, 'no subagents dir yet')
  const subs = join(dirname(at), SID, 'subagents')
  mkdirSync(subs, { recursive: true })
  writeFileSync(join(subs, 'agent-a1.jsonl'), 'xy\n')
  writeFileSync(join(subs, 'agent-a1.meta.json'), '{"not":"counted"}')
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), 7)
  appendFileSync(join(subs, 'agent-a1.jsonl'), 'z\n')
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), 9, 'the main transcript still, a subagent growing')
})

test("transcripts: a pi session's size counts its subagents' run sessions", () => {
  const home = tmp()
  const wt = join(home, 'wt')
  const t = sessionTranscripts({ home, env: {} })
  const at = join(home, '.pi', 'agent', 'sessions', piDir(wt), `2026-09-24T16-26-07-244Z_${SID}.jsonl`)
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, 'abc\n')
  assert.equal(t.size({ harness: 'pi', sessionId: SID, worktree: wt }), 4)
  const run = join(at.replace(/\.jsonl$/, ''), '5a2debb2', 'run-0')
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'session.jsonl'), 'xy\n')
  assert.equal(t.size({ harness: 'pi', sessionId: SID, worktree: wt }), 7)
  appendFileSync(join(run, 'session.jsonl'), 'z\n')
  assert.equal(t.size({ harness: 'pi', sessionId: SID, worktree: wt }), 9)
})

test("transcripts: a Claude session's size counts its background shells' output, so a worker waiting on one is movement", () => {
  const home = tmp()
  const wt = join(home, 'wt')
  const t = sessionTranscripts({ home, env: { CLAUDE_CODE_TMPDIR: join(home, 'tmp') } })
  const at = join(home, '.claude', 'projects', claudeSlug(wt), `${SID}.jsonl`)
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, 'abc\n')
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), 4, 'no background shell yet')
  // As Claude 2.1.286 names it when a Bash call runs in the background:
  // "Output is being written to: /tmp/claude-<uid>/<slug>/<id>/tasks/<task>.output".
  const tasks = join(home, 'tmp', `claude-${process.getuid()}`, claudeSlug(wt), SID, 'tasks')
  mkdirSync(tasks, { recursive: true })
  writeFileSync(join(tasks, 'b90ofhpmx.output'), 'xy\n')
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), 7)
  appendFileSync(join(tasks, 'b90ofhpmx.output'), 'z\n')
  assert.equal(t.size({ harness: 'claude', sessionId: SID, worktree: wt }), 9, 'the main transcript still, a background shell writing')
})

test("transcripts: a pi session's size counts its background tasks' output, kept by pi-background-tasks in its worktree", () => {
  const home = tmp()
  const wt = join(home, 'wt')
  const t = sessionTranscripts({ home, env: {} })
  const at = join(home, '.pi', 'agent', 'sessions', piDir(wt), `2026-09-24T16-26-07-244Z_${SID}.jsonl`)
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, 'abc\n')
  assert.equal(t.size({ harness: 'pi', sessionId: SID, worktree: wt }), 4)
  // pi-background-tasks keys the dir by the session id and pi's pid, so
  // another session's tasks in the same worktree are not this one's.
  const tasks = join(wt, '.pi', 'tasks', `${SID}-26857`)
  mkdirSync(tasks, { recursive: true })
  writeFileSync(join(tasks, 'b5d1c84a7.output'), 'xy\n')
  mkdirSync(join(wt, '.pi', 'tasks', 'other-session-1'), { recursive: true })
  writeFileSync(join(wt, '.pi', 'tasks', 'other-session-1', 'x.output'), 'not this session\n')
  assert.equal(t.size({ harness: 'pi', sessionId: SID, worktree: wt }), 7)
  appendFileSync(join(tasks, 'b5d1c84a7.output'), 'z\n')
  assert.equal(t.size({ harness: 'pi', sessionId: SID, worktree: wt }), 9)
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

const boardOrca = () =>
  fakeOrca({
    worker: async ({ prompt, preamble, worktree, orca }) => {
      if (prompt.startsWith('Die.')) throw new Error('the agent died')
      const pub = prompt.startsWith('Publish.') || prompt.startsWith('Refuse.')
      return submitValue(prompt, preamble, orca, pub ? { worktree, pr_url: 'https://x/pull/1', published: prompt.startsWith('Publish.') } : { worktree })
    },
  })

test('board status: in-progress while an isolated agent works, in-review for Gate, completed once it published', async () => {
  const orca = boardOrca()
  await runScript(BOARD_SCRIPT, { host: orca, stateDir: tmp(), out: () => {}, settings: FAST })
  const history = (title) => orca.calls.filter((c) => c.verb === 'worktreeStatus' && c.worktree === startedAs(orca, title).worktree).map((c) => c.status)
  assert.deepEqual(history('[Implement] impl'), ['in-progress'])
  assert.deepEqual(history('[Implement] dead'), ['in-progress'], "a dead agent's worktree is retained as it stood")
  assert.deepEqual(history('[Gate] gate'), ['in-review'])
  assert.deepEqual(history('[Stack] publish'), ['in-progress', 'completed'])
  assert.deepEqual(history('[Stack] held'), ['in-progress'], 'a publisher that did not publish is not done')
  assert.deepEqual(history('[Finalize] plain'), [], "the run's own worktree is never touched")
  assert.equal(orca.worktrees.get(startedAs(orca, '[Stack] publish').worktree).status, 'completed')
})

test('board status: a status Orca refuses is logged, and the agent still delivers', async () => {
  const lines = []
  const orca = boardOrca()
  orca.worktreeStatus = async () => {
    throw new Error('orca worktree set: selector_not_found')
  }
  const result = await runScript(BOARD_SCRIPT, { host: orca, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST })
  assert.equal(result.worktree, 'C:/fake/run')
  assert.ok(
    lines.some((l) => l.startsWith("!! [Gate] gate: could not set its worktree's board status to in-review")),
    lines.join('\n'),
  )
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
  assert.deepEqual(await runScript(chain('Build it.'), { host: first, stateDir, out: () => {}, settings: FAST }), ['Plan it. @1', null, 'Check it. @1'])
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const b = journal.filter((e) => e.key === journalKey('Build it.', { label: 'b', phase: 'Chain' }) && e.type !== 'started' && e.type !== 'starting')
  assert.deepEqual(
    b.map((e) => [e.type, 'result' in e]),
    [['failed', false]],
  )

  const lines = []
  run = 2
  const from = first.calls.length
  const result = await runScript(chain('Build it.'), { host: first.as('term_2'), stateDir, out: (s) => lines.push(s), settings: FAST, resume: true })
  assert.deepEqual(result, ['Plan it. @1', 'Build it. @2', 'Check it. @2'])
  assert.deepEqual(started(since(first, from)), ['[Chain] b', '[Chain] c'])
  assert.ok(lines.includes('>> [Chain] b: failed in the last run; this call and every one after it run live'), lines.join('\n'))
})

test("resume: a failed call keeps its place among identical calls, so a later one's result is never replayed into it", async () => {
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
  assert.deepEqual(await runScript(script, { host: orca, stateDir, out: () => {}, settings: FAST }), [null, 'Same. @1'])
  run = 2
  const from = orca.calls.length
  assert.deepEqual(await runScript(script, { host: orca.as('term_2'), stateDir, out: () => {}, settings: FAST, resume: true }), ['Same. @2', 'Same. @2'])
  assert.equal(started(since(orca, from)).length, 2)
})

test("resume: a dead agent's worktree from the earlier run stays named in the result, resume after resume", async () => {
  const stateDir = tmp()
  let run = 1
  const one = fakeOrca({
    worker: async (w) => (run === 1 ? worktreeWorker(w) : submitValue(w.prompt, w.preamble, w.orca, w.prompt.startsWith('Reclaim') ? { removed: 0 } : { worktree: w.worktree })),
  })
  const r1 = await runScript(WT_SCRIPT, { host: one, stateDir, out: () => {}, settings: FAST })
  const deadPath = startedAs(one, '[Implement] impl:b').worktree
  assert.deepEqual(
    r1.worktrees_kept.map((k) => k.path),
    [deadPath],
  )

  // impl:b re-runs live in a new worktree of the same Run, numbered past the
  // last run's calls so its name is never the dead one's, and delivers; its
  // old one is still on disk.
  run = 2
  const lines = []
  const r2 = await runScript(WT_SCRIPT, { host: one.as('term_2'), stateDir, out: (s) => lines.push(s), settings: FAST, resume: true })
  assert.notEqual(r2.b.worktree, deadPath)
  assert.equal(one.worktrees.get(deadPath).removed, false)
  assert.deepEqual(
    r2.worktrees_kept.map((k) => k.path),
    [deadPath],
  )
  assert.match(r2.worktrees_kept[0].reason, /impl:b\) died before reporting/)
  assert.ok(
    lines.some((l) => l.startsWith(`!! kept ${deadPath}:`)),
    lines.join('\n'),
  )

  const from = one.calls.length
  const r3 = await runScript(WT_SCRIPT, { host: one.as('term_3'), stateDir, out: () => {}, settings: FAST, resume: true })
  assert.deepEqual(since(one, from).calls, [], 'everything replays')
  assert.deepEqual(
    r3.worktrees_kept.map((k) => k.path),
    [deadPath],
  )
})

test('worktrees: a worktree made for a worker that never started is retained and named', async () => {
  const orca = fakeOrca()
  orca.workerStart = async () => {
    throw Object.assign(new Error('orca terminal wait: agent_not_ready'), { worktree: 'C:/fake/worktrees/orphan' })
  }
  const script = `const a = await agent('Build.', { label: 'impl', phase: 'Implement', isolation: 'worktree' })
return { a, worktrees_kept: [] }`
  const result = await runScript(script, { host: orca, stateDir: tmp(), out: () => {}, settings: FAST, clock: fakeClock() })
  assert.equal(result.a, null)
  assert.deepEqual(
    result.worktrees_kept.map((k) => k.path),
    ['C:/fake/worktrees/orphan'],
  )
  assert.match(result.worktrees_kept[0].reason, /whose worker never started/)
})

test('worktrees: a run that throws still names what it kept, and its failure summary carries it', async () => {
  const orca = worktreeOrca()
  const script = `const b = await agent('Build b.', { label: 'layer0', phase: 'Setup', schema: ${JSON.stringify(WT_SCHEMA)}, isolation: 'worktree' })
if (!b) throw new Error('layer-0 PR failed')
return b`
  const e = await runScript(script, { host: orca, stateDir: tmp(), out: () => {}, settings: FAST }).catch((x) => x)
  assert.match(e.message, /layer-0 PR failed/)
  const deadPath = startedAs(orca, '[Setup] layer0').worktree
  const summary = failureSummary(e, 'orca')
  assert.equal(summary.runner, 'session')
  assert.equal(summary.host, 'orca')
  assert.equal(summary.ok, false)
  assert.match(summary.error, /layer-0 PR failed/)
  assert.deepEqual(
    summary.worktrees_kept.map((k) => k.path),
    [deadPath],
  )
  assert.match(summary.worktrees_kept[0].reason, /layer0\) died before reporting/)
})

test('one run: a Run its host cannot create is named by that host, never as Orca', async () => {
  const lines = []
  const host = fakeOrca({ worker: submitting() })
  host.name = 'crew'
  const create = host.runCreate
  let tries = 0
  host.runCreate = async (a) => {
    if (++tries <= RUNNER_SETTINGS.retryBackoffMs.length + 1) throw new Error('crew: daemon_busy: try later')
    return create(a)
  }
  const script = `const S = ${JSON.stringify(SCHEMA)}
return [await agent('Name a thing.', { label: 'a', schema: S }), await agent('Name a thing.', { label: 'b', schema: S })]`
  assert.deepEqual(await runScript(script, { host, stateDir: tmp(), out: (s) => lines.push(s), settings: FAST, clock: fakeClock() }), [null, GOOD])
  assert.ok(
    lines.some((l) => l.includes("[Run] a: crew could not create this run's Run")),
    lines.join('\n'),
  )
  assert.ok(!lines.some((l) => /\bOrca\b/.test(l)), lines.join('\n'))
})

test('worktree: a refused take-up is a host-neutral WorktreeError, never an OrcaError or an outage, and the crew host reaches it without orca-cli', async () => {
  const probes = (o) => ({ held: async () => false, lines: async () => [], commits: async () => 0, ...o })
  const held = await reuseWorktree('/wt', { dispatched: false, baseline: null }, probes({ held: async () => true })).catch((x) => x)
  assert.ok(held instanceof WorktreeError && !(held instanceof OrcaError))
  assert.deepEqual([held.message, held.code, held.final, held.worktree], ['worktree reuse: worktree_held: /wt still has an agent running in it', 'worktree_held', false, '/wt'])
  assert.equal(orcaUnreachable(held), false)
  const dirty = await reuseWorktree('/wt', { dispatched: true, baseline: null }, probes({ lines: async () => ['?? x'] })).catch((x) => x)
  assert.deepEqual([dirty.code, dirty.final], ['worktree_dirty', true])
  assert.equal(await reuseWorktree('/wt', { dispatched: true, baseline: ['?? x'] }, probes({ lines: async () => ['?? x'] })), '/wt')
  const crewHost = readFileSync(fileURLToPath(new URL('../src/crew-host.mjs', import.meta.url)), 'utf8')
  assert.ok(!/from '\.\/orca-cli\.mjs'/.test(crewHost), 'the crew host imports nothing of the Orca adapter')
})

test('worktree: prepareWorktree copies the MCP answers, warns on a failure, and takes and hands over the baseline', async () => {
  const project = tmp()
  const worktree = tmp()
  const seen = []
  const warnings = []
  const bound = { git: async (cwd, args) => (assert.deepEqual([cwd, args], [worktree, ['status', '--porcelain']]), ' M a\r\n?? b\n') }
  const broken = {
    existsSync: () => {
      throw new Error('disk gone')
    },
  }
  const lines = await prepareWorktree({ project, worktree, bound, onBaseline: (b) => seen.push(b), warnings, fs: broken })
  assert.deepEqual(lines, [' M a', '?? b'])
  assert.deepEqual(seen, [{ worktree, lines }])
  assert.deepEqual(warnings, ["could not copy the project's MCP server answers into its worktree: disk gone"])
})

test("one run: a Run Orca cannot create, retries included, is that agent's null, and the next agent() creates it", async () => {
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
  assert.deepEqual(await runScript(script, { host: orca, stateDir, out: (s) => lines.push(s), settings: FAST, clock: fakeClock() }), [null, GOOD])
  assert.equal(tries, attempts + 1)
  assert.deepEqual(started(orca), ['[Run] b'])
  assert.ok(
    lines.some((l) => l.includes("[Run] a: Orca could not create this run's Run") && l.includes('runtime_unavailable')),
    lines.join('\n'),
  )
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  assert.deepEqual(
    journal.filter((e) => e.title === '[Run] a').map((e) => e.type),
    [...Array(attempts - 1).fill('retry'), 'failed'],
  )
})

// The lifecycle module on its own: one agent call in, its value or null out,
// with the journal and the retained list as plain arrays.
function lifecycleOn(orca, settings = FAST) {
  const journal = []
  const kept = []
  const lines = []
  const life = agentLifecycle({
    host: orca,
    clock: fakeClock(),
    limits: { ...SETTINGS, ...settings },
    out: (s) => lines.push(s),
    stateDir: tmp(),
    objective: () => 'the objective',
    journal: (e) => journal.push(e),
    retainWorktree: (k) => (kept.push(k), k),
    transcripts: fakeTranscripts(orca),
  })
  let n = 0
  const call = (label, more = {}) => {
    const i = ++n
    return { prompt: 'Name a thing.', schema: SCHEMA, isolation: 'none', launch: { harness: 'claude', permissionMode: 'auto' }, key: `k${i}`, n: i, label, title: `[P] ${label}`, phaseName: 'P', ...more }
  }
  return { life, call, journal, kept, lines }
}

test('lifecycle: a call journals started then its result, and returns the value once its worker settles, never releasing it', async () => {
  const orca = fakeOrca({ worker: submitting() })
  const { life, call, journal } = lifecycleOn(orca)
  assert.deepEqual(await life(call('a')), GOOD)
  assert.deepEqual(
    journal.map((e) => [e.type, e.title]),
    [
      ['starting', '[P] a'],
      ['started', '[P] a'],
      ['result', '[P] a'],
    ],
  )
  assert.deepEqual(journal[2].result, GOOD)
  const verbs = orca.calls.map((c) => c.verb)
  assert.deepEqual([verbs[0], verbs[1], verbs.at(-1)], ['runCreate', 'workerStart', 'workerShow'])
  assert.equal(verbs.includes('workerRelease'), false)
  assert.deepEqual([journal[0].run, journal[1].run], ['run_fake1', 'run_fake1'])
  assert.equal(orca.calls[0].objective, 'the objective')
})

test("lifecycle: the run's chain worktree is made once for every call that asks, in its Run, and its baseline journaled once", async () => {
  const orca = fakeOrca({ worker: submitting(), setupLeaves: ['?? setup.out'] })
  const { life, call, journal } = lifecycleOn(orca)
  const [a, b] = await Promise.all([life.chain(call('a')), life.chain(call('b'))])
  assert.equal(a, b)
  assert.equal(a.path, 'C:/fake/worktrees/run_fake1-chain')
  assert.deepEqual(
    orca.calls.filter((c) => ['runCreate', 'worktreeCreate'].includes(c.verb)).map((c) => c.verb),
    ['runCreate', 'worktreeCreate'],
  )
  assert.deepEqual(journal, [{ type: 'chain', runId: 'run_fake1', worktree: a.path, lines: ['?? setup.out'] }])
  assert.deepEqual(foldJournal(journal).chain, { runId: 'run_fake1', worktree: a.path, baseline: ['?? setup.out'], leftovers: [] })
  assert.equal(foldJournal([]).chain, null)
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
  assert.deepEqual(
    journal.map((e) => [e.type, e.title]),
    [
      ['retry', '[P] a'],
      ['retry', '[P] a'],
      ['retry', '[P] a'],
      ['failed', '[P] a'],
      ['starting', '[P] b'],
      ['started', '[P] b'],
      ['result', '[P] b'],
    ],
  )
  assert.equal(journal[3].attempts, 4)
})

test('lifecycle: calls waiting on the same Run share its creation and its retries', async () => {
  const orca = fakeOrca({ worker: submitting(), faults: { runCreate: ({ count }) => count === 1 && new Error('runtime_unavailable') } })
  const { life, call, journal } = lifecycleOn(orca)
  assert.deepEqual(await Promise.all([life(call('a')), life(call('b'))]), [GOOD, GOOD])
  assert.equal(orca.calls.filter((c) => c.verb === 'runCreate').length, 1)
  assert.deepEqual(
    journal.filter((e) => e.type === 'retry').map((e) => e.title),
    ['[P] a'],
  )
})

test('lifecycle: calls share one Run and the live cap, and a queued call starts only once the live one settles', async () => {
  const orca = fakeOrca({ worker: submitting(5) })
  const { life, call, lines, journal } = lifecycleOn(orca, { ...FAST, MAX_LIVE: 1 })
  assert.deepEqual(await Promise.all([life(call('a')), life(call('b'))]), [GOOD, GOOD])
  assert.equal(orca.calls.filter((c) => c.verb === 'runCreate').length, 1)
  assert.equal(liveHighWater(orca.calls), 1)
  assert.deepEqual(
    lines.filter((l) => l.endsWith('queued, 1 agents are live')),
    ['.. [P] b: queued, 1 agents are live'],
  )
  assert.deepEqual(
    journal.filter((e) => e.title === '[P] b').map((e) => e.type),
    ['queued', 'starting', 'started', 'result'],
  )
  assert.equal(
    journal.some((e) => e.title === '[P] a' && e.type === 'queued'),
    false,
  )
})

test('lifecycle: an isolated worker that never started leaves its worktree retained, and on its failed journal line', async () => {
  const orca = fakeOrca()
  orca.workerStart = async () => {
    throw Object.assign(new Error('agent_not_ready'), { worktree: 'C:/fake/worktrees/orphan' })
  }
  const { life, call, journal, kept } = lifecycleOn(orca, { ...FAST, ...NO_DOCTOR })
  assert.equal(await life(call('impl', { isolation: 'worktree' })), null)
  assert.deepEqual(
    kept.map((k) => k.path),
    ['C:/fake/worktrees/orphan'],
  )
  assert.deepEqual(
    journal.map((e) => e.type),
    ['starting', 'retry', 'retry', 'retry', 'failed'],
    'a worker that never started has no started line',
  )
  assert.equal(journal[4].retained, kept[0])
  assert.equal(journal[4].reason, 'its worker did not start: agent_not_ready')
})

// The CLI adapter's own workerStart, whose create names each worktree as asked.
const cliStart = (replies) => childCli({ 'worktree create': (args) => ({ worktree: { path: `C:/wt/${flag(args, '--name')}` } }), ...replies }, { git: gitStub().git }).orca.workerStart

test("lifecycle: a retry whose worktree list is truncated journals retry, then failed with that reason, and keeps the first attempt's worktree", async () => {
  const orca = fakeOrca()
  orca.workerStart = cliStart({ 'terminal wait': { wait: { satisfied: false } }, 'worktree list': { worktrees: [], truncated: true } })
  const { life, call, journal, kept } = lifecycleOn(orca, { ...FAST, ...NO_DOCTOR })
  assert.equal(await life(call('impl', { isolation: 'worktree' })), null)
  assert.deepEqual(
    journal.map((e) => e.type),
    ['starting', 'baseline', 'retry', 'retry', 'retry', 'failed'],
  )
  assert.match(journal[3].reason, /worktree_list_truncated/)
  assert.match(journal[4].reason, /worktree_list_truncated/)
  assert.equal(kept.length, 1)
  assert.equal(journal[5].retained, kept[0])
})

test('lifecycle: a create Orca answers under a suffixed name fails at once, retaining both worktrees', async () => {
  const orca = fakeOrca()
  orca.workerStart = cliStart({ 'worktree create': (args) => ({ worktree: { path: `C:/wt/${flag(args, '--name')}-2` } }) })
  const { life, call, journal, kept } = lifecycleOn(orca, { ...FAST, ...NO_DOCTOR })
  assert.equal(await life(call('impl', { isolation: 'worktree' })), null)
  assert.deepEqual(
    journal.map((e) => e.type),
    ['starting', 'failed', 'retained'],
    'final: never retried into a -3',
  )
  assert.match(journal[1].reason, /worktree_name_taken/)
  const name = journal[1].reason.match(/asked for (\S+),/)[1]
  assert.deepEqual(
    kept.map((k) => k.path),
    [`C:/wt/${name}-2`, `C:/wt/${name}`],
  )
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
  assert.deepEqual(
    r.journal.map((e) => [e.type, e.at]),
    [
      ['run', iso(0)],
      ['starting', iso(0)],
      ['started', iso(0)],
      ['nudge', at(n1)],
      ['continued', at(c1)],
      ['nudge', at(n2)],
      ['continued', at(c2)],
      ['nudge', at(n3)],
      ['continued', at(c3)],
      ['nudge', at(n4)],
      ['failed', r.journal.at(-1).at],
    ],
  )
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
      assert.deepEqual({ dispatchId: e.dispatchId, harness: e.harness, sessionId: e.sessionId, worktree: e.worktree, terminal: e.terminal }, { dispatchId: d.dispatchId, harness: i < 2 ? 'claude' : 'pi', sessionId: s.sessionId, worktree: d.worktree, terminal: d.handle })
      assert.match(e.sessionId, UUID)
      // The custom path, with or without a mode: the harness command carries the id.
      assert.ok(s.command.startsWith(i < 2 ? `claude --session-id ${e.sessionId}` : `pi --approve --session-id ${e.sessionId}`), s.command)
      assert.equal(s.argv.includes('--agent'), false)
      assert.equal(s.argv[s.argv.indexOf('--terminal') + 1], d.handle)
    }
    assert.equal(new Set(journaled.map((e) => e.sessionId)).size, 4, 'every worker has its own session')
    assert.deepEqual(
      journaled.map((e) => e.worktree === 'C:/fake/run'),
      [true, false, true, false],
    )
  }
})

test('fake orca: a worker start without a runner-assigned session id is refused', { skip: ORCA_SKIPPED }, async () => {
  const orca = fakeOrca()
  await assert.rejects(orca.workerStart({ run: 'run_fake', prompt: '', title: 't' }), /without a runner-assigned --session-id/)
  assert.deepEqual(orca.calls, [])
})

// Every way agent() returns null, the failed entry it leaves, and how many
// attempts it made: a start or a Run creation is retried, a started worker never.
const ATTEMPTS = RUNNER_SETTINGS.retryBackoffMs.length + 1
const FAILURES = [
  [
    'never started',
    async () => {},
    {
      orcaPatch: {
        workerStart: async () => {
          throw new Error('orca orchestration worker-start: outcome_unknown')
        },
      },
    },
    /^its worker did not start: orca orchestration worker-start: outcome_unknown$/,
    ATTEMPTS,
  ],
  [
    'died past the continuation cap',
    async function dies({ state }) {
      state.gone = true
      state.onContinue = dies
    },
    {},
    /^its terminal is gone, and its session was already continued 3 times, the cap of 3, with no result$/,
    1,
  ],
  ['stuck past the continuation cap', async () => {}, {}, /^no movement in its transcript or terminal for 40 minutes, and its session was already continued 3 times, the cap of 3, with no result$/, 1],
  [
    'blocked on a human',
    async ({ state }) => {
      state.waiting = '{"evidence":"hook"}'
    },
    {},
    /^blocked on a human, unanswered for 30 minutes, with no result$/,
    1,
  ],
  [
    'invalid result',
    async ({ prompt, preamble, orca }) => {
      const argv = submitArgvIn(prompt, preamble)
      writeFileSync(argv[argv.indexOf('--result') + 1], JSON.stringify(BAD))
      await orca.workerDone({ from: preamble.handle, capability: preamble.capability, taskId: preamble.taskId, dispatchId: preamble.dispatchId, subject: 's', body: 'b' })
    },
    {},
    /^recorded result fails its schema: .*\$\.count: expected integer, got string.* \(outcome succeeded\)$/,
    1,
  ],
  [
    'Run creation failed',
    async () => {},
    {
      orcaPatch: {
        runCreate: async () => {
          throw new Error('orca orchestration run-create: runtime_unavailable')
        },
      },
    },
    /^Orca could not create this run's Run: orca orchestration run-create: runtime_unavailable$/,
    ATTEMPTS,
  ],
]

for (const [what, worker, opts, reason, attempts] of FAILURES) {
  test(`journal: a call that ends in null (${what}) is journaled failed with its reason and attempt count`, async () => {
    const r = await runOne(withDoctor(worker), opts)
    assert.equal(r.result, null)
    assertEntries(r.journal)
    // Its doctors' own lines aside: those of a doctor that never starts either.
    const failed = r.journal.filter((e) => e.type === 'failed' && e.patient == null)
    assert.equal(failed.length, 1)
    assert.match(failed[0].reason, reason)
    assert.equal(failed[0].attempts, attempts)
    assert.equal(r.journal.filter((e) => e.type === 'retry' && e.n === failed[0].n).length, attempts - 1)
    assert.equal(
      r.journal.some((e) => e.type === 'started'),
      what !== 'never started' && what !== 'Run creation failed',
    )
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
  const doctor = async (w) => {
    w.clock.at(w.clock.now() + 15 * MIN, () => givesUp(w))
  }
  const r = await runOne(
    withDoctor(async (w) => {
      if (w.prompt.startsWith('Patient.')) return diesPastCap(w)
      if (w.prompt.startsWith('Independent.')) return void w.clock.at(30 * MIN, () => submitGood(w))
      return submitGood(w)
    }, doctor),
    { script },
  )
  assert.deepEqual(r.result, { p: null, d: GOOD, i: GOOD })
  assertEntries(r.journal)
  const titled = (title, type) => indexOf(r.journal, (e) => e.title === title && e.type === type)
  const rounds = ofType(r.journal, 'doctor')
  assert.deepEqual(
    rounds.map((e) => [e.n, e.title, e.round]),
    [1, 2, 3].map((round) => [1, '[P] patient', round]),
  )
  // Pending: the patient's call fails only once its last doctor gave up.
  const failed = titled('[P] patient', 'failed')
  assert.ok(indexOf(r.journal, (e) => e.type === 'gaveUp' && e.round === 3) < failed)
  assert.equal(
    indexOf(r.journal, (e) => e.type === 'failed' && e.title === '[P] patient'),
    failed,
  )
  assert.ok(titled('[P] patient', 'doctor') < titled('[P] independent', 'result'), 'the independent agent delivered while a doctor worked')
  assert.ok(titled('[P] independent', 'result') < failed)
  assert.ok(failed < titled('[P] dependent', 'starting'), 'the dependent started only once the patient resolved')
  // The fold links each doctor to its patient.
  const agents = foldJournal(r.journal).agents
  const patient = agents.find((a) => a.title === '[P] patient')
  assert.deepEqual(
    patient.doctors,
    rounds.map((e) => e.doctor),
  )
  assert.equal(patient.round, 3)
  for (const n of patient.doctors) assert.equal(agents.find((a) => a.origin === n).patient, patient.origin)
})

test('doctor: a resume carries each earlier doctor forward with its patient, resume after resume, and the run view keeps it under that patient', async () => {
  const stateDir = tmp()
  const clock = fakeClock()
  const orca = fakeOrca({ worker: (w) => withDoctor(diesPastCap)({ ...w, clock }), clock })
  const script = `return await agent('Patient.', { label: 'patient', phase: 'P', schema: ${JSON.stringify(SCHEMA)} })`
  const opts = { stateDir, out: () => {}, clock, transcripts: fakeTranscripts(orca) }
  assert.equal(await runScript(script, { ...opts, host: orca }), null)
  for (const [i, from] of ['term_2', 'term_3'].entries()) {
    assert.equal(await runScript(script, { ...opts, host: orca.as(from), resume: true }), null)
    const agents = foldJournal(journalOf(stateDir)).agents
    const patients = agents.filter((a) => a.title === '[P] patient')
    assert.equal(patients.length, i + 2, 'the patient runs live again on each resume')
    for (const p of patients) {
      assert.equal(p.doctors.length, 3)
      for (const d of p.doctors) assert.equal(agents.find((a) => a.origin === d).patient, p.origin)
    }
    const view = runView({ stateDir, host: orca, clock, transcripts: sessionTranscripts({ home: tmp(), env: {} }), registry: null, alive: () => false })
    await view.refresh()
    assert.deepEqual(
      view.model.rows.slice(1).map((r) => [r.depth, r.agent.patient]),
      patients.flatMap((p) => [[0, null], ...p.doctors.map(() => [1, p.origin])]),
    )
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
    const r = await runOne(
      withDoctor((w) => (w.prompt.startsWith('Patient.') ? diesPastCap(w) : submitGood(w))),
      { script },
    )
    assert.equal(r.result, null)
    const creates = r.orca.calls.filter((c) => c.verb === 'worktreeCreate')
    assert.deepEqual(
      creates.map((c) => [c.name, c.setup]),
      [
        ['run_fake1-1', null],
        ['run_fake1-2', null],
        ['run_fake1-3', 'skip'],
        ['run_fake1-4', 'skip'],
        ['run_fake1-5', 'skip'],
      ],
    )
    const doctors = r.orca.calls.filter((c) => c.verb === 'workerStart').slice(2)
    assert.equal(doctors.length, 3)
    for (const [i, d] of doctors.entries()) {
      assert.equal(d.title, '[Implement] recover -> impl:#7')
      assert.equal(d.worktree, `C:/fake/worktrees/run_fake1-${i + 3}`)
      assert.equal(r.orca.worktrees.get(d.worktree).displayName, '[Implement] recover -> impl:#7')
      assert.deepEqual({ harness: d.harness, model: d.model, ...(launch.effort && { effort: d.effort }) }, launch)
    }
    assert.deepEqual(
      ofType(r.journal, 'doctor').map((e) => e.doctor),
      [3, 4, 5],
    )
  })
}

test('sequential run: every chain agent starts in the one <runId>-chain, made once with its setup, and told its setup leftovers; a worktree agent still gets its own <runId>-<n>', async () => {
  const script = `const S = ${JSON.stringify(SCHEMA)}
await agent('Build a.', { label: 'impl:#1', phase: 'Implement', schema: S, isolation: 'chain' })
await agent('Publish a.', { label: 'publish:#1', phase: 'Stack', schema: S, isolation: 'chain' })
await agent('Own a.', { label: 'own', phase: 'Implement', schema: S, isolation: 'worktree' })
return await agent('Build b.', { label: 'impl:#2', phase: 'Implement', schema: S, isolation: 'chain' })`
  const r = await runOne(submitGood, { script, setupLeaves: ['?? setup.out'] })
  assert.deepEqual(r.result, GOOD)
  const starts = r.orca.calls.filter((c) => c.verb === 'workerStart')
  assert.deepEqual(
    starts.map((c) => [c.title, c.placement, c.worktree]),
    [
      ['[Implement] impl:#1', 'chain', 'C:/fake/worktrees/run_fake1-chain'],
      ['[Stack] publish:#1', 'chain', 'C:/fake/worktrees/run_fake1-chain'],
      ['[Implement] own', 'new-child', 'C:/fake/worktrees/run_fake1-3'],
      ['[Implement] impl:#2', 'chain', 'C:/fake/worktrees/run_fake1-chain'],
    ],
  )
  assert.deepEqual(
    r.orca.calls.filter((c) => c.verb === 'worktreeCreate').map((c) => c.name),
    ['run_fake1-chain', 'run_fake1-3'],
  )
  assert.deepEqual(
    ofType(r.journal, 'chain').map((e) => e.worktree),
    ['C:/fake/worktrees/run_fake1-chain'],
  )
  for (const s of starts) assert.match(r.orca.dispatches.get(s.dispatchId).prompt, /left by its setup: setup\.out/, s.title)
  assert.deepEqual(
    ofType(r.journal, 'started').map((e) => e.worktree),
    starts.map((s) => s.worktree),
  )
})

// The leftover check (#127). Two chain agents; the first, 'Build a.', plays
// `first`, handed the chain's porcelain lines, and the second submits clean.
const TWO_CHAINED = `const S = ${JSON.stringify(SCHEMA)}
await agent('Build a.', { label: 'impl:#1', phase: 'Implement', schema: S, isolation: 'chain' })
return await agent('Build b.', { label: 'impl:#2', phase: 'Implement', schema: S, isolation: 'chain' })`
const leaving = (first) => (w) => (w.prompt.startsWith('Build a.') ? first({ ...w, lines: w.orca.worktrees.get(w.worktree).porcelain }) : submitGood(w))
// Leaves tmp.log behind and submits; sent back, it runs `cleanUp` and its turn ends.
const leavesTmp = (cleanUp = () => {}) =>
  leaving(async (w) => {
    w.lines.push('?? tmp.log')
    w.state.onNudge = (text) => {
      cleanUp(w.lines, text)
      w.state.idle = true
    }
    await submitGood(w)
  })
const followUps = (r) => r.nudges.filter((c) => c.text.startsWith('Your result is in'))

test('leftover check: a chain agent that returns clean is looked at before the next starts, and sent no follow-up', async () => {
  const r = await runOne(submitGood, { script: TWO_CHAINED, setupLeaves: ['?? setup.out'] })
  assert.deepEqual(r.result, GOOD)
  const verbs = r.orca.calls.filter((c) => c.verb === 'workerStart' || c.verb === 'worktreeLines').map((c) => c.verb)
  assert.deepEqual(verbs, ['workerStart', 'worktreeLines', 'workerStart', 'worktreeLines'])
  assert.deepEqual(r.nudges, [])
  assert.deepEqual([...ofType(r.journal, 'followUp'), ...ofType(r.journal, 'leftover')], [])
})

test('leftover check: a chain agent that leaves a file is sent back once, in its own session, and cleans it up before the next starts', async () => {
  const r = await runOne(
    leavesTmp((lines) => lines.splice(lines.indexOf('?? tmp.log'), 1)),
    { script: TWO_CHAINED, setupLeaves: ['?? setup.out'] },
  )
  assert.deepEqual(r.result, GOOD)
  const [first, second] = r.orca.calls.filter((c) => c.verb === 'workerStart')
  const sent = followUps(r)
  assert.deepEqual(
    sent.map((c) => c.dispatchId),
    [first.dispatchId],
  )
  assert.match(sent[0].text, /left these files uncommitted .*: tmp\.log\. Commit the ones that are your work and remove the rest/)
  assert.doesNotMatch(sent[0].text, /setup\.out/, 'the baseline is never its to clean')
  assert.ok(r.orca.calls.indexOf(r.orca.calls.find((c) => c.verb === 'terminalSend')) < r.orca.calls.indexOf(second), 'the follow-up comes before the next agent starts')
  assert.deepEqual(
    ofType(r.journal, 'followUp').map((e) => [e.title, e.lines]),
    [['[Implement] impl:#1', ['?? tmp.log']]],
  )
  assert.deepEqual(ofType(r.journal, 'leftover'), [])
  assert.ok(
    r.log.some((l) => l.includes('[Implement] impl:#1: the chain worktree is clean after its follow-up')),
    r.log.join('\n'),
  )
  assert.doesNotMatch(r.orca.dispatches.get(second.dispatchId).prompt, /tmp\.log/)
})

test('leftover check: a file still there after the one follow-up is logged, journaled and told to the next chain agent never to commit', async () => {
  const r = await runOne(leavesTmp(), { script: TWO_CHAINED, setupLeaves: ['?? setup.out'] })
  assert.deepEqual(r.result, GOOD)
  const [first, second] = r.orca.calls.filter((c) => c.verb === 'workerStart')
  assert.deepEqual(
    followUps(r).map((c) => c.dispatchId),
    [first.dispatchId],
    'exactly one follow-up, and none for the clean second agent',
  )
  assert.deepEqual(
    ofType(r.journal, 'leftover').map((e) => [e.title, e.worktree, e.lines]),
    [['[Implement] impl:#1', 'C:/fake/worktrees/run_fake1-chain', ['?? tmp.log']]],
  )
  assert.ok(
    r.log.some((l) => l.includes('[Implement] impl:#1: left tmp.log uncommitted in the chain worktree after its follow-up; every later chain agent is told never to commit them')),
    r.log.join('\n'),
  )
  const told = r.orca.dispatches.get(second.dispatchId).prompt
  assert.match(told, /left by its setup: setup\.out\. These files were left uncommitted in your worktree by an agent before you: tmp\.log\. They are not your work, so never stage or commit them/)
  assert.deepEqual(foldJournal(r.journal).chain.leftovers, ['?? tmp.log'])
})

test('leftover check: a chain agent still busy with its follow-up past followUpMs is stopped before the next chain agent starts, and what it left is read then', async () => {
  const r = await runOne(
    leaving(async (w) => {
      w.lines.push('?? tmp.log')
      w.state.onNudge = () => {
        w.state.idle = false
      }
      await submitGood(w)
    }),
    { script: TWO_CHAINED, setupLeaves: ['?? setup.out'] },
  )
  assert.deepEqual(r.result, GOOD)
  const [first, second] = r.orca.calls.filter((c) => c.verb === 'workerStart')
  const stop = r.orca.calls.findIndex((c) => c.verb === 'workerStop' && c.dispatchId === first.dispatchId)
  assert.ok(stop >= 0 && stop < r.orca.calls.indexOf(second), 'the busy agent is stopped before the next one starts in its worktree')
  assert.ok(
    r.log.some((l) => l.includes('[Implement] impl:#1: still busy with its follow-up after 10 minutes; stopping it')),
    r.log.join('\n'),
  )
  assert.deepEqual(
    ofType(r.journal, 'leftover').map((e) => e.lines),
    [['?? tmp.log']],
  )
})

test('sequential run: a chain the host made with no baseline (its create answered too late) is journaled all the same, and no chain agent is told to remove what its setup left', async () => {
  const r = await runOne(submitGood, {
    script: TWO_CHAINED,
    setupLeaves: ['?? setup.out'],
    orcaPatch: (orca) => {
      const made = orca.chainWorktree
      return { chainWorktree: async ({ runId }) => ({ ...(await made({ runId })), baseline: null, warnings: ['worktree create answered too late'] }) }
    },
  })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(
    ofType(r.journal, 'chain').map((e) => [e.worktree, e.lines]),
    [['C:/fake/worktrees/run_fake1-chain', null]],
  )
  assert.deepEqual(foldJournal(r.journal).chain, { runId: 'run_fake1', worktree: 'C:/fake/worktrees/run_fake1-chain', baseline: null, leftovers: [] })
  assert.deepEqual([followUps(r), ofType(r.journal, 'followUp'), ofType(r.journal, 'leftover')], [[], [], []])
  assert.ok(
    r.log.some((l) => l.includes('no chain agent is checked for leftovers')),
    r.log.join('\n'),
  )
})

test('leftover check: a chain agent that fails gets no follow-up, whatever it left, and its call ends as ever', async () => {
  const r = await runOne(
    leaving(async (w) => {
      w.lines.push('?? tmp.log')
      throw new Error('the agent died')
    }),
    { script: TWO_CHAINED.slice(0, TWO_CHAINED.indexOf('\nreturn')).replace('await agent', 'return await agent'), settings: NO_DOCTOR },
  )
  assert.equal(r.result, null)
  assert.deepEqual(
    r.orca.calls.filter((c) => c.verb === 'worktreeLines' || c.verb === 'terminalSend'),
    [],
  )
  assert.deepEqual([...ofType(r.journal, 'followUp'), ...ofType(r.journal, 'leftover')], [])
  assert.deepEqual(
    ofType(r.journal, 'failed').map((e) => e.title),
    ['[Implement] impl:#1'],
  )
})

test('sequential run: a chain agent that dies gets a doctor in a <runId>-<n> worktree of its own, setup skipped, never the chain', async () => {
  const script = `const S = ${JSON.stringify(SCHEMA)}
await agent('Build a.', { label: 'impl:#1', phase: 'Implement', schema: S, isolation: 'chain' })
return await agent('Patient.', { label: 'impl:#2', phase: 'Implement', schema: S, isolation: 'chain' })`
  const r = await runOne(
    withDoctor((w) => (w.prompt.startsWith('Patient.') ? diesPastCap(w) : submitGood(w))),
    { script },
  )
  assert.equal(r.result, null)
  const creates = r.orca.calls.filter((c) => c.verb === 'worktreeCreate')
  assert.deepEqual(
    creates.map((c) => [c.name, c.setup]),
    [
      ['run_fake1-chain', null],
      ['run_fake1-3', 'skip'],
      ['run_fake1-4', 'skip'],
      ['run_fake1-5', 'skip'],
    ],
  )
  const doctors = r.orca.calls.filter((c) => c.verb === 'workerStart' && c.title === '[Implement] recover -> impl:#2')
  assert.deepEqual(
    doctors.map((d) => [d.placement, d.worktree]),
    [3, 4, 5].map((n) => ['new-child', `C:/fake/worktrees/run_fake1-${n}`]),
  )
  assert.match(r.orca.dispatches.get(doctors[0].dispatchId).prompt, /^Worktree: C:\/fake\/worktrees\/run_fake1-chain$/m, "the doctor is shown the patient's worktree, the chain")
  assert.deepEqual(
    r.journal.filter((e) => /-chain/.test(JSON.stringify([e.retained ?? null, e.alsoRetained ?? null]))),
    [],
    'the run-owned chain is never retained',
  )
})

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
  assert.deepEqual(
    ofType(r.journal, 'gaveUp').map((e) => [e.n, e.round, e.reason]),
    [1, 2, 3].map((round) => [1, round, `it gave up: ${GIVE_UP}`]),
  )
  assert.deepEqual(
    ofType(r.journal, 'settled').map((e) => [e.n, e.outcome]),
    [
      [2, 'failed'],
      [3, 'failed'],
      [4, 'failed'],
    ],
  )
  const [failed, ...more] = ofType(r.journal, 'failed')
  assert.deepEqual(more, [])
  assert.equal(failed.n, 1)
  assert.match(failed.reason, /the cap of 3, with no result$/)
  assert.equal(failed.workerLeft, true)
  // Kept: its process not stopped, its tab open, its worktree retained.
  const started = ofType(r.journal, 'started')[0]
  assert.equal(
    r.orca.calls.some((c) => c.verb === 'workerStop' && c.dispatch === started.dispatchId),
    false,
  )
  assert.equal(r.released, 0)
  assert.equal(failed.retained.path, started.worktree)
  assert.ok(
    r.lines.some((l) => l.startsWith(`!! kept ${started.worktree}:`)),
    r.lines.join('\n'),
  )
  assert.ok(
    r.lines.some((l) => l.includes('after 3 doctor rounds without a remedy')),
    r.lines.join('\n'),
  )
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
    const result = await runScript(ISOLATED, { host: orca, stateDir, out: () => {}, clock, transcripts: fakeTranscripts(orca), registry })
    const journal = journalOf(stateDir)
    assert.equal(result, null)
    assertEntries(journal)
    const rounds = ofType(journal, 'doctor')
    assert.deepEqual(
      rounds.map((e) => [e.n, e.round]),
      [
        [1, 1],
        [1, 2],
        [1, 3],
      ],
      'three rounds, all for the patient',
    )
    const own = ofType(journal, 'failed').filter((e) => e.n === rounds[0].doctor)
    assert.equal(own.length, 1)
    assert.equal(own[0].patient, 1)
    assert.equal(own[0].key, null)
    assert.equal(own[0].attempts, startFails ? ATTEMPTS : 1)
    assert.deepEqual(
      ofType(journal, 'gaveUp').map((e) => e.reason),
      ['it failed itself', `it gave up: ${GIVE_UP}`, `it gave up: ${GIVE_UP}`],
    )
    // Its failure is no agent() null: only the patient's is, and the run ends partial for it alone.
    assert.deepEqual(
      ofType(journal, 'failed')
        .filter((e) => e.patient == null)
        .map((e) => e.n),
      [1],
    )
    assert.equal(linesOf(registry).find((e) => e.type === 'ended').outcome, 'partial')
  })
}

// --- a doctor's handoff over Orca mail carries its patient on ---------------------

const NOTE = 'Run the suite with --runInBand: the parallel run is what hangs.'
// A patient that dies past its cap, gone or stuck in each continuation, and
// submits once a continuation carries `note`.
const curedBy = (note, death) =>
  function dies(w) {
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
    assert.deepEqual(
      ofType(r.journal, 'result').map((e) => [e.n, e.result]),
      [[1, GOOD]],
    )
    assert.deepEqual(ofType(r.journal, 'failed'), [])
    assert.deepEqual(ofType(r.journal, 'gaveUp'), [])

    const started = ofType(r.journal, 'started')[0]
    const last = ofType(r.journal, 'continued')
      .filter((e) => e.n === 1)
      .at(-1)
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
    assert.deepEqual(
      mail.filter((e) => e.messageId === done.id).map((e) => [e.kind, e.outcome, e.action]),
      [['worker_done', 'succeeded', 'ended']],
    )
    assert.deepEqual(
      ofType(r.journal, 'settled').map((e) => [e.n, e.outcome]),
      [[2, 'succeeded']],
    )
    assert.equal(r.orca.calls.filter((x) => x.verb === 'workerStart').length, 2, 'one doctor, and no second start of the patient')
    const agents = foldJournal(r.journal).agents
    assert.deepEqual(
      agents.map((a) => [a.origin, a.state]),
      [
        [1, 'done'],
        [2, 'done'],
      ],
    )
  })
}

// --- doctor rounds build on each other ------------------------------------------

const NOTES = ['Note one: retry the flaky step.', 'Note two: pin the port.', 'Note three: run it in band.']
// Round k's doctor hands off NOTES[k - 1] while k is in `handing`, and gives up otherwise.
const doctorsHanding = (handing) => {
  let round = 0
  return (d) => (handing.includes(++round) ? handsOff(NOTES[round - 1])(d) : givesUp(d))
}
const doctorPrompts = (orca) => [...orca.dispatches.values()].filter((d) => d.title.includes('recover ->')).map((d) => d.prompt)

test("doctor: a patient that dies past its cap again after a handoff gets round two with a fresh continuation count, and round two's doctor is handed round one's note and outcome", async () => {
  const r = await runOne(withDoctor(curedBy(NOTES[2], 'gone'), doctorsHanding([1])), { script: ISOLATED })
  assert.equal(r.result, null)
  assertEntries(r.journal)
  const doctors = ofType(r.journal, 'doctor')
  assert.deepEqual(
    doctors.map((e) => e.round),
    [1, 2, 3],
  )
  const [remedy, ...more] = ofType(r.journal, 'remedy')
  assert.deepEqual(more, [])
  assert.equal(remedy.round, 1)
  // A fresh count: three more continuations between the remedy and round two.
  const between = r.journal.slice(r.journal.indexOf(remedy), r.journal.indexOf(doctors[1])).filter((e) => e.type === 'continued' && e.n === 1)
  assert.deepEqual(
    between.map((e) => e.attempt),
    [1, 2, 3],
  )
  assert.deepEqual(
    ofType(r.journal, 'continued')
      .filter((e) => e.n === 1)
      .map((e) => e.attempt),
    [1, 2, 3, 1, 2, 3],
  )
  assert.match(doctors[1].reason, /already continued 3 times, the cap of 3, with no result$/)
  const handed = r.lines.findIndex((l) => l.includes('doctor round 1 handed off a note'))
  assert.ok(
    r.lines.slice(handed).some((l) => l.includes('(continuation 1 of 3)')),
    r.lines.join('\n'),
  )
  const [first, second, third] = doctorPrompts(r.orca)
  assert.equal(first.includes('## Earlier doctor rounds'), false, first)
  assert.ok(second.includes(`## Earlier doctor rounds`), second)
  assert.ok(second.includes(`### Round 1\nNote: ${NOTES[0]}\nOutcome: its note carried the patient on, and it failed again: ${doctors[1].reason}`), second)
  assert.equal(second.includes('### Round 2'), false, second)
  assert.ok(third.includes(`### Round 1\nNote: ${NOTES[0]}\n`), third)
  assert.ok(third.includes(`### Round 2\nNote: none\nOutcome: no remedy: it gave up: ${GIVE_UP}`), third)
  // The fold: three rounds, the first remedied, and a fresh count after it.
  const patient = foldJournal(r.journal).agents.find((a) => a.origin === 1)
  assert.deepEqual(
    patient.rounds.map((x) => [x.round, x.outcome, x.note, x.why]),
    [
      [1, 'remedy', NOTES[0], null],
      [2, 'gaveUp', null, `it gave up: ${GIVE_UP}`],
      [3, 'gaveUp', null, `it gave up: ${GIVE_UP}`],
    ],
  )
  assert.deepEqual(
    patient.rounds.map((x) => x.reason),
    doctors.map((e) => e.reason),
  )
  const [failed] = ofType(r.journal, 'failed').filter((e) => e.n === 1)
  assert.equal(failed.continuations, 3)
  assert.deepEqual([patient.state, patient.continuations], ['failed', 3])
})

test('doctor: a patient that succeeds in round three returns its result, and the fold records its 3 rounds', async () => {
  const r = await runOne(withDoctor(curedBy(NOTES[2], 'gone'), doctorsHanding([1, 2, 3])), { script: ISOLATED })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(ofType(r.journal, 'failed'), [])
  assert.deepEqual(
    ofType(r.journal, 'remedy').map((e) => e.round),
    [1, 2, 3],
  )
  assert.deepEqual(
    ofType(r.journal, 'continued')
      .filter((e) => e.n === 1)
      .map((e) => e.attempt),
    [1, 2, 3, 1, 2, 3, 1, 2, 3],
  )
  const third = doctorPrompts(r.orca)[2]
  for (const [i, note] of NOTES.slice(0, 2).entries()) assert.ok(third.includes(`### Round ${i + 1}\nNote: ${note}\nOutcome: its note carried the patient on, and it failed again: `), third)
  const patient = foldJournal(r.journal).agents.find((a) => a.origin === 1)
  assert.equal(patient.state, 'done')
  assert.equal(patient.round, 3)
  assert.deepEqual(
    patient.rounds.map((x) => [x.round, x.outcome, x.note]),
    NOTES.map((note, i) => [i + 1, 'remedy', note]),
  )
  assert.equal(r.orca.calls.filter((c) => c.verb === 'workerStart').length, 4, 'three doctors, and the patient started once')
})

test('doctor: the fold links every doctor to its patient across rounds, and a resume carries the rounds and the links', async () => {
  const stateDir = tmp()
  const clock = fakeClock()
  const play = withDoctor(curedBy(NOTES[2], 'gone'), doctorsHanding([1, 3]))
  const orca = fakeOrca({ worker: (w) => play({ ...w, clock }), clock })
  const opts = { stateDir, out: () => {}, clock, transcripts: fakeTranscripts(orca) }
  assert.deepEqual(await runScript(ISOLATED, { ...opts, host: orca }), GOOD)
  const linked = (journal) => {
    const agents = foldJournal(journal).agents
    const patient = agents.find((a) => a.origin === 1)
    assert.deepEqual(patient.doctors, [2, 3, 4])
    assert.deepEqual(
      patient.rounds.map((x) => [x.round, x.doctor, x.outcome]),
      [
        [1, 2, 'remedy'],
        [2, 3, 'gaveUp'],
        [3, 4, 'remedy'],
      ],
    )
    for (const d of patient.doctors) assert.equal(agents.find((a) => a.origin === d).patient, 1)
    assert.deepEqual(
      agents.filter((a) => a.patient != null).map((a) => a.origin),
      [2, 3, 4],
    )
    return agents
  }
  const fresh = journalOf(stateDir)
  assertEntries(fresh)
  assert.deepEqual(
    ofType(fresh, 'doctor').map((e) => [e.round, e.doctor]),
    [
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  )
  linked(fresh)
  assert.deepEqual(await runScript(ISOLATED, { ...opts, host: orca.as('term_2'), resume: true }), GOOD)
  const resumed = journalOf(stateDir)
  assertEntries(resumed)
  assert.deepEqual(ofType(resumed, 'doctor'), [], 'the resume replays the patient, and starts no doctor')
  linked(resumed)
  const view = runView({ stateDir, host: orca, clock, transcripts: sessionTranscripts({ home: tmp(), env: {} }), registry: null, alive: () => false })
  await view.refresh()
  // Its round-two doctor gave up, so the phase is not all done, and stays open.
  assert.deepEqual(
    view.model.rows.slice(1).map((row) => [row.depth, row.agent.origin, row.agent.state]),
    [
      [0, 1, 'done'],
      [1, 2, 'done'],
      [1, 3, 'failed'],
      [1, 4, 'done'],
    ],
  )
  const [p] = agentsOf(join(stateDir, 'journal.jsonl')).filter((a) => a.origin === 1)
  assert.equal(p.state, 'ok')
})

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
  assert.ok(
    checks.some((c) => c.ack === held[0].deliveryId),
    'acknowledged in the end',
  )
  assert.ok(
    r.lines.some((l) => l.includes("could not read the Run's mailbox") && l.includes('runtime_unavailable')),
    r.lines.join('\n'),
  )
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
  runScript(ISOLATED, { ...opts, host: orca, clock: first }).catch(() => {})
  await first.hung
  const before = orca.calls.length
  const handoff = sentWith(orca, NOTE)
  const died = journalOf(stateDir)
  assert.equal(ofType(died, 'mail').find((e) => e.messageId === handoff.id).action, 'remedy')
  assert.equal(ofType(died, 'remedy').length, 1)
  const batch = orca.calls.find((c) => c.verb === 'mailCheck' && c.ids.includes(handoff.id)).deliveryId
  assert.equal(
    orca.calls.some((c) => c.verb === 'mailCheck' && c.ack === batch),
    false,
    'never acknowledged',
  )

  assert.deepEqual(await runScript(ISOLATED, { ...opts, host: orca.as('term_2'), clock, resume: true }), GOOD)
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
  assert.deepEqual(
    ofType(journal, 'remedy').map((e) => e.messageId),
    [sentWith(orca, NOTE2).id],
  )
  const mail = ofType(journal, 'mail')
  // A message from a dispatch nothing claimed yet is journaled pending, then
  // once more when it is acted on: one acting line per message.
  const acted = mail.filter((e) => e.action !== 'pending')
  assert.equal(new Set(acted.map((e) => e.messageId)).size, acted.length, 'one acting mail line per message, the carried ones included')
  for (const e of mail.filter((x) => x.action === 'pending'))
    assert.ok(
      acted.some((x) => x.messageId === e.messageId),
      `${e.messageId} acted on once claimed`,
    )
  assert.deepEqual(
    mail.filter((e) => e.messageId === handoff.id).map((e) => e.action),
    ['remedy'],
  )
})

test('doctor: a worker_done --outcome failed over mail ends its round with no remedy, its body the reason', async () => {
  const r = await runOne(withDoctor(diesPastCap), { script: ISOLATED })
  assert.equal(r.result, null)
  assertEntries(r.journal)
  const gave = ofType(r.journal, 'mail').filter((e) => e.action === 'gaveUp')
  assert.deepEqual(
    gave.map((e) => [e.kind, e.outcome, e.body, e.doctor, e.patient, e.round]),
    [2, 3, 4].map((d, i) => ['worker_done', 'failed', GIVE_UP, d, 1, i + 1]),
  )
  for (const e of gave) assert.ok(ackOf(r.orca.calls, e.messageId) >= 0, 'acknowledged')
  assert.deepEqual(
    ofType(r.journal, 'gaveUp').map((e) => [e.round, e.reason]),
    [1, 2, 3].map((round) => [round, `it gave up: ${GIVE_UP}`]),
  )
  assert.deepEqual(ofType(r.journal, 'remedy'), [])
  const firstDoctor = r.journal.findIndex((e) => e.type === 'doctor')
  assert.equal(
    r.journal.slice(firstDoctor).some((e) => e.type === 'continued'),
    false,
  )
  assert.equal(r.continues.length, 3, 'only the continuations before the cap')
})

// What crew's handoff tool sends (daemon worker.handoff, #176): the note as a
// handoff, then worker_done succeeded, in one op; called twice here.
const handsOffByToolTwice = (note, again) => async (w) => {
  await handsOff(note)(w)
  await handsOff(again)(w)
}

test("doctor: crew's handoff tool, called twice, carries the patient on with its first note alone: the second acts on nothing (#176)", async () => {
  const AGAIN = 'A second thought.'
  const r = await runOne(withDoctor(curedBy(NOTE, 'gone'), handsOffByToolTwice(NOTE, AGAIN)), { script: ISOLATED })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(
    ofType(r.journal, 'mail')
      .filter((e) => e.kind === 'handoff')
      .map((e) => [e.action, e.body]),
    [
      ['remedy', NOTE],
      ['none', AGAIN],
    ],
  )
  assert.equal(ofType(r.journal, 'remedy').length, 1)
  assert.deepEqual(ofType(r.journal, 'gaveUp'), [])
  assert.equal(r.continues.filter((c) => c.text.includes(AGAIN)).length, 0)
})

test("doctor: its prompt names crew's tools first, from the tool table, and the Run mail lines after as the fallback (#176)", () => {
  const p = doctorPrompt({ patient: { title: 't', prompt: 'p' }, reason: 'r', round: 1, rounds: 1, transcript: 'x', worktree: null, entries: [], log: [] })
  const at = (s) => {
    const i = p.indexOf(s)
    assert.ok(i >= 0, s)
    return i
  }
  const tools = ['handoff', 'needs_you', 'give_up'].map((name) => at(`call \`${name}\``))
  const fallbacks = ['handoff', 'needs_you', 'give_up'].map((name) => at(tool(name).fallback({ role: 'doctor' })))
  assert.ok(Math.max(...tools) < at('Without those tools') && at('Without those tools') < Math.min(...fallbacks), p)
})

// --- a doctor that needs a human: "? needs you" -----------------------------------

const ASK = "Log in to the package registry: run npm login in the patient's worktree."
const ASK2 = 'The login worked, but the token lacks publish scope: grant it, then tell me.'
// A doctor that escalates at once and then waits as `how` says, and hands
// off `note` only when the "human" answers, at each of `later`'s minutes an
// escalation (its body) or, last, the handoff.
const escalates = (how, note, later) => async (w) => {
  const { orca, preamble, state, clock } = w
  await orca.mailSend({ ...idsOf(preamble), type: 'escalation', subject: 'Blocked: a login', body: ASK })
  if (how === 'idle') state.idle = true
  if (how === 'waiting') state.waiting = '{"evidence":"prompt-text","text":"Allow this command?"}'
  const t0 = clock.now()
  for (const [min, body] of later) {
    clock.at(t0 + min * MIN, () => (body === note ? handsOff(note)(w) : orca.mailSend({ ...idsOf(preamble), type: 'escalation', subject: 'Blocked: still', body })))
  }
}
const doctorOf = (journal) => ofType(journal, 'started').find((e) => e.title.includes('recover ->'))

for (const how of ['idle', 'stuck', 'waiting']) {
  test(`needs you: a doctor that escalates (then ${how}) is never nudged, continued or failed by the blocked limit; three hours on its handoff continues the patient`, async () => {
    const r = await runOne(withDoctor(curedBy(NOTE, 'gone'), escalates(how, NOTE, [[180, NOTE]])), { script: ISOLATED })
    assert.deepEqual(r.result, GOOD)
    assertEntries(r.journal)
    const doctor = doctorOf(r.journal)
    const mine = r.journal.filter((e) => e.n === doctor.n)
    assert.deepEqual(
      mine.filter((e) => ['nudge', 'continued', 'failed'].includes(e.type)),
      [],
    )
    assert.deepEqual(
      r.nudges.filter((c) => c.dispatchId === doctor.dispatchId),
      [],
      'never nudged',
    )
    assert.equal(r.continues.filter((c) => (c.from ?? c.dispatchId) === doctor.dispatchId).length, 0, 'never continued')
    assert.deepEqual(ofType(r.journal, 'failed'), [])
    assert.deepEqual(ofType(r.journal, 'gaveUp'), [])

    const mail = ofType(r.journal, 'mail').filter((e) => e.doctor === doctor.n)
    assert.deepEqual(
      mail.map((e) => [e.kind, e.action]),
      [
        ['escalation', 'needsYou'],
        ['handoff', 'remedy'],
        ['worker_done', 'ended'],
      ],
    )
    assert.deepEqual([mail[0].body, mail[0].patient, mail[0].round], [ASK, 1, 1])
    const waited = Date.parse(mail[1].at) - Date.parse(mail[0].at)
    assert.ok(waited >= 180 * MIN && waited > RUNNER_SETTINGS.blockedFailMs * 5, `waited ${waited / MIN} minutes`)
    // Needs you through the wait, in the fold every reader shares, until its handoff.
    const upTo = (e) => foldJournal(r.journal.slice(0, r.journal.indexOf(e) + 1)).agents.find((a) => a.n === doctor.n)
    assert.deepEqual([upTo(mail[0]).state, upTo(mail[0]).reason], ['needs you', ASK])
    const lastLook = r.journal.findLast((e) => r.journal.indexOf(e) < r.journal.indexOf(mail[1]))
    assert.equal(upTo(lastLook).state, 'needs you')
    assert.equal(upTo(mail[1]).state, 'running')
    assert.deepEqual(
      ofType(r.journal, 'remedy').map((e) => [e.n, e.doctor, e.messageId]),
      [[1, doctor.n, mail[1].messageId]],
    )
    assert.ok(
      r.lines.some((l) => l.includes(`recover -> one NEEDS YOU: ${ASK}`)),
      r.lines.join('\n'),
    )
    assert.ok(
      r.lines.some((l) => l.includes(`tell it so in its tab ${doctor.terminal}`)),
      r.lines.join('\n'),
    )
    assert.equal(
      r.lines.some((l) => l.includes('recover -> one: if nobody answers within')),
      false,
    )
  })
}

test('needs you: an escalation then another updates the reason, messages taken in order, and its handoff then continues the patient', async () => {
  const r = await runOne(
    withDoctor(
      curedBy(NOTE, 'stuck'),
      escalates('idle', NOTE, [
        [60, ASK2],
        [120, NOTE],
      ]),
    ),
    { script: ISOLATED },
  )
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  const doctor = doctorOf(r.journal)
  const mail = ofType(r.journal, 'mail').filter((e) => e.doctor === doctor.n)
  assert.deepEqual(
    mail.map((e) => [e.kind, e.action, e.body]),
    [
      ['escalation', 'needsYou', ASK],
      ['escalation', 'needsYou', ASK2],
      ['handoff', 'remedy', NOTE],
      ['worker_done', 'ended', 'handed off'],
    ],
  )
  const upTo = (e) => foldJournal(r.journal.slice(0, r.journal.indexOf(e) + 1)).agents.find((a) => a.n === doctor.n)
  assert.deepEqual([upTo(mail[0]).state, upTo(mail[0]).reason], ['needs you', ASK])
  assert.deepEqual([upTo(mail[1]).state, upTo(mail[1]).reason], ['needs you', ASK2])
  assert.deepEqual(
    r.journal.filter((e) => e.n === doctor.n && ['nudge', 'continued', 'failed'].includes(e.type)),
    [],
  )
  assert.equal(ofType(r.journal, 'remedy').length, 1)
  assert.deepEqual(
    foldJournal(r.journal).agents.map((a) => [a.origin, a.state]),
    [
      [1, 'done'],
      [2, 'done'],
    ],
  )
})

// --- review fixes: the doctor's texts, its round's end, its patient's slot ------

const NOTE_TWO = 'Pin the registry mirror: the default one is down.'
// A doctor that goes idle in every session, never reporting.
const idlesOn = (w) => {
  w.state.idle = true
  w.state.onContinue = idlesOn
}

test('doctor: a hand-off, an escalation, then a second hand-off: only the first note carries the patient on; the escalation and the second note act on nothing, and hold nothing', async () => {
  const doctor = async (w) => {
    const { orca, preamble, clock } = w
    await orca.mailSend({ ...idsOf(preamble), type: 'handoff', subject: 'note', body: NOTE })
    const t0 = clock.now()
    clock.at(t0 + 5 * MIN, () => orca.mailSend({ ...idsOf(preamble), type: 'escalation', subject: 'Blocked: a login', body: ASK }))
    clock.at(t0 + 10 * MIN, () => handsOff(NOTE_TWO)(w))
  }
  const r = await runOne(withDoctor(curedBy(NOTE, 'stuck'), doctor), { script: ISOLATED })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  const d = doctorOf(r.journal)
  const mail = ofType(r.journal, 'mail').filter((e) => e.doctor === d.n)
  assert.deepEqual(
    mail.map((e) => [e.kind, e.action]),
    [
      ['handoff', 'remedy'],
      ['escalation', 'none'],
      ['handoff', 'none'],
      ['worker_done', 'ended'],
    ],
  )
  assert.deepEqual(
    ofType(r.journal, 'remedy').map((e) => e.messageId),
    [mail[0].messageId],
  )
  assert.deepEqual(
    r.continues.filter((c) => c.text.includes(NOTE) || c.text.includes(NOTE_TWO)).map((c) => c.text),
    [notePrompt(NOTE)],
  )
  assert.notEqual(upTo(r.journal, mail[1]).find((a) => a.n === d.n).state, 'needs you')
  assert.equal(
    r.lines.some((l) => l.includes('NEEDS YOU')),
    false,
    r.lines.join('\n'),
  )
  // Its prompt says only its first handoff counts.
  assert.ok(doctorPrompts(r.orca)[0].includes("Your first handoff is this round's note"), doctorPrompts(r.orca)[0])
})

test('doctor: a stalled doctor is nudged and continued with texts of its own: none of them names a submit command it does not have', async () => {
  const doctor = (w) => {
    w.state.idle = true
    w.state.onContinue = handsOff(NOTE)
  }
  const r = await runOne(withDoctor(curedBy(NOTE, 'stuck'), doctor), { script: ISOLATED })
  assert.deepEqual(r.result, GOOD)
  const d = doctorOf(r.journal)
  const nudges = r.nudges.filter((c) => c.dispatchId === d.dispatchId)
  const continues = r.continues.filter((c) => (c.from ?? c.dispatchId) === d.dispatchId)
  assert.equal(nudges.length, RUNNER_SETTINGS.idleNudges)
  assert.equal(continues.length, 1)
  for (const text of [...nudges, ...continues].map((c) => c.text)) {
    assert.doesNotMatch(text, /submit/i)
    assert.match(text, /handoff, then worker_done/)
  }
  // An agent() call's worker is still told to submit.
  assert.ok(r.nudges.filter((c) => c.dispatchId !== d.dispatchId).every((c) => /submit command/.test(c.text)))
})

test("doctor: its patient's agent() returns as soon as its own result is in; a doctor that never sends worker_done is watched to its end in the background, before the run ends, its worktree never retained", async () => {
  const script = `const S = ${JSON.stringify(SCHEMA)}
const one = await agent('Do a thing.', { label: 'one', phase: 'P', schema: S, isolation: 'worktree' })
const next = await agent('Then.', { label: 'next', phase: 'P', schema: S })
return { one, next }`
  const doctor = async (w) => {
    await w.orca.mailSend({ ...idsOf(w.preamble), type: 'handoff', subject: 'note', body: NOTE })
    idlesOn(w)
  }
  const r = await runOne(
    withDoctor((w) => (w.prompt.startsWith('Then.') ? submitGood(w) : curedBy(NOTE, 'stuck')(w)), doctor),
    { script },
  )
  assert.deepEqual(r.result, { one: GOOD, next: GOOD }, 'no worktrees_kept: the doctor changed nothing')
  assertEntries(r.journal)
  const d = doctorOf(r.journal)
  const at = (pred) => indexOf(r.journal, pred)
  const doctorFailed = at((e) => e.type === 'failed' && e.n === d.n)
  assert.ok(doctorFailed > 0, 'the doctor ends, past its cap')
  assert.ok(at((e) => e.type === 'result' && e.title === '[P] one') < doctorFailed)
  assert.ok(at((e) => e.type === 'started' && e.title === '[P] next') < doctorFailed, 'its dependent never waits on the doctor')
  assert.equal(r.journal[doctorFailed].retained, undefined)
  assert.ok(
    r.lines.some((l) => l.includes(`${d.title}: `) && l.endsWith('; its doctor round for [P] one is spent')),
    r.lines.join('\n'),
  )
  assert.equal(
    r.lines.some((l) => l.startsWith(`!! ${d.title}:`) && l.includes('agent() returns null')),
    false,
    r.lines.join('\n'),
  )
})

test("doctor: at a cap of one, a note carries its patient on only once the patient holds the slot again, after its doctor's", async () => {
  const doctor = async (w) => {
    await w.orca.mailSend({ ...idsOf(w.preamble), type: 'handoff', subject: 'note', body: NOTE })
    w.clock.at(w.clock.now() + 10 * MIN, () => w.orca.mailSend({ ...idsOf(w.preamble), type: 'worker_done', outcome: 'succeeded', subject: 'done', body: 'handed off' }))
  }
  const r = await runOne(withDoctor(curedBy(NOTE, 'stuck'), doctor), { script: ISOLATED, settings: { MAX_LIVE: 1 } })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  const d = doctorOf(r.journal)
  const settled = indexOf(r.journal, (e) => e.type === 'settled' && e.n === d.n)
  const [remedy] = ofType(r.journal, 'remedy')
  assert.ok(settled > 0 && r.journal.indexOf(remedy) > settled, 'continued only once the doctor freed its slot')
  assert.ok(indexOf(r.journal, (e) => e.type === 'queued' && e.n === 1) < r.journal.indexOf(remedy))
  const noted = r.orca.calls.findIndex((c) => c.verb === 'workerContinue' && c.text.includes(NOTE))
  const done = r.orca.calls.findIndex((c) => c.verb === 'mailSend' && c.type === 'worker_done' && c.dispatchId === d.dispatchId)
  assert.ok(done >= 0 && noted > done)
})

test("doctor: a bad recover row in the role table is refused at the first agent(), before any worker, in the role table's words", async () => {
  const script = `export const meta = { name: 'x', roles: { recover: { harness: 'codex' } } }
return await agent('Do a thing.', { label: 'one', phase: 'P' })`
  const orca = fakeOrca({ worker: submitGood })
  await assert.rejects(runScript(script, { host: orca, stateDir: tmp(), out: () => {} }), /^Error: the role table's recover row: unknown harness "codex"/)
  assert.equal(
    orca.calls.some((c) => c.verb === 'workerStart'),
    false,
  )
  // With no doctor rounds, no doctor is ever started, so the row is not read.
  assert.deepEqual(await runScript(script.replace("label: 'one', phase: 'P'", "label: 'one', phase: 'P', schema: " + JSON.stringify(SCHEMA)), { host: orca, stateDir: tmp(), out: () => {}, settings: NO_DOCTOR }), GOOD)
})

test('resume: two held patients whose doctors each handed off while no runner ran each get their own note; neither is drained and lost by the other doctor', async () => {
  const script = `const S = ${JSON.stringify(SCHEMA)}
return await parallel(['one', 'two'].map((label) => () => agent('Do ' + label + '.', { label, phase: 'P', schema: S, isolation: 'worktree' })))`
  const noteOf = (text) => (text.includes('[P] one') || text.startsWith('Do one.') ? NOTE : NOTE_TWO)
  const clock = fakeClock()
  const stateDir = tmp()
  const first = mortalOn(clock)
  const doctors = []
  const orca = fakeOrca({
    clock,
    worker: (w) =>
      withDoctor(
        (p) => curedBy(noteOf(p.prompt), 'gone')(p),
        (d) => {
          doctors.push(d)
          if (doctors.length === 2) first.dead = true
        },
      )({ ...w, clock }),
  })
  const opts = { stateDir, out: () => {}, transcripts: fakeTranscripts(orca) }
  runScript(script, { ...opts, host: orca.as('term_runner'), clock: first }).catch(() => {})
  await first.hung
  const died = journalOf(stateDir)
  assert.equal(ofType(died, 'doctor').length, 2)
  // While no runner runs, each doctor hands off its patient's note.
  for (const d of doctors) await handsOff(noteOf(d.prompt))(d)
  // The resume takes doctor two up last, so doctor one's watch drains both
  // doctors' mail before doctor two's box is open.
  const two = ofType(died, 'started').find((e) => e.title === '[P] recover -> two').dispatchId
  const resumed = orca.as('term_2')
  const show = resumed.workerShow
  let slowed = 0
  resumed.workerShow = async (a) => {
    if (a.dispatch === two && !slowed++) await new Promise((r) => setTimeout(r, 50))
    return show.call(resumed, a)
  }
  const result = await runScript(script, { ...opts, host: resumed, clock, resume: true })
  assert.equal(slowed > 0, true)
  assert.deepEqual(result, [GOOD, GOOD])
  const journal = journalOf(stateDir)
  assertEntries(journal)
  // Doctor two's messages were read before its box was open: held, then applied.
  assert.ok(ofType(journal, 'mail').some((e) => e.action === 'pending' && e.dispatchId === two && e.kind === 'handoff'))
  assert.deepEqual(
    ofType(journal, 'remedy')
      .map((e) => [e.title, e.how])
      .sort(),
    [
      ['[P] one', 'continue'],
      ['[P] two', 'continue'],
    ],
  )
  const noted = orca.calls
    .filter((c) => c.verb === 'workerContinue' && (c.text.includes(NOTE) || c.text.includes(NOTE_TWO)))
    .map((c) => c.text)
    .sort()
  assert.deepEqual(noted, [notePrompt(NOTE), notePrompt(NOTE_TWO)].sort())
  const handoffs = ofType(journal, 'mail').filter((e) => e.kind === 'handoff' && e.action !== 'pending')
  assert.deepEqual(
    handoffs.map((e) => e.action),
    ['remedy', 'remedy'],
  )
  assert.deepEqual(ofType(journal, 'gaveUp'), [])
})

// --- a doctor for a never-started agent and a blocked one ---------------------

const START_NOTE = 'Orca restarted its runtime mid-start: start again, it answers now.'
// The patient's worker-start fails through every retry, and the one after,
// its doctor's retry, goes through.
const startFailsThrough = () => {
  let fails = 0
  return { workerStart: ({ title }) => (title === '[P] one' && ++fails <= ATTEMPTS ? new OrcaError('runtime_unavailable', `try ${fails}`, 'orchestration worker-start') : null) }
}
// A patient that submits only with `note` in its prompt.
const submitsWith = (note) => (w) => (w.prompt.includes(note) ? submitGood(w) : diesPastCap(w))
const ISOLATED_KEY = () => journalKey('Do a thing.', { label: 'one', phase: 'P', schema: SCHEMA, isolation: 'worktree' })

test("doctor: a start that fails through every retry starts a doctor, whose handoff retries the start with the note in the worker's prompt; its result reaches the script under the original call's key", async () => {
  const r = await runOne(withDoctor(submitsWith(START_NOTE), handsOff(START_NOTE)), { script: ISOLATED, faults: startFailsThrough() })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(ofType(r.journal, 'failed'), [])
  assert.deepEqual(ofType(r.journal, 'gaveUp'), [])
  assert.deepEqual(
    ofType(r.journal, 'retry').map((e) => [e.n, e.attempt]),
    [
      [1, 2],
      [1, 3],
      [1, 4],
    ],
  )
  const [round, ...moreRounds] = ofType(r.journal, 'doctor')
  assert.deepEqual(moreRounds, [])
  assert.deepEqual([round.n, round.origin, round.round, round.doctor, round.reason], [1, 1, 1, 2, `its worker did not start: orca orchestration worker-start: runtime_unavailable: try ${ATTEMPTS}`])
  // Its doctor is told there is no transcript, and which worktree the start left.
  const doctor = [...r.orca.dispatches.values()].find((d) => d.title === '[P] recover -> one')
  assert.ok(doctor.prompt.includes('Transcript: none: its worker never started'), doctor.prompt)
  assert.ok(doctor.prompt.includes(`Worktree: ${CHILD_WT}`), doctor.prompt)

  const handoff = sentWith(r.orca, START_NOTE)
  const [remedy, ...more] = ofType(r.journal, 'remedy')
  assert.deepEqual(more, [])
  assert.deepEqual([remedy.n, remedy.origin, remedy.round, remedy.doctor, remedy.how, remedy.messageId], [1, 1, 1, 2, 'restart', handoff.id])
  assert.ok(indexOf(r.journal, (e) => e.type === 'mail' && e.messageId === handoff.id) < r.journal.indexOf(remedy))
  // The start retried once, in the worktree its spent start left, with the
  // note after the prompt its worker receives; no session was continued.
  const starts = r.orca.calls.filter((c) => c.verb === 'workerStart' && c.title === '[P] one')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].worktree, CHILD_WT)
  assert.deepEqual(
    r.orca.calls.filter((c) => c.verb === 'worktreeCreate').map((c) => c.name),
    ['run_fake1-1', 'run_fake1-2'],
    "the patient's one worktree, and its doctor's",
  )
  const { prompt } = r.orca.dispatches.get(starts[0].dispatchId)
  assert.ok(prompt.startsWith('Do a thing.\n\n---\nHow this run receives your result'), prompt)
  assert.ok(prompt.endsWith(`## The doctor's note\n${START_NOTE}`), prompt)
  assert.deepEqual(r.continues, [])
  const [started] = ofType(r.journal, 'started').filter((e) => e.n === 1)
  assert.ok(r.journal.indexOf(remedy) < r.journal.indexOf(started))

  // Every line of the call carries the key of the original agent() call; its doctor's none.
  const key = ISOLATED_KEY()
  assert.deepEqual(
    ofType(r.journal, 'result').map((e) => [e.n, e.key, e.result]),
    [[1, key, GOOD]],
  )
  for (const e of r.journal.filter((x) => x.n === 1)) assert.equal(e.key, key, e.type)
  for (const e of r.journal.filter((x) => x.n === 2)) assert.equal(e.key, null, e.type)
  assert.deepEqual(
    foldJournal(r.journal).agents.map((a) => [a.origin, a.state, a.patient]),
    [
      [1, 'done', null],
      [2, 'done', 1],
    ],
  )
})

test('doctor: a chained start that fails through every retry tells its doctor the chain as its worktree, which no failure keeps; the handoff retries it there', async () => {
  const script = `return await agent('Do a thing.', { label: 'one', phase: 'P', schema: ${JSON.stringify(SCHEMA)}, isolation: 'chain' })`
  const r = await runOne(withDoctor(submitsWith(START_NOTE), handsOff(START_NOTE)), { script, faults: startFailsThrough() })
  assert.deepEqual(r.result, GOOD)
  const doctor = [...r.orca.dispatches.values()].find((d) => d.title === '[P] recover -> one')
  assert.match(doctor.prompt, /^Worktree: C:\/fake\/worktrees\/run_fake1-chain$/m, doctor.prompt)
  assert.deepEqual(
    r.journal.filter((e) => /-chain/.test(JSON.stringify([e.retained ?? null, e.alsoRetained ?? null]))),
    [],
    'the run-owned chain is never retained',
  )
  assert.deepEqual(ofType(r.journal, 'failed'), [])
  const starts = r.orca.calls.filter((c) => c.verb === 'workerStart' && c.title === '[P] one')
  assert.deepEqual(
    starts.map((s) => [s.placement, s.worktree]),
    [['chain', 'C:/fake/worktrees/run_fake1-chain']],
  )
})

test('doctor: an agent blocked on a human past the limit starts a doctor, and a handoff continues its session with the note, in its own tab', async () => {
  const blocked = (w) => {
    w.state.waiting = '{"evidence":"hook"}'
    w.state.onContinue = (c) => (c.text.includes(NOTE) ? submitGood(c) : undefined)
  }
  const r = await runOne(withDoctor(blocked, handsOff(NOTE)), { script: ISOLATED })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(ofType(r.journal, 'failed'), [])
  const [round, ...moreRounds] = ofType(r.journal, 'doctor')
  assert.deepEqual(moreRounds, [])
  assert.deepEqual([round.n, round.round, round.doctor, round.reason], [1, 1, 2, 'blocked on a human, unanswered for 30 minutes, with no result'])
  assert.ok(atMs(round) >= 30 * MIN, round.at)
  assert.ok(
    r.lines.some((l) => l.includes('a doctor diagnoses it while its agent() waits')),
    r.lines.join('\n'),
  )

  const started = ofType(r.journal, 'started')[0]
  const handoff = sentWith(r.orca, NOTE)
  const [remedy, ...more] = ofType(r.journal, 'remedy')
  assert.deepEqual(more, [])
  assert.deepEqual([remedy.n, remedy.round, remedy.doctor, remedy.how, remedy.messageId, remedy.reopened], [1, 1, 2, 'continue', handoff.id, false])
  // Never stopped while its doctor worked: the one continuation interrupts it
  // in its own tab, in its own session, with the note.
  assert.equal(
    r.orca.calls.some((c) => c.verb === 'workerStop' && c.dispatch === started.dispatchId),
    false,
  )
  const [c, ...others] = r.continues
  assert.deepEqual(others, [])
  assert.deepEqual([c.text, c.terminal, c.worktree, c.interrupted], [notePrompt(NOTE), started.terminal, started.worktree, true])
  assert.ok(c.command.startsWith(`claude --resume ${started.sessionId}`), c.command)
  assert.deepEqual(
    ofType(r.journal, 'result').map((e) => [e.n, e.key]),
    [[1, ISOLATED_KEY()]],
  )
  assert.deepEqual(
    foldJournal(r.journal).agents.map((a) => [a.origin, a.state]),
    [
      [1, 'done'],
      [2, 'done'],
    ],
  )
})

test("doctor: a resume after a never-started patient's start was retried with a note replays its result by the original call's key", async () => {
  const clock = fakeClock()
  const stateDir = tmp()
  const orca = fakeOrca({ clock, faults: startFailsThrough(), worker: (w) => withDoctor(submitsWith(START_NOTE), handsOff(START_NOTE))({ ...w, clock }) })
  const opts = { stateDir, out: () => {}, clock, transcripts: fakeTranscripts(orca) }
  assert.deepEqual(await runScript(ISOLATED, { ...opts, host: orca }), GOOD)
  assert.equal(ofType(journalOf(stateDir), 'remedy')[0].how, 'restart')
  const before = orca.calls.length

  assert.deepEqual(await runScript(ISOLATED, { ...opts, host: orca.as('term_2'), resume: true }), GOOD)
  const journal = journalOf(stateDir)
  assertEntries(journal)
  const [replayed, ...more] = ofType(journal, 'result')
  assert.deepEqual(more, [])
  assert.deepEqual([replayed.key, replayed.replayed, replayed.origin, replayed.result], [ISOLATED_KEY(), true, 1, GOOD])
  assert.deepEqual(
    orca.calls.slice(before).filter((c) => /^(workerStart|worktreeCreate|workerContinue|runUse)$/.test(c.verb)),
    [],
    'nothing started again',
  )
  // The patient is the agent the first run made, its doctor carried with it.
  const agents = foldJournal(journal).agents.sort((x, y) => x.origin - y.origin)
  assert.deepEqual(
    agents.map((a) => [a.origin, a.state, a.patient]),
    [
      [1, 'done', null],
      [2, 'done', 1],
    ],
  )
})

test("fake orca: a Run's mailbox holds what its workers send, hands its coordinator the same batch until acknowledged, and a run-use delivers it again under a new id", { skip: ORCA_SKIPPED }, async () => {
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

// --- a resume mid-recovery ------------------------------------------------------

// A runner of ISOLATED that dies mid-round: `play(first)` is the worker, which
// kills `first`, the runner's mortal clock, when the test says; `faults(first)`
// and `patch(first, orca)` too; `script` and `settings` are both runners'.
// The resume runs to its end from term_2.
async function midRound(play, { faults = () => ({}), patch = () => ({}), script = ISOLATED, settings = {} } = {}) {
  const clock = fakeClock()
  const stateDir = tmp()
  const first = mortalOn(clock)
  const orca = fakeOrca({ clock, faults: faults(first), worker: (w) => play(first)({ ...w, clock }) })
  const opts = { stateDir, out: () => {}, transcripts: fakeTranscripts(orca), settings }
  runScript(script, { ...opts, host: Object.assign(orca.as('term_runner'), patch(first, orca)), clock: first }).catch(() => {})
  await first.hung
  const died = journalOf(stateDir)
  const before = orca.calls.length
  const result = await runScript(script, { ...opts, host: orca.as('term_2'), clock, resume: true })
  const journal = journalOf(stateDir)
  const after = orca.calls.slice(before)
  const of = (verb) => after.filter((c) => c.verb === verb)
  return { orca, died, result, journal, after, of }
}
const upTo = (journal, e) => foldJournal(journal.slice(0, journal.indexOf(e) + 1)).agents

test('resume: a live doctor is taken up, and no second one started; its patient stays pending until the handoff, and is never continued before it', async () => {
  // The doctor hands off 10 minutes on, before any stillness nudges it; its runner dies as it starts.
  const r = await midRound((first) =>
    withDoctor(curedBy(NOTE, 'gone'), (d) => {
      first.dead = true
      d.clock.at(d.clock.now() + 10 * MIN, () => handsOff(NOTE)(d))
    }),
  )
  assert.deepEqual(
    ofType(r.died, 'doctor').map((e) => [e.n, e.round, e.doctor]),
    [[1, 1, 2]],
  )
  assert.deepEqual(ofType(r.died, 'remedy'), [])
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  const doctor = doctorOf(r.died)
  assert.deepEqual(r.of('workerStart'), [], 'no doctor started again, and no patient')
  const [patientUp, doctorUp, ...more] = ofType(r.journal, 'reattached')
  assert.deepEqual(more, [])
  assert.deepEqual([patientUp.title, patientUp.origin], ['[P] one', 1])
  assert.deepEqual([doctorUp.dispatchId, doctorUp.origin, doctorUp.patient, doctorUp.round, doctorUp.key], [doctor.dispatchId, 2, 1, 1, null])
  // Its round goes on: journaled again, not a new one.
  const [round, ...rounds] = ofType(r.journal, 'doctor')
  assert.deepEqual(rounds, [])
  assert.deepEqual([round.n, round.origin, round.round, round.doctor], [patientUp.n, 1, 1, doctorUp.n])
  // Pending: nothing continues the patient until its doctor's note does.
  assert.deepEqual(
    r.of('workerContinue').map((c) => c.text),
    [notePrompt(NOTE)],
  )
  const [remedy] = ofType(r.journal, 'remedy')
  assert.deepEqual([remedy.messageId, remedy.round, remedy.doctor], [sentWith(r.orca, NOTE).id, 1, doctorUp.n])
  assert.ok(atMs(remedy) >= 10 * MIN, remedy.at)
  assert.ok(r.journal.indexOf(remedy) < r.journal.indexOf(ofType(r.journal, 'result')[0]))
  const before = upTo(r.journal, r.journal[r.journal.indexOf(remedy) - 1])
  assert.deepEqual(
    before.map((a) => [a.origin, a.state]),
    [
      [1, 'failed'],
      [2, 'running'],
    ],
  )
  const agents = foldJournal(r.journal).agents
  assert.deepEqual(
    agents.map((a) => [a.origin, a.state, a.patient]),
    [
      [1, 'done', null],
      [2, 'done', 1],
    ],
  )
  assert.deepEqual(
    agents[0].rounds.map((x) => [x.round, x.doctor, x.outcome]),
    [[1, 2, 'remedy']],
  )
})

test('resume: a handoff journaled before its runner died, and not yet applied, is applied once by the resume, which acknowledges the batch Orca delivers again', async () => {
  let tries = 0
  // The first runner dies continuing its patient with the note: that call never reaches Orca.
  const r = await midRound(() => withDoctor(curedBy(NOTE, 'gone'), handsOff(NOTE)), {
    patch: (first, orca) => ({
      workerContinue: (a) => {
        if (!a.prompt.includes(NOTE)) return orca.workerContinue(a)
        tries++
        first.dead = true
        return first.sleep(0)
      },
    }),
  })
  const handoff = sentWith(r.orca, NOTE)
  assert.equal(tries, 1)
  assert.deepEqual(
    ofType(r.died, 'mail')
      .filter((e) => e.messageId === handoff.id)
      .map((e) => e.action),
    ['remedy'],
  )
  assert.deepEqual(ofType(r.died, 'remedy'), [], 'journaled as mail, never applied')
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  // Applied once: one continuation with the note, one remedy line, for that handoff.
  assert.deepEqual(
    r.of('workerContinue').map((c) => c.text),
    [notePrompt(NOTE)],
  )
  assert.deepEqual(
    ofType(r.journal, 'remedy').map((e) => [e.messageId, e.round, e.how]),
    [[handoff.id, 1, 'continue']],
  )
  assert.deepEqual(r.of('workerStart'), [], 'no second doctor')
  const again = r.after.find((c) => c.verb === 'mailCheck' && c.ids.includes(handoff.id))
  assert.ok(again, 'delivered again to the resume')
  assert.ok(r.after.some((c) => c.verb === 'mailCheck' && c.ack === again.deliveryId))
  assert.deepEqual(
    ofType(r.journal, 'mail')
      .filter((e) => e.messageId === handoff.id)
      .map((e) => e.action),
    ['remedy'],
  )
  assert.deepEqual(
    foldJournal(r.journal).agents.map((a) => [a.origin, a.state]),
    [
      [1, 'done'],
      [2, 'done'],
    ],
  )
})

test('resume: a doctor that needs you stays waiting across a resume, never nudged, continued or failed, until its handoff three hours on', async () => {
  // Its runner dies once it has journaled the escalation.
  const r = await midRound(() => withDoctor(curedBy(NOTE, 'gone'), escalates('idle', NOTE, [[180, NOTE]])), {
    faults: (first) => ({
      mailCheck: ({ ack, batch }) => {
        if (ack && batch?.some((m) => m.type === 'escalation')) first.dead = true
        return null
      },
    }),
  })
  const doctor = doctorOf(r.died)
  assert.deepEqual(
    ofType(r.died, 'mail').map((e) => [e.action, e.body]),
    [['needsYou', ASK]],
  )
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(r.of('workerStart'), [])
  const up = ofType(r.journal, 'reattached').find((e) => e.dispatchId === doctor.dispatchId)
  assert.equal(up.needsYou, ASK)
  const state = (e) => upTo(r.journal, e).find((a) => a.origin === 2)
  assert.deepEqual([state(up).state, state(up).reason], ['needs you', ASK])
  const handoff = ofType(r.journal, 'mail').find((e) => e.action === 'remedy')
  assert.equal(state(r.journal[r.journal.indexOf(handoff) - 1]).state, 'needs you')
  assert.ok(atMs(handoff) >= 180 * MIN, handoff.at)
  assert.deepEqual(
    r.journal.filter((e) => e.origin === 2 || e.n === up.n).filter((e) => ['nudge', 'continued', 'failed'].includes(e.type)),
    [],
  )
  assert.deepEqual(
    r.of('terminalSend').filter((c) => c.dispatchId === doctor.dispatchId),
    [],
    'never nudged',
  )
  assert.deepEqual(
    r.of('workerContinue').map((c) => c.text),
    [notePrompt(NOTE)],
    'only the patient, with the note',
  )
  assert.deepEqual(ofType(r.journal, 'gaveUp'), [])
})

test("resume: a held patient whose worker never started stays pending, and its live doctor's handoff retries its start with the note", async () => {
  const faults = startFailsThrough()
  const r = await midRound(
    (first) =>
      withDoctor(submitsWith(START_NOTE), (d) => {
        first.dead = true
        d.clock.at(d.clock.now() + 30 * MIN, () => handsOff(START_NOTE)(d))
      }),
    { faults: () => faults },
  )
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(
    r.of('workerStart').map((c) => [c.title, c.worktree]),
    [['[P] one', CHILD_WT]],
    'the patient retried in its worktree, and no second doctor',
  )
  const [remedy, ...more] = ofType(r.journal, 'remedy')
  assert.deepEqual(more, [])
  assert.deepEqual([remedy.origin, remedy.how, remedy.round], [1, 'restart', 1])
  const agents = foldJournal(r.journal).agents
  assert.deepEqual(
    agents.map((a) => [a.origin, a.state, a.patient]),
    [
      [1, 'done', null],
      [2, 'done', 1],
    ],
  )
})

// The patient `one`, and `two`, which holds the one live slot from when the
// patient's doctor queues for it.
const HOLDS_SLOT = `const S = ${JSON.stringify(SCHEMA)}
phase('P')
return await parallel([() => agent('Do a thing.', { label: 'one', schema: S, isolation: 'worktree' }), () => agent('Hold the slot.', { label: 'two', schema: S })])`

// A resumed round whose doctor never launched: started afresh in the same
// round, with the doctor prompt, and never spent.
function assertFreshRound(r, doctorN) {
  assert.deepEqual(ofType(r.journal, 'gaveUp'), [], 'nothing spent')
  assert.deepEqual(
    ofType(r.journal, 'doctor').map((e) => [e.n, e.round, e.doctor]),
    [[ofType(r.journal, 'reattached').find((e) => e.origin === 1).n, 1, doctorN]],
    'the same round, the same doctor',
  )
  const [start, ...more] = r.of('workerStart').filter((c) => c.title === '[P] recover -> one')
  assert.deepEqual(more, [])
  assert.ok(IS_DOCTOR.test(r.orca.dispatches.get(ofType(r.journal, 'started').find((e) => e.n === doctorN).dispatchId).prompt), 'the doctor prompt')
  assert.ok(start)
  assert.deepEqual(
    ofType(r.journal, 'remedy').map((e) => [e.round, e.doctor, e.how]),
    [[1, doctorN, 'continue']],
  )
  assert.deepEqual(
    r
      .of('workerContinue')
      .filter((c) => c.text.includes(NOTE))
      .map((c) => c.text),
    [notePrompt(NOTE)],
  )
  const patient = foldJournal(r.journal).agents.find((a) => a.origin === 1)
  assert.deepEqual([patient.state, patient.round, patient.rounds.map((x) => [x.round, x.doctor, x.outcome])], ['done', 1, [[1, doctorN, 'remedy']]])
}

test('resume: a doctor queued for a live slot when its runner died is started afresh in the same round, never counted as spent', async () => {
  const r = await midRound(
    (first) => (w) => {
      if (w.prompt.startsWith('Hold the slot.')) {
        first.dead = true
        w.clock.at(w.clock.now() + 5 * MIN, () => submitGood(w))
        return
      }
      return withDoctor(curedBy(NOTE, 'gone'), handsOff(NOTE))(w)
    },
    { script: HOLDS_SLOT, settings: { MAX_LIVE: 1 } },
  )
  const [round] = ofType(r.died, 'doctor')
  assert.deepEqual([round.round, ofType(r.died, 'queued').some((e) => e.n === round.doctor)], [1, true], 'its doctor queued')
  assert.deepEqual(
    r.died.filter((e) => e.n === round.doctor && e.type !== 'queued'),
    [],
    'and never launched',
  )
  assert.deepEqual(r.result, [GOOD, GOOD])
  assertEntries(r.journal)
  assertFreshRound(r, round.doctor)
})

test('resume: a doctor whose start was being retried when its runner died is started afresh in the same round, in the worktree its start made', async () => {
  let fails = 0
  const r = await midRound(() => withDoctor(curedBy(NOTE, 'gone'), handsOff(NOTE)), {
    faults: (first) => ({
      terminalCreate: ({ title }) => {
        if (!title.includes('recover ->') || ++fails > 1) return null
        first.dead = true
        return new OrcaError('runtime_unavailable', 'no terminal', 'terminal create')
      },
    }),
  })
  const [round] = ofType(r.died, 'doctor')
  const baseline = ofType(r.died, 'baseline').find((e) => e.n === round.doctor)
  assert.ok(baseline, 'its start made a worktree')
  assert.deepEqual(
    r.died.filter((e) => e.n === round.doctor).map((e) => e.type),
    ['starting', 'baseline', 'retry'],
  )
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assertFreshRound(r, round.doctor)
  assert.deepEqual(r.of('worktreeCreate'), [], 'no second worktree')
  assert.equal(ofType(r.journal, 'started').find((e) => e.n === round.doctor).worktree, baseline.worktree)
})

test('fold: an open round whose doctor never launched is to be started afresh; one whose doctor launched and ended while no runner watched it is not', () => {
  const at = new Date(0).toISOString()
  const patient = [
    { type: 'starting', at, key: 'k', n: 1, title: '[P] one', run: 'run_1' },
    { type: 'started', at, key: 'k', n: 1, title: '[P] one', run: 'run_1', dispatchId: 'd1', harness: 'claude', sessionId: 's1', worktree: 'W-1', terminal: 't1', dir: 'agents/001-one' },
    { type: 'doctor', at, key: 'k', n: 1, title: '[P] one', origin: 1, round: 1, reason: 'dead', doctor: 2 },
  ]
  const dTitle = '[P] recover -> one'
  const heldOf = (doctor) => foldJournal([...patient, ...doctor]).calls.get('k')[0].held
  assert.deepEqual(heldOf([]).unlaunched, { made: [], baseline: null })
  assert.deepEqual(heldOf([{ type: 'queued', at, key: null, n: 2, title: dTitle }]).unlaunched, { made: [], baseline: null })
  const starting = [
    { type: 'starting', at, key: null, n: 2, title: dTitle, run: 'run_1' },
    { type: 'baseline', at, key: null, n: 2, title: dTitle, worktree: 'W-2', lines: [] },
  ]
  assert.deepEqual(heldOf(starting).unlaunched, { made: ['W-2'], baseline: [] })
  assert.equal(heldOf([...starting, { type: 'failed', at, key: null, n: 2, title: dTitle, reason: 'no start', attempts: 4, patient: 1 }]).unlaunched, null, 'its start failed: spent')
  const ran = [...starting, { type: 'started', at, key: null, n: 2, title: dTitle, run: 'run_1', dispatchId: 'd2', harness: 'claude', sessionId: 's2', worktree: 'W-2', terminal: 't2', dir: 'agents/002-x' }]
  const settled = heldOf([...ran, { type: 'settled', at, key: null, n: 2, title: dTitle, dispatchId: 'd2', outcome: 'succeeded' }])
  assert.deepEqual([settled.unlaunched, settled.worker], [null, null], 'it ended while no runner watched it: spent')
  assert.equal(heldOf(ran).unlaunched, null, 'still out: taken up')
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
  assert.equal(RUNNER_SETTINGS.hostCallMs, 2 * MIN)
  assert.equal(RUNNER_SETTINGS.worktreeCreateMs, 10 * MIN)
  assert.ok(RUNNER_SETTINGS.worktreeCreateMs > RUNNER_SETTINGS.hostCallMs)
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
  assert.equal(atMs(retry), RUNNER_SETTINGS.hostCallMs)
  assert.equal(Date.parse(retry.nextAt), RUNNER_SETTINGS.hostCallMs + BACKOFF[0])
  assert.equal(verbCount(r, 'terminalClose'), 1, "the timed-out attempt's terminal is closed")
  assert.ok(
    r.lines.some((l) => l.endsWith('call_timeout: no answer within 120s; trying again in 30s (attempt 2 of 4)')),
    r.lines.join('\n'),
  )
})

test('retry: a start that fails after its worktree was made takes that clean worktree up again and succeeds, making no second one', async () => {
  const r = await runOne(submitGood, { script: ISOLATED, faults: { waitIdle: ({ count }) => count === 1 && new OrcaError('agent_not_ready', 'never idle', 'terminal wait') } })
  assert.deepEqual(r.result, GOOD, 'nothing retained')
  assert.deepEqual(types(r), ['starting', 'baseline', 'retry', 'started', 'result'])
  assert.equal(verbCount(r, 'worktreeCreate'), 1)
  assert.deepEqual([...r.orca.worktrees.keys()], ['C:/fake/run', CHILD_WT])
  assert.deepEqual(
    r.orca.calls.filter((c) => c.verb === 'worktreeReuse').map((c) => c.worktree),
    [CHILD_WT],
  )
  assert.equal(entries(r, 'started')[0].worktree, CHILD_WT)
  assert.equal(r.orca.worktrees.get(CHILD_WT).displayName, '[P] one')
})

for (const [what, spoil] of [
  [
    'untracked setup output',
    (w) => {
      w.porcelain.push('?? node_modules/')
    },
  ],
  [
    'commits',
    (w) => {
      w.commits = 2
    },
  ],
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
    assert.deepEqual(
      r.orca.calls.filter((c) => c.verb === 'worktreeReuse').map((c) => c.worktree),
      [CHILD_WT],
    )
    assert.equal(entries(r, 'started')[0].worktree, CHILD_WT)
  })
}

for (const [what, spoil, reason] of [
  [
    'uncommitted changes',
    (w) => {
      w.porcelain.push('?? notes.txt')
    },
    `its worker did not start: worktree reuse: worktree_dirty: ${CHILD_WT} has uncommitted changes`,
  ],
  [
    'commits',
    (w) => {
      w.commits = 2
    },
    `its worker did not start: worktree reuse: worktree_has_commits: ${CHILD_WT} has 2 commit(s) of its own`,
  ],
]) {
  test(`retry: a retry after a worker-start was sent that finds its worktree with ${what} fails with that reason, and keeps the worktree`, async () => {
    const r = await runOne(submitGood, {
      script: ISOLATED,
      settings: NO_DOCTOR,
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
    assert.ok(
      r.lines.some((l) => l.startsWith(`!! kept ${CHILD_WT}:`)),
      r.lines.join('\n'),
    )
  })
}

// --- a worktree judged against its baseline -----------------------------------

const BORN = ['?? node_modules/', '?? package-lock.json']

test("baseline: a worktree born with setup output has that output journaled as its baseline before the agent's terminal opens", async () => {
  let atTerminal = null
  const orca = fakeOrca({
    worker: submitting(),
    setupLeaves: BORN,
    faults: {
      terminalCreate: () => {
        atTerminal = journal.map((e) => e.type)
      },
    },
  })
  const { life, call, journal } = lifecycleOn(orca)
  assert.deepEqual(await life(call('impl', { isolation: 'worktree' })), GOOD)
  assert.deepEqual(atTerminal, ['starting', 'baseline'])
  const [b] = journal.filter((e) => e.type === 'baseline')
  assertEntries([{ ...b, at: new Date(0).toISOString() }])
  assert.deepEqual([b.n, b.title, b.worktree, b.lines], [1, '[P] impl', CHILD_WT, BORN])
  assert.deepEqual(foldJournal(journal).agents[0].baseline, BORN)

  const clean = await runOne(submitGood, { script: ISOLATED })
  assert.deepEqual(
    entries(clean, 'baseline').map((e) => e.lines),
    [[]],
    'a clean one is journaled with none',
  )
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
  assert.deepEqual(
    same.orca.calls.filter((c) => c.verb === 'worktreeReuse').map((c) => c.worktree),
    [CHILD_WT],
  )
  assert.equal(verbCount(same, 'worktreeCreate'), 1)

  const changed = await runOne(submitGood, { script: ISOLATED, settings: NO_DOCTOR, setupLeaves: BORN, faults: failsOnceSent((w) => w.porcelain.push('?? notes.txt')) })
  assert.equal(changed.result, null)
  assert.deepEqual(types(changed), ['starting', 'baseline', 'retry', 'failed'])
  const [failed] = entries(changed, 'failed')
  assert.equal(failed.reason, `its worker did not start: worktree reuse: worktree_dirty: ${CHILD_WT} has changed since it was made`)
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
  const r = await runOne(submitGood, { script: ISOLATED, settings: NO_DOCTOR, faults: { terminalCreate: ({ count }) => new OrcaError('runtime_unavailable', `try ${count}`, 'terminal create') } })
  assert.equal(r.result, null)
  assertEntries(r.journal)
  assert.deepEqual(types(r), ['starting', 'baseline', 'retry', 'retry', 'retry', 'failed'])
  const retries = entries(r, 'retry')
  assert.deepEqual(
    retries.map((e) => e.attempt),
    [2, 3, 4],
  )
  assert.deepEqual(
    retries.map((e) => e.reason),
    [1, 2, 3].map((i) => `its worker did not start: orca terminal create: runtime_unavailable: try ${i}`),
  )
  // Each journaled as its attempt fails, so a runner that dies in the wait
  // still leaves why; nextAt is when the next attempt begins.
  assert.deepEqual(retries.map(atMs), [0, BACKOFF[0], BACKOFF[0] + BACKOFF[1]])
  assert.deepEqual(
    retries.map((e) => Date.parse(e.nextAt)),
    [BACKOFF[0], BACKOFF[0] + BACKOFF[1], BACKOFF[0] + BACKOFF[1] + BACKOFF[2]],
  )
  const [failed] = entries(r, 'failed')
  assert.equal(failed.reason, 'its worker did not start: orca terminal create: runtime_unavailable: try 4')
  assert.equal(failed.attempts, 4)
  assert.equal(failed.retained.path, CHILD_WT)
  assert.equal(verbCount(r, 'worktreeCreate'), 1, 'every retry took up the one worktree')
})

test('retry: the backoff is whatever the settings table says', async () => {
  const r = await runOne(submitGood, { settings: { ...NO_DOCTOR, retryBackoffMs: [1_000, 7_000] }, faults: { terminalCreate: () => new OrcaError('runtime_unavailable', '', 'terminal create') } })
  assert.equal(r.result, null)
  assert.deepEqual(
    entries(r, 'retry').map((e) => [atMs(e), Date.parse(e.nextAt)]),
    [
      [0, 1_000],
      [1_000, 8_000],
    ],
  )
  assert.equal(entries(r, 'failed')[0].attempts, 3)
})

test('retry: a Run Orca fails to create, or never answers for, is retried under the same policy, and the agent then starts', async () => {
  const faults = { runCreate: ({ count }) => (count === 1 ? 'hang' : count === 2 && new OrcaError('runtime_unavailable', 'try 2', 'orchestration run-create')) }
  const r = await runOne(submitGood, { faults })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(types(r), ['retry', 'retry', 'starting', 'started', 'result'])
  const call = RUNNER_SETTINGS.hostCallMs
  assert.deepEqual(
    entries(r, 'retry').map((e) => [e.attempt, atMs(e), Date.parse(e.nextAt), e.reason]),
    [
      [2, call, call + BACKOFF[0], "Orca could not create this run's Run: orca runCreate: call_timeout: no answer within 120s"],
      [3, call + BACKOFF[0], call + BACKOFF[0] + BACKOFF[1], "Orca could not create this run's Run: orca orchestration run-create: runtime_unavailable: try 2"],
    ],
  )
  assert.equal(verbCount(r, 'runCreate'), 1)
})

test('warnings: a display name or board status Orca refuses is logged and journaled, and the agent still delivers', async () => {
  const refused = () => new OrcaError('selector_not_found', 'no such worktree', 'worktree set')
  const r = await runOne(submitGood, { script: ISOLATED, faults: { worktreeSet: refused, worktreeStatus: refused } })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  assert.deepEqual(types(r), ['starting', 'baseline', 'warning', 'started', 'warning', 'result'])
  const reasons = entries(r, 'warning').map((e) => e.reason)
  assert.deepEqual(reasons, ["could not set its worktree's display name: orca worktree set: selector_not_found: no such worktree", "could not set its worktree's board status to in-progress: orca worktree set: selector_not_found: no such worktree"])
  for (const why of reasons)
    assert.ok(
      r.log.some((l) => l.endsWith(` !! [P] one: ${why}`)),
      r.log.join('\n'),
    )
})

test('runner.log: every line the runner printed, in order and timestamped, the one for a worker that never started included', async () => {
  const r = await runOne(async () => {}, {
    orcaPatch: {
      workerStart: async () => {
        throw new Error('orca terminal wait: agent_not_ready')
      },
    },
  })
  assert.ok(
    r.lines.some((l) => l.includes('its worker did not start')),
    r.lines.join('\n'),
  )
  for (const l of r.log) assert.match(l.slice(0, 24), ISO)
  assert.deepEqual(
    r.log.map((l) => l.slice(25)),
    r.lines,
  )
})

test("runner.log: each line carries the clock's time when it was printed", async () => {
  const r = await runOne(async ({ state }) => {
    state.idle = true
    submitsOnContinue(state)
  })
  const nudges = r.log.filter((l) => l.includes('nudging it'))
  assert.equal(nudges.length, 2)
  assert.deepEqual(
    nudges.map((l) => l.slice(0, 24)),
    r.nudges.map((n) => iso(n.at)),
  )
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
  const result = await runScript(chain('Build it.'), { host: orca, stateDir, out: () => {}, settings: FAST, resume: true })
  assert.deepEqual(result, ['Plan it. @old', 'Build it. @2', 'Check it. @2'])
  assert.deepEqual(started(orca), ['[Chain] b', '[Chain] c'])
  const journal = journalOf(stateDir)
  assertEntries(journal)
  assert.deepEqual(
    journal.slice(0, 2).map((e) => [e.type, e.retained?.path ?? e.result, e.replayed]),
    [
      ['retained', 'C:/old/wt', undefined],
      ['result', 'Plan it. @old', true],
    ],
  )
})

// The run registry. Every test writes a registry of its own in a temp dir;
// runScript records nothing there unless it is handed a path.
const registryIn = () => join(tmp(), 'orca-runs.jsonl')
const linesOf = (path) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
const isoAt = (t) => new Date(t).toISOString()

test("registry: the writer appends armed, the runner's terminal and ended, each stamped with the clock's time", () => {
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
  // Its chain worktree: recorded apart from its agents.
  reclaim({ runId: 'run_a', agent: 'run_a-chain', at: isoAt(3 * MIN) })
  reclaim({ runId: 'run_a', at: isoAt(4 * MIN) })
  reclaim({ runId: 'run_b', agent: 'run_b-1', at: isoAt(5 * MIN) })
  // Never armed here: a run from before the registry.
  w.runner({ runId: 'run_old', terminal: 'term_9' })
  w.ended({ runId: 'run_old', outcome: 'ok' })

  const runs = readRegistry(path)
  assert.deepEqual(
    runs.map((r) => r.runId),
    ['run_a', 'run_b'],
  )
  assert.deepEqual(runs[0], {
    runId: 'run_a',
    host: 'orca',
    project: 'C:/repo',
    runDir: 'C:/a',
    spec: 's1',
    script: 'C:/notes/workflow.js',
    permissionMode: 'auto',
    armedAt: isoAt(0),
    state: 'failed',
    endedAt: isoAt(2 * MIN),
    runner: { terminal: 'term_2', at: isoAt(MIN) },
    paused: null,
    reclaimed: true,
    reclaimedAt: isoAt(4 * MIN),
    reclaimedAgents: [{ agent: 'run_a-3', at: isoAt(3 * MIN) }],
    chainReclaimed: true,
  })
  assert.deepEqual(runs[1], {
    runId: 'run_b',
    host: 'orca',
    project: 'C:/other',
    runDir: 'C:/b',
    spec: 's2',
    script: null,
    permissionMode: null,
    armedAt: isoAt(0),
    state: 'running',
    endedAt: null,
    runner: null,
    paused: null,
    reclaimed: false,
    reclaimedAt: null,
    reclaimedAgents: [{ agent: 'run_b-1', at: isoAt(5 * MIN) }],
    chainReclaimed: false,
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
  const result = await runScript(script, { host: orca, stateDir, out: () => {}, clock, registry, project: 'C:/repo' }).catch((e) => e)
  return { orca, result, stateDir }
}

test('registry: the runner arms its Run with project, run directory, spec and time, records its terminal, and ends it ok', async () => {
  const registry = registryIn()
  const clock = fakeClock()
  clock.t = 7 * MIN
  const { result, stateDir } = await registered(registry, { clock })
  assert.deepEqual(result, { r: GOOD })
  const [armed, runner, ended, ...rest] = linesOf(registry)
  assert.deepEqual(armed, { type: 'armed', runId: 'run_fake1', at: isoAt(7 * MIN), project: 'C:/repo', runDir: stateDir, spec: 'tracer', host: 'orca' })
  assert.deepEqual(runner, { type: 'runner', runId: 'run_fake1', at: isoAt(7 * MIN), terminal: 'term_runner', host: 'orca' })
  assert.deepEqual([ended.type, ended.runId, ended.outcome, ended.at], ['ended', 'run_fake1', 'ok', isoAt(clock.now())])
  assert.deepEqual(rest, [])
})

test('registry: the runner arms its Run with the script and permission mode a resume relaunches it with', async () => {
  const registry = registryIn()
  const orca = fakeOrca({ worker: submitGood })
  await runScript(SCRIPT, { host: orca, stateDir: tmp(), out: () => {}, registry, project: 'C:/repo', script: 'C:/notes/workflow.js', permissionMode: 'acceptEdits' })
  const [armed] = linesOf(registry)
  assert.deepEqual([armed.type, armed.script, armed.permissionMode], ['armed', 'C:/notes/workflow.js', 'acceptEdits'])
  assert.deepEqual([readRegistry(registry)[0].script, readRegistry(registry)[0].permissionMode], ['C:/notes/workflow.js', 'acceptEdits'])
})

test('registry: a run where an agent came back null ends partial; a run that throws ends failed', async () => {
  const registry = registryIn()
  const died = await registered(registry, {
    worker: async () => {
      throw new Error('agent died')
    },
  })
  assert.deepEqual(died.result, { r: null })
  const threw = await registered(registry, { script: SCRIPT.replace(/return \{ r \}$/, "throw new Error('boom')"), runPrefix: 'run_throw' })
  assert.match(threw.result.message, /boom/)
  assert.deepEqual(
    readRegistry(registry).map((r) => [r.runId, r.state]),
    [
      ['run_fake1', 'partial'],
      ['run_throw1', 'failed'],
    ],
  )
})

test("registry: a resume that launches takes its Run over and records the new runner's terminal; one that replays everything records nothing", async () => {
  const registry = registryIn()
  const stateDir = tmp()
  let tag = 0
  const orca = answering(() => tag)
  const go = (script, n, resume) => {
    tag = n
    return runScript(script, { host: orca.as(`term_r${n}`), stateDir, out: () => {}, settings: FAST, resume, registry, project: 'C:/repo' })
  }
  await go(chain('Build it.'), 1, false)
  await go(chain('Build it.'), 2, true)
  assert.deepEqual(
    linesOf(registry).map((e) => e.type),
    ['armed', 'runner', 'ended'],
    'a fully replayed resume takes nothing over',
  )
  await go(chain('Build it again.'), 3, true)
  assert.deepEqual(
    readRegistry(registry).map((r) => [r.runId, r.runDir, r.runner.terminal, r.state]),
    [['run_fake1', stateDir, 'term_r3', 'ok']],
  )
  assert.deepEqual(
    linesOf(registry)
      .map((e) => [e.type, e.runId])
      .slice(3),
    [
      ['runner', 'run_fake1'],
      ['ended', 'run_fake1'],
    ],
    'armed once, by the runner that created it',
  )
})

test('registry: two runs at once in one repo are two entries that never mix', async () => {
  const registry = registryIn()
  const [a, b] = await Promise.all([
    registered(registry, { runPrefix: 'run_a', coordinator: 'term_a' }),
    registered(registry, {
      runPrefix: 'run_b',
      coordinator: 'term_b',
      worker: async () => {
        throw new Error('agent died')
      },
    }),
  ])
  const runs = Object.fromEntries(readRegistry(registry).map((r) => [r.runId, r]))
  assert.deepEqual(Object.keys(runs).sort(), ['run_a1', 'run_b1'])
  assert.deepEqual([runs.run_a1.project, runs.run_a1.runDir, runs.run_a1.runner.terminal, runs.run_a1.state], ['C:/repo', a.stateDir, 'term_a', 'ok'])
  assert.deepEqual([runs.run_b1.project, runs.run_b1.runDir, runs.run_b1.runner.terminal, runs.run_b1.state], ['C:/repo', b.stateDir, 'term_b', 'partial'])
})

test('orca-cli: run-create reports the coordinator terminal the Run bound to', { skip: ORCA_SKIPPED }, async () => {
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
  const result = await runScript(script, { host: orca, stateDir, out: () => {}, clock, registry, project: 'C:/repo', settings: NO_DOCTOR })
  return { orca, stateDir, clock, registry, result, during: orca.calls.length }
}

const MUTATING = ['workerRelease', 'terminalClose', 'worktreeRemove']

test('keep every agent: during a run Orca is asked for no worker release, no terminal close and no worktree removal', async () => {
  const script = `${END.replace(/return \[a, b, c\]$/, '')}
const d = await agent('Idle.', { label: 'd', phase: 'P', schema: S, isolation: 'worktree' })
return [a, b, c, d]`
  const run = await endedRun({ script, worker: async (w) => (w.prompt.startsWith('Idle.') ? (w.state.idle = true) : endWorker(w)) })
  assert.deepEqual(run.result, [GOOD, null, GOOD, null])
  assert.deepEqual(
    run.orca.calls.filter((c) => MUTATING.includes(c.verb)),
    [],
  )
  assert.ok(
    run.orca.calls.some((c) => c.verb === 'workerStop'),
    'the idle one died and was stopped, not released',
  )
  for (const d of run.orca.dispatches.values()) assert.equal(d.released, false, d.title)
  for (const [path, w] of run.orca.worktrees) assert.equal(w.removed, false, path)
})

test('reclaim: a worktree with unpushed commits is kept unless forced, and nothing of its agent is touched first', async () => {
  const run = await endedRun()
  run.orca.worktrees.get(A_WT).unpushed = 2
  const agents = agentsOf(join(run.stateDir, 'journal.jsonl'))
  const r = await reclaimRun(agents, { host: run.orca, unpushed: run.orca.unpushedOf, registry: runRegistry(run.registry, run.clock) })
  assert.deepEqual(
    r.kept.map((k) => [k.agent.title, k.reason]),
    [['[P] a', `${A_WT} holds 2 unpushed commits; only a forced reclaim removes it`]],
  )
  assert.equal(
    run.orca.calls.slice(run.during).some((c) => c.verb === 'workerRelease' && c.dispatchId === 'ctx_fake1'),
    false,
  )
  assert.equal(run.orca.worktrees.get(A_WT).removed, false)
  assert.equal(
    linesOf(run.registry).some((e) => e.type === 'reclaimed' && !e.agent),
    false,
    'a run with an agent kept is not reclaimed whole',
  )

  const [a] = agents
  assert.deepEqual(await reclaimAgent(a, { host: run.orca, unpushed: run.orca.unpushedOf, force: true }), { reclaimed: true, notes: [] })
  assert.equal(run.orca.worktrees.get(A_WT).removed, true)
})

// Remove (x, crew rm): stop the runner and every agent, reclaim the run, and
// forget it. A worktree holding unpushed commits is offered for a force, one
// at a time; one not forced is left, named.
test('remove: a run is reclaimed, its unpushed worktree offered for a force, then forgotten and its folder deleted', async () => {
  const run = await endedRun()
  run.orca.worktrees.get(A_WT).unpushed = 2
  const runId = readRegistry(run.registry)[0].runId
  const stopped = []
  const r = await removeRun({ stateDir: run.stateDir, runId, host: run.orca, unpushed: run.orca.unpushedOf, registry: runRegistry(run.registry, run.clock), stopRunner: (d) => stopped.push(d) })
  assert.deepEqual(stopped, [run.stateDir])
  assert.deepEqual(
    r.kept.map((k) => [k.agent.title, k.unpushed]),
    [['[P] a', 2]],
  )
  assert.equal(run.orca.worktrees.get(A_WT).removed, false)
  assert.equal(readRegistry(run.registry).length, 1, 'not forgotten until it is finished')
  assert.deepEqual(await r.force(r.kept[0]), { reclaimed: true, notes: [] })
  assert.equal(run.orca.worktrees.get(A_WT).removed, true)
  assert.deepEqual(r.finish(), { left: [] })
  assert.deepEqual(readRegistry(run.registry), [])
  assert.ok(!existsSync(run.stateDir), 'its folder is deleted')
})

test("remove: the run's ? sessions are closed with it (#168); one closed already, or never started, is left alone", async () => {
  const run = await endedRun()
  const runId = readRegistry(run.registry)[0].runId
  const at = '2026-09-28T10:00:00.000Z'
  const lines = [
    { type: 'starting', n: 1, at },
    { type: 'started', n: 1, at, terminal: 'console_1', sessionId: 's1' },
    { type: 'starting', n: 2, at },
    { type: 'started', n: 2, at, terminal: 'console_2', sessionId: 's2' },
    { type: 'closed', n: 2, at },
    { type: 'starting', n: 3, at },
  ]
  writeFileSync(join(run.stateDir, CONSULT_FILE), lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
  const closed = []
  const host = { ...run.orca, terminalClose: async ({ terminal }) => closed.push(terminal) }
  const notes = []
  const r = await removeRun({ stateDir: run.stateDir, runId, host, unpushed: run.orca.unpushedOf, registry: runRegistry(run.registry, run.clock), stopRunner: () => {}, out: (s) => notes.push(s) })
  assert.deepEqual(
    closed.filter((t) => t.startsWith('console_')),
    ['console_1'],
  )
  assert.deepEqual(
    notes.filter((n) => /console/.test(n)),
    [],
  )
  r.finish()
  // One crew cannot close is named, and the run is still removed.
  const again = await endedRun()
  writeFileSync(
    join(again.stateDir, CONSULT_FILE),
    lines
      .slice(0, 2)
      .map((l) => `${JSON.stringify(l)}\n`)
      .join(''),
  )
  const failing = {
    ...again.orca,
    terminalClose: async () => {
      throw new Error('no crew session console_1')
    },
  }
  const said = []
  await removeRun({ stateDir: again.stateDir, runId: readRegistry(again.registry)[0].runId, host: failing, unpushed: again.orca.unpushedOf, registry: runRegistry(again.registry, again.clock), stopRunner: () => {}, out: (s) => said.push(s) })
  assert.deepEqual(
    said.filter((n) => /console \d/.test(n)),
    ['!! [Orchestrator] console 1: its session could not be closed: no crew session console_1'],
  )
})

test('remove: a worktree not forced is left on disk and named; the run is still forgotten', async () => {
  const run = await endedRun()
  run.orca.worktrees.get(A_WT).unpushed = 1
  const runId = readRegistry(run.registry)[0].runId
  const r = await removeRun({ stateDir: run.stateDir, runId, host: run.orca, unpushed: run.orca.unpushedOf, registry: runRegistry(run.registry, run.clock), stopRunner: () => {} })
  const { left } = r.finish()
  assert.deepEqual(
    left.map((l) => [l.worktree, l.title]),
    [[A_WT, '[P] a']],
  )
  assert.match(left[0].reason, /1 unpushed commit/)
  assert.equal(run.orca.worktrees.get(A_WT).removed, false)
  assert.deepEqual(readRegistry(run.registry), [])
})

test('remove: an agent whose worker is still running is stopped first, then reclaimed', async () => {
  const run = await endedRun({
    script: `return await agent('Wait.', { label: 'w', phase: 'P', schema: ${JSON.stringify(SCHEMA)}, isolation: 'worktree' })`,
    worker: async (w) => {
      w.state.waiting = '{"evidence":"hook"}'
    },
  })
  const runId = readRegistry(run.registry)[0].runId
  const r = await removeRun({ stateDir: run.stateDir, runId, host: run.orca, unpushed: run.orca.unpushedOf, registry: runRegistry(run.registry, run.clock), stopRunner: () => {} })
  assert.ok(
    run.orca.calls.slice(run.during).some((c) => c.verb === 'workerStop'),
    'its worker was stopped',
  )
  assert.deepEqual(r.kept, [])
  assert.equal(run.orca.worktrees.get(A_WT).removed, true)
})

test("remove: a sequential run's agent still at work is stopped, and its chain worktree, holding unpushed commits, is offered by its own path", async () => {
  const run = await reclaimableChainRun(null)
  run.chain.unpushed = 2
  const r = await removeRun({ stateDir: run.rest.stateDir, runId: 'run_fake1', host: run.orca, unpushed: run.orca.unpushedOf, registry: runRegistry(run.registry, run.clock), stopRunner: () => {} })
  assert.ok(
    run.after().some((c) => c.verb === 'workerStop' && c.dispatchId === 'ctx_fake3'),
    'its agent at work was stopped',
  )
  assert.deepEqual(
    r.kept.map((k) => [k.agent.chain, k.worktree, k.unpushed]),
    [[true, RUN_CHAIN, 2]],
  )
  assert.equal(run.chain.removed, false)
  assert.equal((await r.force(r.kept[0])).reclaimed, true)
  assert.equal(run.chain.removed, true)
  assert.deepEqual(r.finish(), { left: [] })
  assert.deepEqual(readRegistry(run.registry), [])
  assert.ok(!existsSync(run.rest.stateDir))
})

test("remove: the runner its state dir's runner.pid names is ended, and waited for; no runner.pid, nothing is signalled", async () => {
  const stateDir = tmp()
  await stopRunnerOf(stateDir, { waitMs: 0 })
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const ended = new Promise((r) => runner.once('exit', (code, signal) => r(signal)))
  writeFileSync(join(stateDir, 'runner.pid'), String(runner.pid))
  assert.equal(runnerAlive(stateDir), true)
  await stopRunnerOf(stateDir)
  assert.equal(await ended, 'SIGTERM')
  assert.equal(runnerAlive(stateDir), false)
})

test('crew pause, resume, rm: a run is named by its run id, its run folder or its state dir', async () => {
  const run = await endedRun()
  const [r] = readRegistry(run.registry)
  assert.equal(findRun(run.registry, r.runId).runId, r.runId)
  assert.equal(findRun(run.registry, run.stateDir).runId, r.runId)
  assert.equal(findRun(run.registry, 'nope'), null)
  assert.match(pauseCommand({ registry: run.registry, target: r.runId }), /^paused .*: no new agent starts/)
  assert.ok(existsSync(join(run.stateDir, 'paused.json')))
  assert.match(pauseCommand({ registry: run.registry, target: r.runId }), /already paused/)
  assert.match(resumeCommand({ registry: run.registry, target: r.runId }), /^resumed /)
  assert.ok(!existsSync(join(run.stateDir, 'paused.json')))
  assert.match(resumeCommand({ registry: run.registry, target: r.runId }), /not paused/)
  assert.throws(() => pauseCommand({ registry: run.registry, target: 'nope' }), /no run nope in the run registry/)
})

test("crew pause, resume: a crew start run is named by its run folder or the folder's name too; an unknown run is an error naming crew ls", () => {
  const folder = join(tmp(), 'runs', '9-20261001-120000-ab12')
  const stateDir = join(folder, 'orca-run')
  mkdirSync(stateDir, { recursive: true })
  const registry = registryIn()
  runRegistry(registry).armed({ runId: 'run_9', project: 'C:/repos/app', runDir: stateDir, spec: 'implement-spec-9', host: 'crew' })
  for (const target of ['run_9', folder, '9-20261001-120000-ab12', stateDir]) {
    assert.match(pauseCommand({ registry, target }), /^paused run_9: /, target)
    assert.ok(existsSync(join(stateDir, 'paused.json')))
    assert.match(resumeCommand({ registry, target }), /^resumed run_9: /, target)
    assert.ok(!existsSync(join(stateDir, 'paused.json')))
  }
  for (const command of [pauseCommand, resumeCommand]) assert.throws(() => command({ registry, target: 'nope' }), /no run nope in the run registry: `crew ls` lists them/)
})

test('crew rm: asks first, unless --yes; asks f for each worktree with unpushed commits, one at a time', async () => {
  const run = await endedRun()
  run.orca.worktrees.get(A_WT).unpushed = 3
  const [r] = readRegistry(run.registry)
  const asked = []
  const answers = ['n']
  const ask = async (q) => (asked.push(q), answers.shift())
  const no = await removeCommand({ registry: run.registry, target: r.runId, openHost: async () => run.orca, unpushed: run.orca.unpushedOf, ask, stopRunner: () => {} })
  assert.match(no, /nothing removed/)
  assert.match(asked[0], /^Remove run .*\? .* \[y\/N\] $/s)
  answers.push('y', 'f')
  const yes = await removeCommand({ registry: run.registry, target: r.runId, openHost: async () => run.orca, unpushed: run.orca.unpushedOf, ask, stopRunner: () => {} })
  assert.match(asked[2], /Force-delete C:\/fake\/worktrees\/run_fake1-1\? .*3 unpushed commits.* \[f = force-delete, anything else keeps it\] $/s)
  assert.equal(run.orca.worktrees.get(A_WT).removed, true)
  assert.match(yes, /^removed /)
  assert.deepEqual(readRegistry(run.registry), [])
})

test('crew rm --yes asks nothing about the run, and still asks about an unpushed worktree; one kept is named', async () => {
  const run = await endedRun()
  run.orca.worktrees.get(A_WT).unpushed = 1
  const [r] = readRegistry(run.registry)
  const asked = []
  const out = await removeCommand({ registry: run.registry, target: r.runId, openHost: async () => run.orca, unpushed: run.orca.unpushedOf, yes: true, ask: async (q) => (asked.push(q), 'k'), stopRunner: () => {} })
  assert.equal(asked.length, 1)
  assert.match(out, /; left on disk: C:\/fake\/worktrees\/run_fake1-1 \(.*1 unpushed commit.*\)$/)
  assert.ok(!/; kept /.test(out), 'every worktree left is named once, in one list')
})

test('reclaim: a live agent is refused and left untouched; once settled it is reclaimed, its open tab closed', async () => {
  const orca = fakeOrca({ worker: () => new Promise(() => {}) })
  const w = await orca.workerStart({ run: 'run_x', prompt: 'p', title: '[P] live', sessionId: SID, child: { name: 'run_x-1', displayName: '[P] live' } })
  const agent = { runId: 'run_x', n: 1, name: 'run_x-1', title: '[P] live', dispatchId: w.dispatchId, terminal: w.terminal, worktree: w.worktree, state: 'running' }
  const before = orca.calls.length
  assert.deepEqual(await reclaimAgent(agent, { host: orca, unpushed: orca.unpushedOf, force: true }), { reclaimed: false, reason: 'it is still live' })
  assert.deepEqual(
    orca.calls.slice(before).filter((c) => MUTATING.includes(c.verb)),
    [],
  )

  orca.dispatches.get(w.dispatchId).settled = true
  assert.equal((await reclaimAgent(agent, { host: orca, unpushed: orca.unpushedOf })).reclaimed, true)
  assert.deepEqual(
    orca.calls
      .slice(before)
      .filter((c) => [...MUTATING, 'terminalList'].includes(c.verb))
      .map((c) => c.verb),
    ['terminalList', 'workerRelease', 'terminalClose', 'worktreeRemove'],
  )
})

test('reclaim: the journal names each agent this run launched, with its Run, dispatch, tab, worktree and state', async () => {
  const run = await endedRun()
  // b's is the dispatch and tab of its last continuation.
  assert.deepEqual(
    agentsOf(join(run.stateDir, 'journal.jsonl')).map(({ name, dispatchId, terminal, worktree, state }) => ({ name, dispatchId, terminal, worktree, state })),
    [
      { name: 'run_fake1-1', dispatchId: 'ctx_fake1', terminal: 'term_fake1', worktree: A_WT, state: 'ok' },
      { name: 'run_fake1-2', dispatchId: 'ctx_fake5', terminal: 'term_fake5', worktree: B_WT, state: 'failed' },
      { name: 'run_fake1-3', dispatchId: 'ctx_fake6', terminal: 'term_fake6', worktree: 'C:/fake/run', state: 'ok' },
    ],
  )
})

test('reclaim: two agents whose worktrees share a name are each known by their own <runId>-<n>, reclaimed and shown reclaimed separately', async () => {
  const run = await endedRun()
  // b's journal names a's worktree as its own, as agents sharing one folder do (ADR-0020).
  const journal = join(run.stateDir, 'journal.jsonl')
  writeFileSync(journal, readFileSync(journal, 'utf8').replaceAll(B_WT, A_WT))
  const [a, b] = agentsOf(journal)
  assert.deepEqual(
    [
      [a.name, a.worktree],
      [b.name, b.worktree],
    ],
    [
      ['run_fake1-1', A_WT],
      ['run_fake1-2', A_WT],
    ],
  )
  const runId = a.runId
  const view = runView({ stateDir: run.stateDir, host: run.orca, clock: run.clock, transcripts: { usage: () => null }, registry: run.registry, alive: () => false })
  const runs = runsView({ host: run.orca, clock: run.clock, registry: run.registry, transcripts: { usage: () => null }, unpushed: run.orca.unpushedOf })
  const reclaimedNow = async () => {
    await view.refresh()
    return view.model.phases.flatMap((p) => p.agents).map((x) => [x.title, x.reclaimed])
  }
  const kept = async () => {
    await runs.refresh()
    return runs.model.projects.flatMap((p) => p.runs).find((x) => x.runId === runId).kept
  }
  const registry = runRegistry(run.registry, run.clock)

  assert.deepEqual((await reclaimRun([a], { host: run.orca, unpushed: run.orca.unpushedOf, registry, closeRun: false })).reclaimed, [a])
  assert.equal(run.orca.worktrees.get(A_WT).removed, true)
  assert.deepEqual(
    readRegistry(run.registry)
      .find((x) => x.runId === runId)
      .reclaimedAgents.map((x) => x.agent),
    ['run_fake1-1'],
  )
  assert.deepEqual(await reclaimedNow(), [
    ['[P] a', true],
    ['[P] b', false],
    ['[P] c', false],
  ])
  assert.equal(await kept(), 2, 'b and c are still left to reclaim')

  assert.deepEqual((await reclaimRun([b], { host: run.orca, unpushed: run.orca.unpushedOf, registry, closeRun: false })).reclaimed, [b])
  assert.deepEqual(
    readRegistry(run.registry)
      .find((x) => x.runId === runId)
      .reclaimedAgents.map((x) => x.agent),
    ['run_fake1-1', 'run_fake1-2'],
  )
  assert.deepEqual(await reclaimedNow(), [
    ['[P] a', true],
    ['[P] b', true],
    ['[P] c', false],
  ])
  assert.equal(await kept(), 1)
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

test('orca-cli: tab liveness is the terminal list without orphans; a reclaim closes the whole tab and force-removes the worktree by path', { skip: ORCA_SKIPPED }, async () => {
  const { argvs, orca } = recordingCli({
    'terminal list': {
      terminals: [
        { handle: 'term_a', orphaned: false },
        { handle: 'term_b', orphaned: true, title: null },
      ],
    },
  })
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
  const gone = new Promise((r) => {
    bothHung = r
  })
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
  runScript(TAKEOVER, { ...opts, host: orca, out: () => {}, clock: mortal }).catch(() => {})
  await gone

  const first = orca.calls.slice()
  const startOf = (label) => first.find((c) => c.verb === 'workerStart' && c.title === `[P] ${label}`)
  const c = orca.dispatches.get(startOf('c').dispatchId)
  if (death === 'gone') c.gone = true
  else c.exited = true
  if (oldTab === 'closed') orca.closeTab('term_old')

  const lines = []
  const result = await runScript(TAKEOVER, { ...opts, host: orca.as('term_new'), out: (s) => lines.push(s), resume: true })
  return { result, orca, first, startOf, calls: orca.calls.slice(first.length), journal: journalOf(stateDir), registry, lines }
}

for (const [oldTab, death] of [
  ['open', 'gone'],
  ['closed', 'gone'],
  ['open', 'exited'],
]) {
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
    assert.deepEqual(
      ofType(r.journal, 'run').map((e) => [e.runId, e.terminal]),
      [
        ['run_fake1', 'term_old'],
        ['run_fake1', 'term_new'],
      ],
    )

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
    assert.deepEqual(
      linesOf(r.registry).map((e) => [e.type, e.runId, e.terminal]),
      [
        ['armed', 'run_fake1', undefined],
        ['runner', 'run_fake1', 'term_old'],
        ['runner', 'run_fake1', 'term_new'],
        ['ended', 'run_fake1', undefined],
      ],
    )
    assert.deepEqual(
      readRegistry(r.registry).map((x) => [x.runner.terminal, x.state]),
      [['term_new', 'ok']],
    )

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
  const hung = new Promise((r) => {
    died = r
  })
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
  runScript(LEFT_OUT, { ...opts, host: orca, clock: first }).catch(() => {})
  await first.hung
  // A resume from terminal `from`, to its end, or on a `mortal` clock until it dies.
  const resume = async (from, mortal = null) => {
    const run = runScript(LEFT_OUT, { ...opts, host: orca.as(from), clock: mortal ?? clock, resume: true })
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
  assert.deepEqual(
    [
      ...new Set(
        r.orca.calls
          .slice(before)
          .filter((c) => c.verb === 'workerShow')
          .map((c) => c.dispatchId),
      ),
    ],
    [r.b.dispatchId],
  )
  const journal = journalOf(r.stateDir)
  assertEntries(journal)
  assert.deepEqual(ofType(journal, 'failed'), [])
  assert.deepEqual(
    ofType(journal, 'result').map((e) => [e.title, e.result, e.replayed]),
    [
      ['[P] a', GOOD, true],
      ['[P] b', GOOD, undefined],
    ],
  )
})

for (const how of ['refused', 'dies']) {
  test(`takeover: a resume ${how === 'refused' ? 'whose run-use Orca refuses for good' : 'that dies retrying its run-use'} leaves the worker still out to the next resume, which takes that same dispatch up and starts none`, async () => {
    const r = await leftOut()
    r.faults.runUse = () => new OrcaError('run_busy', 'not now', 'run-use')
    if (how === 'refused') {
      const once = await r.resume('term_2')
      assert.deepEqual([once.a, once.b], [GOOD, null])
      assert.deepEqual(
        once.worktrees_kept.map((k) => k.path),
        [r.b.worktree],
      )
      const journal = journalOf(r.stateDir)
      assertEntries(journal)
      // A failed line, so the run ends partial, but one that leaves the worker out.
      assert.deepEqual(
        ofType(journal, 'failed').map((e) => [e.title, e.workerOut, e.retained?.path]),
        [['[P] b', true, r.b.worktree]],
      )
    } else await r.resume('term_2', mortalOn(r.clock, true))
    // Either way the journal still holds b's worker, and only it.
    const out = [...readJournal(join(r.stateDir, 'journal.jsonl')).calls.values()].flat().filter((e) => e.worker)
    assert.deepEqual(
      out.map((e) => [e.worker.dispatchId, e.worker.dir]),
      [[r.b.dispatchId, 'agents/002-b']],
    )
    delete r.faults.runUse

    r.clock.at(r.clock.now() + 2 * MIN, r.submitB)
    const before = r.orca.calls.length
    const result = await r.resume('term_3')
    assert.deepEqual(result, { a: GOOD, b: GOOD })
    const calls = r.orca.calls.slice(before)
    assert.deepEqual(
      calls.filter((c) => c.verb === 'workerStart'),
      [],
    )
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
  const refused = await reclaimAgent(b, { host: r.orca, unpushed: r.orca.unpushedOf, force: true })
  assert.equal(refused.stoppable, true)
  assert.match(refused.reason, /^it failed and was kept with its worker still running, so Orca shows it live: only a reclaim that stops that worker first removes it \(r, then f, in the run view\), or close its tab \S+ in Orca and reclaim it again$/)
  // A worker started for it, but no dispatch named: never proof it is not live.
  assert.match((await reclaimAgent({ ...b, dispatchId: null }, { host: r.orca, unpushed: r.orca.unpushedOf, force: true, stop: true })).reason, /could not tell whether it is live/)
  assert.deepEqual(
    r.orca.calls.slice(before).filter((c) => MUTATING.includes(c.verb) || c.verb === 'workerStop'),
    [],
  )
  // Confirmed: its worker is stopped before anything is removed.
  assert.deepEqual(await reclaimAgent(b, { host: r.orca, unpushed: r.orca.unpushedOf, stop: true }), { reclaimed: true, notes: [] })
  const done = r.orca.calls
    .slice(before)
    .filter((c) => MUTATING.includes(c.verb) || c.verb === 'workerStop')
    .map((c) => c.verb)
  assert.equal(done[0], 'workerStop')
  assert.ok(done.includes('workerRelease'), done.join(' '))

  // The same from a journal written before `reattached` carried its Run: the
  // agent is still the worker that line names.
  const path = join(tmp(), 'journal.jsonl')
  writeFileSync(
    path,
    [
      { type: 'run', runId: 'run_1', terminal: 'term_a', lastN: 8 },
      { type: 'reattached', key: 'kb', n: 9, title: '[P] b', dispatchId: 'ctx_1', sessionId: SID, terminal: 'term_1', worktree: 'C:/wt/run_1-2', dir: 'agents/002-b' },
      { type: 'failed', key: 'kb', n: 9, title: '[P] b', reason: 'blocked on a human', attempts: 0, run: 'run_1', retained: { path: 'C:/wt/run_1-2', reason: 'kept' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  )
  const [old] = agentsOf(path)
  assert.deepEqual([old.name, old.dispatchId, old.terminal, old.state], ['run_1-2', 'ctx_1', 'term_1', 'failed'])
  const asked = []
  const waiting = { workerShow: async ({ dispatch }) => (asked.push(dispatch), { settled: false, gone: false, exited: false, waiting: 'Which branch?' }) }
  assert.deepEqual(await reclaimAgent(old, { host: waiting, unpushed: async () => 0 }), { reclaimed: false, reason: 'it is still live' })
  // Its failed line never said its worker was left running: no stop is offered.
  assert.deepEqual(await reclaimAgent(old, { host: waiting, unpushed: async () => 0, stop: true }), { reclaimed: false, reason: 'it is still live' })
  assert.deepEqual(asked, ['ctx_1', 'ctx_1'])
})

test("resume: every agent of the Run is named across resumes, once each in the run view and to a standalone Ctrl+R, under its worktree's name", async () => {
  const registry = registryIn()
  const r = await leftOut({ registry })
  const a = startedAs(r.orca, '[P] a')
  // A resume that dies once it has taken b up: its journal holds b both as
  // carried forward (outstanding) and as taken up (reattached).
  await r.resume('term_2', mortalOn(r.clock, true))
  const runId = ofType(journalOf(r.stateDir), 'run')[0].runId
  const view = runView({ stateDir: r.stateDir, host: r.orca, clock: r.clock, transcripts: { usage: () => null }, registry, alive: () => false })
  await view.refresh()
  assert.deepEqual(
    view.model.phases.flatMap((p) => p.agents).map((x) => [x.title, x.state, x.dispatchId]),
    [
      ['[P] a', 'done', a.dispatchId],
      ['[P] b', 'running', r.b.dispatchId],
    ],
  )
  assert.equal(view.model.header.runId, runId)
  assert.equal(view.model.header.counts.queued, 0)

  r.clock.at(r.clock.now() + 2 * MIN, r.submitB)
  const result = await r.resume('term_3')
  assert.deepEqual(result, { a: GOOD, b: GOOD })
  assertEntries(journalOf(r.stateDir))
  const names = [`${runId}-1`, `${runId}-2`]
  // a, replayed twice, is still the agent the fresh run started; b the worker two resumes took up.
  assert.deepEqual(
    agentsOf(join(r.stateDir, 'journal.jsonl')).map((x) => [x.title, x.name, x.dispatchId, x.state]),
    [
      ['[P] a', names[0], a.dispatchId, 'ok'],
      ['[P] b', names[1], r.b.dispatchId, 'ok'],
    ],
  )

  const runs = runsView({ host: r.orca, clock: r.clock, registry, transcripts: { usage: () => null }, unpushed: r.orca.unpushedOf })
  await runs.refresh()
  const run = () => runs.model.projects.flatMap((p) => p.runs).find((x) => x.runId === runId)
  assert.equal(run().kept, 2)
  const reclaimed = await runs.reclaim(runId)
  assert.deepEqual(
    reclaimed.reclaimed.map((x) => x.name),
    names,
  )
  const entry = readRegistry(registry).find((x) => x.runId === runId)
  assert.deepEqual(
    entry.reclaimedAgents.map((x) => x.agent),
    names,
  )
  assert.equal(entry.reclaimed, true)
  assert.equal(run().kept, 0)
})

test('fake orca: a Run takes worker-starts only from the terminal it is bound to, and run-use rebinds it', { skip: ORCA_SKIPPED }, async () => {
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

test('orca-cli: run-use takes the Run over from this terminal and reports the terminal it is now bound to', { skip: ORCA_SKIPPED }, async () => {
  const { orca, argvs } = recordingCli({ 'orchestration run-use': { run: { id: 'run_1', coordinator_handle: 'term_new', consumer_generation: 2 } } })
  assert.deepEqual(await orca.runUse({ runId: 'run_1' }), { runId: 'run_1', terminal: 'term_new' })
  assert.deepEqual(argvs, [['orchestration', 'run-use', '--id', 'run_1']])
})

test('orca-cli: a worker taken up from an earlier runner is shown as Orca sees it, by worker-show, and a release leaves its tab to reclaim', { skip: ORCA_SKIPPED }, async () => {
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
const startedJ = (n, title, min, harness, sessionId) => J('started', n, title, min, { run: 'run_fake1', dispatchId: `ctx_fake${n}`, harness, sessionId, worktree: wt(n), terminal: `term_fake${n}` })

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
async function treeIn(mode, { stateDir, orca, ...rest }) {
  if (mode === 'attached') {
    const view = runView({ stateDir, host: orca, ...rest })
    await view.refresh()
    return view
  }
  const runs = runsView({ host: orca, ...rest })
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
// With `crew`, the same run on the crew host: the registry names crew and
// the runner's session, term_runner, which its terminal list shows. In
// 'console' mode the tree is opened as `crew view` opens it, entering
// sessions, each run's host the one the registry names.
async function viewedRun(mode = 'attached', { crew = false } = {}) {
  const clock = fakeClock()
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock })
  const host = crew ? crewHosted(orca) : orca
  const elsewhere = fakeOrca({ clock })
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
  const writer = runRegistry(registry, { now: () => 0 })
  writer.armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783', ...(crew && { host: 'crew' }) })
  if (crew) writer.runner({ runId: 'run_fake1', terminal: 'term_runner', host: 'crew' })
  const { home } = transcriptHome({ claude: wt(1), pi: wt(2) })
  clock.t = 30 * MIN
  const hostOf = (name) => (name === (crew ? 'crew' : 'orca') ? host : elsewhere)
  const view = await treeIn(mode, { stateDir, orca: host, clock, transcripts: sessionTranscripts({ home, env: {} }), registry, unpushed: orca.unpushedOf, ...(mode === 'console' && { enter: true, hostOf }) })
  const agent = (n) => view.model.phases.flatMap((p) => p.agents).find((a) => a.n === n)
  const rowOf = (key) => view.model.rows.findIndex((r) => r.key === key)
  const since = orca.calls.length
  return { orca, host, clock, stateDir, registry, view, agent, rowOf, after: () => orca.calls.slice(since) }
}

viewTest('run view: the journal gives each agent its row, its state and its phase, phases in the order the run reached them', async (mode) => {
  const { view, agent } = await viewedRun(mode)
  const m = view.model
  assert.deepEqual(m.header, {
    name: 'implement-spec-783',
    project: 'controlayer',
    runId: 'run_fake1',
    spec: '#783',
    alive: true,
    ended: false,
    elapsedMs: 30 * MIN,
    counts: { blocked: 0, 'needs you': 0, starting: 0, running: 1, continued: 1, stuck: 1, failed: 1, queued: 1, done: 2, reclaimed: 0 },
    outage: null,
    halted: null,
    paused: null,
    outcome: null,
  })
  assert.deepEqual(
    m.phases.map((p) => [p.name, p.agents.map((a) => a.n)]),
    [
      ['Discover', [1]],
      ['Implement', [2, 3, 4, 5, 6]],
      ['Gate', [7]],
    ],
  )
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [agent(n).label, agent(n).state]),
    [
      ['discover', 'done'],
      ['impl:a', 'running'],
      ['impl:b', 'stuck'],
      ['impl:c', 'continued'],
      ['impl:d', 'queued'],
      ['impl:e', 'failed'],
      ['gate:a', 'done'],
    ],
  )
  assert.equal(agent(3).reason, 'no movement in its transcript or terminal for 20 minutes')
  assert.equal(agent(4).continuations, 2)
  assert.equal(agent(4).terminal, 'term_fake5', 'a continuation that reopened runs in its new tab')
  assert.equal(agent(4).reason, null, 'a continuation clears the nudge before it')
  assert.deepEqual([agent(6).reason, agent(6).worktree, agent(6).terminal, agent(6).tabOpen], ['its worker did not start: orca worktree create: call_timeout', wt(6), null, null])
  assert.equal(agent(7).replayed, true)
  assert.deepEqual([agent(2).harness, agent(2).sessionId, agent(2).worktree, agent(2).dispatchId], ['pi', VIEW_SID.pi, wt(2), 'ctx_fake2'])
  // A phase whose every agent is done starts folded: its agents have no rows.
  assert.deepEqual(
    m.rows.map((r) => r.key),
    ['phase:Discover', 'phase:Implement', 'agent:2', 'agent:3', 'agent:4', 'agent:5', 'agent:6', 'phase:Gate'],
  )
  assert.equal(m.selected, 0)
  assert.equal(m.pane.kind, 'phase')
})

viewTest('run view: a folded phase sums its agents up: done of total, its mix of states and its peak context', async (mode) => {
  const { view } = await viewedRun(mode)
  const [discover, implement, gate] = view.model.phases
  assert.deepEqual([discover.folded, discover.done, discover.total, discover.peakContext], [true, 1, 1, 210005])
  assert.deepEqual(discover.mix, { blocked: 0, 'needs you': 0, starting: 0, running: 0, continued: 0, stuck: 0, failed: 0, queued: 0, done: 1, reclaimed: 0 })
  assert.deepEqual([implement.folded, implement.done, implement.total, implement.peakContext], [false, 0, 5, 363000])
  assert.deepEqual(implement.mix, { blocked: 0, 'needs you': 0, starting: 0, running: 1, continued: 1, stuck: 1, failed: 1, queued: 1, done: 0, reclaimed: 0 })
  assert.deepEqual([gate.folded, gate.done, gate.total, gate.peakContext], [true, 1, 1, null], 'a replayed agent ran no session here')
  // A selected phase's pane names its failed and stuck agents, each with its reason.
  await view.key('DOWN')
  assert.deepEqual(
    view.model.pane.problems.map((p) => [p.agent.n, p.reason]),
    [
      [3, 'no movement in its transcript or terminal for 20 minutes'],
      [6, 'its worker did not start: orca worktree create: call_timeout'],
    ],
  )
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
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((n) => agent(n).state),
    ['blocked', 'starting', 'starting', 'running', 'reclaimed', 'failed'],
  )
  assert.deepEqual([agent(1).waiting, agent(1).reason], ['Which branch?', 'blocked on a human: Which branch?'])
  assert.deepEqual([agent(3).reason, agent(3).nextAt], ['its worker did not start: orca terminal create: runtime_unavailable', at(2.5)])
  assert.deepEqual([agent(4).waiting, agent(4).reason], [null, null], 'answered: no longer blocked')
  assert.equal(agent(5).reclaimed, true)
  assert.deepEqual(view.model.header.counts, { blocked: 1, 'needs you': 0, starting: 2, running: 1, continued: 0, stuck: 0, failed: 1, queued: 0, done: 0, reclaimed: 1 })
  const [implement] = view.model.phases
  assert.equal(implement.folded, false)
  assert.equal(view.model.pane.kind, 'phase')
  assert.deepEqual(
    view.model.pane.problems.map((p) => [p.agent.n, p.reason]),
    [
      [1, 'blocked on a human: Which branch?'],
      [6, 'its worker did not start: x'],
    ],
  )
  assert.equal(view.model.alert, 'BLOCKED ON A HUMAN: [Implement] impl:a in tab term_fake1 waits on Which branch?')

  // Drawn: its glyph and word, counted in the header, and on the flash line
  // over the log's latest event.
  const lines = draw(view.model, { width: 140, height: 30, flash: null, alert: view.model.alert }).lines.map(strip)
  assert.match(lines[1], /^ ! 1 blocked {2}◌ 2 starting {2}● 1 running {2}✓? ?.*✗ 1 failed {2}○ 1 reclaimed/)
  assert.match(lines.at(-2), /BLOCKED ON A HUMAN: \[Implement\] impl:a in tab term_fake1 waits on Which branch\?/)
  assert.match(lines[4], /!1 ◌2 ●1 ✗1 ○1/)
  const rows = draw(view.model, { width: 140, height: 30 }).lines.map(strip)
  assert.ok(
    rows.some((l) => /^ +1 +impl:a +! blocked /.test(l)),
    rows.join('\n'),
  )
  assert.ok(
    rows.some((l) => /^ +2 +impl:b +◌ starting /.test(l)),
    rows.join('\n'),
  )
  assert.ok(
    rows.some((l) => /^ +5 +impl:e +○ reclaimed /.test(l)),
    rows.join('\n'),
  )

  // Answered: the alert goes, and the log's latest event is back.
  put(J('unblocked', 1, '[Implement] impl:a', 7, { dispatchId: 'ctx_fake1' }))
  await view.refresh()
  assert.deepEqual([agent(1).state, view.model.alert, view.model.latest], ['running', null, '>> [Implement] impl:e: result received'])
})

// A patient in its second doctor round, as the runner journals it: the
// doctors' n come after an agent started meanwhile, and their own lines have
// no call key.
viewTest("run view: a doctor's row is indented under its patient's, in round order, whatever its number", async (mode) => {
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
  assert.deepEqual(
    view.model.rows.map((r) => [r.key, r.depth ?? null]),
    [
      ['phase:Implement', null],
      ['agent:1', 0],
      ['agent:3', 1],
      ['agent:4', 1],
      ['agent:2', 0],
      ['agent:5', 0],
    ],
  )
  const row = (n) => view.model.rows.find((r) => r.key === `agent:${n}`).agent
  assert.deepEqual([row(3).patient, row(4).patient, row(1).doctors, row(1).round], [1, 1, [3, 4], 2])
  assert.deepEqual([row(3).state, row(4).state], ['failed', 'running'])
  assert.equal(row(3).reason, 'it gave up')
  // Each doctor is a row of its own, in the header's counts and its phase's
  // mix, by what it is: one that gave up is failed, never done.
  const counts = { blocked: 0, 'needs you': 0, starting: 0, running: 2, continued: 0, stuck: 0, failed: 2, queued: 1, done: 0, reclaimed: 0 }
  assert.deepEqual(view.model.header.counts, counts)
  const [implement] = view.model.phases
  assert.deepEqual([implement.total, implement.done, implement.mix], [5, 0, counts])

  const lines = () => draw(view.model, { width: 140, height: 30 }).lines.map(strip)
  assert.match(lines()[1], /● 2 running {2}· 1 queued {2}✗ 2 failed/)
  assert.match(lines()[4], /^ ▾ Implement +0\/5 done +●2 ✗2 ·1 *$/)
  // A round that gave up answered the same failure the next one answers.
  assert.match(lines()[5], /^ +1 +impl:a +✗ failed /)
  assert.match(lines()[6], /^ +3 +└ recover +✗ failed /, 'under its patient, named by its role')
  assert.match(lines()[7], /^ +4 +└ recover +● running /)
  assert.match(lines()[8], /^ +2 +impl:b /)
  // Selected, its pane has its whole title.
  while (view.model.rows[view.model.selected].key !== 'agent:4') await view.key('DOWN')
  assert.match(lines().at(-6), /\[Implement\] recover -> impl:a {2}● running/)
})

// A patient's doctor that escalated, as the runner journals it: its mail
// line names it by n, and is about no agent's lifecycle otherwise.
viewTest('run view: a doctor that escalated is "? needs you" in bold yellow, counted in the header, listed first in its phase, and its reason on the flash line until its next message', async (mode) => {
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock: fakeClock() })
  const stateDir = tmp()
  const title = '[Implement] recover -> impl:a'
  const mailJ = (min, messageId, kind, action, body) => ({ type: 'mail', at: at(min), messageId, kind, action, doctor: 3, patient: 1, round: 1, body })
  const journalPath = join(stateDir, 'journal.jsonl')
  const put = (...entries) => appendFileSync(journalPath, entries.map((e) => JSON.stringify(e) + '\n').join(''))
  put(
    { type: 'run', at: at(0), runId: 'run_fake1', terminal: 'term_runner' },
    startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'),
    startedJ(2, '[Implement] impl:b', 1, 'claude', 'sid-2'),
    J('failed', 4, '[Implement] impl:c', 1, { reason: 'its worker did not start: x', attempts: 4, run: 'run_fake1' }),
    J('doctor', 1, '[Implement] impl:a', 2, { origin: 1, round: 1, reason: 'its session died past its continuation cap, with no result', doctor: 3 }),
    { ...startedJ(3, title, 2, 'claude', 'sid-3'), key: null },
    mailJ(3, 'msg_1', 'escalation', 'needsYou', ASK),
  )
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  writeFileSync(join(stateDir, 'runner.log'), `${at(3)} !!!!!!!! ${title} NEEDS YOU: ${ASK}\n`)
  const registry = registryIn()
  runRegistry(registry, { now: () => 0 }).armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783' })
  const view = await treeIn(mode, { stateDir, orca, clock: fakeClock(), transcripts: sessionTranscripts({ home: tmp(), env: {} }), registry, unpushed: orca.unpushedOf })
  const row = (n) => view.model.rows.find((r) => r.key === `agent:${n}`).agent
  assert.ok(STATES.includes('needs you'))
  assert.deepEqual([row(3).state, row(3).reason, row(3).patient], ['needs you', ASK, 1])
  // Its patient is ✗ failed while its doctor is at work (#77).
  assert.deepEqual(view.model.header.counts, { blocked: 0, 'needs you': 1, starting: 0, running: 1, continued: 0, stuck: 0, failed: 2, queued: 0, done: 0, reclaimed: 0 })
  assert.equal(view.model.phases[0].mix['needs you'], 1)
  assert.deepEqual(
    view.model.pane.problems.map((p) => [p.agent.n, p.reason]),
    [
      [3, ASK],
      [1, 'its session died past its continuation cap, with no result'],
      [4, 'its worker did not start: x'],
    ],
  )
  assert.equal(view.model.alert, `NEEDS YOU: ${title} in tab term_fake3: ${ASK}`)

  const raw = draw(view.model, { width: 200, height: 30, flash: null, alert: view.model.alert }).lines
  const lines = raw.map(strip)
  assert.match(lines[1], /^ \? 1 needs you {2}● 1 running {2}✗ 2 failed/)
  assert.ok(raw[1].includes('\x1b[1;33m? 1 needs you'), 'bold yellow in the header')
  assert.ok(
    lines.some((l) => /^ +3 +└ recover +\? needs you /.test(l)),
    lines.join('\n'),
  )
  assert.ok(
    raw.some((l) => l.includes('\x1b[1;33m? needs you')),
    'bold yellow on its row',
  )
  assert.match(lines[4], /\?1 ●1 ✗2/)
  assert.ok(lines.at(-2).includes(`NEEDS YOU: ${title} in tab term_fake3: ${ASK}`), lines.at(-2))
  assert.ok(raw.at(-2).includes('\x1b[1;33mNEEDS YOU'), 'the alert in bold yellow')

  // A second escalation replaces the reason; its handoff ends the wait.
  put(mailJ(4, 'msg_2', 'escalation', 'needsYou', ASK2))
  await view.refresh()
  assert.deepEqual([row(3).state, view.model.alert], ['needs you', `NEEDS YOU: ${title} in tab term_fake3: ${ASK2}`])
  put(mailJ(5, 'msg_3', 'handoff', 'remedy', NOTE))
  await view.refresh()
  assert.deepEqual([row(3).state, row(3).reason, view.model.alert, view.model.header.counts['needs you']], ['running', null, null, 0])
})

// A patient's journal through its doctor rounds, as the runner writes it: the
// runner continued it to its cap, then each round is its `doctor` line, its
// doctor's own lines under key null, and how the round ended: 'remedy' (the
// doctor's note carried it on), 'gaveUp' (its doctor settled failed), or null
// (its doctor still at work). `then`: the patient's lines after the last round.
const DOCTOR_TITLE = '[Implement] recover -> impl:a'
function roundsJournal(rounds, then = []) {
  const reason = 'its session died past its continuation cap, with no result'
  const patient = (type, min, more) => J(type, 1, '[Implement] impl:a', min, more)
  const lines = [{ type: 'run', at: at(0), runId: 'run_fake1', terminal: 'term_runner' }, startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'), patient('continued', 1, { dispatchId: 'ctx_fake1', sessionId: 'sid-1', terminal: 'term_fake1', reason: 'it exited', attempt: 3, reopened: false })]
  rounds.forEach((outcome, i) => {
    const round = i + 1
    const doctor = 2 + i
    const min = 2 + 2 * i
    const own = (e) => ({ ...e, key: null })
    lines.push(patient('doctor', min, { origin: 1, round, reason, doctor }), own(J('starting', doctor, DOCTOR_TITLE, min, { run: 'run_fake1' })), own(startedJ(doctor, DOCTOR_TITLE, min, 'claude', `sid-${doctor}`)))
    if (outcome === 'remedy') {
      lines.push(
        { type: 'mail', at: at(min + 1), messageId: `m${round}`, kind: 'handoff', action: 'remedy', doctor, patient: 1, round, body: `note ${round}` },
        patient('remedy', min + 1, { origin: 1, round, doctor, how: 'continue', messageId: `m${round}`, dispatchId: 'ctx_fake1', terminal: 'term_fake1', reopened: false }),
        own(J('settled', doctor, DOCTOR_TITLE, min + 1, { dispatchId: `ctx_fake${doctor}`, outcome: 'succeeded' })),
      )
    } else if (outcome === 'gaveUp') {
      lines.push(own(J('settled', doctor, DOCTOR_TITLE, min + 1, { dispatchId: `ctx_fake${doctor}`, outcome: 'failed' })), patient('gaveUp', min + 1, { origin: 1, round, doctor, reason: 'its worker settled failed with no remedy' }))
    }
  })
  return [...lines, ...then.map(([type, more]) => patient(type, 2 + 2 * rounds.length, more))]
}

async function roundsRun(mode, rounds, then) {
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock: fakeClock() })
  const stateDir = tmp()
  writeFileSync(
    join(stateDir, 'journal.jsonl'),
    roundsJournal(rounds, then)
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  )
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  const registry = registryIn()
  runRegistry(registry, { now: () => 0 }).armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783' })
  const view = await treeIn(mode, { stateDir, orca, clock: fakeClock(), transcripts: { usage: () => null }, registry, unpushed: orca.unpushedOf })
  if (view.model.phases[0].folded) await view.key('ENTER')
  return { view, patient: () => view.model.phases[0].agents.find((a) => a.n === 1) }
}

// Moves the selection onto row `key`, which must be drawn.
async function selectRow(view, key) {
  const at = view.model.rows.findIndex((r) => r.key === key)
  assert.ok(at >= 0, `no row ${key}`)
  while (view.model.selected !== at) await view.key(view.model.selected < at ? 'DOWN' : 'UP')
}

// One ✗ per failure a doctor answered, then the glyph and state; the count is
// the attempt, continued counting the doctors' continuations of it.
const TRAILS = [
  ['1 round, its doctor at work', [null], [], ['failed', 1, 1], '✗ failed'],
  ['1 round, remedied', ['remedy'], [], ['continued', 1, 2], '✗● continued'],
  ['1 round, remedied, and its session then continued by the runner', ['remedy'], [['continued', { dispatchId: 'ctx_fake1', sessionId: 'sid-1', terminal: 'term_fake1', reason: 'it exited', attempt: 1, reopened: false }]], ['continued', 1, 2], '✗● continued'],
  ["2 rounds, the second's doctor at work", ['remedy', null], [], ['failed', 2, 2], '✗✗ failed ×2'],
  ['2 rounds, both remedied', ['remedy', 'remedy'], [], ['continued', 2, 3], '✗✗● continued ×2'],
  ['3 rounds, the second given up, then done', ['remedy', 'gaveUp', 'remedy'], [['result', { result: GOOD }]], ['done', 2, 3], '✗✗✓ done ×3'],
]
for (const [name, rounds, then, fold, label] of TRAILS) {
  viewTest(`run view: a patient's STATE is its trail: ${name} is ${label}`, async (mode) => {
    const { view, patient } = await roundsRun(mode, rounds, then)
    assert.deepEqual([patient().state, patient().failures, patient().attempt], fold)
    assert.equal(patient().rounds.length, rounds.length)
    await selectRow(view, 'agent:1')
    const lines = draw(view.model, { width: 140, height: 30 }).lines.map(strip)
    assert.match(lines[5], new RegExp(`^ +1 +impl:a +${label} +░`))
    assert.match(lines.at(-6), new RegExp(`\\[Implement\\] impl:a {2}${label} {2}ctx`))
    for (let n = 2; n <= 1 + rounds.length; n++)
      assert.ok(
        lines.some((l) => new RegExp(`^ +${n} +└ recover `).test(l)),
        `doctor ${n}`,
      )
  })
}

viewTest("run view: the runner's own continuations are never in STATE: the detail pane names them", async (mode) => {
  const { view, agent } = await viewedRun(mode)
  assert.deepEqual([agent(4).state, agent(4).continuations, agent(4).failures], ['continued', 2, 0])
  await selectRow(view, 'agent:4')
  const lines = draw(view.model, { width: 140, height: 30 }).lines.map(strip)
  assert.ok(!lines.slice(0, -6).join('\n').includes('×'), 'no ×n in STATE')
  const pane = lines.slice(-6, -2)
  assert.match(pane[0], /\[Implement\] impl:c {2}↻ continued {2}ctx/)
  assert.match(pane[1], /session sid-4 {3}the runner continued it 2 times/)
  // One the runner never continued names none.
  await selectRow(view, 'agent:2')
  assert.ok(
    !draw(view.model, { width: 140, height: 30 })
      .lines.map(strip)
      .some((l) => l.includes('the runner continued it')),
  )
})

viewTest("run view: context size, its band and tokens come from each agent's Claude or pi transcript", async (mode) => {
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
  assert.deepEqual(
    [1, 2, 3, 5, 6, 7].map((n) => agent(n).elapsedMs),
    [10 * MIN, 29 * MIN, 28 * MIN, null, 8 * MIN, null],
  )
  clock.t += 5 * MIN
  await view.refresh()
  assert.deepEqual(
    [1, 2, 3, 6].map((n) => agent(n).elapsedMs),
    [10 * MIN, 34 * MIN, 33 * MIN, 8 * MIN],
  )
  assert.equal(view.model.header.elapsedMs, 35 * MIN)
  // A runner that is gone: the run's time stops at its last journal entry.
  rmSync(join(stateDir, 'runner.pid'))
  await view.refresh()
  assert.deepEqual([view.model.header.alive, view.model.header.elapsedMs], [false, 25 * MIN])
})

viewTest("run view: a tab is open or closed as Orca's terminal list says, whatever its worker's state", async (mode) => {
  const { view, agent, orca } = await viewedRun(mode)
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => agent(n).tabOpen),
    [true, true, true, true],
    "a done agent's tab stays open",
  )
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
  assert.deepEqual(
    after()
      .filter((c) => c.verb === 'terminalSwitch')
      .map((c) => c.terminal),
    ['term_fake2', 'term_fake5'],
  )

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
  assert.deepEqual(
    view.model.rows.map((r) => r.key),
    ['phase:Discover', 'phase:Implement', 'phase:Gate'],
  )
  assert.equal(view.model.rows[view.model.selected].key, 'phase:Implement')
  await view.key('ENTER')
  assert.equal(folded('Implement'), false)
  await view.key('LEFT')
  assert.equal(folded('Implement'), true)
  await view.key('RIGHT')
  assert.equal(folded('Implement'), false)
  await view.click(rowOf('phase:Discover'))
  assert.equal(folded('Discover'), false)
  assert.deepEqual(
    view.model.rows.slice(0, 3).map((r) => r.key),
    ['phase:Discover', 'agent:1', 'phase:Implement'],
  )
  // The operator's fold outlives a refresh.
  await view.refresh()
  assert.deepEqual([folded('Discover'), folded('Implement')], [false, false])
  assert.equal(view.model.rows[view.model.selected].key, 'phase:Discover')
  assert.deepEqual(
    after().filter((c) => c.verb === 'terminalSwitch'),
    [],
  )
})

// --- the reclaim dialog `Ctrl+R` opens ---------------------------------------------

const reclaimedIn = (registry) =>
  linesOf(registry)
    .filter((e) => e.type === 'reclaimed')
    .map((e) => e.agent ?? null)
const mutations = (calls) => calls.filter((c) => MUTATING.includes(c.verb))
const touched = (calls) => mutations(calls).map((c) => [c.verb, c.verb === 'workerRelease' ? c.dispatchId : (c.terminal ?? c.path)])
// The terminal lines (1-based) its options are drawn on, in option order.
const optionLines = (screen) => screen.lines.map((_, i) => i + 1).filter((y) => screen.optionAt(y) !== null)

viewTest('reclaim dialog: Ctrl+R opens it over the tree, its options in order; Reclaim All is greyed out with its reason while the run is still going, and selectable once it has ended, though its runner lives on', async (mode) => {
  const { view, stateDir, registry, after } = await viewedRun(mode)
  const press = pressOn(view)
  assert.equal(view.model.dialog, null)
  assert.deepEqual(await press('CTRL_R'), {})
  const d = view.model.dialog
  assert.deepEqual([d.kind, d.title, d.highlight], ['choose', 'Reclaim', 0])
  assert.deepEqual(
    d.options.map((o) => [o.id, o.label, o.disabled]),
    [
      ['selected', 'Reclaim Selected', false],
      ['successful', 'Reclaim Successful Ones', false],
      ['all', 'Reclaim All', true],
    ],
  )
  assert.equal(d.options[2].reason, 'the run is still going')
  assert.equal(d.options[0].detail, 'every agent of Discover', 'the selected row is the Discover phase')

  const screen = draw(view.model, { width: 140, height: 30 })
  const ys = optionLines(screen)
  assert.deepEqual(
    ys.map((y) => screen.optionAt(y)),
    [0, 1, 2],
  )
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
  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify({ runner: 'session', host: 'orca', ok: true, result: {} }))
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
  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify({ runner: 'session', host: 'orca', ok: false, error: 'x' }))
  await view.refresh()
  assert.deepEqual(all(), [false, null])

  // A runner gone, summary.json or not: nothing runs the script.
  rmSync(join(stateDir, 'summary.json'))
  rmSync(join(stateDir, 'runner.pid'))
  await view.refresh()
  assert.deepEqual(all(), [false, null])
  assert.deepEqual(mutations(after()), [])
})

test("run ended: by the registry's `ended` with no resume after, a gone runner, or a live runner's summary.json; never by whether the runner lives; null when it cannot be told", () => {
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
  assert.equal(runEnded({ run: running, alive: null, stateDir: dir }), null, "a summary.json no live runner vouches for may be an earlier run's")
})

// view.mjs hands both a hover and a click on an option to view.highlight.
viewTest('reclaim dialog: the arrows, a hover and a click move the highlight; only Enter accepts, and Esc closes it having reclaimed nothing', async (mode) => {
  const { view, after, registry } = await viewedRun(mode)
  const press = pressOn(view)
  await press('CTRL_R')
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
  await press('CTRL_R')
  const calls = after().length
  for (const k of ['LEFT', 'RIGHT', 'l', 'q', 'CTRL_R', 'r', 'R', 'x']) assert.deepEqual(await press(k), {}, k)
  assert.deepEqual(await click(rowOf('phase:Implement')), {})
  assert.deepEqual(await click(rowOf('agent:4')), {})
  assert.equal(view.model.rows[view.model.selected].key, selected)
  assert.equal(view.model.phases.find((p) => p.name === 'Implement').folded, false)
  assert.equal(after().length, calls, 'no tab switched, no log opened')
  const screen = draw(view.model, { width: 140, height: 30 })
  assert.deepEqual(
    screen.lines.map((_, i) => screen.rowAt(i + 1)).filter((i) => i !== null),
    [],
    'no row takes a click',
  )
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
  await press('CTRL_R')
  assert.equal(run.view.model.dialog.options[0].detail, '[Discover] discover')
  const one = await press('ENTER')
  assert.deepEqual([one.option, one.reclaim, one.agent], ['selected', { reclaimed: true, notes: [] }, { n: 1, title: '[Discover] discover' }])
  assert.equal(run.view.model.dialog, null)
  assert.deepEqual(touched(run.after()), [
    ['workerRelease', 'ctx_fake1'],
    ['terminalClose', 'term_fake1'],
    ['worktreeRemove', wt(1)],
  ])
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-1'])

  // Reclaim Successful Ones: the done agents, a live one never touched.
  run = await viewedRun(mode)
  press = pressOn(run.view)
  run.orca.dispatches.get('ctx_fake1').settled = true
  await press('CTRL_R')
  await press('DOWN')
  const done = await press('ENTER')
  assert.equal(done.option, 'successful')
  assert.deepEqual(done.reclaimed, [{ n: 1, title: '[Discover] discover' }])
  assert.deepEqual(done.kept, [])
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-1'])
  assert.deepEqual(touched(run.after()), [
    ['workerRelease', 'ctx_fake1'],
    ['terminalClose', 'term_fake1'],
    ['worktreeRemove', wt(1)],
  ])

  // Reclaim All once the run has ended, its runner still waiting on the view:
  // every agent, the live ones refused.
  run = await viewedRun(mode)
  press = pressOn(run.view)
  run.orca.dispatches.get('ctx_fake1').settled = true
  run.orca.dispatches.get('ctx_fake3').settled = true
  runRegistry(run.registry, { now: () => 0 }).ended({ runId: 'run_fake1', outcome: 'partial' })
  await run.view.refresh()
  await press('CTRL_R')
  await press('DOWN')
  await press('DOWN')
  const all = await press('ENTER')
  assert.equal(all.option, 'all')
  assert.deepEqual(
    all.reclaimed.map((a) => a.n),
    [1, 3, 6],
  )
  assert.deepEqual(
    all.kept.map((k) => [k.agent.n, k.reason]),
    [
      [2, 'it is still live'],
      [4, 'it is still live'],
    ],
  )
  assert.match(run.view.model.message, /^reclaimed 3 of \d+ agents of the run; kept \[Implement\] impl:a: it is still live; kept \[Implement\] impl:c: it is still live$/)
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-1', 'run_fake1-3', 'run_fake1-6'])
  for (const d of ['ctx_fake2', 'ctx_fake5']) assert.equal(run.orca.dispatches.get(d).released, false, d)
})

// A sequential run (ADR-0020) as its journal tells it: three chain agents in
// the one run_fake1-chain, 1 and 2 done, 3 still live, over a fake Orca that
// made the chain and holds each agent's tab.
const RUN_CHAIN = 'C:/fake/worktrees/run_fake1-chain'
async function reclaimableChainRun(mode = 'attached', { alive } = {}) {
  const clock = fakeClock()
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock })
  await orca.chainWorktree({ runId: 'run_fake1' })
  for (let n = 1; n <= 3; n++) await orca.workerStart({ run: 'run_fake1', prompt: 'p', title: `t${n}`, sessionId: SID, chain: RUN_CHAIN })
  const stateDir = tmp()
  const started = (n, label, min) => J('started', n, `[Implement] ${label}`, min, { run: 'run_fake1', dispatchId: `ctx_fake${n}`, harness: 'claude', sessionId: `sid-${n}`, worktree: RUN_CHAIN, terminal: `term_fake${n}` })
  const journal = [{ type: 'chain', at: at(0), runId: 'run_fake1', worktree: RUN_CHAIN, lines: [] }, started(1, 'impl:#1', 0), J('result', 1, '[Implement] impl:#1', 5, { result: GOOD }), started(2, 'impl:#2', 6), J('result', 2, '[Implement] impl:#2', 10, { result: GOOD }), started(3, 'impl:#3', 11)]
  writeFileSync(join(stateDir, 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  const registry = registryIn()
  runRegistry(registry, { now: () => 0 }).armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783' })
  clock.t = 20 * MIN
  for (const d of ['ctx_fake1', 'ctx_fake2']) orca.dispatches.get(d).settled = true
  const rest = { stateDir, clock, transcripts: { usage: () => null }, registry, unpushed: orca.unpushedOf, ...(alive && { alive }) }
  const view = mode ? await treeIn(mode, { orca, ...rest }) : null
  const since = orca.calls.length
  return { orca, clock, registry, view, rest, chain: orca.worktrees.get(RUN_CHAIN), after: () => orca.calls.slice(since) }
}
const selectKey = async (view, key) => {
  while (view.model.rows[view.model.selected].key !== key) await pressOn(view)('DOWN')
}
const chooseOption = async (view, id) => {
  const press = pressOn(view)
  await press('CTRL_R')
  while (view.model.dialog.options[view.model.dialog.highlight].id !== id) await press('DOWN')
  return press('ENTER')
}

viewTest("sequential run: Reclaim Selected and Reclaim Successful Ones close chain agents' tabs and never remove the chain worktree they share", async (mode) => {
  const run = await reclaimableChainRun(mode)
  assert.deepEqual(
    run.view.model.phases.flatMap((p) => p.agents).map((a) => a.worktree),
    [RUN_CHAIN, RUN_CHAIN, RUN_CHAIN],
    'each row still shows the chain',
  )
  await selectKey(run.view, 'agent:1')
  const one = await chooseOption(run.view, 'selected')
  assert.deepEqual([one.option, one.reclaim], ['selected', { reclaimed: true, notes: [] }])
  assert.deepEqual(touched(run.after()), [
    ['workerRelease', 'ctx_fake1'],
    ['terminalClose', 'term_fake1'],
  ])

  const done = await chooseOption(run.view, 'successful')
  assert.deepEqual([done.reclaimed.map((a) => a.n), done.kept], [[2], []])
  assert.deepEqual(touched(run.after()), [
    ['workerRelease', 'ctx_fake1'],
    ['terminalClose', 'term_fake1'],
    ['workerRelease', 'ctx_fake2'],
    ['terminalClose', 'term_fake2'],
  ])
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-1', 'run_fake1-2'])
  assert.equal(run.chain.removed, false)
})

viewTest("sequential run: Reclaim All once the run has ended removes the chain worktree after every agent's tab, never while an agent is kept live, and its unpushed commits only once f forces it", async (mode) => {
  const run = await reclaimableChainRun(mode)
  runRegistry(run.registry, { now: () => 0 }).ended({ runId: 'run_fake1', outcome: 'ok' })
  await run.view.refresh()
  const live = await chooseOption(run.view, 'all')
  assert.deepEqual(
    live.reclaimed.map((a) => a.n),
    [1, 2],
  )
  assert.deepEqual(
    live.kept.map((k) => [k.agent.n, k.reason]),
    [
      [3, 'it is still live'],
      [null, 'an agent of the run was kept'],
    ],
  )
  assert.match(run.view.model.message, /kept run_fake1-chain: an agent of the run was kept/)
  assert.equal(run.chain.removed, false)
  assert.ok(!run.after().some((c) => c.verb === 'worktreeRemove'))

  run.orca.dispatches.get('ctx_fake3').settled = true
  run.chain.unpushed = 2
  const held = await chooseOption(run.view, 'all')
  assert.deepEqual([held.reclaimed.map((a) => a.n), held.kept.map((k) => k.agent.title)], [[3], ['run_fake1-chain']])
  assert.equal(run.view.model.dialog.title, 'Reclaim run_fake1-chain?')
  assert.match(run.view.model.dialog.lines[0], /run_fake1-chain holds 2 unpushed commits; only a forced reclaim removes it/)
  assert.equal(run.chain.removed, false)
  const forced = await pressOn(run.view)('f')
  assert.deepEqual([forced.agent, forced.reclaim.reclaimed, run.view.model.message], [{ runId: 'run_fake1', n: null, title: 'run_fake1-chain', chain: true }, true, 'reclaimed run_fake1-chain'])
  assert.deepEqual(touched(run.after()).slice(-3), [
    ['workerRelease', 'ctx_fake3'],
    ['terminalClose', 'term_fake3'],
    ['worktreeRemove', RUN_CHAIN],
  ])
  assert.equal(run.chain.removed, true)
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-1', 'run_fake1-2', 'run_fake1-3', 'run_fake1-chain'])
  // The chain's reclaim is recorded: Reclaim All has nothing left, and removes it no more.
  const again = await chooseOption(run.view, 'all')
  assert.deepEqual([again.reclaimed, again.kept, run.view.model.message], [[], [], 'the run: no agent left to reclaim'])
  assert.equal(touched(run.after()).filter(([verb]) => verb === 'worktreeRemove').length, 1)
})

test('sequential run: Ctrl+R on the runs list closes a run whose runner is dead with its chain worktree, which unpushed commits keep, and the run with it', async () => {
  const held = await reclaimableChainRun(null, { alive: () => false })
  held.orca.dispatches.get('ctx_fake3').settled = true
  held.chain.unpushed = 1
  const runs = runsView({ host: held.orca, ...held.rest })
  await runs.refresh()
  let r = await runs.reclaim('run_fake1')
  assert.deepEqual([r.reclaimed.map((a) => a.n), r.kept.map((k) => [k.agent.title, k.unpushed])], [[1, 2, 3], [['run_fake1-chain', 1]]])
  assert.deepEqual([held.chain.removed, reclaimedIn(held.registry)], [false, ['run_fake1-1', 'run_fake1-2', 'run_fake1-3']], 'the run stays open')
  held.chain.unpushed = 0
  r = await runs.reclaim('run_fake1')
  assert.deepEqual([r.reclaimed, r.kept], [[], []])
  assert.deepEqual([held.chain.removed, reclaimedIn(held.registry)], [true, ['run_fake1-1', 'run_fake1-2', 'run_fake1-3', 'run_fake1-chain', null]])
})

test('sequential run: a resume that remakes a reclaimed chain and carries its node on under the same <runId>-<n> keeps the chain from Ctrl+R while that agent is live in it', async () => {
  const run = await reclaimableChainRun(null, { alive: () => false })
  run.orca.dispatches.get('ctx_fake3').settled = true
  const runs = runsView({ host: run.orca, ...run.rest })
  await runs.refresh()
  await runs.reclaim('run_fake1')
  assert.deepEqual([run.chain.removed, reclaimedIn(run.registry)], [true, ['run_fake1-1', 'run_fake1-2', 'run_fake1-3', 'run_fake1-chain', null]])
  // r: a runner takes the run up again, remakes the chain and carries node 3 on in it, as run_fake1-3; then it dies too.
  runRegistry(run.registry, { now: () => 0 }).runner({ runId: 'run_fake1', terminal: 'term_runner2' })
  const remade = await run.orca.chainWorktree({ runId: 'run_fake1' })
  const w = await run.orca.workerStart({ run: 'run_fake1', prompt: 'p', title: 't3', sessionId: SID, chain: remade.path })
  appendFileSync(
    join(run.rest.stateDir, 'journal.jsonl'),
    [{ type: 'chain', at: at(25), runId: 'run_fake1', worktree: remade.path, lines: [] }, J('started', 3, '[Implement] impl:#3', 26, { run: 'run_fake1', dispatchId: w.dispatchId, harness: 'claude', sessionId: 'sid-3b', worktree: remade.path, terminal: w.terminal })].map((e) => JSON.stringify(e)).join('\n') + '\n',
  )
  const chain = run.orca.worktrees.get(remade.path)
  assert.equal(chain.removed, false, 'the chain is made again')
  await runs.refresh()
  let r = await runs.reclaim('run_fake1')
  assert.deepEqual([r.reclaimed, r.kept.map((k) => [k.agent.title, k.reason])], [[], [['run_fake1-chain', '[Implement] impl:#3 is still live in it']]])
  assert.equal(chain.removed, false)
  run.orca.dispatches.get(w.dispatchId).settled = true
  r = await runs.reclaim('run_fake1')
  assert.deepEqual([r.reclaimed, r.kept, chain.removed], [[], [], true])
  assert.deepEqual(reclaimedIn(run.registry).slice(-2), ['run_fake1-chain', null])
})

viewTest('run view: f cycles the filter off → running → done → off; a filter keeps every phase row and only its agents, unfolds a done phase while it is on, and the header names it', async (mode) => {
  const { view } = await viewedRun(mode)
  const press = pressOn(view)
  const keys = () => view.model.rows.map((r) => r.key)
  const all = ['phase:Discover', 'phase:Implement', 'agent:2', 'agent:3', 'agent:4', 'agent:5', 'agent:6', 'phase:Gate']
  assert.deepEqual([view.model.filter, keys()], [null, all])
  assert.equal(strip(draw(view.model, { width: 160, height: 30 }).lines[1]).includes('filter'), false)

  assert.match((await press('f')).message, /^filter: running — 3 agents shown$/)
  assert.equal(view.model.filter, 'running')
  assert.deepEqual(keys(), ['phase:Discover', 'phase:Implement', 'agent:2', 'agent:3', 'agent:4', 'phase:Gate'], 'running is every agent at work: running, stuck and continued here; queued and failed are not')
  assert.match(strip(draw(view.model, { width: 160, height: 30 }).lines[1]), /filter running/)

  assert.match((await press('f')).message, /^filter: done — 2 agents shown$/)
  assert.equal(view.model.filter, 'done')
  assert.deepEqual(keys(), ['phase:Discover', 'agent:1', 'phase:Implement', 'phase:Gate', 'agent:7'], 'a phase folded for being all done unfolds while a filter is on, so what it keeps is seen')
  assert.match(strip(draw(view.model, { width: 160, height: 30 }).lines[1]), /filter done/)

  assert.match((await press('f')).message, /^filter off$/)
  assert.deepEqual([view.model.filter, keys()], [null, all])

  // The operator's own fold holds under a filter.
  await press('f')
  await press('f')
  await view.click(view.model.rows.findIndex((r) => r.key === 'phase:Gate'))
  assert.deepEqual(keys(), ['phase:Discover', 'agent:1', 'phase:Implement', 'phase:Gate'])
})

viewTest('run view: Ctrl+F opens a search dialog that takes every key; Enter keeps agents whose name contains the text, case blind, never a phase name; Esc keeps the last search; an empty search is off; it combines with f', async (mode) => {
  const { view } = await viewedRun(mode)
  const press = pressOn(view)
  const keys = () => view.model.rows.map((r) => r.key)
  const type = async (text) => {
    for (const ch of text) await press(ch)
  }
  assert.equal(view.model.search, null)
  await press('CTRL_F')
  assert.deepEqual(view.model.dialog, { kind: 'search', title: 'Search agents', text: '' })
  const drawn = () => draw(view.model, { width: 140, height: 30 }).lines.map(strip)
  assert.ok(
    drawn().some((l) => /Search agents/.test(l)),
    'the dialog is drawn over the tree',
  )
  await type('Impl:B')
  await press('BACKSPACE')
  assert.equal(view.model.dialog.text, 'Impl:')
  assert.ok(
    drawn().some((l) => /Impl:▏/.test(l)),
    'the text is drawn with a cursor after it',
  )
  // q, ?, r and the arrows are text or nothing while the dialog is open: none quits, consults or moves.
  await type('q?')
  await press('UP')
  assert.deepEqual([view.model.dialog.text, view.model.selected], ['Impl:q?', 0])
  await press('BACKSPACE')
  await press('BACKSPACE')
  assert.match((await press('ENTER')).message, /^search: Impl: — 5 agents shown$/)
  assert.deepEqual([view.model.dialog, view.model.search], [null, 'Impl:'])
  assert.deepEqual(keys(), ['phase:Discover', 'phase:Implement', 'agent:2', 'agent:3', 'agent:4', 'agent:5', 'agent:6', 'phase:Gate'])
  assert.match(strip(draw(view.model, { width: 160, height: 30 }).lines[1]), /search Impl:/)

  // Ctrl+F again starts from the last search; Esc cancels and keeps it.
  await press('CTRL_F')
  assert.equal(view.model.dialog.text, 'Impl:')
  await type('zzz')
  assert.match((await press('ESCAPE')).message, /^search kept: Impl:$/)
  assert.deepEqual([view.model.dialog, view.model.search], [null, 'Impl:'])

  // A phase's name is never searched: the phases stay, as the tree, and no agent is named by one.
  await press('CTRL_F')
  for (let i = 0; i < 5; i++) await press('BACKSPACE')
  await type('Implement')
  assert.match((await press('ENTER')).message, /^search: Implement — no agent shown$/)
  assert.deepEqual(keys(), ['phase:Discover', 'phase:Implement', 'phase:Gate'])

  // Search and filter are both applied.
  await press('CTRL_F')
  for (let i = 0; i < 9; i++) await press('BACKSPACE')
  await type('impl:')
  await press('ENTER')
  await press('f')
  assert.deepEqual([view.model.filter, view.model.search, keys()], ['running', 'impl:', ['phase:Discover', 'phase:Implement', 'agent:2', 'agent:3', 'agent:4', 'phase:Gate']])
  await press('f')
  assert.deepEqual(keys(), ['phase:Discover', 'phase:Implement', 'phase:Gate'], 'done agents, none of them named impl:')
  assert.match((await press('f')).message, /^filter off — 5 agents shown$/, 'the search still on, the count is what the tree shows')

  // Enter on an empty text turns the search off.
  await press('CTRL_F')
  for (let i = 0; i < 5; i++) await press('BACKSPACE')
  await press('BACKSPACE')
  assert.equal(view.model.dialog.text, '', 'a backspace on nothing is nothing')
  assert.match((await press('ENTER')).message, /^search off$/)
  assert.deepEqual([view.model.search, keys().length], [null, 8])
  for (const help of [TREE_HELP, consoleTreeHelp('crew', 'f12'), consoleTreeHelp('orca', 'f12'), strip(draw(view.model, { width: 200, height: 30 }).lines.at(-1))]) assert.match(help, /f filter · Ctrl\+F search/)
})

// --- the run console: `crew view`, a crew run's sessions entered in place -----

// The fake Orca as a host whose sessions are entered in place, as crew's are,
// the runner's own session among its terminals.
function crewHosted(orca) {
  return { ...orca, id: 'crew', name: 'crew', inPlace: true, terminalList: async () => [...(await orca.terminalList()), 'term_runner'] }
}

test('run console: a done agent whose crew session is parked keeps its done state, its row tagged parked and its pane saying Enter resumes it; an Orca run has no such tag', async () => {
  const { view, agent, rowOf, host } = await viewedRun('console', { crew: true })
  host.terminalsParked = async () => ['term_fake1']
  await view.refresh()
  assert.deepEqual([agent(1).state, agent(1).parked], ['done', true])
  assert.deepEqual(
    [2, 3, 4].map((n) => agent(n).parked),
    [false, false, false],
  )
  assert.equal(view.model.header.counts.done, 2, 'parked is no state: still counted done')
  const plainLines = () => draw(view.model, { width: 140, height: 30 }).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
  // A phase whose agents are all done is folded: unfold it to see the row.
  await view.click(rowOf('phase:Discover'))
  const row = plainLines().find((l) => /discover/.test(l) && /✓ done/.test(l))
  assert.match(row, /✓ done .*10m00s   ⏾ parked *$/)
  assert.ok(!plainLines().some((l) => /impl:a/.test(l) && /parked/.test(l)))
  await view.click(rowOf('agent:1'))
  assert.ok(plainLines().some((l) => /tab term_fake1 \(parked: Enter resumes it\)/.test(l)))

  const orca = await viewedRun('console')
  assert.equal(orca.agent(1).parked, false, 'a host that cannot park says nothing of it')
})

test('help line: one too long for the screen scrolls by an offset, clamped, a ‹ or › where more is cut; one that fits never moves', () => {
  const help = 'abcdefghij'
  assert.deepEqual([strip(helpLine(help, 20, 5).text), helpLine(help, 20, 5).offset], ['abcdefghij', 0])
  assert.deepEqual([strip(helpLine(help, 6, 0).text), helpLine(help, 6, 0).offset], ['abcde›', 0])
  assert.deepEqual([strip(helpLine(help, 6, 2).text), helpLine(help, 6, 2).offset], ['‹cdef›', 2])
  assert.deepEqual([strip(helpLine(help, 6, 99).text), helpLine(help, 6, 99).offset], ['‹fghij', 5])
  assert.equal(helpLine(help, 6, -3).offset, 0)
  // draw scrolls its last line, says where it is and the offset it took.
  const screen = draw(null, { width: 6, height: 20, help, helpOffset: 99 })
  assert.deepEqual([strip(screen.lines.at(-1)), screen.helpAt, screen.helpOffset], ['‹fghij', screen.lines.length, 5])
  assert.match(consoleTreeHelp('crew', 'f12'), /^ ↑↓ move · /)
})

test("run console: Ctrl+P opens the park dialog, Park Selected only on a done agent, Park All Done parking every done agent's open session; Orca has none to park", async () => {
  const { view, rowOf, host } = await viewedRun('console', { crew: true })
  const parkedNow = new Set()
  host.terminalsParked = async () => [...parkedNow]
  host.terminalPark = async ({ terminal }) => {
    parkedNow.add(terminal)
  }
  const press = pressOn(view)
  await view.click(rowOf('phase:Discover'))
  await view.click(rowOf('agent:1'))
  await press('CTRL_P')
  assert.equal(view.model.dialog.title, 'Park')
  assert.deepEqual(
    view.model.dialog.options.map((o) => [o.id, o.label, o.detail]),
    [
      ['park-selected', 'Park Selected', '[Discover] discover'],
      ['park-done', 'Park All Done', 'the 1 done agent with a running session'],
    ],
  )
  const drawn = draw(view.model, { width: 140, height: 30 }).lines.map(strip)
  assert.ok(
    drawn.some((l) => /Enter parks · Esc closes/.test(l)),
    'the dialog says what Enter does',
  )
  await press('ESCAPE')
  assert.equal(view.model.dialog, null)

  // On an agent that is not done, only Park All Done.
  await view.click(rowOf('agent:3'))
  await press('CTRL_P')
  assert.deepEqual(
    view.model.dialog.options.map((o) => o.id),
    ['park-done'],
  )
  const res = await press('ENTER')
  assert.deepEqual([...parkedNow], ['term_fake1'])
  assert.match(res.message, /parked 1 of 1 done agent/)
  assert.equal(view.model.phases[0].agents[0].parked, true)
  // Nothing left to park.
  await press('CTRL_P')
  assert.match(view.model.dialog.options[0].detail, /the 0 done agents/)
  await press('ESCAPE')

  const orca = await viewedRun('console')
  assert.match((await pressOn(orca.view)('CTRL_P')).message, /only crew parks/)
})

test("run console: a crew run's tree is its phases and agents, no runner row; Enter or a click on an agent answers its session to enter, brings no tab forward, and the selection stays on that row", async () => {
  const { view, rowOf, orca, after } = await viewedRun('console', { crew: true })
  const press = pressOn(view)
  assert.ok(!view.model.rows.some((r) => r.kind === 'runner'), 'no runner row')
  assert.deepEqual(
    view.model.rows.slice(0, 2).map((r) => r.key),
    ['phase:Discover', 'phase:Implement'],
  )
  const at = rowOf('agent:2')
  assert.deepEqual(await clickOn(view)(at), { enter: { session: 'term_fake2', title: '[Implement] impl:a' } })
  // Back from the session, the console refreshes the tree: the selection is where it was.
  await listOf.get(view).refresh()
  assert.deepEqual([view.model.selected, view.model.rows[view.model.selected].key], [at, 'agent:2'])
  await press('DOWN')
  assert.deepEqual(await press('ENTER'), { enter: { session: 'term_fake3', title: '[Implement] impl:b' } })
  assert.equal(view.model.message, null)
  await orca.terminalClose({ terminal: 'term_fake3' })
  await view.refresh()
  assert.deepEqual(await press('ENTER'), { message: "[Implement] impl:b's crew session term_fake3 is closed" })
  assert.deepEqual(await view.click(rowOf('agent:5')), { message: '[Implement] impl:d has no session: its worker never started here' })
  assert.deepEqual(
    after().filter((c) => c.verb === 'terminalSwitch'),
    [],
  )
})

test('run console: arrows walk list → tree → session: Right opens a run and enters an agent, Right unfolds a folded phase, Left goes back from the tree to the list', async () => {
  const { view } = await viewedRun('console', { crew: true })
  const runs = listOf.get(view)
  // Left in the tree goes back to the list, whatever row is selected.
  await runs.key('LEFT')
  assert.equal(runs.opened(), null, 'back on the list')
  // On the run's row Right opens its tree again, as Enter does.
  while (runs.model.rows[runs.model.selected].kind !== 'run') await runs.key('DOWN')
  await runs.key('RIGHT')
  const tree = runs.opened()
  assert.ok(tree, 'the tree is open')
  // Right on an agent enters its session.
  while (tree.model.rows[tree.model.selected].key !== 'agent:2') await runs.key('DOWN')
  assert.deepEqual(await runs.key('RIGHT'), { enter: { session: 'term_fake2', title: '[Implement] impl:a' } })
  // Right on a folded phase unfolds it; on an unfolded one it does nothing.
  const discover = tree.model.rows.findIndex((r) => r.key === 'phase:Discover')
  await tree.click(discover)
  const folded = tree.model.rows[discover].phase.folded
  await runs.key('RIGHT')
  assert.equal(tree.model.rows[discover].phase.folded, false, folded ? 'Right unfolded it' : 'it stays unfolded')
  await runs.key('LEFT')
  assert.equal(runs.opened(), null, 'Left from the tree is the list again')
})

test("run console: on a crew run, l enters the runner's log as a session, closed once left", async () => {
  const { view, host } = await viewedRun('console', { crew: true })
  host.logTail = async () => ({ terminal: 'term_log' })
  assert.deepEqual(await pressOn(view)('l'), { enter: { session: 'term_log', title: 'runner.log', close: true } })
})

test("run console: r in a halted crew run's tree writes the resume request its runner takes, and the runner resumes from it", async () => {
  const { stateDir, registry, view } = await viewedRun('console', { crew: true })
  const runs = listOf.get(view)
  appendFileSync(join(stateDir, 'journal.jsonl'), JSON.stringify({ type: 'halted', at: new Date(0).toISOString(), node: 'n/x', reason: 'it died' }) + '\n')
  runRegistry(registry, { now: () => 0 }).halted({ runId: 'run_fake1', node: 'n/x', reason: 'it died' })
  await runs.refresh()
  await view.refresh()
  assert.ok(view.model.header.halted, 'the tree knows the run is halted')
  const r = await runs.key('r')
  assert.match(r.message, /^asked the runner to resume/)
  const file = join(stateDir, 'resume-request.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { node: null })
  const got = []
  const watch = watchResumeRequests({ stateDir, resume: (m) => got.push(m), pollMs: 60_000 })
  watch.take()
  watch.stop()
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(got, [{ node: null, decisions: null }])
  assert.equal(existsSync(file), false, 'the runner took the request')
  // The orchestrator's decide (#194): a node with the operator's answers; malformed ones are dropped, a request of none carries none.
  writeFileSync(file, JSON.stringify({ node: 'n/x', decisions: [{ question: 'which?', answer: 'that one' }, { question: 7 }, 'nope', { question: 'and?', answer: '' }] }))
  watch.take()
  writeFileSync(file, JSON.stringify({ node: 'n/y', decisions: [] }))
  watch.take()
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(got.slice(1), [
    { node: 'n/x', decisions: [{ question: 'which?', answer: 'that one' }] },
    { node: 'n/y', decisions: null },
  ])
})

test("run console: the attached view of a crew run, itself in the runner's session, has no runner row and names where to enter an agent's session", async () => {
  const { view, rowOf } = await viewedRun('attached', { crew: true })
  assert.equal(view.model.rows[0].key, 'phase:Discover')
  assert.deepEqual(await view.click(rowOf('agent:2')), { message: '[Implement] impl:a runs in crew session term_fake2: enter it from `crew view run_fake1`' })
})

test('run console: on an Orca run there is no runner row, and Enter or a click on an agent still brings its Orca tab to the front', async () => {
  const { view, rowOf, after } = await viewedRun('console')
  assert.equal(view.model.rows[0].key, 'phase:Discover')
  assert.deepEqual(await view.click(rowOf('agent:2')), { switched: 'term_fake2' })
  assert.deepEqual(await pressOn(view)('ENTER'), { switched: 'term_fake2' })
  assert.deepEqual(
    after()
      .filter((c) => c.verb === 'terminalSwitch')
      .map((c) => c.terminal),
    ['term_fake2', 'term_fake2'],
  )
})

test('run console: reclaim on a crew run goes to the crew host by the same rules: never a live agent, and one with unpushed commits only once forced', async () => {
  const { view, rowOf, orca, registry, after } = await viewedRun('console', { crew: true })
  const press = pressOn(view)
  await view.click(rowOf('agent:2'))
  await press('CTRL_R')
  const live = await press('ENTER')
  assert.deepEqual([live.agent.n, live.reclaim.reason, view.model.dialog], [2, 'it is still live', null])
  orca.dispatches.get('ctx_fake2').settled = true
  orca.worktrees.get(wt(2)).unpushed = 2
  await press('CTRL_R')
  const held = await press('ENTER')
  assert.equal(held.reclaim.unpushed, 2)
  assert.deepEqual([view.model.dialog.kind, view.model.dialog.title], ['confirm', 'Reclaim [Implement] impl:a?'])
  assert.deepEqual(mutations(after()), [], 'nothing is touched before it is forced')
  const forced = await press('f')
  assert.equal(forced.reclaim.reclaimed, true)
  assert.deepEqual(reclaimedIn(registry), ['run_fake1-2'])
  assert.deepEqual(touched(after()), [
    ['workerRelease', 'ctx_fake2'],
    ['terminalClose', 'term_fake2'],
    ['worktreeRemove', wt(2)],
  ])
})

test('run console: r on a crew run whose runner lives has nothing to resume; once it is dead, r resumes it on the crew host', async () => {
  const { view, stateDir, host } = await viewedRun('console', { crew: true })
  const press = pressOn(view)
  const resumed = []
  host.resumeRunner = async (o) => {
    resumed.push(o)
    return { terminal: '9', command: 'node runner.mjs' }
  }
  assert.deepEqual(await press('r'), { message: "implement-spec-783 run_fake1's runner is alive: nothing to resume" })
  rmSync(join(stateDir, 'runner.pid'))
  await listOf.get(view).refresh()
  assert.deepEqual(await press('r'), { message: 'resumed implement-spec-783 run_fake1 in crew session 9', resumed: '9' })
  assert.deepEqual(
    resumed.map((o) => [o.stateDir, o.worktree]),
    [[stateDir, 'C:/repos/controlayer']],
  )
})

test("run console: R does nothing, in a halted run's tree or on the runs list with a dead runner; the key lines name Ctrl+R reclaim and r resume", async () => {
  const { view, stateDir, registry, host } = await viewedRun('console', { crew: true })
  const runs = listOf.get(view)
  const resumed = []
  host.resumeRunner = async (o) => {
    resumed.push(o)
    return { terminal: '9', command: 'node runner.mjs' }
  }
  appendFileSync(join(stateDir, 'journal.jsonl'), JSON.stringify({ type: 'halted', at: new Date(0).toISOString(), node: 'n/x', reason: 'it died' }) + '\n')
  runRegistry(registry, { now: () => 0 }).halted({ runId: 'run_fake1', node: 'n/x', reason: 'it died' })
  await runs.refresh()
  await view.refresh()
  assert.ok(view.model.header.halted, 'the tree knows the run is halted')
  assert.deepEqual(await runs.key('R'), {})
  assert.equal(existsSync(join(stateDir, 'resume-request.json')), false, 'R asked the runner nothing')
  assert.equal(view.model.dialog, null, 'R opened no dialog')
  rmSync(join(stateDir, 'runner.pid'))
  await runs.refresh()
  assert.deepEqual(await runs.key('R'), {}, 'in the tree of a dead runner')
  await runs.key('q')
  assert.deepEqual(await runs.key('R'), {}, 'on the list')
  assert.deepEqual(resumed, [], 'R started no runner')
  const list = drawRuns(runs.model, { width: 160, height: 30, title: 'crew runs', help: consoleRunsHelp('f5') }).lines.map(strip)
  assert.match(list.at(-1), /Ctrl\+R reclaim the run · p pause · r resume · x remove/)
  assert.match(list.join('\n'), /Ctrl\+R reclaims every agent .* · r resumes it: its runner is dead/)
})

test("run console: the frames — no runner row, the key line naming the back key, the runs list as crew runs, and crew ls's lines", async () => {
  const { view } = await viewedRun('console', { crew: true })
  const screen = draw(view.model, { width: 140, height: 30, help: consoleTreeHelp('crew', 'f12') })
  const lines = screen.lines.map(strip)
  const discover = lines.findIndex((l) => /▸ Discover/.test(l))
  assert.equal(screen.rowAt(discover + 1), 0, 'the first row is the first phase (rowAt takes a 1-based y)')
  assert.ok(!lines.some((l) => /runner {3}crew session|the runner {2}crew session/.test(l)), 'no runner row or pane')
  // Too long for 140 columns: cut with a ›, the rest a sideways scroll away.
  assert.match(lines.at(-1), /^ ↑↓ move · ⏎\/→\/click enter · F12 out of a session · ← runs · g tickets · f filter · Ctrl\+F search · Ctrl\+R reclaim · Ctrl\+P park · l log · .*›$/)
  assert.match(strip(draw(view.model, { width: 140, height: 30, help: consoleTreeHelp('crew', 'f12'), helpOffset: 99 }).lines.at(-1)), /^‹.*x remove · \? orchestrator$/)
  assert.equal(consoleTreeHelp('orca', 'f12'), `${TREE_HELP} · ? orchestrator`, "an Orca run's agent is its tab; ? is crew's orchestrator whatever the host")
  const runs = listOf.get(view)
  await runs.key('q')
  const list = drawRuns(runs.model, { width: 160, height: 30, title: 'crew runs', help: consoleRunsHelp('f5') }).lines.map(strip)
  assert.match(list[0], /^ crew runs · 1 run · 1 project/)
  assert.ok(
    list.some((l) => /^ project C:\/repos\/controlayer/.test(l)),
    list.join('\n'),
  )
  assert.match(list.at(-1), /q quit · F5 leaves an entered session/)
  const ls = listRuns(runs.model)
  assert.equal(ls[0], 'controlayer  C:/repos/controlayer')
  assert.match(ls[1], /^ {2}run_fake1 +crew +#783 +running +runner ● alive +\d+ kept +30m$/)
})

viewTest("reclaim dialog: Reclaim Selected on a phase row reclaims that phase's agents, and no other", async (mode) => {
  const { view, rowOf, orca, registry, after } = await viewedRun(mode)
  const press = pressOn(view)
  for (const n of [1, 2, 3]) orca.dispatches.get(`ctx_fake${n}`).settled = true
  await view.click(rowOf('phase:Implement'))
  await view.click(rowOf('phase:Implement'))
  assert.equal(view.model.rows[view.model.selected].key, 'phase:Implement')
  await press('CTRL_R')
  assert.equal(view.model.dialog.options[0].detail, 'every agent of Implement')
  const r = await press('ENTER')
  assert.equal(r.option, 'selected')
  // impl:e never started, but Orca made it a worktree: that is removed too.
  assert.deepEqual(
    r.reclaimed.map((a) => a.n),
    [2, 3, 6],
  )
  assert.deepEqual(
    r.kept.map((k) => [k.agent.n, k.reason]),
    [[4, 'it is still live']],
  )
  assert.deepEqual(reclaimedIn(registry), ['run_fake1-2', 'run_fake1-3', 'run_fake1-6'])
  assert.equal(orca.dispatches.get('ctx_fake1').released, false, "Discover's agent is not the phase's")
  assert.deepEqual(
    after()
      .filter((c) => c.verb === 'workerRelease')
      .map((c) => c.dispatchId),
    ['ctx_fake2', 'ctx_fake3'],
  )
})

// Implement: impl:a (1), a patient its doctor (3) carried on to done, its
// worktree and its doctor's each their own, and impl:b (2), done. With
// `failed`, impl:a's doctor gave up and impl:a failed, its doctor done.
async function familyRun(mode, { failed = false } = {}) {
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock: fakeClock() })
  for (let n = 1; n <= 3; n++) await orca.workerStart({ run: 'run_fake1', prompt: 'p', title: `t${n}`, sessionId: SID, child: { name: `run_fake1-${n}`, displayName: `t${n}` } })
  for (let n = 1; n <= 3; n++) orca.dispatches.get(`ctx_fake${n}`).settled = true
  const stateDir = tmp()
  const reason = 'its session died past its continuation cap, with no result'
  const own = (e) => ({ ...e, key: null })
  const ends = failed
    ? [own(J('settled', 3, DOCTOR_TITLE, 5, { dispatchId: 'ctx_fake3', outcome: 'succeeded' })), J('gaveUp', 1, '[Implement] impl:a', 5, { origin: 1, round: 1, doctor: 3, reason: 'it gave up: no idea' }), J('failed', 1, '[Implement] impl:a', 6, { reason, attempts: 1, run: 'run_fake1' })]
    : [
        { type: 'mail', at: at(5), messageId: 'm1', kind: 'handoff', action: 'remedy', doctor: 3, patient: 1, round: 1, body: 'note' },
        J('remedy', 1, '[Implement] impl:a', 5, { origin: 1, round: 1, doctor: 3, how: 'continue', messageId: 'm1', dispatchId: 'ctx_fake1', terminal: 'term_fake1', reopened: false }),
        own(J('settled', 3, DOCTOR_TITLE, 5, { dispatchId: 'ctx_fake3', outcome: 'succeeded' })),
        J('result', 1, '[Implement] impl:a', 8, { result: GOOD }),
      ]
  const journal = [
    { type: 'run', at: at(0), runId: 'run_fake1', terminal: 'term_runner' },
    startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'),
    startedJ(2, '[Implement] impl:b', 1, 'claude', 'sid-2'),
    J('doctor', 1, '[Implement] impl:a', 3, { origin: 1, round: 1, reason, doctor: 3 }),
    own(J('starting', 3, DOCTOR_TITLE, 3, { run: 'run_fake1' })),
    own(startedJ(3, DOCTOR_TITLE, 3, 'claude', 'sid-3')),
    J('result', 2, '[Implement] impl:b', 4, { result: GOOD }),
    ...ends,
  ]
  writeFileSync(join(stateDir, 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(stateDir, 'runner.pid'), String(process.pid))
  const registry = registryIn()
  runRegistry(registry, { now: () => 0 }).armed({ runId: 'run_fake1', project: 'C:/repos/controlayer', runDir: stateDir, spec: 'implement-spec-783' })
  runRegistry(registry, { now: () => 0 }).ended({ runId: 'run_fake1', outcome: failed ? 'partial' : 'ok' })
  const view = await treeIn(mode, { stateDir, orca, clock: fakeClock(), transcripts: { usage: () => null }, registry, unpushed: orca.unpushedOf })
  if (view.model.phases[0].folded) await view.key('ENTER')
  return { orca, registry, view, press: pressOn(view) }
}

// Each dialog option, as the row it is chosen on and its index.
const OPTIONS = [
  ["Reclaim Selected on the patient's row", 'agent:1', 0],
  ["Reclaim Selected on its doctor's row", 'agent:3', 0],
  ["Reclaim Selected on their phase's row", 'phase:Implement', 0],
  ['Reclaim Successful Ones', 'phase:Implement', 1],
  ['Reclaim All', 'phase:Implement', 2],
]
const choose = async ({ view, press }, row, option) => {
  await selectRow(view, row)
  await press('CTRL_R')
  for (let i = 0; i < option; i++) await press('DOWN')
  assert.equal(view.model.dialog.highlight, option)
  return press('ENTER')
}

viewTest('reclaim dialog: under every option, a doctor is reclaimed with its patient, right after it', async (mode) => {
  for (const [name, row, option] of OPTIONS) {
    const run = await familyRun(mode)
    await selectRow(run.view, row)
    await run.press('CTRL_R')
    if (option === 0 && row !== 'phase:Implement') assert.equal(run.view.model.dialog.options[0].detail, '[Implement] impl:a, with its doctor', name)
    if (option === 1) assert.equal(run.view.model.dialog.options[1].detail, 'the 2 done, with their doctors')
    await run.press('ESCAPE')
    await choose(run, row, option)
    const expected = row === 'phase:Implement' ? ['run_fake1-1', 'run_fake1-3', 'run_fake1-2'] : ['run_fake1-1', 'run_fake1-3']
    assert.deepEqual(reclaimedIn(run.registry), expected, name)
    assert.deepEqual(
      run.orca.calls.filter((c) => c.verb === 'worktreeRemove').map((c) => c.path),
      expected.map((e) => wt(Number(e.slice(-1)))),
      name,
    )
    assert.equal(run.view.model.dialog, null, name)
    if (row === 'phase:Implement') assert.match(run.view.model.message, /^reclaimed 3 of 3 agents of /, name)
    else assert.match(run.view.model.message, /^reclaimed \[Implement\] impl:a, with its doctor$/, name)
  }
})

viewTest('reclaim dialog: under every option, a doctor is never reclaimed on its own: kept while its patient is, then reclaimed with it once f confirms it', async (mode) => {
  for (const [name, row, option] of OPTIONS) {
    const run = await familyRun(mode)
    run.orca.worktrees.get(wt(1)).unpushed = 2
    const r = await choose(run, row, option)
    assert.ok(!reclaimedIn(run.registry).includes('run_fake1-1'), name)
    assert.ok(!reclaimedIn(run.registry).includes('run_fake1-3'), name)
    assert.equal(run.orca.dispatches.get('ctx_fake3').released, false, name)
    if (row === 'phase:Implement')
      assert.deepEqual(
        r.kept.map((k) => [k.agent.n, k.reason]),
        [
          [1, `${wt(1)} holds 2 unpushed commits; only a forced reclaim removes it`],
          [3, 'its patient [Implement] impl:a was kept'],
        ],
        name,
      )
    assert.equal(run.view.model.dialog?.title, 'Reclaim [Implement] impl:a?', name)
    await run.press('f')
    assert.deepEqual(
      reclaimedIn(run.registry).filter((a) => a !== 'run_fake1-2'),
      ['run_fake1-1', 'run_fake1-3'],
      name,
    )
    assert.equal(run.view.model.dialog, null, name)
  }
  // Cancelled, neither is reclaimed.
  const run = await familyRun(mode)
  run.orca.worktrees.get(wt(1)).unpushed = 2
  await choose(run, 'agent:3', 0)
  await run.press('x')
  assert.deepEqual(reclaimedIn(run.registry), [])
})

viewTest('reclaim dialog: a done doctor of a failed patient is no successful one: Reclaim Successful Ones leaves it with its patient', async (mode) => {
  const run = await familyRun(mode, { failed: true })
  const agent = (n) => run.view.model.phases[0].agents.find((a) => a.n === n)
  assert.deepEqual([agent(1).state, agent(3).state], ['failed', 'done'])
  await selectRow(run.view, 'phase:Implement')
  await run.press('CTRL_R')
  assert.equal(run.view.model.dialog.options[1].detail, 'the 1 done')
  await run.press('ESCAPE')
  const r = await choose(run, 'phase:Implement', 1)
  assert.deepEqual([r.reclaimed.map((a) => a.n), r.kept], [[2], []])
  assert.deepEqual(reclaimedIn(run.registry), ['run_fake1-2'])
  assert.equal(run.orca.dispatches.get('ctx_fake3').released, false)
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
  put(startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'), startedJ(2, '[Implement] impl:b', 1, 'claude', 'sid-2'), startedJ(3, '[Gate] gate:a', 2, 'claude', 'sid-3'), J('result', 2, '[Implement] impl:b', 8, { result: GOOD }), J('result', 3, '[Gate] gate:a', 9, { result: GOOD }))
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
  await press('CTRL_R')
  const r = await press('ENTER')
  assert.deepEqual([r.reclaimed, r.kept.map((k) => k.agent.n)], [[], [1, 2]])
  assert.match(r.message, /^reclaimed 0 of 2 agents of Implement; 2 to confirm$/)
  assert.deepEqual(mutations(orca.calls), [])
  assert.equal(
    orca.calls.some((c) => c.verb === 'workerStop'),
    false,
  )

  // impl:a's worker first: drawn over the tree, which takes no click.
  assert.deepEqual(view.model.dialog.kind, 'confirm')
  assert.equal(view.model.dialog.title, 'Reclaim [Implement] impl:a?')
  const screen = draw(view.model, { width: 140, height: 30 })
  const text = screen.lines.map(strip)
  assert.ok(text.some((l) => l.includes('Reclaim [Implement] impl:a?')))
  assert.ok(text.some((l) => l.includes('f = stop its worker, then reclaim it · any other key cancels')))
  assert.deepEqual(
    screen.lines.map((_, i) => screen.rowAt(i + 1)).filter((i) => i !== null),
    [],
  )
  assert.deepEqual(await clickOn(view)(rowOf('agent:2')), {})
  // f confirms the stop; its unpushed commit then asks again, for that,
  // before anything is stopped.
  await press('f')
  assert.equal(
    orca.calls.some((c) => c.verb === 'workerStop'),
    false,
  )
  assert.equal(view.model.dialog.title, 'Reclaim [Implement] impl:a?')
  assert.ok(
    draw(view.model, { width: 140, height: 30 })
      .lines.map(strip)
      .some((l) => l.includes('f = force the reclaim, and those commits are lost')),
  )
  await press('f')
  assert.deepEqual(
    orca.calls.filter((c) => c.verb === 'workerStop').map((c) => c.dispatchId),
    ['ctx_fake1'],
  )
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
  assert.deepEqual(
    view.model.rows.map((r) => r.key),
    ['phase:Implement', 'agent:1', 'agent:2', 'phase:Gate', 'agent:3'],
  )
  await view.click(rowOf('agent:2'))
  await press('CTRL_R')
  const refused = await press('ENTER')
  assert.deepEqual([refused.reclaim.unpushed, refused.agent], [3, { n: 2, title: '[Implement] impl:b' }])
  assert.equal(view.model.dialog.title, 'Reclaim [Implement] impl:b?')

  // impl:a finishes while the force question is open: Implement folds, and
  // the selection falls on gate:a's row.
  orca.dispatches.get('ctx_fake1').settled = true
  put(J('result', 1, '[Implement] impl:a', 11, { result: GOOD }))
  await view.refresh()
  assert.deepEqual(
    view.model.rows.map((r) => r.key),
    ['phase:Implement', 'phase:Gate', 'agent:3'],
  )
  assert.equal(view.model.rows[view.model.selected].key, 'agent:3')

  const since = orca.calls.length
  const forced = await press('f')
  assert.deepEqual(
    [forced.reclaim, forced.agent],
    [
      { reclaimed: true, notes: [] },
      { n: 2, title: '[Implement] impl:b' },
    ],
  )
  assert.deepEqual(
    orca.calls
      .slice(since)
      .filter((c) => c.verb === 'worktreeRemove')
      .map((c) => c.path),
    [wt(2)],
  )
  assert.deepEqual([orca.worktrees.get(wt(2)).removed, orca.worktrees.get(wt(3)).removed], [true, false], "gate:a's 5 commits stay")
  assert.equal(orca.dispatches.get('ctx_fake3').released, false)
  assert.deepEqual(reclaimedIn(registry), ['run_fake1-2'])
  assert.match(view.model.message, /reclaimed \[Implement\] impl:b/)
  assert.equal(view.model.dialog, null)
})

viewTest("run view: l follows runner.log in a tab of its own, as Orca's editor opens no file outside a worktree; q quits the view only", async (mode) => {
  const { view, stateDir, after, orca } = await viewedRun(mode)
  const log = join(stateDir, 'runner.log')
  // The run dir is outside every worktree, so `file open` can never show it.
  await assert.rejects(orca.fileOpen({ path: log }), (e) => e.code === 'runtime_error' && /invalid_relative_path/.test(e.message))
  assert.match((await view.key('l')).message, /opened .*runner\.log in a tab that follows it/)
  const tails = () => after().filter((c) => c.verb === 'logTail')
  assert.deepEqual(
    tails().map((c) => [c.path, c.title, c.command]),
    [[log, 'runner.log', tailCommand(log)]],
  )
  const tab = tails()[0].terminal
  // Again while that tab is open: it comes back to the front, no second tab.
  assert.match((await view.key('l')).message, /switched to the tab following/)
  assert.deepEqual(
    after()
      .filter((c) => c.verb === 'terminalSwitch')
      .map((c) => c.terminal),
    [tab],
  )
  assert.equal(tails().length, 1)
  assert.deepEqual(
    after().filter((c) => MUTATING.includes(c.verb)),
    [],
  )
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

test('orca-cli: the view switches to a tab by handle, opens a file by path, and follows a log in a tab of its own', { skip: ORCA_SKIPPED }, async () => {
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
const logged = (stateDir) =>
  readFileSync(join(stateDir, 'runner.log'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => l.replace(/^\S+ /, ''))

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
    spawnView: views.spawn,
    tab: (s) => tab.push(s),
    log: (s) => say(s),
    clock,
    guard: (on) => guards.push(on),
    tail: () => readFileSync(join(stateDir, 'runner.log'), 'utf8').trimEnd().split('\n').slice(-20),
  })
  const gate = attached ? view.gate : (print) => print
  say = runnerLog(
    stateDir,
    gate((s) => tab.push(s)),
    clock,
  )
  if (attached) view.start()
  const registry = registryIn()
  const orca = fakeOrca({
    worker: async (w) => {
      await onStart(views, { ...w, clock })
      await endWorker({ ...w, clock })
    },
    clock,
  })
  const result = await runScript(END, { host: orca, stateDir, out: gate((s) => tab.push(s)), clock, registry, project: 'C:/repo', settings: NO_DOCTOR })
  // As the entry point ends a run: summary.json, then it waits on the view.
  const end = () => finish({ stateDir, summary: { runner: 'session', host: 'orca', ok: true, result }, out: say })
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
  const run = await attachedRun({
    onStart: async (views, w) => {
      if (!w.prompt.startsWith('Build a.')) return
      crashedAt = w.clock.now()
      views.last().emit('exit', 1, null)
    },
  })
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
  for (const [code, words] of [
    [0, 'was closed'],
    [3, 'cannot run in this tab'],
  ]) {
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
  assert.deepEqual(JSON.parse(readFileSync(join(run.stateDir, 'summary.json'), 'utf8')), { runner: 'session', host: 'orca', ok: true, result: [GOOD, null, GOOD] })
  assert.deepEqual(
    readdirSync(run.stateDir).filter((f) => f.endsWith('.json')),
    ['summary.json'],
  )
  let closed = false
  run.view.closed.then(() => (closed = true))
  await turns()
  assert.deepEqual(run.views.last().sent, [], 'the view is sent no question')
  assert.deepEqual(run.tab, [], 'nor is the tab')
  assert.deepEqual(run.orca.calls.slice(since), [])
  assert.deepEqual(
    linesOf(run.registry).filter((e) => e.type === 'reclaimed'),
    [],
  )
  assert.ok(logged(run.stateDir).includes('== Result'))

  // The runner stays until the operator quits the view.
  await turns()
  assert.equal(closed, false)
  run.views.last().emit('message', { type: 'detach' })
  run.views.last().emit('exit', 0, null)
  await turns()
  assert.equal(closed, true)
})

viewTest("run view: the screen is the design's tree, a click lands on the row drawn under it, and the flash line shows the latest event", async (mode) => {
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
  assert.match(lines[8], /^ +4 +impl:c +↻ continued +░/)
  assert.match(lines[10], /^ +6 +impl:e +✗ failed +░{10} +— +— /, 'an agent that never started')
  assert.ok(!lines.some((l) => /PROTOTYPE|Tab ▸|Timeline/.test(l)), 'no status bar')
  assert.match(lines.at(-2), /== Discover/)
  assert.match(lines.at(-1), /↑↓ move · ⏎\/click a phase to fold · ⏎\/→\/click focus tab · g tickets · f filter · Ctrl\+F search · Ctrl\+R reclaim · l log · q quit/)

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

test('orca-cli: a dispatch Orca failed because its tab closed is a gone worker, not a settled one; one that completed before its tab closed is settled', { skip: ORCA_SKIPPED }, async () => {
  // As worker-show answers about 5 s after `terminal close` (live, Orca 1.4.209, #53).
  const closed = (status, stage) => ({
    worker: { agentTerminalHandle: 'term_w', stage, state: status === 'completed' ? 'succeeded' : 'failed' },
    dispatch: { status },
    projection: { outcome: status === 'completed' ? 'succeeded' : 'failed' },
    terminal: { orphaned: true },
    observation: { status: 'live', agentWait: null },
  })
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
  const r = await runOne(
    async ({ state, orca, clock }) => {
      submitsOnContinue(state)
      clock.at(5 * MIN, () => orca.terminalClose({ terminal: state.handle }))
    },
    { script: oneOn('claude', ", isolation: 'worktree'") },
  )
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
  const put = (name, entries, summary = null) => {
    mkdirSync(join(dir, name, 'orca-run'), { recursive: true })
    writeFileSync(join(dir, name, 'orca-run', 'journal.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
    if (summary) writeFileSync(join(dir, name, 'orca-run', 'summary.json'), JSON.stringify(summary))
  }
  // The two ended runs' runners wrote their summary.json, as a runner does at its end.
  put('controlayer-783', [began('run_a1', 1, 'impl:a', a1[0]), began('run_a1', 2, 'impl:b', a1[1]), began('run_a1', 3, 'check', a1[2]), J('result', 1, '[Implement] impl:a', 5, { result: GOOD }), J('failed', 2, '[Implement] impl:b', 6, { reason: 'it died' }), J('result', 3, '[Implement] check', 7, { result: GOOD })], {
    runner: 'session',
    ok: true,
    result: { halted: false, state: 'one ticket failed' },
  })
  put('controlayer-790', [began('run_a2', 1, 'impl:a', a2[0])])
  put('skills-43', [began('run_b1', 1, 'impl:a', b1[0]), J('result', 1, '[Implement] impl:a', 5, { result: GOOD })], { runner: 'session', ok: true, result: { halted: false, state: 'ready for review' } })
  const registry = registryIn()
  writeFileSync(registry, readFileSync(fixture('orca-runs.jsonl'), 'utf8').replaceAll('@RUNS@', dir))

  // Whose runner.pid names a live process, by run dir: run_a2's alone. Every
  // runner's tab stays open after it dies (no `; exit`), so a runner is killed
  // here by its pid, never by closing its tab. `unknown`: the probe cannot tell.
  const runners = { live: new Set(['controlayer-790']), unknown: false }
  const alive = (runDir) => (runners.unknown ? null : runners.live.has(runDir.split(/[\\/]/).at(-2)))
  const runs = runsView({ host: orca, clock, registry, transcripts: { usage: () => null }, unpushed: orca.unpushedOf, alive })
  await runs.refresh()
  const run = (id) => runs.model.projects.flatMap((p) => p.runs).find((r) => r.runId === id)
  const select = async (key) => {
    while (runs.model.rows[runs.model.selected].key !== key) await runs.key(runs.model.rows.findIndex((r) => r.key === key) > runs.model.selected ? 'DOWN' : 'UP')
  }
  return { orca, clock, dir, registry, runs, run, select, runners, a1, a2, b1 }
}
const screenOf = (model) => drawRuns(model, { width: 140, height: 30 }).lines.map(strip)

test('standalone: runs from a registry fixture are listed by project, with outcome, runner alive, ended or dead, kept count and age', async () => {
  const { runs, run, clock, orca, runners } = await standaloneRuns()
  assert.deepEqual(
    runs.model.projects.map((p) => [p.name, p.path, p.runs.map((r) => r.runId)]),
    [
      ['controlayer', PROJECT, ['run_a2', 'run_a1']],
      ['skills', 'C:/repos/skills', ['run_b1']],
    ],
  )
  const facts = () => ['run_a2', 'run_a1', 'run_b1'].map((id) => [run(id).spec, run(id).outcome, run(id).alive, run(id).end, run(id).kept, run(id).ageMs, run(id).reclaimed])
  assert.deepEqual(facts(), [
    ['#790', null, true, null, 1, 30 * MIN, false],
    ['#783', 'partial', false, { kind: 'complete', detail: 'one ticket failed' }, 2, 120 * MIN, false],
    ['#43', 'ok', false, { kind: 'complete', detail: 'ready for review' }, 0, 180 * MIN, true],
  ])
  assert.equal(runs.model.rows[runs.model.selected].key, 'run:run_a2', 'the latest run is selected first')

  const lines = screenOf(runs.model)
  assert.match(lines[0], /^ Orca runs · 3 runs · 2 projects/)
  // A run that ended is not a dead runner (#157): the RUNNER column reads how
  // it ended from its summary.json, as the attached header does. Only a runner
  // gone with no summary is dead.
  assert.match(lines[1], /● 1 alive {2}2 ended {2}○ 0 dead {2}1 reclaimed/)
  assert.match(lines[4], /^ ▾ controlayer {2}C:\/repos\/controlayer {2}2 runs/)
  assert.match(lines[5], /^ +run_a2 +#790 +running +● alive +1 +30m/)
  assert.match(lines[6], /^ +run_a1 +#783 +partial +✓ complete +2 +2h00m/)
  assert.match(lines[7], /^ ▾ skills/)
  assert.match(lines[8], /^ +run_b1 +#43 +ok +✓ complete +0 +3h00m +reclaimed/)
  assert.doesNotMatch(lines.join('\n'), /○ dead/)
  // The pane carries the end's detail.
  assert.match(lines.slice(-6, -2).join('\n'), /run_a2 .* running/)
  await (async () => {
    while (runs.model.rows[runs.model.selected].key !== 'run:run_b1') await runs.key('DOWN')
  })()
  assert.match(screenOf(runs.model).slice(-6, -2).join('\n'), /run_b1 .* ok .* ✓ complete — ready for review/)
  while (runs.model.rows[runs.model.selected].key !== 'run:run_a2') await runs.key('UP')

  // Age runs on the clock.
  clock.t += 25 * 60 * MIN
  await runs.refresh()
  assert.deepEqual(
    ['run_a2', 'run_a1', 'run_b1'].map((id) => run(id).ageMs),
    [25.5 * 60 * MIN, 27 * 60 * MIN, 28 * 60 * MIN],
  )
  assert.match(screenOf(runs.model)[5], / 1d01h/)

  // run_a1's runner is dead though its tab is still open: the tab outlives it.
  assert.ok((await orca.terminalList()).includes('term_runA1'))
  // run_a2's runner is killed, its tab left open: dead, and the tree opened
  // from its row says the same. A terminal list Orca does not answer changes
  // nothing; a runner.pid nobody can read: nobody can say, so nothing is resumable.
  runners.live.clear()
  await runs.refresh()
  assert.deepEqual([run('run_a2').alive, run('run_a2').end, run('run_a2').resumable, run('run_a2').closable], [false, null, true, true])
  assert.match(screenOf(runs.model)[1], /● 0 alive {2}2 ended {2}○ 1 dead {2}1 reclaimed/)
  assert.match(screenOf(runs.model)[5], /^ +run_a2 +#790 +unfinished +○ dead +1/)
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
  assert.deepEqual(
    ['run_a2', 'run_a1'].map((id) => [run(id).alive, run(id).resumable]),
    [
      [null, false],
      [null, false],
    ],
  )
  assert.match(screenOf(runs.model)[5], /\? unknown/)
})

test('standalone: two concurrent runs in one repo are separate rows, and a hand-made worktree with no run prefix never appears', async () => {
  const { runs, run, select, orca } = await standaloneRuns()
  const rows = runs.model.rows.filter((r) => r.kind === 'run' && r.project.name === 'controlayer')
  assert.deepEqual(
    rows.map((r) => r.key),
    ['run:run_a2', 'run:run_a1'],
  )
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
  const lines = draw(tree.model, { width: 152, height: 30, help: TREE_HELP }).lines.map(strip)
  assert.ok(
    lines.some((l) => /^ worktree — +tab term_fake3/.test(l)),
    'the checkout is not named as its worktree',
  )
  assert.ok(!lines.some((l) => /my-feature/.test(l)))
  assert.match(lines.at(-1), /← back to the runs · g tickets · f filter · Ctrl\+F search · Ctrl\+R reclaim · l log · p pause/)
  assert.deepEqual(
    orca.calls.filter((c) => MUTATING.includes(c.verb)),
    [],
  )
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
  assert.deepEqual(
    runs.model.rows.map((r) => r.key).filter((k) => k.startsWith('run:')),
    ['run:run_b1'],
  )
  assert.deepEqual(await runs.key('q'), { quit: true })
})

test('standalone: Ctrl+R reclaims a whole run, each agent by the reclaim rules, and records the run reclaimed once none is left', async () => {
  const { runs, run, select, orca, registry, a1, a2 } = await standaloneRuns()
  const since = orca.calls.length
  const mutations = () => orca.calls.slice(since).filter((c) => MUTATING.includes(c.verb))
  const reclaimedLines = (runId) =>
    readFileSync(registry, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          const e = JSON.parse(l)
          return e.type === 'reclaimed' && e.runId === runId ? [e.agent ?? 'the run'] : []
        } catch {
          return [] // the fixture's torn last line
        }
      })

  // run_a2's one agent is live: kept, nothing touched, the run not reclaimed.
  const live = await runs.key('CTRL_R')
  assert.deepEqual(
    live.kept.map((k) => [k.agent.n, k.reason]),
    [[1, 'it is still live']],
  )
  assert.match(live.message, /^reclaimed 0 of 1 agents of implement-spec-790 run_a2; kept \[Implement\] impl:a: it is still live/)
  assert.deepEqual(mutations(), [])
  assert.deepEqual(reclaimedLines('run_a2'), [])
  assert.equal(orca.dispatches.get(a2[0].dispatchId).released, false)

  // run_a1: impl:a was reclaimed already; impl:b's worktree holds a commit no
  // remote has; check ran in the run's own checkout.
  await select('run:run_a1')
  orca.worktrees.get(a1[1].worktree).unpushed = 1
  const held = await runs.key('CTRL_R')
  assert.deepEqual(
    held.reclaimed.map((a) => a.n),
    [3],
  )
  assert.deepEqual(
    held.kept.map((k) => [k.agent.n, k.reason]),
    [[2, `${a1[1].worktree} holds 1 unpushed commit; only a forced reclaim removes it`]],
  )
  assert.deepEqual(
    mutations().map((c) => [c.verb, c.dispatchId ?? c.path]),
    [
      ['workerRelease', a1[2].dispatchId],
      ['terminalClose', a1[2].dispatchId],
    ],
  )
  assert.deepEqual(reclaimedLines('run_a1'), ['run_a1-1', 'run_a1-3'])
  assert.deepEqual([run('run_a1').kept, run('run_a1').reclaimed], [1, false])

  // Pushed: the last agent goes, and with it the run.
  orca.worktrees.get(a1[1].worktree).unpushed = 0
  const all = await runs.key('CTRL_R')
  assert.deepEqual([all.reclaimed.map((a) => a.n), all.kept], [[2], []])
  assert.match(all.message, /^reclaimed implement-spec-783 run_a1: 1 agent$/)
  assert.deepEqual(reclaimedLines('run_a1'), ['run_a1-1', 'run_a1-3', 'run_a1-2', 'the run'])
  assert.equal(readRegistry(registry).find((r) => r.runId === 'run_a1').reclaimed, true)
  assert.deepEqual([run('run_a1').kept, run('run_a1').reclaimed], [0, true])
  assert.deepEqual(
    mutations()
      .filter((c) => c.verb === 'worktreeRemove')
      .map((c) => c.path),
    [a1[1].worktree],
    'only a worktree named <runId>-<n>',
  )
  assert.ok(!mutations().some((c) => c.dispatchId === a1[0].dispatchId), 'an agent reclaimed before is not reclaimed again')
  assert.deepEqual(
    [PROJECT, HAND_MADE].map((p) => orca.worktrees.get(p).removed),
    [false, false],
  )
  assert.ok((await orca.terminalList()).includes('term_mine'))
  assert.match((await runs.key('CTRL_R')).message, /implement-spec-783 run_a1 is already reclaimed/)
})

test('standalone: Ctrl+R on a run still going reclaims its settled agents but never records the run reclaimed, so an agent it starts later is kept', async () => {
  const { runs, run, select, orca, registry, dir, a2, runners } = await standaloneRuns()
  const pane = () => screenOf(runs.model).slice(-6, -2).join('\n')
  const reclaimedLines = (runId) =>
    readFileSync(registry, 'utf8')
      .split('\n')
      .flatMap((l) => {
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
  assert.match(pane(), /Ctrl\+R reclaims every agent it may; the run stays open/)
  const r = await runs.key('CTRL_R')
  assert.deepEqual([r.reclaimed.map((a) => a.n), r.kept], [[1], []])
  assert.equal(r.message, 'reclaimed 1 agent of implement-spec-790 run_a2; the run stays open: its runner is alive')
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1'], 'the agent, never the run')
  assert.deepEqual([run('run_a2').reclaimed, run('run_a2').kept], [false, 0])
  assert.equal((await runs.key('CTRL_R')).message, 'implement-spec-790 run_a2 has no agent left to reclaim; the run stays open: its runner is alive')
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1'])

  // The runner starts its next agent: listed, kept, and live in the tree.
  const s = await orca.workerStart({ run: 'run_a2', prompt: 'p', title: 't', sessionId: SID, child: { name: 'run_a2-2', displayName: 't' } })
  appendFileSync(join(dir, 'controlayer-790', 'orca-run', 'journal.jsonl'), JSON.stringify(J('started', 2, '[Implement] impl:b', 40, { run: 'run_a2', dispatchId: s.dispatchId, harness: 'claude', sessionId: 'sid-2', worktree: s.worktree, terminal: s.terminal })) + '\n')
  await runs.refresh()
  assert.deepEqual([run('run_a2').reclaimed, run('run_a2').kept], [false, 1])
  assert.match((await runs.key('CTRL_R')).message, /^reclaimed 0 of 1 agents of implement-spec-790 run_a2; kept \[Implement\] impl:b: it is still live/)
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1'])
  await runs.key('ENTER')
  assert.deepEqual(
    runs
      .opened()
      .model.phases.flatMap((p) => p.agents)
      .map((a) => [a.n, a.reclaimed]),
    [
      [1, true],
      [2, false],
    ],
  )
  await runs.key('q')

  // run_a1 has ended, but while nobody can say whether its runner lives it is
  // not taken for dead: its agents may go, the run stays open.
  await select('run:run_a1')
  assert.equal(run('run_a1').closable, true)
  assert.match(pane(), /Ctrl\+R reclaims every agent and closes the run/)
  runners.unknown = true
  await runs.refresh()
  assert.deepEqual([run('run_a1').alive, run('run_a1').closable], [null, false])
  await runs.key('CTRL_R')
  assert.ok(!reclaimedLines('run_a1').includes('the run'))
  assert.equal(run('run_a1').reclaimed, false)
})

test('standalone: Ctrl+R on a run whose runner was killed before it recorded `ended` reclaims its agents and records the run reclaimed, and r then refuses it', async () => {
  const { runs, run, orca, registry, a2, runners } = await standaloneRuns()
  const resumes = () => orca.calls.filter((c) => c.verb === 'resumeRunner')
  const pane = () => screenOf(runs.model).slice(-6, -2).join('\n')
  const reclaimedLines = (runId) =>
    readFileSync(registry, 'utf8')
      .split('\n')
      .flatMap((l) => {
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
  assert.deepEqual(
    ['alive', 'outcome', 'closable', 'resumable'].map((k) => run('run_a2')[k]),
    [false, null, true, true],
  )
  assert.match(pane(), /Ctrl\+R reclaims every agent and closes the run/)

  const r = await runs.key('CTRL_R')
  assert.deepEqual([r.reclaimed.map((a) => a.n), r.kept], [[1], []])
  assert.equal(r.message, 'reclaimed implement-spec-790 run_a2: 1 agent')
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1', 'the run'], 'the agent, then the whole run')
  assert.equal(readRegistry(registry).find((e) => e.runId === 'run_a2').reclaimed, true)
  assert.deepEqual(
    ['reclaimed', 'kept', 'resumable', 'closable'].map((k) => run('run_a2')[k]),
    [true, 0, false, false],
  )

  // Reclaimed: r is neither offered nor carried out, and Ctrl+R has nothing left.
  assert.ok(!/r resumes/.test(pane()))
  assert.match((await runs.key('r')).message, /^implement-spec-790 run_a2 is reclaimed: .*nothing to resume$/)
  assert.deepEqual(resumes(), [])
  assert.match((await runs.key('CTRL_R')).message, /implement-spec-790 run_a2 is already reclaimed/)
  assert.deepEqual(reclaimedLines('run_a2'), ['run_a2-1', 'the run'])
})

test("standalone: r on a run whose runner is dead opens one terminal in the run's worktree running the runner with --resume; never while its runner lives", async () => {
  const { runs, run, select, orca, dir, runners } = await standaloneRuns()
  const resumes = () => orca.calls.filter((c) => c.verb === 'resumeRunner')
  const pane = () => screenOf(runs.model).slice(-6, -2).join('\n')

  // run_a2's runner is alive: not offered, and r opens nothing.
  assert.equal(run('run_a2').resumable, false)
  assert.ok(!/r resumes/.test(pane()))
  assert.match((await runs.key('r')).message, /runner is alive, in tab term_runA2: nothing to resume/)
  assert.deepEqual(resumes(), [])

  // run_a1's ended: the runner as the skill launched it, with --resume.
  await select('run:run_a1')
  assert.equal(run('run_a1').resumable, true)
  assert.match(pane(), /r resumes it: its runner ended/)
  assert.doesNotMatch(pane(), /dead/)
  const r = await runs.key('r')
  const stateDir = `${dir}/controlayer-783/orca-run`
  assert.deepEqual(
    resumes().map((c) => [c.worktree, c.command]),
    [[PROJECT, resumeRunnerCommand({ runner: RUNNER_PATH, script: `${dir}/controlayer-783/workflow.js`, stateDir, permissionMode: 'auto' })]],
  )
  assert.match(resumes()[0].command, /^node '.*runner\.mjs' '.*workflow\.js' --state-dir '.*orca-run' --resume --permission-mode auto$/)
  assert.equal(r.resumed, resumes()[0].terminal)
  // Its new runner is alive before it reaches the registry: a second r opens nothing.
  assert.deepEqual([run('run_a1').alive, run('run_a1').resumable], [true, false])
  assert.match((await runs.key('r')).message, /runner is alive/)
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

  // run_b1 is recorded reclaimed: its agents are gone, so r is neither offered
  // nor carried out, from the list or from inside its tree, and the flash says why.
  await select('run:run_b1')
  assert.deepEqual([run('run_b1').alive, run('run_b1').resumable], [false, false])
  assert.ok(!/r resumes/.test(pane()))
  assert.match((await runs.key('r')).message, /^implement-spec-43 run_b1 is reclaimed: .*nothing to resume$/)
  await runs.key('ENTER')
  assert.match((await runs.key('r')).message, /run_b1 is reclaimed/)
  assert.equal(resumes().length, 1)
  await runs.key('q')

  // From inside a run's tree too. run_a2 was armed before the registry named
  // its script: the skill's layout gives it. Its runner dies, its tab left open.
  runners.live.delete('controlayer-790')
  await runs.refresh()
  await select('run:run_a2')
  await runs.key('ENTER')
  await runs.key('r')
  assert.deepEqual(
    resumes()
      .slice(1)
      .map((c) => [c.worktree, c.command]),
    [[PROJECT, resumeRunnerCommand({ runner: RUNNER_PATH, script: join(dir, 'controlayer-790', 'workflow.js'), stateDir: `${dir}/controlayer-790/orca-run` })]],
  )

  // A worktree Orca no longer knows: nothing opens, and the flash says why.
  await runs.key('q')
  orca.worktrees.get(PROJECT).removed = true
  orca.closeTab(resumes()[0].terminal)
  await runs.refresh()
  await select('run:run_a1')
  assert.match((await runs.key('r')).message, /could not resume implement-spec-783 run_a1: .*selector_not_found/)
  assert.equal(resumes().length, 2)
})

test('orca-cli: resuming a runner creates a tab in its worktree running the runner with --resume, every path a quoted literal', { skip: ORCA_SKIPPED }, async () => {
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

const SKILLS = fileURLToPath(new URL('../../../skills/engineering/', import.meta.url))
const VIEW_MJS = fileURLToPath(new URL('../src/run-view/view.mjs', import.meta.url))
const CREW_BIN = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url))

test('orca-runs: the skill opens the standalone view in a new Orca tab, and implement-spec-in-workflow links it', () => {
  const skill = readFileSync(join(SKILLS, 'orca-runs', 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\r?\nname: orca-runs\r?\ndescription: ".+"\r?\ndisable-model-invocation: true\r?\n---/)
  const command = /orca terminal create .*--command "(.*)" .*--json/.exec(skill)
  assert.ok(command, 'it launches the view with orca terminal create')
  assert.match(command[0], /--focus/)
  assert.match(command[1], /^crew view --standalone$/)
  assert.ok(existsSync(CREW_BIN))
  assert.match(readFileSync(join(SKILLS, 'implement-spec-in-workflow', 'SKILL.md'), 'utf8'), /\]\(\.\.\/orca-runs\/SKILL\.md\)/)
})

test('run view: standalone with no terminal exits as unavailable, and with no mode it is a usage error', () => {
  const alone = spawnSync(process.execPath, [VIEW_MJS, '--standalone', '--registry', registryIn()], { encoding: 'utf8' })
  assert.equal(alone.status, 3)
  assert.match(alone.stderr, /needs a terminal/)
  assert.equal(spawnSync(process.execPath, [VIEW_MJS], { encoding: 'utf8' }).status, 2)
})

// --- an Orca outage (ADR-0015) ------------------------------------------------

// The three ways Orca was not there while it updated itself, as the adapter
// builds them from what its CLI printed: the runtime's metadata gone (in
// Orca's envelope, and as bare stderr), the CLI unable to start, and no orca
// to spawn at all.
const RUNTIME_GONE = new OrcaError('runtime_unavailable', 'Could not read Orca runtime metadata at C:\\Users\\o\\AppData\\Roaming\\orca\\orca-runtime.json. Start the Orca app first.', 'orchestration worker-show')
const RUNTIME_GONE_BARE = new OrcaError('1', 'runtime_unavailable: Could not read Orca runtime metadata at C:\\Users\\o\\AppData\\Roaming\\orca\\orca-runtime.json. Start the Orca app first.', 'orchestration worker-show')
const CLI_GONE = new OrcaError('1', 'Unable to start the Orca CLI: The system cannot find the file specified', 'orchestration worker-show')
const SPAWN_GONE = new OrcaError('ENOENT', 'Error: spawn orca ENOENT', 'orchestration worker-show')
const GONE_SAID = 'Orca unreachable — try again when it is back'
const PAUSED_SAID = 'Orca unreachable for 10m: run paused; r to resume (or it resumes itself once Orca is back)'

test('outage: only Orca not being there is an outage — its runtime gone, its CLI unable to start, no orca to spawn; a timeout, or an error from an Orca that answered, is not', async () => {
  for (const e of [RUNTIME_GONE, RUNTIME_GONE_BARE, CLI_GONE, SPAWN_GONE]) assert.equal(orcaUnreachable(e), true, e.message)
  // The adapter's own spawn of an orca that is not there.
  const e = await orcaCli({ bin: join(tmp(), 'no-orca') })
    .terminalList()
    .catch((x) => x)
  assert.equal(orcaUnreachable(e), true, e.message)
  for (const answered of [
    new OrcaError('call_timeout', 'no answer within 120s', 'terminal list'),
    new OrcaError('timeout', 'tui-idle not reached', 'terminal wait'),
    new OrcaError('terminal_exited', 'terminal_exited', 'terminal switch'),
    new OrcaError('runtime_error', "ENOENT: no such file or directory, open 'C:/x'", 'file open'),
    new OrcaError('consumer_fenced', 'no longer bound', 'orchestration worker-start'),
    new Error('boom'),
    null,
    'down',
  ])
    assert.equal(orcaUnreachable(answered), false, String(answered?.message ?? answered))
})

test('outage: every Orca call waits on the one outage and its one probe, every 5s doubling to 30s, and goes on once Orca answers', async () => {
  const clock = fakeClock()
  let down = true
  const probes = []
  const events = []
  const outage = hostOutage({
    clock,
    limits: SETTINGS,
    unreachable: orcaUnreachable,
    probe: async () => {
      probes.push(clock.now())
      if (down) throw CLI_GONE
    },
    on: (e) => events.push(e),
  })
  clock.at(100_000, () => {
    down = false
  })
  const tries = { a: 0, b: 0 }
  const call = (k) =>
    outage.guard(async () => {
      tries[k]++
      if (down) throw SPAWN_GONE
      return k
    })
  assert.deepEqual(await Promise.all([call('a'), call('b')]), ['a', 'b'])
  assert.deepEqual(
    probes,
    [5, 15, 35, 65, 95, 125].map((s) => s * 1000),
    'one probe for both callers',
  )
  assert.deepEqual(tries, { a: 2, b: 2 })
  assert.deepEqual(
    events.map((e) => [e.phase, e.since]),
    [
      ['start', 0],
      ['end', 0],
    ],
  )
  assert.equal(events[1].ms, 125_000)
  assert.equal(outage.lost(), 125_000, 'the time lost to it, which the runner takes off its clocks')
  assert.equal(outage.state(), null)
  // An error from an Orca that answered is the caller's, at once.
  await assert.rejects(
    outage.guard(async () => {
      throw new OrcaError('terminal_exited', 'x', 'terminal send')
    }),
    /terminal_exited/,
  )
  assert.equal(probes.length, 6)
  assert.deepEqual(
    [1, 5, 6, 124, 125, 600, 719, 720].map((s) => probesBy(s * 1000, SETTINGS)),
    [0, 1, 1, 5, 6, 22, 22, 23],
    'the probes a view counts by the time elapsed',
  )
})

test('outage: past 10 minutes it pauses, never failing a caller, probes every 2 minutes, and resume() probes at once', async () => {
  const clock = fakeClock()
  let down = true
  const probes = []
  const events = []
  const outage = hostOutage({
    clock,
    limits: SETTINGS,
    unreachable: orcaUnreachable,
    probe: async () => {
      probes.push(clock.now())
      if (down) throw RUNTIME_GONE
    },
    on: (e) => events.push(e),
  })
  clock.at(15 * MIN, () => {
    down = false
  })
  assert.equal(
    await outage.guard(async () => {
      if (down) throw RUNTIME_GONE
      return 'ok'
    }),
    'ok',
  )
  assert.deepEqual(
    events.map((e) => [e.phase, e.since]),
    [
      ['start', 0],
      ['paused', 0],
      ['end', 0],
    ],
  )
  assert.equal(events[1].at, 10 * MIN, 'paused at the probe at 10 minutes')
  assert.deepEqual(
    probes.filter((t) => t >= 10 * MIN),
    [10, 12, 14, 16].map((m) => m * MIN),
  )

  // resume(): a probe at once, whatever the schedule. Orca still gone: paused still.
  const again = fakeClock()
  let gone = true
  const at = []
  const answers = []
  const second = hostOutage({
    clock: again,
    limits: SETTINGS,
    unreachable: orcaUnreachable,
    probe: async () => {
      at.push(again.now())
      if (gone) throw CLI_GONE
    },
    on: (e) => {
      if (e.phase !== 'paused') return
      answers.push(
        second.resume().then(async (r) => {
          assert.equal(second.state().phase, 'paused')
          gone = false
          return [r, await second.resume()]
        }),
      )
    },
  })
  assert.equal(
    await second.guard(async () => {
      if (gone) throw CLI_GONE
      return 'ok'
    }),
    'ok',
  )
  assert.deepEqual(
    (await Promise.all(answers)).flat().map((r) => r.back),
    [false, true],
  )
  assert.deepEqual(at.slice(-3), [10 * MIN, 10 * MIN, 10 * MIN], 'two probes at once, beside the scheduled one')
  assert.equal(second.state(), null)
  assert.deepEqual(await second.resume(), { back: true, outage: false }, 'nothing to resume with Orca there')
})

// A clock whose sleeps end only when the test moves it on.
function manualClock() {
  const sleepers = []
  const wait = (ms) => {
    const s = { due: c.t + ms }
    s.promise = new Promise((r) => {
      s.r = r
    })
    sleepers.push(s)
    return s
  }
  const c = {
    t: 0,
    now: () => c.t,
    sleep: (ms) => wait(ms).promise,
    timer: (ms) => {
      const s = wait(ms)
      return {
        promise: s.promise,
        cancel: () => {
          if (sleepers.includes(s)) sleepers.splice(sleepers.indexOf(s), 1)
        },
      }
    },
    async to(t) {
      c.t = t
      for (const s of sleepers.filter((x) => x.due <= t)) {
        sleepers.splice(sleepers.indexOf(s), 1)
        s.r()
      }
      await turns(10)
    },
  }
  return c
}

test("outage: a retry's backoff counts only the time Orca was there", async () => {
  const clock = manualClock()
  let down = false
  const outage = hostOutage({
    clock,
    limits: SETTINGS,
    unreachable: orcaUnreachable,
    probe: async () => {
      if (down) throw CLI_GONE
    },
  })
  let woke = null
  outage.sleep(30_000).then(() => {
    woke = clock.now()
  })
  await clock.to(10_000)
  down = true
  const call = outage.guard(async () => {
    if (down) throw CLI_GONE
  })
  await clock.to(15_000)
  down = false
  await clock.to(25_000)
  await call
  await clock.to(30_000)
  assert.equal(woke, null, '15 of those 30 seconds Orca was gone')
  await clock.to(45_000)
  assert.equal(woke, 45_000)
})

test('outage: the adapter waits it out call by call, so a start Orca drops out of half way goes on from the call that found it gone, and makes no second worktree', async () => {
  const clock = fakeClock()
  const down = () => clock.now() < 40_000
  const { argvs, orca } = childCli(
    {
      'terminal create': () => {
        if (down()) throw CLI_GONE
        return { terminal: { handle: 'term_own' } }
      },
      'terminal list': () => {
        if (down()) throw SPAWN_GONE
        return { terminals: [] }
      },
    },
    { clock },
  )
  orca.guardWith(hostOutage({ clock, limits: SETTINGS, unreachable: orcaUnreachable, probe: () => orca.probe() }))
  const w = await orca.workerStart({ ...START, child: CHILD })
  assert.deepEqual([w.worktree, w.terminal], [CHILD_PATH, 'term_own'])
  assert.deepEqual(verbsOf(argvs), ['worktree create', 'terminal close', 'worktree set', 'terminal create', 'terminal list', 'terminal list', 'terminal list', 'terminal list', 'terminal create', 'terminal wait', 'orchestration worker-start'])
  assert.equal(clock.now(), 65_000)
})

// A run on the fake clock with its own registry, `down(orca, clock, { control,
// registry })` taking Orca away and bringing it back; `control` is what the
// entry point hands the attached view's r to.
async function outageRun(worker, { script = ONE, settings = {}, down = () => {} } = {}) {
  const clock = fakeClock()
  const lines = []
  const stateDir = tmp()
  const registry = registryIn()
  const control = {}
  const orca = fakeOrca({ worker: (w) => worker({ ...w, clock }), clock })
  down(orca, clock, { control, registry })
  const result = await runScript(script, { host: orca, stateDir, out: (s) => lines.push(s), clock, settings: { ...NO_DOCTOR, ...settings }, transcripts: fakeTranscripts(orca), registry, project: 'C:/repo', control })
  const of = (verb) => orca.calls.filter((c) => c.verb === verb)
  return { result, lines, orca, clock, registry, stateDir, journal: journalOf(stateDir), nudges: of('terminalSend'), stops: of('workerStop'), probes: of('probe') }
}
const submitsAt =
  (ms) =>
  ({ clock, ...w }) => {
    clock.at(ms, () => submitGood(w))
  }
const phasesOf = (journal) => ofType(journal, 'outage').map((e) => e.phase)

test('outage: a worker Orca cannot be seen for two minutes is waited on, never failed: no watch error is spent, and the journal and log name the outage', async () => {
  const r = await outageRun(submitsAt(5 * MIN), {
    down: (orca, clock) => {
      clock.at(MIN, () => orca.down(CLI_GONE))
      clock.at(3 * MIN, () => orca.up())
    },
  })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(r.stops, [], 'no worker is stopped')
  assert.deepEqual(ofType(r.journal, 'failed'), [])
  assert.ok(!r.lines.some((l) => /could not look at its worker/.test(l)), r.lines.join('\n'))
  assertEntries(r.journal)
  assert.deepEqual(phasesOf(r.journal), ['start', 'end'])
  const [start, end] = ofType(r.journal, 'outage')
  assert.deepEqual([start.at, start.since, end.at, end.since, end.ms], [isoAt(MIN), isoAt(MIN), isoAt(MIN + 125_000), isoAt(MIN), 125_000])
  assert.ok(
    r.lines.some((l) => /^!! Orca unreachable \(.*Unable to start the Orca CLI.*\): every Orca call waits for it/.test(l)),
    r.lines.join('\n'),
  )
  assert.ok(r.lines.includes('>> Orca is back after 2.1 min: the run carries on'), r.lines.join('\n'))
})

test("outage: the runner's clocks stop for its length, so an outage longer than the stuck limit nudges nobody", async () => {
  const settings = { stuckNudgeMs: 5 * MIN, stuckContinueMs: 10 * MIN }
  const r = await outageRun(submitsAt(9 * MIN), {
    settings,
    down: (orca, clock) => {
      clock.at(MIN, () => orca.down(SPAWN_GONE))
      clock.at(7 * MIN, () => orca.up())
    },
  })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(r.nudges, [], 'watched for 3 minutes of Orca being there, under the 5 it takes')
  assert.deepEqual(phasesOf(r.journal), ['start', 'end'])
  // The same worker with Orca there throughout is nudged at 5 minutes.
  const there = await outageRun(submitsAt(9 * MIN), { settings })
  assert.equal(there.nudges.length, 1)
})

test('outage: a start and the Run it needs wait out an Orca gone from the first call, spending no attempt', async () => {
  const r = await outageRun(submitsAt(5 * MIN), {
    script: oneOn('claude', ", isolation: 'worktree'"),
    down: (orca, clock) => {
      orca.down(RUNTIME_GONE)
      clock.at(40_000, () => orca.up())
    },
  })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(ofType(r.journal, 'retry'), [])
  assert.deepEqual(phasesOf(r.journal), ['start', 'end'])
  assert.deepEqual(
    r.probes.map((p) => p.at),
    [5_000, 15_000, 35_000, 65_000],
  )
  assert.equal(r.orca.calls.filter((c) => c.verb === 'worktreeCreate').length, 1)
})

test('outage: past 10 minutes the run pauses — journaled, logged, recorded in the registry — fails no agent, and carries on by itself once Orca is back', async () => {
  let mid = null
  const r = await outageRun(submitsAt(20 * MIN), {
    down: (orca, clock, { registry }) => {
      clock.at(MIN, () => orca.down(RUNTIME_GONE))
      clock.at(12 * MIN, () => {
        mid = readRegistry(registry).at(0)?.paused ?? 'none'
      })
      clock.at(15 * MIN, () => orca.up())
    },
  })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(r.stops, [])
  assert.deepEqual(ofType(r.journal, 'failed'), [])
  assertEntries(r.journal)
  assert.deepEqual(phasesOf(r.journal), ['start', 'paused', 'end'])
  const [, paused, end] = ofType(r.journal, 'outage')
  assert.deepEqual([paused.at, paused.since, end.at], [isoAt(11 * MIN), isoAt(MIN), isoAt(15 * MIN)])
  assert.ok(
    r.lines.some((l) => l.endsWith(PAUSED_SAID)),
    r.lines.join('\n'),
  )
  assert.deepEqual(mid, { reason: 'orca outage', at: isoAt(11 * MIN) })
  assert.equal(readRegistry(r.registry)[0].paused, null, 'unpaused once Orca is back')
  assert.deepEqual(
    r.probes.map((p) => p.at).filter((t) => t > 11 * MIN),
    [13, 15].map((m) => m * MIN),
  )
})

test('outage: r while the run is paused probes at once: with Orca still gone the run stays paused and says so; with it back the run carries on in the same process', async () => {
  const said = []
  const r = await outageRun(submitsAt(20 * MIN), {
    down: (orca, clock, { control }) => {
      clock.at(MIN, () => orca.down(RUNTIME_GONE))
      clock.at(12 * MIN, async () => {
        said.push(await control.resumeHost())
        orca.up()
        said.push(await control.resumeHost())
      })
    },
  })
  assert.deepEqual(r.result, GOOD)
  assert.deepEqual(
    said.map((x) => x.back),
    [false, true],
  )
  assert.deepEqual(phasesOf(r.journal), ['start', 'paused', 'end'])
  assert.equal(ofType(r.journal, 'outage')[2].at, isoAt(13 * MIN))
  assert.ok(r.lines.includes('!! Orca is still unreachable: the run stays paused, and probes it again every 2 min'), r.lines.join('\n'))
  assert.equal(readRegistry(r.registry)[0].paused, null)
})

test("journal: the fold names the run's outage: none, waiting since its start, paused since its start, and none once it ends", () => {
  const o = (phase, min, more = {}) => ({ type: 'outage', at: at(min), phase, since: at(1), ...more })
  assert.equal(foldJournal([]).outage, null)
  assert.deepEqual(foldJournal([o('start', 1)]).outage, { phase: 'waiting', since: at(1) })
  assert.deepEqual(foldJournal([o('start', 1), o('paused', 11)]).outage, { phase: 'paused', since: at(1) })
  assert.equal(foldJournal([o('start', 1), o('paused', 11), o('end', 15, { ms: 14 * MIN })]).outage, null)
})

test('run view: r in the attached view reaches the runner, which probes Orca at once', async () => {
  const clock = fakeClock()
  const views = fakeViews(clock)
  const asked = []
  const view = attachView({ spawnView: views.spawn, tab: () => {}, log: () => {}, clock, resume: () => asked.push('resume') })
  view.start()
  views.last().emit('message', { type: 'resume' })
  await turns()
  assert.deepEqual(asked, ['resume'])
})

test('run view: while Orca is out the header says so and every agent keeps its state; Enter, l and Ctrl+R say Orca is unreachable and ask Orca nothing; r asks the runner to probe', async () => {
  const clock = fakeClock()
  clock.t = 3 * MIN
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock })
  await orca.workerStart({ run: 'run_fake1', prompt: 'p', title: 't1', sessionId: SID })
  const stateDir = tmp()
  const put = (entries) => writeFileSync(join(stateDir, 'journal.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  const journal = [startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'), { type: 'outage', at: at(1), phase: 'start', since: at(1) }]
  put(journal)
  writeFileSync(join(stateDir, 'runner.log'), '')
  const asked = []
  const view = runView({ stateDir, host: orca, clock, registry: null, transcripts: { usage: () => null }, alive: () => true, resumeHost: () => asked.push(clock.now()) })
  await view.refresh()
  assert.deepEqual(view.model.header.outage, { phase: 'waiting', since: at(1), elapsedMs: 2 * MIN, probes: 5 })
  assert.equal(view.model.phases[0].agents[0].state, 'running')
  const header = () => draw(view.model, { width: 140, height: 30 }).lines.map(strip)[1]
  assert.match(header(), /^ ⚠ Orca unreachable — waiting 2m00s \(probe 5\)/)
  await view.key('DOWN')
  assert.equal(view.model.pane.kind, 'agent')
  const before = orca.calls.length
  for (const k of ['ENTER', 'l', 'CTRL_R']) {
    assert.deepEqual(await view.key(k), { message: GONE_SAID }, k)
    assert.equal(view.model.dialog, null)
  }
  assert.equal(orca.calls.length, before, 'Orca is asked nothing')

  put([...journal, { type: 'outage', at: at(11), phase: 'paused', since: at(1) }])
  clock.t = 12 * MIN
  await view.refresh()
  assert.equal(view.model.header.outage.phase, 'paused')
  assert.match(header(), /^ ⏸ paused: Orca outage past 10m — r to resume/)
  assert.equal(view.model.phases[0].agents[0].state, 'running')
  assert.match((await view.key('r')).message, /asked the runner to probe Orca now/)
  assert.deepEqual(asked, [12 * MIN])

  put([...journal, { type: 'outage', at: at(13), phase: 'end', since: at(1), ms: 12 * MIN }])
  await view.refresh()
  assert.equal(view.model.header.outage, null)
  assert.doesNotMatch(header(), /Orca/)
  assert.match((await view.key('r')).message, /Orca is there/)
  assert.deepEqual(asked, [12 * MIN], 'no probe asked with Orca there')
  // Found gone by the view's own call, before the journal says so.
  orca.down(SPAWN_GONE)
  assert.deepEqual(await view.key('ENTER'), { message: GONE_SAID })
})

test('standalone: a run paused on an Orca outage is listed paused (Orca outage), not running, until Orca is back; an action that finds Orca gone says so and does nothing', async () => {
  const clock = fakeClock()
  clock.t = RUNS_AT
  const registry = registryIn()
  const w = runRegistry(registry, clock)
  const dir = tmp()
  w.armed({ runId: 'run_p', project: PROJECT, runDir: join(dir, 'p'), spec: 'implement-spec-801' })
  w.runner({ runId: 'run_p', terminal: 'term_p' })
  w.armed({ runId: 'run_d', project: PROJECT, runDir: join(dir, 'd'), spec: 'implement-spec-802' })
  w.runner({ runId: 'run_d', terminal: 'term_d' })
  w.paused({ runId: 'run_p', reason: 'orca outage' })
  assert.deepEqual(
    readRegistry(registry).map((r) => r.paused),
    [{ reason: 'orca outage', at: isoAt(RUNS_AT) }, null],
  )
  const orca = fakeOrca({ clock, runWorktree: PROJECT })
  const runs = runsView({ host: orca, clock, registry, transcripts: { usage: () => null }, alive: (d) => d === join(dir, 'p') })
  await runs.refresh()
  const lineOf = (id) => screenOf(runs.model).find((l) => l.includes(id))
  assert.match(lineOf('run_p'), /run_p +#801 +paused \(Orca outage\) +● alive/)
  assert.match(lineOf('run_d'), /run_d +#802 +unfinished +○ dead/)
  orca.down(SPAWN_GONE)
  assert.deepEqual(await runs.resume('run_d'), { message: GONE_SAID })
  assert.deepEqual(
    orca.calls.filter((c) => c.verb === 'resumeRunner'),
    [],
  )
  orca.up()
  w.unpaused({ runId: 'run_p' })
  await runs.refresh()
  assert.match(lineOf('run_p'), /run_p +#801 +running/)
  // A new runner on the run, or its end, is no pause either.
  for (const next of [() => w.runner({ runId: 'run_p', terminal: 'term_p2' }), () => w.ended({ runId: 'run_p', outcome: 'ok' })]) {
    w.paused({ runId: 'run_p', reason: 'orca outage' })
    next()
    assert.equal(readRegistry(registry)[0].paused, null)
  }
})

// --- a worker's prompt reaching its session ----------------------------------

// A value that must never leave the operator's settings file: in a log line,
// a warning, or the worktree's copy.
const SECRET = 'sk-never-print-me'

// fs as mcp-answers.mjs uses it, in memory, keyed by forward-slash path.
function memFs(files = {}) {
  const key = (p) => String(p).replace(/\\/g, '/')
  const m = new Map(Object.entries(files).map(([k, v]) => [key(k), v]))
  return {
    files: m,
    existsSync: (p) => m.has(key(p)),
    readFileSync: (p) => {
      if (!m.has(key(p))) throw new Error(`ENOENT: ${p}`)
      return m.get(key(p))
    },
    writeFileSync: (p, text) => m.set(key(p), String(text)),
    mkdirSync: () => {},
  }
}

test("mcp answers: the source's answers replace the worktree's, every other key is kept, and a server they leave unanswered is disabled", () => {
  const target = { permissions: { allow: ['Bash(ls)'] }, enabledMcpjsonServers: ['old'] }
  const m = mergeMcpAnswers({ source: { enabledMcpjsonServers: ['docs'], disabledMcpjsonServers: ['db'], env: { TOKEN: SECRET } }, target, servers: ['docs', 'db', 'slint'] })
  assert.deepEqual(m.settings, { permissions: { allow: ['Bash(ls)'] }, enabledMcpjsonServers: ['docs'], disabledMcpjsonServers: ['db', 'slint'] })
  assert.deepEqual([m.changed, m.added], [true, ['slint']])
  assert.equal(JSON.stringify(m.settings).includes(SECRET), false, 'only the three MCP keys are copied')

  const all = mergeMcpAnswers({ source: { enableAllProjectMcpServers: true }, servers: ['docs', 'slint'] })
  assert.deepEqual([all.settings, all.added], [{ enableAllProjectMcpServers: true }, []])
  const none = mergeMcpAnswers({ source: {}, servers: ['slint'] })
  assert.deepEqual(none.settings, { disabledMcpjsonServers: ['slint'] }, 'no answer at all: never turned on')
  const same = mergeMcpAnswers({ source: { disabledMcpjsonServers: ['slint'] }, target: { disabledMcpjsonServers: ['slint'], x: 1 }, servers: ['slint'] })
  assert.equal(same.changed, false)
})

test("mcp answers: copied into a worktree's .claude/settings.local.json only when its .mcp.json names a server, with a missing source file answering nothing", () => {
  const project = tmp()
  const wt = tmp()
  const local = join(wt, '.claude', 'settings.local.json')
  assert.deepEqual(copyMcpAnswers({ project, worktree: wt }), { written: false, added: [] })
  assert.equal(existsSync(join(wt, '.claude')), false, 'no .mcp.json: nothing written')

  writeFileSync(join(wt, '.mcp.json'), JSON.stringify({ mcpServers: { slint: { command: 'slint-lsp' } } }))
  assert.deepEqual(copyMcpAnswers({ project, worktree: wt }), { written: true, added: ['slint'] })
  assert.equal(readFileSync(local, 'utf8'), '{\n  "disabledMcpjsonServers": [\n    "slint"\n  ]\n}\n')
  assert.deepEqual(copyMcpAnswers({ project, worktree: wt }), { written: false, added: [] }, 'already answered: not rewritten')

  mkdirSync(join(project, '.claude'))
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { TOKEN: SECRET }, enabledMcpjsonServers: ['slint'] }))
  writeFileSync(local, JSON.stringify({ permissions: { deny: ['x'] }, disabledMcpjsonServers: ['slint'] }))
  assert.deepEqual(copyMcpAnswers({ project, worktree: wt }), { written: true, added: [] })
  assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')), { permissions: { deny: ['x'] }, disabledMcpjsonServers: ['slint'], enabledMcpjsonServers: ['slint'] })
  assert.equal(readFileSync(local, 'utf8').includes(SECRET), false)
})

test('mcp answers: a source that is not JSON fails naming its path, never quoting what it holds', () => {
  const project = tmp()
  const wt = tmp()
  mkdirSync(join(project, '.claude'))
  writeFileSync(join(project, '.claude', 'settings.local.json'), `{ "env": { "TOKEN": "${SECRET}" }, oops`)
  writeFileSync(join(wt, '.mcp.json'), JSON.stringify({ mcpServers: { slint: {} } }))
  const e = (() => {
    try {
      copyMcpAnswers({ project, worktree: wt })
    } catch (x) {
      return x
    }
  })()
  assert.match(e.message, /the project's .*settings\.local\.json is not valid JSON/)
  assert.equal(e.message.includes(SECRET), false)
})

test("orca-cli: a child it creates gets the project's MCP answers before its baseline is taken; a failure to copy them is a warning, and the start goes on", { skip: ORCA_SKIPPED }, async () => {
  const LOCAL = `${CHILD_PATH}/.claude/settings.local.json`
  const files = {
    'C:/proj/.claude/settings.local.json': JSON.stringify({ env: { TOKEN: SECRET }, enabledMcpjsonServers: ['docs'] }),
    [`${CHILD_PATH}/.mcp.json`]: JSON.stringify({ mcpServers: { docs: {}, slint: {} } }),
    [LOCAL]: JSON.stringify({ permissions: { allow: ['y'] } }),
  }
  const fs = memFs(files)
  let atBaseline = null
  const git = async (cwd, args) => {
    if (args[0] === 'status') atBaseline = fs.files.get(LOCAL)
    return args[0] === 'status' ? ' M .claude/settings.local.json\n' : ''
  }
  const baselines = []
  const { argvs, orca } = childCli({}, { git, project: 'C:/proj', fs })
  const w = await orca.workerStart({ ...START, child: { ...CHILD, onBaseline: (b) => baselines.push(b.lines) } })
  assert.deepEqual(JSON.parse(atBaseline), { permissions: { allow: ['y'] }, enabledMcpjsonServers: ['docs'], disabledMcpjsonServers: ['slint'] })
  assert.deepEqual(baselines, [[' M .claude/settings.local.json']], 'the answers are part of the baseline')
  assert.deepEqual(w.warnings, ['the project has no answer for MCP server(s) slint of .mcp.json, so its worktree disables them'])
  assert.deepEqual(verbsOf(argvs), ['worktree create', 'terminal close', 'worktree set', 'terminal create', 'terminal wait', 'orchestration worker-start'])

  const bad = memFs({ ...files, 'C:/proj/.claude/settings.local.json': `{"env":{"TOKEN":"${SECRET}"},` })
  const b = childCli({}, { project: 'C:/proj', fs: bad })
  const w2 = await b.orca.workerStart({ ...START, child: CHILD })
  assert.equal(w2.worktree, CHILD_PATH)
  assert.equal(w2.warnings.length, 1)
  assert.match(w2.warnings[0], /^could not copy the project's MCP server answers into its worktree: the project's .* is not valid JSON$/)
  assert.equal(w2.warnings[0].includes(SECRET), false)
  assert.equal(bad.files.get(LOCAL), files[LOCAL], 'the worktree file is left as it was')
})

test("orca-cli: the delivery check's keys are a bare Enter, one Ctrl-U per line and never an interrupt, and the rendered screen's last lines", { skip: ORCA_SKIPPED }, async () => {
  const rows = Array.from({ length: 20 }, (_, i) => `row ${i}  `)
  const asked = []
  const { argvs, orca } = recordingCli({ 'terminal read': { terminal: { tail: rows } } }, { transcripts: { delivered: (q) => (asked.push(q), q.needle === 'Do a thing.') } })
  await orca.terminalEnter({ terminal: 'term_1' })
  await orca.terminalClearInput({ terminal: 'term_1', lines: 3 })
  const screen = await orca.terminalScreen({ terminal: 'term_1', lines: 15 })
  assert.deepEqual(argvs, [
    ['terminal', 'send', '--terminal', 'term_1', '--enter'],
    ['terminal', 'send', '--terminal', 'term_1', '--text', '\x15\x15\x15'],
    ['terminal', 'read', '--terminal', 'term_1', '--screen'],
  ])
  assert.deepEqual(
    screen,
    rows.slice(5).map((r) => r.trimEnd()),
  )
  const q = { harness: 'claude', sessionId: SID, worktree: 'C:/wt', needle: 'Do a thing.' }
  assert.equal(await orca.promptDelivered(q), true)
  assert.equal(await orca.promptDelivered({ ...q, needle: 'other' }), false)
  assert.deepEqual(asked[0], q)
})

test("transcripts: a prompt is delivered once a user message of the session carries it, whitespace collapsed; a meta line, a subagent's, or a tool result is none", () => {
  const line = (e) => JSON.stringify(e)
  const text = [line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Do a thing.' } }), line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'Do a thing.' } }), line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Do a thing.' }] } })].join('\n')
  assert.equal(promptDelivered(text, 'Do a thing.'), false)
  assert.equal(promptDelivered(`${text}\n${line({ type: 'user', message: { role: 'user', content: 'Orca preamble…\n\nDo  a\r\nthing. More.' } })}`, 'Do a thing.'), true)
  assert.equal(promptDelivered(line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Do a thing.' }] } }), 'Do a thing.'), true)
  assert.equal(promptDelivered(`not json\n${text}`, ''), false)

  const home = tmp()
  const wt = join(home, 'wt')
  const t = sessionTranscripts({ home, env: {} })
  const q = { harness: 'claude', sessionId: SID, worktree: wt, needle: 'Do a thing.' }
  assert.equal(t.delivered(q), false, 'no transcript yet')
  const dir = join(home, '.claude', 'projects', claudeSlug(wt))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${SID}.jsonl`), `${line({ type: 'user', message: { role: 'user', content: 'Do a thing.' } })}\n`)
  assert.equal(t.delivered(q), true)
})

test("transcripts: a turn has ended once the model's reply ends it, and not while a prompt, a tool, or a tool's result waits; a subagent's, a meta line and other entries do not tell", () => {
  const line = (e) => JSON.stringify(e)
  const said = (stop_reason) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason } })
  const prompt = line({ type: 'user', message: { role: 'user', content: 'Do a thing.' } })
  const toolResult = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] } })
  assert.equal(turnEnded(''), null)
  assert.equal(turnEnded([line({ type: 'permission-mode' }), line({ type: 'attachment' })].join('\n')), null)
  assert.equal(turnEnded(prompt), false)
  assert.equal(turnEnded([prompt, said('tool_use')].join('\n')), false)
  assert.equal(turnEnded([prompt, said('tool_use'), toolResult].join('\n')), false)
  assert.equal(turnEnded([prompt, said('end_turn'), line({ type: 'attachment' }), line({ type: 'system', subtype: 'stop_hook_summary' })].join('\n')), true)
  assert.equal(turnEnded([prompt, said('end_turn'), line({ type: 'user', isMeta: true, message: { role: 'user', content: 'hook' } })].join('\n')), true)
  assert.equal(turnEnded([prompt, said('end_turn'), line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sub' } })].join('\n')), true)
  assert.equal(turnEnded([prompt, line({ type: 'system', subtype: 'turn_duration' })].join('\n')), true)
  assert.equal(turnEnded([prompt, said('end_turn'), line({ type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 2 })].join('\n')), false, 'background agents still out keep the turn going')
  assert.equal(turnEnded([prompt, said('end_turn'), line({ type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 0 })].join('\n')), true)
  assert.equal(turnEnded([prompt, line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })].join('\n')), true)
  assert.equal(turnEnded(`{"type":"assistant","message":{"stop_reason":"end_turn"}}\n${prompt}\n{"type":"assis`), false, 'a torn last line waits')

  const pi = (role, stopReason) => line({ type: 'message', id: 'a', message: { role, content: [], ...(stopReason ? { stopReason } : {}) } })
  assert.equal(turnEnded([line({ type: 'session' }), pi('user')].join('\n')), false)
  assert.equal(turnEnded([pi('user'), pi('assistant', 'toolUse'), pi('toolResult')].join('\n')), false)
  assert.equal(turnEnded([pi('user'), pi('assistant', 'toolUse')].join('\n')), false)
  assert.equal(turnEnded([pi('user'), pi('assistant', 'stop'), line({ type: 'compaction' })].join('\n')), true)
  assert.equal(turnEnded([pi('user'), pi('assistant', 'length')].join('\n')), true)

  const home = tmp()
  const wt = join(home, 'wt')
  const t = sessionTranscripts({ home, env: {} })
  const q = { harness: 'claude', sessionId: SID, worktree: wt }
  assert.equal(t.idle(q), null, 'no transcript yet')
  const dir = join(home, '.claude', 'projects', claudeSlug(wt))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${SID}.jsonl`)
  writeFileSync(file, `${line({ type: 'user', message: { role: 'user', content: 'x'.repeat(300 * 1024) } })}\n${prompt}\n`)
  assert.equal(t.idle(q), false)
  appendFileSync(file, `${said('end_turn')}\n`)
  assert.equal(t.idle(q), true)
})

const PROMPT_MS = RUNNER_SETTINGS.promptDeliveryMs
const lossOnFirst =
  (how) =>
  ({ count }) =>
    count === 1 ? how : null
const callsOf = (r, verb) => r.orca.calls.filter((c) => c.verb === verb)

test('prompt delivery: a prompt a launch dialog left unsent is sent with an Enter, and the worker carries on', async () => {
  const r = await runOne(submitGood, { promptLoss: lossOnFirst('dialog'), settings: NO_DOCTOR })
  assert.deepEqual(r.result, GOOD)
  const [enter] = callsOf(r, 'terminalEnter')
  assert.equal(callsOf(r, 'terminalEnter').length, 1)
  assert.equal(enter.at - r.start.at, PROMPT_MS, 'pressed once the prompt has been missing for promptDeliveryMs')
  assert.deepEqual([callsOf(r, 'terminalClearInput').length, r.nudges.length, ofType(r.journal, 'retry').length], [0, 0, 0])
  assert.ok(
    r.lines.some((l) => l === `!! [P] one: its prompt is not in its session 20s after worker-start; pressing Enter in its terminal term_fake1`),
    r.lines.join('\n'),
  )
  assert.ok(r.lines.includes('>> [P] one: its prompt reached its session after the Enter'), r.lines.join('\n'))
})

test('prompt delivery: a prompt lost altogether is typed again, after its input is emptied, with the IDs its preamble carried', async () => {
  const r = await runOne(submitGood, { promptLoss: lossOnFirst('lost'), settings: NO_DOCTOR })
  assert.deepEqual(r.result, GOOD)
  const d = [...r.orca.dispatches.values()][0]
  const steps = r.orca.calls.filter((c) => ['terminalEnter', 'terminalClearInput', 'terminalSend'].includes(c.verb))
  assert.deepEqual(
    steps.map((c) => c.verb),
    ['terminalEnter', 'terminalClearInput', 'terminalSend'],
  )
  const [, clear, resend] = steps
  assert.equal(resend.at - r.start.at, 2 * PROMPT_MS)
  assert.ok(resend.text.endsWith(`---\n${d.prompt}`), 'the whole prompt worker-start sent')
  for (const id of [`worker handle ${d.handle}`, `task id ${d.taskId}`, `dispatch id ${d.dispatchId}`, 'Leave out --dispatch-capability']) assert.ok(resend.text.includes(id), id)
  assert.ok(clear.lines > resend.text.split('\n').length, 'a Ctrl-U for every line the input may hold, Orca preamble included')
  assert.ok(r.lines.includes('>> [P] one: its prompt reached its session when typed again'), r.lines.join('\n'))
  assert.deepEqual(ofType(r.journal, 'nudge'), [], 'typing it again is no nudge')
})

test("prompt delivery: a prompt that never arrives fails the start with its terminal's last lines, stops its worker and closes its tab; the retry takes the same worktree up", async () => {
  const r = await runOne(submitGood, { script: ISOLATED, promptLoss: lossOnFirst('never'), settings: NO_DOCTOR })
  assert.deepEqual(r.result, GOOD)
  const [retry] = ofType(r.journal, 'retry')
  assert.equal(ofType(r.journal, 'retry').length, 1)
  assert.match(retry.reason, /^its worker did not start: its prompt never reached its session, after an Enter and a second typing; its terminal's last lines:\nNew MCP server found in this project: slint\n/)
  assert.deepEqual(
    callsOf(r, 'workerStop').map((c) => c.dispatchId),
    ['ctx_fake1'],
  )
  assert.deepEqual(
    callsOf(r, 'terminalClose').map((c) => c.terminal),
    ['term_fake1'],
  )
  assert.deepEqual(
    callsOf(r, 'terminalScreen').map((c) => [c.dispatchId, c.lines]),
    [['ctx_fake1', 15]],
  )
  assert.equal(callsOf(r, 'worktreeCreate').length, 1)
  assert.deepEqual(
    callsOf(r, 'worktreeReuse').map((c) => c.worktree),
    [callsOf(r, 'worktreeCreate')[0].worktree],
  )
  assert.deepEqual(
    ofType(r.journal, 'started').map((e) => e.dispatchId),
    ['ctx_fake2'],
  )
})

test("prompt delivery: a prompt that never arrives on any attempt fails the call with the last attempt's screen", async () => {
  const r = await runOne(submitGood, { promptLoss: () => 'never', settings: NO_DOCTOR })
  assert.equal(r.result, null)
  const [failed] = ofType(r.journal, 'failed')
  assert.equal(failed.attempts, ATTEMPTS)
  assert.match(failed.reason, /its prompt never reached its session.*\nEnter to confirm · Esc to cancel$/s)
  assert.equal(callsOf(r, 'workerStop').length, ATTEMPTS)
})

test('prompt delivery: a pi worker is not checked, since pi writes no transcript before its first reply', async () => {
  const r = await runOne(submitGood, { script: oneOn('pi'), promptLoss: lossOnFirst('lost'), settings: NO_DOCTOR })
  assert.deepEqual(r.result, GOOD, 'its nudge delivered it')
  assert.deepEqual([callsOf(r, 'terminalEnter').length, callsOf(r, 'terminalClearInput').length], [0, 0])
})

test('prompts: every worker may use subagents, and is told never to start a dynamic workflow', () => {
  const p = workerPrompt('Do a thing.', { schemaPath: 's.json', resultPath: 'r.json', payloadPath: 'p.json' })
  assert.ok(p.includes(NO_WORKFLOW))
  assert.match(NO_WORKFLOW, /may use subagents/)
  assert.match(NO_WORKFLOW, /[Nn]ever start a dynamic workflow/)
})

test("prompts: a worker's finishing words name crew's submit tool first, shaped by its schema, and the CLI submit as the fallback (#174)", () => {
  const p = workerPrompt('Do a thing.', { schema: { type: 'object' }, schemaPath: 's.json', resultPath: 'r.json', payloadPath: 'p.json' })
  const toolAt = p.indexOf('If your session has a tool named `submit`, finish with it: call it with your result as its arguments, which must match the JSON Schema in s.json.')
  const fallbackAt = p.indexOf("Without that tool, or if it says crew's daemon is not reachable, submit with the command below instead:\n1. Write your result to p.json")
  assert.ok(toolAt !== -1 && fallbackAt > toolAt && p.indexOf(`node "${SUBMIT}"`) > fallbackAt, p)
  assert.match(workerPrompt('Do a thing.', { schemaPath: null, resultPath: 'r.json', payloadPath: 'p.txt' }), /call it with your answer as its `text`\. It rejects/)
  assert.match(workerPrompt('Do a thing.', { schema: { type: 'array' }, schemaPath: 's.json', resultPath: 'r.json', payloadPath: 'p.json' }), /call it with your result as its `result`, which must match/)
})

test('prompts: an attended worker is told a person will join, and never that nobody answers', () => {
  const p = workerPrompt('Help.', { schemaPath: 's.json', resultPath: 'r.json', payloadPath: 'p.json', attended: 'blockers: x' })
  assert.ok(!p.includes(NO_ASK))
  assert.match(p, /A person will join this session/)
  assert.match(p, /node ".*submit\.mjs"/)
  // The swap is all that differs: how it submits, and every other worker's
  // prompt, are as they were.
  const paths = { schemaPath: 's.json', resultPath: 'r.json', payloadPath: 'p.json' }
  assert.equal(p.replace(ATTENDED_TEXT, NO_ASK), workerPrompt('Help.', paths))
  assert.equal(workerPrompt('Help.', { ...paths, attended: null }), workerPrompt('Help.', paths))
})

test('prompts: every worker, and every doctor, is told never to run orchestration ask', () => {
  const p = workerPrompt('Do a thing.', { schemaPath: 's.json', resultPath: 'r.json', payloadPath: 'p.json' })
  assert.ok(p.includes(NO_ASK))
  assert.match(NO_ASK, /^Never run any `orchestration ask` command, whatever your session host's preamble offers, and never wait on a reply from anyone/)
  assert.match(NO_ASK, /`decisions_needed`.*then submit\.$/)
  const d = doctorPrompt({ patient: { title: 't', prompt: 'p' }, reason: 'r', round: 1, rounds: 3, transcript: 'x', worktree: null, entries: [], log: [] })
  assert.match(d, /Never run any `orchestration ask` command, whatever your session host's preamble offers: nobody answers it\. A question only a human can answer goes in your escalation or your note/)
})

// --- the run view's phase order, name column, and stuck clearing ------------

test('journal: the Run line names the phases the script declares, in its order, and a resume carries them forward', async () => {
  const stateDir = tmp()
  const meta = `export const meta = { name: 'x', phases: [{ title: 'Plan', detail: 'p' }, { title: 'Chain', detail: 'c' }] }\n`
  const script = meta + chain('Build it.')
  await runScript(script, { host: answering(1), stateDir, out: () => {}, settings: FAST })
  assert.deepEqual(
    ofType(journalOf(stateDir), 'run').map((e) => e.phases),
    [['Plan', 'Chain']],
  )
  assert.deepEqual(readJournal(join(stateDir, 'journal.jsonl')).phases, ['Plan', 'Chain'])
  // Unchanged, it replays every call and takes no Run over: the carried line
  // alone names them.
  await runScript(script, { host: answering(2), stateDir, out: () => {}, settings: FAST, resume: true })
  const [carried] = ofType(journalOf(stateDir), 'run')
  assert.deepEqual([carried.phases, carried.lastN], [['Plan', 'Chain'], 3])
  assert.deepEqual(readJournal(join(stateDir, 'journal.jsonl')).phases, ['Plan', 'Chain'])
  // A script that declares none names none.
  const bare = tmp()
  await runScript(chain('Build it.'), { host: answering(1), stateDir: bare, out: () => {}, settings: FAST })
  assert.equal(ofType(journalOf(bare), 'run')[0].phases, undefined)
  assert.equal(readJournal(join(bare, 'journal.jsonl')).phases, null)
})

viewTest("run view: phases stand in the order the script declares them, however a resume's lines come; one it does not declare follows them, and rows go by call order", async (mode) => {
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock: fakeClock() })
  const stateDir = tmp()
  const earlierJ = (n, title, state) => ({ type: 'earlier', at: at(0), n, title, run: 'run_fake1', dispatchId: `ctx_fake${n}`, harness: 'claude', sessionId: `sid-${n}`, terminal: `term_fake${n}`, worktree: wt(n), origin: n, state, reason: null })
  // As a resume writes it: the carried Run, the mail and the earlier agents
  // first, the replayed Graph call only once the script reaches it again.
  const put = (...entries) => appendFileSync(join(stateDir, 'journal.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  put(
    { type: 'run', at: at(0), runId: 'run_fake1', terminal: 'term_runner', lastN: 6, phases: ['Graph', 'Explore', 'Implement', 'Review'] },
    { type: 'mail', at: at(0), messageId: 'msg_1', kind: 'worker_done', action: 'none' },
    earlierJ(5, '[Review] review', 'done'),
    earlierJ(4, '[Implement] impl:b', 'done'),
    earlierJ(3, '[Implement] impl:a', 'failed'),
    earlierJ(2, '[Odd] odd', 'done'),
    J('result', 7, '[Graph] graph', 1, { result: GOOD, replayed: true, origin: 1 }),
  )
  const registry = registryIn()
  runRegistry(registry, { now: () => 0 }).armed({ runId: 'run_fake1', project: 'C:/repos/x', runDir: stateDir, spec: 'implement-spec-1' })
  const view = await treeIn(mode, { stateDir, orca, clock: fakeClock(), transcripts: { usage: () => null }, registry, alive: () => false })
  assert.deepEqual(
    view.model.phases.map((p) => p.name),
    ['Graph', 'Implement', 'Review', 'Odd'],
  )
  assert.deepEqual(
    view.model.phases.find((p) => p.name === 'Implement').agents.map((a) => a.n),
    [3, 4],
  )
})

test('run view: with no phases journaled, phases stand in the order their agents were called', async () => {
  const stateDir = tmp()
  writeFileSync(join(stateDir, 'journal.jsonl'), [J('result', 2, '[B] b', 0, { result: GOOD }), J('result', 1, '[A] a', 1, { result: GOOD })].map((e) => JSON.stringify(e)).join('\n'))
  const view = runView({ stateDir, host: fakeOrca(), clock: fakeClock(), transcripts: { usage: () => null }, registry: null, alive: () => false })
  await view.refresh()
  assert.deepEqual(
    view.model.phases.map((p) => p.name),
    ['A', 'B'],
  )
})

test('run view: a name that overflows scrolls in place of being cut: its start for 3 s, left at 4 characters a second to its end, its end for 5 s, then over again', () => {
  const at = (ms) => marqueeOffset(ms, 50, 34)
  // Fits: never scrolls.
  for (const ms of [0, 3000, 5000, 20_000]) assert.equal(marqueeOffset(ms, 34, 34), 0)
  assert.equal(marqueeOffset(9000, 10, 34), 0)
  // 16 characters over: 4 s of scrolling, between a 3 s and a 5 s hold.
  assert.deepEqual([0, 2999, 3000, 3249, 3250, 4000, 5000, 6999, 7000, 11_999].map(at), [0, 0, 0, 0, 1, 4, 8, 15, 16, 16])
  assert.deepEqual([12_000, 14_999, 15_250, 19_000, 24_000].map(at), [0, 0, 1, 16, 0])
  assert.equal(NAME_W, 34)
})

test('run view: the name column is 34 wide: a name that fits is padded, one that overflows is cut with … on every row but the selected one, which scrolls from its start', async () => {
  const clock = fakeClock()
  const stateDir = tmp()
  const long = 'impl:a-very-long-slice-label-that-goes-on-and-on' // 48 characters
  writeFileSync(
    join(stateDir, 'journal.jsonl'),
    [
      startedJ(1, `[Implement] ${long}`, 0, 'claude', 'sid-1'),
      startedJ(2, `[Implement] ${long}-two`, 0, 'claude', 'sid-2'),
      J('doctor', 1, `[Implement] ${long}`, 1, { origin: 1, round: 1, reason: 'r', doctor: 3 }),
      { ...startedJ(3, `[Implement] recover -> ${long}`, 1, 'claude', 'sid-3'), key: null },
      startedJ(4, '[Implement] short', 0, 'claude', 'sid-4'),
    ]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  )
  const view = runView({ stateDir, host: fakeOrca(), clock, transcripts: { usage: () => null }, registry: null, alive: () => false })
  await view.refresh()
  assert.deepEqual(
    view.model.rows.map((r) => r.key),
    ['phase:Implement', 'agent:1', 'agent:3', 'agent:2', 'agent:4'],
  )
  const screen = (now) => draw(view.model, { width: 160, height: 30, now })
  const nameOf = (s, i) => strip(s.lines[4 + i]).slice(8, 8 + 34)
  // The phase row is selected: nothing scrolls, and every long name is cut.
  let s = screen(clock.now())
  assert.equal(s.scrolling, false)
  const cut = long.slice(0, 33) + '…'
  assert.equal(nameOf(s, 1), cut)
  assert.equal(nameOf(s, 2), '└ recover'.padEnd(34), 'a doctor keeps its └ and names its role')
  assert.equal(nameOf(s, 4), 'short'.padEnd(34))
  assert.match(strip(s.lines[4 + 1]), new RegExp(`^ +1 +${cut} ✗ failed`))

  clock.t = 60_000
  await view.key('DOWN')
  assert.equal(view.model.selectedAt, 60_000)
  const selectedName = (now) => nameOf(screen(now), 1)
  assert.equal(screen(60_000).scrolling, true)
  assert.equal(selectedName(60_000), long.slice(0, 34), 'its start, uncut')
  assert.equal(selectedName(62_999), long.slice(0, 34))
  assert.equal(selectedName(64_000), long.slice(4, 38))
  assert.equal(selectedName(70_000), long.slice(14), 'its end, held')
  assert.equal(selectedName(72_000), long.slice(0, 34), 'then its start again')
  // A refresh keeps its loop going.
  await view.refresh()
  assert.equal(view.model.selectedAt, 60_000)
  // Moving on: the row left is cut again, and the doctor's name fits, so
  // nothing scrolls.
  clock.t = 90_000
  await view.key('DOWN')
  s = screen(91_000)
  assert.equal(s.scrolling, false)
  assert.equal(nameOf(s, 1), cut)
  // The next long row starts its own loop from its start.
  clock.t = 100_000
  await view.key('DOWN')
  assert.equal(view.model.selectedAt, 100_000)
  assert.equal(nameOf(screen(101_000), 3), `${long}-two`.slice(0, 34))
  assert.equal(nameOf(screen(104_000), 3), `${long}-two`.slice(4, 38))
  assert.equal(nameOf(screen(104_000), 1), cut)
})

test('journal: moving turns a stuck agent back to running, or continued once it was continued; it changes no other state', () => {
  const nudge = J('nudge', 1, '[P] one', 20, { dispatchId: 'ctx_fake1', reason: 'no movement', attempt: 1 })
  const moving = J('moving', 1, '[P] one', 25, { dispatchId: 'ctx_fake1' })
  const start = startedJ(1, '[P] one', 0, 'claude', 'sid-1')
  const stateOf = (...entries) => foldJournal(entries).agents[0].state
  assert.equal(stateOf(start, nudge), 'stuck')
  assert.equal(stateOf(start, nudge, moving), 'running')
  assert.equal(foldJournal([start, nudge, moving]).agents[0].reason, null)
  const cont = J('continued', 1, '[P] one', 10, { dispatchId: 'ctx_fake1', sessionId: 'sid-1', terminal: 'term_fake1', reason: 'it exited', attempt: 1, reopened: false })
  assert.equal(stateOf(start, cont, nudge, moving), 'continued')
  const blocked = J('blocked', 1, '[P] one', 21, { dispatchId: 'ctx_fake1', terminal: 'term_fake1', waiting: 'a question' })
  assert.equal(stateOf(start, nudge, blocked, moving), 'blocked')
  assert.equal(stateOf(start, moving), 'running')
})

test("liveness: a nudged worker that moves past its nudge's echo is journaled moving once, and is no longer stuck", async () => {
  const r = await runOne(async (w) => {
    // The nudge lands in the transcript: that is the nudge, not the worker.
    w.state.onNudge = () => {
      w.state.transcript = (w.state.transcript ?? 0) + 120
    }
    w.clock.at(25 * MIN, () => {
      w.state.transcript = 5_000
    })
    w.clock.at(26 * MIN, () => {
      w.state.transcript = 6_000
    })
    w.clock.at(30 * MIN, () => submitGood(w))
  })
  assert.deepEqual(r.result, GOOD)
  assertEntries(r.journal)
  const [nudge] = ofType(r.journal, 'nudge')
  const moving = ofType(r.journal, 'moving')
  assert.equal(moving.length, 1, 'once: it was stuck only once')
  assert.deepEqual([moving[0].key, moving[0].n, moving[0].title, moving[0].dispatchId], [nudge.key, nudge.n, nudge.title, nudge.dispatchId])
  within(Date.parse(moving[0].at), 25 * MIN, 'moving')
  const upTo = (e) => foldJournal(r.journal.slice(0, r.journal.indexOf(e) + 1)).agents[0].state
  assert.equal(upTo(nudge), 'stuck')
  assert.equal(upTo(moving[0]), 'running')
})

test("liveness: movement within its nudge's echo leaves a nudged worker stuck", async () => {
  const r = await runOne(async (w) => {
    w.state.onNudge = () => {
      w.state.transcript = (w.state.transcript ?? 0) + 120
      w.clock.at(w.clock.now() + 5_000, () => {
        w.state.transcript += 40
      })
    }
    w.clock.at(30 * MIN, () => submitGood(w))
  })
  assert.deepEqual(r.result, GOOD)
  assert.equal(ofType(r.journal, 'nudge').length, 1)
  assert.deepEqual(ofType(r.journal, 'moving'), [])
  assert.equal(foldJournal(r.journal.filter((e) => e.type !== 'result')).agents[0].state, 'stuck')
})

// --- a halted run, and a resume by node (ADR-0016) ---------------------------

// A schema that holds decisions_needed, the convention a result needs the
// operator by.
const DSCHEMA = { ...SCHEMA, properties: { ...SCHEMA.properties, decisions_needed: { type: 'array', items: { type: 'string' } } } }
const ASKS = { ...GOOD, decisions_needed: ['Keep the v1 key, or break it?'] }
const ANSWERED = { ...GOOD, decisions_needed: [] }
const nodeCall = (id, more = '') => `agent('Do ${id}.', { label: '${id}', phase: 'P', schema: ${JSON.stringify(DSCHEMA)}, node: 'n/${id}'${more} })`
const submitsValue =
  (value) =>
  async ({ prompt, preamble, orca }) => {
    const argv = submitArgvIn(prompt, preamble)
    writeFileSync(argv[argv.indexOf('--payload') + 1], JSON.stringify(value))
    assert.equal((await runSubmit(argv, orca)).code, 0)
  }
// Dies at once, its dispatch failed; a continuation of its session submits.
const diesThenSubmitsOnContinue = async ({ state }) => {
  state.onContinue = submitGood
  throw new Error('agent died')
}
const until = async (pred, what) => {
  for (let i = 0; i < 2000; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  assert.fail(`timed out waiting for ${what}`)
}

// One Orca and one state dir for every runner of a run, each runner in its
// own terminal; workers played by their prompt's first line (`plays`), the
// rest submitting GOOD. go() starts a runner and does not wait on it.
function nodeRig(plays = {}, { faults = {}, setupLeaves = [], crew = false } = {}) {
  const orca = fakeOrca({ worker: (w) => (plays[w.prompt.split('\n')[0]] ?? submitGood)(w), faults, setupLeaves, crew })
  const stateDir = tmp()
  const registry = join(stateDir, 'orca-runs.jsonl')
  const lines = []
  const halts = []
  let runs = 0
  const go = (script, { resume = false, settings = {}, runnerTerminal = null } = {}) => {
    const from = orca.calls.length
    const control = {}
    const run = { control, settled: null, calls: () => orca.calls.slice(from) }
    run.p = runScript(script, { host: orca.as(`term_${++runs}`), stateDir, registry, out: (s) => lines.push(s), settings: { ...FAST, ...NO_DOCTOR, ...settings }, resume, control, onHalt: (h) => halts.push(h), runnerTerminal })
    run.p.then(
      (v) => {
        run.settled = { value: v }
      },
      (e) => {
        run.settled = { error: e }
      },
    )
    return run
  }
  const journal = () => journalOf(stateDir)
  const started = (run) =>
    run
      .calls()
      .filter((c) => c.verb === 'workerStart')
      .map((c) => c.title)
  return { orca, stateDir, registry, lines, halts, go, journal, started }
}

test('resume by node: a finished node after a failed one is kept, not run again, and the failed node carries on in its own session', async () => {
  const rig = nodeRig({ 'Do a.': diesThenSubmitsOnContinue })
  const script = `return await parallel([() => ${nodeCall('a')}, () => ${nodeCall('b')}])`
  const first = rig.go(script)
  await until(() => rig.halts.length && ofType(rig.journal(), 'result').some((e) => e.node === 'n/b'), 'the halt, and b done')
  assert.equal(first.settled, null, 'a halted run never settles by itself')
  assert.equal(readRegistry(rig.registry)[0].state, 'halted')
  // The runner died; a --resume rebuilds the run by node.
  const second = rig.go(script, { resume: true })
  const result = await second.p
  assert.deepEqual(result, [GOOD, GOOD])
  assert.deepEqual(rig.started(second), [], 'b is replayed; a carries on in its session, no worker started')
  const [c] = second.calls().filter((x) => x.verb === 'workerContinue')
  assert.match(c.text, /halted here, and the operator has resumed it/)
  const j = rig.journal()
  assertEntries(j)
  assert.deepEqual(
    ofType(j, 'result')
      .filter((e) => !e.carried)
      .map((e) => [e.node, !!e.replayed]),
    [
      ['n/b', true],
      ['n/a', false],
    ],
  )
  assert.ok(
    ofType(j, 'failed').some((e) => e.node === 'n/a' && e.carried),
    'the failed node was carried forward first',
  )
  assert.equal(readRegistry(rig.registry)[0].state, 'ok')
})

// Pause (p): no new agent starts while paused.json is in the state dir;
// agents already at work finish. Sticky: a runner that comes back stays paused.
const pauseRun = (stateDir) => writeFileSync(join(stateDir, 'paused.json'), JSON.stringify({ at: new Date().toISOString() }))

test('pause: a paused run lets its running agent finish and starts no next one; r releases it', async () => {
  let rig
  rig = nodeRig({
    'Do a.': async (w) => {
      pauseRun(rig.stateDir)
      return submitGood(w)
    },
  })
  const run = rig.go(`const a = await ${nodeCall('a')}\nconst b = await ${nodeCall('b')}\nreturn [a, b]`)
  await until(() => rig.lines.some((l) => l.endsWith('[P] b: held, the run is paused')), 'b held')
  assert.deepEqual(rig.started(run), ['[P] a'])
  assert.equal(ofType(rig.journal(), 'pause').length, 1, JSON.stringify(rig.journal().map((e) => e.type)))
  assert.ok(
    rig.lines.some((l) => /PAUSED/.test(l)),
    rig.lines.join('\n'),
  )
  const b = foldJournal(rig.journal()).agents.find((x) => x.node === 'n/b')
  assert.deepEqual([b.state, b.reason], ['queued', 'held: the run is paused'])
  await run.control.resume({})
  assert.deepEqual(await run.p, [GOOD, GOOD])
  assert.ok(!existsSync(join(rig.stateDir, 'paused.json')), 'r removes the pause')
  assert.equal(ofType(rig.journal(), 'unpause').length, 1)
  assert.deepEqual(rig.started(run), ['[P] a', '[P] b'])
})

test('pause: a runner that starts on a paused run stays paused, and removing paused.json resumes it', async () => {
  const rig = nodeRig({})
  pauseRun(rig.stateDir)
  const run = rig.go(`return await ${nodeCall('a')}`, { settings: { pollMs: 5 } })
  await until(() => rig.lines.some((l) => l.endsWith('[P] a: held, the run is paused')), 'a held')
  assert.deepEqual(rig.started(run), [])
  rmSync(join(rig.stateDir, 'paused.json'))
  assert.deepEqual(await run.p, GOOD)
})

test('pause: every new call is held, an in-flight one too, each journaled held; PAUSED is logged once; r starts them in call order', async () => {
  let rig
  rig = nodeRig({
    'Do a.': async (w) => {
      pauseRun(rig.stateDir)
      return submitGood(w)
    },
  })
  const run = rig.go(`const a = await ${nodeCall('a')}\nreturn [a, ...(await parallel([() => ${nodeCall('b')}, () => ${nodeCall('c', ', inFlight: true')}, () => ${nodeCall('d')}]))]`)
  await until(() => rig.lines.filter((l) => l.endsWith(': held, the run is paused')).length === 3, 'b, c and d held')
  assert.deepEqual(rig.started(run), ['[P] a'])
  assert.deepEqual(
    ofType(rig.journal(), 'held').map((e) => [e.node, e.paused]),
    [
      ['n/b', true],
      ['n/c', true],
      ['n/d', true],
    ],
  )
  assert.equal(rig.lines.filter((l) => /PAUSED/.test(l)).length, 1, rig.lines.join('\n'))
  assert.deepEqual(
    foldJournal(rig.journal())
      .agents.filter((x) => x.node !== 'n/a')
      .map((x) => [x.state, x.reason]),
    Array(3).fill(['queued', 'held: the run is paused']),
  )
  assert.deepEqual(await run.control.resume({}), { resumed: [], unpaused: true })
  assert.deepEqual(await run.p, [GOOD, GOOD, GOOD, GOOD])
  assert.deepEqual(rig.started(run), ['[P] a', '[P] b', '[P] c', '[P] d'])
  assert.deepEqual(
    rig
      .journal()
      .filter((e) => ['pause', 'unpause'].includes(e.type))
      .map((e) => e.type),
    ['pause', 'unpause'],
  )
})

test("pause: on a run both halted and paused, the runner's resume lifts the pause, journaled even if no call saw it, and resumes the halt", async () => {
  const rig = nodeRig({ 'Do a.': diesThenSubmitsOnContinue })
  const run = rig.go(`return await parallel([() => ${nodeCall('a')}, () => ${nodeCall('b')}])`)
  await until(() => rig.halts.length && ofType(rig.journal(), 'result').some((e) => e.node === 'n/b'), 'the halt, and b done')
  pauseRun(rig.stateDir)
  assert.deepEqual(await run.control.resume({}), { resumed: ['n/a'], unpaused: true })
  assert.ok(!existsSync(join(rig.stateDir, 'paused.json')))
  assert.deepEqual(await run.p, [GOOD, GOOD])
  assert.deepEqual(
    rig
      .journal()
      .filter((e) => ['pause', 'unpause'].includes(e.type))
      .map((e) => e.type),
    ['pause', 'unpause'],
  )
})

test('hold queue: a call the halt held, then the pause, keeps its place ahead of a later in-flight call the pause alone held; once both clear they start in call order', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-hold-'))
  const entries = []
  const lines = []
  const queue = holdQueue()
  const halt = runHalt({ journal: (e) => entries.push(e), out: (s) => lines.push(s), queue })
  const pause = runPause({ stateDir, journal: (e) => entries.push(e), out: (s) => lines.push(s), sleep: () => new Promise(() => {}), pollMs: 1, queue })
  const started = []
  const call = (title, inFlight = false) => {
    const held = queue.gate({ key: title, n: 0, node: `n/${title}`, title }, { inFlight })
    assert.ok(held, `${title} is held`)
    return held.then(() => started.push(title))
  }
  const resumed = halt.hold({ node: 'n/x', title: 'x', reason: 'it failed' })
  const a = call('a')
  assert.equal(pauseRunIn(stateDir, new Date()), true)
  assert.equal(pauseRunIn(stateDir, new Date()), false, 'already paused')
  const b = call('b', true)
  halt.resume()
  await resumed
  halt.settle('n/x')
  const c = call('c')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(started, [], 'the pause holds every one')
  assert.equal(pause.lift(), true)
  await Promise.all([a, b, c])
  assert.deepEqual(started, ['a', 'b', 'c'])
  assert.deepEqual(
    entries.filter((e) => e.type === 'held').map((e) => [e.node, !!e.paused]),
    [
      ['n/a', false],
      ['n/b', true],
      ['n/a', true],
      ['n/c', true],
    ],
  )
  assert.ok(lines.includes('>> no failed or needs-decision node is left: the run is no longer halted, and the 1 call held meanwhile go on'), lines.join('\n'))
  assert.equal(pause.lift(), false)
  assert.equal(unpauseRun(stateDir), false, 'not paused')
})

// A sequential run (ADR-0020) halted on its first chained node.
const CHAIN_PATH = 'C:/fake/worktrees/run_fake1-chain'
const chainedRun = `const a = await ${nodeCall('a', ", isolation: 'chain'")}
const b = await ${nodeCall('b', ", isolation: 'chain'")}
return [a, b]`
async function haltedChain() {
  const rig = nodeRig({ 'Do a.': diesThenSubmitsOnContinue }, { setupLeaves: ['?? setup.out'] })
  rig.go(chainedRun)
  await until(() => rig.halts.length, 'the halt on a')
  assert.deepEqual(
    ofType(rig.journal(), 'started').map((e) => e.worktree),
    [CHAIN_PATH],
  )
  return rig
}

test('resume of a sequential run: the halted node carries on in the chain worktree, and the next agent starts in it, nothing made', async () => {
  const rig = await haltedChain()
  const second = rig.go(chainedRun, { resume: true })
  assert.deepEqual(await second.p, [GOOD, GOOD])
  const [c] = second.calls().filter((x) => x.verb === 'workerContinue')
  assert.equal(c.worktree, CHAIN_PATH)
  assert.doesNotMatch(c.text, /made again/)
  const starts = second.calls().filter((x) => x.verb === 'workerStart')
  assert.deepEqual(
    starts.map((s) => [s.title, s.placement, s.worktree]),
    [['[P] b', 'chain', CHAIN_PATH]],
  )
  assert.match(rig.orca.dispatches.get(starts[0].dispatchId).prompt, /left by its setup: setup\.out/, 'the baseline journaled when it was made, by the earlier runner')
  assert.deepEqual(
    second.calls().filter((x) => x.verb === 'worktreeCreate'),
    [],
  )
  assertEntries(rig.journal())
  assert.deepEqual(foldJournal(rig.journal()).chain, { runId: 'run_fake1', worktree: CHAIN_PATH, baseline: ['?? setup.out'], leftovers: [] }, 'still journaled for the next resume')
})

test('resume of a sequential run: a chain worktree reclaimed while halted is made again once, setup and all, and the halted node and the next agent carry on in it', async () => {
  const rig = await haltedChain()
  await rig.orca.worktreeRemove({ path: CHAIN_PATH })
  const second = rig.go(chainedRun, { resume: true })
  assert.deepEqual(await second.p, [GOOD, GOOD])
  assert.deepEqual(
    second
      .calls()
      .filter((x) => x.verb === 'worktreeCreate')
      .map((x) => [x.name, x.worktree]),
    [['run_fake1-chain', CHAIN_PATH]],
  )
  const [c] = second.calls().filter((x) => x.verb === 'workerContinue')
  assert.deepEqual([c.worktree, c.reopened], [CHAIN_PATH, true])
  assert.match(c.text, /reclaimed while the run was halted and has been made again/)
  assert.match(c.text, /left by its setup: setup\.out\. They are not your work/)
  const starts = second.calls().filter((x) => x.verb === 'workerStart')
  assert.deepEqual(
    starts.map((s) => [s.title, s.placement, s.worktree]),
    [['[P] b', 'chain', CHAIN_PATH]],
  )
  assert.equal(rig.orca.worktrees.get(CHAIN_PATH).removed, false)
  assert.deepEqual(
    ofType(rig.journal(), 'chain').map((e) => e.worktree),
    [CHAIN_PATH, CHAIN_PATH],
    'the earlier one carried, then the remake',
  )
})

test('resume by node: a node whose key changed runs live and ends replay for every later call; an unchanged earlier node still replays', async () => {
  const rig = nodeRig()
  const seq = (b) => `const a = await ${nodeCall('a')}
const b = await agent(${JSON.stringify(b)}, { label: 'b', phase: 'P', schema: ${JSON.stringify(DSCHEMA)}, node: 'n/b' })
const c = await ${nodeCall('c')}
return [a, b, c]`
  await rig.go(seq('Do b.')).p
  const edited = rig.go(seq('Do b twice.'), { resume: true })
  assert.deepEqual(await edited.p, [GOOD, GOOD, GOOD])
  assert.deepEqual(rig.started(edited), ['[P] b', '[P] c'], 'c is unchanged but follows a changed node')
  assert.ok(
    rig.lines.some((l) => l.includes('node n/b changed since the last run')),
    rig.lines.join('\n'),
  )
  const same = rig.go(seq('Do b twice.'), { resume: true })
  await same.p
  assert.deepEqual(rig.started(same), [])
})

test('resume: calls with no node keep the prefix rule: a failed call returns null, and it and every call after it run live on a resume', async () => {
  let dies = true
  const rig = nodeRig({
    'Plan it.': async (w) => {
      if (dies) throw new Error('agent died')
      return submitGood(w)
    },
  })
  const script = `const a = await agent('Plan it.', { label: 'a', phase: 'P', schema: ${JSON.stringify(SCHEMA)} })
const b = await agent('Build it.', { label: 'b', phase: 'P', schema: ${JSON.stringify(SCHEMA)} })
return [a, b]`
  assert.deepEqual(await rig.go(script).p, [null, GOOD])
  assert.deepEqual(rig.halts, [], 'no node, no halt')
  dies = false
  const again = rig.go(script, { resume: true })
  assert.deepEqual(await again.p, [GOOD, GOOD])
  assert.deepEqual(rig.started(again), ['[P] a', '[P] b'])
})

// a fails; s runs on until the halt, then submits; c is a new call and is
// held, d an in-flight one and runs.
const HALTING = `return await parallel([
  () => ${nodeCall('a')},
  async () => {
    const s = await ${nodeCall('s')}
    return [s, ...(await parallel([() => ${nodeCall('c')}, () => ${nodeCall('d', ', inFlight: true')}]))]
  },
])`

test('halt: a failed node is held and halts the run: a new call is held unstarted, an in-flight one runs; r carries the node on in its session, and the held call is released', async () => {
  let halted
  const haltSeen = new Promise((r) => {
    halted = r
  })
  const rig = nodeRig({
    'Do a.': diesThenSubmitsOnContinue,
    'Do s.': async (w) => {
      await haltSeen
      return submitGood(w)
    },
  })
  const run = rig.go(HALTING)
  await until(() => rig.halts.length, 'the halt')
  halted()
  await until(() => ofType(rig.journal(), 'result').some((e) => e.node === 'n/d') && ofType(rig.journal(), 'held').length, 'd done and c held')
  assert.equal(run.settled, null)
  let j = rig.journal()
  assert.deepEqual(
    ofType(j, 'held').map((e) => e.node),
    ['n/c'],
  )
  assert.ok(!rig.started(run).includes('[P] c'), 'c is not started while halted')
  assert.ok(rig.started(run).includes('[P] d'), 'an in-flight call goes on')
  assert.deepEqual(
    ofType(j, 'halted').map((e) => e.node),
    ['n/a'],
  )
  assert.ok(
    logged(rig.stateDir).some((l) => /HALTED: n\/a failed: .*; r to resume$/.test(l)),
    logged(rig.stateDir).join('\n'),
  )
  assert.equal(readRegistry(rig.registry)[0].state, 'halted')
  const fold = foldJournal(j)
  assert.deepEqual(fold.halted.nodes, ['n/a'])
  assert.deepEqual(fold.agents.find((a) => a.node === 'n/c').state, 'queued')

  assert.deepEqual(await run.control.resume({}), { resumed: ['n/a'], unpaused: false })
  assert.deepEqual(await run.p, [GOOD, [GOOD, GOOD, GOOD]])
  j = rig.journal()
  assertEntries(j)
  assert.equal(ofType(j, 'unhalted').length, 1)
  assert.ok(indexOf(j, (e) => e.type === 'unhalted') < indexOf(j, (e) => e.type === 'starting' && e.node === 'n/c'), 'c starts only once the run leaves halted')
  assert.equal(ofType(j, 'continued').find((e) => e.node === 'n/a').attempt, 0, 'its continuations count afresh')
  assert.equal(readRegistry(rig.registry)[0].state, 'ok')
})

test("halt: r takes the result.json a failed node's worker submitted after the run gave up on it, re-validated, and runs nothing", async () => {
  const rig = nodeRig({
    'Do a.': async ({ state }) => {
      state.onContinue = async () => {
        throw new Error('died again')
      }
      throw new Error('agent died')
    },
  })
  const run = rig.go(`return await ${nodeCall('a')}`)
  await until(() => rig.halts.length, 'the halt')
  const { dir } = ofType(rig.journal(), 'started')[0]
  const at = join(rig.stateDir, dir, 'result.json')
  writeFileSync(at, JSON.stringify(BAD))
  const before = rig.orca.calls.length
  // Invalid: never taken. Its session is continued instead, and fails again.
  await run.control.resume({ node: 'n/a' })
  await until(() => rig.halts.length === 2, 'the second halt')
  writeFileSync(at, JSON.stringify(GOOD))
  const mid = rig.orca.calls.length
  await run.control.resume({ node: 'n/a' })
  assert.deepEqual(await run.p, GOOD)
  assert.ok(rig.orca.calls.slice(before, mid).some((c) => c.verb === 'workerContinue'))
  assert.deepEqual(
    rig.orca.calls.slice(mid).filter((c) => ['workerStart', 'workerContinue'].includes(c.verb)),
    [],
  )
  assert.equal(ofType(rig.journal(), 'result').at(-1).resumedFrom, 'result.json')
})

test('halt: r starts a failed node afresh when its worker never started', async () => {
  const rig = nodeRig({}, { faults: { workerStart: ({ count }) => (count === 1 ? new Error('boom') : null) } })
  const run = rig.go(`return await ${nodeCall('a', ", isolation: 'worktree'")}`, { settings: { retryBackoffMs: [] } })
  await until(() => rig.halts.length, 'the halt')
  assert.deepEqual(rig.started(run), [])
  await run.control.resume({})
  assert.deepEqual(await run.p, GOOD)
  assert.deepEqual(rig.started(run), ['[P] a'])
  assert.ok(
    rig.lines.some((l) => l.endsWith('its worker never started, so it starts now')),
    rig.lines.join('\n'),
  )
})

test('halt: a node whose result needs decisions is held as needs you with its questions; r tells its session the operator answered, and its answer is returned', async () => {
  const rig = nodeRig({
    'Do a.': async (w) => {
      w.state.onContinue = submitsValue(ANSWERED)
      return submitsValue(ASKS)(w)
    },
  })
  const run = rig.go(`return await ${nodeCall('a')}`)
  await until(() => rig.halts.length, 'the halt')
  const j = rig.journal()
  assert.equal(ofType(j, 'result')[0].needsDecision, true)
  const a = foldJournal(j).agents[0]
  assert.equal(a.state, 'needs you')
  assert.match(a.reason, /Keep the v1 key, or break it\?/)
  assert.ok(logged(rig.stateDir).some((l) => /HALTED: n\/a needs decisions only you can make: Keep the v1 key/.test(l)))
  const { dir } = ofType(j, 'started')[0]
  assert.ok(existsSync(join(rig.stateDir, dir, 'result.needs-decision.json')), 'its result.json is set aside')
  await run.control.resume({})
  assert.deepEqual(await run.p, ANSWERED)
  const [c] = rig.orca.calls.filter((x) => x.verb === 'workerContinue')
  assert.match(c.text, /operator has answered them\. Re-read the ticket, its body and its comments/)
  assert.equal(c.reopened, true, 'its dispatch settled, so it continues under a new one')
})

test("halt: a resume that carries the operator's decisions (the orchestrator's decide, #194) hands them to the node's session in its prompt, each question with its answer, instead of sending it to the ticket", async () => {
  const rig = nodeRig({
    'Do a.': async (w) => {
      w.state.onContinue = submitsValue(ANSWERED)
      return submitsValue(ASKS)(w)
    },
  })
  const run = rig.go(`return await ${nodeCall('a')}`)
  await until(() => rig.halts.length, 'the halt')
  const decisions = [{ question: 'Keep the v1 key, or break it?', answer: 'Keep it: v2 reads both until 2027.' }]
  assert.deepEqual(await run.control.resume({ node: 'n/a', decisions }), { resumed: ['n/a'], unpaused: false })
  assert.deepEqual(await run.p, ANSWERED)
  const [c] = rig.orca.calls.filter((x) => x.verb === 'workerContinue')
  assert.match(
    c.text,
    /^The workflow run was halted here: your result named decisions only the operator can make, and the operator has answered them here, each question with its answer\. Q: Keep the v1 key, or break it\? A: Keep it: v2 reads both until 2027\. Take these answers as final, and finish the task, then finish with `submit`/,
  )
  assert.doesNotMatch(c.text, /Re-read the ticket/)
  assert.ok(
    rig.lines.some((l) => l.endsWith('>> r: resuming n/a, with 1 decision from the operator')),
    rig.lines.join('\n'),
  )
})

// --- reopen: a settled node carried on by a journal line ----------------------

const REOPEN_NOTE = 'CodeBuild is checked once the stack is published: do not count it unmet.'
const REDONE = { ...GOOD, count: 3 }

test("reopen: a node of an ended run reopened by a journal line is carried on in its own session with the operator's note on --resume, every other node replayed, and the script gets its new result", async () => {
  const rig = nodeRig({
    'Do b.': async (w) => {
      w.state.onContinue = submitsValue(REDONE)
      return submitsValue(GOOD)(w)
    },
  })
  const script = `const a = await ${nodeCall('a')}\nconst b = await ${nodeCall('b')}\nreturn [a, b]`
  assert.deepEqual(await rig.go(script).p, [GOOD, GOOD])
  const bDir = foldJournal(rig.journal()).nodes.get('n/b').last.dir

  assert.deepEqual(reopenNode(rig.stateDir, { node: 'n/b', note: REOPEN_NOTE }, { alive: () => false }), { node: 'n/b', title: '[P] b' })
  const second = rig.go(script, { resume: true })
  assert.deepEqual(await second.p, [GOOD, REDONE])

  assert.deepEqual(rig.started(second), [], 'a is replayed, b carries on in its session: no worker started')
  const [c] = second.calls().filter((x) => x.verb === 'workerContinue')
  assert.ok(c.text.startsWith(`The workflow run ended, and the operator reopened your task with a note: ${REOPEN_NOTE} Take it as final`), c.text)
  const j = rig.journal()
  assertEntries(j)
  assert.deepEqual(
    ofType(j, 'result')
      .filter((e) => !e.carried)
      .map((e) => [e.node, !!e.replayed]),
    [
      ['n/a', true],
      ['n/b', false],
    ],
  )
  assert.deepEqual(JSON.parse(readFileSync(join(rig.stateDir, bDir, 'result.reopened.json'), 'utf8')), GOOD, 'the result it was reopened from is set aside')
  assert.equal(foldJournal(j).nodes.get('n/b').reopened, undefined, 'its new result settles the reopen')
})

test('reopen: a resume that ends before it reaches the reopened node carries the reopen forward, and the next resume carries the node on', async () => {
  const rig = nodeRig({
    'Do b.': async (w) => {
      w.state.onContinue = submitsValue(REDONE)
      return submitsValue(GOOD)(w)
    },
  })
  const script = `const a = await ${nodeCall('a')}\nconst b = await ${nodeCall('b')}\nreturn [a, b]`
  await rig.go(script).p
  reopenNode(rig.stateDir, { node: 'n/b', note: REOPEN_NOTE }, { alive: () => false })
  assert.deepEqual(await rig.go(`return [await ${nodeCall('a')}]`, { resume: true }).p, [GOOD])
  assert.deepEqual(
    foldJournal(rig.journal()).reopened.map(({ node, note }) => [node, note]),
    [['n/b', REOPEN_NOTE]],
  )
  const third = rig.go(script, { resume: true })
  assert.deepEqual(await third.p, [GOOD, REDONE])
  assert.equal(third.calls().filter((x) => x.verb === 'workerContinue').length, 1)
  assert.deepEqual(foldJournal(rig.journal()).reopened, [])
})

// --- a resubmit carries a held node on (#173) --------------------------------

// A worker that submits `first`, and is kept (`w`) to submit again from the
// test, as an agent of a held node does on its own.
const keepsWorker = (first) => {
  const kept = { w: null }
  kept.play = async (w) => {
    kept.w = w
    return submitsValue(first)(w)
  }
  return kept
}
// The verbs from the latest worker_done on: the runner's next look sees it.
const afterLastSubmit = (rig) => {
  const at = rig.orca.calls.findLastIndex((c) => c.verb === 'workerDone')
  return rig.orca.calls.slice(at + 1).map((c) => c.verb)
}

test('resubmit: a held needs-decision node whose worker submits a result without decisions returns to the script within one poll, with no r and no session continued', async () => {
  const kept = keepsWorker(ASKS)
  const rig = nodeRig({ 'Do a.': kept.play }, { crew: true })
  const run = rig.go(`return await ${nodeCall('a')}`)
  await until(() => rig.halts.length, 'the halt')
  await submitsValue(ANSWERED)(kept.w)
  assert.deepEqual(await run.p, ANSWERED)
  assert.deepEqual(
    afterLastSubmit(rig)
      .filter((v) => ['workerShow', 'workerResult'].includes(v))
      .slice(0, 2),
    ['workerShow', 'workerResult'],
    'the first look after it took it',
  )
  assert.deepEqual(
    rig.orca.calls.filter((c) => ['workerStart', 'workerContinue'].includes(c.verb)).map((c) => c.verb),
    ['workerStart'],
  )
  assert.ok(!existsSync(join(rig.stateDir, RESUME_REQUEST)))
  const j = rig.journal()
  assertEntries(j)
  const taken = ofType(j, 'result').at(-1)
  assert.deepEqual([taken.resumedFrom, taken.resubmitted, taken.needsDecision], ['result.json', true, undefined])
  assert.equal(ofType(j, 'unhalted').length, 1)
  assert.ok(
    rig.lines.some((l) => l.endsWith('resuming node n/a: took the result its worker submitted again after the run gave up on it')),
    rig.lines.join('\n'),
  )
  assert.deepEqual(JSON.parse(readFileSync(join(rig.stateDir, ofType(j, 'started')[0].dir, 'result.json'), 'utf8')), ANSWERED, 'the runner wrote it to its result file')
})

test('resubmit: one that lands after the settle but before the hold is watched is taken too, with no r: the count the runner took the result at is its baseline, and a resume carries it forward', async () => {
  const kept = keepsWorker(ASKS)
  const rig = nodeRig({ 'Do a.': kept.play }, { crew: true })
  // The runner's first look once the result is journaled is the resubmit
  // watch's: the worker submits again just before it, as submit does, its
  // file written first.
  const record = rig.orca.calls.push.bind(rig.orca.calls)
  let early = false
  rig.orca.calls.push = (c) => {
    if (!early && c.verb === 'workerShow' && ofType(rig.journal(), 'result').length) {
      early = true
      const p = kept.w.preamble
      const argv = submitArgvIn(kept.w.prompt, p)
      writeFileSync(argv[argv.indexOf('--result') + 1], JSON.stringify(ANSWERED))
      void kept.w.orca.workerDone({ from: p.handle, capability: p.capability, taskId: p.taskId, dispatchId: p.dispatchId, subject: 'result submitted', body: '', result: ANSWERED })
    }
    return record(c)
  }
  const run = rig.go(`return await ${nodeCall('a')}`)
  assert.deepEqual(await run.p, ANSWERED)
  assert.ok(early, 'it submitted again before the watch looked')
  const j = rig.journal()
  assert.deepEqual(
    ofType(j, 'result').map((e) => [!!e.needsDecision, !!e.resubmitted, e.submissions]),
    [
      [true, false, 1],
      [false, true, undefined],
    ],
  )
  assert.deepEqual(
    rig.orca.calls.filter((c) => ['workerStart', 'workerContinue'].includes(c.verb)).map((c) => c.verb),
    ['workerStart'],
  )

  // A resume carries the count forward with the node it halted on.
  const held = nodeRig({ 'Do a.': submitsValue(ASKS) }, { crew: true })
  held.go(`return await ${nodeCall('a')}`)
  await until(() => held.halts.length, 'the halt')
  assert.equal(foldJournal(held.journal()).nodes.get('n/a').submissions, 1)
  held.go('return 1', { resume: true })
  await until(() => ofType(held.journal(), 'result').some((e) => e.carried), 'the carried line')
  assert.equal(ofType(held.journal(), 'result').find((e) => e.carried).submissions, 1)
})

test('resubmit: one still naming decisions holds the node again, its row showing the new questions', async () => {
  const kept = keepsWorker(ASKS)
  const rig = nodeRig({ 'Do a.': kept.play }, { crew: true })
  const run = rig.go(`return await ${nodeCall('a')}`)
  await until(() => rig.halts.length, 'the halt')
  const ASKS_AGAIN = { ...GOOD, decisions_needed: ['Which region first?'] }
  await submitsValue(ASKS_AGAIN)(kept.w)
  await until(() => rig.halts.length === 2, 'the second hold')
  assert.equal(run.settled, null)
  const a = foldJournal(rig.journal()).agents[0]
  assert.equal(a.state, 'needs you')
  assert.match(a.reason, /Which region first\?/)
  const notice = JSON.parse(readFileSync(join(rig.stateDir, 'halted.json'), 'utf8'))
  assert.deepEqual(notice.nodes[0].questions, ['Which region first?'])
  await submitsValue(ANSWERED)(kept.w)
  assert.deepEqual(await run.p, ANSWERED)
  assert.deepEqual(
    ofType(rig.journal(), 'result').map((e) => [!!e.needsDecision, !!e.resubmitted]),
    [
      [true, false],
      [true, true],
      [false, true],
    ],
  )
})

test('resubmit: a failed node whose worker was kept open is carried on by its submit the same way; one whose worker is gone is never polled', async () => {
  const kept = { w: null }
  const rig = nodeRig(
    {
      'Do a.': async (w) => {
        kept.w = w
        w.state.waiting = '{"evidence":"prompt-text","text":"Allow this command?"}'
      },
      'Do b.': async ({ state }) => {
        state.onContinue = submitGood
        throw new Error('agent died')
      },
    },
    { crew: true },
  )
  const run = rig.go(`return await parallel([() => ${nodeCall('a')}, () => ${nodeCall('b')}])`, { settings: { blockedFailMs: 20 } })
  await until(() => rig.halts.length === 2, 'both held')
  const heldSince = rig.orca.calls.length
  const failed = ofType(rig.journal(), 'failed')
  assert.deepEqual(failed.map((e) => [e.node, !!e.workerLeft]).sort(), [
    ['n/a', true],
    ['n/b', false],
  ])
  const dispatchOf = (node) => ofType(rig.journal(), 'started').find((e) => e.node === node).dispatchId
  const [da, db] = [dispatchOf('n/a'), dispatchOf('n/b')]
  await until(() => rig.orca.calls.filter((c) => c.verb === 'workerShow' && c.dispatchId === da).length > 3, 'a polled')
  kept.w.state.waiting = null
  await submitsValue(GOOD)(kept.w)
  await until(() => ofType(rig.journal(), 'result').some((e) => e.node === 'n/a'), 'a delivered')
  assert.equal(ofType(rig.journal(), 'result').find((e) => e.node === 'n/a').resubmitted, true)
  assert.deepEqual(
    rig.orca.calls.slice(heldSince).filter((c) => ['workerShow', 'workerResult'].includes(c.verb) && c.dispatchId === db),
    [],
  )
  assert.equal(run.settled, null, 'b is still held')
  await run.control.resume({ node: 'n/b' })
  assert.deepEqual(await run.p, [GOOD, GOOD])
})

test('resubmit: a held node with none still waits for r; a resubmit and r together act once', async () => {
  const kept = keepsWorker(ASKS)
  const rig = nodeRig({ 'Do a.': async (w) => ((w.state.onContinue = submitsValue(ANSWERED)), kept.play(w)) }, { crew: true })
  const run = rig.go(`return await ${nodeCall('a')}`)
  await until(() => rig.halts.length, 'the halt')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(run.settled, null, 'no resubmit: still held')
  await submitsValue(GOOD)(kept.w)
  await run.control.resume({ node: 'n/a' })
  assert.deepEqual(await run.p, GOOD)
  const j = rig.journal()
  assert.equal(ofType(j, 'result').filter((e) => e.resumedFrom).length, 1)
  assert.deepEqual(
    rig.orca.calls.filter((c) => c.verb === 'workerContinue'),
    [],
  )
  assert.equal(ofType(j, 'unhalted').length, 1)

  // With none, r carries it on as before: its session told the operator answered.
  const rig2 = nodeRig({ 'Do a.': async (w) => ((w.state.onContinue = submitsValue(ANSWERED)), submitsValue(ASKS)(w)) }, { crew: true })
  const run2 = rig2.go(`return await ${nodeCall('a')}`)
  await until(() => rig2.halts.length, 'the halt')
  await run2.control.resume({})
  assert.deepEqual(await run2.p, ANSWERED)
  assert.equal(rig2.orca.calls.filter((c) => c.verb === 'workerContinue').length, 1)
  assert.equal(ofType(rig2.journal(), 'result').at(-1).resubmitted, undefined)
})

test('halt: an attended node that could not clear its blockers is held; r continues its session with the person, still needs you', async () => {
  const rig = nodeRig({
    'Do a.': async (w) => {
      w.state.onContinue = submitsValue(ANSWERED)
      return submitsValue(ASKS)(w)
    },
  })
  const run = rig.go(`return await ${nodeCall('a', ", attended: 'blockers: no signing identity'")}`)
  await until(() => rig.halts.length, 'the halt')
  assert.equal(foldJournal(rig.journal()).agents[0].state, 'needs you')
  await run.control.resume({})
  assert.deepEqual(await run.p, ANSWERED)
  const [c] = rig.orca.calls.filter((x) => x.verb === 'workerContinue')
  assert.match(c.text, /The person is back/)
  assert.doesNotMatch(c.text, /Re-read the ticket/)
  // Its continued line says it is attended, so a resume whose journal starts
  // afresh still shows it needing you.
  const continued = ofType(rig.journal(), 'continued').at(-1)
  assert.equal(continued.attended, 'blockers: no signing identity')
  assert.equal(foldJournal([continued]).agents[0].state, 'needs you')
})

const viewOn = (entries, over = {}) => {
  const clock = fakeClock()
  clock.t = 5 * MIN
  const stateDir = tmp()
  writeFileSync(join(stateDir, 'journal.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  writeFileSync(join(stateDir, 'runner.log'), '')
  const view = runView({ stateDir, host: fakeOrca({ clock }), clock, registry: null, transcripts: { usage: () => null }, alive: () => true, ...over })
  return { stateDir, view }
}

test('run view: an attended agent shows needs you with its reason while at work, and the alert names its tab', async () => {
  const { view } = viewOn([{ ...startedJ(1, '[Unblock] unblock', 0, 'claude', 'sid-1'), attended: 'blockers: no signing identity' }, startedJ(2, '[Implement] impl:a', 0, 'claude', 'sid-2')])
  await view.refresh()
  const row = (n) => view.model.rows.find((r) => r.key === `agent:${n}`).agent
  assert.deepEqual([row(1).state, row(1).reason], ['needs you', 'blockers: no signing identity'])
  assert.equal(row(2).state, 'running')
  assert.equal(view.model.alert, 'NEEDS YOU: [Unblock] unblock in tab term_fake1: blockers: no signing identity')
  const lines = draw(view.model, { width: 200, height: 30, flash: null, alert: view.model.alert }).lines.map(strip)
  assert.ok(
    lines.some((l) => /unblock +\? needs you/.test(l)),
    lines.join('\n'),
  )
  assert.ok(lines.at(-2).includes('NEEDS YOU: [Unblock] unblock in tab term_fake1: blockers: no signing identity'), lines.at(-2))
})

test('run view: an ended run\'s header shows its outcome from summary.json, never a red "gone"; only a runner gone with no summary is gone', async () => {
  const header = async (summary) => {
    const { stateDir, view } = viewOn([startedJ(1, '[P] a', 0, 'claude', 'sid-1')], { alive: () => false })
    if (summary) writeFileSync(join(stateDir, 'summary.json'), JSON.stringify(summary))
    await view.refresh()
    return [view.model.header.outcome, draw(view.model, { width: 200, height: 30 }).lines.map(strip)[0]]
  }
  const [done, doneLine] = await header({ runner: 'session', ok: true, result: { halted: false, state: 'ready for review' } })
  assert.deepEqual(done, { kind: 'complete', detail: 'ready for review' })
  assert.match(doneLine, /✓ complete — ready for review/)
  assert.doesNotMatch(doneLine, /gone/)
  const [halted, haltedLine] = await header({ runner: 'session', ok: true, result: { halted: true, reason: '#143 failed: not published' } })
  assert.deepEqual(halted, { kind: 'halted', detail: '#143 failed: not published' })
  assert.match(haltedLine, /⏸ halted — #143 failed: not published · r to resume/)
  const [failed, failedLine] = await header({ runner: 'session', ok: false, error: 'the script threw: boom' })
  assert.deepEqual(failed, { kind: 'failed', detail: 'the script threw: boom' })
  assert.match(failedLine, /✗ failed — the script threw: boom/)
  const [gone, goneLine] = await header(null)
  assert.equal(gone, null)
  assert.match(goneLine, /runner ○ gone/)
})

test('run view: p pauses the run, the header says how many agents are finishing; r resumes it', async () => {
  const { stateDir, view } = viewOn([startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1')])
  await view.refresh()
  assert.match((await view.key('p')).message, /paused: no new agent starts; 1 agent is finishing/)
  assert.ok(existsSync(join(stateDir, 'paused.json')))
  await view.refresh()
  assert.deepEqual(view.model.header.paused, { finishing: 1 })
  assert.match(draw(view.model, { width: 160, height: 30 }).lines.map(strip)[1], /^ ⏸ paused — 1 agent finishing · r to resume/)
  assert.match((await view.key('p')).message, /already paused/)
  assert.match((await view.key('r')).message, /resumed/)
  assert.ok(!existsSync(join(stateDir, 'paused.json')))
  await view.refresh()
  assert.equal(view.model.header.paused, null)
})

test('run view: r on a run both paused and halted lifts the pause and asks the runner to resume the halt', async () => {
  const asked = []
  const { stateDir, view } = viewOn([startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'), J('failed', 1, '[Implement] impl:a', 1, { node: 'n/a', reason: 'it died', attempts: 1 }), { type: 'halted', at: at(1), node: 'n/a', reason: 'it died' }], { resumeHalted: (node) => asked.push(node) })
  pauseRun(stateDir)
  await view.refresh()
  assert.deepEqual(view.model.header.paused, { finishing: 0 })
  assert.match(draw(view.model, { width: 160, height: 30 }).lines.map(strip)[1], /^ ⏸ paused · r to resume/)
  assert.match((await view.key('r')).message, /resumed: the agents held by the pause start/)
  assert.ok(!existsSync(join(stateDir, 'paused.json')))
  assert.equal(asked.length, 1)
})

test('run view: x asks before removing; y removes, asking f for each worktree with unpushed commits, one at a time', async () => {
  const forced = []
  const kept = [
    { agent: { title: '[P] a', worktree: '/wt/a' }, reason: '/wt/a holds 2 unpushed commits; only a forced reclaim removes it', unpushed: 2, worktree: '/wt/a' },
    { agent: { title: '[P] b', worktree: '/wt/b' }, reason: '/wt/b holds 1 unpushed commit; only a forced reclaim removes it', unpushed: 1, worktree: '/wt/b' },
  ]
  let removed = 0
  const remove = async () => (
    removed++,
    {
      kept,
      force: async (k) => (forced.push(k.agent.worktree), { reclaimed: true, notes: [] }),
      finish: () => ({
        left: [
          { worktree: '/wt/b', title: '[P] b', reason: kept[1].reason },
          { worktree: null, title: '[P] c', reason: 'it is still live' },
        ],
      }),
    }
  )
  const { view } = viewOn([startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1')], { remove })
  await view.refresh()
  await view.key('x')
  assert.equal(view.model.dialog.kind, 'confirm')
  assert.match(view.model.dialog.title, /^Remove run /)
  assert.ok(view.model.dialog.lines.some((l) => /y = remove it · any other key cancels/.test(l)))
  assert.match((await view.key('n')).message, /nothing removed/)
  assert.equal(removed, 0)
  await view.key('x')
  await view.key('y')
  assert.equal(removed, 1)
  assert.match(view.model.dialog.title, /Force-delete \/wt\/a\?/)
  assert.ok(view.model.dialog.lines.some((l) => /f = force-delete it, and those commits are lost · any other key keeps it/.test(l)))
  await view.key('f')
  assert.match(view.model.dialog.title, /Force-delete \/wt\/b\?/)
  const done = await view.key('k')
  assert.deepEqual(forced, ['/wt/a'])
  assert.equal(done.removed, true)
  assert.equal(done.message, `removed the run; left on disk: /wt/b (${kept[1].reason}); [P] c (it is still live)`)
  assert.equal(view.model.dialog, null)
})

test('runs list: p pauses the run under the cursor and shows it paused; r resumes it; x opens its tree on the remove dialog', async () => {
  const stateDir = tmp()
  writeFileSync(join(stateDir, 'journal.jsonl'), '')
  const registry = registryIn()
  runRegistry(registry).armed({ runId: 'run_1', project: 'C:/repos/app', runDir: stateDir, spec: 'implement-spec-103', host: 'crew' })
  const runs = runsView({ host: { terminalList: async () => [] }, registry, transcripts: { usage: () => null }, alive: () => true })
  await runs.refresh()
  while (runs.model.rows[runs.model.selected]?.kind !== 'run') await runs.key('DOWN')
  assert.match((await runs.key('p')).message, /^paused/)
  assert.ok(existsSync(join(stateDir, 'paused.json')))
  await runs.refresh()
  assert.equal(runs.model.rows.find((r) => r.kind === 'run').run.operatorPaused, true)
  assert.match(
    listRuns(runs.model).find((l) => l.includes('run_1')),
    /run_1 +crew +#103 +paused /,
  )
  assert.match((await runs.key('p')).message, /already paused/)
  assert.match((await runs.key('r')).message, /^resumed/)
  assert.ok(!existsSync(join(stateDir, 'paused.json')))
  await runs.key('x')
  assert.match(runs.opened().model.dialog.title, /^Remove run run_1\?/)
  assert.match((await runs.key('n')).message, /nothing removed/)
})

test('runs list: x, then y, removes the run under the cursor: back on the list, the run gone from it and from the registry, its run folder deleted', async () => {
  const folder = join(tmp(), 'runs', '103-20261001-120000-ab12')
  const stateDir = join(folder, 'orca-run')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'journal.jsonl'), '')
  const registry = registryIn()
  runRegistry(registry).armed({ runId: 'run_1', project: 'C:/repos/app', runDir: stateDir, spec: 'implement-spec-103', host: 'crew' })
  const runs = runsView({ host: { terminalList: async () => [] }, registry, transcripts: { usage: () => null }, alive: () => false })
  await runs.refresh()
  while (runs.model.rows[runs.model.selected]?.kind !== 'run') await runs.key('DOWN')
  await runs.key('x')
  const done = await runs.key('y')
  assert.equal(done.removed, true)
  assert.match(done.message, /^removed the run/)
  assert.equal(runs.opened(), null, 'back on the list')
  assert.ok(!runs.model.rows.some((r) => r.kind === 'run'))
  assert.deepEqual(readRegistry(registry), [])
  assert.ok(!existsSync(folder))
})

test("run view: on a halted run the header says so; r on a failed or needs-you node resumes that node, r elsewhere every held one; the view's r reaches the runner with its node", async () => {
  const clock = fakeClock()
  clock.t = 5 * MIN
  const stateDir = tmp()
  const nodeJ = (type, n, node, min, more = {}) => J(type, n, `[Implement] ${node}`, min, { node, ...more })
  writeFileSync(
    join(stateDir, 'journal.jsonl'),
    [
      startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'),
      nodeJ('failed', 1, 'n/a', 1, { reason: 'it died', attempts: 1 }),
      nodeJ('result', 2, 'n/b', 2, { result: ASKS, needsDecision: true }),
      nodeJ('result', 3, 'n/c', 2, { result: GOOD }),
      { type: 'halted', at: at(1), node: 'n/a', reason: 'it died' },
      nodeJ('held', 4, 'n/d', 3),
    ]
      .map((e) => JSON.stringify(e) + '\n')
      .join(''),
  )
  writeFileSync(join(stateDir, 'runner.log'), '')
  const asked = []
  const view = runView({ stateDir, host: fakeOrca({ clock }), clock, registry: null, transcripts: { usage: () => null }, alive: () => true, resumeHost: () => asked.push('orca'), resumeHalted: (node) => asked.push(node) })
  await view.refresh()
  assert.deepEqual(view.model.header.halted, { since: at(1), nodes: ['n/a', 'n/b'] })
  assert.match(draw(view.model, { width: 160, height: 30 }).lines.map(strip)[1], /^ ⏸ halted — 2 nodes need you · r to resume/)
  const agents = view.model.phases.flatMap((p) => p.agents)
  assert.deepEqual(
    agents.map((a) => [a.node, a.state]),
    [
      ['n/a', 'failed'],
      ['n/b', 'needs you'],
      ['n/c', 'done'],
      ['n/d', 'queued'],
    ],
  )
  const select = async (n) => {
    while (view.model.selected > 0) await view.key('UP')
    while (view.model.rows[view.model.selected].agent?.n !== n) await view.key('DOWN')
  }
  await select(1)
  assert.match((await view.key('r')).message, /resume n\/a$/)
  await select(2)
  await view.key('r')
  await select(3)
  await view.key('r')
  while (view.model.selected > 0) await view.key('UP')
  await view.key('r')
  assert.deepEqual(asked, ['n/a', 'n/b', null, null])

  const views = fakeViews(clock)
  const got = []
  attachView({ spawnView: views.spawn, tab: () => {}, log: () => {}, clock, resume: (m) => got.push(m) }).start()
  views.last().emit('message', { type: 'resume', node: 'n/a' })
  views.last().emit('message', { type: 'resume' })
  await turns()
  assert.deepEqual(got, [{ node: 'n/a' }, { node: null }])
})

test("standalone: an ended run's RUNNER column reads its summary.json as the header does: complete, halted with r, or failed; a halted run whose runner died with no summary is dead; a runner alive after its end is alive", async () => {
  const clock = fakeClock()
  clock.t = RUNS_AT
  const registry = registryIn()
  const w = runRegistry(registry, clock)
  const dir = tmp()
  const live = new Set()
  const arm = (id, n, summary, { ended = null, halted = false } = {}) => {
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(join(dir, id, 'journal.jsonl'), '')
    if (summary) writeFileSync(join(dir, id, 'summary.json'), JSON.stringify(summary))
    w.armed({ runId: id, project: PROJECT, runDir: join(dir, id), spec: `implement-spec-${n}` })
    w.runner({ runId: id, terminal: `term_${id}` })
    if (halted) w.halted({ runId: id, node: 'n/x', reason: 'it died' })
    if (ended) w.ended({ runId: id, outcome: ended })
  }
  // A script halt: the registry says ok, the summary says halted (#157's own case).
  arm('run_script_halt', 901, { runner: 'session', ok: true, result: { halted: true, reason: '#143 failed: not published' } }, { ended: 'ok' })
  arm('run_failed', 902, { runner: 'session', ok: false, error: 'the script threw: boom' }, { ended: 'failed' })
  arm('run_halted_dead', 903, null, { halted: true })
  arm('run_done_alive', 904, { runner: 'session', ok: true, result: { halted: false, state: 'ready' } }, { ended: 'ok' })
  live.add(join(dir, 'run_done_alive'))
  const runs = runsView({ host: fakeOrca({ clock, runWorktree: PROJECT }), clock, registry, transcripts: { usage: () => null }, alive: (d) => live.has(d) })
  await runs.refresh()
  const lineOf = (id) => screenOf(runs.model).find((l) => l.includes(id))
  const runOf = (id) => runs.model.projects.flatMap((p) => p.runs).find((r) => r.runId === id)
  assert.match(lineOf('run_script_halt'), /run_script_halt +#901 +ok +⏸ halted +0/)
  assert.deepEqual(runOf('run_script_halt').end, { kind: 'halted', detail: '#143 failed: not published' })
  assert.match(lineOf('run_failed'), /run_failed +#902 +failed +✗ failed +0/)
  assert.match(lineOf('run_halted_dead'), /run_halted_dead +#903 +halted +○ dead +0/)
  assert.match(lineOf('run_done_alive'), /run_done_alive +#904 +ok +● alive +0/)
  assert.equal(runOf('run_done_alive').end, null, 'a live runner is alive, whatever it wrote')
  assert.match(screenOf(runs.model)[1], /● 1 alive {2}2 ended {2}○ 1 dead {2}0 reclaimed/)
  // The pane: the end with its detail, and r's reason.
  const select = async (key) => {
    while (runs.model.rows[runs.model.selected].key !== key) await runs.key('DOWN')
  }
  const pane = () => screenOf(runs.model).slice(-6, -2).join('\n')
  await select('run:run_script_halt')
  assert.match(pane(), /⏸ halted — #143 failed: not published/)
  assert.match(pane(), /r resumes it: it halted/)
  await select('run:run_failed')
  assert.match(pane(), /✗ failed — the script threw: boom/)
  assert.match(pane(), /r resumes it: its runner ended/)
  await select('run:run_halted_dead')
  assert.match(pane(), /r resumes it: its runner is dead/)
  // crew ls says the same.
  const ls = listRuns(runs.model)
  assert.match(
    ls.find((l) => l.includes('run_script_halt')),
    /runner ⏸ halted/,
  )
  assert.match(
    ls.find((l) => l.includes('run_failed')),
    /runner ✗ failed/,
  )
  assert.match(
    ls.find((l) => l.includes('run_halted_dead')),
    /runner ○ dead/,
  )
})

test('standalone: a halted run is listed halted, is not ended while its runner lives, and r points at its tab', async () => {
  const clock = fakeClock()
  clock.t = RUNS_AT
  const registry = registryIn()
  const w = runRegistry(registry, clock)
  const dir = tmp()
  w.armed({ runId: 'run_h', project: PROJECT, runDir: dir, spec: 'implement-spec-901' })
  w.runner({ runId: 'run_h', terminal: 'term_h' })
  w.halted({ runId: 'run_h', node: 'ticket/12/impl/r1/s1', reason: 'it died' })
  assert.equal(readRegistry(registry)[0].state, 'halted')
  assert.equal(runEnded({ run: readRegistry(registry)[0], alive: true, stateDir: dir }), false)
  const runs = runsView({ host: fakeOrca({ clock, runWorktree: PROJECT }), clock, registry, transcripts: { usage: () => null }, alive: () => true })
  await runs.refresh()
  assert.match(
    screenOf(runs.model).find((l) => l.includes('run_h')),
    /run_h +#901 +halted +● alive/,
  )
  assert.match((await runs.resume('run_h')).message, /alive and halted, in tab term_h: r there resumes it/)
  w.unhalted({ runId: 'run_h' })
  assert.equal(readRegistry(registry)[0].state, 'running')
})

test('halt: halted.json tells the arming session: removed at start, written on the halt, rewritten with a new at when a second node is held and when one of them is carried on, removed once the run leaves halted', async () => {
  let aHeld
  const aSeen = new Promise((r) => {
    aHeld = r
  })
  const rig = nodeRig({
    'Do a.': diesThenSubmitsOnContinue,
    'Do b.': async (w) => {
      await aSeen
      w.state.onContinue = submitsValue(ANSWERED)
      return submitsValue(ASKS)(w)
    },
  })
  const at = join(rig.stateDir, 'halted.json')
  writeFileSync(at, JSON.stringify({ at: 'stale', nodes: [] }))
  const run = rig.go(`return await parallel([() => ${nodeCall('a')}, () => ${nodeCall('b')}])`)
  assert.equal(existsSync(at), false, 'a stale halted.json is removed as the runner starts')
  const notice = () => (existsSync(at) ? JSON.parse(readFileSync(at, 'utf8')) : null)
  await until(() => rig.halts.length === 1, 'the first halt')
  const first = notice()
  const j = rig.journal()
  const tabOf = (node) => ofType(j, 'started').find((e) => e.node === node).terminal
  assert.equal(first.terminal, 'term_1', "the runner's tab")
  assert.equal(first.runId, ofType(j, 'run')[0].runId)
  assert.deepEqual(
    first.nodes.map(({ node, title, tab }) => ({ node, title, tab })),
    [{ node: 'n/a', title: '[P] a', tab: tabOf('n/a') }],
  )
  assert.match(first.nodes[0].reason, /./)
  assert.equal('questions' in first.nodes[0], false)
  aHeld()
  await until(() => rig.halts.length === 2, 'the second halt')
  const second = notice()
  assert.notEqual(second.at, first.at)
  assert.deepEqual(
    second.nodes.map((x) => x.node),
    ['n/a', 'n/b'],
  )
  assert.deepEqual(second.nodes[1], { node: 'n/b', title: '[P] b', reason: 'Keep the v1 key, or break it?', questions: ['Keep the v1 key, or break it?'], tab: ofType(rig.journal(), 'started').find((e) => e.node === 'n/b').terminal })
  await run.control.resume({ node: 'n/b' })
  await until(() => notice()?.nodes.length === 1, 'b carried on')
  const third = notice()
  assert.notEqual(third.at, second.at)
  assert.deepEqual(
    third.nodes.map((x) => x.node),
    ['n/a'],
  )
  await run.control.resume({})
  assert.deepEqual(await run.p, [GOOD, ANSWERED])
  assert.equal(existsSync(at), false, 'removed once the run leaves halted')
})

test("halt: where the Run's terminal is not the runner's own (crew), halted.json, the journal and the registry all name the runner's own session", async () => {
  const rig = nodeRig({ 'Do a.': diesThenSubmitsOnContinue })
  const run = rig.go(`return await ${nodeCall('a')}`, { runnerTerminal: '7' })
  await until(() => rig.halts.length === 1, 'the halt')
  assert.equal(JSON.parse(readFileSync(join(rig.stateDir, 'halted.json'), 'utf8')).terminal, '7', 'the session R is pressed in')
  assert.equal(ofType(rig.journal(), 'run')[0].terminal, '7')
  assert.equal(readRegistry(rig.registry)[0].runner.terminal, '7')
  await run.control.resume({})
  assert.deepEqual(await run.p, GOOD)
})

test('halt: while an Orca outage is on, r probes Orca and resumes no held node; once Orca is back, r resumes the held node', async () => {
  let release
  const released = new Promise((r) => {
    release = r
  })
  const rig = nodeRig({
    'Do a.': diesThenSubmitsOnContinue,
    'Do s.': async (w) => {
      await released
      return submitGood(w)
    },
  })
  const run = rig.go(`return await parallel([() => ${nodeCall('a')}, () => ${nodeCall('s')}])`)
  await until(() => rig.halts.length, 'the halt')
  rig.orca.down(RUNTIME_GONE)
  await until(() => ofType(rig.journal(), 'outage').some((e) => e.phase === 'start'), "s's watch meeting the outage")
  const continued = () => rig.orca.calls.filter((c) => c.verb === 'workerContinue').length
  assert.deepEqual(await run.control.resume({}), { back: false, outage: true })
  assert.equal(continued(), 0, 'no held node is resumed during the outage')
  assert.ok(!rig.lines.some((l) => l.startsWith('>> r: resuming')), rig.lines.join('\n'))
  assert.ok(rig.lines.includes('!! Orca is still unreachable: every Orca call still waits for it'), rig.lines.join('\n'))
  rig.orca.up()
  assert.deepEqual(await run.control.resume({}), { back: true, outage: true }, 'this R ends the outage, and still resumes nothing')
  assert.equal(continued(), 0)
  release()
  assert.deepEqual(await run.control.resume({}), { resumed: ['n/a'], unpaused: false })
  assert.deepEqual(await run.p, [GOOD, GOOD])
  assert.equal(continued(), 1)
  assert.deepEqual(phasesOf(rig.journal()), ['start', 'end'])
})

test("resume by node: a failed node a dead runner's --resume starts afresh is one row in the fold and the view, its latest attempt, not the superseded failed one", async () => {
  const rig = nodeRig({}, { faults: { workerStart: ({ count }) => (count === 1 ? new Error('boom') : null) } })
  const script = `return await ${nodeCall('a', ", isolation: 'worktree'")}`
  rig.go(script, { settings: { retryBackoffMs: [] } })
  await until(() => rig.halts.length, 'the halt')
  // The runner died; a --resume starts the node afresh (its worker never started).
  const second = rig.go(script, { resume: true, settings: { retryBackoffMs: [] } })
  const { worktrees_kept: kept, ...value } = await second.p
  assert.deepEqual(value, GOOD)
  assert.equal(kept.length, 1, 'the worktree its failed start was given')
  assert.deepEqual(rig.started(second), ['[P] a'])
  const fold = readJournal(join(rig.stateDir, 'journal.jsonl'))
  // The failed attempt stays an agent of the Run, for its worktree's reclaim.
  assert.deepEqual(
    fold.agents.filter((a) => a.node === 'n/a').map((a) => [a.state, !!a.superseded, !!a.worktree]),
    [
      ['failed', true, true],
      ['done', false, true],
    ],
  )
  const clock = fakeClock()
  const view = runView({ stateDir: rig.stateDir, host: rig.orca, clock, registry: null, transcripts: { usage: () => null }, alive: () => false })
  await view.refresh()
  assert.deepEqual(
    view.model.phases.flatMap((p) => p.agents).map((a) => [a.node, a.state]),
    [['n/a', 'done']],
  )
})

test("resume: inFlight is no part of a call's key", () => {
  assert.equal(journalKey('p', { node: 'n/a', inFlight: true }), journalKey('p', { node: 'n/a' }))
})

// --- crew as the session host, dying and coming back (#104) ---------------------

// The fake Orca played as crew (ADR-0017): its daemon not answering is crew's
// outage, and a crew that dies takes every session it holds with it, which
// the next daemon shows as lost with its host (`hostDied`).
const CREW_GONE = Object.assign(new Error('connect ENOENT \\\\.\\pipe\\crew-test'), { code: 'ENOENT' })

async function crewDiesRun({ settings = {}, backAt = 15 * MIN, afterContinue }) {
  const clock = fakeClock()
  const lines = []
  const stateDir = tmp()
  const registry = registryIn()
  const live = new Map()
  const lost = new Set()
  const orca = fakeOrca({
    clock,
    worker: ({ state, preamble }) => {
      live.set(preamble.dispatchId, state)
      state.onContinue = afterContinue
    },
  })
  const host = {
    ...orca,
    id: 'crew',
    name: 'crew',
    unreachable: daemonGone,
    async workerShow(a) {
      const s = await orca.workerShow(a)
      return lost.has(a.dispatch) && s.gone && !s.settled ? { ...s, hostDied: true } : s
    },
  }
  let mid = null
  clock.at(MIN, () => {
    orca.down(CREW_GONE)
    for (const [dispatch, state] of live) {
      state.gone = true
      lost.add(dispatch)
    }
  })
  clock.at(12 * MIN, () => {
    mid = readRegistry(registry).at(0)?.paused ?? null
  })
  clock.at(backAt, () => orca.up())
  const result = await runScript(ONE, { host: sessionHost(host), stateDir, out: (s) => lines.push(s), clock, settings: { ...NO_DOCTOR, ...settings }, transcripts: fakeTranscripts(orca), registry, project: 'C:/repo' })
  return { result, lines, registry, mid, journal: journalOf(stateDir) }
}

test('crew: crew unreachable is the outage an Orca outage is — journaled, clocks stopped, paused past its limit as a crew outage, resumed by itself — and a session lost with crew is continued, uncounted, even at a cap of 0', async () => {
  const r = await crewDiesRun({ settings: { maxContinuations: 0 }, afterContinue: submitGood })
  assert.deepEqual(r.result, GOOD, r.lines.join('\n'))
  assertEntries(r.journal)
  assert.deepEqual(phasesOf(r.journal), ['start', 'paused', 'end'])
  const [, paused, end] = ofType(r.journal, 'outage')
  assert.deepEqual([paused.at, end.at], [isoAt(11 * MIN), isoAt(15 * MIN)])
  assert.ok(
    r.lines.some((l) => /^!! crew unreachable \(connect ENOENT .*\): every crew call waits for it/.test(l)),
    r.lines.join('\n'),
  )
  assert.ok(
    r.lines.some((l) => l.endsWith('crew unreachable for 10m: run paused; r to resume (or it resumes itself once crew is back)')),
    r.lines.join('\n'),
  )
  assert.ok(r.lines.includes('>> crew is back after 14 min: the run carries on'), r.lines.join('\n'))
  assert.deepEqual(r.mid, { reason: 'crew outage', at: isoAt(11 * MIN) })
  assert.equal(readRegistry(r.registry)[0].paused, null, 'unpaused once crew is back')
  const continued = ofType(r.journal, 'continued')
  assert.deepEqual(
    continued.map((e) => [e.reason, e.attempt, e.hostDied, e.reopened]),
    [['its session died with its session host', 0, true, true]],
  )
  assert.ok(
    r.lines.some((l) => /its session died with its session host; continuing session \S+ \(not counted against the cap\)/.test(l)),
    r.lines.join('\n'),
  )
  assert.deepEqual(ofType(r.journal, 'failed'), [])
  assert.equal(ofType(r.journal, 'nudge').length, 0, 'fourteen minutes of crew gone stuck nobody')
})

test('crew: after a continuation for crew dying, an ordinary death still spends the cap: one more is continued at a cap of 1, and the next is past it', async () => {
  const diesOnce = ({ state }) => {
    state.gone = true
    state.onContinue = submitGood
  }
  const once = await crewDiesRun({ settings: { maxContinuations: 1 }, backAt: 2 * MIN, afterContinue: diesOnce })
  assert.deepEqual(once.result, GOOD, once.lines.join('\n'))
  assert.deepEqual(
    ofType(once.journal, 'continued').map((e) => [e.attempt, e.hostDied ?? false]),
    [
      [0, true],
      [1, false],
    ],
  )

  const always = ({ state }) => {
    state.gone = true
    state.onContinue = always
  }
  const capped = await crewDiesRun({ settings: { maxContinuations: 1 }, backAt: 2 * MIN, afterContinue: always })
  assert.equal(capped.result, null)
  assert.deepEqual(
    ofType(capped.journal, 'continued').map((e) => [e.attempt, e.hostDied ?? false]),
    [
      [0, true],
      [1, false],
    ],
  )
  const [failed] = ofType(capped.journal, 'failed')
  assert.match(failed.reason, /^its terminal is gone, and its session was already continued 1 times, the cap of 1/)
  assert.equal(failed.continuations, 1)
})

test("run view: an agent's note ends its row, cut to the screen's width, and its own needs-you shows needs you with its reason", async () => {
  const clock = fakeClock()
  const orca = fakeOrca({ worker: () => new Promise(() => {}), clock })
  for (let n = 1; n <= 2; n++) await orca.workerStart({ run: 'run_fake1', prompt: 'p', title: `t${n}`, sessionId: SID, child: { name: `run_fake1-${n}`, displayName: `t${n}` } })
  const stateDir = tmp()
  const journalPath = join(stateDir, 'journal.jsonl')
  const note = `reading the spec, then ${'the tests '.repeat(15)}`.trim()
  appendFileSync(
    journalPath,
    [
      { type: 'run', at: at(0), runId: 'run_fake1', terminal: 'term_runner' },
      startedJ(1, '[Implement] impl:a', 0, 'claude', 'sid-1'),
      J('note', 1, '[Implement] impl:a', 1, { dispatchId: 'ctx_fake1', note: 'first' }),
      J('note', 1, '[Implement] impl:a', 2, { dispatchId: 'ctx_fake1', note }),
      startedJ(2, '[Implement] impl:b', 0, 'claude', 'sid-2'),
      J('needsYou', 2, '[Implement] impl:b', 3, { dispatchId: 'ctx_fake2', terminal: 'term_fake2', reason: 'Log in to npm' }),
    ]
      .map((e) => JSON.stringify(e) + '\n')
      .join(''),
  )
  clock.t = 4 * MIN
  const view = runView({ stateDir, host: orca, clock, transcripts: sessionTranscripts({ home: tmp(), env: {} }) })
  await view.refresh()
  const W = 160
  const rows = draw(view.model, { width: W, height: 30, alert: view.model.alert }).lines.map(strip)
  const a = rows.find((l) => /^ +1 +impl:a +● running /.test(l))
  assert.ok(a, rows.join('\n'))
  assert.equal(a.length, W)
  assert.match(a, / {3}reading the spec, then the tests/)
  assert.ok(!a.includes('first'), 'the later note replaced it')
  assert.ok(!a.endsWith(note), 'cut to the width')
  assert.ok(
    rows.some((l) => /^ +2 +impl:b +\? needs you /.test(l)),
    rows.join('\n'),
  )
  assert.equal(view.model.alert, 'NEEDS YOU: [Implement] impl:b in tab term_fake2: Log in to npm')
})
