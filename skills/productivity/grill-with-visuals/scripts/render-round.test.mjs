import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(new URL('./render-round.mjs', import.meta.url));
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grill-render-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'round.json');
  return {
    put: (file, contents) => writeFileSync(join(dir, file), contents),
    get: (file) => readFileSync(join(dir, file), 'utf8'),
    has: (file) => existsSync(join(dir, file)),
    run(round) {
      writeFileSync(input, JSON.stringify(round));
      return spawnSync(process.execPath, [renderer, input], { cwd: dir, encoding: 'utf8' });
    },
  };
}
const question = { number: 4, title: 'Timeout & retries', body: 'Limit waiting to <5 s?', recommendation: 'Fail fast.' };

test('one input produces a local, escaped HTML round and matching chat copy', (t) => {
  const w = workspace(t);
  const r = w.run({ topic: 'Retries', round: 2, settled: [{ number: 1, decision: 'Retry once.' }], questions: [question] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /index\.html/);
  assert.ok(r.stdout.includes(String.raw`❓ **Q4** - **Timeout \& retries**: Limit waiting to \<5 s?`));
  assert.match(r.stdout, /➡️ Yes — Fail fast\./);
  const html = w.get('index.html');
  assert.match(html, /<title>Retries, round 2<\/title>/);
  assert.match(html, /<b>Q1<\/b> Retry once\./);
  assert.match(html, /id="q4"/);
  assert.match(html, /Timeout &amp; retries.*Limit waiting to &lt;5 s\?/);
  assert.doesNotMatch(html, /class="opts"|class="visual"/);
  assert.ok(w.has('grill.css') && w.has('grill.js'));
  assert.match(r.stderr, /no screenshots needed/i);
  assert.equal(w.has('index.png'), false);
});

test('links glossary terms and reports missing pictures without overwriting explainers', (t) => {
  const w = workspace(t);
  w.put('GLOSSARY.md', '**Timeout**: A limit on waiting.\n\n**Retry**: Another attempt.\n');
  const round = { topic: 'Timing', round: 2, exclude: ['retry'], questions: [question] };
  const first = w.run(round);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /needs its picture: .*timeout\.html/);
  assert.match(first.stderr, /q4: Timeout/);
  assert.match(w.get('index.html'), /href="terms\/timeout.html" data-gl="timeout"/);
  assert.match(w.get('terms/timeout.html'), /href="\.\.\/index\.html#q4"/);
  assert.equal(w.has('terms/retry.html'), false);
  w.put('terms/timeout.html', w.get('terms/timeout.html').replace('data-stub', '').replace('THE PICTURE', 'Hand-authored picture.'));
  const next = w.run({ ...round, round: 3 });
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stderr, /needs its picture/);
  assert.match(w.get('terms/timeout.html'), /Hand-authored picture\./);
});

test('wires each option to its visual and puts the recommendation first', (t) => {
  const w = workspace(t);
  w.put('direct.html', '<pre class="mermaid">flowchart TD\nA --&gt; B</pre>');
  const visual = { today: '<pre>Origin</pre>', views: { A: '<pre>Queue</pre>', B: { file: 'direct.html' } } };
  const q = { ...question, options: [{ name: 'Queue', detail: 'Keep a buffer.' }, { name: 'Direct', detail: 'Drop the buffer.' }], recommendedOption: 'B', visual };
  const r = w.run({ topic: 'Routing', contextLink: { href: 'https://example.org/a?x=1&y=2', label: 'Design' }, round: 1, questions: [q] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /- A\. Queue — Keep a buffer\.\n- B\. Direct — Drop the buffer\./);
  assert.match(r.stdout, /➡️ B — Fail fast\./);
  assert.match(r.stderr, /screenshot if new or changed/);
  const html = w.get('index.html');
  assert.match(html, /href="https:\/\/example\.org\/a\?x=1&amp;y=2"/);
  assert.match(html, /class="opt pick" data-opt="B"/);
  assert.match(html, /class="pane today".*<pre>Origin<\/pre>/);
  assert.match(html, /data-shown>B<\/span>.*class="view" data-opt="B">.*class="mermaid"[\s\S]*class="view" data-opt="A">/);
  const invalid = w.run({ topic: 'Routing', round: 1, questions: [{ ...q, visual: { views: { A: visual.views.A } } }] });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Q4: visual\.views must contain exactly one view per option/);
  assert.equal(w.get('index.html'), html, 'invalid data never replaces the published round');
});

test('closes a round with its decisions and review summary but no approval cards', (t) => {
  const w = workspace(t);
  const r = w.run({ topic: 'Review', settled: [{ number: 1, decision: 'Approve A.' }], questions: [], closingTable: { headers: ['Comment', 'Outcome'], rows: [['Timeout', 'Approved']] } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\| Timeout \| Approved \|/);
  const html = w.get('index.html');
  assert.match(html, /<title>Review, settled<\/title>/);
  assert.match(html, /<tr><td>Timeout<\/td><td>Approved<\/td><\/tr>/);
  assert.doesNotMatch(html, /class="q"|Pick an answer/);
});

test('keeps full review drafts on the card and treats their contents as text', (t) => {
  const w = workspace(t);
  const r = w.run({ topic: 'Review', round: 1, questions: [{ ...question, sections: [
    { title: 'Reviewer said', text: 'Preserve <script> as text.' },
    { title: 'Our response', text: '**Fixed**\n\nAdded a test.', visual: '<pre class="diff"><span>Patch</span></pre>' },
  ] }] });
  assert.equal(r.status, 0, r.stderr);
  const html = w.get('index.html');
  assert.match(html, /class="rec"[\s\S]*Reviewer said[\s\S]*Preserve &lt;script&gt; as text\.[\s\S]*Our response[\s\S]*\*\*Fixed\*\*<br><br>Added a test\.[\s\S]*class="diff"/);
  assert.match(r.stderr, /screenshot if new or changed/i);
});

test('links a glossary entry named Null on the round', (t) => {
  const w = workspace(t);
  w.put('GLOSSARY.md', '**Null**: No value was supplied.\n');
  const r = w.run({ topic: 'Missing values', round: 1, questions: [{ ...question, title: 'Null' }] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(w.get('index.html'), /href="terms\/null.html" data-gl="null"/);
});
