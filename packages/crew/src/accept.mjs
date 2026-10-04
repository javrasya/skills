// The one place a result is accepted (#171): the CLI submit (submit.mjs) and
// the daemon's worker.submit and mail.send (daemon/runs.mjs) take a payload to
// its result here, so a result is checked the same way whichever way it
// came, and a rejection reads the same.
import { validate } from './schema.mjs'

export const RETRY = 'Fix the payload and submit again.'

// `payload` as a result: a value valid against `schema`, JSON text parsed
// first, or text when there is no schema. `against` names the schema in a
// rejection. { value } when accepted, else { errors }: every line saying why.
/** @param {object | null} schema @param {unknown} payload @param {string} [against] @returns {{ value?: unknown, errors?: string[] }} */
export function acceptResult(schema, payload, against = 'its schema') {
  if (schema == null) {
    if (typeof payload !== 'string') return { errors: [`submit rejected: this agent's result is text, not ${JSON.stringify(payload)?.slice(0, 80)}`, RETRY] }
    return { value: payload }
  }
  let value = payload
  if (typeof payload === 'string') {
    try {
      value = JSON.parse(payload)
    } catch (e) {
      return { errors: [`submit rejected: payload is not valid JSON: ${e.message}`, RETRY] }
    }
  }
  const errors = validate(schema, value)
  if (errors.length) return { errors: [`submit rejected: ${errors.length} validation error(s) against ${against}`, ...errors.map((e) => `  ${e}`), RETRY] }
  return { value }
}

// The worker_done an accepted result is sent as; `resultPath`, where it is
// recorded, null for nowhere.
export const acceptedMail = (resultPath) => ({
  type: 'worker_done',
  subject: 'result submitted',
  body: `Submitted a result that is valid against its schema.${resultPath ? ` It is recorded at ${resultPath}.` : ''} Nothing remains for this task.`,
})
