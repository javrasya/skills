export const meta = {
  name: 'implement-spec-__SPEC__',
  description: 'Implement spec #__SPEC__ as a stack of PRs: discover the ticket graph, implement each ticket in its own worktree (in sequential order, the run\'s one chain worktree), gate it, publish it as one stacked PR, review the whole stack, register it',
  phases: [
    { title: 'Graph', detail: 'read the spec and its tickets, return the task graph' },
    { title: 'Explore', detail: 'research notes saved outside the repo' },
    { title: 'Unblock', detail: 'when discovery found blockers: an attended session where the operator clears them, before anything is built' },
    { title: 'Setup', detail: 'layer-0 PR when the operator named prior work at arm time (ADR-0023)' },
    { title: 'Implement', detail: 'a dispatcher sizes each ticket; fresh slice agents implement it, frontier-scheduled' },
    { title: 'Gate', detail: 'code-review each ticket branch before it is published' },
    { title: 'Stack', detail: 'serial publish lane: rebase onto the tip (never in sequential order, whose tip never moves under a ticket), one draft PR per ticket, reclaim the ticket\'s worktrees' },
    { title: 'Review', detail: 'code-review the whole stack; fixes land as the top PR' },
    { title: 'Finalize', detail: 'reconcile the stack, ready the PRs, reclaim the worktrees the lane has not' },
  ],
}

// ---- harness and model per role -----------------------------------------
// The one table an operator edits to move a role between harnesses — cheap
// roles on pi, hard ones on Claude. Every agent() call spreads its role's row.
// harness: 'claude' (Claude Code) or 'pi'. model: always a Claude model name.
// piModel: a pi model pattern ('provider/id'), read only for a pi row.
// Only the session runner reads `harness` and `piModel`. The Workflow runner
// ignores both and runs every role on Claude with `model`, so a pi row keeps a
// Claude `model` beside its `piModel` — e.g.
// { harness: 'pi', piModel: 'openai/gpt-5', model: 'opus' } — and the same
// rendered script runs on either runner.
// `crew start` renders this table (packages/crew/src/arm.mjs, renderRoles):
// RUN_DEFAULT becomes the harness and model its form chose, and a role named
// in crew's per-repo `roles` config gets a row of its own in place of
// RUN_DEFAULT. Keep RUN_DEFAULT's line and the `<role>: RUN_DEFAULT,` rows in
// this shape, or crew refuses to arm.
const RUN_DEFAULT = { harness: 'claude', model: 'opus' }
const ROLES = {
  graph: RUN_DEFAULT,         // Graph: read the spec, return the ticket graph
  explore: RUN_DEFAULT,       // Explore: one research note
  unblock: RUN_DEFAULT,       // Unblock: guide the operator through the blockers (session runner only)
  layer0: RUN_DEFAULT,        // Setup: the layer-0 PR
  dispatch: RUN_DEFAULT,      // Implement: size a ticket into slices
  impl: RUN_DEFAULT,          // Implement: one slice
  gate: RUN_DEFAULT,          // Gate: code-review one ticket
  fixDispatch: RUN_DEFAULT,   // Gate, Review: route findings into fix slices
  fix: RUN_DEFAULT,           // Gate, Review: one fix slice
  publish: RUN_DEFAULT,       // Stack, Review: a ticket's PR, or the integration PR
  review: RUN_DEFAULT,        // Review: code-review the whole stack
  finalize: RUN_DEFAULT,      // Finalize: reconcile and ready the stack
  recover: RUN_DEFAULT,       // any phase: a doctor for an agent that failed (session runner only)
}
// Two more opts every agent() call may carry, both for the runner (ADR-0016):
// `node` — the call's stable name for WHAT it is, never when it ran
// (`ticket/12/impl/r2/s1`, `review`): unique within a run and the same on a
// re-run given the same results, so a runner can keep a finished node's result
// by name. `inFlight: true` — a call a single-slice ticket still makes while
// the run is halting, so a runner can tell it from new work.

// ---- interpolated by the skill ------------------------------------------
const REPO = '__REPO__'                            // owner/name
const SPEC = __SPEC__                              // spec issue number
const REPO_DIR = String.raw`__REPO_DIR__`          // main checkout
const NOTES_DIR = String.raw`__NOTES_DIR__`        // research notes, outside the repo
const BASE_REF = '__BASE_REF__'                    // branch the stack merges into
const START_REF = '__START_REF__'                  // prior work the operator named at arm time: the stack's layer 0, or BASE_REF itself for none (ADR-0023). No agent of this run chooses it
const STACK_MODE = '__STACK_MODE__'                // 'native' (gh-stack + stacks API) or 'chain' (plain --base chain)
const RUN_ORDER = '__RUN_ORDER__'                  // 'parallel' (the frontier at once) or 'sequential' (one ticket at a time, session runner only; ADR-0020)
const RUNNER = '__RUNNER__'                        // 'session' on the session runner (crew, on Orca), and 'orca', its value before, still; anything else is the Workflow runner. The one line the two renderings differ in
// -------------------------------------------------------------------------

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
// work on START_REF — is authoritative on origin, where the operator or
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
//
// On the session runner that worktree is a child of the run's worktree, made by
// its session host, and
// the script reclaims nothing: every agent is kept for the whole run, and the
// runner asks the operator what to reclaim once summary.json is written
// (ADR-0012). The reclaim steps below therefore hand a session run no path, and
// the rendered script stays the same under both runners but for RUNNER.
const ON_SESSION = RUNNER === 'session' || RUNNER === 'orca'
// The skill refuses this before rendering (SKILL.md step 1); this is the
// backstop for a script rendered by hand.
if (RUN_ORDER !== 'parallel' && RUN_ORDER !== 'sequential') throw new Error(`RUN_ORDER is '${RUN_ORDER}': it must be 'parallel' or 'sequential'`)
if (RUN_ORDER === 'sequential' && !ON_SESSION) throw new Error('sequential run order needs the session runner: a sequential run points its agents one after another at one folder, and the Workflow runner cannot point two agents at one folder; re-arm with run order parallel, or on the session runner')
// The session runner starts each doctor itself, with no agent() call to spread a
// row into, so it reads the recover row from meta (ADR-0014).
if (ON_SESSION) meta.roles = ROLES
// A sequential run's code agents share the run's one chain worktree, one
// after another, each picking up the build cache the one before it left
// (ADR-0020); a parallel run's each get one of their own.
const ISOLATION = RUN_ORDER === 'sequential' ? 'chain' : 'worktree'

