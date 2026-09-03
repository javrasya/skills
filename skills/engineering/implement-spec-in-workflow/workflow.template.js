export const meta = {
  name: 'implement-spec-__SPEC__',
  description: 'Implement spec #__SPEC__ as a stack of PRs: discover the ticket graph, implement each ticket in its own worktree, gate it, publish it as one stacked PR, review the whole stack, register it',
  phases: [
    { title: 'Graph', detail: 'read the spec and its tickets, return the task graph' },
    { title: 'Explore', detail: 'research notes saved outside the repo' },
    { title: 'Setup', detail: 'layer-0 PR when prior work already sits on a branch' },
    { title: 'Implement', detail: 'a dispatcher sizes each ticket; fresh slice agents implement it, frontier-scheduled' },
    { title: 'Gate', detail: 'code-review each ticket branch before it is published' },
    { title: 'Stack', detail: 'serial publish lane: rebase onto the tip, one draft PR per ticket, reclaim the ticket\'s worktrees' },
    { title: 'Review', detail: 'code-review the whole stack; fixes land as the top PR' },
    { title: 'Finalize', detail: 'reconcile the stack, ready the PRs, reclaim the worktrees the lane has not' },
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
// Every agent in this run works in a worktree LINKED to one clone — one object
// store, one ref namespace — so a commit any agent makes is reachable by name
// from every other the moment it lands. The shared clone, not origin, is how
// work passes between slices. A ticket branch therefore reaches origin exactly
// once, when the lane publishes it, and that push CREATES the ref rather than
// rewriting one: there is no force-push anywhere in the run. See ADR-0005.
//
// Two kinds of ref follow. One this run CREATED is authoritative locally and
// may not be on origin at all. One the run INHERITED — the base branch, prior
// work on start_ref — is authoritative on origin, where the operator or
// another machine may have moved it, so it is fetched and addressed there.
const runRefs = new Set()
const ref = (r) => (runRefs.has(r) ? r : /^[0-9a-f]{7,40}$/.test(r) ? r : `origin/${r}`)

// Told to every agent that touches git. The first rule is why no push is
// needed; the second is the one an agent cannot guess — git refuses to check
// out a branch another worktree holds, and this run's worktrees outlive the
// agents that made them. The last exists because an observed run answered that
// refusal by inventing `slice1/227`, `ticket-227-slice2` and `fix/226-gate`,
// and one agent's work was stranded on a ref nobody published.
const GIT = `Git in this run — every agent shares ONE clone, and your worktree is linked to it:
- A commit you make is reachable by every other agent, by ref name, the moment it lands. Nothing is pushed to hand work over: push only if this brief tells you to.
- NEVER check a branch out — another worktree may hold it and git will refuse. Start from \`git switch --detach <ref>\`, and once your work is committed, move the branch with \`git update-ref refs/heads/<branch> HEAD\`. That succeeds exactly where \`git checkout\` and \`git branch -f\` are refused.
- Never pass \`--force\` or \`--force-with-lease\` to any push, to any branch, for any reason.
- If git refuses a command, STOP and report it. Never work around a refusal by inventing a branch name: a run scattered across improvised branches is worse than a run that stopped.`

// `gh stack link` pushes every branch it names BY LOCAL REF, atomically and
// without force. So one stale local ref on any layer — left behind by an
// earlier run on layer 0, or origin moved under an inherited branch mid-run —
// is rejected non-fast-forward, and with it every registration for the rest
// of the run, deterministically: no re-list repairs it (an observed run lost
// its whole stack this way and logged each failure as transient). The lane's
// own branches are local == origin by construction; every OTHER branch a link
// call names is mirrored from origin first. A published layer is never
// rewritten by a run (publish-once, ADR-0005), so origin is authoritative for
// it and the mirror can only drop a stale shadow, never work. See ADR-0007.
const mirror = (branches) => `\`git fetch origin\`, then mirror origin into the shared clone's LOCAL ref of ${branches.map((b) => `\`${b}\``).join(', ')} before linking — \`gh stack link\` pushes every branch it names by local ref, and one stale ref fails the whole atomic push, now and on every later re-list. For each: if \`git rev-parse <branch>\` differs from \`git rev-parse origin/<branch>\`, run \`git update-ref refs/heads/<branch> origin/<branch>\` — the branch is published and nothing in this run rewrites it, so origin is right and the local ref is a stale shadow; name the sha you moved off in your note (its commits stay in the object store). The one branch you may not move is one \`git worktree list\` shows checked out (\`[<branch>]\`): leave it, name it in your note, and let the link fail.`

// Told to every agent that runs in its own worktree — and only those: the
// dispatchers receive GIT too but run in the main checkout, so this cannot
// live inside GIT. A worktree is per agent, not per ticket, and the harness
// keeps every one that changed. The lane reclaims a ticket's worktrees the
// moment its PR exists, and the only safe way to know which those are is for
// each agent to name its own — an agent for the next ticket sits clean at the
// same commit and is indistinguishable by git state alone.
const WORKTREE = `Your worktree is throwaway and per agent. Before you return, run \`git rev-parse --show-toplevel\` and return that absolute path as \`worktree\`. This run reclaims it — uncommitted leftovers included — once the work it holds is published.`

