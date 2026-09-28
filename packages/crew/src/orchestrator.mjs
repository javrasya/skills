// The orchestrator (#102): crew's brain, an agent on the run default's
// harness and model that crew hands one question at a time, each in a fresh
// session. It answers through the agent-call machinery a worker's does: the
// question's prompt ends in workerPrompt's submit instructions, submit checks
// its payload against the question's schema, and crew re-reads the recorded
// result against that schema before taking it. Anything short of a valid
// answer is an OrchestratorError, never a value.
//
// Its sessions are titled `orchestrator/<question>`, belong to no run's
// journal, and are closed once answered: no run's graph shows them. It never
// answers a scheduling question: the questions are crew's, and none is one.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { checkSchema } from './schema.mjs'
import { slug } from './util.mjs'
import { readResult, workerPrompt } from './lifecycle.mjs'
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

const NUDGE = 'Crew has not received your answer: your final message is not read. Run the submit command from your instructions until it exits 0.'
const STOPPED = 'its asker stopped asking, and its session was closed'

// `host` is a session host (session-host.mjs), its worker started in the
// host's own directory; `dir` where each question's schema, payload and
// result go. A question is answered within `answerMs`; an orchestrator idle
// for `idleMs` without an answer is nudged once, then given up on. Its
// session is stopped and closed once answered, or given up on. close() gives
// up every question still asked, and asks no more: what its asker calls
// before it goes (a `crew view` quit, a Ctrl+C at `crew start`'s draft), so
// no orchestrator session outlives the command that asked.
export function orchestrator({ host, harness = 'claude', model = null, effort = null, permissionMode = null, dir, pollMs = 1_000, idleMs = 60_000, answerMs = 15 * 60_000 }) {
  const pending = new Set()
  let closed = false

  // `name` names the question, in its session's title; `prompt` asks it;
  // `schema` is its answer's, an object at its root as an agent() call's is.
  async function ask({ name, prompt, schema }) {
    checkSchema(schema)
    const fail = (reason) => new OrchestratorError(name, reason)
    const stopped = () => new OrchestratorError(name, STOPPED, { stopped: true })
    if (closed) throw stopped()
    // A poll's wait, cut short by close().
    const q = { stopped: false, wake: () => {} }
    const wait = (ms) => new Promise((done) => {
      const timer = setTimeout(done, ms)
      q.wake = () => (clearTimeout(timer), done())
    })
    q.done = new Promise((done) => (q.settle = done))
    pending.add(q)
    try {
      const files = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(name)}`)
      mkdirSync(files, { recursive: true })
      const schemaPath = join(files, 'schema.json')
      const resultPath = join(files, 'result.json')
      writeFileSync(schemaPath, JSON.stringify(schema, null, 2))
      const title = orchestratorTitle(name)
      let w
      try {
        const { runId } = await host.runCreate({ objective: title })
        w = await host.workerStart({
          run: runId, title, harness, model, effort, permissionMode, sessionId: randomUUID(),
          prompt: workerPrompt(prompt, { schemaPath, resultPath, payloadPath: join(files, 'payload.json') }),
        })
      } catch (e) {
        throw fail(`its session did not start: ${e?.message ?? e}`)
      }
      try {
        const deadline = Date.now() + answerMs
        let idleSince = null
        let nudged = false
        for (;;) {
          if (q.stopped) throw stopped()
          const s = await host.workerShow({ dispatch: w.dispatchId })
          if (s.settled) {
            if (s.outcome !== 'succeeded') throw fail(`its session settled ${s.outcome ?? 'without an outcome'}`)
            const r = readResult(resultPath, schema)
            if (r.error) throw fail(r.error)
            return r.value
          }
          if (s.gone || s.exited) throw fail('its session ended without submitting an answer')
          if (Date.now() > deadline) throw fail(`no answer within ${Math.round(answerMs / 60_000)} min`)
          if (await host.terminalIdle({ terminal: w.terminal, timeoutMs: 0 })) {
            idleSince ??= Date.now()
            if (Date.now() - idleSince >= idleMs) {
              if (nudged) throw fail('it went idle without submitting an answer, after a nudge')
              await host.terminalSend({ terminal: w.terminal, text: NUDGE })
              nudged = true
              idleSince = null
            }
          } else idleSince = null
          await wait(pollMs)
        }
      } catch (e) {
        throw e instanceof OrchestratorError ? e : fail(e?.message ?? String(e))
      } finally {
        // A crew session's kill is idempotent (daemon/session.mjs), so the
        // close that follows the stop straight away is safe.
        await host.workerStop({ dispatch: w.dispatchId }).catch(() => {})
        await host.terminalClose({ terminal: w.terminal }).catch(() => {})
      }
    } finally {
      pending.delete(q)
      q.settle()
    }
  }

  async function close() {
    closed = true
    const asked = [...pending]
    for (const q of asked) {
      q.stopped = true
      q.wake()
    }
    await Promise.all(asked.map((q) => q.done))
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

Find the checks the repo already runs, and nothing else: read its CI config and workflow files (.github/workflows, .gitlab-ci.yml, azure-pipelines.yml and the like), its Makefile or justfile, and its package scripts (package.json scripts, pyproject.toml, Cargo.toml, and their kin). Never read source files, and never run anything but the submit command below.

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
  const comment = (s) => s.replace(/[\r\n]+/g, ' ').replace(/`/g, "'").replace(/\$\{/g, '$ {').replace(/[\\\s]+$/, '')
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

export const triagePrompt = ({ stateDir, notice }) => `You are crew's orchestrator. A workflow run has halted: ${notice.nodes.length === 1 ? 'one node is' : `${notice.nodes.length} nodes are`} held until the operator resumes ${notice.nodes.length === 1 ? 'it' : 'them'} with R: ${notice.nodes.map((n) => n.node).join(', ')}. The run's state is ${runFiles(stateDir)}.

Read what you need of those files, and nothing else: change nothing, and never run anything but the submit command below.

Answer with a short "summary" of the halt, and one entry per held node, in the order halted.json lists them: { "node": its name as halted.json has it, "reason": why it is held, "questions": the questions it left for the operator (empty when it left none), "decide": what the operator must decide before resuming it }.`

// `?` in the run console: the orchestrator for a free conversation with the
// operator about one run, seeded with its run directory.
export const consultPrompt = (stateDir) => `You are crew's orchestrator, opened from the run console for a conversation with the operator about one workflow run. The run's state is ${runFiles(stateDir)}. Read what you need of it, then wait for the operator's questions. Change nothing unless the operator asks you to.`

// A fresh `?` session on a host that starts sessions of no Run (the crew
// host's sessionStart): titled orchestrator/console, in no run's journal, so
// never a node of any run's graph. Returns its session id.
export async function consultSession({ host, stateDir, harness = 'claude', model = null, effort = null, permissionMode = null, dir }) {
  const { terminal } = await host.sessionStart({ title: orchestratorTitle('console'), prompt: consultPrompt(stateDir), harness, model, effort, permissionMode, sessionId: randomUUID(), dir })
  return terminal
}
