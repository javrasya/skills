// Reclaim (ADR-0012): the operator's act of removing an agent's tab and
// worktree, for one agent or a whole run. Nothing is reclaimed while a run
// runs; the runner's end-of-run prompt and the run view both reclaim through
// here, so both keep the same rules:
//   - an agent still live is refused;
//   - a worktree holding unpushed commits is removed only when forced;
//   - a worktree is the run's only by its `<runId>-<n>` name — any other is
//     the operator's own, and never touched;
//   - reclaiming releases the worker, closes its tab if Orca's terminal list
//     still shows it, and removes its worktree.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { basename } from 'path'
import { madeByRun, readJournal } from './journal.mjs'

// Commits reachable from the worktree's HEAD that no remote-tracking ref
// contains (D6 on #43). Uncommitted files do not count. A worktree already gone
// from disk holds none.
export function gitUnpushed(path) {
  if (!existsSync(path)) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', path, 'rev-list', '--count', 'HEAD', '--not', '--remotes'], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git rev-list in ${path}: ${String(stderr || err.message).trim()}`))
      resolve(Number(String(stdout).trim()))
    })
  })
}

// The agents a run's journal names, by the fold every reader of it shares
// (journal.mjs), in call order:
//   { runId, n, origin, name, title, launched, dispatchId, terminal, worktree,
//     harness, state, reason }
// Every agent its Run holds: a resumed run's journal carries forward the ones
// earlier runners of that Run made, finished, failed or still out, so a
// resume renames none and drops none. name is its worktree's name, the
// `<runId>-<n>` Orca made it, where n is its origin, the call that started its
// worker; one with no worktree of its own is named as it would have been. It is
// what the run registry records a reclaim under. launched: a worker was started
// for it. state is 'ok' for a call that returned a value, 'failed' for one
// that returned null (dead, or settled with no valid result), 'running' for
// one with no settlement journaled. A call whose worker never started is an
// agent only if Orca made it a worktree, and then has no dispatch or tab. A
// call replayed from the journal is the agent that first returned its value.
export function agentsOf(journalPath) {
  return readJournal(journalPath).agents.filter(madeByRun).map((a) => ({
    runId: a.runId, n: a.n, origin: a.origin, name: agentName(a), title: a.title, launched: a.launched, dispatchId: a.dispatchId,
    terminal: a.terminal, worktree: a.worktree, harness: a.harness, state: a.state === 'done' ? 'ok' : a.state === 'failed' ? 'failed' : 'running', reason: a.reason,
  }))
}

// The worktree reclaim may remove, and the run view may show: one the run
// created, by its name.
export const ownWorktree = (a) => (a.worktree && basename(a.worktree).startsWith(`${a.runId}-`) ? a.worktree : null)

// The name the run registry records an agent's reclaim under.
export const agentName = (a) => (ownWorktree(a) ? basename(ownWorktree(a)) : `${a.runId}-${a.origin ?? a.n}`)

// Reclaims one agent: { reclaimed: true, notes } or { reclaimed: false, reason }.
// Every check runs before anything is changed, so a refused agent is left
// exactly as it was. `open`: the terminal list's handles, when the caller has
// already read it for a batch.
export async function reclaimAgent(agent, { orca, unpushed = gitUnpushed, force = false, open = null }) {
  const refuse = (reason) => ({ reclaimed: false, reason })
  // A missing dispatch is never proof its worker is not live: only an agent
  // the journal shows no worker ever started for skips the check. A failed
  // agent kept with its process left running is exactly the one to refuse.
  if (!agent.dispatchId && agent.launched !== false) return refuse('could not tell whether it is live: the journal names no dispatch for its worker')
  if (agent.dispatchId) {
    let s
    try {
      s = await orca.workerShow({ dispatch: agent.dispatchId })
    } catch (e) {
      return refuse(`could not tell whether it is live: ${e?.message ?? e}`)
    }
    if (!s.settled && !s.gone && !s.exited) return refuse('it is still live')
  }
  const worktree = ownWorktree(agent)
  if (worktree && !force) {
    let ahead
    try {
      ahead = await unpushed(worktree)
    } catch (e) {
      return refuse(`could not tell whether ${worktree} holds unpushed commits: ${e?.message ?? e}`)
    }
    if (ahead > 0) return { ...refuse(`${worktree} holds ${ahead} unpushed commit${ahead === 1 ? '' : 's'}; only a forced reclaim removes it`), unpushed: ahead }
  }
  let tabs = open
  if (agent.terminal && !tabs) {
    try {
      tabs = await orca.terminalList()
    } catch (e) {
      return refuse(`could not list Orca's terminals: ${e?.message ?? e}`)
    }
  }

  const notes = []
  if (agent.dispatchId) {
    try {
      await orca.workerRelease({ dispatch: agent.dispatchId })
    } catch (e) {
      notes.push(`its worker was not released: ${e?.message ?? e}`)
    }
  }
  if (agent.terminal && tabs.includes(agent.terminal)) {
    try {
      await orca.terminalClose({ terminal: agent.terminal })
    } catch (e) {
      // Closed between the list and the close.
      if (e?.code !== 'terminal_exited' && e?.code !== 'terminal_handle_stale') notes.push(`its tab was not closed: ${e?.message ?? e}`)
    }
  }
  if (worktree) {
    try {
      await orca.worktreeRemove({ path: worktree })
    } catch (e) {
      if (e?.code !== 'selector_not_found') return refuse(`its worktree ${worktree} was not removed: ${e?.message ?? e}`)
    }
  }
  return { reclaimed: true, notes }
}

