import React, {useState, useEffect, useMemo, useCallback, useRef} from 'react';
import { t } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ListOrdered } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { loadBoardTheme } from '@/config/themeLoader';
import {
  PIECE_NAMES,
  PLAYERS,
  PROMOTED_PIECES,
  getPossibleMoves,
  getDropMoves,
  canPromote,
  mustPromote,
  makeMove,
  makeDrop
} from '@/utils/shogiLogic';

import { buildUsiDrop, buildUsiMove, parseUsi } from '@/utils/usi';

/** =====================
 *  Theme normalization
 *  ===================== */
function normalizeTheme(raw) {
  if (!raw) return null;
  const themeObj = raw.theme ?? raw;

  // background can be string or object {path|url}
  const background =
    typeof themeObj.background === 'string'
      ? themeObj.background
      : (themeObj.background && (themeObj.background.path || themeObj.background.url)) || null;

  // board_region: support start/end variants
  let board_region = themeObj.board_region ?? themeObj.boardRegion ?? null;
  if (board_region) {
    const r = board_region;
    if (r.start && r.end) {
      board_region = {
        x: Number(r.start.x),
        y: Number(r.start.y),
        width: Number(r.end.x) - Number(r.start.x),
        height: Number(r.end.y) - Number(r.start.y),
      };
    } else if ('start_x' in r && 'start_y' in r && 'end_x' in r && 'end_y' in r) {
      board_region = {
        x: Number(r.start_x),
        y: Number(r.start_y),
        width: Number(r.end_x) - Number(r.start_x),
        height: Number(r.end_y) - Number(r.start_y),
      };
    } else if ('x1' in r && 'y1' in r && 'x2' in r && 'y2' in r) {
      board_region = {
        x: Number(r.x1),
        y: Number(r.y1),
        width: Number(r.x2) - Number(r.x1),
        height: Number(r.y2) - Number(r.y1),
      };
    }
  }

  const coordinates = themeObj.coordinates ?? themeObj.coords ?? {};
  const grid = themeObj.grid ?? {};
  const pieces = themeObj.pieces ?? themeObj.piece_images ?? themeObj.images ?? {};

  return { background, board_region, coordinates, grid, pieces };
}

function validateBoardThemeStrict(theme) {
  const errs = [];
  if (!theme || typeof theme !== 'object') {
    errs.push('theme not loaded');
    return errs;
  }
  if (!theme.background) errs.push('background is required in board-theme/config.json');
  if (!theme.board_region) errs.push('board_region is required in board-theme/config.json');
  if (theme.board_region) {
    const r = theme.board_region;
    const nums = ['x', 'y', 'width', 'height'].map((k) => Number(r[k]));
    const allNum = nums.every((v) => Number.isFinite(v));
    if (!allNum) errs.push('board_region must have numeric x,y,width,height');
    const allPos = nums.every((v) => v >= 0);
    if (!allPos) errs.push('board_region must set x,y,width,height all >= 0');
    if (!(Number(r.width) > 0 && Number(r.height) > 0)) errs.push('board_region width/height must be > 0');
  }
  return errs;
}

function computeScaledBackground(theme, bgNatural, cellPx) {
  if (!theme?.background) return null;
  const r = theme?.board_region;
  if (!r) throw new Error('[BoardThemeError] board_region is missing');
  const x = Number(r.x),
    y = Number(r.y),
    w = Number(r.width),
    h = Number(r.height);
  if (![x, y, w, h].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error('[BoardThemeError] board_region must have numeric non-negative x,y,width,height');
  }
  if (!(w > 0 && h > 0)) {
    throw new Error('[BoardThemeError] board_region width/height must be > 0');
  }
  const naturalW = Number(bgNatural.w || 0);
  const naturalH = Number(bgNatural.h || 0);
  if (!(naturalW > 0 && naturalH > 0)) {
    throw new Error('[BoardThemeError] background natural size not available');
  }

  // 9x9 等分。X/Yスケール差が大きい場合はエラー（フォールバック禁止）
  const targetBoardPx = 9 * cellPx;
  const scaleX = targetBoardPx / w;
  const scaleY = targetBoardPx / h;
  if (Math.abs(scaleX - scaleY) > 0.5) {
    throw new Error('[BoardThemeError] board_region is not square enough to divide into 9x9');
  }
  const scale = (scaleX + scaleY) / 2;

  const bgw = Math.round(naturalW * scale);
  const bgh = Math.round(naturalH * scale);
  const offsetLeft = Math.round(x * scale);
  const offsetTop = Math.round(y * scale);

  if (
    offsetLeft < 0 ||
    offsetTop < 0 ||
    offsetLeft + targetBoardPx > bgw ||
    offsetTop + targetBoardPx > bgh
  ) {
    throw new Error('[BoardThemeError] scaled board_region is out of background bounds');
  }
  return { bgw, bgh, offsetLeft, offsetTop, targetBoardPx, scale };
}


// === Fit-by-width helper: keep center column square and scale pieces with it ===

function computeScaledBackgroundByWidth(theme, bgNatural, desiredBoardWidth, maxHeightPx = null, maxBgW = null, maxBgH = null) {
  if (!theme || !theme.background) return null;

  const br = theme.board_region || theme.boardRegion;
  if (!br) throw new Error('[BoardThemeError] board_region is missing');

  let x, y, w, h;
  if (br.start && br.end) {
    x = Number(br.start.x); y = Number(br.start.y);
    w = Number(br.end.x) - Number(br.start.x);
    h = Number(br.end.y) - Number(br.start.y);
  } else if (typeof br.x1 !== 'undefined' && typeof br.x2 !== 'undefined') {
    x = Number(br.x1); y = Number(br.y1);
    w = Number(br.x2) - Number(br.x1);
    h = Number(br.y2) - Number(br.y1);
  } else {
    x = Number(br.x); y = Number(br.y);
    w = Number(br.width); h = Number(br.height);
  }

  if (![x,y,w,h].every((n)=>Number.isFinite(n))) throw new Error('[BoardThemeError] board_region must be numeric');
  if (!(w>0 && h>0)) throw new Error('[BoardThemeError] board_region width/height must be > 0');

  const naturalW = Number(bgNatural.w || 0);
  const naturalH = Number(bgNatural.h || 0);
  if (!(naturalW>0 && naturalH>0)) throw new Error('[BoardThemeError] background natural size not available');

  const desired = Math.max(0, Math.round(desiredBoardWidth || 0));
  if (!(desired>0)) return null;

  // scale so that board_region width fits the desired width (and respect optional height)
  const scales = [];
  const scaleFromWidth = desired / w;
  if (scaleFromWidth > 0) scales.push(scaleFromWidth);
  const scaleFromHeight = (Number.isFinite(maxHeightPx) && maxHeightPx > 0) ? (maxHeightPx / h) : null;
  if (scaleFromHeight && scaleFromHeight > 0) scales.push(scaleFromHeight);
  const bgWCap = (Number.isFinite(maxBgW) && maxBgW > 0) ? (maxBgW / naturalW) : null;
  if (bgWCap && bgWCap > 0) scales.push(bgWCap);
  const bgHCap = (Number.isFinite(maxBgH) && maxBgH > 0) ? (maxBgH / naturalH) : null;
  if (bgHCap && bgHCap > 0) scales.push(bgHCap);
  const scale = scales.length ? Math.min(...scales) : scaleFromWidth;
  if (!(scale > 0)) return null;

  const bgw = Math.round(naturalW * scale);
  const bgh = Math.round(naturalH * scale);

  const boardW = w * scale;
  const boardH = h * scale;
  const cellPx = Math.min(boardW / 9, boardH / 9);
  const boardPx = cellPx * 9;

  const offsetLeft = Math.round(x * scale);
  const offsetTop  = Math.round(y * scale);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const insetLeft = clamp(offsetLeft + Math.round((boardW - boardPx) / 2), 0, Math.max(0, bgw - boardPx));
  const insetTop  = clamp(offsetTop  + Math.round((boardH - boardPx) / 2), 0, Math.max(0, bgh - boardPx));

  return {
    bgw,
    bgh,
    offsetLeft: insetLeft,
    offsetTop: insetTop,
    targetBoardPx: boardPx,
    scale,
    cellPx,
    rawBoardW: boardW,
    rawBoardH: boardH,
    capEdge: desiredBoardWidth,
    availEdge: Math.min(desiredBoardWidth, maxHeightPx ?? desiredBoardWidth)
  };
}





/** ============== time helpers (旧盤準拠) ============== */
const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return '--:--';
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

// breakdown に経過msを適用（initial→byoyomi→deferment の順）
const applyElapsedToBreakdown = (bk, elapsedMs) => {
  if (!bk) return null;
  let ini = Math.max(0, parseInt(bk.initial_ms ?? 0));
  let byo = Math.max(0, parseInt(bk.byoyomi_ms ?? 0));
  let dfr = Math.max(0, parseInt(bk.deferment_ms ?? 0));
  let e = Math.max(0, parseInt(elapsedMs ?? 0));
  if (e > 0) { const c1 = Math.min(e, ini); ini -= c1; e -= c1; }
  if (e > 0) { const c2 = Math.min(e, byo); byo -= c2; e -= c2; }
  if (e > 0) { const c3 = Math.min(e, dfr); dfr -= c3; e -= c3; }
  return { initial_ms: ini, byoyomi_ms: byo, deferment_ms: dfr };
};

/** =====================
 *  ShogiBoard
 *  ===================== */
