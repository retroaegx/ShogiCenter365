// src/utils/deviceFlags.js
// Device / UI mode helpers.
// - iPad is ALWAYS treated as tablet (never Desktop UI), even if it reports trackpad/mouse.
// - Desktop UI means: wide screen + hover + fine pointer + not iPad.

export function getDeviceFlags() {
  if (typeof window === 'undefined') {
    return { isIpad: false, isTouch: false, isDesktopUi: true, wide: true, hasHover: true, finePointer: true };
  }

  const nav = window.navigator || {};
  const ua = nav.userAgent || '';
  const platform = nav.platform || '';
  const maxTouchPoints = nav.maxTouchPoints || 0;

  const isIpad = /iPad/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const isTouch = maxTouchPoints > 0 || ('ontouchstart' in window);

  const mm = (q) => {
    try { return !!window.matchMedia(q).matches; } catch { return false; }
  };

  const wide = mm('(min-width: 1024px)');
  const hasHover = mm('(hover: hover)');
  const finePointer = mm('(pointer: fine)');

  // iPad は常にタブレット扱い
  const isDesktopUi = wide && hasHover && finePointer && !isIpad;

  return { isIpad, isTouch, isDesktopUi, wide, hasHover, finePointer };
}

export function listenDeviceFlags(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mqs = [
    window.matchMedia('(min-width: 1024px)'),
    window.matchMedia('(hover: hover)'),
    window.matchMedia('(pointer: fine)'),
  ];

  let raf = 0;
  const emit = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      try { onChange(getDeviceFlags()); } catch {}
    });
  };

  const handler = () => emit();

  for (const mq of mqs) {
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
  }
  // initial
  emit();

  return () => {
    if (raf) cancelAnimationFrame(raf);
    for (const mq of mqs) {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else if (mq.removeListener) mq.removeListener(handler);
    }
  };
}
