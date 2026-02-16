// src/utils/layoutProbe.js
//
// Layout investigation helper (OPT-IN).
// Enable by adding ?layoutProbe=1 to the URL.
//
// Goals:
// - Capture early/late layout states (before React + after React) with timestamps.
// - Record breakpoint decisions (md=768, lg=1024) and main containers' rects.
// - Detect the "盤だけ" symptom and auto-dump snapshots.
// - Provide easy export methods (clipboard / download) without changing UI.

/* eslint-disable no-console */

const DEFAULT_BUFFER = 80;
const LS_KEY = '__layoutProbe_buffer_v2';

function nowTag() {
  try {
    const t = performance && typeof performance.now === 'function' ? Math.round(performance.now()) : Date.now();
    return `${t}ms`;
  } catch {
    return `${Date.now()}ms`;
  }
}

function safeGetRect(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  return {
    x: +r.x.toFixed(1),
    y: +r.y.toFixed(1),
    w: +r.width.toFixed(1),
    h: +r.height.toFixed(1),
    top: +r.top.toFixed(1),
    left: +r.left.toFixed(1),
    bottom: +r.bottom.toFixed(1),
    right: +r.right.toFixed(1),
  };
}

function safeCss(el, keys) {
  if (!el) return null;
  let cs;
  try {
    cs = getComputedStyle(el);
  } catch {
    return null;
  }
  const out = {};
  for (const k of keys) {
    try {
      out[k] = cs[k];
    } catch {
      out[k] = null;
    }
  }
  return out;
}

function isVisible(el) {
  if (!el) return false;
  try {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch {
    return false;
  }
}

function pickVisible(selector) {
  const els = Array.from(document.querySelectorAll(selector));
  if (els.length === 0) return { picked: null, candidates: [] };
  const candidates = els.map((el) => ({
    rect: safeGetRect(el),
    display: (() => { try { return getComputedStyle(el).display; } catch { return null; } })(),
    visibility: (() => { try { return getComputedStyle(el).visibility; } catch { return null; } })(),
  }));
  const picked = els.find(isVisible) || els[0] || null;
  return { picked, candidates };
}

function listStylesheets() {
  const out = [];
  try {
    const sheets = Array.from(document.styleSheets || []);
    for (const s of sheets) {
      out.push(s && s.href ? String(s.href) : '[inline]');
      if (out.length >= 24) break;
    }
  } catch {}
  return out;
}

function listPerfResources() {
  try {
    if (!performance || typeof performance.getEntriesByType !== 'function') return null;
    const entries = performance.getEntriesByType('resource') || [];
    const css = [];
    const js = [];
    for (const e of entries) {
      const name = String(e.name || '');
      const it = String(e.initiatorType || '');
      const rec = {
        name: name.split('?')[0].slice(-120),
        initiatorType: it,
        startTime: Math.round(e.startTime || 0),
        duration: Math.round(e.duration || 0),
      };
      if (name.includes('.css') || it === 'css' || it === 'link') css.push(rec);
      if (name.includes('.js') || it === 'script') js.push(rec);
    }
    return {
      css: css.slice(-20),
      js: js.slice(-20),
    };
  } catch {
    return null;
  }
}

function safeLocalStoragePick() {
  const keys = [
    'shogi_theme_piece_set',
    'shogi_theme_background_set',
    'boardDesignPreset',
  ];
  const out = {};
  try {
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v != null) out[k] = String(v).slice(0, 200);
    }
  } catch {}
  return out;
}

function breakpointFlags() {
  const mm = (q) => {
    try { return !!window.matchMedia(q).matches; } catch { return null; }
  };
  return {
    md: mm('(min-width: 768px)'),
    lg: mm('(min-width: 1024px)'),
    prefersReducedMotion: mm('(prefers-reduced-motion: reduce)'),
  };
}

function readCssVar(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null;
  } catch {
    return null;
  }
}

