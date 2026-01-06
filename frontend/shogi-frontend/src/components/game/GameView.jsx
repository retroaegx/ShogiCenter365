
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useIsMountedRef } from '@/hooks/useIsMountedRef';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ShogiBoard from '@/components/game/ShogiBoard';
import eyeIcon from '@/assets/icons/eye.svg';
import eyeSlashIcon from '@/assets/icons/eye-slash.svg';
import chatBubbleIcon from '@/assets/icons/chat_bubble.svg';
import leftIcon from '@/assets/icons/left.svg';
import flagIcon from '@/assets/icons/flag.svg';
import { createInitialBoard, makeMove, makeDrop, PLAYERS, PIECE_NAMES } from '@/utils/shogiLogic';
import { parseUsi } from '@/utils/usi';
import websocketService from '@/services/websocketService';
import api from '@/services/apiClient';
import useSound from '@/hooks/useSound';
// global gate for finished modal (avoid double overlay across multiple mounts)
if (typeof window !== 'undefined') { window.__gameFinishedGate ||= {}; }

import { useAuth } from '@/contexts/AuthContext';

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
    const t = setInterval(() => setNow(Date.now()), 250);
    const onVis = () => setNow(Date.now());
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
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

const GameView = ({
  gameId,
  isSpectator = false,
  onLeaveGame,
  onRequestClose,
  shellWidthMode = "normal",
  onChangeShellWidthMode,
  coordVisible: coordVisibleProp,
  onChangeCoordVisible,
}) => {
  const isMountedRef = useIsMountedRef();
  const { user } = useAuth();
    const { playEnv, playSfx, preload } = useSound();
const exitSoundPlayedRef = useRef(false);

  const [gameState, setGameState] = useState(null);
  const [coordVisibleInner, setCoordVisibleInner] = useState(true);
  const coordVisible = (typeof coordVisibleProp === 'boolean') ? coordVisibleProp : coordVisibleInner;
  const setCoordVisible = onChangeCoordVisible || setCoordVisibleInner;
  const [timeStateNorm, setTimeStateNorm] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  // === ローカル見返し（リプレイ）用の状態 ===
  const [reviewIndex, setReviewIndex] = useState(0);
  const [moveListOpen, setMoveListOpen] = useState(false);
  const [showChatMobile, setShowChatMobile] = useState(false);
  const [hasUnreadChat, setHasUnreadChat] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia('(min-width: 768px)').matches;
  });
  const isWideDesktop = isDesktop && shellWidthMode === 'wide';
  const layoutRef = useRef(null);
  const [layoutH, setLayoutH] = useState(0);
  const [gridRows, setGridRows] = useState('auto auto');
  const totalMoves = useMemo(() => Array.isArray(gameState?.move_history) ? gameState.move_history.length : 0, [gameState?.move_history?.length]);

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
  const [mobileToolsPage, setMobileToolsPage] = useState(0);
  const mobileToolsRef = useRef(null);
  const [mobileToolsH, setMobileToolsH] = useState(null);
  const mobileDotsRef = useRef(null);

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
  const [isFinished, setIsFinished] = useState(false);
  const reviewEnabled = isFinished;
  // 再生ユーティリティ: USI の move_history から局面を導出
  // ※ base_board は不要（初期局面は createInitialBoard() で固定）
  const deriveStateFromHistory = (moveHistory, upto) => {
    const hist = Array.isArray(moveHistory) ? moveHistory : [];
    const end = Math.max(0, Math.min(upto ?? hist.length, hist.length));
    let state = {
      board: createInitialBoard(),
      capturedPieces: { sente: {}, gote: {} },
      currentPlayer: PLAYERS.SENTE,
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


  // レビュー表示用の仮想ゲーム状態を構築（サーバと同期しないローカルのみ）
    
  const displayGameState = useMemo(() => {
    if (!reviewEnabled || !gameState) return gameState;
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    const idx = Math.max(0, Math.min(reviewIndex, hist.length));
    const s = deriveStateFromHistory(hist, idx);
    const serverTurn = (gameState?.current_turn ?? gameState?.game_state?.current_turn ?? gameState?.time_state?.current_player ?? null);
    return { ...s, currentPlayer: (serverTurn || s.currentPlayer), players: gameState?.players || {}, move_history: hist.slice(0, idx) };
  }, [reviewEnabled, reviewIndex, gameState]);
  const derivedLiveState = useMemo(() => {
    if (!gameState) return gameState;
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    const s = deriveStateFromHistory(hist, hist.length);
    const serverTurn = (gameState?.current_turn ?? gameState?.game_state?.current_turn ?? gameState?.time_state?.current_player ?? null);
    return { ...s, players: gameState?.players || {}, move_history: hist };
  }, [gameState]);



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
      const r = await api.get('/lobby/online-users');
      const arr = Array.isArray(r?.data?.users) ? r.data.users : [];
      const mine = arr.find(u =>
        String(u.user_id?.$oid || u.user_id?.oid || u.user_id?.id || u.user_id || '') === meId
      );
      myWaiting = mine?.waiting ?? null;
    } catch (e) {
      // 取得失敗でも閉じるのを妨げない
      console.warn('online-users fetch failed (allow close)', e);
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
      // 対局終了時（環境音）
      if (!isSpectator) {
        try { playEnv?.('game_end'); } catch {}
      }
      setIsFinished(true);
      setDcOverlay(prev => (prev && prev.show) ? ({ ...prev, show: false }) : prev);
      finishedRef.current = true;
      setTimeStateNorm(prev => prev ? ({ ...prev, base_at: Date.now(), current_player: 'none' }) : prev);
      try { if (websocketService.off) websocketService.off('time_update', handleTimeUpdate); } catch {}

      if (modalOpenRef.current) return;

      const gidKey = data?.game_id != null ? String(data.game_id) : 'unknown';
      if (finishedOnceRef.current[gidKey]) return;
      finishedOnceRef.current[gidKey] = true;

    
    // force-refresh JWT once at end of game
    ;(async () => {
      try {
        const r = await api.post('/auth/rotate');
        const t = r?.data?.access_token;
        if (t) {
          localStorage.setItem('access_token', t);
          localStorage.setItem('token', t);
          try { if (websocketService.disconnect) websocketService.disconnect(); } catch {}
          try { if (websocketService.connect) websocketService.connect(t); } catch {}
        }
      } catch (e) {
        console.error('rotate at finish failed', e);
      }
    })();
const gid = data?.game_id != null ? String(data.game_id) : null;
    const currentId =
      (typeof gameId !== 'undefined' && gameId != null)
        ? String(gameId)
        : (gameState?.id != null
            ? String(gameState.id)
            : (gameState?.game_id != null ? String(gameState.game_id) : null));
    if (gid && currentId && currentId !== gid) return;
    // global gate: ensure single finished-modal across multiple mounts
    try {
      if (typeof window !== 'undefined') {
        window.__gameFinishedGate ||= {};
        const kk = gid || currentId || 'unknown';
        if (kk && window.__gameFinishedGate[kk]) { return; }
        window.__gameFinishedGate[kk] = true;
      }
    } catch {}


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

    if (isSpectator || !myRole) {
      return;
    }


    const winnerRole = data?.winner || null;
    const iWon = (me && w_uid && me === w_uid)
              || (!w_uid && myRole && winnerRole && myRole === String(winnerRole));

    const title = iWon ? 'あなたの勝ち！' : '負けちゃった…';
    const oppName = iWon ? (data?.loser_username || '') : (data?.winner_username || '');
    const reason = data?.reason === 'resign' ? '投了' : (data?.reason || '');
    const msg = oppName ? `${oppName} に${reason}で${iWon ? '勝ちました' : '負けました'}`
                        : `${reason || '終局'}。${iWon ? '勝ち' : '負け'}`;
    setResultModal({ open: true, title, message: msg });
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
}, [gameId, user?.user_id, gameState?.players?.sente?.user_id, gameState?.players?.gote?.user_id]);
  const pausedByDisconnect = !!(dcOverlay && dcOverlay.show) || (gameState?.status === 'pause');

  const currentTurn = (pausedByDisconnect || isFinished) ? 'none' : (gameState?.currentPlayer || timeStateNorm?.current_player || 'sente');
  const ticking = useTickingClock(timeStateNorm ? { ...timeStateNorm, current_player: ((pausedByDisconnect || isFinished) ? 'none' : currentTurn)} : null);

  useEffect(() => {
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
      board: shaped?.board ?? prev?.board ?? null,
      capturedPieces: shaped?.capturedPieces ?? prev?.capturedPieces ?? { sente:{}, gote:{} },
      currentPlayer: shaped?.currentPlayer ?? prev?.currentPlayer ?? 'sente',
      move_history: Array.isArray(shaped?.move_history)
        ? shaped.move_history
        : (Array.isArray(prev?.move_history) ? prev.move_history : []),
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
        setTimeStateNorm(normalizeTime(data));
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
    isMountedRef.current = true; // <-- fixed: true (JS) not True

    fetchGameData();

    return () => {
      websocketService.off('game_update', handleGameUpdate);
      websocketService.off('analysis_update', handleAnalysisUpdate);
      websocketService.off('time_update', handleTimeUpdate);
      websocketService.off('chat_message', handleChatMessage);
      websocketService.off('chat_history', handleChatHistory);
      websocketService.off('game:move', handleGameMove);

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
        setError(`HTTP ${res.status}: ${res.statusText} (non-JSON response)`);
        setLoading(false);
        return false;
      }
      const keys = Object.keys(json || {});
      console.info('[GAME RAW] keys=', keys, 'sample=', JSON.stringify(json).slice(0, 500));

      if (!res.ok) {
        setError(`HTTP ${res.status}: ${res.statusText} | message=${json?.message || json?.error || 'unknown'}`);
        setLoading(false);
        return false;
      }

      const g = json.success ? json.data : (json.game_state ? json : (json.payload || json));
      if (!g) {
        setError(`Invalid payload: keys=${keys.join(',')}`);
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
      setError('ゲーム情報の取得に失敗しました');
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
      return `詰み${s}`;
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
      const kan = ['','一','二','三','四','五','六','七','八','九'][rank] || String(rank);
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
      if (s === 'resign') return '投了';
      if (s === 'win') return '勝ち';
      if (s === 'none') return null;

      const u = parseUsi(s);
      if (!u?.ok) return s;

      const dst = _rcToKifSquare(u.toRow, u.toCol);
      if (!dst) return s;

      if (u.isDrop) {
        const pn = PIECE_NAMES?.[u.pieceType] || '駒';
        return `${dst}${pn}打`;
      }

      const b = positionState?.board;
      const pieceObj = (b && b[u.fromRow] && b[u.fromRow][u.fromCol]) ? b[u.fromRow][u.fromCol] : null;
      const pt = pieceObj?.piece || null;
      const pn = PIECE_NAMES?.[pt] || '駒';
      return `${dst}${pn}${u.promote ? '成' : ''}`;
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
    const status =
      statusFromServer ||
      (total > 0 && progress >= total ? 'done' : (progress > 0 ? 'running' : null));
    return { total, progress, status, values };
  }, [gameState?.move_history, gameState?.analysis_status]);

  const currentEvalText = useMemo(() => {
    const hist = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    if (!reviewIndex || reviewIndex <= 0) return null;
    const raw = hist[reviewIndex - 1] || null;
    const a = _extractAnalysisFromMove(raw);
    return _formatEvalText(a, reviewIndex);
  }, [reviewIndex, gameState?.move_history]);
  
  // モバイル: 解析ページ(2ページ目)を表示するときだけ、画面の残り高さに合わせてツール領域の高さを固定する
  useEffect(() => {
    if (isDesktop) return;
    if (mobileToolsPage !== 1) return;

    const recompute = () => {
      try {
        const el = mobileToolsRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vh = (window.visualViewport && typeof window.visualViewport.height === 'number')
          ? window.visualViewport.height
          : window.innerHeight;
        const dotsH = mobileDotsRef.current ? (mobileDotsRef.current.getBoundingClientRect().height || 0) : 0;
        // 少し余白を確保（下のドット + 余白）
        const avail = Math.max(160, Math.floor(vh - rect.top - dotsH - 24));
        setMobileToolsH(avail);
      } catch {}
    };

    const t = setTimeout(recompute, 0);
    window.addEventListener('resize', recompute);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', recompute);

    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', recompute);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', recompute);
    };
  }, [isDesktop, mobileToolsPage, analysisDerived?.progress, analysisDerived?.total]);

