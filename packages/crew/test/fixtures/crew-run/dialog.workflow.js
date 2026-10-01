export const meta = { name: 'crew-run-dialog', description: 'a fake-harness agent whose harness asks to trust its folder first', phases: [{ title: 'Trust' }] }

// Run with CREW_FAKE_DIALOG=trust, its harness (fixtures/crew/fake-harness.mjs)
// first asks whether to trust its folder; once the person answers, it gets
// its prompt and submits the text of its [answer].
phase('Trust')
const word = await agent('Say the word. [answer trusted]', { label: 'asker' })
return { word }
