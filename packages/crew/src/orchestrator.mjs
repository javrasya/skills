// The orchestrator (#102): crew's brain, an agent on the run default's
// harness and model that crew hands one question at a time, each a fresh
// headless run in the project (headless.mjs), whose answer must meet the
// question's schema. Anything short of a valid answer is an
// OrchestratorError, never a value.
//
// It runs in no session: no run's graph shows it as a node. Only the run
// console's `?` is a session, titled `orchestrator/console`, for a person to
// talk to: recorded in the run's state dir (CONSULT_FILE, #168), so the run
// tree lists it under Orchestrator and the person can enter it again. It
// never answers a scheduling question: the questions are crew's, and none is one.
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkSchema } from './schema.mjs'
import { runHeadless } from './headless.mjs'
import { TOOLS } from './tools.mjs'
import { validationLineProblem } from './validation-list.mjs'

export const ORCHESTRATOR_PREFIX = 'orchestrator/'
export const orchestratorTitle = (name) => `${ORCHESTRATOR_PREFIX}${name}`
export const isOrchestratorTitle = (title) => typeof title === 'string' && title.startsWith(ORCHESTRATOR_PREFIX)

// `stopped`: given up on because its asker closed the orchestrator
// (close()), not for anything the orchestrator did.
export class OrchestratorError extends Error {
  constructor(question, reason, { stopped = false } = {}) {
    super(`the orchestrator gave no valid answer to ${question}: ${reason}`)
    this.question = question
    this.reason = reason
    this.stopped = stopped
  }
}

const STOPPED = 'its asker stopped asking, and its run was ended'

// Each question is one headless run of the harness (headless.mjs), in `cwd`,
// the project's checkout: the user's own harness, with their settings and
// login, but no TUI, so no dialog can stop it and nobody need be there. Its
// answer is the run's structured output, checked against the question's
// schema. `dirs` are directories outside `cwd` it may read too (a run's
// state dir). `program` is the words the harness starts with (crew's config
// `harnesses`), its own name by default. A question is answered within
// `answerMs`. close() gives up every question still asked, its run ended,
// and asks no more: what its asker calls before it goes (a `crew view` quit,
// a Ctrl+C at `crew start`'s draft), so no orchestrator run outlives the
// command that asked.
export function orchestrator({ harness = 'claude', model = null, effort = null, permissionMode = null, cwd, env = process.env, program = null, answerMs = 15 * 60_000, run = runHeadless }) {
  const pending = new Set()
  let closed = false

  // `name` names the question; `prompt` asks it; `schema` is its answer's,
  // an object at its root as an agent() call's is; `dirs` as above.
  async function ask({ name, prompt, schema, dirs = [] }) {
    checkSchema(schema)
    const fail = (reason) => new OrchestratorError(name, reason)
    if (closed) throw new OrchestratorError(name, STOPPED, { stopped: true })
    const abort = new AbortController()
    pending.add(abort)
    try {
      return await run({ harness, prompt, schema, model, effort, permissionMode, dirs, cwd, env, program, ms: answerMs, signal: abort.signal })
    } catch (e) {
      if (e?.stopped) throw new OrchestratorError(name, STOPPED, { stopped: true })
      throw fail(e?.message ?? String(e))
    } finally {
      pending.delete(abort)
    }
  }

  async function close() {
    closed = true
    for (const abort of pending) abort.abort()
  }

  return { ask, close }
}

// The first question (#102): the validation list of a spec armed without
// one, drafted from how the repo checks itself, never from its source.
export const VALIDATION_SCHEMA = Object.freeze({
  type: 'object',
  required: ['checks'],
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['command', 'source'],
        additionalProperties: false,
        properties: { command: { type: 'string' }, source: { type: 'string' } },
      },
    },
  },
})

export const validationPrompt = (repoDir) => `You are crew's orchestrator. Crew is arming a workflow run in the repo at ${repoDir}, and the run has no validation list: the commands every change must pass before it is done, each run from the repo's root. Draft that list.

Find the checks the repo already runs, and nothing else: read its CI config and workflow files (.github/workflows, .gitlab-ci.yml, azure-pipelines.yml and the like), its Makefile or justfile, and its package scripts (package.json scripts, pyproject.toml, Cargo.toml, and their kin). Never read source files, and never run anything.

Answer with every check you found, in the order CI runs them, each as { "command": the one-line command as run from the repo's root, "source": the file, and the job or script in it, you found it in }. A repo with no discoverable checks is answered with an empty checks list: never invent one.

Each command must be one a shell runs as written: resolve every CI expression (a GitHub Actions \${{ matrix.x }} or \${{ env.X }}, say) to the concrete value it takes, one command per value, and write no command holding a backtick, a \${ or a trailing backslash.`

