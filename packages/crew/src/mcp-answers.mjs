// The operator's answers to Claude's "New MCP server found in this project"
// dialog, carried into a worker's child worktree before its agent starts. A
// fresh child of a repo with a committed `.mcp.json` has no answer yet, so
// Claude opens the dialog on launch; Orca's tui-idle wait passes on it, the
// dialog eats worker-start's Enter, and the prompt is left unsent in the input
// box (live: 2 of 2 probe workers, and most of a real run's). With the
// answers in the worktree's `.claude/settings.local.json` first, no dialog
// shows and the prompt goes through (2 of 2).
// The operator's checkout keeps its answers as an edit of that file, which
// can hold secrets beside them: no message here ever carries its contents.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// The keys Claude records a project's MCP answers under.
export const MCP_KEYS = Object.freeze(['enabledMcpjsonServers', 'disabledMcpjsonServers', 'enableAllProjectMcpServers'])

const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

// The worktree's local settings once the source's answers are merged in: the
// source's value of each key it has replaces the worktree's, every other key
// is kept, and each server of `.mcp.json` (`servers`) the answers leave
// unanswered is disabled, since a worker never turns on a server the operator
// never approved. `added` names those. `changed` is false when the merge
// leaves the settings as they were.
export function mergeMcpAnswers({ source = {}, target = {}, servers = [] }) {
  const settings = { ...target }
  for (const k of MCP_KEYS) if (source[k] !== undefined) settings[k] = source[k]
  const answered = new Set([...names(settings.enabledMcpjsonServers), ...names(settings.disabledMcpjsonServers)])
  const added = settings.enableAllProjectMcpServers === true ? [] : servers.filter((s) => !answered.has(s))
  if (added.length) settings.disabledMcpjsonServers = [...names(settings.disabledMcpjsonServers), ...added]
  const changed = MCP_KEYS.some((k) => JSON.stringify(settings[k]) !== JSON.stringify(target[k]))
  return { settings, changed, added }
}

// Parsed, or {} for a file that is not there. A file that is not JSON fails
// with its path only: a JSON.parse message quotes the text it choked on.
function readJson(fs, path, what) {
  if (!fs.existsSync(path)) return {}
  let v
  try {
    v = JSON.parse(String(fs.readFileSync(path, 'utf8')).replace(/^﻿/, ''))
  } catch {
    throw new Error(`${what} ${path} is not valid JSON`)
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} ${path} is not a JSON object`)
  return v
}

// Copies the MCP answers of the checkout at `project` into the worktree at
// `worktree`. No `.mcp.json` in the worktree, or one naming no server: nothing
// to answer, nothing written. The worktree's file is rewritten, as 2-space JSON, only when the
// answers change it. Returns { written, added }; throws on a file it cannot
// read or write, which the caller turns into a warning.
export function copyMcpAnswers({ project, worktree, fs = { existsSync, readFileSync, writeFileSync, mkdirSync } }) {
  const mcp = readJson(fs, join(worktree, '.mcp.json'), "the worktree's")
  const servers = Object.keys(mcp.mcpServers && typeof mcp.mcpServers === 'object' ? mcp.mcpServers : {})
  if (!servers.length) return { written: false, added: [] }
  const source = readJson(fs, join(project, '.claude', 'settings.local.json'), "the project's")
  const targetPath = join(worktree, '.claude', 'settings.local.json')
  const { settings, changed, added } = mergeMcpAnswers({ source, target: readJson(fs, targetPath, "the worktree's"), servers })
  if (!changed) return { written: false, added }
  fs.mkdirSync(join(worktree, '.claude'), { recursive: true })
  fs.writeFileSync(targetPath, `${JSON.stringify(settings, null, 2)}\n`)
  return { written: true, added }
}
