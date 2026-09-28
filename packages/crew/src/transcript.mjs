// Where a worker's session transcript lives, how big it is (one of the two
// liveness signals, ADR-0013), and how full the session's context is. The runner assigns every session id at launch,
// so the file is found from the id and the worktree the harness runs in.
//   Claude: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/<id>.jsonl, the
//           slug being the cwd with every non-alphanumeric character as '-'.
//   pi:     ~/.pi/agent/sessions/--<enc>--/<created-at>_<id>.jsonl, the enc
//           being the cwd with '/', '\' and ':' as '-'. pi writes the file
//           lazily, at its first assistant message.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

// The user's Claude directory: CLAUDE_CONFIG_DIR when set, else ~/.claude.
// The one place it is resolved: Claude transcripts and the run registry
// (registry.mjs) both live under it.
export const claudeDir = ({ home = homedir(), env = process.env } = {}) => env.CLAUDE_CONFIG_DIR || join(home, '.claude')

export const claudeSlug =(cwd) => resolve(cwd).replace(/[^A-Za-z0-9]/g, '-')
export const piDir = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`

const dirsIn = (root) => {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name))
  } catch {
    return []
  }
}

const piFileIn = (dir, sessionId) => {
  try {
    const name = readdirSync(dir).find((f) => f.endsWith(`_${sessionId}.jsonl`))
    return name ? join(dir, name) : null
  } catch {
    return null
  }
}

// The transcript's path, or null while none is written. `scan` also looks in
// every project dir, for a cwd whose dir name the harness shortened or the
// runner does not know.
export function transcriptPath({ harness, sessionId, worktree, scan = true, home = homedir(), env = process.env }) {
  if (harness === 'pi') {
    const root = env.PI_CODING_AGENT_SESSION_DIR || join(home, '.pi', 'agent', 'sessions')
    const direct = [worktree && join(root, piDir(worktree)), env.PI_CODING_AGENT_SESSION_DIR && root].filter(Boolean)
    for (const dir of direct) {
      const f = piFileIn(dir, sessionId)
      if (f) return f
    }
    if (!scan) return null
    for (const dir of dirsIn(root)) {
      const f = piFileIn(dir, sessionId)
      if (f) return f
    }
    return null
  }
  const root = join(claudeDir({ home, env }), 'projects')
  const name = `${sessionId}.jsonl`
  if (worktree && existsSync(join(root, claudeSlug(worktree), name))) return join(root, claudeSlug(worktree), name)
  if (!scan) return null
  return dirsIn(root).map((d) => join(d, name)).find((f) => existsSync(f)) ?? null
}

// Context size is what the latest turn sent the model; tokens, every turn's
// input and output added up.
//   Claude: one line per content block, each repeating its message's id and
//           usage, so a message counts once. Context is input + cache read +
//           cache creation of the last main-chain assistant message: a
//           sidechain line is a subagent's own context. A subagent's tokens
//           are still the session's, so they count toward tokens.
//   pi:     one line per message: input + cacheRead + cacheWrite, and its
//           totalTokens.
const num = (v) => (Number.isFinite(v) ? v : 0)

function usageOf(e) {
  const u = e?.message?.usage
  if (!u || typeof u !== 'object') return null
  if (e.type === 'assistant') {
    const context = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
    return { id: e.message.id ?? e.uuid ?? null, main: e.isSidechain !== true, context, tokens: context + num(u.output_tokens) }
  }
  if (e.type === 'message' && e.message.role === 'assistant') {
    const context = num(u.input) + num(u.cacheRead) + num(u.cacheWrite)
    return { id: e.id ?? null, main: true, context, tokens: Number.isFinite(u.totalTokens) ? u.totalTokens : context + num(u.output) }
  }
  return null
}

// Reads each transcript once, then only what was appended since: a run view
// looks at every agent every refresh, and a long session's transcript runs to
// megabytes. A file that shrank was rewritten, and is read again from the
// start. A torn last line waits for the rest of it.
function usageReader() {
  const files = new Map()
  return (path) => {
    const size = statSync(path).size
    let f = files.get(path)
    if (!f || size < f.offset) {
      f = { offset: 0, rest: Buffer.alloc(0), byId: new Map(), seen: false, tokens: 0, context: null }
      files.set(path, f)
    }
    if (size > f.offset) {
      const chunk = Buffer.alloc(size - f.offset)
      const fd = openSync(path, 'r')
      try {
        readSync(fd, chunk, 0, chunk.length, f.offset)
      } finally {
        closeSync(fd)
      }
      f.offset = size
      const bytes = Buffer.concat([f.rest, chunk])
      const end = bytes.lastIndexOf(0x0a)
      f.rest = bytes.subarray(end + 1)
      for (const line of bytes.subarray(0, end + 1).toString('utf8').split('\n')) {
        let u
        try {
          u = usageOf(JSON.parse(line))
        } catch {
          continue
        }
        if (!u) continue
        f.seen = true
        if (u.main) f.context = u.context
        if (u.id === null) f.tokens += u.tokens
        else {
          f.tokens += u.tokens - (f.byId.get(u.id) ?? 0)
          f.byId.set(u.id, u.tokens)
        }
      }
    }
    return { context: f.context, tokens: f.seen ? f.tokens : null }
  }
}

// Whether a Claude transcript's text holds a user message carrying `needle`:
// the prompt worker-start typed, submitted. Whitespace is compared collapsed,
// as a TUI may rewrap what is typed into it. A meta line (a hook's or a local
// command's) and a subagent's are no prompt of the session's.
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
export function promptDelivered(text, needle) {
  const want = flat(needle)
  if (!want) return false
  for (const line of String(text).split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e?.type !== 'user' || e.isMeta || e.isSidechain) continue
    const c = e.message?.content
    const said = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
    if (flat(said).includes(want)) return true
  }
  return false
}

// Whether the session's latest turn has ended, from the last transcript entry
// that tells: true once the model's reply ends it; false while a prompt or a
// tool's result waits on the model, or the model on a tool; null when no
// entry tells. A subagent's and a meta line are not the session's turn.
//   Claude: an assistant message's stop_reason (tool_use keeps the turn
//           going), a turn_duration system line (ends it), a user line (a
//           prompt or a tool result: one going, but for an interrupt's marker).
//   pi:     an assistant message's stopReason (toolUse keeps it going), a user
//           or toolResult message (one going).
const INTERRUPTED = /^\[Request interrupted by user/
function turnOf(e) {
  if (!e || typeof e !== 'object' || e.isSidechain || e.isMeta) return null
  const m = e.message
  if (e.type === 'assistant') return m?.stop_reason ? m.stop_reason !== 'tool_use' : null
  if (e.type === 'system') return e.subtype === 'turn_duration' ? true : null
  if (e.type === 'user') {
    const c = m?.content
    const said = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text : null
    return INTERRUPTED.test(said ?? '')
  }
  if (e.type === 'message') {
    if (m?.role === 'assistant') return m.stopReason ? m.stopReason !== 'toolUse' : null
    if (m?.role === 'user' || m?.role === 'toolResult') return false
  }
  return null
}
export function turnEnded(text) {
  const lines = String(text).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let e
    try {
      e = JSON.parse(lines[i])
    } catch {
      continue
    }
    const ended = turnOf(e)
    if (ended !== null) return ended
  }
  return null
}

// The transcript's last `bytes`: the latest turn is at its end, and a long
// session's whole file runs to megabytes. A line cut at the start is skipped.
function tail(path, bytes = 256 * 1024) {
  const size = statSync(path).size
  const chunk = Buffer.alloc(Math.min(size, bytes))
  const fd = openSync(path, 'r')
  try {
    readSync(fd, chunk, 0, chunk.length, size - chunk.length)
  } finally {
    closeSync(fd)
  }
  return chunk.toString('utf8')
}

// size({ harness, sessionId, worktree }) is the transcript's length in bytes,
// or null while it has none; path(…) is where it is, or null; usage(…) is
// { path, context, tokens }, context and tokens null until an assistant turn
// is written, or null with no transcript; delivered({ …, needle }) is
// promptDelivered on it, false with no transcript; idle(…) is turnEnded on its
// tail, null with no transcript. None throws: a transcript the
// caller cannot see is a signal missing, not a dead worker. A found path is
// remembered; the scan of every project dir runs on the first miss and every
// `scanEvery`-th one after, since a runner looks at every live worker every
// few seconds.
export function sessionTranscripts({ home = homedir(), env = process.env, scanEvery = 12 } = {}) {
  const found = new Map()
  const misses = new Map()
  const usage = usageReader()
  function locate({ harness, sessionId, worktree }) {
    if (!sessionId) return null
    let path = found.get(sessionId)
    if (!path || !existsSync(path)) {
      const miss = misses.get(sessionId) ?? 0
      misses.set(sessionId, miss + 1)
      path = transcriptPath({ harness, sessionId, worktree, scan: miss % scanEvery === 0, home, env })
      if (!path) return null
      found.set(sessionId, path)
    }
    return path
  }
  const quiet = (fn) => (q) => {
    try {
      return fn(q)
    } catch {
      return null
    }
  }
  return {
    size: quiet((q) => {
      const path = locate(q)
      return path ? statSync(path).size : null
    }),
    path: quiet(locate),
    delivered: quiet((q) => {
      const path = locate(q)
      return path ? promptDelivered(readFileSync(path, 'utf8'), q.needle) : false
    }),
    idle: quiet((q) => {
      const path = locate(q)
      return path ? turnEnded(tail(path)) : null
    }),
    usage: quiet((q) => {
      const path = locate(q)
      return path ? { path, ...usage(path) } : null
    }),
  }
}
