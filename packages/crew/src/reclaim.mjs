// Reclaim (ADR-0012): the operator's act of removing an agent's tab and
// worktree, for one agent or a whole run. The runner itself reclaims nothing;
// the run view's reclaim dialog and the standalone runs list's run-level `r`
// both reclaim through here, so both keep the same rules:
//   - an agent still live is refused, except one that failed and was kept
//     with its worker left running: that one only with `stop`, a reclaim the
//     operator confirms, which stops its worker first;
//   - a worktree holding unpushed commits is removed only when forced;
//   - a worktree is the run's only by its `<runId>-<n>` name — any other is
//     the operator's own, and never touched;
//   - a sequential run's `<runId>-chain` (ADR-0020) is the run's, never one
//     agent's: reclaiming its agents leaves it, and only reclaiming the whole
//     run once it has ended, no agent of it kept and none the journal ran in
//     it live there, removes it (reclaimChainAfter, the one rule for it);
//   - reclaiming releases the worker, closes its tab if Orca's terminal list
//     still shows it, and removes its worktree.
import { madeByRun, readJournal } from './journal.mjs'
import { agentId, chainName, worktreeName, worktreeUnpushed } from './git.mjs'
import { hostUnreachable } from './session-host.mjs'
import { samePath } from './paths.mjs'

// `unpushed(path)` below defaults to git.mjs's worktreeUnpushed: commits
// no remote-tracking ref holds (D6 on #43), counted by the one bounded git helper.

// The agents a run's journal names, by the fold every reader of it shares
// (journal.mjs), in call order:
//   { runId, n, origin, name, title, launched, dispatchId, terminal, worktree,
//     harness, state, reason, workerLeft }
// Every agent its Run holds: a resumed run's journal carries forward the ones
// earlier runners of that Run made, finished, failed or still out, so a
// resume renames none and drops none. name is its `<runId>-<n>`, where n is its
// origin, the call that started its worker: its identity, what the run registry
// records a reclaim under and the run view marks reclaimed by. It is not read
// off its worktree, which a sequential run's agents share (ADR-0020), save
// where the journal lost its origin (agentName); a worktree of its own Orca
// named the same, so registries written before agree. launched: a worker was
// started for it. state is 'ok' for a call that returned a value, 'failed' for
// one that returned null (dead, or settled with no valid result), 'running' for
// one with no settlement journaled. workerLeft: it failed with its worker's
// process left running (lifecycle.mjs). A call whose worker never started is an
// agent only if Orca made it a worktree, and then has no dispatch or tab. A
// call replayed from the journal is the agent that first returned its value.
export function agentsOf(journalPath) {
  return readJournal(journalPath).agents.filter(madeByRun).map((a) => ({
    runId: a.runId, n: a.n, origin: a.origin, name: agentName(a), title: a.title, launched: a.launched, dispatchId: a.dispatchId,
    terminal: a.terminal, worktree: a.worktree, harness: a.harness, state: a.state === 'done' ? 'ok' : a.state === 'failed' ? 'failed' : 'running', reason: a.reason,
    workerLeft: a.workerLeft === true,
  }))
}

// The worktree the run view may show: one the run created, by its name.
export const runWorktree = (a) => (a.worktree && worktreeName(a.worktree).startsWith(`${a.runId}-`) ? a.worktree : null)

// The worktree an agent's reclaim may remove: one the run created for that
// agent alone, never the chain its sequential run shares.
export const ownWorktree = (a) => (runWorktree(a) && worktreeName(a.worktree) !== chainName(a.runId) ? a.worktree : null)

// A refusal while `worktree` holds commits no remote has, unless `force`.
async function heldBack(worktree, { unpushed, force }) {
  if (force) return null
  let ahead
  try {
    ahead = await unpushed(worktree)
  } catch (e) {
    return { reason: `could not tell whether ${worktree} holds unpushed commits: ${e?.message ?? e}` }
  }
  return ahead > 0 ? { reason: `${worktree} holds ${ahead} unpushed commit${ahead === 1 ? '' : 's'}; only a forced reclaim removes it`, unpushed: ahead } : null
}

// The name the run registry records an agent's reclaim under. Only a journal
// whose take-up never carried its origin leaves the worktree's name as the one
// record of the call that started it.
export const agentName = (a) => (a.originGuessed && ownWorktree(a) ? worktreeName(ownWorktree(a)) : agentId(a.runId, a.origin ?? a.n))

// Whether an agent failed and was kept with its worker's process left
// running: Orca still shows that worker live, so only `stop` reclaims it.
export const keptRunning = (agent) => agent.state === 'failed' && agent.workerLeft === true

