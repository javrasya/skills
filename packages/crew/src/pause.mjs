// A run paused by its operator: p in the run view, or `crew pause`. While the
// state dir holds PAUSE_FILE no new agent() call starts a worker; every agent
// already at work finishes as it would. The file is the pause, so it survives
// the runner and crew restarting: a runner that comes back on a paused run
// stays paused. r, or `crew resume`, removes it, and the held calls go on in
// call order. Unlike a halt (halt.mjs), a pause holds in-flight calls too:
// nothing new launches. The calls it holds wait in the hold queue (hold.mjs),
// the one a halt holds calls in too, so they go on in call order across both.
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './fsutil.mjs'
import { holdQueue } from './hold.mjs'

export const PAUSE_FILE = 'paused.json'

export const pausedAt = (stateDir) => existsSync(join(stateDir, PAUSE_FILE))

// Pauses the run in stateDir as of at (a Date): false if it was already paused.
export function pauseRun(stateDir, at) {
  if (pausedAt(stateDir)) return false
  writeJsonAtomic(join(stateDir, PAUSE_FILE), { at: at.toISOString() })
  return true
}

// Removes the run's pause: false if it was not paused.
export function unpauseRun(stateDir) {
  if (!pausedAt(stateDir)) return false
  rmSync(join(stateDir, PAUSE_FILE), { force: true })
  return true
}

// What p and `crew pause` say to a run already paused, and `crew resume` to
// one that is not: how names the way this caller resumes a run.
export const alreadyPaused = (how) => `already paused: ${how} resumes it`
export const notPaused = (how) => `not paused: a halted run or a dead runner is resumed with ${how}`

// journal(entry) appends a journal line; out(s) logs; sleep(ms) waits on the
// runner's clock; pollMs how often the runner looks for the pause gone while
// it holds a call; queue the hold queue (hold.mjs) the runner gates new calls
// on.
// Returns {
//   on()          whether the run is paused now, journaling a change
//   lift()        removes the pause (r): true if there was one
// }
export function runPause({ stateDir, journal, out, sleep, pollMs, queue = holdQueue() }) {
  let paused = false
  let polling = false
  function on() {
    const now = pausedAt(stateDir)
    if (now === paused) return paused
    paused = now
    journal({ type: paused ? 'pause' : 'unpause' })
    out(paused ? '!!!!!!!! PAUSED: no new agent starts, and every agent at work finishes; r to resume' : '>> the run is resumed: held agents start')
    return paused
  }
  // One poll releases every call held, in call order, not each at its own
  // poll's next tick.
  async function poll() {
    polling = true
    while (on()) await sleep(pollMs)
    polling = false
    queue.release()
  }
  // While paused, every new call is held, an in-flight one too.
  queue.join({
    holds: () => on(),
    held({ key, n, node = null, title }) {
      journal({ type: 'held', key, n, ...(node && { node }), title, paused: true })
      out(`.. ${title}: held, the run is paused`)
      if (!polling) poll()
    },
  })
  // on() first: a pause written since the runner last looked is journaled
  // before its unpause.
  function lift() {
    if (!on()) return false
    unpauseRun(stateDir)
    on()
    queue.release()
    return true
  }
  return { on, lift }
}
