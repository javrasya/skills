// Offline tests for reading a harness's screen before its first prompt
// (screens.mjs) and for the agent row a dialog puts in the journal's fold.
// The claude-*.txt fixtures are real Claude Code screens, as the crew daemon
// renders them, save claude-other-dialog.txt, a dialog crew does not know.
//   node packages/crew/test/test-screens.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { SCREENS, readScreen, readsReady } from '../src/screens.mjs'
import { foldJournal } from '../src/journal.mjs'

const screen = (name) => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8').split('\n')

test("claude: its input box is ready; its trust and MCP dialogs are named, each saying what the person must do; any other dialog is still one", () => {
  assert.deepEqual(readScreen('claude', screen('claude-ready')), { state: 'ready' })
  const trust = readScreen('claude', screen('claude-trust'))
  assert.deepEqual([trust.state, trust.dialog, trust.detail], ['dialog', 'workspace trust', 'Accessing workspace:'])
  assert.match(trust.ask, /trust this folder: enter the session and answer it/)
  const mcp = readScreen('claude', screen('claude-mcp'))
  assert.deepEqual([mcp.dialog, mcp.detail], ['MCP servers', 'New MCP server found in this project: slint'])
  const other = readScreen('claude', screen('claude-other-dialog'))
  assert.deepEqual([other.dialog, other.detail], ['a dialog', 'Something new Claude asks about'])
})

test('claude: a screen still loading, or one with no rule around its ❯, is not recognised; a dialog is never ready, even beside an input box', () => {
  assert.equal(readScreen('claude', []), null)
  assert.equal(readScreen('claude', ['', '  Loading…']), null)
  assert.equal(readScreen('claude', ['❯ No, exit', '  Yes']), null)
  assert.equal(readScreen('claude', [...screen('claude-ready'), ...screen('claude-trust')]).dialog, 'workspace trust')
})

test('readers: pi has no ready screen crew reads, so it is ready once quiet; an unknown harness has no reader; a reader is a table another CLI adds to', () => {
  assert.equal(readsReady('claude'), true)
  assert.equal(readsReady('pi'), false)
  assert.equal(readScreen('pi', screen('claude-trust')), null)
  assert.equal(readScreen('codex', screen('claude-trust')), null)
  const screens = { ...SCREENS, codex: { ready: (lines) => lines.includes('> '), dialogs: [{ name: 'sandbox', match: (text) => /Allow sandbox/.test(text), ask: 'codex asks about its sandbox' }] } }
  assert.deepEqual(readScreen('codex', ['> '], screens), { state: 'ready' })
  assert.equal(readScreen('codex', ['Allow sandbox?', '> '], screens).dialog, 'sandbox')
})

const at = new Date(0).toISOString()
const line = (type, rest = {}) => ({ type, at, key: 'k1', n: 1, title: '[Implement] impl:a', ...rest })
const agentOf = (entries) => foldJournal(entries).agents[0]

test('fold: a dialog makes a starting agent need you, in the session it answers it in; its going puts it back, and a retry or a start ends it too', () => {
  const asked = [line('starting', { run: 'run_1' }), line('dialog', { terminal: '7', dialog: 'workspace trust', ask: 'Claude asks whether to trust this folder: enter the session and answer it' })]
  let a = agentOf(asked)
  assert.deepEqual([a.state, a.terminal, a.reason], ['needs you', '7', 'Claude asks whether to trust this folder: enter the session and answer it'])
  // A second dialog after the first (MCP after trust) needs you still, and goes back to where the first began.
  const both = [...asked, line('dialogClosed'), line('dialog', { terminal: '7', dialog: 'MCP servers', ask: 'mcp' }), line('dialogClosed')]
  assert.equal(agentOf(both.slice(0, -1)).reason, 'mcp')
  a = agentOf(both)
  assert.deepEqual([a.state, a.reason, a.dialog], ['starting', null, null])
  a = agentOf([...asked, line('started', { run: 'run_1', dispatchId: '7', harness: 'claude', sessionId: 's', worktree: null, terminal: '7', dir: 'agents/1' })])
  assert.equal(a.state, 'running')
  a = agentOf([...asked, line('retry', { attempt: 2, reason: 'its worker did not start: it ended', nextAt: at }), line('dialogClosed')])
  assert.deepEqual([a.state, a.reason], ['starting', 'its worker did not start: it ended'], 'a dialog a retry ended is not closed again')
  // A continued session's dialog puts it back to continued.
  a = agentOf([...asked, line('dialogClosed'), line('started', { run: 'run_1', dispatchId: '7', harness: 'claude', sessionId: 's', worktree: null, terminal: '7', dir: 'agents/1' }),
    line('continued', { dispatchId: '8', sessionId: 's', terminal: '8', reason: 'it died', attempt: 1, reopened: true }), line('dialog', { terminal: '8', dialog: 'a dialog', ask: 'x' }), line('dialogClosed')])
  assert.equal(a.state, 'continued')
})
