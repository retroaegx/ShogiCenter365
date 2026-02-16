// src/i18n/index.js
// Lightweight i18n helper.
//
// - Language is stored in localStorage (key: shogi_language)
// - Locale files live under src/i18n/locales/*.json
// - Falls back to Japanese (then English) when a key is missing in the selected language.

import {
  ensurePreferredLanguage,
  normalizeLanguage,
  getPreferredLanguage,
} from '@/utils/language';

import ja from '@/i18n/locales/ja.json';
import en from '@/i18n/locales/en.json';
import zh from '@/i18n/locales/zh.json';
import fr from '@/i18n/locales/fr.json';
import de from '@/i18n/locales/de.json';
import pl from '@/i18n/locales/pl.json';
import it from '@/i18n/locales/it.json';
import pt from '@/i18n/locales/pt.json';

const LOCALES = {
  ja,
  en,
  zh,
  fr,
  de,
  pl,
  it,
  pt,
};

const listeners = new Set();

function emitToSubscribers() {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

export function subscribeI18n(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    try {
      listeners.delete(listener);
    } catch {
      // ignore
    }
  };
}

export function notifyLanguageChange() {
  // Consumers (React root, etc.) can re-render when language is changed.
  emitToSubscribers();

  // Notify non-React pages (static HTML) too.
  try {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(
        new CustomEvent('shogi_language_changed', {
          detail: { lang: getLanguage(), source: 'react' },
        })
      );
    }
  } catch {
    // ignore
  }
}

// If the language is changed by non-React UI (e.g., the shared static header
// language picker), re-render React consumers too.
try {
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('shogi_language_changed', (e) => {
      try {
        if (e && e.detail && e.detail.source === 'react') return;
      } catch {
        // ignore
      }
      emitToSubscribers();
    });
  }
} catch {
  // ignore
}

// Make sure localStorage has a language value early.
ensurePreferredLanguage();

export function getLanguage() {
  return normalizeLanguage(getPreferredLanguage());
}

export function getMessages(lang) {
  const code = normalizeLanguage(lang || getLanguage());
  return LOCALES[code] || {};
}

function normalizeKey(k) {
  if (k === null || k === undefined) return '';
  return String(k).replace(/\s+/g, ' ').trim();
}

function interpolate(template, vars) {
  if (!vars) return template;
  return String(template).replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

// Translate by key.
// i18n keys must be stable ASCII identifiers (e.g. ui.xxx, static.xxx).
// Missing keys fall back to Japanese, then English.
export function t(key, vars) {
  const lang = getLanguage();
  const msg = getMessages(lang);
  const nk = normalizeKey(key);

  let direct = msg && (msg[nk] ?? msg[key]);
  if (direct === '' || direct === undefined || direct === null) {
    // Fall back to Japanese for missing keys.
    direct = ja && (ja[nk] ?? ja[key]);
  }
  if (direct === '' || direct === undefined || direct === null) {
    // Last resort: fall back to English.
    direct = en && (en[nk] ?? en[key]);
  }

  if (direct !== undefined && direct !== null && direct !== '') {
    // If the message is not a string (e.g. arrays for notation tables), return it as-is.
    if (Array.isArray(direct)) return direct.slice();
    if (typeof direct === 'object') return direct;
    return interpolate(direct, vars);
  }

  // Still not found: render as empty.
  return '';
}
