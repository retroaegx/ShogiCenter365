// 将棋倶楽部24の目安（段級の境は上下の中間点）
// 登録時は五段(2400)まで（将棋倶楽部24の目安）

export const RATING_MIN = 0;
export const RATING_MAX = 2400;
export const RATING_STEP = 50;

export const DEFAULT_INITIAL_RATING = 1500;

export const RATING_LEVELS_24 = [
  { anchor: 0, label: '初心者' },
  { anchor: 100, label: '15級' },
  { anchor: 200, label: '14級' },
  { anchor: 300, label: '13級' },
  { anchor: 400, label: '12級' },
  { anchor: 500, label: '11級' },
  { anchor: 600, label: '10級' },
  { anchor: 700, label: '9級' },
  { anchor: 800, label: '8級' },
  { anchor: 900, label: '7級' },
  { anchor: 1000, label: '6級' },
  { anchor: 1100, label: '5級' },
  { anchor: 1200, label: '4級' },
  { anchor: 1300, label: '3級' },
  { anchor: 1400, label: '2級' },
  { anchor: 1500, label: '1級' },
  { anchor: 1600, label: '初段' },
  { anchor: 1800, label: '二段' },
  { anchor: 2000, label: '三段' },
  { anchor: 2200, label: '四段' },
  { anchor: 2400, label: '五段' },
  { anchor: 2600, label: '六段' },
  { anchor: 2800, label: '七段' },
  { anchor: 3000, label: '八段' },
];

export const ratingToRank24 = (rating) => {
  const r = Number(rating);
  if (!Number.isFinite(r)) return '';
  let label = RATING_LEVELS_24[0].label;
  for (let i = 1; i < RATING_LEVELS_24.length; i++) {
    const min = (RATING_LEVELS_24[i - 1].anchor + RATING_LEVELS_24[i].anchor) / 2;
    if (r >= min) label = RATING_LEVELS_24[i].label;
  }
  return label;
};

export const buildRatingOptions = ({ min = RATING_MIN, max = RATING_MAX, step = RATING_STEP } = {}) => {
  const opts = [];
  for (let v = min; v <= max; v += step) opts.push(v);
  return opts;
};
