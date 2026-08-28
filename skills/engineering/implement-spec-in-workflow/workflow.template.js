export const meta = {
  name: 'implement-spec-__SPEC__',
  description: 'Implement spec #__SPEC__ as one PR: discover the ticket graph, implement each ticket in its own worktree, merge serially, review, ready the PR',
  phases: [
    { title: 'Graph', detail: 'read the spec and its tickets, return the task graph' },
    { title: 'Explore', detail: 'research notes saved outside the repo' },
    { title: 'Setup', detail: 'PR branch and draft PR' },
    { title: 'Implement', detail: 'one worktree agent per ticket, frontier-scheduled' },
    { title: 'Gate', detail: 'code-review each ticket branch before it merges' },
    { title: 'Merge', detail: 'serial merge lane onto the PR branch' },
    { title: 'Review', detail: 'code-review the merged PR branch, then one fixer' },
    { title: 'Finalize', detail: 'ready or hold the PR, prune worktrees' },
  ],
}

// ---- interpolated by the skill ------------------------------------------
const REPO = '__REPO__'                            // owner/name
const SPEC = __SPEC__                              // spec issue number
const REPO_DIR = String.raw`__REPO_DIR__`          // main checkout
const NOTES_DIR = String.raw`__NOTES_DIR__`        // research notes, outside the repo
const BASE_REF = '__BASE_REF__'                    // branch the PR merges into
const PR_BRANCH = 'spec/__SPEC__'
// -------------------------------------------------------------------------

const M = { model: 'opus' }
const POINTERS = `Repo ${REPO}, checkout ${REPO_DIR}. Spec: \`gh issue view ${SPEC}\`. Research notes: ${NOTES_DIR}.`

const GRAPH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tickets', 'start_ref', 'explorations'],
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'title', 'blocked_by', 'needs_human', 'human_reason'],
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          blocked_by: { type: 'array', items: { type: 'integer' } },
          needs_human: { type: 'boolean' },
          human_reason: { type: 'string', description: 'empty when needs_human is false' },
        },
      },
    },
    start_ref: { type: 'string', description: 'branch or sha the PR branch starts from — an existing branch already carrying work for this spec, else the base ref' },
    explorations: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'question'],
        properties: { label: { type: 'string' }, question: { type: 'string' } },
      },
    },
  },
}

const SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr_url', 'pr_number', 'head_sha'],
  properties: { pr_url: { type: 'string' }, pr_number: { type: 'integer' }, head_sha: { type: 'string' } },
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'summary', 'tests_run', 'tests_green', 'unmet'],
  properties: {
    branch: { type: 'string' },
    summary: { type: 'string', description: 'one or two sentences' },
    tests_run: { type: 'string', description: 'the exact command(s) run' },
    tests_green: { type: 'boolean' },
    unmet: { type: 'array', items: { type: 'string' }, description: 'acceptance criteria from the ticket that were not satisfied — empty when all are met' },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merged', 'conflicts_resolved', 'head_sha', 'note'],
  properties: {
    merged: { type: 'boolean' },
    conflicts_resolved: { type: 'array', items: { type: 'string' } },
    head_sha: { type: 'string' },
    note: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'location', 'issue', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          location: { type: 'string', description: 'path:line' },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'issue', 'action', 'reason'],
        properties: {
          location: { type: 'string', description: 'path:line, copied from the finding' },
          issue: { type: 'string', description: 'the finding, copied verbatim' },
          action: { type: 'string', enum: ['fixed', 'rejected'] },
          reason: { type: 'string', description: 'what you changed, or — when rejected — the specific checkable reason the finding is wrong' },
        },
      },
    },
  },
}

