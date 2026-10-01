// The one queue of new agent() calls held from starting, shared by every gate
// that can hold one: the halt (halt.mjs), then the operator's pause
// (pause.mjs). A call joins it once, as it is made, and leaves it only once no
// gate holds it, so held calls start in call order whichever gate held them
// and whichever cleared first: a call held by the halt and then by the pause
// keeps its place ahead of a later call the pause alone held.
//
// A gate is { holds(opts), held(call) }: holds says whether it holds a new
// call made with those agent() options now; held journals and logs that it
// holds that call, once each time the gate holding a call changes.
// Returns {
//   join(gate)    adds a gate; the first joined is asked first
//   gate(call, opts)
//                 for a new call: null while no gate holds it, else a promise
//                 that resolves once none does
//   release()     after a gate cleared: every held call no gate holds now
//                 goes on, in call order
//   count(gate)   how many calls that gate holds
// }
export function holdQueue() {
  const gates = []
  // { call, opts, by, go }, in call order: by is the gate holding it.
  const waiting = []
  const holder = (opts) => gates.find((g) => g.holds(opts)) ?? null

  function gate(call, opts = {}) {
    const by = holder(opts)
    if (!by) return null
    by.held(call)
    return new Promise((go) => waiting.push({ call, opts, by, go }))
  }

  function release() {
    for (const w of [...waiting]) {
      const by = holder(w.opts)
      if (by) {
        if (by !== w.by) {
          w.by = by
          by.held(w.call)
        }
        continue
      }
      waiting.splice(waiting.indexOf(w), 1)
      w.go()
    }
  }

  return { join: (g) => gates.push(g), gate, release, count: (g) => waiting.filter((w) => w.by === g).length }
}