// Reclaims a run's agents, one at a time, except those `keep(agent)` names a
// reason to keep. Each reclaim is appended to the run registry (`registry`, a
// runRegistry writer, or null); once no agent of a run is left, so is the whole
// run, unless `closeRun` is false: a run that may still start agents must stay
// open, since no registry entry undoes a whole-run reclaim. A registry write
// that fails is reported through `out`, never thrown.
// Returns { reclaimed: [agent], kept: [{ agent, reason }] }.
export async function reclaimRun(agents, { orca, unpushed = gitUnpushed, force = false, keep = () => null, registry = null, closeRun = true, out = () => {} }) {
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
      open = await orca.terminalList()
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
    const r = await reclaimAgent(agent, { orca, unpushed, force, open })
    if (!r.reclaimed) {
      kept.push({ agent, reason: r.reason })
      continue
    }
    for (const note of r.notes) out(`!! ${agent.title}: ${note}`)
    reclaimed.push(agent)
    record({ runId: agent.runId, agent: agent.name })
  }
  if (closeRun) for (const runId of new Set(agents.map((a) => a.runId))) {
    if (!kept.some((k) => k.agent.runId === runId)) record({ runId })
  }
  return { reclaimed, kept }
}

// The three answers to the end-of-run prompt, and what each keeps. The default
// keeps the failed and dead agents — every call that came back null — and any
// that never settled; it reclaims the rest.
export const END_CHOICES = Object.freeze(['default', 'all', 'none'])

export function keepFor(choice) {
  if (choice === 'all') return () => null
  if (choice === 'none') return () => 'you chose to keep every agent'
  return (a) => (a.state === 'ok' ? null : a.state === 'failed' ? `it failed: ${a.reason ?? 'no result'}` : 'it never settled')
}

// Enter, `a` or `n`; anything else is asked again. No answer at all (stdin
// closed) keeps everything: nothing is removed without the operator.
export function parseChoice(answer) {
  if (answer === null || answer === undefined) return 'none'
  const a = String(answer).trim().toLowerCase()
  if (a === '') return 'default'
  if (a === 'a' || a === 'all') return 'all'
  if (a === 'n' || a === 'none') return 'none'
  return null
}

// The end-of-run prompt: names what the default keeps, asks with
// `ask(question, { title, lines })` (resolving to the answer, or null once there
// can be none), reclaims, and names every agent kept and why. title and lines
// are what was printed before the question, for a caller that shows the
// prompt somewhere else than the log: the run view draws them as its modal.
// No agents, no prompt.
export async function endOfRunPrompt({ agents, ask, out, ...rest }) {
  if (!agents.length) return null
  const byDefault = keepFor('default')
  const keptByDefault = agents.filter((a) => byDefault(a))
  const lines = []
  const show = (s) => {
    lines.push(s.trim())
    out(s)
  }
  out('== Reclaim')
  show(`   ${agents.length} agent${agents.length === 1 ? '' : 's'} kept their tab and worktree through this run. Reclaiming one closes its tab and removes its worktree.`)
  if (keptByDefault.length) {
    show(`   The default keeps ${keptByDefault.length} failed or dead:`)
    for (const a of keptByDefault) show(`     ${a.title} (${byDefault(a)})`)
  } else {
    show('   None failed or died.')
  }
  const question = `   Enter = keep those and reclaim the other ${agents.length - keptByDefault.length}, a = reclaim all, n = keep all: `
  let choice = null
  let answer
  while (!choice) {
    answer = await ask(question, { title: 'The run ended. Reclaim what?', lines })
    choice = parseChoice(answer)
    if (!choice) out(`?? "${answer}" is not an answer: press Enter, a or n`)
  }
  out(`   ${answer === null ? 'no answer: keeping every agent' : `chosen: ${choice}`}`)
  const outcome = await reclaimRun(agents, { ...rest, out, keep: keepFor(choice) })
  for (const a of outcome.reclaimed) out(`<< reclaimed ${a.title}`)
  for (const { agent, reason } of outcome.kept) out(`!! kept ${agent.title}${agent.worktree ? ` in ${agent.worktree}` : ''}${agent.terminal ? `, tab ${agent.terminal}` : ''}: ${reason}`)
  return { choice, ...outcome }
}
