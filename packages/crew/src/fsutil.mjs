// Files written whole or not at all.
import { renameSync, writeFileSync } from 'fs'

// JSON to `file` by a temp file and a rename: a reader never sees half of it,
// and a writer killed mid-write leaves the file it had.
export function writeJsonAtomic(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}
