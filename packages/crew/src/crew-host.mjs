// The crew session host (ADR-0017): every worker a session the crew daemon
// holds in a real pty, reached through the daemon's client protocol
// (daemon/daemon.mjs), which this adapter is the only client of. A worker's
// terminal handle and its dispatch are both its daemon session's id: crew has
// no dispatch apart from the session it runs in. Runs, dispatches and their
// mailboxes are the daemon's (daemon/runs.mjs); worktrees are git's.
//
// A worker gets crew's preamble typed before its prompt, in the place Orca's
// goes: its IDs, and the agent-side `crew orchestration send` its mail and
// worker_done go through. Its session's environment names crew as its host
// (CREW_HOST, CREW_HOME), so submit and that command reach this daemon with
// no Orca installed.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'
import { crewPaths, noDaemon } from './daemon/transport.mjs'
import { ensureDaemon, request } from './daemon/client.mjs'
import { launchCommand, launchedSession, resumeCommand } from './harness.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'
import { sessionTranscripts } from './transcript.mjs'
import { readCrewConfig, repoConfig, samePath } from './crew-config.mjs'
import { gitIn, porcelainLines, worktreeOwnCommits } from './git.mjs'
import { reuseWorktree } from './orca-cli.mjs'
import { copyMcpAnswers } from './mcp-answers.mjs'

export const CREW_BIN = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url))

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const fail = (code, message, extra = {}) => Object.assign(new Error(`crew: ${code}: ${message}`), { code, ...extra })

// What a worker reads before its prompt. The runner's prompts send it to "your
// Orca preamble" for its IDs and "orchestration send" for its mail, so crew's
// says it stands in for that preamble and names the command in full.
export function crewPreamble({ terminal, taskId, capability }) {
  const ids = `--from ${terminal} --dispatch-capability ${capability} --task-id ${taskId} --dispatch-id ${terminal}`
  return `=== Your Orca preamble, from crew ===
No Orca runs here: crew, this run's session host, stands in for it. Your IDs: ${ids}
Every \`orchestration send\` your instructions name is this command, with those IDs:
  node "${CREW_BIN}" orchestration send ${ids} --type <worker_done|handoff|escalation> --subject "<subject>" --body "<body>" [--outcome succeeded|failed]
=== TASK ===
`
}

// The main checkout of the repo `dir` is in: a worktree's config and its
// siblings are keyed on it, whichever worktree of it the run is in.
async function repoOf(dir, bound) {
  const common = resolve(dir, (await gitIn(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], bound)).trim())
  return basename(common) === '.git' ? dirname(common) : common.replace(/\.git$/, '')
}

// Where crew makes a repo's worktrees: `<repo-parent>/<repo>.crew/`.
export const crewWorktrees = (repo) => join(dirname(repo), `${basename(repo)}.crew`)

// The repo a worktree crew made belongs to, from where crew put it; null for any other path.
const repoOfCrewWorktree = (path) => {
  const root = dirname(resolve(path))
  return basename(root).endsWith('.crew') && basename(root) !== '.crew' ? join(dirname(root), basename(root).slice(0, -'.crew'.length)) : null
}

async function worktreesOf(repo, bound) {
  const rows = []
  for (const line of (await gitIn(repo, ['worktree', 'list', '--porcelain'], bound)).split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (line.startsWith('worktree ')) rows.push({ path: resolve(line.slice(9)), branch: null })
    else if (line.startsWith('branch ') && rows.length) rows.at(-1).branch = line.slice(7)
  }
  return rows
}

// A setup hook by its kind: a node script, PowerShell, sh or cmd, and
// anything else run as it is.
function hookCommand(script) {
  const ext = extname(script).toLowerCase()
  if (['.mjs', '.cjs', '.js'].includes(ext)) return [process.execPath, [script]]
  if (ext === '.ps1') return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]]
  if (ext === '.sh') return ['sh', [script]]
  if (ext === '.cmd' || ext === '.bat') return [process.env.ComSpec || 'cmd.exe', ['/d', '/c', script]]
  return [script, []]
}

