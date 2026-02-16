import { RefreshCcw, LogOut, Clock, Play, Square, Loader2, UserRound } from 'lucide-react';
import api from '@/services/apiClient';
import websocketService from '@/services/websocketService';
import { useAuth } from '@/contexts/AuthContext';
import useSound from '@/hooks/useSound';
import WaitConfigModal from './WaitConfigModal';
import { RATING_TAB_DEFS, getRatingTabs, bandOfRating } from '@/services/ratingBands';
import { ratingToRank24 } from '@/utils/rating24';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { t, getLanguage } from '@/i18n';
import { gameErrorMessage } from '@/i18n/gameErrors';
import { lobbyJoinErrorMessage, inviteErrorMessage } from '@/i18n/lobbyErrors';
import DoubleLineActionButton from '@/components/ui/double-line-action-button';
import { Button } from '@/components/ui/button';
import UserStatsOverlay from '@/components/user/UserStatsOverlay';
import LegionFlagIcon from '@/components/common/LegionFlagIcon';


const statusLabelOf = (w) => {
  if (w === 'applying') return t('ui.components.lobby.lobbyview.k2c8ae496');
  if (w === 'pending') return t('ui.components.lobby.lobbyview.k1c9aa13f');
  if (w === 'seeking') return t('ui.components.lobby.lobbyview.k55e95614');
  if (w === 'playing') return t('ui.components.lobby.lobbyview.kc0a194e7');
  if (w === 'review') return t('ui.components.lobby.lobbyview.k64aae95e');
  return t('ui.components.lobby.lobbyview.k479954f1');
};

// src/components/lobby/LobbyView.jsx

function OfferModal({ open, onClose, onSubmit, defaultCode, options = [], submitting = false, ratingNote }) {
  const [code, setCode] = useState(defaultCode || (options[0]?.code ?? ''));
  useEffect(() => { if (open) setCode(defaultCode || (options[0]?.code ?? '')); }, [open, defaultCode, options]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] card-like shogi-merge">
      <div className="bg-white rounded-xl p-4 w-[340px]">
        <div className="text-lg font-semibold mb-2">{t("ui.components.lobby.lobbyview.k1a9bf87b")}</div>
        <div className="text-sm mb-1">{t("ui.components.lobby.lobbyview.k21e72ec7")}</div>
        <div className="flex flex-wrap gap-2 mb-2">
          {options.map(opt => (
            <button
              key={opt.code}
              className={"px-3 py-1 rounded border " + (code===opt.code ? "bg-gray-200":"bg-white")}
              onClick={()=> setCode(opt.code)}
            >{opt.name}</button>
          ))}
        </div>
        {ratingNote && (
          <div className="mb-2 text-xs text-red-500">
            {ratingNote}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 border rounded" onClick={onClose} disabled={submitting}>{t("ui.components.lobby.lobbyview.k18ca8614")}</button>
          <button className="px-3 py-1 border rounded bg-emerald-600 text-white hover:bg-emerald-700"

            onClick={()=> onSubmit?.(code)} disabled={!code || submitting}>
            {submitting ? t('ui.components.lobby.lobbyview.k7f1bfccb') : t('ui.components.lobby.lobbyview.k53ea5d46')}
          </button>
        </div>
      </div>
    </div>
  );
}

function AlertModal({ open, title, message = "", onClose }) {
  const displayTitle = title ?? t("ui.components.lobby.lobbyview.k85e598e7");
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[110]">
      <div className="bg-white rounded-xl p-4 w-[340px]">
        <div className="text-lg font-semibold mb-2">{displayTitle}</div>
        <div className="text-sm text-gray-700 mb-4 whitespace-pre-wrap">{message}</div>
        <div className="flex justify-end">
          <button className="px-3 py-1 border rounded" onClick={onClose}>{t("ui.components.lobby.lobbyview.k3da5c185")}</button>
        </div>
      </div>
    </div>
  );
}


