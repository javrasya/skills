#!/usr/bin/env node
// crew: the session runner's command line.
//
//   crew run [--host crew|orca] <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
//                     on the crew host, its default, the runner is a crew
//                     session of the daemon's, entered from `crew console`;
//                     on orca it is this process, in the operator's Orca tab
//   crew start <spec#> [--harness h] [--model m] [--base b] [--stack-mode s] [--permission-mode p]
//                     arms a run of the implement-spec workflow from a form,
//                     each row a flag (every one of them with no terminal),
//                     and launches it as `crew run` does
//   crew view --attached <run-dir> | --standalone [--registry <file>]
//   crew daemon start | status | stop [--force] | restart [--force]
//   crew session spawn [--cwd <dir>] -- <command…> | list | screen <id> | kill <id>
//   crew console      the daemon's sessions; Enter enters one, the back key (F12,
//                     or backKey in ~/.crew/config.json) comes back
//   crew orchestration send --from <h> --dispatch-capability <c> --task-id <t>
//        --dispatch-id <d> --type <worker_done|handoff|escalation> --subject <s>
//        --body <b> [--outcome succeeded|failed]
//                     a worker's message to its crew Run's mailbox, as its
//                     preamble (crew-host.mjs) names it; no Orca involved
//
// Every command but `daemon stop` starts the per-machine crew daemon when none
// answers (src/daemon/). view, and run on orca, carry on without it if it
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
import { runConsole } from '../src/console.mjs'
import { crewHost } from '../src/crew-host.mjs'
import { launchRunner, startCommand } from '../src/arm.mjs'

