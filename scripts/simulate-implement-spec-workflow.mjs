// Simulates the rendered workflow script with stubbed agent() calls, driving
// it through the paths the dispatcher redesign added.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { loadScript } from '../packages/crew/src/runner.mjs'

const TPL = fileURLToPath(new URL('../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url))

const SIM_CHECK = 'npm t'

function render(runner, runOrder = 'parallel') {
  let s = readFileSync(TPL, 'utf8')
  s = s
    .replace(/__SPEC__/g, '224')
    .replace(/__REPO__/g, 'o/r')
    .replace(/__REPO_DIR__/g, '/tmp/x')
    .replace(/__NOTES_DIR__/g, '/tmp/n')
    .replace(/__BASE_REF__/g, 'main')
    .replace(/__STACK_MODE__/g, 'native')
    .replace(/__RUN_ORDER__/g, runOrder)
    .replace(/__RUNNER__/g, runner)
    .replace(/__VALIDATION__/g, SIM_CHECK)
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

// The harness enforces each call's schema, so a real agent never omits a
// required field. Stubs state only what a scenario is about; this fills the
// rest the way a green, well-behaved agent would. A null result (an agent that
// died) stays null.
function completeToSchema(result, opts, label) {
  const schema = opts.schema
  if (!schema || !result || typeof result !== 'object') return result
  const filled = { ...result }
  for (const key of schema.required || []) {
    if (key in filled) continue
    if (key === 'checks') filled.checks = [{ command: SIM_CHECK, passed: true, runs: 1, seconds: 1 }]
    else if (key === 'validated_sha') filled.validated_sha = 'simsha'
    else if (key === 'worktree') filled.worktree = '/wt/' + label
    else {
      const type = (schema.properties[key] || {}).type
      filled[key] = type === 'array' ? [] : type === 'string' ? '' : type === 'boolean' ? false : type === 'integer' || type === 'number' ? 0 : null
    }
  }
  return filled
}

async function run(overrides = {}, { runner = 'workflow', runOrder = 'parallel' } = {}) {
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
    explore: () => ({ path: '/tmp/n/01-area-a.md', blockers: [] }),
    unblock: () => ({ resolved: [], decisions_needed: [] }),
    layer0: () => ({ pr_url: 'https://pr/layer0', pr_number: 90, note: 'in sync', worktree: '/wt/layer0' }),
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
      return { published: true, pr_url: 'https://pr/' + n, pr_number: 100 + Number(n), conflicts_resolved: [], stack_link, note: '', worktree: '/wt/publish-' + n, worktrees_removed: 0, worktrees_kept: [] }
    },
    review: () => ({ findings: [] }),
    integration: () => ({ pr_url: 'https://pr/int', pr_number: 999, branch: 'spec/224-integration', worktree: '/wt/int', worktrees_removed: 0, worktrees_kept: [] }),
    finalize: () => 'stack registered, 2 PRs ready, 0 worktrees',
    reclaim: () => ({ worktrees_removed: 0, worktrees_kept: [] }),
    retrospective: () => ({ summary: 'sim', report_path: '/tmp/n/retrospective.md', proposals: [] }),
  }
  const h = { ...defaults, ...overrides }

  function route(label) {
    if (label.startsWith('graph')) return 'graph'
    if (label.startsWith('explore')) return 'explore'
    if (label.startsWith('unblock')) return 'unblock'
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
    if (label === 'reclaim') return 'reclaim'
    if (label === 'retrospective') return 'retrospective'
    throw new Error('unrouted label: ' + label)
  }

  // `alongside` counts the agents already in flight when a call starts.
  const timeline = []
  let inFlight = 0
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || '?'
    calls.push({ label, effort: opts.effort || '(inherit)', prompt, opts, alongside: inFlight })
    inFlight++
    timeline.push('start ' + label)
    try {
      return completeToSchema(await h[route(label)](label, prompt, opts), opts, label)
    } finally {
      inFlight--
      timeline.push('end ' + label)
    }
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const logs = []
  const log = (m) => logs.push(m)
  const phase = () => {}

  // The session runner's own loader, so the script is loaded one way everywhere.
  const result = await loadScript(render(runner, runOrder))(agent, parallel, phase, log, {})
  EVERY_CALL.push(...calls)
  EVERY_RUN.push(calls)
  return { result, calls, logs, timeline }
}

// Assertions that must hold of EVERY prompt the workflow can emit are checked
// against all scenarios at the bottom, not inside one — a prompt only rendered
// on some path (the integration fix dispatcher, say) is exactly where a
// template hole hides.
const EVERY_CALL = []
const EVERY_RUN = []
const nodesOf = (calls) => calls.map((c) => c.opts.node)
const checks = []
function check(name, cond, detail) { checks.push({ name, ok: !!cond, detail }); if (!cond) process.exitCode = 1 }

// --- scenario A: happy path -------------------------------------------------
{
  const { result, calls } = await run()
  const seq = calls.map((c) => c.label)
  check('A: dispatcher runs once per ticket', seq.filter((l) => l.startsWith('dispatch')).length === 2, seq.join(' | '))
  check('A: implementer reads its ticket, not the spec', calls.find((c) => c.label === 'impl:#10').prompt.includes('`gh issue view 10`') && calls.find((c) => c.label === 'impl:#10').prompt.includes('Read no spec'), '')
  check('A: publish order respects the dependency', seq.indexOf('publish:#10') < seq.indexOf('publish:#11'), '')
  check('A: #11 cut from #10 branch, addressed locally', calls.find((c) => c.label === 'impl:#11').prompt.includes('git switch --detach ticket/10') && !calls.find((c) => c.label === 'impl:#11').prompt.includes('origin/ticket/10'), '')
  check('A: an inherited ref stays origin-addressed', calls.find((c) => c.label === 'impl:#10').prompt.includes('origin/main'), '')
  check('A: slices move the ref instead of pushing', calls.find((c) => c.label === 'impl:#10').prompt.includes('git update-ref refs/heads/ticket/10 HEAD') && calls.find((c) => c.label === 'impl:#10').prompt.includes('Push nothing'), '')
  check('A: the lane pushes once, creating the ref', calls.find((c) => c.label === 'publish:#10').prompt.includes('git push origin ticket/10') && calls.find((c) => c.label === 'publish:#10').prompt.includes('CREATES the branch'), '')
  check('A: publish #10 needs no rebase (tip unmoved)', !calls.find((c) => c.label === 'publish:#10').prompt.includes('git rebase --onto'), '')
  check('A: complete state', result.state.startsWith('complete'), result.state)
  check('A: not halted, reviewed and finalized', result.halted === false && seq.includes('review:spec-224') && seq.includes('finalize'), seq.join(' | '))
  check('A: nodes are named for what they are', ['graph', 'explore/area-a', 'ticket/10/dispatch', 'ticket/10/impl/r1/s1', 'ticket/10/gate/r1', 'ticket/10/publish', 'ticket/11/publish', 'review', 'finalize', 'retrospective'].every((n) => nodesOf(calls).includes(n)), nodesOf(calls).join(' | '))
  check('A: no call is marked in flight when nothing halts', !calls.some((c) => c.opts.inFlight), '')
  check('A: explore effort low / dispatch high / publish low', calls.find((c) => c.label.startsWith('explore')).effort === 'low' && calls.find((c) => c.label === 'dispatch:#10').effort === 'high' && calls.find((c) => c.label === 'publish:#10').effort === 'low', '')
  check('A: slice effort taken from dispatcher verdict', calls.find((c) => c.label === 'impl:#10').effort === 'medium', '')
  check('A: an untouched harness table runs every agent on Claude opus', calls.every((c) => c.opts.harness === 'claude' && c.opts.model === 'opus'), JSON.stringify(calls.filter((c) => c.opts.harness !== 'claude' || c.opts.model !== 'opus').map((c) => c.label)))
}

// --- scenario U: blockers found at discovery are cleared first (ADR-0021) ---
const SIGNING = { subject: 'Developer ID signing identity', tickets: [10], why: 'the app must be signed with it', evidence: 'security find-identity shows none', check: 'security find-identity -v -p codesigning | grep "Developer ID Application"' }
const NOTARY = { subject: 'notary credentials', tickets: [11], why: 'notarization', evidence: 'no keychain profile', check: 'xcrun notarytool history --keychain-profile notary' }
const withBlockers = (blockers, start_ref = 'main') => () => ({
  tickets: [
    { number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' },
    { number: 11, title: 'T11', blocked_by: [10], needs_human: false, human_reason: '' },
  ],
  start_ref,
  explorations: [{ label: 'area-a', question: 'q?' }],
  blockers,
})
{
  const { result, calls } = await run({
    graph: withBlockers([SIGNING]),
    explore: () => ({ path: '/tmp/n/01-area-a.md', blockers: [NOTARY] }),
    unblock: () => ({ resolved: [{ subject: 'Developer ID signing identity', verified_by: 'find-identity lists it' }, { subject: 'notary credentials', verified_by: 'history ran' }], decisions_needed: [] }),
  }, { runner: 'session' })
  const seq = calls.map((c) => c.label)
  const u = calls.find((c) => c.label === 'unblock')
  check('U1: blockers open one unblock session', seq.filter((l) => l === 'unblock').length === 1, seq.join(' | '))
  check('U1: unblock runs after explore and before anything is implemented', seq.indexOf('unblock') > seq.findIndex((l) => l.startsWith('explore')) && seq.indexOf('unblock') < seq.findIndex((l) => l.startsWith('dispatch')), seq.join(' | '))
  check('U1: unblock is attended, a node, in the project, with the blockers as its reason', u && typeof u.opts.attended === 'string' && /Developer ID signing identity/.test(u.opts.attended) && u.opts.node === 'unblock' && !u.opts.isolation && u.opts.phase === 'Unblock', JSON.stringify(u && u.opts))
  check('U1: the unblock prompt hands over every blocker with its check, graph and explorers alike', u && u.prompt.includes(SIGNING.check) && u.prompt.includes(SIGNING.evidence) && u.prompt.includes('notarytool history'), '')
  check('U1: the unblock agent guides and never fixes', u && /[Nn]ever install, sign, configure/.test(u.prompt) && /`decisions_needed`/.test(u.prompt), '')
  check('U1: a cleared run implements every ticket', result.halted === false && result.state.startsWith('complete') && seq.includes('publish:#11'), result.state)
  check('U1: the unblock agent takes its role row from the role table', u && u.opts.harness === 'claude' && u.opts.model === 'opus', JSON.stringify(u && u.opts))
  check('U1: explorers that return blockers still hand the dispatcher their notes by path', calls.find((c) => c.label === 'dispatch:#10').prompt.includes('/tmp/n/01-area-a.md'), '')
}
{
  const { calls } = await run({ graph: withBlockers([SIGNING], 'feat/prior') }, { runner: 'session' })
  const seq = calls.map((c) => c.label)
  check('U6: unblock runs before Setup builds layer 0', seq.includes('unblock') && seq.findIndex((l) => l.startsWith('layer0')) > seq.indexOf('unblock'), seq.join(' | '))
}
{
  const { result, calls } = await run({ graph: withBlockers([SIGNING]), unblock: () => ({ resolved: [], decisions_needed: ['Developer ID signing identity: no Account Holder access today'] }) }, { runner: 'session' })
  check('U5: an unresolved blocker halts the run before anything is built', result.halted === true && /Developer ID signing identity/.test(result.reason) && !calls.some((c) => c.label.startsWith('dispatch') || c.label.startsWith('layer0')), JSON.stringify(result))
}
{
  const before = (await run({}, { runner: 'session' })).calls.map((c) => c.label)
  const { calls } = await run({ graph: withBlockers([]) }, { runner: 'session' })
  check('U2: an empty blocker list leaves the call sequence as it was', JSON.stringify(calls.map((c) => c.label)) === JSON.stringify(before), calls.map((c) => c.label).join(' | '))
}
{
  const { calls } = await run({}, { runner: 'session' })
  check('U2: no blockers, no unblock session', !calls.some((c) => c.label === 'unblock'), calls.map((c) => c.label).join(' | '))
  check('U2: the graph prompt asks for blockers, apart from needs_human', /blockers:/.test(calls[0].prompt) && /is a blocker, not needs_human/.test(calls[0].prompt), '')
}
{
  const { result, calls } = await run({ graph: withBlockers([SIGNING]), explore: () => ({ path: '/tmp/n/01-area-a.md', blockers: [NOTARY] }) })
  const seq = calls.map((c) => c.label)
  check('U3: the Workflow runner halts at blockers instead of opening a session', !seq.includes('unblock') && result.halted === true && result.blockers.length === 2, JSON.stringify(result))
  check('U3: the halt lists every blocker, graph and explorers alike, with the tickets that need it', /Developer ID signing identity \(#10\)/.test(result.reason) && /notary credentials \(#11\)/.test(result.reason), result.reason)
  check('U3: nothing is implemented past a blocker', !seq.some((l) => l.startsWith('dispatch') || l.startsWith('layer0') || l.startsWith('publish')), seq.join(' | '))
}
{
  const { result, calls } = await run({ graph: withBlockers([SIGNING]), unblock: () => null }, { runner: 'session' })
  const seq = calls.map((c) => c.label)
  check('U4: an unblock session that died halts the run with its blockers', result.halted === true && /Developer ID signing identity/.test(result.reason) && !seq.some((l) => l.startsWith('dispatch')), JSON.stringify(result))
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
  check('B: run completes, not halted', result.halted === false && result.state.startsWith('complete'), result.state)
  check('B: a re-dispatch and its slices are nodes of their round', ['ticket/10/impl/r1/s1', 'ticket/10/dispatch/r2', 'ticket/10/impl/r2/s1'].every((n) => nodesOf(calls).includes(n)) && !nodesOf(calls).includes('ticket/10/impl/r1/s2'), nodesOf(calls).join(' | '))
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

// --- scenario C: remainder survives every dispatch round — the run halts ---
{
  const { result, calls } = await run({
    graph: () => ({ tickets: [{ number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' }], start_ref: 'main', explorations: [] }),
    impl: () => ({ branch: 'ticket/10', summary: 'partial', tests_run: 'npm t', tests_green: true, unmet: ['criterion Z'] }),
  })
  const seq = calls.map((c) => c.label)
  const rounds = calls.filter((c) => c.label.startsWith('impl:#10')).length
  check('C: exactly MAX_DISPATCH_ROUNDS slice rounds', rounds === 6, String(rounds))
  check('C: unmet after the cap halts the run', result.halted === true && result.tickets.length === 1 && result.tickets[0].state === 'unmet' && result.tickets[0].detail.includes('criterion Z'), JSON.stringify(result.tickets))
  check('C: an unmet ticket is neither gated nor published', !seq.some((l) => l.startsWith('gate') || l.startsWith('publish')), seq.join(' | '))
  check('C: a halted run has no review and no finalize', !seq.some((l) => l.startsWith('review') || l === 'finalize' || l === 'reclaim' || l === 'retrospective'), seq.join(' | '))
  check('C: the halted summary names its reason and what published', /#10/.test(result.reason) && Array.isArray(result.published) && result.published.length === 0, JSON.stringify(result))
  check('C: local-only refs are named for recovery', result.local_only_branches && result.local_only_branches.refs.includes('ticket/10'), JSON.stringify(result.local_only_branches))
}

// --- scenario C2: the #1186 incident — a failed chain under a layer 0 ------
// #1187 failed and #1188-#1190 wait on it. Layer 0 existed, so the old early
// stop (nothing published AND no layer 0) did not fire and the run reviewed a
// stack of pre-existing work. A halted run reviews nothing.
{
  const { result, calls } = await run({
    graph: () => ({
      tickets: [
        { number: 1187, title: 'T1187', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 1188, title: 'T1188', blocked_by: [1187], needs_human: false, human_reason: '' },
        { number: 1189, title: 'T1189', blocked_by: [1188], needs_human: false, human_reason: '' },
        { number: 1190, title: 'T1190', blocked_by: [1189], needs_human: false, human_reason: '' },
      ],
      start_ref: 'feat/prior',
      explorations: [],
    }),
    impl: () => null,
  })
  const seq = calls.map((c) => c.label)
  const st = Object.fromEntries(result.tickets.map((x) => [x.ticket, x]))
  check('C2: one failed ticket halts the run despite a layer 0', result.halted === true && !seq.some((l) => l.startsWith('review') || l === 'finalize'), seq.join(' | '))
  check('C2: the failed ticket is failed, its chain not started', st[1187].state === 'failed' && ['1188', '1189', '1190'].every((n) => st[n].state === 'not started') && /#1187/.test(st[1188].detail), JSON.stringify(result.tickets))
  check('C2: no agent ran for the chain', !seq.some((l) => /#11(88|89|90)/.test(l)), seq.join(' | '))
  check('C2: layer 0 is the only thing published', result.published.length === 1 && /layer 0/.test(result.published[0]), JSON.stringify(result.published))
}

// --- scenario C3: a decision halts its ticket; blocked work is never re-dispatched
// The observed slice returned decisions_needed AND put the blocked criterion
// in unmet; the script re-dispatched it, and the new slice blocked on a reply.
{
  const { result, calls } = await run({
    graph: () => ({ tickets: [{ number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' }, { number: 11, title: 'T11', blocked_by: [10], needs_human: false, human_reason: '' }], start_ref: 'main', explorations: [] }),
    impl: (label) => label.includes('#10')
      ? { branch: 'ticket/10', summary: 's', unmet: ['criterion Q'], decisions_needed: ['criterion Q: the ticket says keep X, ADR-0003 says drop it — which?'] }
      : { branch: 'ticket/11', summary: 's', unmet: [] },
  })
  const seq = calls.map((c) => c.label)
  const t10 = result.tickets.find((x) => x.ticket === 10)
  check('C3: a decision ends the slice rounds — no re-dispatch', !seq.some((l) => l.startsWith('dispatch:#10:re')) && seq.filter((l) => l.startsWith('impl:#10')).length === 1, seq.join(' | '))
  check('C3: the ticket needs a decision, with the question', t10 && t10.state === 'needs decision' && /ADR-0003/.test(t10.detail) && t10.questions.length === 1, JSON.stringify(result.tickets))
  check('C3: a ticket needing a decision is not gated or published, and halts the run', result.halted === true && !seq.some((l) => l.startsWith('gate') || l.startsWith('publish') || l.startsWith('review')), seq.join(' | '))
  check('C3: the slice prompt says when to decide and when to halt', /decide it yourself/.test(calls.find((c) => c.label === 'impl:#10').prompt) && /never in `unmet`/.test(calls.find((c) => c.label === 'impl:#10').prompt), '')
}

// --- scenario C4: halting starts nothing new; a single-slice ticket finishes -
// #10 fails. #11, independent and dispatched as one slice, is mid-slice: it
// finishes its slice, gate and publish, each call marked inFlight. #13, also
// independent but dispatched as two slices, makes no call after the one it is
// in. #12 waits on #11 and never starts, though #11 published.
{
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms))
  const { result, calls } = await run({
    graph: () => ({
      tickets: [
        { number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 11, title: 'T11', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 12, title: 'T12', blocked_by: [11], needs_human: false, human_reason: '' },
        { number: 13, title: 'T13', blocked_by: [], needs_human: false, human_reason: '' },
      ],
      start_ref: 'main',
      explorations: [],
    }),
    dispatch: (label) => label.includes('#13')
      ? { ticket_brief: 'b', slices: [{ title: 'p1', brief: 'x', effort: 'medium' }, { title: 'p2', brief: 'y', effort: 'medium' }] }
      : { ticket_brief: 'b', slices: [{ title: 'all', brief: 'x', effort: 'medium' }] },
    impl: (label) => {
      const n = label.match(/#(\d+)/)[1]
      if (n === '10') return null
      return later(20, { branch: 'ticket/' + n, summary: 's', unmet: [] })
    },
  })
  const seq = calls.map((c) => c.label)
  const st = Object.fromEntries(result.tickets.map((x) => [x.ticket, x]))
  check('C4: the in-flight single-slice ticket is gated and published', seq.includes('gate:#11:r1') && seq.includes('publish:#11') && result.published.some((p) => p.startsWith('#11')), seq.join(' | '))
  check('C4: its calls after the halt are marked inFlight', calls.find((c) => c.label === 'gate:#11:r1').opts.inFlight === true && calls.find((c) => c.label === 'publish:#11').opts.inFlight === true, '')
  check('C4: a multi-slice ticket makes no new call once halting', !seq.includes('impl:#13:s2') && !seq.includes('gate:#13:r1') && st[13] && st[13].state === 'stopped', seq.join(' | ') + ' ' + JSON.stringify(result.tickets))
  check('C4: no ticket starts after the halt', !seq.some((l) => l.includes('#12')) && st[12].state === 'not started', seq.join(' | '))
  check('C4: the run halts on the failure, not on the in-flight ticket', result.halted === true && st[10].state === 'failed' && !st[11] && /#10/.test(result.reason) && !seq.some((l) => l.startsWith('review') || l === 'finalize'), JSON.stringify(result))
}

// --- scenario C5: a contradiction closed inside the ticket reaches the PR ----
{
  const { calls } = await run({
    graph: () => ({ tickets: [{ number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' }], start_ref: 'main', explorations: [] }),
    impl: () => ({ branch: 'ticket/10', summary: 's', unmet: [], decided: ['criterion 2 and 3 disagree on the flag name; kept `--dry`, which the ticket leaves open'] }),
  })
  check('C5: a decision the implementer made is put on its PR', /kept `--dry`/.test(calls.find((c) => c.label === 'publish:#10').prompt), '')
  check('C5: the gate reviewer sees the decision', /kept `--dry`/.test(calls.find((c) => c.label === 'gate:#10:r1').prompt), '')
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
  check('D: gate fixes are nodes of their gate round', ['ticket/10/gate/r1', 'ticket/10/gate/r1/fix/dispatch', 'ticket/10/gate/r1/fix/s1', 'ticket/10/gate/r1/fix/s2', 'ticket/10/gate/r2'].every((n) => nodesOf(calls).includes(n)), nodesOf(calls).join(' | '))
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
  // Round 2 lists a.js:1 under "Claimed fixed" — only the unverified block must omit it.
  const unverifiedBlock = calls.find((c) => c.label === 'gate:#10:r2').prompt.split('never reported back')[1].split('\n\n')[1]
  check('E: a fixed finding is NOT re-listed as unverified', unverifiedBlock.includes('b.js:2') && !unverifiedBlock.includes('a.js:1'), unverifiedBlock)
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
  check('F: review fixes are nodes of the review', ['review', 'review/fix/dispatch', 'review/fix/s1', 'review/publish', 'finalize'].every((n) => nodesOf(calls).includes(n)), nodesOf(calls).join(' | '))
  const again = await run({ review: () => ({ findings: [{ severity: 'major', location: 'c.js:3', issue: 'two helpers', fix: 'merge them' }] }) })
  check('F: a re-run with the same results names the same nodes', JSON.stringify(nodesOf(again.calls).slice().sort()) === JSON.stringify(nodesOf(calls).slice().sort()), '')
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
      return { published: true, pr_url: 'https://pr/' + n, pr_number: 100 + Number(n), conflicts_resolved: [], stack_link, note: '', worktree: '/wt/publish-' + n, worktrees_removed: 0, worktrees_kept: [] }
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

// --- scenario H4: a link push rejected non-fast-forward is not transient ----
// `gh stack link` pushes every branch it names by LOCAL ref. A stale local ref
// on any layer (an earlier run's leftover on layer 0, say) is rejected, and
// every later re-list dies the same way — so every link call mirrors origin
// into the lower layers first, and a rejection is named in the log and the
// brief instead of being logged as transient and waited out.
{
  const { result, calls, logs } = await run({
    graph: () => ({
      tickets: [
        { number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 11, title: 'T11', blocked_by: [10], needs_human: false, human_reason: '' },
        { number: 12, title: 'T12', blocked_by: [11], needs_human: false, human_reason: '' },
      ],
      start_ref: 'feat/prior',
      explorations: [],
    }),
    layer0: () => ({ pr_url: 'https://pr/layer0', pr_number: 90, note: 'moved feat/prior off stale 54a41bb0 to origin', worktree: '/wt/layer0' }),
    publish: (label) => {
      const n = label.match(/#(\d+)/)[1]
      const stack_link = n === '12' ? 'registered' : 'rejected'
      return { published: true, pr_url: 'https://pr/' + n, pr_number: 100 + Number(n), conflicts_resolved: [], stack_link, note: 'feat/prior local 54a41bb0 vs origin ac46c84a', worktree: '/wt/publish-' + n, worktrees_removed: 0, worktrees_kept: [] }
    },
  })
  const layer0 = calls.find((c) => c.label.startsWith('layer0'))
  const first = calls.find((c) => c.label === 'publish:#10')
  const second = calls.find((c) => c.label === 'publish:#11')
  const finalize = calls.find((c) => c.label === 'finalize')
  const mirrorCmd = 'git update-ref refs/heads/<branch> origin/<branch>'
  check('H4: layer 0 mirrors its own local ref from origin', layer0.prompt.includes(mirrorCmd) && layer0.prompt.includes('`feat/prior`'), layer0.prompt.slice(-600))
  check('H4: the layer-0 log carries what the mirror found', logs.some((l) => /Layer 0:.*stale 54a41bb0/.test(l)), logs.join(' | '))
  check('H4: every link mirrors the layers below before linking', first.prompt.includes(mirrorCmd) && first.prompt.includes('LOCAL ref of `feat/prior` before') && second.prompt.includes('LOCAL ref of `feat/prior`, `ticket/10` before'), second.prompt.slice(-900))
  check('H4: the mirror never names the branch being published', !first.prompt.includes('`feat/prior`, `ticket/10` before'), '')
  check('H4: the mirror spares a branch a worktree has checked out', /git worktree list/.test(first.prompt) && /let the link fail/.test(first.prompt), '')
  check('H4: a rejected push is its own outcome, not "failed"', /stack_link: "rejected"/.test(first.prompt) && /not transient/.test(first.prompt), '')
  check('H4: a rejection does not latch — the next publish still links', /gh stack link feat\/prior ticket\/10 ticket\/11 ticket\/12/.test(calls.find((c) => c.label === 'publish:#12').prompt), '')
  check('H4: the log names the rejection loudly', logs.some((l) => /stacked #10.*NOT REGISTERED.*rejected non-fast-forward.*54a41bb0/.test(l)), logs.join(' | '))
  check('H4: finalize mirrors every layer before reconciling', finalize.prompt.includes('LOCAL ref of `feat/prior`, `ticket/10`, `ticket/11`, `ticket/12`, `spec/224-integration` before') || finalize.prompt.includes('LOCAL ref of `feat/prior`, `ticket/10`, `ticket/11`, `ticket/12` before'), finalize.prompt.slice(0, 1200))
  check('H4: the brief says registered once a later link succeeded', /registered incrementally/.test(result.stack_registration), result.stack_registration)
}

// --- scenario H5: every link rejected — the brief must not blame layer count -
{
  const { result, calls } = await run({
    graph: () => ({
      tickets: [
        { number: 10, title: 'T10', blocked_by: [], needs_human: false, human_reason: '' },
        { number: 11, title: 'T11', blocked_by: [10], needs_human: false, human_reason: '' },
      ],
      start_ref: 'main',
      explorations: [],
    }),
    publish: (label) => {
      const n = label.match(/#(\d+)/)[1]
      const stack_link = n === '10' ? 'skipped' : 'rejected'
      return { published: true, pr_url: 'https://pr/' + n, pr_number: 100 + Number(n), conflicts_resolved: [], stack_link, note: 'ticket/10 local a vs origin b', worktree: '/wt/publish-' + n, worktrees_removed: 0, worktrees_kept: [] }
    },
  })
  const finalize = calls.find((c) => c.label === 'finalize')
  check('H5: the brief says the lane never registered, with the last rejection', /NOT REGISTERED IN THE LANE/.test(result.stack_registration) && /#11: link push rejected non-fast-forward — ticket\/10 local a vs origin b/.test(result.stack_registration), result.stack_registration)
  check('H5: the brief does not blame the layer count', !/never reached two layers/.test(result.stack_registration), result.stack_registration)
  check('H5: finalize is told it is the first registration, and why', /first registration/.test(finalize.prompt) && /the last failure: #11/.test(finalize.prompt), finalize.prompt.slice(0, 1500))
}

// --- scenario R: the Workflow runner reclaims, the Orca runner never does ---
{
  const onRunner = async (runner, overrides = {}) => (await run(overrides, { runner }))
  const publish10 = (calls) => calls.find((c) => c.label === 'publish:#10').prompt
  const onWorkflow = await onRunner('workflow')
  const onOrca = await onRunner('session')
  // 'orca' is what RUNNER was rendered as before 'session': such a script,
  // and its resume, must run exactly as the new rendering does.
  const onOrcaValue = await onRunner('orca')
  const trace = (r) => JSON.stringify([r.calls.map((c) => [c.label, c.prompt]), r.result])
  check("R: a script rendered with RUNNER 'orca' runs exactly as one rendered with 'session'", trace(onOrcaValue) === trace(onOrca), '')
  const wf = publish10(onWorkflow.calls)
  const orca = publish10(onOrca.calls)
  const reclaimCmd = /git worktree remove|git worktree prune|orca worktree rm/
  check('R: the Workflow publisher reclaims the ticket\'s exact paths with git', /\/wt\/impl:#10 → ticket\/10/.test(wf) && /`git worktree remove --force <path>`/.test(wf) && /git worktree prune/.test(wf) && !/orca worktree rm/.test(wf), wf.slice(0, 1500))
  check('R: the Workflow finalize reclaims what the lane did not', /\/wt\/publish-11 → ticket\/11/.test(onWorkflow.calls.find((c) => c.label === 'finalize').prompt), '')
  check('R: no Orca prompt names a worktree to reclaim or a way to remove one', !onOrca.calls.some((c) => reclaimCmd.test(c.prompt) || / → ticket\/\d+\n/.test(c.prompt)), [...new Set(onOrca.calls.filter((c) => reclaimCmd.test(c.prompt)).map((c) => c.label))].join(' | '))
  check('R: the Orca publisher is told to remove no worktree', /Remove no worktree/.test(orca) && /Never remove it: the operator decides at the end of the run/.test(orca), orca.slice(0, 1500))
  check('R: a session agent is told its worktree is a child of the run\'s', /a child worktree of this run's worktree, per agent, made by this run's session host/.test(onOrca.calls.find((c) => c.label === 'impl:#10').prompt), '')
  check('R: no Orca prompt guesses strays from harness paths', !onOrca.calls.some((c) => /not in the ledger/.test(c.prompt)), '')
  check('R: the Orca run completes', onOrca.result.state.startsWith('complete'), onOrca.result.state)
  // A publish that fails halts the run: nothing is reclaimed on either runner.
  const unpublished = { publish: () => ({ published: false, note: 'push rejected', worktree: '/wt/publish-10', worktrees_removed: 0, worktrees_kept: [] }) }
  const wfNone = await onRunner('workflow', unpublished)
  const orcaNone = await onRunner('session', unpublished)
  check('R: a failed publish halts the run on either runner', wfNone.result.halted === true && orcaNone.result.halted === true && wfNone.result.tickets.find((x) => x.ticket === 10).state === 'failed', JSON.stringify(wfNone.result.tickets))
  check('R: a halted run starts no reclaim agent on either runner — a resume carries its worktrees on', ![...wfNone.calls, ...orcaNone.calls].some((c) => c.label === 'reclaim'), wfNone.calls.map((c) => c.label).join(' | '))
  // One template, one rendering: the runner value is the only difference.
  const diff = render('workflow').split('\n').filter((l, i) => l !== render('session').split('\n')[i])
  check('R: the rendered script differs between runners only in RUNNER', diff.length === 1 && /^const RUNNER = 'workflow'/.test(diff[0]), diff.join(' | '))
}

// --- scenario O: the run order is rendered, and the Workflow runner refuses sequential
{
  check('O: the run order reaches the script', /^const RUN_ORDER = 'sequential'/m.test(render('session', 'sequential')) && /^const RUN_ORDER = 'parallel'/m.test(render('workflow')), '')
  const refused = await run({}, { runner: 'workflow', runOrder: 'sequential' }).then(() => null, (e) => e)
  check('O: the Workflow runner refuses a sequential run, and says why', refused && /needs the session runner/.test(refused.message) && /cannot point two agents at one folder/.test(refused.message), refused?.message ?? 'it ran')
  const seq = await run({}, { runner: 'session', runOrder: 'sequential' })
  check('O: a sequential run on the session runner loads and completes', seq.result.state.startsWith('complete'), seq.result.state)
}

// --- scenario S: sequential order builds one ticket at a time --------------
// The graph lists its tickets out of map order on purpose: the scheduler must
// sort, not walk the list. #14 sits second in the map but waits on #13; #11
// and #15 are unplaced (map_position 0), so they go last, lowest number first.
{
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms))
  const ticket = (number, map_position, blocked_by = []) => ({ number, title: 'T' + number, map_position, blocked_by, needs_human: false, human_reason: '' })
  const graph = () => ({
    tickets: [ticket(15, 0), ticket(11, 0), ticket(14, 2, [13]), ticket(13, 3), ticket(12, 1)],
    start_ref: 'main',
    explorations: [{ label: 'area-a', question: 'a?' }, { label: 'area-b', question: 'b?' }],
  })
  const overrides = {
    graph,
    explore: (label) => later(5, `/tmp/n/${label}.md`),
    impl: (label) => later(5, { branch: 'ticket/' + label.match(/#(\d+)/)[1], summary: 's', unmet: [] }),
    review: () => ({ findings: [{ severity: 'major', location: 'c.js:3', issue: 'two helpers', fix: 'merge them' }, { severity: 'major', location: 'd.js:4', issue: 'two contracts', fix: 'pick one' }] }),
    fixdispatch: (label, prompt) => ({ slices: locationsIn(prompt).map((l) => ({ title: l, brief: `- ${l} — ${issueFor(l)}`, findings: [l], effort: 'medium' })) }),
  }
  const ticketsOf = (calls) => calls.filter((c) => c.label.startsWith('dispatch:#')).map((c) => Number(c.label.match(/#(\d+)/)[1]))
  const { result, calls, timeline } = await run(overrides, { runner: 'session', runOrder: 'sequential' })
  const seq = calls.map((c) => c.label)
  const order = ticketsOf(calls)
  const before = (a, b) => timeline.includes(a) && timeline.indexOf(a) < timeline.indexOf(b)
  check("S: tickets are taken in the spec map's order, then the lowest number, blockers first", JSON.stringify(order) === '[12,13,14,11,15]', JSON.stringify(order))
  check('S: the stack is built in that order', JSON.stringify(result.stack_bottom_to_top.map((l) => l.split(':')[0])) === JSON.stringify(['#12', '#13', '#14', '#11', '#15', 'integration']), JSON.stringify(result.stack_bottom_to_top))
  const crowded = calls.filter((c) => !c.label.startsWith('explore') && c.alongside > 0).map((c) => c.label)
  check('S: outside Explore no agent ever runs beside another', !crowded.length, crowded.join(' | '))
  check('S: the explorers still run side by side', calls.filter((c) => c.label.startsWith('explore')).some((c) => c.alongside > 0), '')
  check("S: each ticket's publish returns before the next ticket's dispatch starts", order.slice(1).every((n, i) => before(`end publish:#${order[i]}`, `start dispatch:#${n}`)), timeline.join(' | '))
  const publishes = calls.filter((c) => c.label.startsWith('publish:'))
  check('S: no publisher prompt carries a rebase step', publishes.length === 6 && !publishes.some((c) => /git rebase/.test(c.prompt)), publishes.filter((c) => /git rebase/.test(c.prompt)).map((c) => c.label).join(' | '))
  check('S: the whole-stack review and its integration fixes run one agent at a time', before('end review:spec-224', 'start integration:dispatch') && before('end integration:dispatch', 'start integration:s1') && before('end integration:s1', 'start integration:s2') && before('end integration:s2', 'start publish:integration'), timeline.join(' | '))
  check('S: the sequential run completes', result.state.startsWith('complete'), result.state)

  // The same graph in parallel order: the frontier starts at once, map order unread.
  const par = await run(overrides, { runner: 'session' })
  const first = ticketsOf(par.calls).slice(0, 4).sort((a, b) => a - b)
  check('S: parallel order still dispatches every takeable ticket at once', JSON.stringify(first) === '[11,12,13,15]' && par.calls.some((c) => c.label.startsWith('dispatch:#') && c.alongside > 0) && par.result.state.startsWith('complete'), JSON.stringify(ticketsOf(par.calls)))

  const isolations = (calls) => [...new Set(calls.filter((c) => c.opts.isolation).map((c) => c.opts.isolation))]
  check('S: every agent that would get a worktree of its own runs in the chain worktree instead', JSON.stringify(isolations(calls)) === '["chain"]' && calls.filter((c) => c.opts.isolation).every((c) => /this run's one chain worktree/.test(c.prompt)), JSON.stringify(isolations(calls)))
  check('S: a parallel run still gives each its own', JSON.stringify(isolations(par.calls)) === '["worktree"]' && !par.calls.some((c) => /chain worktree/.test(c.prompt)), JSON.stringify(isolations(par.calls)))

  // A chain of blockers leaves a parallel run one order too: both publish the
  // same layers, each PR on the same base, linked by the same commands.
  const line = { ...overrides, graph: () => ({ tickets: [ticket(12, 3, [11]), ticket(11, 2, [10]), ticket(10, 1)], start_ref: 'main', explorations: [] }) }
  const published = ({ calls, result }) => ({
    stack: result.stack_bottom_to_top,
    layers: calls.filter((c) => c.label.startsWith('publish:')).map((c) => [c.label, c.prompt.match(/gh pr create[^\n]*/)?.[0] ?? null, c.prompt.match(/gh stack link [a-z][^\n`]*/)?.[0] ?? null]),
  })
  const seqLine = published(await run(line, { runner: 'session', runOrder: 'sequential' }))
  const parLine = published(await run(line, { runner: 'session' }))
  check('S: a sequential run publishes the same stack as a parallel one', seqLine.layers.length === 4 && JSON.stringify(seqLine) === JSON.stringify(parLine), JSON.stringify({ seqLine, parLine }))

  const failed = await run({ ...overrides, impl: (label) => (label.includes('#12') ? null : overrides.impl(label)) }, { runner: 'session', runOrder: 'sequential' })
  const st = Object.fromEntries(failed.result.tickets.map((x) => [x.ticket, x]))
  check('S: a failed ticket halts a sequential run with nothing else started', failed.result.halted === true && st[12].state === 'failed' && [11, 13, 14, 15].every((n) => st[n].state === 'not started') && !failed.calls.some((c) => /#1[1345]\b/.test(c.label)), JSON.stringify(failed.result.tickets))

  const cycle = await run({ graph: () => ({ tickets: [ticket(10, 1, [11]), ticket(11, 2, [10])], start_ref: 'main', explorations: [] }) }, { runner: 'session', runOrder: 'sequential' })
  check('S: a blocking cycle halts a sequential run instead of hanging it', cycle.result.halted === true && cycle.result.tickets.every((x) => x.state === 'not started' && /cycle/.test(x.detail)), JSON.stringify(cycle.result.tickets))
}

// --- run-wide: every prompt of every scenario ------------------------------
{
  const offenders = (re) => [...new Set(EVERY_CALL.filter((c) => re.test(c.prompt)).map((c) => c.label))].join(' | ')
  const noForce = /--force(?!` or `--force-with-lease` to any push)/
  check('ALL: no prompt tells an agent to force-push', !EVERY_CALL.some((c) => noForce.test(c.prompt.replace(/^- Never pass.*$/gm, '').replace(/git worktree remove --force|orca worktree rm --worktree path:<path> --force/g, ''))), offenders(/--force-with-lease origin|--force origin/))
  check('ALL: no prompt tells an agent to check a branch out', !EVERY_CALL.some((c) => /git checkout -B|git checkout ticket\//.test(c.prompt)), offenders(/git checkout -B/))
  check('ALL: no prompt interpolates an object instead of a value', !EVERY_CALL.some((c) => c.prompt.includes('[object Object]')), offenders(/\[object Object\]/))
  check('A: a publisher that cannot publish hands the operator a decision, so a resume carries its session on', /`decisions_needed`/.test(EVERY_RUN[0].find((c) => c.label === 'publish:#10').prompt) && EVERY_RUN[0].find((c) => c.label === 'publish:#10').opts.schema.required.includes('decisions_needed'), '')
  check('A: the dispatcher names the research notes by path', EVERY_RUN[0].find((c) => c.label === 'dispatch:#10').prompt.includes('/tmp/n/01-area-a.md'), '')
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
  const unnamed = EVERY_RUN.flatMap((calls) => calls.filter((c) => typeof c.opts.node !== 'string' || !c.opts.node)).map((c) => c.label)
  check('ALL: every agent() call names its node', !unnamed.length, [...new Set(unnamed)].join(' | '))
  const dupes = EVERY_RUN.flatMap((calls) => nodesOf(calls).filter((n, i, a) => n && a.indexOf(n) !== i))
  check('ALL: node names are unique within a run', !dupes.length, [...new Set(dupes)].join(' | '))
  check('ALL: every scenario contributed prompts', EVERY_CALL.length > 60, String(EVERY_CALL.length))
}

for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '   [' + c.detail + ']'))
console.log(checks.every((c) => c.ok) ? '\nALL PASS (' + checks.length + ' checks)' : '\nFAILURES PRESENT')
