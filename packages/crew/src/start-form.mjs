// The form `crew start` arms a run from (#100): harness, model, base branch,
// stack mode, run order and permission mode, each with a default and a flag. Pure but
// for probeStart, which gathers the facts the form is drawn from, and the
// answer file, so the command drives it by flags alone or row by row.
//
// The answers are remembered per repo in crew's home (start.json, keyed by
// the repo's path) and pre-fill the next form, beating the harness's own
// default. A model is remembered per harness, so switching harness never
// carries Claude's model to pi.
import { mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readCrewConfig } from './crew-config.mjs'
import { parseFlags } from './args.mjs'
import { writeJsonAtomic } from './fsutil.mjs'
import { samePath } from './paths.mjs'
import { branchNames, currentBranch, execProgram, ghRepo, ghStackInstalled, stacksApi } from './git.mjs'
import { HARNESSES, lastUsedModel, piModels } from './harness.mjs'

export const ROWS = ['harness', 'model', 'base', 'stackMode', 'runOrder', 'permissionMode']
export const FLAGS = { harness: '--harness', model: '--model', base: '--base', stackMode: '--stack-mode', runOrder: '--run-order', permissionMode: '--permission-mode' }
export const LABELS = { harness: 'Harness', model: 'Model', base: 'Base branch', stackMode: 'Stack mode', runOrder: 'Run order', permissionMode: 'Permission mode' }
const HARNESS_LABELS = { claude: 'Claude Code', pi: 'pi' }

// A stack mode's answer is the template's STACK_MODE, but for `install`,
// which arms as `native` once the extension is in (settleStackMode).
export const STACK_MODES = { native: 'GH Stack', install: 'Install and Use GH Stack', chain: 'Basic Git stacking' }
export const STACKS_DOCS = 'https://docs.github.com/en/pull-requests/tutorials/roll-out-stacked-prs'
export const GH_STACK_INSTALL = ['extension', 'install', 'github/gh-stack']

// The template's RUN_ORDER (ADR-0020), the default first.
export const RUN_ORDERS = { parallel: 'Parallel', sequential: 'Sequential' }

// The rows flag-only use may leave out, and the answer each then takes, never
// the remembered one: a script written before Run order existed arms as it
// did, parallel (ADR-0020).
export const FLAG_DEFAULTS = { runOrder: 'parallel' }

// The modes a Claude worker can start in; `auto` first, as it is the default.
export const PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'default']

const unique = (xs) => [...new Set(xs.filter(Boolean))]

// What the form is drawn from, probed once:
//   branch, branches     the checkout's branch (null when detached) and every
//                        branch a stack could merge into
//   models[harness]      { last, list }: the model the harness last ran with,
//                        and the ones it cycles through
//   ghStack              { installed, api: 'enabled'|'disabled'|'unknown', detail }
//   repo                 owner/name as gh knows it, null when it knows none
export async function probeStart({ cwd = process.cwd(), paths, home = homedir(), env = process.env, run = execProgram } = {}) {
  const claudeLast = lastUsedModel('claude', { home, env })
  const piLast = lastUsedModel('pi', { home, env })
  const [branch, branches, repo, installed, pi] = await Promise.all([currentBranch(cwd, run), branchNames(cwd, run), ghRepo(cwd, run), ghStackInstalled(run), piModels(run, { env, cwd })])
  const api = await stacksApi(repo, run)
  return {
    repo,
    branch,
    branches: unique([branch, ...branches]),
    models: {
      claude: { last: claudeLast, list: unique([claudeLast, ...readCrewConfig(paths).claudeModels]) },
      pi: { last: piLast, list: unique([piLast, ...pi]) },
    },
    ghStack: { installed, api: api.state, ...(api.detail && { detail: api.detail }) },
  }
}

// The stack modes the facts allow, each { value, label, disabled, note }. A
// 404 disables GH Stack whether or not the extension is in, since installing
// nothing enables stacks for a repo; so does a stacks API that gave no
// answer, since nothing says installing would make GH Stack usable.
export function stackOptions({ installed, api, detail }) {
  let first
  if (api === 'disabled') first = { value: 'native', disabled: true, note: `not enabled for this repo: ${STACKS_DOCS}` }
  else if (api === 'unknown') first = { value: 'native', disabled: true, note: `the stacks API did not answer: ${detail}` }
  else if (!installed) first = { value: 'install', note: `runs gh ${GH_STACK_INSTALL.join(' ')}` }
  else first = { value: 'native' }
  return [first, { value: 'chain' }].map((o) => ({ label: STACK_MODES[o.value], disabled: false, ...o }))
}

// The flag-given answers in argv, by row, and the words that are no flag of
// the form's. A flag with no value is an error naming it.
export function flagsToAnswers(argv) {
  const { values, positionals } = parseFlags(argv, { strings: Object.values(FLAGS) })
  const answers = Object.fromEntries(ROWS.filter((r) => values[FLAGS[r]] !== undefined).map((r) => [r, values[FLAGS[r]]]))
  return { answers, rest: positionals }
}