function buildSnapshot(reason, extra) {
  const vv = window.visualViewport;

  const rootPick = pickVisible('#root');
  const appPick = pickVisible('.app-root');
  const mainPick = pickVisible('.site-main');
  const viewportPick = pickVisible('.viewport-shell');
  const gameViewportPick = pickVisible('.game-viewport');
  const mainShellPick = pickVisible('.main-shell');

  // Important: .game-grid / .game-bottom exist in both mobile+desktop trees.
  // We capture candidates and also the picked visible one.
  const gameGridPick = pickVisible('.game-grid');
  const gameBottomPick = pickVisible('.game-bottom');
  const chatPick = pickVisible('.chat-panel');
  const spectatorsPick = pickVisible('.spectator-panel');

  const pickedGameGrid = gameGridPick.picked;
  const pickedGameBottom = gameBottomPick.picked;

  const snap = {
    reason,
    time: {
      tag: nowTag(),
      perfMs: (() => { try { return Math.round(performance.now()); } catch { return null; } })(),
    },
    url: String(location.href),
    dpr: window.devicePixelRatio || 1,
    breakpoints: breakpointFlags(),
    screen: {
      w: window.screen?.width ?? null,
      h: window.screen?.height ?? null,
      availW: window.screen?.availWidth ?? null,
      availH: window.screen?.availHeight ?? null,
    },
    window: {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      outerW: window.outerWidth,
      outerH: window.outerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    docEl: {
      clientW: document.documentElement?.clientWidth ?? null,
      clientH: document.documentElement?.clientHeight ?? null,
      scrollW: document.documentElement?.scrollWidth ?? null,
      scrollH: document.documentElement?.scrollHeight ?? null,
    },
    visualViewport: vv ? {
      w: vv.width,
      h: vv.height,
      scale: vv.scale,
      offsetTop: vv.offsetTop,
      offsetLeft: vv.offsetLeft,
      pageTop: vv.pageTop,
      pageLeft: vv.pageLeft,
    } : null,
    cssVars: {
      appHeight_inline: document.documentElement?.style?.getPropertyValue('--app-height')?.trim() || null,
      appHeight: readCssVar('--app-height'),
      hdr: readCssVar('--hdr'),
      ftr: readCssVar('--ftr'),
    },
    stylesheets: listStylesheets(),
    perf: listPerfResources(),
    localStorage: safeLocalStoragePick(),
    elements: [
      { selector: '#root', picked: !!rootPick.picked, rect: safeGetRect(rootPick.picked), css: safeCss(rootPick.picked, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY','flex','flexDirection','gridTemplateRows','gridTemplateColumns']) },
      { selector: '.app-root', picked: !!appPick.picked, rect: safeGetRect(appPick.picked), css: safeCss(appPick.picked, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY','flex','flexDirection','gridTemplateRows','gridTemplateColumns']) },
      { selector: '.site-main', picked: !!mainPick.picked, rect: safeGetRect(mainPick.picked), css: safeCss(mainPick.picked, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY','flex','flexDirection']) },
      { selector: '.viewport-shell', picked: !!viewportPick.picked, rect: safeGetRect(viewportPick.picked), css: safeCss(viewportPick.picked, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY','flex','flexDirection']) },
      { selector: '.main-shell', picked: !!mainShellPick.picked, rect: safeGetRect(mainShellPick.picked), css: safeCss(mainShellPick.picked, ['display','position','width','maxWidth','height','minHeight','maxHeight','overflow','overflowX','overflowY','flex','flexDirection']) },
      { selector: '.game-viewport', picked: !!gameViewportPick.picked, rect: safeGetRect(gameViewportPick.picked), css: safeCss(gameViewportPick.picked, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY','flex','flexDirection']) },
      { selector: '.game-grid (picked)', picked: !!pickedGameGrid, rect: safeGetRect(pickedGameGrid), css: safeCss(pickedGameGrid, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY','flex','flexDirection']) },
      { selector: '.game-bottom (picked)', picked: !!pickedGameBottom, rect: safeGetRect(pickedGameBottom), css: safeCss(pickedGameBottom, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY','flex','flexDirection']) },
      { selector: '.chat-panel (picked)', picked: !!chatPick.picked, rect: safeGetRect(chatPick.picked), css: safeCss(chatPick.picked, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY']) },
      { selector: '.spectator-panel (picked)', picked: !!spectatorsPick.picked, rect: safeGetRect(spectatorsPick.picked), css: safeCss(spectatorsPick.picked, ['display','position','height','minHeight','maxHeight','overflow','overflowX','overflowY']) },
    ],
    candidates: {
      gameGrid: gameGridPick.candidates,
      gameBottom: gameBottomPick.candidates,
    },
    flags: {
      // Filled by heuristics below
      boardOnlySuspected: false,
      nearLgBoundary: false,
    },
    extra: extra || null,
  };

  // Heuristic flags
  try {
    const innerW = window.innerWidth || 0;
    snap.flags.nearLgBoundary = Math.abs(innerW - 1024) <= 32;
  } catch {}

  try {
    if (pickedGameGrid && pickedGameBottom) {
      const gr = pickedGameGrid.getBoundingClientRect();
      const br = pickedGameBottom.getBoundingClientRect();
      // "盤だけ" suspicion: bottom exists but has almost no height, while grid is tall.
      if (gr.height > 0.6 * (window.innerHeight || 1) && br.height < 12) {
        snap.flags.boardOnlySuspected = true;
      }
      // Also suspicious if bottom is pushed below viewport.
      if (br.top > (window.innerHeight || 0) + 8) {
        snap.flags.boardOnlySuspected = true;
      }
    }
  } catch {}

  return snap;
}

function ensureBuffer(state) {
  if (!Array.isArray(state.buffer)) state.buffer = [];
  if (!state.bufferMax || typeof state.bufferMax !== 'number') state.bufferMax = DEFAULT_BUFFER;
}

function pushBuffer(state, snap) {
  ensureBuffer(state);
  state.buffer.push(snap);
  while (state.buffer.length > state.bufferMax) state.buffer.shift();
  try {
    // Persist small ring buffer so you can copy later even if UI changes.
    localStorage.setItem(LS_KEY, JSON.stringify(state.buffer));
  } catch {}
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // fallback
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

function downloadJson(filename, obj) {
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch {
    return false;
  }
}

export function initLayoutProbe(options = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__layoutProbe && window.__layoutProbe.__initedV2) {
    // allow updating context/options
    try {
      if (options && options.bufferMax) window.__layoutProbe.setBufferMax(options.bufferMax);
      if (options && options.auto) window.__layoutProbe.startAuto();
    } catch {}
    return;
  }

  const state = {
    __initedV2: true,
    startedAt: nowTag(),
    context: {},
    last: null,
    buffer: [],
    bufferMax: typeof options.bufferMax === 'number' ? options.bufferMax : DEFAULT_BUFFER,
    autoTimer: 0,
    autoUntil: 0,
    mo: null,
  };

  // Restore persisted buffer if present
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr)) state.buffer = arr.slice(-state.bufferMax);
  } catch {}

  const api = {
    __initedV2: true,
    dumpNow(reason = 'manual', extra = null) {
      try {
        const snap = buildSnapshot(reason, { ...(state.context || {}), ...(extra || {}) });
        state.last = snap;
        pushBuffer(state, snap);
        console.log('[layoutProbe] dump:', snap);
        return snap;
      } catch (e) {
        console.warn('[layoutProbe] dump failed', e);
        const snap = { reason, time: { tag: nowTag() }, error: String(e && e.message ? e.message : e) };
        state.last = snap;
        pushBuffer(state, snap);
        return snap;
      }
    },
    last() {
      return state.last;
    },
    buffer() {
      return Array.isArray(state.buffer) ? state.buffer : [];
    },
    setContext(ctx) {
      try { state.context = { ...(state.context || {}), ...(ctx || {}) }; } catch {}
    },
    setBufferMax(n) {
      if (typeof n !== 'number' || !isFinite(n) || n < 10) return;
      state.bufferMax = Math.max(10, Math.min(500, Math.floor(n)));
      ensureBuffer(state);
      while (state.buffer.length > state.bufferMax) state.buffer.shift();
      try { localStorage.setItem(LS_KEY, JSON.stringify(state.buffer)); } catch {}
    },
    async copyLast() {
      const snap = state.last;
      if (!snap) return null;
      const ok = await copyText(JSON.stringify(snap, null, 2));
      console.log('[layoutProbe] copyLast:', ok);
      return snap;
    },
    async copyBuffer() {
      const buf = Array.isArray(state.buffer) ? state.buffer : [];
      const ok = await copyText(JSON.stringify(buf, null, 2));
      console.log('[layoutProbe] copyBuffer:', ok, `(${buf.length})`);
      return buf;
    },
    downloadLast() {
      const snap = state.last;
      if (!snap) return false;
      return downloadJson(`layoutProbe_last_${Date.now()}.json`, snap);
    },
    downloadBuffer() {
      const buf = Array.isArray(state.buffer) ? state.buffer : [];
      return downloadJson(`layoutProbe_buffer_${Date.now()}.json`, buf);
    },
    startAuto({ intervalMs = 250, durationMs = 180000 } = {}) {
      if (state.autoTimer) return;
      const i = Math.max(120, Math.min(2000, Math.floor(intervalMs)));
      const d = Math.max(5000, Math.min(10 * 60 * 1000, Math.floor(durationMs)));
      state.autoUntil = Date.now() + d;
      state.autoTimer = window.setInterval(() => {
        if (Date.now() > state.autoUntil) {
          api.stopAuto();
          return;
        }
        const snap = api.dumpNow('auto-tick');
        if (snap && snap.flags && snap.flags.boardOnlySuspected) {
          api.dumpNow('auto-detected-board-only', { from: 'auto-tick' });
        }
      }, i);
      console.log('[layoutProbe] auto started', { intervalMs: i, durationMs: d });
    },
    stopAuto() {
      if (state.autoTimer) {
        clearInterval(state.autoTimer);
        state.autoTimer = 0;
        console.log('[layoutProbe] auto stopped');
      }
    },
    clearBuffer() {
      state.buffer = [];
      try { localStorage.removeItem(LS_KEY); } catch {}
    },
  };

  window.__layoutProbe = api;

  // Initial snapshots (boot -> first paint -> settle)
  api.dumpNow(options.boot ? 'boot' : 'init');
  try {
    requestAnimationFrame(() => api.dumpNow('raf-1'));
    requestAnimationFrame(() => api.dumpNow('raf-2'));
    setTimeout(() => api.dumpNow('t+120ms'), 120);
    setTimeout(() => api.dumpNow('t+500ms'), 500);
  } catch {}

  // Fonts often change metrics without resize
  try {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => api.dumpNow('fonts-ready'));
    }
  } catch {}

  // Reactive dumps
  const onResize = () => api.dumpNow('resize');
  try {
    window.addEventListener('resize', onResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => api.dumpNow('visualViewport.resize'), { passive: true });
      window.visualViewport.addEventListener('scroll', () => api.dumpNow('visualViewport.scroll'), { passive: true });
    }
  } catch {}

  // Observe key subtree changes (layout flip without resize)
  try {
    const mo = new MutationObserver(() => {
      // Keep it lightweight: only dump when in game view containers exist
      if (document.querySelector('.game-viewport')) api.dumpNow('mutation');
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    state.mo = mo;
  } catch {}

  // Optional auto mode via query param
  try {
    const qs = new URLSearchParams(window.location.search || '');
    if (qs.has('layoutProbeAuto')) api.startAuto();
  } catch {}
}