const USERS_POLL_MS = 45000;
export default function LobbyView({ onJoinGame, compact = false }) {
  const { playEnv } = useSound();
  const lang = getLanguage();
  // ---- time controls (from backend) ----
  const [timeControls, setTimeControls] = useState([]);

    const [code2name, setCode2name] = useState({});



  // 強制スクロール: ホイール/タッチを user-list に確実に流す
  const [name2code, setName2code] = useState({});
  useEffect(() => {
    (async () => {
      const q = lang ? `?lang=${encodeURIComponent(lang)}` : '';
      const r = await fetch(`/api/lobby/time-controls${q}`, { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      const arr = Array.isArray(j?.controls) ? j.controls : [];
      setTimeControls(arr);
      setCode2name(Object.fromEntries(arr.map(x => [x.code, x.name])));
      setName2code(Object.fromEntries(arr.map(x => [x.name, x.code])));
    })();
  }, [lang]);
  const codeToName = (code) => code2name[code] || '';
  // --------------------------------------
const { user, logout } = useAuth();
  const isBanned = Boolean(user?.is_banned);
  const [users, setUsers] = useState([]);
    const [offerTarget, setOfferTarget] = useState(null);
  const [offerSubmitting, setOfferSubmitting] = useState(false);
  const [applyFailOpen, setApplyFailOpen] = useState(false);
  const [applyFailMsg, setApplyFailMsg] = useState('');
  const [incomingOffer, setIncomingOffer] = useState(null);

  useEffect(() => {
    if (!offerTarget) setOfferSubmitting(false);
  }, [offerTarget]);

  const handleSpectate = async (targetUserId) => {
    try {
      const res = await api.post('/game/spectate-by-user', { target_user_id: targetUserId });
      const gid = res?.data?.game_id;
      if (!gid) return;
      if (typeof onJoinGame === 'function') {
        onJoinGame(gid, true);
      } else {
        try {
          websocketService.joinGame(gid);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('open_game', { detail: { gameId: gid, spectator: true } }));
          }
        } catch (e) {
          console.error('failed to join game for spectate', e);
        }
      }
    } catch (e) {
      console.error('spectate-by-user failed', e);
      const code = e?.response?.data?.error_code || e?.response?.data?.error || e?.response?.data?.code;
      const fb = e?.response?.data?.message || e?.message || '';
      setErr(gameErrorMessage(code, fb, t('ui.components.lobby.lobbyview.k857d8f4f')));
    }
  };
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [waitOpen, setWaitOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [activeTab, setActiveTab] = useState(null);
  const [hoveredUserId, setHoveredUserId] = useState(null);

  const myId = user?.user_id || user?._id || user?.id;

  // 待ち開始モーダル: レーティング範囲（チェック/数値）を保存して復元する
  const WAIT_CFG_SPANS = [100, 150, 200, 250, 300, 350, 400];
  const waitCfgKey = useMemo(() => {
    const uid = (user?.user_id || user?._id || user?.id || user?.username || 'guest');
    return `shogi.waitConfig.ratingRange.v1:${String(uid)}`;
  }, [user?.user_id, user?._id, user?.id, user?.username]);

  const readWaitCfg = useCallback((key) => {
    const def = { useRange: true, rateSpan: 300 };
    try {
      if (typeof window === 'undefined' || !window.localStorage) return def;
      const raw = window.localStorage.getItem(key);
      if (!raw) return def;
      const obj = JSON.parse(raw);
      const useRange = (obj && typeof obj === 'object' && typeof obj.useRange === 'boolean') ? obj.useRange : def.useRange;
      const spanRaw = (obj && typeof obj === 'object') ? obj.rateSpan : undefined;
      const spanN = Number(spanRaw);
      const span = Number.isFinite(spanN) ? Math.floor(spanN) : def.rateSpan;
      return {
        useRange,
        rateSpan: WAIT_CFG_SPANS.includes(span) ? span : def.rateSpan,
      };
    } catch {
      return def;
    }
  }, []);

  const writeWaitCfg = useCallback((key, cfg) => {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const obj = {
        useRange: !!cfg?.useRange,
        rateSpan: WAIT_CFG_SPANS.includes(Number(cfg?.rateSpan)) ? Number(cfg?.rateSpan) : 300,
      };
      window.localStorage.setItem(key, JSON.stringify(obj));
    } catch {}
  }, []);

  const [waitRatingCfg, setWaitRatingCfg] = useState(() => readWaitCfg(waitCfgKey));
  useEffect(() => {
    setWaitRatingCfg(readWaitCfg(waitCfgKey));
  }, [waitCfgKey, readWaitCfg]);

  function idToStr(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return v.$oid ?? v.oid ?? v.id ?? String(v);
    return String(v);
  }

  async function doRefresh() {
    try {
  const res = await api.post('/lobby/touch?force=1');
  const t = res?.data?.access_token;
  if (t) {
    localStorage.setItem('access_token', t);
    localStorage.setItem('token', t);
  }
} catch (e) { /* ignore */ }
    await fetchUsers();
  }

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/lobby/online-users');
      const list = Array.isArray(res.data?.users) ? res.data.users : [];
      setUsers(list);
      setErr('');
    } catch (e) {
      if (e?.response?.status !== 401) {
        setErr(t("ui.components.lobby.lobbyview.k5b841145"));
      }
      console.error('online-users error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const heartbeat = useCallback(async () => {
    try {
      await Promise.resolve() /* active removed */;
    } catch (e) {
      if (e?.response?.status !== 401) console.warn('heartbeat err', e);
    }
  }, []);

  const usersTimerRef = useRef(null);
  const lastOfferRef = useRef({ key: null, ts: 0 });
  
  useEffect(() => {
  // -- offer listeners start --
  try {
    if (typeof window !== 'undefined') {
    }
    if (typeof websocketService !== 'undefined' && websocketService?.on) {
      try { websocketService.off('lobby_offer_update', onOffer); } catch {}
      websocketService.on('lobby_offer_update', onOffer);
    }
  } catch {}
  // -- offer listeners end --

    fetchUsers();
    if (!usersTimerRef.current) usersTimerRef.current = setInterval(fetchUsers, USERS_POLL_MS);
    return () => { if (usersTimerRef.current) { clearInterval(usersTimerRef.current); usersTimerRef.current = null; } };

  }, []);
  // WebSocket: 対局申請をUIに反映
  useEffect(() => {
    const onOffer = (payload) => {
      const p = payload && payload.detail ? payload.detail : payload;
      if (!p) return;
      // de-dup same offer-status bursts within 800ms (window + ws double wiring etc.)
      try {
        const key = [p.type, p.status, p.from_user_id || p.from, p.to_user_id || p.to].join(':');
        const now = Date.now();
        if (lastOfferRef.current && lastOfferRef.current.key === key && (now - lastOfferRef.current.ts) < 800) {
          return;
        }
        lastOfferRef.current = { key, ts: now };
      } catch {}

      // offer created → show incoming / also refresh presence so pending_offer is reflected
      if (p.type === 'offer_created') {
        try {
          const toId = idToStr(p.to_user_id || p.to);
          const meStr = idToStr(myId);
          if (toId === meStr) {
            try { playEnv?.('offer_received'); } catch {}
            setIncomingOffer({
              from_user_id: p.from_user_id || p.from,
              from_username: p.from_username || (p.from_user && p.from_user.username) || '',
              from_rating: p.from_rating ?? (p.from_user && p.from_user.rating),
              time_code: p.time_code,
              time_label: p.time_name || codeToName(p.time_code) || '',
              requested_game_type: p.requested_game_type || p.game_type,
            });
            // pull latest presence (server also writes pending_offer on receiver)
            if (typeof fetchUsers === 'function') { fetchUsers(); }
          }
        } catch (e) { /* ignore */ }
      }
      // any terminal status clears the overlay
      if (p.type === 'offer_status' || p.type === 'offer_accepted' || p.type === 'offer_declined') {
        if (p.type==='offer_status' && p.status==='accepted' && p.game_id && typeof onJoinGame==='function') { onJoinGame(p.game_id, false); }
        setIncomingOffer(null);
      }
    };
    websocketService.on('lobby_offer_update', onOffer);
    websocketService.on('offer_created', onOffer);
    websocketService.on('offer_accepted', onOffer);
    websocketService.on('offer_declined', onOffer);
    return () => {
      websocketService.off('lobby_offer_update', onOffer);
      websocketService.off('offer_created', onOffer);
      websocketService.off('offer_accepted', onOffer);
      websocketService.off('offer_declined', onOffer);
    };
  }, [myId]);
  // WebSocket: offer/online 更新イベントで即時に一覧を更新
  useEffect(() => {
    const refresh = () => { fetchUsers(); };
    websocketService.on('lobby_offer_update', refresh);
    websocketService.on('offer_created', refresh);
    websocketService.on('offer_accepted', refresh);
    websocketService.on('offer_declined', refresh);
    websocketService.on('online_users_update', refresh);
    return () => {
      websocketService.off('lobby_offer_update', refresh);
      websocketService.off('offer_created', refresh);
      websocketService.off('offer_accepted', refresh);
      websocketService.off('offer_declined', refresh);
      websocketService.off('online_users_update', refresh);
    };
  }, [fetchUsers]);

  // WebSocket: 対局申請をUIに反映
  useEffect(() => {
    const onOffer = (payload) => {
      const p = payload && payload.detail ? payload.detail : payload;
      if (!p) return;
      // de-dup same offer-status bursts within 800ms (window + ws double wiring etc.)
      try {
        const key = [p.type, p.status, p.from_user_id || p.from, p.to_user_id || p.to].join(':');
        const now = Date.now();
        if (lastOfferRef.current && lastOfferRef.current.key === key && (now - lastOfferRef.current.ts) < 800) {
          return;
        }
        lastOfferRef.current = { key, ts: now };
      } catch {}

      if (p.type === 'offer_created') {
        const toId = idToStr(p.to_user_id || p.to);
        if (toId === idToStr(myId)) {
          setIncomingOffer({
            from_user_id: p.from_user_id || p.from,
            from_username: (p.from_user && p.from_user.username) || p.from_username || '',
            from_rating: p.from_rating ?? (p.from_user && p.from_user.rating),
            time_code: p.time_code,
            time_label: p.time_name || codeToName(p.time_code) || '',
            requested_game_type: p.requested_game_type || p.game_type,
          });
        }
      }
      if (p.type === 'offer_status' || p.type === 'offer_accepted' || p.type === 'offer_declined') {
        setIncomingOffer(null);
      }
    };
    websocketService.on('lobby_offer_update', onOffer);
    websocketService.on('offer_created', onOffer);
    websocketService.on('offer_accepted', onOffer);
    websocketService.on('offer_declined', onOffer);
    return () => {
      websocketService.off('lobby_offer_update', onOffer);
      websocketService.off('offer_created', onOffer);
      websocketService.off('offer_accepted', onOffer);
      websocketService.off('offer_declined', onOffer);
    };
  }, [myId]);

