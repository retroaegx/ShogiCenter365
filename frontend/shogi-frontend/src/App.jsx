import './styles/shogi.css'
import './styles/layout-fix-v15.css'

import '@/services/fetchAuthPatch'
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';

import { t, subscribeI18n } from '@/i18n';
import { socketErrorMessage } from '@/i18n/socketErrors';
import useAutoJwtRefresh from '@/hooks/useAutoJwtRefresh';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Crown, 
  Users, 
  Search, 
  Settings, 
  LogOut, 
  Menu, 
  X, 
  Wifi, 
  WifiOff, 
  ChevronLeft, 
  ChevronRight, 
  Volume2, 
	  Ban
} from 'lucide-react';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { OnlineUsersProvider, useOnlineUsers } from '@/contexts/OnlineUsersContext';
import useSound from '@/hooks/useSound';
import websocketService from '@/services/websocketService';
import { maybeReloadIfBuildChanged } from '@/services/buildInfo';
import api from '@/services/apiClient';
import LoginForm from '@/components/auth/LoginForm';
import UserStatsOverlay from '@/components/user/UserStatsOverlay';
import RegisterForm from '@/components/auth/RegisterForm';
import LobbyView from '@/components/lobby/LobbyView';
import InviteView from '@/components/invite/InviteView';
import IncomingOfferLayer from '@/components/lobby/IncomingOfferLayer';
import OutgoingOfferLayer from '@/components/lobby/OutgoingOfferLayer';
import GameView from '@/components/game/GameView';
import KifuSearch from '@/components/kifu/KifuSearch';
import TopStaticShogi from '@/components/top/TopStaticShogi';
import { loadBoardThemeConfig, THEME_LS_KEYS } from '@/config/themeLoader';
import ThemeSamplePreview from '@/components/settings/ThemeSamplePreview';
import './App.css';
import './styles/responsive.css';

// match Tailwind 'lg' breakpoint (1024px)
function useMediaQuery(query, defaultValue = false) {
  const [matches, setMatches] = useState(() => {
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return !!defaultValue;
      return window.matchMedia(query).matches;
    } catch {
      return !!defaultValue;
    }
  });

  useEffect(() => {
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      const mql = window.matchMedia(query);
      const handler = (e) => setMatches(!!e.matches);

      if (mql.addEventListener) mql.addEventListener('change', handler);
      else mql.addListener(handler);

      setMatches(!!mql.matches);

      return () => {
        if (mql.removeEventListener) mql.removeEventListener('change', handler);
        else mql.removeListener(handler);
      };
    } catch {
      return;
    }
  }, [query]);

  return matches;
}


// メインアプリケーションコンポーネント
const AppContent = () => {
  const headerRef = useRef(null);
  const footerRef = useRef(null);
  const mainShellRef = useRef(null);

  const { user, logout, isAuthenticated, loading, setUser } = useAuth();
  const { users: onlineUsers, initialized: onlineUsersInitialized, applyUserDiff: applyOnlineUsersDiff } = useOnlineUsers();
  // NOTE: setSfxVolume は state setter と衝突しやすいので別名にする
  const { installUnlockHandlers, setEnvVolume, setSfxVolume: setSfxVolumeGain, playEnv, playSfx } = useSound();
  const [currentView, setCurrentView] = useState('lobby');

  const [inviteToken, setInviteToken] = useState(() => {
    try {
      if (typeof window === 'undefined') return null;
      return new URLSearchParams(window.location.search).get('invite');
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (inviteToken) setCurrentView('invite');
  }, [inviteToken]);

  // build-id hot reload (top / game): if server build differs, reload to pick up new CSS/assets
  useEffect(() => {
    const isTop = !isAuthenticated && !inviteToken;
    const isGame = currentView === 'game';
    if (!isTop && !isGame) return;
    // best-effort (throttled inside)
    maybeReloadIfBuildChanged();
  }, [isAuthenticated, inviteToken, currentView]);

  const clearInvite = useCallback(() => {
    setInviteToken(null);
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('invite');
      window.history.replaceState({}, '', u.pathname + (u.search || '') + (u.hash || ''));
    } catch {
      // ignore
    }
  }, []);

  const closeInvite = useCallback(() => {
    clearInvite();
    setCurrentView('lobby');
    setShowMobileMenu(false);
  }, [clearInvite]);

  const isGameView = currentView === 'game';
  const isLgUp = useMediaQuery('(min-width: 1024px)');

  // i18n: re-render on language change
  const [, forceI18nRerender] = useState(0);
  useEffect(() => {
    const unsub = subscribeI18n(() => forceI18nRerender((x) => x + 1));
    return () => { try { unsub && unsub(); } catch {} };
  }, []);

  // JWT自動更新（lobby以外）。残り5分以内の場合のみローテーション。
  useAutoJwtRefresh(isAuthenticated && currentView !== 'lobby');

  // === viewport height stabilization (Mobile/Tablet) ===
  // Some browsers treat 100vh/100dvh as the "full" height including UI bars on initial paint,
  // which can push the bottom UI outside the visible screen. We compute a px height using
  // visualViewport/innerHeight and write it to --app-height. CSS uses this as a stable source.
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const root = document.documentElement;

    let raf = 0;
    let settleTimer = 0;
    let last = 0;

    const readH = () => {
      const vv = window.visualViewport;
      const h = (vv && typeof vv.height === 'number' ? vv.height : window.innerHeight);
      const nh = Math.max(0, Math.round(h || 0));
      return nh;
    };

    const apply = () => {
      const h = readH();
      if (!h) return;
      if (Math.abs(h - last) <= 1) return;
      last = h;
      root.style.setProperty('--app-height', `${h}px`);
    };

    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
    };

    // before first paint
    schedule();
    // and once again after the initial layout settles
    settleTimer = window.setTimeout(schedule, 400);

    window.addEventListener('resize', schedule, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', schedule, { passive: true });
      window.visualViewport.addEventListener('scroll', schedule, { passive: true });
    }

    return () => {
      try { window.removeEventListener('resize', schedule); } catch {}
      try {
        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', schedule);
          window.visualViewport.removeEventListener('scroll', schedule);
        }
      } catch {}
      if (raf) cancelAnimationFrame(raf);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, []);

  // CSS 変数（ヘッダー / フッター分のオフセット）を正しいタイミングで更新
  useLayoutEffect(() => {
    const applyVars = () => {
      const h = headerRef.current ? headerRef.current.offsetHeight : 56;
      let f = footerRef.current ? footerRef.current.offsetHeight : 56;
      // 対局画面はフッターを非表示にするので、余白も取らない
      if (isGameView) f = 0;
      const root = document.documentElement;
      root.style.setProperty('--hdr', h + 'px');
      root.style.setProperty('--ftr', f + 'px');
    };

    // 初期適用（フォント読み込みなどで高さが後から変わることがあるので rAF でも追従）
    applyVars();
    const raf1 = requestAnimationFrame(applyVars);
    const raf2 = requestAnimationFrame(applyVars);

    // ヘッダー/フッターの高さが「ウィンドウリサイズなし」で変わるケース対策
    // （3:2 解像度でたまに下部UIが画面外に出る原因になっていた）
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => applyVars());
      if (headerRef.current) ro.observe(headerRef.current);
      if (footerRef.current) ro.observe(footerRef.current);
    }

    window.addEventListener('resize', applyVars);
    return () => {
      window.removeEventListener('resize', applyVars);
      if (ro) ro.disconnect();
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isGameView]);

  function handleCloseGame() {
    try { playSfx?.('room_exit', { forceHtml: true }); } catch {}
    setCurrentGameId(null);
    setCurrentView('lobby');
    setShowSideLobby(true);
  }

  const [currentGameId, setCurrentGameId] = useState(null);
  const [isSpectator, setIsSpectator] = useState(false);
  // 右サイドロビーは「デフォルト折り畳み(非表示)」
  const [showSideLobby, setShowSideLobby] = useState(false);
  const [sideDock, setSideDock] = useState({ left: 0, width: 0 });

  // 画面リロード直後に「感想戦(review)」で取り残されるのを防ぐ。
  // 仕様: waiting==review のときだけ /lobby/waiting/stop を叩いてロビーへ戻す。
  // playing を勝手に落とすと対局中に悪影響があるので触らない。
  const autoStopReviewRef = useRef(false);
  useEffect(() => {
    if (autoStopReviewRef.current) return;
    if (loading) return;
    if (!isAuthenticated) return;
    if (!onlineUsersInitialized) return;

    const meIdRaw = (user?.user_id || user?._id || user?.id);
    const meId = meIdRaw != null ? String(meIdRaw) : '';
    if (!meId) return;

    autoStopReviewRef.current = true;

    const normalizeId = (v) => {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'object') return String(v.$oid ?? v.oid ?? v.id ?? v);
      return String(v);
    };

    (async () => {
      try {
        // presence を作っておく（失敗しても続行）
        try { await api.post('/lobby/touch?force=1'); } catch {}

        const arr = Array.isArray(onlineUsers) ? onlineUsers : [];
        const mine = arr.find(u => normalizeId(u.user_id) === meId);
        const myWaiting = (mine && typeof mine.waiting === 'string') ? mine.waiting : null;

        if (myWaiting === 'review') {
          const res = await api.post('/lobby/waiting/stop');
          if (res?.data?.success) {
            try { applyOnlineUsersDiff([{ user_id: meId, waiting: 'lobby', waiting_info: {}, pending_offer: {} }], []); } catch {}
            setIsSpectator(false);
            setCurrentGameId(null);
            setCurrentView('lobby');
            setShowSideLobby(true);
          }
        }
      } catch (e) {
        try { console.warn('[autoStopReview] failed', e); } catch {}
      }
    })();
  }, [loading, isAuthenticated, onlineUsersInitialized, onlineUsers, user?.user_id, user?._id, user?.id]);

  const [shellWidthMode, setShellWidthMode] = useState(() => {
    // 対局画面での main-shell 横幅 (normal|wide)
    try {
      const v = window?.localStorage?.getItem('shogi_shellWidthMode');
      if (v === 'wide' || v === 'normal') return v;
    } catch {}
    return "normal";
  });