// --- the worktree ledger ---------------------------------------------------
// Every path an isolated agent reports, keyed by what it worked on, beside the
// branch that holds its work. A reclaim is handed EXACT paths from here and
// never a pattern. The check before removal is that HEAD is on that branch;
// the tree may be dirty, because an agent that returned committed what it
// meant to keep and the rest is build output — in a repo whose build rewrites
// tracked generated files every worktree is dirty, and a rule that spared
// them would reclaim nothing. A dead agent never reports a path, so its
// worktree is never in here and never removed: finalize names it instead.
const worktreesOf = new Map() // key → { branch, paths: [] }
function noteWorktree(key, branch, r) {
  if (!r || !r.worktree) return
  const e = worktreesOf.get(key) || { branch, paths: [] }
  if (!e.paths.includes(r.worktree)) e.paths.push(r.worktree)
  worktreesOf.set(key, e)
}
const reclaimed = new Set()
const worktreesKept = []
// The publisher cannot remove its own worktree (its cwd), so it is handed to
// the next publisher down the lane, and the last one to finalize.
let prevPublishWorktree = null // { path, branch }
const prevPublisher = () => (prevPublishWorktree ? [prevPublishWorktree] : [])
// Entries not yet handed to any reclaimer. Marked reclaimed only once the reclaimer
// returned: a reclaimer that died leaves them for the next one, or finalize.
function pendingWorktrees(keys) {
  const out = []
  for (const k of keys) {
    const e = worktreesOf.get(k)
    if (e) for (const path of e.paths) if (!reclaimed.has(path)) out.push({ path, branch: e.branch })
  }
  return out
}
function markReclaimed(entries, r) {
  for (const e of entries) reclaimed.add(e.path)
  if (r && r.worktrees_kept) worktreesKept.push(...r.worktrees_kept)
}
const reclaimStep = (entries) => entries.length
  ? `Reclaim these worktrees — exact paths, nothing else. Each belonged to an agent of this run that has finished, and the branch beside it holds that agent's work:
${entries.map((e) => `   - ${e.path} → ${ref(e.branch)}`).join('\n')}
   For each path: if it no longer exists, count it removed — the harness already cleaned it. Otherwise \`git -C <path> merge-base --is-ancestor HEAD <branch>\` must succeed; if it fails the worktree holds a commit its branch does not, so keep it and report why. Then \`git worktree remove --force <path>\` — force on purpose: the agent that used it returned and committed what it meant to keep, so whatever is uncommitted there is build output, and the ancestor check above is the real guard. If git still refuses (a file lock, say), keep the worktree and report \`{path, reason}\`. Never remove your own worktree, ${REPO_DIR}, or any path not in this list. Finish with \`git worktree prune\`. Return how many you removed and every one you kept.`
  : `No worktrees to reclaim this time: report 0 removed and none kept.`
// A dead agent never reported a path, so its worktree is not in the ledger.
// The harness names a run's worktrees `wf_<run>-<n>`; the prefix is read off
// any reported path so a reclaimer can NAME the strays without touching them.
const strayPrefix = () => {
  for (const e of worktreesOf.values()) for (const p of e.paths) { const m = /^(.*[\\/]wf_[^\\/]+-)\d+$/.exec(p); if (m) return m[1] }
  return null
}
const strayStep = () => {
  const prefix = strayPrefix()
  return prefix
    ? `Then \`git worktree list --porcelain\`: any worktree whose path starts with \`${prefix}\` and is NOT in the list above belonged to an agent of this run that died before reporting. Do not remove it — it may hold the only copy of that agent's work — but add it to \`worktrees_kept\` with the reason "not in the ledger: its agent died before reporting".`
    : ''
}

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

// Every agent that runs in its own worktree names it; see WORKTREE.
const WORKTREE_FIELD = { worktree: { type: 'string', description: 'absolute path of the worktree you ran in — `git rev-parse --show-toplevel`' } }
// What a reclaimer reports back; see reclaimStep.
const RECLAIM_FIELDS = {
  worktrees_removed: { type: 'integer' },
  worktrees_kept: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'reason'],
      properties: { path: { type: 'string' }, reason: { type: 'string', description: 'why it was kept: dirty, HEAD not on its branch, or the refusal git gave' } },
    },
  },
}

const LAYER0_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr_url', 'pr_number', 'note', 'worktree'],
  properties: {
    pr_url: { type: 'string' },
    pr_number: { type: 'integer' },
    note: { type: 'string', description: 'what the local-ref mirror found: in sync, a stale sha it moved off, or a worktree holding the branch so it was left alone' },
    ...WORKTREE_FIELD,
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'summary', 'tests_run', 'tests_green', 'unmet', 'worktree'],
  properties: {
    branch: { type: 'string' },
    summary: { type: 'string', description: 'one or two sentences' },
    tests_run: { type: 'string', description: 'the exact command(s) run' },
    tests_green: { type: 'boolean' },
    unmet: { type: 'array', items: { type: 'string' }, description: 'acceptance criteria from the ticket that were not satisfied — empty when all are met' },
    ...WORKTREE_FIELD,
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
  required: ['published', 'pr_url', 'pr_number', 'conflicts_resolved', 'stack_link', 'note', 'worktree', 'worktrees_removed', 'worktrees_kept'],
  properties: {
    published: { type: 'boolean' },
    pr_url: { type: 'string' },
    pr_number: { type: 'integer' },
    conflicts_resolved: { type: 'array', items: { type: 'string' } },
    // `disabled` is the one value that latches: it means the stacks API said
    // exit 9, so no later publish should spend a call on it. `failed` is a
    // transient error and needs no handling — the next publish re-lists the
    // whole stack and repairs it for free. `rejected` is neither: the push
    // was refused non-fast-forward on a named branch, which is deterministic
    // and recurs on every re-list until that branch's local ref is mirrored;
    // it is logged loudly and carried into the brief rather than waited out.
    stack_link: { type: 'string', enum: ['registered', 'skipped', 'failed', 'rejected', 'disabled'] },
    note: { type: 'string' },
    ...WORKTREE_FIELD,
    ...RECLAIM_FIELDS,
  },
}

// Shared by the gate reviewers and the whole-stack review — both isolated.
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'worktree'],
  properties: {
    ...WORKTREE_FIELD,
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

const VERDICTS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['location', 'issue', 'action', 'reason'],
    properties: {
      location: { type: 'string', description: 'path:line, copied from the finding' },
      issue: { type: 'string', description: 'the finding, copied verbatim' },
      action: { type: 'string', enum: ['fixed', 'rejected'] },
      reason: { type: 'string', description: 'what you changed, or \u2014 when rejected \u2014 the specific checkable reason the finding is wrong' },
    },
  },
}

// What the dispatcher returns when it sizes a batch of review findings. No
// ticket_brief: a fix dispatch is handed the brief the ticket dispatcher
// already wrote, and never re-derives it.
const FIX_DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slices'],
  properties: {
    slices: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'brief', 'findings', 'effort'],
        properties: {
          title: { type: 'string' },
          brief: { type: 'string', description: 'self-contained: every finding this slice owns copied in full, the files they touch, and every constraint from the ticket brief that bears on them \u2014 its fixer reads no issue and no spec' },
          findings: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'the `location` of each finding this slice owns, copied verbatim \u2014 every finding in exactly one slice, none dropped, none in two' },
          effort: { type: 'string', enum: ['medium', 'high'], description: 'reasoning effort for the slice fixer' },
        },
      },
    },
  },
}

