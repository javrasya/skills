// Offline tests for the crew console: entering a session and leaving it with
// the back key, the mode replay, and resize. The end-to-end tests drive the
// console through fake stdin and stdout streams against a real daemon holding
// a real pty that runs a small scripted program (fixtures/crew/scripted.mjs);
// what reaches the fake stdout is fed to a headless terminal standing in for
// the operator's.
//   node packages/crew/test/test-console.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'stream'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import xterm from '@xterm/headless'
import { crewPaths } from '../src/daemon/transport.mjs'
import { request } from '../src/daemon/client.mjs'
import { startDaemon } from '../src/daemon/daemon.mjs'
import { ptySession } from '../src/daemon/session.mjs'
import { RESET, repaint, stripHostModes, trackModes } from '../src/daemon/modes.mjs'
import { backKeySequences, readCrewConfig } from '../src/crew-config.mjs'
import { backKeyFilter, runConsole } from '../src/console.mjs'

const { Terminal } = xterm
const CREW = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url))
const SCRIPTED = fileURLToPath(new URL('./fixtures/crew/scripted.mjs', import.meta.url))
const F12 = '\x1b[24~'
const F5 = '\x1b[15~'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(what, check, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

const emulator = (cols, rows) => new Terminal({ cols, rows, allowProposedApi: true })
const parsed = (terminal, data) => new Promise((done) => terminal.write(data, done))
function screenOf(terminal) {
  const buffer = terminal.buffer.active
  const lines = []
  for (let y = 0; y < terminal.rows; y++) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
  return { lines, cursor: [buffer.cursorX, buffer.cursorY], alternate: buffer.type === 'alternate' }
}

test('back key: every other key is forwarded byte for byte, and the back key never is', async () => {
  const forwarded = []
  const backs = []
  const filter = backKeyFilter({ sequences: [F12], forward: (keys) => forwarded.push(keys), back: (rest) => backs.push(rest.toString()), holdMs: 20 })
  const out = () => Buffer.concat(forwarded.splice(0)).toString('latin1')

  // a, Up, Ctrl+C, Ctrl+], Ctrl+Left, a byte that is not UTF-8, Shift+F12
  const keys = Buffer.from('a\x1b[A\x03\x1d\x1b[1;5D\xff\x1b[24;2~', 'latin1')
  filter.push(keys)
  assert.equal(out(), keys.toString('latin1'))
  assert.deepEqual(backs, [])

  filter.push(Buffer.from(`x${F12}y`))
  assert.equal(out(), 'x')
  assert.deepEqual(backs.splice(0), ['y'])

  // A back key split across two reads is still the back key.
  filter.push(Buffer.from('\x1b[2'))
  assert.equal(out(), '')
  filter.push(Buffer.from('4~'))
  assert.equal(out(), '')
  assert.deepEqual(backs.splice(0), [''])

  // A held start that turns out to be another key goes on whole: F10, then a lone Escape after the hold.
  filter.push(Buffer.from('\x1b[2'))
  filter.push(Buffer.from('1~'))
  assert.equal(out(), '\x1b[21~')
  filter.push(Buffer.from('\x1b'))
  assert.equal(out(), '')
  await sleep(60)
  assert.equal(out(), '\x1b')
  assert.deepEqual(backs, [])
})

test('crew config: the back key is F12 unless ~/.crew/config.json names another; Ctrl+Left and Ctrl+] are refused', () => {
  const paths = crewPaths({ CREW_HOME: mkdtempSync(join(tmpdir(), 'crew-config-')) })
  assert.equal(readCrewConfig(paths).backKey, 'f12')
  assert.deepEqual(backKeySequences('f12'), [F12])

  writeFileSync(paths.config, JSON.stringify({ backKey: 'F5' }))
  assert.equal(readCrewConfig(paths).backKey, 'F5')
  assert.ok(backKeySequences('F5').includes(F5))
  assert.deepEqual(backKeySequences('ctrl+b'), ['\x02'])

  for (const key of ['ctrl+left', 'Ctrl+]']) {
    writeFileSync(paths.config, JSON.stringify({ backKey: key }))
    assert.throws(() => readCrewConfig(paths), /cannot be used: pi binds/)
  }
  writeFileSync(paths.config, JSON.stringify({ backKey: 'ctrl+m' }))
  assert.throws(() => readCrewConfig(paths), /not one crew knows/)
  writeFileSync(paths.config, 'nope')
  assert.throws(() => readCrewConfig(paths), /config\.json: not JSON/)
})

test('mode replay: a terminal in any state is put into the session\'s screen and private modes, SGR mouse and a hidden cursor included', async () => {
  const session = emulator(40, 10)
  const modes = trackModes(session)
  await parsed(session, 'normal\r\n\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[?1h\x1b=')
  await parsed(session, '\x1b[H\x1b[1;31mred\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m\x1b[3;7H世界\x1b[5;2H')

  const bytes = repaint(session, modes)
  // The two the emulator's serializer drops.
  assert.ok(bytes.includes('\x1b[?1006h'))
  assert.ok(bytes.endsWith('\x1b[?25l'))

  const real = emulator(40, 10)
  await parsed(real, 'junk\x1b[?1003h\x1b[?1049h\x1b[31mmore junk')
  await parsed(real, bytes)
  assert.deepEqual(screenOf(real), screenOf(session))
  assert.equal(screenOf(real).alternate, true)
  assert.equal(real.modes.mouseTrackingMode, 'drag', '?1000h then ?1002h: the last one set wins')
  assert.equal(real.modes.bracketedPasteMode, true)
  assert.equal(real.modes.applicationCursorKeysMode, true)
  assert.equal(real.modes.applicationKeypadMode, true)
  const cell = (x) => real.buffer.active.getLine(0).getCell(x)
  assert.ok(cell(0).isBold() && cell(0).isFgPalette() && cell(0).getFgColor() === 1)
  assert.ok(cell(4).isFgRGB() && cell(4).getFgColor() === 0x010203)

  // The normal screen is under it, for when the program leaves the alternate one.
  await parsed(session, '\x1b[?1049l')
  await parsed(real, '\x1b[?1049l')
  assert.deepEqual(screenOf(real), screenOf(session))

  await parsed(session, '\x1bc')
  assert.equal(modes.size, 0, 'a full reset (ESC c) clears them')
  assert.equal(stripHostModes('a\x1b[?9001hb\x1b[?9001l'), 'ab')
})

// A terminal made of fake streams: stdin is written to as if keys were pressed,
// and what the console writes to stdout lands in a headless terminal too.
function fakeTerminal(cols, rows) {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.raw = false
  stdin.setRawMode = (on) => {
    stdin.raw = on
    return stdin
  }
  const real = emulator(cols, rows)
  const chunks = []
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk)
      real.write(chunk)
      done()
    },
  })
  stdout.columns = cols
  stdout.rows = rows
  const resize = (c, r) => {
    stdout.columns = c
    stdout.rows = r
    real.resize(c, r)
    stdout.emit('resize')
  }
  const text = (from = 0) => Buffer.concat(chunks.slice(from)).toString('utf8')
  const screen = async () => {
    await parsed(real, '')
    return screenOf(real)
  }
  return { stdin, stdout, real, chunks, text, screen, resize, press: (keys) => stdin.write(Buffer.from(keys, 'latin1')) }
}

