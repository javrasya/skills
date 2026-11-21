#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, linkRound } from './glossary.mjs';

const assets = new URL('../assets/', import.meta.url);
const lines = (text) => escapeHtml(text).replace(/\r?\n/g, '<br>');
const chatText = (text, indent = '') => text
  .replace(/[\\`*_{}\[\]<>&|~]/g, '\\$&')
  .replace(/^(\s*)([#=+\-]|[0-9]+[.)])/gm, (_, space, marker) => `${space}${marker.slice(0, -1)}\\${marker.slice(-1)}`)
  .replace(/\r?\n/g, `  \n${indent}`);
const questionId = (number) => `Q${number}`;
const letter = (i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i];
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function text(value, name) {
  requireThat(typeof value === 'string' && value.trim(), `${name} must be nonempty text`);
  return value;
}
function number(value, name) {
  requireThat(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}
function list(value, name) {
  requireThat(Array.isArray(value), `${name} must be an array`);
  return value;
}
function writeChanged(file, content) {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
}

function visualHtml(visual, keys, recommended, id, fragment) {
  const intro = visual.intro === undefined ? '' : fragment(visual.intro, `${id}.visual.intro`);
  const after = visual.after === undefined ? '' : fragment(visual.after, `${id}.visual.after`);
  const label = visual.label === undefined ? '' : `<span class="vlabel">${escapeHtml(text(visual.label, `${id}.visual.label`))}</span>`;
  const hasViews = visual.views !== undefined;
  requireThat(!hasViews || (visual.views && typeof visual.views === 'object' && !Array.isArray(visual.views)), `${id}: visual.views must be an object keyed by option letter`);
  let body;
  if (hasViews) {
    requireThat(visual.html === undefined && keys.length && Object.keys(visual.views).length === keys.length && keys.every((key) => Object.hasOwn(visual.views, key)), `${id}: visual.views must contain exactly one view per option, without visual.html`);
    body = [recommended, ...keys.filter((key) => key !== recommended)].map((key) => `<div class="view" data-opt="${key}">${fragment(visual.views[key], `${id}.visual.views.${key}`)}</div>`).join('\n');
  } else {
    body = fragment(visual.html, `${id}.visual.html`);
  }
  if (visual.today !== undefined) {
    const today = fragment(visual.today, `${id}.visual.today`);
    body = `<div class="pair"><div class="pane today"><h3>Today</h3>${today}</div>${proposed(body, hasViews, recommended)}</div>`;
  } else if (hasViews) {
    body = proposed(body, true, recommended);
  }
  return `<div class="visual">${label}${intro}${body}${after}</div>`;
}
function proposed(body, hasViews, recommended) {
  return `<div class="pane new"><h3>Proposed${hasViews ? ` · <span data-shown>${recommended}</span>` : ''}</h3>${body}</div>`;
}

function renderQuestion(q, id, fragment) {
  const heading = text(q.title, `${id}.title`);
  const body = text(q.body, `${id}.body`);
  const rec = text(q.recommendation, `${id}.recommendation`);
  const options = list(q.options ?? [], `${id}.options`);
  requireThat(options.length !== 1 && options.length <= 26, `${id}: give no options or 2–26 options`);
  const keys = options.map((_, i) => letter(i));
  const pick = q.recommendedOption;
  requireThat(keys.length ? keys.includes(pick) : pick === undefined, `${id}: recommendedOption must name an option (omit it for yes/no)`);
  const visual = q.visual === undefined ? '' : visualHtml(q.visual, keys, pick, id, fragment);
  const choices = options.map((option, i) => ({ key: keys[i], name: text(option.name, `${id} option name`), detail: text(option.detail, `${id} option detail`) }));
  const answer = `${pick ?? 'Yes'} — ${rec}`;
  const chatChoices = choices.map(({ key, name, detail }) => `- ${key}. ${chatText(name, '  ')} — ${chatText(detail, '  ')}`).join('\n');
  const chat = [`❓ **${id}** - **${chatText(heading)}**: ${chatText(body)}`, chatChoices, `➡️ ${chatText(answer)}`].filter(Boolean).join('\n\n');
  const opts = choices.length ? `<ul class="opts">\n${choices.map(({ key, name, detail }) => {
    const view = q.visual?.views ? ` data-opt="${key}"` : '';
    return `<li class="opt${key === pick ? ' pick' : ''}"${view}><span class="letter">${key}</span><span><span class="name">${escapeHtml(name)}</span> <span class="cost">— ${lines(detail)}</span></span></li>`;
  }).join('\n')}\n</ul>` : '';
  const content = list(q.sections ?? [], `${id}.sections`);
  const sections = content.map((section) => {
    const title = escapeHtml(text(section.title, `${id} section title`));
    const prose = lines(text(section.text, `${id} section text`));
    let picture = '';
    if (section.visual !== undefined) {
      picture = `<div class="visual">${fragment(section.visual, `${id} section visual`)}</div>`;
    }
    return `<div class="review-section"><h3>${title}</h3><p>${prose}</p>${picture}</div>`;
  }).join('\n');
  const html = `<section class="q" id="${id.toLowerCase()}">
<p class="qline">❓ <span class="qnum">${id}</span> - <span class="qtitle">${escapeHtml(heading)}</span>: ${lines(body)}</p>
${opts}
<div class="rec"><span class="arrow">➡️</span><p>${pick ? `<b>${pick}</b> — ${lines(rec)}` : lines(answer)}</p></div>
${visual}
${sections}
</section>`;
  return { html, chat, hasVisual: Boolean(visual) || content.some((section) => section.visual !== undefined) };
}

function render(input) {
  const dir = path.dirname(input);
  const { topic, round, context, contextLink, legend = {}, settled = [], questions, closingTable, exclude = [] } = JSON.parse(fs.readFileSync(input, 'utf8'));
  text(topic, 'topic');
  list(questions, 'questions');
  const closed = questions.length === 0;
  if (!closed || round !== undefined) number(round, 'round');
  list(exclude, 'exclude').forEach((term) => text(term, 'excluded term'));
  const title = `${topic}, ${closed ? 'settled' : `round ${round}`}`;
  const seen = new Set();
  function unique(n) {
    number(n, 'question number');
    requireThat(!seen.has(n), `duplicate ${questionId(n)}`);
    seen.add(n);
    return questionId(n);
  }
  // Only visual fragments are trusted HTML. All discussion data is escaped separately.
  function fragment(source, name) {
    if (typeof source === 'string') return text(source, name);
    const file = text(source?.file, `${name}.file`);
    const relative = path.relative(dir, path.resolve(dir, file));
    requireThat(!path.isAbsolute(file) && relative && relative !== '..' && !relative.startsWith(`..${path.sep}`), `${name}.file must be inside the round folder`);
    return text(fs.readFileSync(path.join(dir, relative), 'utf8'), name);
  }

  const decisions = list(settled, 'settled').map(({ number: n, decision }) => ({ id: unique(n), decision: text(decision, 'decision') }));
  const settledHtml = decisions.length ? `<section class="settled" id="settled" aria-label="Settled so far"><h2>Settled so far</h2><ul>\n${decisions.map(({ id, decision }) => `<li><b>${id}</b> ${lines(decision)}</li>`).join('\n')}\n</ul></section>` : '';
  const cards = questions.map((q) => renderQuestion(q, unique(q.number), fragment));
  const chat = cards.map((card) => card.chat);
  const today = questions.some((q) => q.visual?.today !== undefined);
  const proposed = today || questions.some((q) => q.visual?.views !== undefined);

  let contextHtml = context === undefined ? '' : lines(text(context, 'context'));
  if (contextLink !== undefined) {
    const label = text(contextLink.label, 'contextLink.label');
    const href = text(contextLink.href, 'contextLink.href');
    requireThat(/^https?:\/\/[^\s]+$/i.test(href) || /^(?![/\\]{2})[^:\\\s]+$/.test(href), 'contextLink.href must be HTTP(S) or a local path');
    contextHtml += `${contextHtml ? ' ' : ''}<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  }
  if (!closed) contextHtml += `${contextHtml ? ' ' : ''}Pick an answer on each card and add anything in its box, then copy them all with the button at the bottom right and paste them in the chat.`;
  const chips = [
    [legend.today || today, 'today', 'today'],
    [legend.proposed || proposed, 'new', 'proposed'],
    [!closed, 'rec', 'recommendation'],
    [legend.aside !== undefined, 'aside', legend.aside],
  ].filter(([enabled]) => enabled).map(([, cls, name]) => `<span class="chip ${cls}">● ${escapeHtml(text(name, `legend.${cls}`))}</span>`);
  const summary = closingTable === undefined ? '' : renderClosingTable(closingTable, closed, chat);
  if (closed && decisions.length) chat.unshift(decisions.map(({ id, decision }) => `- **${id}** ${chatText(decision, '  ')}`).join('\n'));
  const slots = {
    TITLE: escapeHtml(title), CONTEXT: contextHtml ? `<p class="sub">${contextHtml}</p>` : '',
    LEGEND: chips.join('\n      '), SETTLED: settledHtml, CARDS: cards.map((card) => card.html).join('\n'), SUMMARY: summary,
    FOOT: closed ? '' : '<p class="foot">Or answer in the chat, e.g. “q2 yes, q3 C because…”.</p>',
  };
  const template = fs.readFileSync(new URL('round.template.html', assets), 'utf8');
  const page = path.join(dir, 'index.html');
  for (const asset of ['grill.css', 'grill.js']) writeChanged(path.join(dir, asset), fs.readFileSync(new URL(asset, assets), 'utf8'));
  const html = template.replace(/\{\{([A-Z]+)\}\}/g, (_, slot) => slots[slot]);
  writeChanged(page, linkRound(page, html, exclude));
  const chatCopy = closed
    ? [page, ...chat].join('\n\n')
    : [page, chat.join('\n\n---\n\n'), 'Answer on the page and paste the copied block, or answer here.'].join('\n\n');
  console.log(chatCopy);
  console.error(cards.some((card) => card.hasVisual) ? `Round contains pictures; screenshot if new or changed: ${page}` : 'No screenshots needed for the round (text only).');
}

