export const meta = {
  name: 'implement-spec-__SPEC__',
  description: 'Implement spec #__SPEC__ as a stack of PRs: discover the ticket graph, implement each ticket in its own worktree, gate it, publish it as one stacked PR, review the whole stack, register it',
  phases: [
    { title: 'Graph', detail: 'read the spec and its tickets, return the task graph' },
    { title: 'Explore', detail: 'research notes saved outside the repo' },
    { title: 'Setup', detail: 'layer-0 PR when prior work already sits on a branch' },
    { title: 'Implement', detail: 'a dispatcher sizes each ticket; fresh slice agents implement it, frontier-scheduled' },
    { title: 'Gate', detail: 'code-review each ticket branch before it is published' },
    { title: 'Stack', detail: 'serial publish lane: rebase onto the tip, one draft PR per ticket' },
    { title: 'Review', detail: 'code-review the whole stack; fixes land as the top PR' },
    { title: 'Finalize', detail: 'register the stack, ready the PRs, prune worktrees' },
  ],
}

// ---- interpolated by the skill ------------------------------------------
const REPO = '__REPO__'                            // owner/name
const SPEC = __SPEC__                              // spec issue number
const REPO_DIR = String.raw`__REPO_DIR__`          // main checkout
const NOTES_DIR = String.raw`__NOTES_DIR__`        // research notes, outside the repo
const BASE_REF = '__BASE_REF__'                    // branch the stack merges into
const STACK_MODE = '__STACK_MODE__'                // 'native' (gh-stack + stacks API) or 'chain' (plain --base chain)
// -------------------------------------------------------------------------

const M = { model: 'opus' }
const POINTERS = `Repo ${REPO}, checkout ${REPO_DIR}. Spec: \`gh issue view ${SPEC}\`. Research notes: ${NOTES_DIR}.`
// A ref as agents must address it: sha as-is, branch via origin — local branch
// state in a throwaway worktree is meaningless.
const q = (ref) => (/^[0-9a-f]{7,40}$/.test(ref) ? ref : `origin/${ref}`)

// Context economy, told to every agent that reads or edits code. A minor lever
// by measurement (~5% of a heavy agent's context was repeat reads — the
// structural savings live in the dispatcher and its briefs), but free to state.
const ECONOMY = `Context economy — your context is re-read every turn, so never put the same bytes in twice:
- Read source with \`Read\` and its offset/limit slices; never \`cat\` a file into the transcript.
- Never re-read a file or a range you already read — including one you just edited; the edit applied.
- One wide read beats several narrow overlapping ones.
- Decide a file's whole change before touching it and land it in as few edits as you can.
- Run tests in the repo's quietest failures-only form, and re-run only after you changed something.`

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
    start_ref: { type: 'string', description: 'branch already carrying work for this spec — it becomes the bottom layer of the stack; else the base ref' },
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

const LAYER0_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr_url', 'pr_number'],
  properties: { pr_url: { type: 'string' }, pr_number: { type: 'integer' } },
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

const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket_brief', 'slices'],
  properties: {
    ticket_brief: { type: 'string', description: 'one short paragraph on the whole ticket, for later fix agents — they read this instead of the issue' },
    slices: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'brief', 'effort'],
        properties: {
          title: { type: 'string' },
          brief: { type: 'string', description: 'self-contained: the goal, the acceptance criteria this slice covers, the files it touches, and every constraint from ticket/spec/notes that bears on it — its implementer reads no issue and no spec' },
          effort: { type: 'string', enum: ['medium', 'high'], description: 'reasoning effort for the slice implementer' },
        },
      },
    },
  },
}