// A real daemon, under a scratch crew home, holding the scripted program in a
// real pty; writes records every byte the daemon hands the session's pty.
async function scriptedSession(t) {
  const paths = crewPaths({ CREW_HOME: join(mkdtempSync(join(tmpdir(), 'crew-console-')), 'home') })
  const writes = []
  const daemon = await startDaemon({
    paths,
    exit: () => {},
    log: () => {},
    spawnSession: (options) => {
      const session = ptySession(options)
      const write = session.write
      session.write = (data) => {
        writes.push(Buffer.from(data))
        write(data)
      }
      return session
    },
  })
  t.after(() => daemon.shutdown('test over'))
  const { session } = await request(paths, { op: 'session.spawn', command: [process.execPath, SCRIPTED], cols: 80, rows: 24 })
  const screen = async () => (await request(paths, { op: 'session.screen', id: session.id })).screen
  await until('the program to draw its alternate screen', async () => (await screen()).lines[2].includes('ready'))
  const info = async () => (await request(paths, { op: 'session.list' })).sessions.find((s) => s.id === session.id)
  return { paths, id: session.id, writes, screen, info, typed: () => Buffer.concat(writes).toString('latin1') }
}

test('console: enter, the mode replay, keys, resize and the back key, against a real pty', async (t) => {
  const { paths, id, screen, info, typed } = await scriptedSession(t)
  const term = fakeTerminal(80, 24)
  const crew = runConsole({ paths, stdin: term.stdin, stdout: term.stdout, refreshMs: 100 })
  assert.equal(term.stdin.raw, true)
  await until('the list', () => term.text().includes(`> ${id}  running`))
  assert.equal(crew.mode(), 'list')

  // Enter: the session is quiet by now, so all it shows comes from the repaint.
  const quiet = await screen()
  const from = term.chunks.length
  term.press('\r')
  await until('the session entered', () => crew.mode() === 'entered')
  await until('its screen', async () => (await term.screen()).lines[2] === '    ready')
  const entered = term.text(from)
  assert.ok(entered.startsWith(RESET), 'the terminal is reset before the repaint')
  const painted = entered.indexOf('ready')
  assert.ok(entered.slice(0, painted).includes('\x1b[?1049h'), 'the alternate screen is up before its content is painted')
  assert.ok(entered.includes('\x1b[?1002h') && entered.includes('\x1b[?1006h'), 'drag mouse reporting in SGR encoding')
  assert.ok(entered.includes('\x1b[?2004h') && entered.includes('\x1b[?25l'), 'bracketed paste and the hidden cursor')
  const shown = await term.screen()
  assert.equal(shown.alternate, true)
  assert.equal(term.real.modes.mouseTrackingMode, 'drag')
  assert.deepEqual(shown.lines, quiet.lines, 'the current screen, before any new output')
  assert.equal((await screen()).lines.join('\n'), quiet.lines.join('\n'), 'the program wrote nothing since')

  // Keys: each reaches the pty byte for byte, and the program reads them.
  const keys = 'hi\x1b[A\x1b[24;2~\x1d'
  term.press(keys)
  await until('the keys at the pty', () => typed() === keys)
  await until('the program to read them', async () => (await term.screen()).lines[4].startsWith('got 68691b5b41'))

  // Resize: the session's pty and screen follow the terminal.
  term.resize(100, 30)
  await until('the session resized', async () => {
    const s = await info()
    return s.cols === 100 && s.rows === 30
  })
  await until('the program to see its new size', async () => (await term.screen()).lines[5] === 'size 100x30')

  // The back key: never at the pty, back at the list, the session still running.
  const before = typed()
  term.press(`z${F12}`)
  await until('the list again', () => crew.mode() === 'list' && term.text().includes(`> ${id}  running  pid`))
  await sleep(100)
  assert.equal(typed(), `${before}z`, 'the keys before the back key go through, the back key does not')
  assert.equal((await info()).alive, true, 'leaving keeps the session running')
  assert.equal(term.real.modes.mouseTrackingMode, 'none', 'leaving resets the terminal for the list')
  assert.equal((await term.screen()).alternate, false)

  // Entering again shows the screen as it is now.
  term.press('\r')
  await until('entered again', async () => crew.mode() === 'entered' && (await term.screen()).lines[5] === 'size 100x30')
  term.press(F12)
  await until('the list once more', () => crew.mode() === 'list')

  term.press('q')
  await crew.done
  assert.equal(term.stdin.raw, false)
  assert.equal(crew.mode(), 'quit')
})

