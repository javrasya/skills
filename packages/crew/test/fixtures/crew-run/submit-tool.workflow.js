export const meta = { name: 'crew-run-submit-tool', description: "pi agents finish with crew's submit tool, one repairing a payload pi rejected", phases: [{ title: 'Submit' }] }

// Its agents are pi (fixtures/crew/fake-harness.mjs), which calls the tool
// crew's extension registered, once per [call]: the second agent's first
// payload lacks `word`, so pi rejects it in the turn, and its next is taken.
phase('Submit')
const schema = { type: 'object', required: ['word'], properties: { word: { type: 'string' } } }
const [first, second] = await parallel([
  () => agent('Submit the first word. [call submit {"word":"tool"}]', { label: 'caller', schema, harness: 'pi' }),
  () => agent('Submit the second word. [call submit {"wrd":"oops"}] [call submit {"word":"repaired"}]', { label: 'repairer', schema, harness: 'pi' }),
])
return { first: first.word, second: second.word }
