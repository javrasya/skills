// Offline tests for the Orca runner's tracer: submit and one agent() round
// trip, with the fake Orca standing in for the CLI adapter.
//   node scripts/test-orca-runner.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { submit } from '../skills/engineering/implement-spec-in-workflow/orca/submit.mjs'
import { runScript, SUBMIT } from '../skills/engineering/implement-spec-in-workflow/orca/runner.mjs'
import { fakeOrca } from '../skills/engineering/implement-spec-in-workflow/orca/fake-orca.mjs'

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
  const result = await runScript(SCRIPT, { orca, stateDir: tmp(), out: (s) => lines.push(s), pollMs: 1 })
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
  const result = await runScript(SCRIPT, { orca, stateDir: tmp(), out: (s) => lines.push(s), pollMs: 1 })
  assert.deepEqual(result, { r: null })
  assert.ok(lines.some((l) => l.includes('recorded result fails its schema') && l.includes('$.count: expected integer, got string')), lines.join('\n'))
})

test('agent(): a schema no result can satisfy throws before any worker starts', async () => {
  const orca = fakeOrca()
  const script = `return await agent('x', { schema: { type: 'object', required: ['a'], properties: {} } })`
  await assert.rejects(runScript(script, { orca, stateDir: tmp(), out: () => {} }), /requires properties it does not define: a/)
  assert.equal(orca.calls.length, 0)
})
