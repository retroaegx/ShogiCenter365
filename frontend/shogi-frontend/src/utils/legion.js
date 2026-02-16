// Country/region ("legion") helpers.
//
// Stored as ISO 3166-1 alpha-2 code (e.g., "JP").
// UI shows flag + native name.

import { t } from '@/i18n';

export const LEGION_DEFS = [
  { code: 'JP' },
  { code: 'US' },
  { code: 'GB' },
  { code: 'FR' },
  { code: 'DE' },
  { code: 'ES' },
  { code: 'IT' },
  { code: 'CN' },
  { code: 'KR' },
  { code: 'TW' },
  { code: 'HK' },
  { code: 'SG' },
  { code: 'TH' },
  { code: 'VN' },
  { code: 'ID' },
  { code: 'PH' },
  { code: 'IN' },
  { code: 'AU' },
  { code: 'CA' },
  { code: 'BR' },
  { code: 'MX' },
  { code: 'RU' },
  { code: 'TR' },
  { code: 'SA' },
  { code: 'AE' },
  { code: 'NL' },
  { code: 'SE' },
  { code: 'NO' },
  { code: 'FI' },
  { code: 'PL' },
  { code: 'UA' },
];

// Backward compatibility export
export const LEGIONS = LEGION_DEFS.map((x) => ({ code: x.code, label: x.code }));

// Preferred API for UI (translated labels)
export function getLegions() {
  // literal t() so gen-i18n picks up keys
  const labelMap = {
    JP: t('ui.utils.legion.jp'),
    US: t('ui.utils.legion.us'),
    GB: t('ui.utils.legion.gb'),
    FR: t('ui.utils.legion.fr'),
    DE: t('ui.utils.legion.de'),
    ES: t('ui.utils.legion.es'),
    IT: t('ui.utils.legion.it'),
    CN: t('ui.utils.legion.cn'),
    KR: t('ui.utils.legion.kr'),
    TW: t('ui.utils.legion.tw'),
    HK: t('ui.utils.legion.hk'),
    SG: t('ui.utils.legion.sg'),
    TH: t('ui.utils.legion.th'),
    VN: t('ui.utils.legion.vn'),
    ID: t('ui.utils.legion.id'),
    PH: t('ui.utils.legion.ph'),
    IN: t('ui.utils.legion.in'),
    AU: t('ui.utils.legion.au'),
    CA: t('ui.utils.legion.ca'),
    BR: t('ui.utils.legion.br'),
    MX: t('ui.utils.legion.mx'),
    RU: t('ui.utils.legion.ru'),
    TR: t('ui.utils.legion.tr'),
    SA: t('ui.utils.legion.sa'),
    AE: t('ui.utils.legion.ae'),
    NL: t('ui.utils.legion.nl'),
    SE: t('ui.utils.legion.se'),
    NO: t('ui.utils.legion.no'),
    FI: t('ui.utils.legion.fi'),
    PL: t('ui.utils.legion.pl'),
    UA: t('ui.utils.legion.ua'),
  };

  return LEGION_DEFS.map((d) => ({ code: d.code, label: labelMap[d.code] ?? '' }));
}

export const LEGION_CODE_SET = new Set(LEGION_DEFS.map((x) => x.code));

function _safeNavigatorLanguage() {
  try {
    if (typeof navigator === 'undefined') return '';
    return String(navigator.language || '').trim();
  } catch {
    return '';
  }
}

function _safeTimezone() {
  try {
    if (typeof Intl === 'undefined') return '';
    return String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
  } catch {
    return '';
  }
}

function _safeResolvedLocale() {
  try {
    if (typeof Intl === 'undefined') return '';
    return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
  } catch {
    return '';
  }
}

