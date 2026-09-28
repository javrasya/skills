// Raw terminal input as key names, by a table of the sequences a screen takes.

export const ARROW_KEYS = [
  ['\x1b[A', 'up'], ['\x1bOA', 'up'], ['\x1b[B', 'down'], ['\x1bOB', 'down'],
  ['\x1b[C', 'right'], ['\x1bOC', 'right'], ['\x1b[D', 'left'], ['\x1bOD', 'left'],
]
export const ENTER_KEYS = [['\r\n', 'enter'], ['\r', 'enter'], ['\n', 'enter']]

// The keys in one chunk of raw input, by `table` ([sequence, name] pairs, the
// first match winning). An escape no sequence of the table starts is Esc
// ('cancel') when it is alone, and skipped whole when it is a sequence the
// table does not name: the chunk carries the whole sequence, as raw input
// delivers a keypress. Any other character is `char(c)`'s key, or none when
// it answers nothing.
export function decodeKeys(chunk, table, { char = () => null } = {}) {
  const keys = []
  for (let i = 0; i < chunk.length;) {
    const hit = table.find(([seq]) => chunk.startsWith(seq, i))
    if (hit) {
      keys.push(hit[1])
      i += hit[0].length
    } else if (chunk[i] === '\x1b') {
      const seq = /^\x1b(\[[0-9;]*[~A-Za-z]|O[A-Za-z])?/.exec(chunk.slice(i))[0]
      if (seq.length === 1) keys.push('cancel')
      i += seq.length
    } else {
      const c = String.fromCodePoint(chunk.codePointAt(i))
      const key = char(c)
      if (key != null) keys.push(key)
      i += c.length
    }
  }
  return keys
}