// --- step 1: read the spec and tickets, understand the task graph ---------
phase('Graph')
const graph = await agent(
  `Read spec issue #${SPEC} in ${REPO} and every ticket that implements it, and return the task graph.

${POINTERS}

Find the tickets: sub-issues of #${SPEC}, issues that reference #${SPEC}, and issues linked from the spec body. Search each way — GitHub's sub-issue and dependency APIs are often empty even when the tickets exist.

Blocking relationships are usually prose, not API state: read each ticket's "Blocked by" section (or equivalent) and resolve it to issue numbers. A dependency the ticket calls soft or tests-only is still a dependency — record it.

Set needs_human on a ticket that cannot be completed by an agent alone: it needs hardware, a running game, a physical device, credentials only a person holds, or its label says so. Put the reason in human_reason.

start_ref: if work for this spec already sits on a branch (the spec or a ticket names one, or a branch exists whose commits are for this spec), return that branch — the PR must build on it rather than orphan it. Otherwise return "${BASE_REF}".

explorations: propose up to 4 research questions whose answers every implementer will need — the code paths, the external API contracts, the existing test arrangement. Ask what is expensive to discover, not what a ticket already states.`,
  { ...M, phase: 'Graph', schema: GRAPH_SCHEMA, label: `graph:spec-${SPEC}` },
)
if (!graph) throw new Error('graph discovery failed')

const all = graph.tickets
const byNum = new Map(all.map((t) => [t.number, t]))
const blocked = new Set()
for (let pass = 0; pass < all.length + 1; pass++) {
  for (const t of all) {
    if (t.needs_human) blocked.add(t.number)
    if (t.blocked_by.some((d) => blocked.has(d))) blocked.add(t.number)
  }
}
const auto = all.filter((t) => !blocked.has(t.number))
const deferred = all.filter((t) => blocked.has(t.number))
log(`${all.length} tickets. Automating ${auto.map((t) => '#' + t.number).join(', ') || 'none'}.`)
if (deferred.length) {
  log(`Deferred to a human: ${deferred.map((t) => '#' + t.number + (t.needs_human ? '' : ' (downstream)')).join(', ')}`)
}
if (!auto.length) return { spec: SPEC, error: 'every ticket needs a human', deferred: deferred.map((t) => t.number) }

// --- step 2: exploration subagents, notes saved outside the repo ----------
phase('Explore')
const notes = (await parallel(
  graph.explorations.map((e, i) => () =>
    agent(
      `Research this question against the codebase and any external docs it needs, then save your findings as markdown.

Question: ${e.question}

${POINTERS}

Write your notes to ${NOTES_DIR}/${String(i + 1).padStart(2, '0')}-${e.label.replace(/[^a-zA-Z0-9._-]/g, '-')}.md (create the directory if absent — it lives outside the repo on purpose, so create no files inside the checkout). Cite file:line for every claim. Later agents read this instead of re-deriving it, so record what is expensive to find and skip what the tickets already say.

Return the absolute path you wrote.`,
      { ...M, phase: 'Explore', label: `explore:${e.label}` },
    ),
  ),
)).filter(Boolean)
log(`${notes.length} research notes in ${NOTES_DIR}`)

// --- step 3: branch and draft PR, closing the spec and its tickets --------
phase('Setup')
const closes = [SPEC, ...auto.map((t) => t.number)].map((n) => `Closes #${n}`).join('\n')
const setup = await agent(
  `Create the branch and the draft PR for spec #${SPEC}.

${POINTERS}

1. Fetch, then create branch \`${PR_BRANCH}\` from \`${graph.start_ref}\` and push it to origin.
2. Put one empty commit on it (\`git commit --allow-empty\`) so the PR has a diff to open against \`${BASE_REF}\`.
3. Open a DRAFT PR: head \`${PR_BRANCH}\`, base \`${BASE_REF}\`, title from the spec's title. The body must state that it implements spec #${SPEC} and must contain these lines verbatim:

${closes}

${deferred.length ? `Also note in the body that #${deferred.map((t) => t.number).join(', #')} are deliberately excluded and stay open for a human.` : ''}

Do not disturb the user's working copy: leave ${REPO_DIR}'s checked-out branch and its uncommitted changes exactly as you found them. Work through a worktree or through plain \`git push\` refspecs.

Return the PR url, its number, and the head sha.`,
  { ...M, phase: 'Setup', schema: SETUP_SCHEMA, isolation: 'worktree', label: `setup:${PR_BRANCH}` },
)
if (!setup) throw new Error('setup failed — no PR branch')
log(`Draft PR ${setup.pr_url}`)

