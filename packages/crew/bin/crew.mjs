#!/usr/bin/env node
// crew: the session runner's command line.
//
//   crew run [--host crew|orca] <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
//                     on the crew host, its default, the runner is a crew
//                     session of the daemon's, entered from the run console
//                     (`crew view <run dir>`, the dir it prints);
//                     on orca it is this process, in the operator's Orca tab
//   crew start <spec#> [--harness h] [--model m] [--base b] [--start-ref r] [--stack-mode s] [--run-order o] [--permission-mode p]
//                     arms a run of the implement-spec workflow from a form,
//                     each row a flag (every one of them with no terminal),
//                     and launches it as `crew run` does; a spec with no
//                     validation.md gets the orchestrator's draft as the
//                     form's last step, and is an error with no terminal.
//                     At a terminal it then opens the run's view, as
//                     `crew view <run dir>` does; with none it prints that
//   crew ls [--registry <file>]
//                     every run in the run registry, crew's and Orca's, by project
//   crew pause <run> | resume <run> | rm <run> [--yes]
//                     p, r and x of the run view: pause holds every new agent
//                     while those at work finish, and outlives the runner;
//                     resume lifts it; rm stops the run, reclaims it (asking
//                     f for each worktree with unpushed commits), forgets it
//                     and deletes its folder. A run is named by its run id,
//                     its run folder or its state dir
//   crew [view [<run>] [--registry <file>]]
//                     the run console: the run's tree (by run id or run dir),
//                     or with no run the runs list (bare `crew` at a terminal);
//                     Enter, Right or a click goes in (list to tree, tree to
//                     an agent's session), Ctrl+Shift+Left comes out of a session
//                     and Left from the tree to the list; Enter on a crew run's agent enters that
//                     session, and the back key comes back to the tree; an Orca
//                     run's agent is brought to the front in Orca
//   crew view --attached <run-dir> | --standalone [--registry <file>]
//   crew daemon start | status | stop [--force] | restart [--force]
//                     stop and restart refuse while a run is live, naming
//                     it, unless --force; a daemon started after one that
//                     died (a crash, a kill, --force) resumes the runs live then
//   crew session spawn [--cwd <dir>] -- <command…> | list | screen <id> | kill <id>
//   crew console      debug only: the daemon's raw sessions, whatever run they
//                     are of, in a flat list; Enter enters one, the back key
//                     (Ctrl+Shift+Left, or backKey in ~/.crew/config.json) comes back. An
//                     operator enters a run's agents and runner from `crew view`
//   crew orchestration send --from <h> --dispatch-capability <c> --task-id <t>
//        --dispatch-id <d> --type <worker_done|handoff|escalation> --subject <s>
//        --body <b> [--outcome succeeded|failed]
//                     a worker's message to its crew Run's mailbox, as its
//                     preamble (crew-host.mjs) names it; no Orca involved
//
// Every command but `daemon stop` and `ls` starts the per-machine crew daemon when none
// answers (src/daemon/); `ls` reads only the run registry, so it never does
// (ADR-0017 records the deviation). view, and run on orca, carry on without it if it
// cannot start: nothing they do needs it yet.
//
// Each entry keeps its own argv parsing and its own "am I main" check, so this
// hands it the argv it would have had launched directly, then loads it in this
// process: a child process would split the terminal and its signals between two.
import { existsSync, realpathSync } from 'fs'
import { basename, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { HOST_NAMES as HOSTS } from '../src/hosts.mjs'
import { crewPaths } from '../src/daemon/transport.mjs'
import { ensureDaemon, request, stopDaemon } from '../src/daemon/client.mjs'
import { readCrewConfig } from '../src/crew-config.mjs'
import { describeSession, runConsole, runsConsole } from '../src/console.mjs'
import { parseFlags } from '../src/args.mjs'
import { samePath } from '../src/paths.mjs'
import { crewHost } from '../src/crew-host.mjs'
import { launchRunner, runOrchestrator, startCommand } from '../src/arm.mjs'
import { REGISTRY_PATH } from '../src/registry.mjs'
import { runsView } from '../src/run-view-model.mjs'
import { pauseCommand, removeCommand, resumeCommand } from '../src/run-commands.mjs'
import { listRuns } from '../src/run-view/draw.mjs'
import { DEFAULT_HOST, LEGACY_HOST, openHosts } from '../src/hosts.mjs'
import { RUNNER_SETTINGS } from '../src/settings.mjs'
import { sleep } from '../src/util.mjs'

const USAGE = [
  'usage: crew run [--host <host>] <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]',
  '       crew start <spec#> [--harness claude|pi] [--model <m>] [--base <branch>] [--start-ref <branch>] [--stack-mode native|install|chain] [--run-order parallel|sequential] [--permission-mode <mode>]',
  '       crew ls [--registry <run registry, for a fixture>]',
  '       crew pause <run> | resume <run> | rm <run> [--yes]  (a run by its run id, run folder or state dir)',
  '       crew [view [<run id or run dir>] [--registry <run registry, for a fixture>]]  (no run: the runs list)',
  '       crew view --attached <run-dir> | --standalone [--registry <run registry, for a fixture>]',
  '       crew daemon start | status | stop [--force] | restart [--force]',
  '       crew orchestration send --from <h> --dispatch-capability <c> --task-id <t> --dispatch-id <d> --type <worker_done|handoff|escalation> --subject <s> --body <b> [--outcome succeeded|failed]',
  'debug: crew session spawn [--cwd <dir>] -- <command…> | list | screen <id> | kill <id>',
  '       crew console (the daemon\'s raw sessions; a run\'s are entered from crew view)',
  `hosts: ${HOSTS.join(', ')}`,
].join('\n')

const entry = (rel) => realpathSync(fileURLToPath(new URL(rel, import.meta.url)))

async function launch(path, args) {
  process.argv = [process.argv[0], path, ...args]
  await import(pathToFileURL(path).href)
}

const usage = (message) => {
  console.error(message ? `${message}\n${USAGE}` : USAGE)
  process.exit(2)
}
const fail = (e) => {
  console.error(`crew: ${e.message}`)
  process.exit(1)
}

const paths = crewPaths()

async function daemonAnyway() {
  try {
    await ensureDaemon(paths)
  } catch (e) {
    console.error(`crew: ${e.message}\ncrew: carrying on without the daemon`)
  }
}

const said = (hello) => `crew daemon: pid ${hello.pid} on ${hello.endpoint}`

// argv's flags (args.mjs), or the usage error `prefix: <what is wrong>`.
const flagsOf = (argv, prefix, spec) => {
  try {
    return parseFlags(argv, spec)
  } catch (e) {
    return usage(`${prefix}: ${e.message}`)
  }
}

async function daemon(args) {
  let parsed = null
  try {
    parsed = parseFlags(args, { booleans: ['--force'] })
  } catch {}
  const [verb, ...extra] = parsed?.positionals ?? []
  const force = !!parsed?.values['--force']
  if (!parsed || extra.length || !['start', 'status', 'stop', 'restart'].includes(verb) || (force && !['stop', 'restart'].includes(verb))) {
    usage(`crew daemon: ${args.length ? `unexpected ${args.join(' ')}` : 'start, status, stop or restart'}`)
  }
  if (verb === 'stop' || verb === 'restart') {
    const stopped = await stopDaemon(paths, { force })
    console.log(stopped.stopped ? `crew daemon: pid ${stopped.pid} stopped` : 'crew daemon: not running')
    if (verb === 'stop') return
  }
  const hello = await ensureDaemon(paths)
  console.log(`${said(hello)}${hello.started ? ' (started)' : ''}`)
}

async function session([verb, ...args]) {
  if (verb === 'spawn') {
    const dash = args.indexOf('--')
    const command = dash >= 0 ? args.slice(dash + 1) : []
    let options = null
    try {
      options = parseFlags(dash >= 0 ? args.slice(0, dash) : args, { strings: ['--cwd'] })
    } catch {}
    const cwd = options?.values['--cwd'] ?? process.cwd()
    if (!command.length || !options || options.positionals.length) usage('crew session spawn: -- <command…> is required')
    await ensureDaemon(paths)
    const { session: s } = await request(paths, {
      op: 'session.spawn',
      command,
      cwd: resolve(cwd),
      env: process.env,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 30,
    })
    console.log(s.id)
    return
  }
  if (verb === 'list' && !args.length) {
    await ensureDaemon(paths)
    for (const s of (await request(paths, { op: 'session.list' })).sessions) console.log(describeSession(s))
    return
  }
  if ((verb === 'screen' || verb === 'kill') && args.length === 1) {
    await ensureDaemon(paths)
    if (verb === 'kill') {
      console.log(describeSession((await request(paths, { op: 'session.kill', id: args[0] })).session))
      return
    }
    const { screen } = await request(paths, { op: 'session.screen', id: args[0] })
    const lines = [...screen.lines]
    while (lines.length && !lines.at(-1)) lines.pop()
    console.log(lines.join('\n'))
    return
  }
  usage(`crew session: ${verb ? `unexpected ${[verb, ...args].join(' ')}` : 'spawn, list, screen or kill'}`)
}

async function consoleCommand(args) {
  if (args.length) usage(`crew console: unexpected ${args.join(' ')}`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('crew console: needs a terminal')
    process.exit(3)
  }
  const { backKey } = readCrewConfig(paths)
  await ensureDaemon(paths)
  await runConsole({ paths, stdin: process.stdin, stdout: process.stdout, backKey }).done
  process.exit(0)
}

// The run registry a command reads: --registry's, for a fixture, else the machine's.
function registryOf(args, command) {
  let parsed
  try {
    parsed = parseFlags(args, { strings: ['--registry'] })
  } catch (e) {
    usage(`${command}: ${e.kind === 'value' ? '--registry needs a file' : e.message}`)
  }
  const file = parsed.values['--registry']
  return { registry: file ? resolve(file) : REGISTRY_PATH, rest: parsed.positionals }
}

// Only the registry is read: a run's liveness is its runner.pid's to say.
async function ls(args) {
  const { registry, rest } = registryOf(args, 'crew ls')
  if (rest.length) usage(`crew ls: unexpected ${rest.join(' ')}`)
  const runs = runsView({ host: null, registry, transcripts: { usage: () => null } })
  await runs.refresh()
  if (runs.model.message) throw new Error(runs.model.message)
  console.log(listRuns(runs.model).join('\n'))
}

// crew pause | resume | rm <run>: the run view's p, r and x.
async function runCommand(verb, args) {
  const { values, positionals } = parseFlags(args, { strings: ['--registry'], booleans: verb === 'rm' ? ['--yes'] : [] })
  if (positionals.length !== 1) usage(`crew ${verb}: one run, by its run id, run folder or state dir`)
  const registry = values['--registry'] ? resolve(values['--registry']) : REGISTRY_PATH
  const [target] = positionals
  if (verb === 'pause') return console.log(pauseCommand({ registry, target }))
  if (verb === 'resume') return console.log(resumeCommand({ registry, target }))
  // The host is opened only for a run removeCommand found: an unknown run opens none.
  const openHost = async (run) => {
    const hosts = await openHosts({ paths, callMs: RUNNER_SETTINGS.viewCallMs })
    return hosts[run.host] ?? hosts[LEGACY_HOST]
  }
  const { createInterface } = await import('readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(await removeCommand({ registry, target, openHost, yes: !!values['--yes'], ask: (q) => rl.question(q), out: (s) => console.error(s) }))
  } finally {
    rl.close()
  }
}

// waitMs: how long to wait for a run just launched to be in the registry,
// which its runner records once it has started; 0 for a run already there.
// With no run named, the console opens on the runs list rather than a tree.
async function view(args, { waitMs = 0 } = {}) {
  // Before any of its own checks, as `crew run` does: a view that bails still leaves the daemon up.
  await daemonAnyway()
  if (['--attached', '--standalone'].includes(args[0])) {
    return launch(entry('../src/run-view/view.mjs'), args)
  }
  const { registry, rest } = registryOf(args, 'crew view')
  if (rest.length > 1) usage(`crew view: unexpected ${rest.slice(1).join(' ')}`)
  const [target = null] = rest
  // Each run's tree, reclaim and resume go to the host the registry names for it.
  const callMs = RUNNER_SETTINGS.viewCallMs
  const hosts = await openHosts({ paths, callMs })
  const orchestrator = runOrchestrator({ paths })
  const runs = runsView({ host: hosts[LEGACY_HOST], hostOf: (name) => hosts[name] ?? hosts[LEGACY_HOST], registry, enter: true, orchestrator })
  const find = async () => {
    await runs.refresh()
    return runs.model.projects.flatMap((p) => p.runs).find((r) => r.runId === target || samePath(r.runDir, target))
  }
  const deadline = Date.now() + waitMs
  let run = target && await find()
  while (target && !run && Date.now() < deadline) {
    await sleep(250)
    run = await find()
  }
  if (target && !run) throw new Error(`no run ${target} in the run registry ${registry}`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('crew view: needs a terminal')
    process.exit(3)
  }
  const { backKey } = readCrewConfig(paths)
  if (run) await runs.open(run.runId)
  else await runs.refresh()
  await runsConsole({ paths, stdin: process.stdin, stdout: process.stdout, runs, backKey }).done
  // A halt triage still asked is given up, its session closed, before the
  // exit: none outlives the view to hold `crew daemon stop` up.
  await orchestrator.close()
  process.exit(0)
}

const SEND_FLAGS = { '--from': 'from', '--dispatch-capability': 'capability', '--task-id': 'taskId', '--dispatch-id': 'dispatchId', '--type': 'type', '--subject': 'subject', '--body': 'body', '--outcome': 'outcome' }

async function orchestration([verb, ...args]) {
  if (verb !== 'send') usage(`crew orchestration: ${verb ? `unexpected ${verb}` : 'send'}`)
  // A body or subject may start with --: every flag here takes a value.
  const { values, positionals } = flagsOf(args, 'crew orchestration send', { strings: Object.keys(SEND_FLAGS), dashValues: true })
  if (positionals.length) usage(`crew orchestration send: unexpected ${positionals[0]}`)
  const m = Object.fromEntries(Object.entries(values).map(([flag, v]) => [SEND_FLAGS[flag], v]))
  const missing = ['taskId', 'dispatchId', 'type'].filter((k) => !m[k])
  if (missing.length) usage(`crew orchestration send: missing ${missing.map((k) => Object.keys(SEND_FLAGS).find((f) => SEND_FLAGS[f] === k)).join(', ')}`)
  const { id } = await crewHost({ paths }).mailSend(m)
  console.log(`crew orchestration send: ${m.type} ${id} sent to the run's mailbox`)
}

// The runner as a session of the daemon's, on the crew host: it outlives this
// command, as a runner outlives its Orca tab, and `crew view <run dir>` enters it.
// Its own argv errors would land on a screen nobody has entered yet, so its
// argv is checked here first. The daemon refuses a second runner on a run dir
// that has one (run_live), --resume or not.
const RUN_FLAGS = { strings: ['--host', '--state-dir', '--permission-mode'], booleans: ['--resume'] }
async function crewRun(args) {
  const { values, positionals: scripts } = flagsOf(args, 'crew run', RUN_FLAGS)
  if (scripts.length !== 1) usage(`crew run: ${scripts.length ? `one script, not ${scripts.join(', ')}` : 'the rendered script is required'}`)
  const [stateDir, permissionMode] = ['--state-dir', '--permission-mode'].map((f) => values[f] ?? null)
  if (!existsSync(scripts[0])) throw new Error(`no script ${resolve(scripts[0])}`)
  const s = await launchRunner({ ...terminalSize(), paths, script: scripts[0], stateDir, resume: !!values['--resume'], permissionMode, cwd: process.cwd(), title: `crew run ${basename(scripts[0])}` })
  console.log(`crew run: the runner is crew session ${s.id}; enter it from \`crew view "${s.runDir}"\``)
}

const terminalSize = () => ({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 30 })

async function start(args) {
  try {
    const { script, session: s } = await startCommand({
      argv: args,
      paths,
      tty: !!(process.stdin.isTTY && process.stdout.isTTY),
      stdin: process.stdin,
      stdout: process.stdout,
      launch: (o) => launchRunner({ ...terminalSize(), ...o, paths }),
    })
    console.log(`crew start: armed ${script}; the runner is crew session ${s.id}; enter it from \`crew view "${s.runDir}"\``)
    // At a terminal the operator is taken to the run straight away. With none
    // (the skill's crew path, an agent's shell) the view would take over a
    // screen nobody watches, so only the command is printed.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await view([s.runDir], { waitMs: 15_000 }).catch((e) => {
        console.error(`crew start: the run is launched, but its view did not open: ${e.message}; open it with \`crew view "${s.runDir}"\``)
        process.exit(1)
      })
    }
  } catch (e) {
    if (e.code === 2) usage(`crew start: ${e.message}`)
    console.error(`crew start: ${e.message}`)
    process.exit(typeof e.code === 'number' ? e.code : 1)
  }
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'run') {
  // Only the host is read here: on orca the runner checks its own argv.
  const { values } = parseFlags(rest, { ...RUN_FLAGS, lenient: true })
  const host = values['--host'] ?? DEFAULT_HOST
  if (!HOSTS.includes(host)) usage(typeof host === 'string' ? `crew: unknown host ${host}` : 'crew run: --host needs a host')
  if (host === 'crew') {
    await crewRun(rest).catch(fail)
  } else {
    await daemonAnyway()
    await launch(entry('../src/runner.mjs'), rest)
  }
} else if (command === 'start') {
  await start(rest)
  // The daemon's socket and the form's stdin would otherwise hold it open.
  process.exit(0)
} else if (command === 'view') {
  await view(rest).catch(fail)
} else if (command === 'ls') {
  await ls(rest).catch(fail)
} else if (['pause', 'resume', 'rm'].includes(command)) {
  await runCommand(command, rest).catch(fail)
  process.exit(0)
} else if (command === 'daemon') {
  await daemon(rest).catch(fail)
} else if (command === 'session') {
  await session(rest).catch(fail)
} else if (command === 'console') {
  await consoleCommand(rest).catch(fail)
} else if (command === 'orchestration') {
  await orchestration(rest).catch(fail)
} else if (command === undefined && process.stdin.isTTY && process.stdout.isTTY) {
  // Bare `crew` at a terminal: the run console on its runs list.
  await view([]).catch(fail)
} else {
  console.error(USAGE)
  process.exit(command === '--help' || command === '-h' ? 0 : 2)
}