function runHook(script, { repo, worktree, env, ms }) {
  const [program, args] = hookCommand(script)
  return new Promise((done, reject) => {
    execFile(program, args, { cwd: worktree, env: { ...env, CREW_REPO: repo, CREW_WORKTREE: worktree }, timeout: ms, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(fail('setup_failed', `the setup hook ${script} failed in ${worktree}${err.killed ? ` (killed after ${Math.round(ms / 1000)}s)` : ''}: ${String(stderr || err.message).trim().split('\n').slice(-8).join('\n')}`)) : done())
  })
}

// A log's lines, then every line added to it, drawn in a session of its own.
const TAIL = "const fs=require('fs');const p=process.argv[1];let at=0;const show=()=>{let s;try{s=fs.statSync(p)}catch{return}if(s.size<at)at=0;if(s.size===at)return;const b=Buffer.alloc(s.size-at);const fd=fs.openSync(p,'r');fs.readSync(fd,b,0,b.length,at);fs.closeSync(fd);at=s.size;process.stdout.write(b.toString('utf8').replace(/\\r?\\n/g,'\\r\\n'))};show();setInterval(show,500)"

// `cwd` is the run's worktree, where a worker without a child worktree runs,
// and the checkout whose MCP answers a child worktree gets (`project`);
// `env` the environment its harness gets. `harnesses` maps a harness to the
// program words its launch line starts with in place of the harness's own
// name, as the contract suite puts its fake harness there, crew's config's
// `harnesses` by default; the rest of the line is the runner's launch
// command, word for word. A harness is ready for
// its prompt once it has drawn and then been quiet for `quietMs`, and a start
// fails if it is not ready within `readyMs`. A worker is idle once its session
// transcript says its latest turn ended, or, where the transcript does not
// say, once its terminal has been quiet for `quietMs`. Git calls are bounded
// at `callMs`, and a worktree's making, its setup hook included, at `createMs`.
export function crewHost({ paths = crewPaths(), env = process.env, cwd = process.cwd(), project = cwd, harnesses = readCrewConfig(paths).harnesses ?? {}, transcripts = sessionTranscripts({ env }), quietMs = RUNNER_SETTINGS.quietOutputMs, readyMs = 180_000, endMs = 10_000, pollMs = 100, callMs = RUNNER_SETTINGS.hostCallMs, createMs = RUNNER_SETTINGS.worktreeCreateMs } = {}) {
  // This adapter's side of the Runs it creates or takes over, as a runner's
  // terminal is on Orca: the daemon fences every other coordinator out.
  const coordinator = `coord_${randomBytes(6).toString('hex')}`
  const sessionEnv = { ...env, CREW_HOST: 'crew', CREW_HOME: paths.home }
  const bound = { ms: callMs }
  let daemon = null
  let outage = null
  async function once(message) {
    daemon ??= ensureDaemon(paths).catch((e) => {
      daemon = null
      throw e
    })
    await daemon
    return request(paths, message)
  }
  const call = (message) => (outage ? outage.guard(() => once(message)) : once(message))
  const sessions = async () => (await call({ op: 'session.list' })).sessions
  const sessionOf = async (id) => (await sessions()).find((s) => s.id === id) ?? null

  async function screen(id, lines) {
    const rows = (await call({ op: 'session.screen', id })).screen.lines.map((l) => l.trimEnd())
    while (rows.length && !rows.at(-1)) rows.pop()
    return rows.slice(-lines)
  }

  // A prompt typed into a TUI still starting is lost, as on Orca.
  async function ready(id, command) {
    const deadline = Date.now() + readyMs
    for (;;) {
      const s = await sessionOf(id)
      if (!s?.alive) throw new Error(`\`${command.join(' ')}\` in crew session ${id} ended before its first prompt${s?.exit ? ` (exit ${s.exit.code})` : ''}; its screen:\n${(await screen(id, 15).catch(() => [])).join('\n')}`)
      if (s.quietMs !== null && s.quietMs >= quietMs) return
      if (Date.now() > deadline) throw new Error(`\`${command.join(' ')}\` in crew session ${id} never went quiet within ${Math.round(readyMs / 1000)}s`)
      await sleep(pollMs)
    }
  }

  const type = (terminal, data, paste = false) => call({ op: 'session.write', id: terminal, data, paste })

  async function terminalSend({ terminal, text }) {
    await type(terminal, text, true)
    await type(terminal, '\r')
  }

  // The harness from `line` (launchCommand's or resumeCommand's) in a new
  // session, a dispatch of `run`, typed its preamble and prompt once ready;
  // a session that fails that is closed. `typing` is called as the prompt
  // starts to go in, past which a worker may have it.
  async function launch(line, { harness, dir, title, prompt, run, typing = () => {} }) {
    const [program, ...args] = line.split(' ')
    const command = [...(harnesses[harness] ?? [program]), ...args]
    const { session } = await call({ op: 'session.spawn', command, cwd: dir, env: sessionEnv, title })
    try {
      const { worker } = await call({ op: 'run.worker', run, session: session.id, coordinator })
      await ready(session.id, command)
      typing()
      await terminalSend({ terminal: session.id, text: crewPreamble({ terminal: session.id, ...worker }) + prompt })
      return { terminal: session.id, taskId: worker.taskId }
    } catch (e) {
      await call({ op: 'session.close', id: session.id }).catch(() => {})
      throw e
    }
  }

  async function idleNow(terminal) {
    const s = await sessionOf(terminal)
    if (!s) throw new Error(`no crew session ${terminal}`)
    // An ended program has no turn going.
    if (!s.alive) return true
    const { harness, sessionId } = launchedSession(s.command)
    const ended = sessionId ? transcripts.idle({ harness, sessionId, worktree: s.cwd }) : null
    return ended ?? (s.quietMs !== null && s.quietMs >= quietMs)
  }

  // The `<runId>-<n>` worktree a child start runs in: the one an earlier
  // attempt made, taken up by the rule every host shares (reuseWorktree), or
  // a new one on a branch of its name from the run's HEAD, its setup hook run
  // unless `setup` is 'skip'. A worktree whose hook failed is removed again:
  // nothing in it is anyone's work. `made` is whether this start made it.
  async function childWorktree(child) {
    const repo = await repoOf(cwd, bound)
    const path = join(crewWorktrees(repo), child.name)
    const known = (await worktreesOf(repo, bound)).find((w) => samePath(w.path, path))
    if (known && child.retry) {
      await reuseWorktree(path, { dispatched: child.dispatched, baseline: child.baseline ?? null }, {
        held: async () => (await sessions()).some((s) => s.alive && samePath(s.cwd, path)),
        lines: async () => porcelainLines(await gitIn(path, ['status', '--porcelain'], bound)),
        commits: () => worktreeOwnCommits(path, known.branch, bound),
      })
      return { path, made: false }
    }
    if (known || existsSync(path)) throw fail('worktree_name_taken', `${path} already exists: crew makes each <runId>-<n> worktree once`, { worktree: path, final: true })
    await gitIn(cwd, ['worktree', 'add', '-b', child.name, path, 'HEAD'], { ms: createMs })
    const setup = child.setup === 'skip' ? null : repoConfig(paths, repo).setup ?? null
    if (setup) {
      try {
        await runHook(setup, { repo, worktree: path, env, ms: createMs })
      } catch (e) {
        try {
          await gitIn(repo, ['worktree', 'remove', '--force', path], bound)
          await gitIn(repo, ['branch', '-D', child.name], bound)
        } catch (removing) {
          e.message += `; removing ${path} again failed too: ${removing.message}`
          e.worktree = path
        }
        throw e
      }
    }
    return { path, made: true }
  }

  return {
    id: 'crew',
    name: 'crew',
    unreachable: (e) => noDaemon(e),
    guardWith(o) {
      outage = o
    },
    probe: () => ensureDaemon(paths),

    // Crew makes the run id; the Run is bound to this adapter from then on.
    async runCreate({ objective }) {
      const { run } = await call({ op: 'run.create', objective, coordinator })
      return { runId: run.id, terminal: run.coordinator }
    },
    async runUse({ runId }) {
      const { run } = await call({ op: 'run.use', id: runId, coordinator })
      return { runId: run.id, terminal: run.coordinator }
    },

    // As the Orca host's (orca-cli.mjs): without `child` the worker runs in
    // the run's worktree; with `child: { name, retry, dispatched, baseline,
    // onBaseline, setup }` in a worktree of its own, at
    // `<repo-parent>/<repo>.crew/<name>`. Its baseline, the porcelain lines
    // it holds before its agent, is taken after the setup hook and the MCP
    // answers, and handed to onBaseline and to `prompt` when a function.
    async workerStart({ run, prompt, title, harness = 'claude', model, effort, permissionMode, sessionId, child = null }) {
      if (!sessionId) throw new Error(`workerStart: ${title} has no session id; the runner assigns one to every worker`)
      const warnings = []
      let worktree = cwd
      let baseline = child?.baseline ?? null
      let dispatched = false
      try {
        if (child) {
          const made = await childWorktree(child)
          worktree = made.path
          if (made.made) {
            try {
              const m = copyMcpAnswers({ project, worktree })
              if (m.added.length) warnings.push(`the project has no answer for MCP server(s) ${m.added.join(', ')} of .mcp.json, so its worktree disables them`)
            } catch (e) {
              warnings.push(`could not copy the project's MCP server answers into its worktree: ${e?.message ?? e}`)
            }
            baseline = porcelainLines(await gitIn(worktree, ['status', '--porcelain'], bound))
            await child.onBaseline?.({ worktree, lines: baseline })
          }
        }
        const text = typeof prompt === 'function' ? prompt(baseline) : prompt
        const w = await launch(launchCommand({ harness, model, effort, permissionMode, sessionId }), { harness, dir: worktree, title, prompt: text, run, typing: () => { dispatched = true } })
        return { dispatchId: w.terminal, taskId: w.taskId, terminal: w.terminal, worktree, warnings }
      } catch (e) {
        if (child && worktree !== cwd && e instanceof Object) e.worktree ??= worktree
        if (dispatched && e instanceof Object) e.dispatched = true
        throw e
      }
    },

    // The session carried on in a new crew session running the harness's
    // resume line, in the same worktree, as a new dispatch of the run; the
    // old session, its harness ended first if still running (two harnesses on
    // one session id would both write its transcript), is closed once the new
    // one has its prompt. A pty whose program ended cannot take another, and a
    // harness run straight in its pty has no shell to type a resume line into.
    async workerContinue({ run, dispatch, terminal = dispatch, worktree = null, title, prompt, harness = 'claude', model, effort, permissionMode, sessionId }) {
      const line = resumeCommand({ harness, model, effort, permissionMode, sessionId })
      const old = await sessionOf(terminal)
      if (old?.alive) {
        await call({ op: 'session.kill', id: old.id })
        const deadline = Date.now() + endMs
        while ((await sessionOf(old.id))?.alive) {
          if (Date.now() > deadline) throw new Error(`workerContinue: ${title}'s harness in crew session ${old.id} did not end within ${Math.round(endMs / 1000)}s`)
          await sleep(pollMs)
        }
      }
      const dir = old?.cwd ?? worktree ?? cwd
      const w = await launch(line, { harness, dir, title: old?.title ?? title, prompt, run })
      if (old) await call({ op: 'session.close', id: old.id }).catch(() => {})
      return { dispatchId: w.terminal, taskId: w.taskId, terminal: w.terminal, worktree: dir, reopened: true }
    },

    // From crew's own records: settled once its worker_done came (or it was
    // stopped), gone once its session is closed, exited once its program
    // ended. Crew cannot see a harness waiting on a human, so never waiting.
    async workerShow({ dispatch }) {
      return (await call({ op: 'worker.show', id: dispatch })).worker
    },
    // The harness ends and an unsettled dispatch is cancelled; its session and
    // last screen stay until closed.
    async workerStop({ dispatch }) {
      await call({ op: 'worker.stop', id: dispatch })
    },
    async workerRelease({ dispatch }) {
      await call({ op: 'worker.release', id: dispatch })
    },

    // Whether the worker is idle, waiting up to `timeoutMs` for it to be.
    async terminalIdle({ terminal, timeoutMs = 0 }) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (await idleNow(terminal)) return true
        if (Date.now() >= deadline) return false
        await sleep(pollMs)
      }
    },
    terminalSend,
    async terminalEnter({ terminal }) {
      await type(terminal, '\r')
    },
    // Ctrl-U once per line, as on Orca (orca-cli.mjs says why never Ctrl-C or Esc).
    async terminalClearInput({ terminal, lines = 1 }) {
      await type(terminal, '\x15'.repeat(Math.max(1, lines)))
    },
    // The last `lines` rows of the screen, its blank rows below the last drawn one left out.
    terminalScreen: ({ terminal, lines = 15 }) => screen(terminal, lines),
    promptDelivered: ({ harness, sessionId, worktree, needle }) => transcripts.delivered({ harness, sessionId, worktree, needle }) === true,

    // Every session the daemon holds, its program ended or not, until closed.
    async terminalList() {
      return (await sessions()).map((s) => s.id)
    },
    async terminalClose({ terminal }) {
      await call({ op: 'session.close', id: terminal })
    },
    async terminalRename({ terminal, title }) {
      await call({ op: 'session.rename', id: terminal, title })
    },
    // Crew has no tabs to bring forward: the session is entered from `crew console`.
    async terminalSwitch({ terminal }) {
      if (!(await sessionOf(terminal))) throw new Error(`no crew session ${terminal}`)
      return { terminal, worktreeId: null }
    },
    async logTail({ path, title }) {
      const { session } = await call({ op: 'session.spawn', command: [process.execPath, '-e', TAIL, path], cwd, env, title })
      return { terminal: session.id }
    },
    async resumeRunner({ worktree, title, runner, script, stateDir, permissionMode = null }) {
      const command = [process.execPath, runner, script, '--host', 'crew', '--state-dir', stateDir, '--resume', ...(permissionMode ? ['--permission-mode', permissionMode] : [])]
      const { session } = await call({ op: 'session.spawn', command, cwd: worktree, env: sessionEnv, title })
      return { terminal: session.id, command: command.join(' ') }
    },

    // Crew has no board: the status is kept by the daemon, for a worktree git has.
    async worktreeStatus({ worktree, status }) {
      const top = await gitIn(worktree, ['rev-parse', '--show-toplevel'], bound).catch(() => null)
      if (top === null || !samePath(top.trim(), worktree)) throw fail('selector_not_found', `no worktree ${worktree}`)
      await call({ op: 'worktree.status', path: resolve(worktree), status })
    },
    // Only a worktree crew made (by where it is), removed however dirty, and
    // every session in it closed first, as Orca's `worktree rm --force` does.
    // Its branch stays: whether it holds unpushed commits is reclaim's check.
    async worktreeRemove({ path }) {
      const repo = repoOfCrewWorktree(path)
      if (!repo) throw fail('selector_not_found', `${path} is not a worktree crew made`)
      if (!(await worktreesOf(repo, bound)).some((w) => samePath(w.path, path))) throw fail('selector_not_found', `no worktree ${path}`)
      for (const s of await sessions()) if (samePath(s.cwd, path)) await call({ op: 'session.close', id: s.id }).catch(() => {})
      if (existsSync(path)) await gitIn(repo, ['worktree', 'remove', '--force', path], bound)
      else await gitIn(repo, ['worktree', 'prune'], bound)
    },

    // A worker's own calls, from its session (submit, and `crew orchestration
    // send`): the IDs its preamble gave it.
    async workerDone({ from, capability, taskId, dispatchId, subject, body }) {
      await call({ op: 'mail.send', from, capability, taskId, dispatchId, type: 'worker_done', outcome: 'succeeded', subject, body })
    },
    async mailSend({ from, capability, taskId, dispatchId, type, subject, body, outcome = null }) {
      return { id: (await call({ op: 'mail.send', from, capability, taskId, dispatchId, type, subject, body, outcome })).id }
    },
    // The mailbox of the Run bound to this adapter, in the Orca host's shape.
    async mailCheck({ ack = null } = {}) {
      const { deliveryId, acknowledged, replayed, messages } = await call({ op: 'mail.check', coordinator, ack })
      return { deliveryId, acknowledged, replayed, messages }
    },
  }
}
