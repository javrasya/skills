export const meta = { name: 'crew-run-resubmit-tool', description: "a node whose result needs decisions is held, and its agent submits again on its own with crew's submit tool", phases: [{ title: 'Decide' }] }

// Its agent is pi (fixtures/crew/fake-harness.mjs), which calls the submit
// tool crew's extension registered: first with decisions_needed: [<the
// [decide] question>], so the node is held; then, [resubmit] ms after the
// runner set that result aside, with its arguments alone, nobody pressing r.
phase('Decide')
const schema = { type: 'object', required: ['word'], properties: { word: { type: 'string' }, decisions_needed: { type: 'array', items: { type: 'string' } } } }
const answer = await agent('Pick the word. [call submit {"word":"carried"}] [decide Which word?] [resubmit 500]', { label: 'decider', schema, node: 'decide', harness: 'pi' })
return { word: answer.word }
