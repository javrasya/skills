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
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { crewPaths } from './daemon/transport.mjs'
import { daemonGone, ensureDaemon, request } from './daemon/client.mjs'
import { runnerCommand } from './daemon/runs.mjs'
import { crewSessionEnv, launchedSession, launchWords, resumeWords } from './harness.mjs'
import { RUNNER_SETTINGS } from './settings.mjs'
import { SCREENS, readScreen, readsReady, tellsReady } from './screens.mjs'
import { CLAUDE_HOOK_EVENTS } from './waiting.mjs'
import { sessionTranscripts } from './transcript.mjs'
import { readCrewConfig, repoConfig } from './crew-config.mjs'
import { childCommand } from './command.mjs'
import { samePath } from './paths.mjs'
import { sleep } from './util.mjs'
import { chainName, gitIn, repoOf } from './git.mjs'
import { gitProbes, prepareChainWorktree, prepareWorktree, reuseWorktree, worktreeLines } from './worktree.mjs'

export const CREW_BIN = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url))

// What crew adds to the harness line of a session it starts, and to no other
// (ADR-0022): a way for the harness to tell the daemon, from its own events,
// when it waits on the person (waiting.mjs). pi loads crew's extension; Claude
// takes crew's hooks as settings of that session alone, beside the person's
// own. Neither changes what the harness does or shows.
export const PI_EXTENSION = fileURLToPath(new URL('./hooks/crew-pi.mjs', import.meta.url))
export const CLAUDE_HOOK = fileURLToPath(new URL('./hooks/claude-hook.mjs', import.meta.url))
export const claudeSettings = (node = process.execPath) =>
  JSON.stringify({
    hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command: `"${node}" "${CLAUDE_HOOK}"`, timeout: 10 }] }]])),
  })
export const waitWords = (harness) => (harness === 'pi' ? ['-e', PI_EXTENSION] : harness === 'claude' ? ['--settings', claudeSettings()] : [])

// The rows of a session's screen read for what it shows.
const SCREEN_ROWS = 500
// The dialog name of a screen still not ready when readyMs runs out.
export const UNRECOGNISED = 'unrecognised screen'

const fail = (code, message, extra = {}) => Object.assign(new Error(`crew: ${code}: ${message}`), { code, ...extra })

// What a worker reads before its prompt. The runner's prompts send it to "your
// session host's preamble" for its IDs and "orchestration send" for its mail,
// so crew's is titled as that preamble and names the command in full.
export function crewPreamble({ terminal, taskId, capability }) {
  const ids = `--from ${terminal} --dispatch-capability ${capability} --task-id ${taskId} --dispatch-id ${terminal}`
  return `=== Your session host's preamble, from crew ===
Crew is this run's session host. Your IDs: ${ids}
Every \`orchestration send\` your instructions name is this command, with those IDs:
  node "${CREW_BIN}" orchestration send ${ids} --type <worker_done|handoff|escalation> --subject "<subject>" --body "<body>" [--outcome succeeded|failed]
=== TASK ===
`
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

// A setup hook by its kind: a node script, PowerShell or sh, and anything
// else (a .cmd or .bat through ComSpec, on Windows) run as it is.
function hookCommand(script) {
  const ext = extname(script).toLowerCase()
  if (['.mjs', '.cjs', '.js'].includes(ext)) return [process.execPath, [script]]
  if (ext === '.ps1') return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]]
  if (ext === '.sh') return ['sh', [script]]
  return childCommand(script, [])
}

