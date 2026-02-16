/*
  Unified header/footer for Top (React) + static HTML pages.
  - Injects the same markup into #staticHeader / #staticFooter placeholders
  - Adds a small mobile menu toggle (no framework)

  i18n:
    This file does NOT hardcode display text.
    Visible strings are emitted as empty elements with data-i18n* keys
    and are filled by public/i18n/dom_i18n.js.
*/

(function () {
  // ===== language picker (shared across Top + static pages) =====
  const LS_LANG_KEY = 'shogi_language';
  const SUPPORTED_LANGUAGES = [
    { code: 'ja', flag: 'jp' },
    // English icon: use US flag as a generic English icon
    { code: 'en', flag: 'us' },
    { code: 'zh', flag: 'cn' },
    { code: 'fr', flag: 'fr' },
    { code: 'de', flag: 'de' },
    { code: 'pl', flag: 'pl' },
    { code: 'it', flag: 'it' },
    { code: 'pt', flag: 'pt' },
  ];
  const SUPPORTED_SET = (function () {
    try {
      return new Set(SUPPORTED_LANGUAGES.map((x) => x.code));
    } catch {
      return null;
    }
  })();

  function normalizeLanguage(input) {
    try {
      const raw = String(input || '').trim();
      if (!raw) return 'en';
      const lowered = raw.toLowerCase();

      // Accept full labels from some clients
      if (lowered === 'japanese') return 'ja';
      if (lowered === 'english') return 'en';
      if (lowered === 'chinese') return 'zh';
      if (lowered === 'french') return 'fr';
      if (lowered === 'german') return 'de';
      if (lowered === 'polish') return 'pl';
      if (lowered === 'italiano' || lowered === 'italian') return 'it';
      if (lowered === 'portuguese') return 'pt';

      // Locale like "ja-JP" -> "ja"
      const base = lowered.split(/[-_]/)[0];
      if (SUPPORTED_SET && SUPPORTED_SET.has(base)) return base;

      // Some common variants
      if (lowered.startsWith('pt')) return 'pt';
      if (lowered.startsWith('zh')) return 'zh';

      return 'en';
    } catch {
      return 'en';
    }
  }

  function detectSystemLanguage() {
    try {
      return normalizeLanguage((navigator && (navigator.language || navigator.userLanguage)) || '');
    } catch {
      return 'en';
    }
  }

  function getPreferredLanguage() {
    try {
      const stored = window.localStorage.getItem(LS_LANG_KEY);
      if (stored) return normalizeLanguage(stored);
    } catch {
      // ignore
    }
    return detectSystemLanguage();
  }

  function ensurePreferredLanguage() {
    const current = getPreferredLanguage();
    try {
      const existing = window.localStorage.getItem(LS_LANG_KEY);
      if (!existing) window.localStorage.setItem(LS_LANG_KEY, current);
    } catch {
      // ignore
    }
    return current;
  }

  function setPreferredLanguage(next) {
    const normalized = normalizeLanguage(next);
    try {
      window.localStorage.setItem(LS_LANG_KEY, normalized);
    } catch {
      // ignore
    }
    return normalized;
  }

  function getLanguageMeta(code) {
    const c = normalizeLanguage(code);
    for (let i = 0; i < SUPPORTED_LANGUAGES.length; i++) {
      if (SUPPORTED_LANGUAGES[i].code === c) return SUPPORTED_LANGUAGES[i];
    }
    for (let i = 0; i < SUPPORTED_LANGUAGES.length; i++) {
      if (SUPPORTED_LANGUAGES[i].code === 'en') return SUPPORTED_LANGUAGES[i];
    }
    return { code: 'en', flag: 'us' };
  }

  function getFlagAssetPath(code) {
    const meta = getLanguageMeta(code);
    const flag = meta && meta.flag ? String(meta.flag).toLowerCase() : 'us';
    return `/country/${flag}.svg`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function svgGlobe() {
    // lucide "globe" (inline svg)
    return (
      '<svg class="lang-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />' +
      '<path d="M2 12h20" stroke="currentColor" stroke-width="2" />' +
      '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" stroke="currentColor" stroke-width="2" />' +
      '</svg>'
    );
  }

  function svgX() {
    // lucide "x" (inline svg)
    return (
      '<svg class="lang-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />' +
      '<path d="M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />' +
      '</svg>'
    );
  }

  function renderLanguagePicker() {
    const items = SUPPORTED_LANGUAGES.map((x) => {
      const code = escapeHtml(x.code);
      const src = escapeHtml(getFlagAssetPath(x.code));
      return (
        '<button class="lang-item" type="button" data-lang-code="' + code + '">' +
          '<span class="lang-left">' +
            '<span class="lang-flag" aria-hidden="true"><img draggable="false" alt="" aria-hidden="true" src="' + src + '" /></span>' +
            '<span class="lang-names">' +
              '<span class="lang-native" data-i18n="ui.language.native.' + code + '"></span>' +
              '<span class="lang-label" data-i18n="ui.language.label.' + code + '"></span>' +
            '</span>' +
          '</span>' +
          '<span class="lang-selected" data-i18n="ui.components.top.languagepicker.kb4dffb70"></span>' +
        '</button>'
      );
    }).join('');

    return (
      '<div class="lang-picker" data-lang-picker>' +
        '<button type="button" class="lang-btn lang-btn-icon" data-lang-toggle aria-label="" data-i18n-aria-label="ui.components.top.languagepicker.kc5b3a0ce">' +
          svgGlobe() +
        '</button>' +
        '<button type="button" class="lang-btn" data-lang-toggle aria-label="" data-i18n-aria-label="ui.components.top.languagepicker.k0c5a5d1b">' +
          '<span class="lang-flag" aria-hidden="true"><img draggable="false" alt="" aria-hidden="true" data-lang-current-flag src="/country/us.svg" /></span>' +
        '</button>' +
        '<div class="lang-panel" data-lang-panel hidden role="dialog" aria-label="" data-i18n-aria-label="ui.components.top.languagepicker.k95f05a46">' +
          '<div class="lang-panel-head">' +
            '<div class="lang-panel-title" data-i18n="ui.components.top.languagepicker.keb9f0071"></div>' +
            '<button type="button" class="lang-close" data-lang-close aria-label="" data-i18n-aria-label="ui.components.top.languagepicker.k7a0d0b6b">' +
              svgX() +
            '</button>' +
          '</div>' +
          '<div class="lang-list">' + items + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function dispatchLanguageChanged(lang, source) {
    try {
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(
          new CustomEvent('shogi_language_changed', {
            detail: { lang: normalizeLanguage(lang), source: source || 'shell' },
          })
        );
      }
    } catch {
      // ignore
    }
  }

  function applyLanguagePickerState(pickerRoot, lang) {
    if (!pickerRoot) return;
    const code = normalizeLanguage(lang);
    const cur = pickerRoot.querySelector('[data-lang-current-flag]');
    if (cur) {
      try {
        cur.src = getFlagAssetPath(code);
      } catch {
        // ignore
      }
      try {
        cur.onerror = function () {
          try {
            if (cur && cur.src && cur.src.indexOf('/country/us.svg') === -1) cur.src = '/country/us.svg';
          } catch {
            // ignore
          }
        };
      } catch {
        // ignore
      }
    }

    const items = pickerRoot.querySelectorAll('.lang-item[data-lang-code]');
    for (const btn of items) {
      const c = btn.getAttribute('data-lang-code') || '';
      const active = normalizeLanguage(c) === code;
      btn.classList.toggle('active', !!active);
      btn.setAttribute('aria-current', active ? 'true' : 'false');
    }
  }

  function wireLanguagePicker(root) {
    const picker = root && root.querySelector ? root.querySelector('[data-lang-picker]') : null;
    if (!picker) return;
    if (picker.dataset.bound === '1') return;
    picker.dataset.bound = '1';

    const panel = picker.querySelector('[data-lang-panel]');
    const toggles = picker.querySelectorAll('[data-lang-toggle]');
    const closeBtn = picker.querySelector('[data-lang-close]');

    const close = () => {
      if (!panel) return;
      panel.hidden = true;
      picker.classList.remove('open');
    };

    const open = () => {
      if (!panel) return;
      panel.hidden = false;
      picker.classList.add('open');
    };

    const toggle = () => {
      if (!panel) return;
      if (panel.hidden) open();
      else close();
    };

    // initialize
    const initial = ensurePreferredLanguage();
    applyLanguagePickerState(picker, initial);

    for (const t of toggles) {
      t.addEventListener('click', (e) => {
        e.preventDefault();
        toggle();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        close();
      });
    }

    picker.addEventListener('click', (e) => {
      const t = e && e.target ? e.target.closest('.lang-item[data-lang-code]') : null;
      if (!t) return;
      const code = t.getAttribute('data-lang-code') || '';
      const next = setPreferredLanguage(code);
      applyLanguagePickerState(picker, next);
      close();
      dispatchLanguageChanged(next, 'shell');
    });

    // Close on outside click
    document.addEventListener('mousedown', (e) => {
      if (!picker.classList.contains('open')) return;
      if (picker.contains(e.target)) return;
      close();
    });
    document.addEventListener('touchstart', (e) => {
      if (!picker.classList.contains('open')) return;
      if (picker.contains(e.target)) return;
      close();
    }, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (!picker.classList.contains('open')) return;
      if (!e) return;
      if (e.key === 'Escape') close();
    });

    // Keep in sync across tabs / other emitters
    window.addEventListener('storage', (e) => {
      if (!e || e.key !== LS_LANG_KEY) return;
      applyLanguagePickerState(picker, getPreferredLanguage());
    });
    window.addEventListener('shogi_language_changed', (e) => {
      try {
        const next = normalizeLanguage((e && e.detail && e.detail.lang) || getPreferredLanguage());
        applyLanguagePickerState(picker, next);
      } catch {
        // ignore
      }
    });
  }

  function normPath(p) {
    if (!p) return '/';
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

    if (toggle.dataset.bound === '1') return;
    toggle.dataset.bound = '1';

    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      toggleOpen();
    });

    document.addEventListener('click', (e) => {
      if (!list.classList.contains('open')) return;
      const t = e.target;
      if (t && (list.contains(t) || toggle.contains(t))) return;
      close();
    });

    list.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.tagName === 'A') close();
    });
  }

  async function pageExists(url, pageId) {
    const target = url || '';
    if (!target) return false;

    // Use GET and verify a page marker to avoid false positives from SPA fallbacks.
    try {
      const res = await fetch(target, { method: 'GET', cache: 'no-store' });
      if (!res || !res.ok) return false;
      if (!pageId) return true;

      const bodyText = await res.text();
      return (
        bodyText.includes(`data-shogi-page="${pageId}"`) ||
        bodyText.includes(`data-shogi-page='${pageId}'`)
      );
    } catch {
      return false;
    }
  }

  function wireOptionalNav(root) {
    if (!root) return;
    const items = root.querySelectorAll('li[data-optional-nav]');
    if (!items || !items.length) return;

    items.forEach((li) => {
      const url = li.getAttribute('data-optional-nav') || '';
      // Hide by default (prevents flash).
      li.hidden = true;

      const pageId = li.getAttribute('data-optional-pageid') || '';

      pageExists(url, pageId).then((ok) => {
        if (ok) {
          li.hidden = false;
          try {
            setActiveLink(root);
          } catch {
            // ignore
          }
        } else {
          try {
            li.remove();
          } catch {
            // ignore
          }
        }
      });
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
                '<span class="logo-title" data-i18n="static.brand"></span>' +
                '<span class="logo-subtitle">SHOGI CENTER 365</span>' +
              '</span>' +
            '</a>' +
            '<div class="header-actions">' +
              renderLanguagePicker() +
              '<nav class="nav" aria-label="" data-i18n-aria-label="static.nav.aria">' +
                '<button aria-label="" data-i18n-aria-label="static.nav.toggle.aria" class="nav-toggle" type="button">☰</button>' +
                '<ul class="nav-list">' +
                  '<li><a data-nav href="/" data-i18n="static.nav.home"></a></li>' +
                  '<li><a data-nav href="/rules.html" data-i18n="static.nav.rules"></a></li>' +
                  '<li><a data-nav href="/requirements.html" data-i18n="static.nav.requirements"></a></li>' +
                  '<li><a data-nav href="/distribute.html" data-i18n="static.nav.distribute"></a></li>' +
                  '<li data-optional-nav="/legal.html" data-optional-pageid="legal" hidden><a data-nav href="/legal.html" data-i18n="static.nav.legal"></a></li>' +
                  '<li><a data-nav href="/contact.html" data-i18n="static.nav.contact"></a></li>' +
                '</ul>' +
              '</nav>' +
            '</div>' +
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
          '<small>© ' + year + ' <span data-i18n="static.brand"></span></small>' +
        '</div>' +
      '</footer>'
    );
  }

  function init() {
    const headerSlot = document.getElementById('staticHeader');
    const footerSlot = document.getElementById('staticFooter');
    if (!headerSlot && !footerSlot) return;

    if (headerSlot && headerSlot.dataset.filled !== '1') {
      headerSlot.innerHTML = renderHeader();
      headerSlot.dataset.filled = '1';
      const header = headerSlot.querySelector('.site-header');
      if (header) {
        setActiveLink(header);
        wireMenu(header);
        wireOptionalNav(header);
        wireLanguagePicker(header);
      }
    } else if (headerSlot) {
      const header = headerSlot.querySelector('.site-header');
      if (header) {
        setActiveLink(header);
        wireMenu(header);
        wireOptionalNav(header);
        wireLanguagePicker(header);
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