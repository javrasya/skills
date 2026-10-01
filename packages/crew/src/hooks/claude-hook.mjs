// crew's Claude Code hook, passed to a worker's session only (`claude
// --settings`, crew-host claudeSettings), never installed: Claude runs it with
// the hook's event as JSON on stdin, and it tells the crew daemon whether the
// session waits on the person (waiting.mjs). It prints nothing and exits 0,
// so Claude goes on as it would without it.
import { claudeWaiting } from '../waiting.mjs'
import { tell } from './tell.mjs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', async () => {
  try {
    await tell(claudeWaiting(JSON.parse(input)))
  } catch {}
  process.exit(0)
})