// Reclaims one agent: { reclaimed: true, notes } or { reclaimed: false, reason },
// with `stoppable: true` when the agent failed and was kept with its worker
// still running, so a reclaim with `stop` would take it, and `unpushed` when
// its worktree holds commits only `force` removes. Every check runs before
// anything is changed, so a refused agent is left exactly as it was; `stop`
// then stops that worker before anything else. `open`: the terminal list's
// handles, when the caller has already read it for a batch. A refusal
// because Orca was not there at all (an outage, ADR-0015) is `unreachable`.
export async function reclaimAgent(agent, { host, unpushed = worktreeUnpushed, force = false, stop = false, open = null }) {
  const refuse = (reason, e = null) => ({ reclaimed: false, reason, ...(hostUnreachable(host, e) && { unreachable: true }) })
  let stopFirst = false
  // A missing dispatch is never proof its worker is not live: only an agent
  // the journal shows no worker ever started for skips the check. A failed
  // agent kept with its process left running is exactly the one to refuse.
  if (!agent.dispatchId && agent.launched !== false) return refuse('could not tell whether it is live: the journal names no dispatch for its worker')
  if (agent.dispatchId) {
    let s
    try {
      s = await host.workerShow({ dispatch: agent.dispatchId })
    } catch (e) {
      return refuse(`could not tell whether it is live: ${e?.message ?? e}`, e)
    }
    if (!s.settled && !s.gone && !s.exited) {
      // Never offered for a worker still at work: only for one the journal
      // records failed and kept running.
      if (!keptRunning(agent)) return refuse('it is still live')
      if (!stop) {
        const tab = agent.terminal ? `close its tab ${agent.terminal} in Orca` : 'close its tab in Orca'
        return { ...refuse(`it failed and was kept with its worker still running, so Orca shows it live: only a reclaim that stops that worker first removes it (r, then f, in the run view), or ${tab} and reclaim it again`), stoppable: true }
      }
      stopFirst = true
    }
  }
  const worktree = ownWorktree(agent)
  const held = worktree && (await heldBack(worktree, { unpushed, force }))
  if (held) return { ...refuse(held.reason), ...(held.unpushed && { unpushed: held.unpushed }) }
  let tabs = open
  if (agent.terminal && !tabs) {
    try {
      tabs = await host.terminalList()
    } catch (e) {
      return refuse(`could not list Orca's terminals: ${e?.message ?? e}`, e)
    }
  }

  if (stopFirst) {
    try {
      await host.workerStop({ dispatch: agent.dispatchId })
    } catch (e) {
      return refuse(`its worker could not be stopped: ${e?.message ?? e}`, e)
    }
  }
  const notes = []
  if (agent.dispatchId) {
    try {
      await host.workerRelease({ dispatch: agent.dispatchId })
    } catch (e) {
      notes.push(`its worker was not released: ${e?.message ?? e}`)
    }
  }
  if (agent.terminal && tabs.includes(agent.terminal)) {
    try {
      await host.terminalClose({ terminal: agent.terminal })
    } catch (e) {
      // Closed between the list and the close.
      if (e?.code !== 'terminal_exited' && e?.code !== 'terminal_handle_stale') notes.push(`its tab was not closed: ${e?.message ?? e}`)
    }
  }
  if (worktree) {
    try {
      await host.worktreeRemove({ path: worktree })
    } catch (e) {
      if (e?.code !== 'selector_not_found') return refuse(`its worktree ${worktree} was not removed: ${e?.message ?? e}`, e)
    }
  }
  return { reclaimed: true, notes }
}

// What a sequential run's chain is kept or reclaimed as, beside its agents.
export const chainAgent = (chain) => ({ runId: chain.runId, n: null, title: worktreeName(chain.worktree), chain: true })

// A dispatch its host no longer knows has no worker live.
const unknownDispatch = (e) => e?.code === 'dispatch_not_found' || e?.code === 'selector_not_found'

