// An Orca outage (ADR-0015): a stretch in which Orca itself is not there — its
// app down or restarting, as while it updates, or its CLI unable to run — as
// the host's unreachable(e) (session-host.mjs) tells it from an Orca that
// answered. It is one event for the whole run, never an agent's: every Orca
// call the runner makes goes through guard(), which holds a call that finds Orca gone on the one
// outage under way and runs it again once Orca answers, so no watch error,
// start attempt, nudge, continuation or doctor round is spent on it. One probe
// at a time looks for Orca, however many calls wait on it.

// When each probe of an outage comes, in ms since it began: after
// outageProbeMs, each wait twice the last up to outageProbeMaxMs, one at
// outageLimitMs itself, where a run still waiting pauses, then every
// pausedProbeMs.
export function* probeTimes(limits) {
  let t = 0
  let every = limits.outageProbeMs
  for (;;) {
    if (t >= limits.outageLimitMs) {
      t += limits.pausedProbeMs
    } else {
      t = Math.min(t + every, limits.outageLimitMs)
      every = Math.min(every * 2, limits.outageProbeMaxMs)
    }
    yield t
  }
}

// How many probes an outage has had `ms` into it, by the schedule: what the
// run view counts, since the journal holds only an outage's start and end.
export function probesBy(ms, limits) {
  let k = 0
  for (const t of probeTimes(limits)) {
    if (t > ms) return k
    k++
  }
}

// probe() is a cheap Orca call, never itself guarded. on(event) hears
// { phase: 'start', since, at, reason }, { phase: 'paused', since, at } and
// { phase: 'end', since, at, ms, paused }: since is when it began, at now,
// both the clock's, and ms its length. Returns:
//   guard(fn)   runs fn, one Orca call, waiting out every outage it meets: a
//               call made while one is under way waits before it asks Orca
//   state()     null, or { phase: 'waiting' | 'paused', since }
//   lost()      the ms the run has spent in outages, the one under way
//               included, which the runner takes off its own clocks
//   sleep(ms)   waits ms of time Orca was there: a retry's backoff
//   resume()    probes at once, sharing a probe already out: { back, outage },
//               back once Orca answered, outage whether there was one
export function hostOutage({ clock, limits, probe, unreachable, on = () => {} }) {
  let current = null
  let ended = 0
  let probing = null

  // True unless the probe found Orca still gone: an Orca that answers with
  // an error, or not in time, is there, and the call it held meets that itself.
  const ask = () =>
    (probing ??= Promise.resolve()
      .then(probe)
      .then(
        () => true,
        (e) => !unreachable(e),
      )
      .finally(() => {
        probing = null
      }))

  const lost = () => ended + (current ? clock.now() - current.since : 0)

  function over(o, quiet = false) {
    if (current !== o) return
    current = null
    const ms = clock.now() - o.since
    ended += ms
    try {
      if (!quiet) on({ phase: 'end', since: o.since, at: clock.now(), ms, paused: o.phase === 'paused' })
    } finally {
      o.end()
    }
  }

  async function outlast(o) {
    for (const t of probeTimes(limits)) {
      const timer = clock.timer(Math.max(0, o.since + t - clock.now()))
      await Promise.race([timer.promise, o.over])
      timer.cancel()
      if (current !== o) return
      const back = await ask()
      if (current !== o) return
      if (back) return over(o)
      if (o.phase === 'waiting' && clock.now() - o.since >= limits.outageLimitMs) {
        o.phase = 'paused'
        on({ phase: 'paused', since: o.since, at: clock.now() })
      }
    }
  }

  function begin(e) {
    const o = { since: clock.now(), phase: 'waiting' }
    o.over = new Promise((r) => {
      o.end = r
    })
    current = o
    // A journal or log that throws must not leave every call waiting for good:
    // the calls are let go, and meet Orca, gone or not, themselves.
    outlast(o).catch(() => over(o, true))
    on({ phase: 'start', since: o.since, at: o.since, reason: e?.message ?? String(e) })
  }

  return {
    async guard(fn) {
      for (;;) {
        if (current) await current.over
        try {
          return await fn()
        } catch (e) {
          if (!unreachable(e)) throw e
          if (!current) begin(e)
        }
      }
    },
    state: () => (current ? { phase: current.phase, since: current.since } : null),
    lost,
    async sleep(ms) {
      for (let left = ms; left > 0; ) {
        const from = lost()
        await clock.sleep(left)
        left = lost() - from
      }
    },
    async resume() {
      const o = current
      if (!o) return { back: true, outage: false }
      const back = await ask()
      if (back) over(o)
      return { back, outage: true }
    },
  }
}