// --- steps 4-6: frontier scheduling, own worktree each, serial merge lane -
const notesLine = notes.length ? `Research notes (read these before exploring anything yourself): ${notes.join(', ')}.` : ''
const merged = []

let mergeLane = Promise.resolve()
function enqueueMerge(t, impl) {
  const run = mergeLane.then(() =>
    agent(
      `Merge ticket #${t.number}'s work onto the PR branch.

${POINTERS}
PR: ${setup.pr_url} — branch \`${PR_BRANCH}\`.
Ticket branch: \`${impl.branch}\` (\`gh issue view ${t.number}\` for what it was meant to do).
Already merged onto ${PR_BRANCH}: ${merged.length ? merged.map((n) => '#' + n).join(', ') : 'nothing yet'}.

Fetch, check out \`${PR_BRANCH}\` fresh from origin, merge the ticket branch into it, resolve any conflict in favour of keeping BOTH tickets' behaviour, run the tests the ticket branch ran, and push \`${PR_BRANCH}\`.

You are the only agent touching ${PR_BRANCH} right now, so a force-free \`git push\` must succeed; if it is rejected, re-fetch and redo the merge rather than forcing.

Return whether it merged, what you resolved, and the new head sha.`,
      { ...M, phase: 'Merge', schema: MERGE_SCHEMA, isolation: 'worktree', label: `merge:#${t.number}` },
    ).then((r) => {
      if (!r || !r.merged) throw new Error(`merge of #${t.number} failed: ${r ? r.note : 'agent died'}`)
      merged.push(t.number)
      log(`merged #${t.number} — ${merged.length}/${auto.length}`)
      return r
    }),
  )
  mergeLane = run.then(() => {}, () => {})
  return run
}

