// Arming a run (#100): in code, with no agent session in between, what the
// implement-spec skill's arming steps do (SKILL.md steps 2-4): resolve the
// repo, its path and the notes directory, render the bundled template into a
// new run's own folder under it, and launch the runner there as a crew
// session, as `crew run` does.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readCrewConfig, repoConfig } from './crew-config.mjs'
import { runFolderOf, stateDirOf } from './run-layout.mjs'
import { ensureDaemon, request } from './daemon/client.mjs'
import { runnerCommand } from './daemon/runs.mjs'
import { execProgram, repoOf } from './git.mjs'
import { flagsToAnswers, probeStart, rememberAnswers, rememberedAnswers, settleStackMode, startForm } from './start-form.mjs'
import { draftEditor, drawDrafting, runDraftStep, runStartForm } from './start-tui.mjs'
import { crewHost } from './crew-host.mjs'
import { consultSession, draftValidation, orchestrator } from './orchestrator.mjs'
import { triageHalt } from './triage.mjs'
import { validationListProblem } from './validation-list.mjs'
import { preflight } from './headless.mjs'

// The copy `npm pack` bundles (scripts/pack-template.mjs), else, in a checkout
// of this repo, the skill folder's own: the copy is taken from it.
export const TEMPLATES = [
  fileURLToPath(new URL('../workflow.template.js', import.meta.url)),
  fileURLToPath(new URL('../../../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url)),
]

export function templatePath(candidates = TEMPLATES) {
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`no workflow template: looked at ${candidates.join(', ')}`)
  return found
}

export const PLACEHOLDERS = ['SPEC', 'REPO', 'REPO_DIR', 'NOTES_DIR', 'BASE_REF', 'START_REF', 'STACK_MODE', 'RUN_ORDER', 'RUNNER', 'VALIDATION']
const PLACEHOLDER = new RegExp(`__(${PLACEHOLDERS.join('|')})__`, 'g')

// SKILL.md step 3: substitute, never rewrite. One pass, so a value that
// happens to hold a placeholder's text (a validation comment, say) is left as
// the operator wrote it. A validation list the template's String.raw literal
// cannot hold is refused, never rendered into a workflow.js that dies on load.
export function renderTemplate(template, values) {
  const missing = PLACEHOLDERS.filter((k) => values[k] === undefined || values[k] === null)
  if (missing.length) throw new Error(`no value for ${missing.map((k) => `__${k}__`).join(', ')}`)
  const problem = validationListProblem(values.VALIDATION)
  if (problem) throw new Error(`the validation list cannot be armed: its ${problem}`)
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
const literal = (row) => `{ ${Object.entries(row).map(([k, v]) => `${k}: ${quote(v)}`).join(', ')} }`

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
  return script
    .replace(DEFAULT_LINE, () => `const RUN_DEFAULT = ${literal(roleRow(runDefault, claudeModel))}`)
    .replace(ROLE_ROW, (row, indent, name) => (roles[name] ? `${indent}${name}: ${literal(roleRow(roles[name], claudeModel))},` : row))
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
// notes and its state dir. Only validation.md is the spec's, shared by its runs.
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
// the repo gh knows the checkout as and the spec's title. `validation` is the
// list the notes dir keeps at `validationFile`, null when it keeps none.
export async function resolveArming({ repoDir, spec, repo, run = execProgram, home = homedir() }) {
  if (!repo) throw new Error('gh knows no GitHub repo for this checkout, so there is no spec to arm')
  const issue = await run('gh', ['issue', 'view', String(spec), '--repo', repo, '--json', 'title', '-q', '.title'], { cwd: repoDir })
  if (issue.code !== 0) throw new Error(`no spec #${spec} in ${repo}: ${issue.stderr.trim() || `gh exited ${issue.code}`}`)
  const notesDir = notesDirOf(repo, spec, home)
  const validationFile = join(notesDir, 'validation.md')
  const validation = existsSync(validationFile) ? readFileSync(validationFile, 'utf8') : null
  return { spec, repo, repoDir, notesDir, title: issue.stdout.trim(), validationFile, validation }
}

// The words crew's config starts `harness` with in place of its name, or null.
const programOf = (paths, harness) => readCrewConfig(paths).harnesses?.[harness] ?? null

// The orchestrator `crew start` drafts a missing validation list with: in the
// checkout, on the harness and model the form answered.
export const crewOrchestrator = ({ paths, repoDir, harness, model, permissionMode }) =>
  orchestrator({ harness, model, permissionMode, cwd: repoDir, program: programOf(paths, harness) })

// `crew start`'s check, before it drafts or arms anything, that the harness
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

// Ctrl+C at a terminal not in raw mode: `on()` is called on each, and the
// returned function stops listening.
const sigint = (on) => {
  process.on('SIGINT', on)
  return () => process.off('SIGINT', on)
}

// The orchestrator's draft of the list, shown as the form's last step, and
// written only once the operator confirms it. Null when they cancel. A
// Ctrl+C while it drafts gives the question up, its session closed, before
// crew start ends: no orchestrator session outlives it.
async function draftStep({ target, answers, orchestrate, paths, stdin, stdout, heading, interrupt = sigint }) {
  drawDrafting(stdout, { heading, file: target.validationFile })
  const orch = orchestrate({ paths, repoDir: target.repoDir, ...answers })
  let interrupted = false
  const unlisten = interrupt(() => {
    interrupted = true
    orch.close?.()
  })
  let draft
  try {
    draft = await draftValidation(orch, { repoDir: target.repoDir })
  } catch (e) {
    if (interrupted) throw new StartError('cancelled while the orchestrator drafted; its session closed, no validation list written, nothing armed', 130)
    throw new StartError(`${e.message}; no validation list written, nothing armed`)
  } finally {
    unlisten()
  }
  const text = await runDraftStep({ editor: draftEditor(draft.text), stdin, stdout, heading, file: target.validationFile, empty: draft.empty })
  if (text === null) return null
  mkdirSync(target.notesDir, { recursive: true })
  writeFileSync(target.validationFile, text)
  return text
}

// Renders the template into a new run's own folder and launches it there.
// `answers` are the form's, stackMode settled to the template's value; `roles`
// the per-role overrides of crew's per-repo config; `newId()` draws the run's
// id (newRunId). A run folder that exists already is another run's: a new id
// is drawn, `attempts` times in all, before the start is refused.
export async function armRun({ target, answers, roles, newId, attempts = 5, template = readFileSync(templatePath(), 'utf8'), launch }) {
  const { spec, repo, repoDir, notesDir, title, validation } = target
  const render = (runFolder) => renderRoles(renderTemplate(template, {
    SPEC: spec, REPO: repo, REPO_DIR: repoDir, NOTES_DIR: runFolder, BASE_REF: answers.base, START_REF: answers.startRef, STACK_MODE: answers.stackMode, RUN_ORDER: answers.runOrder, RUNNER: 'session', VALIDATION: validation,
  }), { runDefault: answers, roles })
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

export class StartError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

// `crew start <spec#> [--harness h] [--model m] [--base b] [--start-ref r] [--stack-mode s]
// [--run-order o] [--permission-mode p]`. With no terminal each row's flag is required, and so
// is the spec's validation list, since nobody is there to confirm a draft of
// one; at one, the form shows, pre-filled from the flags and the repo's
// remembered answers, then the orchestrator's draft of a missing list. The
// repo's config and remembered answers are its main checkout's, whichever of
// its worktrees crew start runs in; the run itself is armed in this one.
export async function startCommand({ argv, paths, cwd = process.cwd(), tty, stdin, stdout, run = execProgram, home = homedir(), env = process.env, launch, orchestrate = crewOrchestrator, check = crewPreflight, newRunId: runIdFor = newRunId, interrupt = sigint }) {
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
  let target = await resolveArming({ repoDir, spec, repo: facts.repo, run, home })
  const problem = target.validation === null ? null : validationListProblem(target.validation)
  if (problem) throw new StartError(`${target.validationFile} cannot be armed: its ${problem}; the workflow holds the list in a template literal, so write the command without it; nothing armed`)
  if (!tty && target.validation === null) {
    throw new StartError(`spec #${spec} has no validation list, and with no terminal nobody can confirm the orchestrator's draft of one: write the project's checks to ${target.validationFile}, one command per line (# for comments), or run crew start at a terminal`)
  }
  const heading = `crew start: ${target.repo} #${spec}: ${target.title}`
  const answers = tty ? await runStartForm({ form, stdin, stdout, heading }) : form.flagAnswers()
  if (!answers) throw new StartError('cancelled; nothing armed', 130)
  try {
    await check({ paths, repoDir, harness: answers.harness, model: answers.model })
  } catch (e) {
    throw new StartError(`${answers.harness}${answers.model ? ` on ${answers.model}` : ''} cannot run here: ${e?.message ?? e}; nothing armed`)
  }
  if (target.validation === null) {
    const validation = await draftStep({ target, answers, orchestrate, paths, stdin, stdout, heading, interrupt })
    if (validation === null) throw new StartError('cancelled; no validation list written, nothing armed', 130)
    target = { ...target, validation }
  }
  const settled = { ...answers, stackMode: await settleStackMode(answers, run) }
  rememberAnswers(paths, repo, settled)
  return { ...(await armRun({ target, answers: settled, roles, newId: () => runIdFor(spec), launch })), target, answers: settled }
}
