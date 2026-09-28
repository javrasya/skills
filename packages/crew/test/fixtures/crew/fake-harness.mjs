// A stand-in for a worker's harness, run by the host contract suite in a real
// pty from the runner's own launch line (`--session-id <id>` or `--resume
// <id>`; `--approve` makes it pi, else it is Claude). Like the TUI it plays,
// it leaves a line on the normal screen, switches to the alternate screen
// with bracketed paste on and its cursor hidden, and draws a header and an
// input line. Keys and pastes land in the input; Enter outside a paste
// submits it: the prompt is shown, and written to the session's transcript in
// the harness's own format, where the runner finds it by the session id; the
// turn ends with an echo, written there as the model's reply ending the turn.
// Ctrl-U empties the input. Between turns it idles. A resumed session carries
// on the transcript it had.
//
// Words in a prompt script its turn:
//   [turn <ms>]   the turn takes this long, the terminal quiet meanwhile
//   [spin <ms>]   the turn takes this long, a spinner drawn meanwhile
//   [draw]        from now on the terminal redraws a clock, turn or none
//   [unrecorded]  the turn leaves no trace in the transcript
//   [die]         the harness dies mid-turn: its prompt is in the transcript,
//                 no reply ever is, and it exits 1
import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { claudeDir, claudeSlug, piDir, transcriptPath } from '../../../src/transcript.mjs'

const argv = process.argv.slice(2)
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null)
const harness = argv.includes('--approve') ? 'pi' : 'claude'
const sessionId = after('--session-id') ?? after('--resume')
const cwd = process.cwd()

// pi reopens the file its session id names, and writes a new one only at its
// first assistant message, its header first.
const earlier = harness === 'pi' ? transcriptPath({ harness, sessionId, worktree: cwd, scan: false }) : null
const transcript = harness === 'pi'
  ? earlier ?? join(process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), '.pi', 'agent', 'sessions'), piDir(cwd), `${new Date().toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`)
  : join(claudeDir(), 'projects', claudeSlug(cwd), `${sessionId}.jsonl`)
let parent = null
const write = (entry) => {
  mkdirSync(dirname(transcript), { recursive: true })
  appendFileSync(transcript, `${JSON.stringify(entry)}\n`)
}
let piStarted = !!earlier
let piHeld = null

function asked(prompt) {
  const timestamp = new Date().toISOString()
  if (harness === 'pi') {
    const user = randomUUID().slice(0, 8)
    const entry = { type: 'message', id: user, parentId: parent, timestamp, message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() } }
    parent = user
    if (piStarted) write(entry)
    else piHeld = entry
    return
  }
  const user = randomUUID()
  write({ type: 'user', uuid: user, parentUuid: parent, sessionId, cwd, timestamp, message: { role: 'user', content: prompt } })
  parent = user
}

function replied(reply) {
  const timestamp = new Date().toISOString()
  if (harness === 'pi') {
    if (!piStarted) write({ type: 'session', version: 3, id: sessionId, timestamp, cwd })
    piStarted = true
    if (piHeld) write(piHeld)
    piHeld = null
    const id = randomUUID().slice(0, 8)
    write({ type: 'message', id, parentId: parent, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, timestamp: Date.now() } })
    parent = id
    return
  }
  const id = randomUUID()
  write({ type: 'assistant', uuid: id, parentUuid: parent, sessionId, cwd, timestamp, message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } })
  parent = id
}

const said = []
let input = ''
let status = ''
function draw() {
  const [cols, rows] = process.stdout.getWindowSize?.() ?? [120, 30]
  const shown = said.slice(-(rows - 5)).map((l) => l.slice(0, cols - 1))
  process.stdout.write(`\x1b[2J\x1b[H\x1b[1mfake ${harness} ${sessionId}\x1b[0m`)
  shown.forEach((l, i) => process.stdout.write(`\x1b[${i + 3};1H${l}`))
  if (status) process.stdout.write(`\x1b[${rows - 1};1H${status.slice(0, cols - 1)}`)
  process.stdout.write(`\x1b[${rows};1H\x1b[2K❯ ${input.replace(/\n/g, '⏎').slice(-(cols - 3))}`)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let drawing = null
async function turn(prompt) {
  const recorded = !/\[unrecorded\]/.test(prompt)
  said.push(...prompt.split('\n').map((l) => `> ${l}`))
  if (recorded) asked(prompt)
  if (/\[draw\]/.test(prompt) && !drawing) {
    drawing = setInterval(() => {
      status = `· ${new Date().toISOString()}`
      draw()
    }, 100)
  }
  if (/\[die\]/.test(prompt)) {
    status = 'working…'
    draw()
    await sleep(200)
    process.exit(1)
  }
  const [, how, ms] = /\[(turn|spin) (\d+)\]/.exec(prompt) ?? []
  if (how === 'spin') {
    const spinner = setInterval(() => {
      status = `${'|/-+'[Math.floor(Date.now() / 50) % 4]} working`
      draw()
    }, 50)
    await sleep(Number(ms))
    clearInterval(spinner)
    status = ''
  } else if (how === 'turn') await sleep(Number(ms))
  const reply = `echo: ${prompt.replace(/\s+/g, ' ').trim()}`
  said.push(reply)
  if (recorded) replied(reply)
  draw()
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
        if (prompt.trim()) turn(prompt)
      } else if (key === '\x15') input = ''
      else if (key === '\x7f' || key === '\b') input = input.slice(0, -1)
      else if (key === '\r' || key === '\n') input += '\n'
      else if (key >= ' ') input += key
    }
  }
  draw()
})
process.stdout.on('resize', draw)
