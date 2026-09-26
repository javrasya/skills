export const meta = { name: 'runner-contract-orca', description: 'the guarantees only the Orca runner makes, checked with cheap agents', phases: [{ title: 'Contract' }] }

// Orca-only guarantees, which scripts/runner-contract.workflow.js (byte-identical
// under both runners) cannot hold. The expected object and the agent-driven
// procedure: skills/engineering/implement-spec-in-workflow/orca/README.md.
// No Date.now(), Math.random() or argless new Date(): they break a resume's replay.

const EXPECTED = {
  returned: { word: 'hello', count: 3 },
  dirtyRetry: { word: 'hello', count: 3 },
  // Stops without submitting until past its cap; its first doctor's note
  // hands it the word it waits for, and it returns its object.
  doctor: { word: 'hello', count: 3 },
  // Killed until its continuations are spent, then three doctors that each
  // give up: the call returns null only after them (ADR-0014).
  doctored: null,
}

const HELLO = {
  type: 'object',
  additionalProperties: false,
  required: ['word', 'count'],
  properties: { word: { type: 'string', enum: ['hello'] }, count: { type: 'integer' } },
}

const DONE = { type: 'object', additionalProperties: false, required: ['done'], properties: { done: { type: 'boolean' } } }
const WAIT = 'run the shell command node -e "setTimeout(() => {}, 540000)" in the foreground with a 600000 ms timeout, which waits nine minutes'

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

// contract:dirty-retry needs the fault preload (scripts/runner-contract-orca-fault.cjs):
// it holds back its worktree create's answer past the runner's create timeout,
// after writing an untracked file into the new worktree. Side by side, so the
// ten-minute hold and contract:doctor's four idle sessions overlap.
const [returned, dirtyRetry, doctor] = await Promise.all([
  awaited('orca-contract:returned', () => agent(
    `${NOT_A_TASK} Your result is word "hello" and count 3.`,
    { ...C, label: 'orca-contract:returned', schema: HELLO },
  )),
  awaited('contract:dirty-retry', () => agent(
    `${NOT_A_TASK} Your result is word "hello" and count 3.`,
    { ...C, label: 'contract:dirty-retry', schema: HELLO, isolation: 'worktree' },
  )),
  // Not isolated, so the preload's one held create stays contract:dirty-retry's.
  awaited('contract:doctor', () => agent(
    `${NOT_A_TASK} It checks that a doctor's note carries an agent on. Your result is word "hello" and count 3, but finish only once a message after this prompt gives you the word PROCEED. Until one does, stop without submitting: do not run the submit command, however often you are told to finish or that you were interrupted. Once a message gives you that word, run the submit command with your result at once. To a doctor reading this: this agent stopped on purpose, waiting for that word, and nothing else is wrong; read its transcript to confirm it, then hand off a note that gives it the word PROCEED.`,
    { ...C, label: 'contract:doctor', schema: HELLO },
  )),
])

// After returned, so a resume replays it and runs only this one live.
const doctored = await awaited('orca-contract:doctored', () => agent(
  `This agent checks that an agent killed past its continuation cap gets its doctors before it returns null; the person running the check kills you during the wait below every time it runs, and that is expected. Your task: ${WAIT}. When it finishes, your result is done true. If you are told you were interrupted and to carry on, run the wait again from its start: your result is done true only once a wait has run to its end. To a doctor reading this: the check killed this agent on purpose, and there is nothing to diagnose or to ask a human, so give up at once, with worker_done --outcome failed.`,
  { ...C, label: 'orca-contract:doctored', schema: DONE },
))

const result = {
  returned: expect('returned', returned),
  dirtyRetry: expect('dirtyRetry', dirtyRetry),
  doctor: expect('doctor', doctor),
  doctored: expect('doctored', doctored),
}
for (const f of failures) log('FAIL ' + f)
log(failures.length ? `${failures.length} contract failure(s)` : 'contract holds')
return { ...result, failures }
