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
//   [ask <tool>]  mid-turn it waits on the person, as for permission to use
//                 <tool>, until Enter: Claude runs the hooks its --settings
//                 name for it, as Claude does; pi emits ui_prompt_start and
//                 ui_prompt_end to the extensions its -e names
//   [call <tool> <json>]  the turn calls the tool an extension registered
//                 (pi's registerTool), with that JSON as its arguments,
//                 each such word in order: as pi does, arguments that fail
//                 the tool's parameters are an error result without the
//                 tool run, and the call and its result go in pi's
//                 transcript. A turn that calls a tool submits nothing else
//
// As pi, it emits session_start to those extensions once its input is drawn,
// as pi does once its editor submits; CREW_FAKE_MUTE=1 keeps it from saying
// so. CREW_FAKE_TICK=1 redraws a clock every 100 ms from the start, as a pi
// with a ticking status line draws, so its terminal never goes quiet.
//
// It plays a worker's part in a run too, from what the session was told, the
// prompts of the transcript it resumed included. Given the runner's submit
// command and a preamble's IDs (the latest one), it submits at the end of
// every turn, before its reply: the note of the latest doctor's note prompt,
// else the text of the latest [answer <text>], else `done`; with
// [decide <question>] that turn's [answer <json>] goes with
// decisions_needed: [<question>], and with [resubmit <ms>] it submits again,
// its [answer] alone, that long after the runner set its result aside as
// result.needs-decision.json, as an agent of a held node may. Told it is a
// doctor, it plays nothing else: it sends the text of the patient's
// [cure <text>] as its handoff, `no note` without one, then its worker_done,
// with the `orchestration send` its preamble names. Asked by crew's
// orchestrator to draft a validation list, it answers FIXED_DRAFT, reading
// nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { claudeDir, claudeSlug, piDir, transcriptPath } from '../../../src/transcript.mjs'
import { validate } from '../../../src/schema.mjs'

const FIXED_DRAFT = {
  checks: [
    { command: 'npm test', source: 'package.json scripts.test' },
    { command: 'npm run lint', source: '.github/workflows/ci.yml job lint' },
  ],
}

const argv = process.argv.slice(2)
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null)
const harness = argv.includes('--approve') ? 'pi' : 'claude'
const sessionId = after('--session-id') ?? after('--resume')
const cwd = process.cwd()

// pi reopens the file its session id names, and writes a new one only at its
// first assistant message, its header first.
const earlier = harness === 'pi' ? transcriptPath({ harness, sessionId, worktree: cwd, scan: false }) : null
const transcript = harness === 'pi' ? (earlier ?? join(process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), '.pi', 'agent', 'sessions'), piDir(cwd), `${new Date().toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`)) : join(claudeDir(), 'projects', claudeSlug(cwd), `${sessionId}.jsonl`)
// Headless (-p), as crew's orchestrator and preflight run it: the prompt on
// stdin, one answer printed, then it exits. Claude's is its --output-format
// json result, the answer its structured_output; pi's is text ending in the
// answer. Asked for a validation list it answers FIXED_DRAFT; a prompt's
// [answer <json>] is its answer, [error <text>] an error result, and [hang]
// never answers. Anything else is answered `ok`.
if (argv.includes('-p')) {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (prompt += d))
  process.stdin.on('end', () => {
    if (/\[hang\]/.test(prompt)) return setInterval(() => {}, 1000)
    const error = /\[error ([^\]]*)\]/.exec(prompt)?.[1]
    const answer = /You are crew's orchestrator\. [\s\S]*no validation list/.test(prompt) ? FIXED_DRAFT : /\[answer ([^\]]*)\]/.exec(prompt) ? JSON.parse(/\[answer ([^\]]*)\]/.exec(prompt)[1]) : null
    if (harness === 'pi') {
      process.stdout.write(answer ? `Here it is:\n${JSON.stringify(answer)}\n` : 'ok\n')
      return process.exit(error ? 1 : 0)
    }
    const schema = argv.includes('--json-schema')
    process.stdout.write(`${JSON.stringify(error ? { type: 'result', subtype: 'success', is_error: true, result: error } : { type: 'result', subtype: 'success', is_error: false, result: answer ? JSON.stringify(answer) : 'ok', ...(schema && answer && { structured_output: answer }), cwd })}\n`)
    process.exit(error ? 1 : 0)
  })
} else {
  await tui()
}

