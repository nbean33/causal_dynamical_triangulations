// Shared page behaviour: theme toggle, current-page marking in the nav, and KaTeX rendering.
// Loaded with `defer` on every page, after KaTeX on pages that use math.

(function () {
  var root = document.documentElement;
  var KEY = 'cdt-theme';

  // The research code (CDT_4d-master) has no public remote yet. Once it does, set this and every
  // [data-code-link] placeholder becomes a link to it.
  var CODE_REPO_URL = '';
  if (CODE_REPO_URL) {
    document.querySelectorAll('[data-code-link]').forEach(function (el) {
      var a = document.createElement('a');
      a.href = CODE_REPO_URL;
      a.textContent = 'The source code is on GitHub.';
      el.replaceChildren(a);
    });
  }

  function effectiveTheme() {
    if (root.dataset.theme) return root.dataset.theme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function labelToggle(btn) {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    btn.textContent = next === 'dark' ? '☾' : '☀';
    btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    btn.title = 'Switch to ' + next + ' theme';
  }

  var toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    labelToggle(toggle);
    toggle.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch (e) { /* storage unavailable */ }
      labelToggle(toggle);
      document.dispatchEvent(new CustomEvent('themechange', { detail: next }));
    });
  }

  // Mark the current page in the header and sub-nav. A header link to a section is marked on
  // that section's pages unless another header link is an exact match (e.g. Simulator).
  var here = location.pathname.replace(/index\.html$/, '');
  function pathOf(a) {
    return new URL(a.getAttribute('href'), location.href).pathname.replace(/index\.html$/, '');
  }
  var headerLinks = Array.prototype.slice.call(document.querySelectorAll('.site-nav a'));
  var exact = headerLinks.filter(function (a) { return pathOf(a) === here; });
  var marked = exact.length ? exact : headerLinks.filter(function (a) {
    return a.dataset.section && here.indexOf(a.dataset.section) !== -1;
  });
  document.querySelectorAll('.sub-nav a').forEach(function (a) {
    if (pathOf(a) === here) marked.push(a);
  });
  marked.forEach(function (a) { a.setAttribute('aria-current', 'page'); });

  if (window.renderMathInElement) {
    window.renderMathInElement(document.body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false }
      ],
      throwOnError: false
    });
  }
})();