// 対局画面(通常サイズ)のときだけ、main-shell 右側の空き領域を計測して
// 右マージン内に「サイドロビー」を展開する（対局エリアは一切縮めない）
useLayoutEffect(() => {
  if (!isLgUp) return;
  if (!isGameView) return;
  if (!currentGameId) return;

  if (shellWidthMode !== 'normal') {
    setSideDock({ left: 0, width: 0 });
    return;
  }

  const el = mainShellRef.current;
  if (!el) return;

  let raf = 0;
  const measure = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const left = Math.max(0, Math.floor(rect.right));
      const width = Math.max(0, Math.floor(window.innerWidth - rect.right));
      setSideDock({ left, width });
    });
  };

  measure();
  window.addEventListener('resize', measure);

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => measure());
    ro.observe(el);
  }

  return () => {
    window.removeEventListener('resize', measure);
    if (ro) ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
  };
}, [isLgUp, isGameView, currentGameId, shellWidthMode]);

  const [coordVisible, setCoordVisible] = useState(() => {
    // 対局画面: 盤上の符号(座標)表示
    try {
      const v = window?.localStorage?.getItem('shogi_coordVisible');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch {}
    return true;
  }); // 対局画面での main-shell 横幅

  const [moveConfirmEnabled, setMoveConfirmEnabled] = useState(() => {
    // 対局画面: 着手確認（クライアント側）
    try {
      const v = window?.localStorage?.getItem('shogi_moveConfirmEnabled');
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {}
    return false;
  });

  const [reviewDrawNextMove, setReviewDrawNextMove] = useState(() => {
    // 感想戦: 次の本譜手を視覚的に表示（デフォルトOFF）
    try {
      const v = window?.localStorage?.getItem('shogi_reviewDrawNextMove');
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {}
    return false;
  });

  const [reviewDrawBestMove, setReviewDrawBestMove] = useState(() => {
    // 感想戦: 最善手を視覚的に表示（デフォルトOFF）
    try {
      const v = window?.localStorage?.getItem('shogi_reviewDrawBestMove');
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {}
    return false;
  });

  const [lastMoveFromHighlightEnabled, setLastMoveFromHighlightEnabled] = useState(() => {
    // 対局画面: 移動元の強調表示（デフォルトON）
    try {
      const v = window?.localStorage?.getItem('shogi_lastMoveFromHighlightEnabled');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch {}
    return true;
  });

  const [lastMovePieceHighlightEnabled, setLastMovePieceHighlightEnabled] = useState(() => {
    // 対局画面: 移動駒の強調表示（デフォルトON）
    try {
      const v = window?.localStorage?.getItem('shogi_lastMovePieceHighlightEnabled');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch {}
    return true;
  });
  const [authMode, setAuthMode] = useState('login');
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [notifications, setNotifications] = useState([]);
  // 設定ダイアログ用の状態
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  // サウンド設定
  const [envSoundVolume, setEnvSoundVolume] = useState(50);
  const [sfxVolume, setSfxVolume] = useState(50);

  // 音: 自動再生制限対策（最初のユーザー操作で unlock）
  useEffect(() => {
    try { installUnlockHandlers?.(); } catch {}
  }, [installUnlockHandlers]);

  // 音量を反映
  useEffect(() => {
    try { setEnvVolume?.(envSoundVolume); } catch {}
  }, [envSoundVolume, setEnvVolume]);
  useEffect(() => {
    try { setSfxVolumeGain?.(sfxVolume); } catch {}
  }, [sfxVolume, setSfxVolumeGain]);

  // ログイン時の音（自動ログインはブラウザ制限で鳴らない場合があるため、unlock 後にキュー消化）
  const prevAuthRef = useRef(false);
  useEffect(() => {
    const prev = !!prevAuthRef.current;
    const now = !!isAuthenticated;
    if (!prev && now) {
      try { playEnv?.('login'); } catch {}
    }
    prevAuthRef.current = now;
  }, [isAuthenticated, playEnv]);
  // 盤駒デザイン（board-theme/config.json のセット）
  const [boardBackgroundSet, setBoardBackgroundSet] = useState('');
  const [boardPieceSet, setBoardPieceSet] = useState('');
  const [themeSetOptions, setThemeSetOptions] = useState({ backgroundSets: [], pieceSets: [] });
  // 旧プリセット（互換用。現UIでは使わないが設定保存は維持）
  const [boardDesignPreset, setBoardDesignPreset] = useState('classic');
  // ブロックリスト
  const [blockInput, setBlockInput] = useState('');
  const [blockList, setBlockList] = useState([]);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState(null);

  // board-theme/config.json のセット一覧を読み込む
  useEffect(() => {
    let alive = true;
    loadBoardThemeConfig()
      .then((cfg) => {
        if (!alive) return;
        const backgroundSets = Array.isArray(cfg?.background_sets) ? cfg.background_sets : [];
        const pieceSets = Array.isArray(cfg?.piece_sets) ? cfg.piece_sets : [];
        setThemeSetOptions({ backgroundSets, pieceSets });
      })
      .catch((e) => {
        console.error('テーマ設定の読み込みに失敗しました', e);
        setThemeSetOptions({ backgroundSets: [], pieceSets: [] });
      });
    return () => {
      alive = false;
    };
  }, []);

  // 選択値が無い / 定義が無い場合は先頭をデフォルトにする
  useEffect(() => {
    const list = themeSetOptions.backgroundSets;
    if (!Array.isArray(list) || list.length === 0) return;
    setBoardBackgroundSet((prev) => {
      if (prev && list.some((x) => x?.name === prev)) return prev;
      return list[0]?.name || '';
    });
  }, [themeSetOptions.backgroundSets]);

  useEffect(() => {
    const list = themeSetOptions.pieceSets;
    if (!Array.isArray(list) || list.length === 0) return;
    setBoardPieceSet((prev) => {
      if (prev && list.some((x) => x?.name === prev)) return prev;
      return list[0]?.name || '';
    });
  }, [themeSetOptions.pieceSets]);

  // 設定画面のプレビュー用に、選択中のセット定義を引く
  const selectedBackgroundSetObj = (themeSetOptions.backgroundSets || []).find((x) => x?.name === boardBackgroundSet)
    || (themeSetOptions.backgroundSets || [])[0]
    || null;
  const selectedPieceSetObj = (themeSetOptions.pieceSets || []).find((x) => x?.name === boardPieceSet)
    || (themeSetOptions.pieceSets || [])[0]
    || null;

  // ログイン/設定取得後は localStorage にも反映して対局画面の読み込みに使う
  useEffect(() => {
    if (!user?.settings) return;
    const s = user.settings;
    const bg = (typeof s.boardBackgroundSet === 'string' && s.boardBackgroundSet.trim()) ? s.boardBackgroundSet.trim() : null;
    const ps = (typeof s.boardPieceSet === 'string' && s.boardPieceSet.trim()) ? s.boardPieceSet.trim() : null;
    if (bg) setBoardBackgroundSet(bg);
    if (ps) setBoardPieceSet(ps);
    const cv = (typeof s.coordVisible === 'boolean') ? s.coordVisible : null;
    const swm = (typeof s.shellWidthMode === 'string') ? s.shellWidthMode.trim() : null;
    const mc = (typeof s.moveConfirmEnabled === 'boolean') ? s.moveConfirmEnabled : null;
    const rdn = (typeof s.reviewDrawNextMove === 'boolean') ? s.reviewDrawNextMove : null;
    const rdb = (typeof s.reviewDrawBestMove === 'boolean') ? s.reviewDrawBestMove : null;
    const lmf = (typeof s.lastMoveFromHighlightEnabled === 'boolean') ? s.lastMoveFromHighlightEnabled : null;
    const lmp = (typeof s.lastMovePieceHighlightEnabled === 'boolean') ? s.lastMovePieceHighlightEnabled : null;
    if (cv !== null) setCoordVisible(cv);
    if (swm === 'wide' || swm === 'normal') setShellWidthMode(swm);
    if (mc !== null) setMoveConfirmEnabled(mc);
    if (rdn !== null) setReviewDrawNextMove(rdn);
    if (rdb !== null) setReviewDrawBestMove(rdb);
    if (lmf !== null) setLastMoveFromHighlightEnabled(lmf);
    if (lmp !== null) setLastMovePieceHighlightEnabled(lmp);
    try {
      if (bg) localStorage.setItem(THEME_LS_KEYS.backgroundSet, bg);
      if (ps) localStorage.setItem(THEME_LS_KEYS.pieceSet, ps);
      if (cv !== null) localStorage.setItem('shogi_coordVisible', cv ? '1' : '0');
      if (swm === 'wide' || swm === 'normal') localStorage.setItem('shogi_shellWidthMode', swm);
      if (mc !== null) localStorage.setItem('shogi_moveConfirmEnabled', mc ? '1' : '0');
      if (rdn !== null) localStorage.setItem('shogi_reviewDrawNextMove', rdn ? '1' : '0');
      if (rdb !== null) localStorage.setItem('shogi_reviewDrawBestMove', rdb ? '1' : '0');
      if (lmf !== null) localStorage.setItem('shogi_lastMoveFromHighlightEnabled', lmf ? '1' : '0');
      if (lmp !== null) localStorage.setItem('shogi_lastMovePieceHighlightEnabled', lmp ? '1' : '0');
    } catch {}
  }, [user]);

  // 対局画面UI設定の localStorage 反映（未ログインでも復元できるように）
  useEffect(() => {
    try { localStorage.setItem('shogi_coordVisible', coordVisible ? '1' : '0'); } catch {}
  }, [coordVisible]);

  useEffect(() => {
    try { localStorage.setItem('shogi_moveConfirmEnabled', moveConfirmEnabled ? '1' : '0'); } catch {}
  }, [moveConfirmEnabled]);

  useEffect(() => {
    try { localStorage.setItem('shogi_reviewDrawNextMove', reviewDrawNextMove ? '1' : '0'); } catch {}
  }, [reviewDrawNextMove]);

  useEffect(() => {
    try { localStorage.setItem('shogi_reviewDrawBestMove', reviewDrawBestMove ? '1' : '0'); } catch {}
  }, [reviewDrawBestMove]);

  useEffect(() => {
    try { localStorage.setItem('shogi_lastMoveFromHighlightEnabled', lastMoveFromHighlightEnabled ? '1' : '0'); } catch {}
  }, [lastMoveFromHighlightEnabled]);

  useEffect(() => {
    try { localStorage.setItem('shogi_lastMovePieceHighlightEnabled', lastMovePieceHighlightEnabled ? '1' : '0'); } catch {}
  }, [lastMovePieceHighlightEnabled]);

  useEffect(() => {
    try { localStorage.setItem('shogi_shellWidthMode', shellWidthMode); } catch {}
  }, [shellWidthMode]);

  // 対局画面UI設定をプロファイル(settings)に保存（変更時）
  const saveGameUiTimerRef = useRef(null);
  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const s = user.settings || {};
    const desiredCv = (typeof s.coordVisible === 'boolean') ? s.coordVisible : true;
    const desiredSwm = (typeof s.shellWidthMode === 'string' && (s.shellWidthMode === 'wide' || s.shellWidthMode === 'normal'))
      ? s.shellWidthMode
      : 'normal';
    const desiredMc = (typeof s.moveConfirmEnabled === 'boolean') ? s.moveConfirmEnabled : false;
    const desiredRdn = (typeof s.reviewDrawNextMove === 'boolean') ? s.reviewDrawNextMove : false;
    const desiredRdb = (typeof s.reviewDrawBestMove === 'boolean') ? s.reviewDrawBestMove : false;
    const desiredLmf = (typeof s.lastMoveFromHighlightEnabled === 'boolean') ? s.lastMoveFromHighlightEnabled : true;
    const desiredLmp = (typeof s.lastMovePieceHighlightEnabled === 'boolean') ? s.lastMovePieceHighlightEnabled : true;

    if (
      desiredCv === coordVisible &&
      desiredSwm === shellWidthMode &&
      desiredMc === moveConfirmEnabled &&
      desiredRdn === reviewDrawNextMove &&
      desiredRdb === reviewDrawBestMove &&
      desiredLmf === lastMoveFromHighlightEnabled &&
      desiredLmp === lastMovePieceHighlightEnabled
    ) return;

    if (saveGameUiTimerRef.current) {
      try { clearTimeout(saveGameUiTimerRef.current); } catch {}
    }

    saveGameUiTimerRef.current = window.setTimeout(async () => {
      try {
        const payload = {
          settings: {
            coordVisible,
            shellWidthMode,
            moveConfirmEnabled,
            reviewDrawNextMove,
            reviewDrawBestMove,
            lastMoveFromHighlightEnabled,
            lastMovePieceHighlightEnabled,
          }
        };
        const res = await api.put('/user/settings', payload);
        const updatedSettings =
          res?.data?.settings ||
          res?.data?.profile?.settings ||
          payload.settings;

        if (updatedSettings && setUser) {
          setUser(prev => (prev ? { ...prev, settings: { ...(prev.settings || {}), ...updatedSettings } } : prev));
        }
      } catch (e) {
        try { console.warn('[game-ui-settings] save failed', e); } catch {}
      }
    }, 350);

    return () => {
      if (saveGameUiTimerRef.current) {
        try { clearTimeout(saveGameUiTimerRef.current); } catch {}
        saveGameUiTimerRef.current = null;
      }
    };
  }, [
    coordVisible,
    shellWidthMode,
    moveConfirmEnabled,
    reviewDrawNextMove,
    reviewDrawBestMove,
    lastMoveFromHighlightEnabled,
    lastMovePieceHighlightEnabled,
    isAuthenticated,
    user?.id,
    user?.settings?.coordVisible,
    user?.settings?.shellWidthMode,
    user?.settings?.moveConfirmEnabled,
    user?.settings?.reviewDrawNextMove,
    user?.settings?.reviewDrawBestMove,
    user?.settings?.lastMoveFromHighlightEnabled,
    user?.settings?.lastMovePieceHighlightEnabled,
    setUser,
  ]);

  // 設定ダイアログ open 時に user.settings をフォームに反映
  useEffect(() => {
    if (showSettingsDialog && user && user.settings) {
      const s = user.settings;
      if (typeof s.envSoundVolume === 'number') {
        setEnvSoundVolume(s.envSoundVolume);
      }
      if (typeof s.sfxVolume === 'number') {
        setSfxVolume(s.sfxVolume);
      }
      if (typeof s.boardDesignPreset === 'string') {
        setBoardDesignPreset(s.boardDesignPreset);
      }
      if (typeof s.boardBackgroundSet === 'string') {
        setBoardBackgroundSet(s.boardBackgroundSet);
      }
      if (typeof s.boardPieceSet === 'string') {
        setBoardPieceSet(s.boardPieceSet);
      }
      if (Array.isArray(s.blockList)) {
        setBlockList(s.blockList);
      }
      if (typeof s.reviewDrawNextMove === 'boolean') {
        setReviewDrawNextMove(s.reviewDrawNextMove);
      }
      if (typeof s.reviewDrawBestMove === 'boolean') {
        setReviewDrawBestMove(s.reviewDrawBestMove);
      }
      if (typeof s.lastMoveFromHighlightEnabled === 'boolean') {
        setLastMoveFromHighlightEnabled(s.lastMoveFromHighlightEnabled);
      }
      if (typeof s.lastMovePieceHighlightEnabled === 'boolean') {
        setLastMovePieceHighlightEnabled(s.lastMovePieceHighlightEnabled);
      }
    }
  }, [showSettingsDialog, user]);


  // WebSocket接続管理
  useEffect(() => {
    if (isAuthenticated && user) {
      // WebSocket接続
      websocketService.connect(localStorage.getItem('token'));
      // すでにつながってたら即座に反映
      if (websocketService.isSocketConnected()) {
        setConnectionStatus('connected')
      }
      const handleConnected = () => setConnectionStatus('connected')
      const handleDisconnected = () => setConnectionStatus('disconnected')

      
      // 接続状態の監視
      const handleConnectionStatus = (data) => {
        setConnectionStatus(data.connected ? 'connected' : 'disconnected');
      };

      const handleAuthenticated = (data) => {
        console.log('WebSocket認証成功:', data);
        setConnectionStatus('connected');
      };

      const handleError = (data) => {
        console.error('WebSocketエラー:', data);
        const code = data?.error_code || data?.error || data?.code;
        const fb = (typeof data?.message === 'string') ? data.message : '';
        addNotification('error', socketErrorMessage(code, fb, t("ui.app.k860c59b6")));
      };

      const handleConnectionError = (data) => {
        console.error('WebSocket接続エラー:', data);
        setConnectionStatus('error');
      };

      websocketService.on('connect', handleConnected);
      websocketService.on('disconnect', handleDisconnected);
      websocketService.on('connection_status', handleConnectionStatus);
      websocketService.on('authenticated', handleAuthenticated);
      websocketService.on('error', handleError);
      websocketService.on('connection_error', handleConnectionError);

      return () => {
        websocketService.off('connect', handleConnected);
        websocketService.off('disconnect', handleDisconnected);
        websocketService.off('connection_status', handleConnectionStatus);
        websocketService.off('authenticated', handleAuthenticated);
        websocketService.off('error', handleError);
        websocketService.off('connection_error', handleConnectionError);
      };
    } else {
      // ログアウト時はWebSocket切断
      websocketService.disconnect();
      setConnectionStatus('disconnected');
    }
  }, [isAuthenticated, user]);

  // 通知管理
  const addNotification = (type, message) => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, type, message }]);
    
    // 5秒後に自動削除
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 5000);
  };

  const removeNotification = (id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };
  const handleSaveSettings = async () => {
    try {
      const payload = {
        settings: {
          envSoundVolume,
          sfxVolume,
          boardDesignPreset,
          boardBackgroundSet,
          boardPieceSet,
          blockList,
          // 対局画面のUI設定も保存
          coordVisible,
          shellWidthMode,
          moveConfirmEnabled,
          reviewDrawNextMove,
          reviewDrawBestMove,
          lastMoveFromHighlightEnabled,
          lastMovePieceHighlightEnabled,
        },
      };
      const res = await api.put('/user/settings', payload);
      const updatedSettings =
        res?.data?.settings ||
        res?.data?.profile?.settings ||
        payload.settings;

      if (updatedSettings) {
        if (setUser) {
          setUser(prev => (prev ? { ...prev, settings: updatedSettings } : prev));
        }
        if (typeof updatedSettings.envSoundVolume === 'number') {
          setEnvSoundVolume(updatedSettings.envSoundVolume);
        }
        if (typeof updatedSettings.sfxVolume === 'number') {
          setSfxVolume(updatedSettings.sfxVolume);
        }
        if (typeof updatedSettings.boardDesignPreset === 'string') {
          setBoardDesignPreset(updatedSettings.boardDesignPreset);
        }
        if (typeof updatedSettings.boardBackgroundSet === 'string') {
          setBoardBackgroundSet(updatedSettings.boardBackgroundSet);
        }
        if (typeof updatedSettings.boardPieceSet === 'string') {
          setBoardPieceSet(updatedSettings.boardPieceSet);
        }
        if (Array.isArray(updatedSettings.blockList)) {
          setBlockList(updatedSettings.blockList);
        }
        if (typeof updatedSettings.moveConfirmEnabled === 'boolean') {
          setMoveConfirmEnabled(updatedSettings.moveConfirmEnabled);
        }
        if (typeof updatedSettings.reviewDrawNextMove === 'boolean') {
          setReviewDrawNextMove(updatedSettings.reviewDrawNextMove);
        }
        if (typeof updatedSettings.reviewDrawBestMove === 'boolean') {
          setReviewDrawBestMove(updatedSettings.reviewDrawBestMove);
        }
        if (typeof updatedSettings.lastMoveFromHighlightEnabled === 'boolean') {
          setLastMoveFromHighlightEnabled(updatedSettings.lastMoveFromHighlightEnabled);
        }
        if (typeof updatedSettings.lastMovePieceHighlightEnabled === 'boolean') {
          setLastMovePieceHighlightEnabled(updatedSettings.lastMovePieceHighlightEnabled);
        }
      }

      // 対局画面は localStorage の値を参照してテーマを組み立てる
      try {
        const bgSel = (typeof updatedSettings?.boardBackgroundSet === 'string') ? updatedSettings.boardBackgroundSet : boardBackgroundSet;
        const psSel = (typeof updatedSettings?.boardPieceSet === 'string') ? updatedSettings.boardPieceSet : boardPieceSet;
        if (bgSel) localStorage.setItem(THEME_LS_KEYS.backgroundSet, bgSel);
        if (psSel) localStorage.setItem(THEME_LS_KEYS.pieceSet, psSel);
      } catch {}
      try { window.dispatchEvent(new Event('shogi_theme_changed')); } catch {}

      setShowSettingsDialog(false);
    } catch (e) {
      console.error('設定の保存に失敗しました', e);
    }
  };


  // ゲーム参加
  const handleJoinGame = (gameId, spectator = false) => {
    clearInvite();
    try {
      // 入室効果音
      playSfx?.('room_enter');
      // 対局開始（自分が入室時）
      if (!spectator) playEnv?.('game_start');
    } catch {}
    setCurrentGameId(gameId);
    setIsSpectator(spectator);
    setCurrentView('game');
    // 対局開始時のデフォルトは「折り畳み(非表示)」
    setShowSideLobby(false);
    setShowMobileMenu(false);
  };
  useEffect(() => {
    if (!user?.id) return;
    const handler = (payload) => {
      try {
        const p = payload?.detail ? payload.detail : payload;
        // accepted が来たら自分宛にのみ届くのでID照合は不要
        if (p && p.type === 'offer_status' && p.status === 'accepted' && p.game_id) {
          handleJoinGame(p.game_id, false);
        }
        if (p && p.type === 'offer_status' && p.status === 'declined') {
          addNotification('info', t("ui.app.k3af45c04"));
        }
      } catch {}
    };
    try { websocketService.on('lobby_offer_update', handler); } catch {}
    return () => {
      try { websocketService.off('lobby_offer_update', handler); } catch {}
      };
  }, [user?.id]);


  // ゲーム退出
  const handleLeaveGame = () => {
    try { playSfx?.('room_exit'); } catch {}
    setCurrentGameId(null);
    setIsSpectator(false);
    setCurrentView('lobby');
  };

  // ログアウト処理
  const handleLogout = () => {
    try { playSfx?.('room_exit'); } catch {}
    logout();
    setCurrentView('lobby');
    setCurrentGameId(null);
    setIsSpectator(false);
    setShowMobileMenu(false);
  };

  // ビュー切り替え
  const switchView = (view) => {
    if (view !== 'invite') clearInvite();
    setCurrentView(view);
    setShowMobileMenu(false);
  };

  // 認証モード切り替え
  const switchAuthMode = (mode) => {
    setAuthMode(mode);
  };

  // ログイン成功時の処理
  const handleLoginSuccess = () => {
    setCurrentView('lobby');
    addNotification('success', t("ui.app.k5251d0da"));
  };

  // 登録成功時の処理
  const handleRegisterSuccess = () => {
    setAuthMode('login');
    addNotification('success', t("ui.app.k06a57c3b"));
  };

  // 接続状態のアイコン
  const getConnectionIcon = () => {
    switch (connectionStatus) {
      case 'connected':
        return <Wifi className="h-4 w-4 text-green-500" />;
      case 'error':
        return <WifiOff className="h-4 w-4 text-red-500" />;
      default:
        return <WifiOff className="h-4 w-4 text-gray-400" />;
    }
  };

  // 接続状態のテキスト
  const getConnectionText = () => {
    switch (connectionStatus) {
      case 'connected':
        return t("ui.app.k69078300");
      case 'error':
        return t("ui.app.kfb71a4e0");
      default:
        return t("ui.app.kd32cd8eb");
    }
  };