test('console: the back key named in crew config leaves, and F12 then reaches the session like any key', async (t) => {
  const { paths, id, typed } = await scriptedSession(t)
  writeFileSync(paths.config, JSON.stringify({ backKey: 'f5' }))
  const term = fakeTerminal(80, 24)
  const crew = runConsole({ paths, stdin: term.stdin, stdout: term.stdout, backKey: readCrewConfig(paths).backKey, refreshMs: 100 })
  await until('the list', () => term.text().includes(`> ${id}  running`))
  assert.match(term.text(), /F5 comes back/)
  term.press('\r')
  await until('the session entered', () => crew.mode() === 'entered')
  term.press(F12)
  await until('F12 at the pty', () => typed() === F12)
  term.press(F5)
  await until('the list again', () => crew.mode() === 'list')
  await sleep(100)
  assert.equal(typed(), F12, 'the configured back key never reaches the session')
  term.press('q')
  await crew.done
})

test('crew console: needs a terminal, and takes no arguments', () => {
  const env = { ...process.env, CREW_HOME: join(mkdtempSync(join(tmpdir(), 'crew-console-bin-')), 'home') }
  const run = (...args) => spawnSync(process.execPath, [CREW, 'console', ...args], { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] })
  const piped = run()
  assert.equal(piped.status, 3)
  assert.match(piped.stderr, /crew console: needs a terminal/)
  assert.equal(run('extra').status, 2)
})
