export const meta = { name: 'crew-run-resubmit', description: 'a node whose result needs decisions is held, and its agent submits again on its own', phases: [{ title: 'Decide' }] }

// Its harness (fixtures/crew/fake-harness.mjs) first submits its [answer]
// with decisions_needed: [<the [decide] question>], so the node is held; then,
// [resubmit] ms after the runner set that result aside, its [answer] alone,
// with nobody pressing r.
phase('Decide')
const schema = { type: 'object', required: ['word'], properties: { word: { type: 'string' }, decisions_needed: { type: 'array', items: { type: 'string' } } } }
const answer = await agent('Pick the word. [answer {"word":"carried"}] [decide Which word?] [resubmit 500]', { label: 'decider', schema, node: 'decide' })
return { word: answer.word }
