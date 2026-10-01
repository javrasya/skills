export const meta = { name: 'crew-chain-fixture', description: 'a sequential run: its code agents one after another in the chain worktree, a doctor in its own', phases: [{ title: 'Chain' }] }

// The fake harness (fixtures/crew/fake-harness.mjs) submits the text of its
// [answer], dies on [die], and as a doctor hands off the text of [cure].
phase('Chain')
const first = await agent('Say the first word. [answer hello]', { label: 'first', isolation: 'chain' })
const patient = await agent('Fall over once. [die] [cure the note carried it on]', { label: 'patient', isolation: 'chain' })
return { first, patient }
