// public/i18n/dom_i18n.js
// Static (non-React) i18n translator (dictionary-keyed only).
//
// - Reads language from localStorage (key: shogi_language)
// - Loads /i18n/<lang>.json (falls back to /i18n/ja.json)
// - Applies translations ONLY for elements that declare i18n keys:
//     - data-i18n        => textContent
//     - data-i18n-html   => innerHTML
//     - data-i18n-title  => document.title (on <html> element)
//     - data-i18n-aria-label / -placeholder / -alt / -title => respective attributes
//
// - Supports language switching at runtime:
//     - shogi_language_changed CustomEvent
//     - storage event (other tabs)
//     - MutationObserver (new keyed DOM)

(function () {
  const LS_KEY = 'shogi_language';
  const FALLBACK = 'ja';

  // Keep in sync with src/utils/language.js supported set.
  const SUPPORTED = new Set(['ja', 'en', 'zh', 'fr', 'de', 'pl', 'it', 'pt']);

  const KEYED_TEXT_ATTR = 'data-i18n';
  const KEYED_HTML_ATTR = 'data-i18n-html';
  const KEYED_TITLE_KEY_ATTR = 'data-i18n-title'; // on <html> element

  const KEYED_ATTRS = [
    ['data-i18n-title', 'title'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-alt', 'alt'],
  ];

  let currentLang = null;
  let currentDict = {};
  let observer = null;
  let applySeq = 0;

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
      const base = lowered.replace('_', '-').split('-')[0];
      if (SUPPORTED.has(base)) return base;

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

  function getLanguage() {
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored) return normalizeLanguage(stored);
    } catch {
      // ignore
    }
    return detectSystemLanguage();
  }

  function ensurePreferredLanguage() {
    const current = getLanguage();
    try {
      const existing = localStorage.getItem(LS_KEY);
      if (!existing) localStorage.setItem(LS_KEY, current);
    } catch {
      // ignore
    }
    return current;
  }

  async function loadMessages(lang) {
    const code = normalizeLanguage(lang);

    async function loadOne(url) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        const json = await res.json();
        return (json && typeof json === 'object') ? json : null;
      } catch {
        return null;
      }
    }

    // Always load the fallback language first, then overlay the current language.
    // This prevents missing keys from becoming blank.
    const base = (await loadOne(`/i18n/${FALLBACK}.json`)) || {};
    if (code === FALLBACK) return base;

    const cur = (await loadOne(`/i18n/${code}.json`)) || {};
    const merged = { ...base };
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      // Treat empty string as "missing" so fallback remains.
      if (v === '' || v === null || v === undefined) continue;
      merged[k] = v;
    }
    return merged;
  }

  function getDictValue(dict, key) {
    if (!dict || !key) return null;
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    return null;
  }

  function applyKeyed(dict, root) {
    try {
      const base = root && root.querySelectorAll ? root : document;
      const selector =
        `[${KEYED_TEXT_ATTR}],[${KEYED_HTML_ATTR}],` +
        KEYED_ATTRS.map(([a]) => `[${a}]`).join(',');

      const all = base.querySelectorAll ? base.querySelectorAll(selector) : [];
      for (const el of all) {
        // data-i18n (textContent)
        const kText = el.getAttribute && el.getAttribute(KEYED_TEXT_ATTR);
        if (kText) {
          const v = getDictValue(dict, kText);
          el.textContent = (v === null || v === undefined) ? '' : String(v);
        }

        // data-i18n-html (innerHTML)
        const kHtml = el.getAttribute && el.getAttribute(KEYED_HTML_ATTR);
        if (kHtml) {
          const v = getDictValue(dict, kHtml);
          el.innerHTML = (v === null || v === undefined) ? '' : String(v);
        }

        // keyed attributes
        for (const [attrKey, targetAttr] of KEYED_ATTRS) {
          const k = el.getAttribute && el.getAttribute(attrKey);
          if (!k) continue;
          const v = getDictValue(dict, k);
          try {
            el.setAttribute(targetAttr, (v === null || v === undefined) ? '' : String(v));
          } catch {
            // ignore
          }
        }
      }

      // document.title (from <html data-i18n-title="...">)
      const htmlEl = document.documentElement;
      const titleKey = htmlEl && htmlEl.getAttribute ? htmlEl.getAttribute(KEYED_TITLE_KEY_ATTR) : null;
      if (titleKey) {
        const v = getDictValue(dict, titleKey);
        document.title = (v === null || v === undefined) ? '' : String(v);
      }
    } catch {
      // ignore
    }
  }

  function dispatchReady(lang) {
    try {
      window.__shogiMessages = currentDict;
      window.__shogiI18nLang = lang;
      window.__shogiI18nReady = true;
      window.dispatchEvent(new CustomEvent('shogi_i18n_ready', { detail: { lang } }));
    } catch {
      // ignore
    }
  }

  async function applyLanguage(lang, root) {
    const seq = ++applySeq;
    const code = normalizeLanguage(lang);
    const dict = await loadMessages(code);
    if (seq !== applySeq) return;

    currentLang = code;
    currentDict = dict || {};

    try {
      if (document && document.documentElement) document.documentElement.lang = currentLang;
    } catch {
      // ignore
    }
    applyKeyed(currentDict, root || document.body);
    dispatchReady(currentLang);
  }

  function ensureObserver() {
    if (observer || !document.body || !window.MutationObserver) return;

    observer = new MutationObserver((mutations) => {
      if (!currentDict) return;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) applyKeyed(currentDict, node);
          }
        }
      }
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
    });
  }

  function requestApply(root) {
    const lang = getLanguage();
    applyLanguage(lang, root);
  }

  function onLangChanged() {
    requestApply(document.body);
  }

  function run() {
    try { ensurePreferredLanguage(); } catch { /* ignore */ }
    requestApply(document.body);
    ensureObserver();

    window.addEventListener('shogi_language_changed', onLangChanged);
    window.addEventListener('storage', (e) => {
      if (!e || e.key !== LS_KEY) return;
      onLangChanged();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();