// Layer 0 (ADR-0003, ADR-0023): prior work the OPERATOR named when arming,
// which becomes the bottom of the stack with a PR of its own. The graph agent
// used to find such a branch itself, and an observed run (#827) had it pick
// up an aborted run's integration branch, then re-implement a ticket whose
// work was already on it. Now the operator names it or there is none, and the
// graph agent's one job about it is to say which tickets it already covers.
const hasLayer0 = START_REF !== BASE_REF
const WORKTREE = ISOLATION === 'chain'
  ? `Your worktree is this run's one chain worktree, made by its session host and worked in by its code agents one after another: the dependencies and build cache the agent before you left are yours to use. Leave nothing of your own in it uncommitted. Before you return, run \`git rev-parse --show-toplevel\` and return that absolute path as \`worktree\`. Never remove it: the operator decides at the end of the run whether it is reclaimed.`
  : ON_SESSION
  ? `Your worktree is a child worktree of this run's worktree, per agent, made by this run's session host. Before you return, run \`git rev-parse --show-toplevel\` and return that absolute path as \`worktree\`. Never remove it: the operator decides at the end of the run whether it is reclaimed.`
  : `Your worktree is throwaway and per agent. Before you return, run \`git rev-parse --show-toplevel\` and return that absolute path as \`worktree\`. This run reclaims it — uncommitted leftovers included — once the work it holds is published.`

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
const prevPublisher = () => (prevPublishWorktree && !ON_SESSION ? [prevPublishWorktree] : [])
// Entries not yet handed to any reclaimer. Marked reclaimed only once the reclaimer
// returned: a reclaimer that died leaves them for the next one, or finalize.
function pendingWorktrees(keys) {
  if (ON_SESSION) return []
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
  : ON_SESSION
    ? `Remove no worktree — not yours, not any other: on this runner every agent's worktree is kept until the run ends, and the operator decides then what is reclaimed. Report 0 removed and none kept.`
    : `No worktrees to reclaim this time: report 0 removed and none kept.`
// A dead agent never reported a path, so its worktree is not in the ledger.
// The harness names a run's worktrees `wf_<run>-<n>`; the prefix is read off
// any reported path so a reclaimer can NAME the strays without touching them.
// The session runner reclaims nothing in-script, so there is nothing to guess.
const strayPrefix = () => {
  for (const e of worktreesOf.values()) for (const p of e.paths) { const m = /^(.*[\\/]wf_[^\\/]+-)\d+$/.exec(p); if (m) return m[1] }
  return null
}
const strayStep = () => {
  const prefix = ON_SESSION ? null : strayPrefix()
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

// How a check is run, told to every agent that carries the validation list.
// Measured over 4821 validation calls of one project's runs: 55% of the wall
// time was waiting (sleep/pgrep loops around backgrounded tests), the full
// suite ran 193 times where a scoped run would have done, and end-of-agent
// cache cleans deleted what the next agent could have reused. See ADR-0009.
const RUNNING = `Running checks:
- While iterating, run the narrowest scope your build tool supports (one package, one crate, one test file). Run the validation list once, after your last edit, before you return.
- Run every check in the foreground, exactly as written. Never launch a check in the background. If the harness moves a long command to the background on its own, wait on it once with the harness's wait primitive — never with a sleep, pgrep or polling loop.
- Never run a build-cache clean (\`cargo clean\` or its equivalent). The worktree remove at reclaim is the only disk reclaim this run does.`

// --- the acceptance contract and readiness ---------------------------------
// What a ticket owes is the ticket's criteria, the spec, and any ADR the spec
// itself creates or amends — nothing else. Existing ADRs were checked when the
// spec was designed; re-proving them ticket by ticket cost an observed run
// (spec #339) most of its gate rounds without changing whether a PR was
// mergeable. Told to dispatchers, implementers and reviewers alike, so all
// three hold the same definition of done.
const CONTRACT = `The acceptance contract for this ticket is its own acceptance criteria, the spec's decisions that bear on it, and any ADR the spec itself creates or amends. Nothing else binds: existing ADRs and repo conventions are guidance, not criteria — follow them where cheap, never re-prove them.`

// Readiness is the ticket's per-change commands green on the exact commit
// under review. Running a command is not the self-assessment ADR-0004 forbids
// — the agent does not judge, the exit code does — so the implementer runs
// it, and the reviewer establishes it first: by inheriting the implementer's
// result when the sha is unchanged (ADR-0009), else by re-running. The
// commands are the ticket's own `### Run per change`, copied by its dispatcher
// (ADR-0029); its `### Run at review` half runs once, on the stack tip, in the
// whole-stack review, and never reaches a per-ticket role.
const validationLine = (cmds) => `${cmds.length
  ? `Ticket validation — run per change. Run EVERY command below on your final commit and return one result per command, the command copied verbatim:\n${cmds.map((c) => `- \`${c}\``).join('\n')}`
  : `This ticket's validation recipe has no per-change commands. Run the repo's tests for what you touched and return each command you ran with its result.`}
${RUNNING}`
// A green result travels with the sha it was green on (ADR-0009). The agent
// downstream checks the sha itself — one rev-parse — and inherits the result
// when nothing changed, so the run pays for each tree once. Re-running on an
// unchanged tree was 36 of 153 measured full-suite runs, provably; the same
// rule is what ECONOMY asks for and could not enforce.
const inherit = (v) => v && v.sha
  ? `The branch was validated green at \`${v.sha}\` by ${v.by}. Run \`git rev-parse HEAD\`: if it matches and you have edited nothing, inherit that result — report every check with \`passed: true\` and \`validated_sha\` = \`${v.sha}\` — instead of re-running. If it differs, or you edited anything, run the list.`
  : ''
// The commands a result set leaves red or missing. Whitespace-insensitive,
// because agents copy imperfectly; anything looser would credit the wrong run.
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const readinessRed = (checks, cmds) => cmds.filter((c) => !(checks || []).some((k) => norm(k.command) === norm(c) && k.passed))
// One result per command. A single green boolean is what let a fixer report
// "tests, clippy, docs green" while fmt was never run (#344).
const CHECKS_FIELD = {
  checks: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'passed'],
      properties: {
        command: { type: 'string', description: 'the exact command, copied verbatim from the validation list' },
        passed: { type: 'boolean' },
      },
    },
    description: 'one entry per validation command run on the final commit',
  },
  validated_sha: { type: 'string', description: '`git rev-parse HEAD` of the commit the whole validation list last passed on; empty if it never passed' },
}

// What discovery finds missing from the environment (ADR-0021): something a
// person supplies once — a credential, a signing identity, a device or service
// set up — so agents can do the rest. Never a ticket: those stay automated.
const BLOCKERS_FIELD = {
  blockers: {
    type: 'array',
    description: 'what the environment is missing that a person must supply once; empty when nothing is',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'tickets', 'why', 'evidence', 'check'],
      properties: {
        subject: { type: 'string', description: 'what is missing, named plainly' },
        tickets: { type: 'array', items: { type: 'integer' }, description: 'the tickets that need it' },
        why: { type: 'string', description: 'what those tickets cannot do without it' },
        evidence: { type: 'string', description: 'what you ran or read that shows it missing' },
        check: { type: 'string', description: 'one command that succeeds once it is there' },
      },
    },
  },
}

const GRAPH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tickets', 'explorations', 'blockers'],
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        // map_position orders a sequential run only (runInOrder), so only a sequential run asks for it;
        // done_in_prior_work is asked only when the operator named prior work (ADR-0023).
        required: ['number', 'title', ...(RUN_ORDER === 'sequential' ? ['map_position'] : []), 'blocked_by', 'needs_human', 'human_reason', ...(hasLayer0 ? ['done_in_prior_work', 'prior_work_evidence'] : [])],
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          ...(RUN_ORDER === 'sequential' && { map_position: { type: 'integer', description: "1-based place in the spec's own map of its tickets; 0 when the spec does not place it" } }),
          blocked_by: { type: 'array', items: { type: 'integer' } },
          needs_human: { type: 'boolean' },
          human_reason: { type: 'string', description: 'empty when needs_human is false' },
          ...(hasLayer0 && {
            done_in_prior_work: { type: 'boolean', description: `true only when every acceptance criterion of the ticket is already met by \`${BASE_REF}..${START_REF}\`` },
            prior_work_evidence: { type: 'string', description: 'the commits (sha and subject) or files that show it; empty when done_in_prior_work is false' },
          }),
        },
      },
    },
    ...BLOCKERS_FIELD,
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
      properties: { path: { type: 'string' }, reason: { type: 'string', description: `why it was kept: dirty, HEAD not on its branch, or the refusal git gave` } },
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
  required: ['branch', 'summary', 'checks', 'validated_sha', 'unmet', 'decisions_needed', 'decided', 'worktree'],
  properties: {
    branch: { type: 'string' },
    summary: { type: 'string', description: 'one or two sentences' },
    ...CHECKS_FIELD,
    unmet: { type: 'array', items: { type: 'string' }, description: 'the REMAINDER: work the brief asked for that you did not do — a criterion, a test, a file. Empty when the brief is done. Never a question for a human, and never a criterion blocked on one; that goes in decisions_needed' },
    decisions_needed: { type: 'array', items: { type: 'string' }, description: 'a contradiction only a human can settle, because every fix breaks something the ticket, its spec or an ADR explicitly says to keep. Name the criterion, the constraint and the evidence. It halts this ticket. Never work you did not do' },
    decided: { type: 'array', items: { type: 'string' }, description: 'each contradiction or silence you closed yourself inside what the ticket leaves open: what the ticket said, what the code showed, what you chose. It goes on the PR' },
    ...WORKTREE_FIELD,
  },
}

const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket_brief', 'validation', 'review_validation', 'slices'],
  properties: {
    ticket_brief: { type: 'string', description: 'one short paragraph on the whole ticket, for later fix agents — they read this instead of the issue' },
    validation: { type: 'array', items: { type: 'string' }, description: "every command the ticket's `### Run per change` subsection lists, each copied verbatim; empty when it lists none" },
    review_validation: { type: 'array', items: { type: 'string' }, description: "every command the ticket's `### Run at review` subsection lists, each copied verbatim; empty when it lists none" },
    slices: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'brief', 'effort'],
        properties: {
          title: { type: 'string' },
          brief: { type: 'string', maxLength: 3000, description: 'four sections and nothing else: the acceptance criteria this slice owns, verbatim; the files you expect it to touch; the research notes to read; what is out of scope. No design — no function to reuse, no test body, no doc paragraph to delete' },
          effort: { type: 'string', enum: ['medium', 'high'], description: 'reasoning effort for the slice implementer' },
        },
      },
    },
  },
}

const PUBLISH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['published', 'nothing_to_publish', 'pr_url', 'pr_number', 'conflicts_resolved', 'checks', 'validated_sha', 'stack_link', 'note', 'worktree', 'worktrees_removed', 'worktrees_kept', 'decisions_needed'],
  properties: {
    published: { type: 'boolean' },
    // The branch has no commit beyond the tip it was cut from: the ticket's
    // work was already there, and there is no PR to open. Not a failure and
    // not a decision: the script records the ticket as subsumed and moves on.
    nothing_to_publish: { type: 'boolean', description: 'true when `git rev-list --count <base>..<branch>` is 0; then published is false and decisions_needed is empty' },
    // A publisher that cannot publish says why here: the runner holds its node
    // and halts the run, and a resume carries the same session on once the
    // operator acted, rather than replaying a publish that never happened.
    decisions_needed: { type: 'array', items: { type: 'string' }, description: 'empty when published; else what stopped you and what the operator must do' },
    pr_url: { type: 'string' },
    pr_number: { type: 'integer' },
    conflicts_resolved: { type: 'array', items: { type: 'string' } },
    ...CHECKS_FIELD,
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
const FINDINGS_FIELD = {
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
}
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'worktree'],
  properties: { ...WORKTREE_FIELD, ...FINDINGS_FIELD },
}
// The gate reviewer also establishes readiness before it reads a line — by
// inheriting the implementer's result when the sha is unchanged (ADR-0009),
// else by re-running the list. A red there is a readiness failure, routed
// back to dispatch, not a finding.
const GATE_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks', 'validated_sha', 'findings', 'worktree'],
  properties: { ...WORKTREE_FIELD, ...CHECKS_FIELD, ...FINDINGS_FIELD },
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
  required: ['verdicts', 'unfinished', 'checks', 'validated_sha', 'worktree'],
  properties: {
    verdicts: VERDICTS,
    ...CHECKS_FIELD,
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

const EXPLORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'blockers'],
  properties: {
    path: { type: 'string', description: 'the absolute path of the note you wrote' },
    ...BLOCKERS_FIELD,
  },
}

