
import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useIsMountedRef } from '@/hooks/useIsMountedRef';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog';
import ShogiBoard from '@/components/game/ShogiBoard';
import eyeIcon from '@/assets/icons/eye.svg';
import eyeSlashIcon from '@/assets/icons/eye-slash.svg';
import chatBubbleIcon from '@/assets/icons/chat_bubble.svg';
import leftIcon from '@/assets/icons/left.svg';
import flagIcon from '@/assets/icons/flag.svg';
import { createInitialBoard, makeMove, makeDrop, PLAYERS, PIECE_NAMES } from '@/utils/shogiLogic';
import { parseUsi } from '@/utils/usi';
import { parseSfen, DEFAULT_START_SFEN } from '@/utils/sfen';
import websocketService from '@/services/websocketService';
import api from '@/services/apiClient';
import useSound from '@/hooks/useSound';
import { useIsMobile } from '@/hooks/use-mobile';
import { useBackNavigationLock } from '@/hooks/useBackNavigationLock';
import { getDeviceFlags, listenDeviceFlags } from '@/utils/deviceFlags';
import AnalysisPvReplayOverlay from '@/components/game/AnalysisPvReplayOverlay';
// global gate for finished modal (avoid double overlay across multiple mounts)
if (typeof window !== 'undefined') { window.__gameFinishedGate ||= {}; }

import { useAuth } from '@/contexts/AuthContext';
import { useOnlineUsers } from '@/contexts/OnlineUsersContext';
import { t, getLanguage } from '@/i18n';
import { gameErrorMessage } from '@/i18n/gameErrors';

