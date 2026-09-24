// The run registry (ADR-0012): the machine-wide list of Orca-runner runs, one
// append-only JSON-lines file shared by every runner on the machine. An Orca
// Run knows no project, run directory, spec or outcome, and cannot be closed,
// so these entries hold them, keyed by the Run id. A run's current state is
// the fold of its entries (readRegistry). Runs from before the registry are
// not in it and are never backfilled (D9 on #43).
//
// Entries, each with `type`, `runId` and `at` (ISO time):
//   armed      project, runDir, spec: the runner created the Run; script and
//              permissionMode, when it had them: what a resume relaunches it with
//   runner     terminal: a runner started on the run — at creation, and again
//              whenever one takes it up on a resume
//   ended      outcome: ok, partial or failed
//   reclaimed  agent: the reclaimed agent's worktree name, `<runId>-<n>`; with
//              no agent, the whole run was reclaimed
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export const REGISTRY_PATH = join(homedir(), '.claude', 'orca-runs.jsonl')

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
    armed: ({ runId, project, runDir, spec, script = null, permissionMode = null }) =>
      append({ type: 'armed', runId, project, runDir, spec, ...(script && { script }), ...(permissionMode && { permissionMode }) }),
    runner: ({ runId, terminal }) => append({ type: 'runner', runId, terminal: terminal ?? null }),
    ended: ({ runId, outcome }) => {
      if (!OUTCOMES.includes(outcome)) throw new Error(`run registry: unknown outcome "${outcome}": expected one of ${OUTCOMES.join(', ')}`)
      append({ type: 'ended', runId, outcome })
    },
    reclaimed: ({ runId, agent = null }) => append({ type: 'reclaimed', runId, ...(agent && { agent }) }),
  }
}

// Every run the registry knows, in the order they were armed:
//   { runId, project, runDir, spec, script, permissionMode, armedAt,
//     state: 'running' | 'ok' | 'partial' | 'failed', endedAt,
//     runner: { terminal, at } | null   — where a runner was last seen on it,
//     reclaimed: boolean, reclaimedAt,  — the whole run
//     reclaimedAgents: [{ agent, at }] }
// 'running' only means no `ended` was written: a runner that was killed never
// writes one, so whether it is still alive is Orca's to say, by its terminal.
// A line that does not parse (a torn last line) is skipped, and so is an entry
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
          runId: e.runId, project: e.project ?? null, runDir: e.runDir ?? null, spec: e.spec ?? null,
          script: e.script ?? null, permissionMode: e.permissionMode ?? null, armedAt: e.at ?? null,
          state: 'running', endedAt: null, runner: null, reclaimed: false, reclaimedAt: null, reclaimedAgents: [],
        })
      }
      continue
    }
    const run = runs.get(e.runId)
    if (!run) continue
    if (e.type === 'runner') run.runner = { terminal: e.terminal ?? null, at: e.at ?? null }
    else if (e.type === 'ended' && OUTCOMES.includes(e.outcome)) Object.assign(run, { state: e.outcome, endedAt: e.at ?? null })
    else if (e.type === 'reclaimed') {
      if (e.agent) run.reclaimedAgents.push({ agent: e.agent, at: e.at ?? null })
      else Object.assign(run, { reclaimed: true, reclaimedAt: e.at ?? null })
    }
  }
  return [...runs.values()]
}
