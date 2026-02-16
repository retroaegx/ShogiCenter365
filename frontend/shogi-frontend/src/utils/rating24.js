// 将棋倶楽部24の目安（段級の境は上下の中間点）
// 登録時は五段(2400)まで（将棋倶楽部24の目安）

import { t } from '@/i18n';

export const RATING_MIN = 0;
export const RATING_MAX = 2400;
export const RATING_STEP = 100;

export const DEFAULT_INITIAL_RATING = 0;

// NOTE: 多言語化のため、ラベルは呼び出し時に t() を通す。
//（初期ロードで固定すると、言語切替後に更新されないため）
export const getRatingLevels24 = () => ([
  { anchor: 0, label: t('ui.utils.rating24.kbe26042c') },
  { anchor: 100, label: t('ui.utils.rating24.kb7c2aba0') },
  { anchor: 200, label: t('ui.utils.rating24.k907de06a') },
  { anchor: 300, label: t('ui.utils.rating24.kf07f96fc') },
  { anchor: 400, label: t('ui.utils.rating24.k099ce2be') },
  { anchor: 500, label: t('ui.utils.rating24.k4d5f3ddc') },
  { anchor: 600, label: t('ui.utils.rating24.k8ddc74da') },
  { anchor: 700, label: t('ui.utils.rating24.k385e9da8') },
  { anchor: 800, label: t('ui.utils.rating24.k3c2f5ccd') },
  { anchor: 900, label: t('ui.utils.rating24.kc5b4645b') },
  { anchor: 1000, label: t('ui.utils.rating24.k8caeebdb') },
  { anchor: 1100, label: t('ui.utils.rating24.k2525a92e') },
  { anchor: 1200, label: t('ui.utils.rating24.k99cfca43') },
  { anchor: 1300, label: t('ui.utils.rating24.ka42cd7f6') },
  { anchor: 1400, label: t('ui.utils.rating24.k56ed4240') },
  { anchor: 1500, label: t('ui.utils.rating24.k60666bd4') },
  { anchor: 1600, label: t('ui.utils.rating24.k10718b33') },
  { anchor: 1800, label: t('ui.utils.rating24.k72d8b5e5') },
  { anchor: 2000, label: t('ui.utils.rating24.k6b569325') },
  { anchor: 2200, label: t('ui.utils.rating24.k3881e89c') },
  { anchor: 2400, label: t('ui.utils.rating24.k7b646fb9') },
  { anchor: 2600, label: t('ui.utils.rating24.k867bd53d') },
  { anchor: 2800, label: t('ui.utils.rating24.k0e580dc5') },
  { anchor: 3000, label: t('ui.utils.rating24.k869eaa1d') },
]);

export const ratingToRank24 = (rating) => {
  const r = Number(rating);
  if (!Number.isFinite(r)) return '';
  const levels = getRatingLevels24();
  let label = levels[0].label;
  for (let i = 1; i < levels.length; i++) {
    const min = (levels[i - 1].anchor + levels[i].anchor) / 2;
    if (r >= min) label = levels[i].label;
  }
  return label;
};

export const buildRatingOptions = ({ min = RATING_MIN, max = RATING_MAX, step = RATING_STEP } = {}) => {
  const opts = [];
  for (let v = min; v <= max; v += step) opts.push(v);
  return opts;
};
