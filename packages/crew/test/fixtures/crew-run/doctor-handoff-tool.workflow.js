export const meta = { name: 'crew-doctor-handoff-tool', description: "a patient, its pi doctor, and the note it hands off with crew's handoff tool", phases: [{ title: 'Treat' }], roles: { recover: { harness: 'pi' } } }

// Its doctor is pi (fixtures/crew/fake-harness.mjs), which calls the handoff
// tool crew's extension registered once for each [cure]: the first note is
// the remedy, the second acts on nothing, and the patient carried on with the
// first submits it.
phase('Treat')
const patient = await agent('Fall over once. [die] [cure the note carried it on] [cure a second note]', { label: 'patient' })
return { patient }
