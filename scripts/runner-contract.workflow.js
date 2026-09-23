export const meta = { name: 'runner-contract', description: 'the guarantees the implement-spec script takes from its runner, checked with cheap agents', phases: [{ title: 'Contract' }] }

// The runner contract test (ADR-0011): run it under the Workflow runner and
// under the Orca runner, then resume each run; all four must return EXPECTED.
// How to run it, and the one hand step (killing contract:kill), is in
// skills/engineering/implement-spec-in-workflow/orca/README.md.
//
// Byte-identical under both runners: no Date.now(), Math.random() or argless
// new Date() (the Workflow runner throws on them, and they would break resume),
// and no prompt names a runner's own result mechanism.

const EXPECTED = {
  valid: { word: 'hello', count: 3 },
  repaired: { count: 3, first_attempt_rejected: true },
  thrown: [null, null],
  killed: null,
}

const HELLO = {
  type: 'object',
  additionalProperties: false,
  required: ['word', 'count'],
  properties: { word: { type: 'string', enum: ['hello'] }, count: { type: 'integer' } },
}
const REPAIR = {
  type: 'object',
  additionalProperties: false,
  required: ['count', 'first_attempt_rejected'],
  properties: { count: { type: 'integer' }, first_attempt_rejected: { type: 'boolean' } },
}
const DONE = { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } }

const C = { phase: 'Contract', effort: 'low' }
const NOT_A_TASK = 'This is a check of the workflow runner, not a task: read no files and run nothing except what returning your result needs.'

// Key order is whatever the agent wrote; the comparison and the returned
// object must not depend on it.
const canon = (v) =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  : v
const failures = []
const expect = (what, got) => {
  const want = EXPECTED[what]
  if (JSON.stringify(canon(got)) !== JSON.stringify(canon(want))) failures.push(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  return canon(got)
}

phase('Contract')

let par
try {
  par = await parallel([
    () => agent(`${NOT_A_TASK} Your result is word "hello" and count 3.`, { ...C, label: 'contract:valid', schema: HELLO }),
    () => agent(
      `${NOT_A_TASK} It checks that a rejected result is repaired inside your turn. Your FIRST attempt to return your result must deliberately leave out a required field: return exactly {"count": 3}. It will be rejected with a validation error. Then return it again, correctly: {"count": 3, "first_attempt_rejected": true}.`,
      { ...C, label: 'contract:repair', schema: REPAIR },
    ),
    () => {
      throw new Error('contract: this thunk throws before returning a promise')
    },
    async () => {
      throw new Error('contract: this thunk returns a rejected promise')
    },
  ])
} catch (e) {
  failures.push(`parallel: rejected (${e?.message ?? e}); it must resolve with null in the throwing thunks' places`)
  par = [null, null, null, null]
}
log('parallel returned ' + JSON.stringify(par))

// Last, so a resume's unchanged prefix is the two calls above. Outside
// parallel(), which turns a throw into null and would hide an agent() that
// throws on a dead agent. The wait is bounded and the prompt asks for nothing
// an agent refuses: told to never return, a Workflow runner agent returns at
// once. A bare `sleep` is refused by some hosts' hooks.
let killed
try {
  killed = {
    value: await agent(
      'This agent checks that an agent killed mid-task returns null; the person running the check kills you during the wait below, and that is expected. Your task: run the shell command node -e "setTimeout(() => {}, 540000)" in the foreground with a 600000 ms timeout, which waits nine minutes. When it finishes, your result is done true.',
      { ...C, label: 'contract:kill', schema: DONE },
    ),
  }
} catch (e) {
  killed = { threw: String(e?.message ?? e) }
}
if (killed.threw) failures.push(`killed: agent() threw (${killed.threw}); a dead agent must return null`)
log('contract:kill returned ' + JSON.stringify(killed))

const result = {
  valid: expect('valid', par[0]),
  repaired: expect('repaired', par[1]),
  thrown: expect('thrown', [par[2], par[3]]),
  killed: expect('killed', killed.threw ? '<threw>' : killed.value),
}
for (const f of failures) log('FAIL ' + f)
log(failures.length ? `${failures.length} contract failure(s)` : 'contract holds')
return { ...result, failures }
