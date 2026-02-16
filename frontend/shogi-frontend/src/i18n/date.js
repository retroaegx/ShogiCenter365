// src/i18n/date.js
// Date/locale helpers for UI.
//
// - Language is read from localStorage (via utils/language).
// - Only Japanese locale is bundled for now.
// - When adding languages, extend getDateFnsLocale / getDateFormatShort.

import { format } from 'date-fns';
import { ja } from 'date-fns/locale';

import { t, getMessages } from '@/i18n';

import { getPreferredLanguage, normalizeLanguage } from '@/utils/language';

function currentLang() {
  return normalizeLanguage(getPreferredLanguage());
}

export function getDateFnsLocale(lang) {
  const l = normalizeLanguage(lang || currentLang());
  switch (l) {
    case 'ja':
    default:
      return ja;
  }
}

export function getDateFormatShort(lang) {
  // keep key for gen-i18n
  t('date.format.short');
  const l = normalizeLanguage(lang || currentLang());
  const msg = getMessages(l);
  const fmt = msg ? msg['date.format.short'] : null;
  return (typeof fmt === 'string') ? fmt : '';
}


export function formatDateShort(date, lang) {
  try {
    if (!date) return '';
    return format(date, getDateFormatShort(lang), {
      locale: getDateFnsLocale(lang),
    });
  } catch {
    return '';
  }
}