const handleMove = (move) => {
    const usi = (move && typeof move.usi === 'string') ? move.usi : null;
    if (!usi) return;
    websocketService.emit('make_move', { game_id: gameId, usi });
  };
  const handleResign = () => websocketService.emit('resign', { game_id: gameId });
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
    if (uid && senteUserId && uid === senteUserId) return 'text-blue-600';
    if (uid && goteUserId  && uid === goteUserId)  return 'text-red-600';
    return 'text-green-600';
  };
  const chatDisplayName = (m) => (m?.username || m?.sender || '匿名');

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
  const chatPlaceholder = canSendChat ? 'メッセージを入力...' : '対局中は観戦者はチャットできません';

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
        <Card><CardContent className="p-6">読み込み中...</CardContent></Card>
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

  




  const selectMoveFromGraph = (moveNumber) => {
    try {
      if (!reviewEnabled) return;
      const n = Math.max(0, Math.min(totalMoves, parseInt(moveNumber, 10)));
      if (!Number.isFinite(n)) return;
      setReviewIndex(n);
    } catch {}
  };

  const AnalysisGraphSvg = ({ values, highlightMove, onSelectMove = null, className = "w-full h-[70px]" }) => {
    try {
      const arr = Array.isArray(values) ? values : [];
      const n = arr.length;
      const present = arr.filter(v => typeof v === 'number' && Number.isFinite(v));
      if (!n || present.length === 0) return null;

      const maxAbsRaw = Math.max(...present.map(v => Math.abs(v)));
      const maxAbs = Math.max(1000, Math.min(6000, maxAbsRaw || 0));

      const LABEL_W = 18;
      const PLOT_W = 100;
      const W = LABEL_W + PLOT_W;
      const H = 40;
      const mid = H / 2;
      const amp = (H / 2) - 2;
      const yTop = mid - amp;
      const yBot = mid + amp;

      // minor grid lines every 1000 (thin)
      const minorStep = 1000;
      const minorTicks = [];
      for (let v = minorStep; v < maxAbs; v += minorStep) {
        minorTicks.push(v, -v);
      }
      minorTicks.sort((a, b) => b - a);

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
          aria-label="解析グラフ"
          role={onSelectMove ? "button" : undefined}
          preserveAspectRatio="none"
          onMouseDown={handlePointerDown}
          onTouchStart={handlePointerDown}
        >
          <rect x="0" y="0" width={W} height={H} fill="transparent" pointerEvents="all" />
          <line x1={LABEL_W} y1={mid} x2={W} y2={mid} stroke="currentColor" strokeOpacity="0.25" strokeWidth="0.7" />
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
          {hx != null ? (
            <line x1={hx} y1="0" x2={hx} y2={H} stroke="#ef4444" strokeOpacity="0.9" strokeWidth="1.2" />
          ) : null}
          <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    } catch {
      return null;
    }
  };

  const AnalysisPanel = ({
    highlightMove,
    showHeader = true,
    onSelectMove = null,
    fillHeight = false,
    graphSize = 'normal',
    className = "",
  }) => {
    const total = analysisDerived?.total ?? 0;
    const progress = analysisDerived?.progress ?? 0;
    const values = analysisDerived?.values ?? [];
    const done = (analysisDerived?.status === 'done') || (total > 0 && progress >= total);

    let msg = '終局後に解析が表示されます';
    if (isFinished && progress <= 0) msg = '終局しました。解析待ち…';
    if (isFinished && progress > 0 && progress < total) msg = `解析中… ${progress}/${total}`;
    if (done && total > 0) msg = '解析完了';

    // グラフ上部に表示する: 現在手の評価と最善手（解析がある場合）
    const topMoveN = (typeof highlightMove === 'number' && Number.isFinite(highlightMove)) ? Math.trunc(highlightMove) : 0;
    const histLocal = Array.isArray(gameState?.move_history) ? gameState.move_history : [];
    let topAnalysis = null;
    if (topMoveN > 0 && topMoveN <= histLocal.length) topAnalysis = _extractAnalysisFromMove(histLocal[topMoveN - 1]);
    const topEval = (topMoveN > 0) ? _formatEvalText(topAnalysis, topMoveN) : null;
    let topBest = null;
    try {
      if (topAnalysis && typeof topAnalysis === 'object') {
        const cand = (topAnalysis.bestmove ?? topAnalysis.best_move ?? null);
        if (typeof cand === 'string' && cand.trim()) topBest = cand.trim();
        if (!topBest && Array.isArray(topAnalysis.main_pv) && typeof topAnalysis.main_pv[0] === 'string') topBest = String(topAnalysis.main_pv[0]).trim();
        if (!topBest && Array.isArray(topAnalysis.pv) && typeof topAnalysis.pv[0] === 'string') topBest = String(topAnalysis.pv[0]).trim();
      }
    } catch {}
    let posStateForBest = null;
    try {
      const idx = Math.max(0, Math.min(topMoveN, histLocal.length));
      posStateForBest = deriveStateFromHistory(histLocal, idx);
    } catch {}

    const topSideMark = (topMoveN % 2 === 0) ? '▲' : '△';
    const topBestKif = topBest ? (_usiToKifMove(topBest, posStateForBest) || topBest) : null;
    const topBestDisp = topBestKif ? `${topSideMark}${topBestKif}` : null;

    const rootCls = `text-slate-700${className ? ` ${className}` : ''}`;
    const graphBoxCls = `rounded-lg border border-white/70 bg-white/50 p-2${fillHeight ? ' flex-1 min-h-0 flex flex-col' : ''}`;
    const graphSvgCls = fillHeight
      ? 'w-full h-full'
      : (graphSize === 'large' ? 'w-full h-[140px]' : 'w-full h-[70px]');

    return (
      <div className={rootCls}>
        {showHeader ? (
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">解析</div>
            <div className="text-xs text-slate-600 font-mono">
              {total > 0 ? `${progress}/${total}` : (progress > 0 ? `${progress}` : '')}
              {done && total > 0 ? ' 完了' : ''}
            </div>
          </div>
        ) : null}

        {(progress > 0) ? (
          <div className={graphBoxCls}>
            <div className="flex items-start justify-between gap-2 mb-1">
            <div className="text-[11px] text-slate-600 shrink-0">先手視点</div>
            <div className="text-[11px] text-slate-700 flex flex-wrap justify-end gap-x-3 gap-y-1 leading-none">
              <span className="font-mono">{`評価 ${topEval ?? '-'}`}</span>
              <span className="font-mono">{`最善 ${topBestDisp ?? '-'}`}</span>
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
          <div className={`rounded-lg border border-white/70 bg-white/50 p-3 text-sm text-slate-600${fillHeight ? ' flex-1 min-h-0 flex items-center justify-center' : ''}`}>
            {msg}
          </div>
        )}

        {(isFinished && progress > 0 && total > 0 && progress < total) ? (
          <div className="mt-2 text-xs text-slate-600">{`解析中… ${progress}/${total}`}</div>
        ) : null}
        {(isFinished && progress <= 0) ? (
          <div className="mt-2 text-xs text-slate-600">解析が始まるまで少し待ってください</div>
        ) : null}
      </div>
    );
  };
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
      {/* 手の一覧ポップアップ（終了後のみ） */}
      <Dialog open={moveListOpen} onOpenChange={(o) => { if (!reviewEnabled) return; setMoveListOpen(o); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>手の一覧</DialogTitle>
            <DialogDescription>選択した手まで盤面を移動します（ローカルのみ）</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto divide-y">
            {/* 0手（初期局面）も選べるようにする */}
            <button type="button" className="w-full text-left px-3 py-2 hover:bg-gray-50"
                    onClick={() => { setReviewIndex(0); setMoveListOpen(false); }}>
              <span className="inline-block w-16">0手</span> 初期局面
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
                  onClick={() => { setReviewIndex(n); setMoveListOpen(false); }}
                >
                  <div className="min-w-0">
                    <span className="inline-block w-16">{n}手</span>
                    <span className="truncate">{label}</span>
                  </div>
                  {evalText ? (
                    <span className="text-xs text-slate-600 font-mono shrink-0">{evalText}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

    <div className="p-0 md:p-4 h-full min-h-0">
      <div className={`flex ${isWideDesktop ? 'flex-row gap-3' : 'flex-col'} h-full min-h-0`}>
        {isWideDesktop ? (
          <aside className="hidden md:flex flex-col w-[360px] min-w-[280px] max-w-[420px] h-full min-h-0">
            <div className="flex flex-col gap-3 h-full min-h-0">
              <div className="flex-[7] min-h-0 rounded-xl border border-white/70 bg-white/60 backdrop-blur-sm p-3 flex flex-col">
                <div className="text-sm font-semibold mb-2">チャット</div>
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
                  >
                    送信
                  </Button>
                </div>
                <ScrollArea
                  ref={chatScrollRef}
                  className="mt-2 flex-1 min-h-0 border border-white/70 rounded bg-white/60 backdrop-blur-sm p-2"
                >
                  <div className="space-y-0.5">
                    {chatMessages?.length ? chatMessages.map((m, i) => (
                      <div key={i} className="text-sm py-0.5"><span className={'font-semibold ' + chatNameClass(m.user_id)}>{chatDisplayName(m)}</span><span className="ml-1">{m.text}</span></div>
                    )) : <div className="text-sm text-slate-500">まだメッセージがありません</div>}
                    <div ref={chatEndRef} />
                  </div>
                </ScrollArea>
              </div>

              <div className="flex-[3] min-h-0 rounded-xl border border-white/70 bg-white/60 backdrop-blur-sm p-3 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">観戦者</div>
                  <div className="text-xs text-slate-600">{(spectators || []).length}人</div>
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
                    <div className="text-slate-400">いまは観戦者はいません</div>
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
        <div className="md:rounded-xl md:p-3 min-h-0 game-grid shogi-lobby-layer">
          <div className="w-full flex flex-col items-stretch md:items-stretch game-top flex-1 min-h-0" >
            <div className="flex-1 min-h-0 flex w-full">
            <ShogiBoard
            showCoordinates={coordVisible}
            onToggleCoordinates={() => setCoordVisible(v => !v)}
            gameState={reviewEnabled ? displayGameState : derivedLiveState}
            onMove={handleMove}
            isSpectator={isSpectator}
            currentUser={user || null}
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
            <div className="mt-3 w-full hidden md:flex items-center justify-between gap-2 bg-white/70 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-sm border border-white/80">
                {/* 左端: 盤サイズ + 符号 ON/OFF */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowChatMobile(v => !v)}
                    aria-label="チャット"
                    title="チャット"
                    className="md:hidden relative p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                  >
                    <img src={chatBubbleIcon} alt="チャット" className="w-4 h-4" />
                    {(!isDesktop && !showChatMobile && hasUnreadChat) && (
                      <span className="absolute -top-1 -right-1 inline-flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-600" />
                      </span>
                    )}
                  </Button>

                  {/* スマホでは盤サイズプルダウンを表示しない */}
                  <div className="hidden md:block">
                    <select
                      value={shellWidthMode || "normal"}
                      onChange={(e) => {
                        const mode = e.target.value === "wide" ? "wide" : "normal";
                        if (onChangeShellWidthMode) {
                          onChangeShellWidthMode(mode);
                        }
                      }}
                      className="text-xs md:text-sm rounded-md border border-white/80 bg-white/90 px-2 py-1 shadow-sm focus:outline-none"
                      aria-label="盤の表示サイズ"
                      title="盤の表示サイズ"
                    >
                      <option value="normal">通常サイズ</option>
                      <option value="wide">拡大サイズ</option>
                    </select>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCoordVisible(v => !v)}
                    aria-label={coordVisible ? '符号を非表示' : '符号を表示'}
                    title={coordVisible ? '符号を非表示' : '符号を表示'}
                    className="p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                  >
                    <img
                      src={coordVisible ? eyeIcon : eyeSlashIcon}
                      alt={coordVisible ? '符号表示中' : '符号非表示'}
                      className="w-4 h-4"
                    />
                  </Button>
                </div>

                {/* 中央: 見返し（対局中はグレーアウト） */}
                <div className="flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReviewIndex(0)}
                    disabled={!reviewEnabled || reviewIndex <= 0}
                    aria-disabled={!reviewEnabled || reviewIndex <= 0}
                  >
                    &laquo;
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReviewIndex(Math.max(0, reviewIndex - 1))}
                    disabled={!reviewEnabled || reviewIndex <= 0}
                    aria-disabled={!reviewEnabled || reviewIndex <= 0}
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
                    aria-label="手数"
                    title="手数"
                  >
                    {`${reviewIndex} / ${totalMoves} 手`}
                    {currentEvalText ? (<span className="ml-2 text-xs font-mono text-slate-600">{currentEvalText}</span>) : null}
                  </button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReviewIndex(Math.min(totalMoves, reviewIndex + 1))}
                    disabled={!reviewEnabled || reviewIndex >= totalMoves}
                    aria-disabled={!reviewEnabled || reviewIndex >= totalMoves}
                  >
                    &rsaquo;
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReviewIndex(totalMoves)}
                    disabled={!reviewEnabled || reviewIndex >= totalMoves}
                    aria-disabled={!reviewEnabled || reviewIndex >= totalMoves}
                  >
                    &raquo;
                  </Button>
                </div>


                {/* 右端: 投了 / 退室 */}
                <div className="flex items-center gap-2">
                  {!isSpectator && !isFinished ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleResign}
                      aria-label="投了"
                      title="投了"
                      className="p-2 shadow-sm border border-white/60"
                    >
                      <img src={flagIcon} alt="投了" className="w-4 h-4" />
                    </Button>
                  ) : null}

                  {/* 退室（対局を閉じる）: 観戦者は常時 / 対局者は終局後のみ */}
                  {(isSpectator || isFinished) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onPointerDown={() => { try { triggerExitSfx(); } catch {} }}
                            onClick={() => { try { triggerExitSfx(); Promise.resolve(handleCloseGameScreen()).catch(() => {}); } catch {} }}
                      aria-label="退室"
                      title="退室"
                      className="p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                    >
                      <img src={leftIcon} alt="退室" className="w-4 h-4" />
                    </Button>
                  )}
                </div>
            </div>

            <div className="mt-3 w-full md:hidden">
              <div
                ref={mobileToolsRef}
                className="flex w-full items-stretch overflow-x-auto snap-x snap-mandatory scroll-smooth gap-3 transition-[height] duration-200"
                style={{
                  WebkitOverflowScrolling: 'touch',
                  height: (!isDesktop && mobileToolsPage === 1 && typeof mobileToolsH === 'number' && mobileToolsH > 0) ? `${mobileToolsH}px` : undefined,
                }}
                onScroll={() => {
                  try {
                    const el = mobileToolsRef.current;
                    if (!el) return;
                    const w = el.clientWidth || 1;
                    const p = Math.round((el.scrollLeft || 0) / w);
                    setMobileToolsPage(p);
                  } catch {}
                }}
              >
                <div className="w-full shrink-0 snap-start h-full">
                  <div className="w-full flex items-center justify-between gap-2 bg-white/70 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-sm border border-white/80">
                      {/* 左端: 盤サイズ + 符号 ON/OFF */}
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setShowChatMobile(v => !v)}
                          aria-label="チャット"
                          title="チャット"
                          className="md:hidden relative p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                        >
                          <img src={chatBubbleIcon} alt="チャット" className="w-4 h-4" />
                          {(!isDesktop && !showChatMobile && hasUnreadChat) && (
                            <span className="absolute -top-1 -right-1 inline-flex h-2.5 w-2.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-600" />
                            </span>
                          )}
                        </Button>

                        {/* スマホでは盤サイズプルダウンを表示しない */}
                        <div className="hidden md:block">
                          <select
                            value={shellWidthMode || "normal"}
                            onChange={(e) => {
                              const mode = e.target.value === "wide" ? "wide" : "normal";
                              if (onChangeShellWidthMode) {
                                onChangeShellWidthMode(mode);
                              }
                            }}
                            className="text-xs md:text-sm rounded-md border border-white/80 bg-white/90 px-2 py-1 shadow-sm focus:outline-none"
                            aria-label="盤の表示サイズ"
                            title="盤の表示サイズ"
                          >
                            <option value="normal">通常サイズ</option>
                            <option value="wide">拡大サイズ</option>
                          </select>
                        </div>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCoordVisible(v => !v)}
                          aria-label={coordVisible ? '符号を非表示' : '符号を表示'}
                          title={coordVisible ? '符号を非表示' : '符号を表示'}
                          className="p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                        >
                          <img
                            src={coordVisible ? eyeIcon : eyeSlashIcon}
                            alt={coordVisible ? '符号表示中' : '符号非表示'}
                            className="w-4 h-4"
                          />
                        </Button>
                      </div>

                      {/* 中央: 見返し（対局中はグレーアウト） */}
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReviewIndex(0)}
                          disabled={!reviewEnabled || reviewIndex <= 0}
                          aria-disabled={!reviewEnabled || reviewIndex <= 0}
                        >
                          &laquo;
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReviewIndex(Math.max(0, reviewIndex - 1))}
                          disabled={!reviewEnabled || reviewIndex <= 0}
                          aria-disabled={!reviewEnabled || reviewIndex <= 0}
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
                          aria-label="手数"
                          title="手数"
                        >
                          {`${reviewIndex} / ${totalMoves} 手`}
                          {currentEvalText ? (<span className="ml-2 text-xs font-mono text-slate-600">{currentEvalText}</span>) : null}
                        </button>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReviewIndex(Math.min(totalMoves, reviewIndex + 1))}
                          disabled={!reviewEnabled || reviewIndex >= totalMoves}
                          aria-disabled={!reviewEnabled || reviewIndex >= totalMoves}
                        >
                          &rsaquo;
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReviewIndex(totalMoves)}
                          disabled={!reviewEnabled || reviewIndex >= totalMoves}
                          aria-disabled={!reviewEnabled || reviewIndex >= totalMoves}
                        >
                          &raquo;
                        </Button>
                      </div>


                      {/* 右端: 投了 / 退室 */}
                      <div className="flex items-center gap-2">
                        {!isSpectator && !isFinished ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleResign}
                            aria-label="投了"
                            title="投了"
                            className="p-2 shadow-sm border border-white/60"
                          >
                            <img src={flagIcon} alt="投了" className="w-4 h-4" />
                          </Button>
                        ) : null}

                        {/* 退室（対局を閉じる）: 観戦者は常時 / 対局者は終局後のみ */}
                        {(isSpectator || isFinished) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onPointerDown={() => { try { triggerExitSfx(); } catch {} }}
                      onClick={() => { try { triggerExitSfx(); Promise.resolve(handleCloseGameScreen()).catch(() => {}); } catch {} }}
                            aria-label="退室"
                            title="退室"
                            className="p-2 bg-white/90 border border-white/80 shadow-sm hover:bg-white"
                          >
                            <img src={leftIcon} alt="退室" className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                  </div>
                </div>

                <div className="w-full shrink-0 snap-start h-full">
                  <div className="w-full h-full min-h-0 bg-white/70 backdrop-blur-sm rounded-2xl p-3 shadow-sm border border-white/80 flex flex-col">
                    <AnalysisPanel highlightMove={reviewIndex} onSelectMove={reviewEnabled ? selectMoveFromGraph : null} fillHeight={true} className="h-full flex flex-col min-h-0" />
                  </div>
                </div>
              </div>

              <div ref={mobileDotsRef} className="flex justify-center gap-2 mt-2">
                <button
                  type="button"
                  aria-label="ページ1"
                  className={`h-2.5 w-2.5 rounded-full ${mobileToolsPage === 0 ? 'bg-slate-600' : 'bg-slate-300'}`}
                  onClick={() => {
                    try {
                      const el = mobileToolsRef.current;
                      if (!el) return;
                      el.scrollTo({ left: 0, behavior: 'smooth' });
                      setMobileToolsPage(0);
                    } catch {}
                  }}
                />
                <button
                  type="button"
                  aria-label="ページ2"
                  className={`h-2.5 w-2.5 rounded-full ${mobileToolsPage === 1 ? 'bg-slate-600' : 'bg-slate-300'}`}
                  onClick={() => {
                    try {
                      const el = mobileToolsRef.current;
                      if (!el) return;
                      const w = el.clientWidth || 1;
                      el.scrollTo({ left: w, behavior: 'smooth' });
                      setMobileToolsPage(1);
                    } catch {}
                  }}
                />
              </div>
            </div>

          </div>
        </div>

          {!isWideDesktop ? (
                <div className="border-t pt-2 hidden md:block game-bottom min-h-0 overflow-hidden">
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
                >
                  送信
                </Button>
              </div>
              <ScrollArea
                ref={chatScrollRef}
                className="mt-2 flex-1 min-h-0 border border-white/70 rounded bg-white/60 backdrop-blur-sm p-2"
              >
                <div className="space-y-0.5">
                  {chatMessages?.length ? chatMessages.map((m, i) => (
                    <div key={i} className="text-sm py-0.5"><span className={"font-semibold " + chatNameClass(m.user_id)}>{chatDisplayName(m)}</span><span className="ml-1">{m.text}</span></div>
                  )) : <div className="text-sm text-slate-500">まだメッセージがありません</div>}
                  <div ref={chatEndRef} />
                </div>
          </ScrollArea>
            </div>
            {/* 閲覧者リストの枠（中身はまだダミー） */}
            <div className="col-span-4 h-full min-h-0">
              <div className="border border-white/70 rounded bg-white/60 backdrop-blur-sm p-2 h-full min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">観戦者</div>
                  <div className="text-xs text-slate-600">{(spectators || []).length}人</div>
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
                  <div className="text-slate-400">いまは観戦者はいません</div>
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
        <div className="fixed left-3 bottom-3 z-40 pointer-events-auto">
          {analysisOverlayCollapsed ? (
            <button
              type="button"
              className="bg-white/80 backdrop-blur-sm rounded-full shadow-lg border border-white/70 px-3 py-2 flex items-center gap-3"
              onClick={() => setAnalysisOverlayCollapsed(false)}
              aria-label="解析グラフを開く"
              title="解析グラフを開く"
            >
              <span className="text-xs font-semibold">解析</span>
              {(analysisDerived?.total > 0) ? (
                <span className="text-xs text-slate-600 font-mono">{`${analysisDerived.progress}/${analysisDerived.total}`}</span>
              ) : null}
            </button>
          ) : (
            <div className={`${analysisOverlayGraphSize === 'large' ? 'w-[640px]' : 'w-[320px]'} max-w-[calc(100vw-1.5rem)] bg-white/80 backdrop-blur-sm rounded-2xl shadow-lg border border-white/70 p-3`}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold">解析グラフ</div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setAnalysisOverlayGraphSize(s => (s === 'large' ? 'normal' : 'large'))}
                    className="h-7 w-7"
                    aria-label={analysisOverlayGraphSize === 'large' ? '解析グラフを通常サイズにする' : '解析グラフを大きめサイズにする'}
                    title={analysisOverlayGraphSize === 'large' ? '通常サイズ' : '大きめサイズ'}
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
                    onClick={() => setAnalysisOverlayCollapsed(true)}
                    className="h-7 w-7"
                    aria-label="解析グラフをたたむ"
                    title="たたむ"
                  >
                    <CollapseIcon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <AnalysisPanel
                highlightMove={reviewIndex}
                showHeader={false}
                onSelectMove={reviewEnabled ? selectMoveFromGraph : null}
                graphSize={analysisOverlayGraphSize}
              />
            </div>
          )}
        </div>
      ) : null}

      {/* モバイル: チャットスライドオーバー */}
      <div className={"md:hidden fixed inset-x-0 bottom-0 z-50 transform transition-transform duration-300 " + (showChatMobile ? "translate-y-0" : "translate-y-full")}>
        <div className="bg-white rounded-t-2xl shadow-2xl border-t p-3 h-[75svh] flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">チャット</div>
            <Button size="sm" variant="ghost" onClick={() => setShowChatMobile(false)}>閉じる</Button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat(); }}
              placeholder={chatPlaceholder}
                  disabled={!canSendChat}
            />
            <Button onClick={handleSendChat} disabled={!canSendChat}>送信</Button>
          </div>
          <ScrollArea ref={chatScrollRef} className="mt-2 flex-1 min-h-0 border rounded p-2">
            <div className="space-y-0.5">
              {chatMessages?.length ? chatMessages.map((m, i) => (
                <div key={i} className="text-sm py-0.5"><span className={"font-semibold " + chatNameClass(m.user_id)}>{chatDisplayName(m)}</span><span className="ml-1">{m.text}</span></div>
              )) : <div className="text-sm text-slate-500">まだメッセージがありません</div>}
              <div ref={chatEndRef} />
            </div>
          </ScrollArea>
        </div>
      </div>
{/* 接続待ちオーバーレイ */}
        {(!isSpectator && !isFinished && dcOverlay?.show) && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 pointer-events-none select-none">
            <div className="bg-white shadow-xl rounded-xl p-6 text-center pointer-events-auto">
              <div className="text-lg font-semibold mb-2">相手の接続を待っています…</div>
              <div className="text-sm text-gray-600 mb-4">残り時間: {formatMsToMMSS(Math.max(0, (dcOverlay.leftMsShadow ?? dcOverlay.remainingMs)))}</div>
              <div className="text-xs text-gray-500">90秒の合計切断時間を超えると負けになります</div>
            </div>
          </div>
        )}

        </>
  );
};

export default GameView;