useEffect(() => {
    if (activeTab !== null) return;
    const me = users.find(usr => idToStr(usr.user_id) === idToStr(myId));
    const myRating = (me?.rating ?? me?.rate ?? user?.rating ?? user?.rate);
    if (myRating !== undefined && myRating !== null) {
      setActiveTab(bandOfRating(Number(myRating)));
    }
  }, [users, myId, user, activeTab]);

  
  // 自分のプレゼンス（waiting）を把握する（UIガード用）
  const myUser = useMemo(() => users.find(usr => idToStr(usr.user_id) === idToStr(myId)) || null, [users, myId]);
  const myWaiting = useMemo(() => {
    const w = myUser?.waiting;
    return (typeof w === 'string') ? w : (w ? 'seeking' : '');
  }, [myUser]);

  const myRating = useMemo(() => {
    const r = (myUser?.rating ?? myUser?.rate ?? user?.rating ?? user?.rate);
    const n = Number(r);
    return Number.isFinite(n) ? n : null;
  }, [myUser, user]);

  const withinTargetRange = useCallback((target) => {
    try {
      if (!target) return true;
      if (myRating === null) return false;
      const wi = target.waiting_info || {};
      const min = (wi.rating_min ?? wi.ratingMin);
      const max = (wi.rating_max ?? wi.ratingMax);
      const rr = (wi.rating_range ?? wi.rate_span ?? wi.rateSpan);
      if (min !== undefined && min !== null && max !== undefined && max !== null) {
        const mn = Number(min);
        const mx = Number(max);
        if (Number.isFinite(mn) && Number.isFinite(mx)) {
          return myRating >= mn && myRating <= mx;
        }
      }
      const rrN = Number(rr);
      if (Number.isFinite(rrN)) {
        const base = Number(target.rating ?? target.rate ?? wi.rating);
        if (Number.isFinite(base)) {
          return myRating >= (base - rrN) && myRating <= (base + rrN);
        }
      }
      return true;
    } catch {
      return true;
    }
  }, [myRating]);

  // 挑戦制限：自分が相手より400以上高い（相手が下位）場合は、R対局では挑戦できない
  const violatesRatingGap = useCallback((target) => {
    try {
      if (!target) return false;
      const wi = target.waiting_info || {};
      const gt = (wi.game_type ?? wi.gameType ?? 'rating');
      if (gt !== 'rating') return false;
      if (myRating === null) return false;
      const oppR = Number(target.rating ?? target.rate ?? wi.rating);
      if (!Number.isFinite(oppR)) return false;
      return (myRating - oppR) >= 400;
    } catch {
      return false;
    }
  }, [myRating]);


const grouped = useMemo(() => {
    const map = Object.fromEntries(RATING_TAB_DEFS.map(tab => [tab.key, []]));
    for (const u of users) {
      const rating = u?.rating ?? u?.rate ?? 0;
      const key = bandOfRating(rating);
      (map[key] ??= []).push(u);
    }
    for (const k of Object.keys(map)) {
      map[k].sort((a,b) => (b.rating??0) - (a.rating??0));
    }
    return map;
  }, [users]);

  const me = useMemo(() => users.find(usr => idToStr(usr.user_id) === idToStr(myId)) , [users, myId]);
  const myStatus = (me?.waiting ?? 'lobby');
  const reviewResetRef = useRef(false);
  useEffect(()=>{
    try{
      if (reviewResetRef.current) return;
      if (myStatus === 'review') {
        // ユーザーが「対局を閉じる」ボタンを押したときだけ実行する
        let ok = false;
        try { ok = (window.localStorage.getItem('shogi_close_from_game') === '1'); } catch {}
        if (!ok) return;
        reviewResetRef.current = true;
        // 一度だけ使うフラグなので消す
        try { window.localStorage.removeItem('shogi_close_from_game'); } catch {}
        // サーバ側でロビーに戻す
        (async()=>{
          try{ await api.post('/lobby/waiting/stop'); await fetchUsers(); }catch(e){}
        })();
      }
    }catch{}
  }, [myStatus, fetchUsers]);

  const amWaiting = (myStatus === 'seeking') || (myStatus === 'pending');
  const iAmSeeking = (myStatus === 'seeking');

