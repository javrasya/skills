export const meta = { name: 'crew-run-claude-needs-you', description: "a Claude agent posts a status note and says it needs you through crew's MCP server, idles past the nudge interval un-nudged, then submits through it", phases: [{ title: 'Ask' }] }

// Its agent is Claude (fixtures/crew/fake-harness.mjs), calling the tools of
// the MCP server its --mcp-config starts, in order, then idling: the test
// answers it in its session, past the runner's nudge grace, and that turn
// calls submit, first with a payload the daemon rejects, then repaired.
phase('Ask')
const schema = { type: 'object', required: ['word'], properties: { word: { type: 'string' } } }
const got = await agent('Ask the person. [call status {"note":"reading the spec"}] [call needs_you {"reason":"Log in to the registry"}]', { label: 'asker', schema, harness: 'claude' })
return { word: got.word }
