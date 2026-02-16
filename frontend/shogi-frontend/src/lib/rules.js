// src/lib/rules.js
import { t } from '@/i18n';

// NOTE: 静的ラベルはここで t() を通す（言語切替で更新させるため）
export const TIME_RULES = {
  m15: { labelKey: 'ui.lib.rules.k54252b90' },
  m30: { labelKey: 'ui.lib.rules.k08477099' },
  rapid1: { labelKey: 'ui.lib.rules.kac25f5f7' },
  rapid2: { labelKey: 'ui.lib.rules.k348f29ab' },
  rapid3: { labelKey: 'ui.lib.rules.k018d8b90' },
};

export function timeCodeToLabel(code) {
  switch (code) {
    case 'm15': return t('ui.lib.rules.k54252b90');
    case 'm30': return t('ui.lib.rules.k08477099');
    case 'rapid1': return t('ui.lib.rules.kac25f5f7');
    case 'rapid2': return t('ui.lib.rules.k348f29ab');
    case 'rapid3': return t('ui.lib.rules.k018d8b90');
    default: return t('ui.lib.rules.k75e9dd8f');
  }
}

export function gameTypeToLabel(type) {
  return type === 'free' ? t('ui.lib.rules.k036a9f3c') : t('ui.lib.rules.ke496d813');
}
