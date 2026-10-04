export const meta = { name: 'crew-run-needs-you', description: 'a pi agent posts a status note, says it needs you, idles past the nudge interval un-nudged, then submits', phases: [{ title: 'Ask' }] }

// Its agent is pi (fixtures/crew/fake-harness.mjs), calling the tools crew's
// extension registered, in order, then idling: the test answers it in its
// session, past the runner's nudge grace, and that turn submits.
phase('Ask')
const schema = { type: 'object', required: ['word'], properties: { word: { type: 'string' } } }
const got = await agent('Ask the person. [call status {"note":"reading the spec"}] [call needs_you {"reason":"Log in to the registry"}]', { label: 'asker', schema, harness: 'pi' })
return { word: got.word }