// wireframe-nav.html 風（四隅から線が伸びて枠ができる）ヘッダーボタン
const headerNavBtnBase =
  "relative inline-flex items-center gap-2 bg-transparent shadow-none border-0 " +
  "text-sm font-medium text-stone-800/90 hover:text-amber-800 hover:bg-transparent " +
  "focus-visible:ring-2 focus-visible:ring-amber-400/60 focus-visible:ring-offset-0 " +
  "before:content-[''] before:absolute before:top-0 before:left-0 before:w-0 before:h-0 before:rounded-md " +
  "before:border-t before:border-l before:border-amber-400/80 before:transition-all before:duration-300 before:ease-out before:pointer-events-none " +
  "after:content-[''] after:absolute after:bottom-0 after:right-0 after:w-0 after:h-0 after:rounded-md " +
  "after:border-b after:border-r after:border-amber-400/80 after:transition-all after:duration-300 after:ease-out after:pointer-events-none " +
  "hover:before:w-full hover:before:h-full hover:after:w-full hover:after:h-full";

const headerNavBtnActive = "text-amber-800 before:w-full before:h-full after:w-full after:h-full";

const headerNavBtn = (active, extra = "") =>
  `${headerNavBtnBase} ${active ? headerNavBtnActive : ""} ${extra}`;