const FIX_SLICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'unfinished', 'worktree'],
  properties: {
    verdicts: VERDICTS,
    unfinished: { type: 'array', items: { type: 'string' }, description: '`location` of each finding in your brief you did not reach \u2014 empty normally' },
    ...WORKTREE_FIELD,
  },
}

const INTEGRATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr_url', 'pr_number', 'branch', 'worktree', 'worktrees_removed', 'worktrees_kept'],
  properties: {
    pr_url: { type: 'string' },
    pr_number: { type: 'integer' },
    branch: { type: 'string' },
    ...WORKTREE_FIELD,
    ...RECLAIM_FIELDS,
  },
}

const RECLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['worktrees_removed', 'worktrees_kept'],
  properties: { ...RECLAIM_FIELDS },
}

const FINALIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'worktrees_removed', 'worktrees_kept'],
  properties: {
    summary: { type: 'string', description: 'one line: whether the stack registered and how many PRs went ready' },
    ...RECLAIM_FIELDS,
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
// Every PR body says which layer it is out of how many are PLANNED — layer 0
// plus the automatable tickets. Planned, not promised: a ticket can fail or be
// deferred, so a stack that lands short must read as short rather than broken.
// The integration PR is deliberately outside this count; whether it exists is
// unknown until the whole-stack review returns.
const PLANNED_LAYERS = auto.length + (hasLayer0 ? 1 : 0)
const layerLine = (k) =>
  `Layer ${k} of ${PLANNED_LAYERS} planned — spec #${SPEC} is still being implemented; more layers may follow.`
let layer0 = null
if (hasLayer0) {
  layer0 = await agent(
    `Open the layer-0 PR of the stack for spec #${SPEC}.

${POINTERS}
${GIT}

The branch \`${graph.start_ref}\` already carries work for this spec, done before this run. It becomes the bottom layer of the stack. \`git fetch origin\`, then \`git switch --detach ${ref(graph.start_ref)}\` so your worktree sits on the layer it publishes (the reclaim that later removes it checks exactly that), confirm the branch exists on origin (push it from the local checkout if it only exists locally — plain push, no force), then open a DRAFT PR: head \`${graph.start_ref}\`, base \`${BASE_REF}\`, title from the branch's work. The body must open with exactly this line:

${layerLine(1)}

and then say plainly that this PR carries pre-existing work for spec #${SPEC} that this run did not implement or gate — the operator should review it with that in mind.

Do not register a stack: \`gh stack link\` needs two layers and this is the only one so far. The next PR of the stack registers both — and every one of those calls names this branch, so: ${mirror([graph.start_ref])}

Do not disturb the user's working copy: leave ${REPO_DIR}'s checked-out branch and its uncommitted changes exactly as you found them.

${WORKTREE}

Return the PR url and number, what the mirror found, and your worktree.`,
    { ...M, effort: 'low', phase: 'Setup', schema: LAYER0_SCHEMA, isolation: 'worktree', label: `layer0:${graph.start_ref}` },
  )
  if (!layer0) throw new Error('layer-0 PR failed — prior work would be orphaned')
  noteWorktree('layer0', graph.start_ref, layer0)
  log(`Layer 0: ${layer0.pr_url} (pre-existing work on ${graph.start_ref}) — ${layer0.note}`)
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
// corrective, so the dispatcher is biased against slicing.
//
// This is the dispatcher's implementation entry point. `dispatchFix` is the
// other: the same role sizing a batch of review findings. Every piece of work
// this run does goes through one of the two — nothing reaches a fixer or an
// implementer unsized.
//
// MAX_DISPATCH_ROUNDS governs re-slicing HERE only. The gate has no equivalent
// nesting: whatever a fix slice does not reach falls to the next reviewer,
// which re-derives what is still broken from the branch itself.
const MAX_DISPATCH_ROUNDS = 3

function dispatch(t, remainder) {
  return agent(
    `Slice ticket #${t.number} — ${t.title} — into the fewest implementation slices that fresh-context agents can finish, and write each slice's brief.

${POINTERS}
${GIT}
${notesLine}
${remainder ? `
Earlier slices of this same run already did part of this work — \`ticket/${t.number}\` is this run's own unpublished branch (created by this workflow, no PR) carrying what they pushed. Slice ONLY what remains: ${remainder}` : ''}

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
${GIT}

Your brief — the ticket is already distilled into it, so run no \`gh issue view\` and read no spec:
${s.brief}

First: \`git fetch origin && git switch --detach ${out.started ? `ticket/${t.number}\` — this run's own local branch, carrying what earlier slices of this same workflow committed minutes ago` : `${ref(cutFrom)}\` — your worktree starts on the wrong ref, and everything stacked before this ticket is reachable from there`}.

Follow the repo's own conventions and CLAUDE.md, and stay inside the brief — the rest of the ticket belongs to other slices. Comments only where load-bearing: why-not-what, landmines, pointers to external context; never narrate what code does.

${ECONOMY}

Past roughly 70 tool calls this slice has outgrown one agent's context. Stop cleanly: commit what works, move the branch to it, and name what you did not reach in \`unmet\` — the dispatcher hands the remainder to a fresh agent. A named remainder is cheap; a 300-turn agent is not.

Run the repo's tests for what you touched and get them green. Commit, then move the ticket branch onto your work: \`git update-ref refs/heads/ticket/${t.number} HEAD\`. Push nothing — this branch reaches origin exactly once, when the stack lane publishes it.

${WORKTREE}

Return the branch, a one-line summary, the test command and its result, anything from the brief you did not reach in \`unmet\`, and your worktree.`,
      { ...M, effort: s.effort, phase: 'Implement', schema: IMPL_SCHEMA, isolation: 'worktree', label: `${tag}${slices.length > 1 ? `:s${i + 1}` : ''}` },
    )
    if (!r) throw new Error(`slice implementer for #${t.number} died (${s.title})`)
    noteWorktree(t.number, `ticket/${t.number}`, r)
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

// The stack is registered as it grows, not at the end: the operator sees a
// real stack map from the second PR onward instead of waiting for the run.
// The lane is the only place this can happen — two concurrent `gh stack link`
// calls against one stack is exactly the race the lane exists to prevent.
//
// `stackLayers()` is the full bottom-to-top list, re-listed on every publish.
// `link` reconciles rather than replaces ("existing PRs are never removed"),
// so re-listing needs no stack number to discover and no state to carry
// between agents — the same reason the tip is derived and never remembered.
const stackLayers = () => [...(hasLayer0 ? [graph.start_ref] : []), ...stacked.map((s) => s.branch)]
let stackRegistered = false
// The last non-transient link failure, for the brief: a rejected push is a
// fact about a branch, not the weather, and the operator has to hear it.
let lastLinkFailure = null
// Latches on exit 9 only: the stacks API went away mid-run, and no later call
// will fix that. Chain mode starts here, so the lane never links at all.
let stackDisabled = STACK_MODE !== 'native'

let lane = Promise.resolve()
function enqueuePublish(t, impl, cutFrom) {
  const run = lane.then(() => {
    const base = tip
    // Layers as they will stand once this PR exists — k is the ACTUAL position
    // in the stack, not the ticket's index in the plan, so the map's fourth box
    // says "layer 4". A run that lost three tickets ends "4 of 7 planned",
    // which announces its own shortfall before the brief does.
    const layers = [...stackLayers(), impl.branch]
    const canLink = !stackDisabled && layers.length >= 2
    // Everything this ticket's agents left behind, plus the previous
    // publisher's own worktree (it could not remove its cwd) and, on the
    // first publish, layer 0's. The reclaim runs BEFORE the rebase below: the
    // check is "HEAD is on ticket/N", and a rebase makes every slice
    // worktree's HEAD an orphan of the branch it built, so reclaiming after
    // would keep them all for nothing.
    const toReclaim = [
      ...pendingWorktrees([t.number, ...(stacked.length ? [] : ['layer0'])]),
      ...prevPublisher(),
    ]
    return agent(
      `Publish ticket #${t.number}'s branch as the next PR of the stack for spec #${SPEC}.

${POINTERS}
${GIT}
Ticket branch: \`${impl.branch}\` — a LOCAL ref this run created. It is not on origin, and putting it there is your job. Cut from \`${ref(cutFrom)}\` (\`gh issue view ${t.number}\` for what it was meant to do).
Current stack tip: \`${ref(base)}\` — what your PR must be based on.
Stack so far, bottom to top: ${stacked.length ? stacked.map((s) => `#${s.number} (${s.branch})`).join(' → ') : hasLayer0 ? `layer 0 (${graph.start_ref})` : 'empty'}.

1. \`git fetch origin\` — for the inherited refs; this run's own branches are already local.
2. ${reclaimStep(toReclaim)}${toReclaim.length ? `
   This comes before any rebase on purpose: the check is that a worktree's HEAD sits on its branch, and a rebase would orphan every one of them from the branch they built.` : ''}
3. \`git switch --detach ${impl.branch}\`.
${cutFrom !== base ? `4. The tip moved since this ticket was cut. Replay its commits onto the tip: \`git rebase --onto ${ref(base)} ${ref(cutFrom)}\`. This rewrites only local commits that have never left this clone, so it needs no force and destroys nothing. Resolve any conflict in favour of keeping BOTH tickets' behaviour.
5. Run the tests the ticket branch ran (${impl.tests_run}); get them green, committing any fix.
6. Move the branch onto the rebased work: \`git update-ref refs/heads/${impl.branch} HEAD\`.` : `4. The tip has not moved: the branch already sits on \`${ref(base)}\`. No rebase.
5. Run the tests the ticket branch ran (${impl.tests_run}); confirm green.
6. The branch already points at the work; nothing to move.`}
7. Put it on origin for the first time: \`git push origin ${impl.branch}\`. This CREATES the branch there — it overwrites nothing and needs no force. A rejected push means something you do not know about is going on: stop and report it.
8. Open a DRAFT PR: \`gh pr create --draft --head ${impl.branch} --base ${base}\` — \`--base\` takes the branch name. Title = the ticket's title. The body must open with exactly this line:

   ${layerLine(layers.length)}

   and must also contain the line \`Closes #${t.number}\` and state that it is part of the stack for spec #${SPEC}. Leave it a DRAFT — every layer stays draft until the run finalizes, which is how the operator can tell the stack is still being built.
${canLink
        ? `9. ${mirror(layers.slice(0, -1))}

   Then register the stack as it now stands — this exact command, nothing else from the gh-stack extension (the others force-push or keep per-worktree state):

   gh stack link ${layers.join(' ')} --base ${BASE_REF} --remote origin

   It re-lists the whole stack on purpose: \`link\` reconciles rather than replaces, so this needs no stack number and repairs any earlier call that failed. Never pass \`--open\` — it would mark the PRs ready for review and destroy the in-progress signal. Never name a branch whose PR you have not just confirmed exists: \`link\` opens a PR for any branch that lacks one, and that PR would be outside this run's control.

   This step must not fail the publish. The PR is the real output; registration is the stack map.
   - Exit 9 → stacks are disabled for this repo. Report \`stack_link: "disabled"\` so no later publish spends a call on it.
   - A push refused non-fast-forward (\`! [rejected] <branch> -> <branch>\`) → report \`stack_link: "rejected"\`, with the branch and its local and origin shas in your note. This is not transient: it names a local ref that still disagrees with origin, and no re-list repairs it.
   - Any other error → report \`stack_link: "failed"\` and move on. The next publish re-lists everything and repairs it.
   - Success → \`stack_link: "registered"\`.`
        : stackDisabled
          ? `9. Do not register a stack${STACK_MODE === 'native' ? ' — a previous publish found the stacks API disabled (exit 9)' : ' — this run is in chain mode'}. Report \`stack_link: "disabled"\`.`
          : `9. Do not register a stack yet: \`gh stack link\` needs two layers and yours is the only one. Report \`stack_link: "skipped"\`. The next PR registers both.`}

You are the only agent publishing right now. After the PR exists, the branch is published: nothing may ever push to it again.

${WORKTREE}

Return whether it published, the PR url and number, what you resolved, how the stack link went, any note, the reclaim count and kept list, and your worktree.`,
      { ...M, effort: 'low', phase: 'Stack', schema: PUBLISH_SCHEMA, isolation: 'worktree', label: `publish:#${t.number}` },
    ).then((r) => {
      if (!r || !r.published) {
        // A publisher that returned without publishing still used a
        // worktree: file it under the ticket so finalize reclaims it. Its
        // reclaim list is NOT marked — finalize re-hands it, and a path the
        // failed publisher already removed simply counts as removed.
        noteWorktree(t.number, impl.branch, r)
        throw new Error(`publish of #${t.number} failed: ${r ? r.note : 'agent died'}`)
      }
      markReclaimed(toReclaim, r)
      prevPublishWorktree = { path: r.worktree, branch: impl.branch }
      stacked.push({ number: t.number, branch: impl.branch, pr_url: r.pr_url, pr_number: r.pr_number })
      tip = impl.branch
      if (r.stack_link === 'registered') stackRegistered = true
      // Only exit 9 latches. A transient failure is left alone deliberately —
      // the next publish's full re-list is the repair, so retrying here would
      // burn a call per layer for something one call already fixes.
      if (r.stack_link === 'disabled' && STACK_MODE === 'native') stackDisabled = true
      // A rejected push does not latch — the next publish mirrors the stale
      // ref and its re-list repairs the stack — but it is never called
      // transient: the log names it and the brief carries it.
      if (r.stack_link === 'rejected') lastLinkFailure = `#${t.number}: link push rejected non-fast-forward — ${r.note}`
      const linkState = stackDisabled
        ? 'stack: unregistered — stacks API disabled mid-run'
        : r.stack_link === 'registered'
          ? 'stack registered'
          : r.stack_link === 'skipped'
            ? 'stack: not yet — needs 2 layers'
            : r.stack_link === 'rejected'
              ? `stack: NOT REGISTERED — link push rejected non-fast-forward, a local ref shadows origin (${r.note})`
              : 'stack: unregistered — link failed, next publish retries'
      log(`stacked #${t.number} → ${r.pr_url} — ${stacked.length}/${auto.length} (${linkState}; reclaimed ${r.worktrees_removed} worktree(s)${r.worktrees_kept.length ? `, kept ${r.worktrees_kept.length}` : ''})`)
      return r
    })
  })
  lane = run.then(() => {}, () => {})
  return run
}

