// One path however it is spelled.
import { resolve } from 'path'

// A path's key, so two spellings of it compare equal: resolved, no trailing
// separator, and on Windows forward slashes and case-folded.
export const pathKey = (p, platform = process.platform) => {
  const r = resolve(p).replace(/(.)[\\/]+$/, '$1')
  return platform === 'win32' ? r.replace(/\\/g, '/').toLowerCase() : r
}

// Whether a and b name one path; a missing one names none.
export const samePath = (a, b, platform = process.platform) => !!a && !!b && pathKey(a, platform) === pathKey(b, platform)