// The unblock agent's result: every blocker it saw verified clear, and, as a
// node's decisions_needed, each it could not — which holds the node and halts
// the run until a resume carries the same session on (ADR-0016, ADR-0021).
const UNBLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resolved', 'decisions_needed'],
  properties: {
    resolved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'verified_by'],
        properties: { subject: { type: 'string' }, verified_by: { type: 'string', description: 'the check you ran and what it showed' } },
      },
    },
    decisions_needed: { type: 'array', items: { type: 'string' }, description: 'each blocker still not clear, and why; empty once every one is' },
  },
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

Find the tickets: sub-issues of #${SPEC}, issues that reference #${SPEC}, and issues linked from the spec body. Search each way — GitHub's sub-issue API is often empty even when the tickets exist.

Blocking relationships: query GitHub's native dependencies first, per ticket — \`gh api "repos/${REPO}/issues/<n>/dependencies/blocked_by" -q '[.[].number]'\`. Only when that returns an empty list or a 404 fall back to prose: read the ticket's "Blocked by" section (or equivalent) and resolve it to issue numbers. A dependency the ticket calls soft or tests-only is still a dependency — record it.
${RUN_ORDER === 'sequential' ? `
map_position: where the spec itself places the ticket in its map of tickets — the ordered list, table or diagram of its slices — counting from 1. A ticket the spec does not place gets 0. Read it off the spec as written; do not rank the tickets yourself.
` : ''}
Set needs_human on a ticket whose work itself cannot be done by an agent alone — a person must do it with their own hands throughout — or whose label says so. Put the reason in human_reason.

blockers: what this machine is missing that a person can supply once so agents can do the rest — a credential, a signing identity or profile, an account or permission, a device or service set up and running. Check, do not guess: look for it (the keychain, the config file, the running process, the env var) and record what you ran as evidence. Something missing that a person supplies once is a blocker, not needs_human: the tickets that need it stay automated, and the run clears its blockers with the operator before it builds anything. Give each a \`check\` command that succeeds once it is there. Nothing missing: an empty list.

${hasLayer0 ? `done_in_prior_work: the operator named \`${START_REF}\` as prior work for this spec; it becomes the bottom layer of the stack, and this run builds on it. Read what it already holds — \`git fetch origin\`, then \`git log --format='%h %s' ${ref(BASE_REF)}..${ref(START_REF)}\` and, where a subject names a ticket, its diff — and for each ticket say whether EVERY one of its acceptance criteria is already met there. A ticket that is becomes no agent's work: it is closed by the layer-0 PR. Partly done is false: its implementer starts from that branch and finishes it. Cite the commits or files in prior_work_evidence; never guess from titles alone.
` : `Prior work: the operator named none, so the stack starts on \`${BASE_REF}\`. Do not look for a branch carrying work for this spec, and propose none: which branch the stack starts on is the operator's call, made when the run was armed, never yours.
`}
explorations: propose up to 4 research questions whose answers implementers will need — the code paths, the external API contracts, the existing test arrangement. A question need not serve every ticket: give each a label that names its subject plainly, so an implementer can tell whether it bears on their ticket. Ask what is expensive to discover, not what a ticket already states.`,
  { ...ROLES.graph, phase: 'Graph', schema: GRAPH_SCHEMA, label: `graph:spec-${SPEC}`, node: 'graph' },
)
if (!graph) throw new Error('graph discovery failed')

const all = graph.tickets
const byNum = new Map(all.map((t) => [t.number, t]))
// A ticket the prior work already finishes (ADR-0023) is nobody's work: it
// is closed by the layer-0 PR, and it blocks nothing — its work is on the
// branch every later ticket is cut from.
const subsumed = hasLayer0 ? all.filter((t) => t.done_in_prior_work) : []
const isSubsumed = (n) => subsumed.some((t) => t.number === n)
const blocked = new Set()
for (let pass = 0; pass < all.length + 1; pass++) {
  for (const t of all) {
    if (isSubsumed(t.number)) continue
    if (t.needs_human) blocked.add(t.number)
    if (t.blocked_by.some((d) => blocked.has(d))) blocked.add(t.number)
  }
}
const auto = all.filter((t) => !blocked.has(t.number) && !isSubsumed(t.number))
const deferred = all.filter((t) => blocked.has(t.number))
log(`${all.length} tickets. Automating ${auto.map((t) => '#' + t.number).join(', ') || 'none'}.`)
if (subsumed.length) {
  log(`Already done on ${START_REF}, closed by the layer-0 PR: ${subsumed.map((t) => `#${t.number} (${t.prior_work_evidence})`).join(', ')}`)
}
if (deferred.length) {
  log(`Deferred to a human: ${deferred.map((t) => '#' + t.number + (t.needs_human ? '' : ' (downstream)')).join(', ')}`)
}
if (!all.length) throw new Error(`spec #${SPEC} has no implementation tickets — break it into ticket sub-issues first, then arm again`)
if (!auto.length) {
  return subsumed.length
    ? { spec: SPEC, error: `every automatable ticket is already done on ${START_REF}: publish that branch by hand and close them, or arm again with no prior work`, subsumed: subsumed.map((t) => t.number), deferred: deferred.map((t) => t.number) }
    : { spec: SPEC, error: 'every ticket needs a human', deferred: deferred.map((t) => t.number) }
}

// --- step 2: exploration subagents, notes saved outside the repo ----------
phase('Explore')
// One node per topic, named by its slug; a repeated slug gets its index.
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'topic'
const exploreNodes = graph.explorations.map((e, i, a) =>
  a.filter((x) => slug(x.label) === slug(e.label)).length > 1 ? `explore/${slug(e.label)}-${i + 1}` : `explore/${slug(e.label)}`)
const notes = (await parallel(
  graph.explorations.map((e, i) => () =>
    agent(
      `Research this question against the codebase and any external docs it needs, then save your findings as markdown.

Question: ${e.question}

${POINTERS}

Write your notes to ${NOTES_DIR}/${String(i + 1).padStart(2, '0')}-${e.label.replace(/[^a-zA-Z0-9._-]/g, '-')}.md (create the directory if absent — it lives outside the repo on purpose, so create no files inside the checkout). Cite file:line for every claim. Later agents read this instead of re-deriving it, so record what is expensive to find and skip what the tickets already say.

Keep the note under 300 lines. Every reader ingests it whole at full price, so cite file:line and name what the code does rather than quoting it back — they can read the code; the note saves them the search, not the reading.

${ECONOMY}

If your research shows this machine missing something a person must supply once — a credential, a signing identity or profile, an account, a device or service set up and running — return it in \`blockers\`, with the evidence you saw and a \`check\` command that succeeds once it is there. Check, do not guess; nothing missing is an empty list.

Return the absolute path you wrote, and your blockers.`,
      { ...ROLES.explore, effort: 'low', phase: 'Explore', schema: EXPLORE_SCHEMA, label: `explore:${e.label}`, node: exploreNodes[i] },
    ),
  ),
)).filter(Boolean)
log(`${notes.length} research notes in ${NOTES_DIR}`)

// --- step 2b: clear the blockers with the operator (ADR-0021) -------------
// Everything discovery found missing is cleared before anything is built, so
// every automated ticket runs undisturbed. The session runner opens one
// attended session the operator joins; no clock hurries it. A blocker it
// cannot clear comes back as the node's decisions_needed, which holds the
// node and halts the run until a resume carries that same session on. The
// Workflow runner has nobody in its sessions, so it halts here instead.
const blockers = [...(graph.blockers || []), ...notes.flatMap((n) => n.blockers || [])]
const neededBy = (b) => (b.tickets.length ? b.tickets.map((t) => '#' + t).join(', ') : 'the run')
const blockerList = blockers.map((b) => `${b.subject} (${neededBy(b)})`).join('; ')
const haltOnBlockers = (why) => {
  log(`HALTED at Unblock — ${why}: ${blockerList}`)
  return {
    spec: SPEC,
    halted: true,
    reason: `${why}: ${blockerList}. Nothing was built. Clear them, then resume the run.`,
    blockers,
    published: [],
    notes: NOTES_DIR,
  }
}
if (blockers.length) {
  log(`${blockers.length} blocker(s) to clear before anything is built: ${blockerList}`)
  if (!ON_SESSION) return haltOnBlockers('this machine is missing what the tickets need, and the Workflow runner has nobody to clear it with')
  phase('Unblock')
  const cleared = await agent(
    `Help the person at this machine clear what it is missing before the run for spec #${SPEC} builds anything.

${POINTERS}

Discovery found these blockers. Each names what is missing, the tickets that need it, what was seen, and a command that succeeds once it is there:

${blockers.map((b, i) => `${i + 1}. ${b.subject} — needed by ${neededBy(b)}: ${b.why}
   evidence: ${b.evidence}
   check: \`${b.check}\``).join('\n')}

Some may repeat one another — treat them as one. Before you start, run every check: one that already passes is resolved, and you tell the person so.

You guide; the person acts. Never install, sign, configure, create or fetch anything yourself, and never handle a secret: a credential, a certificate, an account or a permission is the person's decision and the person's action. Explain what each blocker is and why the tickets need it, ask what you need to know (which account, which machine, what they already have), tell them step by step what to do, and wait for them for as long as they take. Once they say a step is done, run its check. A check that still fails: say what it shows and work out the next step together.

