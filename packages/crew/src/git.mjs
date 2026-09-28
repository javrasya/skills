// Git and bounded calls as the runner and every session host use them. No
// host in here: a worktree is git's, whichever host made it.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { RUNNER_SETTINGS } from './settings.mjs'

// A clock's timer: resolves after ms unless cancelled first. The runner's
// clock carries one, so a test's clock decides when a call has taken too long.
export function realTimer(ms) {
  let id
  const promise = new Promise((r) => { id = setTimeout(r, ms) })
  return { promise, cancel: () => clearTimeout(id) }
}

// p, unless it has not settled within ms of the clock's time: then the error
// timeout() makes.
export async function bounded(clock, ms, p, timeout) {
  const t = clock.timer(ms)
  try {
    return await Promise.race([p, t.promise.then(() => { throw timeout() })])
  } finally {
    t.cancel()
  }
}

export function execGit(cwd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]} in ${cwd}: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout)))
  })
}

// The one git helper: a git command in `cwd`, bounded at `ms` as a host call
// is, so a hung git fails as call_timeout and never stalls its caller.
export function gitIn(cwd, args, { git = execGit, clock = { timer: realTimer }, ms = RUNNER_SETTINGS.hostCallMs } = {}) {
  return bounded(clock, ms, git(cwd, args, ms), () => Object.assign(new Error(`git ${args[0]}: call_timeout: no answer within ${Math.round(ms / 1000)}s`), { code: 'call_timeout' }))
}

// `git status --porcelain` as its lines, each kept whole: a line's leading
// space is its index column, so the output is never trimmed.
export const porcelainLines = (text) => String(text ?? '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)

// Whether a worktree's porcelain lines are its baseline's, in any order.
export const sameLines = (lines, baseline) => lines.length === baseline.length && [...lines].sort().join('\n') === [...baseline].sort().join('\n')

// Commits on a worktree's branch that no other branch and no remote holds:
// work of its own, which a retry never takes a worktree over with.
export async function worktreeOwnCommits(path, branch, bound) {
  const b = String(branch ?? '').replace(/^refs\/heads\//, '')
  return Number((await gitIn(path, ['rev-list', '--count', 'HEAD', '--not', `--exclude=${b}`, '--branches', '--remotes'], bound)).trim())
}

// Commits reachable from a worktree's HEAD that no remote-tracking ref holds
// (D6 on #43): what a reclaim refuses to remove unless forced. Uncommitted
// files do not count. A worktree already gone from disk holds none.
export async function worktreeUnpushed(path, bound) {
  if (!existsSync(path)) return 0
  return Number((await gitIn(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], bound)).trim())
}

// The last segment of a worktree path: the name its host gave it, suffixed
// -2, -3… when that name was taken. Every reader of a worktree's name takes
// it from here, so the `<runId>-` ownership rule reads one name.
export const worktreeName = (path) => String(path).split(/[\\/]/).pop()
