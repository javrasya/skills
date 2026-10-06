// Arming a run (#100): in code, with no agent session in between, what the
// implement-spec skill's arming steps do (SKILL.md steps 2-4): resolve the
// repo, its path and the notes directory, render the bundled template into a
// new run's own folder under it, and launch the runner there as a crew
// session, as `crew run` does.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCrewConfig, repoConfig } from './crew-config.mjs'
import { runFolderOf, stateDirOf } from './run-layout.mjs'
import { ensureDaemon, request } from './daemon/client.mjs'
import { runnerCommand } from './daemon/runs.mjs'
import { execProgram, repoOf } from './git.mjs'
import { flagsToAnswers, probeStart, rememberAnswers, rememberedAnswers, settleStackMode, startForm } from './start-form.mjs'
import { runStartForm } from './start-tui.mjs'
import { crewHost } from './crew-host.mjs'
import { consultSession, orchestrator } from './orchestrator.mjs'
import { triageHalt } from './triage.mjs'
import { preflight } from './headless.mjs'

// The copy `npm pack` bundles (scripts/pack-template.mjs), else, in a checkout
// of this repo, the skill folder's own: the copy is taken from it.
export const TEMPLATES = [fileURLToPath(new URL('../workflow.template.js', import.meta.url)), fileURLToPath(new URL('../../../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url))]

export function templatePath(candidates = TEMPLATES) {
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`no workflow template: looked at ${candidates.join(', ')}`)
  return found
}

// The vendored `pr` skill the publisher writes each ticket PR's body by: the
// copy `npm pack` bundles beside the template, else the repo's own.
export const PR_GUIDES = [fileURLToPath(new URL('../pr-guide.md', import.meta.url)), fileURLToPath(new URL('../../../skills/engineering/pr/SKILL.md', import.meta.url))]

export function prGuidePath(candidates = PR_GUIDES) {
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`no PR-body guide: looked at ${candidates.join(', ')}`)
  return found
}

export const PLACEHOLDERS = ['SPEC', 'REPO', 'REPO_DIR', 'NOTES_DIR', 'BASE_REF', 'START_REF', 'BASE_SHA', 'STACK_MODE', 'RUN_ORDER', 'RUNNER', 'PER_CHANGE_COMMANDS', 'AT_REVIEW_COMMANDS', 'TICKET_RECIPES', 'PR_GUIDE']
const PLACEHOLDER = new RegExp(`__(${PLACEHOLDERS.join('|')})__`, 'g')

// SKILL.md step 3: substitute, never rewrite. One pass, so a value that
// happens to hold a placeholder's text (a path, say) is left as written.
export function renderTemplate(template, values) {
  const missing = PLACEHOLDERS.filter((k) => values[k] === undefined || values[k] === null)
  if (missing.length) throw new Error(`no value for ${missing.map((k) => `__${k}__`).join(', ')}`)
  return template.replace(PLACEHOLDER, (_, k) => String(values[k]))
}

// The template's role table (#101): RUN_DEFAULT's line and one
// `<role>: RUN_DEFAULT,` row per role. A checkout's template may be CRLF.
const DEFAULT_LINE = /^const RUN_DEFAULT = \{ harness: 'claude', model: '([^']+)' \}(?=\r?$)/m
const ROLE_ROW = /^( +)(\w+): RUN_DEFAULT,/gm

// A role's row from a harness and that harness's model. A pi row keeps a
// Claude `model` beside its `piModel`: the Workflow runner ignores
// `harness` and runs every role on Claude with `model`.
export const roleRow = ({ harness, model }, claudeModel) => (harness === 'pi' ? { harness: 'pi', piModel: model, model: claudeModel } : { harness, model })

const quote = (v) => `'${String(v).replace(/[\\']/g, '\\$&')}'`
const literal = (row) =>
  `{ ${Object.entries(row)
    .map(([k, v]) => `${k}: ${quote(v)}`)
    .join(', ')} }`