// The form over the facts, pre-filled from the remembered answers, then the
// flags. A remembered answer the facts no longer allow (a branch gone, GH
// Stack no longer available) falls back to the default; a flag they do not
// allow is an error naming the flag.
export function startForm(facts, { remembered = {}, flags = {} } = {}) {
  const stacks = stackOptions(facts.ghStack)
  const usable = (row, v) => options(row).some((o) => o.value === v && !o.disabled)
  const modelFor = (harness) => remembered.models?.[harness] || facts.models[harness]?.last || facts.models[harness]?.list[0] || null
  const values = {}

  function options(row) {
    if (row === 'harness') return HARNESSES.map((h) => ({ value: h, label: HARNESS_LABELS[h] ?? h, disabled: false }))
    if (row === 'model') return unique([...(facts.models[values.harness]?.list ?? []), values.model]).map((m) => ({ value: m, label: m, disabled: false }))
    if (row === 'base') return unique([...facts.branches, values.base]).map((b) => ({ value: b, label: b, disabled: false }))
    if (row === 'stackMode') return stacks
    if (row === 'runOrder') return Object.entries(RUN_ORDERS).map(([value, label]) => ({ value, label, disabled: false }))
    if (row === 'permissionMode') return PERMISSION_MODES.map((m) => ({ value: m, label: m, disabled: false }))
    throw new Error(`no row ${row}`)
  }
  const shown = (row) => row !== 'permissionMode' || values.harness === 'claude'

  values.harness = HARNESSES.includes(remembered.harness) ? remembered.harness : HARNESSES[0]
  values.model = modelFor(values.harness)
  values.base = facts.branches.includes(remembered.base) ? remembered.base : facts.branch ?? facts.branches[0] ?? null
  values.stackMode = usable('stackMode', remembered.stackMode) ? remembered.stackMode : stacks.find((o) => o.value === 'native' && !o.disabled) ? 'native' : 'chain'
  values.runOrder = Object.hasOwn(RUN_ORDERS, remembered.runOrder) ? remembered.runOrder : 'parallel'
  values.permissionMode = PERMISSION_MODES.includes(remembered.permissionMode) ? remembered.permissionMode : PERMISSION_MODES[0]

  const form = {
    rows: () => ROWS.filter(shown).map((row) => ({ row, flag: FLAGS[row], label: LABELS[row], value: values[row], options: options(row) })),
    // An answer for a row, as a flag or a pick gives it.
    set(row, value) {
      const flag = FLAGS[row]
      if (!flag) throw new Error(`no row ${row}`)
      if (!shown(row)) throw new Error(`${flag}: ${values.harness} has no permission mode`)
      if (typeof value !== 'string' || !value) throw new Error(`${flag} needs a value`)
      if (row === 'model') {
        values.model = value
        return form
      }
      const option = options(row).find((o) => o.value === value)
      if (row === 'base' && !option) throw new Error(`${flag}: no branch ${value}`)
      if (!option) throw new Error(`${flag}: ${value} is not one of ${options(row).filter((o) => !o.disabled).map((o) => o.value).join(', ')}`)
      if (option.disabled) throw new Error(`${flag}: ${option.label} cannot be used, ${option.note}`)
      if (row === 'harness' && value !== values.harness) values.model = modelFor(value)
      values[row] = value
      return form
    },
    // The row's next usable option, wrapping; step -1 for the one before.
    cycle(row, step = 1) {
      const opts = options(row)
      let i = opts.findIndex((o) => o.value === values[row])
      for (let n = 0; n < opts.length; n++) {
        i = (i + step + opts.length) % opts.length
        if (!opts[i].disabled) return form.set(row, opts[i].value)
      }
      return form
    },
    // The flags of the shown rows that flag-only use has not given and that
    // have no FLAG_DEFAULTS answer: each an error when there is no terminal
    // to ask at.
    missingFlags: (given = flags) => ROWS.filter((r) => shown(r) && given[r] === undefined && !Object.hasOwn(FLAG_DEFAULTS, r)).map((r) => FLAGS[r]),
    // The answers the run is armed from, permissionMode only for Claude.
    answers: () => Object.fromEntries(ROWS.filter(shown).map((r) => [r, values[r]])),
    // The answers of flag-only use: a row with no flag takes its FLAG_DEFAULTS answer.
    flagAnswers() {
      for (const [row, value] of Object.entries(FLAG_DEFAULTS)) if (flags[row] === undefined) form.set(row, value)
      return form.answers()
    },
  }
  for (const row of ROWS) if (flags[row] !== undefined) form.set(row, flags[row])
  return form
}

// The template's STACK_MODE for the answers. Only the Install and Use answer
// installs the extension: choosing it is the operator's consent.
export async function settleStackMode(answers, run = execProgram) {
  if (answers.stackMode !== 'install') return answers.stackMode
  const r = await run('gh', GH_STACK_INSTALL)
  if (r.code !== 0) throw new Error(`gh ${GH_STACK_INSTALL.join(' ')}: ${r.stderr.trim() || (r.code === null ? 'gh is not installed' : `exited ${r.code}`)}`)
  return 'native'
}

export const answersFile = (paths) => join(paths.home, 'start.json')

function readAnswers(paths) {
  try {
    const all = JSON.parse(readFileSync(answersFile(paths), 'utf8'))
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch {
    // An unreadable file only loses the pre-fill; the form still has its defaults.
    return {}
  }
}

// A repo's entry, {} when it is not an object: a hand-edited null only loses
// the pre-fill, as an unreadable file does.
const answersIn = (all, key) => {
  const a = key === undefined ? null : all[key]
  return a && typeof a === 'object' && !Array.isArray(a) ? a : {}
}

// The answers last given in the repo, {} when none were.
export function rememberedAnswers(paths, repo) {
  const all = readAnswers(paths)
  return answersIn(all, Object.keys(all).find((k) => samePath(k, repo)))
}

export function rememberAnswers(paths, repo, answers) {
  const all = readAnswers(paths)
  const key = Object.keys(all).find((k) => samePath(k, repo)) ?? repo
  const before = answersIn(all, key)
  all[key] = {
    ...before,
    ...answers,
    models: { ...before.models, [answers.harness]: answers.model },
  }
  delete all[key].model
  mkdirSync(paths.home, { recursive: true })
  const file = answersFile(paths)
  writeJsonAtomic(file, all)
}
