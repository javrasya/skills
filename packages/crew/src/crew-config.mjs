// Crew's own config: ~/.crew/config.json (crewPaths().config), every key optional.
//   { "backKey": "f12" }   the key that leaves an entered session for the list
import { readFileSync } from 'fs'

export const DEFAULTS = Object.freeze({ backKey: 'f12' })

// The bytes each key arrives as in raw input. The F-keys have a few spellings:
// xterm's, the VT220's, and libuv's on the Windows console (F12 is ESC[24~ in all).
const FKEYS = {
  f1: ['\x1bOP', '\x1b[11~', '\x1b[[A'],
  f2: ['\x1bOQ', '\x1b[12~', '\x1b[[B'],
  f3: ['\x1bOR', '\x1b[13~', '\x1b[[C'],
  f4: ['\x1bOS', '\x1b[14~', '\x1b[[D'],
  f5: ['\x1b[15~', '\x1b[[E'],
  f6: ['\x1b[17~'],
  f7: ['\x1b[18~'],
  f8: ['\x1b[19~'],
  f9: ['\x1b[20~'],
  f10: ['\x1b[21~'],
  f11: ['\x1b[23~'],
  f12: ['\x1b[24~'],
}
// pi binds both, so a back key there would take them from the session.
const REFUSED = { 'ctrl+left': 'pi binds Ctrl+Left', 'ctrl+]': 'pi binds Ctrl+]' }
// Ctrl+H, I, J and M are Backspace, Tab and Enter to a program.
const CTRL = 'abcdefgklnopqrstuvwxyz'

export const BACK_KEYS = [...Object.keys(FKEYS), ...[...CTRL].map((c) => `ctrl+${c}`)]

// The byte sequences a back key name arrives as.
export function backKeySequences(name) {
  const key = String(name).trim().toLowerCase()
  if (REFUSED[key]) throw new Error(`back key ${name} cannot be used: ${REFUSED[key]}`)
  if (FKEYS[key]) return FKEYS[key]
  const ctrl = /^ctrl\+([a-z])$/.exec(key)
  if (ctrl && CTRL.includes(ctrl[1])) return [String.fromCharCode(ctrl[1].charCodeAt(0) - 96)]
  throw new Error(`back key ${name} is not one crew knows; use one of ${BACK_KEYS.join(', ')}`)
}

export function readCrewConfig(paths) {
  let text
  try {
    text = readFileSync(paths.config, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULTS }
    throw e
  }
  let config
  try {
    config = JSON.parse(text)
  } catch (e) {
    throw new Error(`${paths.config}: not JSON (${e.message})`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${paths.config}: not a JSON object`)
  const merged = { ...DEFAULTS, ...config }
  try {
    backKeySequences(merged.backKey)
  } catch (e) {
    throw new Error(`${paths.config}: ${e.message}`)
  }
  return merged
}
