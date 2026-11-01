#!/usr/bin/env node
// Screenshot a grill page with every option's view shown, so each diagram, mockup and chart can be looked at
// once before the page goes to the user. No dependencies: drives an installed Chrome or Chromium headless.
//
//   node shoot.mjs <page.html> [out.png] [--width 1280] [--height 5000]
//
// Set CHROME to the browser's path if it is not found.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args.splice(i, 2)[1]; };
const width = Number(opt('width', 1280));
const height = Number(opt('height', 5000));
const [page, outArg] = args;
if (!page) { console.error('usage: shoot.mjs <page.html> [out.png] [--width 1280] [--height 5000]'); process.exit(2); }

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const known = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of known) if (fs.existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const chrome = findChrome();
if (!chrome) { console.error('no Chrome or Chromium found: set CHROME to its path'); process.exit(1); }

const abs = path.resolve(page);
const out = path.resolve(outArg || abs.replace(/\.html?$/, '') + '.png');
// The copy sits next to the page so grill.css, grill.js and its links resolve the same way.
const copy = path.join(path.dirname(abs), `.${path.basename(abs)}.shoot.html`);
const reveal = `<script>(function wait(){if(document.documentElement.dataset.ready){document.querySelectorAll('.view[hidden]').forEach(function(v){v.hidden=false})}else setTimeout(wait,100)})()</script>`;
fs.writeFileSync(copy, fs.readFileSync(abs, 'utf8').replace(/<\/body>/i, `${reveal}</body>`));
try {
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=15000',
    `--window-size=${width},${height}`, `--screenshot=${out}`, `file://${copy}`,
  ], { encoding: 'utf8', timeout: 90000 });
  if (r.status !== 0 || !fs.existsSync(out)) { console.error(r.stderr || 'Chrome took no screenshot'); process.exit(1); }
  console.log(out);
} finally {
  fs.rmSync(copy, { force: true });
}
