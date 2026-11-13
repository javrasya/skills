// grill-with-visuals: shared by every round page and term explainer. Copied once next to the pages.
  // An animation card: draw(t) renders any moment from the time alone; the player only moves t.
  window.player = function (id, length, draw) {
    var cv = document.getElementById(id), card = cv.closest('.player');
    var play = card.querySelector('[data-play]'), scrub = card.querySelector('[data-scrub]');
    var clock = card.querySelector('[data-clock]'), speedBtn = card.querySelector('[data-speed]');
    var t = 0, speed = 1, running = false, last = 0;
    scrub.max = length;
    function render() { draw(cv.getContext('2d'), t); scrub.value = t.toFixed(1); clock.textContent = t.toFixed(1) + ' s'; }
    function frame(now) {
      if (!running) return;
      t = Math.min(length, t + (now - last) / 1000 * speed); last = now; render();
      if (t >= length) { running = false; play.textContent = 'Replay'; return; }
      requestAnimationFrame(frame);
    }
    play.addEventListener('click', function () {
      if (running) { running = false; play.textContent = 'Play'; return; }
      if (t >= length) t = 0;
      running = true; play.textContent = 'Pause'; last = performance.now(); requestAnimationFrame(frame);
    });
    scrub.addEventListener('input', function () { t = +scrub.value; render(); });
    speedBtn.addEventListener('click', function () { speed = speed === 1 ? 4 : 1; speedBtn.textContent = speed + '×'; });
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) t = length;
    render();
  };
  (function () {
    function options() {
      document.querySelectorAll('section.q').forEach(function (card) {
        var tabs = card.querySelectorAll('.opt[data-opt]');
        var views = card.querySelectorAll('.view[data-opt]');
        if (!tabs.length || !views.length) return;
        card.querySelector('.opts').setAttribute('role', 'tablist');
        var shown = card.querySelector('[data-shown]');
        function show(key) {
          tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.opt === key)); });
          views.forEach(function (v) { v.hidden = v.dataset.opt !== key; });
          if (shown) shown.textContent = key;
        }
        tabs.forEach(function (t) {
          t.setAttribute('role', 'tab');
          t.tabIndex = 0;
          t.addEventListener('click', function () { show(t.dataset.opt); });
          t.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(t.dataset.opt); }
          });
        });
        show((card.querySelector('.opt.pick[data-opt]') || tabs[0]).dataset.opt);
      });
      document.documentElement.dataset.ready = '1';
    }
    // Mermaid lays out wrongly inside hidden elements, so every view stays visible until diagrams are drawn.
    var blocks = document.querySelectorAll('pre.mermaid');
    if (!blocks.length) return options();
    // ELK lays out self-loops and crowded labels cleanly; Mermaid's default layout overlaps them.
    Promise.all([
      import('https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs'),
      import('https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.3/dist/mermaid-layout-elk.esm.min.mjs'),
    ]).then(function (m) {
      var mermaid = m[0].default;
      mermaid.registerLayoutLoaders(m[1].default);
      mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', layout: 'elk' });
      // One at a time, each into a string before any is on the page: with ELK, two charts that share state
      // names lay each other out if the first is already in the document.
      var src = Array.prototype.map.call(blocks, function (b) { return b.textContent; });
      var svgs = [];
      return src.reduce(function (p, text, i) {
        return p.then(function () {
          return mermaid.render('grill-mmd-' + i, text).then(function (r) { svgs[i] = r.svg; }, function () { svgs[i] = null; });
        });
      }, Promise.resolve()).then(function () {
        blocks.forEach(function (b, i) {
          if (!svgs[i]) return;
          // Parsed as HTML, as innerHTML would, without running scripts; Mermaid's strict mode has sanitized it.
          b.replaceChildren.apply(b, Array.from(new DOMParser().parseFromString(svgs[i], 'text/html').body.childNodes));
          b.dataset.processed = 'true';
          // At its own size, so every chart's text is the same size; a wide one scrolls in its box.
          var svg = b.querySelector('svg'), vb = svg && svg.viewBox && svg.viewBox.baseVal;
          if (vb && vb.width) { svg.removeAttribute('width'); svg.style.maxWidth = 'none'; svg.style.width = vb.width + 'px'; }
        });
      });
    }).then(options, options);
  })();
  // Answers: pick a choice on each question card and add a note in its box; the floating button copies every
  // answer as one block for the chat. Kept in localStorage per page and question, so a reload keeps them.
  (function () {
    var cards = Array.prototype.filter.call(document.querySelectorAll('section.q'), function (c) { return c.querySelector('.qline'); });
    if (!cards.length) return;
    var store; try { store = window.localStorage; } catch (e) { store = null; }
    function key(id) { return 'grill:' + location.pathname + ':' + id; }
    function load(id) { try { return JSON.parse(store.getItem(key(id))) || {}; } catch (e) { return {}; } }
    function save(id, a) { try { store.setItem(key(id), JSON.stringify(a)); } catch (e) { /* no storage: answers live until reload */ } }
    function text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
    function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; }
    function icon(paths) {
      var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
      [['viewBox', '0 0 24 24'], ['width', '22'], ['height', '22'], ['aria-hidden', 'true'], ['fill', 'none'], ['stroke', 'currentColor'],
        ['stroke-width', '2.2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']].forEach(function (kv) { svg.setAttribute(kv[0], kv[1]); });
      paths.forEach(function (p) { var e = document.createElementNS(NS, p[0]); Object.keys(p[1]).forEach(function (k) { e.setAttribute(k, p[1][k]); }); svg.appendChild(e); });
      return svg;
    }

    var answers = cards.map(function (card) {
      var num = text(card.querySelector('.qnum')), id = card.id || num;
      var a = { num: num, title: text(card.querySelector('.qtitle')), state: load(id), choices: [] };
      var box = el('div', 'answer');
      var opts = card.querySelectorAll('.opts .opt');
      if (opts.length) {
        opts.forEach(function (o) {
          var name = text(o.querySelector('.name'));
          a.choices.push({ el: o, value: text(o.querySelector('.letter')) + (name ? ', ' + name : '') });
          if (!o.dataset.opt) { o.tabIndex = 0; o.setAttribute('role', 'button'); }
          o.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(o); } });
        });
      } else {
        // A yes/no question has no option list: it gets two buttons in its answer box.
        var yn = el('div', 'yn'); yn.setAttribute('role', 'group'); yn.setAttribute('aria-label', 'Your answer to ' + num);
        ['Yes', 'No'].forEach(function (v) { var b = el('button', 'opt'); b.type = 'button'; b.textContent = v; yn.appendChild(b); a.choices.push({ el: b, value: v }); });
        box.appendChild(yn);
      }
      a.choices.forEach(function (c) { c.el.classList.add('choice'); c.el.addEventListener('click', function () { choose(c.el); }); });
      function choose(target) {
        var c = a.choices.find(function (x) { return x.el === target; });
        a.state.choice = a.state.choice === c.value ? null : c.value;  // clicking the chosen one again clears it
        paint(); save(id, a.state);
      }
      function paint() {
        a.choices.forEach(function (c) {
          var on = c.value === a.state.choice;
          c.el.classList.toggle('chosen', on);
          if (c.el.tagName === 'BUTTON' || c.el.getAttribute('role') === 'button') c.el.setAttribute('aria-pressed', String(on));
          var sr = c.el.querySelector('.sr');
          if (on && !sr) c.el.appendChild(el('span', 'sr', ' (your answer)')); else if (!on && sr) sr.remove();
        });
        card.classList.toggle('answered', !!(a.state.choice || (a.state.note || '').trim()));
      }
      var label = el('label', 'notelabel'); label.textContent = 'Anything to add';
      var note = el('textarea', 'note-in');
      note.rows = 2; note.id = 'note-' + id; label.htmlFor = note.id;
      note.placeholder = a.choices.length ? 'A reason, a condition, or a different answer…' : 'Your answer…';
      note.value = a.state.note || '';
      function grow() { note.style.height = 'auto'; note.style.height = note.scrollHeight + 2 + 'px'; }
      note.addEventListener('input', function () { a.state.note = note.value; grow(); paint(); save(id, a.state); });
      box.appendChild(label); box.appendChild(note);
      card.appendChild(box);
      paint(); requestAnimationFrame(grow);
      return a;
    });

    function block() {
      var done = [], missing = [];
      answers.forEach(function (a) {
        var note = (a.state.note || '').trim();
        if (!a.state.choice && !note) return missing.push(a.num);
        done.push(a.num + ' - ' + a.title + ':' + (a.state.choice ? ' ' + a.state.choice : '') + (note ? '\n' + note : ''));
      });
      return { text: done.join('\n\n'), done: done.length, missing: missing };
    }
    function fallback(s) {
      var t = el('textarea'); t.value = s; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      t.remove(); return ok;
    }
    function copy(s) {
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return fallback(s); });
      return Promise.resolve(fallback(s));
    }
    var dock = el('div', 'copydock');
    var status = el('span', 'copied'); status.setAttribute('role', 'status');
    var COPY = icon([['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }], ['path', { d: 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1' }]]);
    var CHECK = icon([['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]]);
    var btn = el('button', 'copyall'); btn.type = 'button'; btn.appendChild(COPY);
    btn.setAttribute('aria-label', 'Copy answers'); btn.title = 'Copy answers';
    var timer;
    function say(msg, ok) {
      status.textContent = msg; dock.classList.add('show'); btn.replaceChildren(ok ? CHECK : COPY);
      clearTimeout(timer); timer = setTimeout(function () { dock.classList.remove('show'); btn.replaceChildren(COPY); }, 2600);
    }
    btn.addEventListener('click', function () {
      var b = block();
      if (!b.done) return say('No answers yet', false);
      copy(b.text).then(function (ok) {
        if (!ok) return say('Could not copy', false);
        say('Copied ' + b.done + ' of ' + answers.length + (b.missing.length ? ' · ' + b.missing.join(', ') + ' open' : ''), true);
      });
    });
    dock.appendChild(status); dock.appendChild(btn);
    document.body.appendChild(dock);
  })();