// The rendered script's role table: RUN_DEFAULT from the form's harness and
// model, and each role in `roles` (crew's per-repo config) on a row of its
// own. A pi row's Claude model is the run default's when that is Claude, else
// the template's.
export function renderRoles(script, { runDefault, roles = {} }) {
  const line = DEFAULT_LINE.exec(script)
  if (!line) throw new Error("the workflow template has no `const RUN_DEFAULT = { harness: 'claude', model: '…' }` line to render the run default into")
  const names = [...script.matchAll(ROLE_ROW)].map((m) => m[2])
  const unknown = Object.keys(roles).filter((r) => !names.includes(r))
  if (unknown.length) throw new Error(`crew config roles: ${unknown.join(', ')} ${unknown.length > 1 ? 'are no roles' : 'is no role'} of the workflow template's; its roles are ${names.join(', ')}`)
  const claudeModel = runDefault.harness === 'claude' ? runDefault.model : line[1]
  return script.replace(DEFAULT_LINE, () => `const RUN_DEFAULT = ${literal(roleRow(runDefault, claudeModel))}`).replace(ROLE_ROW, (row, indent, name) => (roles[name] ? `${indent}${name}: ${literal(roleRow(roles[name], claudeModel))},` : row))
}

// The run default a rendered script's RUN_DEFAULT line holds, as the form's
// { harness, model }: what the orchestrator of a run already armed runs on.
// Null for a script with no such line.
export function runDefaultOf(script) {
  const line = /^const RUN_DEFAULT = \{([^\n]*)\}\r?$/m.exec(script)
  if (!line) return null
  const row = Object.fromEntries([...line[1].matchAll(/(\w+): '((?:[^'\\]|\\.)*)'/g)].map(([, k, v]) => [k, v.replace(/\\(.)/g, '$1')]))
  if (!row.harness) return null
  return { harness: row.harness, model: (row.harness === 'pi' ? row.piModel : row.model) ?? null }
}

// SKILL.md step 2's __NOTES_DIR__.
export const notesDirOf = (repo, spec, home = homedir()) => join(home, '.claude', 'spec-notes', `${repo.split('/').pop()}-${spec}`)

// Every crew start arms a run of its own, never one an earlier start made: its
// own folder under the spec's notes dir, named by its spec and a part of its
// own (UTC time and a random tail), holding its workflow.js, its research
// notes and its state dir.
// Two ids of one second may match; armRun's exclusive mkdir draws again then.
export function newRunId(spec, at = new Date()) {
  const stamp = `${spec}-${at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

// The runner as a session of the daemon's, on the crew host: it outlives the
// command that launched it, and the run console (`crew view <run dir>`)
// enters it. Its state dir is `stateDir`, else the one the runner takes by
// default, beside the script, and the daemon refuses it run_live while that
// run has a runner already. Answers its session, and its state dir as `runDir`.
export async function launchRunner({ paths, script, stateDir = null, resume = false, permissionMode = null, cwd, title, env = process.env, cols = 120, rows = 30 }) {
  const path = resolve(cwd, script)
  const runDir = stateDir ? resolve(cwd, stateDir) : stateDirOf(dirname(path))
  await ensureDaemon(paths)
  const { session } = await request(paths, { op: 'session.spawn', command: runnerCommand({ script: path, stateDir: runDir, resume, permissionMode }), runDir, cwd, env, title, cols, rows })
  return { ...session, runDir }
}

// The checkout's top, SKILL.md step 2's __REPO_DIR__.
export async function repoDirOf(cwd, run = execProgram) {
  const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (top.code !== 0) throw new Error(`not in a git checkout: ${top.stderr.trim() || cwd}`)
  return resolve(top.stdout.trim())
}

// What arming needs beyond the form, each a refusal when it cannot be had:
// the repo gh knows the checkout as and the spec's title.
export async function resolveArming({ repoDir, spec, repo, run = execProgram, home = homedir() }) {
  if (!repo) throw new Error('gh knows no GitHub repo for this checkout, so there is no spec to arm')
  const issue = await run('gh', ['issue', 'view', String(spec), '--repo', repo, '--json', 'title', '-q', '.title'], { cwd: repoDir })
  if (issue.code !== 0) throw new Error(`no spec #${spec} in ${repo}: ${issue.stderr.trim() || `gh exited ${issue.code}`}`)
  return { spec, repo, repoDir, notesDir: notesDirOf(repo, spec, home), title: issue.stdout.trim() }
}