// A ticket is reviewed on its own branch, against its own ticket, while its diff is
// small and its author's reasoning is still recoverable. Review and fix alternate until
// a review comes back with nothing blocking — a fresh reviewer each round, so "clean"
// is a verdict rather than a reviewer running out of patience.
//
// The loop's real hazard is not slow convergence, it is ping-pong: a fixer judges a
// finding wrong and leaves the code, the next reviewer raises it again, forever. So a
// rejection is a first-class outcome — it is carried into every later round with its
// reason, and a reviewer may only re-raise it by falsifying that reason.
const GATE_MAX_ROUNDS = 4
async function reviewGate(t, impl) {
  const rejected = []
  for (let round = 1; round <= GATE_MAX_ROUNDS; round++) {
    const r = await agent(
      `Review ticket #${t.number}'s branch before it merges.

${POINTERS}
Branch \`${impl.branch}\`, reviewed against \`origin/${PR_BRANCH}\` — that diff is the whole of this ticket's work.
What the ticket asked for: \`gh issue view ${t.number}\`. What the implementer says it did: ${impl.summary}

\`git fetch origin\`, then invoke the \`code-review\` skill with \`origin/${PR_BRANCH}\` as the fixed point and ticket #${t.number} as the spec — both its axes: does it follow this repo's documented standards, and does it do what the ticket asked for, acceptance criterion by acceptance criterion.

Judge this ticket's diff. Work another ticket owns is out of scope; the merged branch gets its own review later. Change no code — report.
${rejected.length
        ? `
A previous round already raised the findings below, and the implementer judged each one wrong for the stated reason. Raise one again only if you can show its reason is false — say which part is false and why. Otherwise leave it out entirely.

${rejected.map((v) => `- ${v.location} — ${v.issue}\n  judged wrong because: ${v.reason}`).join('\n')}`
        : ''}`,
      { ...M, phase: 'Gate', schema: REVIEW_SCHEMA, isolation: 'worktree', label: `gate:#${t.number}:r${round}` },
    )
    const blocking = r ? r.findings.filter((f) => f.severity !== 'minor') : []
    if (!blocking.length) {
      log(`#${t.number} gate clean${round > 1 ? ` after ${round} rounds` : ''}${rejected.length ? `, ${rejected.length} finding(s) rejected` : ''}`)
      return []
    }
    if (round === GATE_MAX_ROUNDS) {
      log(`#${t.number} merges with ${blocking.length} unresolved finding(s) — gate hit ${GATE_MAX_ROUNDS} rounds`)
      return blocking
    }
    log(`#${t.number} gate round ${round}: ${blocking.length} blocking`)
    const fix = await agent(
      `Fix what the review raised on ticket #${t.number}'s branch.

${POINTERS}
\`git fetch origin && git checkout ${impl.branch}\`.

${blocking.map((f) => `- [${f.severity}] ${f.location} — ${f.issue} → ${f.fix}`).join('\n')}

Fix them. Stay inside ticket #${t.number}'s scope — unless a finding's real cause sits outside it, in which case fix it there and say so.

A finding you believe is wrong: leave the code alone and return it as rejected with the reason it is wrong. That reason goes to the next reviewer, who may only raise it again by falsifying it — so make the reason specific and checkable, and reject only what you are confident about. Everything you do not reject, you have fixed.

Run the repo's tests, get them green, commit, and push \`${impl.branch}\`.

Return one verdict per finding above.`,
      { ...M, phase: 'Gate', schema: FIX_SCHEMA, isolation: 'worktree', label: `gate-fix:#${t.number}:r${round}` },
    )
    if (!fix) throw new Error(`gate fixer for #${t.number} died at round ${round}`)
    for (const v of fix.verdicts.filter((v) => v.action === 'rejected')) {
      if (!rejected.some((p) => p.location === v.location && p.issue === v.issue)) rejected.push(v)
    }
  }
  return []
}

const memo = new Map()
function ticketDone(n) {
  if (!memo.has(n)) {
    const t = byNum.get(n)
    memo.set(
      n,
      (async () => {
        await Promise.all(t.blocked_by.filter((d) => byNum.has(d) && !blocked.has(d)).map(ticketDone))
        const impl = await agent(
          `Implement ticket #${t.number} — ${t.title}.

${POINTERS}
${notesLine}
PR branch: \`${PR_BRANCH}\` (spec #${SPEC}). Already merged into it: ${merged.length ? merged.map((x) => '#' + x).join(', ') : 'nothing yet'}.

First: \`git fetch origin && git checkout -B ticket/${t.number} origin/${PR_BRANCH}\` — your worktree starts on the wrong ref, and everything merged before you lives on ${PR_BRANCH}.

Read \`gh issue view ${t.number}\` for the work and its acceptance criteria, and the spec for the surrounding decisions. Implement it, follow the repo's own conventions and CLAUDE.md, and satisfy every acceptance criterion in the ticket. Stay inside this ticket's scope — a neighbouring ticket has its own agent.

Run the repo's tests for what you touched and get them green. Commit to \`ticket/${t.number}\` and push it to origin.

Return your branch, a one-line summary, the test command and its result, and any acceptance criterion you could not meet.`,
          { ...M, phase: 'Implement', schema: IMPL_SCHEMA, isolation: 'worktree', label: `impl:#${t.number}` },
        )
        if (!impl) throw new Error(`implementer for #${t.number} died`)
        if (impl.unmet.length) log(`#${t.number} unmet: ${impl.unmet.join('; ')}`)
        const unfixed = await reviewGate(t, impl)
        await enqueueMerge(t, impl)
        return { number: t.number, ...impl, unfixed }
      })(),
    )
  }
  return memo.get(n)
}

