#!/usr/bin/env node
// Glossary terms for a grilling page. Node >= 18, no dependencies.
//
//   node glossary.mjs terms [--glossary <file|dir>]
//       Print the parsed glossary as JSON: { sources, terms: { <slug>: {term, forms, section, html, avoid} } }.
//
//   node glossary.mjs link <page.html> [--glossary <file|dir>] [--out <file>] [--max <n>] [--exclude a,b]
//       Turn glossary terms in the page's text into links with a hover/focus/tap tooltip,
//       append a "Terms on this page" list, and inject the tooltip CSS + JS. Rewrites the page
//       in place unless --out is given. Idempotent: a re-run strips its previous injection first.
//
// --glossary defaults to the current directory. A directory is searched upward (stopping at the
// git root) for GLOSSARY-MAP.md, GLOSSARY.md, CONTEXT-MAP.md, CONTEXT.md; a map pulls in every
// local .md it links to. No glossary found: `link` leaves the page untouched and says so.

import fs from 'node:fs';
import path from 'node:path';

// ---------- glossary discovery ----------

const ROOT_NAMES = ['GLOSSARY-MAP.md', 'GLOSSARY.md', 'CONTEXT-MAP.md', 'CONTEXT.md'];

function findGlossary(start) {
  const abs = path.resolve(start);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return expandMap(abs);
  let dir = abs;
  for (;;) {
    for (const name of ROOT_NAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return expandMap(p);
    }
    if (fs.existsSync(path.join(dir, '.git'))) return [];
    const up = path.dirname(dir);
    if (up === dir) return [];
    dir = up;
  }
}

