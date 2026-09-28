export const meta = { name: 'crew-run-fixture', description: 'two fake-harness agents on the crew host', phases: [{ title: 'Greet' }] }

// A whole run under `crew run`, its agents the fake harness
// (fixtures/crew/fake-harness.mjs), which submits the text of its [answer].
phase('Greet')
const [first, second] = await parallel([
  () => agent('Say the first word. [answer hello]', { label: 'first' }),
  () => agent('Say the second word. [answer world]', { label: 'second' }),
])
return { first, second }