/** @returns {Promise<void>} */
function runHook(script, { repo, worktree, env, ms }) {
  const [program, args] = hookCommand(script)
  return new Promise((done, reject) => {
    execFile(program, args, { cwd: worktree, env: { ...env, CREW_REPO: repo, CREW_WORKTREE: worktree }, timeout: ms, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err
        ? reject(
            fail(
              'setup_failed',
              `the setup hook ${script} failed in ${worktree}${err.killed ? ` (killed after ${Math.round(ms / 1000)}s)` : ''}: ${String(stderr || err.message)
                .trim()
                .split('\n')
                .slice(-8)
                .join('\n')}`,
            ),
          )
        : done(),
    )
  })
}

// A log's lines, then every line added to it, drawn in a session of its own.
const TAIL =
  "const fs=require('fs');const p=process.argv[1];let at=0;const show=()=>{let s;try{s=fs.statSync(p)}catch{return}if(s.size<at)at=0;if(s.size===at)return;const b=Buffer.alloc(s.size-at);const fd=fs.openSync(p,'r');fs.readSync(fd,b,0,b.length,at);fs.closeSync(fd);at=s.size;process.stdout.write(b.toString('utf8').replace(/\\r?\\n/g,'\\r\\n'))};show();setInterval(show,500)"

// `cwd` is the run's worktree, where a worker without a child worktree runs,
// and the checkout whose MCP answers a child worktree gets (`project`);
// `env` the environment its harness gets. `harnesses` maps a harness to the
// program words its launch line starts with in place of the harness's own
// name, as the contract suite puts its fake harness there, crew's config's
// `harnesses` by default; the rest of the line is the runner's launch
// command, word for word. A harness is ready for its prompt once its screen
// is its input prompt (`screens`, screens.mjs), steady for `settleMs`, or,
// for one whose ready screen crew cannot tell, once it has drawn and then
// been quiet for `quietMs`; a screen still not ready at `readyMs` fails the
// start, or, for a worker, needs the person (ready below). A worker is idle once its session
// transcript says its latest turn ended, or, where the transcript does not
// say, once its terminal has been quiet for `quietMs`. Git calls are bounded
// at `callMs`, and a worktree's making, its setup hook included, at `createMs`.
// `start` answers with the daemon, starting it when none does.
export function crewHost({
  paths = crewPaths(),
  env = process.env,
  cwd = process.cwd(),
  project = cwd,
  harnesses = readCrewConfig(paths).harnesses ?? {},
  transcripts = sessionTranscripts({ env }),
  quietMs = RUNNER_SETTINGS.quietOutputMs,
  readyMs = 180_000,
  settleMs = 1_000,
  screens = SCREENS,
  endMs = 10_000,
  pollMs = 100,
  callMs = RUNNER_SETTINGS.hostCallMs,
  createMs = RUNNER_SETTINGS.worktreeCreateMs,
  start = ensureDaemon,
} = {}) {
  // This adapter's side of the Runs it creates or takes over, as a runner's
  // terminal is on Orca: the daemon fences every other coordinator out.
  const coordinator = `coord_${randomBytes(6).toString('hex')}`
  // The crew session this adapter's runner runs in, if any: the daemon starts
  // it again, resuming its Run, should the daemon die under it.
  const runner = env.CREW_SESSION ?? null
  const sessionEnv = crewSessionEnv(env, { home: paths.home })
  const bound = { ms: callMs }
  let daemon = null
  let outage = null
  async function once(message) {
    daemon ??= start(paths).catch((e) => {
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

  // A prompt typed into a TUI still starting is lost, as on Orca, and one
  // typed into a dialog answers it: a prompt goes in only once the screen is
  // the harness's input prompt (screens.mjs), or the harness has said it is
  // ready (its session's `ready`, told by hooks/), either steady for
  // `settleMs`, since a startup dialog may follow either by a moment; or, for
  // a harness that neither shows nor says, once its terminal is quiet.
  // A dialog on the screen is the person's to answer: `asking({ terminal,
  // dialog, ask, detail })` is called when one shows, `asking(null)` once it
  // is gone, and nothing is typed meanwhile, however long it waits. A screen
  // still not ready at `readyMs` is asked about the same way, as an
  // unrecognised screen. With no `asking`, nobody can answer: a dialog, or a
  // screen not ready at `readyMs`, fails the start.
  async function ready(id, command, { harness, asking = null }) {
    const deadline = Date.now() + readyMs
    // How this harness is known to be ready, and what a start that ran out says.
    const way = readsReady(harness, screens)
      ? { isReady: (seen) => seen?.state === 'ready', settle: settleMs, ranOut: 'never showed its input prompt' }
      : tellsReady(harness, screens)
        ? { isReady: (seen, s) => s.ready === true, settle: settleMs, ranOut: 'never said it was ready' }
        : { isReady: (seen, s) => s.quietMs !== null && s.quietMs >= quietMs, settle: 0, ranOut: 'never went quiet' }
    let shown = null
    let steadySince = null
    const show = async (seen) => {
      if ((seen?.dialog ?? null) === (shown?.dialog ?? null)) return
      shown = seen
      await asking(seen && { terminal: id, dialog: seen.dialog, ask: seen.ask, detail: seen.detail ?? null })
    }
    for (;;) {
      const s = await sessionOf(id)
      if (!s?.alive)
        throw new Error(
          `\`${command.join(' ')}\` in crew session ${id} ended before its first prompt${s?.exit ? ` (exit ${s.exit.code})` : ''}${shown ? `, while ${shown.dialog === UNRECOGNISED ? 'its screen was not one crew recognises' : `it asked: ${shown.dialog}`}` : ''}; its screen:\n${(await screen(id, 15).catch(() => [])).join('\n')}`,
        )
      // A harness that told the daemon it waits on the person (pi's dialogs,
      // its extension's events) shows a dialog, whatever its screen.
      const seen = s.waiting ? { state: 'dialog', dialog: 'a dialog', ask: `${s.waiting}: enter the session and answer it`, detail: null } : readScreen(harness, await screen(id, SCREEN_ROWS), screens)
      if (seen?.state === 'dialog') {
        steadySince = null
        if (!asking) throw Object.assign(new Error(`\`${command.join(' ')}\` in crew session ${id} stopped at a dialog before its first prompt (${seen.dialog}): ${seen.ask.replace(/: enter the session.*$/, '')}; answer it in a \`${harness}\` session of your own in ${s.cwd}, then try again`), { dialog: seen.dialog })
        await show(seen)
      } else {
        const now = Date.now()
        const isReady = way.isReady(seen, s)
        if (isReady) {
          steadySince ??= now
          if (now - steadySince >= way.settle) {
            if (shown) await show(null)
            return
          }
        } else steadySince = null
        if (now > deadline) {
          if (!asking) throw new Error(`\`${command.join(' ')}\` in crew session ${id} ${way.ranOut} within ${Math.round(readyMs / 1000)}s; its screen:\n${(await screen(id, 15).catch(() => [])).join('\n')}`)
          if (!isReady) await show({ dialog: UNRECOGNISED, ask: `crew does not recognise ${harness}'s screen after ${Math.round(readyMs / 1000)}s: enter the session and get it to its input prompt`, detail: null })
        } else if (shown && !isReady) await show(null)
      }
      await sleep(pollMs)
    }
  }

  // Anything typed into a parked session (ADR-0024, ADR-0025) revives it
  // first, in place, and waits for its harness's prompt, as a launch does:
  // the daemon refuses the write rather than lose it to a harness starting.
  const PARKED = /is parked: /
  async function type(terminal, data, paste = false) {
    try {
      return await call({ op: 'session.write', id: terminal, data, paste })
    } catch (e) {
      if (!PARKED.test(e?.message ?? '')) throw e
    }
    const { session } = await call({ op: 'session.revive', id: terminal })
    await ready(session.id, session.command, { harness: launchedSession(session.command).harness })
    return call({ op: 'session.write', id: terminal, data, paste })
  }

  async function terminalSend({ terminal, text }) {
    await type(terminal, text, true)
    await type(terminal, '\r')
  }

  // The harness from `line` (launchWords' or resumeWords' argv, spawned with
  // no shell, so a model such as `opus[1m]` goes in as it is) in a new
  // session, a dispatch of `run`, typed its preamble and prompt once ready;
  // a session that fails that is closed. `typing` is called as the prompt
  // starts to go in, past which a worker may have it. With no `run` it is no
  // worker: no dispatch, no preamble, only the prompt.
  // `asking` is ready's: who hears of a dialog the person must answer first.
  // `agent` is what its dispatch knows of its agent, for a submit by session
  // (runs.mjs): { role, schema, resultPath }.
  async function launch(line, { harness, dir, title, prompt, run, typing = () => {}, asking = null, agent = {} }) {
    const [program, ...args] = line
    const command = [...(harnesses[harness] ?? [program]), ...args, ...waitWords(harness)]
    const { session } = await call({ op: 'session.spawn', command, cwd: dir, env: sessionEnv, title })
    try {
      const { worker } = run ? await call({ op: 'run.worker', run, session: session.id, coordinator, ...agent }) : { worker: null }
      await ready(session.id, command, { harness, asking })
      typing()
      await terminalSend({ terminal: session.id, text: (worker ? crewPreamble({ terminal: session.id, ...worker }) : '') + prompt })
      return { terminal: session.id, taskId: worker?.taskId ?? null }
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

  // A new worktree `name` at `path` from the run's HEAD, on a branch of its
  // name, or detached when that branch is `existing` (a chain remade after a
  // reclaim, which leaves its branch where it stands), its setup hook run
  // unless `skip`. One whose hook failed is removed again: nothing in it is
  // anyone's work, and a branch it did not make is left where it was.
  async function addWorktree(repo, name, path, skip, existing = false) {
    await gitIn(cwd, ['worktree', 'add', ...(existing ? ['--detach', path, 'HEAD'] : ['-b', name, path, 'HEAD'])], { ms: createMs })
    const setup = skip ? null : (repoConfig(paths, repo).setup ?? null)
    if (!setup) return
    try {
      await runHook(setup, { repo, worktree: path, env, ms: createMs })
    } catch (e) {
      try {
        await gitIn(repo, ['worktree', 'remove', '--force', path], bound)
        if (!existing) await gitIn(repo, ['branch', '-D', name], bound)
      } catch (removing) {
        e.message += `; removing ${path} again failed too: ${removing.message}`
        e.worktree = path
      }
      throw e
    }
  }

  // The `<runId>-<n>` worktree a child start runs in: the one an earlier
  // attempt made, taken up by the rule every host shares (reuseWorktree), or
  // a new one (addWorktree), its setup hook run unless `setup` is 'skip'.
  // `made` is whether this start made it.
  async function childWorktree(child) {
    const repo = await repoOf(cwd, bound)
    const path = join(crewWorktrees(repo), child.name)
    const known = (await worktreesOf(repo, bound)).find((w) => samePath(w.path, path))
    if (known && child.retry) {
      await reuseWorktree(
        path,
        { dispatched: child.dispatched, baseline: child.baseline ?? null },
        {
          held: async () => (await sessions()).some((s) => s.alive && samePath(s.cwd, path)),
          ...gitProbes(path, known.branch, bound),
        },
      )
      return { path, made: false }
    }
    if (known || existsSync(path)) throw fail('worktree_name_taken', `${path} already exists: crew makes each <runId>-<n> worktree once`, { worktree: path, final: true })
    await addWorktree(repo, child.name, path, child.setup === 'skip')
    return { path, made: true }
  }

  return {
    id: 'crew',
    name: 'crew',
    // A worker's session is entered in place, from `crew view` (or `crew
    // console`, for debugging), never brought to the front: there are no tabs.
    inPlace: true,
    // Crew not there at all is an outage (ADR-0015, ADR-0017), as Orca's is.
    unreachable: (e) => daemonGone(e),
    guardWith(o) {
      outage = o
    },
    probe: () => start(paths),

    // Crew makes the run id; the Run is bound to this adapter from then on.
    async runCreate({ objective }) {
      const { run } = await call({ op: 'run.create', objective, coordinator, runner })
      return { runId: run.id, terminal: run.coordinator }
    },
    async runUse({ runId }) {
      const { run } = await call({ op: 'run.use', id: runId, coordinator, runner })
      return { runId: run.id, terminal: run.coordinator }
    },

    // As the Orca host's (orca-cli.mjs): without `child` the worker runs in
    // the run's worktree; with `child: { name, retry, dispatched, baseline,
    // onBaseline, setup }` in a worktree of its own, at
    // `<repo-parent>/<repo>.crew/<name>`. Its baseline, the porcelain lines
    // it holds before its agent, is taken after the setup hook and the MCP
    // answers, and handed to onBaseline and to `prompt` when a function.
    // `asking` hears of a dialog its harness shows before the prompt goes in
    // (ready above), as workerContinue's does; the start waits it out.
    // With `chain`, chainWorktree's path, the worker runs in the run's chain
    // worktree, which is never this start's to make or name on its error.
    // `role`, `schema` and `resultPath` go on its dispatch, as a continue's do.
    async workerStart({ run, prompt, title, harness = 'claude', model, effort, permissionMode, sessionId, child = null, chain = null, asking = null, role, schema, resultPath }) {
      if (!sessionId) throw new Error(`workerStart: ${title} has no session id; the runner assigns one to every worker`)
      const warnings = []
      let worktree = chain ?? cwd
      let baseline = child?.baseline ?? null
      let dispatched = false
      try {
        if (child) {
          const made = await childWorktree(child)
          worktree = made.path
          if (made.made) baseline = await prepareWorktree({ project, worktree, bound, onBaseline: child.onBaseline, warnings })
        }
        const text = typeof prompt === 'function' ? prompt(baseline) : prompt
        const w = await launch(launchWords({ harness, model, effort, permissionMode, sessionId }), {
          harness,
          dir: worktree,
          title,
          prompt: text,
          run,
          asking,
          agent: { role, schema, resultPath },
          typing: () => {
            dispatched = true
          },
        })
        return { dispatchId: w.terminal, taskId: w.taskId, terminal: w.terminal, worktree, warnings }
      } catch (e) {
        if (child && worktree !== cwd && e instanceof Object) e.worktree ??= worktree
        if (dispatched && e instanceof Object) e.dispatched = true
        throw e
      }
    },

    // A harness session of no Run, for a person to talk to: in `dir` (the
    // host's own directory by default), prompted once ready, and entered from
    // the run console. Nothing settles it, and closing it is its opener's.
    // Crew's own, beyond the session host interface (session-host.mjs CREW_ONLY).
    async sessionStart({ title, prompt, harness = 'claude', model, effort, permissionMode, sessionId, dir = cwd }) {
      const { terminal } = await launch(launchWords({ harness, model, effort, permissionMode, sessionId }), { harness, dir, title, prompt, run: null })
      return { terminal }
    },

    // The session carried on in a new crew session running the harness's
    // resume line, in the same worktree, as a new dispatch of the run; the
    // old session, its harness ended first if still running (two harnesses on
    // one session id would both write its transcript), is closed once the new
    // one has its prompt. A pty whose program ended cannot take another, and a
    // harness run straight in its pty has no shell to type a resume line into.
    async workerContinue({ run, dispatch, terminal = dispatch, worktree = null, title, prompt, harness = 'claude', model, effort, permissionMode, sessionId, asking = null, role, schema, resultPath }) {
      const line = resumeWords({ harness, model, effort, permissionMode, sessionId })
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
      const w = await launch(line, { harness, dir, title: old?.title ?? title, prompt, run, asking, agent: { role, schema, resultPath } })
      if (old) await call({ op: 'session.close', id: old.id }).catch(() => {})
      return { dispatchId: w.terminal, taskId: w.taskId, terminal: w.terminal, worktree: dir, reopened: true }
    },

    // From crew's own records: settled once its worker_done came (or it was
    // stopped), gone once its session is closed, exited once its program
    // ended, and waiting on what its harness's own events say it waits on the
    // person for (waitWords).
    async workerShow({ dispatch }) {
      return (await call({ op: 'worker.show', id: dispatch })).worker
    },
    // The harness ends and an unsettled dispatch is cancelled; its session and
    // last screen stay until closed.
    async workerStop({ dispatch }) {
      await call({ op: 'worker.stop', id: dispatch })
    },
    // Crew's own (session-host.mjs CREW_ONLY): the last result its worker
    // submitted, with the count of every worker_done it sent, so a runner
    // holding its node can tell a submit again from the one it took.
    async workerResult({ dispatch }) {
      const { result, outcome, submissions } = await call({ op: 'worker.result', id: dispatch })
      return { result, outcome, submissions }
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
    // The sessions the daemon has parked: a done agent's harness ended while
    // idle, started again on its resume line when entered (ADR-0024).
    // Crew's own, beyond the session host interface (session-host.mjs CREW_ONLY).
    async terminalsParked() {
      return (await sessions()).filter((s) => s.parked).map((s) => s.id)
    },
    // Every session the daemon holds, as the run tree reads a `?` session's
    // state (#168): alive, parked, what its harness waits on the person for,
    // and how its program ended. Crew's own, beyond the interface.
    async terminalsInfo() {
      return (await sessions()).map((s) => ({ terminal: s.id, alive: !!s.alive, parked: !!s.parked, waiting: s.waiting ?? null, exit: s.exit ?? null }))
    },
    // A done agent's session parked now (the run tree's Ctrl+P); the daemon
    // refuses any other, naming why. Crew's own, beyond the interface.
    async terminalPark({ terminal }) {
      await call({ op: 'session.park', id: terminal })
    },
    async terminalClose({ terminal }) {
      await call({ op: 'session.close', id: terminal })
    },
    async terminalRename({ terminal, title }) {
      await call({ op: 'session.rename', id: terminal, title })
    },
    // Crew has no tabs to bring forward: the session is entered from `crew view`.
    async terminalSwitch({ terminal }) {
      if (!(await sessionOf(terminal))) throw new Error(`no crew session ${terminal}`)
      return { terminal, worktreeId: null }
    },
    async logTail({ path, title }) {
      const { session } = await call({ op: 'session.spawn', command: [process.execPath, '-e', TAIL, path], cwd, env, title })
      return { terminal: session.id }
    },
    async resumeRunner({ worktree, title, runner, script, stateDir, permissionMode = null }) {
      const command = runnerCommand({ runner, script, stateDir, permissionMode })
      // Refused run_live while the run has a runner, crew's own resuming it included.
      const { session } = await call({ op: 'session.spawn', command, cwd: worktree, env: sessionEnv, title, runDir: stateDir })
      return { terminal: session.id, command: command.join(' ') }
    },

    // chainName(runId) beside the run's `<runId>-<n>` worktrees, made as they
    // are; asked again, the one git holds is the run's as it is, whoever
    // worked in it last, so it is never refused as a child's would be. One
    // reclaimed meanwhile is made again, setup hook and all, from the run's
    // HEAD as the first was (session-host.mjs), detached: the branch the
    // first made, which reclaim leaves, keeps whatever it holds.
    async chainWorktree({ runId }) {
      const repo = await repoOf(cwd, bound)
      const name = chainName(runId)
      const path = join(crewWorktrees(repo), name)
      const held = (await worktreesOf(repo, bound)).some((w) => samePath(w.path, path))
      if (held && existsSync(path)) return { path, made: false, baseline: null, warnings: [] }
      // A folder deleted by hand stays listed, and blocks its path, until pruned.
      if (held) await gitIn(repo, ['worktree', 'prune'], bound)
      else if (existsSync(path)) throw fail('worktree_name_taken', `${path} already exists and is no worktree git holds`, { worktree: path, final: true })
      const branched = !!(await gitIn(repo, ['branch', '--list', name], bound)).trim()
      await addWorktree(repo, name, path, false, branched)
      const warnings = []
      const baseline = await prepareChainWorktree({ project, worktree: path, bound, warnings })
      return { path, made: true, baseline, warnings }
    },

    worktreeLines: ({ worktree }) => worktreeLines(worktree, bound),

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
    async workerDone({ from, capability, taskId, dispatchId, subject, body, result = null }) {
      await call({ op: 'mail.send', from, capability, taskId, dispatchId, type: 'worker_done', outcome: 'succeeded', subject, body, result })
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