const USAGE = [
  'usage: crew run [--host <host>] <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]',
  '       crew start <spec#> [--harness claude|pi] [--model <m>] [--base <branch>] [--stack-mode native|install|chain] [--permission-mode <mode>]',
  '       crew view --attached <run-dir> | --standalone [--registry <run registry, for a fixture>]',
  '       crew daemon start | status | stop [--force] | restart [--force]',
  '       crew session spawn [--cwd <dir>] -- <command…> | list | screen <id> | kill <id>',
  '       crew console',
  '       crew orchestration send --from <h> --dispatch-capability <c> --task-id <t> --dispatch-id <d> --type <worker_done|handoff|escalation> --subject <s> --body <b> [--outcome succeeded|failed]',
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

async function daemon([verb, ...flags]) {
  const force = flags.includes('--force')
  const unknown = flags.filter((f) => f !== '--force')
  if (unknown.length || !['start', 'status', 'stop', 'restart'].includes(verb) || (force && !['stop', 'restart'].includes(verb))) {
    usage(`crew daemon: ${verb ? `unexpected ${[verb, ...flags].join(' ')}` : 'start, status, stop or restart'}`)
  }
  if (verb === 'stop' || verb === 'restart') {
    const stopped = await stopDaemon(paths, { force })
    console.log(stopped.stopped ? `crew daemon: pid ${stopped.pid} stopped` : 'crew daemon: not running')
    if (verb === 'stop') return
  }
  const hello = await ensureDaemon(paths)
  console.log(`${said(hello)}${hello.started ? ' (started)' : ''}`)
}

const describe = (s) => `${s.id}\t${s.alive ? 'running' : `exited ${s.exit?.code ?? s.exit?.signal}`}\tpid ${s.pid}\t${s.command.join(' ')}`

async function session([verb, ...args]) {
  if (verb === 'spawn') {
    const dash = args.indexOf('--')
    const command = dash >= 0 ? args.slice(dash + 1) : []
    const options = dash >= 0 ? args.slice(0, dash) : args
    const at = options.indexOf('--cwd')
    const cwd = at >= 0 ? options[at + 1] : process.cwd()
    if (!command.length || !cwd || options.length !== (at >= 0 ? 2 : 0)) usage('crew session spawn: -- <command…> is required')
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
    for (const s of (await request(paths, { op: 'session.list' })).sessions) console.log(describe(s))
    return
  }
  if ((verb === 'screen' || verb === 'kill') && args.length === 1) {
    await ensureDaemon(paths)
    if (verb === 'kill') {
      console.log(describe((await request(paths, { op: 'session.kill', id: args[0] })).session))
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

const SEND_FLAGS = { '--from': 'from', '--dispatch-capability': 'capability', '--task-id': 'taskId', '--dispatch-id': 'dispatchId', '--type': 'type', '--subject': 'subject', '--body': 'body', '--outcome': 'outcome' }

async function orchestration([verb, ...args]) {
  if (verb !== 'send') usage(`crew orchestration: ${verb ? `unexpected ${verb}` : 'send'}`)
  const m = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = SEND_FLAGS[args[i]]
    if (!key || args[i + 1] === undefined) usage(`crew orchestration send: ${key ? `${args[i]} needs a value` : `unexpected ${args[i]}`}`)
    m[key] = args[i + 1]
  }
  const missing = ['taskId', 'dispatchId', 'type'].filter((k) => !m[k])
  if (missing.length) usage(`crew orchestration send: missing ${missing.map((k) => Object.keys(SEND_FLAGS).find((f) => SEND_FLAGS[f] === k)).join(', ')}`)
  const { id } = await crewHost({ paths }).mailSend(m)
  console.log(`crew orchestration send: ${m.type} ${id} sent to the run's mailbox`)
}

// The runner as a session of the daemon's, on the crew host: it outlives this
// command, as a runner outlives its Orca tab, and `crew console` enters it.
// Its own argv errors would land on a screen nobody has entered yet, so the
// script is checked here first.
async function crewRun(args) {
  const scripts = args.filter((a, i) => !a.startsWith('--') && !['--state-dir', '--permission-mode'].includes(args[i - 1]))
  if (scripts.length !== 1) usage(`crew run: ${scripts.length ? `one script, not ${scripts.join(', ')}` : 'the rendered script is required'}`)
  if (!existsSync(scripts[0])) throw new Error(`no script ${resolve(scripts[0])}`)
  const s = await launchRunner({ ...terminalSize(), paths, args, cwd: process.cwd(), title: `crew run ${basename(scripts[0])}` })
  console.log(`crew run: the runner is crew session ${s.id}; enter it from \`crew console\``)
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
    console.log(`crew start: armed ${script}; the runner is crew session ${s.id}; enter it from \`crew console\``)
  } catch (e) {
    if (e.code === 2) usage(`crew start: ${e.message}`)
    console.error(`crew start: ${e.message}`)
    process.exit(typeof e.code === 'number' ? e.code : 1)
  }
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'run') {
  const at = rest.indexOf('--host')
  const host = at >= 0 ? rest[at + 1] : 'crew'
  if (!HOSTS.includes(host)) usage(host ? `crew: unknown host ${host}` : 'crew run: --host needs a host')
  if (host === 'crew') {
    await crewRun(rest.filter((_, i) => at < 0 || (i !== at && i !== at + 1))).catch(fail)
  } else {
    await daemonAnyway()
    await launch(entry('../src/runner.mjs'), rest)
  }
} else if (command === 'start') {
  await start(rest)
  // The daemon's socket and the form's stdin would otherwise hold it open.
  process.exit(0)
} else if (command === 'view') {
  await daemonAnyway()
  await launch(entry('../src/run-view/view.mjs'), rest)
} else if (command === 'daemon') {
  await daemon(rest).catch(fail)
} else if (command === 'session') {
  await session(rest).catch(fail)
} else if (command === 'console') {
  await consoleCommand(rest).catch(fail)
} else if (command === 'orchestration') {
  await orchestration(rest).catch(fail)
} else {
  console.error(USAGE)
  process.exit(command === '--help' || command === '-h' ? 0 : 2)
}