const [inviteOpen, setInviteOpen] = useState(false);
const [inviteUrl, setInviteUrl] = useState('');
const [inviteMsg, setInviteMsg] = useState('');
const [inviteBusy, setInviteBusy] = useState(false);
const inviteInputRef = useRef(null);

const createInviteUrl = useCallback(async () => {
  if (!iAmSeeking) return;
  setInviteOpen(true);
  setInviteBusy(true);
  setInviteMsg('');
  setInviteUrl('');
  try {
    const res = await api.post('/lobby/invite/create', {});
    const token = res?.data?.token;
    const path = res?.data?.path || (token ? `/?invite=${encodeURIComponent(token)}` : '');
    const abs = path
      ? `${window.location.origin}${path.startsWith('/') ? path : '/' + path}`
      : '';
    if (!abs) throw new Error('no_url');
    setInviteUrl(abs);

    // ここでは自動コピーしない（意図しない上書きを避ける）
    setInviteMsg(t("ui.components.lobby.lobbyview.k63a3bb9a"));
  } catch (e) {
    const data = e?.response?.data;
    const code = data?.error_code || data?.error || data?.code;
    const fb = data?.message || e?.message || '';
    setInviteMsg(inviteErrorMessage(code, fb) || t("ui.components.lobby.lobbyview.k3f401ed1"));
  } finally {
    setInviteBusy(false);
    // URLが取れたら選択しやすくする
    setTimeout(() => {
      try { inviteInputRef.current?.focus?.(); inviteInputRef.current?.select?.(); } catch {}
    }, 0);
  }
}, [iAmSeeking]);

const copyInviteUrl = useCallback(async () => {
  if (!inviteUrl) return;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    setInviteMsg(t("ui.components.lobby.lobbyview.k61a3aa44"));
    return;
  } catch {}
  // クリップボード権限が無い/拒否された場合の手動コピー補助
  try {
    inviteInputRef.current?.focus?.();
    inviteInputRef.current?.select?.();
    setInviteMsg(t("ui.components.lobby.lobbyview.kdb6e22e4"));
  } catch {
    setInviteMsg(t("ui.components.lobby.lobbyview.k326aea46"));
  }
}, [inviteUrl]);

