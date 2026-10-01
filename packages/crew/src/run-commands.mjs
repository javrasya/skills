// crew pause, crew resume and crew rm: what p, r and x do in the run view,
// from the command line, on a run named by its run id, its run folder (crew
// start's runs/<id>) or its state dir.
import { basename } from 'path'
import { samePath } from './paths.mjs'
import { REGISTRY_PATH, readRegistry, runRegistry } from './registry.mjs'
import { alreadyPaused, notPaused, pauseRun, unpauseRun } from './pause.mjs'
import { leftOnDisk, removeRun, stopRunnerOf } from './remove.mjs'
import { runFolderOfStateDir } from './run-layout.mjs'
import { worktreeUnpushed } from './git.mjs'

export function findRun(registry, target) {
  return readRegistry(registry).find((r) => r.runId === target || (r.runDir && (samePath(r.runDir, target) || samePath(runFolderOfStateDir(r.runDir), target) || basename(runFolderOfStateDir(r.runDir)) === target))) ?? null
}

function runOf(registry, target) {
  const run = findRun(registry, target)
  if (!run) throw new Error(`no run ${target} in the run registry: \`crew ls\` lists them`)
  if (!run.runDir) throw new Error(`${run.runId} has no run directory recorded`)
  return run
}

export function pauseCommand({ registry = REGISTRY_PATH, target, now = () => new Date() }) {
  const run = runOf(registry, target)
  if (!pauseRun(run.runDir, now())) return `${run.runId} is ${alreadyPaused(`\`crew resume ${run.runId}\``)}`
  return `paused ${run.runId}: no new agent starts, and every agent at work finishes; \`crew resume ${run.runId}\` resumes it`
}

export function resumeCommand({ registry = REGISTRY_PATH, target }) {
  const run = runOf(registry, target)
  if (!unpauseRun(run.runDir)) return `${run.runId} is ${notPaused(`r in \`crew view ${run.runId}\``)}`
  return `resumed ${run.runId}: the agents held by the pause start`
}

// ask(question): the operator's answer, one line. `yes` skips the run's
// confirmation, never a force-delete's. openHost(run): the run's host, opened
// only once the run is found.
export async function removeCommand({ registry = REGISTRY_PATH, target, openHost, ask, yes = false, unpushed = worktreeUnpushed, stopRunner = stopRunnerOf, out = () => {} }) {
  const run = runOf(registry, target)
  if (!yes) {
    const answer = await ask(`Remove run ${run.runId}? It stops its runner and every agent, reclaims its worktrees, forgets the run and deletes ${runFolderOfStateDir(run.runDir)}; its PRs on GitHub stay. [y/N] `)
    if (!/^y(es)?$/i.test(String(answer ?? '').trim())) return 'nothing removed'
  }
  const handle = await removeRun({ stateDir: run.runDir, runId: run.runId, host: await openHost(run), registry: runRegistry(registry), unpushed, stopRunner, out })
  for (const k of handle.kept.filter((k) => k.unpushed > 0)) {
    const answer = await ask(`Force-delete ${k.worktree ?? k.agent.title}? ${k.reason}. [f = force-delete, anything else keeps it] `)
    if (String(answer ?? '').trim() === 'f') await handle.force(k)
  }
  return `removed ${run.runId}${leftOnDisk(handle.finish().left)}`
}
