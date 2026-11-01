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
    var root = document.documentElement.getAttribute('data-theme');
    var dark = root ? root === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    // ELK lays out self-loops and crowded labels cleanly; Mermaid's default layout overlaps them.
    Promise.all([
      import('https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs'),
      import('https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.3/dist/mermaid-layout-elk.esm.min.mjs'),
    ]).then(function (m) {
      var mermaid = m[0].default;
      mermaid.registerLayoutLoaders(m[1].default);
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict', layout: 'elk' });
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
          b.innerHTML = svgs[i]; b.dataset.processed = 'true';
          // At its own size, so every chart's text is the same size; a wide one scrolls in its box.
          var svg = b.querySelector('svg'), vb = svg && svg.viewBox && svg.viewBox.baseVal;
          if (vb && vb.width) { svg.removeAttribute('width'); svg.style.maxWidth = 'none'; svg.style.width = vb.width + 'px'; }
        });
      });
    }).then(options, options);
  })();
