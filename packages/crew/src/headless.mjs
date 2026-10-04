// A harness run once, headless (`claude -p`, `pi -p`): a prompt in, one
// answer out, then it exits. No TUI and no screen to read, so no dialog can
// stop it: Claude skips its workspace trust dialog in print mode, and pi runs
// with --approve as a worker does. It is the user's own harness, with their
// settings, login, MCP servers and hooks, in `cwd`.
//
// Crew uses it where nobody is there to answer anything: the orchestrator's
// questions (orchestrator.mjs), each with a schema its answer must meet, and
// `crew start`'s check that the harness is logged in and can reach the model
// before a run is armed on it (preflight).
//
// Each harness is a table entry, as screens.mjs's readers are:
//   words({ schema, model, effort, permissionMode, dirs })
//                    the argv after the program word; the prompt goes on stdin
//   prompt(prompt, schema)
//                    the prompt as sent, for one that cannot take a schema
//   answer(stdout, schema)
//                    the value it answered, or a throw saying why none
import { spawn } from 'node:child_process'
import { childCommand } from './command.mjs'
import { validate } from './schema.mjs'
import { nativeEnv } from './harness.mjs'

// The last JSON object in `text`: a model's reply that ends in one.
function lastObject(text) {
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {}
    }
  }
  throw new Error('its reply holds no JSON object')
}

export const HEADLESS = Object.freeze({
  // --output-format json prints one result object; with --json-schema its
  // `structured_output` is the answer, checked against the schema by Claude.
  claude: Object.freeze({
    words: ({ schema, model, effort, permissionMode, dirs = [] }) => [
      '-p',
      '--output-format',
      'json',
      ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...(permissionMode ? ['--permission-mode', permissionMode] : []),
      ...dirs.flatMap((d) => ['--add-dir', d]),
    ],
    prompt: (prompt) => prompt,
    answer(stdout, schema) {
      let r
      try {
        r = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1))
      } catch {
        throw new Error(`claude printed no result: ${stdout.trim().slice(-300) || 'nothing'}`)
      }
      if (r.is_error || r.subtype !== 'success')
        throw new Error(
          `claude answered with an error: ${String(r.result ?? r.subtype ?? 'no reason given')
            .trim()
            .slice(0, 500)}`,
        )
      if (!schema) return r.result
      if (r.structured_output === undefined) throw new Error('claude gave no structured answer')
      return r.structured_output
    },
  }),
  // pi takes no schema: it is asked to end its reply in the answer.
  pi: Object.freeze({
    words: ({ model, effort }) => ['--approve', '-p', ...(model ? ['--model', model] : []), ...(effort ? ['--thinking', effort] : [])],
    prompt: (prompt, schema) => (schema ? `${prompt}\n\nEnd your reply with your answer as one JSON object meeting this JSON Schema, and nothing after it:\n${JSON.stringify(schema)}` : prompt),
    answer: (stdout, schema) => (schema ? lastObject(stdout) : stdout.trim()),
  }),
})

// `harness`'s answer to `prompt`, run in `cwd`, checked against `schema` when
// one is given. `program` is the words the harness starts with, its name by
// default (crew's config `harnesses` names another, as the suite's fake one).
// It is killed at `ms`, or when `signal` aborts. Rejects with why there is no answer.
export function runHeadless({ harness = 'claude', prompt, schema = null, model = null, effort = null, permissionMode = null, dirs = [], cwd, env = process.env, program = null, ms = 15 * 60_000, signal = null }) {
  const h = HEADLESS[harness]
  if (!h) return Promise.reject(new Error(`no headless run for harness "${harness}"`))
  const [file, ...pre] = program ?? [harness]
  const [cmd, args] = childCommand(file, [...pre, ...h.words({ schema, model, effort, permissionMode, dirs })], { cwd, env })
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let why = null
    const child = spawn(cmd, args, { cwd, env: nativeEnv(env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stop = (reason) => {
      why ??= reason
      child.kill()
    }
    const timer = setTimeout(() => stop(`no answer within ${Math.round(ms / 60_000)} min`), ms)
    const aborted = () => stop('stopped')
    signal?.addEventListener('abort', aborted, { once: true })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => stop(`${file} could not be started: ${e.message}`))
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      if (why) return reject(Object.assign(new Error(why), { stopped: why === 'stopped' }))
      let value
      try {
        value = h.answer(out, schema)
      } catch (e) {
        return reject(new Error(code ? `${harness} exited ${code}: ${(err.trim() || e.message).split('\n').slice(-6).join('\n')}` : e.message))
      }
      if (code && harness !== 'claude') return reject(new Error(`${harness} exited ${code}: ${err.trim().split('\n').slice(-6).join('\n')}`))
      const errors = schema ? validate(schema, value) : []
      if (errors.length) return reject(new Error(`its answer fails its schema: ${errors.join('; ')}`))
      resolve(value)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(h.prompt(prompt, schema))
  })
}

// Whether `harness` can run on `model` at all: logged in, the model one its
// account reaches. One short headless turn, so it costs a little; `crew
// start` runs it before it drafts or arms anything. Rejects with the
// harness's own words for why not.
export async function preflight({ harness = 'claude', model = null, effort = null, cwd, env = process.env, program = null, ms = 2 * 60_000, run = runHeadless }) {
  const reply = await run({ harness, prompt: 'Reply with the single word: ok', model, effort, cwd, env, program, ms })
  if (typeof reply !== 'string' || !reply.trim()) throw new Error(`${harness} gave no reply`)
}