const ShogiBoard = ({
  gameState,
  onMove,
  showCoordinates: showCoordinatesProp,
  onToggleCoordinates,
  interactionDisabled = false,
  lastMoveOverrideUsi = null,
  isSpectator = false,
  currentUser,
  sharedBoardStatus = null,
  // review/analysis用: 手番プレイヤーの駒を手動で動かせる（WS同期は親側が制御）
  allowManualEdit = false,
  timeState = null,
  className = '',
  onRequestClose,
  shellWidthMode = 'normal',
  uiDensity = 'normal',
  pendingMoveConfirm = null,
  onConfirmMoveConfirm = null,
  onCancelMoveConfirm = null,
  moveConfirmEnabled = false,
  onChangeMoveConfirmEnabled = null,
  lastMoveFromHighlightEnabled = true,
  lastMovePieceHighlightEnabled = true,
  nextMainlineMoveUsi = null,
  bestMoveUsi = null,
  reviewOverlayPlayer = null,
}) => {
  const isCompactUI = uiDensity === 'compact';
  const [internalShowCoordinates, setInternalShowCoordinates] = useState(true);
  // coordinates visibility (controlled or uncontrolled)
  const showCoordinates =
    typeof showCoordinatesProp === 'boolean' ? showCoordinatesProp : internalShowCoordinates;
  const toggleCoordinates = onToggleCoordinates || (() => setInternalShowCoordinates((v) => !v));

  // Compact UI: prefer hiding coordinate labels to free space (only in uncontrolled mode).
  useEffect(() => {
    if (typeof showCoordinatesProp === 'boolean') return;
    if (isCompactUI) setInternalShowCoordinates(false);
  }, [isCompactUI, showCoordinatesProp]);
  const [boardTheme, setBoardTheme] = useState(null);
  const [bgNatural, setBgNatural] = useState({ w: 0, h: 0 });
  const [boardFlipped, setBoardFlipped] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [selectedCapturedPiece, setSelectedCapturedPiece] = useState(null);
  const [possibleMoves, setPossibleMoves] = useState([]);
  const [lastMove, setLastMove] = useState(null);

  // 直近手の強調を、ローカルの確認中の手に差し替えられるようにする
  const overrideLastMove = useMemo(() => {
    if (!lastMoveOverrideUsi) return null;
    try {
      const p = parseUsi(lastMoveOverrideUsi);
      if (!p?.ok) return null;
      // drop は from が無いので to のみ強調する
      const fr = p.isDrop ? { row: p.toRow, col: p.toCol } : { row: p.fromRow, col: p.fromCol };
      return { fromRow: fr.row, fromCol: fr.col, toRow: p.toRow, toCol: p.toCol };
    } catch {
      return null;
    }
  }, [lastMoveOverrideUsi]);
  const effectiveLastMove = overrideLastMove || lastMove;

  const [pendingPromotion, setPendingPromotion] = useState(null);
  const CELL_BASE = 48;
  const fitRef = useRef(null);
  const promoOverlayRef = useRef(null);
  const moveConfirmOverlayRef = useRef(null);
  const wideLockRef = useRef(null);
const boardAreaRef = useRef(null);

// Pointer Events drag & drop (board piece move / captured piece drop)
const DRAG_THRESHOLD_PX = 6;
const dragRef = useRef({
  active: false,
  pointerId: null,
  kind: null, // 'board' | 'captured'
  type: null, // 'move' | 'drop'
  startX: 0,
  startY: 0,
  tapRow: null,
  tapCol: null,
  fromRow: null,
  fromCol: null,
  piece: null,
  captured: null, // { pieceType, owner }
  validSet: null,
  hoverKey: null,
  dragging: false
});

const [dragUI, setDragUI] = useState({
  dragging: false,
  type: null,
  from: null,
  captured: null,
  ghostPiece: null,
  hover: null
});

  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // desktop breakpoint
  // - iPad は常にタブレット扱い（横向きでも PC レイアウトにしない）
  // - "幅だけ" で判定すると iPad(1024px) が PC 扱いになって崩れるので、hover/pointer も見る
  const isIpad = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isiPadUA = /\biPad\b/i.test(ua);
    const isIpadOS13Plus = /\bMacintosh\b/i.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document;
    return isiPadUA || isIpadOS13Plus;
  }, []);
  const [isDesktop, setIsDesktop] = useState(() => {
    if (isIpad) return false;
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)').matches;
  });
  useEffect(() => {
    if (isIpad) {
      setIsDesktop(false);
      return;
    }
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)');
    const onChange = (e) => setIsDesktop(!!e.matches);
    setIsDesktop(!!mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, [isIpad]);

  // viewport size (visualViewport優先)。iPad縦(4:3)などで高さが足りないときは、ユーザーパネルを左右に逃がす。
  const [viewportSize, setViewportSize] = useState(() => ({ w: 0, h: 0 }));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = 0;
    const read = () => {
      const vv = window.visualViewport;
      const w = Math.round(vv?.width ?? window.innerWidth);
      const h = Math.round(vv?.height ?? window.innerHeight);
      setViewportSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('orientationchange', schedule, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', schedule, { passive: true });
      window.visualViewport.addEventListener('scroll', schedule, { passive: true });
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      try { window.removeEventListener('resize', schedule); } catch {}
      try { window.removeEventListener('orientationchange', schedule); } catch {}
      try {
        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', schedule);
          window.visualViewport.removeEventListener('scroll', schedule);
        }
      } catch {}
    };
  }, []);

  const usePortraitSides = useMemo(() => {
    if (isDesktop) return false;
    const w = viewportSize.w;
    const h = viewportSize.h;
    if (!w || !h) return false;
    if (h < w) return false; // landscape
    if (w < 700) return false; // phoneは除外
    return (h / w) <= (16 / 9 + 0.01);
  }, [isDesktop, viewportSize.w, viewportSize.h]);
  // PC/タブレット判定（スマホは除外）
  // - PC: isDesktop
  // - タブレット: iPad または 幅>=700px（phone除外と同じ閾値）
  const isTabletLike = useMemo(() => {
    if (isDesktop) return false;
    if (isIpad) return true;
    const w = viewportSize.w;
    return !!w && w >= 700;
  }, [isDesktop, isIpad, viewportSize.w]);
  const usePcTabletHeader = isDesktop || isTabletLike;

  // PC/タブレット(縦オーバーレイ以外)では、持ち駒を少し大きくして見やすくする。
  // ※ iPad縦の「左右オーバーレイ」状態では、盤の邪魔になるので従来通り圧縮。
  const useLargeCaptured = usePcTabletHeader && !usePortraitSides;


  // iPad縦など「高さが足りない」条件のときは、ヘッダーも含めてUIを圧縮できるよう
  // ルート(html)にクラスを付与してCSS側で調整する。
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('sb-portrait-sides-active', !!usePortraitSides);
    return () => {
      try { root.classList.remove('sb-portrait-sides-active'); } catch {}
    };
  }, [usePortraitSides]);

  // user_id を厳密に正規化（string / {$oid} / {oid} / {_id} など全部対応）
  const normUid = (val) => {
    try {
      const v = (val && typeof val === 'object' && 'user_id' in val) ? val.user_id : val;
      if (v && typeof v === 'object') {
        const cand = v.$oid ?? v.oid ?? v.id ?? v.$id ?? v._id ?? null;
        return String(cand ?? JSON.stringify(v));
      }
      return String(v ?? '');
    } catch {
      return String(val ?? '');
    }
  };


  // === theme load / hot swap (while playing) ===
  // App は設定保存時に window.dispatchEvent(new Event('shogi_theme_changed')) を投げる。
  // 対局中でもテーマ変更を反映できるよう、ここで購読して再読み込みする。
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let cancelled = false;
    let reqId = 0;

    const load = () => {
      const id = ++reqId;
      loadBoardTheme()
        .then((t) => {
          if (cancelled) return;
          if (id !== reqId) return;
          const norm = normalizeTheme(t);
          setBoardTheme(norm);
        })
        .catch((e) => {
          console.error('loadBoardTheme failed', e);
          if (!cancelled && id === reqId) setBoardTheme(null);
        });
    };

    const onThemeChanged = () => {
      load();
    };

    // initial
    load();
    window.addEventListener('shogi_theme_changed', onThemeChanged);
    return () => {
      cancelled = true;
      try { window.removeEventListener('shogi_theme_changed', onThemeChanged); } catch {}
    };
  }, []);

  // === strict validate ===
  useEffect(() => {
    if (!boardTheme) return;
    const errs = validateBoardThemeStrict(boardTheme);
    if (errs.length) throw new Error('[BoardConfigError] ' + errs.join('; '));
  }, [boardTheme]);

  // === background natural size ===

  // === responsive container observer (width + height) ===
  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;

    const measure = () => {
      try {
        const rect = el.getBoundingClientRect();
        let w = Math.max(0, Math.round(rect.width || el.clientWidth || 0));
        let h = Math.max(0, Math.round(rect.height || el.clientHeight || 0));

        // Some layouts momentarily report 0 for one dimension (e.g., when the parent is
        // still settling or when an absolutely positioned child is the only content).
        // Try the parent box as a fallback, but never "downgrade" a previously non-zero
        // measurement to 0 (that causes the board to jump or oversize).
        if ((w === 0 || h === 0) && el.parentElement) {
          const p = el.parentElement;
          const pr = p.getBoundingClientRect();
          w = Math.max(w, Math.round(pr.width || p.clientWidth || 0));
          h = Math.max(h, Math.round(pr.height || p.clientHeight || 0));
        }

        setContainerSize((prev) => {
          const pw = prev?.w || 0;
          const ph = prev?.h || 0;
          // don't accept transient zeros once we have a stable size
          if ((w === 0 && pw > 0) || (h === 0 && ph > 0)) return prev;

          const dw = Math.abs(pw - w);
          const dh = Math.abs(ph - h);
          if (pw === 0 || ph === 0) return { w, h };
          if (dw < 2 && dh < 2) return prev;
          return { w, h };
        });
      } catch {
        /* noop */
      }
    };

    measure();

    // layout確定後に0幅/0高が取れることがあるので、1フレーム遅延でも測る
    try { requestAnimationFrame(measure); } catch { /* noop */ }

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => measure());
      ro.observe(el);
      return () => ro.disconnect();
    }

    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    const src = boardTheme?.background;
    if (!src) {
      setBgNatural({ w: 0, h: 0 });
      return;
    }
    const img = new Image();
    img.onload = () => setBgNatural({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
    img.onerror = () => setBgNatural({ w: -1, h: -1 });
    img.src = src;
  }, [boardTheme?.background]);

  // === flip board if I'm gote ===
  useEffect(() => {
    if (!isSpectator && currentUser && gameState?.players) {
      const my = currentUser?.user_id;
      const gote = gameState.players?.gote?.user_id;
      setBoardFlipped(my != null && gote != null && String(my) === String(gote));
    }
  }, [isSpectator, currentUser, gameState?.players]);

  // === last move ===
  useEffect(() => {
    try {
      const hist = Array.isArray(gameState?.move_history)
        ? gameState.move_history
        : Array.isArray(gameState?.moveHistory)
        ? gameState.moveHistory
        : [];
      if (hist && hist.length > 0) {
        const m = hist[hist.length - 1] || {};
        const usi = (typeof m?.usi === 'string' ? m.usi : (typeof m?.obj?.usi === 'string' ? m.obj.usi : null));
        if (usi) {
          const p = parseUsi(usi);
          if (p?.ok) {
            const fr = p.isDrop ? { row: p.toRow, col: p.toCol } : { row: p.fromRow, col: p.fromCol };
            const to = { row: p.toRow, col: p.toCol };
            setLastMove({ fromRow: fr.row, fromCol: fr.col, toRow: to.row, toCol: to.col });
            return;
          }
        }

        // fallback: legacy numeric coordinates
        const fromRow = m.from_row ?? m.fromRow ?? m.from?.row;
        const fromCol = m.from_col ?? m.fromCol ?? m.from?.col;
        const toRow = m.to_row ?? m.toRow ?? m.to?.row;
        const toCol = m.to_col ?? m.toCol ?? m.to?.col;
        const ok = [fromRow, fromCol, toRow, toCol].every((v) => Number.isInteger(v));
        if (ok) setLastMove({ fromRow, fromCol, toRow, toCol });
      }
    } catch {}
  }, [gameState?.move_history?.length, gameState?.moveHistory?.length]);

  const { board = [], capturedPieces = {}, currentPlayer } = gameState || {};
  
  // 自分の役割（先手/後手）を決定
  const myRole = (() => {
    try {
      const me = currentUser?.user_id != null ? String(currentUser.user_id) : null;
      const s  = gameState?.players?.sente?.user_id != null ? String(gameState.players.sente.user_id) : null;
      const g  = gameState?.players?.gote?.user_id  != null ? String(gameState.players.gote.user_id)  : null;
      if (me && s && me === s) return 'sente';
      if (me && g && me === g) return 'gote';
    } catch {}
    return null;
  })();

  
  const isMyTurn = !isSpectator && !!myRole && (currentPlayer === myRole);

  // review/analysisでは「手番側の駒」を動かせる（自分の手番かどうかは問わない）
  // 観戦者は常に操作不可。
  const canOperate = !interactionDisabled && !isSpectator && (isMyTurn || allowManualEdit);


  const clearSelection = useCallback(() => {
    setPendingPromotion(null);
    setSelectedSquare(null);
    setSelectedCapturedPiece(null);
    setPossibleMoves([]);
  }, []);

  // 着手確認中は操作できないようにし、選択状態もクリアする
  useEffect(() => {
    if (!interactionDisabled) return;
    try { clearSelection(); } catch {}
  }, [interactionDisabled, clearSelection]);

  // promotion-choice overlay: cancel on outside click / Escape / losing turn
  useEffect(() => {
    if (!pendingPromotion) return;
    const onPointerDown = (e) => {
      const el = promoOverlayRef.current;
      if (el && el.contains(e.target)) return;
      setPendingPromotion(null);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setPendingPromotion(null);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [pendingPromotion]);

  // move-confirm overlay: cancel on outside click / Escape
  useEffect(() => {
    if (!pendingMoveConfirm) return;
    const onPointerDown = (e) => {
      const el = moveConfirmOverlayRef.current;
      if (el && el.contains(e.target)) return;
      try { onCancelMoveConfirm && onCancelMoveConfirm(); } catch {}
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        try { onCancelMoveConfirm && onCancelMoveConfirm(); } catch {}
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [pendingMoveConfirm, onCancelMoveConfirm]);

  useEffect(() => {
    if (pendingPromotion && !canOperate) setPendingPromotion(null);
  }, [pendingPromotion, canOperate]);

  // rows/cols helper
  const getBoardRows = useCallback(() => {
    const arr = [];
    for (let i = 0; i < 9; i++) arr.push(boardFlipped ? 8 - i : i);
    return arr;
  }, [boardFlipped]);
  const getBoardCols = useCallback(() => {
    const arr = [];
    for (let i = 0; i < 9; i++) arr.push(boardFlipped ? 8 - i : i);
    return arr;
  }, [boardFlipped]);

  // === geometry ===
  // board_region は「駒を置く盤面(9x9)が背景画像のどこにあるか」を示す。
  // 背景画像そのものは全体を表示し、その上に board_region に合わせて盤面をオーバーレイする。
  const geom = useMemo(() => {
    if (!boardTheme?.background) return null;
    if (!(bgNatural.w > 0 && bgNatural.h > 0)) return null;

    const coords = boardTheme?.coordinates || {};
    const showVLeftLocal  = ((coords?.outside?.left ?? true) !== false) && !!showCoordinates;
    const showVRightLocal = (!!(coords?.outside?.right)) && !!showCoordinates;

    const labelThickLocal = showCoordinates ? 26 : 0;
    const left  = showVLeftLocal  ? labelThickLocal : 0;
    const right = showVRightLocal ? labelThickLocal : 0;
    const top   = labelThickLocal;

    const cw = containerSize.w || 0;
    const ch = containerSize.h || 0;
    const usableW = Math.max(0, cw - left - right);
    const usableH = Math.max(0, ch - top);

    const usage = shellWidthMode === 'wide' ? 1.0 : (isDesktop ? 0.96 : 1.0);
    const edgeRaw = (usableW > 0 && usableH > 0) ? Math.min(usableW, usableH) : 0;
    const edgeCap = Math.max(0, Math.floor(edgeRaw * usage));
    if (!(edgeCap > 0)) return null;

    const br = boardTheme.board_region || boardTheme.boardRegion;
    if (!br) return null;

    let x, y, w, h;
    if (br.start && br.end) {
      x = Number(br.start.x); y = Number(br.start.y);
      w = Number(br.end.x) - Number(br.start.x);
      h = Number(br.end.y) - Number(br.start.y);
    } else if (typeof br.x1 !== 'undefined' && typeof br.x2 !== 'undefined') {
      x = Number(br.x1); y = Number(br.y1);
      w = Number(br.x2) - Number(br.x1);
      h = Number(br.y2) - Number(br.y1);
    } else {
      x = Number(br.x); y = Number(br.y);
      w = Number(br.width); h = Number(br.height);
    }
    if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
    if (!(w > 0 && h > 0)) return null;

    // 盤面は必ず正方形扱い（テーマが僅かに矩形でも、中央の正方形を採用）
    const s = Math.min(w, h);
    const sx = x + (w - s) / 2;
    const sy = y + (h - s) / 2;

    // 背景画像“全体”が edgeCap に収まる最大スケール
    const scaleMax = Math.min(edgeCap / bgNatural.w, edgeCap / bgNatural.h);
    if (!(scaleMax > 0)) return null;

    // 盤面(9x9)サイズを 9 の倍数に丸めて、駒サイズを整数に保つ
    const boardPxMax = s * scaleMax;
    let boardPx = Math.floor(boardPxMax / 9) * 9;
    if (boardPxMax > 0 && boardPx < 9) boardPx = 9;
    if (!(boardPx > 0)) return null;
    const cellPx = boardPx / 9;

    const scale = boardPx / s;
    const r3 = (n) => Math.round(n * 1000) / 1000;

    const bgW = r3(bgNatural.w * scale);
    const bgH = r3(bgNatural.h * scale);
    const boardLeft = r3(sx * scale);
    const boardTop  = r3(sy * scale);

    // safety
    if (boardLeft < 0 || boardTop < 0) return null;
    if (boardLeft + boardPx > bgW + 0.5) return null;
    if (boardTop + boardPx > bgH + 0.5) return null;

    return {
      bgW,
      bgH,
      boardPx,
      cellPx,
      boardLeft,
      boardTop,
      labels: { left, right, top, thick: labelThickLocal, showVLeft: showVLeftLocal, showVRight: showVRightLocal },
      usableW,
      usableH
    };
  }, [boardTheme, bgNatural.w, bgNatural.h, containerSize.w, containerSize.h, showCoordinates, shellWidthMode, isDesktop]);


  // derive sizes from geometry to keep pieces in sync
  const cellSize  = geom?.cellPx ?? 0;
  const boardSize = geom?.boardPx ?? 0;
  const bgW = geom?.bgW ?? 0;
  const bgH = geom?.bgH ?? 0;
  const boardInsetLeft = geom?.boardLeft ?? 0;
  const boardInsetTop  = geom?.boardTop ?? 0;
  const piecePad = Math.max(0, Math.floor((cellSize || 0) * 0.06));


  // tablet portrait-sides: shrink user panels to about half of the board frame height
  const tabletUserPanelH = useMemo(() => {
    if (!usePortraitSides) return null;
    const base = (geom?.bgH || geom?.boardPx || containerSize.w || 0);
    if (!Number.isFinite(base) || base <= 0) return null;
    // keep some minimum so header + captured list remains usable
    const minH = isCompactUI ? 96 : 120;
    return Math.max(minH, Math.floor(base * 0.5));
  }, [usePortraitSides, geom?.bgH, geom?.boardPx, containerSize.w, isCompactUI]);



  // === move click ===
  const handleSquareClick = useCallback(
    (row, col) => {
      if (!canOperate) return;
      if (pendingPromotion) {
        setPendingPromotion(null);
        return;
      }
      const piece = board?.[row]?.[col];

      // drop mode
      if (selectedCapturedPiece) {
        const dropMoves = getDropMoves(board, selectedCapturedPiece.piece, currentPlayer);
        const valid = dropMoves.find((m) => m.row === row && m.col === col);
        if (valid) {
          const result = makeDrop(gameState, row, col, selectedCapturedPiece.piece);
          if (result.success) {
            const usi = buildUsiDrop({ pieceType: selectedCapturedPiece.piece, toRow: row, toCol: col });
            onMove({ usi });
            clearSelection();
          }
        } else {
          clearSelection();
        }
        return;
      }

      // move mode
      if (selectedSquare) {
        const { row: fr, col: fc } = selectedSquare;
        const selectedPiece = board?.[fr]?.[fc];
        if (fr === row && fc === col) {
          clearSelection();
          return;
        }
        const valid = possibleMoves.find((m) => m.row === row && m.col === col);
        if (valid) {
          if (canPromote(selectedPiece, fr, row) && !mustPromote(selectedPiece, row)) {
            setPendingPromotion({
              fromRow: fr,
              fromCol: fc,
              toRow: row,
              toCol: col,
              piece: selectedPiece
            });
          } else {
            const promote = mustPromote(selectedPiece, row);
            const result = makeMove(gameState, fr, fc, row, col, promote);
            if (result.success) {
              const usi = buildUsiMove({ fromRow: fr, fromCol: fc, toRow: row, toCol: col, promote: !!promote });
              onMove({ usi });
              clearSelection();
            }
          }
        } else {
          if (piece && piece.owner === currentPlayer) {
            setSelectedSquare({ row, col });
            setSelectedCapturedPiece(null);
            setPossibleMoves(getPossibleMoves(board, row, col, piece));
          } else {
            clearSelection();
          }
        }
        return;
      }

      // select piece
      if (piece && piece.owner === currentPlayer) {
        setSelectedSquare({ row, col });
        setSelectedCapturedPiece(null);
        setPossibleMoves(getPossibleMoves(board, row, col, piece));
      }
    },
    [canOperate, pendingPromotion, board, selectedCapturedPiece, selectedSquare, possibleMoves, currentPlayer, gameState, onMove, clearSelection]
  );

  const handleCapturedPieceClick = useCallback(
    (pieceType, owner) => {
      if (!canOperate || owner !== currentPlayer) return;
      if (pendingPromotion) setPendingPromotion(null);
      if (selectedCapturedPiece?.piece === pieceType) {
        clearSelection();
        return;
      }
      setSelectedSquare(null);
      setSelectedCapturedPiece({ piece: pieceType, owner });
      const dropMoves = getDropMoves(board, pieceType, currentPlayer);
      setPossibleMoves(dropMoves);
    },
    [canOperate, pendingPromotion, currentPlayer, selectedCapturedPiece, board, clearSelection]
  );


// === Pointer Events drag & drop ===
const pointToSquare = useCallback((clientX, clientY) => {
  const el = boardAreaRef.current;
  if (!el) return null;

  const rect = el.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;

  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;

  const vCol = Math.max(0, Math.min(8, Math.floor((x / rect.width) * 9)));
  const vRow = Math.max(0, Math.min(8, Math.floor((y / rect.height) * 9)));
  const row = boardFlipped ? 8 - vRow : vRow;
  const col = boardFlipped ? 8 - vCol : vCol;
  return { row, col };
}, [boardFlipped]);

const resetDrag = useCallback(() => {
  dragRef.current = {
    active: false,
    pointerId: null,
    kind: null,
    type: null,
    startX: 0,
    startY: 0,
    tapRow: null,
    tapCol: null,
    fromRow: null,
    fromCol: null,
    piece: null,
    captured: null,
    validSet: null,
    hoverKey: null,
    dragging: false
  };
  setDragUI({
    dragging: false,
    type: null,
    from: null,
    captured: null,
    ghostPiece: null,
    hover: null
  });
}, []);

const handleAnyPointerMove = useCallback((e) => {
  const d = dragRef.current;
  if (!d?.active) return;
  if (d.pointerId !== e.pointerId) return;

  // Activate drag once the pointer moved enough
  if (!d.dragging) {
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

    // Not a draggable source => keep as tap
    if (!d.type) return;

    d.dragging = true;
    d.hoverKey = null;

    try { clearSelection(); } catch {}

    const ghostPiece =
      d.type === 'move'
        ? d.piece
        : (d.captured?.pieceType ? { piece: d.captured.pieceType, owner: currentPlayer } : null);

    setDragUI({
      dragging: true,
      type: d.type,
      from: d.type === 'move' ? { row: d.fromRow, col: d.fromCol } : null,
      captured: d.type === 'drop' ? d.captured : null,
      ghostPiece,
      hover: null
    });
  }

  if (!d.dragging) return;

  const sq = pointToSquare(e.clientX, e.clientY);
  let hover = null;
  if (sq) {
    const key = `${sq.row},${sq.col}`;
    const sameFrom = d.type === 'move' && sq.row === d.fromRow && sq.col === d.fromCol;
    if (!sameFrom && d.validSet && d.validSet.has(key)) hover = sq;
  }
  const nextKey = hover ? `${hover.row},${hover.col}` : null;

  if (d.hoverKey !== nextKey) {
    d.hoverKey = nextKey;
    setDragUI((prev) => (prev.dragging ? { ...prev, hover } : prev));
  }
}, [pointToSquare, clearSelection, currentPlayer]);

const finishDragOrTap = useCallback((e, opts = {}) => {
  const cancelOnly = !!opts.cancelOnly;

  const d = dragRef.current;
  if (!d?.active) return;
  if (d.pointerId !== e.pointerId) return;

  try { e.currentTarget?.releasePointerCapture?.(e.pointerId); } catch {}

  // Reset UI first (avoid leaving ghost)
  setDragUI({
    dragging: false,
    type: null,
    from: null,
    captured: null,
    ghostPiece: null,
    hover: null
  });

  // Keep a copy for logic then clear ref
  const wasDragging = !!d.dragging;
  const dragType = d.type;
  const tapRow = d.tapRow;
  const tapCol = d.tapCol;
  const fromRow = d.fromRow;
  const fromCol = d.fromCol;
  const piece = d.piece;
  const captured = d.captured;
  const validSet = d.validSet;

  dragRef.current.active = false;

  if (cancelOnly) return;

  // Tap behavior (no drag)
  if (!wasDragging || !dragType) {
    if (d.kind === 'board' && Number.isInteger(tapRow) && Number.isInteger(tapCol)) {
      handleSquareClick(tapRow, tapCol);
    } else if (d.kind === 'captured' && captured?.pieceType) {
      handleCapturedPieceClick(captured.pieceType, captured.owner);
    }
    return;
  }

  const to = pointToSquare(e.clientX, e.clientY);
  if (!to) return;

  const key = `${to.row},${to.col}`;
  const sameFrom = dragType === 'move' && to.row === fromRow && to.col === fromCol;
  const valid = !sameFrom && validSet && validSet.has(key);
  if (!valid) return;

  if (dragType === 'drop') {
    const pieceType = captured?.pieceType;
    if (!pieceType) return;
    const result = makeDrop(gameState, to.row, to.col, pieceType);
    if (result?.success) {
      const usi = buildUsiDrop({ pieceType, toRow: to.row, toCol: to.col });
      try { onMove && onMove({ usi }); } catch {}
      try { clearSelection(); } catch {}
    }
    return;
  }

  // move
  if (!piece) return;
  if (!(Number.isInteger(fromRow) && Number.isInteger(fromCol))) return;

  // Optional promotion: show picker and do not clear selection (picker owns it)
  if (canPromote(piece, fromRow, to.row) && !mustPromote(piece, to.row)) {
    setPendingPromotion({ fromRow, fromCol, toRow: to.row, toCol: to.col, piece });
    return;
  }

  const promote = mustPromote(piece, to.row);
  const result = makeMove(gameState, fromRow, fromCol, to.row, to.col, promote);
  if (result?.success) {
    const usi = buildUsiMove({ fromRow, fromCol, toRow: to.row, toCol: to.col, promote: !!promote });
    try { onMove && onMove({ usi }); } catch {}
    try { clearSelection(); } catch {}
  }
}, [pointToSquare, handleSquareClick, handleCapturedPieceClick, gameState, onMove, clearSelection]);

const handleAnyPointerUp = useCallback((e) => {
  finishDragOrTap(e);
  resetDrag();
}, [finishDragOrTap, resetDrag]);

const handleAnyPointerCancel = useCallback((e) => {
  finishDragOrTap(e, { cancelOnly: true });
  resetDrag();
}, [finishDragOrTap, resetDrag]);

const handleBoardPointerDown = useCallback((e, row, col) => {
  if (!canOperate) return;
  if (pendingMoveConfirm) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  const piece = board?.[row]?.[col] || null;

  // When a captured piece is selected (drop mode), keep board interactions as tap only.
  const canDragMove =
    !pendingPromotion &&
    !selectedCapturedPiece &&
    piece &&
    piece.owner === currentPlayer;

  const validMoves = canDragMove ? getPossibleMoves(board, row, col, piece) : [];
  const validSet = canDragMove ? new Set(validMoves.map((m) => `${m.row},${m.col}`)) : null;

  dragRef.current = {
    active: true,
    pointerId: e.pointerId,
    kind: 'board',
    type: canDragMove ? 'move' : null,
    startX: e.clientX,
    startY: e.clientY,
    tapRow: row,
    tapCol: col,
    fromRow: canDragMove ? row : null,
    fromCol: canDragMove ? col : null,
    piece: canDragMove ? piece : null,
    captured: null,
    validSet,
    hoverKey: null,
    dragging: false
  };

  try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {}
  try { e.preventDefault(); } catch {}
  try { e.stopPropagation(); } catch {}
}, [canOperate, pendingMoveConfirm, pendingPromotion, selectedCapturedPiece, board, currentPlayer]);

const handleCapturedPointerDown = useCallback((e, pieceType, owner) => {
  if (!canOperate) return;
  if (pendingMoveConfirm) return;
  if (pendingPromotion) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  // Only the current player's hand is draggable/droppable
  if (owner !== currentPlayer) return;

  const moves = getDropMoves(board, pieceType, currentPlayer) || [];
  const validSet = new Set(moves.map((m) => `${m.row},${m.col}`));

  dragRef.current = {
    active: true,
    pointerId: e.pointerId,
    kind: 'captured',
    type: 'drop',
    startX: e.clientX,
    startY: e.clientY,
    tapRow: null,
    tapCol: null,
    fromRow: null,
    fromCol: null,
    piece: null,
    captured: { pieceType, owner },
    validSet,
    hoverKey: null,
    dragging: false
  };

  try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {}
  try { e.preventDefault(); } catch {}
  try { e.stopPropagation(); } catch {}
}, [canOperate, pendingMoveConfirm, pendingPromotion, board, currentPlayer]);

  const cancelPromotionChoice = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  const commitPromotionChoice = useCallback(
    (promote) => {
      if (interactionDisabled) return;
      const p = pendingPromotion;
      if (!p) return;
      const result = makeMove(gameState, p.fromRow, p.fromCol, p.toRow, p.toCol, !!promote);
      if (result && result.success) {
        const usi = buildUsiMove({
          fromRow: p.fromRow,
          fromCol: p.fromCol,
          toRow: p.toRow,
          toCol: p.toCol,
          promote: !!promote
        });
        onMove({ usi });
        clearSelection();
      } else {
        setPendingPromotion(null);
      }
    },
    [interactionDisabled, pendingPromotion, gameState, onMove, clearSelection]
  );

  // 強調オーバーレイ（選択 / 候補 / 直近）
  const renderSquareOverlay = (row, col) => {
    const isSelected = selectedSquare && selectedSquare.row === row && selectedSquare.col === col;
    const isPossibleMove = possibleMoves.some((move) => move.row === row && move.col === col);
    const isDropLastMove =
  !!effectiveLastMove &&
  effectiveLastMove.fromRow === effectiveLastMove.toRow &&
  effectiveLastMove.fromCol === effectiveLastMove.toCol;

const isLastMoveFrom =
  !!effectiveLastMove &&
  !isDropLastMove &&
  (effectiveLastMove.fromRow === row && effectiveLastMove.fromCol === col);

const isLastMoveTo =
  !!effectiveLastMove &&
  (effectiveLastMove.toRow === row && effectiveLastMove.toCol === col);

    // 「動かせる位置」は、四角い塗りつぶしではなく点滅する丸で表示する
    // （駒が置かれているマスでも見えるように z-index を高めに）
    const layers = [];
    if (lastMovePieceHighlightEnabled && isLastMoveTo) {
  // 移動先は「うっすら背景」＋ 駒側の輪郭/波紋（駒描画側で付与）
  layers.push(<div key="lastto" className="shogi-last-move-to-bg" />);
}
if (lastMoveFromHighlightEnabled && isLastMoveFrom) {
  // 移動元は「赤い点滅丸」で表示（緑の候補表示の赤版）
  layers.push(<div key="lastfrom" className="shogi-last-move-indicator" />);
}
    if (isSelected) {
      layers.push(
        <div
          key="selected"
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: 'rgba(59,130,246,0.35)', zIndex: 3 }}
        />
      );
    }
    if (isPossibleMove) {
      layers.push(<div key="possible" className="shogi-possible-move-indicator" />);
    }
    if (!layers.length) return null;
    return <>{layers}</>;
  };


  // 感想戦オーバーレイ: USI から線分（from/to）を作る
  const buildOverlayLineFromUsi = (usi) => {
    if (!usi) return null;
    if (!(cellSize > 0) || !(boardSize > 0)) return null;

    let p = null;
    try { p = parseUsi(usi); } catch { p = null; }
    if (!p?.ok) return null;

    const toVisual = (r, c) => {
      const vr = boardFlipped ? (8 - r) : r;
      const vc = boardFlipped ? (8 - c) : c;
      return { vr, vc };
    };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

    const to = toVisual(p.toRow, p.toCol);
    const toX0 = (to.vc + 0.5) * cellSize;
    const toY0 = (to.vr + 0.5) * cellSize;

    // オーバーレイの手番（感想戦は親から渡される reviewOverlayPlayer を優先）
    const turn = (reviewOverlayPlayer != null) ? reviewOverlayPlayer : currentPlayer;
    const cur = (turn === PLAYERS.SENTE || turn === 'sente') ? 'sente'
      : (turn === PLAYERS.GOTE || turn === 'gote') ? 'gote'
      : String(turn || '');
    const isGoteTurn = cur === 'gote';
    // 盤面の駒表示と同じ基準で、相手側の駒は 180° 回転させる
    const dropPieceRotated = (boardFlipped ? !isGoteTurn : isGoteTurn);

    let fromX0 = null;
    let fromY0 = null;
    let isDrop = !!p.isDrop;
    const dropPieceType = isDrop ? (p.pieceType || null) : null;
    const dropPieceChar = isDrop ? t(PIECE_NAMES?.[dropPieceType] || '') : '';

    if (!isDrop && Number.isInteger(p.fromRow) && Number.isInteger(p.fromCol)) {
      const fr = toVisual(p.fromRow, p.fromCol);
      fromX0 = (fr.vc + 0.5) * cellSize;
      fromY0 = (fr.vr + 0.5) * cellSize;
    } else {
      // 打ち（fromが無い）: 手番側の「手元方向」から短い線を引く（盤外に出さずに表現）
      const curAtBottom = (!boardFlipped && cur === 'sente') || (boardFlipped && cur === 'gote');
      const dir = curAtBottom ? 1 : -1;

      fromX0 = toX0;
      // 打ちは「盤外から来る」イメージだが、盤内で表現すると 1マス移動に見えやすい。
      // そのため線は短くし、駒種は別途マーカーで表示する。
      fromY0 = clamp(toY0 + dir * cellSize * 0.55, cellSize * 0.5, boardSize - cellSize * 0.5);
      isDrop = true;
    }

    const dx = toX0 - fromX0;
    const dy = toY0 - fromY0;
    const dist = Math.hypot(dx, dy);
    if (!(dist > 1)) return null;

    const ux = dx / dist;
    const uy = dy / dist;

    // 端点を少し内側へ（線が駒の中心を潰しにくくする）
    const trim = Math.max(2, Math.min(cellSize * 0.18, dist * 0.25));
    const fromX = fromX0 + ux * trim;
    const fromY = fromY0 + uy * trim;
    const toX = toX0 - ux * trim * 0.55;
    const toY = toY0 - uy * trim * 0.55;

    return { fromX, fromY, toX, toY, isDrop, toX0, toY0, dropPieceType, dropPieceChar, dropPieceRotated };
  };

  // 感想戦: 最善手（USI）を緑線でプレビュー（解析がある場合）
  const renderBestMoveLineOverlay = () => {
    const line = buildOverlayLineFromUsi(bestMoveUsi);
    if (!line) return null;

    const strokeW = Math.max(2, Math.min(6, cellSize * 0.085));

    // 駒打ちは「どの駒を打つか」が重要なので、線だけでなく駒種マーカーを表示する。
    if (line.isDrop) {
      const r = Math.max(10, Math.min(18, cellSize * 0.28));
      const fs = Math.max(11, Math.min(18, cellSize * 0.34));
const sw = Math.max(1.5, Math.min(3.5, cellSize * 0.06));
      const textSw = Math.max(1.2, Math.min(2.6, cellSize * 0.055));
return (
        <svg
          className="shogi-bestmove-line is-drop"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 6,
            pointerEvents: 'none',
            overflow: 'visible',
            color: 'rgba(34, 197, 94, 0.95)'
          }}
          width={boardSize}
          height={boardSize}
          viewBox={`0 0 ${boardSize} ${boardSize}`}
          aria-hidden="true"
        >
          <circle
            cx={line.toX0}
            cy={line.toY0}
            r={r}
            fill="currentColor"
            fillOpacity="0.92"
            stroke="white"
            strokeOpacity="0.9"
            strokeWidth={sw}
          />
          <text
            x={line.toX0}
            y={line.toY0}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={fs}
            fontWeight={900}
            fill="white"
            stroke="rgba(0,0,0,0.78)"
            strokeWidth={textSw}
            paintOrder="stroke"
            strokeLinejoin="round"
            transform={line.dropPieceRotated ? `rotate(180 ${line.toX0} ${line.toY0})` : undefined}
          >
            {line.dropPieceChar || t('ui.components.game.shogiboard.k675b9983')}
          </text>
        </svg>
      );
    }

    return (
      <svg
        className={`shogi-bestmove-line ${line.isDrop ? 'is-drop' : ''}`}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 6,
          pointerEvents: 'none',
          overflow: 'visible',
          color: 'rgba(34, 197, 94, 0.95)'
        }}
        width={boardSize}
        height={boardSize}
        viewBox={`0 0 ${boardSize} ${boardSize}`}
        aria-hidden="true"
      >
        <path
          d={`M ${line.fromX.toFixed(2)} ${line.fromY.toFixed(2)} L ${line.toX.toFixed(2)} ${line.toY.toFixed(2)}`}
          stroke="currentColor"
          strokeWidth={strokeW}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  };

  // 感想戦: 次の本譜手（USI）をオレンジ線でプレビュー
  const renderNextMainlineArrowOverlay = () => {
    const line = buildOverlayLineFromUsi(nextMainlineMoveUsi);
    if (!line) return null;

    // 最善手（緑線）と揃えて「線」で統一（矢印ヘッド無し）
    const strokeW = Math.max(2, Math.min(6, cellSize * 0.085));

    if (line.isDrop) {
      const r = Math.max(10, Math.min(18, cellSize * 0.28));
      const fs = Math.max(11, Math.min(18, cellSize * 0.34));
const sw = Math.max(1.5, Math.min(3.5, cellSize * 0.06));
      const textSw = Math.max(1.2, Math.min(2.6, cellSize * 0.055));
return (
        <svg
          className="shogi-next-mainline-arrow is-drop"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 7,
            pointerEvents: 'none',
            overflow: 'visible',
            color: 'rgba(245, 158, 11, 0.95)'
          }}
          width={boardSize}
          height={boardSize}
          viewBox={`0 0 ${boardSize} ${boardSize}`}
          aria-hidden="true"
        >
          <circle
            cx={line.toX0}
            cy={line.toY0}
            r={r}
            fill="currentColor"
            fillOpacity="0.92"
            stroke="white"
            strokeOpacity="0.9"
            strokeWidth={sw}
          />
          <text
            x={line.toX0}
            y={line.toY0}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={fs}
            fontWeight={900}
            fill="white"
            stroke="rgba(0,0,0,0.78)"
            strokeWidth={textSw}
            paintOrder="stroke"
            strokeLinejoin="round"
            transform={line.dropPieceRotated ? `rotate(180 ${line.toX0} ${line.toY0})` : undefined}
          >
            {line.dropPieceChar || t('ui.components.game.shogiboard.k675b9983')}
          </text>
        </svg>
      );
    }

    return (
      <svg
        className={`shogi-next-mainline-arrow ${line.isDrop ? 'is-drop' : ''}`}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 7,
          pointerEvents: 'none',
          overflow: 'visible',
          color: 'rgba(245, 158, 11, 0.95)'
        }}
        width={boardSize}
        height={boardSize}
        viewBox={`0 0 ${boardSize} ${boardSize}`}
        aria-hidden="true"
      >
        <path
          d={`M ${line.fromX.toFixed(2)} ${line.fromY.toFixed(2)} L ${line.toX.toFixed(2)} ${line.toY.toFixed(2)}`}
          stroke="currentColor"
          strokeWidth={strokeW}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  };


  const renderPiece = (piece, opts = null) => {
    if (!piece) return null;
    const isGote = piece.owner === PLAYERS.GOTE || piece.owner === 'gote';
    const rotation = (boardFlipped ? !isGote : isGote) ? 'rotate-180' : '';
    const rawKey = (piece.piece || piece.type || '').toString();
    const norm = rawKey.toLowerCase();
    const pmap = boardTheme?.pieces || {};
    let url = null;
    if (pmap && (pmap.sente || pmap.gote)) {
      url = isGote ? pmap.gote?.[norm] ?? pmap.sente?.[norm] ?? null : pmap.sente?.[norm] ?? pmap.gote?.[norm] ?? null;
    } else if (pmap) {
      url = pmap[norm] || null;
    }
    if (url) {
  const effect = opts && typeof opts === 'object' ? (opts.effect || null) : null;

  if (effect === 'lastmove-to') {
    // PNGの透明（アルファ）を無視して輪郭を出すため、drop-shadow を利用する
    return (
      <span
        className={`${rotation} pointer-events-none relative w-full h-full`}
        style={{ display: 'block' }}
      >
        <img
          src={url}
          alt={norm}
          className="absolute inset-0 w-full h-full object-contain shogi-piece-lastmove-to-ripple"
          draggable={false}
        />
        <img
          src={url}
          alt={norm}
          className="absolute inset-0 w-full h-full object-contain shogi-piece-lastmove-to-outline"
          draggable={false}
        />
      </span>
    );
  }

  return (
    <img
      src={url}
      alt={norm}
      style={{ width: '100%', height: 'auto', maxHeight: '100%', objectFit: 'contain' }}
      className={`${rotation} pointer-events-none`}
      draggable={false}
    />
  );
}
    return (
      <span className={`${rotation} ${isGote ? 'text-red-600' : 'text-blue-600'}`}>
        {t(PIECE_NAMES[piece.piece] || PIECE_NAMES[piece.type] || '')}
      </span>
    );
  };


  const renderMoveConfirmOverlay = () => {
    if (!pendingMoveConfirm || !pendingMoveConfirm.usi) return null;
    if (!(cellSize > 0) || !(boardSize > 0)) return null;

    let toRow = pendingMoveConfirm.toRow;
    let toCol = pendingMoveConfirm.toCol;
    try {
      if (!(Number.isInteger(toRow) && Number.isInteger(toCol))) {
        const pu = parseUsi(pendingMoveConfirm.usi);
        if (pu && pu.ok) {
          toRow = pu.toRow;
          toCol = pu.toCol;
        }
      }
    } catch {}
    if (!(Number.isInteger(toRow) && Number.isInteger(toCol))) return null;

    // anchor on destination square (where the piece will land)
    const dRow = boardFlipped ? 8 - toRow : toRow;
    const dCol = boardFlipped ? 8 - toCol : toCol;
    const sqLeft = dCol * cellSize;
    const sqTop = dRow * cellSize;

    const gap = Math.max(6, Math.floor(cellSize * 0.12));
    const panelW = Math.max(160, Math.floor(cellSize * 3.0));
    const panelH = Math.max(36, Math.floor(cellSize * 0.85));

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    let left = sqLeft + (cellSize - panelW) / 2;
    left = clamp(left, 0, Math.max(0, boardSize - panelW));

    const aboveTop = sqTop - panelH - gap;
    const belowTop = sqTop + cellSize + gap;
    let top = aboveTop;
    if (top < 0 && belowTop + panelH <= boardSize) top = belowTop;
    top = clamp(top, 0, Math.max(0, boardSize - panelH));

    const label = (pendingMoveConfirm.kifText || '').toString();

    return (
      <div
        ref={moveConfirmOverlayRef}
        className="absolute rounded-lg border border-black/20 shadow-md"
        style={{
          left,
          top,
          width: panelW,
          height: panelH,
          zIndex: 41,
          backgroundColor: 'rgba(255,255,255,0.98)'
        }}
        onPointerDown={(e) => {
          // panel itself should not trigger board interactions
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="w-full h-full flex items-center gap-2 px-2">
          <div className="flex-1 min-w-0 text-xs font-semibold text-slate-800 truncate">{label}</div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              className="px-2 py-1 text-xs rounded-md border border-black/20 bg-white hover:bg-black/5 active:bg-black/10"
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                try { onCancelMoveConfirm && onCancelMoveConfirm(); } catch {}
              }}
            >
              NO
            </button>
            <button
              type="button"
              className="px-2 py-1 text-xs rounded-md border border-black/20 bg-white hover:bg-black/5 active:bg-black/10"
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                try { onConfirmMoveConfirm && onConfirmMoveConfirm(); } catch {}
              }}
            >
              OK
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderPromotionOverlay = () => {
    if (!pendingPromotion) return null;
    if (!(cellSize > 0) || !(boardSize > 0)) return null;

    const { toRow, toCol, piece } = pendingPromotion;
    if (!(Number.isInteger(toRow) && Number.isInteger(toCol))) return null;

    const baseKey = (piece?.piece || piece?.type || '').toString();
    if (!baseKey) return null;

    const promotedKey =
      PROMOTED_PIECES[baseKey] || PROMOTED_PIECES[baseKey.toLowerCase()] || null;
    const owner = piece?.owner;

    // anchor on destination square (where the piece will land)
    const dRow = boardFlipped ? 8 - toRow : toRow;
    const dCol = boardFlipped ? 8 - toCol : toCol;
    const sqLeft = dCol * cellSize;
    const sqTop = dRow * cellSize;

    // make the picker large enough for touch, but keep it inside the 9x9 area
    const gap = Math.max(6, Math.floor(cellSize * 0.10));
    const maxOpt = Math.floor((boardSize - gap) / 2);
    const optSize = Math.max(44, Math.min(Math.floor(cellSize * 0.95), maxOpt));
    const panelW = optSize * 2 + gap;
    const panelH = optSize;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

    // place above the destination square when possible; otherwise below
    let left = sqLeft + (cellSize - panelW) / 2;
    left = clamp(left, 0, Math.max(0, boardSize - panelW));

    const aboveTop = sqTop - panelH - gap;
    const belowTop = sqTop + cellSize + gap;

    let top = aboveTop;
    if (top < 0 && belowTop + panelH <= boardSize) top = belowTop;
    top = clamp(top, 0, Math.max(0, boardSize - panelH));

    const basePiece = { piece: baseKey, owner };
    const promoPiece = { piece: promotedKey || baseKey, owner };

    const iconPad = Math.max(6, Math.floor(optSize * 0.12));
    const iconBox = Math.max(0, optSize - iconPad * 2);

    return (
      <div
        ref={promoOverlayRef}
        className="absolute rounded-xl border border-black/20 shadow-lg overflow-hidden"
        style={{
          left,
          top,
          width: panelW,
          height: panelH,
          zIndex: 40,
          backgroundColor: 'rgba(255,255,255,0.95)',
          backdropFilter: 'blur(2px)'
        }}
        onPointerDown={(e) => {
          // clicking the panel background cancels (buttons stop propagation)
          e.preventDefault();
          e.stopPropagation();
          cancelPromotionChoice();
        }}
      >
        <div className="w-full h-full flex">
          {/* iPad/タブレットは左側を優先して押しやすいので、成を左・不成を右に配置 */}
          <button
            type="button"
            className="flex-1 flex items-center justify-center hover:bg-black/5 active:bg-black/10"
            aria-label={t('ui.components.game.shogiboard.kbb357862')}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              commitPromotionChoice(true);
            }}
          >
            <div
              style={{
                width: iconBox,
                height: iconBox,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {renderPiece(promoPiece)}
            </div>
          </button>

          <div
            style={{
              width: 1,
              backgroundColor: 'rgba(0,0,0,0.15)'
            }}
          />

          <button
            type="button"
            className="flex-1 flex items-center justify-center hover:bg-black/5 active:bg-black/10"
            aria-label={t('ui.components.game.shogiboard.kf57568e8')}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              commitPromotionChoice(false);
            }}
          >
            <div
              style={{
                width: iconBox,
                height: iconBox,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {renderPiece(basePiece)}
            </div>
          </button>
        </div>
      </div>
    );
  };

  // 持ち駒表示用（ボタン内の固定サイズに合わせて描画）
  const renderCapturedPieceVisual = (pieceType, owner) => {
    const rawKey = (pieceType || '').toString();
    const norm = rawKey.toLowerCase();
    const isGote = owner === PLAYERS.GOTE || owner === 'gote';
    const rotation = (boardFlipped ? !isGote : isGote) ? 'rotate-180' : '';

    const pmap = boardTheme?.pieces || {};
    let url = null;
    if (pmap && (pmap.sente || pmap.gote)) {
      url = isGote
        ? (pmap.gote?.[norm] ?? pmap.sente?.[norm] ?? null)
        : (pmap.sente?.[norm] ?? pmap.gote?.[norm] ?? null);
    } else if (pmap) {
      url = pmap[norm] || null;
    }

    if (url) {
      return (
        <img
          src={url}
          alt={norm}
          draggable={false}
          className={`${rotation} pointer-events-none select-none`}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      );
    }

    // 画像が無い場合のフォールバック（極力発生しない想定）
    return (
      <span className={`${rotation} ${isGote ? 'text-red-600' : 'text-blue-600'} ${isCompactUI ? 'text-xs' : 'text-base'} leading-none`}>
        {t(PIECE_NAMES[pieceType] || '')}
      </span>
    );
  };

  // プレイヤー見出し（旧盤の時間表記に準拠）
  const PlayerHeader = ({ owner }) => {
    const isBottom = (owner === PLAYERS.SENTE && !boardFlipped) || (owner === PLAYERS.GOTE && boardFlipped);
    const player = owner === PLAYERS.SENTE ? gameState?.players?.sente : gameState?.players?.gote;
    const rating = player?.rating ?? player?.elo ?? null;
    const isSente = owner === PLAYERS.SENTE;

    // 時間：breakdown と base_at/current_player から動的算出
    const baseAt = timeState?.base_at || Date.now();
    const elapsed = Math.max(0, Date.now() - baseAt);
    const cfg = timeState?.config || null;
    const showInitial   = !!(cfg?.initial_ms   > 0);
    const showByoyomi   = !!(cfg?.byoyomi_ms   > 0);
    const showDeferment = !!(cfg?.deferment_ms > 0);
    const bk = (timeState?.breakdown && (isSente ? timeState.breakdown.sente : timeState.breakdown.gote)) || null;
    const running = timeState?.current_player === (isSente ? 'sente' : 'gote') ? elapsed : 0;
    const a = bk ? applyElapsedToBreakdown(bk, running) : null;
    const secStr = (ms) => `${Math.ceil(Math.max(0, (ms || 0)) / 1000)}`;

    const showTurn = currentPlayer === owner;

    // リプレイ/観戦などで timeState が無い場合、--:-- 表示は高さを食うだけなので常に隠す。
    const hideTimeLine = !timeState;

	return (
      <div className="user-header-block">
        {/* 1行目: 名前(R) + 共有盤 + 手番 */}
	    <div className={`user-line1 min-w-0 ${usePcTabletHeader ? 'flex flex-col gap-1' : 'flex items-center gap-0.5 flex-nowrap'}`}>
          <span
            className={
              owner === PLAYERS.SENTE
                ? `rounded-md bg-blue-100 text-blue-700 flex-1 min-w-0 truncate ${isCompactUI ? 'px-1.5 py-0 text-[11px] leading-4' : 'px-2 py-0.5'}`
                : `rounded-md bg-red-100 text-red-700 flex-1 min-w-0 truncate ${isCompactUI ? 'px-1.5 py-0 text-[11px] leading-4' : 'px-2 py-0.5'}`
            }
          >
            {owner === PLAYERS.SENTE ? (player?.username || t('ui.components.game.shogiboard.k3a1b7009')) : (player?.username || t('ui.components.game.shogiboard.k3bcc9adf'))}
            {(usePcTabletHeader && !isCompactUI && typeof rating === 'number') ? ` R ${rating}` : ''}
          </span>

          {/* 共有盤の状態表示は、名前のtruncate領域の外に出して見切れを防ぐ */}
          {(() => {
            // 観戦者視点でも「共有盤有効化中」を表示したい。
            // 対局者ごとの enabled フラグ（sente/gote）に従う。
            const sharedEnabled = (sharedBoardStatus?.enabled &&
              (owner === PLAYERS.SENTE ? !!sharedBoardStatus.enabled.sente : !!sharedBoardStatus.enabled.gote)
            );

            // PC/Tablet は常に1行分(改行分)の領域を確保してレイアウトのガタつきを防ぐ。
            // Mobile は従来通り「表示する時だけ」出す。
            if (usePcTabletHeader) {
              return (
                <span
                  className={`${usePcTabletHeader ? '' : 'ml-1'} inline-flex items-center gap-1 text-[10px] text-emerald-700 whitespace-nowrap shrink-0 ${sharedEnabled ? '' : 'invisible'}`}
                >
                  <span className={`w-2 h-2 rounded-full bg-emerald-500 ${sharedEnabled ? 'animate-pulse' : ''}`} />
                  {t('ui.components.game.shogiboard.kbdb71059')}
                </span>
              );
            }

            return sharedEnabled ? (
              <span className={`${usePcTabletHeader ? '' : 'ml-1'} inline-flex items-center gap-1 text-[10px] text-emerald-700 whitespace-nowrap shrink-0`}>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                {t('ui.components.game.shogiboard.kbdb71059')}
              </span>
            ) : null;
          })()}

	          {usePcTabletHeader ? (
            <div className="h-6 flex items-center">
              {showTurn ? (
                <Badge variant="default" className="h-6 whitespace-nowrap">
                  {t('ui.components.game.shogiboard.kfa7892e6')}
                </Badge>
              ) : (
                <span className="h-6" />
              )}
            </div>
          ) : (
            showTurn ? (
              <Badge variant="default" className="h-3.5 px-1 text-[8px] whitespace-nowrap">
                {t('ui.components.game.shogiboard.kfa7892e6')}
              </Badge>
            ) : null
          )}</div>

        {/* 2行目: 持ち時間 */}
        {!hideTimeLine && (
          <div className={`user-line2 user-times font-mono ${isCompactUI ? 'text-[10px] leading-4 mt-0.5' : 'text-xs leading-5 mt-1'}`}>
            {a ? (
              <>
                {showInitial   && (<><span>{t('ui.components.game.shogiboard.k21e72ec7')} {formatTime((a.initial_ms||0)/1000)}</span>{showByoyomi || showDeferment ? <span className="mx-1">/</span> : null}</>)}
                {showByoyomi   && (<><span>{t('ui.components.game.shogiboard.k911d567a')} {secStr(a.byoyomi_ms)}</span>{showDeferment ? <span className="mx-1">/</span> : null}</>)}
                {showDeferment && (<><span>{t('ui.components.game.shogiboard.k82ef18d7')} {formatTime((a.deferment_ms||0)/1000)}</span></>) }
              </>
            ) : (
              <span>--:--</span>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderCaptured = (owner) => {
    const pieces = capturedPieces?.[owner] || {};
    const isEmptyCaptured = Object.keys(pieces).length === 0;
    const isBottom = (owner === PLAYERS.SENTE && !boardFlipped) || (owner === PLAYERS.GOTE && boardFlipped);
    const panelStyle = (usePortraitSides && tabletUserPanelH) ? { height: tabletUserPanelH, maxHeight: tabletUserPanelH } : undefined;

    // タブレット縦(左右パネル)では、持ち駒が1列スクロールだと小さく見えづらいので、
    // 3列グリッドで折り返して表示する（最大7種→3行程度に収まる）。
    const useTabletCapturedGrid = !!usePortraitSides;

    // PC/タブレットでは「compact」でも持ち駒は小さすぎるので、常に大きめにする。
    // ただし tablet(左右パネル) は grid 表示に切り替える。
    const useCompactCaptured = isCompactUI && !useLargeCaptured && !useTabletCapturedGrid;

    // flex の並びが環境依存で "space-between" になってしまうケースがあるため、
    // inline style で明示して詰める。
    const capturedListStyle = {
      justifyContent: isBottom ? 'flex-end' : 'flex-start',
      alignContent: 'flex-start',
      ...(useCompactCaptured ? { WebkitOverflowScrolling: 'touch' } : {}),
      ...(useTabletCapturedGrid ? { gridTemplateColumns: 'repeat(3, 36px)' } : {}),
    };

    const capturedBtnClass = useLargeCaptured
      ? 'h-12 w-12 p-1'
      : (useCompactCaptured ? 'h-5 w-5 p-0' : 'h-9 w-9 p-1');

    const capturedCountClass = useLargeCaptured
      ? 'text-[11px]'
      : (useCompactCaptured ? 'text-[8px]' : 'text-[10px]');

    return (
        <div className={`user-panel sb-user-panel ${isCompactUI ? 'p-1 rounded-md' : 'p-3 rounded-lg'} shogi-lobby-layer w-full min-h-0 flex flex-col ${isDesktop ? 'h-1/2' : ''} ${isBottom ? 'text-right' : ''} relative`} style={panelStyle}>
        <PlayerHeader owner={owner} />
        {!useCompactCaptured && <div className="user-captured-title text-xs text-slate-500 mt-2 mb-1">{t('ui.components.game.shogiboard.k503e3171')}</div>}
        <div
          className={
            useTabletCapturedGrid
              ? `user-captured-piece-list grid gap-1 content-start items-start ${isBottom ? 'justify-end' : ''}`
              : (
                useCompactCaptured
                  ? (
                      isEmptyCaptured
                        ? `user-captured-piece-list flex flex-wrap gap-0.5 min-h-[24px] h-auto py-1 overflow-hidden items-center ${isBottom ? 'justify-end' : ''}`
                        : `user-captured-piece-list flex flex-nowrap gap-0.5 h-6 min-h-[24px] overflow-x-auto overflow-y-hidden items-center ${isBottom ? 'justify-end' : ''}`
                    )
                  : `user-captured-piece-list flex flex-wrap ${useLargeCaptured ? 'gap-2' : 'gap-1'} flex-1 min-h-0 overflow-auto ${isBottom ? 'justify-end' : ''}`
              )
          }
          style={capturedListStyle}
        >
          {Object.entries(pieces).map(([pieceType, count]) => {
            const selected = selectedCapturedPiece?.piece === pieceType && selectedCapturedPiece?.owner === owner;
            const baseLabel = t(PIECE_NAMES[pieceType] || '');
            const label = baseLabel ? `${baseLabel}${count > 1 ? ` ×${count}` : ''}` : '';
            return (
              <Button
                key={pieceType}
                variant="outline"
                size="sm"
                className={`user-captured-piece-button relative ${capturedBtnClass} ${selected ? 'bg-blue-200 ring-2 ring-blue-400' : ''}`}
                onPointerDown={(e) => handleCapturedPointerDown(e, pieceType, owner)}
                onPointerMove={handleAnyPointerMove}
                onPointerUp={handleAnyPointerUp}
                onPointerCancel={handleAnyPointerCancel}
                style={{ touchAction: 'none' }}
                disabled={!canOperate || owner !== currentPlayer}
                title={label}
                aria-label={label}
                aria-pressed={selected}
              >
                <div className="relative w-full h-full flex items-center justify-center" style={(dragUI.dragging && dragUI.type === 'drop' && dragUI.captured?.pieceType === pieceType && dragUI.captured?.owner === owner) ? { visibility: 'hidden' } : undefined}>
                  {renderCapturedPieceVisual(pieceType, owner)}
                  {count > 1 && (
                    <span
                      className={`user-captured-piece-count absolute -top-1 -right-1 leading-none px-1 py-0.5 rounded-full bg-slate-900 text-white ${capturedCountClass}`}
                      style={{ minWidth: '1.1rem', textAlign: 'center' }}
                    >
                      {count}
                    </span>
                  )}
                </div>
              </Button>
            );
          })}
          {isEmptyCaptured && (
            <span
              className={`user-captured-piece-empty text-gray-400 whitespace-normal break-words leading-tight min-w-0 ${useTabletCapturedGrid ? 'col-span-3 text-center' : 'w-full'} ${useCompactCaptured ? 'text-[10px] px-1' : 'text-sm'} ${useTabletCapturedGrid ? '' : (isBottom ? 'text-right' : 'text-left')}`}
            >
              {t('ui.components.game.shogiboard.ke331c5b0')}
            </span>
          )}
        </div>
      </div>
    );
  };

  // coordinate decoration background & layout options
  const hLabelBg = boardTheme?.coordinates?.outside?.background_horizontal || null;
  const vLabelBgLeft  = boardTheme?.coordinates?.outside?.background_vertical || null;
  const vLabelBgRight = boardTheme?.coordinates?.outside?.background_vertical_right ?? null;
  const coordColor = boardTheme?.coordinates?.color || '#4b5563';

  // Fill the top-left / top-right "corner" behind coordinate labels.
  // Without this, the corner becomes transparent and the page background shows through.
  // Allow explicit per-corner overrides via board-theme config:
  // coordinates.outside.background_corner_left / background_corner_right
  const cornerBgLeft  = boardTheme?.coordinates?.outside?.background_corner_left  ?? vLabelBgLeft  ?? hLabelBg ?? null;
  const cornerBgRight = boardTheme?.coordinates?.outside?.background_corner_right ?? vLabelBgRight ?? hLabelBg ?? null;

  const showVLeft  = geom?.labels?.showVLeft ?? (((boardTheme?.coordinates?.outside?.left ?? true) !== false) && !!showCoordinates);
  const showVRight = geom?.labels?.showVRight ?? ((!!boardTheme?.coordinates?.outside?.right) && !!showCoordinates);
  const labelThick = geom?.labels?.thick ?? (showCoordinates ? 26 : 0); // px

  const isWide = shellWidthMode === 'wide';

  // Desktop wide mode: keep the board height-limited (same as current behavior),
  // but avoid pushing user panels to the far edges when horizontal space is abundant.
  //
  // IMPORTANT: do NOT derive this lock from `geom` (it depends on container width),
  // otherwise a resize feedback loop can occur and panels may jitter left-right.
  // We derive the locked width only from the available HEIGHT (stable) so the board
  // can grow to the maximum size allowed by height, while the 3-column group stays centered.
  const coordsForLock = boardTheme?.coordinates || {};
  const thickForLock = showCoordinates ? 26 : 0;
  const showVLeftForLock  = ((coordsForLock?.outside?.left ?? true) !== false) && !!showCoordinates;
  const showVRightForLock = (!!(coordsForLock?.outside?.right)) && !!showCoordinates;

  // fitRef height is the usable board area height (padding/border are outside fitRef).
  // We want the square edge to be limited by height (usableH = h - topLabel).
  const desktopSquareEdge = (isDesktop && isWide && (containerSize?.h || 0) > 0)
    ? Math.max(0, Math.floor((containerSize.h || 0) - thickForLock))
    : null;

  // Locked fitRef width: (left label) + (square edge) + (right label).
  // This guarantees usableW >= usableH, so the board stays height-limited and stable.
  const desktopFitRefW = (desktopSquareEdge && desktopSquareEdge > 0)
    ? Math.ceil((showVLeftForLock ? thickForLock : 0) + desktopSquareEdge + (showVRightForLock ? thickForLock : 0))
    : null;

  // lg:p-4 is 16px. The board frame has two wrappers each with lg:p-4.
  // Outer wrapper also has a 1px border (x2).
  const desktopBoardFrameW = (isDesktop && isWide && desktopFitRefW)
    ? Math.ceil(desktopFitRefW + (16 * 2) + (16 * 2) + 2)
    : null;

  // Stabilize against tiny measurement noise to avoid layout jitter
  const stableDesktopBoardFrameW = (() => {
    if (!(isDesktop && isWide && desktopBoardFrameW)) return null;
    const prev = wideLockRef.current;
    if (!prev) { wideLockRef.current = desktopBoardFrameW; return desktopBoardFrameW; }
    if (Math.abs(prev - desktopBoardFrameW) < 6) return prev;
    wideLockRef.current = desktopBoardFrameW;
    return desktopBoardFrameW;
  })();

  const desktopGridCols = (isDesktop && isWide && stableDesktopBoardFrameW)
    ? 'grid-cols-[160px_auto_160px]'
    : 'grid-cols-[160px_minmax(0,1fr)_160px]';

  const desktopGap = (isDesktop && isWide && stableDesktopBoardFrameW) ? 'gap-4' : 'gap-6';

  const centerColCls = (isDesktop && isWide && stableDesktopBoardFrameW)
    ? 'justify-self-center w-auto flex-none'
    : 'justify-self-stretch w-full flex-1';

  const centerColStyle = (isDesktop && isWide && stableDesktopBoardFrameW)
    ? { width: `${stableDesktopBoardFrameW}px`, maxWidth: '100%', flex: '0 0 auto' }
    : undefined;


  // IMPORTANT:
  // Mobile/Tablet (especially iPad portrait) must NOT vertically stretch the grid items.
  // If the grid stretches, the inner "shogi-lobby-layer" panels inherit that height and
  // their background layer grows down into the empty space.
  // Desktop keeps stretch so the 3-column frame can fill the top area.
  const gridLayoutCls = usePortraitSides
    // iPad(実機)では sb-grid が h-full を持つため、grid の既定 align-content:stretch によって
    // 1行グリッドの行高が「余白まで」伸び、右側(自分)パネルが画面右下まで落ちることがある。
    // content-start で行高の伸張を止め、盤(中央)の高さに揃えて左右パネルも盤に追従させる。
    ? 'grid-cols-[minmax(120px,160px)_minmax(0,1fr)_minmax(120px,160px)] gap-3 content-start items-stretch justify-center'
    : (isDesktop ? `${desktopGridCols} ${desktopGap} items-stretch justify-center` : 'grid-cols-1 gap-0 items-start');

  if (showVRight && !vLabelBgRight) {
    throw new Error('board-theme: coordinates.outside.right is true but background_vertical_right is missing');
  }

  return (
    // ShogiBoard may be mounted inside a flex-row container.
    // If inner layout uses absolutely-positioned elements, a flex item can collapse to width=0
    // unless it has an explicit width/min-width. Keep w-full + min-w-0 here.
    <div className={`game-no-select flex flex-col ${isCompactUI ? 'space-y-2' : 'space-y-4'} h-full min-h-0 w-full min-w-0 ${className}`}>
      {/* レスポンシブ配置: スマホ=縦一列（上=相手→盤→下=自分）、PC=左右3カラム（左=上／右=下） */}
      <div className={`sb-grid grid ${gridLayoutCls} ${usePortraitSides ? 'sb-portrait-sides' : ''} w-full h-full min-h-0 min-w-0`}>
        {/* 相手（モバイル: 上／PC: 左=上揃え） */}
        <div className={`order-1 ${isDesktop || usePortraitSides ? 'order-none flex flex-col justify-start' : ''} h-full min-h-0 ${usePortraitSides ? 'sb-side-col sb-side-col-top' : ''}`}>
          {renderCaptured(boardFlipped ? PLAYERS.SENTE : PLAYERS.GOTE)}
        </div>

        {/* 盤（中央） */}
	        <div className={`order-2 ${isDesktop || usePortraitSides ? 'order-none' : ''} h-full min-h-0 flex ${isDesktop ? 'items-stretch' : 'items-start'} min-w-0 ${centerColCls}`} style={centerColStyle}>
	          <div className={`!m-0 !p-0 !border-0 !rounded-none shogi-lobby-layer self-start min-h-0 flex-1 flex w-full min-w-0 ${isDesktop ? '!p-4 !rounded-xl h-full' : ''}`} style={{ flex: 1, minWidth: 0 }}>
	            {/*
	              iPad 実機(Safari/Chrome)では、親 flex の items-stretch によって
	              padding-hack(正方形)を入れている fitRef が縦に引き伸ばされ、盤が縦中央に見える。
	              モバイル/タブレットでは伸張させず、正方形の高さ(=幅)に合わせる。
	            */}
	            <div className={`!p-0 min-h-0 flex-1 min-w-0 flex ${isDesktop ? 'items-stretch' : 'items-start'} ${isDesktop ? '!p-4 h-full' : ''}`} style={{ flex: 1, minWidth: 0 }}>
          {/* Measure a stable, in-flow element. Measuring an absolutely-positioned box can lead to 0-width
              when mounted as a flex item (content-size becomes 0). */}
          <div ref={fitRef} className={`relative w-full min-w-0 min-h-0 overflow-hidden ${isDesktop ? 'flex-1 h-full' : ''}`} style={{ minWidth: 0, minHeight: 0 }}>
            {/* iPad(実機)/Safari で aspect-ratio が不安定なことがあるので、モバイルは padding-hack で正方形を保証 */}
            <div className={isDesktop ? 'hidden' : 'block'} style={{ paddingTop: '100%' }} aria-hidden="true" />
            <div className="absolute inset-0 overflow-hidden flex items-center justify-center">
      {!(boardTheme && geom) ? null : (
        <div
          style={{
            width: (showVLeft ? labelThick : 0) + bgW + (showVRight ? labelThick : 0),
            height: labelThick + bgH,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            justifyContent: 'stretch'
          }}
        >
          {/* 上の横ラベル（9..1） */}
          {labelThick > 0 && (
            <div style={{ height: labelThick, display: 'flex', alignItems: 'stretch' }}>
              {showVLeft ? (
                <div style={{ width: labelThick, height: labelThick, position: 'relative', flex: '0 0 auto' }}>
                  {cornerBgLeft && (
                    <img
                      src={cornerBgLeft}
                      alt="coord-corner-left"
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                      draggable={false}
                    />
                  )}
                </div>
              ) : null}

              <div style={{ width: bgW, height: labelThick, position: 'relative' }}>
                {hLabelBg && (
                  <img
                    src={hLabelBg}
                    alt="h-label-bg"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                    draggable={false}
                  />
                )}
                <div
                  style={{
                    position: 'absolute',
                    left: boardInsetLeft,
                    top: 0,
                    width: boardSize,
                    height: '100%',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(9, 1fr)',
                    zIndex: 1,
                    justifyItems: 'center',
                    alignItems: 'center',
                    fontSize: '0.8rem',
                    color: coordColor
                  }}
                >
                  {Array.from({ length: 9 }, (_, i) => 9 - i).map((n) => (
                    <div
                      key={n}
                      style={{
                        width: cellSize,
                        height: labelThick,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      {n}
                    </div>
                  ))}
                </div>
              </div>

              {showVRight ? (
                <div style={{ width: labelThick, height: labelThick, position: 'relative', flex: '0 0 auto' }}>
                  {cornerBgRight && (
                    <img
                      src={cornerBgRight}
                      alt="coord-corner-right"
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                      draggable={false}
                    />
                  )}
                </div>
              ) : null}
            </div>
          )}

          {/* 縦ラベル + 盤 */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'stretch' }}>
            {/* 左の縦ラベル（一..九） */}
            {showVLeft && (
              <div
                style={{
                  width: labelThick,
                  height: bgH,
                  display: (showCoordinates ? 'block' : 'none'),
                  position: 'relative',
                  flex: '0 0 auto'
                }}
              >
                {vLabelBgLeft && (
                  <img
                    src={vLabelBgLeft}
                    alt="v-label-bg-left"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                    draggable={false}
                  />
                )}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: boardInsetTop,
                    width: labelThick,
                    height: boardSize,
                    display: 'grid',
                    gridTemplateRows: 'repeat(9, 1fr)',
                    zIndex: 1,
                    justifyItems: 'center',
                    alignItems: 'center',
                    fontSize: '0.8rem',
                    color: coordColor
                  }}
                >
                  {[t('ui.components.game.shogiboard.kd274eee8'), t('ui.components.game.shogiboard.k1d5639f7'), t('ui.components.game.shogiboard.k49ddb069'), t('ui.components.game.shogiboard.k4f88740b'), t('ui.components.game.shogiboard.k8f07f53d'), t('ui.components.game.shogiboard.k3d72c724'), t('ui.components.game.shogiboard.k7db1eeb5'), t('ui.components.game.shogiboard.k2142fb62'), t('ui.components.game.shogiboard.k27a2b9f1')].map((ch, idx) => (
                    <div
                      key={idx}
                      style={{
                        width: labelThick,
                        height: cellSize,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      {ch}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 背景と盤面 */}
            <div style={{ width: bgW, height: bgH, position: 'relative', overflow: 'hidden', flex: '0 0 auto' }}>
              <img
                src={boardTheme.background}
                alt="board background"
                draggable={false}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  // 背景画像は全体表示（切り抜き禁止）
                  // wrapper(div) 自体が背景のアスペクト比を保持するため、contain で歪みも防ぐ
                  objectFit: 'contain',
                  pointerEvents: 'none'
                }}
              />

              {/* 盤のアクティブ領域（駒・クリックはここだけ） */}
              <div
                ref={boardAreaRef}
                style={{
                  position: 'absolute',
                  left: boardInsetLeft,
                  top: boardInsetTop,
                  width: boardSize,
                  height: boardSize
                }}
              >
                {getBoardRows().map((row) => (
                  <div key={row} className="flex">
                    {getBoardCols().map((col) => (
                      <div
                        key={`${row}-${col}`}
                        className="relative flex items-center justify-center text-sm font-bold cursor-pointer transition-colors"
                        style={{ width: cellSize, height: cellSize, touchAction: 'none' }}
                        onPointerDown={(e) => handleBoardPointerDown(e, row, col)}
                        onPointerMove={handleAnyPointerMove}
                        onPointerUp={handleAnyPointerUp}
                        onPointerCancel={handleAnyPointerCancel}
                      >
                        {renderSquareOverlay(row, col)}
                        {dragUI.dragging && dragUI.ghostPiece && dragUI.hover && dragUI.hover.row === row && dragUI.hover.col === col && (
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 8 }}>
                            <div
                              className="shogi-drag-ghost-piece"
                              style={{
                                width: Math.max(0, cellSize - 2 * piecePad),
                                height: Math.max(0, cellSize - 2 * piecePad),
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}
                            >
                              {renderPiece(dragUI.ghostPiece)}
                            </div>
                          </div>
                        )}
                        <div
                          style={{
                            position: 'relative',
                            zIndex: 4,
                            width: Math.max(0, cellSize - 2 * piecePad),
                            height: Math.max(0, cellSize - 2 * piecePad),
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          {(dragUI.dragging && dragUI.type === 'move' && dragUI.from && dragUI.from.row === row && dragUI.from.col === col) ? null : renderPiece(
                            board?.[row]?.[col],
                            (lastMovePieceHighlightEnabled && effectiveLastMove && effectiveLastMove.toRow === row && effectiveLastMove.toCol === col)
                              ? { effect: 'lastmove-to' }
                              : null
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
                {renderBestMoveLineOverlay()}
                {renderNextMainlineArrowOverlay()}
                {renderMoveConfirmOverlay()}
                {renderPromotionOverlay()}
              </div>
            </div>

            {/* 右の縦ラベル（必要なら） */}
            {showVRight && (
              <div
                style={{
                  width: labelThick,
                  height: bgH,
                  display: (showCoordinates ? 'block' : 'none'),
                  position: 'relative',
                  flex: '0 0 auto'
                }}
              >
                <img
                  src={vLabelBgRight}
                  alt="v-label-bg-right"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                  draggable={false}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: boardInsetTop,
                    width: labelThick,
                    height: boardSize,
                    display: 'grid',
                    gridTemplateRows: 'repeat(9, 1fr)',
                    zIndex: 1,
                    justifyItems: 'center',
                    alignItems: 'center',
                    fontSize: '0.8rem',
                    color: coordColor
                  }}
                >
                  {[t('ui.components.game.shogiboard.kd274eee8'), t('ui.components.game.shogiboard.k1d5639f7'), t('ui.components.game.shogiboard.k49ddb069'), t('ui.components.game.shogiboard.k4f88740b'), t('ui.components.game.shogiboard.k8f07f53d'), t('ui.components.game.shogiboard.k3d72c724'), t('ui.components.game.shogiboard.k7db1eeb5'), t('ui.components.game.shogiboard.k2142fb62'), t('ui.components.game.shogiboard.k27a2b9f1')].map((ch, idx) => (
                    <div
                      key={idx}
                      style={{
                        width: labelThick,
                        height: cellSize,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      {ch}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  </div>
            </div>
          </div>
        </div>
        {/* 自分（モバイル: 下／PC: 右=下揃え） */}
        <div className={`order-3 ${isDesktop || usePortraitSides ? 'order-none flex flex-col justify-end' : ''} h-full min-h-0 ${usePortraitSides ? 'sb-side-col sb-side-col-bottom' : ''}`}>
          {renderCaptured(boardFlipped ? PLAYERS.GOTE : PLAYERS.SENTE)}
        </div>
      </div>
    </div>
  );
};

export default ShogiBoard;