// The run's pinned base (ADR-0030): the commit its cut-from ref, the prior work
// or else the base, stands at on origin after a fetch, resolved once here so
// every ticket of the run is cut from one sha however the ref moves under it.
// Prior work may live only in the checkout yet (the layer-0 agent pushes it),
// so its local branch answers when origin has none; the base must be on origin.
export async function pinBase({ repoDir, base, startRef, run = execProgram }) {
  const named = startRef === base ? `origin/${base}` : `prior work ${startRef}`
  const fetched = await run('git', ['-C', repoDir, 'fetch', '-q', 'origin'])
  if (fetched.code !== 0) throw new StartError(`cannot pin the run's base, ${named}: git fetch origin: ${fetched.stderr.trim() || `exited ${fetched.code}`}; nothing armed`)
  for (const candidate of [`refs/remotes/origin/${startRef}`, ...(startRef === base ? [] : [`refs/heads/${startRef}`])]) {
    const sha = await run('git', ['-C', repoDir, 'rev-parse', '-q', '--verify', `${candidate}^{commit}`])
    if (sha.code === 0) return sha.stdout.trim()
  }
  throw new StartError(`cannot pin the run's base: ${named} resolves to no commit${startRef === base ? ' on origin' : ', on origin or in this checkout'}; nothing armed`)
}

