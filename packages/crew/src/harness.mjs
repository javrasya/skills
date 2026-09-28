// The command lines a worker's harness starts and resumes from, whichever
// host types them into its terminal, and the models each harness offers.
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { claudeDir } from './transcript.mjs'

export const HARNESSES = ['claude', 'pi']

// Typed into the new terminal's shell (PowerShell on Windows), so every word
// must be one no shell reads as syntax.
export const SHELL_WORD = /^[\w.:/@+=-]+$/

// Every worker's harness starts from this command line, never from the
// host's own agent launch (ADR-0011): it has no permission-mode or
// session-id flag. The session id is the runner's, so it is known before the
// agent runs; both harnesses take `--session-id`, and Claude requires a UUID.
// Without one the command is still built, which is how a call's launch words
// are checked before any worker starts.
export function launchCommand({ harness = 'claude', model, effort, permissionMode, sessionId }) {
  return commandLine(harness, sessionId && ['--session-id', sessionId], { model, effort, permissionMode })
}

// The same launch, carrying on the session it started (session continuation,
// ADR-0013). Claude refuses a --session-id already in use, so it resumes with
// --resume; pi's --session-id reopens the session it names.
export function resumeCommand({ harness = 'claude', model, effort, permissionMode, sessionId }) {
  if (!sessionId) throw new Error(`resumeCommand: no session id to continue for ${harness}`)
  return commandLine(harness, harness === 'claude' ? ['--resume', sessionId] : ['--session-id', sessionId], { model, effort, permissionMode })
}

// The harness and session id a launch or resume line, split into words, runs,
// whatever its program word; sessionId is null in any other command.
export function launchedSession(words) {
  const after = (flag) => (words.includes(flag) ? words[words.indexOf(flag) + 1] ?? null : null)
  return { harness: words.includes('--approve') ? 'pi' : 'claude', sessionId: after('--session-id') ?? after('--resume') }
}

function commandLine(harness, session, { model, effort, permissionMode }) {
  let argv
  if (harness === 'pi') {
    // --approve trusts project-local files: an unattended pi worker would
    // otherwise stop at pi's trust prompt with nobody to answer it.
    argv = ['pi', '--approve', session, model && ['--model', model], effort && ['--thinking', effort]]
  } else if (harness === 'claude') {
    argv = ['claude', session, permissionMode && ['--permission-mode', permissionMode], model && ['--model', model], effort && ['--effort', effort]]
  } else {
    throw new Error(`unknown harness "${harness}": expected one of ${HARNESSES.join(', ')}`)
  }
  const words = argv.flat().filter(Boolean)
  const bad = words.find((w) => !SHELL_WORD.test(w))
  if (bad) throw new Error(`refusing to type "${bad}" into a shell to launch ${harness}: use plain model, effort and mode names`)
  return words.join(' ')
}

const settingsOf = (path) => {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'))
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

// The model the harness last ran with, as its own settings keep it, null when
// they name none: Claude's `model`; pi's `defaultProvider`/`defaultModel`, as
// the provider/id pi's --model takes.
export function lastUsedModel(harness, { home = homedir(), env = process.env } = {}) {
  if (harness === 'claude') return settingsOf(join(claudeDir({ home, env }), 'settings.json')).model || null
  if (harness === 'pi') {
    const s = settingsOf(join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'settings.json'))
    return s.defaultModel ? (s.defaultProvider ? `${s.defaultProvider}/${s.defaultModel}` : s.defaultModel) : null
  }
  throw new Error(`unknown harness "${harness}": expected one of ${HARNESSES.join(', ')}`)
}

// pi's models, from `pi --list-models`: a header row, then one model a row
// whose first two columns are its provider and id. None when pi cannot say.
export async function piModels(run) {
  const r = await run('pi', ['--list-models'])
  if (r.code !== 0) return []
  return r.stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((w) => w.length >= 2).map(([provider, id]) => `${provider}/${id}`)
}
