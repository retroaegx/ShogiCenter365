// Build-id based cache busting + auto-reload helper
// - CLIENT_BUILD_ID: baked at build time
// - Server exposes the current build id at /api/build-info

export const CLIENT_BUILD_ID = (import.meta?.env?.VITE_BUILD_ID || '').trim();

const CHECK_INTERVAL_MS = 15_000; // throttle
const TS_KEY = '__shogi_build_check_ts__';

function nowMs() {
  try { return Date.now(); } catch { return 0; }
}

function canCheck() {
  try {
    const last = Number(sessionStorage.getItem(TS_KEY) || '0');
    const n = nowMs();
    if (!n) return true;
    if (n - last < CHECK_INTERVAL_MS) return false;
    sessionStorage.setItem(TS_KEY, String(n));
    return true;
  } catch {
    return true;
  }
}

export async function fetchServerBuildId() {
  try {
    const res = await fetch('/api/build-info', {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const v = (j?.buildId ?? '').toString().trim();
    return v || null;
  } catch {
    return null;
  }
}

export async function maybeReloadIfBuildChanged() {
  if (!canCheck()) return false;

  const server = await fetchServerBuildId();
  if (!server) return false;

  // If CLIENT_BUILD_ID is missing for some reason, don't reload endlessly.
  if (!CLIENT_BUILD_ID) return false;

  if (server !== CLIENT_BUILD_ID) {
    try {
      // Ensure we fetch the newest HTML/CSS
      window.location.reload();
    } catch {}
    return true;
  }
  return false;
}
