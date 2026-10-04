// Where the daemon keeps its records (runs.mjs), the one seam between them and
// the disk: the daemon reads, writes and lists records here and never touches
// a file for them itself. A record is one of a kind's, under its key:
//
//   runs        run id      -> the Run, its acked batch ids an array
//   dispatches  session id  -> the dispatch
//   statuses    worktree    -> its status
//   sessions    session id  -> { command, cwd, title }
//   meta        name        -> messages, deliveries, nextSession, running
//
// The file store is the only one: the crew home's runs.json, in the shape it
// has always had, so a book an older daemon wrote reads back unchanged.
import { existsSync, readFileSync } from 'node:fs'
import { writeJsonAtomic } from '../fsutil.mjs'

export const KINDS = Object.freeze(['runs', 'dispatches', 'statuses', 'sessions', 'meta'])
// Kept in the file as an array of records, each its key as its id.
const ARRAYS = new Set(['runs', 'dispatches'])

/**
 * @typedef {[string, any]} StoreRecord
 * @typedef {{
 *   list: (kind: string) => StoreRecord[],
 *   read: (kind: string, key: string) => any,
 *   write: (records: Record<string, Iterable<StoreRecord>>) => void,
 * }} Store
 */

/** @returns {Store} */
export function fileStore(file) {
  let book = {}
  try {
    book = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) ?? {}) : {}
  } catch {
    // Written whole by rename, so only a hand-edited book fails to parse: the
    // daemon still starts, with no records.
  }
  const kindOf = (kind) => {
    if (!KINDS.includes(kind)) throw new Error(`not a kind of record the daemon keeps: ${JSON.stringify(kind)}`)
    return kind
  }
  const list = (kind) => {
    if (kindOf(kind) === 'meta') return Object.entries(book).filter(([name]) => !KINDS.includes(name))
    if (ARRAYS.has(kind)) return (book[kind] ?? []).map((record) => [String(record.id), record])
    return Object.entries(book[kind] ?? {})
  }
  return {
    list,
    read: (kind, key) => list(kind).find(([k]) => k === String(key))?.[1] ?? null,
    // Each kind named replaces every record of it; a kind not named keeps its
    // own. The whole book goes down at once, so a daemon killed mid-write
    // leaves the one it had.
    write(records) {
      for (const kind of Object.keys(records)) kindOf(kind)
      const next = {}
      for (const kind of KINDS) {
        const entries = Object.hasOwn(records, kind) ? [...records[kind]] : list(kind)
        if (kind === 'meta') Object.assign(next, Object.fromEntries(entries))
        else next[kind] = ARRAYS.has(kind) ? entries.map(([, record]) => record) : Object.fromEntries(entries)
      }
      writeJsonAtomic(file, next)
      book = next
    },
  }
}