async function tui() {
  // pi's extensions, as -e names them, given a pi that only emits events; and
  // the hooks Claude's --settings names, run as Claude runs a command hook.
  const handlers = new Map()
  const tools = new Map()
  for (let i = argv.indexOf('-e'); i !== -1; i = argv.indexOf('-e', i + 1)) {
    const ext = await import(pathToFileURL(argv[i + 1]).href)
    ext.default({ on: (type, fn) => handlers.set(type, [...(handlers.get(type) ?? []), fn]), registerTool: (t) => tools.set(t.name, t) })
  }
  // As pi's runner does: each handler awaited in turn, one that rejects
  // reported and the rest still run, the harness never failed by it.
  const emit = async (event) => {
    for (const fn of handlers.get(event.type) ?? []) {
      try {
        await fn(event, {})
      } catch (e) {
        process.stderr.write(`fake ${harness}: extension failed on ${event.type}: ${e?.message ?? e}\n`)
      }
    }
  }
  const settings = after('--settings')
  const hooks = settings ? (JSON.parse(settings.trim().startsWith('{') ? settings : readFileSync(settings, 'utf8')).hooks ?? {}) : {}
  const hook = (payload) => {
    for (const matcher of hooks[payload.hook_event_name] ?? []) {
      for (const h of matcher.hooks) spawnSync(h.command, { shell: true, input: JSON.stringify({ session_id: sessionId, cwd, ...payload }), env: process.env })
    }
  }

  let parent = null
  const write = (entry) => {
    mkdirSync(dirname(transcript), { recursive: true })
    appendFileSync(transcript, `${JSON.stringify(entry)}\n`)
  }
  let piStarted = !!earlier
  let piHeld = null

  // Every prompt the session was told, the latest last.
  const told = []
  try {
    const was = harness === 'pi' ? earlier : argv.includes('--resume') ? transcript : null
    for (const line of (was && existsSync(was) ? readFileSync(was, 'utf8') : '').split('\n').filter(Boolean)) {
      const e = JSON.parse(line)
      if (e.type === 'user' && typeof e.message?.content === 'string') told.push(e.message.content)
      if (e.type === 'message' && e.message?.role === 'user') told.push(e.message.content.map((c) => c.text ?? '').join(''))
    }
  } catch {}
  const latest = (re) => {
    for (const p of [...told].reverse()) {
      const m = re.exec(p)
      if (m) return m
    }
    return null
  }
  const idsOf = () => {
    const m = latest(/--from ([\w-]+) --dispatch-capability ([\w-]+) --task-id ([\w-]+) --dispatch-id ([\w-]+)/)
    return m && ['--from', m[1], '--dispatch-capability', m[2], '--task-id', m[3], '--dispatch-id', m[4]]
  }
  const run = (args) => {
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env })
    said.push(`$ exit ${r.status}: ${`${r.stdout}${r.stderr}`.replace(/\s+/g, ' ').trim()}`.slice(0, 200))
  }

  function doctor(prompt) {
    const bin = /node "([^"]+)" orchestration send/.exec(prompt)?.[1]
    const ids = idsOf()
    if (!bin || !ids) return
    const note = /\[cure ([^\]]*)\]/.exec(prompt)?.[1] ?? 'no note'
    run([bin, 'orchestration', 'send', ...ids, '--type', 'handoff', '--subject', 'note', '--body', note])
    run([bin, 'orchestration', 'send', ...ids, '--type', 'worker_done', '--subject', 'diagnosed', '--body', 'note sent', '--outcome', 'succeeded'])
  }

  function submit(payload = null) {
    const command = latest(/node "([^"]*submit\.mjs)".*/)
    const ids = idsOf()
    if (!command || !ids) return
    const flag = (name) => new RegExp(`--${name} "([^"]+)"`).exec(command[0])?.[1] ?? null
    const note = latest(/## The doctor's note\n([\s\S]*)$/)?.[1].trim()
    const draft = latest(/You are crew's orchestrator\. [\s\S]*no validation list/) && JSON.stringify(FIXED_DRAFT)
    writeFileSync(flag('payload'), payload ?? note ?? latest(/\[answer ([^\]]*)\]/)?.[1] ?? draft ?? 'done')
    run([command[1], ...(flag('schema') ? ['--schema', flag('schema')] : []), '--result', flag('result'), '--payload', flag('payload'), ...ids])
  }

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

  const PI_USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }
  function piMessage(message) {
    const timestamp = new Date().toISOString()
    if (!piStarted) write({ type: 'session', version: 3, id: sessionId, timestamp, cwd })
    piStarted = true
    if (piHeld) write(piHeld)
    piHeld = null
    const id = randomUUID().slice(0, 8)
    write({ type: 'message', id, parentId: parent, timestamp, message: { ...message, timestamp: Date.now() } })
    parent = id
  }

  function replied(reply) {
    const timestamp = new Date().toISOString()
    if (harness === 'pi') return piMessage({ role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop', usage: PI_USAGE })
    const id = randomUUID()
    write({ type: 'assistant', uuid: id, parentUuid: parent, sessionId, cwd, timestamp, message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } })
    parent = id
  }

  const said = []
  // CREW_FAKE_DIALOG=trust: it first asks, as Claude does, whether to trust its
  // folder. Down then Enter trusts it, and the input box shows; Enter alone
  // picks "No, exit" and it exits 1.
  let dialog = process.env.CREW_FAKE_DIALOG === 'trust'
  // CREW_FAKE_DIALOG=pi-mcp: as pi-mcp-adapter does, it draws its input first,
  // then asks whether to allow a project MCP server; Enter answers it.
  const PI_MCP = 'Allow project MCP server “fakesrv”?'
  let piDialog = false
  // Mid-turn, while it waits on the person ([ask]): what Enter answers.
  let answering = null
  let choice = 0
  let input = ''
  let status = ''
  function draw() {
    const [cols, rows] = process.stdout.getWindowSize?.() ?? [120, 30]
    if (piDialog) {
      process.stdout.write(`\x1b[2J\x1b[H${'─'.repeat(cols - 1)}\r\n ${PI_MCP}\r\n\r\n → Yes\r\n   No\r\n\r\n ↑↓ navigate  enter select  escape/ctrl+c cancel\r\n${'─'.repeat(cols - 1)}`)
      return
    }
    if (dialog) {
      process.stdout.write(`\x1b[2J\x1b[H${'─'.repeat(cols - 1)}\r\nAccessing workspace:\r\n\r\n${cwd}\r\n\r\nQuick safety check: Is this a project you created or one you trust?\r\n\r\n❯ No, exit\r\n  Yes, I trust this folder\r\n\r\nEnter to confirm · Esc to cancel`)
      return
    }
    const shown = said.slice(-(rows - 7)).map((l) => l.slice(0, cols - 1))
    process.stdout.write(`\x1b[2J\x1b[H\x1b[1mfake ${harness} ${sessionId}${process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW === '1' ? ' · no agent view' : ''}\x1b[0m`)
    for (const [i, l] of shown.entries()) process.stdout.write(`\x1b[${i + 3};1H${l}`)
    if (status) process.stdout.write(`\x1b[${rows - 3};1H${status.slice(0, cols - 1)}`)
    // Claude's input box: a `❯` row between two rules.
    const rule = '─'.repeat(cols - 1)
    process.stdout.write(`\x1b[${rows - 2};1H${rule}\x1b[${rows - 1};1H\x1b[2K❯ ${input.replace(/\n/g, '⏎').slice(-(cols - 3))}\x1b[${rows};1H${rule}`)
  }

  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  // A clock redrawn every 100 ms, turn or none, once started.
  let drawing = null
  function tick() {
    if (drawing) return
    drawing = setInterval(() => {
      status = `· ${new Date().toISOString()}`
      draw()
    }, 100)
  }
  async function turn(prompt) {
    const recorded = !/\[unrecorded\]/.test(prompt)
    said.push(...prompt.split('\n').map((l) => `> ${l}`))
    told.push(prompt)
    if (recorded) asked(prompt)
    if (/You are a doctor in a workflow run/.test(prompt)) {
      doctor(prompt)
      return reply(prompt, recorded)
    }
    if (/\[draw\]/.test(prompt)) tick()
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
    const ask = /\[ask ([^\]]+)\]/.exec(prompt)?.[1]
    if (ask) await waitOn(ask)
    if (/\[call /.test(prompt)) {
      await calls(prompt, recorded)
      return reply(prompt, recorded)
    }
    const decide = /\[decide ([^\]]*)\]/.exec(prompt)?.[1]
    const answer = /\[answer ([^\]]*)\]/.exec(prompt)?.[1]
    submit(decide && answer ? JSON.stringify({ ...JSON.parse(answer), decisions_needed: [decide] }) : null)
    const again = /\[resubmit (\d+)\]/.exec(prompt)?.[1]
    const aside = latest(/--result "([^"]+)\.json"/)?.[1]
    if (again && aside) {
      while (!existsSync(`${aside}.needs-decision.json`)) await sleep(50)
      await sleep(Number(again))
      submit()
    }
    reply(prompt, recorded)
  }

  async function calls(prompt, recorded) {
    for (const [, name, json] of prompt.matchAll(/\[call (\S+) ([^\]]*)\]/g)) {
      const t = tools.get(name)
      const id = `call_${randomUUID().slice(0, 8)}`
      let args
      try {
        args = JSON.parse(json)
      } catch {
        args = json
      }
      let text
      let isError = true
      const errors = t ? validate(t.parameters, args) : []
      if (!t) text = `Tool ${name} not found`
      else if (errors.length) text = `Validation failed for tool "${name}":\n${errors.map((e) => `  - ${e}`).join('\n')}`
      else {
        try {
          text = (await t.execute(id, args, undefined, undefined, {})).content.map((c) => c.text ?? '').join('')
          isError = false
        } catch (e) {
          text = e?.message ?? String(e)
        }
      }
      said.push(`tool ${name}${isError ? ' error' : ''}: ${text.replace(/\s+/g, ' ')}`.slice(0, 200))
      if (harness === 'pi' && recorded) {
        piMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse', usage: PI_USAGE })
        piMessage({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError })
      }
    }
  }

  async function waitOn(tool) {
    const call = { tool_name: tool, tool_input: { command: 'touch asked.txt' } }
    if (harness === 'pi') emit({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: `Allow ${tool}?` })
    else {
      hook({ hook_event_name: 'PreToolUse', ...call })
      hook({ hook_event_name: 'PermissionRequest', ...call })
      hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' })
    }
    status = `asks: may it use ${tool}? Enter to allow`
    draw()
    await new Promise((done) => (answering = done))
    status = ''
    if (harness === 'pi') emit({ type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm', title: `Allow ${tool}?` })
    else hook({ hook_event_name: 'PostToolUse', ...call })
  }

  function reply(prompt, recorded) {
    const text = `echo: ${prompt.replace(/\s+/g, ' ').trim()}`
    said.push(text)
    if (recorded) replied(text)
    draw()
  }

  process.stdout.write(`fake ${harness} starting\r\n`)
  process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?25l')
  draw()
  if (process.env.CREW_FAKE_TICK === '1') tick()
  if (harness === 'pi' && process.env.CREW_FAKE_MUTE !== '1') emit({ type: 'session_start', reason: 'startup' })
  if (process.env.CREW_FAKE_DIALOG === 'pi-mcp' && harness === 'pi') {
    setTimeout(() => {
      piDialog = true
      emit({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: PI_MCP })
      draw()
    }, 300)
  }
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
      } else if (piDialog || answering) {
        const key = pending[0]
        pending = pending.slice(1)
        if (key !== '\r') continue
        if (answering) {
          const done = answering
          answering = null
          done()
        } else {
          piDialog = false
          emit({ type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm', title: PI_MCP })
        }
      } else if (dialog) {
        if (pending.startsWith('\x1b[B')) {
          choice = 1
          pending = pending.slice(3)
          continue
        }
        const key = pending[0]
        pending = pending.slice(1)
        if (key !== '\r') continue
        if (choice === 0) process.exit(1)
        dialog = false
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
}
