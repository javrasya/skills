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
//   terminal terminalIdle, terminalSend, terminalEnter, terminalClearInput,
//            terminalScreen, terminalList, terminalClose, terminalSwitch,
//            terminalRename; logTail, resumeRunner (a tab of the view's)
//   worktree worktreeStatus, worktreeRemove
//   mailbox  mailCheck({ ack }): the run's messages, each a `type` of
//            worker_done, handoff or escalation; workerDone, sent by submit
//
// promptDelivered({ harness, sessionId, worktree, needle }) is optional: a
// host that cannot tell leaves the prompt-delivery check out.
// inPlace is optional too: true on a host whose sessions a console enters in
// place (crew), where Enter on an agent enters its session rather than
// terminalSwitch bringing its tab to the front.
export const SESSION_HOST = Object.freeze([
  'unreachable', 'probe', 'guardWith',
  'runCreate', 'runUse',
  'workerStart', 'workerShow', 'workerStop', 'workerContinue', 'workerRelease',
  'terminalIdle', 'terminalSend', 'terminalEnter', 'terminalClearInput', 'terminalScreen',
  'terminalList', 'terminalClose', 'terminalSwitch', 'terminalRename', 'logTail', 'resumeRunner',
  'worktreeStatus', 'worktreeRemove',
  'mailCheck', 'workerDone',
])

// The session-level methods: a worker's session and its terminal, apart from
// the run, worktrees and mailbox around it. The host contract suite
// (test/test-host-contract.mjs) runs every host through them, and through
// the run, worker and mailbox methods of RUN_METHODS.
export const SESSION_METHODS = Object.freeze([
  'workerStart', 'workerStop', 'workerContinue',
  'terminalIdle', 'terminalSend', 'terminalEnter', 'terminalClearInput', 'terminalScreen',
  'terminalList', 'terminalClose', 'terminalRename',
])

export const RUN_METHODS = Object.freeze(['runCreate', 'runUse', 'workerShow', 'workerRelease', 'workerDone', 'mailCheck', 'worktreeStatus', 'worktreeRemove'])

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
