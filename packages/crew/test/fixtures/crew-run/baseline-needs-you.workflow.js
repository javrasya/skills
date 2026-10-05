export const meta = { name: 'crew-run-baseline-needs-you', description: "the template's Explore in small: a baseline that cannot run a command says it needs you beside an explorer, and dispatch waits on its submit", phases: [{ title: 'Explore' }, { title: 'Implement' }] }

phase('Explore')
const schema = { type: 'object', required: ['command', 'exit_code'], properties: { command: { type: 'string' }, exit_code: { type: 'integer' } } }
const [baseline, note] = await parallel([
  () =>
    agent('Measure the per-change commands at the pinned base. [call needs_you {"reason":"npm is not installed — evidence: npm test: command not found (exit 127); check: `npm --version`"}]', {
      label: 'baseline:per-change',
      node: 'baseline/per-change',
      isolation: 'worktree',
      schema,
      harness: 'pi',
    }),
  () => agent('Research the code paths. [answer notes]', { label: 'explore:code paths', node: 'explore/code-paths' }),
])
phase('Implement')
const sized = await agent('Size the ticket. [answer one slice]', { label: 'dispatch:#101', node: 'dispatch/101' })
return { measured: baseline, note, sized }
