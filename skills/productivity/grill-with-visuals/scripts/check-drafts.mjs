// Exercise the shared answer UI against local files, as the visual skills open them.
// Run with CHROME=/path/to/chrome node check-drafts.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = process.env.CHROME || 'google-chrome';
const dir = mkdtempSync(join(tmpdir(), 'grill-drafts-'));
const page = join(dir, 'index.html');
const oldQuestion = 'Which layout?';
const newQuestion = 'When should it retry?';

function open(round, num, question, answer = false) {
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>Test, round ${round}</title>
<section class="q" id="q1">
  <p class="qline"><span class="qnum">${num}</span> <span class="qtitle">Review</span>: ${question}</p>
</section>
<script src="grill.js"></script>
<script>
  const note = document.querySelector('.note-in');
  if (${answer}) {
    document.querySelector('.yn button').click();
    note.value = 'Use tabs';
    note.dispatchEvent(new Event('input'));
  }
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: undefined });
  document.execCommand = () => { copied = document.activeElement.value; return true; };
  document.querySelector('.copyall').click();
  const output = document.createElement('output');
  output.textContent = JSON.stringify({ note: note.value, choice: document.querySelector('.yn .chosen')?.firstChild.textContent ?? '', copied });
  document.body.append(output);
</script>`);
  const dom = execFileSync(chrome, [
    '--headless', '--no-first-run', '--disable-background-networking',
    `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', pathToFileURL(page).href,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  const output = dom.match(/<output>(.*?)<\/output>/s)?.[1];
  assert.ok(output, 'Chrome did not render the answer UI');
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error('Chrome returned an invalid answer snapshot', { cause: error });
  }
}

try {
  copyFileSync(new URL('../assets/grill.js', import.meta.url), join(dir, 'grill.js'));
  const filled = { note: 'Use tabs', choice: 'Yes', copied: 'Q1 - Review: Yes\nUse tabs' };
  const blank = { note: '', choice: '', copied: '' };
  const cases = [
    ['new draft is copyable', open(1, 'Q1', oldQuestion, true), filled],
    ['reload restores the draft', open(1, 'Q1', oldQuestion), filled],
    ['changed question starts blank even if the card ID is reused', open(2, 'Q2', newQuestion), blank],
    ['next round starts blank even for the same Q number and wording', open(2, 'Q1', oldQuestion), blank],
    ['changed wording starts blank even if the round title and Q number are reused', open(1, 'Q1', newQuestion), blank],
  ];
  for (const [name, actual, expected] of cases) {
    console.log(`${JSON.stringify(actual) === JSON.stringify(expected) ? 'PASS' : 'FAIL'}: ${name}`);
  }
  for (const [name, actual, expected] of cases) assert.deepEqual(actual, expected, name);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
