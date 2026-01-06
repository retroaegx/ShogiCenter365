import './styles/shogi.css'
import './styles/layout-fix-v15.css'

import '@/services/fetchAuthPatch'
import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import useAutoJwtRefresh from '@/hooks/useAutoJwtRefresh';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
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
import useSound from '@/hooks/useSound';
import websocketService from '@/services/websocketService';
import api from '@/services/apiClient';
import LoginForm from '@/components/auth/LoginForm';
import RegisterForm from '@/components/auth/RegisterForm';
import LobbyView from '@/components/lobby/LobbyView';
import IncomingOfferLayer from '@/components/lobby/IncomingOfferLayer';
import OutgoingOfferLayer from '@/components/lobby/OutgoingOfferLayer';
import GameView from '@/components/game/GameView';
import KifuSearch from '@/components/kifu/KifuSearch';
import TopStaticShogi from '@/components/top/TopStaticShogi';
import { loadBoardThemeConfig, THEME_LS_KEYS } from '@/config/themeLoader';
import './App.css';
import './styles/responsive.css';

// メインアプリケーションコンポーネント
const AppContent = () => {
  const headerRef = useRef(null);
  const footerRef = useRef(null);

  const { user, logout, isAuthenticated, loading, setUser } = useAuth();
  // NOTE: setSfxVolume は state setter と衝突しやすいので別名にする
  const { installUnlockHandlers, setEnvVolume, setSfxVolume: setSfxVolumeGain, playEnv, playSfx } = useSound();
  const [currentView, setCurrentView] = useState('lobby');
  const isGameView = currentView === 'game';

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
    let t = 0;
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
    t = window.setTimeout(schedule, 400);

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
      if (t) clearTimeout(t);
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
  const [showSideLobby, setShowSideLobby] = useState(false);
  const [shellWidthMode, setShellWidthMode] = useState(() => {
    // 対局画面での main-shell 横幅 (normal|wide)
    try {
      const v = window?.localStorage?.getItem('shogi_shellWidthMode');
      if (v === 'wide' || v === 'normal') return v;
    } catch {}
    return "normal";
  });
  const [coordVisible, setCoordVisible] = useState(() => {
    // 対局画面: 盤上の符号(座標)表示
    try {
      const v = window?.localStorage?.getItem('shogi_coordVisible');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch {}
    return true;
  }); // 対局画面での main-shell 横幅
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
    if (cv !== null) setCoordVisible(cv);
    if (swm === 'wide' || swm === 'normal') setShellWidthMode(swm);
    try {
      if (bg) localStorage.setItem(THEME_LS_KEYS.backgroundSet, bg);
      if (ps) localStorage.setItem(THEME_LS_KEYS.pieceSet, ps);
      if (cv !== null) localStorage.setItem('shogi_coordVisible', cv ? '1' : '0');
      if (swm === 'wide' || swm === 'normal') localStorage.setItem('shogi_shellWidthMode', swm);
    } catch {}
  }, [user]);

  // 対局画面UI設定の localStorage 反映（未ログインでも復元できるように）
  useEffect(() => {
    try { localStorage.setItem('shogi_coordVisible', coordVisible ? '1' : '0'); } catch {}
  }, [coordVisible]);

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

    if (desiredCv === coordVisible && desiredSwm === shellWidthMode) return;

    if (saveGameUiTimerRef.current) {
      try { clearTimeout(saveGameUiTimerRef.current); } catch {}
    }

    saveGameUiTimerRef.current = window.setTimeout(async () => {
      try {
        const payload = { settings: { coordVisible, shellWidthMode } };
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
    isAuthenticated,
    user?.id,
    user?.settings?.coordVisible,
    user?.settings?.shellWidthMode,
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
        addNotification('error', data.message || 'エラーが発生しました');
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
    try {
      // 入室効果音
      playSfx?.('room_enter');
      // 対局開始（自分が入室時）
      if (!spectator) playEnv?.('game_start');
    } catch {}
    setCurrentGameId(gameId);
    setIsSpectator(spectator);
    setCurrentView('game');
    // 対局開始時は右サイドのロビーを自動でたたむ（表示崩れ防止）
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
          addNotification('info', '申請は拒否されました');
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
    addNotification('success', 'ログインしました');
  };

  // 登録成功時の処理
  const handleRegisterSuccess = () => {
    setAuthMode('login');
    addNotification('success', 'アカウントを作成しました。ログインしてください。');
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
        return 'オンライン';
      case 'error':
        return '接続エラー';
      default:
        return 'オフライン';
    }
  };

  if (loading) {
    return (
    <div className={`app-root shogi-theme ${isGameView ? "is-game" : ""}`}>
      {/* 設定ダイアログ */}
      <Dialog open={showSettingsDialog} onOpenChange={setShowSettingsDialog}>
        <DialogContent className="w-full sm:max-w-xl lg:max-w-2xl max-h-[80vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader className="mb-2">
            <DialogTitle>設定</DialogTitle>
            <DialogDescription>
              一般・サウンド・ブロックリストなどのユーザー設定を調整できます。
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="general" className="mt-2 flex flex-col sm:flex-row gap-4">
            {/* 左側 縦メニュー */}
            <div className="sm:w-28 md:w-36 shrink-0">
              <TabsList className="flex flex-row sm:flex-col items-start gap-1">
                <TabsTrigger
                  value="general"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Settings className="h-4 w-4" />
                  <span>一般</span>
                </TabsTrigger>
                <TabsTrigger
                  value="sound"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Volume2 className="h-4 w-4" />
                  <span>サウンド</span>
                </TabsTrigger>
                <TabsTrigger
                  value="block"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Ban className="h-4 w-4" />
                  <span>ブロックリスト</span>
                </TabsTrigger>
              </TabsList>
            </div>

            {/* 右側 コンテンツ */}
            <div className="flex-1 min-w-0">
              <TabsContent value="general" className="mt-0 space-y-6">
                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">
                    盤面の背景と駒画像のセットを選べます。
                  </div>

                  {/* 背景セット */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="board-bg-set" className="w-28 shrink-0">
                      背景セット
                    </Label>
                    <div className="min-w-[10rem]">
                      <Select
                        value={boardBackgroundSet}
                        onValueChange={setBoardBackgroundSet}
                        disabled={themeSetOptions.backgroundSets.length === 0}
                      >
                        <SelectTrigger id="board-bg-set">
                          <SelectValue placeholder="背景を選択" />
                        </SelectTrigger>
                        <SelectContent>
                          {themeSetOptions.backgroundSets.map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {s.displayName || s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* 駒セット */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="board-piece-set" className="w-28 shrink-0">
                      駒セット
                    </Label>
                    <div className="min-w-[10rem]">
                      <Select
                        value={boardPieceSet}
                        onValueChange={setBoardPieceSet}
                        disabled={themeSetOptions.pieceSets.length === 0}
                      >
                        <SelectTrigger id="board-piece-set">
                          <SelectValue placeholder="駒を選択" />
                        </SelectTrigger>
                        <SelectContent>
                          {themeSetOptions.pieceSets.map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {s.displayName || s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="sound" className="mt-0 space-y-6">
                {/* 環境音 */}
                <div className="flex items-center gap-4 py-2">
                  <Label htmlFor="env-sound" className="w-28 shrink-0">
                    環境音
                  </Label>
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
                <div className="flex items-center gap-4 py-2">
                  <Label htmlFor="sfx-sound" className="w-28 shrink-0">
                    効果音
                  </Label>
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
                    placeholder="ブロックするユーザー名を入力"
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
                  >
                    追加
                  </Button>
                </div>

                {/* 一覧表示 */}
                <div className="space-y-2">
                  <Label className="text-sm">ブロック中のユーザー</Label>
                  <div className="border rounded-md max-h-48 overflow-y-auto divide-y">
                    {blockList.length === 0 && (
                      <p className="text-xs text-muted-foreground px-3 py-2">
                        まだブロックしているユーザーはいません。
                      </p>
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
                          <span className="text-xs text-muted-foreground">選択中</span>
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
                  >
                    選択したユーザーをブロック解除
                  </Button>
                </div>
              </TabsContent>
            </div>
          </Tabs>

          <div className="flex justify-end mt-4">
            <Button type="button" onClick={handleSaveSettings}>
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>

        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-lg font-medium">読み込み中...</p>
        </div>
      </div>
    );
  }

  // 未認証時の表示
  if (!isAuthenticated) {
    return (
      <TopStaticShogi onGotoLobby={() => switchView('lobby')} />
    );
  }

  return (
    <div className={`app-root shogi-theme ${isGameView ? "is-game" : ""}`}>
      {/* 設定ダイアログ */}
      <Dialog open={showSettingsDialog} onOpenChange={setShowSettingsDialog}>
        <DialogContent className="w-full sm:max-w-xl lg:max-w-2xl max-h-[80vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader className="mb-2">
            <DialogTitle>設定</DialogTitle>
            <DialogDescription>
              一般・サウンド・ブロックリストなどのユーザー設定を調整できます。
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="general" className="mt-2 flex flex-col sm:flex-row gap-4">
            {/* 左側 縦メニュー */}
            <div className="sm:w-28 md:w-36 shrink-0">
              <TabsList className="flex flex-row sm:flex-col items-start gap-1">
                <TabsTrigger
                  value="general"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Settings className="h-4 w-4" />
                  <span>一般</span>
                </TabsTrigger>
                <TabsTrigger
                  value="sound"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Volume2 className="h-4 w-4" />
                  <span>サウンド</span>
                </TabsTrigger>
                <TabsTrigger
                  value="block"
                  className="justify-start gap-2 px-3 py-2 text-sm"
                >
                  <Ban className="h-4 w-4" />
                  <span>ブロックリスト</span>
                </TabsTrigger>
              </TabsList>
            </div>

            {/* 右側 コンテンツ */}
            <div className="flex-1 min-w-0">
              <TabsContent value="general" className="mt-0 space-y-6">
                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">
                    盤面の背景と駒画像のセットを選べます。
                  </div>

                  {/* 背景セット */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="board-bg-set" className="w-28 shrink-0">
                      背景セット
                    </Label>
                    <div className="min-w-[10rem]">
                      <Select
                        value={boardBackgroundSet}
                        onValueChange={setBoardBackgroundSet}
                        disabled={themeSetOptions.backgroundSets.length === 0}
                      >
                        <SelectTrigger id="board-bg-set">
                          <SelectValue placeholder="背景を選択" />
                        </SelectTrigger>
                        <SelectContent>
                          {themeSetOptions.backgroundSets.map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {s.displayName || s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* 駒セット */}
                  <div className="flex items-center gap-4 py-2">
                    <Label htmlFor="board-piece-set" className="w-28 shrink-0">
                      駒セット
                    </Label>
                    <div className="min-w-[10rem]">
                      <Select
                        value={boardPieceSet}
                        onValueChange={setBoardPieceSet}
                        disabled={themeSetOptions.pieceSets.length === 0}
                      >
                        <SelectTrigger id="board-piece-set">
                          <SelectValue placeholder="駒を選択" />
                        </SelectTrigger>
                        <SelectContent>
                          {themeSetOptions.pieceSets.map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {s.displayName || s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="sound" className="mt-0 space-y-6">
                {/* 環境音 */}
                <div className="flex items-center gap-4 py-2">
                  <Label htmlFor="env-sound" className="w-28 shrink-0">
                    環境音
                  </Label>
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
                <div className="flex items-center gap-4 py-2">
                  <Label htmlFor="sfx-sound" className="w-28 shrink-0">
                    効果音
                  </Label>
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
                    placeholder="ブロックするユーザー名を入力"
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
                  >
                    追加
                  </Button>
                </div>

                {/* 一覧表示 */}
                <div className="space-y-2">
                  <Label className="text-sm">ブロック中のユーザー</Label>
                  <div className="border rounded-md max-h-48 overflow-y-auto divide-y">
                    {blockList.length === 0 && (
                      <p className="text-xs text-muted-foreground px-3 py-2">
                        まだブロックしているユーザーはいません。
                      </p>
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
                          <span className="text-xs text-muted-foreground">選択中</span>
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
                  >
                    選択したユーザーをブロック解除
                  </Button>
                </div>
              </TabsContent>
            </div>
          </Tabs>

          <div className="flex justify-end mt-4">
            <Button type="button" onClick={handleSaveSettings}>
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ヘッダー */}
      <header ref={headerRef} className="site-header border-b bg-white/55 backdrop-blur-sm">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            {/* ロゴ */}
            <div className="flex items-center gap-3">
              <div className="relative flex-shrink-0">
                <div className="w-8 h-8 bg-gradient-to-br from-amber-600 to-stone-700 rounded-lg shadow-lg" />
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500 to-stone-600 rounded-lg blur-lg opacity-30" />
              </div>

              <div className="leading-tight">
                <h1 className="text-base font-bold bg-gradient-to-r from-amber-700 to-stone-600 bg-clip-text text-transparent">
                  将棋センター365
                </h1>
                <p className="text-[9px] text-amber-700/60 tracking-[0.2em]">
                  SHOGI CENTER 365
                </p>
              </div>

              <div className="hidden sm:flex items-center gap-2 ml-2">
                {getConnectionIcon()}
                <span className="text-sm text-muted-foreground">
                  {getConnectionText()}
                </span>
              </div>
            </div>

            {/* デスクトップナビゲーション */}
            <nav className="hidden md:flex items-center gap-4">
              <Button
                variant={currentView === 'lobby' ? 'default' : 'ghost'}
                  disabled={isGameView}
               
                onClick={() => switchView('lobby')}
              >
                <Users className="h-4 w-4 mr-2" />
                ロビー
              </Button>
              <Button
                variant={currentView === 'kifu' ? 'default' : 'ghost'}
                  disabled={isGameView}
               
                onClick={() => switchView('kifu')}
              >
                <Search className="h-4 w-4 mr-2" />
                棋譜検索
              </Button>
    </nav>

            {/* ユーザー情報とメニュー */}
            <div className="flex items-center gap-4">
              {/* ユーザー情報 */}
              <div className="hidden sm:flex items-center gap-2">
                <Crown className="h-4 w-4 text-yellow-500" />
                <span className="font-medium">{user?.username}</span>
                <Badge variant="outline">{user?.rating ?? 1500}</Badge>
              </div>

              {/* 設定ボタン（デスクトップ） */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="hidden sm:inline-flex"
                onClick={() => setShowSettingsDialog(true)}
              >
                <Settings className="h-4 w-4 mr-1" />
                設定
              </Button>

              {/* モバイルメニューボタン */}
              <Button
                variant="ghost"
                size="sm"
                className="md:hidden"
                onClick={() => setShowMobileMenu(!showMobileMenu)}
              >
                {showMobileMenu ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </Button>

              {/* ログアウトボタン（デスクトップ） */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleLogout}
                className="hidden md:flex"
              >
                <LogOut className="h-4 w-4 mr-2" />
                ログアウト
              </Button>
            </div>
          </div>

          {/* モバイルメニュー */}
          {showMobileMenu && (
            <div className="md:hidden border-t bg-card py-4 space-y-2">
              <div className="flex items-center gap-2 px-4 py-2">
                <Crown className="h-4 w-4 text-yellow-500" />
                <span className="font-medium">{user?.username}</span>
                <Badge variant="outline">{user?.rating ?? 1500}</Badge>
                <div className="ml-auto flex items-center gap-2">
                  {getConnectionIcon()}
                  <span className="text-sm text-muted-foreground">
                    {getConnectionText()}
                  </span>
                </div>
              </div>
              <Button
                variant={currentView === 'lobby' ? 'default' : 'ghost'}
                disabled={isGameView}
                onClick={() => switchView('lobby')}
                className="w-full justify-start"
               >
                <Users className="h-4 w-4 mr-2" />
                ロビー
              </Button>
              <Button
                variant={currentView === 'kifu' ? 'default' : 'ghost'}
                disabled={isGameView}
                onClick={() => switchView('kifu')}
                className="w-full justify-start"
               >
                <Search className="h-4 w-4 mr-2" />
                棋譜検索
              </Button>
              {/* 設定（モバイル） */}
              <Button
                type="button"
                variant="ghost"
                onClick={() => { setShowSettingsDialog(true); setShowMobileMenu(false); }}
                className="w-full justify-start"
              >
                <Settings className="h-4 w-4 mr-2" />
                設定
              </Button>

              <Button
                variant="outline"
                onClick={handleLogout}
                className="w-full justify-start"
              >
                <LogOut className="h-4 w-4 mr-2" />
                ログアウト
              </Button>
            </div>
          )}
        </div>
      </header>
      <main className="site-main">
        <div className="viewport-shell">
          <div className={"main-shell" + (isGameView && shellWidthMode === "wide" ? " main-shell-wide" : "")}>
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
      

        {currentView === 'lobby' && (
          <LobbyView onJoinGame={handleJoinGame} />)
}
        
        {currentView === 'game' && currentGameId && (
          <div className="w-full flex flex-col flex-1 min-h-0 game-viewport">
            {/* mobile full-screen */}
            <div className="md:hidden game-mobile-shell relative">
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
                    variant={currentView === 'lobby' ? 'default' : 'ghost'}
                    disabled={isGameView}
                    onClick={() => switchView('lobby')}
                    className="w-full justify-start text-sm"
                  >
                    <Users className="h-4 w-4 mr-2" />
                    ロビー
                  </Button>
                  <Button
                    variant={currentView === 'kifu' ? 'default' : 'ghost'}
                    disabled={isGameView}
                    onClick={() => switchView('kifu')}
                    className="w-full justify-start text-sm"
                  >
                    <Search className="h-4 w-4 mr-2" />
                    棋譜検索
                  </Button>
                  {/* 設定（extra-small） */}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => { setShowSettingsDialog(true); setShowMobileMenu(false); }}
                    className="w-full justify-start text-sm"
                  >
                    <Settings className="h-4 w-4 mr-2" />
                    設定
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleLogout}
                    className="w-full justify-start text-sm"
                  >
                    <LogOut className="h-4 w-4 mr-2" />
                    ログアウト
                  </Button>
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
              />
            </div>
            {/* desktop: game + collapsible right lobby */}
            <div className="hidden md:grid md:grid-cols-[1fr_auto] md:grid-rows-[minmax(0,1fr)] w-full h-full flex-1 min-h-0">
              <div className="h-full min-h-0 overflow-hidden">
                <GameView onRequestClose={handleCloseGame}
                  gameId={currentGameId}
                  isSpectator={isSpectator}
                  onLeaveGame={handleLeaveGame}
                  shellWidthMode={shellWidthMode}
                  onChangeShellWidthMode={setShellWidthMode}
                coordVisible={coordVisible}
                  onChangeCoordVisible={setCoordVisible}
                />
              </div>
              <aside className={"relative hidden md:block border-l bg-card transition-all duration-300 " + (showSideLobby ? "w-[360px]" : "w-10")}>
                <button
                  className="absolute -left-4 top-4 z-10 w-8 h-8 rounded-full border bg-background shadow hover:bg-accent flex items-center justify-center"
                  onClick={()=>setShowSideLobby(v=>!v)}
                  title={showSideLobby ? "閉じる" : "ひらく"}
                >
                  {showSideLobby ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                </button>
                <div className={(showSideLobby ? "opacity-100" : "opacity-0 pointer-events-none") + " transition-opacity duration-200 h-full overflow-y-auto"}>
                  <LobbyView onJoinGame={handleJoinGame} />
                </div>
              </aside>
            </div>
          </div>
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
            <p>&copy; 2025 将棋センター365. All rights reserved.</p>
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
      <AppContent />
      <IncomingOfferLayer />
      <OutgoingOfferLayer />
    </AuthProvider>
  );
};

export default App;