// validation.md's text for an answer: each check under a comment naming its
// source; '' for none. A command that is not one line, or one the rendered
// workflow.js cannot hold (validation-list.mjs), is no answer. A source is
// only a comment, so what the workflow cannot hold is dropped from it.
export function validationText({ checks }) {
  const bad = checks.find((c) => !c.command.trim() || /[\r\n]/.test(c.command))
  if (bad) throw new Error(`a check's command is not one line: ${JSON.stringify(bad.command)}`)
  const unheld = checks.find((c) => validationLineProblem(c.command))
  if (unheld) throw new Error(`a check's command ${validationLineProblem(unheld.command)}: ${JSON.stringify(unheld.command)}`)
  const comment = (s) =>
    s
      .replace(/[\r\n]+/g, ' ')
      .replace(/`/g, "'")
      .replace(/\$\{/g, '$ {')
      .replace(/[\\\s]+$/, '')
  return checks.map((c) => `# ${comment(c.source)}\n${c.command.trim()}\n`).join('')
}

// The orchestrator's draft of a spec's validation list: { text, empty }.
export async function draftValidation(orch, { repoDir }) {
  const name = 'validation-list'
  const answer = await orch.ask({ name, prompt: validationPrompt(repoDir), schema: VALIDATION_SCHEMA })
  try {
    return { text: validationText(answer), empty: answer.checks.length === 0 }
  } catch (e) {
    throw new OrchestratorError(name, e.message)
  }
}

// The halt triage question (#103), asked once per halted.json `at`
// (triage.mjs): each held node's reason, its questions, and what the operator
// must decide, for the run console's halt panel.
export const TRIAGE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['summary', 'nodes'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['node', 'reason', 'questions', 'decide'],
        additionalProperties: false,
        properties: { node: { type: 'string' }, reason: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } }, decide: { type: 'string' } },
      },
    },
  },
})

// The run directory's files, as both orchestrator uses name them.
const runFiles = (stateDir) => `its halted.json (the held nodes, while it is halted), journal.jsonl (every call and what became of it), runner.log, the agents' results (agents/*/result.json) and summary.json (once the run has ended), all in ${stateDir}`

export const triagePrompt = ({
  stateDir,
  notice,
}) => `You are crew's orchestrator. A workflow run has halted: ${notice.nodes.length === 1 ? 'one node is' : `${notice.nodes.length} nodes are`} held until the operator resumes ${notice.nodes.length === 1 ? 'it' : 'them'} with r: ${notice.nodes.map((n) => n.node).join(', ')}. The run's state is ${runFiles(stateDir)}.

Read what you need of those files, and nothing else: change nothing, and never run anything.

Answer with a short "summary" of the halt, and one entry per held node, in the order halted.json lists them: { "node": its name as halted.json has it, "reason": why it is held, "questions": the questions it left for the operator (empty when it left none), "decide": what the operator must decide before resuming it }.`

