// src/lib/rules.js
export const TIME_RULES = {
  m15: { label: '15分' },
  m30: { label: '30分' },
  rapid1: { label: '早指1' },
  rapid2: { label: '早指2' },
  rapid3: { label: '早指3' },
}

export function timeCodeToLabel(code) {
  return (TIME_RULES[code] && TIME_RULES[code].label) || '不明'
}

export function gameTypeToLabel(t) {
  return t === 'free' ? '自由対局' : 'レーティング'
}
