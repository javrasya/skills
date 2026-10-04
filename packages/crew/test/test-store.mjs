// The daemon's store contract (src/daemon/store.mjs), run against the file
// store, the only one: what is written reads back and lists, from a store
// opened on the same place again, and through a daemon that stops and starts.
//   node packages/crew/test/test-store.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crewPaths } from '../src/daemon/transport.mjs'
import { request } from '../src/daemon/client.mjs'
import { startDaemon } from '../src/daemon/daemon.mjs'
import { fileStore } from '../src/daemon/store.mjs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(what, check, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

// A stand-in for a pty session: its program runs until killed.
function fakeSession({ id, command, cwd, env, title = null }) {
  let exit = null
  const exits = new Set()
  return {
    id,
    env,
    info: () => ({ id, title, command, cwd, pid: 1, cols: 80, rows: 24, alive: exit === null, exit, quietMs: null }),
    onExit: (watch) => exits.add(watch),
    kill() {
      if (exit) return
      exit = { code: 0, signal: null }
      for (const watch of exits) watch(exit)
    },
    write() {},
    rename() {},
    resize() {},
  }
}

// The contract every store keeps: `place` names a new place none wrote,
// `open(at)` opens a store on it, and again on the same place each call.
function storeContract(name, place, openAt) {
  const records = {
    runs: [['run_1', { id: 'run_1', objective: 'a run', coordinator: 'c1', runner: '1', pending: [], batch: null, acked: ['delivery_1'] }]],
    dispatches: [
      ['2', { id: '2', run: 'run_1', taskId: 'task_a', capability: 'cap_a', settled: true, outcome: 'succeeded', released: false }],
      ['3', { id: '3', run: 'run_1', taskId: 'task_b', capability: 'cap_b', settled: false, outcome: null, released: false }],
    ],
    statuses: [['/work/tree', 'in-review']],
    sessions: [['2', { command: ['claude'], cwd: '/work', title: 'impl' }]],
    meta: [
      ['messages', 4],
      ['nextSession', 5],
      ['running', ['2']],
    ],
  }

  test(`${name}: an empty store lists nothing and reads nothing`, () => {
    const at = place()
    const open = () => openAt(at)
    const store = open()
    for (const kind of Object.keys(records)) assert.deepEqual(store.list(kind), [], kind)
    assert.equal(store.read('dispatches', '2'), null)
  })

  test(`${name}: what is written reads back and lists, and again from the store opened anew`, () => {
    const at = place()
    const open = () => openAt(at)
    const first = open()
    first.write(records)
    for (const store of [first, open()]) {
      for (const [kind, entries] of Object.entries(records)) {
        assert.deepEqual(store.list(kind), entries, `${kind} lists as written`)
        for (const [key, record] of entries) assert.deepEqual(store.read(kind, key), record, `${kind} ${key} reads back`)
      }
      assert.equal(store.read('dispatches', '9'), null, 'a record never written reads as none')
    }
  })

  test(`${name}: a kind written replaces its records, and a kind not named keeps its own`, () => {
    const at = place()
    const open = () => openAt(at)
    open().write(records)
    open().write({ dispatches: [records.dispatches[1]] })
    const store = open()
    assert.deepEqual(store.list('dispatches'), [records.dispatches[1]])
    assert.equal(store.read('dispatches', '2'), null)
    assert.deepEqual(store.list('runs'), records.runs)
    assert.deepEqual(store.list('meta'), records.meta)
  })

  test(`${name}: a kind of record it does not keep is refused`, () => {
    const at = place()
    const open = () => openAt(at)
    const store = open()
    assert.throws(() => store.list('jobs'), /not a kind of record the daemon keeps/)
    assert.throws(() => store.write({ jobs: [] }), /not a kind of record the daemon keeps/)
  })
}

storeContract(
  'file store',
  () => join(mkdtempSync(join(tmpdir(), 'crew-store-')), 'runs.json'),
  (file) => fileStore(file),
)

test('file store: runs.json keeps the shape it has always had', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'crew-store-')), 'runs.json')
  fileStore(file).write({
    runs: [['run_1', { id: 'run_1', acked: [] }]],
    dispatches: [['2', { id: '2', run: 'run_1' }]],
    statuses: [['/w', 'todo']],
    sessions: [['2', { command: ['claude'], cwd: '/w', title: null }]],
    meta: [
      ['messages', 1],
      ['deliveries', 0],
      ['nextSession', 3],
      ['running', ['2']],
    ],
  })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    runs: [{ id: 'run_1', acked: [] }],
    dispatches: [{ id: '2', run: 'run_1' }],
    statuses: { '/w': 'todo' },
    sessions: { 2: { command: ['claude'], cwd: '/w', title: null } },
    messages: 1,
    deliveries: 0,
    nextSession: 3,
    running: ['2'],
  })
  assert.ok(!existsSync(`${file}.tmp`), 'written by a rename')
})

test('file store: a book that does not parse opens as no records', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'crew-store-')), 'runs.json')
  writeFileSync(file, '{ not json')
  assert.deepEqual(fileStore(file).list('runs'), [])
})

test("daemon: its records are the file store's at the crew home's runs.json, and survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-store-'))
  const paths = crewPaths({ CREW_HOME: join(dir, 'home') })
  const registry = join(dir, 'orca-runs.jsonl')
  const exits = []
  const first = await startDaemon({ paths, registry, spawnSession: fakeSession, exit: () => exits.push(1), log: () => {} })
  const { run } = await request(paths, { op: 'run.create', objective: 'a workflow run', coordinator: 'c1' })
  const session = (await request(paths, { op: 'session.spawn', command: ['claude'], cwd: dir })).session.id
  const { worker } = await request(paths, { op: 'run.worker', run: run.id, session, coordinator: 'c1' })
  await request(paths, { op: 'mail.send', taskId: worker.taskId, dispatchId: session, type: 'worker_done', outcome: 'failed' })
  await request(paths, { op: 'worktree.status', path: dir, status: 'in-review' })

  assert.equal(paths.runs, join(paths.home, 'runs.json'))
  const kept = fileStore(paths.runs)
  assert.deepEqual(
    kept.list('runs').map(([id]) => id),
    [run.id],
  )
  assert.equal(kept.read('dispatches', session).taskId, worker.taskId)
  assert.equal(kept.read('statuses', dir), 'in-review')

  first.shutdown('test over')
  await until('the first daemon to stop', () => exits.length === 1)
  const second = await startDaemon({ paths, registry, spawnSession: fakeSession, exit: () => {}, log: () => {} })
  try {
    await second.recovered
    const shown = (await request(paths, { op: 'worker.show', id: session })).worker
    assert.equal(shown.settled, true)
    assert.equal(shown.outcome, 'failed')
    assert.deepEqual((await request(paths, { op: 'worktree.statuses' })).statuses, { [dir]: 'in-review' })
    assert.equal((await request(paths, { op: 'run.use', id: run.id, coordinator: 'c2' })).run.coordinator, 'c2')
    const checked = await request(paths, { op: 'mail.check', coordinator: 'c2' })
    assert.deepEqual(
      checked.messages.map((m) => [m.type, m.dispatchId, m.outcome]),
      [['worker_done', session, 'failed']],
    )
    const next = (await request(paths, { op: 'session.spawn', command: ['claude'], cwd: dir })).session.id
    assert.ok(Number(next) > Number(session), 'a session id is never handed out twice')
  } finally {
    second.shutdown('test over')
  }
})
