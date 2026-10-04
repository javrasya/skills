// A halted run (ADR-0016): a node that failed, or whose result needs decisions
// only the operator can make, is held, never handed to the script as null or
// as that result, and the run halts. While it is halted every new agent() call
// but an in-flight one (opts.inFlight) is held too, not started. r resumes a
// held node, or every one; once no failed or needs-decision node is left, the
// run leaves halted and releases every held call, in call order. The runner
// (runner.mjs) decides what is held and how a node is resumed; this is only
// the run's halted state, what it journals, logs and records, and the waits.
// The calls it holds wait in the hold queue (hold.mjs), the one a pause holds
// calls in too, so they go on in call order across both.
import { holdQueue } from './hold.mjs'

// journal(entry) appends a journal line; out(s) logs; record(what, entry)
// writes the run registry; runId() is the Run's id, or null before there is
// one; onHalt({ node, nodes }) is told each time a node is held, and
// onChange(held) each time the set of held nodes changes or a node is held
// again, with every held node, in the order held, as { node, title, reason,
// questions? }: none once the run leaves halted. queue is the hold queue
// (hold.mjs) the runner gates new calls on.
// Returns {
//   on()             whether the run is halted
//   hold(node)       holds a node: { node, title, needsDecision, reason,
//                    questions? };
//                    resolves once r resumes it, which the caller then does
//   settle(node)     a held node succeeded: the run leaves halted once none
//                    is left, and every held call no other gate holds goes on
//   resume(node)     r: resumes that held node, or with none every one not
//                    already being resumed; { resumed: [node…] }
//   nodes()          every held node's name, in the order they were held
// }
/** @param {{ journal: (entry: object) => unknown, out: (line: string) => unknown, record?: (what: string, entry: object) => unknown, runId?: () => string | null, onHalt?: (halt: { node: string, nodes: string[] }) => unknown, onChange?: (held: object[]) => unknown, queue?: ReturnType<typeof holdQueue> }} options */
export function runHalt({ journal, out, record = () => {}, runId = () => null, onHalt = () => {}, onChange = () => {}, queue = holdQueue() }) {
  // node -> { node, title, needsDecision, reason, questions, go, resuming }
  const held = new Map()
  let on = false
  // While halted, every new call but an in-flight one is held.
  const gate = {
    holds: ({ inFlight = false }) => on && !inFlight,
    held({ key, n, node = null, title }) {
      journal({ type: 'held', key, n, ...(node && { node }), title })
      out(`.. ${title}: held, the run is halted`)
    },
  }
  queue.join(gate)

  const changed = () => onChange([...held.values()].map(({ node, title, reason, questions }) => ({ node, title, reason, ...(questions && { questions }) })))

  function hold({ node, title, needsDecision = false, reason, questions = null }) {
    return new Promise((go) => {
      held.set(node, { node, title, needsDecision, reason, questions, go, resuming: false })
      if (!on) {
        on = true
        journal({ type: 'halted', node, reason })
        if (runId()) record('halted', { runId: runId(), node, reason })
      }
      out(`!!!!!!!! HALTED: ${node} ${needsDecision ? 'needs decisions only you can make' : 'failed'}: ${reason}; r to resume`)
      onHalt({ node, nodes: [...held.keys()] })
      changed()
    })
  }

  function settle(node) {
    if (!held.delete(node) || !on) return
    changed()
    if (held.size) return
    on = false
    journal({ type: 'unhalted' })
    if (runId()) record('unhalted', { runId: runId() })
    const waiting = queue.count(gate)
    out(`>> no failed or needs-decision node is left: the run is no longer halted${waiting ? `, and the ${waiting} call${waiting === 1 ? '' : 's'} held meanwhile go on` : ''}`)
    queue.release()
  }

  function resume(node = null) {
    if (!on) {
      out('>> r: the run is not halted: nothing to resume')
      return { resumed: [] }
    }
    const targets = node ? [held.get(node)].filter(Boolean) : [...held.values()]
    const ready = targets.filter((t) => !t.resuming)
    if (!ready.length) out(node && !held.has(node) ? `>> r: ${node} is not held: nothing to resume` : '>> r: every held node is already being resumed')
    for (const t of ready) {
      t.resuming = true
      out(`>> r: resuming ${t.node}`)
      t.go()
    }
    return { resumed: ready.map((t) => t.node) }
  }

  return { on: () => on, hold, settle, resume, nodes: () => [...held.keys()] }
}

// The file the tree's r writes in a run's state dir for its runner to take
// (runner.mjs watchResumeRequests): { node }, null for every held node.
export const RESUME_REQUEST = 'resume-request.json'