// wireframe-nav.html 風（ユーザー名/レーティングなど非ボタン領域用の枠線エフェクト）
const headerWireFrameBoxBase =
  "relative inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-transparent " +
  "text-sm font-medium text-stone-800/90 " +
  "before:content-[''] before:absolute before:top-0 before:left-0 before:w-3 before:h-3 before:rounded-md " +
  "before:border-t before:border-l before:border-amber-400/80 before:transition-all before:duration-300 before:ease-out before:pointer-events-none " +
  "after:content-[''] after:absolute after:bottom-0 after:right-0 after:w-3 after:h-3 after:rounded-md " +
  "after:border-b after:border-r after:border-amber-400/80 after:transition-all after:duration-300 after:ease-out after:pointer-events-none " +
  "hover:before:w-full hover:before:h-full hover:after:w-full hover:after:h-full";

const headerWireFrameBox = (extra = "") => `${headerWireFrameBoxBase} ${extra}`;

  if (loading) {
    return (
    <div className={`app-root shogi-theme ${isGameView ? "is-game" : ""} ${isAuthenticated ? "is-auth" : ""}`}> 
      {/* 設定ダイアログ */}
      <Dialog open={showSettingsDialog} onOpenChange={setShowSettingsDialog}>
        <DialogContent className="w-full sm:max-w-xl lg:max-w-2xl max-h-[80vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader className="mb-2">
            <DialogTitle>{t("ui.app.k6329f21c")}</DialogTitle>
	            <DialogDescription>
	              {t("ui.app.k723d0902")}
	            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="general" className="mt-2 flex flex-col sm:flex-row gap-4">
            {/* 左側 縦メニュー */}
            <div className="sm:w-28 lg:w-36 shrink-0">
              <TabsList className="flex flex-row sm:flex-col items-start gap-1">
                <TabsTrigger
                  value="general"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Settings className="h-4 w-4" />
                  <span>{t("ui.app.kf0aaccbc")}</span>
                </TabsTrigger>
                <TabsTrigger
                  value="sound"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Volume2 className="h-4 w-4" />
                  <span>{t("ui.app.k389775ae")}</span>
                </TabsTrigger>
                <TabsTrigger
                  value="block"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Ban className="h-4 w-4" />
                  <span>{t("ui.app.k62cf94ff")}</span>
                </TabsTrigger>
              </TabsList>
            </div>

            {/* 右側 コンテンツ */}
            <div className="flex-1 min-w-0">
              <TabsContent value="general" className="mt-0 space-y-6">
                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">{
                    t("ui.app.kc3b768c6")}</div>

                  {/* 背景セット */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="board-bg-set" className="w-28 shrink-0">{
                      t("ui.app.kacaba613")}</Label>
                    <div className="min-w-[10rem]">
                      <Select
                        value={boardBackgroundSet}
                        onValueChange={setBoardBackgroundSet}
                        disabled={themeSetOptions.backgroundSets.length === 0}
                      >
                        <SelectTrigger id="board-bg-set">
                          <SelectValue placeholder={t("ui.app.ke6b14bb3")} />
                        </SelectTrigger>
                        <SelectContent>
                          {themeSetOptions.backgroundSets.map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {t(s.displayName)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* 駒セット */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="board-piece-set" className="w-28 shrink-0">{
                      t("ui.app.k2d87732a")}</Label>
                    <div className="min-w-[10rem]">
                      <Select
                        value={boardPieceSet}
                        onValueChange={setBoardPieceSet}
                        disabled={themeSetOptions.pieceSets.length === 0}
                      >
                        <SelectTrigger id="board-piece-set">
                          <SelectValue placeholder={t("ui.app.ke2c19088")} />
                        </SelectTrigger>
                        <SelectContent>
                          {themeSetOptions.pieceSets.map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {t(s.displayName)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <ThemeSamplePreview bgSet={selectedBackgroundSetObj} pieceSet={selectedPieceSetObj} />

                  {/* 着手確認 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="move-confirm" className="w-28 shrink-0">{
                      t("ui.app.kfd4a4a68")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="move-confirm"
                        checked={!!moveConfirmEnabled}
                        onCheckedChange={(v) => setMoveConfirmEnabled(!!v)}
                      />
</div>
                  </div>
                  <div className="text-xs text-muted-foreground -mt-2">{
                    t("ui.app.k64a77abe")}</div>

                  {/* 移動元の強調表示 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="lastmove-from-highlight" className="w-28 shrink-0">{
                      t("ui.app.moveFromHighlightEnabled")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="lastmove-from-highlight"
                        checked={!!lastMoveFromHighlightEnabled}
                        onCheckedChange={(v) => setLastMoveFromHighlightEnabled(!!v)}
                      />
                    </div>
                  </div>

                  {/* 移動駒の強調表示 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="lastmove-piece-highlight" className="w-28 shrink-0">{
                      t("ui.app.movePieceHighlightEnabled")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="lastmove-piece-highlight"
                        checked={!!lastMovePieceHighlightEnabled}
                        onCheckedChange={(v) => setLastMovePieceHighlightEnabled(!!v)}
                      />
                    </div>
                  </div>

                  {/* 感想戦: 次の手 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="review-draw-next" className="w-28 shrink-0">{
                      t("ui.app.k35a22ac6")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="review-draw-next"
                        checked={!!reviewDrawNextMove}
                        onCheckedChange={(v) => setReviewDrawNextMove(!!v)}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground -mt-2">{
                    t("ui.app.k9e0f4057")}</div>

                  {/* 感想戦: 最善手 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="review-draw-best" className="w-28 shrink-0">{
                      t("ui.app.k8960b9ca")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="review-draw-best"
                        checked={!!reviewDrawBestMove}
                        onCheckedChange={(v) => setReviewDrawBestMove(!!v)}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground -mt-2">{
                    t("ui.app.k99cc0d62")}</div>

                </div>
              </TabsContent>
              <TabsContent value="sound" className="mt-0 space-y-10">
                {/* 環境音 */}
                <div className="flex items-center gap-6 py-4">
                  <Label htmlFor="env-sound" className="w-28 shrink-0">{
                    t("ui.app.kc0ba5b38")}</Label>
                  <Slider
                    id="env-sound"
                    min={0}
                    max={100}
                    value={[envSoundVolume]}
                    onValueChange={(values) => setEnvSoundVolume(values[0] ?? 0)}
                    className="flex-1"
                  />
                  <span className="w-10 text-right text-xs text-muted-foreground">
                    {envSoundVolume}
                  </span>
                </div>

                {/* 効果音 */}
                <div className="flex items-center gap-6 py-4">
                  <Label htmlFor="sfx-sound" className="w-28 shrink-0">{
                    t("ui.app.k310719b8")}</Label>
                  <Slider
                    id="sfx-sound"
                    min={0}
                    max={100}
                    value={[sfxVolume]}
                    onValueChange={(values) => setSfxVolume(values[0] ?? 0)}
                    className="flex-1"
                  />
                  <span className="w-10 text-right text-xs text-muted-foreground">
                    {sfxVolume}
                  </span>
                </div>
              </TabsContent>

              <TabsContent value="block" className="mt-0 space-y-6">
                {/* 入力エリア */}
                <div className="flex gap-2">
                  <Input
                    value={blockInput}
                    onChange={(e) => setBlockInput(e.target.value)}
                    placeholder={t("ui.app.k7eb05e36")}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && blockInput.trim()) {
                        const trimmed = blockInput.trim();
                        if (!blockList.includes(trimmed)) {
                          setBlockList([...blockList, trimmed]);
                        }
                        setBlockInput('');
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (!blockInput.trim()) return;
                      const trimmed = blockInput.trim();
                      if (!blockList.includes(trimmed)) {
                        setBlockList([...blockList, trimmed]);
                      }
                      setBlockInput('');
                    }}
                    disabled={!blockInput.trim()}
                  >{
                    t("ui.app.kaec344de")}</Button>
                </div>

                {/* 一覧表示 */}
                <div className="space-y-2">
                  <Label className="text-sm">{t("ui.app.k62cfa361")}</Label>
                  <div className="border rounded-md max-h-48 overflow-y-auto divide-y">
                    {blockList.length === 0 && (
                      <p className="text-xs text-muted-foreground px-3 py-2">{
                        t("ui.app.k2e1a7258")}</p>
                    )}
                    {blockList.map((name, index) => (
                      <button
                        key={name + '-' + index}
                        type="button"
                        onClick={() =>
                          setSelectedBlockIndex(
                            selectedBlockIndex === index ? null : index
                          )
                        }
                        className={
                          "w-full flex items-center justify-between px-3 py-2 text-sm text-left " +
                          (selectedBlockIndex === index ? "bg-muted" : "bg-background")
                        }
                      >
                        <span>{name}</span>
                        {selectedBlockIndex === index && (
                          <span className="text-xs text-muted-foreground">{t("ui.app.k701f79be")}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 削除ボタン */}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={selectedBlockIndex === null}
                    onClick={() => {
                      if (selectedBlockIndex === null) return;
                      const newList = blockList.filter((_, i) => i !== selectedBlockIndex);
                      setBlockList(newList);
                      setSelectedBlockIndex(null);
                    }}
                  >{
                    t("ui.app.k88b0953e")}</Button>
                </div>
              </TabsContent>
            </div>
          </Tabs>

          <div className="flex justify-end mt-4">
            <Button type="button" onClick={handleSaveSettings}>
              {t("ui.app.kfadf24db")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-lg font-medium">{t("ui.app.kc7c610c8")}</p>
        </div>
      </div>
    );
  }

  // 未認証時の表示
  if (!isAuthenticated) {
    // 招待リンク経由は、未ログインでも専用画面を出す（ここでゲスト/通常ログイン）
    if (inviteToken) {
      return (
        <InviteView token={inviteToken} onClose={closeInvite} onJoinGame={handleJoinGame} />
      );
    }
    return (
      <TopStaticShogi onGotoLobby={() => switchView('lobby')} />
    );
  }

return (
    <div className={`app-root shogi-theme ${isGameView ? "is-game" : ""} ${isAuthenticated ? "is-auth" : ""}`}>
      {/* 設定ダイアログ */}
      <Dialog open={showSettingsDialog} onOpenChange={setShowSettingsDialog}>
        <DialogContent className="w-full sm:max-w-xl lg:max-w-2xl max-h-[80vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader className="mb-2">
            <DialogTitle>{t("ui.app.k6329f21c")}</DialogTitle>
	            <DialogDescription>
	              {t("ui.app.k723d0902")}
	            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="general" className="mt-2 flex flex-col sm:flex-row gap-4">
            {/* 左側 縦メニュー */}
            <div className="sm:w-28 lg:w-36 shrink-0">
              <TabsList className="flex flex-row sm:flex-col items-start gap-1">
                <TabsTrigger
                  value="general"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Settings className="h-4 w-4" />
                  <span>{t("ui.app.kf0aaccbc")}</span>
                </TabsTrigger>
                <TabsTrigger
                  value="sound"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Volume2 className="h-4 w-4" />
                  <span>{t("ui.app.k389775ae")}</span>
                </TabsTrigger>
                <TabsTrigger
                  value="block"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Ban className="h-4 w-4" />
                  <span>{t("ui.app.k62cf94ff")}</span>
                </TabsTrigger>
              </TabsList>
            </div>

            {/* 右側 コンテンツ */}
            <div className="flex-1 min-w-0">
              <TabsContent value="general" className="mt-0 space-y-6">
                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">{
                    t("ui.app.kc3b768c6")}</div>

                  {/* 背景セット */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="board-bg-set" className="w-28 shrink-0">{
                      t("ui.app.kacaba613")}</Label>
                    <div className="min-w-[10rem]">
                      <Select
                        value={boardBackgroundSet}
                        onValueChange={setBoardBackgroundSet}
                        disabled={themeSetOptions.backgroundSets.length === 0}
                      >
                        <SelectTrigger id="board-bg-set">
                          <SelectValue placeholder={t("ui.app.ke6b14bb3")} />
                        </SelectTrigger>
                        <SelectContent>
                          {themeSetOptions.backgroundSets.map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {t(s.displayName)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* 駒セット */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="board-piece-set" className="w-28 shrink-0">{
                      t("ui.app.k2d87732a")}</Label>
                    <div className="min-w-[10rem]">
                      <Select
                        value={boardPieceSet}
                        onValueChange={setBoardPieceSet}
                        disabled={themeSetOptions.pieceSets.length === 0}
                      >
                        <SelectTrigger id="board-piece-set">
                          <SelectValue placeholder={t("ui.app.ke2c19088")} />
                        </SelectTrigger>
                        <SelectContent>
                          {themeSetOptions.pieceSets.map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {t(s.displayName)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <ThemeSamplePreview bgSet={selectedBackgroundSetObj} pieceSet={selectedPieceSetObj} />

                  {/* 着手確認 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="move-confirm" className="w-28 shrink-0">{
                      t("ui.app.kfd4a4a68")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="move-confirm"
                        checked={!!moveConfirmEnabled}
                        onCheckedChange={(v) => setMoveConfirmEnabled(!!v)}
                      />
</div>
                  </div>
                  <div className="text-xs text-muted-foreground -mt-2">{
                    t("ui.app.k64a77abe")}</div>

                  {/* 移動元の強調表示 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="lastmove-from-highlight" className="w-28 shrink-0">{
                      t("ui.app.moveFromHighlightEnabled")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="lastmove-from-highlight"
                        checked={!!lastMoveFromHighlightEnabled}
                        onCheckedChange={(v) => setLastMoveFromHighlightEnabled(!!v)}
                      />
                    </div>
                  </div>

                  {/* 移動駒の強調表示 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="lastmove-piece-highlight" className="w-28 shrink-0">{
                      t("ui.app.movePieceHighlightEnabled")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="lastmove-piece-highlight"
                        checked={!!lastMovePieceHighlightEnabled}
                        onCheckedChange={(v) => setLastMovePieceHighlightEnabled(!!v)}
                      />
                    </div>
                  </div>

                  {/* 感想戦: 次の手 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="review-draw-next" className="w-28 shrink-0">{
                      t("ui.app.k35a22ac6")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="review-draw-next"
                        checked={!!reviewDrawNextMove}
                        onCheckedChange={(v) => setReviewDrawNextMove(!!v)}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground -mt-2">{
                    t("ui.app.k9e0f4057")}</div>

                  {/* 感想戦: 最善手 */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="review-draw-best" className="w-28 shrink-0">{
                      t("ui.app.k8960b9ca")}</Label>
                    <div className="flex flex-1 items-center justify-end">
                      <Switch className="scale-110"
                        id="review-draw-best"
                        checked={!!reviewDrawBestMove}
                        onCheckedChange={(v) => setReviewDrawBestMove(!!v)}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground -mt-2">{
                    t("ui.app.k99cc0d62")}</div>

                </div>
              </TabsContent>
              <TabsContent value="sound" className="mt-0 space-y-10">
                {/* 環境音 */}
                <div className="flex items-center gap-6 py-4">
                  <Label htmlFor="env-sound" className="w-28 shrink-0">{
                    t("ui.app.kc0ba5b38")}</Label>
                  <Slider
                    id="env-sound"
                    min={0}
                    max={100}
                    value={[envSoundVolume]}
                    onValueChange={(values) => setEnvSoundVolume(values[0] ?? 0)}
                    className="flex-1"
                  />
                  <span className="w-10 text-right text-xs text-muted-foreground">
                    {envSoundVolume}
                  </span>
                </div>

                {/* 効果音 */}
                <div className="flex items-center gap-6 py-4">
                  <Label htmlFor="sfx-sound" className="w-28 shrink-0">{
                    t("ui.app.k310719b8")}</Label>
                  <Slider
                    id="sfx-sound"
                    min={0}
                    max={100}
                    value={[sfxVolume]}
                    onValueChange={(values) => setSfxVolume(values[0] ?? 0)}
                    className="flex-1"
                  />
                  <span className="w-10 text-right text-xs text-muted-foreground">
                    {sfxVolume}
                  </span>
                </div>
              </TabsContent>

              <TabsContent value="block" className="mt-0 space-y-6">
                {/* 入力エリア */}
                <div className="flex gap-2">
                  <Input
                    value={blockInput}
                    onChange={(e) => setBlockInput(e.target.value)}
                    placeholder={t("ui.app.k7eb05e36")}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && blockInput.trim()) {
                        const trimmed = blockInput.trim();
                        if (!blockList.includes(trimmed)) {
                          setBlockList([...blockList, trimmed]);
                        }
                        setBlockInput('');
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (!blockInput.trim()) return;
                      const trimmed = blockInput.trim();
                      if (!blockList.includes(trimmed)) {
                        setBlockList([...blockList, trimmed]);
                      }
                      setBlockInput('');
                    }}
                    disabled={!blockInput.trim()}
                  >{
                    t("ui.app.kaec344de")}</Button>
                </div>

                {/* 一覧表示 */}
                <div className="space-y-2">
                  <Label className="text-sm">{t("ui.app.k62cfa361")}</Label>
                  <div className="border rounded-md max-h-48 overflow-y-auto divide-y">
                    {blockList.length === 0 && (
                      <p className="text-xs text-muted-foreground px-3 py-2">{
                        t("ui.app.k2e1a7258")}</p>
                    )}
                    {blockList.map((name, index) => (
                      <button
                        key={name + '-' + index}
                        type="button"
                        onClick={() =>
                          setSelectedBlockIndex(
                            selectedBlockIndex === index ? null : index
                          )
                        }
                        className={
                          "w-full flex items-center justify-between px-3 py-2 text-sm text-left " +
                          (selectedBlockIndex === index ? "bg-muted" : "bg-background")
                        }
                      >
                        <span>{name}</span>
                        {selectedBlockIndex === index && (
                          <span className="text-xs text-muted-foreground">{t("ui.app.k701f79be")}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 削除ボタン */}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={selectedBlockIndex === null}
                    onClick={() => {
                      if (selectedBlockIndex === null) return;
                      const newList = blockList.filter((_, i) => i !== selectedBlockIndex);
                      setBlockList(newList);
                      setSelectedBlockIndex(null);
                    }}
                  >{
                    t("ui.app.k88b0953e")}</Button>
                </div>
              </TabsContent>
            </div>
          </Tabs>

          <div className="flex justify-end mt-4">
            <Button type="button" onClick={handleSaveSettings}>
              {t("ui.app.kfadf24db")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ヘッダー */}
      <header ref={headerRef} className="site-header border-b bg-white/55 backdrop-blur-sm">
        <div className="container mx-auto px-4">
          <div className="site-header__inner flex items-center justify-between h-16">
            {/* ロゴ */}
            <div className="site-header__left flex items-center gap-3">
              <div className="relative flex-shrink-0">
                <div className="site-header__mark w-8 h-8 bg-gradient-to-br from-amber-600 to-stone-700 rounded-lg shadow-lg" />
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500 to-stone-600 rounded-lg blur-lg opacity-30" />
              </div>

              <div className="site-header__title leading-tight">
                <h1 className="text-base font-bold bg-gradient-to-r from-amber-700 to-stone-600 bg-clip-text text-transparent">
                  {t("ui.app.k883dcacc")}
                </h1>
                <p className="site-header__subtitle text-[9px] text-amber-700/60 tracking-[0.2em]">
                  {t("static.brand.latin")}
                </p>
              </div>
            </div>
            {/* デスクトップナビゲーション（wireframe v8風） */}
            <nav className="hidden lg:flex items-center gap-6 bg-white/50 backdrop-blur-md rounded-xl px-4 py-2 border border-white/50 shadow-sm">
              <Button
                variant="ghost"
                size="sm"
                disabled={isGameView}
                onClick={() => switchView('lobby')}
                className={headerNavBtn(currentView === 'lobby')}
              >
                <Users className="h-4 w-4" />
                {t("ui.app.k479954f1")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isGameView}
                onClick={() => switchView('kifu')}
                className={headerNavBtn(currentView === 'kifu')}
              >
                <Search className="h-4 w-4" />
                {t("ui.app.k9f0c19bf")}
              </Button>
            </nav>

            {/* ユーザー情報とメニュー */}
            <div className="flex items-center gap-4">
              {/* ユーザー情報 */}
              <div className={headerWireFrameBox("site-header__userinfo hidden sm:inline-flex") }>
                <Crown className="h-4 w-4 text-yellow-500" />
                <UserStatsOverlay userId={user?.user_id || user?.id || user?._id} align="end">
                  <button
                    type="button"
                    className="font-medium bg-transparent border-0 p-0 m-0 hover:underline underline-offset-2 focus:outline-none"
                  >
                    {user?.username}
                  </button>
                </UserStatsOverlay>
                <Badge variant="outline">{user?.rating ?? 1500}</Badge>
              </div>

              {/* 設定ボタン（デスクトップ） */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`site-header__settings hidden sm:inline-flex ${headerNavBtn(false)}`}
                onClick={() => setShowSettingsDialog(true)}
              >
                <Settings className="h-4 w-4 mr-1" />
                {t("ui.app.k6329f21c")}
              </Button>

              {/* モバイルメニューボタン */}
              <Button
                variant="ghost"
                size="sm"
                className="lg:hidden"
                onClick={() => setShowMobileMenu(!showMobileMenu)}
              >
                {showMobileMenu ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </Button>

              {/* ログアウトボタン（デスクトップ） */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className={headerNavBtn(false, "hidden lg:flex")}
              >
                <LogOut className="h-4 w-4 mr-2" />
                {t("ui.app.k33dedd93")}
              </Button>
            </div>
          </div>

          {/* モバイルメニュー */}
          {showMobileMenu && (
            <div className="lg:hidden border-t border-white/40 bg-white/50 backdrop-blur-md py-4 space-y-2">
              <div className={headerWireFrameBox("mx-4 w-[calc(100%-2rem)] justify-start") }>
                <Crown className="h-4 w-4 text-yellow-500" />
                <UserStatsOverlay userId={user?.user_id || user?.id || user?._id} align="start">
                  <button
                    type="button"
                    className="font-medium bg-transparent border-0 p-0 m-0 hover:underline underline-offset-2 focus:outline-none"
                  >
                    {user?.username}
                  </button>
                </UserStatsOverlay>
                <Badge variant="outline">{user?.rating ?? 1500}</Badge>
              </div>
              <Button
                variant="ghost"
                disabled={isGameView}
                onClick={() => switchView('lobby')}
                className={headerNavBtn(currentView === 'lobby', "w-full justify-start")}
               >
                <Users className="h-4 w-4 mr-2" />
                {t("ui.app.k479954f1")}
              </Button>
              <Button
                variant="ghost"
                disabled={isGameView}
                onClick={() => switchView('kifu')}
                className={headerNavBtn(currentView === 'kifu', "w-full justify-start")}
               >
                <Search className="h-4 w-4 mr-2" />
                {t("ui.app.k9f0c19bf")}
              </Button>
              {/* 設定（モバイル） */}
              <Button
                type="button"
                variant="ghost"
                onClick={() => { setShowSettingsDialog(true); setShowMobileMenu(false); }}
                className={headerNavBtn(false, "w-full justify-start")}
              >
                <Settings className="h-4 w-4 mr-2" />
                {t("ui.app.k6329f21c")}
              </Button>

              <Button
                variant="ghost"
                onClick={handleLogout}
                className={headerNavBtn(false, "w-full justify-start")}
              >
                <LogOut className="h-4 w-4 mr-2" />
                {t("ui.app.k33dedd93")}
              </Button>
            </div>
          )}
        </div>
      </header>
      <main className="site-main">
        <div className="viewport-shell">
          <div ref={mainShellRef} className={"main-shell" + (isGameView && shellWidthMode === "wide" ? " main-shell-wide" : "")}>
{/* 通知エリア */}
      {notifications.length > 0 && (
        <div className="fixed top-20 right-4 z-50 space-y-2">
          {notifications.map((notification) => (
            <Alert
              key={notification.id}
              variant={notification.type === 'error' ? 'destructive' : 'default'}
              className="w-80 fade-in cursor-pointer"
              onClick={() => removeNotification(notification.id)}
            >
              <AlertDescription>{notification.message}</AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      {/* メインコンテンツ */}
      

        {currentView === 'invite' && inviteToken && (
          <InviteView token={inviteToken} onClose={closeInvite} onJoinGame={handleJoinGame} />
        )}

        {currentView === 'lobby' && (
          <LobbyView onJoinGame={handleJoinGame} />
        )}

        {currentView === 'game' && currentGameId && (
          <div className="w-full flex flex-col flex-1 min-h-0 game-viewport">
            {isLgUp ? (
            <div className="w-full h-full flex-1 min-h-0 overflow-hidden">
              <GameView onRequestClose={handleCloseGame}
                gameId={currentGameId}
                isSpectator={isSpectator}
                onLeaveGame={handleLeaveGame}
                shellWidthMode={shellWidthMode}
                onChangeShellWidthMode={setShellWidthMode}
                coordVisible={coordVisible}
                onChangeCoordVisible={setCoordVisible}
                moveConfirmEnabled={moveConfirmEnabled}
                onChangeMoveConfirmEnabled={setMoveConfirmEnabled}
                reviewDrawNextMove={reviewDrawNextMove}
                reviewDrawBestMove={reviewDrawBestMove}
                lastMoveFromHighlightEnabled={lastMoveFromHighlightEnabled}
                lastMovePieceHighlightEnabled={lastMovePieceHighlightEnabled}
              />
            </div>
            ) : (
            <div className="game-mobile-shell relative">
              {/* extra-small top-right game toolbar (SEなど) */}
              <div className="mini-game-toolbar">
                <Button
                  variant="secondary"
                  size="sm"
                  className="mini-game-toolbar__btn"
                  onClick={() => setShowMobileMenu(!showMobileMenu)}
                >
                  <Menu className="h-4 w-4" />
                </Button>
              </div>

              {/* extra-small in-game menu (ヘッダーのモバイルメニューと同等） */}
              {showMobileMenu && (
                <div className="mini-game-menu">
                  <Button
                    variant="ghost"
                    disabled={isGameView}
                    onClick={() => switchView('lobby')}
                    className={headerNavBtn(false, "w-full justify-start text-sm")}
                  >
                    <Users className="h-4 w-4 mr-2" />{
                    t("ui.app.k479954f1")}</Button>
                  <Button
                    variant="ghost"
                    disabled={isGameView}
                    onClick={() => switchView('kifu')}
                    className={headerNavBtn(false, "w-full justify-start text-sm")}
                  >
                    <Search className="h-4 w-4 mr-2" />{
                    t("ui.app.k9f0c19bf")}</Button>

                  {/* 設定（extra-small） */}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => { setShowSettingsDialog(true); setShowMobileMenu(false); }}
                    className={headerNavBtn(false, "w-full justify-start text-sm")}
                  >
                    <Settings className="h-4 w-4 mr-2" />{
                    t("ui.app.k6329f21c")}</Button>

                  <Button
                    variant="ghost"
                    onClick={handleLogout}
                    className={headerNavBtn(false, "w-full justify-start text-sm")}
                  >
                    <LogOut className="h-4 w-4 mr-2" />{
                    t("ui.app.k33dedd93")}</Button>
                </div>
              )}

              <GameView onRequestClose={handleCloseGame}
                gameId={currentGameId}
                isSpectator={isSpectator}
                onLeaveGame={handleLeaveGame}
                shellWidthMode={shellWidthMode}
                onChangeShellWidthMode={setShellWidthMode}
                coordVisible={coordVisible}
                onChangeCoordVisible={setCoordVisible}
                moveConfirmEnabled={moveConfirmEnabled}
                onChangeMoveConfirmEnabled={setMoveConfirmEnabled}
                  reviewDrawNextMove={reviewDrawNextMove}
                  reviewDrawBestMove={reviewDrawBestMove}
                lastMoveFromHighlightEnabled={lastMoveFromHighlightEnabled}
                lastMovePieceHighlightEnabled={lastMovePieceHighlightEnabled}
              />
            </div>
            )}
          </div>
        )}

        {/* 対局画面(通常サイズ)の右側の空き領域に、ユーザー一覧のみのロビーを表示 */}
        {isLgUp && isGameView && currentGameId && shellWidthMode === 'normal' && sideDock.width >= 40 && (
          <aside
            className="fixed z-20"
            style={{
              top: 'var(--hdr,56px)',
              bottom: 0,
              left: sideDock.left,
              width: showSideLobby ? sideDock.width : Math.min(40, sideDock.width),
            }}
          >
            <div className="h-full w-full flex">
              {/* バー幅: 32〜40px（ボタンを中に収める） */}
              <div className="h-full w-10 border-l bg-card/95 supports-[backdrop-filter]:bg-card/85 backdrop-blur-sm flex items-start justify-center pt-4">
                <button
                  className="w-8 h-8 rounded-full border bg-background shadow hover:bg-accent flex items-center justify-center"
                  onClick={() => setShowSideLobby(v => !v)}
                  title={showSideLobby ? t("ui.app.k3da5c185") : t("ui.app.kc8dc2d63")}
                >
                  {showSideLobby ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                </button>
              </div>

              <div className={(showSideLobby ? 'flex-1' : 'hidden') + ' h-full min-w-0 overflow-hidden'}>
                <div className="h-full min-w-0 overflow-hidden">
                  <LobbyView onJoinGame={handleJoinGame} compact />
                </div>
              </div>
            </div>
          </aside>
        )}
        
        {currentView === 'kifu' && (
          <KifuSearch />
        )}
      

      {/* フッター */}
      

      
              </div>
          </div>
      </main>
      <footer ref={footerRef} className="site-footer footer-bar border-t bg-white/60 supports-[backdrop-filter]:bg-white/50 backdrop-blur-sm">
        <div className="flex-1 w-full px-0 sm:px-4 py-6 sm:max-w-5xl mx-auto">
          <div className="text-center text-sm text-muted-foreground">
            <p>{t("ui.app.k8ad40658")}</p>
            <p className="mt-2">
              
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

// メインアプリケーション
const App = () => {
  return (
    <AuthProvider>
      <OnlineUsersProvider>
        <LoginWarningLayer />
        <AppContent />
        <IncomingOfferLayer />
        <OutgoingOfferLayer />
      </OnlineUsersProvider>
    </AuthProvider>
  );
};

// One-time login warning modal (shown only when server returned login_warning)
function LoginWarningLayer() {
  const { isAuthenticated } = useAuth();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!isAuthenticated) return;
    try {
      const m = window.sessionStorage.getItem('login_warning');
      if (m) {
        setMsg(String(m));
        setOpen(true);
        window.sessionStorage.removeItem('login_warning');
      }
    } catch (_) {
      // ignore
    }
  }, [isAuthenticated]);

  if (!msg) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setMsg('');
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ui.app.k5521e368")}</DialogTitle>
          <DialogDescription>{t("ui.app.kcd358b4c")}</DialogDescription>
        </DialogHeader>
        <div className="text-sm whitespace-pre-wrap break-words">{msg}</div>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => setOpen(false)}>{t("ui.app.k3da5c185")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default App;