const PUBLISH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['published', 'pr_url', 'pr_number', 'conflicts_resolved', 'note'],
  properties: {
    published: { type: 'boolean' },
    pr_url: { type: 'string' },
    pr_number: { type: 'integer' },
    conflicts_resolved: { type: 'array', items: { type: 'string' } },
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
  required: ['verdicts', 'overflow'],
  properties: {
    overflow: { type: 'array', items: { type: 'string' }, description: '"location — issue" lines for findings too large to fix in this agent\'s remaining context — empty normally' },
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

const INTEGRATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr_url', 'pr_number', 'branch', 'verdicts'],
  properties: {
    pr_url: { type: 'string' },
    pr_number: { type: 'integer' },
    branch: { type: 'string' },
    verdicts: FIX_SCHEMA.properties.verdicts,
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

start_ref: if work for this spec already sits on a branch (the spec or a ticket names one, or a branch exists whose commits are for this spec), return that branch — it becomes the bottom layer of the stack rather than being orphaned. Otherwise return "${BASE_REF}".

explorations: propose up to 4 research questions whose answers implementers will need — the code paths, the external API contracts, the existing test arrangement. A question need not serve every ticket: give each a label that names its subject plainly, so an implementer can tell whether it bears on their ticket. Ask what is expensive to discover, not what a ticket already states.`,
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

Keep the note under 300 lines. Every reader ingests it whole at full price, so cite file:line and name what the code does rather than quoting it back — they can read the code; the note saves them the search, not the reading.

${ECONOMY}

Return the absolute path you wrote.`,
      { ...M, effort: 'low', phase: 'Explore', label: `explore:${e.label}` },
    ),
  ),
)).filter(Boolean)
log(`${notes.length} research notes in ${NOTES_DIR}`)

// --- step 3: layer 0 — prior work becomes the bottom of the stack --------
// The stack's whole-stack merge lands on BASE_REF, and a `Closes #N` only fires
// on a merge into the default branch — so prior work must ride IN the stack,
// as its own layer with its own PR, not be the branch the stack merges into.
phase('Setup')
const hasLayer0 = graph.start_ref !== BASE_REF
let layer0 = null
if (hasLayer0) {
  layer0 = await agent(
    `Open the layer-0 PR of the stack for spec #${SPEC}.

${POINTERS}

The branch \`${graph.start_ref}\` already carries work for this spec, done before this run. It becomes the bottom layer of the stack. \`git fetch origin\`, confirm the branch exists on origin (push it from the local checkout if it only exists locally — plain push, no force), then open a DRAFT PR: head \`${graph.start_ref}\`, base \`${BASE_REF}\`, title from the branch's work. The body must say plainly that this PR carries pre-existing work for spec #${SPEC} that this run did not implement or gate — the operator should review it with that in mind.

Do not disturb the user's working copy: leave ${REPO_DIR}'s checked-out branch and its uncommitted changes exactly as you found them.

Return the PR url and number.`,
    { ...M, effort: 'low', phase: 'Setup', schema: LAYER0_SCHEMA, isolation: 'worktree', label: `layer0:${graph.start_ref}` },
  )
  if (!layer0) throw new Error('layer-0 PR failed — prior work would be orphaned')
  log(`Layer 0: ${layer0.pr_url} (pre-existing work on ${graph.start_ref})`)
}

// --- steps 4-6: frontier scheduling, gate, then the serial publish lane ---
// Not "read all of these first": the notes exist to save exploration, and a
// ticket that needs one of the four should not pay for the other three.
const notesLine = notes.length ? `Research notes for this spec: ${notes.join(', ')}. Their filenames name their subjects. Read the ones whose subject bears on this ticket — once each — instead of re-deriving that ground yourself, and skip the rest.` : ''

// --- the dispatcher: the agent expert at sizing a ticket's work -----------
// A single long-lived implementer accumulates every read and every thought for
// its whole life and pays for them again on each turn (one measured run: 276
// turns, 362K peak context). The dispatcher resets that: it reads the ticket
// ONCE, decides how many fresh-context agents the work actually needs — one is
// the normal answer — and writes each a self-contained brief, so slice
// implementers read no issue and no spec. Under-slicing self-corrects (an
// overrun comes back here as a remainder to re-slice); over-slicing has no
// corrective, so the dispatcher is biased against slicing. It is also the
// universal overflow handler: a gate fixer that outgrows its context hands its
// remainder here too.
const MAX_DISPATCH_ROUNDS = 3