phase('Implement')
const outcomes = await Promise.all(
  auto.map((t) => ticketDone(t.number).catch((e) => ({ number: t.number, failed: String(e && e.message ? e.message : e) }))),
)
const failed = outcomes.filter((o) => o.failed)
if (failed.length) log(`FAILED: ${failed.map((o) => '#' + o.number).join(', ')}`)

// --- step 7: code-review the PR branch, fix everything in one implementer -
phase('Review')
const review = await agent(
  `Review the whole merged PR branch for spec #${SPEC}.

${POINTERS}
PR: ${setup.pr_url}. Review \`${BASE_REF}...${PR_BRANCH}\` — everything the spec's tickets added.

Invoke the \`code-review\` skill with \`${BASE_REF}\` as the fixed point and spec #${SPEC} as the spec — both its axes: this repo's documented standards, and whether the branch matches what the spec and its tickets asked for.

Every ticket was already reviewed alone on its own branch, so look hardest at what that could not see: two implementations of one helper, abstractions that contradict each other, a contract one ticket relies on that another changed. Return every finding; change no code yourself.`,
  { ...M, phase: 'Review', schema: REVIEW_SCHEMA, isolation: 'worktree', label: `review:${PR_BRANCH}` },
)
const findings = review ? review.findings : []
log(`code review: ${findings.length} findings`)

let fix = null
if (findings.length) {
  fix = await agent(
    `Fix every issue the code review raised on the PR branch for spec #${SPEC}.

${POINTERS}
PR: ${setup.pr_url}.

\`git fetch origin && git checkout -B review-fixes origin/${PR_BRANCH}\`.

Findings:
${findings.map((f) => `- [${f.severity}] ${f.location} — ${f.issue} → ${f.fix}`).join('\n')}

Fix all of them. Where a finding is wrong, say so in your report rather than changing code to satisfy it. Run the repo's tests, get them green, commit, and push directly to \`${PR_BRANCH}\`.

Return one line per finding: fixed, or rejected and why.`,
    { ...M, phase: 'Review', isolation: 'worktree', label: 'fix:review' },
  )
}

// --- steps 8-9: ready or hold the PR, then clean up the worktrees --------
phase('Finalize')
const holdReason = deferred.length
  ? `it still needs human-only work: ${deferred.map((t) => `#${t.number}${t.human_reason ? ` (${t.human_reason})` : ' (downstream of a human ticket)'}`).join(', ')}`
  : failed.length
    ? `these tickets did not land: ${failed.map((o) => `#${o.number} — ${o.failed}`).join('; ')}`
    : ''
const finalize = await agent(
  `Finalize the PR for spec #${SPEC} and clean up.

${POINTERS}
PR: ${setup.pr_url}.

${holdReason
    ? `Leave the PR as a DRAFT and comment on it explaining that it is held because ${holdReason}. Say exactly what a human has to do next.`
    : `Mark the PR ready for review (\`gh pr ready\`).`}

Then clean up every worktree this run created: \`git worktree list\`, remove the ones under \`.claude/worktrees\` created for spec #${SPEC} (setup, ticket/*, merge, review, fix), and \`git worktree prune\`. Leave the user's own checkout and any worktree you did not create alone. Delete no branches — the PR and its ticket branches stay.

Return one line: the PR's state, and how many worktrees you removed.`,
  { ...M, phase: 'Finalize', label: 'finalize' },
)

return {
  spec: SPEC,
  pr: setup.pr_url,
  state: holdReason ? 'draft (held)' : 'ready for review',
  held_because: holdReason || null,
  merged,
  gate_unfixed: outcomes
    .filter((o) => o.unfixed && o.unfixed.length)
    .map((o) => ({ ticket: o.number, findings: o.unfixed.map((f) => `[${f.severity}] ${f.location} — ${f.issue}`) })),
  failed: failed.map((o) => ({ ticket: o.number, error: o.failed })),
  deferred_to_human: deferred.map((t) => ({ ticket: t.number, reason: t.human_reason || 'downstream of a human ticket' })),
  review_findings: findings.length,
  review_fix: fix,
  notes: NOTES_DIR,
  finalize,
}
