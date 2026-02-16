import { useEffect, useRef } from 'react';

function isIOSLike() {
  try {
    const ua = navigator?.userAgent || '';
    const maxTouch = Number(navigator?.maxTouchPoints || 0);
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    const isAppleMobileUA = /iPhone|iPad|iPod/.test(ua);
    // iPadOS "Request Desktop Site" can appear as Macintosh with touch points.
    const isIpadOsDesktopUA = /Macintosh/.test(ua) && (maxTouch > 1 || coarse);

    return !!(isAppleMobileUA || isIpadOsDesktopUA);
  } catch {
    return false;
  }
}

function safeObj(v) {
  return (v && typeof v === 'object') ? v : {};
}

/**
 * Best-effort back-navigation lock.
 *
 * - When enabled, adds a history entry and re-pushes it on back (popstate).
 * - On iOS Safari, arms only after the first user activation (pointerdown/touchstart/keydown)
 *   because some history entries added without activation may be skipped.
 *
 * NOTE: Browsers may still bypass this in some cases; treat as UX guard, not a security boundary.
 */
export function useBackNavigationLock(enabled) {
  const armedRef = useRef(false);
  const cleanupArmerRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      armedRef.current = false;
      if (cleanupArmerRef.current) {
        try { cleanupArmerRef.current(); } catch {}
        cleanupArmerRef.current = null;
      }
      return;
    }

    const url = (() => {
      try { return window.location.href; } catch { return ''; }
    })();

    const pushLockEntry = () => {
      // Replace then push so there is always a prior entry inside the app.
      try {
        const prev = safeObj(window.history.state);
        window.history.replaceState({ ...prev, __shogiGameBackLockRoot: true }, '', url || window.location.href);
      } catch {
        try { window.history.replaceState({ __shogiGameBackLockRoot: true }, '', url || window.location.href); } catch {}
      }
      try {
        window.history.pushState({ __shogiGameBackLock: true }, '', url || window.location.href);
      } catch {
        try { window.history.pushState(null, '', url || window.location.href); } catch {}
      }
    };

    const onPopState = () => {
      if (!armedRef.current) return;
      // Re-push the lock entry so the visible screen stays.
      try {
        window.history.pushState({ __shogiGameBackLock: true }, '', url || window.location.href);
      } catch {
        try { window.history.pushState(null, '', url || window.location.href); } catch {}
      }
    };

    const arm = () => {
      if (armedRef.current) return;
      armedRef.current = true;
      pushLockEntry();
      window.addEventListener('popstate', onPopState);
    };

    const disarm = () => {
      // Remove listeners first.
      try { window.removeEventListener('popstate', onPopState); } catch {}
      if (cleanupArmerRef.current) {
        try { cleanupArmerRef.current(); } catch {}
        cleanupArmerRef.current = null;
      }
      // Best-effort: if we're sitting on the lock entry, step back once to drop it.
      try {
        const st = window.history.state;
        if (st && typeof st === 'object' && st.__shogiGameBackLock) {
          window.history.back();
        }
      } catch {}
      armedRef.current = false;
    };

    // iOS Safari often requires a user activation for pushState entries to be honored.
    if (isIOSLike()) {
      let done = false;
      const armOnce = () => {
        if (done) return;
        done = true;
        arm();
      };

      const opts = { capture: true, passive: true };
      const add = (type) => {
        try { window.addEventListener(type, armOnce, opts); } catch {}
      };
      const remove = (type) => {
        try { window.removeEventListener(type, armOnce, opts); } catch {}
      };

      add('pointerdown');
      add('touchstart');
      add('keydown');

      cleanupArmerRef.current = () => {
        remove('pointerdown');
        remove('touchstart');
        remove('keydown');
      };
    } else {
      arm();
    }

    return () => {
      disarm();
    };
  }, [enabled]);
}
