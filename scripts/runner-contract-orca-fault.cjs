// Preloaded into the Orca runner for the runner contract tests only:
//   node --require <repo>/scripts/runner-contract-orca-fault.cjs <repo>/skills/engineering/implement-spec-in-workflow/orca/runner.mjs …
// The contract scripts cannot fault Orca themselves, and the runner carries no
// test hook. orca-cli.mjs reaches Orca through child_process.execFile; this
// patches it before any ES module imports it.
// - runner-contract.workflow.js: it fails the first worker-start of
//   contract:retry, after its terminal and worktree exist, as an Orca refusal
//   would, so the start retry runs against real Orca.
// - runner-contract-orca.workflow.js: it holds back the answer of the first
//   worktree create, contract:dirty-retry's (the script's one isolated agent;
//   a create carries no task title to match), past the adapter's bound on it,
//   after writing an untracked file into the new worktree as a setup hook
//   would. The runner has to find that worktree by name and start in it.
const cp = require('child_process')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { syncBuiltinESMExports } = require('module')

const LABEL = 'contract:retry'
const ORCA_ONLY = process.argv.some((a) => path.basename(a) === 'runner-contract-orca.workflow.js')
const SETUP_OUTPUT = 'contract-setup-output.txt'
const execFile = cp.execFile
let failed = false
let held = false

cp.execFile = function (file, args, options, callback) {
  if (ORCA_ONLY && !held && args?.[0] === 'worktree' && args[1] === 'create' && typeof callback === 'function') {
    held = true
    // execFile's own timeout is the adapter's bound on this create.
    const holdMs = (options?.timeout ?? 0) + 5_000
    return execFile.call(this, file, args, options, (err, stdout, stderr) => {
      try {
        const made = JSON.parse(String(stdout)).result?.worktree?.path
        if (made) fs.writeFileSync(path.join(made, SETUP_OUTPUT), 'written by the contract preload, as a setup hook would\n')
      } catch {}
      setTimeout(() => callback(err, stdout, stderr), holdMs)
    })
  }
  const title = Array.isArray(args) ? args[args.indexOf('--task-title') + 1] : null
  if (ORCA_ONLY || failed || args?.[0] !== 'orchestration' || args[1] !== 'worker-start' || typeof title !== 'string' || !title.includes(LABEL)) {
    return execFile.apply(this, arguments)
  }
  failed = true
  const envelope = { ok: false, error: { code: 'contract_fault', message: `the runner contract test fails ${LABEL}'s first start on purpose` } }
  setImmediate(() => callback(Object.assign(new Error('Command failed'), { code: 1 }), JSON.stringify(envelope), ''))
  return new EventEmitter()
}
syncBuiltinESMExports()
