/*
  Unified header/footer for Top (React) + static HTML pages.
  - Injects the same markup into #staticHeader / #staticFooter placeholders
  - Adds a small mobile menu toggle (no framework)

  Usage:
    - Put <div id="staticHeader"></div> and <div id="staticFooter"></div> in the page
    - Load this script (defer) and call window.initShogiStaticShell() (optional)
*/

(function () {
  const BRAND = '将棋センター365';

  function normPath(p) {
    if (!p) return '/';
    // Remove trailing slash except root
    return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  }

  function setActiveLink(root) {
    const path = normPath(window.location.pathname);
    const links = root.querySelectorAll('a[data-nav]');
    links.forEach((a) => {
      const href = a.getAttribute('href') || '';
      const target = normPath(href.startsWith('http') ? new URL(href).pathname : href);
      const isActive = (target === '/' && path === '/') || (target !== '/' && path === target);
      a.classList.toggle('active', !!isActive);
      a.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
  }

  function wireMenu(root) {
    const toggle = root.querySelector('.nav-toggle');
    const list = root.querySelector('.nav-list');
    if (!toggle || !list) return;

    const close = () => list.classList.remove('open');
    const toggleOpen = () => list.classList.toggle('open');

    // Avoid double-binding
    if (toggle.dataset.bound === '1') return;
    toggle.dataset.bound = '1';

    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      toggleOpen();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!list.classList.contains('open')) return;
      const t = e.target;
      if (t && (list.contains(t) || toggle.contains(t))) return;
      close();
    });

    // Close when clicking a link
    list.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.tagName === 'A') close();
    });
  }

function renderHeader() {
  return (
    '<header class="site-header">' +
      '<div class="container">' +
        '<div class="header-inner">' +
          '<a class="brand-link" href="/">' +
            '<span class="logo-icon" aria-hidden="true"></span>' +
            '<span class="logo-text">' +
              '<span class="logo-title">' + BRAND + '</span>' +
              '<span class="logo-subtitle">SHOGI CENTER 365</span>' +
            '</span>' +
          '</a>' +
          '<nav class="nav" aria-label="メインメニュー">' +
            '<button aria-label="メニュー" class="nav-toggle" type="button">☰</button>' +
            '<ul class="nav-list">' +
              '<li><a data-nav href="/">ホーム</a></li>' +
              '<li><a data-nav href="/rules.html">ルール</a></li>' +
              '<li><a data-nav href="/ranking.html">ランキング</a></li>' +
              '<li><a data-nav href="/contact.html">問い合わせ</a></li>' +
            '</ul>' +
          '</nav>' +
        '</div>' +
      '</div>' +
    '</header>'
  );
}

  function renderFooter() {
    const year = new Date().getFullYear();
    return (
      '<footer class="site-footer">' +
        '<div class="container">' +
          '<small>© ' + year + ' ' + BRAND + '</small>' +
        '</div>' +
      '</footer>'
    );
  }

  function init() {
    const headerSlot = document.getElementById('staticHeader');
    const footerSlot = document.getElementById('staticFooter');
    if (!headerSlot && !footerSlot) return;

    // Inject markup
    if (headerSlot && headerSlot.dataset.filled !== '1') {
      headerSlot.innerHTML = renderHeader();
      headerSlot.dataset.filled = '1';
      const header = headerSlot.querySelector('.site-header');
      if (header) {
        setActiveLink(header);
        wireMenu(header);
      }
    } else if (headerSlot) {
      const header = headerSlot.querySelector('.site-header');
      if (header) {
        setActiveLink(header);
        wireMenu(header);
      }
    }

    if (footerSlot && footerSlot.dataset.filled !== '1') {
      footerSlot.innerHTML = renderFooter();
      footerSlot.dataset.filled = '1';
    }
  }

  window.initShogiStaticShell = init;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
