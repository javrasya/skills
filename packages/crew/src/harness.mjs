// The command lines a worker's harness starts and resumes from, whichever
// host types them into its terminal, and the models each harness offers.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeDir, piAgentDir } from './transcript.mjs'
import { childCommand } from './command.mjs'

export const HARNESSES = ['claude', 'pi']

// Typed into the new terminal's shell (PowerShell on Windows), so every word
// must be one no shell reads as syntax.
export const SHELL_WORD = /^[\w.:/@+=-]+$/

// A launch word may also hold brackets, as Claude's `opus[1m]` does: a word
// crew spawns straight into a pty as argv, and one the shell line quotes.
const LAUNCH_WORD = /^[\w.:/@+=[\]-]+$/

// A launch's words as a line a shell reads back as the same words: one with a
// bracket, which a POSIX shell globs and zsh refuses unmatched, single-quoted,
// as PowerShell and POSIX shells both read it.
const shellLine = (words) => words.map((w) => (SHELL_WORD.test(w) ? w : `'${w}'`)).join(' ')

// Every worker's harness starts from this command line, never from the
// host's own agent launch (ADR-0011): it has no permission-mode or
// session-id flag. The session id is the runner's, so it is known before the
// agent runs; both harnesses take `--session-id`, and Claude requires a UUID.
// Without one the command is still built, which is how a call's launch words
// are checked before any worker starts. launchWords is the same launch as
// argv, for a host that spawns it with no shell (crew).
export const launchWords = ({ harness = 'claude', model, effort, permissionMode, sessionId }) => commandWords(harness, sessionId && ['--session-id', sessionId], { model, effort, permissionMode })
export const launchCommand = (launch) => shellLine(launchWords(launch))

// The same launch, carrying on the session it started (session continuation,
// ADR-0013). Claude refuses a --session-id already in use, so it resumes with
// --resume; pi's --session-id reopens the session it names.
export function resumeWords({ harness = 'claude', model, effort, permissionMode, sessionId }) {
  if (!sessionId) throw new Error(`resumeCommand: no session id to continue for ${harness}`)
  return commandWords(harness, harness === 'claude' ? ['--resume', sessionId] : ['--session-id', sessionId], { model, effort, permissionMode })
}
export const resumeCommand = (launch) => shellLine(resumeWords(launch))

// The harness and session id a launch or resume line, split into words, runs,
// whatever its program word; sessionId is null in any other command.
export function launchedSession(words) {
  const after = (flag) => (words.includes(flag) ? (words[words.indexOf(flag) + 1] ?? null) : null)
  return { harness: words.includes('--approve') ? 'pi' : 'claude', sessionId: after('--session-id') ?? after('--resume') }
}

// A launched harness's own command, past any program words crew's config put
// in place of its name, carrying on the session it started, as a parked
// session is entered again (daemon.mjs): Claude's --session-id becomes
// --resume, pi's reopens the session as it is. null for a command with no
// session to carry on.
export function resumedCommand(words) {
  const { harness, sessionId } = launchedSession(words)
  if (!sessionId) return null
  return harness === 'claude' ? words.map((w) => (w === '--session-id' ? '--resume' : w)) : [...words]
}

function commandWords(harness, session, { model, effort, permissionMode }) {
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
  const bad = words.find((w) => !LAUNCH_WORD.test(w))
  if (bad) throw new Error(`refusing to type "${bad}" into a shell to launch ${harness}: use plain model, effort and mode names`)
  return words
}

// A Claude Code session marks the programs it starts as its own (CLAUDECODE,
// its session id, CLAUDE_CODE_CHILD_SESSION…), and a Claude started under
// those marks is a child session: one that saves no transcript, which crew
// reads a worker's turns from. A crew started from inside Claude Code would
// hand them on to every session it starts: each is left out, so every
// session is the one a person would start in a terminal of their own. Only
// the marks go: a CLAUDE_CODE_* setting (a provider, a token) stays.
const SESSION_MARKS = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH']
export const nativeEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_MARKS.includes(k)))

// A session crew hosts stays in crew's terminal: Claude's agent view (Left
// arrow at an empty prompt, /background, --bg) would take the person out of
// the session into a list of Claude's own, and background it where crew no
// longer watches it. Set in the session's environment, so it holds alike on
// macOS and Windows; pi reads nothing of it.
export const HOSTED_ENV = { CLAUDE_CODE_DISABLE_AGENT_VIEW: '1' }

// The environment a crew-hosted harness runs in: `env` without the marks of
// any session it was started from, crew's own on top, and its session's id.
export const crewSessionEnv = (env, { home, session = null }) => ({ ...nativeEnv(env), ...HOSTED_ENV, CREW_HOST: 'crew', CREW_HOME: home, ...(session != null && { CREW_SESSION: session }) })

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
    const s = settingsOf(join(piAgentDir({ home, env }), 'settings.json'))
    return s.defaultModel ? (s.defaultProvider ? `${s.defaultProvider}/${s.defaultModel}` : s.defaultModel) : null
  }
  throw new Error(`unknown harness "${harness}": expected one of ${HARNESSES.join(', ')}`)
}

// pi's models, from `pi --list-models`: a header row, then one model a row
// whose first two columns are its provider and id. None when pi cannot say.
// On Windows npm installs pi as a pi.cmd shim, which only a shell starts: pi
// is found on Path as a shell would find it, and a shim run through ComSpec.
export async function piModels(run, { platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  const r = await run(...childCommand('pi', ['--list-models'], { cwd, env, platform }))
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((w) => w.length >= 2)
    .map(([provider, id]) => `${provider}/${id}`)
}
