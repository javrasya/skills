// Offline tests for what a harness's own events say about a person being
// waited on (waiting.mjs): Claude's hook payloads and pi's extension events.
// The fixtures are real ones, recorded from a Claude Code session asked to run
// a command it needed permission for, and from a pi session that started on
// an unapproved project MCP server; ids and paths stripped.
//   node packages/crew/test/test-waiting.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { claudeWaiting, piWaiting } from '../src/waiting.mjs'

const events = (name) =>
  readFileSync(new URL(`./fixtures/hooks/${name}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

test("claude: a permission prompt is waited on from its request, its notification keeps the request's words, and the tool running clears it", () => {
  const said = events('claude-permission').map((p) => [p.hook_event_name, claudeWaiting(p)])
  assert.deepEqual(said, [
    ['SessionStart', null],
    ['UserPromptSubmit', { waiting: null }],
    ['PreToolUse', { waiting: null }],
    ['PermissionRequest', { waiting: 'Claude asks permission to use Bash: touch hello-crew.txt' }],
    ['Notification', { waiting: 'Claude needs your permission', keep: true }],
    ['PostToolUse', { waiting: null }],
    ['Stop', { waiting: null }],
  ])
})

test("claude: its question tool, an MCP server's elicitation and an elicitation notification are waited on; an idle notification is not; a denial, a failed tool and an answered elicitation clear it", () => {
  const ask = claudeWaiting({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which branch?', options: [] }] } })
  assert.deepEqual(ask, { waiting: 'Claude asks you: Which branch?' })
  assert.deepEqual(claudeWaiting({ hook_event_name: 'Elicitation', mcp_server_name: 'slint', message: 'Pick a port' }), { waiting: 'slint asks: Pick a port' })
  assert.deepEqual(claudeWaiting({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'slint needs input' }), { waiting: 'slint needs input', keep: true })
  assert.equal(claudeWaiting({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), null)
  for (const hook_event_name of ['PermissionDenied', 'PostToolUseFailure', 'ElicitationResult']) assert.deepEqual(claudeWaiting({ hook_event_name }), { waiting: null }, hook_event_name)
  assert.equal(claudeWaiting({}), null)
})

test("pi: an extension's dialog is waited on, named by its title, until it ends; one with no title is named by its kind", () => {
  assert.deepEqual(events('pi-mcp-dialog').map(piWaiting), [{ waiting: 'pi asks: Allow project MCP server “slint”?' }, { waiting: null }])
  assert.deepEqual(piWaiting({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'custom' }), { waiting: 'pi shows a custom dialog' })
  assert.equal(piWaiting({ type: 'turn_start' }), null)
})
