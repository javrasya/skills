// Crew's agent tools (ADR-0027): the one source for the words an agent reads
// about finishing. Each row names a tool, who uses it, what it does, and the
// CLI line an agent runs instead while its session has no such tool. The
// worker prompt's finishing section (lifecycle.mjs) and the doctor prompt's
// mail instructions (doctor.mjs) take their command lines from here, so a tool
// and the prompt naming it cannot drift apart.
import { fileURLToPath } from 'node:url'

export const SUBMIT = fileURLToPath(new URL('./submit.mjs', import.meta.url))

// The IDs an Orca host's preamble names, as a worker copies them into submit.
const ID_PLACEHOLDERS = '--from <worker_handle> --dispatch-capability <capability> --task-id <task_id> --dispatch-id <dispatch_id>'

// `fallback(paths)`: the CLI line, given the worker's files (submit only); a
// doctor's lines leave the command and IDs to its session host's preamble.
/** @type {ReadonlyArray<{ name: string, who: string[], description: string, fallback: (paths?: { schemaPath?: string, resultPath?: string, payloadPath?: string }) => string | null }>} */
export const TOOLS = Object.freeze([
  {
    name: 'submit',
    who: ['worker'],
    description: "Hands the workflow your result, checked against your task's schema, and ends your dispatch. Run it again after a rejection until it is accepted.",
    fallback: ({ schemaPath, resultPath, payloadPath }) => [`node "${SUBMIT}"`, schemaPath && `--schema "${schemaPath}"`, `--result "${resultPath}"`, `--payload "${payloadPath}"`, ID_PLACEHOLDERS].filter(Boolean).join(' '),
  },
  {
    name: 'status',
    who: ['worker', 'doctor'],
    description: 'Tells the run what you are doing now, in one line the operator sees beside your row. It changes nothing in the run.',
    // Run mail has no status type, and a handoff is a doctor's note: a
    // session without the tool sends no status.
    fallback: () => null,
  },
  {
    name: 'needs_you',
    who: ['doctor'],
    description: 'Tells the operator that only a human can clear what blocks you, and what they must do or decide. Wait for them after it, for as long as they take.',
    fallback: () => 'orchestration send --type escalation --subject "Blocked: <what>" --body "<what the human must do or decide>"',
  },
  {
    name: 'handoff',
    who: ['doctor'],
    description: 'Sends your note, the guidance the patient carries on with, and ends your round. The runner takes only your first, so send it once you are done.',
    fallback: () => 'orchestration send --type handoff --subject note --body "<the note>", then worker_done --outcome succeeded',
  },
  {
    name: 'give_up',
    who: ['doctor'],
    description: 'Ends your round without a note, saying why. The runner treats the patient as one no doctor could cure.',
    fallback: () => 'worker_done --outcome failed, with why in the body',
  },
])

export const tool = (name) => {
  const t = TOOLS.find((t) => t.name === name)
  if (!t) throw new Error(`no crew tool named ${name}`)
  return t
}

// The arguments `submit` takes for a result `schema`, and the payload they
// make: a tool's arguments are always an object, so an object schema is its
// parameters as they stand, any other wraps under `result`, and a text result
// (no schema) is its `text`. `how` says so in the worker's prompt
// (lifecycle.mjs), the extension registers it (hooks/crew-pi.mjs).
export function submitShape(schema) {
  if (schema == null) return { parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'Your answer, as plain text.' } } }, payload: (args) => args.text, how: 'your answer as its `text`' }
  if (schema.type === 'object') return { parameters: schema, payload: (args) => args, how: 'your result as its arguments' }
  return { parameters: { type: 'object', required: ['result'], properties: { result: schema } }, payload: (args) => args.result, how: 'your result as its `result`' }
}
