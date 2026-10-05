// Reopening a node (ADR-0032): the one journal line the orchestrator's reopen
// tool writes (hooks/crew-tools.mjs), and its refusals. A run whose script
// ended on a node's result, as the template's own halt does on an unmet
// ticket, replays that same result on every --resume, so it ends the same way
// in the same second. Once the operator and the orchestrator have agreed what
// was wrong and fixed it, a `reopen` line names the node and the note its
// agent finishes with; the next resume carries that node on in its own
// session instead of replaying it (runner.mjs), every other node replayed as
// before. The line is appended, never a line changed: the journal stays the
// record of what happened.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJournal } from './journal.mjs'
import { runnerAlive } from './run-view-model.mjs'

// Appends a reopen line for `node`, with the operator's `note`, to the run in
// `stateDir`, and returns { node, title }. Refused, writing nothing, while
// the run's runner is alive or may be (a live runner owns the journal, and a
// resume rewrites it from empty), for an empty note, and for a node that is
// not a settled result: one not in the journal, one held (failed or needing
// decisions, which a resume already carries on), or one whose worker is still
// out. A node reopened again takes the later note.
export function reopenNode(stateDir, { node, note }, { alive = runnerAlive, now = () => Date.now() } = {}) {
  const text = typeof note === 'string' ? note.trim() : ''
  if (!text) throw new Error('reopen needs a note: what was fixed, and how its agent finishes.')
  const live = alive(stateDir)
  if (live === true) throw new Error("the run's runner is alive: it owns the journal, so nothing was reopened. A held node is carried on with resume or decide; reopen is for a run whose runner has ended.")
  if (live === null) throw new Error("whether the run's runner is alive cannot be told (its runner.pid did not answer), so nothing was reopened.")
  const path = join(stateDir, 'journal.jsonl')
  const e = readJournal(path).nodes.get(node)
  if (!e) throw new Error(`no node ${node} in this run's journal: run_status names each agent's node. Nothing was reopened.`)
  if (e.failed || e.needsDecision) throw new Error(`${node} is held, ${e.failed ? 'failed' : 'needing decisions'}: a resume carries it on as it is, so it needs no reopen. Nothing was reopened.`)
  if (!('result' in e)) throw new Error(`${node} has not settled: its worker is still out, and a resume takes it up. Nothing was reopened.`)
  // A torn last line (a runner killed mid-write) must not swallow this one.
  const torn = existsSync(path) && !/\n$|^$/.test(readFileSync(path, 'utf8'))
  appendFileSync(path, `${torn ? '\n' : ''}${JSON.stringify({ type: 'reopen', at: new Date(now()).toISOString(), node, note: text })}\n`)
  return { node, title: e.title }
}
