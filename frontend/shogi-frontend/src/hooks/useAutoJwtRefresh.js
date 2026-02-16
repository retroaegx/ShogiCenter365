// Robust auto-refresh hook without external interval helpers
import { useEffect, useRef } from 'react';
import api from '@/services/apiClient';

// Interval config resolved from env at runtime
const TOUCH_INTERVAL_SEC = Number((import.meta?.env?.VITE_LOBBY_TOUCH_INTERVAL_SECONDS ?? '300')) || 300;
const INTERVAL_MS = Math.max(10, TOUCH_INTERVAL_SEC) * 1000;

// Decode JWT 'exp' (seconds)
function decodeJwtExpSeconds(token) {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return Number(json.exp);
  } catch {
    return null;
  }
}

/**
 * Auto-refresh JWT by calling /lobby/touch when remaining lifetime < TOUCH_INTERVAL_SEC.
 * Runs on mount and every INTERVAL_MS while enabled=true.
 */
export default function useAutoJwtRefresh(enabled) {
  const timerRef = useRef(null);

  async function timerHandler() {
    const token = (typeof window !== 'undefined') ? (localStorage.getItem('access_token') || localStorage.getItem('token')) : null;
    if (!token) return;

    const exp = decodeJwtExpSeconds(token);
    if (!exp) return;

    const now = Math.floor(Date.now() / 1000);
    const remain = exp - now;

    if (remain < TOUCH_INTERVAL_SEC) {
      try {
        const res = await api.post('/lobby/touch');
        const t = res?.data?.access_token;
        if (t) {
          localStorage.setItem('access_token', t);
          localStorage.setItem('token', t);
        }
      } catch (e) {
        // Don't throw inside the hook; just log.
        console.error('touch rotate error', e);
      }
    }
  }

  useEffect(() => {
    if (!enabled) return;
    // run immediately
    timerHandler();
    // then set interval
    timerRef.current = setInterval(timerHandler, INTERVAL_MS);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [enabled]);
}
