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
import { readResult, workerPrompt } from './lifecycle.mjs'
import { validationLineProblem } from './validation-list.mjs'

export const ORCHESTRATOR_PREFIX = 'orchestrator/'
export const orchestratorTitle = (name) => `${ORCHESTRATOR_PREFIX}${name}`
export const isOrchestratorTitle = (title) => typeof title === 'string' && title.startsWith(ORCHESTRATOR_PREFIX)

export class OrchestratorError extends Error {
  constructor(question, reason) {
    super(`the orchestrator gave no valid answer to ${question}: ${reason}`)
    this.question = question
    this.reason = reason
  }
}

const NUDGE = 'Crew has not received your answer: your final message is not read. Run the submit command from your instructions until it exits 0.'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const slug = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60)

// `host` is a session host (session-host.mjs), its worker started in the
// host's own directory; `dir` where each question's schema, payload and
// result go. A question is answered within `answerMs`; an orchestrator idle
// for `idleMs` without an answer is nudged once, then given up on. Its
// session is closed once answered, its harness given `endMs` to end first.
export function orchestrator({ host, harness = 'claude', model = null, effort = null, permissionMode = null, dir, pollMs = 1_000, idleMs = 60_000, answerMs = 15 * 60_000, endMs = 10_000 }) {
  // `name` names the question, in its session's title; `prompt` asks it;
  // `schema` is its answer's, an object at its root as an agent() call's is.
  async function ask({ name, prompt, schema }) {
    checkSchema(schema)
    const fail = (reason) => new OrchestratorError(name, reason)
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
        await sleep(pollMs)
      }
    } catch (e) {
      throw e instanceof OrchestratorError ? e : fail(e?.message ?? String(e))
    } finally {
      // Closed only once its harness has ended: a crew session killed again
      // while its first kill is under way takes the daemon down with it.
      await host.workerStop({ dispatch: w.dispatchId }).catch(() => {})
      for (const until = Date.now() + endMs; Date.now() < until; await sleep(pollMs)) {
        const s = await host.workerShow({ dispatch: w.dispatchId }).catch(() => null)
        if (!s || s.exited || s.gone) break
      }
      await host.terminalClose({ terminal: w.terminal }).catch(() => {})
    }
  }
  return { ask }
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
