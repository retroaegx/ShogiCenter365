import React, {useState, useEffect, useMemo, useCallback, useRef} from 'react';
import { Button } from '@/components/ui/button';
import { ListOrdered } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { loadBoardTheme } from '@/config/themeLoader';
import {
  PIECE_NAMES,
  PLAYERS,
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
  const t = raw.theme ?? raw;

  // background can be string or object {path|url}
  const background =
    typeof t.background === 'string'
      ? t.background
      : (t.background && (t.background.path || t.background.url)) || null;

  // board_region: support start/end variants
  let board_region = t.board_region ?? t.boardRegion ?? null;
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

  const coordinates = t.coordinates ?? t.coords ?? {};
  const grid = t.grid ?? {};
  const pieces = t.pieces ?? t.piece_images ?? t.images ?? {};

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
  isSpectator = false,
  currentUser,
  timeState = null,
  className = '',
  onRequestClose,
  shellWidthMode = 'normal'
}) => {
  const [internalShowCoordinates, setInternalShowCoordinates] = useState(true);
  // coordinates visibility (controlled or uncontrolled)
  const showCoordinates =
    typeof showCoordinatesProp === 'boolean' ? showCoordinatesProp : internalShowCoordinates;
  const toggleCoordinates = onToggleCoordinates || (() => setInternalShowCoordinates((v) => !v));
  const [boardTheme, setBoardTheme] = useState(null);
  const [bgNatural, setBgNatural] = useState({ w: 0, h: 0 });
  const [boardFlipped, setBoardFlipped] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [selectedCapturedPiece, setSelectedCapturedPiece] = useState(null);
  const [possibleMoves, setPossibleMoves] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  const CELL_BASE = 48;
  const fitRef = useRef(null);
  const wideLockRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // desktop breakpoint (Tailwind md: 768px)
  // Mobile は盤をできるだけ大きく見せたいので、"通常モード(0.96)"の余白縮小を無効化する。
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia('(min-width: 768px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e) => setIsDesktop(!!e.matches);
    setIsDesktop(!!mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);

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


  // === theme load ===
  useEffect(() => {
    let alive = true;
    loadBoardTheme()
      .then((t) => {
        if (!alive) return;
        const norm = normalizeTheme(t);
        setBoardTheme(norm);
      })
      .catch((e) => {
        console.error('loadBoardTheme failed', e);
        setBoardTheme(null);
      });
    return () => {
      alive = false;
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


  const clearSelection = useCallback(() => {
    setSelectedSquare(null);
    setSelectedCapturedPiece(null);
    setPossibleMoves([]);
  }, []);

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


  // === move click ===
  const handleSquareClick = useCallback(
    (row, col) => {
      if (!isMyTurn) return;
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
            const promote = window.confirm('成りますか？');
            const result = makeMove(gameState, fr, fc, row, col, !!promote);
            if (result.success) {
              const usi = buildUsiMove({ fromRow: fr, fromCol: fc, toRow: row, toCol: col, promote: !!promote });
              onMove({ usi });
              clearSelection();
            }
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
    [isMyTurn, board, selectedCapturedPiece, selectedSquare, possibleMoves, currentPlayer, gameState, onMove, clearSelection]
  );

  const handleCapturedPieceClick = useCallback(
    (pieceType, owner) => {
      if (!isMyTurn || owner !== currentPlayer) return;
      if (selectedCapturedPiece?.piece === pieceType) {
        clearSelection();
        return;
      }
      setSelectedSquare(null);
      setSelectedCapturedPiece({ piece: pieceType, owner });
      const dropMoves = getDropMoves(board, pieceType, currentPlayer);
      setPossibleMoves(dropMoves);
    },
    [isMyTurn, currentPlayer, selectedCapturedPiece, board, clearSelection]
  );

  // 強調オーバーレイ（選択 / 候補 / 直近）
  const renderSquareOverlay = (row, col) => {
    const isSelected = selectedSquare && selectedSquare.row === row && selectedSquare.col === col;
    const isPossibleMove = possibleMoves.some((move) => move.row === row && move.col === col);
    const isLastMove =
      lastMove &&
      ((lastMove.fromRow === row && lastMove.fromCol === col) ||
        (lastMove.toRow === row && lastMove.toCol === col));

    // 「動かせる位置」は、四角い塗りつぶしではなく点滅する丸で表示する
    // （駒が置かれているマスでも見えるように z-index を高めに）
    const layers = [];
    if (isLastMove) {
      // 直近の移動元/移動先は「赤い点滅丸」で表示（緑の候補表示の赤版）
      // 駒が置かれているマスでも見えるように z-index を高めに
      layers.push(<div key="last" className="shogi-last-move-indicator" />);
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


  const renderPiece = (piece) => {
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
        {PIECE_NAMES[piece.piece] || PIECE_NAMES[piece.type] || '？'}
      </span>
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
      <span className={`${rotation} ${isGote ? 'text-red-600' : 'text-blue-600'} text-base leading-none`}>
        {PIECE_NAMES[pieceType] || '？'}
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

    
	return (
      <div className="user-header-block">
        {/* 1行目: 名前(R) + 手番 */}
	        <div className="user-line1 flex items-center gap-2 flex-wrap min-w-0">
          <span
            className={
              owner === PLAYERS.SENTE
	                ? 'px-2 py-0.5 rounded-md bg-blue-100 text-blue-700 flex-1 min-w-0 break-all'
	                : 'px-2 py-0.5 rounded-md bg-red-100 text-red-700 flex-1 min-w-0 break-all'
            }
          >
            {owner === PLAYERS.SENTE ? player?.username || '先手' : player?.username || '後手'}
            {typeof rating === 'number' ? ` R ${rating}` : ''}
          </span>
	          {showTurn && (
	            <Badge variant="default" className="ml-1 shrink-0 whitespace-nowrap">
	              手番
	            </Badge>
	          )}
        </div>

        {/* 2行目: 持ち時間 */}
        <div className="user-line2 user-times font-mono text-xs leading-5 mt-1">
          {a ? (
            <>
              {showInitial   && (<><span>持ち時間 {formatTime((a.initial_ms||0)/1000)}</span>{showByoyomi || showDeferment ? <span className="mx-1">/</span> : null}</>)}
              {showByoyomi   && (<><span>秒読み {secStr(a.byoyomi_ms)}</span>{showDeferment ? <span className="mx-1">/</span> : null}</>)}
              {showDeferment && (<><span>猶予時間 {formatTime((a.deferment_ms||0)/1000)}</span></>)}
            </>
          ) : (
            <span>--:--</span>
          )}
        </div>
      </div>
    );
  };

  const renderCaptured = (owner) => {
    const pieces = capturedPieces?.[owner] || {};
    const isBottom = (owner === PLAYERS.SENTE && !boardFlipped) || (owner === PLAYERS.GOTE && boardFlipped);
    return (
      <div className={`user-panel p-3 rounded-lg shogi-lobby-layer w-full min-h-0 flex flex-col md:h-1/2 min-h-0 flex flex-col ${isBottom ? 'text-right' : ''} relative`}>
        <PlayerHeader owner={owner} />
        <div className="user-captured-title text-xs text-slate-500 mt-2 mb-1">持ち駒</div>
        <div className={`flex flex-wrap gap-1 flex-1 min-h-0 overflow-auto ${isBottom ? 'justify-end' : ''}`}>
          {Object.entries(pieces).map(([pieceType, count]) => {
            const selected = selectedCapturedPiece?.piece === pieceType && selectedCapturedPiece?.owner === owner;
            const label = `${PIECE_NAMES[pieceType] || pieceType}${count > 1 ? ` ×${count}` : ''}`;
            return (
              <Button
                key={pieceType}
                variant="outline"
                size="sm"
                className={`relative h-9 w-9 p-1 ${selected ? 'bg-blue-200 ring-2 ring-blue-400' : ''}`}
                onClick={() => handleCapturedPieceClick(pieceType, owner)}
                disabled={!isMyTurn || owner !== currentPlayer}
                title={label}
                aria-label={label}
                aria-pressed={selected}
              >
                <div className="relative w-full h-full flex items-center justify-center">
                  {renderCapturedPieceVisual(pieceType, owner)}
                  {count > 1 && (
                    <span
                      className="absolute -top-1 -right-1 text-[10px] leading-none px-1 py-0.5 rounded-full bg-slate-900 text-white"
                      style={{ minWidth: '1.1rem', textAlign: 'center' }}
                    >
                      {count}
                    </span>
                  )}
                </div>
              </Button>
            );
          })}
          {Object.keys(pieces).length === 0 && <span className="text-gray-400 text-sm">持ち駒なし</span>}
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
  const cornerBgLeft  = vLabelBgLeft || hLabelBg || null;
  const cornerBgRight = vLabelBgRight || hLabelBg || null;

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

  // md:p-4 is 16px. The board frame has two wrappers each with md:p-4.
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
    ? 'md:grid-cols-[160px_auto_160px]'
    : 'md:grid-cols-[160px_minmax(0,1fr)_160px]';

  const desktopGap = (isDesktop && isWide && stableDesktopBoardFrameW) ? 'md:gap-4' : 'md:gap-6';

  const centerColCls = (isDesktop && isWide && stableDesktopBoardFrameW)
    ? 'md:justify-self-center md:w-auto md:flex-none'
    : 'md:justify-self-stretch w-full flex-1';

  const centerColStyle = (isDesktop && isWide && stableDesktopBoardFrameW)
    ? { width: `${stableDesktopBoardFrameW}px`, maxWidth: '100%', flex: '0 0 auto' }
    : undefined;

  if (showVRight && !vLabelBgRight) {
    throw new Error('board-theme: coordinates.outside.right is true but background_vertical_right is missing');
  }

  return (
    // ShogiBoard may be mounted inside a flex-row container.
    // If inner layout uses absolutely-positioned elements, a flex item can collapse to width=0
    // unless it has an explicit width/min-width. Keep w-full + min-w-0 here.
    <div className={`flex flex-col space-y-4 h-full min-h-0 w-full min-w-0 ${className}`}>
      {/* レスポンシブ配置: スマホ=縦一列（上=相手→盤→下=自分）、PC=左右3カラム（左=上／右=下） */}
      <div className={`grid grid-cols-1 gap-0 ${desktopGap} ${desktopGridCols} md:items-stretch md:justify-center w-full h-full min-h-0 min-w-0`}>
        {/* 相手（モバイル: 上／PC: 左=上揃え） */}
        <div className="order-1 md:order-none md:flex md:flex-col md:justify-start h-full min-h-0">
          {renderCaptured(boardFlipped ? PLAYERS.SENTE : PLAYERS.GOTE)}
        </div>

        {/* 盤（中央） */}
        <div className={`order-2 md:order-none h-full min-h-0 flex min-w-0 ${centerColCls}`} style={centerColStyle}>
          <div className="!m-0 !p-0 md:!p-4 !border-0 !rounded-none md:!rounded-xl shogi-lobby-layer h-full min-h-0 flex-1 flex w-full min-w-0" style={{ flex: 1, minWidth: 0 }}>
            <div className="!p-0 md:!p-4 h-full min-h-0 flex-1 min-w-0 flex" style={{ flex: 1, minWidth: 0 }}>
          {/* Measure a stable, in-flow element. Measuring an absolutely-positioned box can lead to 0-width
              when mounted as a flex item (content-size becomes 0). */}
          <div ref={fitRef} className="relative w-full min-w-0 min-h-0 overflow-hidden aspect-square md:aspect-auto md:flex-1 md:h-full" style={{ minWidth: 0, minHeight: 0 }}>
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
                  {['一', '二', '三', '四', '五', '六', '七', '八', '九'].map((ch, idx) => (
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
                        style={{ width: cellSize, height: cellSize }}
                        onClick={() => handleSquareClick(row, col)}
                      >
                        {renderSquareOverlay(row, col)}
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
                          {renderPiece(board?.[row]?.[col])}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
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
                  {['一', '二', '三', '四', '五', '六', '七', '八', '九'].map((ch, idx) => (
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
        <div className="order-3 md:order-none md:flex md:flex-col md:justify-end h-full min-h-0">
          {renderCaptured(boardFlipped ? PLAYERS.GOTE : PLAYERS.SENTE)}
        </div>
      </div>
    </div>
  );
};

export default ShogiBoard;
