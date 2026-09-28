#!/usr/bin/env node
// crew: the session runner's command line.
//
//   crew run --host orca <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
//   crew view --attached <run-dir> | --standalone [--registry <file>]
//   crew daemon start | status | stop [--force] | restart [--force]
//   crew session spawn [--cwd <dir>] -- <command…> | list | screen <id> | kill <id>
//
// Every command but `daemon stop` starts the per-machine crew daemon when none
// answers (src/daemon/). run and view carry on without it if it cannot start:
// nothing they do needs it yet.
//
// Each entry keeps its own argv parsing and its own "am I main" check, so this
// hands it the argv it would have had launched directly, then loads it in this
// process: a child process would split the terminal and its signals between two.
import { realpathSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { HOST_NAMES as HOSTS } from '../src/hosts.mjs'
import { crewPaths } from '../src/daemon/transport.mjs'
import { ensureDaemon, request, stopDaemon } from '../src/daemon/client.mjs'

const USAGE = [
  'usage: crew run --host <host> <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]',
  '       crew view --attached <run-dir> | --standalone [--registry <run registry, for a fixture>]',
  '       crew daemon start | status | stop [--force] | restart [--force]',
  '       crew session spawn [--cwd <dir>] -- <command…> | list | screen <id> | kill <id>',
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

const [command, ...rest] = process.argv.slice(2)
if (command === 'run') {
  const at = rest.indexOf('--host')
  const host = at >= 0 ? rest[at + 1] : null
  if (!HOSTS.includes(host)) usage(host ? `crew: unknown host ${host}` : 'crew run: --host is required')
  await daemonAnyway()
  await launch(entry('../src/runner.mjs'), rest)
} else if (command === 'view') {
  await daemonAnyway()
  await launch(entry('../src/run-view/view.mjs'), rest)
} else if (command === 'daemon') {
  await daemon(rest).catch(fail)
} else if (command === 'session') {
  await session(rest).catch(fail)
} else {
  console.error(USAGE)
  process.exit(command === '--help' || command === '-h' ? 0 : 2)
}
