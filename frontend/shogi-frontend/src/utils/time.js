// Shared time utilities
export const fmt = (ms) => {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
};


// Extra helpers for segmented clocks
export const fmtMs = (ms) => {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
};
export const secsCeil = (ms) => {
  const s = Math.ceil(Math.max(0, (ms ?? 0) / 1000));
  return `${s}`;
};
