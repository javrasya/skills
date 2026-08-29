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
    gatefix: () => ({ verdicts: [], overflow: [] }),
    publish: (label) => { const n = label.match(/#(\d+)/)[1]; return { published: true, pr_url: 'https://pr/' + n, pr_number: 100 + Number(n), conflicts_resolved: [], note: '' } },
    review: () => ({ findings: [] }),
    integration: () => ({ pr_url: 'https://pr/int', pr_number: 999, branch: 'spec/224-integration', verdicts: [] }),
    finalize: () => 'stack registered, 2 PRs ready, 0 worktrees',
  }
  const h = { ...defaults, ...overrides }

  function route(label) {
    if (label.startsWith('graph')) return 'graph'
    if (label.startsWith('explore')) return 'explore'
    if (label.startsWith('dispatch')) return 'dispatch'
    if (label.startsWith('impl')) return 'impl'
    if (label.startsWith('gate-fix')) return label.includes(':d') ? 'impl' : 'gatefix'
    if (label.startsWith('gate')) return 'gate'
    if (label.startsWith('publish')) return 'publish'
    if (label.startsWith('review')) return 'review'
    if (label === 'integration') return 'integration'
    if (label === 'finalize') return 'finalize'
    throw new Error('unrouted label: ' + label)
  }

  const agent = async (prompt, opts = {}) => {
    const label = opts.label || '?'
    calls.push({ label, effort: opts.effort || '(inherit)', prompt })
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

// --- scenario D: gate fixer overflows to the dispatcher ---------------------
{
  let gateRound = 0
  const { result, calls } = await run({
    graph: () => ({ tickets: [{ number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' }], start_ref: 'main', explorations: [] }),
    gate: () => (++gateRound === 1
      ? { findings: [{ severity: 'blocker', location: 'a.js:1', issue: 'bug', fix: 'fix it' }] }
      : { findings: [] }),
    gatefix: () => ({ verdicts: [{ location: 'a.js:1', issue: 'bug', action: 'fixed', reason: 'small part fixed' }], overflow: ['a.js:1 — the large part'] }),
  })
  const seq = calls.map((c) => c.label)
  check('D: overflow re-dispatches', seq.includes('dispatch:#10:re'), seq.join(' | '))
  check('D: overflow slice agent runs under gate-fix tag', seq.some((l) => l.startsWith('gate-fix:#10:r1:d')), seq.join(' | '))
  check('D: fixer got the ticket brief, not the issue', calls.find((c) => c.label === 'gate-fix:#10:r1').prompt.includes('the ticket in brief'), '')
  check('D: gate converges next round', gateRound === 2 && result.gate_unfixed.length === 0, '')
}

for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '   [' + c.detail + ']'))
console.log(checks.every((c) => c.ok) ? '\nALL PASS (' + checks.length + ' checks)' : '\nFAILURES PRESENT')
