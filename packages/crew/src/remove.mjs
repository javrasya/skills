// Removing a run (x in the run view, `crew rm`): its runner stopped, every
// agent's worker stopped, the whole run reclaimed, then the run forgotten —
// a `removed` line in the run registry, which drops it from every list — and
// its folder deleted. Its PRs on GitHub stay. A worktree holding commits no
// remote has is never removed unasked: removeRun returns each as `kept`, the
// caller asks the operator about each, one at a time, and `force` removes
// the ones they say to; finish() forgets the run whatever was left, naming it.
import { rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { readJournal } from './journal.mjs'
import { agentsOf, reclaimAgent, reclaimChainAfter, reclaimRun } from './reclaim.mjs'
import { runnerAlive, runnerPid } from './run-view-model.mjs'
import { worktreeUnpushed } from './git.mjs'

// The folder a run lives in: crew start's own run folder (runs/<id>/), or
// for any other run its state dir alone.
export const runFolderOf = (stateDir) => (basename(stateDir) === 'orca-run' && basename(dirname(dirname(stateDir))) === 'runs' ? dirname(stateDir) : stateDir)

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
  const { kept } = await reclaimRun(agents, { host, unpushed, registry, runId, chain, journaled: agents, out })
  const left = new Set(kept)
  const pathOf = (k) => (k.agent.chain ? chain.worktree : k.agent.worktree)
  return {
    kept,
    async force(k) {
      const r = k.agent.chain
        ? await reclaimChainAfter([], chain, { host, journaled: agents, unpushed, force: true, registry })
        : await reclaimAgent(k.agent, { host, unpushed, force: true })
      if (r.reclaimed) left.delete(k)
      return r
    },
    finish() {
      registry?.removed({ runId })
      rmSync(runFolderOf(stateDir), { recursive: true, force: true })
      return { left: [...left].map(pathOf).filter(Boolean) }
    },
  }
}