// The one rule for a sequential run's chain worktree (ADR-0020), `chain` the
// journal's { runId, worktree }: the last step of reclaiming its whole run,
// removed only once `kept`, the agents of its run that reclaim kept, is empty
// and no agent the journal ran in it is live there now, reclaimed or not: a
// resume may have remade a reclaimed chain and carried a node on in it under
// the name the registry already records reclaimed. `journaled` is every agent
// the run's journal names (agentsOf). Commits no remote has keep it unless
// `force`; one already gone is reclaimed. Its reclaim is recorded in the run
// registry (`registry`, a runRegistry writer, or null) under `<runId>-chain`,
// so a later whole-run reclaim leaves it be until a resume. Answers as
// reclaimAgent does: { reclaimed: true, notes } or { reclaimed: false, reason },
// with `unpushed` and `unreachable` alike.
export async function reclaimChainAfter(kept, chain, { host, journaled, unpushed = worktreeUnpushed, force = false, registry = null }) {
  const refuse = (reason, e = null) => ({ reclaimed: false, reason, ...(hostUnreachable(host, e) && { unreachable: true }) })
  if (kept.length) return refuse('an agent of the run was kept')
  for (const a of journaled.filter((x) => x.runId === chain.runId && samePath(x.worktree, chain.worktree))) {
    if (!a.dispatchId) {
      if (a.launched !== false) return refuse(`could not tell whether ${a.title} is live in it: the journal names no dispatch for its worker`)
      continue
    }
    let s
    try {
      s = await host.workerShow({ dispatch: a.dispatchId })
    } catch (e) {
      if (unknownDispatch(e)) continue
      return refuse(`could not tell whether ${a.title} is live in it: ${e?.message ?? e}`, e)
    }
    if (!s.settled && !s.gone && !s.exited) return refuse(`${a.title} is still live in it`)
  }
  const held = await heldBack(chain.worktree, { unpushed, force })
  if (held) return { ...refuse(held.reason), ...(held.unpushed && { unpushed: held.unpushed }) }
  try {
    await host.worktreeRemove({ path: chain.worktree })
  } catch (e) {
    if (e?.code !== 'selector_not_found') return refuse(`its worktree ${chain.worktree} was not removed: ${e?.message ?? e}`, e)
  }
  const notes = []
  try {
    registry?.reclaimed({ runId: chain.runId, agent: chainName(chain.runId) })
  } catch (e) {
    notes.push(`the run registry did not record it: ${e?.message ?? e}`)
  }
  return { reclaimed: true, notes }
}

// Reclaims a run's agents, one at a time, except those `keep(agent)` names a
// reason to keep. Each reclaim is appended to the run registry (`registry`, a
// runRegistry writer, or null); once no agent of a run is left, so is the whole
// run, unless `closeRun` is false: a run that may still start agents must stay
// open, since no registry entry undoes a whole-run reclaim. A registry write
// that fails is reported through `out`, never thrown. `runId` names a run to
// close even with no agent left to reclaim. `chain`, the journal's chain of a
// sequential run, goes with the run it closes, by reclaimChainAfter over
// `journaled`, every agent its journal names; refused, it is kept as
// `{ agent: chainAgent(chain), reason }`, which keeps the run open too.
// Returns { reclaimed: [agent], kept: [{ agent, reason }] }, a kept one also
// `unreachable` when Orca was not there to reclaim it.
export async function reclaimRun(agents, { host, unpushed = worktreeUnpushed, force = false, keep = () => null, registry = null, closeRun = true, runId = null, chain = null, journaled = agents, out = () => {} }) {
  const record = (entry) => {
    try {
      registry?.reclaimed(entry)
    } catch (e) {
      out(`!! run registry: could not record the reclaim of ${entry.agent ?? entry.runId}: ${e?.message ?? e}`)
    }
  }
  const reclaimed = []
  const kept = []
  let open = null
  if (agents.some((a) => a.terminal && !keep(a))) {
    try {
      open = await host.terminalList()
    } catch (e) {
      out(`!! could not list Orca's terminals: ${e?.message ?? e}`)
    }
  }
  for (const agent of agents) {
    const why = keep(agent)
    if (why) {
      kept.push({ agent, reason: why })
      continue
    }
    const r = await reclaimAgent(agent, { host, unpushed, force, open })
    if (!r.reclaimed) {
      kept.push({ agent, reason: r.reason, ...(r.unreachable && { unreachable: true }) })
      continue
    }
    for (const note of r.notes) out(`!! ${agent.title}: ${note}`)
    reclaimed.push(agent)
    record({ runId: agent.runId, agent: agent.name })
  }
  if (chain && closeRun) {
    const agent = chainAgent(chain)
    const r = await reclaimChainAfter(kept.filter((k) => k.agent.runId === chain.runId), chain, { host, journaled, unpushed, force, registry })
    if (r.reclaimed) for (const note of r.notes) out(`!! ${agent.title}: ${note}`)
    else kept.push({ agent, reason: r.reason, ...(r.unreachable && { unreachable: true }), ...(r.unpushed && { unpushed: r.unpushed }) })
  }
  if (closeRun) for (const id of new Set([...agents.map((a) => a.runId), ...(chain ? [chain.runId] : []), ...(runId ? [runId] : [])])) {
    if (!kept.some((k) => k.agent.runId === id)) record({ runId: id })
  }
  return { reclaimed, kept }
}