function expandMap(file) {
  if (!/-MAP\.md$/i.test(file)) return [file];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    if (/^[a-z]+:/i.test(m[1])) continue;
    const p = path.resolve(path.dirname(file), m[1]);
    if (fs.existsSync(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

// ---------- glossary parsing ----------

const STRUCTURAL = /^(context|glossary|language|contexts|relationships|terms|example dialogue|flagged ambiguities)$/i;

function slugify(s) {
  return s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'term';
}
const norm = (s) => s.toLowerCase().replace(/['’]/g, "'").replace(/[\s\-]+/g, ' ').trim();

function splitSentences(text) {
  return text.split(/(?<!\be\.g\.)(?<!\bi\.e\.)(?<!\bvs\.)(?<=[.!?])\s+(?=[A-Z0-9\[*_`(])/);
}

function balance(md) {
  if ((md.match(/\*\*/g) || []).length % 2) md += '**';
  if ((md.match(/`/g) || []).length % 2) md += '`';
  return md;
}

function excerpt(md, maxSentences = 2, maxChars = 420) {
  const sents = splitSentences(md.trim());
  let out = '';
  for (const s of sents.slice(0, maxSentences)) {
    if (out && (out + ' ' + s).length > maxChars) break;
    out = out ? out + ' ' + s : s;
  }
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  return balance(out);
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function mdInline(md) {
  const codes = [];
  let s = escapeHtml(md).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

// Splits "Crew, the session host, the run console, and the orchestrator" into its terms.
function headingParts(heading) {
  return heading
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s+vs\.?\s+/i)
    .map((p) => p.trim().replace(/^(the|a|an|its|their)\s+/i, '').replace(/\s+/g, ' ').trim())
    .filter((p) => p && !/^(what|how|why|when|where|which|who)\b/i.test(p) && p.split(' ').length <= 5);
}

function parseGlossary(text, source) {
  const lines = text.split(/\r?\n/);
  const sections = []; // {heading, level, lines[]}
  let cur = { heading: null, level: 0, lines: [] };
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      sections.push(cur);
      cur = { heading: h[2], level: h[1].length, lines: [] };
    } else cur.lines.push(line);
  }
  sections.push(cur);

  const hasH3 = sections.some((s) => s.level >= 3);
  const entries = [];
  const wikiTargets = [];

  for (const sec of sections) {
    const body = sec.lines.join('\n');
    for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) wikiTargets.push({ target: m[1].trim(), alias: m[2]?.trim() });

    // Paragraphs: blank-line separated, list items kept as their own paragraphs.
    const paras = [];
    let buf = [];
    const flush = () => { if (buf.length) paras.push(buf.join(' ').trim()); buf = []; };
    for (const l of sec.lines) {
      if (!l.trim()) flush();
      else if (/^\s*([-*+]|\d+\.)\s/.test(l)) { flush(); buf.push(l.replace(/^\s*([-*+]|\d+\.)\s+/, '')); }
      else buf.push(l.trim());
    }
    flush();

    const avoidParas = paras.filter((p) => /^_Avoid_/.test(p));
    const prose = paras.filter((p) => !/^_Avoid_/.test(p));
    const avoidOf = (p) => p.replace(/^_Avoid_\s*:?\s*/, '');

    // 1. Format-style entries: "**Term**:" opening a paragraph.
    const fmtParas = [];
    for (let i = 0; i < paras.length; i++) {
      const m = /^\*\*([^*]+)\*\*\s*:\s*(.*)$/.exec(paras[i]);
      if (!m) continue;
      fmtParas.push(i);
      let def = m[2];
      let avoid = null;
      const am = /\s*_Avoid_\s*:?\s*(.*)$/.exec(def);
      if (am) { avoid = am[1]; def = def.slice(0, am.index); }
      if (!avoid && paras[i + 1] && /^_Avoid_/.test(paras[i + 1])) avoid = avoidOf(paras[i + 1]);
      entries.push({ term: m[1].trim(), section: sec.heading && !STRUCTURAL.test(sec.heading) ? sec.heading : null, md: def, avoid, rank: 0, source });
    }

    // 2. Heading-defined terms.
    const isTermHeading = sec.heading && !STRUCTURAL.test(sec.heading) && (hasH3 ? sec.level >= 3 : sec.level >= 2) && !fmtParas.length;
    const lead = prose.find((p) => !/^\*\*[^*]+\*\*\s*:/.test(p)) || '';
    const boldIn = (term) => {
      const re = new RegExp(`\\*\\*${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\*\\*`, 'i');
      for (const p of prose) for (const s of splitSentences(p)) if (re.test(s)) return s;
      return null;
    };
    if (isTermHeading) {
      const parts = headingParts(sec.heading);
      parts.forEach((part, i) => {
        const sentence = boldIn(part);
        if (i === 0) {
          entries.push({ term: part, section: sec.heading, md: excerpt(lead), avoid: avoidParas[0] ? avoidOf(avoidParas[0]) : null, rank: 1, source });
        } else if (sentence) {
          entries.push({ term: part, section: sec.heading, md: excerpt(sentence, 1), avoid: null, rank: 2, source });
        } else {
          entries.push({ term: part, section: sec.heading, md: excerpt(lead), avoid: null, rank: 4, source, weak: true });
        }
      });
    }

    // 3. Terms bolded as a definition inside prose: "a **brief** is ...", "the **frontier**".
    if (sec.heading && !STRUCTURAL.test(sec.heading)) {
      for (const p of prose) {
        for (const s of splitSentences(p)) {
          for (const m of s.matchAll(/(?:^|\b(?:a|an|the|its|their)\s+)\*\*([A-Za-z][\w'’ -]{1,40})\*\*(?=\s|[,.:;—)])/g)) {
            const term = m[1].trim();
            // A lone bolded word in prose is usually emphasis ("**parallel**"), and a phrase with a
            // verb is a claim: keep multi-word noun phrases only.
            const words = term.split(/\s+/);
            if (words.length < 2 || words.length > 4) continue;
            if (/^(not|never|no|only|all|every|one|both|each|before|after|nothing|first|last)\b/i.test(term)) continue;
            if (/\s(is|are|was|were|has|have|does|do|can|may|must)(\s|$)/i.test(term)) continue;
            entries.push({ term, section: sec.heading, md: excerpt(s, 1), avoid: null, rank: 3, source });
          }
        }
      }
    }
  }
  return { entries, wikiTargets };
}

function buildTerms(files) {
  let entries = [];
  let wikiTargets = [];
  for (const f of files) {
    const r = parseGlossary(fs.readFileSync(f, 'utf8'), f);
    entries = entries.concat(r.entries);
    wikiTargets = wikiTargets.concat(r.wikiTargets);
  }
  const wikiNorm = new Set(wikiTargets.flatMap((w) => [norm(w.target), w.alias && norm(w.alias)]).filter(Boolean));
  // A weak heading part (not bolded in its section) survives only if something links to it.
  entries = entries.filter((e) => !e.weak || wikiNorm.has(norm(e.term)));

  const byNorm = new Map();
  for (const e of entries.sort((a, b) => a.rank - b.rank)) {
    const k = norm(e.term);
    if (!k || byNorm.has(k)) continue;
    byNorm.set(k, e);
  }
  const terms = {};
  const used = new Set();
  for (const [k, e] of byNorm) {
    let slug = slugify(e.term);
    while (used.has(slug)) slug += '-x';
    used.add(slug);
    terms[slug] = {
      term: e.term,
      forms: [k],
      section: e.section,
      html: mdInline(e.md || ''),
      avoid: e.avoid ? mdInline(excerpt(e.avoid, 1, 260)) : null,
      source: e.source,
    };
    e.slug = slug;
  }
  // Wikilink aliases ("[[crew|session host]]") become extra forms of their target.
  for (const w of wikiTargets) {
    const target = byNorm.get(norm(w.target));
    if (!target) continue;
    for (const form of [w.target, w.alias].filter(Boolean)) {
      const k = norm(form);
      if (!byNorm.has(k) && !terms[target.slug].forms.includes(k)) terms[target.slug].forms.push(k);
    }
  }
  return terms;
}

// ---------- page linking ----------

const START = '<!-- glossary:start -->';
const END = '<!-- glossary:end -->';
const SKIP_TAGS = new Set(['a', 'code', 'pre', 'script', 'style', 'title', 'head', 'textarea', 'button', 'select', 'option', 'svg', 'kbd', 'samp', 'h1', 'template']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function stripInjection(html) {
  html = html.replace(/[ \t]*<!-- glossary:start -->[\s\S]*?<!-- glossary:end -->\n?/g, '');
  html = html.replace(/\n[ \t]*<span class="chip gl" data-gl-injected[^>]*>[^<]*<\/span>/g, '');
  return html.replace(/<a class="gl" [^>]*data-gl="[^"]*"[^>]*>([\s\S]*?)<\/a>/g, '$1');
}

function formRegex(form) {
  return form
    .split(' ')
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]"))
    .join('[\\s\\u00a0-]+');
}

function linkPage(html, terms, { max = 2, exclude = [], hrefOf = (slug) => `#gl-${slug}` } = {}) {
  html = stripInjection(html);
  const excluded = new Set(exclude.map(norm));
  const forms = [];
  for (const [slug, t] of Object.entries(terms)) {
    if (excluded.has(norm(t.term))) continue;
    for (const f of t.forms) if (!excluded.has(f) && f.length >= 2) forms.push({ f, slug });
  }
  forms.sort((a, b) => b.f.length - a.f.length);
  if (!forms.length) return { html, used: [], perScope: [] };
  const slugOf = new Map(forms.map((x) => [x.f, x.slug]));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_&-])(${forms.map((x) => formRegex(x.f)).join('|')})(?:e?s)?(?![\\p{L}\\p{N}_]|-\\p{L})`, 'giu');

  const stack = []; // {name, skip, scope}
  const scopes = [new Map()];
  const perScope = [{ label: '(page)', links: [] }];
  const used = new Set();
  let out = '';
  for (const tok of html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+|</g) || []) {
    if (tok[0] === '<' && tok.length > 1 && tok[1] !== '!') {
      const close = tok[1] === '/';
      const name = (/^<\/?([a-zA-Z0-9-]+)/.exec(tok) || [])[1]?.toLowerCase();
      if (close) {
        const i = stack.map((x) => x.name).lastIndexOf(name);
        if (i !== -1) {
          for (const x of stack.splice(i)) if (x.scope) scopes.pop();
        }
      } else if (name && !VOID.has(name) && !tok.endsWith('/>')) {
        const skip = SKIP_TAGS.has(name) || /\sdata-no-glossary\b/.test(tok) || /\sclass="[^"]*\b(legend|chip)\b/.test(tok);
        const scope = name === 'section' || /\sdata-glossary-scope\b/.test(tok);
        stack.push({ name, skip, scope });
        if (scope) {
          scopes.push(new Map());
          const id = /\sid="([^"]*)"/.exec(tok) || /\saria-label="([^"]*)"/.exec(tok);
          perScope.push({ label: id ? id[1] : `<${name}> ${perScope.length}`, links: [] });
          scopes[scopes.length - 1].report = perScope[perScope.length - 1];
        }
      }
      out += tok;
      continue;
    }
    if (tok[0] === '<' || stack.some((x) => x.skip)) { out += tok; continue; }
    const counts = scopes[scopes.length - 1];
    const report = counts.report || perScope[0];
    out += tok.replace(re, (m, g1) => {
      const slug = slugOf.get(norm(g1));
      if (!slug) return m;
      const n = counts.get(slug) || 0;
      if (n >= max) return m;
      counts.set(slug, n + 1);
      used.add(slug);
      report.links.push(m);
      (report.slugs ||= new Set()).add(slug);
      return `<a class="gl" href="${hrefOf(slug)}" data-gl="${slug}">${m}</a>`;
    });
  }
  return { html: out, used: [...used], perScope: perScope.filter((s) => s.links.length), slugsOf: perScope.filter((s) => s.links.length).map((s) => ({ label: s.label, slugs: [...(s.slugs || [])] })) };
}

const CSS = `
:root { --gl: #6a4bc4; --gl-bg: #efeafb; --gl-tip-bg: #1d1a2b; --gl-tip-ink: #f3f1fa; --gl-tip-muted: #b9b2d3; --gl-tip-avoid: #ffb4a3; }
a.gl { color: inherit; text-decoration: underline dotted var(--gl); text-decoration-thickness: 2px; text-underline-offset: 3px; cursor: help; border-radius: 3px; }
a.gl:hover, a.gl[aria-describedby] { background: var(--gl-bg); color: var(--gl); }
a.gl:focus-visible { outline: 2px solid var(--gl); outline-offset: 2px; }
.chip.gl { background: var(--gl-bg); color: var(--gl); text-decoration: underline dotted; text-underline-offset: 3px; }
#gl-tip { position: fixed; z-index: 1000; max-width: min(380px, calc(100vw - 24px)); padding: 12px 14px; border-radius: 10px; background: var(--gl-tip-bg); color: var(--gl-tip-ink); font-size: 0.88rem; line-height: 1.5; box-shadow: 0 8px 28px rgba(0,0,0,.28); display: flex; flex-direction: column; gap: 6px; }
#gl-tip[hidden] { display: none; }
#gl-tip .gl-term { font-weight: 700; }
#gl-tip .gl-sec { color: var(--gl-tip-muted); font-size: 0.78rem; }
#gl-tip .gl-more { color: var(--gl-tip-ink); font-weight: 600; }
.gl-terms dt a { color: inherit; }
#gl-tip .gl-avoid { color: var(--gl-tip-avoid); font-size: 0.84rem; }
#gl-tip code, .gl-terms code { font-size: 0.8rem; background: transparent; padding: 0; }
.gl-terms { display: flex; flex-direction: column; gap: 10px; }
.gl-terms dl { margin: 0; display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 8px 18px; font-size: 0.92rem; }
.gl-terms dt { font-weight: 600; color: var(--gl); scroll-margin-top: 24px; }
.gl-terms dd { margin: 0; max-width: 70ch; }
.gl-terms dd .gl-avoid { display: block; color: var(--muted, #666); font-size: 0.86rem; }
.gl-terms dt:target, .gl-terms dt:target + dd { background: var(--gl-bg); }
@media (max-width: 560px) { .gl-terms dl { grid-template-columns: 1fr; } .gl-terms dd { margin-bottom: 8px; } }
`;

const JS = `
(() => {
  const data = JSON.parse(document.getElementById('gl-data').textContent);
  const tip = document.getElementById('gl-tip');
  let cur = null, hideTimer = 0, touch = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function place(a) {
    const r = a.getBoundingClientRect(), t = tip.getBoundingClientRect(), gap = 8;
    let top = r.bottom + gap;
    if (top + t.height > innerHeight - 8 && r.top - gap - t.height > 8) top = r.top - gap - t.height;
    const left = Math.max(12, Math.min(r.left, innerWidth - t.width - 12));
    tip.style.top = top + 'px'; tip.style.left = left + 'px';
  }
  function show(a) {
    clearTimeout(hideTimer);
    const d = data[a.dataset.gl]; if (!d) return;
    if (cur !== a) {
      if (cur) cur.removeAttribute('aria-describedby');
      tip.innerHTML = '<div><span class="gl-term"></span></div><div class="gl-def">' + d.html + '</div>' +
        (d.avoid ? '<div class="gl-avoid"><b>Avoid:</b> ' + d.avoid + '</div>' : '') +
        (d.section && d.section.toLowerCase() !== d.term.toLowerCase() ? '<div class="gl-sec"></div>' : '') +
        (d.href ? '<a class="gl-more" href="' + d.href + '">Open the explainer →</a>' : '');
      tip.querySelector('.gl-term').textContent = d.term;
      const sec = tip.querySelector('.gl-sec'); if (sec) sec.textContent = 'Glossary: ' + d.section;
      cur = a; a.setAttribute('aria-describedby', 'gl-tip');
    }
    tip.hidden = false; place(a);
  }
  function hideNow() {
    clearTimeout(hideTimer); tip.hidden = true;
    if (cur) { cur.removeAttribute('aria-describedby'); delete cur.dataset.armed; }
    cur = null;
  }
  const hide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hideNow, reduce ? 0 : 200); };
  document.addEventListener('pointerdown', (e) => {
    touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (!e.target.closest('a.gl, #gl-tip')) hideNow();
  });
  document.addEventListener('mouseover', (e) => {
    if (touch) return;
    const a = e.target.closest('a.gl');
    if (a) show(a); else if (e.target.closest('#gl-tip')) clearTimeout(hideTimer);
  });
  document.addEventListener('mouseout', (e) => { if (!touch && e.target.closest('a.gl, #gl-tip')) hide(); });
  document.addEventListener('focusin', (e) => { const a = e.target.closest('a.gl'); if (a) show(a); });
  document.addEventListener('focusout', (e) => { if (e.target.closest('a.gl')) hide(); });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.gl');
    if (!a || !touch) return;
    if (a.dataset.armed) return; // second tap: follow the link to the term list
    e.preventDefault();
    document.querySelectorAll('a.gl[data-armed]').forEach((x) => delete x.dataset.armed);
    a.dataset.armed = '1'; show(a);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tip.hidden) hideNow(); });
  addEventListener('scroll', () => { if (cur && !tip.hidden) place(cur); }, { passive: true });
  addEventListener('resize', () => { if (cur && !tip.hidden) place(cur); });
})();
`;

function inject(html, terms, used, hrefs = {}) {
  if (!used.length) return html;
  const data = {};
  const sorted = used.slice().sort((a, b) => terms[a].term.localeCompare(terms[b].term));
  for (const s of sorted) {
    const t = terms[s];
    data[s] = { term: t.term, section: t.section, html: t.html, avoid: t.avoid, href: hrefs[s] };
  }
  const list = sorted
    .map((s) => {
      const t = terms[s];
      const name = hrefs[s] ? `<a href="${hrefs[s]}">${escapeHtml(t.term)} →</a>` : escapeHtml(t.term);
      return `<dt id="gl-${s}">${name}</dt><dd>${t.html}${t.avoid ? `<span class="gl-avoid">Avoid: ${t.avoid}</span>` : ''}</dd>`;
    })
    .join('\n      ');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const appendix = `<section class="gl-terms" data-no-glossary aria-label="Glossary terms on this page">
    <h2>Terms on this page</h2>
    <dl>
      ${list}
    </dl>
  </section>`;
  const tail = `<style>${CSS}</style>
<div id="gl-tip" role="tooltip" hidden></div>
<script type="application/json" id="gl-data">${json}</script>
<script>${JS}</script>`;

  // The list goes first: right after the page's <header>, else at the top of <main>; the rest before </body>.
  const headerEnd = html.indexOf('</header>');
  const mainStart = html.search(/<main[^>]*>/);
  const at = headerEnd !== -1 ? headerEnd + '</header>'.length : mainStart !== -1 ? html.indexOf('>', mainStart) + 1 : -1;
  const block = `${START}\n${tail}\n${END}\n`;
  if (at !== -1) {
    html = html.slice(0, at) + `\n  ${START}\n  ${appendix}\n  ${END}` + html.slice(at);
    const bodyEnd = html.lastIndexOf('</body>');
    html = bodyEnd !== -1 ? html.slice(0, bodyEnd) + block + html.slice(bodyEnd) : html + block;
  } else {
    const bodyEnd = html.lastIndexOf('</body>');
    const all = `${START}\n${appendix}\n${tail}\n${END}\n`;
    html = bodyEnd !== -1 ? html.slice(0, bodyEnd) + all + html.slice(bodyEnd) : html + all;
  }
  // A legend chip that says what the dotted underline means.
  html = html.replace(/(<[a-z]+ [^>]*class="[^"]*\blegend\b[^"]*"[^>]*>)/, `$1\n      <span class="chip gl" data-gl-injected>glossary term: hover or tap</span>`);
  return html;
}

const stripAll = stripInjection;

// ---------- CLI ----------

function explainerSetup(page, html) {
  const meta = (name) => (new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html) || [])[1];
  const rel = meta('gl-explainers');
  if (rel === undefined) return { dir: null, self: null, href: () => null };
  const dir = path.resolve(path.dirname(page), rel);
  return {
    dir,
    self: meta('gl-self') || null,
    href: (slug) => (fs.existsSync(path.join(dir, `${slug}.html`)) ? path.relative(path.dirname(page), path.join(dir, `${slug}.html`)) : null),
  };
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opts[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else opts._.push(a);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd, page] = opts._;
  const files = findGlossary(opts.glossary || process.cwd());
  if (cmd === 'terms') {
    const terms = files.length ? buildTerms(files) : {};
    process.stdout.write(JSON.stringify({ sources: files, terms }, null, 2) + '\n');
    return;
  }
  if (cmd === 'link' && page) {
    const html = fs.readFileSync(page, 'utf8');
    const target = opts.out || page;
    if (!files.length) {
      if (target !== page) fs.writeFileSync(target, stripAll(html));
      console.error('no glossary found: page left without term links');
      return;
    }
    const terms = buildTerms(files);
    const max = Number(opts.max ?? 1);
    const exclude = typeof opts.exclude === 'string' ? opts.exclude.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const ex = explainerSetup(page, html);
    if (ex.self) exclude.push(...(terms[ex.self] ? [terms[ex.self].term] : []));
    const r = linkPage(stripAll(html), terms, { max, exclude, hrefOf: (slug) => ex.href(slug) || `#gl-${slug}` });
    const hrefs = Object.fromEntries(r.used.map((slug) => [slug, ex.href(slug)]).filter(([, h]) => h));
    fs.writeFileSync(target, inject(r.html, terms, r.used, hrefs));
    console.error(`glossary: ${files.join(', ')} (${Object.keys(terms).length} terms)`);
    console.error(`linked ${r.used.length} distinct terms -> ${target}`);
    for (const s of r.perScope) console.error(`  ${s.label}: ${s.links.join(' · ')}`);
    if (ex.dir) console.error(`explainers: ${Object.keys(hrefs).length} of ${r.used.length} terms have one in ${path.relative(process.cwd(), ex.dir) || '.'}`);
    return;
  }
  if (cmd === 'explainers' && page) {
    if (!files.length) { console.error('no glossary found: no explainers to write'); return; }
    const html = fs.readFileSync(page, 'utf8');
    const terms = buildTerms(files);
    const ex = explainerSetup(page, html);
    if (!ex.dir) { console.error('the page names no explainer folder (<meta name="gl-explainers">)'); process.exit(2); }
    const r = linkPage(stripAll(html), terms, { max: Number(opts.max ?? 1) });
    const usedIn = {};
    for (const sc of r.slugsOf) for (const slug of sc.slugs) (usedIn[slug] ||= []).push(sc.label);
    const tpl = fs.readFileSync(new URL('../assets/term.template.html', import.meta.url), 'utf8');
    const back = path.relative(ex.dir, page);
    fs.mkdirSync(ex.dir, { recursive: true });
    const made = [], stubs = [];
    for (const slug of r.used) {
      const file = path.join(ex.dir, `${slug}.html`);
      if (!fs.existsSync(file)) {
        const t = terms[slug];
        const where = (usedIn[slug] || []).map((l) => `<li><a href="${back}#${l}">${escapeHtml(l.toUpperCase())}</a></li>`).join('\n      ') || '<li>On the round page.</li>';
        fs.writeFileSync(file, tpl
          .replaceAll('{{TERM}}', escapeHtml(t.term)).replaceAll('{{SLUG}}', slug).replaceAll('{{BACK}}', back)
          .replace('{{DEFINITION}}', t.html).replace('{{SECTION}}', escapeHtml(t.section || t.term))
          .replace('{{AVOID}}', t.avoid ? `<p class="m">Avoid: ${t.avoid}</p>` : '')
          .replace('{{USED_IN}}', where));
        made.push(path.relative(process.cwd(), file));
      }
      if (/\sdata-stub\b/.test(fs.readFileSync(file, 'utf8'))) stubs.push(path.relative(process.cwd(), file));
    }
    console.error(`explainers: ${r.used.length} terms on the page, ${made.length} new`);
    for (const f of made) console.error(`  new   ${f}`);
    for (const f of stubs) console.error(`  needs its picture: ${f}`);
    return;
  }
  console.error('usage: glossary.mjs terms [--glossary <file|dir>]\n       glossary.mjs link <page.html> [--glossary <file|dir>] [--out <file>] [--max 1] [--exclude a,b]\n       glossary.mjs explainers <page.html> [--glossary <file|dir>]');
  process.exit(2);
}

main();
