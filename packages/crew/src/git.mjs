// Git and bounded calls as the runner and every session host use them. No
// host in here: a worktree is git's, whichever host made it.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { RUNNER_SETTINGS } from './settings.mjs'

// A clock's timer: resolves after ms unless cancelled first. The runner's
// clock carries one, so a test's clock decides when a call has taken too long.
export function realTimer(ms) {
  let id
  const promise = new Promise((r) => {
    id = setTimeout(r, ms)
  })
  return { promise, cancel: () => clearTimeout(id) }
}

// p, unless it has not settled within ms of the clock's time: then the error
// timeout() makes.
export async function bounded(clock, ms, p, timeout) {
  const t = clock.timer(ms)
  try {
    return await Promise.race([
      p,
      t.promise.then(() => {
        throw timeout()
      }),
    ])
  } finally {
    t.cancel()
  }
}

export function execGit(cwd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]} in ${cwd}: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout))))
  })
}

// The one git helper: a git command in `cwd`, bounded at `ms` as a host call
// is, so a hung git fails as call_timeout and never stalls its caller.
export function gitIn(cwd, args, { git = execGit, clock = { timer: realTimer }, ms = RUNNER_SETTINGS.hostCallMs } = {}) {
  return bounded(clock, ms, git(cwd, args, ms), () => Object.assign(new Error(`git ${args[0]}: call_timeout: no answer within ${Math.round(ms / 1000)}s`), { code: 'call_timeout' }))
}

// The main checkout of the repo `dir` is in: crew's per-repo config, its
// remembered `crew start` answers and a worktree's siblings are keyed on it,
// whichever worktree of it the command runs in.
export async function repoOf(dir, bound) {
  const common = resolve(dir, (await gitIn(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], bound)).trim())
  return basename(common) === '.git' ? dirname(common) : common.replace(/\.git$/, '')
}

// `git status --porcelain` as its lines, each kept whole: a line's leading
// space is its index column, so the output is never trimmed.
export const porcelainLines = (text) =>
  String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)

// Whether a worktree's porcelain lines are its baseline's, in any order.
export const sameLines = (lines, baseline) => lines.length === baseline.length && [...lines].sort().join('\n') === [...baseline].sort().join('\n')

// A worktree's porcelain lines that none of `known` is: what it holds beyond them.
export const extraLines = (lines, known) => {
  const had = new Set(known)
  return lines.filter((l) => !had.has(l))
}

// The paths a worktree's porcelain lines name: each line's two status columns
// and the space after them dropped.
export const porcelainPaths = (lines) => lines.map((l) => l.slice(3))

// `known` with every line of `lines` it lacks added, each line once.
export const unionLines = (known, lines) => [...new Set([...known, ...lines])]

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

// The names a run gives its worktrees, built here and nowhere else: an
// agent's own `<runId>-<n>`, n the origin of the call that started it, which
// is also the agent's identity in the run registry; and a sequential run's one
// chain worktree (ADR-0020), which is the run's, never one agent's.
export const agentId = (runId, origin) => `${runId}-${origin}`
export const chainName = (runId) => `${runId}-chain`

// A program's exit, never a rejection: { code, stdout, stderr }, code null
// when it could not start at all (not installed). The probes `crew start`
// makes take one of these, so a test hands them its own.
export function execProgram(program, args, { cwd, timeoutMs = RUNNER_SETTINGS.hostCallMs } = {}) {
  return new Promise((resolve) => {
    execFile(program, args, { cwd, windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') }))
  })
}

// The branch the checkout sits on, null on a detached HEAD.
export async function currentBranch(cwd, run = execProgram) {
  const r = await run('git', ['-C', cwd, 'branch', '--show-current'])
  if (r.code !== 0) throw new Error(`git branch in ${cwd}: ${r.stderr.trim()}`)
  return r.stdout.trim() || null
}

// Every branch a stack could merge into: the local ones, and origin's by the
// name a local one would have.
export async function branchNames(cwd, run = execProgram) {
  const r = await run('git', ['-C', cwd, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'])
  if (r.code !== 0) throw new Error(`git for-each-ref in ${cwd}: ${r.stderr.trim()}`)
  const names = r.stdout
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^refs\/heads\//, '')
        .replace(/^refs\/remotes\/origin\//, ''),
    )
    .filter((n) => n && n !== 'HEAD')
  return [...new Set(names)]
}

// The repo's owner/name as gh knows it, null when gh knows none for the checkout.
export async function ghRepo(cwd, run = execProgram) {
  const r = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd })
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

export const ghStackInstalled = async (run = execProgram) => {
  const r = await run('gh', ['extension', 'list'])
  return r.code === 0 && /\bgh-stack\b/.test(r.stdout)
}

// Whether the repo's stacks API answers: 'enabled' on any 200 (even `[]`),
// 'disabled' on a 404 (stacks not rolled out for the repo, which installing
// nothing fixes), and 'unknown' with gh's own words on anything else.
export async function stacksApi(repo, run = execProgram) {
  if (!repo) return { state: 'unknown', detail: 'gh knows no GitHub repo for this checkout' }
  const r = await run('gh', ['api', `repos/${repo}/stacks`, '--silent'])
  if (r.code === 0) return { state: 'enabled' }
  if (/\b404\b/.test(r.stderr)) return { state: 'disabled' }
  return { state: 'unknown', detail: r.code === null ? 'gh is not installed' : r.stderr.trim() || `gh exited ${r.code}` }
}
