export const meta = { name: 'crew-doctor-fixture', description: 'a patient, its doctor, and the note that carries it on', phases: [{ title: 'Treat' }] }

// The fake harness (fixtures/crew/fake-harness.mjs) dies on [die]; its
// doctor hands off the text of [cure], and the patient carried on with that
// note submits the note.
phase('Treat')
const patient = await agent('Fall over once. [die] [cure the note carried it on]', { label: 'patient' })
return { patient }
