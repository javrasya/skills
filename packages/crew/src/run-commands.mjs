// crew pause, crew resume and crew rm: what p, r and x do in the run view,
// from the command line, on a run named by its run id, its run folder (crew
// start's runs/<id>) or its state dir.
import { rmSync } from 'fs'
import { basename, join } from 'path'
import { samePath } from './paths.mjs'
import { REGISTRY_PATH, readRegistry, runRegistry } from './registry.mjs'
import { PAUSE_FILE, pausedAt } from './pause.mjs'
import { removeRun, runFolderOf, stopRunnerOf } from './remove.mjs'
import { writeJsonAtomic } from './fsutil.mjs'
import { worktreeUnpushed } from './git.mjs'

export function findRun(registry, target) {
  return readRegistry(registry).find((r) => r.runId === target || (r.runDir && (samePath(r.runDir, target) || samePath(runFolderOf(r.runDir), target) || basename(runFolderOf(r.runDir)) === target))) ?? null
}

function runOf(registry, target) {
  const run = findRun(registry, target)
  if (!run) throw new Error(`no run ${target} in the run registry: \`crew ls\` lists them`)
  if (!run.runDir) throw new Error(`${run.runId} has no run directory recorded`)
  return run
}

export function pauseCommand({ registry = REGISTRY_PATH, target, now = () => new Date() }) {
  const run = runOf(registry, target)
  if (pausedAt(run.runDir)) return `${run.runId} is already paused: \`crew resume ${run.runId}\` resumes it`
  writeJsonAtomic(join(run.runDir, PAUSE_FILE), { at: now().toISOString() })
  return `paused ${run.runId}: no new agent starts, and every agent at work finishes; \`crew resume ${run.runId}\` resumes it`
}

export function resumeCommand({ registry = REGISTRY_PATH, target }) {
  const run = runOf(registry, target)
  if (!pausedAt(run.runDir)) return `${run.runId} is not paused: a halted run or a dead runner is resumed with r in \`crew view ${run.runId}\``
  rmSync(join(run.runDir, PAUSE_FILE), { force: true })
  return `resumed ${run.runId}: the agents held by the pause start`
}

// ask(question): the operator's answer, one line. `yes` skips the run's
// confirmation, never a force-delete's.
export async function removeCommand({ registry = REGISTRY_PATH, target, host, ask, yes = false, unpushed = worktreeUnpushed, stopRunner = stopRunnerOf, out = () => {} }) {
  const run = runOf(registry, target)
  if (!yes) {
    const answer = await ask(`Remove run ${run.runId}? It stops its runner and every agent, reclaims its worktrees, forgets the run and deletes ${runFolderOf(run.runDir)}; its PRs on GitHub stay. [y/N] `)
    if (!/^y(es)?$/i.test(String(answer ?? '').trim())) return 'nothing removed'
  }
  const handle = await removeRun({ stateDir: run.runDir, runId: run.runId, host, registry: runRegistry(registry), unpushed, stopRunner, out })
  const kept = []
  for (const k of handle.kept) {
    if (!(k.unpushed > 0)) {
      kept.push(`${k.agent.title}: ${k.reason}`)
      continue
    }
    const answer = await ask(`Force-delete ${k.agent.worktree ?? k.agent.title}? ${k.reason}. [f = force-delete, anything else keeps it] `)
    if (String(answer ?? '').trim() !== 'f') continue
    const r = await handle.force(k)
    if (!r.reclaimed) kept.push(`${k.agent.title}: ${r.reason}`)
  }
  const { left } = handle.finish()
  return `removed ${run.runId}${left.length ? `; left on disk: ${left.join(', ')}` : ''}${kept.length ? `; kept ${kept.join('; ')}` : ''}`
}
