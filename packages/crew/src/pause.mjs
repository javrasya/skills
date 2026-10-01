// A run paused by its operator: p in the run view, or `crew pause`. While the
// state dir holds PAUSE_FILE no new agent() call starts a worker; every agent
// already at work finishes as it would. The file is the pause, so it survives
// the runner and crew restarting: a runner that comes back on a paused run
// stays paused. r, or `crew resume`, removes it, and the held calls go on in
// call order. Unlike a halt (halt.mjs), a pause holds in-flight calls too:
// nothing new launches.
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

export const PAUSE_FILE = 'paused.json'

export const pausedAt = (stateDir) => existsSync(join(stateDir, PAUSE_FILE))

// journal(entry) appends a journal line; out(s) logs; sleep(ms) waits on the
// runner's clock; pollMs how often a held call looks for the pause gone.
// Returns {
//   on()          whether the run is paused now, journaling a change
//   gate(call)    for a new call: null while not paused, else a promise that
//                 resolves once the pause is gone
//   lift()        removes the pause (r): true if there was one
// }
export function runPause({ stateDir, journal, out, sleep, pollMs }) {
  const file = join(stateDir, PAUSE_FILE)
  let paused = false
  // The calls held, each its release, in call order. One poll releases them
  // all, so they go on in call order, not each at its own poll's next tick.
  const waiting = []
  let polling = false
  function on() {
    const now = existsSync(file)
    if (now === paused) return paused
    paused = now
    journal({ type: paused ? 'pause' : 'unpause' })
    out(paused ? '!!!!!!!! PAUSED: no new agent starts, and every agent at work finishes; r to resume' : '>> the run is resumed: held agents start')
    return paused
  }
  const release = () => {
    for (const go of waiting.splice(0)) go()
  }
  async function poll() {
    polling = true
    while (on()) await sleep(pollMs)
    polling = false
    release()
  }
  function gate({ key, n, node = null, title }) {
    if (!on()) return null
    journal({ type: 'held', key, n, ...(node && { node }), title, paused: true })
    out(`.. ${title}: held, the run is paused`)
    const held = new Promise((go) => waiting.push(go))
    if (!polling) poll()
    return held
  }
  // on() first: a pause written since the runner last looked is journaled
  // before its unpause.
  function lift() {
    if (!on()) return false
    rmSync(file, { force: true })
    on()
    release()
    return true
  }
  return { on, gate, lift }
}
