export const meta = { name: 'runner-contract-orca', description: 'the guarantees only the Orca runner makes, checked with cheap agents', phases: [{ title: 'Contract' }] }

// Orca-only guarantees, which scripts/runner-contract.workflow.js (byte-identical
// under both runners) cannot hold. The expected object and the agent-driven
// procedure: skills/engineering/implement-spec-in-workflow/orca/README.md.
// No Date.now(), Math.random() or argless new Date(): they break a resume's replay.

const EXPECTED = {
  returned: { word: 'hello', count: 3 },
}

const HELLO = {
  type: 'object',
  additionalProperties: false,
  required: ['word', 'count'],
  properties: { word: { type: 'string', enum: ['hello'] }, count: { type: 'integer' } },
}

const C = { phase: 'Contract', effort: 'low' }
const NOT_A_TASK = 'This is a check of the workflow runner, not a task: read no files and run nothing except what returning your result needs.'

const canon = (v) =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  : v
const failures = []
const expect = (what, got) => {
  if (JSON.stringify(canon(got)) !== JSON.stringify(canon(EXPECTED[what]))) failures.push(`${what}: expected ${JSON.stringify(EXPECTED[what])}, got ${JSON.stringify(got)}`)
  return canon(got)
}

// Outside parallel(), which turns a throw into null and would hide it.
const awaited = async (what, call) => {
  let r
  try {
    r = { value: await call() }
  } catch (e) {
    r = { threw: String(e?.message ?? e) }
  }
  if (r.threw) failures.push(`${what}: agent() threw (${r.threw})`)
  log(`${what} returned ` + JSON.stringify(r))
  return r.threw ? '<threw>' : r.value
}

phase('Contract')

const returned = await awaited('orca-contract:returned', () => agent(
  `${NOT_A_TASK} Your result is word "hello" and count 3.`,
  { ...C, label: 'orca-contract:returned', schema: HELLO },
))

const result = {
  returned: expect('returned', returned),
}
for (const f of failures) log('FAIL ' + f)
log(failures.length ? `${failures.length} contract failure(s)` : 'contract holds')
return { ...result, failures }
