// A stand-in for a worker's harness, run by the host contract suite in a real
// pty from the runner's own launch line (`--session-id <id>` or `--resume
// <id>`; `--approve` makes it pi, else it is Claude). Like the TUI it plays,
// it leaves a line on the normal screen, switches to the alternate screen
// with bracketed paste on and its cursor hidden, and draws a header and an
// input line. Keys and pastes land in the input; Enter outside a paste
// submits it: the prompt is shown with an echo, and written to the session's
// transcript in the harness's own format, where the runner finds it by the
// session id. Ctrl-U empties the input. Between prompts it idles.
import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { claudeDir, claudeSlug, piDir } from '../../../src/transcript.mjs'

const argv = process.argv.slice(2)
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null)
const harness = argv.includes('--approve') ? 'pi' : 'claude'
const sessionId = after('--session-id') ?? after('--resume')
const cwd = process.cwd()

const transcript = harness === 'pi'
  ? join(process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), '.pi', 'agent', 'sessions'), piDir(cwd), `${new Date().toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`)
  : join(claudeDir(), 'projects', claudeSlug(cwd), `${sessionId}.jsonl`)
let parent = null
const write = (entry) => {
  mkdirSync(dirname(transcript), { recursive: true })
  appendFileSync(transcript, `${JSON.stringify(entry)}\n`)
}
// pi writes its file only at its first assistant message, its header first.
let piStarted = false
function record(prompt, reply) {
  const timestamp = new Date().toISOString()
  if (harness === 'pi') {
    if (!piStarted) write({ type: 'session', version: 3, id: sessionId, timestamp, cwd })
    piStarted = true
    const user = randomUUID().slice(0, 8)
    write({ type: 'message', id: user, parentId: parent, timestamp, message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() } })
    parent = randomUUID().slice(0, 8)
    write({ type: 'message', id: parent, parentId: user, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, timestamp: Date.now() } })
    return
  }
  const user = randomUUID()
  write({ type: 'user', uuid: user, parentUuid: parent, sessionId, cwd, timestamp, message: { role: 'user', content: prompt } })
  parent = randomUUID()
  write({ type: 'assistant', uuid: parent, parentUuid: user, sessionId, cwd, timestamp, message: { id: `msg_${parent}`, role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 5 } } })
}

const said = []
let input = ''
function draw() {
  const [cols, rows] = process.stdout.getWindowSize?.() ?? [120, 30]
  const shown = said.slice(-(rows - 4)).map((l) => l.slice(0, cols - 1))
  process.stdout.write(`\x1b[2J\x1b[H\x1b[1mfake ${harness} ${sessionId}\x1b[0m`)
  shown.forEach((l, i) => process.stdout.write(`\x1b[${i + 3};1H${l}`))
  process.stdout.write(`\x1b[${rows};1H\x1b[2K❯ ${input.replace(/\n/g, '⏎').slice(-(cols - 3))}`)
}

process.stdout.write(`fake ${harness} starting\r\n`)
process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?25l')
draw()
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')

let pasting = false
let pending = ''
process.stdin.on('data', (chunk) => {
  pending += chunk
  while (pending) {
    if (pending.startsWith('\x1b[200~')) {
      pasting = true
      pending = pending.slice(6)
    } else if (pending.startsWith('\x1b[201~')) {
      pasting = false
      pending = pending.slice(6)
    } else if (pending.startsWith('\x1b') && pending.length < 6 && '\x1b[20'.startsWith(pending.slice(0, 4))) {
      // A paste bracket split across reads.
      break
    } else {
      const key = pending[0]
      pending = pending.slice(1)
      if (key === '\r' && !pasting) {
        const prompt = input
        input = ''
        if (prompt.trim()) {
          const reply = `echo: ${prompt.replace(/\s+/g, ' ').trim()}`
          said.push(...prompt.split('\n').map((l) => `> ${l}`), reply)
          record(prompt, reply)
        }
      } else if (key === '\x15') input = ''
      else if (key === '\x7f' || key === '\b') input = input.slice(0, -1)
      else if (key === '\r' || key === '\n') input += '\n'
      else if (key >= ' ') input += key
    }
  }
  draw()
})
process.stdout.on('resize', draw)
