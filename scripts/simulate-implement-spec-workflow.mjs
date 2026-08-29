// Simulates the rendered workflow script with stubbed agent() calls, driving
// it through the paths the dispatcher redesign added.
import { readFileSync } from 'fs'

const TPL = new URL('../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url).pathname

function render() {
  let s = readFileSync(TPL, 'utf8')
  s = s
    .replace(/__SPEC__/g, '224')
    .replace(/__REPO__/g, 'o/r')
    .replace(/__REPO_DIR__/g, '/tmp/x')
    .replace(/__NOTES_DIR__/g, '/tmp/n')
    .replace(/__BASE_REF__/g, 'main')
    .replace(/__STACK_MODE__/g, 'native')
    .replace(/^export const meta/m, 'const meta')
  return s
}

// A stubbed fixer answers from the findings its prompt actually names, so a
// finding the script fails to route into a slice brief comes back with no
// verdict — which is exactly what the reconciliation is there to catch.
const ISSUES = new Map()
function locationsIn(prompt) {
  const out = []
  for (const m of prompt.matchAll(/^- (?:\[\w+\] )?([\w./]+:\d+) \u2014 ([^\n\u2192]+?)(?: \u2192 |$)/gm)) {
    out.push(m[1])
    ISSUES.set(m[1], m[2].trim())
  }
  return out
}
const issueFor = (loc) => ISSUES.get(loc) || '?'

async function run(overrides = {}) {
  const calls = []
  const defaults = {
    graph: () => ({
      tickets: [
        { number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 11, title: 'T11', blocked_by: [10], needs_human: false, human_reason: '' },
      ],
      start_ref: 'main',
      explorations: [{ label: 'area-a', question: 'q?' }],
    }),
    explore: () => '/tmp/n/01-area-a.md',
    dispatch: () => ({ ticket_brief: 'the ticket in brief', slices: [{ title: 'all of it', brief: 'do it', effort: 'medium' }] }),
    impl: (label) => ({ branch: 'ticket/' + label.match(/#(\d+)/)[1], summary: 's', tests_run: 'npm t', tests_green: true, unmet: [] }),
    gate: () => ({ findings: [] }),
    // The fix dispatcher sees the findings in its prompt; by default it puts
    // all of them in one slice, which is the verdict it is biased towards.
    fixdispatch: (label, prompt) => ({ slices: [{ title: 'all the findings', brief: 'fix them', findings: locationsIn(prompt), effort: 'medium' }] }),
    fixslice: (label, prompt) => ({ verdicts: locationsIn(prompt).map((l) => ({ location: l, issue: issueFor(l), action: 'fixed', reason: 'fixed it' })), unfinished: [] }),
    publish: (label) => { const n = label.match(/#(\d+)/)[1]; return { published: true, pr_url: 'https://pr/' + n, pr_number: 100 + Number(n), conflicts_resolved: [], note: '' } },
    review: () => ({ findings: [] }),
    integration: () => ({ pr_url: 'https://pr/int', pr_number: 999, branch: 'spec/224-integration' }),
    finalize: () => 'stack registered, 2 PRs ready, 0 worktrees',
  }
  const h = { ...defaults, ...overrides }

  function route(label) {
    if (label.startsWith('graph')) return 'graph'
    if (label.startsWith('explore')) return 'explore'
    if (label.startsWith('dispatch')) return 'dispatch'
    if (label.startsWith('impl')) return 'impl'
    if (label.endsWith(':dispatch')) return 'fixdispatch'
    if (label.startsWith('gate-fix') || label.startsWith('integration')) return 'fixslice'
    if (label.startsWith('gate')) return 'gate'
    if (label === 'publish:integration') return 'integration'
    if (label.startsWith('publish')) return 'publish'
    if (label.startsWith('review')) return 'review'
    if (label === 'finalize') return 'finalize'
    throw new Error('unrouted label: ' + label)
  }

  const agent = async (prompt, opts = {}) => {
    const label = opts.label || '?'
    calls.push({ label, effort: opts.effort || '(inherit)', prompt, opts })
    return h[route(label)](label, prompt, opts)
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const logs = []
  const log = (m) => logs.push(m)
  const phase = () => {}

  const fn = new Function('agent', 'parallel', 'phase', 'log', 'return (async () => {' + render() + '\n})()')
  const result = await fn(agent, parallel, phase, log)
  return { result, calls, logs }
}

const checks = []
function check(name, cond, detail) { checks.push({ name, ok: !!cond, detail }); if (!cond) process.exitCode = 1 }

// --- scenario A: happy path -------------------------------------------------
{
  const { result, calls } = await run()
  const seq = calls.map((c) => c.label)
  check('A: dispatcher runs once per ticket', seq.filter((l) => l.startsWith('dispatch')).length === 2, seq.join(' | '))
  check('A: implementer is told NOT to read the issue', calls.find((c) => c.label === 'impl:#10').prompt.includes('run no `gh issue view`'), '')
  check('A: publish order respects the dependency', seq.indexOf('publish:#10') < seq.indexOf('publish:#11'), '')
  check('A: #11 cut from #10 branch (tip moved)', calls.find((c) => c.label === 'impl:#11').prompt.includes('origin/ticket/10'), '')
  check('A: complete state', result.state.startsWith('complete'), result.state)
  check('A: no unmet', result.unmet.length === 0, JSON.stringify(result.unmet))
  check('A: explore effort low / dispatch high / publish low', calls.find((c) => c.label.startsWith('explore')).effort === 'low' && calls.find((c) => c.label === 'dispatch:#10').effort === 'high' && calls.find((c) => c.label === 'publish:#10').effort === 'low', '')
  check('A: slice effort taken from dispatcher verdict', calls.find((c) => c.label === 'impl:#10').effort === 'medium', '')
}

// --- scenario B: slice bails, re-dispatch finishes --------------------------
{
  let implCalls = 0
  const { result, calls } = await run({
    dispatch: (label) => label.includes(':re')
      ? { ticket_brief: 'b', slices: [{ title: 'remainder', brief: 'finish it', effort: 'high' }] }
      : { ticket_brief: 'b', slices: [{ title: 'part 1', brief: 'x', effort: 'medium' }, { title: 'part 2', brief: 'y', effort: 'medium' }] },
    impl: (label) => {
      implCalls++
      const n = label.match(/#(\d+)/)[1]
      if (label.startsWith('impl:#10') && !label.includes(':r') && label.includes(':s1'))
        return { branch: 'ticket/10', summary: 'partial', tests_run: 'npm t', tests_green: true, unmet: ['criterion Z'] }
      return { branch: 'ticket/' + n, summary: 'done', tests_run: 'npm t', tests_green: true, unmet: [] }
    },
  })
  const seq = calls.map((c) => c.label)
  check('B: bailed slice aborts the round (part 2 never runs pre-redispatch)', !seq.includes('impl:#10:s2'), seq.join(' | '))
  check('B: re-dispatch happens with remainder', seq.includes('dispatch:#10:re'), seq.join(' | '))
  check('B: re-dispatch prompt names the remainder and not-started slice', calls.find((c) => c.label === 'dispatch:#10:re').prompt.includes('criterion Z') && calls.find((c) => c.label === 'dispatch:#10:re').prompt.includes('not started: part 2'), '')
  check('B: continuation slice starts from origin/ticket/10', calls.find((c) => c.label === 'impl:#10:r2').prompt.includes('origin/ticket/10'), '')
  check('B: remainder slice gets dispatcher effort high', calls.find((c) => c.label === 'impl:#10:r2').effort === 'high', '')
  check('B: run completes with no unmet', result.unmet.length === 0 && result.state.startsWith('complete'), result.state)
}

// --- scenario C: remainder survives every dispatch round --------------------
{
  const { result, calls } = await run({
    graph: () => ({ tickets: [{ number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' }], start_ref: 'main', explorations: [] }),
    impl: () => ({ branch: 'ticket/10', summary: 'partial', tests_run: 'npm t', tests_green: true, unmet: ['criterion Z'] }),
  })
  const rounds = calls.filter((c) => c.label.startsWith('impl:#10')).length
  check('C: exactly MAX_DISPATCH_ROUNDS slice rounds', rounds === 3, String(rounds))
  check('C: unmet carried to the result', result.unmet.length === 1 && result.unmet[0].criteria.includes('criterion Z'), JSON.stringify(result.unmet))
  check('C: run is partial, spec stays open', result.state.startsWith('partial'), result.state)
  check('C: gate reviewer told not to re-litigate declared unmet', calls.find((c) => c.label === 'gate:#10:r1').prompt.includes('already declared these criteria unmet'), '')
  check('C: finalize told what remains', calls.find((c) => c.label === 'finalize').prompt.includes('unmet criteria: criterion Z'), '')
}

// --- scenario D: every gate fix goes through the dispatcher -----------------
{
  let gateRound = 0
  const { result, calls } = await run({
    graph: () => ({ tickets: [{ number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' }], start_ref: 'main', explorations: [] }),
    gate: () => (++gateRound === 1
      ? { findings: [{ severity: 'blocker', location: 'a.js:1', issue: 'bug', fix: 'fix it' }, { severity: 'major', location: 'b.js:2', issue: 'other bug', fix: 'fix that' }] }
      : { findings: [] }),
    fixdispatch: (label, prompt) => ({ slices: [
      { title: 'a', brief: 'fix a: a.js:1 — bug', findings: ['a.js:1'], effort: 'medium' },
      { title: 'b', brief: 'fix b: b.js:2 — other bug', findings: ['b.js:2'], effort: 'high' },
    ] }),
    fixslice: (label) => label.endsWith(':s1')
      ? { verdicts: [{ location: 'a.js:1', issue: 'bug', action: 'fixed', reason: 'done' }], unfinished: [] }
      : { verdicts: [{ location: 'b.js:2', issue: 'other bug', action: 'rejected', reason: 'b.js:2 is generated code' }], unfinished: [] },
  })
  const seq = calls.map((c) => c.label)
  check('D: no monolithic fixer — the batch is dispatched first', seq.includes('gate-fix:#10:r1:dispatch'), seq.join(' | '))
  check('D: fix dispatcher runs at medium effort', calls.find((c) => c.label === 'gate-fix:#10:r1:dispatch').effort === 'medium', '')
  check('D: dispatcher precedes every fix slice', seq.indexOf('gate-fix:#10:r1:dispatch') < seq.indexOf('gate-fix:#10:r1:s1'), seq.join(' | '))
  check('D: one agent per slice, effort from the dispatcher', calls.find((c) => c.label === 'gate-fix:#10:r1:s1').effort === 'medium' && calls.find((c) => c.label === 'gate-fix:#10:r1:s2').effort === 'high', '')
  check('D: fix agents run in the Gate phase, not Implement', calls.filter((c) => c.label.startsWith('gate-fix')).every((c) => c.opts.phase === 'Gate'), JSON.stringify(calls.filter((c) => c.label.startsWith('gate-fix')).map((c) => c.opts.phase)))
  check('D: dispatcher got the ticket brief, not the issue', calls.find((c) => c.label === 'gate-fix:#10:r1:dispatch').prompt.includes('the ticket in brief'), '')
  check('D: slice fixer reads only its brief', calls.find((c) => c.label === 'gate-fix:#10:r1:s1').prompt.includes('run no `gh issue view`'), '')
  check('D: rejection reaches the next reviewer', calls.find((c) => c.label === 'gate:#10:r2').prompt.includes('b.js:2 is generated code'), '')
  check('D: gate converges', gateRound === 2 && result.gate_unfixed.length === 0, '')
}

// --- scenario E: a dropped finding is reconciled, not assumed fixed ---------
{
  let gateRound = 0
  const { result, calls, logs } = await run({
    graph: () => ({ tickets: [{ number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' }], start_ref: 'main', explorations: [] }),
    gate: () => (++gateRound === 1
      ? { findings: [{ severity: 'blocker', location: 'a.js:1', issue: 'bug', fix: 'fix it' }, { severity: 'blocker', location: 'b.js:2', issue: 'dropped one', fix: 'fix that' }] }
      : { findings: [] }),
    // The dispatcher silently drops b.js:2 — the failure the script must catch.
    fixdispatch: () => ({ slices: [{ title: 'a only', brief: 'fix a.js:1 — bug', findings: ['a.js:1'], effort: 'medium' }] }),
    fixslice: () => ({ verdicts: [{ location: 'a.js:1', issue: 'bug', action: 'fixed', reason: 'done' }], unfinished: [] }),
  })
  check('E: the dropped finding is logged, not silently lost', logs.some((l) => l.includes('no verdict')), logs.join(' | '))
  check('E: the next reviewer is told to check it explicitly', calls.find((c) => c.label === 'gate:#10:r2').prompt.includes('never reported back') && calls.find((c) => c.label === 'gate:#10:r2').prompt.includes('b.js:2'), '')
  check('E: a fixed finding is NOT re-listed as unverified', !calls.find((c) => c.label === 'gate:#10:r2').prompt.includes('a.js:1'), '')
  check('E: a clean re-review still closes the gate', gateRound === 2 && result.gate_unfixed.length === 0, '')
}

// --- scenario F: the whole-stack review routes through the dispatcher too ---
{
  const { result, calls } = await run({
    review: () => ({ findings: [{ severity: 'major', location: 'c.js:3', issue: 'two helpers', fix: 'merge them' }] }),
  })
  const seq = calls.map((c) => c.label)
  check('F: integration fixes are dispatched', seq.includes('integration:dispatch'), seq.join(' | '))
  check('F: integration slices run in the Review phase', calls.filter((c) => c.label.startsWith('integration')).every((c) => c.opts.phase === 'Review'), '')
  check('F: first integration slice cuts from the stack tip', calls.find((c) => c.label === 'integration').prompt.includes('origin/ticket/11'), calls.find((c) => c.label === 'integration').prompt)
  check('F: a separate low-effort agent opens the PR', calls.find((c) => c.label === 'publish:integration') && calls.find((c) => c.label === 'publish:integration').effort === 'low', seq.join(' | '))
  check('F: the publisher is told to change no code', calls.find((c) => c.label === 'publish:integration').prompt.includes('Change no code'), '')
  check('F: the publisher runs after the fixes', seq.indexOf('integration') < seq.indexOf('publish:integration'), seq.join(' | '))
  check('F: integration PR becomes the stack top', result.stack_bottom_to_top.some((l) => l.startsWith('integration')), JSON.stringify(result.stack_bottom_to_top))
}

// --- scenario G: no fix lands, so no integration PR is opened ---------------
{
  const { result, calls } = await run({
    review: () => ({ findings: [{ severity: 'major', location: 'c.js:3', issue: 'two helpers', fix: 'merge them' }] }),
    fixslice: () => null,
  })
  const seq = calls.map((c) => c.label)
  check('G: nothing landed, so no PR is opened', !seq.includes('publish:integration'), seq.join(' | '))
  check('G: the finding is reported unfixed', result.integration_unfixed.length > 0, JSON.stringify(result.integration_unfixed))
  check('G: no integration PR in the stack', !result.stack_bottom_to_top.some((l) => l.startsWith('integration')), JSON.stringify(result.stack_bottom_to_top))
}

for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '   [' + c.detail + ']'))
console.log(checks.every((c) => c.ok) ? '\nALL PASS (' + checks.length + ' checks)' : '\nFAILURES PRESENT')
