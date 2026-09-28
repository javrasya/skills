export const meta = { name: 'crew-run-slow', description: 'two fake-harness agents whose turns outlast a daemon killed under them', phases: [{ title: 'Greet' }] }

// Each agent's first turn takes 8 s (fixtures/crew/fake-harness.mjs's
// [turn]): long enough to kill the crew daemon while both are mid-turn.
phase('Greet')
const [first, second] = await parallel([
  () => agent('Say the first word. [turn 8000] [answer hello]', { label: 'first' }),
  () => agent('Say the second word. [turn 8000] [answer world]', { label: 'second' }),
])
return { first, second }