function formatMsToMMSS(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function extractGameId(raw) {
  const p = raw?.game_state || raw || {};
  const gid = (p.game_id != null ? p.game_id : (p.id != null ? p.id : null));
  if (gid == null) return null;
  try { return String(gid); } catch { return null; }
}
function normalizeTime(payload) {
  // 新形式: time_effective + time_effective_breakdown を優先（正規フロー）
  if (payload.time_effective && payload.game_state) {
    const te = payload.time_effective || {};
    const br = payload.time_effective_breakdown || null;
    const current = payload.game_state.current_turn || 'sente';
    return {
      base_at: (typeof te.server_ts === 'number' ? te.server_ts : Date.now()),
      current_player: current,
      sente_left: te.sente_ms ?? payload.time_state?.sente_time_left ?? payload.time_state?.sente?.left_ms ?? 0,
      gote_left:  te.gote_ms  ?? payload.time_state?.gote_time_left  ?? payload.time_state?.gote?.left_ms  ?? 0,
      breakdown: br && typeof br === 'object' ? {
        sente: {
          initial_ms: Math.max(0, parseInt(br?.sente?.initial_ms ?? 0)),
          byoyomi_ms: Math.max(0, parseInt(br?.sente?.byoyomi_ms ?? 0)),
          deferment_ms: Math.max(0, parseInt(br?.sente?.deferment_ms ?? 0)),
        },
        gote: {
          initial_ms: Math.max(0, parseInt(br?.gote?.initial_ms ?? 0)),
          byoyomi_ms: Math.max(0, parseInt(br?.gote?.byoyomi_ms ?? 0)),
          deferment_ms: Math.max(0, parseInt(br?.gote?.deferment_ms ?? 0)),
        }
      } : null,
      config: (payload.time_config || payload.time_state?.config || null),
          source: 'effective',
    };
  }
  // 旧形式: 平坦（互換観測専用。UIはフォールバックしない）
  const ts = payload.time_state || payload;
  if (ts && (typeof ts.sente_time_left === 'number' || typeof ts.gote_time_left === 'number')) {
    return {
      base_at: Date.now(),
      current_player: (payload.game_state?.current_turn || ts.current_player || 'sente'),
      sente_left: ts.sente_time_left ?? 0,
      gote_left: ts.gote_time_left ?? 0,
      breakdown: ts.breakdown || null,
      config: (payload.time_config || payload.time_state?.config || null),
          source: 'flat',
    };
  }
  // 旧形式: ネスト
  if (ts && (ts.sente || ts.gote)) {
    return {
      base_at: Date.now(),
      current_player: (payload.game_state?.current_turn || ts.current_player || 'sente'),
      sente_left: ts.sente?.left_ms ?? 0,
      gote_left: ts.gote?.left_ms ?? 0,
      breakdown: {
        sente: ts.sente ? {
          initial_ms: Math.max(0, parseInt(ts.sente.initial_ms ?? 0)),
          byoyomi_ms: Math.max(0, parseInt(ts.sente.byoyomi_ms ?? 0)),
          deferment_ms: Math.max(0, parseInt(ts.sente.deferment_ms ?? 0)),
        } : null,
        gote: ts.gote ? {
          initial_ms: Math.max(0, parseInt(ts.gote.initial_ms ?? 0)),
          byoyomi_ms: Math.max(0, parseInt(ts.gote.byoyomi_ms ?? 0)),
          deferment_ms: Math.max(0, parseInt(ts.gote.deferment_ms ?? 0)),
        } : null,
      },
      config: (payload.time_config || payload.time_state?.config || null),
          source: 'nested',
    };
  }
  return null;
}

function useTickingClock(norm) {
  const [now, setNow] = useState(() => Date.now());

  // サーバーの time_state に合わせて、ローカルで秒針を進める
  useEffect(() => {
    setNow(Date.now());
    const timerId = setInterval(() => setNow(Date.now()), 250);
    const onVis = () => setNow(Date.now());
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(timerId);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [norm?.base_at, norm?.current_player, norm?.sente_left, norm?.gote_left]);

  return useMemo(() => {
    if (!norm) return { sente: 0, gote: 0 };
    const base = norm.base_at || now;
    const elapsed = Math.max(0, now - base);
    const sente = Math.max(0, norm.sente_left - (norm.current_player === 'sente' ? elapsed : 0));
    const gote  = Math.max(0, norm.gote_left  - (norm.current_player === 'gote'  ? elapsed : 0));
    return { sente, gote };
  }, [norm, now]);
}

function computeIsSe2Size() {
  try {
    if (typeof window === 'undefined') return false;

    const vv = window.visualViewport;
    const vw = (vv?.width ?? window.innerWidth ?? 0);
    const vh = (vv?.height ?? window.innerHeight ?? 0);
    const sw = (window.screen?.width ?? 0);
    const sh = (window.screen?.height ?? 0);

    // Prefer screen.* when it looks sane, but fall back to viewport on iOS Safari quirks / desktop UA.
    const baseW = (sw > 0 && sh > 0) ? sw : vw;
    const baseH = (sw > 0 && sh > 0) ? sh : vh;

    const short = Math.min(baseW, baseH);
    const long = Math.max(baseW, baseH);

    // iPhone SE (2nd gen) / iPhone 8 相当: 375x667 付近（拡大表示でも 320x568 に落ちることがある）
    const isSmallPhone = (short > 0 && long > 0 && short <= 390 && long <= 740);

    // iOS の「デスクトップ用Webサイト」等で UA が Macintosh になるケースがあるので、タッチ情報も見る
    const ua = (navigator?.userAgent || '');
    const maxTouch = Number(navigator?.maxTouchPoints || 0);
    const coarse = !!(window.matchMedia?.('(pointer: coarse)').matches);
    const isTouchDevice = (maxTouch >= 2) || coarse;

    const looksLikeIOS =
      /iPhone|iPod/.test(ua) ||
      // iOS Safari "desktop site": Macintosh + touch
      (/Macintosh/.test(ua) && isTouchDevice);

    return !!(isSmallPhone && looksLikeIOS);
  } catch {
    return false;
  }
}


// --- icons (inline SVG) ---
function ExpandIcon({ className = '' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="15 3 21 3 21 9" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function ShrinkIcon({ className = '' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="9 3 3 3 3 9" />
      <line x1="3" y1="3" x2="10" y2="10" />
      <polyline points="15 21 21 21 21 15" />
      <line x1="21" y1="21" x2="14" y2="14" />
    </svg>
  );
}

function PlayCircleIcon({ className = '' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <polygon points="11 9 16 12 11 15 11 9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CollapseIcon({ className = '' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="6 10 12 16 18 10" />
    </svg>
  );
}


function MoveConfirmToggle({
  id,
  checked,
  onChange,
  labelClassName = 'text-xs text-slate-700 select-none',
  wrapperClassName = '',
}) {
  const label = t("ui.components.game.gameview.k2368116e");
  const len = (label || '').length;
  const fitClass = (len >= 18)
    ? ' text-[10px] tracking-tight'
    : (len >= 14)
      ? ' text-[11px] tracking-tight'
      : '';

  return (
    <div
      className={
        "inline-flex items-center gap-1.5 whitespace-nowrap bg-white/90 border border-white/80 shadow-sm rounded-full h-8 px-2 overflow-hidden relative isolate min-w-0" +
        (wrapperClassName ? (" " + wrapperClassName) : "")
      }
    >
      <Checkbox
        id={id}
        checked={!!checked}
        onCheckedChange={(v) => { try { onChange?.(!!v); } catch {} }}
        className="h-4 w-4"
        aria-label={label}
      />
      <Label
        htmlFor={id}
        title={label}
        className={labelClassName + ' leading-none min-w-0 overflow-hidden text-clip' + fitClass}
      >
        {label}
      </Label>
    </div>
  );
}



function SharedBoardToggle({
  id,
  checked,
  onChange,
  disabled = false,
  label = t("ui.components.game.gameview.kbb3504ff"),
  labelClassName = "text-xs text-slate-700 select-none",
  wrapperClassName = '',
}) {
  const len = (label || '').length;
  const fitClass = (len >= 18)
    ? ' text-[10px] tracking-tight'
    : (len >= 14)
      ? ' text-[11px] tracking-tight'
      : '';

  return (
    <div
      className={
        "inline-flex items-center gap-1.5 whitespace-nowrap bg-white/90 border border-white/80 shadow-sm rounded-full h-8 px-2 overflow-hidden relative isolate min-w-0" +
        (wrapperClassName ? (" " + wrapperClassName) : "") +
        (disabled ? " opacity-50" : "")
      }
    >
      <Switch
        id={id}
        checked={!!checked}
        onCheckedChange={(v) => { try { if (onChange) onChange(!!v); } catch {} }}
        disabled={!!disabled}
      />
      <Label
        htmlFor={id}
        title={label}
        className={labelClassName + ' leading-none min-w-0 overflow-hidden text-clip' + fitClass}
      >
        {label}
      </Label>
    </div>
  );
}


// ---- Analysis UI (module scope) ----
// NOTE: These components are defined at module scope so they are not re-mounted on every GameView re-render.
//       (GameView updates `now` every 250ms; defining components inside it causes hover/click flicker.)

const AnalysisGraphSvg = ({
  values,
  highlightMove,
  onSelectMove = null,
  compact = false,
  className = "w-full h-[70px]",
}) => {
  try {
    const arr = Array.isArray(values) ? values : [];
    const n = arr.length;
    const present = arr.filter(v => typeof v === 'number' && Number.isFinite(v));
    if (!n || present.length === 0) return null;

    const maxAbsRaw = Math.max(...present.map(v => Math.abs(v)));
    const maxAbs = Math.max(1000, Math.min(6000, maxAbsRaw || 0));

    const LABEL_W = compact ? 0 : 18;
    const PLOT_W = 100;
    const W = LABEL_W + PLOT_W;
    const H = compact ? 24 : 40;
    const mid = H / 2;
    const amp = (H / 2) - 2;
    const yTop = mid - amp;
    const yBot = mid + amp;

    // minor grid lines every 1000 (thin)
    const minorTicks = [];
    if (!compact) {
      const minorStep = 1000;
      for (let v = minorStep; v < maxAbs; v += minorStep) {
        minorTicks.push(v, -v);
      }
      minorTicks.sort((a, b) => b - a);
    }

    const clamp = (v) => Math.max(-maxAbs, Math.min(maxAbs, v));
    let d = '';
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (!(typeof v === 'number' && Number.isFinite(v))) {
        started = false;
        continue;
      }
      const x = LABEL_W + ((n <= 1) ? 0 : (i / (n - 1)) * PLOT_W);
      const y = mid - (clamp(v) / maxAbs) * amp;
      d += started ? ` L ${x} ${y}` : `M ${x} ${y}`;
      started = true;
    }

    const hi = (typeof highlightMove === 'number' && highlightMove > 0) ? (highlightMove - 1) : null;
    const hx = (hi != null && n > 1) ? (LABEL_W + (hi / (n - 1)) * PLOT_W) : (hi === 0 ? LABEL_W : null);

    const handlePointerDown = (e) => {
      try {
        if (!onSelectMove) return;
        if (!n) return;

        const clientX = (e?.clientX ?? e?.touches?.[0]?.clientX ?? e?.changedTouches?.[0]?.clientX ?? null);
        const clientY = (e?.clientY ?? e?.touches?.[0]?.clientY ?? e?.changedTouches?.[0]?.clientY ?? null);
        if (clientX == null) return;

        const svg = e.currentTarget;
        let ux = null;

        // Map screen coordinate -> SVG user coordinate (viewBox) to avoid letterboxing issues.
        try {
          if (clientY != null && svg?.createSVGPoint && svg?.getScreenCTM) {
            const pt = svg.createSVGPoint();
            pt.x = clientX;
            pt.y = clientY;
            const ctm = svg.getScreenCTM();
            if (ctm) {
              const p = pt.matrixTransform(ctm.inverse());
              if (p && typeof p.x === 'number' && Number.isFinite(p.x)) ux = p.x;
            }
          }
        } catch {}

        // Fallback: proportional in the element's pixel width.
        if (ux == null) {
          const rect = svg.getBoundingClientRect();
          const w = rect.width || 1;
          const x = clientX - rect.left;
          ux = (x / w) * W;
        }

        const plotUx = Math.max(0, Math.min(PLOT_W, ux - LABEL_W));
        const r = (PLOT_W > 0) ? (plotUx / PLOT_W) : 0;
        const idx0 = (n <= 1) ? 0 : Math.round(r * (n - 1));
        onSelectMove(idx0 + 1);
      } catch {}
    };

    const svgClass = `${className}${onSelectMove ? ' cursor-pointer select-none' : ''}`;

    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={svgClass}
        aria-label={t("ui.components.game.gameview.k8bed108e")}
        role={onSelectMove ? "button" : undefined}
        preserveAspectRatio="none"
        onMouseDown={handlePointerDown}
        onTouchStart={handlePointerDown}
      >
        <rect x="0" y="0" width={W} height={H} fill="transparent" pointerEvents="all" />
        <line x1={LABEL_W} y1={mid} x2={W} y2={mid} stroke="currentColor" strokeOpacity={compact ? "0.18" : "0.25"} strokeWidth="0.7" />
        {!compact ? (
          <>
            {minorTicks.map((tv, i) => {
              const y = mid - (tv / maxAbs) * amp;
              return (
                <line
                  key={`minor-${tv}-${i}`}
                  x1={LABEL_W}
                  y1={y}
                  x2={W}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity="0.10"
                  strokeWidth="0.5"
                />
              );
            })}
            <line x1={LABEL_W} y1={yTop} x2={W} y2={yTop} stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.7" />
            <line x1={LABEL_W} y1={yBot} x2={W} y2={yBot} stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.7" />
            <line x1={LABEL_W} y1="0" x2={LABEL_W} y2={H} stroke="currentColor" strokeOpacity="0.18" strokeWidth="0.8" />
            <text x={LABEL_W - 1} y={yTop + 4} textAnchor="end" fontSize="4" fill="currentColor" fillOpacity="0.7" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">{`+${maxAbs}`}</text>
            <text x={LABEL_W - 1} y={mid + 1.8} textAnchor="end" fontSize="4" fill="currentColor" fillOpacity="0.55" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">0</text>
            <text x={LABEL_W - 1} y={yBot - 1} textAnchor="end" fontSize="4" fill="currentColor" fillOpacity="0.7" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">{`-${maxAbs}`}</text>
          </>
        ) : null}
        {hx != null ? (
          <line x1={hx} y1="0" x2={hx} y2={H} stroke="currentColor" strokeOpacity={compact ? "0.35" : "0.30"} strokeWidth={compact ? "1.3" : "1.0"} />
        ) : null}
        <path d={d} fill="none" stroke="currentColor" strokeOpacity={compact ? "0.75" : "0.65"} strokeWidth={compact ? "1.6" : "1.2"} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  } catch {
    return null;
  }
};

const AnalysisPanel = ({
  analysisDerived,
  gameState,
  isFinished,
  suppressEvalDisplay,
  suppressBestDisplay = false,
  highlightMove,
  showHeader = true,
  onSelectMove = null,
  fillHeight = false,
  graphSize = 'normal',
  className = "",
  deriveStateFromHistory,
  applyUsiToState,
  usiToKifMove,
  extractAnalysisFromMove,
  formatEvalText,
  onOpenPvReplay,
}) => {
  const total = analysisDerived?.total ?? 0;
  const progress = analysisDerived?.progress ?? 0;
  const values = analysisDerived?.values ?? [];
  const status = analysisDerived?.status ?? null;
  const errorText = analysisDerived?.error ?? null;
  const done = (status === 'done') || (total > 0 && progress >= total);
  const isError = (status === 'error') || (typeof errorText === 'string' && errorText.trim());
  const noDataDone = (!isError && status === 'done' && total > 0 && progress <= 0);
  const noTarget = (!isError && status === 'done' && total <= 0);

  let msg = t('ui.components.game.gameview.kb01d1f60');
  if (isError) msg = t('ui.components.game.gameview.k93aed38d');
  else if (noTarget) msg = t('ui.components.game.gameview.kfcca9c16');
  else if (noDataDone) msg = t('ui.components.game.gameview.kab07aecc');
  else if (isFinished && status === 'queued') msg = t('ui.components.game.gameview.k604ef280');
  else if (isFinished && status === 'running' && progress <= 0 && total > 0) msg = t('ui.components.game.gameview.k2719c3a9', { progress: 0, total });
  else if (isFinished && progress <= 0) msg = t('ui.components.game.gameview.k77eb6328');
  else if (isFinished && progress > 0 && progress < total) msg = t('ui.components.game.gameview.kb6c0bd57', { progress, total });
  else if (done && total > 0) msg = t('ui.components.game.gameview.k13dafedd');

  const graphBoxCls =
    graphSize === 'large'
      ? 'rounded-xl border border-white/70 bg-white/70 backdrop-blur-sm p-3 shadow-sm'
      : (graphSize === 'small'
          ? 'rounded-lg border border-white/70 bg-white/60 backdrop-blur-sm px-3 py-2 shadow-sm'
          : 'rounded-xl border border-white/70 bg-white/70 backdrop-blur-sm p-3 shadow-sm');

  const graphSvgCls =
    graphSize === 'large'
      ? 'w-full h-[92px]'
      : (graphSize === 'small' ? 'w-full h-[58px]' : 'w-full h-[70px]');

  const msgBoxCls =
    graphSize === 'small'
      ? 'rounded-lg border border-white/70 bg-white/60 backdrop-blur-sm px-3 py-2 text-sm text-slate-600'
      : 'rounded-xl border border-white/70 bg-white/70 backdrop-blur-sm p-3 text-sm text-slate-600 shadow-sm';

  const headerCls = showHeader
    ? 'mb-2 flex items-center justify-between gap-2'
    : 'mb-1 flex items-center justify-between gap-2';

  const viewMoveN = (typeof highlightMove === 'number' && Number.isFinite(highlightMove)) ? Math.trunc(highlightMove) : 0;
  const histLocal = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
  let viewAnalysis = null;
  if (viewMoveN > 0 && viewMoveN <= histLocal.length) {
    try { viewAnalysis = extractAnalysisFromMove ? extractAnalysisFromMove(histLocal[viewMoveN - 1]) : null; } catch { viewAnalysis = null; }
  }

  const topEval = (!suppressEvalDisplay && viewAnalysis) ? (formatEvalText ? formatEvalText(viewAnalysis, viewMoveN) : null) : null;

  // PV: normalized list of USI moves
  const normalizePvUsiList = (analysis) => {
    try {
      if (!analysis || typeof analysis !== 'object') return [];
      const pv0 = Array.isArray(analysis.main_pv)
        ? analysis.main_pv
        : (Array.isArray(analysis.pv) ? analysis.pv : []);
      const list = (pv0 || []).map((x) => String(x || '').trim()).filter(Boolean);
      return list;
    } catch {
      return [];
    }
  };

  let posStateForBest = null;
  try {
    if (deriveStateFromHistory) {
      const idx = Math.max(0, Math.min(viewMoveN, histLocal.length));
      posStateForBest = deriveStateFromHistory(histLocal, idx);
    }
  } catch { posStateForBest = null; }

  const topPvUsi = normalizePvUsiList(viewAnalysis);
  const canPvReplay = (!suppressBestDisplay) && !!(posStateForBest && topPvUsi.length > 0);

  const topBest = (topPvUsi && topPvUsi.length) ? topPvUsi[0] : null;
  const topBestKif = topBest ? ((usiToKifMove ? usiToKifMove(topBest, posStateForBest) : null) || topBest) : null;
  const topBestDisp = topBestKif ? topBestKif : null;
  const topBestLabel = suppressBestDisplay ? '-' : (topBestDisp ?? '-');

  const openPvReplay = () => {
    try {
      if (!canPvReplay) return;
      const baseMoveNumber = viewMoveN;
      let st = { ...posStateForBest };

      const pvMoves = [];
      const maxPlies = 60; // safety cap
      for (let i = 0; i < Math.min(topPvUsi.length, maxPlies); i += 1) {
        const usi = topPvUsi[i];
        if (!usi) break;
        const core = (usiToKifMove ? usiToKifMove(usi, st) : null) || usi;
        const mark = ((baseMoveNumber + i) % 2 === 0) ? '▲' : '△';
        pvMoves.push({ usi, kif: `${mark}${core}` });
        const next = applyUsiToState ? applyUsiToState(st, usi) : null;
        if (!next) break;
        st = next;
      }
      if (!pvMoves.length) return;
      if (onOpenPvReplay) onOpenPvReplay({ baseMoveNumber, baseState: posStateForBest, pvMoves });
    } catch {}
  };

  const statusLabel = isError
    ? t('ui.components.game.gameview.kec6399d6')
    : (noDataDone ? t('ui.components.game.gameview.k1a2e920b') : (done ? t('ui.components.game.gameview.k1cae18a9') : (progress > 0 ? t('ui.components.game.gameview.k8807e099') : (isFinished ? t('ui.components.game.gameview.k7102bf83') : t('ui.components.game.gameview.k5e5efe80')))));
  const statusCls = isError
    ? 'text-red-700 font-semibold'
    : (noDataDone ? 'text-amber-800 font-semibold' : (done ? 'text-emerald-700 font-semibold' : 'text-slate-700 font-semibold'));

  const msgNode = (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm text-slate-600 truncate">{msg}</div>
      {total > 0 && progress > 0 && progress < total ? (
        <div className="text-xs text-slate-600 shrink-0 font-mono">{`${progress}/${total}`}</div>
      ) : null}
    </div>
  );

  return (
    <div className={className}>
      {showHeader ? (
        <div className={headerCls}>
          <div className="text-xs text-slate-600">{t('ui.components.game.gameview.kaf57b02c')}</div>
          <div className="flex items-center gap-3 text-xs font-mono whitespace-nowrap overflow-x-auto max-w-[72%]">
            {statusLabel ? (<span className={statusCls}>{statusLabel}</span>) : null}
          </div>
        </div>
      ) : null}

      {(progress > 0) ? (
        <div className={graphBoxCls}>
          <div className="flex items-center gap-2 mb-1">
            <div className="text-[11px] text-slate-600 shrink-0">{t('ui.components.game.gameview.k1b05b044')}</div>
            <div className="flex-1 min-w-0 overflow-x-auto">
              <div className="text-[11px] text-slate-700 font-mono flex items-center justify-end gap-4 whitespace-nowrap">
                {!suppressEvalDisplay ? (<span>{t('ui.components.game.gameview.k27a85ea6')} {topEval ?? '-'}</span>) : null}
                <button
                  type="button"
                  className={
                    `inline-flex items-center gap-1 rounded-full px-2.5 py-1 border text-[11px] sm:text-xs font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white ` +
                    (canPvReplay
                      ? 'bg-sky-600 text-white border-sky-700/30 hover:bg-sky-500 active:bg-sky-700 cursor-pointer'
                      : 'bg-slate-200/70 text-slate-500 border-slate-200 opacity-70 cursor-default')
                  }
                  onPointerDown={(e) => { try { e.stopPropagation(); } catch {} }}
                  onClick={(e) => { try { e.preventDefault(); e.stopPropagation(); openPvReplay(); } catch {} }}
                  disabled={!canPvReplay}
                  title={canPvReplay ? t('ui.components.game.gameview.k392d51d7') : ''}
                >
                  <span>{t('ui.components.game.gameview.k90485549', { move: topBestLabel })}</span>
                  <PlayCircleIcon className="w-[18px] h-[18px] shrink-0" />
                </button>
              </div>
            </div>
          </div>
          <div className={`text-slate-700${fillHeight ? ' flex-1 min-h-0' : ''}`}>
            <AnalysisGraphSvg
              values={values}
              highlightMove={highlightMove}
              onSelectMove={onSelectMove}
              className={graphSvgCls}
            />
          </div>
        </div>
      ) : (
        <div className={msgBoxCls}>
          {msgNode}
        </div>
      )}

      {(isError && progress > 0) ? (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700">
          <div className="font-semibold mb-1">{t('ui.components.game.gameview.k93aed38d')}</div>
          <div className="font-mono break-words">{(typeof errorText === 'string' && errorText.trim()) ? errorText.trim() : t('ui.components.game.gameview.k5d6cc511')}</div>
        </div>
      ) : null}

      {(!showHeader && !isError && !noDataDone && isFinished && progress > 0 && total > 0 && progress < total) ? (
        <div className="mt-2 text-xs text-slate-600">{t('ui.components.game.gameview.kb6c0bd57', { progress, total })}</div>
      ) : null}
      {(!isError && !noDataDone && isFinished && progress <= 0) ? (
        <div className="mt-2 text-xs text-slate-600">{t('ui.components.game.gameview.k2476ed09')}</div>
      ) : null}
    </div>
  );
};

const AnalysisBarCompact = ({
  analysisDerived,
  gameState,
  isFinished,
  suppressBestDisplay = false,
  highlightMove,
  onSelectMove = null,
  className = "",
  deriveStateFromHistory,
  applyUsiToState,
  usiToKifMove,
  extractAnalysisFromMove,
  onOpenPvReplay,
}) => {
  const total = analysisDerived?.total ?? 0;
  const progress = analysisDerived?.progress ?? 0;
  const values = analysisDerived?.values ?? [];
  const status = analysisDerived?.status ?? null;
  const errorText = analysisDerived?.error ?? null;
  const done = (status === 'done') || (total > 0 && progress >= total);
  const isError = (status === 'error') || (typeof errorText === 'string' && errorText.trim());
  const noDataDone = (!isError && status === 'done' && total > 0 && progress <= 0);
  const noTarget = (!isError && status === 'done' && total <= 0);

  let msg = t('ui.components.game.gameview.kb01d1f60');
  if (isError) msg = t('ui.components.game.gameview.k93aed38d');
  else if (noTarget) msg = t('ui.components.game.gameview.kfcca9c16');
  else if (noDataDone) msg = t('ui.components.game.gameview.kab07aecc');
  else if (isFinished && status === 'queued') msg = t('ui.components.game.gameview.k604ef280');
  else if (isFinished && status === 'running' && progress <= 0 && total > 0) msg = t('ui.components.game.gameview.k2719c3a9', { progress: 0, total });
  else if (isFinished && progress <= 0) msg = t('ui.components.game.gameview.k77eb6328');
  else if (isFinished && progress > 0 && progress < total) msg = t('ui.components.game.gameview.kb6c0bd57', { progress, total });
  else if (done && total > 0) msg = t('ui.components.game.gameview.k13dafedd');

  // 右端の数値表示は「解析中のみ」。終わったら何も出さない。
  let right = '';
  if (isError) right = t('ui.components.game.gameview.kec6399d6');
  else if (noDataDone) right = (total > 0 ? t('ui.components.game.gameview.k47581901', { progress: 0, total }) : t('ui.components.game.gameview.k1a2e920b'));
  else if (!done && total > 0) right = `${progress}/${total}`;
  else if (!done && progress > 0) right = `${progress}`;

  const rootCls = `w-full flex items-center gap-2 bg-white/70 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-sm border border-white/80${className ? ` ${className}` : ''}`;

  // PV再生（SE2用）: 現在局面の最善手の読み筋をオーバーレイで再生する
  const topMoveN = (typeof highlightMove === 'number' && Number.isFinite(highlightMove)) ? Math.trunc(highlightMove) : 0;
  const histLocal = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
  let topAnalysis = null;
  if (topMoveN > 0 && topMoveN <= histLocal.length) {
    try { topAnalysis = extractAnalysisFromMove ? extractAnalysisFromMove(histLocal[topMoveN - 1]) : null; } catch { topAnalysis = null; }
  }

  let posStateForBest = null;
  try {
    if (deriveStateFromHistory) {
      const idx = Math.max(0, Math.min(topMoveN, histLocal.length));
      posStateForBest = deriveStateFromHistory(histLocal, idx);
    }
  } catch {}

  let topPvUsi = [];
  try {
    const pv0 = (topAnalysis && typeof topAnalysis === 'object')
      ? (Array.isArray(topAnalysis.main_pv) ? topAnalysis.main_pv
        : (Array.isArray(topAnalysis.pv) ? topAnalysis.pv : []))
      : [];
    topPvUsi = (pv0 || []).map((x) => String(x || '').trim()).filter(Boolean);
  } catch { topPvUsi = []; }

  const canPvReplay = (!suppressBestDisplay) && !!(posStateForBest && topPvUsi.length > 0);

  const openPvReplay = () => {
    try {
      if (!canPvReplay) return;
      const baseMoveNumber = topMoveN;
      let st = { ...posStateForBest };

      const pvMoves = [];
      const maxPlies = 60; // safety cap
      for (let i = 0; i < Math.min(topPvUsi.length, maxPlies); i += 1) {
        const usi = topPvUsi[i];
        if (!usi) break;
        const core = (usiToKifMove ? usiToKifMove(usi, st) : null) || usi;
        const mark = ((baseMoveNumber + i) % 2 === 0) ? '▲' : '△';
        pvMoves.push({ usi, kif: `${mark}${core}` });
        const next = applyUsiToState ? applyUsiToState(st, usi) : null;
        if (!next) break;
        st = next;
      }
      if (!pvMoves.length) return;
      if (onOpenPvReplay) onOpenPvReplay({ baseMoveNumber, baseState: posStateForBest, pvMoves });
    } catch {}
  };

  const iconToneCls = isError ? 'text-red-700' : (noDataDone ? 'text-amber-800' : 'text-slate-700');
  const playBtnCls = canPvReplay
    ? 'shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-sky-600 text-white border border-sky-700/30 shadow-sm transition-colors hover:bg-sky-500 active:bg-sky-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white'
    : `shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-white/90 border border-white/80 shadow-sm ${iconToneCls} opacity-60 cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white`;

  return (
    <div className={rootCls}>
      <button
        type="button"
        className={playBtnCls}
        onClick={() => { try { openPvReplay(); } catch {} }}
        disabled={!canPvReplay}
        aria-label={t('ui.components.game.gameview.k392d51d7')}
        title={canPvReplay ? t('ui.components.game.gameview.k392d51d7') : (isError ? t('ui.components.game.gameview.k93aed38d') : (noDataDone ? t('ui.components.game.gameview.k7f11636e') : t('ui.components.game.gameview.kd065182a')))}
      >
        <PlayCircleIcon className="w-5 h-5" />
      </button>

      <div className="flex-1 min-w-0">
        {(progress > 0) ? (
          <AnalysisGraphSvg
            values={values}
            highlightMove={highlightMove}
            onSelectMove={onSelectMove}
            compact={true}
            className="w-full h-[32px]"
          />
        ) : (
          <div className={`text-xs truncate ${isError ? 'text-red-700' : (noDataDone ? 'text-amber-800' : 'text-slate-600')}`}>{msg}</div>
        )}
      </div>
      {right ? (
        <div className={`text-xs font-mono shrink-0 ${isError ? 'text-red-700' : (noDataDone ? 'text-amber-800' : 'text-slate-600')}`}>{right}</div>
      ) : null}
    </div>
  );
};
// ---- /Analysis UI ----

const GameView = ({
  gameId,
  isSpectator = false,
  onLeaveGame,
  onRequestClose,
  shellWidthMode = "normal",
  onChangeShellWidthMode,
  coordVisible: coordVisibleProp,
  onChangeCoordVisible,
  moveConfirmEnabled: moveConfirmEnabledProp,
  onChangeMoveConfirmEnabled,
  reviewDrawNextMove = false,
  reviewDrawBestMove = false,
  lastMoveFromHighlightEnabled = true,
  lastMovePieceHighlightEnabled = true,
}) => {
  const isMountedRef = useIsMountedRef();
  const isMobile = useIsMobile();
  // Smartphone only: prevent accidental browser back (gesture/back button) from leaving the match screen.
  useBackNavigationLock(isMobile);
  const { user, fetchProfile } = useAuth();
  const onlineUsersCtx = useOnlineUsers() || {};
  const { getUserById: getOnlineUserById, applyUserDiff: applyOnlineUsersDiff } = onlineUsersCtx;
  const { playEnv, playSfx, preload } = useSound();
  const exitSoundPlayedRef = useRef(false);

  const [gameState, setGameState] = useState(null);
  const [coordVisibleInner, setCoordVisibleInner] = useState(true);
  const coordVisible = (typeof coordVisibleProp === 'boolean') ? coordVisibleProp : coordVisibleInner;
  const setCoordVisible = onChangeCoordVisible || setCoordVisibleInner;

  const [moveConfirmEnabledInner, setMoveConfirmEnabledInner] = useState(() => {
    try {
      const v = window?.localStorage?.getItem('shogi_moveConfirmEnabled');
      return v === '1';
    } catch {
      return false;
    }
  });
  const moveConfirmEnabled = (typeof moveConfirmEnabledProp === 'boolean') ? moveConfirmEnabledProp : moveConfirmEnabledInner;
  const setMoveConfirmEnabled = onChangeMoveConfirmEnabled || setMoveConfirmEnabledInner;

  useEffect(() => {
    try { localStorage.setItem('shogi_moveConfirmEnabled', moveConfirmEnabled ? '1' : '0'); } catch {}
  }, [moveConfirmEnabled]);
  const [timeStateNorm, setTimeStateNorm] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  // === ローカル見返し（リプレイ）用の状態 ===
  const [reviewIndex, setReviewIndex] = useState(0);
  // ローカル分岐（本譜と同期しない、対局者のみ）
  // - baseIndex: 分岐元の手数（reviewIndex）
  // - usiMoves: 分岐で追加した USI（時系列）
  const [localBranch, setLocalBranch] = useState(null);

  // === 共有盤（終局後のみ・サーバ同期 / 表示トグルはユーザーごと） ===
  const [sharedBoardViewEnabled, setSharedBoardViewEnabled] = useState(false);
  const [sharedBoardStatus, setSharedBoardStatus] = useState({ enabled: { sente: false, gote: false }, mutual: false });
  const [postgamePresence, setPostgamePresence] = useState(null); // { sente: bool, gote: bool }
  const [sharedBoardCursor, setSharedBoardCursor] = useState(0);
  const [sharedBoardBranch, setSharedBoardBranch] = useState(null);
  const [sharedBoardOffer, setSharedBoardOffer] = useState(null);
  const [sharedBoardOfferOpen, setSharedBoardOfferOpen] = useState(false);

  const [moveListOpen, setMoveListOpen] = useState(false);

  // === KIFコピー（手の一覧の上部ボタン / 取得は1回だけで流用） ===
  const [kifCopyStatus, setKifCopyStatus] = useState('idle'); // idle | loading | ok | err
  const kifCacheRef = useRef({ gameId: null, moveCount: null, kifText: null, promise: null });
  const kifCopyResetTimerRef = useRef(null);

  useEffect(() => {
    // 部屋（gameId）が変わったらキャッシュは無効化
    try {
      kifCacheRef.current = { gameId: (gameId != null ? String(gameId) : null), moveCount: null, kifText: null, promise: null };
    } catch {}
    try {
      if (kifCopyResetTimerRef.current) clearTimeout(kifCopyResetTimerRef.current);
      kifCopyResetTimerRef.current = null;
    } catch {}
    try { setKifCopyStatus('idle'); } catch {}
  }, [gameId]);

  useEffect(() => {
    return () => {
      try {
        if (kifCopyResetTimerRef.current) clearTimeout(kifCopyResetTimerRef.current);
        kifCopyResetTimerRef.current = null;
      } catch {}
    };
  }, []);

  const _copyTextToClipboard = async (raw) => {
    const s = String(raw ?? '');
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return;
    }
    // fallback
    if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return;
    }
    throw new Error('clipboard_unavailable');
  };

  const _getKifTextCached = async () => {
    const gid = (gameId != null) ? String(gameId) : null;
    if (!gid) throw new Error('no_game_id');
    const moveCount = Array.isArray(gameState?.move_history) ? gameState.move_history.length : null;

    const cur = kifCacheRef.current || {};
    if (cur.gameId === gid && typeof cur.kifText === 'string' && cur.kifText.length > 0) {
      // 対局中に増える可能性があるので、手数が一致する場合だけ流用
      if (moveCount == null || cur.moveCount === moveCount) return cur.kifText;
    }
    if (cur.gameId === gid && cur.promise) {
      return await cur.promise;
    }

    const prom = (async () => {
      const res = await api.get(`/kifu/${gid}`);
      if (!res?.data?.success) throw new Error(res?.data?.error_code || res?.data?.code || 'fetch_failed');
      const kifText = String(res?.data?.kifu?.kif_text || '');
      kifCacheRef.current = { gameId: gid, moveCount: moveCount, kifText, promise: null };
      return kifText;
    })();

    kifCacheRef.current = { gameId: gid, moveCount: moveCount, kifText: cur.kifText ?? null, promise: prom };
    return await prom;
  };

  const handleCopyKifFromMoveList = async () => {
    if (kifCopyStatus === 'loading') return;
    try {
      setKifCopyStatus('loading');
      const kifText = await _getKifTextCached();
      await _copyTextToClipboard(kifText);
      if (isMountedRef.current) setKifCopyStatus('ok');
    } catch (e) {
      console.warn('KIF copy failed', e);
      if (isMountedRef.current) setKifCopyStatus('err');
    } finally {
      try {
        if (kifCopyResetTimerRef.current) clearTimeout(kifCopyResetTimerRef.current);
        kifCopyResetTimerRef.current = setTimeout(() => {
          try { if (isMountedRef.current) setKifCopyStatus('idle'); } catch {}
        }, 1200);
      } catch {}
    }
  };



  const [showChatMobile, setShowChatMobile] = useState(false);
  const [hasUnreadChat, setHasUnreadChat] = useState(false);
  const [isSe2Size, setIsSe2Size] = useState(() => {
    return computeIsSe2Size();
  });
  const [isDesktop, setIsDesktop] = useState(() => {
    try { return !!getDeviceFlags().isDesktopUi; } catch { return true; }
  });
  const [splitMobileOpbar, setSplitMobileOpbar] = useState(false);
  const mobileToolsTotalPages = isSe2Size ? 3 : 2;
  const isWideDesktop = isDesktop && shellWidthMode === 'wide';
  const layoutRef = useRef(null);
  const [layoutH, setLayoutH] = useState(0);
  const [gridRows, setGridRows] = useState('auto auto');
  const totalMoves = useMemo(() => Array.isArray(gameState?.move_history) ? gameState.move_history.length : 0, [gameState?.move_history?.length]);

  const myRole = useMemo(() => {
    try {
      const me = (user?.user_id ?? user?._id ?? user?.id);
      const meId = me != null ? String(me) : '';
      const p = gameState?.players || {};
      const s = (p?.sente?.user_id ?? p?.sente?.id ?? p?.sente?._id);
      const g = (p?.gote?.user_id ?? p?.gote?.id ?? p?.gote?._id);
      const sId = s != null ? String(s) : '';
      const gId = g != null ? String(g) : '';
      if (meId && sId && meId === sId) return 'sente';
      if (meId && gId && meId === gId) return 'gote';
      return null;
    } catch {
      return null;
    }
  }, [user?.user_id, user?._id, user?.id, gameState?.players?.sente?.user_id, gameState?.players?.gote?.user_id, gameState?.players?.sente?._id, gameState?.players?.gote?._id]);

  const isPlayer = !!myRole;

  useEffect(() => {
    // 入室/終局/部屋切替のたびに、表示トグルは基本OFF（ユーザー操作でONにする）
    try { setSharedBoardViewEnabled(false); } catch {}
    try { setSharedBoardOffer(null); } catch {}
    try { setSharedBoardOfferOpen(false); } catch {}
  }, [gameId]);


  // 駒の操作時（move_history が増えたら効果音）
  const prevMovesRef = useRef(null);
  useEffect(() => {
    if (prevMovesRef.current === null) {
      prevMovesRef.current = totalMoves;
      return;
    }
    if (totalMoves > prevMovesRef.current) {
      try { playSfx?.('piece_action'); } catch {}
    }
    prevMovesRef.current = totalMoves;
  }, [totalMoves, playSfx]);

  const [spectators, setSpectators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const chatScrollRef = useRef(null);
  const chatEndRef = useRef(null);
  const isDesktopRef = useRef(true);
  const showChatMobileRef = useRef(false);
  const myUserIdRef = useRef('');
  // チャット欄は常に最新が見えるように自動スクロールする
  const pendingChatScrollBehaviorRef = useRef(null);
  const [dcOverlay, setDcOverlay] = useState({ show: false, userId: null, role: null, remainingMs: 0, startedAt: 0 });
  const [analysisOverlayCollapsed, setAnalysisOverlayCollapsed] = useState(false);
  // PC左下の解析グラフ: 現在のサイズを「通常」とし、任意で大きめ表示に切り替えられるようにする
  const [analysisOverlayGraphSize, setAnalysisOverlayGraphSize] = useState('normal'); // 'normal' | 'large'

  // 解析の最善手読み筋（PV）再生オーバーレイ
  const [pvReplayOpen, setPvReplayOpen] = useState(false);
  const [pvReplayPayload, setPvReplayPayload] = useState(null);

  // PC解析グラフの位置（ドラッグで移動。画面内に収まるように補正）
  const analysisOverlayRef = useRef(null);
  const analysisOverlayDragRef = useRef({ active: false, pointerId: null, startX: 0, startY: 0, baseX: 0, baseY: 0, moved: false });
  const suppressAnalysisOverlayClickRef = useRef(false);
  const analysisOverlayPosRef = useRef(null);
  const [analysisOverlayPos, setAnalysisOverlayPos] = useState(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem('shogi.analysisOverlayPos.v1');
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const x = Number(obj?.x);
      const y = Number(obj?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    } catch {
      return null;
    }
  });
  const [mobileToolsPage, setMobileToolsPage] = useState(0);
  const mobileToolsRef = useRef(null);
  const [mobileToolsH, setMobileToolsH] = useState(null);
  const mobileDotsRef = useRef(null);

  const scrollMobileToolsTo = (p) => {
    try {
      const el = mobileToolsRef.current;
      if (!el) return;

      const maxP = Math.max(0, (mobileToolsTotalPages || 2) - 1);
      const pp = Math.max(0, Math.min(maxP, Number.isFinite(Number(p)) ? Number(p) : 0));

      const target = el.children?.[pp];
      const left = (target && typeof target.offsetLeft === 'number')
        ? target.offsetLeft
        : (el.clientWidth || 1) * pp;

      el.scrollTo({ left, behavior: 'smooth' });
      setMobileToolsPage(pp);
    } catch {}
  };

  

  // clamp mobileToolsPage when page count changes
  useEffect(() => {
    try {
      const maxP = Math.max(0, (mobileToolsTotalPages || 2) - 1);
      if (mobileToolsPage > maxP) scrollMobileToolsTo(maxP);
    } catch {}
  }, [mobileToolsTotalPages]);
useEffect(() => {
    // keep refs fresh for WS handlers
    isDesktopRef.current = !!isDesktop;
  }, [isDesktop]);
  useEffect(() => {
    showChatMobileRef.current = !!showChatMobile;
    if (showChatMobile) setHasUnreadChat(false);
  }, [showChatMobile]);
  useEffect(() => {
    myUserIdRef.current = String(user?.user_id || user?._id || user?.id || '');
  }, [user?.user_id, user?._id, user?.id]);
  useEffect(() => {
    // Desktop UI: wide + hover + fine pointer + not iPad
    try { setIsDesktop(!!getDeviceFlags().isDesktopUi); } catch {}
    return listenDeviceFlags((flags) => {
      try { setIsDesktop(!!flags?.isDesktopUi); } catch {}
    });
  }, []);

  useEffect(() => {
    // 端末回転やアドレスバー変動でも追従
    if (typeof window === 'undefined') return;
    const recompute = () => {
      try { setIsSe2Size(computeIsSe2Size()); } catch {}
    };
    recompute();
    window.addEventListener('resize', recompute);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', recompute);
    };
  }, []);

  useEffect(() => {
    // モバイル/タブレットの操作バー: 余裕がある時だけ2段にする
    if (typeof window === 'undefined') return;
    const update = () => {
      try {
        if (isDesktop) { setSplitMobileOpbar(false); return; }
        const vv = window.visualViewport;
        const vw = (vv?.width ?? window.innerWidth ?? 0);
        const vh = (vv?.height ?? window.innerHeight ?? 0);        // 2段目(約1行)の追加分を許容できる端末/画面だけON
        // - 端末自体が十分大きい (screenベースで判定)
        // - いまの表示領域も極端に小さくない
        // - 横向きは高さが足りなくなりやすいので基本OFF
        const sw = (window.screen?.width ?? 0);
        const sh = (window.screen?.height ?? 0);
        const sShort = (sw > 0 && sh > 0) ? Math.min(sw, sh) : Math.min(vw, vh);
        const sLong  = (sw > 0 && sh > 0) ? Math.max(sw, sh) : Math.max(vw, vh);
        const isLandscape = vw > vh;
        // Galaxy Z Fold 等で「幅が 360px 未満でも高さが十分ある」ケースがあり、
        // 2段(改行)レイアウトが有効でも良いのに弾かれてしまう。
        // 短辺しきい値を少し緩めて、縦長端末では2段を許可する。
        const deviceHasRoom = (sLong >= 740 && sShort >= 340) || (vw >= 700 && vh >= 650);
        const viewportHasRoom = vh >= 600;
        const enough = (!isLandscape) && deviceHasRoom && viewportHasRoom;
        setSplitMobileOpbar((!isSe2Size) && !!enough);
      } catch {
        setSplitMobileOpbar(false);
      }
    };
    update();
    window.addEventListener('resize', update);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', update);
    };
  }, [isDesktop, isSe2Size]);

  useEffect(() => {
    // desktop では常時チャットが表示される前提なので、未読表示は使わない
    if (isDesktop) {
      setShowChatMobile(false);
      setHasUnreadChat(false);
    }
  }, [isDesktop]);

  useEffect(() => {
    // 対局切替時は未読/開閉をリセット
    setHasUnreadChat(false);
    setShowChatMobile(false);
  }, [gameId]);

  const scrollChatToBottom = (behavior = 'auto') => {
    try {
      const el = chatEndRef.current;
      if (!el) return;
      requestAnimationFrame(() => {
        try {
          el.scrollIntoView({ behavior, block: 'end' });
        } catch {
          try { el.scrollIntoView(); } catch {}
        }
      });
    } catch {}
  };

  // 接続時/履歴受信時/新規受信時/モバイル表示切替時に、常に最新が見える位置までスクロール
  useEffect(() => {
    const behavior = pendingChatScrollBehaviorRef.current ?? 'auto';
    pendingChatScrollBehaviorRef.current = null;
    scrollChatToBottom(behavior);
  }, [chatMessages?.length, showChatMobile]);

  useEffect(() => {
    const onSpecs = (p) => {
      try {
        if (p && (p.game_id === gameId || String(p.game_id) === String(gameId))) {
          setSpectators(Array.isArray(p.spectators) ? p.spectators : []);
        }
      } catch {}
    };
    try { websocketService.on('spectators_update', onSpecs); } catch {}


    try {
      if (websocketService.off) websocketService.off('game:user_disconnected');
      if (websocketService.off) websocketService.off('game:user_connected');
    } catch {}
    try {
      websocketService.on('game:user_disconnected', handleUserDisconnected);
      websocketService.on('game:user_connected', handleUserConnected);
    } catch {}
    return () => {
      try {
        websocketService.off('game:user_disconnected', handleUserDisconnected);
        websocketService.off('game:user_connected', handleUserConnected);
      } catch {}
    };
  }, [gameId, gameState?.players?.sente?.user_id, gameState?.players?.gote?.user_id, user?.user_id]);

  useEffect(() => {
    const onSpecs = (p) => {
      try {
        if (p && (p.game_id === gameId || String(p.game_id) === String(gameId))) {
          setSpectators(Array.isArray(p.spectators) ? p.spectators : []);
        }
      } catch {}
    };
    try { websocketService.on('spectators_update', onSpecs); } catch {}


    if (!dcOverlay?.show) return;
    let rafId = null;
    const tick = () => {
      const elapsed = Date.now() - (dcOverlay.startedAt || Date.now());
      const remain = Math.max(0, (dcOverlay.remainingMs || 0) - elapsed);
      setDcOverlay(prev => (prev && prev.show) ? { ...prev, _now: Date.now(), leftMsShadow: remain } : prev);
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => { if (rafId) window.cancelAnimationFrame(rafId); };
  }, [dcOverlay?.show, dcOverlay?.startedAt, dcOverlay?.remainingMs]);


  // 終局ポップアップとタイマー制御の状態
  const [resultModal, setResultModal] = useState({ open: false, title: '', message: '' });
  const [resignConfirmOpen, setResignConfirmOpen] = useState(false);

  // 着手確認（クライアント側の確定前プレビュー）
  const [pendingMove, setPendingMove] = useState(null); // { usi, baseState, baseHistoryLen, stage, sentAt }

  const [isFinished, setIsFinished] = useState(false);
  const reviewEnabled = isFinished;

  // 操作バー（PCのみ）: 盤の表示サイズに合わせて拡大
  // - 通常サイズ: 既存の1.5倍
  // - 拡大サイズ: 既存の2倍
  const opbarScaleClass = (shellWidthMode === 'wide') ? 'game-opbar-scale-200' : 'game-opbar-scale-150';
  const opbarLayoutClass = 'game-opbar-compact';
  const opbarI18nClass = (getLanguage() !== 'ja') ? 'game-opbar-i18n-tight' : '';

  // 共有盤: 表示はユーザーごと（sharedBoardViewEnabled）。操作できるのは「対局者」かつ「自分がON」のときだけ。
  const isSharedViewActive = !!(reviewEnabled && sharedBoardViewEnabled);
  const sharedEnabledForMe = (isPlayer && myRole)
    ? !!(sharedBoardStatus?.enabled && sharedBoardStatus.enabled[myRole])
    : false;
  const canOperateShared = !!(isSharedViewActive && !isSpectator && isPlayer && sharedEnabledForMe);

  // 解析グラフのドラッグ移動
  const clampAnalysisOverlayPos = (x, y) => {
    if (typeof window === 'undefined') return { x, y };
    const margin = 12;
    const el = analysisOverlayRef.current;
    const rect = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const maxX = Math.max(margin, vw - (rect.width || 0) - margin);
    const maxY = Math.max(margin, vh - (rect.height || 0) - margin);
    const nx = Math.min(maxX, Math.max(margin, x));
    const ny = Math.min(maxY, Math.max(margin, y));
    return { x: nx, y: ny };
  };

  useEffect(() => {
    analysisOverlayPosRef.current = analysisOverlayPos;
  }, [analysisOverlayPos]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isDesktop) return;
    const shouldShow = !!(isFinished || (Number(gameState?.analysis_progress ?? 0) > 0));
    if (!shouldShow) return;

    const el = analysisOverlayRef.current;
    if (!el) return;

    // 初回: 現在位置（デフォルトの左下固定）から left/top に変換して保持
    if (!analysisOverlayPos) {
      const rect = el.getBoundingClientRect();
      const next = clampAnalysisOverlayPos(rect.left, rect.top);
      setAnalysisOverlayPos(next);
      return;
    }

    // サイズ変更で画面外に出ないように補正
    const next = clampAnalysisOverlayPos(analysisOverlayPos.x, analysisOverlayPos.y);
    if (next.x !== analysisOverlayPos.x || next.y !== analysisOverlayPos.y) setAnalysisOverlayPos(next);
  }, [isDesktop, isFinished, gameState?.analysis_progress, analysisOverlayCollapsed, analysisOverlayGraphSize, analysisOverlayPos?.x, analysisOverlayPos?.y]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!analysisOverlayPos) return;
    try {
      window.localStorage.setItem('shogi.analysisOverlayPos.v1', JSON.stringify(analysisOverlayPos));
    } catch {}
  }, [analysisOverlayPos?.x, analysisOverlayPos?.y]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      try {
        const pos = analysisOverlayPosRef.current;
        if (!pos) return;
        const el = analysisOverlayRef.current;
        if (!el) return;
        const next = clampAnalysisOverlayPos(pos.x, pos.y);
        if (next.x !== pos.x || next.y !== pos.y) setAnalysisOverlayPos(next);
      } catch {}
    };
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize);
    };
  }, []);

  const onAnalysisOverlayPointerDown = (e) => {
    try {
      if (!isDesktop) return;
      if (e.button != null && e.button !== 0) return;
      const el = analysisOverlayRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cur = analysisOverlayPosRef.current || analysisOverlayPos || { x: rect.left, y: rect.top };
      analysisOverlayDragRef.current = {
        active: true,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseX: cur.x,
        baseY: cur.y,
        moved: false,
      };
      try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {}
      try { document.body.style.userSelect = 'none'; } catch {}
      try { e.preventDefault(); } catch {}
    } catch {}
  };

  const onAnalysisOverlayPointerMove = (e) => {
    try {
      const st = analysisOverlayDragRef.current;
      if (!st?.active) return;
      if (st.pointerId != null && e.pointerId !== st.pointerId) return;
      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;
      if (!st.moved && (Math.abs(dx) + Math.abs(dy)) > 3) st.moved = true;
      const next = clampAnalysisOverlayPos(st.baseX + dx, st.baseY + dy);
      setAnalysisOverlayPos(next);
      try { e.preventDefault(); } catch {}
    } catch {}
  };

  const onAnalysisOverlayPointerUp = (e) => {
    try {
      const st = analysisOverlayDragRef.current;
      if (!st?.active) return;
      if (st.pointerId != null && e.pointerId !== st.pointerId) return;
      analysisOverlayDragRef.current = { active: false, pointerId: null, startX: 0, startY: 0, baseX: 0, baseY: 0, moved: false };
      try { document.body.style.userSelect = ''; } catch {}
      if (st.moved) suppressAnalysisOverlayClickRef.current = true;
      try { e.preventDefault(); } catch {}
    } catch {}
  };
  // 再生ユーティリティ: USI の move_history から局面を導出
  // ※ start_sfen（駒落ちなど）に対応するため、初期局面は SFEN を優先する
  const deriveStateFromHistory = (moveHistory, upto, baseSfen) => {
    const hist = Array.isArray(moveHistory) ? moveHistory : [];
    const end = Math.max(0, Math.min(upto ?? hist.length, hist.length));

    // Start position: prefer start_sfen (handicap uses this).
    let startSfen = null;
    try {
      if (typeof baseSfen === 'string' && baseSfen.trim()) startSfen = baseSfen.trim();
      else if (typeof gameState?.start_sfen === 'string' && gameState.start_sfen.trim()) startSfen = gameState.start_sfen.trim();
      else if (typeof gameState?.startSfen === 'string' && gameState.startSfen.trim()) startSfen = gameState.startSfen.trim();
      else if (typeof gameState?.game_state?.start_sfen === 'string' && gameState.game_state.start_sfen.trim()) startSfen = gameState.game_state.start_sfen.trim();
      else if (typeof gameState?.game_state?.startSfen === 'string' && gameState.game_state.startSfen.trim()) startSfen = gameState.game_state.startSfen.trim();
    } catch {}

    // Fallback: if start_sfen is missing but we only need the latest position, use current SFEN.
    let parsedBase = null;
    try {
      if (!startSfen && end === hist.length) {
        const cur = (typeof gameState?.sfen === 'string' && gameState.sfen.trim()) ? gameState.sfen.trim() : null;
        if (cur) parsedBase = parseSfen(cur);
      }
    } catch {}
    if (!parsedBase) {
      parsedBase = parseSfen(startSfen || DEFAULT_START_SFEN);
    }

    let state = {
      board: parsedBase?.board || createInitialBoard(),
      capturedPieces: parsedBase?.capturedPieces || { sente: {}, gote: {} },
      currentPlayer: parsedBase?.currentPlayer || PLAYERS.SENTE,
    };

    const toNum = (v) => {
      if (v === 0 || v === '0') return 0;
      const n = Number(v);
      return Number.isInteger(n) ? n : null;
    };
    const inBounds = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < 9 && c >= 0 && c < 9;

    for (let i = 0; i < end; i++) {
      const raw = hist[i] || {};

      // 1) canonical: raw.usi (or raw.obj.usi)
      const usi = (typeof raw?.usi === 'string' ? raw.usi : (typeof raw?.obj?.usi === 'string' ? raw.obj.usi : null));
      if (usi) {
        const p = parseUsi(usi);
        if (p?.ok) {
          try {
            if (p.isDrop) {
              const res = makeDrop(state, p.toRow, p.toCol, p.pieceType);
              if (res?.success) state = { ...state, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
            } else {
              const res = makeMove(state, p.fromRow, p.fromCol, p.toRow, p.toCol, !!p.promote);
              if (res?.success) state = { ...state, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
            }
          } catch {}
          continue;
        }
      }

      // 2) fallback: legacy object formats
      const m = (raw && typeof raw === 'object' && raw.obj) ? raw.obj : raw;
      const fr = m.from || m.frm || m.f || m;
      const to = m.to || m.dst || m.t || m;
      const fromRow = toNum(m.from_row ?? m.fromRow ?? fr?.row ?? fr?.r ?? null);
      const fromCol = toNum(m.from_col ?? m.fromCol ?? fr?.col ?? fr?.c ?? null);
      const toRow = toNum(m.to_row ?? m.toRow ?? to?.row ?? to?.r ?? null);
      const toCol = toNum(m.to_col ?? m.toCol ?? to?.col ?? to?.c ?? null);
      const isDrop = !!(m.type === 'drop' || m.is_drop || m.drop || (m.piece_type && (fromRow == null || fromCol == null)));
      const promote = !!(m.promote ?? m.is_promote ?? m.promotion ?? m.is_promotion ?? m.promoted ?? m.p);
      try {
        if (isDrop) {
          const pt = (m.piece_type ?? m.piece ?? null);
          if (pt && inBounds(toRow, toCol)) {
            const res = makeDrop(state, toRow, toCol, pt);
            if (res?.success) state = { ...state, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
          }
        } else {
          if (inBounds(fromRow, fromCol) && inBounds(toRow, toCol)) {
            const res = makeMove(state, fromRow, fromCol, toRow, toCol, promote);
            if (res?.success) state = { ...state, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
          }
        }
      } catch {}
    }
    return state;
  };

  const extractUsiFromHistoryEntry = (raw) => {
    try {
      if (!raw) return null;
      if (typeof raw.usi === 'string') return raw.usi;
      if (typeof raw?.obj?.usi === 'string') return raw.obj.usi;
    } catch {}
    return null;
  };

  const applyUsiToState = (baseState, usi) => {
    if (!baseState || !usi) return null;
    try {
      const p = parseUsi(usi);
      if (!p?.ok) return null;
      if (p.isDrop) {
        const res = makeDrop(baseState, p.toRow, p.toCol, p.pieceType);
        return res?.success ? { ...baseState, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer } : null;
      }
      const res = makeMove(baseState, p.fromRow, p.fromCol, p.toRow, p.toCol, !!p.promote);
      return res?.success ? { ...baseState, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer } : null;
    } catch {
      return null;
    }
  };


  // レビュー表示用の仮想ゲーム状態を構築（サーバと同期しないローカルのみ）
    
  const displayGameState = useMemo(() => {
    if (!reviewEnabled || !gameState) return gameState;
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    const idx = Math.max(0, Math.min(reviewIndex, hist.length));
    const s = deriveStateFromHistory(hist, idx);
    return { ...s, players: gameState?.players || {}, move_history: hist.slice(0, idx) };
  }, [reviewEnabled, reviewIndex, gameState]);

  // ローカル分岐（対局者のみ・WS同期なし）
  const branchedReviewGameState = useMemo(() => {
    if (!reviewEnabled || !gameState || !localBranch) return null;
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    const baseIndex = Math.max(0, Math.min(Number(localBranch.baseIndex ?? 0), hist.length));
    const base = deriveStateFromHistory(hist, baseIndex);

    let st = { ...base };
    const usiMoves = Array.isArray(localBranch.usiMoves) ? localBranch.usiMoves : [];
    for (const usi of usiMoves) {
      const next = applyUsiToState(st, usi);
      if (!next) return null;
      st = next;
    }

    const mergedHistory = [...hist.slice(0, baseIndex)];
    for (const usi of usiMoves) mergedHistory.push({ usi, obj: { usi }, local_branch: true });

    return {
      ...st,
      players: gameState?.players || {},
      move_history: mergedHistory,
    };
  }, [reviewEnabled, gameState, localBranch]);

  const effectiveReviewGameState = branchedReviewGameState || displayGameState;
  const derivedLiveState = useMemo(() => {
    if (!gameState) return gameState;
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    const s = deriveStateFromHistory(hist, hist.length);
    return { ...s, players: gameState?.players || {}, move_history: hist };
  }, [gameState]);


  // 共有盤: 分岐がある場合は「本譜の総手数(totalMoves)」より先までカーソルが進む。
  // （例：総手数4手、2手から分岐して3手進めたら cursor=5）
  const sharedBranchInfo = useMemo(() => {
    try {
      const br0 = sharedBoardBranch;
      if (!br0 || typeof br0 !== 'object') {
        return { isBranched: false, baseIndex: null, moves: [] };
      }
      const rawMoves = Array.isArray(br0.usiMoves)
        ? br0.usiMoves
        : (Array.isArray(br0.usi_moves) ? br0.usi_moves : []);
      const moves = (rawMoves || [])
        .map((x) => String(x || '').trim())
        .filter(Boolean);
      if (!moves.length) {
        return { isBranched: false, baseIndex: null, moves: [] };
      }
      let baseIndex = 0;
      try { baseIndex = parseInt(br0.baseIndex ?? br0.base_index ?? 0); } catch { baseIndex = 0; }
      if (!Number.isFinite(baseIndex)) baseIndex = 0;
      if (baseIndex < 0) baseIndex = 0;
      if (baseIndex > totalMoves) baseIndex = totalMoves;
      return { isBranched: true, baseIndex: baseIndex, moves };
    } catch {
      return { isBranched: false, baseIndex: null, moves: [] };
    }
  }, [sharedBoardBranch, totalMoves]);

  const sharedIsBranched = !!sharedBranchInfo.isBranched;
  const sharedBranchBaseIndex = sharedIsBranched ? sharedBranchInfo.baseIndex : null;

  const sharedCursorMax = useMemo(() => {
    try {
      if (sharedIsBranched && sharedBranchBaseIndex != null) {
        return Math.max(0, Math.trunc(sharedBranchBaseIndex + (sharedBranchInfo.moves?.length || 0)));
      }
      return Math.max(0, Math.trunc(totalMoves));
    } catch {
      return Math.max(0, Math.trunc(totalMoves));
    }
  }, [sharedIsBranched, sharedBranchBaseIndex, sharedBranchInfo, totalMoves]);

  const sharedCursorClamped = useMemo(() => {
    try {
      const max = sharedCursorMax;
      const cur = Number.isFinite(Number(sharedBoardCursor)) ? Number(sharedBoardCursor) : max;
      return Math.max(0, Math.min(max, Math.trunc(cur)));
    } catch {
      return 0;
    }
  }, [sharedBoardCursor, sharedCursorMax]);

  // 共有盤の表示用（サーバ同期）
  const sharedDisplayGameState = useMemo(() => {
    if (!reviewEnabled || !gameState || !isSharedViewActive) return null;
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    const total = hist.length;

    // 分岐がある場合は sharedCursorMax が total より先まで伸びる。
    const cursor = Math.max(0, Math.min(sharedCursorMax, Math.trunc(sharedCursorClamped)));

    if (!sharedIsBranched || !sharedBoardBranch) {
      const s = deriveStateFromHistory(hist, Math.max(0, Math.min(total, cursor)));
      return { ...s, players: gameState?.players || {}, move_history: hist.slice(0, Math.max(0, Math.min(total, cursor))) };
    }

    const baseIndex = (sharedBranchBaseIndex != null) ? Math.max(0, Math.min(total, sharedBranchBaseIndex)) : 0;
    const moves = Array.isArray(sharedBranchInfo.moves) ? sharedBranchInfo.moves : [];

    const rel = Math.max(0, Math.min(moves.length, cursor - baseIndex));
    let st = { ...deriveStateFromHistory(hist, baseIndex) };
    const mergedHistory = [...hist.slice(0, baseIndex)];

    for (let i = 0; i < rel; i++) {
      const usi = moves[i];
      const next = applyUsiToState(st, usi);
      if (!next) break;
      st = next;
      mergedHistory.push({ usi, obj: { usi }, shared_branch: true });
    }

    return { ...st, players: gameState?.players || {}, move_history: mergedHistory };
  }, [reviewEnabled, isSharedViewActive, gameState, sharedCursorClamped, sharedCursorMax, sharedIsBranched, sharedBranchBaseIndex, sharedBranchInfo, sharedBoardBranch]);

  // --- pending move preview (client-side only) ---
  const pendingPreviewState = useMemo(() => {
    const usi = pendingMove?.usi;
    if (!usi) return null;
    const base = pendingMove?.baseState || derivedLiveState;
    if (!base || !base.board) return null;
    try {
      const p = parseUsi(usi);
      if (!p?.ok) return null;
      if (p.isDrop) {
        const res = makeDrop(base, p.toRow, p.toCol, p.pieceType);
        if (res?.success) return { ...base, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: base.currentPlayer };
        return null;
      }
      const res = makeMove(base, p.fromRow, p.fromCol, p.toRow, p.toCol, !!p.promote);
      if (res?.success) return { ...base, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: base.currentPlayer };
      return null;
    } catch {
      return null;
    }
  }, [pendingMove?.usi, pendingMove?.baseState, derivedLiveState]);

  // when server updates move history, clear local pending
  useEffect(() => {
    if (!pendingMove) return;
    const len = Array.isArray(gameState?.move_history) ? gameState.move_history.length : 0;
    const baseLen = Number.isInteger(pendingMove.baseHistoryLen) ? pendingMove.baseHistoryLen : -1;
    if (len > baseLen) {
      setPendingMove(null);
    }
  }, [gameState?.move_history?.length, pendingMove]);

  // failsafe: if we already sent the move but the server doesn't reflect it, unlock UI
  useEffect(() => {
    if (!pendingMove || pendingMove.stage !== 'sent') return;
    const timeoutId = window.setTimeout(() => {
      setPendingMove(null);
    }, 8000);
    return () => window.clearTimeout(timeoutId);
  }, [pendingMove?.stage, pendingMove?.sentAt]);

  const boardStateForBoard = (!reviewEnabled && pendingPreviewState)
    ? pendingPreviewState
    : (reviewEnabled
        ? (isSharedViewActive ? (sharedDisplayGameState || effectiveReviewGameState) : effectiveReviewGameState)
        : derivedLiveState);
  const boardInteractionDisabled = (!reviewEnabled && !!pendingMove);
  const lastMoveOverrideUsi = (!reviewEnabled && pendingMove?.usi) ? pendingMove.usi : null;



  // 対局終了時や手数変更時に、レビュー位置を末尾に寄せる
  useEffect(() => {
    const onSpecs = (p) => {
      try {
        if (p && (p.game_id === gameId || String(p.game_id) === String(gameId))) {
          setSpectators(Array.isArray(p.spectators) ? p.spectators : []);
        }
      } catch {}
    };
    try { websocketService.on('spectators_update', onSpecs); } catch {}


    const len = Array.isArray(gameState?.move_history) ? gameState.move_history.length : 0;
    try { setLocalBranch(null); } catch {}
    setReviewIndex(len);
  }, [gameId, isFinished, gameState?.move_history?.length]);

  const triggerExitSfx = () => {
    // 退室効果音は「ユーザー操作のスタック内」で鳴らす（モバイルの制限/中断に強くする）
    try {
      if (exitSoundPlayedRef.current) return;
      playSfx?.('room_exit', { forceHtml: true });
      exitSoundPlayedRef.current = true;
    } catch {}
  };


  const handleCloseGameScreen = async () => {
    // 要求仕様:
    // 1) playing のときだけ閉じるのを禁止し false を返す
    // 2) それ以外（review / lobby / 不明 など）は UI を閉じて true を返す
    //    ※ 不明時は allow（true）に倒す
    //    ※ ただし review→lobby への遷移 API に失敗した場合はエラーを投げる（フォールバックせず通知）
    const meId = (user?.user_id || user?._id || user?.id) ? String(user.user_id || user._id || user.id) : '';
    let myWaiting = null;
    try {
      const mine = (typeof getOnlineUserById === 'function') ? getOnlineUserById(meId) : null;
      myWaiting = mine?.waiting ?? null;
    } catch (e) {
      // 取得失敗でも閉じるのを妨げない
      try { console.warn('online-users context read failed (allow close)', e); } catch {}
      myWaiting = null;
    }

    if (myWaiting === 'playing') {
      // playing 中は何もしないで false を返す（既存仕様）
      return false;
    }

    // review のときだけロビーへ戻す API を呼ぶ（失敗時は例外）
    if (myWaiting === 'review') {
      const res = await api.post('/lobby/waiting/stop');
      if (!res?.data?.success) {
        throw new Error('failed_to_set_lobby_status');
      }
      try { applyOnlineUsersDiff?.([{ user_id: meId, waiting: 'lobby', waiting_info: {}, pending_offer: {} }], []); } catch {}
    }

    if (onRequestClose) onRequestClose();
    return true;
  };

  const finishedRef = useRef(false);
  const finishedOnceRef = useRef({});
  const modalOpenRef = useRef(false);

  // 終局ダイアログの多重表示ガード（StrictModeや多重on対策）



// 終局イベント: 勝敗ポップアップ

  const handleUserDisconnected = (payload) => {
    try {
      if (!payload || !payload.game_id || payload.game_id !== gameId) return;
      const targetId = String(payload.user_id || '');
      const sId = String(gameState?.players?.sente?.user_id || '');
      const gId = String(gameState?.players?.gote?.user_id || '');
      if (targetId !== sId && targetId !== gId) return;
      const isMe = String(user?.user_id || '') === targetId;
      if (isMe) return;      if (finishedRef.current || isFinished || gameState?.status === 'finished') return;

      const remaining = Number.isFinite(payload.remaining_ms) ? Math.max(0, Math.floor(payload.remaining_ms)) : 90000;
      setDcOverlay({ show: true, userId: targetId, role: payload.role || null, remainingMs: remaining, startedAt: Date.now() });
    } catch (e) { console.warn('handleUserDisconnected error', e); }
  };
  const handleUserConnected = (payload) => {
    try {
      if (!payload || !payload.game_id || payload.game_id !== gameId) return;
      const targetId = String(payload.user_id || '');
      const sId = String(gameState?.players?.sente?.user_id || '');
      const gId = String(gameState?.players?.gote?.user_id || '');
      if (targetId !== sId && targetId !== gId) return;
      setDcOverlay(prev => (prev && prev.show && prev.userId === targetId) ? { ...prev, show: false } : prev);
    } catch (e) { console.warn('handleUserConnected error', e); }
  };
const handleGameFinished = (data) => {
  try {
    // 他の対局のイベントが混ざった場合は無視
    const gid = data?.game_id != null ? String(data.game_id) : null;
    const currentId =
      (typeof gameId !== 'undefined' && gameId != null)
        ? String(gameId)
        : (gameState?.id != null
            ? String(gameState.id)
            : (gameState?.game_id != null ? String(gameState.game_id) : null));
    if (gid && currentId && currentId !== gid) return;

    // 対局終了時（環境音）
    if (!isSpectator) {
      try { playEnv?.('game_end'); } catch {}
    }

    // 盤面/時計の終了状態は、観戦者でも必要
    setIsFinished(true);
    setDcOverlay(prev => (prev && prev.show) ? ({ ...prev, show: false }) : prev);
    finishedRef.current = true;
    setTimeStateNorm(prev => prev ? ({ ...prev, base_at: Date.now(), current_player: 'none' }) : prev);
    try { if (websocketService.off) websocketService.off('time_update', handleTimeUpdate); } catch {}

    // 観戦者は勝敗ポップアップを出さない
    if (isSpectator) return;

    if (modalOpenRef.current) return;

    const gidKey = gid || currentId || 'unknown';
    if (finishedOnceRef.current[gidKey]) return;
    finishedOnceRef.current[gidKey] = true;

    // global gate: ensure single finished-modal across multiple mounts
    try {
      if (typeof window !== 'undefined') {
        window.__gameFinishedGate ||= {};
        const kk = gidKey;
        if (kk && window.__gameFinishedGate[kk]) { return; }
        window.__gameFinishedGate[kk] = true;
      }
    } catch {}

    // force-refresh JWT once at end of game（対局者のみ）
    ;(async () => {
      try {
        const r = await api.post('/auth/rotate');
        const accessToken = r?.data?.access_token;
        if (accessToken) {
          localStorage.setItem('access_token', accessToken);
          localStorage.setItem('token', accessToken);
          try { if (websocketService.disconnect) websocketService.disconnect(); } catch {}
          try { if (websocketService.connect) websocketService.connect(accessToken); } catch {}
        }
      } catch (e) {
        console.error('rotate at finish failed', e);
      }

      // 終局時にヘッダー等のユーザー情報（レーティング）を更新
      try {
        if (typeof fetchProfile === 'function') {
          await fetchProfile();
        }
      } catch (e) {
        console.warn('profile refresh at finish failed', e);
      }
    })();


    const me = (user && user.user_id) ? String(user.user_id) : null;
    const w_uid = data?.winner_user_id ? String(data.winner_user_id) : null;

    const myRole = (() => {
      const p = gameState?.players || {};
      const s = p?.sente?.user_id ? String(p.sente.user_id) : null;
      const g = p?.gote?.user_id ? String(p.gote.user_id) : null;
      if (me && s === me) return 'sente';
      if (me && g === me) return 'gote';
      return null;
    })();

        const winnerRole = data?.winner || null;
    const reasonKey = data?.reason || data?.finished_reason || '';
    const isDraw = String(winnerRole) === 'draw' || String(reasonKey) === 'sennichite';

    const is256Draw = String(reasonKey) === 'jishogi_256';

    const reasonText = (() => {
      switch (String(reasonKey)) {
        case 'resign': return t('ui.components.game.gameview.kd462b7f2');
        case 'checkmate': return t('ui.components.game.gameview.k7f7c52a3');
        case 'timeout': return t('ui.components.game.gameview.kd03cff73');
        case 'timeup': return t('ui.components.game.gameview.kd03cff73');
        case 'sennichite': return t('ui.components.game.gameview.k51eec1db');
        case 'perpetual_check_sennichite': return t('ui.components.game.gameview.k2b05cfd9');
        case 'illegal': return t('ui.components.game.gameview.kcc055345');
        case 'disconnect_timeout': return t('ui.components.game.gameview.k09257558');
        case 'disconnect_four': return t('ui.components.game.gameview.k09257558');
        case 'draw': return t('ui.components.game.gameview.kacc1bf92');
        case 'nyugyoku': return t('ui.components.game.gameview.k90a688f9');
        case 'nyugyoku_low_points': return t('ui.components.game.gameview.k464bb54d');
        case 'nyugyoku_both': return t('ui.components.game.gameview.k44109836');
        case 'nyugyoku_low_points_both': return t('ui.components.game.gameview.k77d7c098');
        case 'jishogi_256': return t('ui.components.game.gameview.k7d2b187e');
        default: return '';
      }
    })();

    const titleAndMsg = (() => {
      // Spectator (or cannot resolve my role)
      if (!myRole) {
        if (isDraw) {
          if (is256Draw) {
            return { title: t('ui.components.game.gameview.k3a533012'), msg: t('ui.components.game.gameview.k6d877461') };
          }
          return { title: t('ui.components.game.gameview.kacc1bf92'), msg: t('ui.components.game.gameview.k4d0e866b', { reasonText }) };
        }
        const winName = (data?.winner_username || (winnerRole === 'sente' ? t('ui.components.game.gameview.k3a1b7009') : winnerRole === 'gote' ? t('ui.components.game.gameview.k3bcc9adf') : ''));
        const msg = winName ? t('ui.components.game.gameview.k250b678c', { winName, reasonText }) : `${reasonText}`;
        return { title: t('ui.components.game.gameview.kdd844a42'), msg };
      }

      // Player
      if (isDraw) {
        if (is256Draw) {
          return { title: t('ui.components.game.gameview.k3a533012'), msg: t('ui.components.game.gameview.k6d877461') };
        }
        return { title: t('ui.components.game.gameview.kacc1bf92'), msg: t('ui.components.game.gameview.k4d0e866b', { reasonText }) };
      }

      const iWon = (me && w_uid && me === w_uid)
                || (!w_uid && myRole && winnerRole && myRole === String(winnerRole));

      const title = iWon ? t('ui.components.game.gameview.k220bdd74') : t('ui.components.game.gameview.k1b5f1316');
      const oppName = iWon ? (data?.loser_username || '') : (data?.winner_username || '');
      const msg = oppName
        ? t('ui.components.game.gameview.ke878a4df', { oppName, reasonText, result: iWon ? t('ui.components.game.gameview.kbaf6a82c') : t('ui.components.game.gameview.k4c0d4980') })
        : t('ui.common.reason_result', { reasonText, result: iWon ? t('ui.components.game.gameview.k2c8bd192') : t('ui.components.game.gameview.k0e371a7b') });

      return { title, msg };
    })();

    setResultModal({ open: true, title: titleAndMsg.title, message: titleAndMsg.msg });
  } catch (e) {
    console.warn('handleGameFinished error', e);
  }
};
useEffect(() => {
  try {
    if (websocketService.off) websocketService.off('game:finished');
    if (websocketService.removeAllListeners) websocketService.removeAllListeners('game:finished');
    if (websocketService.socket && websocketService.socket.off) websocketService.socket.off('game:finished');
    if (websocketService.socket && websocketService.socket.removeAllListeners) websocketService.socket.removeAllListeners('game:finished');
  } catch {}
  if (websocketService.once) websocketService.once('game:finished', handleGameFinished);
  else websocketService.on('game:finished', handleGameFinished);
  return () => {
    try {
      if (websocketService.off) websocketService.off('game:finished', handleGameFinished);
      if (websocketService.removeListener) websocketService.removeListener('game:finished', handleGameFinished);
      if (websocketService.socket && websocketService.socket.off) websocketService.socket.off('game:finished', handleGameFinished);
    } catch {}
  };
}, [gameId, isSpectator, user?.user_id, gameState?.players?.sente?.user_id, gameState?.players?.gote?.user_id, fetchProfile]);
  const pausedByDisconnect = !!(dcOverlay && dcOverlay.show) || (gameState?.status === 'pause');

  const currentTurn = (pausedByDisconnect || isFinished) ? 'none' : (gameState?.currentPlayer || timeStateNorm?.current_player || 'sente');
  const ticking = useTickingClock(timeStateNorm ? { ...timeStateNorm, current_player: ((pausedByDisconnect || isFinished) ? 'none' : currentTurn)} : null);

  // === 時間効果音（持ち時間切れ / 秒読み・猶予のカウントダウン） ===
  const timeSfxRef = useRef({
    running: null,
    lastInitialMs: { sente: null, gote: null },
    lastTenSec: { sente: null, gote: null },
    lastOneSec: { sente: null, gote: null },
    lastPhase: { sente: null, gote: null },
  });

  // NOTE: このeffectは「時刻の経過」で判定する必要があるため、ticking（250ms更新）にも依存させる。
  // timeStateNorm だけに依存すると、サーバからのstate更新が無い間は一度も再評価されず、
  // 10秒/1秒SEが鳴らない。
  useEffect(() => {
    try {
      if (pausedByDisconnect || isFinished) return;

      const tick = () => {
        try {
          if (pausedByDisconnect || isFinished) return;
          const running = (currentTurn === 'sente' || currentTurn === 'gote') ? currentTurn : null;
          if (!running) return;

          const br = timeStateNorm?.breakdown;
          const baseAt = Number(timeStateNorm?.base_at);
          const curPlayer = String(timeStateNorm?.current_player || '');
          if (!br || !Number.isFinite(baseAt)) return;

          const bk0 = br?.[running] || null;
          if (!bk0) return;

          const elapsedMs = Math.max(0, Date.now() - baseAt);
          const runningElapsed = (curPlayer === running) ? elapsedMs : 0;

          // breakdown に経過msを適用（initial→byoyomi→deferment の順）
          let ini = Math.max(0, parseInt(bk0.initial_ms ?? 0));
          let byo = Math.max(0, parseInt(bk0.byoyomi_ms ?? 0));
          let dfr = Math.max(0, parseInt(bk0.deferment_ms ?? 0));
          let e = Math.max(0, parseInt(runningElapsed ?? 0));
          if (e > 0) { const c1 = Math.min(e, ini); ini -= c1; e -= c1; }
          if (e > 0) { const c2 = Math.min(e, byo); byo -= c2; e -= c2; }
          if (e > 0) { const c3 = Math.min(e, dfr); dfr -= c3; e -= c3; }

          const ref = timeSfxRef.current;

          // 走者が切り替わったら関連カウンタをリセット（重複・取りこぼし防止）
          if (ref.running !== running) {
            ref.running = running;
            ref.lastTenSec[running] = null;
            ref.lastOneSec[running] = null;
            ref.lastPhase[running] = null;
            // lastInitialMs は継続（0検知のため）
          }

          // 持ち時間(初期時間)が0になった瞬間
          const prevIni = ref.lastInitialMs[running];
          if (typeof prevIni === 'number' && prevIni > 0 && ini <= 0) {
            try { playSfx?.('time_up', { forceHtml: true }); } catch {}
          }
          ref.lastInitialMs[running] = ini;

          // 秒読み/猶予のカウント（持ち時間が残っている間は鳴らさない）
          if (ini > 0) {
            ref.lastTenSec[running] = null;
            ref.lastOneSec[running] = null;
            ref.lastPhase[running] = 'initial';
            return;
          }

          const phase = (byo > 0) ? 'byoyomi' : ((dfr > 0) ? 'deferment' : 'none');
          if (ref.lastPhase[running] !== phase) {
            ref.lastPhase[running] = phase;
            ref.lastTenSec[running] = null;
            ref.lastOneSec[running] = null;
          }

          const ms = (phase === 'byoyomi') ? byo : ((phase === 'deferment') ? dfr : 0);
          if (ms <= 0) return;

          const sec = Math.ceil(Math.max(0, ms) / 1000);

          // 残り9秒〜0秒：毎秒
          if (sec <= 9) {
            if (ref.lastOneSec[running] !== sec) {
              try { playSfx?.('countdown_1s', { forceHtml: true }); } catch {}
              ref.lastOneSec[running] = sec;
            }
            ref.lastTenSec[running] = null;
            return;
          }

          // 残り1分未満：10秒ごと（50/40/30/20/10）
          if (sec < 60 && sec >= 10 && sec % 10 === 0) {
            if (ref.lastTenSec[running] !== sec) {
              try { playSfx?.('countdown_10s', { forceHtml: true }); } catch {}
              ref.lastTenSec[running] = sec;
            }
            return;
          }

          // リセット等で残りが増えた場合: 記録をクリア
          if (ref.lastTenSec[running] != null && sec > ref.lastTenSec[running]) ref.lastTenSec[running] = null;
          if (ref.lastOneSec[running] != null && sec > ref.lastOneSec[running]) ref.lastOneSec[running] = null;
        } catch {}
      };

      tick();
      const id = setInterval(tick, 250);
      const onVis = () => tick();
      document.addEventListener('visibilitychange', onVis);

      return () => {
        clearInterval(id);
        document.removeEventListener('visibilitychange', onVis);
      };
    } catch {}
  }, [pausedByDisconnect, isFinished, currentTurn, timeStateNorm, playSfx]);


  useEffect(() => {
    try { setPostgamePresence(null); } catch {}
    const onSpecs = (p) => {
      try {
        if (p && (p.game_id === gameId || String(p.game_id) === String(gameId))) {
          setSpectators(Array.isArray(p.spectators) ? p.spectators : []);
        }
      } catch {}
    };
    try { websocketService.on('spectators_update', onSpecs); } catch {}


    const handleGameUpdate = (data) => {
  const payload = (data && data.game_state) ? data.game_state : (data || {});
  // 厳密ID抽出（game_id→id の順で確認して文字列化）
  const gidRaw = (payload && payload.game_id !== undefined && payload.game_id !== null)
    ? payload.game_id
    : ((payload && payload.id !== undefined && payload.id !== null) ? payload.id : null);
  const incomingId = gidRaw != null ? String(gidRaw) : null;
  const currentId  = gameId != null ? String(gameId) : null;
  if (incomingId && currentId && incomingId !== currentId) {
    console.warn('[WS] game_update ignored (id mismatch)', { incomingId, currentId });
    return;
  }
  
  // If server says finished, freeze clocks immediately
  try {
    const status = (payload && (payload.status || (payload.game_state && payload.game_state.status))) || null;
    if (status === 'finished' || payload?.finished_reason) {
      setIsFinished(true);
      setDcOverlay(prev => (prev && prev.show) ? ({ ...prev, show: false }) : prev);
      setTimeStateNorm(prev => prev ? ({ ...prev, base_at: Date.now(), current_player: 'none' }) : prev);
      try { if (websocketService.off) websocketService.off('time_update', handleTimeUpdate); } catch {}
    }
  } catch {}
setGameState(prev => {
    const shaped = normalizeGameState(payload);
    // players/board/capturedPieces が欠けて届く差分イベントに対して、既存値を保持する
    const merged = {
      ...prev,
      ...shaped,
      players: (shaped?.players && (shaped.players.sente || shaped.players.gote)) ? shaped.players : (prev?.players || {}),
      start_sfen: (shaped?.start_sfen ?? shaped?.startSfen ?? prev?.start_sfen ?? prev?.startSfen ?? null),
      sfen: (shaped?.sfen ?? prev?.sfen ?? null),
      board: shaped?.board ?? prev?.board ?? null,
      capturedPieces: shaped?.capturedPieces ?? prev?.capturedPieces ?? { sente:{}, gote:{} },
      currentPlayer: (() => {
        try {
          const has = (payload && Object.prototype.hasOwnProperty.call(payload, 'current_turn'));
          if (has && (payload.current_turn === 'sente' || payload.current_turn === 'gote' || payload.current_turn === 'none')) {
            return shaped?.currentPlayer ?? prev?.currentPlayer ?? 'sente';
          }
        } catch {}
        return prev?.currentPlayer ?? 'sente';
      })(),
      move_history: (() => {
        try {
          const has = (payload && Object.prototype.hasOwnProperty.call(payload, 'move_history'));
          if (has && Array.isArray(payload.move_history)) return payload.move_history;
        } catch {}
        return (Array.isArray(prev?.move_history) ? prev.move_history : []);
      })(),
      last_move: shaped?.last_move ?? prev?.last_move ?? null,
    };
    return merged;
  });
  try {
    const specs = Array.isArray(data?.spectators)
      ? data.spectators
      : (Array.isArray(payload?.spectators)
          ? payload.spectators
          : (Array.isArray(data?.game_state?.spectators) ? data.game_state.spectators : null));
    if (specs) setSpectators(specs);
  } catch {}
  if (payload.time_state || payload.time_effective) setTimeStateNorm(normalizeTime(payload));
};
    const handleTimeUpdate = (data) => {
      if (data.game_id === gameId) {
        console.info('[WS] time_update', data);
        const n = normalizeTime(data);
        setTimeStateNorm((prev) => {
          if (!prev) return n;
          if (!n) return prev;
          const merged = { ...prev, ...n };
          if (!n.breakdown && prev.breakdown) merged.breakdown = prev.breakdown;
          if (!n.config && prev.config) merged.config = prev.config;

          // normalizeTime が flat/nested 形式を誤判定して 0 に潰れる場合の保険
          const nextZero = (Number(n.sente_left || 0) <= 0 && Number(n.gote_left || 0) <= 0);
          const prevNonZero = (Number(prev.sente_left || 0) > 0 || Number(prev.gote_left || 0) > 0);
          if (nextZero && prevNonZero) {
            merged.sente_left = prev.sente_left;
            merged.gote_left = prev.gote_left;
            merged.base_at = prev.base_at;
            merged.current_player = prev.current_player;
            merged.source = prev.source || merged.source;
          }
          return merged;
        });
      }
    };
    const handleChatMessage = (raw) => {
      try {
        const m = normalizeChat(raw);
        if (!m) return;
        if (String(m.game_id) !== String(gameId)) return;
        setChatMessages(prev => mergeChatMessages(prev, [m]));
        pendingChatScrollBehaviorRef.current = 'smooth';
        // モバイルでチャットを開いていないときに受信した場合のみ、未読マークを立てる
        try {
          const desktop = !!isDesktopRef.current;
          const chatOpen = !!showChatMobileRef.current;
          const me = String(myUserIdRef.current || '');
          const from = String(m.user_id || '');
          const isFromMe = (me && from) ? (me === from) : false;
          if (!desktop && !chatOpen && !isFromMe) {
            setHasUnreadChat(true);
          }
        } catch {}
      } catch {}
    };

    const handleChatHistory = (data) => {
      try {
        if (!data) return;
        const gid = String(data.game_id ?? data.id ?? '');
        if (String(gameId) !== gid) return;
        const msgs = Array.isArray(data.messages) ? data.messages : [];
        setChatMessages(prev => mergeChatMessages(prev, msgs));
        pendingChatScrollBehaviorRef.current = 'auto';
      } catch {}
    };

    const handleGameMove = (data) => {
      // legacy event (some clients used it). Canonical state is updated by game_update.
      // Keep this handler as a no-op for safety.
      try {
        const gidRaw = data && (data.game_id ?? data.id);
        const incomingId = gidRaw != null ? String(gidRaw) : null;
        const currentId  = gameId != null ? String(gameId) : null;
        if (incomingId && currentId && incomingId !== currentId) return;
      } catch {}
    };



    const handleAnalysisUpdate = (data) => {
      try {
        const gidRaw = (data && (data.game_id ?? data.gameId ?? data.id ?? (data.game_state && (data.game_state.game_id ?? data.game_state.id)))) ?? null;
        const incoming = gidRaw != null ? String(gidRaw) : '';
        const cleaned = incoming.startsWith('game:') ? incoming.slice(5) : incoming;
        const currentId = gameId != null ? String(gameId) : '';
        if (cleaned && currentId && cleaned !== currentId) return;

        const meta = {
          analysis_status: data?.analysis_status ?? null,
          analysis_progress: (typeof data?.analysis_progress === 'number') ? data.analysis_progress : null,
          analysis_total: (typeof data?.analysis_total === 'number') ? data.analysis_total : null,
          analysis_error: (typeof data?.analysis_error === 'string') ? data.analysis_error : null,
        };

        const updates =
          (Array.isArray(data?.updates) ? data.updates
            : (Array.isArray(data?.delta_updates) ? data.delta_updates
              : (Array.isArray(data?.all_results) ? data.all_results : [])));

        setGameState(prev => {
          if (!prev) return prev;
          const hist0 = Array.isArray(prev.move_history) ? prev.move_history : [];
          const hist = hist0.slice();
          for (const u of updates) {
            if (!u || typeof u !== 'object') continue;
            const idx =
              (typeof u.index === 'number') ? u.index
              : ((typeof u.i === 'number') ? u.i
                : ((typeof u.ply === 'number') ? (u.ply - 1) : null));
            if (idx == null || idx < 0 || idx >= hist.length) continue;
            const analysis = (u.analysis && typeof u.analysis === 'object') ? u.analysis
                           : ((u.result && typeof u.result === 'object') ? u.result : null);
            if (!analysis) continue;

            const raw = hist[idx];
            if (raw && typeof raw === 'object') {
              // Prefer keeping existing shape (raw / raw.obj)
              if (raw.obj && typeof raw.obj === 'object') {
                hist[idx] = { ...raw, obj: { ...raw.obj, analysis } };
              } else {
                hist[idx] = { ...raw, analysis };
              }
            } else if (typeof raw === 'string') {
              hist[idx] = { usi: raw, analysis };
            } else {
              hist[idx] = { analysis };
            }
          }
          const merged = { ...prev, move_history: hist };
          if (meta.analysis_status != null) merged.analysis_status = meta.analysis_status;
          if (meta.analysis_progress != null) merged.analysis_progress = meta.analysis_progress;
          if (meta.analysis_total != null) merged.analysis_total = meta.analysis_total;
          if (meta.analysis_error != null) merged.analysis_error = meta.analysis_error;
          return merged;
        });
      } catch (e) {
        console.warn('handleAnalysisUpdate error', e);
      }
    };


    const handleSharedBoardStatus = (data) => {
      try {
        if (!data) return;
        const gidRaw = (data.game_id ?? data.gameId ?? data.id) ?? null;
        const incoming = gidRaw != null ? String(gidRaw) : '';
        const currentId = gameId != null ? String(gameId) : '';
        if (incoming && currentId && incoming !== currentId) return;
        const en0 = data.enabled;
        const en = (en0 && typeof en0 === 'object') ? {
          sente: !!en0.sente,
          gote: !!en0.gote,
        } : { sente: false, gote: false };
        setSharedBoardStatus({ enabled: en, mutual: !!data.mutual });
      } catch {}
    };

    const handleSharedBoardState = (data) => {
      try {
        if (!data) return;
        const gidRaw = (data.game_id ?? data.gameId ?? data.id) ?? null;
        const incoming = gidRaw != null ? String(gidRaw) : '';
        const currentId = gameId != null ? String(gameId) : '';
        if (incoming && currentId && incoming !== currentId) return;
        const cur = (data.cursor != null) ? parseInt(data.cursor) : null;
        if (Number.isFinite(cur)) setSharedBoardCursor(cur);
        const br = (data.branch && typeof data.branch === 'object') ? data.branch : null;
        setSharedBoardBranch(br);
      } catch {}
    };

    const handleSharedBoardOffer = (data) => {
      try {
        if (!data) return;
        const gidRaw = (data.game_id ?? data.gameId ?? data.id) ?? null;
        const incoming = gidRaw != null ? String(gidRaw) : '';
        const currentId = gameId != null ? String(gameId) : '';
        if (incoming && currentId && incoming !== currentId) return;
        setSharedBoardOffer({
          initiator_user_id: data.initiator_user_id ?? null,
          initiator_role: data.initiator_role ?? null,
        });
        // 既に自分が共有盤表示中なら出さない
        if (!sharedBoardViewEnabled) setSharedBoardOfferOpen(true);
      } catch {}
    };

    const handlePostgamePresence = (data) => {
      try {
        if (!data) return;
        const gidRaw = (data.game_id ?? data.gameId ?? data.id) ?? null;
        const incoming = gidRaw != null ? String(gidRaw) : '';
        const currentId = gameId != null ? String(gameId) : '';
        if (incoming && currentId && incoming !== currentId) return;
        const p0 = data.presence;
        const p = (p0 && typeof p0 === 'object') ? {
          sente: !!p0.sente,
          gote: !!p0.gote,
        } : { sente: false, gote: false };
        setPostgamePresence(p);
      } catch {}
    };

    const handleSocketDisconnect = () => {
      try {
        // 自分が切断した場合のみ、ローカル表示の共有盤をOFF（相手側には影響しない）
        setSharedBoardViewEnabled(false);
        setSharedBoardOfferOpen(false);
      } catch {}
    };

    websocketService.on('shared_board_status', handleSharedBoardStatus);
    websocketService.on('shared_board_state', handleSharedBoardState);
    websocketService.on('shared_board_offer', handleSharedBoardOffer);
    websocketService.on('postgame_presence', handlePostgamePresence);
    websocketService.on('disconnect', handleSocketDisconnect);
    websocketService.on('game_update', handleGameUpdate);
    websocketService.on('analysis_update', handleAnalysisUpdate);
    if (!isFinished) websocketService.on('time_update', handleTimeUpdate);
    websocketService.on('chat_message', handleChatMessage);
    websocketService.on('chat_history', handleChatHistory);
    websocketService.on('game:move', handleGameMove);
    websocketService.joinGame(gameId);

    // 入室毎にフラグをリセット（退室SEの二重再生防止）
    try { exitSoundPlayedRef.current = false; } catch {}

    // 入室時: 効果音（部屋入室） + 環境音（対局開始）
    try { playSfx?.('room_enter'); } catch {}
    try { playEnv?.('game_start'); } catch {}
    // 退室SEは押した瞬間に鳴る必要があるため、入室時に先読み（ダウンロード/デコードだけ済ませる）
    try { preload?.('room_exit'); } catch {}
    // 時間系効果音も先読み（カウントダウン中の遅延を抑える）
    try { preload?.('time_up'); } catch {}
    try { preload?.('countdown_10s'); } catch {}
    try { preload?.('countdown_1s'); } catch {}
    isMountedRef.current = true; // <-- fixed: true (JS) not True

    fetchGameData();

    return () => {
      websocketService.off('game_update', handleGameUpdate);
      websocketService.off('analysis_update', handleAnalysisUpdate);
      websocketService.off('time_update', handleTimeUpdate);
      websocketService.off('chat_message', handleChatMessage);
      websocketService.off('chat_history', handleChatHistory);
      websocketService.off('game:move', handleGameMove);

      try { websocketService.off('shared_board_status', handleSharedBoardStatus); } catch {}
      try { websocketService.off('shared_board_state', handleSharedBoardState); } catch {}
      try { websocketService.off('shared_board_offer', handleSharedBoardOffer); } catch {}
      try { websocketService.off('postgame_presence', handlePostgamePresence); } catch {}
      try { websocketService.off('disconnect', handleSocketDisconnect); } catch {}


      // 退室時: 効果音（部屋退室）
      // ※ ボタン操作で既に鳴らした場合は二重再生しない
      try {
        if (!exitSoundPlayedRef.current) {
          playSfx?.('room_exit');
          exitSoundPlayedRef.current = true;
        }
      } catch {}

      websocketService.leaveGame(gameId);
      isMountedRef.current = false;
    };
    return () => { try { websocketService.off && websocketService.off('spectators_update'); } catch {} };
  }, [gameId, playEnv, playSfx]);

  const fetchGameData = async () => {
    try {
      const url = `/api/game/${gameId}`;
      const res = await fetch(url, { credentials: 'include' });
      console.info('[GET /api/game/:id] status=', res.status, res.statusText, 'ok=', res.ok);
      let dataText = await res.text();
      let json = null;
      try { json = JSON.parse(dataText); } catch (e) {
        console.error('[GAME ERROR] response is not JSON:', dataText);
        setError(t('ui.components.game.gameview.k21a5126d'));
        setLoading(false);
        return false;
      }
      const keys = Object.keys(json || {});
      console.info('[GAME RAW] keys=', keys, 'sample=', JSON.stringify(json).slice(0, 500));

      if (!res.ok) {
        const code = json?.error_code || json?.error || json?.code;
        const fb = json?.message || json?.error || '';
        setError(gameErrorMessage(code, fb, t('ui.components.game.gameview.k21a5126d')));
        setLoading(false);
        return false;
      }

      const g = json.success ? json.data : (json.game_state ? json : (json.payload || json));
      if (!g) {
        setError(t('ui.components.game.gameview.k21a5126d'));
        setLoading(false);
        return false;
      }

      const shaped = normalizeGameState(g.game_state || g);
      console.info('[GAME SHAPED] has_players=', !!shaped?.players, 'has_board=', !!shaped?.board, 'current_turn=', shaped?.currentPlayer);

      setGameState(shaped);
      const initialChat = g.chat || g.chat_history || g.chat_messages || [];
      setChatMessages(prev => mergeChatMessages(prev, initialChat));
      pendingChatScrollBehaviorRef.current = 'auto';
      try {
        const specs0 = Array.isArray(g.spectators)
          ? g.spectators
          : (Array.isArray(g?.game_state?.spectators) ? g.game_state.spectators : null);
        if (specs0) setSpectators(specs0);
      } catch {}
      setTimeStateNorm(normalizeTime(g));

      // 既に終局している対局への参加（観戦など）の場合は、即座に終局モードに入る
      try {
        const status = (g && (g.status || (g.game_state && g.game_state.status))) || null;
        const finishedReason = (g && (g.finished_reason || (g.game_state && g.game_state.finished_reason))) || null;
        if (status === 'finished' || finishedReason) {
          setIsFinished(true);
          setDcOverlay(prev => (prev && prev.show) ? ({ ...prev, show: false }) : prev);
          setTimeStateNorm(prev => prev ? ({ ...prev, base_at: Date.now(), current_player: 'none' }) : prev);
        }
      } catch (e) {
        console.warn('[GAME] failed to infer finished state from initial payload', e);
      }

      setLoading(false);
      setError('');
      return true;
    } catch (e) {
      console.error('[GAME ERROR] fetch failed', e);
      setError(t('ui.components.game.gameview.k21a5126d'));
      setLoading(false);
      return false;
    }
  };

  const normalizeGameState = (gs) => {

  const toCountMap = (arrOrObj) => {
    // 入力がすでに {pieceType: count} 形式ならそのまま返す
    if (arrOrObj && !Array.isArray(arrOrObj) && typeof arrOrObj === 'object') {
      // ただし値が配列なら count に変換
      const values = Object.values(arrOrObj);
      if (values.length && values.every(v => typeof v === 'number')) return arrOrObj;
      const out = {};
      for (const [k, v] of Object.entries(arrOrObj)) {
        if (Array.isArray(v)) {
          // 例: { pawn: ['pawn','pawn'] } / { pieces: ['pawn'] } は合算
          out[k] = v.length;
        } else if (typeof v === 'object' && v) {
          // 例: { 0:{piece:'pawn'} } を合算
          const key = v.piece || v.type || v.kind || k;
          out[key] = (out[key] || 0) + 1;
        } else {
          // number 以外の値は 1 とみなさない（未知の形式）
          // ここはスキップ
        }
      }
      return out;
    }
    // 配列形式 ['pawn','gold', {piece:'pawn'}] など
    const out = {};
    const arr = Array.isArray(arrOrObj) ? arrOrObj : [];
    for (const it of arr) {
      const key = (typeof it === 'string' ? it : (it?.piece || it?.type || it?.kind || null));
      if (!key) continue;
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  };

    if (!gs) return null;
    return {
      game_id: (gs.game_id ?? gs.id ?? gs._id ?? gs.game_state?.game_id ?? gs.game_state?.id ?? gs.game_state?._id ?? null),
      status: (gs.status ?? gs.game_state?.status ?? null),
      finished_reason: (gs.finished_reason ?? gs.game_state?.finished_reason ?? null),
      analysis_status: (gs.analysis_status ?? gs.game_state?.analysis_status ?? null),
      analysis_progress: (gs.analysis_progress ?? gs.game_state?.analysis_progress ?? null),
      analysis_total: (gs.analysis_total ?? gs.game_state?.analysis_total ?? null),
      analysis_error: (gs.analysis_error ?? gs.game_state?.analysis_error ?? null),
      board: gs.board ?? gs.game_state?.board ?? null,
      capturedPieces: (() => { const c = gs.captured ?? gs.game_state?.captured ?? { sente:[], gote:[] }; return { sente: toCountMap(c.sente), gote: toCountMap(c.gote) }; })(),
      currentPlayer: gs.current_turn ?? gs.game_state?.current_turn ?? 'sente',
      start_sfen: (gs.start_sfen ?? gs.startSfen ?? gs.game_state?.start_sfen ?? gs.game_state?.startSfen ?? null),
      sfen: (gs.sfen ?? gs.game_state?.sfen ?? null),
      players: gs.players ?? gs.game_state?.players ?? {},
      move_history: gs.move_history ?? []
    };
  };


  const _extractAnalysisFromMove = (raw) => {
    try {
      if (!raw) return null;
      if (raw && typeof raw === 'object') {
        if (raw.analysis && typeof raw.analysis === 'object') return raw.analysis;
        if (raw.obj && typeof raw.obj === 'object') {
          if (raw.obj.analysis && typeof raw.obj.analysis === 'object') return raw.obj.analysis;
          if (raw.obj.analysis_result && typeof raw.obj.analysis_result === 'object') return raw.obj.analysis_result;
        }
        if (raw.analysis_result && typeof raw.analysis_result === 'object') return raw.analysis_result;
      }
    } catch {}
    return null;
  };

  const _scoreNumberFromAnalysis = (analysis, moveNumber) => {
    try {
      if (!analysis || typeof analysis !== 'object') return null;
      const cpRaw = (analysis.main_score_cp ?? analysis.score_cp ?? analysis.cp ?? null);
      const mateRaw = (analysis.main_score_mate ?? analysis.score_mate ?? analysis.mate ?? null);
      let val = null;
      if (typeof mateRaw === 'number' && Number.isFinite(mateRaw) && mateRaw !== 0) {
        // Treat mate as a very large score for graphing.
        val = (mateRaw > 0 ? 6000 : -6000);
      } else if (typeof cpRaw === 'number' && Number.isFinite(cpRaw)) {
        val = cpRaw;
      } else {
        return null;
      }
      // The engine's score is typically from the side-to-move perspective.
      // After N moves: side-to-move is gote when N is odd. Convert to sente perspective.
      if (moveNumber % 2 === 1) val = -val;
      return val;
    } catch {
      return null;
    }
  };

  const _formatEvalText = (analysis, moveNumber) => {
    if (!analysis || typeof analysis !== 'object') return null;
    const cpRaw = (analysis.main_score_cp ?? analysis.score_cp ?? analysis.cp ?? null);
    const mateRaw = (analysis.main_score_mate ?? analysis.score_mate ?? analysis.mate ?? null);
    if (typeof mateRaw === 'number' && Number.isFinite(mateRaw) && mateRaw !== 0) {
      const v = (moveNumber % 2 === 1) ? -mateRaw : mateRaw;
      const s = (v > 0 ? '+' : '') + String(v);
      return t("ui.components.game.gameview.ka361cd7e", { s });
    }
    if (typeof cpRaw === 'number' && Number.isFinite(cpRaw)) {
      const v = (moveNumber % 2 === 1) ? -cpRaw : cpRaw;
      const s = (v > 0 ? '+' : '') + String(Math.trunc(v));
      return s;
    }
    return null;
  };


  const _rcToKifSquare = (row, col) => {
    try {
      const r = Number(row), c = Number(col);
      if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
      if (r < 0 || r > 8 || c < 0 || c > 8) return null;
      const file = 9 - c;
      const rank = r + 1;
      const kan = ['', t('ui.components.game.gameview.kd274eee8'), t('ui.components.game.gameview.k1d5639f7'), t('ui.components.game.gameview.k49ddb069'), t('ui.components.game.gameview.k4f88740b'), t('ui.components.game.gameview.k8f07f53d'), t('ui.components.game.gameview.k3d72c724'), t('ui.components.game.gameview.k7db1eeb5'), t('ui.components.game.gameview.k2142fb62'), t('ui.components.game.gameview.k27a2b9f1')][rank] || String(rank);
      return `${file}${kan}`;
    } catch { return null; }
  };

  // USI -> だいたいの符号（例: 7g7f -> 7六歩、P*7f -> 7六歩打）
  // ※「同」「右/左/直」などの詳細な表記までは付けない（まず読める形を優先）
  const _usiToKifMove = (usi, positionState) => {
    try {
      if (!usi || typeof usi !== 'string') return null;
      const s = usi.trim();
      if (!s) return null;
      if (s === 'resign') return t('ui.components.game.gameview.kd462b7f2');
      if (s === 'win') return t('ui.components.game.gameview.k2c8bd192');
      if (s === 'none') return null;

      const u = parseUsi(s);
      if (!u?.ok) return s;

      const dst = _rcToKifSquare(u.toRow, u.toCol);
      if (!dst) return s;

      if (u.isDrop) {
        const pn = t(PIECE_NAMES?.[u.pieceType] || '') || t('ui.components.game.gameview.k675b9983');
        return `${dst}${pn}${t('ui.components.game.gameview.k6919d5be')}`;
      }

      const b = positionState?.board;
      const pieceObj = (b && b[u.fromRow] && b[u.fromRow][u.fromCol]) ? b[u.fromRow][u.fromCol] : null;
      const pt = pieceObj?.piece || null;
      const pn = t(PIECE_NAMES?.[pt] || '') || t('ui.components.game.gameview.k675b9983');
      return `${dst}${pn}${u.promote ? t('ui.components.game.gameview.kbb357862') : ''}`;
    } catch {
      return null;
    }
  };

  const analysisDerived = useMemo(() => {
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    const total = hist.length;
    let progress = 0;
    const values = [];
    for (let i = 0; i < total; i++) {
      const a = _extractAnalysisFromMove(hist[i]);
      const sc = _scoreNumberFromAnalysis(a, i + 1);
      values.push(sc);
      if (a && sc != null) progress += 1;
    }
    const statusFromServer = (gameState && (gameState.analysis_status ?? gameState.game_state?.analysis_status)) || null;
    const errorFromServer = (gameState && (gameState.analysis_error ?? gameState.game_state?.analysis_error)) || null;
    const status =
      statusFromServer ||
      (total > 0 && progress >= total ? 'done' : (progress > 0 ? 'running' : null));
    const error = (typeof errorFromServer === 'string' && errorFromServer.trim()) ? errorFromServer : null;
    return { total, progress, status, values, error };
  }, [gameState?.move_history, gameState?.analysis_status, gameState?.analysis_error]);

  const currentEvalText = useMemo(() => {
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    if (!reviewIndex || reviewIndex <= 0) return null;
    const raw = hist[reviewIndex - 1] || null;
    const a = _extractAnalysisFromMove(raw);
    return _formatEvalText(a, reviewIndex);
  }, [reviewIndex, gameState?.move_history]);

  const activeEvalText = useMemo(() => {
    try {
      // 分岐中（共有盤/ローカル盤）は評価値を表示しない。
      const localIsBranched = !!(localBranch && Array.isArray(localBranch.usiMoves) && localBranch.usiMoves.length > 0);

      if (isSharedViewActive) {
        if (sharedIsBranched) return null;
        const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
        if (!sharedCursorClamped || sharedCursorClamped <= 0) return null;
        const idx = Math.max(0, Math.min(hist.length, sharedCursorClamped)) - 1;
        const raw = (idx >= 0) ? (hist[idx] || null) : null;
        const a = _extractAnalysisFromMove(raw);
        return _formatEvalText(a, Math.max(0, Math.min(hist.length, sharedCursorClamped)));
      }

      if (localIsBranched) return null;
      return currentEvalText;
    } catch {
      return null;
    }
  }, [isSharedViewActive, sharedCursorClamped, sharedIsBranched, currentEvalText, gameState?.move_history, localBranch]);

  
  // モバイル: 横スライド領域の高さを、画面の残り高さに合わせて固定する（スワイプ3枚でも共通）
  useLayoutEffect(() => {
    // ローディング中はDOMが出ていないので計測しない
    if (loading) return;
    if (isDesktop) return;

    const recompute = () => {
      try {
        const el = mobileToolsRef.current;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const vh = (vv && typeof vv.height === 'number') ? vv.height : window.innerHeight;
        const dotsH = mobileDotsRef.current ? (mobileDotsRef.current.getBoundingClientRect().height || 0) : 0;

        // 画面下部のブラウザUI(特にiOS Safari)で見切れやすいので、visualViewportを優先して残り高さを算出する。
        // SE2相当は「残りにフィット」させつつ、一般的な端末より大きくなりすぎない上限を設ける。
        const paddingBottom = isSe2Size ? 12 : 24;
        const raw = Math.max(0, Math.floor(vh - rect.top - dotsH - paddingBottom));

        // SE2相当は最小値で底上げすると逆に見切れることがあるため、
        // 「残りにフィット」(raw)を優先しつつ、上限のみを設ける。
        const capH = isSe2Size ? 220 : 9999;
        const avail = isSe2Size ? Math.min(capH, raw) : Math.max(160, raw);

        setMobileToolsH(avail);
      } catch {}
    };

    // 初回描画直後は要素がまだ落ち着いていないことがあるので、少しだけ再計測する
    let raf1 = 0;
    let raf2 = 0;
    const t0 = window.setTimeout(recompute, 0);
    const t1 = window.setTimeout(recompute, 120);
    try {
      raf1 = window.requestAnimationFrame(() => {
        recompute();
        raf2 = window.requestAnimationFrame(recompute);
      });
    } catch {}

    const onResize = () => { try { recompute(); } catch {} };
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

    return () => {
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      try { if (raf1) window.cancelAnimationFrame(raf1); } catch {}
      try { if (raf2) window.cancelAnimationFrame(raf2); } catch {}
      window.removeEventListener('resize', onResize);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize);
    };
  }, [loading, isDesktop, mobileToolsPage, isSe2Size]);


  const handleMove = (move) => {
    const usi = (move && typeof move.usi === 'string') ? move.usi : null;
    if (!usi) return;

    // Review/spectator is always read-only
    if (reviewEnabled || isSpectator || isFinished) {
      // ShogiBoard already blocks, but keep it safe.
      return;
    }

    if (moveConfirmEnabled) {
      // Only one pending move at a time
      if (pendingMove) return;
      let toRow = null, toCol = null;
      try {
        const pu = parseUsi(usi);
        if (pu && pu.ok) {
          toRow = pu.toRow;
          toCol = pu.toCol;
        }
      } catch {}
      const core = _usiToKifMove(usi, derivedLiveState) || usi;
      const mark = (derivedLiveState?.currentPlayer === 'sente') ? '▲' : ((derivedLiveState?.currentPlayer === 'gote') ? '△' : '');
      const kifText = mark ? `${mark}${core}` : core;
      setPendingMove({
        usi,
        kifText,
        toRow,
        toCol,
        baseState: derivedLiveState,
        baseHistoryLen: totalMoves,
        stage: 'confirm',
        createdAt: Date.now(),
      });
      return;
    }

    websocketService.emit('make_move', { game_id: gameId, usi });
  };

  // === ローカル見返しの手動操作（対局者のみ） ===
  const isBranched = !!(localBranch && Array.isArray(localBranch.usiMoves) && localBranch.usiMoves.length > 0);
  const branchBaseIndex = isBranched ? Math.max(0, Math.min(Number(localBranch.baseIndex ?? 0), totalMoves)) : null;

  const clearBranchAndSetReviewIndex = (idx) => {
    try { setLocalBranch(null); } catch {}
    setReviewIndex(idx);
  };

  const navigateReview = (delta) => {
    const base = (isBranched && branchBaseIndex != null) ? branchBaseIndex : reviewIndex;
    const next = Math.max(0, Math.min(totalMoves, base + delta));
    clearBranchAndSetReviewIndex(next);
  };


  const sharedBoardUpdateEmit = (payload) => {
    try { websocketService.emit('shared_board_update', { game_id: gameId, ...(payload || {}) }); } catch {}
  };
  const sharedBoardToggleEmit = (enabled) => {
    try { websocketService.emit('shared_board_toggle', { game_id: gameId, enabled: !!enabled }); } catch {}
  };

  const setSharedCursor = (idx) => {
    if (!canOperateShared) return;
    sharedBoardUpdateEmit({ action: 'set_cursor', cursor: idx });
  };
  const navigateShared = (delta) => {
    if (!canOperateShared) return;
    sharedBoardUpdateEmit({ action: 'navigate', delta });
  };

  const setActiveCursor = (idx) => {
    if (isSharedViewActive) return setSharedCursor(idx);
    return clearBranchAndSetReviewIndex(idx);
  };
  const navigateActive = (delta) => {
    if (isSharedViewActive) return navigateShared(delta);
    return navigateReview(delta);
  };

  const activeNavBase = (isSharedViewActive
    ? ((sharedIsBranched && sharedBranchBaseIndex != null) ? sharedBranchBaseIndex : sharedCursorClamped)
    : ((isBranched && branchBaseIndex != null) ? branchBaseIndex : reviewIndex)
  );

  // 分岐中は、本譜の「次の手」「最善手」をそのまま出すと誤表示になる。
  // 分岐局面の解析は無いので、表示は抑制する。
  const activeIsBranched = isSharedViewActive ? !!sharedIsBranched : !!isBranched;

  const reviewStepLabel = (reviewEnabled && isBranched && branchBaseIndex != null)
    ? t("ui.components.game.gameview.ke7eadd4e", { n: branchBaseIndex })
    : t("ui.components.game.gameview.k04d4d166", { a: reviewIndex, b: totalMoves });

  const activeStepLabel = (isSharedViewActive
    ? ((sharedIsBranched && sharedBranchBaseIndex != null)
        ? t("ui.components.game.gameview.ke7eadd4e", { n: sharedBranchBaseIndex })
        : t("ui.components.game.gameview.k04d4d166", { a: sharedCursorClamped, b: totalMoves }))
    : reviewStepLabel
  );

  const suppressEvalDisplay = (isBranched || sharedIsBranched);

  // 感想戦: 「次の本譜手」がある場合は盤面に矢印で表示する
  const nextMainlineMoveUsiForArrow = useMemo(() => {
    try {
      if (!reviewEnabled || !gameState) return null;
      if (!reviewDrawNextMove) return null;
      if (activeIsBranched) return null;
      const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
      const base = Number.isFinite(Number(activeNavBase)) ? Math.trunc(Number(activeNavBase))
        : (Number.isFinite(Number(reviewIndex)) ? Math.trunc(Number(reviewIndex)) : 0);
      if (base < 0 || base >= hist.length) return null;
      return extractUsiFromHistoryEntry(hist[base]);
    } catch {
      return null;
    }
  }, [reviewEnabled, gameState?.move_history, activeNavBase, reviewIndex, reviewDrawNextMove, activeIsBranched]);


  // 感想戦: 現在局面（activeNavBase）の「最善手」を緑線で表示する（解析がある場合）
  const bestMoveUsiForOverlay = useMemo(() => {
    try {
      if (!reviewEnabled || !gameState) return null;
      if (!reviewDrawBestMove) return null;
      if (activeIsBranched) return null;
      const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
      const base = Number.isFinite(Number(activeNavBase)) ? Math.trunc(Number(activeNavBase))
        : (Number.isFinite(Number(reviewIndex)) ? Math.trunc(Number(reviewIndex)) : 0);
      // move_history[i] の解析は「その手を指した後の局面」に紐づくため、
      // 現在局面（base 手目の局面＝base 手指した後）の最善手は base-1 の解析を参照する
      // 例: base=1（1手指した後）→ hist[0].analysis が「2手目（次の手）」の候補
      if (base < 0 || base > hist.length) return null;
      const analysisIndex = base - 1;
      if (analysisIndex < 0 || analysisIndex >= hist.length) return null;

      const raw = hist[analysisIndex];
      // move entry -> analysis
      let a = null;
      try {
        if (raw && typeof raw === 'object') {
          a = (raw.analysis && typeof raw.analysis === 'object') ? raw.analysis : null;
          if (!a && raw.obj && typeof raw.obj === 'object') {
            if (raw.obj.analysis && typeof raw.obj.analysis === 'object') a = raw.obj.analysis;
            else if (raw.obj.analysis_result && typeof raw.obj.analysis_result === 'object') a = raw.obj.analysis_result;
          }
          if (!a && raw.analysis_result && typeof raw.analysis_result === 'object') a = raw.analysis_result;
        }
      } catch { a = null; }

      if (!a || typeof a !== 'object') return null;

      let cand = null;
      try {
        cand = (typeof a.bestmove === 'string' ? a.bestmove : (typeof a.best_move === 'string' ? a.best_move : null));
        if (!cand && Array.isArray(a.main_pv) && typeof a.main_pv[0] === 'string') cand = a.main_pv[0];
        if (!cand && Array.isArray(a.pv) && typeof a.pv[0] === 'string') cand = a.pv[0];
      } catch { cand = null; }
      if (!(typeof cand === 'string' && cand.trim())) return null;

      const usi = cand.trim();
      // 念のためUSIとして成立するものだけ
      try {
        const p = parseUsi(usi);
        if (!p?.ok) return null;
      } catch {
        return null;
      }
      return usi;
    } catch {
      return null;
    }
  }, [reviewEnabled, gameState?.move_history, activeNavBase, reviewIndex, reviewDrawBestMove, activeIsBranched]);

  // 感想戦: 矢印/最善線の「手番」を本譜（activeNavBase）基準に固定（分岐中の打ち矢印方向ズレ防止）
  const reviewOverlayPlayer = useMemo(() => {
    try {
      if (!reviewEnabled || !gameState) return null;
      if (!(reviewDrawNextMove || reviewDrawBestMove)) return null;
      if (activeIsBranched) return null;
      const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
      const base = Number.isFinite(Number(activeNavBase)) ? Math.trunc(Number(activeNavBase))
        : (Number.isFinite(Number(reviewIndex)) ? Math.trunc(Number(reviewIndex)) : 0);
      const idx = Math.max(0, Math.min(base, hist.length));
      const st = deriveStateFromHistory(hist, idx);
      return (st && typeof st === 'object') ? (st.currentPlayer ?? st.current_player ?? null) : null;
    } catch {
      return null;
    }
  }, [reviewEnabled, gameState?.move_history, activeNavBase, reviewIndex, reviewDrawNextMove, reviewDrawBestMove, activeIsBranched]);



  const handleReviewManualMove = (move) => {
    const usi = (move && typeof move.usi === 'string') ? move.usi : null;
    if (!usi) return;
    if (!reviewEnabled || isSpectator) return;
    if (!gameState) return;

    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];

    // 分岐中: 現在の分岐局面からだけ進める
    if (isBranched) {
      const baseSt = effectiveReviewGameState;
      const nextSt = applyUsiToState(baseSt, usi);
      if (!nextSt) return;
      setLocalBranch((prev) => {
        if (!prev) return { baseIndex: reviewIndex, usiMoves: [usi] };
        const arr = Array.isArray(prev.usiMoves) ? prev.usiMoves : [];
        return { ...prev, usiMoves: [...arr, usi] };
      });
      return;
    }

    // 本譜の次手と一致したら、分岐せずそのまま進む
    const nextMainUsi = extractUsiFromHistoryEntry(hist[reviewIndex]);
    if (nextMainUsi && nextMainUsi === usi) {
      clearBranchAndSetReviewIndex(Math.min(totalMoves, reviewIndex + 1));
      return;
    }

    // それ以外は分岐開始
    const base = deriveStateFromHistory(hist, reviewIndex);
    const next = applyUsiToState(base, usi);
    if (!next) return;
    setLocalBranch({ baseIndex: reviewIndex, usiMoves: [usi] });
  };

  const handleSharedManualMove = (move) => {
    const usi = (move && typeof move.usi === 'string') ? move.usi : null;
    if (!usi) return;
    if (!reviewEnabled) return;
    if (!canOperateShared) return;
    sharedBoardUpdateEmit({ action: 'manual_move', usi });
  };

  const boardOnMove = (reviewEnabled && !isSpectator)
    ? (isSharedViewActive ? handleSharedManualMove : handleReviewManualMove)
    : handleMove;

  const cancelPendingMove = () => {
    try { setPendingMove(null); } catch {}
  };

  const confirmPendingMove = () => {
    const usi = pendingMove?.usi;
    if (!usi) {
      cancelPendingMove();
      return;
    }
    // optimistic preview stays until the server reflects the move
    try {
      setPendingMove(prev => (prev ? { ...prev, stage: 'sent', sentAt: Date.now() } : prev));
    } catch {}
    try { websocketService.emit('make_move', { game_id: gameId, usi }); } catch {}
  };
  const handleResign = () => setResignConfirmOpen(true);
  const confirmResign = () => {
    try { setResignConfirmOpen(false); } catch {}
    try { websocketService.emit('resign', { game_id: gameId }); } catch {}
  };
  const handleSendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    // 観戦者は終局後のみ送信可
    try { if (!canSendChat) return; } catch {}
    websocketService.emit('chat_message', { game_id: gameId, text });
    setChatInput('');
  };

  // Chat visibility/formatting
  const senteUserId = String((gameState?.players?.sente || {}).user_id || '');
  const goteUserId  = String((gameState?.players?.gote  || {}).user_id || '');
  const chatNameClass = (uidRaw) => {
    const uid = String(uidRaw || '');
    if (uid === 'system') return 'text-gray-500';
    if (uid && senteUserId && uid === senteUserId) return 'text-blue-600';
    if (uid && goteUserId  && uid === goteUserId)  return 'text-red-600';
    return 'text-green-600';
  };
  const chatDisplayName = (m) => (m?.username || m?.sender || t('ui.components.game.gameview.k9117f23d'));

  const normalizeChat = (m) => {
    if (!m) return null;
    const gid = (m.game_id ?? m.gameId ?? m.id ?? m.room_id ?? '') != null ? String(m.game_id ?? m.gameId ?? m.id ?? m.room_id ?? '') : '';
    const uid = (m.user_id ?? m.userId ?? m.uid ?? m.from_user_id ?? '') != null ? String(m.user_id ?? m.userId ?? m.uid ?? m.from_user_id ?? '') : '';
    const username = (m.username ?? m.sender ?? m.name ?? '') != null ? String(m.username ?? m.sender ?? m.name ?? '') : '';
    const text = (m.text ?? m.message ?? m.msg ?? '') != null ? String(m.text ?? m.message ?? m.msg ?? '') : '';
    const timestamp = (m.timestamp ?? m.ts ?? m.created_at ?? m.at ?? null);
    return {
      ...m,
      game_id: gid || String(gameId || ''),
      user_id: uid,
      username,
      text,
      timestamp: (timestamp != null) ? String(timestamp) : null,
    };
  };

  const chatKey = (m) => `${m?.timestamp || ''}|${m?.user_id || ''}|${m?.text || ''}`;

  const mergeChatMessages = (prev, incoming) => {
    const base = Array.isArray(prev) ? prev : [];
    const inc  = Array.isArray(incoming) ? incoming : [];
    const all = [];
    for (const x of base) { const n = normalizeChat(x); if (n) all.push(n); }
    for (const x of inc)  { const n = normalizeChat(x); if (n) all.push(n); }
    const map = new Map();
    for (const m of all) {
      const k = chatKey(m);
      if (!map.has(k)) map.set(k, m);
    }
    const out = Array.from(map.values());
    out.sort((a, b) => {
      const at = a?.timestamp ? String(a.timestamp) : '';
      const bt = b?.timestamp ? String(b.timestamp) : '';
      if (!at && !bt) return 0;
      if (!at) return 1;
      if (!bt) return -1;
      return at.localeCompare(bt);
    });
    return out;
  };

  const canSendChat = (!isSpectator) || isFinished;
  const chatPlaceholder = canSendChat ? t('ui.components.game.gameview.k2c6e57b2') : t('ui.components.game.gameview.k56d675cf');

useEffect(() => {
  finishedOnceRef.current = {};
}, [gameId]);

useEffect(() => {
  setIsFinished(false);
  finishedRef.current = false;
}, [gameId]);
if (loading) {
    return (
      <div className="p-6 card-like shogi-merge">
        <Card><CardContent className="p-6">{t('ui.components.game.gameview.kc7c610c8')}</CardContent></Card>
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <Alert><AlertDescription>{error}</AlertDescription></Alert>
      </div>
    );
  }
  if (!gameState) return null;

  




  // 解析グラフ: 現在表示中の盤（ローカル/共有盤）に合わせてカーソルを移動できるようにする。
  // - 共有盤表示中は共有盤カーソルを更新（操作権限がある場合のみ）
  // - 共有盤OFF時はローカル見返しカーソルを更新
  const selectMoveFromGraph = (moveNumber) => {
    try {
      if (!reviewEnabled) return;
      const n = Math.max(0, Math.min(totalMoves, parseInt(moveNumber, 10)));
      if (!Number.isFinite(n)) return;

      if (isSharedViewActive) {
        if (!canOperateShared) return;
        setSharedCursor(n);
        return;
      }
      clearBranchAndSetReviewIndex(n);
    } catch {}
  };

  // 解析グラフの赤線（現在位置）は、表示中の盤に合わせる。
  // 共有盤の分岐で cursor が本譜の総手数を超える場合は、グラフ側は本譜の範囲までに収める。
  const graphHighlightMove = (() => {
    try {
      const raw = isSharedViewActive ? sharedCursorClamped : reviewIndex;
      const v = Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : 0;
      return Math.max(0, Math.min(totalMoves, v));
    } catch {
      return 0;
    }
  })();

  // 共有盤表示中は、操作権限がない場合はグラフからの局面移動を無効化する。
  const graphSelectEnabled = !!(reviewEnabled && (!isSharedViewActive || canOperateShared));


  return (
      <>
      <Dialog open={resultModal.open} onOpenChange={(o)=> { modalOpenRef.current = !!o; setResultModal(m => ({...m, open: o})); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{resultModal.title}</DialogTitle>
            <DialogDescription>{resultModal.message}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <AlertDialog open={sharedBoardOfferOpen} onOpenChange={setSharedBoardOfferOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ui.components.game.gameview.kbb3504ff')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ui.components.game.gameview.k58406f20')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('ui.components.game.gameview.k275dcb68')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                try { setSharedBoardOfferOpen(false); } catch {}
                try { setSharedBoardViewEnabled(true); } catch {}
                try { if (reviewEnabled && isPlayer) sharedBoardToggleEmit(true); } catch {}
              }}
            >
              {t('ui.components.game.gameview.kfd9a4c0e')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={resignConfirmOpen} onOpenChange={setResignConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ui.components.game.gameview.kd11a57b8')}</AlertDialogTitle>
            <AlertDialogDescription>{t('ui.components.game.gameview.k4b36732b')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('ui.components.game.gameview.k269b0f92')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmResign}
            >
              {t('ui.components.game.gameview.k7045c901')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* 手の一覧ポップアップ（終了後のみ） */}
      <Dialog open={moveListOpen} onOpenChange={(o) => { if (!reviewEnabled) return; setMoveListOpen(o); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            {/* close(X)が右上に重なるので、右側に余白を確保する */}
            <div className="flex items-center justify-between gap-2 pr-12 flex-wrap">
              <DialogTitle>{t('ui.components.game.gameview.kca85a6a2')}</DialogTitle>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 flex items-center gap-1 border-slate-300 bg-slate-100 text-slate-900 shadow-sm hover:bg-slate-200 active:shadow-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-50 dark:hover:bg-slate-700"
                onClick={() => { try { handleCopyKifFromMoveList(); } catch {} }}
                disabled={kifCopyStatus === 'loading' || (gameId == null)}
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>
                  {kifCopyStatus === 'loading' ? t('ui.components.game.gameview.k4e8d15fe') : (kifCopyStatus === 'ok' ? t('ui.components.game.gameview.k3e2e7724') : (kifCopyStatus === 'err' ? t('ui.components.game.gameview.k0b0c4220') : t('ui.components.game.gameview.kdd07ca1d')))}
                </span>
              </Button>
            </div>
            <DialogDescription>{isSharedViewActive ? (canOperateShared ? t('ui.components.game.gameview.k1824fa3b') : t('ui.components.game.gameview.k05c3242b')) : t('ui.components.game.gameview.k4ccb29fc')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto divide-y">
            {/* 0手（初期局面）も選べるようにする */}
            <button type="button" className="w-full text-left px-3 py-2 hover:bg-gray-50"
                    onClick={() => { if (isSharedViewActive) { if (canOperateShared) setSharedCursor(0); setMoveListOpen(false); } else { clearBranchAndSetReviewIndex(0); setMoveListOpen(false); } }}>
              <span className="inline-block w-16">{t("ui.components.game.gameview.k3b419229", { n: 0 })}</span> {t("ui.components.game.gameview.k5e7b7c41")}
            </button>
            {Array.isArray(gameState?.move_history) && gameState.move_history.map((raw, idx) => {
              const n = idx + 1;
              const m = (raw && typeof raw === 'object' && raw.obj) ? raw.obj : raw;
              const kif = (raw && typeof raw === 'object' && raw.kif) ? raw.kif : '';
              const usi = (raw && typeof raw === 'object' && typeof raw.usi === 'string') ? raw.usi
                        : ((raw && typeof raw === 'object' && typeof raw.obj?.usi === 'string') ? raw.obj.usi : '');
              const fr = m.from || m.frm || m.f || m;
              const to = m.to || m.dst || m.t || m;
              const fromRow = (m.from_row ?? m.fromRow ?? fr?.row ?? fr?.r ?? null);
              const fromCol = (m.from_col ?? m.fromCol ?? fr?.col ?? fr?.c ?? null);
              const toRow   = (m.to_row   ?? m.toRow   ?? to?.row ?? to?.r ?? null);
              const toCol   = (m.to_col   ?? m.toCol   ?? to?.col ?? to?.c ?? null);
              const isDrop  = !!(m.is_drop ?? m.drop ?? (m.piece_type && (fromRow == null || fromCol == null)));
              const fallback = isDrop ? `* (${toRow},${toCol})` : `(${fromRow},${fromCol})→(${toRow},${toCol})`;
              const label = kif || usi || fallback;
              const evalText = _formatEvalText(_extractAnalysisFromMove(raw), n);
              return (
                <button
                  key={idx}
                  type="button"
                  className="w-full px-3 py-2 hover:bg-gray-50 flex items-center justify-between gap-2 text-left"
                  onClick={() => { if (isSharedViewActive) { if (canOperateShared) setSharedCursor(n); setMoveListOpen(false); } else { clearBranchAndSetReviewIndex(n); setMoveListOpen(false); } }}
                >
                  <div className="min-w-0">
                    <span className="inline-block w-16">{t("ui.components.game.gameview.k3b419229", { n })}</span>
                    <span className="truncate">{label}</span>
                  </div>
                  {(!suppressEvalDisplay && evalText) ? (
                    <span className="text-xs text-slate-600 font-mono shrink-0">{evalText}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* 解析: 最善手の読み筋（PV）再生 */}
      <AnalysisPvReplayOverlay
        open={pvReplayOpen}
        onOpenChange={(o) => {
          try { setPvReplayOpen(!!o); } catch {}
          if (!o) {
            try { setPvReplayPayload(null); } catch {}
          }
        }}
        baseState={pvReplayPayload?.baseState || null}
        baseMoveNumber={pvReplayPayload?.baseMoveNumber ?? 0}
        pvMoves={Array.isArray(pvReplayPayload?.pvMoves) ? pvReplayPayload.pvMoves : []}
      />

    <div className={(isDesktop ? 'p-4' : 'p-0') + ' h-full min-h-0'}>

      <div className={`flex ${isWideDesktop ? 'flex-row gap-3' : 'flex-col'} h-full min-h-0`}>
        {isWideDesktop ? (
          <aside className="flex flex-col w-[360px] min-w-[280px] max-w-[420px] h-full min-h-0">
            <div className="flex flex-col gap-3 h-full min-h-0">
              <div className="flex-[7] min-h-0 rounded-xl border border-white/70 bg-white/60 backdrop-blur-sm p-3 flex flex-col">
                <div className="text-sm font-semibold mb-2">{t("ui.components.game.gameview.kab9f7ee6")}</div>
                <div className="flex items-center gap-2">
                  <Input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat(); }}
                    placeholder={chatPlaceholder}
                    disabled={!canSendChat}
                    className="bg-white/70 border-white/70 backdrop-blur-sm placeholder:text-slate-400"
                  />
                  <Button
                    type="button"
                    onClick={handleSendChat}
                    disabled={!canSendChat}
                    size="sm"
                    className="shrink-0"
                  >{t("ui.components.game.gameview.k58aa7961")}</Button>
                </div>
                <ScrollArea
                  ref={chatScrollRef}
                  className="mt-2 flex-1 min-h-0 border border-white/70 rounded bg-white/60 backdrop-blur-sm p-2"
                >
                  <div className="space-y-0.5">
                    {chatMessages?.length ? chatMessages.map((m, i) => (
                      <div key={i} className="text-sm py-0.5"><span className={'font-semibold ' + chatNameClass(m.user_id)}>{chatDisplayName(m)}</span><span className="ml-1">{m.text}</span></div>
                    )) : <div className="text-sm text-slate-500">{t('ui.components.game.gameview.k0b8e51eb')}</div>}
                    <div ref={chatEndRef} />
                  </div>
                </ScrollArea>
              </div>

              <div className="flex-[3] min-h-0 rounded-xl border border-white/70 bg-white/60 backdrop-blur-sm p-3 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">{t("ui.components.game.gameview.kc2b82286")}</div>
                  <div className="text-xs text-slate-600">{t("ui.components.game.gameview.k28a3d57c", { n: (spectators || []).length })}</div>
                </div>
                <div className="flex-1 overflow-auto text-sm text-slate-500">
                  {(spectators && spectators.length > 0) ? (
                    <ul className="space-y-1">
                      {spectators.map(sp => (
                        <li key={sp.user_id || Math.random()} className="flex items-center gap-2">
                          <span className="inline-block w-5 h-5 rounded-full bg-gray-200" />
                          <span className="truncate">{sp.username || sp.user_id}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-slate-400">{t('ui.components.game.gameview.k4fae74ba')}</div>
                  )}
                </div>
              </div>
            </div>
          </aside>
        ) : null}

        <div className="flex flex-col h-full min-h-0 flex-1 min-w-0">
        {/* NOTE: ここは親が flex-col で、下段(.game-bottom)と高さを分け合います。
            h-full を付けるとこのブロックが常に全高を占有してしまい、
            その結果、対局開始直後に「盤だけしか見えない」（下段が画面外に押し出される）
            状態が発生します。高さ配分は CSS の .game-grid / .game-bottom の flex 指定に任せます。 */}
        {/* 背景の shogi-lobby-layer はタブレットでも欲しい。
            ただし余白問題は内側(sb-grid)の content-start 等で解消する。 */}
        <div className={'min-h-0 game-grid shogi-lobby-layer ' + (isDesktop ? 'rounded-xl p-3' : '')}>
          <div className="w-full flex flex-col items-stretch game-top flex-1 min-h-0" >
            <div className="flex-1 min-h-0 flex w-full">
            <ShogiBoard
            showCoordinates={coordVisible}
            onToggleCoordinates={() => setCoordVisible(v => !v)}
            gameState={boardStateForBoard}
            onMove={boardOnMove}
            isSpectator={isSpectator}
            currentUser={user || null}
            sharedBoardStatus={reviewEnabled ? sharedBoardStatus : null}
            postgamePresence={reviewEnabled ? postgamePresence : null}
            allowManualEdit={!!(reviewEnabled && !isSpectator && (!isSharedViewActive || canOperateShared))}
            interactionDisabled={boardInteractionDisabled || (isSharedViewActive && !canOperateShared)}
            moveConfirmEnabled={moveConfirmEnabled}
            onChangeMoveConfirmEnabled={setMoveConfirmEnabled}
            lastMoveOverrideUsi={lastMoveOverrideUsi}
            nextMainlineMoveUsi={(reviewEnabled && reviewDrawNextMove) ? nextMainlineMoveUsiForArrow : null}
            bestMoveUsi={(reviewEnabled && reviewDrawBestMove) ? bestMoveUsiForOverlay : null}
            reviewOverlayPlayer={reviewEnabled ? reviewOverlayPlayer : null}
            lastMoveFromHighlightEnabled={lastMoveFromHighlightEnabled}
            lastMovePieceHighlightEnabled={lastMovePieceHighlightEnabled}
            pendingMoveConfirm={(!reviewEnabled && pendingMove && pendingMove.stage === 'confirm') ? { usi: pendingMove.usi, kifText: pendingMove.kifText || '', toRow: pendingMove.toRow, toCol: pendingMove.toCol } : null}
            onConfirmMoveConfirm={confirmPendingMove}
            onCancelMoveConfirm={cancelPendingMove}
            timeState={{
              current_player: (isFinished ? 'none' : (timeStateNorm?.current_player || gameState.currentPlayer)),
              base_at: (isFinished ? Date.now() : (timeStateNorm?.base_at || Date.now())),
              breakdown: timeStateNorm?.breakdown || null,
              config: timeStateNorm?.config || (gameState?.time_config ?? null),
              sente_time_left: (ticking?.sente ?? timeStateNorm?.sente_left ?? 0),
              gote_time_left: (ticking?.gote  ?? timeStateNorm?.gote_left  ?? 0),
            }} onRequestClose={handleCloseGameScreen} className="w-full h-full" shellWidthMode={shellWidthMode} />
            </div>
            {/* === 見返しコントロール === */}
            <div className={'mt-3 w-full ' + (isDesktop ? 'flex' : 'hidden') + ' items-center justify-between gap-2 bg-white/70 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-sm border border-white/80 overflow-hidden game-opbar game-no-select ' + opbarScaleClass + ' ' + opbarLayoutClass + ' ' + opbarI18nClass}>

                {/* 左端: 盤サイズ + 符号 ON/OFF */}
                <div className={'flex items-center gap-2 ' + (splitMobileOpbar ? 'order-2' : '') + (isSe2Size ? ' hidden' : '')}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowChatMobile(v => !v)}
                    aria-label={t("ui.components.game.gameview.kab9f7ee6")}
                    title={t("ui.components.game.gameview.kab9f7ee6")}
                    className={'game-op-icon relative p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white ' + (isDesktop ? 'hidden' : '')}
                  >
                    <img src={chatBubbleIcon} alt={t("ui.components.game.gameview.kab9f7ee6")} className="w-4 h-4" />
                    {(!isDesktop && !showChatMobile && hasUnreadChat) && (
                      <span className="absolute -top-1 -right-1 inline-flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-600" />
                      </span>
                    )}
                  </Button>

                  {/* スマホでは盤サイズプルダウンを表示しない */}
                  <div className={isDesktop ? "block" : "hidden"}>
                    <select
                      value={shellWidthMode || "normal"}
                      onChange={(e) => {
                        const mode = e.target.value === "wide" ? "wide" : "normal";
                        if (onChangeShellWidthMode) {
                          onChangeShellWidthMode(mode);
                        }
                      }}
                      className={"text-xs opbar-size-select rounded-md border border-white/80 bg-white/90 px-1.5 py-1 shadow-sm focus:outline-none min-w-0"}
                      aria-label={t("ui.components.game.gameview.kb215ec6f")}
                      title={t("ui.components.game.gameview.kb215ec6f")}
                    >
                      <option value="normal">{t("ui.components.game.gameview.k469eb99a")}</option>
                      <option value="wide">{t("ui.components.game.gameview.kf38f97e8")}</option>
                    </select>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCoordVisible(v => !v)}
                    aria-label={coordVisible ? t('ui.components.game.gameview.k50bce13a') : t('ui.components.game.gameview.k99046845')}
                    title={coordVisible ? t('ui.components.game.gameview.k50bce13a') : t('ui.components.game.gameview.k99046845')}
                    className="game-op-icon p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                  >
                    <img
                      src={coordVisible ? eyeIcon : eyeSlashIcon}
                      alt={coordVisible ? t('ui.components.game.gameview.kf52f5b3e') : t('ui.components.game.gameview.k8ddc4f34')}
                      className="w-4 h-4"
                    />
                  </Button>

                      <MoveConfirmToggle
                    id="move-confirm-toggle-desktop-opbar"
                    checked={!!moveConfirmEnabled}
                    onChange={(v) => setMoveConfirmEnabled(!!v)}
                    labelClassName="text-xs text-slate-700 select-none"
                    wrapperClassName="game-op-toggle"
                  />
                  {reviewEnabled ? (
                    <SharedBoardToggle
                      id="shared-board-toggle-desktop-opbar"
                      checked={!!sharedBoardViewEnabled}
                      onChange={(v) => {
                        try { setSharedBoardViewEnabled(!!v); } catch {}
                        // 対局者のみサーバへ通知（観戦者はローカル表示のみ）
                        try { if (reviewEnabled && isPlayer) sharedBoardToggleEmit(!!v); } catch {}
                      }}
                      disabled={!reviewEnabled}
                      wrapperClassName="game-op-toggle"
                    />
                  ) : null}
                </div>

                {/* 中央: 見返し（対局中はグレーアウト） */}
                <div className={(splitMobileOpbar ? 'order-1 w-full flex items-center justify-center gap-2' : 'flex items-center justify-center gap-2')}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setActiveCursor(0)}
                    disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase <= 0}
                    aria-disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase <= 0}
                  >
                    &laquo;
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigateActive(-1)}
                    disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase <= 0}
                    aria-disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase <= 0}
                  >
                    &lsaquo;
                  </Button>

                  <button
                    type="button"
                    disabled={!reviewEnabled}
                    className={`opbar-move-count px-3 py-1 rounded-md border text-sm ${
                      !reviewEnabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'
                    }`}
                    onClick={() => { if (!reviewEnabled) return; setMoveListOpen(true); }}
                    aria-label={t("ui.components.game.gameview.k3baf9d41")}
                    title={t("ui.components.game.gameview.k3baf9d41")}
                  >
                    {activeStepLabel}
                    {activeEvalText ? (<span className="opbar-eval ml-2 text-xs font-mono text-slate-600">{activeEvalText}</span>) : null}
                  </button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigateActive(1)}
                    disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase >= totalMoves}
                    aria-disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase >= totalMoves}
                  >
                    &rsaquo;
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setActiveCursor(totalMoves)}
                    disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase >= totalMoves}
                    aria-disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase >= totalMoves}
                  >
                    &raquo;
                  </Button>
                </div>


                {/* 右端: 投了 / 退室 */}
                <div className={'flex items-center gap-2 ' + (splitMobileOpbar ? 'order-3' : '')}>
                  {!isSpectator && !isFinished ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleResign}
                      aria-label={t("ui.components.game.gameview.kd462b7f2")}
                      title={t("ui.components.game.gameview.kd462b7f2")}
                      className="game-op-icon p-2 shadow-sm border border-white/60"
                    >
                      <img src={flagIcon} alt={t("ui.components.game.gameview.kd462b7f2")} className="w-4 h-4" />
                    </Button>
                  ) : null}

                  {/* 退室（対局を閉じる）: 観戦者は常時 / 対局者は終局後のみ */}
                  {(isSpectator || isFinished) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onPointerDown={() => { try { triggerExitSfx(); } catch {} }}
                            onClick={() => { try { triggerExitSfx(); Promise.resolve(handleCloseGameScreen()).catch(() => {}); } catch {} }}
                      aria-label={t("ui.components.game.gameview.kc2c709bc")}
                      title={t("ui.components.game.gameview.kc2c709bc")}
                      className="game-op-icon p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                    >
                      <img src={leftIcon} alt={t("ui.components.game.gameview.kc2c709bc")} className="w-4 h-4" />
                    </Button>
                  )}
                </div>
            </div>

            <div className={'mt-3 w-full ' + (isDesktop ? 'hidden' : 'block')}>

              <div
                ref={mobileToolsRef}
                className="flex w-full items-stretch overflow-x-auto overflow-y-hidden snap-x snap-mandatory scroll-smooth gap-3 transition-[height] duration-200 touch-pan-x"
                style={{
                  WebkitOverflowScrolling: 'touch',
                  height: (!isDesktop && typeof mobileToolsH === 'number' && mobileToolsH > 0) ? `${mobileToolsH}px` : undefined,
                }}
                onScroll={() => {
                  try {
                    const el = mobileToolsRef.current;
                    if (!el) return;
                    const w = el.clientWidth || 1;
                    const p0 = Math.round((el.scrollLeft || 0) / w);
                    const maxP = Math.max(0, (mobileToolsTotalPages || 2) - 1);
                    const p = Math.max(0, Math.min(maxP, p0));
                    setMobileToolsPage(p);
                  } catch {}
                }}
              >
                <div className="w-full shrink-0 snap-start h-full relative">
                  {/*
                    NOTE: mobileToolsH で高さ固定すると、このページ(操作バー)も h-full になり
                    背景が大きな白いパネルに見える(iPad 実機で顕著)。
                    操作バー自体に背景があるので、ここでは全面背景を置かない。
                  */}
                  <div
                  className={
                    'w-full bg-white/70 backdrop-blur-sm shadow-sm border border-white/80 overflow-hidden game-opbar game-no-select ' + opbarI18nClass + ' ' +
                    (splitMobileOpbar
                      ? 'flex flex-wrap items-center justify-between gap-x-2 gap-y-2 rounded-2xl px-3 py-2'
                      : 'flex items-center justify-between gap-2 rounded-full px-3 py-1.5')
                  }
                >
                      {/* 左端: 盤サイズ + 符号 ON/OFF */}
                      <div className={'flex items-center gap-2 ' + (splitMobileOpbar ? 'order-2' : '') + (isSe2Size ? ' hidden' : '')}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setShowChatMobile(v => !v)}
                          aria-label={t("ui.components.game.gameview.kab9f7ee6")}
                          title={t("ui.components.game.gameview.kab9f7ee6")}
                          className={'game-op-icon relative p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white ' + (isDesktop ? 'hidden' : '')}
                        >
                          <img src={chatBubbleIcon} alt={t("ui.components.game.gameview.kab9f7ee6")} className="w-4 h-4" />
                          {(!isDesktop && !showChatMobile && hasUnreadChat) && (
                            <span className="absolute -top-1 -right-1 inline-flex h-2.5 w-2.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-600" />
                            </span>
                          )}
                        </Button>

                        {/* スマホでは盤サイズプルダウンを表示しない */}
                        <div className={isDesktop ? "block" : "hidden"}>
                          <select
                            value={shellWidthMode || "normal"}
                            onChange={(e) => {
                              const mode = e.target.value === "wide" ? "wide" : "normal";
                              if (onChangeShellWidthMode) {
                                onChangeShellWidthMode(mode);
                              }
                            }}
                            className={"text-xs opbar-size-select rounded-md border border-white/80 bg-white/90 px-1.5 py-1 shadow-sm focus:outline-none min-w-0"}
                            aria-label={t("ui.components.game.gameview.kb215ec6f")}
                            title={t("ui.components.game.gameview.kb215ec6f")}
                          >
                            <option value="normal">{t("ui.components.game.gameview.k469eb99a")}</option>
                            <option value="wide">{t("ui.components.game.gameview.kf38f97e8")}</option>
                          </select>
                        </div>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCoordVisible(v => !v)}
                          aria-label={coordVisible ? t('ui.components.game.gameview.k50bce13a') : t('ui.components.game.gameview.k99046845')}
                          title={coordVisible ? t('ui.components.game.gameview.k50bce13a') : t('ui.components.game.gameview.k99046845')}
                          className="game-op-icon p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                        >
                          <img
                            src={coordVisible ? eyeIcon : eyeSlashIcon}
                            alt={coordVisible ? t('ui.components.game.gameview.kf52f5b3e') : t('ui.components.game.gameview.k8ddc4f34')}
                            className="w-4 h-4"
                          />
                        </Button>

                      <MoveConfirmToggle
                        id="move-confirm-toggle-opbar"
                        checked={!!moveConfirmEnabled}
                        onChange={(v) => setMoveConfirmEnabled(!!v)}
                      />
                      {reviewEnabled ? (
                        <SharedBoardToggle
                          id="shared-board-toggle-mobile-opbar"
                          checked={!!sharedBoardViewEnabled}
                          onChange={(v) => {
                            try { setSharedBoardViewEnabled(!!v); } catch {}
                            try { if (reviewEnabled && isPlayer) sharedBoardToggleEmit(!!v); } catch {}
                          }}
                          disabled={!reviewEnabled}
                        />
                      ) : null}
                      </div>

                      {/* 中央: 見返し（対局中はグレーアウト） */}
                      <div className={splitMobileOpbar ? 'order-1 w-full flex items-center justify-center gap-2' : (isSe2Size ? 'flex-1 flex items-center justify-start gap-2' : 'flex items-center justify-center gap-2')}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setActiveCursor(0)}
                          disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase <= 0}
                          aria-disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase <= 0}
                        >
                          &laquo;
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigateActive(-1)}
                          disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase <= 0}
                          aria-disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase <= 0}
                        >
                          &lsaquo;
                        </Button>

                        <button
                          type="button"
                          disabled={!reviewEnabled}
                          className={`px-3 py-1 rounded-md border text-sm ${
                            !reviewEnabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'
                          }`}
                          onClick={() => { if (!reviewEnabled) return; setMoveListOpen(true); }}
                          aria-label={t("ui.components.game.gameview.k3baf9d41")}
                          title={t("ui.components.game.gameview.k3baf9d41")}
                        >
                          {activeStepLabel}
                          {activeEvalText ? (<span className="ml-2 text-xs font-mono text-slate-600">{activeEvalText}</span>) : null}
                        </button>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigateActive(1)}
                          disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase >= totalMoves}
                          aria-disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase >= totalMoves}
                        >
                          &rsaquo;
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setActiveCursor(totalMoves)}
                          disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase >= totalMoves}
                          aria-disabled={!reviewEnabled || (isSharedViewActive && !canOperateShared) || activeNavBase >= totalMoves}
                        >
                          &raquo;
                        </Button>
                      </div>


                      {/* 右端: 投了 / 退室 */}
                      <div className={'flex items-center gap-2 ' + (splitMobileOpbar ? 'order-3' : '')}>
                        {!isSpectator && !isFinished ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleResign}
                            aria-label={t("ui.components.game.gameview.kd462b7f2")}
                            title={t("ui.components.game.gameview.kd462b7f2")}
                            className="game-op-icon p-2 shadow-sm border border-white/60"
                          >
                            <img src={flagIcon} alt={t("ui.components.game.gameview.kd462b7f2")} className="w-4 h-4" />
                          </Button>
                        ) : null}

                        {/* 退室（対局を閉じる）: 観戦者は常時 / 対局者は終局後のみ */}
                        {(isSpectator || isFinished) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onPointerDown={() => { try { triggerExitSfx(); } catch {} }}
                      onClick={() => { try { triggerExitSfx(); Promise.resolve(handleCloseGameScreen()).catch(() => {}); } catch {} }}
                            aria-label={t("ui.components.game.gameview.kc2c709bc")}
                            title={t("ui.components.game.gameview.kc2c709bc")}
                            className="game-op-icon p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                          >
                            <img src={leftIcon} alt={t("ui.components.game.gameview.kc2c709bc")} className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                  </div>
                </div>

                {isSe2Size ? (
                  <div className="w-full shrink-0 snap-start h-full overflow-hidden">
                    <div className="w-full h-full min-h-0 bg-white/70 backdrop-blur-sm rounded-2xl px-3 py-2 shadow-sm border border-white/80 flex items-start justify-start gap-2 overflow-hidden game-no-select">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowChatMobile(v => !v)}
                        aria-label={t("ui.components.game.gameview.kab9f7ee6")}
                        title={t("ui.components.game.gameview.kab9f7ee6")}
                        className="game-op-icon relative p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                      >
                        <img src={chatBubbleIcon} alt={t("ui.components.game.gameview.kab9f7ee6")} className="w-4 h-4" />
                        {(!isDesktop && !showChatMobile && hasUnreadChat) && (
                          <span className="absolute -top-1 -right-1 inline-flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-600" />
                          </span>
                        )}
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCoordVisible(v => !v)}
                        aria-label={coordVisible ? t('ui.components.game.gameview.k50bce13a') : t('ui.components.game.gameview.k99046845')}
                        title={coordVisible ? t('ui.components.game.gameview.k50bce13a') : t('ui.components.game.gameview.k99046845')}
                        className="game-op-icon p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                      >
                        <img
                          src={coordVisible ? eyeIcon : eyeSlashIcon}
                          alt={coordVisible ? t('ui.components.game.gameview.kf52f5b3e') : t('ui.components.game.gameview.k8ddc4f34')}
                          className="w-4 h-4"
                        />
                      </Button>

                      <MoveConfirmToggle
                        id="move-confirm-toggle-se2"
                        checked={!!moveConfirmEnabled}
                        onChange={(v) => setMoveConfirmEnabled(!!v)}
                      />
                      {reviewEnabled ? (
                        <SharedBoardToggle
                          id="shared-board-toggle-se2"
                          checked={!!sharedBoardViewEnabled}
                          onChange={(v) => {
                            try { setSharedBoardViewEnabled(!!v); } catch {}
                            try { if (reviewEnabled && isPlayer) sharedBoardToggleEmit(!!v); } catch {}
                          }}
                          disabled={!reviewEnabled}
                        />
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="w-full shrink-0 snap-start h-full overflow-hidden">
                  {isSe2Size ? (
                    <AnalysisBarCompact analysisDerived={analysisDerived} gameState={gameState} isFinished={isFinished} suppressBestDisplay={activeIsBranched} deriveStateFromHistory={deriveStateFromHistory} applyUsiToState={applyUsiToState} usiToKifMove={_usiToKifMove} extractAnalysisFromMove={_extractAnalysisFromMove} onOpenPvReplay={(pl) => { try { setPvReplayPayload(pl); setPvReplayOpen(true); } catch {} }}
                      highlightMove={graphHighlightMove}
                      onSelectMove={graphSelectEnabled ? selectMoveFromGraph : null}
                    />
                  ) : (
                    <div className="w-full h-full min-h-0 bg-white/70 backdrop-blur-sm rounded-2xl p-3 shadow-sm border border-white/80 flex flex-col">
                      <AnalysisPanel analysisDerived={analysisDerived} gameState={gameState} isFinished={isFinished} suppressEvalDisplay={suppressEvalDisplay} suppressBestDisplay={activeIsBranched} deriveStateFromHistory={deriveStateFromHistory} applyUsiToState={applyUsiToState} usiToKifMove={_usiToKifMove} extractAnalysisFromMove={_extractAnalysisFromMove} formatEvalText={_formatEvalText} onOpenPvReplay={(pl) => { try { setPvReplayPayload(pl); setPvReplayOpen(true); } catch {} }} highlightMove={graphHighlightMove} onSelectMove={graphSelectEnabled ? selectMoveFromGraph : null} fillHeight={true} className="h-full flex flex-col min-h-0" />
                    </div>
                  )}
                </div>
              </div>

              <div ref={mobileDotsRef} className="mt-2 flex items-center justify-between gap-3 px-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => scrollMobileToolsTo(Math.max(0, mobileToolsPage - 1))}
                  disabled={mobileToolsPage === 0}
                  aria-label={t("ui.components.game.gameview.kdda84a4c")}
                  title={t("ui.components.game.gameview.kdda84a4c")}
                  className={mobileToolsPage === 0 ? "opacity-40" : ""}
                >
                  &lsaquo;
                </Button>

                <div className="flex-1 flex flex-col items-center justify-center select-none">
                  <div className="h-1 w-12 rounded-full bg-slate-400/40" />
                  <div className="mt-1 text-xs text-slate-600">{t("ui.components.game.gameview.kf68b1721", { cur: mobileToolsPage + 1, total: mobileToolsTotalPages })}</div>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => scrollMobileToolsTo(Math.min((mobileToolsTotalPages || 2) - 1, mobileToolsPage + 1))}
                  disabled={mobileToolsPage === (mobileToolsTotalPages - 1)}
                  aria-label={t("ui.components.game.gameview.kb1445ddb")}
                  title={t("ui.components.game.gameview.kb1445ddb")}
                  className={mobileToolsPage === (mobileToolsTotalPages - 1) ? "opacity-40" : ""}
                >
                  &rsaquo;
                </Button>
              </div>
            </div>

          </div>
        </div>

          {!isWideDesktop ? (
                <div className={'border-t pt-2 ' + (isDesktop ? 'block' : 'hidden') + ' game-bottom min-h-0 overflow-hidden'}>

          <div className="grid grid-cols-12 gap-3 h-full min-h-0">
            {/* チャット（少し狭める） */}
            <div className="col-span-8 h-full min-h-0 flex flex-col">
              <div className="flex items-center gap-2">
                <Input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat(); }}
                  placeholder={chatPlaceholder}
                  disabled={!canSendChat}
                  className="bg-white/70 border-white/70 backdrop-blur-sm placeholder:text-slate-400"
                />
                <Button
                  type="button"
                  onClick={handleSendChat}
                  disabled={!canSendChat}
                  size="sm"
                  className="shrink-0"
                >{t("ui.components.game.gameview.k58aa7961")}</Button>
              </div>
              <ScrollArea
                ref={chatScrollRef}
                className="mt-2 flex-1 min-h-0 border border-white/70 rounded bg-white/60 backdrop-blur-sm p-2"
              >
                <div className="space-y-0.5">
                  {chatMessages?.length ? chatMessages.map((m, i) => (
                    <div key={i} className="text-sm py-0.5"><span className={"font-semibold " + chatNameClass(m.user_id)}>{chatDisplayName(m)}</span><span className="ml-1">{m.text}</span></div>
                  )) : <div className="text-sm text-slate-500">{t('ui.components.game.gameview.k0b8e51eb')}</div>}
                  <div ref={chatEndRef} />
                </div>
          </ScrollArea>
            </div>
            {/* 閲覧者リストの枠（中身はまだダミー） */}
            <div className="col-span-4 h-full min-h-0">
              <div className="border border-white/70 rounded bg-white/60 backdrop-blur-sm p-2 h-full min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">{t("ui.components.game.gameview.kc2b82286")}</div>
                  <div className="text-xs text-slate-600">{t("ui.components.game.gameview.k28a3d57c", { n: (spectators || []).length })}</div>
                </div>
                <div className="flex-1 overflow-auto text-sm text-slate-500">
{(spectators && spectators.length > 0) ? (
                  <ul className="space-y-1">
                    {spectators.map(sp => (
                      <li key={sp.user_id || Math.random()} className="flex items-center gap-2">
                        <span className="inline-block w-5 h-5 rounded-full bg-gray-200" />
                        <span className="truncate">{sp.username || sp.user_id}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-slate-400">{t('ui.components.game.gameview.k4fae74ba')}</div>
                )}
                </div>
              </div>
            </div>
          </div>
        </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        
      </div>
    </div>

        

      {isDesktop && (isFinished || (analysisDerived && analysisDerived.progress > 0)) ? (
        <div
          ref={analysisOverlayRef}
          className={`fixed z-40 pointer-events-auto ${analysisOverlayPos ? '' : 'left-3 bottom-3'}`}
          style={analysisOverlayPos ? { left: analysisOverlayPos.x, top: analysisOverlayPos.y } : undefined}
        >
          {analysisOverlayCollapsed ? (
            <button
              type="button"
              className="bg-white/80 backdrop-blur-sm rounded-full shadow-lg border border-white/70 px-3 py-2 flex items-center gap-3"
              onPointerDown={onAnalysisOverlayPointerDown}
              onPointerMove={onAnalysisOverlayPointerMove}
              onPointerUp={onAnalysisOverlayPointerUp}
              onPointerCancel={onAnalysisOverlayPointerUp}
              onClick={() => {
                if (suppressAnalysisOverlayClickRef.current) {
                  suppressAnalysisOverlayClickRef.current = false;
                  return;
                }
                setAnalysisOverlayCollapsed(false);
              }}
              aria-label={t('ui.components.game.gameview.k4f50dc1e')}
              title={t('ui.components.game.gameview.k4f50dc1e')}
            >
              <span className="text-xs font-semibold">{t('ui.components.game.gameview.kaf57b02c')}</span>
              {(analysisDerived?.status === 'error' || (analysisDerived?.error && String(analysisDerived.error).trim())) ? (
                <span className="text-xs text-red-700 font-semibold">{t('ui.components.game.gameview.kec6399d6')}</span>
              ) : ((analysisDerived?.total > 0) ? (
                <span className="text-xs text-slate-600 font-mono">{`${analysisDerived.progress}/${analysisDerived.total}`}</span>
              ) : null)}
            </button>
          ) : (
            <div className={`${analysisOverlayGraphSize === 'large' ? 'w-[640px]' : 'w-[320px]'} max-w-[calc(100vw-1.5rem)] bg-white/80 backdrop-blur-sm rounded-2xl shadow-lg border border-white/70 p-3`}>
              <div
                className="flex items-center justify-between mb-2 -mx-1 px-1 py-1 cursor-move select-none"
                onPointerDown={onAnalysisOverlayPointerDown}
                onPointerMove={onAnalysisOverlayPointerMove}
                onPointerUp={onAnalysisOverlayPointerUp}
                onPointerCancel={onAnalysisOverlayPointerUp}
                title={t('ui.components.game.gameview.kbdcb848f')}
              >
                <div className="text-sm font-semibold">{t('ui.components.game.gameview.k8bed108e')}</div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onPointerDown={(e) => { try { e.stopPropagation(); } catch {} }}
                    onClick={() => setAnalysisOverlayGraphSize(s => (s === 'large' ? 'normal' : 'large'))}
                    className="h-7 w-7 cursor-pointer"
                    aria-label={analysisOverlayGraphSize === 'large' ? t('ui.components.game.gameview.k17606366') : t('ui.components.game.gameview.k7b72fddf')}
                    title={analysisOverlayGraphSize === 'large' ? t('ui.components.game.gameview.k469eb99a') : t('ui.components.game.gameview.k0171929a')}
                  >
                    {analysisOverlayGraphSize === 'large' ? (
                      <ShrinkIcon className="h-4 w-4" />
                    ) : (
                      <ExpandIcon className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onPointerDown={(e) => { try { e.stopPropagation(); } catch {} }}
                    onClick={() => setAnalysisOverlayCollapsed(true)}
                    className="h-7 w-7 cursor-pointer"
                    aria-label={t('ui.components.game.gameview.kb464a426')}
                    title={t('ui.components.game.gameview.kc0e6dd22')}
                  >
                    <CollapseIcon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <AnalysisPanel analysisDerived={analysisDerived} gameState={gameState} isFinished={isFinished} suppressEvalDisplay={suppressEvalDisplay} suppressBestDisplay={activeIsBranched} deriveStateFromHistory={deriveStateFromHistory} applyUsiToState={applyUsiToState} usiToKifMove={_usiToKifMove} extractAnalysisFromMove={_extractAnalysisFromMove} formatEvalText={_formatEvalText} onOpenPvReplay={(pl) => { try { setPvReplayPayload(pl); setPvReplayOpen(true); } catch {} }}
                highlightMove={graphHighlightMove}
                showHeader={false}
                onSelectMove={graphSelectEnabled ? selectMoveFromGraph : null}
                graphSize={analysisOverlayGraphSize}
              />
            </div>
          )}
        </div>
      ) : null}

      {/* モバイル: チャットスライドオーバー */}
      <div className={`fixed inset-x-0 bottom-0 z-50 transform transition-transform duration-300 ${isDesktop ? 'hidden' : ''} ` + (showChatMobile ? 'translate-y-0' : 'translate-y-full')}>
        <div className="bg-white rounded-t-2xl shadow-2xl border-t p-3 h-[75svh] flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">{t("ui.components.game.gameview.kab9f7ee6")}</div>
            <Button size="sm" variant="ghost" onClick={() => setShowChatMobile(false)}>{t('ui.components.game.gameview.k3da5c185')}</Button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat(); }}
              placeholder={chatPlaceholder}
                  disabled={!canSendChat}
            />
            <Button onClick={handleSendChat} disabled={!canSendChat}>{t('ui.components.game.gameview.k58aa7961')}</Button>
          </div>
          <ScrollArea ref={chatScrollRef} className="mt-2 flex-1 min-h-0 border rounded p-2">
            <div className="space-y-0.5">
              {chatMessages?.length ? chatMessages.map((m, i) => (
                <div key={i} className="text-sm py-0.5"><span className={"font-semibold " + chatNameClass(m.user_id)}>{chatDisplayName(m)}</span><span className="ml-1">{m.text}</span></div>
              )) : <div className="text-sm text-slate-500">{t('ui.components.game.gameview.k0b8e51eb')}</div>}
              <div ref={chatEndRef} />
            </div>
          </ScrollArea>
        </div>
      </div>
{/* 接続待ちオーバーレイ */}
        {(!isSpectator && !isFinished && dcOverlay?.show) && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 pointer-events-none select-none">
            <div className="bg-white shadow-xl rounded-xl p-6 text-center pointer-events-auto">
              <div className="text-lg font-semibold mb-2">{t("ui.components.game.gameview.k0775f5d2")}</div>
              <div className="text-sm text-gray-600 mb-4">{t("ui.components.game.gameview.kd36a552b", { time: formatMsToMMSS(Math.max(0, (dcOverlay.leftMsShadow ?? dcOverlay.remainingMs))) })}</div>
              <div className="text-xs text-gray-500">{t("ui.components.game.gameview.k24db7b80")}</div>
            </div>
          </div>
        )}

        </>
  );
};

export default GameView;