// The pack step: the workflow template lives in the skill folder, and only a
// copy taken at pack time ships in the package (ADR-0017).
import { copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('../../../skills/engineering/implement-spec-in-workflow/workflow.template.js', import.meta.url))
const COPY = fileURLToPath(new URL('../workflow.template.js', import.meta.url))

if (process.argv.includes('--clean')) rmSync(COPY, { force: true })
else copyFileSync(SOURCE, COPY)