End when every blocker's check passes: each in \`resolved\`, with the check you ran and what it showed. If the person tells you to stop with some still failing, put each of those in \`decisions_needed\` with why it is not clear — the run then halts, and resuming it brings you back here.`,
    { ...ROLES.unblock, phase: 'Unblock', schema: UNBLOCK_SCHEMA, attended: `blockers: ${blockers.map((b) => b.subject).join(' · ')}`, label: 'unblock', node: 'unblock' },
  )
  // The session runner holds an unresolved node until a resume clears it, so
  // this is any runner that hands one back.
  if (!cleared) return haltOnBlockers('the unblock session ended without a result')
  if (cleared.decisions_needed.length) return haltOnBlockers(`the unblock session left some uncleared (${cleared.decisions_needed.join('; ')})`)
  log(`Unblocked: ${cleared.resolved.map((r) => r.subject).join('; ') || 'nothing left to clear'}`)
}

// --- step 3: layer 0 — prior work becomes the bottom of the stack --------
// The stack's whole-stack merge lands on BASE_REF, and a `Closes #N` only fires
// on a merge into the default branch — so prior work must ride IN the stack,
// as its own layer with its own PR, not be the branch the stack merges into.
phase('Setup')
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

The operator named \`${START_REF}\` as prior work for this spec when arming this run: it already carries work done before the run, and it becomes the bottom layer of the stack. \`git fetch origin\`, then \`git switch --detach ${ref(START_REF)}\` so your worktree sits on the layer it publishes (the reclaim that later removes it checks exactly that), confirm the branch exists on origin (push it from the local checkout if it only exists locally — plain push, no force), then open a DRAFT PR: head \`${START_REF}\`, base \`${BASE_REF}\`, title from the branch's work. The body must open with exactly this line:

${layerLine(1)}

and then say plainly that this PR carries pre-existing work for spec #${SPEC} that this run did not implement or gate — the operator should review it with that in mind.${subsumed.length ? `

The graph agent found these tickets already finished on this branch, so this PR closes them: put one line per ticket in the body, exactly \`Closes #<n>\`, for ${subsumed.map((t) => `#${t.number}`).join(', ')}, each followed by the evidence in one line:
${subsumed.map((t) => `- #${t.number}: ${t.prior_work_evidence}`).join('\n')}` : ''}

Do not register a stack: \`gh stack link\` needs two layers and this is the only one so far. The next PR of the stack registers both — and every one of those calls names this branch, so: ${mirror([START_REF])}

Do not disturb the user's working copy: leave ${REPO_DIR}'s checked-out branch and its uncommitted changes exactly as you found them.

${WORKTREE}

Return the PR url and number, what the mirror found, and your worktree.`,
    { ...ROLES.layer0, effort: 'low', phase: 'Setup', schema: LAYER0_SCHEMA, isolation: ISOLATION, label: `layer0:${START_REF}`, node: 'layer0' },
  )
  if (!layer0) throw new Error('layer-0 PR failed — prior work would be orphaned')
  noteWorktree('layer0', START_REF, layer0)
  log(`Layer 0: ${layer0.pr_url} (pre-existing work on ${START_REF}) — ${layer0.note}`)
}

// --- steps 4-6: frontier scheduling, gate, then the serial publish lane ---
// The notes are named in each slice's brief by the dispatcher, by filename,
// so a ticket that needs one of the four does not pay for the other three.

// --- the dispatcher: a router, not a planner -------------------------------
// A single long-lived implementer accumulates every read and every thought for
// its whole life and pays for them again on each turn (one measured run: 276
// turns, 362K peak context). The dispatcher resets that: it reads the ticket
// ONCE, decides how many fresh-context agents the work actually needs — one is
// the normal answer — and tells each which criteria it owns. Under-slicing
// self-corrects (an overrun comes back here as a remainder to re-slice);
// over-slicing has no corrective, so the dispatcher is biased against slicing.
//
// It answers two questions — how many agents, which criteria each — and no
// third. An observed dispatcher (#360) told to write "self-contained" briefs
// carrying "every constraint" thought for 40 minutes before its first tool
// call, wrote a 15K-char implementation plan plus five design essays, and
// cost $17; the implementer then redid the design with the code open. So the
// brief is capped, the dispatcher reads no spec and no note body, and it does
// not hunt for gaps: the ticket was cut from the spec by a human and is trusted
// as written. A gap is met by the implementer at the line where it lives.
//
// This is the dispatcher's implementation entry point. `dispatchFix` is the
// other: the same role sizing a batch of review findings. Every piece of work
// this run does goes through one of the two — nothing reaches a fixer or an
// implementer unsized.
//
// MAX_DISPATCH_ROUNDS governs re-slicing HERE only. The gate has no equivalent
// nesting: whatever a fix slice does not reach falls to the next reviewer,
// which re-derives what is still broken from the branch itself. A readiness
// red at the gate (the validation list failing on the branch) also comes back
// here as a remainder and spends one of these rounds — one cap, not two.
const MAX_DISPATCH_ROUNDS = 6

// --- halting (ADR-0016) ------------------------------------------------------
// A ticket that fails, is left with an unmet remainder or needs a human
// decision HALTS the run: review and finalize are reached only once every
// automated ticket is published, since a review of a half-built stack is
// wasted and a finalize would have to be undone by the resume. Once halting,
// no ticket starts and a running ticket makes no new agent() call — except
// one whose current dispatch returned exactly ONE slice, which finishes that
// slice, its gate and its publish, each call marked `inFlight`.
let halting = false
let haltedBy = null // the first ticket to halt the run: { number, state, detail }
// Checked before every new agent() call on a ticket's path: null when halting
// stops the call, else what its opts add. `single` — the ticket's current
// dispatch returned one slice.
const goOn = (single) => (!halting ? {} : single ? { inFlight: true } : null)

function dispatch(t, remainder, node) {
  return agent(
    `Route ticket #${t.number} — ${t.title} — to the fewest implementation slices that fresh-context agents can finish, and say which acceptance criteria each owns.

${POINTERS}
${GIT}
${remainder ? `
Earlier slices of this same run already did part of this work — \`ticket/${t.number}\` is this run's own unpublished branch (created by this workflow, no PR) carrying what they pushed. Route ONLY what remains: ${remainder}

This remainder is work the earlier brief asked for and nobody did. It is not a gap, not a question for the operator, and not something to "report": brief a slice that does it.` : ''}

You are a router, not a planner. You answer two questions — how many agents, and which criteria each owns — and no third. Read \`gh issue view ${t.number}\` for the criteria. Skim the code's STRUCTURE only — \`git ls-files\`, grep hits — to name the files each criterion is likely to touch; about five tool calls is normal. Read no spec, no research note body and no implementation, and do not work out HOW anything will be done: the implementer designs with the code in front of it, and a design done here is done twice.

The ticket was cut from the spec by a human and is trusted as written. Do not look for gaps, silences or drift; if a criterion is unclear, hand it on verbatim — the implementer meets a real gap at the line where it lives, with the code running, and settles it or halts the ticket on it from there.

Default to ONE slice. Slice only when one agent plausibly cannot finish in roughly 70 tool calls; when unsure, do not slice. Slices run sequentially on one branch, so each must leave the branch consistent — building, tests green.

Each brief is under 3,000 characters and has four sections, nothing else: (1) the acceptance criteria this slice owns, copied verbatim from the ticket; (2) the files you expect it to touch; (3) which of these research notes to read — ${notes.length ? notes.map((n) => n.path).join(', ') : 'none exist'} — by filename, the ones whose subject bears on its criteria; (4) what is out of scope because another slice owns it. Every criterion of the ticket is owned by exactly one slice, including any test the ticket demands. Set each slice's effort: 'high' for the gnarly ones, 'medium' otherwise.

Also return ticket_brief: one short paragraph on the whole ticket, for later fix agents.

And return the ticket's validation recipe. Read exactly two subsections of the ticket's \`## Validation\` section, and nothing else for it — no CI config, no package scripts, no other ticket: \`### Run per change\` into \`validation\`, and \`### Run at review\` into \`review_validation\`. One array entry per command the subsection lists in backticks, copied character for character — never rewritten, merged, split, reordered or invented. A line that names no command ("absent: …", "not applicable: …", a measured time, "Needs: …") adds nothing. A subsection that is missing or lists no command is an empty array.`,
    { ...ROLES.dispatch, effort: 'high', phase: 'Implement', schema: DISPATCH_SCHEMA, label: `dispatch:#${t.number}${remainder ? ':re' : ''}`, node },
  )
}

async function runSlices(t, slices, { cutFrom, started, tag, node, validation }) {
  const out = { started, summaries: [], last: null, unmet: [], decisions: [], decided: [], stopped: null }
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]
    const go = goOn(slices.length === 1)
    if (!go) { out.stopped = `the run halted before slice ${i + 1} of ${slices.length} (${s.title})`; break }
    const r = await agent(
      `Implement one slice of ticket #${t.number}: ${s.title}${slices.length > 1 ? ` (slice ${i + 1} of ${slices.length})` : ''}.

${POINTERS}
${GIT}

Your brief — which criteria you own, which files, which notes:
${s.brief}

Read the ticket for the wording of your criteria: \`gh issue view ${t.number}\`. Read the research notes your brief names, once each. Read no spec: the ticket is the contract, and ${CONTRACT}

You design the change: your brief names what to satisfy, not how. Read the code the criteria touch and decide the approach with it in front of you.

First: \`git fetch origin && git switch --detach ${out.started ? `ticket/${t.number}\` — this run's own local branch, carrying what earlier slices of this same workflow committed minutes ago` : `${ref(cutFrom)}\` — your worktree starts on the wrong ref, and everything stacked before this ticket is reachable from there`}.