// --- the fix path: findings reach a fixer only through the dispatcher -----
// Every batch of blocking findings is sized and briefed exactly like a ticket:
// the dispatcher is the only route into any work this run does, implementation
// or fix. The earlier design let one fixer own a whole batch and hand back
// only what it declared too large for its context — and an agent under context
// pressure does not declare it: one measured run reached 344.8K tokens and
// handed off nothing. Self-assessment is the first thing context pressure
// destroys, so the routing is unconditional and the sizing happens before any
// fixer starts. See docs/adr/0004.
const fkey = (f) => `${f.location}||${f.issue}`

function dispatchFix(findings, { subject, brief, branch, skimRef, started, phase: ph, tag }) {
  return agent(
    `Slice the review findings on ${subject} into the fewest fix slices that fresh-context agents can finish, and write each slice's brief.

${POINTERS}
${GIT}
What the work is, distilled — read this instead of the issue, and run no \`gh issue view\` and no spec: ${brief}
The branch the fixes land on: \`${branch}\`${started ? ' — this run\'s own branch, already pushed, no PR' : `, which your first slice cuts fresh from \`${skimRef}\``}.

Findings to fix:
${findings.map((f) => `- [${f.severity}] ${f.location} — ${f.issue} → ${f.fix}`).join('\n')}

Size this work, do not do it. \`git fetch origin\`, then skim at \`${skimRef}\`: \`git diff --stat\` against what it was cut from, and the STRUCTURE of the files the findings name — signatures, grep hits. Read no implementations; your slices read the code.

Default to ONE slice. Slice only when one agent plausibly cannot finish in roughly 70 tool calls; when unsure, do not slice. A finding naming a rename and one naming an extraction read alike in a line and differ by two orders of magnitude in work — that difference, not the finding count, is what you are judging. Slices run sequentially on one branch, so each must leave the branch consistent — building, tests green.

Every finding above belongs to exactly one slice: none dropped, none in two. Each brief must be self-contained — the findings it owns copied in full with their suggested fixes, the files they touch, and every constraint from the distilled work above that bears on them; its fixer reads no issue, no spec and no review.`,
    { ...M, effort: 'medium', phase: ph, schema: FIX_DISPATCH_SCHEMA, label: `${tag}:dispatch` },
  )
}

