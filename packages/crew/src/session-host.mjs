// The session host (ADR-0017): every call the runner, submit and the run view
// make on the app their sessions run in. A host adapter (hosts.mjs lists
// them) returns a plain object with each method below; fake-orca.mjs is the
// in-memory one the offline tests run on. The runner holds a host and nothing
// else of it: notions of one host only, such as how it groups a run's
// dispatches or brings a tab to the front, stay inside its adapter.
//
//   id, name                 the host's name in the runner's files, and in text
//   unreachable(e)           whether e is the host not there at all: an outage
//   probe()                  a cheap call, never guarded, that finds it back
//   guardWith(outage)        makes every call wait out an outage (outage.mjs)
//
//   run      runCreate({ objective }), runUse({ runId }) → { runId, terminal }
//   worker   workerStart, workerShow, workerStop, workerContinue, workerRelease
//            (workerShow's `hostDied`, where a host can tell: the session was
//            lost with the host itself, which is continued uncounted)
//            (workerShow's `note` and `needsYou`, where a host keeps them: its
//            agent's status note and why it needs you, #175)
//            (workerStart's and workerContinue's `agent`, { role, schema,
//            resultPath }: what a host whose agents submit by session keeps
//            on the dispatch, and another ignores)
//   terminal terminalIdle, terminalSend, terminalEnter, terminalClearInput,
//            terminalScreen, terminalList, terminalClose, terminalSwitch,
//            terminalRename; logTail, resumeRunner (a tab of the view's)
//   worktree chainWorktree, worktreeLines, worktreeStatus, worktreeRemove
//            (chainWorktree({ runId }) → { path, made, baseline,
//            warnings }: the run's one chain worktree, ADR-0020, named
//            chainName(runId) (git.mjs) beside its `<runId>-<n>` ones. Asked
//            while the host holds it, the same one as it is, `made` false and
//            no baseline. Asked when it holds none, the first time or after a
//            reclaim removed it, it is made: always from the run's worktree's
//            HEAD, the run's base, never from a ref a chain agent left it on
//            (an agent carried on in a remade one is told to switch back to
//            its own ref, lifecycle.mjs haltedPrompt), its setup hook run
//            then, `made` true, and a new baseline taken as a child's is, or
//            null with a warning when it cannot be read or the create
//            answered too late. workerStart({ chain }) starts a worker in it,
//            making nothing. worktreeLines({ worktree }) → the `git status
//            --porcelain` lines it holds now)
//   mailbox  mailCheck({ ack }): the run's messages, each a `type` of
//            worker_done, handoff or escalation; workerDone, sent by submit
//
// promptDelivered({ harness, sessionId, worktree, needle }) is optional: a
// host that cannot tell leaves the prompt-delivery check out.
// inPlace is optional too: true on a host whose sessions a console enters in
// place (crew), where Enter on an agent enters its session rather than
// terminalSwitch bringing its tab to the front.
//
// Some methods are crew's only, outside the interface, and no runner calls
// them on a host it was handed: sessionStart({ title, prompt, harness,
// model, effort, permissionMode, sessionId, dir, stateDir }) → { terminal },
// a harness session of no Run (the orchestrator's `?`, orchestrator.mjs,
// always asked of a crew host: arm.mjs runOrchestrator), stateDir the run it
// is about, for its tools (#194); mailSend, a worker's `crew
// orchestration send` (bin/crew.mjs; on Orca a worker sends with Orca's own
// CLI, and fake-orca.mjs has one only to play a worker in the suite); and
// the parking ones the run tree calls only when the host has them:
// terminalsParked, terminalPark (ADR-0024) and terminalsInfo, every session
// as { terminal, alive, parked, waiting, exit }, which the tree
// reads a `?` session's state from (#168); and workerResult({ dispatch })
// → { result, outcome, submissions }, the last result a worker submitted
// and how many times it did, which a runner asks only of a host that has it
// (#173). The contract suite checks the
// crew host has them all.
export const CREW_ONLY = Object.freeze(['sessionStart', 'mailSend', 'terminalsParked', 'terminalPark', 'terminalsInfo', 'workerResult'])

export const SESSION_HOST = Object.freeze([
  'unreachable',
  'probe',
  'guardWith',
  'runCreate',
  'runUse',
  'workerStart',
  'workerShow',
  'workerStop',
  'workerContinue',
  'workerRelease',
  'terminalIdle',
  'terminalSend',
  'terminalEnter',
  'terminalClearInput',
  'terminalScreen',
  'terminalList',
  'terminalClose',
  'terminalSwitch',
  'terminalRename',
  'logTail',
  'resumeRunner',
  'chainWorktree',
  'worktreeLines',
  'worktreeStatus',
  'worktreeRemove',
  'mailCheck',
  'workerDone',
])

// The session-level methods: a worker's session and its terminal, apart from
// the run, worktrees and mailbox around it. The host contract suite
// (test/test-host-contract.mjs) runs every host through them, and through
// the run, worker and mailbox methods of RUN_METHODS.
export const SESSION_METHODS = Object.freeze(['workerStart', 'workerStop', 'workerContinue', 'terminalIdle', 'terminalSend', 'terminalEnter', 'terminalClearInput', 'terminalScreen', 'terminalList', 'terminalClose', 'terminalRename'])

export const RUN_METHODS = Object.freeze(['runCreate', 'runUse', 'workerShow', 'workerRelease', 'workerDone', 'mailCheck', 'chainWorktree', 'worktreeLines', 'worktreeStatus', 'worktreeRemove'])

// A host as the checker sees it. Hosts are duck-typed: sessionHost() checks
// the methods SESSION_HOST names at runtime, and the fakes the tests hand in
// implement only what they need, so the checker is told its id, its name, and
// that the rest is whatever the host defines.
/** @typedef {{ id: string, name: string, inPlace?: boolean } & Record<string, any>} SessionHost */

// The methods of the interface `host` lacks, [] for a whole one.
export const missingMethods = (host) => SESSION_HOST.filter((m) => typeof host?.[m] !== 'function')

export function sessionHost(host) {
  const missing = missingMethods(host)
  if (missing.length || typeof host?.id !== 'string' || typeof host?.name !== 'string') {
    throw new Error(`not a session host: ${[...(typeof host?.id === 'string' ? [] : ['id']), ...(typeof host?.name === 'string' ? [] : ['name']), ...missing].join(', ')} missing`)
  }
  return host
}

// Whether an error from `host` means the host is not there at all. A host
// that cannot tell (a test's stand-in) never has an outage.
export const hostUnreachable = (host, e) => e != null && host?.unreachable?.(e) === true
