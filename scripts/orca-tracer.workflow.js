// A one-agent workflow script for checking the Orca runner against a real
// Orca by hand; it spends one short agent session. From an Orca terminal:
//   orca terminal create --title "orca tracer" --command "node skills/engineering/implement-spec-in-workflow/orca/runner.mjs scripts/orca-tracer.workflow.js --state-dir <dir>; exit $LASTEXITCODE"
export const meta = { name: 'orca-tracer', description: 'one agent() with a schema, on a real Orca', phases: [{ title: 'Tracer' }] }

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['word', 'count'],
  properties: { word: { type: 'string', enum: ['hello'] }, count: { type: 'integer' } },
}

phase('Tracer')
log('starting one agent through Orca')
const r = await agent('This is a check of the result contract, not a task: do nothing else. Your result is word "hello" and count 3.', {
  label: 'tracer:hello',
  phase: 'Tracer',
  schema: SCHEMA,
})
log('the agent returned ' + JSON.stringify(r))
return { result: r }
