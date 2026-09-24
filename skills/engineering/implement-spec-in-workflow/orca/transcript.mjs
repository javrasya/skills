// Where a worker's session transcript lives, and how big it is: one of the two
// liveness signals (ADR-0013). The runner assigns every session id at launch,
// so the file is found from the id and the worktree the harness runs in.
//   Claude: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/<id>.jsonl, the
//           slug being the cwd with every non-alphanumeric character as '-'.
//   pi:     ~/.pi/agent/sessions/--<enc>--/<created-at>_<id>.jsonl, the enc
//           being the cwd with '/', '\' and ':' as '-'. pi writes the file
//           lazily, at its first assistant message.
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

export const claudeSlug = (cwd) => resolve(cwd).replace(/[^A-Za-z0-9]/g, '-')
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
  const root = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')
  const name = `${sessionId}.jsonl`
  if (worktree && existsSync(join(root, claudeSlug(worktree), name))) return join(root, claudeSlug(worktree), name)
  if (!scan) return null
  return dirsIn(root).map((d) => join(d, name)).find((f) => existsSync(f)) ?? null
}

// size({ harness, sessionId, worktree }) is the transcript's length in bytes,
// or null while it has none. Never throws: a transcript the runner cannot see
// is one signal missing, not a dead worker. A found path is remembered; the
// scan of every project dir runs on the first miss and every `scanEvery`-th
// one after, since a runner looks at every live worker every few seconds.
export function sessionTranscripts({ home = homedir(), env = process.env, scanEvery = 12 } = {}) {
  const found = new Map()
  const misses = new Map()
  return {
    size({ harness, sessionId, worktree }) {
      if (!sessionId) return null
      try {
        let path = found.get(sessionId)
        if (!path || !existsSync(path)) {
          const miss = misses.get(sessionId) ?? 0
          misses.set(sessionId, miss + 1)
          path = transcriptPath({ harness, sessionId, worktree, scan: miss % scanEvery === 0, home, env })
          if (!path) return null
          found.set(sessionId, path)
        }
        return statSync(path).size
      } catch {
        return null
      }
    },
  }
}