useEffect(() => {
  if (!inviteOpen) return;
  const onKeyDown = (e) => {
    if (e.key === 'Escape') setInviteOpen(false);
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}, [inviteOpen]);




  async function startWaiting(payload) {
    if (isBanned) {
      setErr(t("ui.components.lobby.lobbyview.k6e90170c"));
      return;
    }
    setStarting(true);
    setErr('');

    // レーティング範囲設定を保存（成功/失敗に関係なく次回に反映）
    try {
      const raw = payload?.rateSpan;
      const hasSpan = (raw !== null && raw !== undefined && Number.isFinite(Number(raw)));
      const span = hasSpan ? Math.floor(Number(raw)) : (waitRatingCfg?.rateSpan ?? 300);
      const next = {
        useRange: !!hasSpan,
        rateSpan: WAIT_CFG_SPANS.includes(span) ? span : 300,
      };
      writeWaitCfg(waitCfgKey, next);
      setWaitRatingCfg(next);
    } catch {}

    try {
      const res = await api.post('/lobby/waiting/start', {
        game_type: payload.gameType,
        time_code: (name2code[payload.timeControl] ?? payload.timeControl),
        rating_range: payload.rateSpan ?? payload.ratingRange,
      });
      if (res.data?.success) {
        try { playEnv?.('waiting_start'); } catch {}
        setWaitOpen(false);
        await fetchUsers();
      } else {
        throw new Error('failed');
      }
    } catch (e) {
      console.error('start waiting failed', e);
      const data = e?.response?.data || {};
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || e?.message || '';
      if (e?.response?.status === 403 && (code === 'banned' || code === 'banned_user')) {
        setErr(t("ui.components.lobby.lobbyview.k6e90170c"));
      } else {
        setErr(lobbyJoinErrorMessage(code, data, fb, t("ui.components.lobby.lobbyview.k3503a83d")));
      }
      // waiting_start_failed_banned
    } finally {
      setStarting(false);
    }
  }

  async function stopWaiting() {
    setStopping(true);
    setErr('');
    try {
      const res = await api.post('/lobby/waiting/stop');
      if (res.data?.success) {
        await fetchUsers();
      } else {
        throw new Error('failed');
      }
    } catch (e) {
      console.error('stop waiting failed', e);
      const data = e?.response?.data || {};
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || e?.message || '';
      setErr(lobbyJoinErrorMessage(code, data, fb, t("ui.components.lobby.lobbyview.k17fd111b")));
    } finally {
      setStopping(false);
    }
  }

  async function requestMatch(target) {
    if (isBanned) {
      setErr(t("ui.components.lobby.lobbyview.k23ce31c8"));
      return;
    }
    // 自分がロビー外なら申請は出せない（UIガードの二重化）
    if (!(myWaiting === 'lobby' || myWaiting === '' || myWaiting === 'seeking')) {
      setErr(t("ui.components.lobby.lobbyview.k1de0d13f"));
      return;
    }
    if (!target) return;
    if (idToStr(target.user_id) === idToStr(myId)) return;
    // レート範囲外なら、申請モーダルを開かない（UIガード）
    if (!withinTargetRange(target)) {
      const wi = target?.waiting_info || {};
      const mn = wi.rating_min ?? wi.ratingMin;
      const mx = wi.rating_max ?? wi.ratingMax;
      if (mn !== undefined && mx !== undefined && mn !== null && mx !== null) {
        setErr(t("ui.components.lobby.lobbyview.kf3c4bf73", { mn, mx }));
      } else {
        setErr(t("ui.components.lobby.lobbyview.k2c6d270b"));
      }
      return;
    }
    // 挑戦制限：自分が相手より400以上高い（相手が下位）場合は申請できない（UIガード）
    if (violatesRatingGap(target)) {
      setErr(t("ui.components.lobby.lobbyview.kae18e4f6"));
      return;
    }

    try {
      // 申請モーダルを開く（POSTはOfferModalで実行）
      setOfferTarget(target);
    } catch (e) {
      console.error('join-by-user failed', e);
      setErr(t("ui.components.lobby.lobbyview.k592853f9"));
    }
  }
  const ratingTabs = getRatingTabs();
  const currentTab = (activeTab ?? RATING_TAB_DEFS[0].key);
  const tabUsers = (grouped[currentTab] ?? []);

  return (
    <div
      className={
        "lobby-root w-full mx-0 relative flex flex-col min-h-0 "
        + (compact ? "h-full lg:pr-0 lg:py-0" : "flex-1 lg:pr-40 lg:py-10")
      }
    >
      {!compact && (
      <>
      {/* PC: 右側の縦ボタン（更新/待ち開始・終了） */}
      <div className="hidden lg:flex flex-col gap-4 absolute top-10 right-3 z-20">
        <DoubleLineActionButton
          label={t("ui.components.lobby.lobbyview.kd9db02d0")}
          onClick={doRefresh}
          borderColor="#10b981"
          backgroundColor="#0a0a0f"
          hoverFillColor="#10b981"
          textColor="#ffffff"
          hoverTextColor="#0a0a0f"
        />
        <DoubleLineActionButton
          label={amWaiting ? t('ui.components.lobby.lobbyview.k1709be76') : t('ui.components.lobby.lobbyview.kb313f5db')}
          onClick={() => {
            if (amWaiting) return stopWaiting();
            if (isBanned) { setErr(t("ui.components.lobby.lobbyview.k6e90170c")); return; }
            setWaitOpen(true);
          }}
          disabled={isBanned || (amWaiting ? stopping : starting)}
          borderColor={amWaiting ? '#fb7185' : '#60a5fa'}
          backgroundColor="#0a0a0f"
          hoverFillColor={amWaiting ? '#fb7185' : '#60a5fa'}
          textColor="#ffffff"
          hoverTextColor="#0a0a0f"
        />
        {iAmSeeking && (
          <DoubleLineActionButton
            label={inviteBusy ? t('ui.components.lobby.lobbyview.k5c1a34ce') : t('ui.components.lobby.lobbyview.k5a7451f8')}
            onClick={createInviteUrl}
            disabled={inviteBusy}
            borderColor="#94a3b8"
            backgroundColor="#0a0a0f"
            hoverFillColor="#94a3b8"
            textColor="#ffffff"
            hoverTextColor="#0a0a0f"
          />
        )}
      </div>

      </>
      )}

      {/* スマホ: ボタンは右下フローティング（デザイン差し替え） */}

      {!compact && isBanned && <div className="mb-3 text-red-700 text-sm font-semibold">{t("ui.components.lobby.lobbyview.k38043e9c")}</div>}

      {!compact && err && <div className="mb-3 text-red-600 text-sm">{err}</div>}

      <div
        className="rounded-lg overflow-hidden shadow-2xl flex flex-col flex-1 min-h-0 backdrop-blur-[2px]"
        style={{
          background: 'linear-gradient(180deg, rgba(222,184,135,0.82) 0%, rgba(210,166,121,0.82) 100%)',
          boxShadow: '0 4px 20px rgba(139, 69, 19, 0.25), inset 0 1px 0 rgba(255,255,255,0.25)',
        }}
      >

        {/* 段位タブ（元デザインを移植） */}
        <div className="flex border-b-2 border-amber-700/20">
          {ratingTabs.map((tab) => {
            const isActive = currentTab === tab.key;

            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={
                  `relative flex-1 ${compact ? 'py-2 text-[12px]' : 'py-2.5 sm:py-3 text-[13px] sm:text-sm'} font-medium tracking-widest transition-all duration-300 `
                  + (isActive ? 'text-amber-900' : 'text-amber-700/60 hover:text-amber-800')
                }
                style={{ fontFamily: 'serif' }}
              >
                {isActive && <div className="absolute inset-0 bg-amber-100/50" />}
                <span className="relative z-10">{tab.label}</span>
                {isActive && (
                  <div
                    className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[8px] border-r-[8px] border-b-[8px] border-l-transparent border-r-transparent border-b-amber-900/80"
                    style={{ transform: 'translateX(-50%) rotate(180deg)', bottom: '-2px' }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className={"user-list flex-1 min-h-0 overflow-y-auto " + (compact ? "pb-0" : "pb-28 lg:pb-0")}>
          {loading ? (
            <div className="px-4 py-8 text-center text-amber-800/70" style={{ fontFamily: 'serif' }}>
              {t("ui.components.lobby.lobbyview.kd1c13ac5")}
            </div>
          ) : tabUsers.length === 0 ? (
            <div className="px-4 py-8 text-center text-amber-800/70" style={{ fontFamily: 'serif' }}>
              {t("ui.components.lobby.lobbyview.k6d997525")}
            </div>
          ) : (
            tabUsers.map((usr, index) => {
              const myStr = idToStr(myId);
              const uidStr = idToStr(usr.user_id);
              const isMe = uidStr === myStr;

              const statusText = (usr.waiting === 'seeking')
                ? t('ui.components.lobby.lobbyview.k55e95614')
                : (usr.waiting === 'pending'
                  ? t('ui.components.lobby.lobbyview.k94e87a7d')
                  : (usr.waiting === 'applying'
                    ? t('ui.components.lobby.lobbyview.k485c0c63')
                    : (usr.waiting === 'playing'
                      ? t('ui.components.lobby.lobbyview.kc0a194e7')
                      : (usr.waiting === 'review' ? t('ui.components.lobby.lobbyview.k64aae95e') : t('ui.components.lobby.lobbyview.k69078300')))));


              if (compact) {
                const name = (usr.username || usr.name || '—');
                const rRaw = (usr.rating ?? usr.rate ?? usr.rating_value);
                const rNum = Number(rRaw);
                const rText = Number.isFinite(rNum) ? `R ${Math.round(rNum)}` : '';
                const waiting = usr.waiting;

                const dotClsCompact = (waiting === 'seeking')
                  ? 'bg-emerald-400 border-emerald-600'
                  : (waiting === 'review')
                    ? 'bg-amber-400 border-amber-600'
                    : (waiting === 'playing')
                      ? 'bg-sky-400 border-sky-600'
                      : (waiting === 'pending' || waiting === 'applying')
                        ? 'bg-rose-400 border-rose-600'
                        : 'bg-stone-300 border-stone-400';

                const badgeClsCompact = (waiting === 'seeking')
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : (waiting === 'review')
                    ? 'bg-amber-100 text-amber-800 border border-amber-300'
                    : (waiting === 'playing')
                      ? 'bg-sky-100 text-sky-800 border border-sky-300'
                      : (waiting === 'pending' || waiting === 'applying')
                        ? 'bg-rose-100 text-rose-800 border border-rose-300'
                        : 'bg-stone-100 text-stone-600 border border-stone-300';

                return (
                  <div
                    key={uidStr + ':' + index}
                    className={
                      "px-3 py-2 flex items-center gap-2 border-b border-amber-700/10 "
                      + (isMe ? "bg-amber-100/40" : "")
                    }
                    style={{ fontFamily: 'serif' }}
                  >
                    <span className={"w-2.5 h-2.5 rounded-full border " + dotClsCompact} />
                    <span className="flex-1 min-w-0 flex items-center gap-1">
                      <span className="min-w-0 flex items-center gap-1">
                        <LegionFlagIcon code={usr.legion} size={14} className="flex-shrink-0" />
                        <span className="min-w-0 truncate text-[13px] text-amber-950">
                          {name}
                        </span>
                      </span>
                      {rText && (
                        <span className="shrink-0 text-[12px] text-amber-900/70 tabular-nums">
                          {rText}
                        </span>
                      )}
                    </span>
                    <span className={"shrink-0 ml-1 px-2 py-0.5 rounded text-[10px] leading-none " + badgeClsCompact}>
                      {statusText}
                    </span>
                  </div>
                );
              }



              const timeText = (usr.waiting === 'seeking')
                ? (usr.waiting_info?.time_name
                  ?? codeToName(usr.waiting_info?.time_code)
                  ?? (usr.waiting_info?.time_control ? t('ui.components.lobby.lobbyview.k5c442341', { minutes: usr.waiting_info.time_control }) : '-'))
                : '-';

              const requestableBase = (usr.waiting === 'seeking')
                && !isMe
                && !isBanned
                && (myWaiting === 'lobby' || myWaiting === '' || myWaiting === 'seeking');
              const inRange = withinTargetRange(usr);
              const gapTooLarge = violatesRatingGap(usr);
              const canRequest = requestableBase && inRange && !gapTooLarge;

              const dotCls = (usr.waiting === 'seeking')
                ? 'bg-emerald-400 border-emerald-600'
                : (usr.waiting === 'review')
                  ? 'bg-amber-400 border-amber-600'
                  : (usr.waiting === 'playing')
                    ? 'bg-sky-400 border-sky-600'
                    : (usr.waiting === 'pending' || usr.waiting === 'applying')
                      ? 'bg-rose-400 border-rose-600'
                      : 'bg-stone-300 border-stone-400';

              const badgeCls = (usr.waiting === 'seeking')
                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                : (usr.waiting === 'review')
                  ? 'bg-amber-100 text-amber-800 border border-amber-300'
                  : (usr.waiting === 'playing')
                    ? 'bg-sky-100 text-sky-800 border border-sky-300'
                    : (usr.waiting === 'pending' || usr.waiting === 'applying')
                      ? 'bg-rose-100 text-rose-800 border border-rose-300'
                      : 'bg-stone-100 text-stone-600 border border-stone-300';


              const actionNode = isMe ? (
                <span className="text-[11px] text-amber-400" style={{ fontFamily: 'serif' }}>—</span>
              ) : canRequest ? (
                <button
                  className="px-3 py-1.5 text-[11px] font-medium bg-amber-800 text-amber-100 rounded hover:bg-amber-900 active:scale-95 transition-all shadow-md"
                  style={{ fontFamily: 'serif' }}
                  onClick={() => requestMatch(usr)}
                  disabled={usr.waiting !== 'seeking' || idToStr(usr.user_id) === idToStr(myId) || !(myWaiting === 'lobby' || myWaiting === '' || myWaiting === 'seeking')}
                >
                  {t("ui.components.lobby.lobbyview.k221056a0")}
                </button>
              ) : (requestableBase && !inRange) ? (
                <span className="text-[11px] px-2 py-1 rounded bg-stone-100 text-stone-500 border border-stone-300" style={{ fontFamily: 'serif' }}>
                  {t("ui.components.lobby.lobbyview.k8387056b")}
                </span>
              ) : (requestableBase && inRange && gapTooLarge) ? (
                <span
                  className="text-[11px] px-2 py-1 rounded bg-stone-100 text-stone-500 border border-stone-300"
                  style={{ fontFamily: 'serif' }}
                  title={t("ui.components.lobby.lobbyview.kae18e4f6")}
                >
                  {t("ui.components.lobby.lobbyview.kb391a00c")}
                </span>
              ) : ((usr.waiting === 'playing' || usr.waiting === 'review') && (myWaiting === 'lobby' || myWaiting === '')) ? (
                <button
                  className="px-3 py-1.5 text-[11px] font-medium bg-sky-700 text-white rounded hover:bg-sky-800 active:scale-95 transition-all shadow-md"
                  style={{ fontFamily: 'serif' }}
                  onClick={() => handleSpectate(idToStr(usr.user_id))}
                >
                  {t("ui.components.lobby.lobbyview.k0f375d73")}
                </button>
              ) : (
                <span className="text-[11px] text-amber-400" style={{ fontFamily: 'serif' }}>—</span>
              );

              return (
                <div
                  key={uidStr || `${index}`}
                  onMouseEnter={() => setHoveredUserId(uidStr)}
                  onMouseLeave={() => setHoveredUserId(null)}
                  className={
                    `relative group px-3 py-3 sm:px-4 transition-all duration-200 flex flex-col gap-2 sm:gap-3 sm:grid sm:items-center sm:grid-cols-[minmax(0,1fr)_96px_80px_50px_86px] `
                    + `border-b border-amber-700/10 `
                    + `${hoveredUserId === uidStr ? 'bg-amber-100/30' : ''} `
                    + `${isMe ? 'bg-amber-200/20' : ''}`
                  }
                  style={{
                    animation: `slideIn 0.25s ease ${index * 0.02}s both`,
                  }}
                >
                  {/* プレイヤー名 */}
                  <div className="flex items-center gap-2 relative z-10 min-w-0">
                    <div className="relative flex-shrink-0">
                      <div className={`w-2.5 h-2.5 rounded-full border-2 ${dotCls}`} />
                    </div>
                    <LegionFlagIcon code={usr.legion} size={16} className="flex-shrink-0" />
                    <UserStatsOverlay userId={uidStr} align="start">
                      <button
                        type="button"
                        className={`text-sm truncate text-left bg-transparent border-0 p-0 m-0 hover:underline underline-offset-2 focus:outline-none ${isMe ? 'text-amber-900 font-bold' : 'text-amber-800'}`}
                        style={{ fontFamily: 'serif' }}
                      >
                        {usr.username ?? usr.name ?? '(no name)'}
                      </button>
                    </UserStatsOverlay>
                    {isMe && (
                      <span className="text-[9px] px-1.5 py-0.5 bg-amber-800 text-amber-100 rounded-sm flex-shrink-0">
                        {t("ui.components.lobby.lobbyview.k55e9a3f9")}
                      </span>
                    )}
                  </div>


                  {/* モバイル詳細行（ユーザー名枠を広く見せる） */}
                  <div className="sm:hidden flex items-center gap-2 justify-between relative z-10">
                    <div className="w-24 text-right flex-shrink-0">
                      <span className="text-sm text-amber-700 tabular-nums" style={{ fontFamily: 'serif' }}>
                        {(() => {
                          const r = Number(usr.rating ?? usr.rate);
                          if (!Number.isFinite(r)) return '—';
                          const rank = ratingToRank24(r);
                          return (
                            <>
                              {usr.rating ?? usr.rate}
                              {rank ? <span className="text-[11px] text-amber-700/80 ml-1">（{rank}）</span> : null}
                            </>
                          );
                        })()}
                      </span>
                    </div>

                    <div className="flex-1 min-w-0 flex items-center justify-center">
                      <span
                        className={`text-[11px] px-2 py-1 rounded inline-block text-center ${badgeCls} truncate`}
                        style={{ fontFamily: 'serif' }}
                        title={statusText}
                      >
                        {statusText}
                      </span>
                    </div>

                    <div className="w-14 text-center flex-shrink-0">
                      <span
                        className="text-sm text-amber-700/80 truncate block"
                        style={{ fontFamily: 'serif' }}
                        title={timeText}
                      >
                        {timeText}
                      </span>
                    </div>

                    <div className="flex-shrink-0">
                      {!compact && actionNode}
                    </div>
                  </div>

                  {/* レート */}
                  <div className="hidden sm:block text-right relative z-10">
                    <span className="text-sm text-amber-700" style={{ fontFamily: 'serif' }}>
                      {(() => {
                        const r = Number(usr.rating ?? usr.rate);
                        if (!Number.isFinite(r)) return '—';
                        const rank = ratingToRank24(r);
                        return (
                          <>
                            {usr.rating ?? usr.rate}
                            {rank ? <span className="text-[11px] text-amber-700/80 ml-1">（{rank}）</span> : null}
                          </>
                        );
                      })()}
                    </span>
                  </div>

                  {/* ステータス */}
                  <div className="hidden sm:block text-center relative z-10">
                    <span
                      className={`text-[11px] px-2 py-1 rounded inline-block w-20 text-center ${badgeCls}`}
                      style={{ fontFamily: 'serif' }}
                    >
                      {statusText}
                    </span>
                  </div>

                  {/* 時間 */}
                  <div className="hidden sm:block text-center relative z-10 min-w-0">
                    <span
                      className="text-sm text-amber-700/80 truncate block"
                      style={{ fontFamily: 'serif' }}
                      title={timeText}
                    >
                      {timeText}
                    </span>
                  </div>

                  {/* アクション */}
                  <div className="hidden sm:block text-right relative z-10">
                    {!compact && actionNode}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {!compact && (
      <>
      {/* スマホ: 更新/待機ボタン（ユーザー一覧と被らないよう下に余白を確保） */}
      <div className="lg:hidden absolute right-3 bottom-3 z-20 flex gap-2">
        <button
          onClick={doRefresh}
          className="w-12 h-12 rounded-lg bg-amber-100 border-2 border-amber-300 text-amber-700 hover:bg-amber-200 transition-all duration-300 flex items-center justify-center shadow-lg active:scale-95"
          aria-label={t("ui.components.lobby.lobbyview.kd9db02d0")}
          title={t("ui.components.lobby.lobbyview.kd9db02d0")}
        >
          <RefreshCcw className="w-5 h-5" />
        </button>

        <button
          onClick={() => {
            if (amWaiting) return stopWaiting();
            if (isBanned) { setErr(t("ui.components.lobby.lobbyview.k6e90170c")); return; }
            setWaitOpen(true);
          }}
          disabled={isBanned || (amWaiting ? stopping : starting)}
          className={
            'px-5 h-12 rounded-lg border-2 text-sm font-medium tracking-widest flex items-center gap-2 active:scale-95 transition-all duration-300 shadow-lg '
            + (amWaiting
              ? 'bg-rose-600 border-rose-700 text-white hover:bg-rose-700'
              : 'bg-amber-800 border-amber-900 text-amber-100 hover:bg-amber-900')
          }
          style={{ fontFamily: 'serif' }}
          aria-label={amWaiting ? t('ui.components.lobby.lobbyview.k1709be76') : t('ui.components.lobby.lobbyview.kb313f5db')}
        >
          <span>{amWaiting ? t('ui.components.lobby.lobbyview.k1709be76') : t('ui.components.lobby.lobbyview.kb313f5db')}</span>
        </button>

{iAmSeeking && (
  <button
    onClick={createInviteUrl}
    disabled={inviteBusy}
    className={
      'px-4 h-12 rounded-lg border-2 text-sm font-medium tracking-wide flex items-center justify-center gap-2 active:scale-95 transition-all duration-300 shadow-lg ' +
      (inviteBusy ? 'bg-gray-300 border-gray-400 text-gray-700' : 'bg-slate-800 border-slate-900 text-slate-100 hover:bg-slate-900')
    }
    style={{ fontFamily: 'serif' }}
    aria-label={t("ui.components.lobby.lobbyview.k5a7451f8")}
  >
    <span>{t("ui.components.lobby.lobbyview.k5a7451f8")}</span>
  </button>
)}


      </div>

      </>
      )}

      


<style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(-10px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
      {!compact && (
      <>
      
      {/* 申請受信中のオーバーレイ（ブロッキング） */}
      {(() => {
        if (typeof window !== 'undefined' && window.__INCOMING_OFFER_LAYER_ENABLED__) { return null; }
        return null; // replaced by IncomingOfferLayer
      })()}
      {/* 申請モーダル */}
      <OfferModal
                open={!!offerTarget}
                submitting={offerSubmitting}
                options={timeControls}
                defaultCode={( () => {
                  const info = offerTarget?.waiting_info;
                  if (!info) return timeControls?.[0]?.code;
                  const byName = info.time_name ? name2code[info.time_name] : undefined; return info.time_code ?? byName ?? timeControls?.[0]?.code;
                })()}
                ratingNote={(offerTarget?.user_kind === "guest" || offerTarget?.is_guest) ? t("ui.components.lobby.lobbyview.k47bff6be") : ""}
                onClose={() => {
                  if (offerSubmitting) return;
                  setOfferTarget(null);
                }}
                onSubmit={async (code)=>{
                  setErr('');
                  setOfferSubmitting(true);
                  if (isBanned) {
                    setOfferTarget(null);
                    setApplyFailMsg(t("ui.components.lobby.lobbyview.k23ce31c8"));
                    setApplyFailOpen(true);
                    setOfferSubmitting(false);
                    return;
                  }
                  try {
                    const res = await api.post('/lobby/join-by-user', {
                      opponent_user_id: idToStr(offerTarget?._id || offerTarget?.user_id),
                      time_code: code,
                    });
                    if (!res || (res.status && res.status >= 400)) {
                      throw new Error('join_failed');
                    }
                    setOfferTarget(null);
                    await fetchUsers();
                  } catch (e) {
                    console.error('join-by-user failed', e);
                    const data = e?.response?.data || {};
                    const code = data?.error_code || data?.error || data?.code;
                    const fb = data?.message || e?.message || '';
                    const msg = lobbyJoinErrorMessage(code, data, fb, t("ui.components.lobby.lobbyview.k592853f9"));

                    // 「申請モーダル」を閉じて、エラー用ポップアップに切り替える
                    setOfferTarget(null);
                    setApplyFailMsg(msg);
                    setApplyFailOpen(true);
                  } finally {
                    setOfferSubmitting(false);
                  }
                }}
              />

      {/* 申請失敗ポップアップ */}
      <AlertModal
        open={applyFailOpen}
        title={t("ui.components.lobby.lobbyview.kf83ec1e2")}
        message={applyFailMsg || t("ui.components.lobby.lobbyview.k592853f9")}
        onClose={() => setApplyFailOpen(false)}
      />


      {/* 招待URL モーダル（レイアウトを崩さない） */}
      {inviteOpen && (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-black/30 backdrop-blur-[2px] px-4"
          onMouseDown={(e) => {
            // 背景クリックで閉じる
            if (e.target === e.currentTarget) setInviteOpen(false);
          }}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-[min(32rem,calc(100vw-2rem))] p-4"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-base font-semibold">{t("ui.components.lobby.lobbyview.k5a7451f8")}</div>
                <div className="text-sm text-muted-foreground">
                  {t("ui.components.lobby.lobbyview.kb7aab564")}
                </div>
              </div>
              <Button variant="outline" onClick={() => setInviteOpen(false)}>{t("ui.components.lobby.lobbyview.k3da5c185")}</Button>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  ref={inviteInputRef}
                  className="flex-1 rounded-md border px-3 py-2 text-sm"
                  value={inviteUrl}
                  readOnly
                  placeholder={inviteBusy ? t('ui.components.lobby.lobbyview.k3a98deb0') : t('ui.components.lobby.lobbyview.k69fa5d81')}
                  onFocus={(e) => e.target.select()}
                />
                <Button variant="secondary" onClick={copyInviteUrl} disabled={!inviteUrl}>
                  {t("ui.components.lobby.lobbyview.ke94c2107")}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Button
                  onClick={createInviteUrl}
                  disabled={inviteBusy || !iAmSeeking}
                  title={!iAmSeeking ? t('ui.components.lobby.lobbyview.kdc53ffa0') : ''}
                >
                  {inviteBusy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t("ui.components.lobby.lobbyview.kb211c88d")}
                    </>
                  ) : (
                    t('ui.components.lobby.lobbyview.k03bc936f')
                  )}
                </Button>
                <div className="text-xs text-muted-foreground">{t("ui.components.lobby.lobbyview.kde1bc270")}</div>
              </div>

              {inviteMsg && (
                <div className="text-sm text-muted-foreground">
                  {inviteMsg}
                </div>
              )}
            </div>
          </div>
        </div>
      )}


<WaitConfigModal
        open={waitOpen}
        onClose={() => setWaitOpen(false)}
        onSubmit={startWaiting}
        initial={waitRatingCfg}
        options={timeControls}
      />

      </>
      )}
    </div>
  );
}