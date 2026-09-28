#!/usr/bin/env node
// crew: the session runner's command line.
//
//   crew run --host orca <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
//   crew view --attached <run-dir> | --standalone [--registry <file>]
//
// Each entry keeps its own argv parsing and its own "am I main" check, so this
// hands it the argv it would have had launched directly, then loads it in this
// process: a child process would split the terminal and its signals between two.
import { realpathSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'

const HOSTS = ['orca']
const USAGE = [
  'usage: crew run --host <host> <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]',
  '       crew view --attached <run-dir> | --standalone [--registry <run registry, for a fixture>]',
  `hosts: ${HOSTS.join(', ')}`,
].join('\n')

const entry = (rel) => realpathSync(fileURLToPath(new URL(rel, import.meta.url)))

async function launch(path, args) {
  process.argv = [process.argv[0], path, ...args]
  await import(pathToFileURL(path).href)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'run') {
  const at = rest.indexOf('--host')
  const host = at >= 0 ? rest[at + 1] : null
  if (!HOSTS.includes(host)) {
    console.error(host ? `crew: unknown host ${host}\n${USAGE}` : `crew run: --host is required\n${USAGE}`)
    process.exit(2)
  }
  rest.splice(at, 2)
  await launch(entry('../src/runner.mjs'), rest)
} else if (command === 'view') {
  await launch(entry('../src/run-view/view.mjs'), rest)
} else {
  console.error(USAGE)
  process.exit(command === '--help' || command === '-h' ? 0 : 2)
}