async function runFixSlices(slices, { subject, branch, cutFrom, started, phase: ph, tag, ledgerKey }) {
  const out = { verdicts: [], unfinished: [], landed: started, died: null }
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]
    const r = await agent(
      `Fix one slice of the review findings on ${subject}: ${s.title}${slices.length > 1 ? ` (slice ${i + 1} of ${slices.length})` : ''}.

${POINTERS}
${GIT}

Your brief — the work and its findings are already distilled into it, so run no \`gh issue view\`, read no spec, and re-read no review:
${s.brief}

First: \`git fetch origin && git switch --detach ${out.landed ? `${branch}\` — this run's own local branch, carrying what earlier fix slices of this same workflow committed minutes ago` : `${ref(cutFrom)}\``}.

Fix what your brief owns and nothing else — the rest of the findings belong to other slices, and the branches below this one in the stack are published and must not be touched.

A finding you believe is wrong: leave the code alone and return it as \`rejected\` with the reason it is wrong. That reason goes to the next reviewer, who may only raise it again by falsifying it — so make the reason specific and checkable, and reject only what you are confident about.

${ECONOMY}

Past roughly 70 tool calls this slice has outgrown one agent's context. Stop cleanly: commit what works, move the branch to it, and name the findings you did not reach in \`unfinished\`. The next review round re-derives what is still broken from the branch itself, so a named remainder is cheap; a 300-turn agent is not.

Run the repo's tests, get them green, commit, then move the branch onto your work: \`git update-ref refs/heads/${branch} HEAD\`. Push nothing.

${WORKTREE}

Return one verdict per finding in your brief you fixed or rejected, the \`location\` of any you did not reach, and your worktree.`,
      { ...M, effort: s.effort, phase: ph, schema: FIX_SLICE_SCHEMA, isolation: 'worktree', label: `${tag}${slices.length > 1 ? `:s${i + 1}` : ''}` },
    )
    // A dead fixer is not fatal — it is the next reviewer's problem, and that
    // reviewer reads the branch rather than anyone's account of it. But the
    // branch may be mid-change, so the round stops rather than building on it.
    if (!r) { out.died = s.title; break }
    noteWorktree(ledgerKey, branch, r)
    out.landed = true
    out.verdicts.push(...r.verdicts)
    out.unfinished.push(...r.unfinished)
  }
  return out
}