Follow the repo's own conventions and CLAUDE.md, and stay inside the brief — the rest of the ticket belongs to other slices. Comments only where load-bearing: why-not-what, landmines, pointers to external context; never narrate what code does.

${ECONOMY}

Past roughly 70 tool calls this slice has outgrown one agent's context. Stop cleanly: commit what works, move the branch to it, and name what you did not reach in \`unmet\` — the dispatcher hands the remainder to a fresh agent. A named remainder is cheap; a 300-turn agent is not.

\`unmet\` is the remainder: anything the brief asked for that you did not do, a test included. It is never a question.

When running the code shows the ticket silent, or contradicting itself or its spec: if the fix stays inside what the ticket leaves open, decide it yourself and record it in \`decided\` — it goes on the PR. If the fix would break something the ticket, its spec or an ADR explicitly says to keep, stop that criterion, leave no code for it, and put it in \`decisions_needed\` naming the constraint and the evidence — never in \`unmet\`: it halts this ticket for the operator, and blocked work handed out again as remainder cannot move. Then go on to the next criterion.

${validationLine(validation)}
Every command must pass on the commit you return. Commit, then move the ticket branch onto your work: \`git update-ref refs/heads/ticket/${t.number} HEAD\`. Push nothing — this branch reaches origin exactly once, when the stack lane publishes it.

${WORKTREE}

Return the branch, a one-line summary, one result per validation command, the sha the list passed on in \`validated_sha\`, anything from the brief you did not reach in \`unmet\`, what you settled yourself in \`decided\`, any contradiction for the operator in \`decisions_needed\`, and your worktree.`,
      { ...ROLES.impl, effort: s.effort, phase: 'Implement', schema: IMPL_SCHEMA, isolation: ISOLATION, label: `${tag}${slices.length > 1 ? `:s${i + 1}` : ''}`, node: `${node}/s${i + 1}`, ...go },
    )
    if (!r) throw new Error(`slice implementer for #${t.number} died (${s.title})`)
    noteWorktree(t.number, `ticket/${t.number}`, r)
    out.started = true
    out.summaries.push(r.summary)
    out.last = r
    out.decided.push(...(r.decided || []))
    // A decision needed ends the ticket's slice rounds, whatever else the slice
    // says: an agent has filed the blocked criterion in `unmet` too, and the
    // re-dispatched slice then waited on a reply nobody was there to give.
    if (r.decisions_needed.length) { out.decisions.push(...r.decisions_needed); break }
    // A red or missing validation result is a remainder like any other: the
    // brief asked for a green list and did not get one.
    const red = readinessRed(r.checks, validation)
    const unmet = [...r.unmet, ...red.map((c) => `validation red or not run: ${c}`)]
    if (unmet.length) {
      // Later slices may depend on the unfinished part: stop the round and let
      // the dispatcher re-slice the whole remainder rather than build on sand.
      out.unmet.push(...unmet, ...slices.slice(i + 1).map((x) => `not started: ${x.title}`))
      break
    }
  }
  return out
}

// The stack, bottom to top. `tip` is the branch the next PR is based on.
// Publish-once: a branch is rebased and pushed only BEFORE its PR exists;
// after enqueuePublish resolves, nothing touches that branch again.
const stacked = []
let tip = hasLayer0 ? START_REF : BASE_REF

// The stack is registered as it grows, not at the end: the operator sees a
// real stack map from the second PR onward instead of waiting for the run.
// The lane is the only place this can happen — two concurrent `gh stack link`
// calls against one stack is exactly the race the lane exists to prevent.
//
// `stackLayers()` is the full bottom-to-top list, re-listed on every publish.
// `link` reconciles rather than replaces ("existing PRs are never removed"),
// so re-listing needs no stack number to discover and no state to carry
// between agents — the same reason the tip is derived and never remembered.
const stackLayers = () => [...(hasLayer0 ? [START_REF] : []), ...stacked.map((s) => s.branch)]
let stackRegistered = false
// The last non-transient link failure, for the brief: a rejected push is a
// fact about a branch, not the weather, and the operator has to hear it.
let lastLinkFailure = null
// Latches on exit 9 only: the stacks API went away mid-run, and no later call
// will fix that. Chain mode starts here, so the lane never links at all.
let stackDisabled = STACK_MODE !== 'native'

let lane = Promise.resolve()
function enqueuePublish(t, impl, cutFrom, single) {
  const run = lane.then(() => {
    // Checked when the lane reaches the ticket, not when it queued: the run may
    // have started halting while it waited.
    const go = goOn(single)
    if (!go) return { stopped: true }
    const base = tip
    if (RUN_ORDER === 'sequential' && cutFrom !== base) throw new Error(`publish of #${t.number}: the tip moved from ${cutFrom} to ${base} under a sequential run, whose publishes never rebase`)
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
Stack so far, bottom to top: ${stacked.length ? stacked.map((s) => `#${s.number} (${s.branch})`).join(' → ') : hasLayer0 ? `layer 0 (${START_REF})` : 'empty'}.

1. \`git fetch origin\` — for the inherited refs; this run's own branches are already local.
2. ${reclaimStep(toReclaim)}${toReclaim.length ? `
   This comes before any rebase on purpose: the check is that a worktree's HEAD sits on its branch, and a rebase would orphan every one of them from the branch they built.` : ''}
3. \`git switch --detach ${impl.branch}\`. Then \`git rev-list --count ${ref(base)}..${impl.branch}\`: if it is 0 the branch adds nothing to \`${base}\` — the ticket's work was already there — and there is no PR to open. Stop here: return \`published: false\`, \`nothing_to_publish: true\`, an empty \`decisions_needed\`, and in \`note\` what \`git log --oneline -5 ${impl.branch}\` shows. Push nothing, remove nothing beyond step 2.
${cutFrom !== base ? `4. The tip moved since this ticket was cut. Replay its commits onto the tip: \`git rebase --onto ${ref(base)} ${ref(cutFrom)}\`. This rewrites only local commits that have never left this clone, so it needs no force and destroys nothing. Resolve any conflict in favour of keeping BOTH tickets' behaviour.
5. The rebase produced a tree nobody has validated. ${validationLine(impl.validation)}
   Get every command green, committing any fix.
6. Move the branch onto the rebased work: \`git update-ref refs/heads/${impl.branch} HEAD\`.` : `4. The tip has not moved: the branch already sits on \`${ref(base)}\`. No rebase.
5. ${validationLine(impl.validation)}
   ${inherit(impl.validated)}
6. The branch already points at the work; nothing to move.`}
7. Put it on origin for the first time. First \`git ls-remote --exit-code --heads origin ${impl.branch}\`: exit 0 means the branch is ALREADY on origin — an earlier run's, or someone's — and this run may not move it, not even fast-forward (publish-once, ADR-0005): stop, return \`published: false\`, and put in \`decisions_needed\` the branch, its origin sha and this run's sha, and that the operator must delete or rename the origin branch before the run can publish. Exit 2 (no such ref): \`git push origin ${impl.branch}\`. This CREATES the branch there — it overwrites nothing and needs no force. A rejected push means something you do not know about is going on: stop and report it.
8. Open a DRAFT PR: \`gh pr create --draft --head ${impl.branch} --base ${base}\` — \`--base\` takes the branch name. Title = the ticket's title. The body must open with exactly this line:

   ${layerLine(layers.length)}

   and must also contain the line \`Closes #${t.number}\`, state that it is part of the stack for spec #${SPEC}, and carry one provenance line — \`Validated green at <sha> by <role>\` — naming the sha the validation list last passed on and who ran it (you, or the role you inherited it from).${impl.decided.length ? ` Under a heading "Decided during implementation", list what the implementer settled itself where the ticket left it open:
${impl.decided.map((d) => `   - ${d}`).join('\n')}
  ` : ''} Leave it a DRAFT — every layer stays draft until the run finalizes, which is how the operator can tell the stack is still being built.
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

If you cannot publish — the base branch is not on origin, a push or the PR is refused, anything you must not work around — stop, return \`published: false\`, and put what stopped you and what the operator must do in \`decisions_needed\`. The run then waits for the operator, and once they have acted your session is carried on: check again and publish.

${WORKTREE}

Return whether it published, the PR url and number, what you resolved, one result per validation command plus the sha they hold for, how the stack link went, any note, the reclaim count and kept list, and your worktree.`,
      { ...ROLES.publish, effort: 'low', phase: 'Stack', schema: PUBLISH_SCHEMA, isolation: ISOLATION, label: `publish:#${t.number}`, node: `ticket/${t.number}/publish`, ...go },
    ).then((r) => {
      if (r && !r.published && r.nothing_to_publish) {
        // Nothing to stack: the tip stays, and the ticket is recorded as
        // subsumed rather than published, failed or held.
        noteWorktree(t.number, impl.branch, r)
        log(`#${t.number}: nothing to publish — ${impl.branch} adds no commit to ${base} (${r.note})`)
        return { ...r, subsumed: true }
      }
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

function dispatchFix(findings, { subject, brief, branch, skimRef, started, phase: ph, tag, node, go }) {
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
    { ...ROLES.fixDispatch, effort: 'medium', phase: ph, schema: FIX_DISPATCH_SCHEMA, label: `${tag}:dispatch`, node: `${node}/dispatch`, ...go },
  )
}

async function runFixSlices(slices, { subject, branch, cutFrom, started, phase: ph, tag, node, guard, ledgerKey, validated, validation }) {
  const out = { verdicts: [], unfinished: [], landed: started, died: null, stopped: false, validated: validated || null }
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]
    const go = guard()
    if (!go) { out.stopped = true; break }
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

${validationLine(validation)}
${inherit(out.validated)}
Every command must pass on the commit you return — a fix that leaves one red is not fixed; it is the next round's first finding, and a round costs two agents.

${WORKTREE}

Return one verdict per finding in your brief you fixed or rejected, the \`location\` of any you did not reach, one result per validation command, the sha the list passed on in \`validated_sha\`, and your worktree.`,
      { ...ROLES.fix, effort: s.effort, phase: ph, schema: FIX_SLICE_SCHEMA, isolation: ISOLATION, label: `${tag}${slices.length > 1 ? `:s${i + 1}` : ''}`, node: `${node}/s${i + 1}`, ...go },
    )
    // A dead fixer is not fatal — it is the next reviewer's problem, and that
    // reviewer reads the branch rather than anyone's account of it. But the
    // branch may be mid-change, so the round stops rather than building on it.
    if (!r) { out.died = s.title; break }
    noteWorktree(ledgerKey, branch, r)
    out.validated = r.validated_sha ? { sha: r.validated_sha, by: 'a fix slice' } : null
    out.landed = true
    out.verdicts.push(...r.verdicts)
    out.unfinished.push(...r.unfinished)
    // A fixer that left the validation list red has not fixed anything it
    // claims: the next reviewer's readiness check will catch it, but the log
    // should say why before it does.
    const red = readinessRed(r.checks, validation)
    if (red.length) log(`${subject}: fix slice "${s.title}" left validation red: ${red.join('; ')}`)
  }
  return out
}

