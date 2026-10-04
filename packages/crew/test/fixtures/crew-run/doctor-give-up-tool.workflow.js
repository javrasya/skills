export const meta = { name: 'crew-doctor-give-up-tool', description: "a patient, and its pi doctor that gives up with crew's give_up tool", phases: [{ title: 'Treat' }], roles: { recover: { harness: 'pi' } } }

// Its doctor is pi (fixtures/crew/fake-harness.mjs), which calls the give_up
// tool crew's extension registered with the text of [give up]: its one round
// ends with no remedy, so the patient's agent() fails.
phase('Treat')
const patient = await agent('Fall over once. [die] [give up only a human can fix this]', { label: 'patient' })
return { patient }