function dispatch(t, remainder) {
  return agent(
    `Slice ticket #${t.number} — ${t.title} — into the fewest implementation slices that fresh-context agents can finish, and write each slice's brief.

${POINTERS}
${notesLine}
${remainder ? `
Earlier agents already did part of this work — branch \`ticket/${t.number}\` carries what they pushed. Slice ONLY what remains: ${remainder}` : ''}

Read \`gh issue view ${t.number}\` and the spec's decisions that bear on it, and skim the code's STRUCTURE only — file lists, signatures, grep hits. Read no implementations: the slices read the code; you size and brief them.

Default to ONE slice. Slice only when one agent plausibly cannot finish in roughly 70 tool calls; when unsure, do not slice. Slices run sequentially on one branch, so each must leave the branch consistent — building, tests green.

Each brief must be self-contained: its goal, the acceptance criteria it covers, the files it will touch, and every constraint from the ticket, the spec, and the notes that bears on it — its implementer reads none of those. Set each slice's effort: 'high' for the gnarly ones, 'medium' otherwise.

Also return ticket_brief: one short paragraph on the whole ticket, for later fix agents.`,
    { ...M, effort: 'high', phase: 'Implement', schema: DISPATCH_SCHEMA, label: `dispatch:#${t.number}${remainder ? ':re' : ''}` },
  )
}

async function runSlices(t, slices, { cutFrom, started, tag }) {
  const out = { started, summaries: [], last: null, unmet: [] }
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]
    const r = await agent(
      `Implement one slice of ticket #${t.number}: ${s.title}${slices.length > 1 ? ` (slice ${i + 1} of ${slices.length})` : ''}.

${POINTERS}

Your brief — the ticket is already distilled into it, so run no \`gh issue view\` and read no spec:
${s.brief}

First: \`git fetch origin && git checkout -B ticket/${t.number} ${out.started ? `origin/ticket/${t.number}\` — the branch already carries the earlier slices' pushed work` : `${q(cutFrom)}\` — your worktree starts on the wrong ref, and everything stacked before this ticket is reachable from there`}.

Follow the repo's own conventions and CLAUDE.md, and stay inside the brief — the rest of the ticket belongs to other slices. Comments only where load-bearing: why-not-what, landmines, pointers to external context; never narrate what code does.

${ECONOMY}

Past roughly 70 tool calls this slice has outgrown one agent's context. Stop cleanly: commit and push what works, and name what you did not reach in \`unmet\` — the dispatcher hands the remainder to a fresh agent. A named remainder is cheap; a 300-turn agent is not.

Run the repo's tests for what you touched and get them green. Commit to \`ticket/${t.number}\` and push it to origin (plain push — the branch has no PR yet).

Return the branch, a one-line summary, the test command and its result, and anything from the brief you did not reach in \`unmet\`.`,
      { ...M, effort: s.effort, phase: 'Implement', schema: IMPL_SCHEMA, isolation: 'worktree', label: `${tag}${slices.length > 1 ? `:s${i + 1}` : ''}` },
    )
    if (!r) throw new Error(`slice implementer for #${t.number} died (${s.title})`)
    out.started = true
    out.summaries.push(r.summary)
    out.last = r
    if (r.unmet.length) {
      // Later slices may depend on the unfinished part: stop the round and let
      // the dispatcher re-slice the whole remainder rather than build on sand.
      out.unmet.push(...r.unmet, ...slices.slice(i + 1).map((x) => `not started: ${x.title}`))
      break
    }
  }
  return out
}

// The stack, bottom to top. `tip` is the branch the next PR is based on.
// Publish-once: a branch is rebased and pushed only BEFORE its PR exists;
// after enqueuePublish resolves, nothing touches that branch again.
const stacked = []
let tip = hasLayer0 ? graph.start_ref : BASE_REF

