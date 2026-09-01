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
    layer0: () => ({ pr_url: 'https://pr/layer0', pr_number: 90 }),
    dispatch: () => ({ ticket_brief: 'the ticket in brief', slices: [{ title: 'all of it', brief: 'do it', effort: 'medium' }] }),
    impl: (label) => ({ branch: 'ticket/' + label.match(/#(\d+)/)[1], summary: 's', tests_run: 'npm t', tests_green: true, unmet: [] }),
    gate: () => ({ findings: [] }),
    // The fix dispatcher sees the findings in its prompt; by default it puts
    // all of them in one slice, which is the verdict it is biased towards.
    fixdispatch: (label, prompt) => ({ slices: [{ title: 'all the findings', brief: 'fix them', findings: locationsIn(prompt), effort: 'medium' }] }),
    fixslice: (label, prompt) => ({ verdicts: locationsIn(prompt).map((l) => ({ location: l, issue: issueFor(l), action: 'fixed', reason: 'fixed it' })), unfinished: [] }),
    // Honest about the link: it reports what its own prompt told it to. A stub
    // that always says "registered" would hide the script handing a one-layer
    // stack a link command it cannot run.
    publish: (label, prompt) => {
      const n = label.match(/#(\d+)/)[1]
      const stack_link = /gh stack link [a-z]/.test(prompt) ? 'registered' : /stack_link: "skipped"/.test(prompt) ? 'skipped' : 'disabled'
      return { published: true, pr_url: 'https://pr/' + n, pr_number: 100 + Number(n), conflicts_resolved: [], stack_link, note: '' }
    },
    review: () => ({ findings: [] }),
    integration: () => ({ pr_url: 'https://pr/int', pr_number: 999, branch: 'spec/224-integration' }),
    finalize: () => 'stack registered, 2 PRs ready, 0 worktrees',
  }
  const h = { ...defaults, ...overrides }

  function route(label) {
    if (label.startsWith('graph')) return 'graph'
    if (label.startsWith('explore')) return 'explore'
    if (label.startsWith('layer0')) return 'layer0'
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
  EVERY_CALL.push(...calls)
  return { result, calls, logs }
}

// Assertions that must hold of EVERY prompt the workflow can emit are checked
// against all scenarios at the bottom, not inside one — a prompt only rendered
// on some path (the integration fix dispatcher, say) is exactly where a
// template hole hides.
const EVERY_CALL = []
const checks = []
function check(name, cond, detail) { checks.push({ name, ok: !!cond, detail }); if (!cond) process.exitCode = 1 }

// --- scenario A: happy path -------------------------------------------------
{
  const { result, calls } = await run()
  const seq = calls.map((c) => c.label)
  check('A: dispatcher runs once per ticket', seq.filter((l) => l.startsWith('dispatch')).length === 2, seq.join(' | '))
  check('A: implementer is told NOT to read the issue', calls.find((c) => c.label === 'impl:#10').prompt.includes('run no `gh issue view`'), '')
  check('A: publish order respects the dependency', seq.indexOf('publish:#10') < seq.indexOf('publish:#11'), '')
  check('A: #11 cut from #10 branch, addressed locally', calls.find((c) => c.label === 'impl:#11').prompt.includes('git switch --detach ticket/10') && !calls.find((c) => c.label === 'impl:#11').prompt.includes('origin/ticket/10'), '')
  check('A: an inherited ref stays origin-addressed', calls.find((c) => c.label === 'impl:#10').prompt.includes('origin/main'), '')
  check('A: slices move the ref instead of pushing', calls.find((c) => c.label === 'impl:#10').prompt.includes('git update-ref refs/heads/ticket/10 HEAD') && calls.find((c) => c.label === 'impl:#10').prompt.includes('Push nothing'), '')
  check('A: the lane pushes once, creating the ref', calls.find((c) => c.label === 'publish:#10').prompt.includes('git push origin ticket/10') && calls.find((c) => c.label === 'publish:#10').prompt.includes('CREATES the branch'), '')
  check('A: publish #10 needs no rebase (tip unmoved)', !calls.find((c) => c.label === 'publish:#10').prompt.includes('git rebase --onto'), '')
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
  check('B: continuation slice detaches at the local ticket branch', calls.find((c) => c.label === 'impl:#10:r2').prompt.includes('git switch --detach ticket/10'), '')
  check('B: remainder slice gets dispatcher effort high', calls.find((c) => c.label === 'impl:#10:r2').effort === 'high', '')
  check('B: run completes with no unmet', result.unmet.length === 0 && result.state.startsWith('complete'), result.state)
}

// --- scenario B2: two independent tickets — the tip moves under the second --
// The case that produced the force-push: both cut from main, one publishes
// first, so the other must be replayed onto a tip that did not exist when it
// started. Nothing on origin is rewritten, because it was never pushed.
{
  const { result, calls } = await run({
    graph: () => ({
      tickets: [
        { number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 11, title: 'T11', blocked_by: [], needs_human: false, human_reason: '' },
      ],
      start_ref: 'main',
      explorations: [],
    }),
  })
  const second = calls.find((c) => c.label === 'publish:#11')
  check('B2: both tickets cut from the same inherited base', calls.find((c) => c.label === 'impl:#11').prompt.includes('origin/main'), '')
  check('B2: the second publish replays onto the moved tip', second.prompt.includes('git rebase --onto ticket/10'), second.prompt.slice(0, 400))
  check('B2: the rebase is stated as local-only', second.prompt.includes('never left this clone'), '')
  check('B2: still one plain push, no force', second.prompt.includes('git push origin ticket/11') && !second.prompt.includes('--force-with-lease origin'), '')
  check('B2: both tickets stack', result.stack_bottom_to_top.length === 2, JSON.stringify(result.stack_bottom_to_top))
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
  check('C: local-only refs are named for recovery', result.local_only_branches === null || Array.isArray(result.local_only_branches.refs), JSON.stringify(result.local_only_branches))
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
  check('F: first integration slice cuts from the local stack tip', calls.find((c) => c.label === 'integration').prompt.includes('git switch --detach ticket/11'), calls.find((c) => c.label === 'integration').prompt)
  check('F: the fix dispatcher names the ref the branch is cut from', calls.find((c) => c.label === 'integration:dispatch').prompt.includes('cuts fresh from `ticket/11`'), calls.find((c) => c.label === 'integration:dispatch').prompt.split('\n').find((l) => l.includes('cuts fresh from')))
  check('F: the integration publisher performs the first push', calls.find((c) => c.label === 'publish:integration').prompt.includes('git push origin spec/224-integration'), '')
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

// --- scenario H: the stack registers as it grows, not at finalize ----------
// `gh stack link` takes a minimum of two arguments, so the first PR of a
// layer-0-less run cannot register and the second must. Every call re-lists
// the whole stack: no stack number is ever discovered or carried.
{
  const { result, calls, logs } = await run({
    graph: () => ({
      tickets: [
        { number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 11, title: 'T11', blocked_by: [10], needs_human: false, human_reason: '' },
      ],
      start_ref: 'main',
      explorations: [],
    }),
  })
  const first = calls.find((c) => c.label === 'publish:#10')
  const second = calls.find((c) => c.label === 'publish:#11')
  const publishLogs = logs.filter((l) => l.startsWith('stacked #'))
  check('H: the first PR cannot register — link needs two layers', /needs two layers/.test(first.prompt) && !/gh stack link [a-z]/.test(first.prompt), first.prompt.slice(-500))
  check('H: the second PR registers the whole stack, bottom to top', second.prompt.includes('gh stack link ticket/10 ticket/11 --base main --remote origin'), second.prompt.slice(-700))
  check('H: no publish uses the stack-number shortcut', !calls.some((c) => c.label.startsWith('publish:#') && /gh stack link \d+ /.test(c.prompt)), '')
  check('H: each PR body states its actual layer position', first.prompt.includes('Layer 1 of 2 planned') && second.prompt.includes('Layer 2 of 2 planned'), '')
  check('H: every layer stays draft until finalize', /Leave it a DRAFT/.test(second.prompt), '')
  check('H: finalize reconciles rather than first-registers', calls.find((c) => c.label === 'finalize').prompt.includes('Reconcile the stack registration'), '')
  check('H: the log line carries registration state', publishLogs[0].includes('needs 2 layers') && publishLogs[1].includes('stack registered'), publishLogs.join(' | '))
  check('H: the brief says registration was incremental', /registered incrementally/.test(result.stack_registration), result.stack_registration)
}

// --- scenario H2: layer 0 means the FIRST ticket already has two layers -----
{
  const { calls } = await run({
    graph: () => ({
      tickets: [{ number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' }],
      start_ref: 'feat/prior',
      explorations: [],
    }),
  })
  const layer0 = calls.find((c) => c.label.startsWith('layer0'))
  const first = calls.find((c) => c.label === 'publish:#10')
  check('H2: layer 0 cannot register alone', /needs two layers/.test(layer0.prompt), layer0.prompt.slice(-300))
  check('H2: layer 0 is layer 1 of the planned count', layer0.prompt.includes('Layer 1 of 2 planned'), '')
  check('H2: the first ticket registers layer 0 with itself', first.prompt.includes('gh stack link feat/prior ticket/10 --base main --remote origin'), first.prompt.slice(-700))
  check('H2: the first ticket is layer 2, counting layer 0', first.prompt.includes('Layer 2 of 2 planned'), '')
}

// --- scenario H3: exit 9 mid-run latches, degrades, and says so loudly ------
// The arm-time gate cannot cover the stacks API going away DURING a run, and
// nobody is there to ask. Publishing continues; the brief must not pretend the
// run is still native, because the operator's merge is a different operation.
{
  const { result, calls } = await run({
    graph: () => ({
      tickets: [
        { number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 11, title: 'T11', blocked_by: [10], needs_human: false, human_reason: '' },
        { number: 12, title: 'T12', blocked_by: [11], needs_human: false, human_reason: '' },
      ],
      start_ref: 'main',
      explorations: [],
    }),
    publish: (label) => {
      const n = label.match(/#(\d+)/)[1]
      // #10 is the lone first layer, so it never gets a link command to run;
      // #11 is the first that does, and that is where the API says exit 9.
      const stack_link = n === '10' ? 'skipped' : n === '11' ? 'disabled' : 'registered'
      return { published: true, pr_url: 'https://pr/' + n, pr_number: 100 + Number(n), conflicts_resolved: [], stack_link, note: '' }
    },
  })
  const third = calls.find((c) => c.label === 'publish:#12')
  check('H3: after exit 9 no later publish spends a call on link', !/gh stack link/.test(third.prompt) && /stacks API disabled/.test(third.prompt), third.prompt.slice(-500))
  check('H3: the ticket still publishes — the PR outranks the stack map', result.stack_bottom_to_top.length === 3, JSON.stringify(result.stack_bottom_to_top))
  check('H3: finalize does not retry the dead link', !/gh stack link/.test(calls.find((c) => c.label === 'finalize').prompt), '')
  check('H3: the brief stops calling the run native', /degraded mid-run/.test(result.mode), result.mode)
  check('H3: the brief states what was lost in its own field', /LOST MID-RUN/.test(result.stack_registration), result.stack_registration)
  check('H3: the merge instructions switch to bottom-up by hand', /merge bottom-up by hand/.test(result.merge_how), result.merge_how.slice(0, 120))
}

// --- run-wide: every prompt of every scenario ------------------------------
{
  const offenders = (re) => [...new Set(EVERY_CALL.filter((c) => re.test(c.prompt)).map((c) => c.label))].join(' | ')
  const noForce = /--force(?!` or `--force-with-lease` to any push)/
  check('ALL: no prompt tells an agent to force-push', !EVERY_CALL.some((c) => noForce.test(c.prompt.replace(/^- Never pass.*$/gm, ''))), offenders(/--force-with-lease origin|--force origin/))
  check('ALL: no prompt tells an agent to check a branch out', !EVERY_CALL.some((c) => /git checkout -B|git checkout ticket\//.test(c.prompt)), offenders(/git checkout -B/))
  check('ALL: no prompt interpolates a helper instead of a value', !EVERY_CALL.some((c) => /runRefs\.has|\(r\) =>|=> \(\{/.test(c.prompt)), offenders(/runRefs\.has|\(r\) =>/))
  // `--open` readies the PRs, and the drafts are half the "still adding
  // layers" signal. Every `gh stack link` in the run must omit it.
  check('ALL: no prompt passes --open to gh stack link', !EVERY_CALL.some((c) => /gh stack link[^\n]*--open/.test(c.prompt)), offenders(/gh stack link[^\n]*--open/))
  // `link` opens a PR for any branch that lacks one, and that PR would be
  // outside the run's control. Every prompt carrying a REAL link command (not
  // just a mention of one) must say so. `[a-z]` after the command isolates an
  // invocation with branch arguments from a backticked mention.
  const realLink = /gh stack link [a-z]/
  check('ALL: no prompt names a branch to link without its PR existing', !EVERY_CALL.some((c) => realLink.test(c.prompt) && !/already has its PR|PR you have not just confirmed exists/.test(c.prompt)), offenders(realLink))
  check('ALL: every scenario contributed prompts', EVERY_CALL.length > 60, String(EVERY_CALL.length))
}

for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '   [' + c.detail + ']'))
console.log(checks.every((c) => c.ok) ? '\nALL PASS (' + checks.length + ' checks)' : '\nFAILURES PRESENT')