// `?` in the run console: the orchestrator for a free conversation with the
// operator about one run, seeded with its run directory, and told its tools
// (#194, tools.mjs's orchestrator rows): the readers first, the acts only on
// the operator's word, since they do to the run what the operator's own keys
// do.
const ORCHESTRATOR_TOOLS = TOOLS.filter((t) => t.who.includes('orchestrator'))
const list = (tools) =>
  tools
    .map((t) => `\`${t.name}\``)
    .join(', ')
    .replace(/, (`[^`]+`)$/, ' and $1')
export const consultPrompt = (stateDir) =>
  `You are crew's orchestrator, opened from the run console for a conversation with the operator about one workflow run. The run's state is ${runFiles(stateDir)}. Your session has crew's tools for this run: ${list(ORCHESTRATOR_TOOLS.filter((t) => !t.acts))} read it, and ${list(ORCHESTRATOR_TOOLS.filter((t) => t.acts))} act on it as the operator's p and r do in the run console. Start with run_status, read what else you need of the files, then wait for the operator's questions. Use pause, resume and decide only when the operator asks, and give decide only the answers they gave. Change nothing else unless the operator asks you to.`

// The `?` sessions of a run, one JSON line each in its state dir, appended by
// the console that opens one (never by the runner, whose journal a resume
// rewrites): `starting` { n, at, harness, model, dir } as the start begins,
// then `started` { n, at, terminal, sessionId } once the harness has its
// prompt, or `failed` { n, at, reason }; `closed` { n, at } once the operator
// closes it from the tree. Numbered from 1 in the order opened. A `starting`
// with nothing after it is a start under way, or one whose console died
// mid-start, which nothing else records: past CONSULT_START_MS it is read as
// failed, so the tree never shows it starting for good.
export const CONSULT_FILE = 'orchestrator.jsonl'
// The phase the run tree lists them under, drawn before the run's own.
export const CONSOLE_PHASE = 'Orchestrator'
// A `?` session's title in the tree, its label `console <n>` under its phase.
export const consoleTitle = (n) => `[${CONSOLE_PHASE}] console ${n}`
export const CONSULT_START_MS = 15 * 60_000
const STALE_START = 'its start was never recorded as done: the console that started it went away'

const consultLines = (stateDir) => {
  let text
  try {
    text = readFileSync(join(stateDir, CONSULT_FILE), 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const lines = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      lines.push(JSON.parse(line))
    } catch {
      // A line cut short by a console killed mid-write: the ones before it stand.
    }
  }
  return lines
}

const consultWrite = (stateDir, entry, now) => appendFileSync(join(stateDir, CONSULT_FILE), `${JSON.stringify({ ...entry, at: new Date(now).toISOString() })}\n`)

// Every `?` session the run dir records, in the order opened: { n, at, state,
// terminal, sessionId, harness, model, dir, reason }, state one of starting,
// started, failed, closed, as the last line of its n says; `at` the time of
// its starting line. `now` is when a starting line goes stale.
export function consultSessions(stateDir, { now = Date.now() } = {}) {
  const byN = new Map()
  for (const e of consultLines(stateDir)) {
    if (e.type === 'starting') byN.set(e.n, { n: e.n, at: e.at, state: 'starting', terminal: null, sessionId: null, harness: e.harness ?? 'claude', model: e.model ?? null, dir: e.dir ?? null, reason: null })
    const s = byN.get(e.n)
    if (!s) continue
    if (e.type === 'started') Object.assign(s, { state: 'started', terminal: e.terminal, sessionId: e.sessionId ?? null })
    else if (e.type === 'failed') Object.assign(s, { state: 'failed', reason: e.reason ?? null })
    else if (e.type === 'closed') s.state = 'closed'
  }
  for (const s of byN.values()) {
    if (s.state === 'starting' && now - Date.parse(s.at) >= CONSULT_START_MS) Object.assign(s, { state: 'failed', reason: STALE_START })
  }
  return [...byN.values()].sort((a, b) => a.n - b.n)
}

// Session `n` closed by the operator: its record says so, and the tree drops it.
export const closeConsult = (stateDir, n, { now = Date.now() } = {}) => consultWrite(stateDir, { type: 'closed', n }, now)

// A fresh `?` session on a host that starts sessions of no Run (the crew
// host's sessionStart): titled orchestrator/console, in no run's journal, so
// never a node of any run's graph; recorded in the run dir as above, and
// told the run's state dir, which the host keeps on the session so its
// harness equips it with the orchestrator's tools (#194, tools.mjs). Returns
// { terminal, n }, its session id and its number among the run's.
export async function consultSession({ host, stateDir, harness = 'claude', model = null, effort = null, permissionMode = null, dir, now = Date.now }) {
  const n = (consultSessions(stateDir, { now: now() }).at(-1)?.n ?? 0) + 1
  const sessionId = randomUUID()
  consultWrite(stateDir, { type: 'starting', n, harness, model, dir }, now())
  let terminal
  try {
    ;({ terminal } = await host.sessionStart({ title: orchestratorTitle('console'), prompt: consultPrompt(stateDir), harness, model, effort, permissionMode, sessionId, dir, stateDir }))
  } catch (e) {
    consultWrite(stateDir, { type: 'failed', n, reason: e?.message ?? String(e) }, now())
    throw e
  }
  consultWrite(stateDir, { type: 'started', n, terminal, sessionId }, now())
  return { terminal, n }
}
