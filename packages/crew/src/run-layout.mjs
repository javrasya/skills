// Where a run's files live. A crew start run has a run folder of its own,
// <notes dir>/runs/<id>, and its state dir is the folder's orca-run. Any other
// run has a state dir alone, beside its script (launchRunner's default).
import { basename, dirname, join } from 'node:path'

const RUNS = 'runs'
const STATE_DIR = 'orca-run'

export const stateDirOf = (dir) => join(dir, STATE_DIR)
export const runFolderOf = (notesDir, id) => join(notesDir, RUNS, id)
// The inverse of the two: the run folder a state dir lies in, or, for a run
// that has none, the state dir itself.
export const runFolderOfStateDir = (stateDir) => (basename(stateDir) === STATE_DIR && basename(dirname(dirname(stateDir))) === RUNS ? dirname(stateDir) : stateDir)
