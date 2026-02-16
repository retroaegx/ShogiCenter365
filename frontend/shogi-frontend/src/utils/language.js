// Supported UI languages
// - Stored in localStorage so it can be used before login.
// - Sent to server on login / register / guest login.
// - Language icons are served from /public/country (e.g. /country/jp.svg).

const LS_KEY = 'shogi_language';

// Map UI language -> flag asset (public/country/*.svg)
export const SUPPORTED_LANGUAGES = [
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

const SUPPORTED = new Set(SUPPORTED_LANGUAGES.map((x) => x.code));

export function normalizeLanguage(input) {
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
    if (SUPPORTED.has(base)) return base;

    // Some common variants
    if (lowered.startsWith('pt')) return 'pt';
    if (lowered.startsWith('zh')) return 'zh';

    return 'en';
  } catch {
    return 'en';
  }
}

export function detectSystemLanguage() {
  try {
    if (typeof navigator !== 'undefined') {
      return normalizeLanguage(navigator.language || navigator.userLanguage || '');
    }
  } catch {
    // ignore
  }
  return 'en';
}

export function getPreferredLanguage() {
  // Best-effort read. Does NOT write.
  try {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(LS_KEY);
      if (stored) return normalizeLanguage(stored);
    }
  } catch {
    // ignore
  }
  return detectSystemLanguage();
}

export function ensurePreferredLanguage() {
  // If never set, store system language (or fallback to English).
  const current = getPreferredLanguage();
  try {
    if (typeof window !== 'undefined') {
      const existing = window.localStorage.getItem(LS_KEY);
      if (!existing) window.localStorage.setItem(LS_KEY, current);
    }
  } catch {
    // ignore
  }
  return current;
}

export function setPreferredLanguage(next) {
  const normalized = normalizeLanguage(next);
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LS_KEY, normalized);
    }
  } catch {
    // ignore
  }
  return normalized;
}

export function getLanguageMeta(code) {
  const c = normalizeLanguage(code);
  return (
    SUPPORTED_LANGUAGES.find((x) => x.code === c) ||
    SUPPORTED_LANGUAGES.find((x) => x.code === 'en')
  );
}

export function getFlagAssetPath(code) {
  const meta = getLanguageMeta(code);
  const flag = (meta && meta.flag) ? String(meta.flag).toLowerCase() : 'us';
  return `/country/${flag}.svg`;
}