let lane = Promise.resolve()
function enqueuePublish(t, impl, cutFrom) {
  const run = lane.then(() => {
    const base = tip
    return agent(
      `Publish ticket #${t.number}'s branch as the next PR of the stack for spec #${SPEC}.

${POINTERS}
Ticket branch: \`${impl.branch}\`, cut from \`${q(cutFrom)}\` (\`gh issue view ${t.number}\` for what it was meant to do).
Current stack tip: \`${base}\` — the branch your PR must be based on.
Stack so far, bottom to top: ${stacked.length ? stacked.map((s) => `#${s.number} (${s.branch})`).join(' → ') : hasLayer0 ? `layer 0 (${graph.start_ref})` : 'empty'}.

1. \`git fetch origin\`.
${cutFrom !== base ? `2. The tip moved since this ticket was cut. Replay its commits onto the tip: \`git rebase --onto ${q(base)} ${q(cutFrom)} ${impl.branch}\` (check the branch out from origin first). Resolve any conflict in favour of keeping BOTH tickets' behaviour. This branch has NO pull request yet — this is the last moment its history may be rewritten.
3. Run the tests the ticket branch ran (${impl.tests_run}); get them green.
4. Push: \`git push --force-with-lease origin ${impl.branch}\` — force-with-lease because the pre-rebase branch is already on origin; it has no PR and nothing is based on it, so this rewrites nothing published.` : `2. The tip has not moved: the branch already sits on \`${q(base)}\`. No rebase. Confirm the branch is pushed to origin as-is.
3. Run the tests the ticket branch ran (${impl.tests_run}); confirm green.
4. Nothing to push beyond what is already on origin.`}
5. Open a DRAFT PR: \`gh pr create --draft --head ${impl.branch} --base ${base}\` — \`--base\` takes the branch name. Title = the ticket's title. The body must contain the line \`Closes #${t.number}\` and state that it is part of the stack for spec #${SPEC}.

You are the only agent publishing right now. After the PR exists, the branch is published: nothing may ever push to it again.

Return whether it published, the PR url and number, what you resolved, and any note.`,
      { ...M, effort: 'low', phase: 'Stack', schema: PUBLISH_SCHEMA, isolation: 'worktree', label: `publish:#${t.number}` },
    ).then((r) => {
      if (!r || !r.published) throw new Error(`publish of #${t.number} failed: ${r ? r.note : 'agent died'}`)
      stacked.push({ number: t.number, branch: impl.branch, pr_url: r.pr_url, pr_number: r.pr_number })
      tip = impl.branch
      log(`stacked #${t.number} → ${r.pr_url} — ${stacked.length}/${auto.length}`)
      return r
    })
  })
  lane = run.then(() => {}, () => {})
  return run
}

