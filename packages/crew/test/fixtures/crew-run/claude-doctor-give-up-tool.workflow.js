export const meta = { name: 'crew-doctor-claude-give-up-tool', description: "a patient, and its Claude doctor that gives up with crew's give_up tool", phases: [{ title: 'Treat' }], roles: { recover: { harness: 'claude' } } }

// Its doctor is Claude (fixtures/crew/fake-harness.mjs), which calls the
// give_up tool of crew's MCP server with the text of [give up]: its one round
// ends with no remedy, so the patient's agent() fails.
phase('Treat')
const patient = await agent('Fall over once. [die] [give up only a human can fix this]', { label: 'patient' })
return { patient }
