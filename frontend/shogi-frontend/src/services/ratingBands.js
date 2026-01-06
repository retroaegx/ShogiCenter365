
// src/services/ratingBands.js
export const RATING_TABS = [
  { key: 'highdan', label: '高段',   range: [2300, Infinity] },
  { key: 'dan',     label: '段',     range: [1600, 2300]     },
  { key: 'high',    label: '上級',   range: [1200, 1600]     },
  { key: 'mid',     label: '中級',   range: [550, 1200]      },
  { key: 'low',     label: '低級',   range: [0, 550]         },
];

export function bandOfRating(rating) {
  const r = Number.isFinite(rating) ? rating : 0;
  const t = RATING_TABS.find(t => r >= t.range[0] && r < t.range[1]);
  return t ? t.key : 'low';
}
