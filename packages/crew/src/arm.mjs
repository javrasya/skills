// Arming a run (#100): in code, with no agent session in between, what the
// implement-spec skill's arming steps do (SKILL.md steps 2-4): resolve the
// repo, its path and the notes directory, render the bundled template into the
// notes directory, clear the previous run's end signals, and launch the runner
// as a crew session, as `crew run` does.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { ensureDaemon, request } from './daemon/client.mjs'
import { execProgram } from './git.mjs'
import { flagsToAnswers, probeStart, rememberAnswers, rememberedAnswers, settleStackMode, startForm } from './start-form.mjs'
import { runStartForm } from './start-tui.mjs'

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

export const PLACEHOLDERS = ['SPEC', 'REPO', 'REPO_DIR', 'NOTES_DIR', 'BASE_REF', 'STACK_MODE', 'RUNNER', 'VALIDATION']
const PLACEHOLDER = new RegExp(`__(${PLACEHOLDERS.join('|')})__`, 'g')

// SKILL.md step 3: substitute, never rewrite. One pass, so a value that
// happens to hold a placeholder's text (a validation comment, say) is left as
// the operator wrote it.
export function renderTemplate(template, values) {
  const missing = PLACEHOLDERS.filter((k) => values[k] === undefined || values[k] === null)
  if (missing.length) throw new Error(`no value for ${missing.map((k) => `__${k}__`).join(', ')}`)
  return template.replace(PLACEHOLDER, (_, k) => String(values[k]))
}

// SKILL.md step 2's __NOTES_DIR__.
export const notesDirOf = (repo, spec, home = homedir()) => join(home, '.claude', 'spec-notes', `${repo.split('/').pop()}-${spec}`)

// The runner's state dir under the notes dir, and the files in it that tell an
// arming session the last run ended, halted or died. The notes dir outlives a
// run, so a re-arm launches over the last run's (SKILL.md step 4).
export const stateDirOf = (notesDir) => join(notesDir, 'orca-run')
export const END_SIGNALS = ['summary.json', 'runner.pid', 'halted.json']

export function clearEndSignals(stateDir) {
  for (const f of END_SIGNALS) rmSync(join(stateDir, f), { force: true })
}

// The runner as a session of the daemon's, on the crew host: it outlives the
// command that launched it, and `crew console` enters it.
export async function launchRunner({ paths, args, cwd, title, env = process.env, cols = 120, rows = 30, runner = fileURLToPath(new URL('./runner.mjs', import.meta.url)) }) {
  await ensureDaemon(paths)
  const { session } = await request(paths, { op: 'session.spawn', command: [process.execPath, runner, ...args, '--host', 'crew'], cwd, env, title, cols, rows })
  return session
}

// The checkout's top, SKILL.md step 2's __REPO_DIR__.
export async function repoDirOf(cwd, run = execProgram) {
  const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (top.code !== 0) throw new Error(`not in a git checkout: ${top.stderr.trim() || cwd}`)
  return resolve(top.stdout.trim())
}

// What arming needs beyond the form, each a refusal when it cannot be had:
// the repo gh knows the checkout as, the spec's title, and the validation
// list the notes dir keeps.
export async function resolveArming({ repoDir, spec, repo, run = execProgram, home = homedir() }) {
  if (!repo) throw new Error('gh knows no GitHub repo for this checkout, so there is no spec to arm')
  const issue = await run('gh', ['issue', 'view', String(spec), '--repo', repo, '--json', 'title', '-q', '.title'], { cwd: repoDir })
  if (issue.code !== 0) throw new Error(`no spec #${spec} in ${repo}: ${issue.stderr.trim() || `gh exited ${issue.code}`}`)
  const notesDir = notesDirOf(repo, spec, home)
  const validationFile = join(notesDir, 'validation.md')
  // Refused until a later ticket of #94 infers the checks: the skill's
  // interactive path is the one that writes them today.
  if (!existsSync(validationFile)) {
    throw new Error(`spec #${spec} has no validation list: ${validationFile} does not exist. Write the project's checks there, one command per line (# for comments), or arm the run with the implement-spec-in-workflow skill, which writes it`)
  }
  return { spec, repo, repoDir, notesDir, title: issue.stdout.trim(), validation: readFileSync(validationFile, 'utf8') }
}

// Renders the template into the notes dir, clears the end signals, launches.
// `answers` are the form's, stackMode settled to the template's value.
export async function armRun({ target, answers, template = readFileSync(templatePath(), 'utf8'), launch }) {
  const { spec, repo, repoDir, notesDir, title, validation } = target
  const script = join(notesDir, 'workflow.js')
  mkdirSync(notesDir, { recursive: true })
  writeFileSync(script, renderTemplate(template, {
    SPEC: spec, REPO: repo, REPO_DIR: repoDir, NOTES_DIR: notesDir, BASE_REF: answers.base, STACK_MODE: answers.stackMode, RUNNER: 'session', VALIDATION: validation,
  }))
  clearEndSignals(stateDirOf(notesDir))
  const args = [script, ...(answers.permissionMode ? ['--permission-mode', answers.permissionMode] : [])]
  const session = await launch({ args, cwd: repoDir, title: `implement-spec #${spec}: ${title}` })
  return { script, session }
}

export class StartError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

// `crew start <spec#> [--harness h] [--model m] [--base b] [--stack-mode s]
// [--permission-mode p]`. With no terminal each row's flag is required; at one,
// the form shows, pre-filled from the flags and the repo's remembered answers.
export async function startCommand({ argv, paths, cwd = process.cwd(), tty, stdin, stdout, run = execProgram, home = homedir(), env = process.env, launch }) {
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
  const facts = await probeStart({ cwd: repoDir, paths, home, env, run })
  let form
  try {
    form = startForm(facts, { remembered: rememberedAnswers(paths, repoDir), flags })
  } catch (e) {
    throw new StartError(e.message, 2)
  }
  if (!tty) {
    const missing = form.missingFlags()
    if (missing.length) throw new StartError(`no terminal to show the form at, so every row needs its flag: missing ${missing.join(', ')}`, 2)
  }
  const target = await resolveArming({ repoDir, spec, repo: facts.repo, run, home })
  const answers = tty ? await runStartForm({ form, stdin, stdout, heading: `crew start: ${target.repo} #${spec}: ${target.title}` }) : form.answers()
  if (!answers) throw new StartError('cancelled; nothing armed', 130)
  const settled = { ...answers, stackMode: await settleStackMode(answers, run) }
  rememberAnswers(paths, repoDir, settled)
  return { ...(await armRun({ target, answers: settled, launch })), target, answers: settled }
}
