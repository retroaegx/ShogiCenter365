import React, { useEffect, useMemo, useRef } from 'react';

const GSI_SCRIPT_ID = 'gsi-client-script';

const ensureGsiScript = () => {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window?.google?.accounts?.id) return Promise.resolve(true);

  return new Promise((resolve) => {
    const existing = document.getElementById(GSI_SCRIPT_ID);
    if (existing) {
      const start = Date.now();
      const tick = () => {
        if (window?.google?.accounts?.id) return resolve(true);
        if (Date.now() - start > 8000) return resolve(false);
        setTimeout(tick, 120);
      };
      tick();
      return;
    }

    const s = document.createElement('script');
    s.id = GSI_SCRIPT_ID;
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(!!window?.google?.accounts?.id);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
};

const ensureGlobalInit = (clientId) => {
  const gsi = window?.google?.accounts?.id;
  if (!gsi) return false;
  if (window.__shogiGsiInitialized && window.__shogiGsiClientId === clientId) return true;

  try {
    gsi.initialize({
      client_id: clientId,
      callback: (resp) => {
        const cred = resp?.credential;
        if (!cred) return;
        const h = window.__shogiGsiCredentialHandler;
        if (typeof h === 'function') h(cred);
      },
    });
    window.__shogiGsiInitialized = true;
    window.__shogiGsiClientId = clientId;
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('GSI initialize failed', e);
    return false;
  }
};

const raf = (cb) =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      cb && cb();
      resolve();
    });
  });

const calcClampedWidth = (hostEl, desiredWidth) => {
  const parent = hostEl?.parentElement;
  if (!parent) return desiredWidth;

  const available = parent.clientWidth;
  if (!available || available <= 0) return null;

  // -2: border/subpixel rounding safety
  return Math.max(180, Math.min(desiredWidth, Math.floor(available - 2)));
};

/**
 * Google Identity Services のボタンを描画する。
 * - callback はグローバルハンドラ経由にすることで、タブ切替などで
 *   画面が変わっても最新の onCredential が呼ばれる。
 *
 * 重要:
 * - GSI のボタンは px 固定幅の iframe を描画する。
 * - 初回で「大きい幅 → 縮む」が見えるのは、初期 width(例:320)で描画した後に
 *   クランプ幅へ描画し直すため。
 * - ここでは “描画直前に実幅を測ってその幅で一回で描画” する。
 */
const GoogleGsiButton = ({ clientId, onCredential, text = 'signin_with', width = 320 }) => {
  const btnRef = useRef(null);
  const ownerIdRef = useRef(Math.random().toString(36).slice(2));
  const onCredentialRef = useRef(onCredential);
  const lastWidthRef = useRef(null);
  const roRef = useRef(null);
  const rafIdRef = useRef(0);

  const desiredWidth = useMemo(() => {
    const n = Number(width);
    return Number.isFinite(n) ? Math.max(180, Math.floor(n)) : 320;
  }, [width]);

  useEffect(() => {
    onCredentialRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    if (!clientId || typeof window === 'undefined') return;

    let cancelled = false;
    const ownerId = ownerIdRef.current;

    const handler = (cred) => {
      try {
        onCredentialRef.current && onCredentialRef.current(cred);
      } catch (e) {
        // ignore
      }
    };
    handler.__owner = ownerId;
    window.__shogiGsiCredentialHandler = handler;

    let readyPromise = null;
    const ensureReady = () => {
      if (readyPromise) return readyPromise;
      readyPromise = (async () => {
        const ok = await ensureGsiScript();
        if (!ok) return false;
        if (!ensureGlobalInit(clientId)) return false;
        return true;
      })();
      return readyPromise;
    };

    const renderOnce = async (force = false) => {
      if (cancelled) return;
      const host = btnRef.current;
      if (!host) return;

      // レイアウトが確定するまで少し待つ（親の clientWidth が 0 のことがある）
      let clamped = null;
      for (let i = 0; i < 6; i += 1) {
        clamped = calcClampedWidth(host, desiredWidth);
        if (clamped != null) break;
        await raf();
      }
      const finalWidth = clamped ?? desiredWidth;

      if (!force && lastWidthRef.current === finalWidth) return;
      lastWidthRef.current = finalWidth;

      const ok = await ensureReady();
      if (cancelled || !ok || !btnRef.current) return;

      try {
        host.innerHTML = '';
        window.google.accounts.id.renderButton(host, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text,
          shape: 'pill',
          width: finalWidth,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('GSI renderButton failed', e);
      }
    };

    const scheduleRerender = () => {
      if (cancelled) return;
      if (rafIdRef.current) return;
      rafIdRef.current = requestAnimationFrame(async () => {
        rafIdRef.current = 0;
        await renderOnce(false);
      });
    };

    // Initial render
    renderOnce(true);

    const host = btnRef.current;
    const parent = host?.parentElement;

    if (parent && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => scheduleRerender());
      ro.observe(parent);
      roRef.current = ro;
    }

    window.addEventListener('resize', scheduleRerender, { passive: true });

    return () => {
      cancelled = true;
      window.removeEventListener('resize', scheduleRerender);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      if (roRef.current) {
        roRef.current.disconnect();
        roRef.current = null;
      }
      const current = window.__shogiGsiCredentialHandler;
      if (current && current.__owner === ownerId) {
        window.__shogiGsiCredentialHandler = null;
      }
    };
  }, [clientId, text, desiredWidth]);

  if (!clientId) return null;
  return <div ref={btnRef} style={{ maxWidth: '100%', overflow: 'hidden' }} />;
};

export default GoogleGsiButton;