function _safeNavigatorLanguages() {
  try {
    if (typeof navigator === 'undefined') return [];
    const ls = navigator.languages;
    if (!Array.isArray(ls)) return [];
    return ls.map((x) => String(x || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function _extractRegionFromTag(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return '';

  // Modern browsers: use Intl.Locale when available.
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function') {
      const loc = new Intl.Locale(raw);
      const r = (loc && loc.region) ? String(loc.region).trim().toUpperCase() : '';
      if (r && LEGION_CODE_SET.has(r)) return r;
    }
  } catch {
    // ignore
  }

  // Fallback: parse BCP47-ish tag.
  // Examples:
  // - "ja-JP" -> ["ja","JP"]
  // - "zh-Hans-CN" -> ["zh","Hans","CN"]
  // - "sr-Latn-RS" -> ["sr","Latn","RS"]
  const parts = raw.split(/[-_]/).map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/^[A-Za-z]{2}$/.test(p)) {
      const r = p.toUpperCase();
      if (LEGION_CODE_SET.has(r)) return r;
      return '';
    }
  }
  return '';
}

/**
 * Best-effort client-side default.
 * - Prefer region from locale tags (navigator.languages / navigator.language / Intl resolved locale).
 * - Fallback to timezone heuristics.
 */
export function detectLegionCode(defaultCode = 'JP') {
  // 1) Locale tags (best-effort, no network / geo-IP).
  const tags = [];
  const navLang = _safeNavigatorLanguage();
  if (navLang) tags.push(navLang);
  const navLangs = _safeNavigatorLanguages();
  for (const l of navLangs) tags.push(l);
  const resolved = _safeResolvedLocale();
  if (resolved) tags.push(resolved);

  for (const tag of tags) {
    const r = _extractRegionFromTag(tag);
    if (r) return r;
  }

  // 2) Timezone heuristics.
  // (Still imperfect: timezones are not 1:1 with countries, but helps when locale tags have no region.)
  const tz = _safeTimezone();
  if (tz === 'Asia/Tokyo') return 'JP';
  if (tz === 'Asia/Seoul') return 'KR';
  if (tz === 'Asia/Taipei') return 'TW';
  if (tz === 'Asia/Hong_Kong') return 'HK';
  if (tz === 'Asia/Singapore') return 'SG';
  if (tz === 'Asia/Bangkok') return 'TH';
  if (tz === 'Asia/Ho_Chi_Minh') return 'VN';
  if (tz === 'Asia/Jakarta') return 'ID';
  if (tz === 'Asia/Manila') return 'PH';
  if (tz === 'Asia/Kolkata') return 'IN';
  if (tz === 'Europe/London') return 'GB';
  if (tz === 'Europe/Paris') return 'FR';
  if (tz === 'Europe/Berlin') return 'DE';

  // China timezones are commonly "Asia/Shanghai" (and a few legacy aliases).
  if (tz === 'Asia/Shanghai' || tz === 'Asia/Chongqing' || tz === 'Asia/Harbin' || tz === 'Asia/Urumqi') return 'CN';

  if (tz.startsWith('Australia/')) return 'AU';
  // Canada commonly uses these, but keep it conservative.
  if (tz === 'America/Toronto' || tz === 'America/Vancouver' || tz === 'America/Halifax' || tz === 'America/Winnipeg' || tz === 'America/Edmonton' || tz === 'America/St_Johns') return 'CA';
  if (tz === 'America/Sao_Paulo') return 'BR';
  if (tz === 'America/Mexico_City') return 'MX';

  if (tz.startsWith('America/')) return 'US';

  return defaultCode;
}

export function normalizeLegionCode(code, fallback = 'JP') {
  const raw = String(code || '').trim().toUpperCase();
  if (raw && LEGION_CODE_SET.has(raw)) return raw;
  const fb = String(fallback || '').trim().toUpperCase();
  return fb && LEGION_CODE_SET.has(fb) ? fb : 'JP';
}

export function getLegionFlagAssetPath(code, fallback = 'JP') {
  const c = normalizeLegionCode(code, fallback);
  return `/country/${c.toLowerCase()}.svg`;
}