// Reconciliation happens HERE, in the script, never in a prompt: the reason
// this path exists at all is that an agent's own account of what it did not do
// is unreliable. A finding with no verdict is unfixed, named, and handed to the
// next reviewer to check explicitly — not silently assumed done.
async function fixFindings(findings, opts) {
  const skimRef = opts.started ? opts.branch : ref(opts.cutFrom)
  const plan = await dispatchFix(findings, { ...opts, skimRef })
  if (!plan) {
    log(`${opts.subject}: fix dispatcher died — ${findings.length} finding(s) unaccounted`)
    return { verdicts: [], unaccounted: findings, landed: opts.started }
  }
  if (plan.slices.length > 1) log(`${opts.subject}: ${findings.length} finding(s) dispatched as ${plan.slices.length} fix slices`)
  const out = await runFixSlices(plan.slices, opts)
  if (out.died) log(`${opts.subject}: fix slice "${out.died}" died — the round stops there`)

  const unfinished = new Set(out.unfinished)
  const exact = new Map(out.verdicts.map((v) => [fkey(v), v]))
  const byLoc = new Map()
  for (const v of out.verdicts) byLoc.set(v.location, (byLoc.get(v.location) || []).concat(v))
  const verdicts = []
  const unaccounted = []
  for (const f of findings) {
    const at = byLoc.get(f.location) || []
    // Agents copy imperfectly: an exact match first, then a location that only
    // one verdict claims. Anything looser would credit the wrong finding.
    const v = exact.get(fkey(f)) || (at.length === 1 ? at[0] : null)
    if (v && !unfinished.has(f.location)) verdicts.push({ ...v, location: f.location, issue: f.issue })
    else unaccounted.push(f)
  }
  if (unaccounted.length) log(`${opts.subject}: ${unaccounted.length} finding(s) came back with no verdict — carried to the next review`)
  return { verdicts, unaccounted, landed: out.landed }
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
//
// A fix round is never re-dispatched in place: whatever a slice did not reach
// falls to the next round's reviewer, which re-derives what is still broken
// from the branch. One cap governs the gate, not two multiplying ones.
const GATE_MAX_ROUNDS = 4
async function reviewGate(t, impl, cutFrom, ticketBrief) {
  const rejected = []
  let unverified = []
  for (let round = 1; round <= GATE_MAX_ROUNDS; round++) {
    const r = await agent(
      `Review ticket #${t.number}'s branch before it is published as a PR.

${POINTERS}
${GIT}
Branch \`${impl.branch}\`, reviewed against \`${ref(cutFrom)}\` — that diff is the whole of this ticket's work.
What the ticket asked for: \`gh issue view ${t.number}\`. What the implementer says it did: ${impl.summary}

\`git fetch origin && git switch --detach ${impl.branch}\`, then invoke the \`code-review\` skill with \`${ref(cutFrom)}\` as the fixed point and ticket #${t.number} as the spec — both its axes: does it follow this repo's documented standards, and does it do what the ticket asked for, acceptance criterion by acceptance criterion.

Judge this ticket's diff. Work another ticket owns is out of scope; the whole stack gets its own review later. Change no code — report.
${impl.unmet.length ? `
The implementer already declared these criteria unmet — they are carried to the operator, so report them without re-litigating: ${impl.unmet.join('; ')}` : ''}
${unverified.length ? `
The previous round handed these findings to a fixer that never reported back on them. Nobody knows whether they were addressed, so the branch is the only truth — check each one explicitly and raise it again if it is still real:

${unverified.map((f) => `- ${f.location} — ${f.issue}`).join('\n')}` : ''}
${rejected.length
        ? `
A previous round already raised the findings below, and the implementer judged each one wrong for the stated reason. Raise one again only if you can show its reason is false — say which part is false and why. Otherwise leave it out entirely.

${rejected.map((v) => `- ${v.location} — ${v.issue}\n  judged wrong because: ${v.reason}`).join('\n')}`
        : ''}

${WORKTREE}`,
      { ...M, phase: 'Gate', schema: REVIEW_SCHEMA, isolation: 'worktree', label: `gate:#${t.number}:r${round}` },
    )
    noteWorktree(t.number, impl.branch, r)
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
    const out = await fixFindings(blocking, {
      subject: `ticket #${t.number}`,
      brief: ticketBrief,
      branch: impl.branch,
      cutFrom,
      started: true,
      phase: 'Gate',
      tag: `gate-fix:#${t.number}:r${round}`,
      ledgerKey: t.number,
    })
    for (const v of out.verdicts.filter((v) => v.action === 'rejected')) {
      if (!rejected.some((p) => p.location === v.location && p.issue === v.issue)) rejected.push(v)
    }
    unverified = out.unaccounted
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
        // This run owns `ticket/N` from here on: every agent addresses it as a
        // local ref, and it stays off origin until the lane publishes it.
        runRefs.add(`ticket/${t.number}`)
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
if (!stacked.length && !hasLayer0) {
  // Nothing published, so no lane step ever reclaimed. The worktrees are the
  // same dead weight as after a full run; the same rule applies, and a dirty
  // one is a dead agent's only copy — kept and named.
  const leftovers = pendingWorktrees([...worktreesOf.keys()])
  const reclaim = leftovers.length
    ? await agent(
      `Nothing of spec #${SPEC} was published; the run is stopping. ${reclaimStep(leftovers)}
${strayStep()}

${POINTERS}
Delete no branches: any work these worktrees carried is on its \`ticket/<n>\` branch in ${REPO_DIR}'s clone, and the operator may want it.`,
      { ...M, effort: 'low', phase: 'Finalize', schema: RECLAIM_SCHEMA, label: 'reclaim' },
    )
    : null
  if (reclaim) markReclaimed(leftovers, reclaim)
  return {
    spec: SPEC,
    error: 'no ticket was published',
    failed: failed.map((o) => ({ ticket: o.number, error: o.failed })),
    worktrees_kept: worktreesKept,
    local_only_branches: { note: `Never pushed. Any work these carry is in ${REPO_DIR}'s clone only.`, refs: auto.map((t) => `ticket/${t.number}`) },
  }
}

// --- step 7: review the whole stack; fixes land as the top PR -------------
phase('Review')
const review = await agent(
  `Review the whole stack for spec #${SPEC}.

${POINTERS}
${GIT}
The stack, bottom to top: ${[...(hasLayer0 ? [`${graph.start_ref} (pre-existing work)`] : []), ...stacked.map((s) => `#${s.number} (${s.branch})`)].join(' → ')}.
Review \`${ref(BASE_REF)}...${ref(tip)}\` — everything the stack adds.

Invoke the \`code-review\` skill with \`${ref(BASE_REF)}\` as the fixed point and spec #${SPEC} as the spec — both its axes: this repo's documented standards, and whether the stack matches what the spec and its tickets asked for.

Every ticket was already reviewed alone on its own branch, so look hardest at what that could not see: two implementations of one helper, abstractions that contradict each other, a contract one ticket relies on that another changed. Return every finding; change no code yourself.

${WORKTREE}`,
  { ...M, phase: 'Review', schema: REVIEW_SCHEMA, isolation: 'worktree', label: `review:spec-${SPEC}` },
)
noteWorktree('review', tip, review)
const findings = review ? review.findings : []
log(`code review: ${findings.length} findings`)

// The stack's PRs are published: pushing fixes into them would force-update
// every PR above and hand the operator phantom diffs mid-review. So the fixes
// become one integration PR on top — the seams between the tickets, as their
// own small reviewable diff.
let integration = null
let integrationVerdicts = []
let integrationUnaccounted = []
if (findings.length) {
  const branch = `spec/${SPEC}-integration`
  runRefs.add(branch)
  const stackLine = [...(hasLayer0 ? [`${graph.start_ref} (pre-existing work)`] : []), ...stacked.map((s) => `#${s.number} (${s.branch})`)].join(' → ')
  const out = await fixFindings(findings, {
    subject: `spec #${SPEC}`,
    brief: `The whole stack for spec #${SPEC}, bottom to top: ${stackLine}. These findings come from the review of the stack as a whole, so they are the seams BETWEEN tickets — one helper implemented twice, abstractions that contradict each other, a contract one ticket relies on that another changed — not any single ticket's work. They land on \`${branch}\`, a new branch cut from the stack tip; every branch below it is published and must not be touched.`,
    branch,
    cutFrom: tip,
    started: false,
    phase: 'Review',
    tag: 'integration',
    ledgerKey: 'integration',
  })
  integrationVerdicts = out.verdicts
  integrationUnaccounted = out.unaccounted
  if (out.landed) {
    // Publishing is the one irreversible act of this phase, so it is its own
    // small agent rather than the last and most context-exhausted fixer's job.
    // It also reclaims: the whole-stack review's worktree, the integration
    // fixers', and the last ticket publisher's. No rebase here, so after the
    // PR is fine.
    const integrationReclaim = [...pendingWorktrees(['review', 'integration']), ...prevPublisher()]
    integration = await agent(
      `Open the integration PR for spec #${SPEC} — the top layer of the stack.

${POINTERS}
${GIT}
Branch \`${branch}\` carries the cross-ticket fixes from the whole-stack review; this run's fix slices committed it locally. It is not on origin, and putting it there is your job. Current stack tip: \`${tip}\`.

\`git fetch origin\` and confirm the local branch \`${branch}\` exists. Change no code. Then put it on origin for the first time: \`git push origin ${branch}\` — this CREATES the branch there, overwrites nothing, and needs no force. If the branch is missing locally or the push is rejected, say so in the branch field and open no PR.

Open a DRAFT PR: \`gh pr create --draft --head ${branch} --base ${tip}\`, title "spec #${SPEC}: integration fixes". The body must open with exactly this line:

Integration layer, on top of ${PLANNED_LAYERS} planned layers of spec #${SPEC}.

It carries no layer index on purpose: whether this PR exists at all was unknown until the whole-stack review returned, so it is outside the planned count the other layers state. The rest of the body lists the findings below and states that this PR carries the cross-ticket fixes from the whole-stack review of spec #${SPEC}.

Do not run \`gh stack link\` — finalize registers this layer.

Findings it addresses:
${findings.map((f) => `- [${f.severity}] ${f.location} — ${f.issue}`).join('\n')}

After the PR exists:
${reclaimStep(integrationReclaim)}

${WORKTREE}

Return the PR url and number, the branch, the reclaim count and kept list, and your worktree.`,
      { ...M, effort: 'low', phase: 'Review', schema: INTEGRATION_SCHEMA, isolation: 'worktree', label: 'publish:integration' },
    )
    if (integration && integration.pr_number) {
      // The prompt reclaims only after the PR exists, so a returned-but-unopened
      // result reclaimed nothing: leave its list pending for finalize.
      markReclaimed(integrationReclaim, integration)
      prevPublishWorktree = { path: integration.worktree, branch }
      tip = integration.branch
      log(`integration PR ${integration.pr_url} — new stack top`)
    } else {
      noteWorktree('integration', branch, integration)
      integration = null
      log(`integration PR never opened — the fixes sit on ${branch}, unpublished; the brief names them`)
    }
  } else {
    log('no integration fix landed — the review findings stay unfixed; the brief names them')
  }
}

// --- steps 8-9: reconcile the stack, ready the PRs, clean up --------------
// The lane already registered every ticket layer as it published, so this is a
// reconciler, not the first registration: it picks up the integration PR (which
// publishes outside the lane, so nothing there ever links it) and repairs any
// in-lane call that failed. `link` is idempotent, so the cost is one call.
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
// Whatever no reclaimer was handed: failed tickets' worktrees, a reclaimer that
// died, and the last publisher's own. Same rule as the lane — exact paths,
// dirty kept and named — never "the ones for this spec".
const finalReclaim = [...pendingWorktrees([...worktreesOf.keys()]), ...prevPublisher()]
const finalize = await agent(
  `Finalize the stack for spec #${SPEC}.

${POINTERS}
${GIT}
The stack, bottom to top: ${bottomToTop.map((l) => `${l.label} → PR #${l.pr_number} (${l.branch})`).join(', ')}.
Top PR: #${bottomToTop[bottomToTop.length - 1].pr_number}.

${stackDisabled
    ? `1. No stack registration. ${STACK_MODE === 'native'
      ? 'This run started in native mode and the stacks API went away mid-run (exit 9), so the PRs are a plain base-chain rather than a registered stack. Do not retry the link. Say so in your report — the operator has to merge bottom-up by hand instead of once from the top.'
      : 'This run is in chain mode (native stacks unavailable at arm time). The PRs form a plain base-chain.'}`
    : `1. Reconcile the stack registration. ${mirror(bottomToTop.map((l) => l.branch))}

   Then this exact command, nothing else from the gh-stack extension (the others force-push or keep per-worktree state):

   gh stack link ${bottomToTop.map((l) => l.branch).join(' ')} --base ${BASE_REF} --remote origin

   ${stackRegistered
      ? 'The stack is already registered: the publish lane linked each ticket layer as it landed. This call is the reconciler — it adds the integration PR, which publishes outside the lane, and repairs any in-lane link that failed. `link` reconciles rather than replaces, so re-listing every layer is correct and existing PRs are never removed.'
      : bottomToTop.length >= 2
        ? `No in-lane link ever succeeded${lastLinkFailure ? ` — the last failure: ${lastLinkFailure}` : ''}. This call is the stack's first registration; if it fails too, quote the error in your report.`
        : 'No in-lane link ever succeeded — a single-layer stack cannot be registered, and two layers are needed. If the stack is still one layer, skip this and say so; that is correct, not a failure.'}

   Every branch listed above already has its PR — this run opened each one — so \`link\` only registers; it never has to open one, which is the case that would put a PR outside this run's control.

   Never pass \`--open\`: readying the PRs is step 2's job and belongs after this. If it exits 9, stacks are disabled for this repo — skip registration and say so in your report.`}
2. Mark every PR of the stack ready for review, bottom to top: \`gh pr ready <number>\`. Draft PRs block a stack merge, so none may stay draft — and until this step the drafts are what tell the operator the run is still adding layers, so it must not happen earlier.
${complete
    ? `3. Append the line \`Closes #${SPEC}\` to the TOP PR's body (\`gh pr edit\` — keep the existing body, add the line). Merging the whole stack from the top then closes every ticket and the spec at once.`
    : `3. Add NO \`Closes #${SPEC}\` anywhere — the spec is not complete. Comment on the TOP PR and on issue #${SPEC}: the stack in merge order (the PR list above), and what remains for a human: ${remains.join('; ')}. A later run stacks the remainder on top.`}
4. ${reclaimStep(finalReclaim)}
   The lane already reclaimed each published ticket's worktrees; these are the rest. ${strayStep()}
   Touch no other worktree — the user's own checkout in particular — and delete no branches and close no PRs.

Do not merge anything — merging is the operator's.

Return one line on the stack — whether it registered and how many PRs went ready — plus the reclaim count and kept list.`,
  { ...M, effort: 'low', phase: 'Finalize', schema: FINALIZE_SCHEMA, label: 'finalize' },
)
if (finalize) markReclaimed(finalReclaim, finalize)

return {
  spec: SPEC,
  // A run that started native and lost the stacks API mid-run is NOT a native
  // run any more, and saying so is the whole point: the operator's merge is a
  // different operation. This must never be a footnote.
  mode: STACK_MODE === 'native' && stackDisabled ? 'chain (degraded mid-run from native)' : STACK_MODE,
  stack_registration: STACK_MODE !== 'native'
    ? 'none — chain mode was chosen at arm time'
    : stackDisabled
      ? 'LOST MID-RUN. The stack registered while publishing, then the stacks API returned exit 9 and later layers were never linked. The PRs and their base chain are correct and complete; only the Stack object is missing. Merge bottom-up by hand as described below, or re-register by hand once stacks are enabled again.'
      : stackRegistered
        ? 'registered incrementally as each layer published, reconciled at finalize'
        : bottomToTop.length >= 2
          ? `NOT REGISTERED IN THE LANE — every in-lane link failed${lastLinkFailure ? ` (last: ${lastLinkFailure})` : ''}; finalize's reconcile was the first real attempt, see its report below. Until a stack object exists, merge bottom-up by hand.`
          : 'not registered — the stack never reached two layers, which is the minimum `gh stack link` accepts',
  stack_bottom_to_top: bottomToTop.map((l) => `${l.label}: ${l.pr_url}`),
  state: complete ? 'complete — ready for review' : 'partial — ready for review, spec stays open',
  merge_how: STACK_MODE === 'native' && !stackDisabled
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
  integration_unfixed: [
    ...integrationUnaccounted.map((f) => `[${f.severity}] ${f.location} — ${f.issue} — no verdict came back`),
    ...integrationVerdicts.filter((v) => v.action === 'rejected').map((v) => `${v.location} — ${v.issue} — rejected: ${v.reason}`),
    ...(findings.length && !integration ? [`no integration PR was opened — any fix that landed sits unpublished on spec/${SPEC}-integration`] : []),
  ],
  notes: NOTES_DIR,
  local_only_branches: (() => {
    const unpublished = auto.filter((t) => !stacked.some((x) => x.number === t.number)).map((t) => `ticket/${t.number}`)
    if (integration === null && findings.length) unpublished.push(`spec/${SPEC}-integration`)
    return unpublished.length
      ? { note: `Never pushed. Any work these carry is on the branch in ${REPO_DIR}'s clone only — the worktrees that built it were removed where clean and on the branch, kept otherwise; see worktrees_kept.`, refs: unpublished }
      : null
  })(),
  // Every worktree a reclaim refused to remove, with git's reason. Each is a
  // dead agent's uncommitted work or a file the OS still holds — both for the
  // operator, neither for --force.
  worktrees_kept: worktreesKept,
  finalize,
}
