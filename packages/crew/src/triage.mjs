// Halt triage (#103): each new `at` of a run's halted.json is one question to
// the orchestrator, summarising the held nodes for the run console's halt
// panel. The question's record is triage/<at>.json in the run's state dir,
// created exclusively before it is asked: an `at` is asked once, however many
// consoles show the run and across their restarts, and a notice rewritten with
// a new `at` is a new question. A question never holds anything up: R resumes
// the run whatever became of it, and one that fails is recorded failed. One
// given up on because its console quit (the orchestrator closed) is no
// answer and no failure: its claim is dropped, and the next console to show
// the run asks it again.
//
// Only a console asks: a run that halts while nobody has it open in `crew
// view` is triaged when someone next opens it there (ADR-0018).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { TRIAGE_SCHEMA, triagePrompt } from './orchestrator.mjs'

// A question still asking this long after it was claimed has no asker left:
// the orchestrator answers within 15 minutes, or is given up on.
export const TRIAGE_STALE_MS = 20 * 60_000

// The run's halted.json, or null while it is not halted.
export function haltNoticeOf(stateDir) {
  try {
    const notice = JSON.parse(readFileSync(join(stateDir, 'halted.json'), 'utf8'))
    return typeof notice?.at === 'string' && Array.isArray(notice.nodes) ? notice : null
  } catch {
    return null
  }
}

export const triageFile = (stateDir, at) => join(stateDir, 'triage', `${at.replace(/[^\w.-]+/g, '-')}.json`)

// The question asked about `at`: { at, state: 'asking' | 'answered' |
// 'failed', since, answer?, error? }, or null while none is.
export function readTriage(stateDir, at, now = Date.now()) {
  let t
  try {
    t = JSON.parse(readFileSync(triageFile(stateDir, at), 'utf8'))
  } catch {
    return null
  }
  if (t.state === 'asking' && now - Date.parse(t.since) > TRIAGE_STALE_MS) return { ...t, state: 'failed', error: 'no answer was recorded: whatever asked it ended first' }
  return t
}

// Asks about the halt halted.json names now, unless its `at` was claimed
// already; the claim is made before this returns its promise, so a reader
// sees the question asking at once. `orchestrate()` gives the orchestrator to
// ask. Never rejects: { asked, state }.
export function triageHalt({ stateDir, orchestrate, now = () => Date.now() }) {
  const notice = haltNoticeOf(stateDir)
  if (!notice) return Promise.resolve({ asked: false, state: null })
  const file = triageFile(stateDir, notice.at)
  const since = new Date(now()).toISOString()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ at: notice.at, state: 'asking', since }), { flag: 'wx' })
  } catch {
    // Claimed by another asker, or a run dir nothing can be written in.
    return Promise.resolve({ asked: false, state: null })
  }
  const record = (entry) => {
    try {
      // Whole or not at all: a console reads it on every refresh.
      writeFileSync(`${file}.tmp`, JSON.stringify({ at: notice.at, since, ...entry }, null, 2))
      renameSync(`${file}.tmp`, file)
    } catch {}
    return { asked: true, state: entry.state }
  }
  return (async () => orchestrate().ask({ name: 'halt-triage', prompt: triagePrompt({ stateDir, notice }), schema: TRIAGE_SCHEMA }))()
    .then((answer) => record({ state: 'answered', answer }), (e) => {
      if (!e?.stopped) return record({ state: 'failed', error: e?.message ?? String(e) })
      rmSync(file, { force: true })
      return { asked: true, state: null }
    })
}

