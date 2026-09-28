// Crew's own config: ~/.crew/config.json (crewPaths().config), every key optional.
//   "backKey": "f12"       the key that leaves an entered session for the list
//   "repos": { "<repo path>": { "setup": "<script>", "roles": { "<role>": { "harness": "pi", "model": "<model>" } } } }
//                          per repo, by its main checkout's path, never in the
//                          repo: `setup` is the hook run in each worktree crew
//                          makes of it (crew-host.mjs), relative to the repo;
//                          `roles` the workflow template's roles that run on a
//                          harness and model of their own in place of the run
//                          default `crew start` chose (arm.mjs renderRoles)
//   "harnesses": { "<harness>": ["<program>", "<arg>", …] }
//                          the program words a worker's launch line starts
//                          with in place of the harness's own name, as a test
//                          puts a fake harness there (crew-host.mjs)
//   "claudeModels": ["opus", …]
//                          the models `crew start` cycles Claude through,
//                          beside the one Claude last ran with (start-form.mjs)
import { readFileSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { HARNESSES } from './harness.mjs'

export const DEFAULTS = Object.freeze({ backKey: 'f12', claudeModels: Object.freeze(['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]']) })

// The bytes each key arrives as in raw input. The F-keys have a few spellings:
// xterm's, the VT220's, and libuv's on the Windows console (F12 is ESC[24~ in all).
const FKEYS = {
  f1: ['\x1bOP', '\x1b[11~', '\x1b[[A'],
  f2: ['\x1bOQ', '\x1b[12~', '\x1b[[B'],
  f3: ['\x1bOR', '\x1b[13~', '\x1b[[C'],
  f4: ['\x1bOS', '\x1b[14~', '\x1b[[D'],
  f5: ['\x1b[15~', '\x1b[[E'],
  f6: ['\x1b[17~'],
  f7: ['\x1b[18~'],
  f8: ['\x1b[19~'],
  f9: ['\x1b[20~'],
  f10: ['\x1b[21~'],
  f11: ['\x1b[23~'],
  f12: ['\x1b[24~'],
}
// pi binds both, so a back key there would take them from the session.
const REFUSED = { 'ctrl+left': 'pi binds Ctrl+Left', 'ctrl+]': 'pi binds Ctrl+]' }
// Ctrl+H, I, J and M are Backspace, Tab and Enter to a program.
const CTRL = 'abcdefgklnopqrstuvwxyz'

export const BACK_KEYS = [...Object.keys(FKEYS), ...[...CTRL].map((c) => `ctrl+${c}`)]

// The byte sequences a back key name arrives as.
export function backKeySequences(name) {
  const key = String(name).trim().toLowerCase()
  if (REFUSED[key]) throw new Error(`back key ${name} cannot be used: ${REFUSED[key]}`)
  if (FKEYS[key]) return FKEYS[key]
  const ctrl = /^ctrl\+([a-z])$/.exec(key)
  if (ctrl && CTRL.includes(ctrl[1])) return [String.fromCharCode(ctrl[1].charCodeAt(0) - 96)]
  throw new Error(`back key ${name} is not one crew knows; use one of ${BACK_KEYS.join(', ')}`)
}

export function readCrewConfig(paths) {
  let text
  try {
    text = readFileSync(paths.config, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULTS }
    throw e
  }
  let config
  try {
    config = JSON.parse(text)
  } catch (e) {
    throw new Error(`${paths.config}: not JSON (${e.message})`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${paths.config}: not a JSON object`)
  const merged = { ...DEFAULTS, ...config }
  try {
    backKeySequences(merged.backKey)
    reposOf(merged.repos)
    harnessesOf(merged.harnesses)
    if (!Array.isArray(merged.claudeModels) || !merged.claudeModels.every((m) => typeof m === 'string' && m)) throw new Error('claudeModels: not a list of model names')
  } catch (e) {
    throw new Error(`${paths.config}: ${e.message}`)
  }
  return merged
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function reposOf(repos = {}) {
  if (!isObject(repos)) throw new Error('repos: not an object of repo paths')
  for (const [repo, c] of Object.entries(repos)) {
    if (!isObject(c)) throw new Error(`repos[${JSON.stringify(repo)}]: not an object`)
    if (c.setup !== undefined && (typeof c.setup !== 'string' || !c.setup)) throw new Error(`repos[${JSON.stringify(repo)}].setup: not a script path`)
    if (c.roles === undefined) continue
    if (!isObject(c.roles)) throw new Error(`repos[${JSON.stringify(repo)}].roles: not an object of role names`)
    for (const [role, row] of Object.entries(c.roles)) {
      const at = `repos[${JSON.stringify(repo)}].roles.${role}`
      if (!isObject(row) || !HARNESSES.includes(row.harness)) throw new Error(`${at}: not { "harness": ${HARNESSES.map((h) => `"${h}"`).join(' or ')}, "model": "<model>" }`)
      if (typeof row.model !== 'string' || !row.model) throw new Error(`${at}.model: not a model name`)
    }
  }
  return repos
}

function harnessesOf(harnesses = {}) {
  if (!isObject(harnesses)) throw new Error('harnesses: not an object of harness names')
  for (const [name, words] of Object.entries(harnesses)) {
    if (!Array.isArray(words) || !words.length || !words.every((w) => typeof w === 'string' && w)) throw new Error(`harnesses.${name}: not a list of program words`)
  }
  return harnesses
}

// One path however it is spelled: Windows paths match whatever their case and slashes.
export const samePath = (a, b, platform = process.platform) => {
  const norm = (p) => resolve(p).replace(/[\\/]+$/, '')
  return platform === 'win32' ? norm(a).replace(/\\/g, '/').toLowerCase() === norm(b).replace(/\\/g, '/').toLowerCase() : norm(a) === norm(b)
}

// The repo's own config, {} when crew has none for it; `setup`, when named,
// made absolute against the repo.
export function repoConfig(paths, repo) {
  const repos = readCrewConfig(paths).repos ?? {}
  const key = Object.keys(repos).find((k) => samePath(k, repo))
  const c = key ? repos[key] : {}
  return { ...c, ...(c.setup && { setup: isAbsolute(c.setup) ? c.setup : resolve(repo, c.setup) }) }
}
