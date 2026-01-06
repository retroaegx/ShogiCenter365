export const LOBBY_TOUCH_INTERVAL_SECONDS =
  Number((import.meta?.env?.VITE_LOBBY_TOUCH_INTERVAL_SECONDS ?? '300')) || 300;

export function getTouchIntervalMs() {
  return Math.max(10, LOBBY_TOUCH_INTERVAL_SECONDS) * 1000;
}
