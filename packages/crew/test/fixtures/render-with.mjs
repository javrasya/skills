// The workflow template rendered as crew start renders it (renderTemplate),
// every placeholder a test does not care about given a default. A new
// placeholder is one more default here, not an edit to every test that
// renders the template; renderTemplate refuses one left out.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prGuidePath, renderTemplate, templatePath } from '../../src/arm.mjs'

export const PINNED = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567'

export const renderWith = (overrides = {}, template = readFileSync(templatePath(), 'utf8')) =>
  renderTemplate(template, {
    SPEC: 94,
    REPO: 'acme/app',
    REPO_DIR: tmpdir(),
    NOTES_DIR: overrides.NOTES_DIR ?? mkdtempSync(join(tmpdir(), 'crew-notes-')),
    BASE_REF: 'main',
    START_REF: 'main',
    BASE_SHA: PINNED,
    STACK_MODE: 'native',
    RUN_ORDER: 'parallel',
    RUNNER: 'session',
    PER_CHANGE_COMMANDS: '[]',
    AT_REVIEW_COMMANDS: '[]',
    TICKET_RECIPES: '{}',
    PR_GUIDE: prGuidePath(),
    ...overrides,
  })