// A ticket is reviewed on its own still-unpublished branch, against the base it
// was cut from, while its diff is small and its author's reasoning is still
// recoverable. Review and fix alternate until a review comes back with nothing
// blocking — a fresh reviewer each round, so "clean" is a verdict rather than a
// reviewer running out of patience. Fixes land before the branch becomes a PR,
// so the gate never touches published history.
//
// The loop's real hazard is not slow convergence, it is ping-pong: a fixer
// judges a finding wrong and leaves the code, the next reviewer raises it
// again, forever. So a rejection is a first-class outcome — it is carried into
// every later round with its reason, and a reviewer may only re-raise it by
// falsifying that reason.
const GATE_MAX_ROUNDS = 4
async function reviewGate(t, impl, cutFrom, ticketBrief) {
  const rejected = []
  for (let round = 1; round <= GATE_MAX_ROUNDS; round++) {
    const r = await agent(
      `Review ticket #${t.number}'s branch before it is published as a PR.

${POINTERS}
Branch \`${impl.branch}\`, reviewed against \`${q(cutFrom)}\` — that diff is the whole of this ticket's work.
What the ticket asked for: \`gh issue view ${t.number}\`. What the implementer says it did: ${impl.summary}

\`git fetch origin\`, then invoke the \`code-review\` skill with \`${q(cutFrom)}\` as the fixed point and ticket #${t.number} as the spec — both its axes: does it follow this repo's documented standards, and does it do what the ticket asked for, acceptance criterion by acceptance criterion.

Judge this ticket's diff. Work another ticket owns is out of scope; the whole stack gets its own review later. Change no code — report.
${impl.unmet.length ? `
The implementer already declared these criteria unmet — they are carried to the operator, so report them without re-litigating: ${impl.unmet.join('; ')}` : ''}
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
      log(`#${t.number} publishes with ${blocking.length} unresolved finding(s) — gate hit ${GATE_MAX_ROUNDS} rounds`)
      return blocking
    }
    log(`#${t.number} gate round ${round}: ${blocking.length} blocking`)
    const fix = await agent(
      `Fix what the review raised on ticket #${t.number}'s branch.

${POINTERS}
The ticket, distilled (read this instead of the issue): ${ticketBrief}

\`git fetch origin && git checkout ${impl.branch}\`.

${blocking.map((f) => `- [${f.severity}] ${f.location} — ${f.issue} → ${f.fix}`).join('\n')}

Fix them. Stay inside ticket #${t.number}'s scope — unless a finding's real cause sits outside it, in which case fix it there and say so.

A finding you believe is wrong: leave the code alone and return it as rejected with the reason it is wrong. That reason goes to the next reviewer, who may only raise it again by falsifying it — so make the reason specific and checkable, and reject only what you are confident about.

${ECONOMY}

A finding too large to fix in your remaining context (past roughly 70 tool calls): fix what you can, and return the rest as "location — issue" lines in \`overflow\` — the dispatcher hands them to fresh agents. Everything you neither reject nor overflow, you have fixed.

Run the repo's tests, get them green, commit, and push \`${impl.branch}\` (plain push — the branch has no PR yet).

Return one verdict per finding above.`,
      { ...M, phase: 'Gate', schema: FIX_SCHEMA, isolation: 'worktree', label: `gate-fix:#${t.number}:r${round}` },
    )
    if (!fix) throw new Error(`gate fixer for #${t.number} died at round ${round}`)
    for (const v of fix.verdicts.filter((v) => v.action === 'rejected')) {
      if (!rejected.some((p) => p.location === v.location && p.issue === v.issue)) rejected.push(v)
    }
    if (fix.overflow.length) {
      log(`#${t.number} gate round ${round}: ${fix.overflow.length} finding(s) overflowed to the dispatcher`)
      const replan = await dispatch(t, `gate findings too large for one fixer: ${fix.overflow.join('; ')}`)
      if (replan) await runSlices(t, replan.slices, { cutFrom, started: true, tag: `gate-fix:#${t.number}:r${round}:d` })
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
        // The tip as this ticket starts: its dependencies are already stacked
        // (awaited above), so cutting from the tip sees all of their work.
        const cutFrom = tip
        const plan = await dispatch(t, null)
        if (!plan) throw new Error(`dispatcher for #${t.number} died`)
        if (plan.slices.length > 1) log(`#${t.number} dispatched as ${plan.slices.length} slices`)
        // Slice rounds: run the plan; a remainder (a slice bailed out, or was
        // never started) goes back to the dispatcher for a re-slice with a
        // fresh agent. On the round cap the remainder is carried as unmet —
        // named for the operator — rather than ground out.
        let slices = plan.slices
        let started = false
        let last = null
        const summaries = []
        let unmet = []
        for (let round = 1; round <= MAX_DISPATCH_ROUNDS; round++) {
          const out = await runSlices(t, slices, { cutFrom, started, tag: `impl:#${t.number}${round > 1 ? `:r${round}` : ''}` })
          started = out.started
          if (out.last) last = out.last
          summaries.push(...out.summaries)
          unmet = out.unmet
          if (!unmet.length || round === MAX_DISPATCH_ROUNDS) break
          log(`#${t.number} remainder after round ${round}: ${unmet.join('; ')} — re-dispatching`)
          const replan = await dispatch(t, unmet.join('; '))
          if (!replan) { log(`#${t.number} re-dispatch died — carrying the remainder as unmet`); break }
          slices = replan.slices
        }
        if (!started || !last) throw new Error(`no slice of #${t.number} landed`)
        const impl = {
          branch: `ticket/${t.number}`,
          summary: summaries.join(' '),
          tests_run: last.tests_run,
          tests_green: last.tests_green,
          unmet,
        }
        if (impl.unmet.length) log(`#${t.number} unmet: ${impl.unmet.join('; ')}`)
        const unfixed = await reviewGate(t, impl, cutFrom, plan.ticket_brief)
        await enqueuePublish(t, impl, cutFrom)
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
if (!stacked.length && !hasLayer0) return { spec: SPEC, error: 'no ticket was published', failed: failed.map((o) => ({ ticket: o.number, error: o.failed })) }

// --- step 7: review the whole stack; fixes land as the top PR -------------
phase('Review')
const review = await agent(
  `Review the whole stack for spec #${SPEC}.

${POINTERS}
The stack, bottom to top: ${[...(hasLayer0 ? [`${graph.start_ref} (pre-existing work)`] : []), ...stacked.map((s) => `#${s.number} (${s.branch})`)].join(' → ')}.
Review \`${q(BASE_REF)}...${q(tip)}\` — everything the stack adds.

Invoke the \`code-review\` skill with \`${q(BASE_REF)}\` as the fixed point and spec #${SPEC} as the spec — both its axes: this repo's documented standards, and whether the stack matches what the spec and its tickets asked for.

Every ticket was already reviewed alone on its own branch, so look hardest at what that could not see: two implementations of one helper, abstractions that contradict each other, a contract one ticket relies on that another changed. Return every finding; change no code yourself.`,
  { ...M, phase: 'Review', schema: REVIEW_SCHEMA, isolation: 'worktree', label: `review:spec-${SPEC}` },
)
const findings = review ? review.findings : []
log(`code review: ${findings.length} findings`)

// The stack's PRs are published: pushing fixes into them would force-update
// every PR above and hand the operator phantom diffs mid-review. So the fixes
// become one integration PR on top — the seams between the tickets, as their
// own small reviewable diff.
let integration = null
if (findings.length) {
  integration = await agent(
    `Fix what the whole-stack review raised for spec #${SPEC}, as one integration PR on top of the stack.

${POINTERS}
Current stack tip: \`${tip}\`.

\`git fetch origin && git checkout -B spec/${SPEC}-integration ${q(tip)}\`.

Findings:
${findings.map((f) => `- [${f.severity}] ${f.location} — ${f.issue} → ${f.fix}`).join('\n')}

Fix them on this branch — touch no other branch of the stack; they are published. A finding you believe is wrong: leave the code alone and return it as rejected with a specific checkable reason.

${ECONOMY}

Run the repo's tests, get them green, commit, push \`spec/${SPEC}-integration\`, and open a DRAFT PR: head \`spec/${SPEC}-integration\`, base \`${tip}\`, title "spec #${SPEC}: integration fixes". The body lists the findings it addresses and states that it carries the cross-ticket fixes from the whole-stack review.

Return the PR url and number, the branch, and one verdict per finding.`,
    { ...M, phase: 'Review', schema: INTEGRATION_SCHEMA, isolation: 'worktree', label: 'integration' },
  )
  if (integration) {
    tip = integration.branch
    log(`integration PR ${integration.pr_url} — new stack top`)
  } else {
    log('integration fixer died — findings land unfixed; the brief names them')
  }
}

// --- steps 8-9: register the stack, ready the PRs, clean up ---------------
phase('Finalize')
// A ticket whose remainder survived every dispatch round is incomplete work,
// exactly like a failed or deferred ticket: it keeps the spec open.
const unmetTickets = outcomes.filter((o) => o.unmet && o.unmet.length)
const complete = !deferred.length && !failed.length && !unmetTickets.length
const bottomToTop = [
  ...(hasLayer0 ? [{ label: `layer 0 (pre-existing)`, branch: graph.start_ref, pr_url: layer0.pr_url, pr_number: layer0.pr_number }] : []),
  ...stacked.map((s) => ({ label: `#${s.number}`, branch: s.branch, pr_url: s.pr_url, pr_number: s.pr_number })),
  ...(integration ? [{ label: 'integration', branch: integration.branch, pr_url: integration.pr_url, pr_number: integration.pr_number }] : []),
]
const remains = [
  ...deferred.map((t) => `#${t.number} — ${t.human_reason || 'downstream of a human ticket'}`),
  ...failed.map((o) => `#${o.number} — failed: ${o.failed}`),
  ...unmetTickets.map((o) => `#${o.number} — published with unmet criteria: ${o.unmet.join('; ')}`),
]
const finalize = await agent(
  `Finalize the stack for spec #${SPEC}.

${POINTERS}
The stack, bottom to top: ${bottomToTop.map((l) => `${l.label} → PR #${l.pr_number} (${l.branch})`).join(', ')}.
Top PR: #${bottomToTop[bottomToTop.length - 1].pr_number}.

${STACK_MODE === 'native'
    ? `1. Register it as a native GitHub stack — this exact command, nothing else from the gh-stack extension (the others force-push or keep per-worktree state):

   gh stack link ${bottomToTop.map((l) => l.branch).join(' ')} --base ${BASE_REF} --remote origin

   It is append-only and pushes without force; the PRs already exist and are correctly based, so it only registers. If it exits 9, stacks are disabled for this repo — skip registration and say so in your report.`
    : `1. No stack registration — this run is in chain mode (native stacks unavailable). The PRs form a plain base-chain.`}
2. Mark every PR of the stack ready for review, bottom to top: \`gh pr ready <number>\`. Draft PRs block a stack merge, so none may stay draft.
${complete
    ? `3. Append the line \`Closes #${SPEC}\` to the TOP PR's body (\`gh pr edit\` — keep the existing body, add the line). Merging the whole stack from the top then closes every ticket and the spec at once.`
    : `3. Add NO \`Closes #${SPEC}\` anywhere — the spec is not complete. Comment on the TOP PR and on issue #${SPEC}: the stack in merge order (the PR list above), and what remains for a human: ${remains.join('; ')}. A later run stacks the remainder on top.`}
4. Clean up every worktree this run created: \`git worktree list\`, remove the ones created for spec #${SPEC}, and \`git worktree prune\`. Leave the user's own checkout and any worktree you did not create alone. Delete no branches and close no PRs.

Do not merge anything — merging is the operator's.

Return one line: whether the stack registered, how many PRs went ready, and how many worktrees you removed.`,
  { ...M, effort: 'low', phase: 'Finalize', label: 'finalize' },
)

return {
  spec: SPEC,
  mode: STACK_MODE,
  stack_bottom_to_top: bottomToTop.map((l) => `${l.label}: ${l.pr_url}`),
  state: complete ? 'complete — ready for review' : 'partial — ready for review, spec stays open',
  merge_how: STACK_MODE === 'native'
    ? `Review bottom-up, then merge ONCE from the top PR (the Merge button there, or PUT .../pulls/${bottomToTop[bottomToTop.length - 1].pr_number}/merge-async). Every layer needs green required checks and required approvals, evaluated against ${BASE_REF}. After a FAILED merge, re-read the actual state of ${BASE_REF} — do not assume rollback.`
    : `No stack object (chain mode): merge bottom-up by hand, one PR at a time, with MERGE COMMITS (--merge), deleting each head branch after its merge so GitHub retargets the next PR. Squash/rebase merges rewrite shas and give every child PR a phantom diff.`,
  gate_unfixed: outcomes
    .filter((o) => o.unfixed && o.unfixed.length)
    .map((o) => ({ ticket: o.number, findings: o.unfixed.map((f) => `[${f.severity}] ${f.location} — ${f.issue}`) })),
  failed: failed.map((o) => ({ ticket: o.number, error: o.failed })),
  deferred_to_human: deferred.map((t) => ({ ticket: t.number, reason: t.human_reason || 'downstream of a human ticket' })),
  unmet: unmetTickets.map((o) => ({ ticket: o.number, criteria: o.unmet })),
  review_findings: findings.length,
  integration_pr: integration ? integration.pr_url : null,
  integration_unfixed: findings.length && !integration ? findings.map((f) => `[${f.severity}] ${f.location} — ${f.issue}`) : [],
  notes: NOTES_DIR,
  finalize,
}
