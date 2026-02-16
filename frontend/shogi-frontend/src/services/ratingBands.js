
import { t } from '@/i18n';

// src/services/ratingBands.js
// NOTE: 表示ラベルは getRatingTabs() で t() を通す（言語切替で更新させるため）
export const RATING_TAB_DEFS = [
  { key: 'highdan', range: [2300, Infinity] },
  { key: 'dan',     range: [1600, 2300]     },
  { key: 'high',    range: [1200, 1600]     },
  { key: 'mid',     range: [550, 1200]      },
  { key: 'low',     range: [0, 550]         },
];

export function getRatingTabs() {
  // literal t() so gen-i18n picks up keys
  const labelMap = {
    highdan: t('ui.services.ratingbands.kffeedfec'),
    dan:     t('ui.services.ratingbands.kc865b5b0'),
    high:    t('ui.services.ratingbands.kc87eaa66'),
    mid:     t('ui.services.ratingbands.kdb829393'),
    low:     t('ui.services.ratingbands.kfc85f8db'),
  };
  return RATING_TAB_DEFS.map((d) => ({ ...d, label: labelMap[d.key] ?? '' }));
}

export function bandOfRating(rating) {
  const r = Number.isFinite(rating) ? rating : 0;
  const tabMatch = RATING_TAB_DEFS.find(x => r >= x.range[0] && r < x.range[1]);
  return tabMatch ? tabMatch.key : 'low';
}