function renderClosingTable({ headers, rows }, closed, chat) {
  requireThat(closed, 'closingTable belongs on a settled page');
  const columns = list(headers, 'closingTable.headers').map((cell) => text(cell, 'column heading'));
  requireThat(columns.length, 'closingTable needs at least one column');
  list(rows, 'closingTable.rows').forEach((row) => {
    requireThat(list(row, 'table row').length === columns.length && row.every((cell) => typeof cell === 'string'), 'each table row must contain one text cell per heading');
  });
  const markdown = (row) => `| ${row.join(' | ')} |`;
  const literalCells = (row) => row.map((cell) => chatText(cell.replace(/\r?\n/g, ' ')));
  chat.push([literalCells(columns), columns.map(() => '---'), ...rows.map(literalCells)].map(markdown).join('\n'));
  const tr = (row, tag) => `<tr>${row.map((cell) => `<${tag}>${lines(cell)}</${tag}>`).join('')}</tr>`;
  return `<section class="settled" aria-label="Summary"><h2>Summary</h2><table><thead>${tr(columns, 'th')}</thead><tbody>${rows.map((row) => tr(row, 'td')).join('')}</tbody></table></section>`;
}

try {
  requireThat(process.argv.length === 3, 'usage: node render-round.mjs <round.json>');
  render(path.resolve(process.argv[2]));
} catch (error) {
  console.error(`render-round: ${error.message}`);
  process.exitCode = 1;
}