// Reconciliation happens HERE, in the script, never in a prompt: the reason
// this path exists at all is that an agent's own account of what it did not do
// is unreliable. A finding with no verdict is unfixed, named, and handed to the
// next reviewer to check explicitly — not silently assumed done.
//
// `opts.node` names the fix nodes (`<node>/dispatch`, `<node>/s<i>`), and
// `opts.guard` is asked before each call: null stops the round (the run is
// halting), else it gives what the call's opts add. The whole-stack review is
// reached only once nothing halts, so it passes none.
async function fixFindings(findings, opts) {
  opts = { guard: () => ({}), ...opts }
  const skimRef = opts.started ? opts.branch : ref(opts.cutFrom)
  const go = opts.guard()
  if (!go) return { verdicts: [], unaccounted: findings, landed: opts.started, validated: opts.validated || null, stopped: true }
  const plan = await dispatchFix(findings, { ...opts, skimRef, go })
  if (!plan) {
    log(`${opts.subject}: fix dispatcher died — ${findings.length} finding(s) unaccounted`)
    return { verdicts: [], unaccounted: findings, landed: opts.started, validated: opts.validated || null }
  }
  if (plan.slices.length > 1) log(`${opts.subject}: ${findings.length} finding(s) dispatched as ${plan.slices.length} fix slices`)
  const out = await runFixSlices(plan.slices, opts)
  if (out.died) log(`${opts.subject}: fix slice "${out.died}" died — the round stops there`)
  if (out.stopped) return { verdicts: out.verdicts, unaccounted: findings, landed: out.landed, validated: out.validated, stopped: true }

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
  return { verdicts, unaccounted, landed: out.landed, validated: out.validated }
}

// A ticket is reviewed on its own still-unpublished branch, against the base it
// was cut from, while its diff is small and its author's reasoning is still
// recoverable. Review and fix alternate until a review comes back with nothing
// blocking — a fresh reviewer each round, so "clean" is a verdict rather than a
// reviewer running out of patience. Fixes land before the branch becomes a PR,
// so the gate never touches published history.
//
// What may BLOCK is deliberately narrow: an unmet criterion, a red validation
// command, or a correctness bug (panic, crash, silent data loss in release).
// ADR fit and style are minor here — see docs/adr/0008. Round 1 reads the
// whole diff; later rounds verify the claimed fixes and the lines the fixer
// touched, so the round count measures repair, not fresh discovery.
//
// Readiness comes before review: the reviewer re-runs the validation list on
// the branch, and a red there is a remainder handed back to dispatch (the
// gate returns `readiness`), not a finding handed to a fixer.
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
const BLOCKING = `What may block this ticket is exactly four things: an acceptance criterion of the ticket that the diff does not meet; a validation command that is red on the branch; a command the ticket's \`### Run per change\` lists that this prompt's per-change commands omit; and a correctness bug — a panic or crash reachable from input, an unhandled variant, silent data loss or a check that only runs in debug builds. Mark those \`blocker\` or \`major\`. Everything else — ADR fit, architecture, naming, style, a convention the repo documents — is \`minor\`, which passes the gate: it was settled when the spec was designed, or it is the whole-stack review's to judge across tickets.`
// `tk` is the ticket's own state: `single` for goOn, and `gates`, which numbers
// its gate rounds across every gate it runs (a readiness red sends the ticket
// back to dispatch and a later gate goes on counting), so each round's node
// stays unique. Returns `stopped` when halting ends the gate.
async function reviewGate(t, impl, cutFrom, ticketBrief, tk) {
  const rejected = []
  let unverified = []
  let lastFixed = []
  // The sha the branch was last green on, and who made it so. Starts as the
  // implementer's; each fix round replaces it; the reviewer inherits it when
  // HEAD still matches (ADR-0009).
  let validated = impl.validated || null
  for (let round = 1; round <= GATE_MAX_ROUNDS; round++) {
    const go = goOn(tk.single)
    if (!go) return { stopped: `the run halted before gate round ${round}` }
    const node = `ticket/${t.number}/gate/r${++tk.gates}`
    const r = await agent(
      `Review ticket #${t.number}'s branch before it is published as a PR${round > 1 ? ` — round ${round}, verifying the previous round's fixes` : ''}.

${POINTERS}
${GIT}
Branch \`${impl.branch}\`, reviewed against \`${ref(cutFrom)}\` — that diff is the whole of this ticket's work.
What the ticket asked for: \`gh issue view ${t.number}\`. What the implementer says it did: ${impl.summary}

\`git fetch origin && git switch --detach ${impl.branch}\`. Before you read a line of the diff, establish readiness. ${validationLine(impl.validation)}
${inherit(validated)}
Return one result per command in \`checks\`, and the sha they hold for in \`validated_sha\`. If any is red, stop there and return no findings — the branch is not ready for review and goes back to implementation, not to a fixer.

The per-change commands above (${impl.validation.length ? `${impl.validation.length} of them` : 'none'}) are this run's copy of the ticket's recipe. Compare them with the commands the ticket's \`### Run per change\` subsection lists, under \`## Validation\` in \`gh issue view ${t.number}\`: for each command the ticket has that this prompt omits, return a \`blocker\` finding naming that command.

${CONTRACT}
${round === 1
        ? `Then invoke the \`code-review\` skill with \`${ref(cutFrom)}\` as the fixed point and ticket #${t.number} as the spec — both its axes, with the severities below overriding whatever the skill would assign. Judge acceptance criterion by acceptance criterion.`
        : `Then verify, do not rediscover: the previous round's fixer claims to have fixed the findings below. Check each on the branch, and read the lines the fixer touched since the last review (\`git log -p\` for the newest commit(s)) for anything that fix broke. Do not re-review the rest of the diff — round 1 did, and the whole stack gets its own review later.

Claimed fixed:
${lastFixed.map((v) => `- ${v.location} — ${v.issue}\n  fixer says: ${v.reason}`).join('\n')}`}

${BLOCKING}

Judge this ticket's diff. Work another ticket owns is out of scope. Change no code — report.
${impl.decided.length ? `
The implementer closed these gaps itself, where the ticket left them open. Block on one only if it breaks something the ticket, its spec or an ADR explicitly says to keep:
${impl.decided.map((d) => `- ${d}`).join('\n')}` : ''}
${unverified.length ? `
The previous round handed these findings to a fixer that never reported back on them. Nobody knows whether they were addressed, so the branch is the only truth — check each one explicitly and raise it again if it is still real:

${unverified.map((f) => `- ${f.location} — ${f.issue}`).join('\n')}` : ''}
${rejected.length
        ? `
A previous round already raised the findings below, and the implementer judged each one wrong for the stated reason. Raise one again only if you can show its reason is false — say which part is false and why. Otherwise leave it out entirely.

${rejected.map((v) => `- ${v.location} — ${v.issue}\n  judged wrong because: ${v.reason}`).join('\n')}`
        : ''}

${WORKTREE}`,
      { ...ROLES.gate, phase: 'Gate', schema: GATE_REVIEW_SCHEMA, isolation: ISOLATION, label: `gate:#${t.number}:r${round}`, node, ...go },
    )
    noteWorktree(t.number, impl.branch, r)
    // Fail closed: a reviewer that died is not a clean review. Its round is
    // spent, and the next reviewer sees the same branch.
    if (!r) {
      log(`#${t.number} gate round ${round}: reviewer died — not counted as clean`)
      if (round === GATE_MAX_ROUNDS) return { unfixed: [{ severity: 'blocker', location: 'gate', issue: 'no review completed', fix: 'review the PR by hand' }], validated }
      continue
    }
    const red = readinessRed(r.checks, impl.validation)
    if (red.length) {
      log(`#${t.number} gate round ${round}: not ready — validation red: ${red.join('; ')}`)
      return { readiness: red }
    }
    if (r.validated_sha) validated = { sha: r.validated_sha, by: validated && validated.sha === r.validated_sha ? validated.by : 'the gate reviewer' }
    const blocking = r.findings.filter((f) => f.severity !== 'minor')
    if (!blocking.length) {
      log(`#${t.number} gate clean${round > 1 ? ` after ${round} rounds` : ''}${rejected.length ? `, ${rejected.length} finding(s) rejected` : ''}`)
      return { unfixed: [], validated }
    }
    if (round === GATE_MAX_ROUNDS) {
      log(`#${t.number} publishes with ${blocking.length} unresolved finding(s) — gate hit ${GATE_MAX_ROUNDS} rounds`)
      return { unfixed: blocking, validated }
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
      node: `${node}/fix`,
      guard: () => goOn(tk.single),
      ledgerKey: t.number,
      validated,
      validation: impl.validation,
    })
    if (out.stopped) return { stopped: `the run halted during gate round ${round}'s fixes` }
    validated = out.validated
    for (const v of out.verdicts.filter((v) => v.action === 'rejected')) {
      if (!rejected.some((p) => p.location === v.location && p.issue === v.issue)) rejected.push(v)
    }
    lastFixed = out.verdicts.filter((v) => v.action === 'fixed')
    unverified = out.unaccounted
  }
  return { unfixed: [], validated }
}

