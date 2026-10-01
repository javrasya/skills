// The run registry (ADR-0012): the machine-wide list of Orca-runner runs, one
// append-only JSON-lines file shared by every runner on the machine. An Orca
// Run knows no project, run directory, spec or outcome, and cannot be closed,
// so these entries hold them, keyed by the Run id. A run's current state is
// the fold of its entries (readRegistry). Runs from before the registry are
// not in it and are never backfilled (D9 on #43).
//
// Entries, each with `type`, `runId` and `at` (ISO time):
//   armed      project, runDir, spec: the runner created the Run; script and
//              permissionMode, when it had them: what a resume relaunches it with;
//              host, the session host it runs on (hosts.mjs), none being orca
//   runner     terminal: a runner started on the run, in that terminal (on
//              crew, the runner's own crew session), and host — at creation, and again
//              whenever one takes it up on a resume. One after `ended`, or
//              after a whole-run `reclaimed`, is a resume: the run is going
//              again, so it is running and no longer reclaimed
//   ended      outcome: ok, partial or failed
//   paused     reason: the run's runner is alive but has paused it, which
//              fails no agent: `orca outage` or `crew outage`, its session
//              host gone past its limit (ADR-0015)
//   unpaused   the runner carries it on again
//   halted     node, reason: the run halted on a node that failed or needs a
//              decision (ADR-0016); its runner stays, and R carries it on
//   unhalted   no failed or needs-decision node is left: it runs again
//   reclaimed  agent: the reclaimed agent's journaled `<runId>-<n>`, n being
//              the call that started its worker (its origin: a resume numbers
//              its calls on, never its agents), never its worktree's name, which
//              agents may share. Entries written before named the worktree, which
//              Orca named the same. With no agent, the whole run was reclaimed
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'fs'
import { dirname, join } from 'path'
import { claudeDir } from './transcript.mjs'
import { LEGACY_HOST } from './hosts.mjs'

// In the user's Claude directory, resolved where transcripts resolve it.
export const REGISTRY_PATH = join(claudeDir(), 'orca-runs.jsonl')

export const OUTCOMES = Object.freeze(['ok', 'partial', 'failed'])

// Whether the file's last byte is a newline. A runner killed mid-write leaves
// a torn line; appending straight after it would weld the next entry onto it
// and lose both.
function endsTorn(path) {
  if (!existsSync(path)) return false
  const fd = openSync(path, 'r')
  try {
    const { size } = fstatSync(fd)
    if (!size) return false
    const b = Buffer.alloc(1)
    readSync(fd, b, 0, 1, size - 1)
    return b[0] !== 0x0a
  } finally {
    closeSync(fd)
  }
}

// The writer for one runner. `clock.now()` stamps every entry.
export function runRegistry(path = REGISTRY_PATH, clock = { now: () => Date.now() }) {
  const append = (entry) => {
    mkdirSync(dirname(path), { recursive: true })
    const line = JSON.stringify({ type: entry.type, runId: entry.runId, at: new Date(clock.now()).toISOString(), ...entry }) + '\n'
    appendFileSync(path, (endsTorn(path) ? '\n' : '') + line)
  }
  return {
    path,
    armed: ({ runId, project, runDir, spec, script = null, permissionMode = null, host = null }) =>
      append({ type: 'armed', runId, project, runDir, spec, ...(script && { script }), ...(permissionMode && { permissionMode }), ...(host && { host }) }),
    runner: ({ runId, terminal, host = null }) => append({ type: 'runner', runId, terminal: terminal ?? null, ...(host && { host }) }),
    ended: ({ runId, outcome }) => {
      if (!OUTCOMES.includes(outcome)) throw new Error(`run registry: unknown outcome "${outcome}": expected one of ${OUTCOMES.join(', ')}`)
      append({ type: 'ended', runId, outcome })
    },
    reclaimed: ({ runId, agent = null }) => append({ type: 'reclaimed', runId, ...(agent && { agent }) }),
    paused: ({ runId, reason }) => append({ type: 'paused', runId, reason }),
    unpaused: ({ runId }) => append({ type: 'unpaused', runId }),
    halted: ({ runId, node, reason }) => append({ type: 'halted', runId, node, reason }),
    unhalted: ({ runId }) => append({ type: 'unhalted', runId }),
  }
}

// Every run the registry knows, in the order they were armed:
//   { runId, host, project, runDir, spec, script, permissionMode, armedAt,
//     state: 'running' | 'halted' | 'ok' | 'partial' | 'failed', endedAt,
//                                       — halted: its runner halted it, and
//                                         has not carried it on since
//     runner: { terminal, at } | null   — where a runner was last seen on it,
//     paused: { reason, at } | null     — its runner paused it, and has not
//                                         carried it on, ended it or been
//                                         followed by another runner,
//     reclaimed: boolean, reclaimedAt,  — the whole run
//     reclaimedAgents: [{ agent, at }] }
// 'running' only means no `ended` was written since a runner last started on
// it: a runner that was killed never writes one, so whether it is still alive
// is its runner.pid's to say (run-view-model.mjs's runnerAlive). A resume's
// `runner` entry reopens a run that ended, or was reclaimed as a whole: state
// is running again and reclaimed false, while reclaimedAgents keeps the agents
// already reclaimed, since their worktrees are gone. host is the one its
// latest runner named, else its armed entry's, else orca: every run armed
// before hosts had names ran on Orca. A line that does not parse (a torn last line) is skipped, and so is an entry
// for a Run never armed here.
export function readRegistry(path = REGISTRY_PATH) {
  const runs = new Map()
  if (!existsSync(path)) return []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!e || typeof e !== 'object' || typeof e.runId !== 'string') continue
    if (e.type === 'armed') {
      if (!runs.has(e.runId)) {
        runs.set(e.runId, {
          runId: e.runId, host: e.host ?? LEGACY_HOST, project: e.project ?? null, runDir: e.runDir ?? null, spec: e.spec ?? null,
          script: e.script ?? null, permissionMode: e.permissionMode ?? null, armedAt: e.at ?? null,
          state: 'running', endedAt: null, runner: null, paused: null, reclaimed: false, reclaimedAt: null, reclaimedAgents: [],
        })
      }
      continue
    }
    const run = runs.get(e.runId)
    if (!run) continue
    if (e.type === 'runner') Object.assign(run, { runner: { terminal: e.terminal ?? null, at: e.at ?? null }, state: 'running', endedAt: null, paused: null, reclaimed: false, reclaimedAt: null, ...(e.host && { host: e.host }) })
    else if (e.type === 'ended' && OUTCOMES.includes(e.outcome)) Object.assign(run, { state: e.outcome, endedAt: e.at ?? null, paused: null })
    else if (e.type === 'paused') run.paused = { reason: e.reason ?? null, at: e.at ?? null }
    else if (e.type === 'unpaused') run.paused = null
    else if (e.type === 'halted' && run.state === 'running') run.state = 'halted'
    else if (e.type === 'unhalted' && run.state === 'halted') run.state = 'running'
    else if (e.type === 'reclaimed') {
      if (e.agent) run.reclaimedAgents.push({ agent: e.agent, at: e.at ?? null })
      else Object.assign(run, { reclaimed: true, reclaimedAt: e.at ?? null })
    }
  }
  return [...runs.values()]
}
