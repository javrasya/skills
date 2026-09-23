#!/usr/bin/env node
// The worker's end of an agent() call on the Orca runner. The worker runs it
// on its result: it validates the payload against the agent's schema and
// exits 1 with every error, so the agent repairs its payload inside its own
// turn. Only a valid payload is recorded, and only then is worker_done sent.
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { validate } from './schema.mjs'
import { orcaCli } from './orca-cli.mjs'

export const USAGE =
  'usage: node submit.mjs --result <file> --payload <file> [--schema <file>] --from <worker_handle> --dispatch-capability <capability> --task-id <task_id> --dispatch-id <dispatch_id>'

const FLAGS = {
  '--schema': 'schema',
  '--result': 'result',
  '--payload': 'payload',
  '--from': 'from',
  '--dispatch-capability': 'capability',
  '--task-id': 'taskId',
  '--dispatch-id': 'dispatchId',
}

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]]
    if (!key) throw new Error(`unknown argument ${argv[i]}`)
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`)
    a[key] = argv[i + 1]
  }
  a.from ??= process.env.ORCA_TERMINAL_HANDLE
  const missing = ['result', 'payload', 'taskId', 'dispatchId'].filter((k) => !a[k])
  if (missing.length) throw new Error(`missing ${missing.map((k) => Object.keys(FLAGS).find((f) => FLAGS[f] === k)).join(', ')}`)
  return a
}

// Windows PowerShell 5.1's `>` writes UTF-16LE with a BOM; an agent that
// writes its payload that way must not read as invalid JSON.
function readText(path) {
  const buf = readFileSync(path)
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  return buf.toString('utf8').replace(/^﻿/, '')
}

export async function submit(argv, { orca, stdout = (s) => process.stdout.write(s + '\n'), stderr = (s) => process.stderr.write(s + '\n') } = {}) {
  let a
  try {
    a = parseArgs(argv)
  } catch (e) {
    stderr(`submit: ${e.message}`)
    stderr(USAGE)
    return 2
  }

  let text
  try {
    text = readText(a.payload)
  } catch (e) {
    stderr(`submit rejected: cannot read payload ${a.payload}: ${e.message}`)
    return 1
  }

  let value = text
  if (a.schema) {
    const schema = JSON.parse(readText(a.schema))
    try {
      value = JSON.parse(text)
    } catch (e) {
      stderr(`submit rejected: payload is not valid JSON: ${e.message}`)
      stderr('Fix the payload and run submit again.')
      return 1
    }
    const errors = validate(schema, value)
    if (errors.length) {
      stderr(`submit rejected: ${errors.length} validation error(s) against ${a.schema}`)
      for (const err of errors) stderr(`  ${err}`)
      stderr('Fix the payload and run submit again.')
      return 1
    }
  }

  // Written whole or not at all: the runner reads this file once it sees the
  // worker settle, and must never read half of it.
  writeFileSync(a.result + '.tmp', JSON.stringify(value))
  renameSync(a.result + '.tmp', a.result)

  try {
    await (orca ?? orcaCli()).workerDone({
      from: a.from,
      capability: a.capability,
      taskId: a.taskId,
      dispatchId: a.dispatchId,
      subject: 'result submitted',
      body: `Submitted a result that is valid against its schema. It is recorded at ${a.result}. Nothing remains for this task.`,
    })
  } catch (e) {
    stderr(`submit: the result is recorded at ${a.result}, but worker_done failed: ${e.message}`)
    stderr('Check the IDs against your Orca preamble and run submit again.')
    return 3
  }
  stdout(`submit accepted: result recorded at ${a.result}; worker_done sent. Stop here and idle.`)
  return 0
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) process.exitCode = await submit(process.argv.slice(2))