// Every ticket resolves to an outcome, never rejects: `state` is 'published',
// or why it is not — 'failed', 'unmet', 'needs decision' (each of which halts
// the run), 'stopped' (halting reached it mid-way) or 'not started'.
const memo = new Map()
function ticketDone(n) {
  if (!memo.has(n)) memo.set(n, runTicket(byNum.get(n)))
  return memo.get(n)
}

// A dependency already done on the prior work (subsumed at the graph) is on
// the branch every ticket is cut from: nothing to wait for.
const awaited = (t) => t.blocked_by.filter((d) => byNum.has(d) && !blocked.has(d) && !isSubsumed(d))
// A ticket is settled once published, or once its publisher found its
// branch added nothing to the tip (subsumed there): either way its
// dependants can start, and the run is not halted by it.
const settledStates = ['published', 'subsumed']

async function runTicket(t) {
  const deps = await Promise.all(awaited(t).map(ticketDone))
  const waits = deps.filter((d) => !settledStates.includes(d.state))
  if (waits.length) return { number: t.number, state: 'not started', detail: `waits on ${waits.map((d) => `#${d.number} (${d.state})`).join(', ')}` }
  if (halting) return { number: t.number, state: 'not started', detail: `the run halted before it started` }
  try {
    return await implementTicket(t)
  } catch (e) {
    return halt(t, 'failed', String(e && e.message ? e.message : e))
  }
}

function halt(t, state, detail, extra = {}) {
  if (!halting) haltedBy = { number: t.number, state, detail }
  halting = true
  log(`#${t.number} ${state} — the run halts: ${detail}`)
  return { number: t.number, state, detail, ...extra }
}

async function implementTicket(t) {
  // The tip as this ticket starts: its dependencies are already stacked
  // (awaited above), so cutting from the tip sees all of their work.
  const cutFrom = tip
  // This run owns `ticket/N` from here on: every agent addresses it as a
  // local ref, and it stays off origin until the lane publishes it.
  runRefs.add(`ticket/${t.number}`)
  const plan = await dispatch(t, null, `ticket/${t.number}/dispatch`)
  if (!plan) throw new Error(`dispatcher for #${t.number} died`)
  if (plan.slices.length > 1) log(`#${t.number} dispatched as ${plan.slices.length} slices`)
  // The first dispatch's copy of the recipe holds for the whole ticket, as its
  // ticket_brief does: a re-dispatch re-slices, it does not re-read the ticket.
  const validation = plan.validation || []
  const reviewValidation = plan.review_validation || []
  const tk = { single: false, gates: 0 }
  const stop = (detail) => {
    log(`#${t.number} stopped — ${detail}`)
    return { number: t.number, state: 'stopped', detail }
  }
  // Slice rounds: run the plan; a remainder (a slice bailed out, was never
  // started, or left the validation list red — including at the gate) goes
  // back to the dispatcher for a re-slice with a fresh agent. A decision
  // needed, or a remainder that survives the round cap, halts the ticket.
  let slices = plan.slices
  let started = false
  let last = null
  const summaries = []
  const decided = []
  let gate = null
  for (let round = 1; ; round++) {
    tk.single = slices.length === 1
    const out = await runSlices(t, slices, { cutFrom, started, tag: `impl:#${t.number}${round > 1 ? `:r${round}` : ''}`, node: `ticket/${t.number}/impl/r${round}`, validation })
    started = out.started
    if (out.last) last = out.last
    summaries.push(...out.summaries)
    for (const d of out.decided) if (!decided.includes(d)) decided.push(d)
    if (out.decisions.length) return halt(t, 'needs decision', out.decisions.join('; '), { questions: out.decisions })
    if (out.stopped) return stop(out.stopped)
    let unmet = out.unmet
    if (!unmet.length) {
      gate = await reviewGate(t, { branch: `ticket/${t.number}`, summary: summaries.join(' '), decided, validated: last.validated_sha ? { sha: last.validated_sha, by: 'the implementer' } : null, validation }, cutFrom, plan.ticket_brief, tk)
      if (gate.stopped) return stop(gate.stopped)
      if (!gate.readiness) break
      unmet = gate.readiness.map((c) => `validation red at the gate: ${c}`)
    }
    if (round === MAX_DISPATCH_ROUNDS) return halt(t, 'unmet', `after ${MAX_DISPATCH_ROUNDS} dispatch rounds: ${unmet.join('; ')}`, { unmet })
    // A re-dispatch is new work, which halting never starts.
    if (halting) return stop(`the run halted before its remainder was re-dispatched: ${unmet.join('; ')}`)
    log(`#${t.number} remainder after round ${round}: ${unmet.join('; ')} — re-dispatching`)
    const replan = await dispatch(t, unmet.join('; '), `ticket/${t.number}/dispatch/r${round + 1}`)
    if (!replan) throw new Error(`re-dispatcher for #${t.number} died`)
    slices = replan.slices
  }
  const impl = {
    branch: `ticket/${t.number}`,
    summary: summaries.join(' '),
    checks: last.checks,
    // The gate's fixers may have moved the branch; the newest green sha is
    // what the publisher inherits or invalidates by rebasing.
    validated: gate.validated || (last.validated_sha ? { sha: last.validated_sha, by: 'the implementer' } : null),
    decided,
    validation,
    review_validation: reviewValidation,
  }
  const pub = await enqueuePublish(t, impl, cutFrom, tk.single)
  if (pub.stopped) return stop('the run halted before its publish')
  if (pub.subsumed) return { number: t.number, state: 'subsumed', detail: `${impl.branch} adds no commit to the tip it was cut from: the ticket's work was already there. No PR; close the ticket by hand once that work is merged.`, ...impl, unfixed: gate.unfixed || [] }
  return { number: t.number, state: 'published', ...impl, unfixed: gate.unfixed || [] }
}

const mapOrder = (a, b) => (a.map_position || Infinity) - (b.map_position || Infinity) || a.number - b.number
async function runInOrder() {
  const queue = [...auto].sort(mapOrder)
  const out = []
  while (queue.length) {
    const i = queue.findIndex((t) => awaited(t).every((d) => memo.has(d)))
    if (i < 0) {
      out.push(...queue.map((t) => ({ number: t.number, state: 'not started', detail: `blocked in a cycle among ${queue.map((x) => '#' + x.number).join(', ')}` })))
      break
    }
    out.push(await ticketDone(queue.splice(i, 1)[0].number))
  }
  return out
}

phase('Implement')
const outcomes = RUN_ORDER === 'sequential' ? await runInOrder() : await Promise.all(auto.map((t) => ticketDone(t.number)))
const layer0Line = () => (hasLayer0 ? [`layer 0 (pre-existing): ${layer0.pr_url}`] : [])

// --- a halted run: no review, no finalize, nothing more on GitHub ----------
// Review and finalize are for a stack every automated ticket reached. Anything
// less is halted, and waits to be resumed rather than finished with gaps. It
// reclaims nothing either: a resume carries each failed node on in its own
// worktree (ADR-0016).
// A subsumed ticket (its branch added nothing to the tip) is settled, not
// unpublished: there was no PR to open.
const unpublished = outcomes.filter((o) => !settledStates.includes(o.state))
if (unpublished.length) {
  const cause = haltedBy || unpublished[0]
  log(`HALTED on #${cause.number} (${cause.state}) — ${unpublished.map((o) => `#${o.number} ${o.state}`).join(', ')}`)
  const localOnly = unpublished.filter((o) => runRefs.has(`ticket/${o.number}`)).map((o) => `ticket/${o.number}`)
  return {
    spec: SPEC,
    halted: true,
    reason: `#${cause.number} ${cause.state}: ${cause.detail}. No whole-stack review and no finalize until every automated ticket is published — resume the run to carry it on.`,
    tickets: unpublished.map((o) => ({ ticket: o.number, state: o.state, detail: o.detail, ...(o.questions ? { questions: o.questions } : {}) })),
    published: [...layer0Line(), ...stacked.map((s) => `#${s.number}: ${s.pr_url}`)],
    deferred_to_human: deferred.map((t) => ({ ticket: t.number, reason: t.human_reason || 'downstream of a human ticket' })),
    gate_unfixed: outcomes
      .filter((o) => o.unfixed && o.unfixed.length)
      .map((o) => ({ ticket: o.number, findings: o.unfixed.map((f) => `[${f.severity}] ${f.location} — ${f.issue}`) })),
    local_only_branches: localOnly.length
      ? { note: `Never pushed. Any work these carry is in ${REPO_DIR}'s clone only, and the worktrees that built it are kept for the resume.`, refs: localOnly }
      : null,
    worktrees_kept: worktreesKept,
    notes: NOTES_DIR,
  }
}

// --- step 7: review the whole stack; fixes land as the top PR -------------
// Every published ticket's `### Run at review` commands, once each, on the
// stack tip: the full suites no per-ticket role runs (ADR-0029).
const reviewValidation = []
for (const c of outcomes.filter((o) => o.state === 'published').flatMap((o) => o.review_validation || [])) {
  if (!reviewValidation.some((k) => norm(k) === norm(c))) reviewValidation.push(c)
}
phase('Review')
const review = await agent(
  `Review the whole stack for spec #${SPEC}.

${POINTERS}
${GIT}
The stack, bottom to top: ${[...(hasLayer0 ? [`${START_REF} (pre-existing work)`] : []), ...stacked.map((s) => `#${s.number} (${s.branch})`)].join(' → ')}.
Review \`${ref(BASE_REF)}...${ref(tip)}\` — everything the stack adds.

Invoke the \`code-review\` skill with \`${ref(BASE_REF)}\` as the fixed point and spec #${SPEC} as the spec — both its axes: this repo's documented standards, and whether the stack matches what the spec and its tickets asked for.

Every ticket was already reviewed alone on its own branch, so look hardest at what that could not see: two implementations of one helper, abstractions that contradict each other, a contract one ticket relies on that another changed. Return every finding; change no code yourself.

${reviewValidation.length
    ? `Run at review — the deduplicated union of every published ticket's \`### Run at review\` commands. Run each once, on the stack tip (\`git switch --detach ${ref(tip)}\`), in the foreground and exactly as written, never as a background job and never with a build-cache clean:
${reviewValidation.map((c) => `- \`${c}\``).join('\n')}
Each command that exits red is a \`blocker\` finding: the command in \`location\`, what failed in \`issue\`.`
    : `No published ticket lists a command to run at review.`}

${WORKTREE}`,
  { ...ROLES.review, phase: 'Review', schema: REVIEW_SCHEMA, isolation: ISOLATION, label: `review:spec-${SPEC}`, node: 'review' },
)
noteWorktree('review', tip, review)
// Fail closed: a review that never returned is not a review with zero findings.
const reviewMissing = !review
const findings = review ? review.findings : []
log(reviewMissing ? 'code review: the whole-stack reviewer died — the stack is UNREVIEWED as a whole' : `code review: ${findings.length} findings`)

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
  const stackLine = [...(hasLayer0 ? [`${START_REF} (pre-existing work)`] : []), ...stacked.map((s) => `#${s.number} (${s.branch})`)].join(' → ')
  const out = await fixFindings(findings, {
    subject: `spec #${SPEC}`,
    brief: `The whole stack for spec #${SPEC}, bottom to top: ${stackLine}. These findings come from the review of the stack as a whole, so they are the seams BETWEEN tickets — one helper implemented twice, abstractions that contradict each other, a contract one ticket relies on that another changed — not any single ticket's work. They land on \`${branch}\`, a new branch cut from the stack tip; every branch below it is published and must not be touched.`,
    branch,
    cutFrom: tip,
    started: false,
    phase: 'Review',
    tag: 'integration',
    node: 'review/fix',
    ledgerKey: 'integration',
    validation: reviewValidation,
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
      { ...ROLES.publish, effort: 'low', phase: 'Review', schema: INTEGRATION_SCHEMA, isolation: ISOLATION, label: 'publish:integration', node: 'review/publish' },
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
// Every automated ticket published to get here. A ticket deferred to a human
// still keeps the spec open, as do a gate finding nobody fixed, an integration
// finding with no verdict, and a whole-stack review that never ran: published
// is not complete, and a run that cannot show its work was reviewed does not
// get to say the spec is done.
const gateUnfixedTickets = outcomes.filter((o) => o.unfixed && o.unfixed.length)
const integrationOpen = findings.length && (!integration || integrationUnaccounted.length)
// A ticket whose branch had nothing to publish is open still: no PR closes it.
const subsumedOutcomes = outcomes.filter((o) => o.state === 'subsumed')
const complete = !deferred.length && !gateUnfixedTickets.length && !integrationOpen && !reviewMissing && !subsumedOutcomes.length
const bottomToTop = [
  ...(hasLayer0 ? [{ label: `layer 0 (pre-existing)`, branch: START_REF, pr_url: layer0.pr_url, pr_number: layer0.pr_number }] : []),
  ...stacked.map((s) => ({ label: `#${s.number}`, branch: s.branch, pr_url: s.pr_url, pr_number: s.pr_number })),
  ...(integration ? [{ label: 'integration', branch: integration.branch, pr_url: integration.pr_url, pr_number: integration.pr_number }] : []),
]
const remains = [
  ...deferred.map((t) => `#${t.number} — ${t.human_reason || 'downstream of a human ticket'}`),
  ...subsumedOutcomes.map((o) => `#${o.number} — nothing to publish: ${o.detail}`),
  ...gateUnfixedTickets.map((o) => `#${o.number} — published with ${o.unfixed.length} unresolved gate finding(s)`),
  ...(integrationOpen ? [`whole-stack review findings not fully fixed or not published`] : []),
  ...(reviewMissing ? ['the whole-stack review never ran — review the stack as a whole by hand'] : []),
]
// Whatever no reclaimer was handed: a reclaimer that died, and the last
// publisher's own. Same rule as the lane — exact paths,
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
${ON_SESSION ? '' : `   The lane already reclaimed each published ticket's worktrees; these are the rest. ${strayStep()}
`}   Touch no other worktree — the user's own checkout in particular — and delete no branches and close no PRs.

Do not merge anything — merging is the operator's.

Return one line on the stack — whether it registered and how many PRs went ready — plus the reclaim count and kept list.`,
  { ...ROLES.finalize, effort: 'low', phase: 'Finalize', schema: FINALIZE_SCHEMA, label: 'finalize', node: 'finalize' },
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
  halted: false,
  state: complete ? 'complete — ready for review' : 'ready for review — spec stays open for what remains',
  merge_how: STACK_MODE === 'native' && !stackDisabled
    ? `Review bottom-up, then merge ONCE from the top PR (the Merge button there, or PUT .../pulls/${bottomToTop[bottomToTop.length - 1].pr_number}/merge-async). Every layer needs green required checks and required approvals, evaluated against ${BASE_REF}. After a FAILED merge, re-read the actual state of ${BASE_REF} — do not assume rollback.`
    : `No stack object (chain mode): merge bottom-up by hand, one PR at a time, with MERGE COMMITS (--merge), deleting each head branch after its merge so GitHub retargets the next PR. Squash/rebase merges rewrite shas and give every child PR a phantom diff.`,
  gate_unfixed: outcomes
    .filter((o) => o.unfixed && o.unfixed.length)
    .map((o) => ({ ticket: o.number, findings: o.unfixed.map((f) => `[${f.severity}] ${f.location} — ${f.issue}`) })),
  deferred_to_human: deferred.map((t) => ({ ticket: t.number, reason: t.human_reason || 'downstream of a human ticket' })),
  // What implementers settled themselves where a ticket left it open; each is
  // also on its PR.
  decided: outcomes.filter((o) => o.decided && o.decided.length).map((o) => ({ ticket: o.number, decisions: o.decided })),
  review_findings: reviewMissing ? 'UNREVIEWED — the whole-stack reviewer died' : findings.length,
  integration_pr: integration ? integration.pr_url : null,
  integration_unfixed: [
    ...integrationUnaccounted.map((f) => `[${f.severity}] ${f.location} — ${f.issue} — no verdict came back`),
    ...integrationVerdicts.filter((v) => v.action === 'rejected').map((v) => `${v.location} — ${v.issue} — rejected: ${v.reason}`),
    ...(findings.length && !integration ? [`no integration PR was opened — any fix that landed sits unpublished on spec/${SPEC}-integration`] : []),
  ],
  notes: NOTES_DIR,
  local_only_branches: (() => {
    const unpublished = auto.filter((t) => !stacked.some((x) => x.number === t.number) && !outcomes.some((o) => o.number === t.number && o.state === 'subsumed')).map((t) => `ticket/${t.number}`)
    if (integration === null && findings.length) unpublished.push(`spec/${SPEC}-integration`)
    return unpublished.length
      ? { note: `Never pushed. Any work these carry is on the branch in ${REPO_DIR}'s clone only — ${ON_SESSION ? 'the worktrees that built it are kept until the operator reclaims them at the end of the run' : 'the worktrees that built it were removed where clean and on the branch, kept otherwise; see worktrees_kept'}.`, refs: unpublished }
      : null
  })(),
  // Every worktree a reclaim refused to remove, with git's reason. Each is a
  // dead agent's uncommitted work or a file the OS still holds — both for the
  // operator, neither for --force.
  worktrees_kept: worktreesKept,
  finalize,
}
