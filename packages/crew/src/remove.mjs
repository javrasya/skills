// Removing a run (x in the run view, `crew rm`): its runner stopped, every
// agent's worker stopped, the whole run reclaimed, then the run forgotten —
// a `removed` line in the run registry, which drops it from every list — and
// its folder deleted. Its PRs on GitHub stay. A worktree holding commits no
// remote has is never removed unasked: removeRun returns each as `kept`, the
// caller asks the operator about each, one at a time, and `force` removes
// the ones they say to; finish() forgets the run whatever was left, naming
// each once, with why it was left. Each kept one carries `worktree`, its path:
// the chain's is its run's, not its agent's, which chainAgent leaves unset.
import { rmSync } from 'fs'
import { join } from 'path'
import { readJournal } from './journal.mjs'
import { agentsOf, reclaimAgent, reclaimChainAfter, reclaimRun } from './reclaim.mjs'
import { runnerAlive, runnerPid } from './run-view-model.mjs'
import { worktreeUnpushed } from './git.mjs'
import { runFolderOfStateDir } from './run-layout.mjs'
import { consoleTitle, consultSessions } from './orchestrator.mjs'

// finish()'s `left`, as the words that end a removal's message.
export const leftOnDisk = (left) => (left.length ? `; left on disk: ${left.map((l) => `${l.worktree ?? l.title} (${l.reason})`).join('; ')}` : '')

// Ends the runner whose runner.pid the state dir names, and waits, up to
// `waitMs`, for it to be gone.
export async function stopRunnerOf(stateDir, { waitMs = 5_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const pid = runnerPid(stateDir)
  if (!pid || runnerAlive(stateDir) !== true) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
  for (let waited = 0; waited < waitMs && runnerAlive(stateDir) === true; waited += 100) await sleep(100)
}

export async function removeRun({ stateDir, runId, host, registry = null, unpushed = worktreeUnpushed, out = () => {}, stopRunner = stopRunnerOf }) {
  await stopRunner(stateDir)
  const journalPath = join(stateDir, 'journal.jsonl')
  const agents = agentsOf(journalPath)
  const { chain } = readJournal(journalPath)
  // A worker still at work, or kept running, is stopped: nothing of the run
  // goes on once it is removed.
  for (const a of agents) {
    if (!a.dispatchId) continue
    try {
      const s = await host.workerShow({ dispatch: a.dispatchId })
      if (!s.settled && !s.gone && !s.exited) await host.workerStop({ dispatch: a.dispatchId })
    } catch (e) {
      out(`!! ${a.title}: its worker could not be stopped: ${e?.message ?? e}`)
    }
  }
  // The run's `?` sessions go with it (#168): each still started is closed;
  // one closed already, or never started, has no session to close. The
  // record goes with the folder.
  for (const s of consultSessions(stateDir)) {
    if (s.state !== 'started') continue
    try {
      await host.terminalClose({ terminal: s.terminal })
    } catch (e) {
      out(`!! ${consoleTitle(s.n)}: its session could not be closed: ${e?.message ?? e}`)
    }
  }
  const kept = (await reclaimRun(agents, { host, unpushed, registry, runId, chain, journaled: agents, out })).kept.map((k) => ({ ...k, worktree: k.agent.chain ? chain.worktree : k.agent.worktree }))
  // Each kept one still on disk, and why: its reclaim's reason, or a failed force's.
  const left = new Map(kept.map((k) => [k, k.reason]))
  return {
    kept,
    async force(k) {
      const r = k.agent.chain
        ? await reclaimChainAfter([], chain, { host, journaled: agents, unpushed, force: true, registry })
        : await reclaimAgent(k.agent, { host, unpushed, force: true })
      if (r.reclaimed) left.delete(k)
      else left.set(k, r.reason)
      return r
    },
    finish() {
      registry?.removed({ runId })
      rmSync(runFolderOfStateDir(stateDir), { recursive: true, force: true })
      return { left: [...left].map(([k, reason]) => ({ worktree: k.worktree ?? null, title: k.agent.title, reason })) }
    },
  }
}
