// Preloaded into the Orca runner for the runner contract test only:
//   node --require <repo>/scripts/runner-contract-orca-fault.cjs <repo>/skills/engineering/implement-spec-in-workflow/orca/runner.mjs …
// It fails the first worker-start of contract:retry, after its terminal and
// worktree exist, as an Orca refusal would, so the start retry runs against
// real Orca. The contract script cannot fail a start itself and stays
// byte-identical under both runners, and the runner carries no test hook.
// orca-cli.mjs reaches Orca through child_process.execFile; this patches it
// before any ES module imports it.
const cp = require('child_process')
const { EventEmitter } = require('events')
const { syncBuiltinESMExports } = require('module')

const LABEL = 'contract:retry'
const execFile = cp.execFile
let failed = false

cp.execFile = function (file, args, options, callback) {
  const title = Array.isArray(args) ? args[args.indexOf('--task-title') + 1] : null
  if (failed || args?.[0] !== 'orchestration' || args[1] !== 'worker-start' || typeof title !== 'string' || !title.includes(LABEL)) {
    return execFile.apply(this, arguments)
  }
  failed = true
  const envelope = { ok: false, error: { code: 'contract_fault', message: `the runner contract test fails ${LABEL}'s first start on purpose` } }
  setImmediate(() => callback(Object.assign(new Error('Command failed'), { code: 1 }), JSON.stringify(envelope), ''))
  return new EventEmitter()
}
syncBuiltinESMExports()
