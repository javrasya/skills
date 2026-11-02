#!/usr/bin/env node
// chartcheck.mjs — can this machine draw model-checked statecharts (pstack's `statechart` skill), or only
// reasoned ones? Prints JSON; with --html prints the status line a statechart card shows under its chart.
//
//   node chartcheck.mjs          → { mode: "checked" | "checked-first-run" | "reasoned", skill, missing: [...], fix: [...] }
//   node chartcheck.mjs --html   → <div class="chartsrc …">…</div>
//
// What pstack's statechart needs: the skill itself; a runtime for its TypeScript (Node 22.18–22.x or 23.6+,
// Bun 1.1.5+, Deno 2+); and TLC + Java, which it fetches with mise on first run (or TLA2TOOLS + JAVA set).
import { existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir(), env = process.env;
const run = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); } catch { return null; } };
const ver = (cmd) => { const m = (run(cmd, ['--version']) || '').match(/(\d+)\.(\d+)\.(\d+)/); return m ? m.slice(1).map(Number) : null; };
const atLeast = (v, min) => v && (v[0] - min[0] || v[1] - min[1] || v[2] - min[2]) >= 0;

// Same tool pins as the statechart skill's run.ts.
const TLC = 'http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4';
const JAVA = 'java@temurin-25';

const skillDirs = [join(process.cwd(), '.claude/skills/statechart'), join(process.cwd(), '.agents/skills/statechart'),
  join(HOME, '.claude/skills/statechart'), join(HOME, '.agents/skills/statechart')];
const skill = skillDirs.find((d) => existsSync(join(d, 'scripts/statechart')));

const node = process.versions.node.split('.').map(Number); // the node running this is the one on PATH
const runtime = (node && (atLeast(node, [23, 6, 0]) || (node[0] === 22 && atLeast(node, [22, 18, 0]))) && `Node ${node.join('.')}`)
  || (atLeast(ver('bun'), [1, 1, 5]) && 'Bun') || (atLeast(ver('deno'), [2, 0, 0]) && 'Deno') || null;

const pinned = env.TLA2TOOLS && existsSync(env.TLA2TOOLS);
const mise = run('mise', ['--version']) !== null;
const misenv = { cwd: tmpdir(), env: { ...env, MISE_CEILING_PATHS: tmpdir() } };
const fetched = mise && run('mise', ['where', TLC], misenv) && run('mise', ['which', 'java', '--tool', JAVA], misenv);

const missing = [], fix = [];
if (!skill) { missing.push('pstack statechart skill is not installed'); fix.push('npx skills add https://github.com/cursor/plugins/tree/main/pstack -g -s statechart'); }
if (!pinned && !mise) { missing.push('mise is missing (it fetches TLC and Java)'); fix.push('brew install mise'); }
if (!runtime) { missing.push(`no runtime for its TypeScript (Node ${node.join('.')}; needs Node 22.18+ / 23.6+, Bun or Deno)`); fix.push('mise use -g node@lts'); }

const mode = missing.length ? 'reasoned' : (pinned || fetched) ? 'checked' : 'checked-first-run';
const out = { mode, skill: skill ? realpathSync(skill) : null, runtime, tlc: pinned ? 'TLA2TOOLS' : fetched ? 'fetched by mise' : mise ? 'fetched on first run (needs network)' : null, missing, fix };

if (!process.argv.includes('--html')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const html = mode === 'reasoned'
  ? `<div class="chartsrc reasoned" data-no-glossary><span class="badge">Reasoned, not model-checked</span><span>Drawn with plain Mermaid from the code and the decisions so far: no TLC run.</span><span class="why">${missing.map(esc).join(' · ')}</span><span class="fix">To check charts: ${fix.map((f) => `<code>${esc(f)}</code>`).join(' then ')}</span></div>`
  : `<div class="chartsrc checked" data-no-glossary><span class="badge">Model-checked · pstack statechart</span><span>Rules checked by TLC; breaks and bug paths come from its report.</span>${mode === 'checked-first-run' ? '<span class="why">First run fetches TLC and Java with mise (needs network).</span>' : ''}</div>`;
console.log(html);
