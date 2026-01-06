import { RefreshCcw, LogOut, Clock, Play, Square, Loader2, UserRound } from 'lucide-react';
import api from '@/services/apiClient';
import websocketService from '@/services/websocketService';
import { useAuth } from '@/contexts/AuthContext';
import useSound from '@/hooks/useSound';
import WaitConfigModal from './WaitConfigModal';
import { RATING_TABS, bandOfRating } from '@/services/ratingBands';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import DoubleLineActionButton from '@/components/ui/double-line-action-button';


const statusLabelOf = (w) => {
  if (w === 'applying') return '申請者';
  if (w === 'pending') return '申請待機中';
  if (w === 'seeking') return '待機中';
  if (w === 'playing') return '対局中';
  if (w === 'review') return '感想戦';
  return 'ロビー';
};

// src/components/lobby/LobbyView.jsx

function OfferModal({ open, onClose, onSubmit, defaultCode, options = [] }) {
  const [code, setCode] = useState(defaultCode || (options[0]?.code ?? ''));
  useEffect(() => { if (open) setCode(defaultCode || (options[0]?.code ?? '')); }, [open, defaultCode, options]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] card-like shogi-merge">
      <div className="bg-white rounded-xl p-4 w-[340px]">
        <div className="text-lg font-semibold mb-2">対局申請</div>
        <div className="text-sm mb-1">持ち時間</div>
        <div className="flex flex-wrap gap-2 mb-4">
          {options.map(opt => (
            <button key={opt.code}
              className={"px-3 py-1 rounded border " + (code===opt.code ? "bg-gray-200":"bg-white")}
              onClick={()=> setCode(opt.code)}
            >{opt.name}</button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 border rounded" onClick={onClose}>やめる</button>
          <button className="px-3 py-1 border rounded bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={()=> onSubmit?.(code)} disabled={!code}>申請する</button>
        </div>
      </div>
    </div>
  );
}


const USERS_POLL_MS = 45000;
export default function LobbyView({ onJoinGame }) {
  const { playEnv } = useSound();
  // ---- time controls (from backend) ----
  const [timeControls, setTimeControls] = useState([]);

    const [code2name, setCode2name] = useState({});



  // 強制スクロール: ホイール/タッチを user-list に確実に流す
  const [name2code, setName2code] = useState({});
  useEffect(() => {
    (async () => {
      const r = await fetch('/api/lobby/time-controls', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      const arr = Array.isArray(j?.controls) ? j.controls : [];
      setTimeControls(arr);
      setCode2name(Object.fromEntries(arr.map(x => [x.code, x.name])));
      setName2code(Object.fromEntries(arr.map(x => [x.name, x.code])));
    })();
  }, []);
  const codeToName = (code) => code2name[code] || '';
  // --------------------------------------
const { user, logout } = useAuth();
  const [users, setUsers] = useState([]);
    const [offerTarget, setOfferTarget] = useState(null);
  const [incomingOffer, setIncomingOffer] = useState(null);

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
        setErr('データ取得に失敗しました');
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

const grouped = useMemo(() => {
    const map = Object.fromEntries(RATING_TABS.map(t => [t.key, []]));
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

  async function startWaiting(payload) {
    setStarting(true);
    setErr('');
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
      setErr('待機の開始に失敗しました');
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
      setErr('待機の解除に失敗しました');
    } finally {
      setStopping(false);
    }
  }

  async function requestMatch(target) {
    // 自分がロビー外なら申請は出せない（UIガードの二重化）
    if (!(myWaiting === 'lobby' || myWaiting === '')) {
      setErr('ロビー以外のステータスでは申請できません');
      return;
    }
    if (!target) return;
    if (idToStr(target.user_id) === idToStr(myId)) return;
    try {
      // 申請モーダルを開く（POSTはOfferModalで実行）
      setOfferTarget(target);
    } catch (e) {
      console.error('join-by-user failed', e);
      setErr('申し込みに失敗しました');
    }
  }
  const currentTab = (activeTab ?? RATING_TABS[0].key);
  const tabUsers = (grouped[currentTab] ?? []);

  return (
    <div className="lobby-root w-full flex-1 min-h-0 mx-0 relative md:pr-40 flex flex-col md:py-10">
      {/* PC: 右側の縦ボタン（更新/待ち開始・終了） */}
      <div className="hidden md:flex flex-col gap-4 absolute top-10 right-3 z-20">
        <DoubleLineActionButton
          label="更新"
          onClick={doRefresh}
          borderColor="#10b981"
          backgroundColor="#0a0a0f"
          hoverFillColor="#10b981"
          textColor="#ffffff"
          hoverTextColor="#0a0a0f"
        />
        <DoubleLineActionButton
          label={amWaiting ? '待ち終了' : '待ち開始'}
          onClick={() => {
            if (amWaiting) return stopWaiting();
            setWaitOpen(true);
          }}
          disabled={amWaiting ? stopping : starting}
          borderColor={amWaiting ? '#fb7185' : '#60a5fa'}
          backgroundColor="#0a0a0f"
          hoverFillColor={amWaiting ? '#fb7185' : '#60a5fa'}
          textColor="#ffffff"
          hoverTextColor="#0a0a0f"
        />
      </div>

      {/* スマホ: ボタンは右下フローティング（デザイン差し替え） */}

      {err && <div className="mb-3 text-red-600 text-sm">{err}</div>}

      <div
        className="rounded-lg overflow-hidden shadow-2xl flex flex-col flex-1 min-h-0 backdrop-blur-[2px]"
        style={{
          background: 'linear-gradient(180deg, rgba(222,184,135,0.82) 0%, rgba(210,166,121,0.82) 100%)',
          boxShadow: '0 4px 20px rgba(139, 69, 19, 0.25), inset 0 1px 0 rgba(255,255,255,0.25)',
        }}
      >

        {/* 段位タブ（元デザインを移植） */}
        <div className="flex border-b-2 border-amber-700/20">
          {RATING_TABS.map((t) => {
            const isActive = currentTab === t.key;

            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={
                  `relative flex-1 py-2.5 sm:py-3 text-[13px] sm:text-sm font-medium tracking-widest transition-all duration-300 `
                  + (isActive ? 'text-amber-900' : 'text-amber-700/60 hover:text-amber-800')
                }
                style={{ fontFamily: 'serif' }}
              >
                {isActive && <div className="absolute inset-0 bg-amber-100/50" />}
                <span className="relative z-10">{t.label}</span>
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

        <div className="user-list flex-1 min-h-0 overflow-y-auto pb-28 md:pb-0">
          {loading ? (
            <div className="px-4 py-8 text-center text-amber-800/70" style={{ fontFamily: 'serif' }}>
              読み込み中…
            </div>
          ) : tabUsers.length === 0 ? (
            <div className="px-4 py-8 text-center text-amber-800/70" style={{ fontFamily: 'serif' }}>
              この帯域にオンラインがいないよ
            </div>
          ) : (
            tabUsers.map((usr, index) => {
              const myStr = idToStr(myId);
              const uidStr = idToStr(usr.user_id);
              const isMe = uidStr === myStr;

              const statusText = (usr.waiting === 'seeking')
                ? '待機中'
                : (usr.waiting === 'pending'
                  ? '申請受諾待ち'
                  : (usr.waiting === 'playing'
                    ? '対局中'
                    : (usr.waiting === 'review' ? '感想戦' : 'オンライン')));

              const timeText = (usr.waiting === 'seeking')
                ? (usr.waiting_info?.time_name
                  ?? codeToName(usr.waiting_info?.time_code)
                  ?? (usr.waiting_info?.time_control ? `${usr.waiting_info.time_control}分` : '-'))
                : '-';

              const canRequest = (usr.waiting === 'seeking')
                && !isMe
                && (myWaiting === 'lobby' || myWaiting === '');

              const dotCls = (usr.waiting === 'seeking')
                ? 'bg-emerald-400 border-emerald-600'
                : (usr.waiting === 'review')
                  ? 'bg-amber-400 border-amber-600'
                  : (usr.waiting === 'playing')
                    ? 'bg-sky-400 border-sky-600'
                    : (usr.waiting === 'pending')
                      ? 'bg-rose-400 border-rose-600'
                      : 'bg-stone-300 border-stone-400';

              const badgeCls = (usr.waiting === 'seeking')
                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                : (usr.waiting === 'review')
                  ? 'bg-amber-100 text-amber-800 border border-amber-300'
                  : (usr.waiting === 'playing')
                    ? 'bg-sky-100 text-sky-800 border border-sky-300'
                    : (usr.waiting === 'pending')
                      ? 'bg-rose-100 text-rose-800 border border-rose-300'
                      : 'bg-stone-100 text-stone-600 border border-stone-300';


              const actionNode = isMe ? (
                <span className="text-[11px] text-amber-400" style={{ fontFamily: 'serif' }}>—</span>
              ) : canRequest ? (
                <button
                  className="px-3 py-1.5 text-[11px] font-medium bg-amber-800 text-amber-100 rounded hover:bg-amber-900 active:scale-95 transition-all shadow-md"
                  style={{ fontFamily: 'serif' }}
                  onClick={() => requestMatch(usr)}
                  disabled={usr.waiting !== 'seeking' || idToStr(usr.user_id) === idToStr(myId) || !(myWaiting === 'lobby' || myWaiting === '')}
                >
                  申込む
                </button>
              ) : ((usr.waiting === 'playing' || usr.waiting === 'review') && (myWaiting === 'lobby' || myWaiting === '')) ? (
                <button
                  className="px-3 py-1.5 text-[11px] font-medium bg-sky-700 text-white rounded hover:bg-sky-800 active:scale-95 transition-all shadow-md"
                  style={{ fontFamily: 'serif' }}
                  onClick={() => handleSpectate(idToStr(usr.user_id))}
                >
                  観戦
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
                    `relative group px-3 py-3 sm:px-4 transition-all duration-200 flex flex-col gap-2 sm:gap-3 sm:grid sm:items-center sm:grid-cols-[minmax(0,1fr)_60px_80px_50px_86px] `
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
                    <span
                      className={`text-sm truncate ${isMe ? 'text-amber-900 font-bold' : 'text-amber-800'}`}
                      style={{ fontFamily: 'serif' }}
                      title={usr.username ?? usr.name ?? '(no name)'}
                    >
                      {usr.username ?? usr.name ?? '(no name)'}
                    </span>
                    {isMe && (
                      <span className="text-[9px] px-1.5 py-0.5 bg-amber-800 text-amber-100 rounded-sm flex-shrink-0">
                        自分
                      </span>
                    )}
                  </div>


                  {/* モバイル詳細行（ユーザー名枠を広く見せる） */}
                  <div className="sm:hidden flex items-center gap-2 justify-between relative z-10">
                    <div className="w-12 text-right flex-shrink-0">
                      <span className="text-sm text-amber-700 tabular-nums" style={{ fontFamily: 'serif' }}>
                        {Number.isFinite(Number(usr.rating ?? usr.rate)) ? (usr.rating ?? usr.rate) : '—'}
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
                      {actionNode}
                    </div>
                  </div>

                  {/* レート */}
                  <div className="hidden sm:block text-right relative z-10">
                    <span className="text-sm text-amber-700" style={{ fontFamily: 'serif' }}>
                      {Number.isFinite(Number(usr.rating ?? usr.rate)) ? (usr.rating ?? usr.rate) : '—'}
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
                    {actionNode}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* スマホ: 更新/待機ボタン（ユーザー一覧と被らないよう下に余白を確保） */}
      <div className="md:hidden absolute right-3 bottom-3 z-20 flex gap-2">
        <button
          onClick={doRefresh}
          className="w-12 h-12 rounded-lg bg-amber-100 border-2 border-amber-300 text-amber-700 hover:bg-amber-200 transition-all duration-300 flex items-center justify-center shadow-lg active:scale-95"
          aria-label="更新"
          title="更新"
        >
          <RefreshCcw className="w-5 h-5" />
        </button>

        <button
          onClick={() => {
            if (amWaiting) return stopWaiting();
            setWaitOpen(true);
          }}
          disabled={amWaiting ? stopping : starting}
          className={
            'px-5 h-12 rounded-lg border-2 text-sm font-medium tracking-widest flex items-center gap-2 active:scale-95 transition-all duration-300 shadow-lg '
            + (amWaiting
              ? 'bg-rose-600 border-rose-700 text-white hover:bg-rose-700'
              : 'bg-amber-800 border-amber-900 text-amber-100 hover:bg-amber-900')
          }
          style={{ fontFamily: 'serif' }}
          aria-label={amWaiting ? '待ち終了' : '待ち開始'}
        >
          <span>{amWaiting ? '待ち終了' : '待ち開始'}</span>
        </button>
      </div>

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(-10px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
      
      
      {/* 申請受信中のオーバーレイ（ブロッキング） */}
      {(() => {
        if (typeof window !== 'undefined' && window.__INCOMING_OFFER_LAYER_ENABLED__) { return null; }
        return null; // replaced by IncomingOfferLayer
      })()}
      {/* 申請モーダル */}
      <OfferModal
                open={!!offerTarget}
                options={timeControls}
                defaultCode={( () => {
                  const info = offerTarget?.waiting_info;
                  if (!info) return timeControls?.[0]?.code;
                  const byName = info.time_name ? name2code[info.time_name] : undefined; return info.time_code ?? byName ?? timeControls?.[0]?.code;
                })()}
                onClose={()=> setOfferTarget(null)}
                onSubmit={async (code)=>{
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
                    setErr('申し込みに失敗しました');
                  }
                }}
              />


      <WaitConfigModal
        open={waitOpen}
        onClose={() => setWaitOpen(false)}
        onSubmit={startWaiting}
        initial={{}}
        options={timeControls}
      />
    </div>
  );
}