// A ticket's validation recipe (ADR-0029, ADR-0030), read from its body's
// `## Validation` section: whether that holds a `### Run per change` heading,
// and each `### Run per change` and `### Run at review` line's first code span.
// A line with none, or labelled as prose ("absent: …", "Tests: not
// applicable: …"), is no command. Headings and spans only, matched as strings;
// what the section says is preflight's.
const PROSE = /^(absent|not applicable|recipe measured|needs|deferred repo gate)\b/i
const SUBSECTIONS = { '### Run per change': 'perChange', '### Run at review': 'atReview' }
const CODE_SPAN = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/
function readRecipe(body) {
  const found = { hasPerChange: false, perChange: [], atReview: [] }
  let inValidation = false
  let into = null
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (/^##?\s/.test(line)) {
      inValidation = line === '## Validation'
      into = null
    } else if (inValidation && /^#{3,}\s/.test(line)) {
      into = SUBSECTIONS[line] ?? null
      if (into === 'perChange') found.hasPerChange = true
    } else if (into) {
      const text = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      if (PROSE.test(text) || PROSE.test(text.replace(/^[^:`]*:\s*/, ''))) continue
      const command = CODE_SPAN.exec(text)?.[2].trim()
      if (command) found[into].push(command)
    }
  }
  return found
}

// Whether a ticket's body carries its validation recipe: the headings alone.
export const hasValidationRecipe = (body) => readRecipe(body).hasPerChange

// Each command once, kept as first written; two that differ only in
// whitespace are one, as the rendered script's norm() has them.
function onceEach(commands) {
  const seen = new Map()
  for (const c of commands) {
    const key = c.replace(/\s+/g, ' ').trim()
    if (!seen.has(key)) seen.set(key, c)
  }
  return [...seen.values()]
}

export function recipeCommands(body) {
  const { perChange, atReview } = readRecipe(body)
  return { perChange: onceEach(perChange), atReview: onceEach(atReview) }
}

// The per-change and the at-review commands of all `tickets`, each command
// once whichever tickets list it: the sets the baseline measures.
export function recipeCommandSets(tickets) {
  const recipes = tickets.map(({ body }) => readRecipe(body))
  return { perChange: onceEach(recipes.flatMap((r) => r.perChange)), atReview: onceEach(recipes.flatMap((r) => r.atReview)) }
}

// Each ticket's own recipe by its number, from the same parse as the sets: the
// commands the script runs for that ticket are the baselined ones, string for
// string, so the record always has an entry for them.
export const ticketRecipes = (tickets) => Object.fromEntries(tickets.map(({ number, body }) => [number, recipeCommands(body)]))

// The spec's open `ready-for-agent` sub-issues, as [{ number, title, body }];
// ready-for-human ones are never the run's to take, and nor are closed ones —
// a partly delivered spec's tickets from before preflight existed must not
// refuse the start. Each sub-issue is one line of JSON (`@json`), so a
// paginated answer parses page by page alike.
export async function takeableTickets({ spec, repo, repoDir, run = execProgram }) {
  const jq = '.[] | {number, title, state, body, labels: [.labels[].name]} | @json'
  const res = await run('gh', ['api', `repos/${repo}/issues/${spec}/sub_issues?per_page=100`, '--paginate', '--jq', jq], { cwd: repoDir })
  if (res.code !== 0) throw new Error(`cannot read spec #${spec}'s tickets: ${res.stderr.trim() || `gh exited ${res.code}`}`)
  const tickets = res.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  return tickets.filter((t) => t.state !== 'closed' && t.labels.includes('ready-for-agent')).map(({ number, title, body }) => ({ number, title, body }))
}

// The words crew's config starts `harness` with in place of its name, or null.
const programOf = (paths, harness) => readCrewConfig(paths).harnesses?.[harness] ?? null

// `crew start`'s check, before it arms anything, that the harness
// the form answered is logged in and reaches its model: one headless turn in
// the checkout (headless.mjs preflight).
export const crewPreflight = ({ paths, repoDir, harness, model }) => preflight({ harness, model, cwd: repoDir, program: programOf(paths, harness) })

// The orchestrator's two console uses for runsView's runs, on the crew host,
// in the run's project, on the run default its script was armed with and the
// runner's permission mode: triage(run) asks about its halt, consult(run)
// starts a `?` session, recorded in the run dir, and answers { terminal, n },
// its session id and its number among the run's. close() gives up every triage
// still asked, its session closed: a console calls it as it quits.
export function runOrchestrator({ paths, host = (cwd) => crewHost({ paths, cwd }) }) {
  const asking = new Set()
  const launchOf = (run) => {
    let runDefault = null
    try {
      if (run.script) runDefault = runDefaultOf(readFileSync(run.script, 'utf8'))
    } catch {}
    return { harness: runDefault?.harness ?? 'claude', model: runDefault?.model ?? null, permissionMode: run.permissionMode ?? null }
  }
  const cwdOf = (run) => run.project ?? run.runDir
  return {
    triage: (run) => {
      const launch = launchOf(run)
      const orch = orchestrator({ cwd: cwdOf(run), program: programOf(paths, launch.harness), ...launch })
      asking.add(orch)
      return triageHalt({ stateDir: run.runDir, orchestrate: () => orch }).finally(() => asking.delete(orch))
    },
    consult: (run) => consultSession({ host: host(cwdOf(run)), stateDir: run.runDir, dir: cwdOf(run), ...launchOf(run) }),
    close: () => Promise.all([...asking].map((orch) => orch.close())),
  }
}

// Renders the template into a new run's own folder and launches it there.
// `answers` are the form's, stackMode settled to the template's value; `roles`
// the per-role overrides of crew's per-repo config; `baseSha` the pinned base
// (pinBase); `tickets` the takeable ones, whose recipeCommandSets and
// ticketRecipes are rendered as JSON literals, which no command text can break
// out of; `newId()` draws the run's
// id (newRunId). A run folder that exists already is another run's: a new id
// is drawn, `attempts` times in all, before the start is refused.
export async function armRun({ target, answers, baseSha, roles, tickets, newId, attempts = 5, template = readFileSync(templatePath(), 'utf8'), prGuide = prGuidePath(), launch }) {
  const { spec, repo, repoDir, notesDir, title } = target
  const recipe = recipeCommandSets(tickets)
  const render = (runFolder) =>
    renderRoles(
      renderTemplate(template, {
        SPEC: spec,
        REPO: repo,
        REPO_DIR: repoDir,
        NOTES_DIR: runFolder,
        BASE_REF: answers.base,
        START_REF: answers.startRef,
        BASE_SHA: baseSha,
        STACK_MODE: answers.stackMode,
        RUN_ORDER: answers.runOrder,
        RUNNER: 'session',
        PER_CHANGE_COMMANDS: JSON.stringify(recipe.perChange),
        AT_REVIEW_COMMANDS: JSON.stringify(recipe.atReview),
        TICKET_RECIPES: JSON.stringify(ticketRecipes(tickets)),
        PR_GUIDE: prGuide,
      }),
      { runDefault: answers, roles },
    )
  let runFolder, rendered
  for (let i = 1; ; i++) {
    runFolder = runFolderOf(notesDir, newId())
    // Rendered before any folder is made, so a script refused arms nothing.
    rendered = render(runFolder)
    mkdirSync(dirname(runFolder), { recursive: true })
    try {
      mkdirSync(runFolder)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (i >= attempts) throw new StartError(`run folder ${runFolder} exists already: another run's, left as it is; nothing armed`)
    }
  }
  const stateDir = stateDirOf(runFolder)
  const script = join(runFolder, 'workflow.js')
  writeFileSync(script, rendered)
  const session = await launch({ script, stateDir, permissionMode: answers.permissionMode ?? null, cwd: repoDir, title: `implement-spec #${spec}: ${title}` })
  return { script, session }
}

// What `crew start` tells the operator once the run is launched: its script,
// the ref and pinned sha every ticket is cut from, and how to enter the run.
export const startSummary = ({ script, session, answers, baseSha }) => `crew start: armed ${script}, every ticket cut from ${answers.startRef} at ${baseSha}; the runner is crew session ${session.id}; enter it from \`crew view "${session.runDir}"\``

export class StartError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

// `crew start <spec#> [--harness h] [--model m] [--base b] [--start-ref r] [--stack-mode s]
// [--run-order o] [--permission-mode p]`. With no terminal each row's flag is required; at
// one, the form shows, pre-filled from the flags and the repo's remembered
// answers. Either way every `ready-for-agent` ticket of the spec must carry
// its validation recipe first, else nothing is armed; so must the cut-from ref
// resolve to the sha the run is pinned to. A `validation.md` left
// in the notes dir from before ADR-0029 is ignored, said once to `warn`. The
// repo's config and remembered answers are its main checkout's, whichever of
// its worktrees crew start runs in; the run itself is armed in this one.
export async function startCommand({ argv, paths, cwd = process.cwd(), tty, stdin, stdout, run = execProgram, home = homedir(), env = process.env, launch, check = crewPreflight, newRunId: runIdFor = newRunId, warn = (line) => process.stderr.write(`${line}\n`) }) {
  let parsed
  try {
    parsed = flagsToAnswers(argv)
  } catch (e) {
    throw new StartError(e.message, 2)
  }
  const { answers: flags, rest } = parsed
  if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0])) throw new StartError(rest.length ? `one spec issue number, not ${rest.join(' ')}` : 'the spec issue number is required', 2)
  const spec = Number(rest[0])
  const repoDir = await repoDirOf(cwd, run)
  const repo = await repoOf(repoDir)
  const { roles } = repoConfig(paths, repo)
  const facts = await probeStart({ cwd: repoDir, paths, home, env, run })
  let form
  try {
    form = startForm(facts, { remembered: rememberedAnswers(paths, repo), flags })
  } catch (e) {
    throw new StartError(e.message, 2)
  }
  if (!tty) {
    const missing = form.missingFlags()
    if (missing.length) throw new StartError(`no terminal to show the form at, so every row needs its flag: missing ${missing.join(', ')}`, 2)
  }
  const target = await resolveArming({ repoDir, spec, repo: facts.repo, run, home })
  const tickets = await takeableTickets({ spec, repo: target.repo, repoDir, run })
  const bare = tickets.filter((t) => !hasValidationRecipe(t.body))
  if (bare.length) {
    const named = bare.map((t) => `#${t.number} (${t.title})`).join(', ')
    throw new StartError(`spec #${spec}: ${bare.length > 1 ? 'tickets' : 'ticket'} ${named} ${bare.length > 1 ? 'have' : 'has'} no "## Validation" section holding "### Run per change"; run preflight on the spec to write each ticket's validation recipe, then crew start again; nothing armed`)
  }
  const heading = `crew start: ${target.repo} #${spec}: ${target.title}`
  const answers = tty ? await runStartForm({ form, stdin, stdout, heading }) : form.flagAnswers()
  if (!answers) throw new StartError('cancelled; nothing armed', 130)
  // Said after the form, whose screen would wipe it at a terminal.
  const stray = join(target.notesDir, 'validation.md')
  if (existsSync(stray)) warn(`crew start: ignoring ${stray}: validation recipes live on the tickets now, in their "## Validation" sections`)
  try {
    await check({ paths, repoDir, harness: answers.harness, model: answers.model })
  } catch (e) {
    throw new StartError(`${answers.harness}${answers.model ? ` on ${answers.model}` : ''} cannot run here: ${e?.message ?? e}; nothing armed`)
  }
  const baseSha = await pinBase({ repoDir, base: answers.base, startRef: answers.startRef, run })
  const settled = { ...answers, stackMode: await settleStackMode(answers, run) }
  rememberAnswers(paths, repo, settled)
  return { ...(await armRun({ target, answers: settled, baseSha, roles, tickets, newId: () => runIdFor(spec), launch })), target, answers: settled, baseSha }
}
