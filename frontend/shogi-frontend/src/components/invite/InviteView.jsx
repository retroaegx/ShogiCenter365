import React, { useEffect, useMemo, useState } from 'react';
import { t } from '@/i18n';
import { inviteErrorMessage, lobbyJoinErrorMessage } from '@/i18n/lobbyErrors';
import { gameErrorMessage } from '@/i18n/gameErrors';
import api from '@/services/apiClient';
import { useAuth } from '@/contexts/AuthContext';
import OfferModal from '@/components/lobby/OfferModal';
import LoginForm from '@/components/auth/LoginForm';
import GuestLoginForm from '@/components/auth/GuestLoginForm';
import GoogleProfileSetupForm from '@/components/auth/GoogleProfileSetupForm';
import AuthTabbedContainer from '@/components/auth/AuthTabbedContainer';
import { Loader2 } from 'lucide-react';

const GAME_TYPE_BADGE_KEY = {
  rating: 'ui.components.lobby.lobbyview.gameTypeBadge.rating',
  free: 'ui.components.lobby.lobbyview.gameTypeBadge.free',
};

const HANDICAP_LABEL_KEY = {
  // 招待/ロビー/申込側では「平手」だけだと先後が読めないので詳細表記を使う
  even_lower_first: 'ui.components.lobby.waitconfigmodal.handicap.evenLowerFirstDetail',
  lance: 'ui.components.lobby.waitconfigmodal.handicap.lance',
  double_lance: 'ui.components.lobby.waitconfigmodal.handicap.doubleLance',
  bishop: 'ui.components.lobby.waitconfigmodal.handicap.bishop',
  rook: 'ui.components.lobby.waitconfigmodal.handicap.rook',
  rook_lance: 'ui.components.lobby.waitconfigmodal.handicap.rookLance',
  rook_double_lance: 'ui.components.lobby.waitconfigmodal.handicap.rookDoubleLance',
  two_piece: 'ui.components.lobby.waitconfigmodal.handicap.twoPiece',
  four_piece: 'ui.components.lobby.waitconfigmodal.handicap.fourPiece',
  six_piece: 'ui.components.lobby.waitconfigmodal.handicap.sixPiece',
  eight_piece: 'ui.components.lobby.waitconfigmodal.handicap.eightPiece',
  ten_piece: 'ui.components.lobby.waitconfigmodal.handicap.tenPiece',
};

function buildInviteConditionTags(waitingInfo) {
  const wi = waitingInfo || {};
  const gameType = String(wi.game_type ?? wi.gameType ?? 'rating').toLowerCase();
  const reserved = Boolean(wi.reserved);
  const he = Boolean(wi.handicap_enabled ?? wi.handicapEnabled);
  const ht = wi.handicap_type ?? wi.handicapType;

  const tags = [];
  tags.push(t(GAME_TYPE_BADGE_KEY[gameType] || GAME_TYPE_BADGE_KEY.rating));
  if (reserved) tags.push(t('ui.components.lobby.lobbyview.reservedBadge'));
  if (gameType === 'free' && he && ht) {
    const k = HANDICAP_LABEL_KEY[String(ht)] || '';
    if (k) tags.push(t(k));
  }
  return tags.filter(Boolean);
}

function idToStr(v) {
  try {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      if (typeof v.$oid === 'string') return v.$oid;
      if (typeof v.oid === 'string') return v.oid;
      if (typeof v._id === 'string') return v._id;
      if (v._id && typeof v._id.$oid === 'string') return v._id.$oid;
      if (typeof v.id === 'string') return v.id;
      if (typeof v.user_id === 'string') return v.user_id;
    }
    return String(v);
  } catch {
    return '';
  }
}

export default function InviteView({ token, onClose, onJoinGame }) {
  const { isAuthenticated, user } = useAuth();
  const isBanned = Boolean(user?.is_banned);

  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [timeControls, setTimeControls] = useState([]);
  const [offerOpen, setOfferOpen] = useState(false);

  // auth UI state (used only when !isAuthenticated)
  const [authTab, setAuthTab] = useState('login'); // login | guest | googleComplete
  const [googlePending, setGooglePending] = useState(null);

  const inviter = info?.inviter || null;
  const waiting = info?.waiting || '';
  const waitingInfo = info?.waiting_info || info?.waitingInfo || null;
  const inviterIsGuest = inviter?.user_kind === 'guest' || inviter?.is_guest;

  const conditionTags = useMemo(() => buildInviteConditionTags(waitingInfo), [waitingInfo]);
  const conditionText = useMemo(() => (conditionTags.length ? conditionTags.join('・') : ''), [conditionTags]);

  const myId = useMemo(() => idToStr(user?.id || user?.user_id || user?._id), [user]);

  const isSelf = useMemo(() => {
    const inv = idToStr(inviter?.user_id);
    return inv && myId && inv === myId;
  }, [inviter, myId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch('/api/lobby/time-controls');
        const data = await res.json();
        if (!mounted) return;
        const raw = data?.controls || data?.time_controls || data?.timeControls || [];
        const list = (raw || [])
          .map((t) => ({
            code: t.code || t.key || t.id,
            name: t.name || t.label || t.code,
          }))
          .filter((t) => t.code);
        setTimeControls(list);
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function loadInfo() {
    if (!token) return;
    setLoading(true);
    setErr('');
    try {
      const res = await api.get(`/lobby/invite/${encodeURIComponent(token)}`);
      setInfo(res.data || null);
    } catch (e) {
      const data = e?.response?.data;
      const msg = inviteErrorMessage(data?.error_code ?? data?.error ?? data?.code, data?.message || e?.message);
      setErr(String(msg || t('ui.components.invite.inviteview.ka4e28917')));
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInfo();
  }, [token, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      setAuthTab('login');
      setGooglePending(null);
    }
  }, [isAuthenticated]);

  async function doOffer(timeCode) {
    if (!inviter?.user_id) return;
    if (isBanned) {
      setErr(t('ui.components.invite.inviteview.k23ce31c8'));
      setOfferOpen(false);
      return;
    }
    setErr('');
    try {
      await api.post('/lobby/join-by-user', {
        opponent_user_id: idToStr(inviter.user_id),
        time_code: timeCode,
      });
      setOfferOpen(false);
      // 申請後はWSで accepted を待つ
    } catch (e) {
      const data = e?.response?.data || {};
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || e?.message || '';
      const msg = lobbyJoinErrorMessage(code, data, fb, t('ui.components.invite.inviteview.k592853f9'));
      setErr(String(msg || t('ui.components.invite.inviteview.k592853f9')));
    }
  }

  async function doSpectate() {
    if (!inviter?.user_id) return;
    setErr('');
    try {
      const res = await api.post('/game/spectate-by-user', {
        target_user_id: idToStr(inviter.user_id),
      });
      const gid = res?.data?.game_id;
      if (!gid) throw new Error('no_game');
      onJoinGame?.(gid, true);
      onClose?.();
    } catch (e) {
      const data = e?.response?.data;
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || e?.message || '';
      setErr(gameErrorMessage(code, fb, t('ui.components.invite.inviteview.k857d8f4f')));
    }
  }

  const waitingLabel = useMemo(() => {
    if (waiting === 'seeking') return t('ui.components.invite.inviteview.k55e95614');
    if (waiting === 'playing') return t('ui.components.invite.inviteview.kc0a194e7');
    if (waiting === 'review') return t('ui.components.invite.inviteview.k64aae95e');
    if (waiting === 'pending' || waiting === 'applying') return t('ui.components.invite.inviteview.k485c0c63');
    if (waiting === 'offline') return t('ui.components.invite.inviteview.kd32cd8eb');
    return waiting || t('ui.components.invite.inviteview.k479954f1');
  }, [waiting]);

  if (!token) return null;

  return (
    <div className="w-full flex-1 flex items-center justify-center p-4">
      <div className="w-full max-w-[560px] bg-white/95 rounded-2xl shadow-xl border p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">{t("ui.components.invite.inviteview.kc7950405")}</div>
            <div className="text-xs text-gray-600">{t("ui.components.invite.inviteview.kbc8532fe")}</div>
          </div>
          <button className="px-3 py-1 border rounded" onClick={onClose}>
            {t("ui.components.invite.inviteview.k60a1005b")}
          </button>
        </div>

        <div className="mt-4 border rounded-xl p-4 bg-white">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t("ui.components.invite.inviteview.kd1c13ac5")}
            </div>
          ) : err ? (
            <div className="text-sm text-red-600">{err}</div>
          ) : (
            <>
              <div className="text-sm text-gray-600">{t("ui.components.invite.inviteview.k23be7ed6")}</div>
              <div className="text-xl font-semibold">
                {inviter?.username || '—'}
                {typeof inviter?.rating === 'number' ? (
                  <span className="ml-2 text-sm text-gray-600">R{inviter.rating}</span>
                ) : null}
              </div>
              <div className="mt-1 text-sm text-gray-700">{t("ui.components.invite.inviteview.ka08d5721", { status: waitingLabel })}</div>

              {conditionTags.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {conditionTags.map((s, idx) => (
                    <span
                      key={`${idx}-${s}`}
                      className="inline-flex items-center px-2 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200 text-[11px] leading-none"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>

        {!loading && !err && !isAuthenticated && (
          <div className="mt-4">
            <div className="text-sm text-gray-700 mb-2">{t("ui.components.invite.inviteview.k9b9c24c7")}</div>

            <AuthTabbedContainer
              ariaLabel={t("ui.components.invite.inviteview.kd94f2b06")}
              className="mb-4"
              tabs={[
                { key: 'login', label: t('ui.components.invite.inviteview.k417181d1') },
                { key: 'guest', label: t('ui.components.invite.inviteview.k896be4bc') },
              ]}
              activeKey={authTab === 'googleComplete' ? 'login' : authTab}
              onChange={(k) => {
                setGooglePending(null);
                setAuthTab(k);
              }}
            >
              {authTab === 'googleComplete' ? (
                <GoogleProfileSetupForm
                  embedded
                  pending={googlePending}
                  onCancel={() => {
                    setGooglePending(null);
                    setAuthTab('login');
                  }}
                  onComplete={() => {
                    // 認証成功後は isAuthenticated で自動的に画面が切り替わる
                  }}
                />
              ) : authTab === 'guest' ? (
                <GuestLoginForm embedded onLoginSuccess={() => {}} />
              ) : (
                <LoginForm
                  embedded
                  onLoginSuccess={() => {}}
                  // 招待画面はミニマムでOK: ここでは新規登録へ誘導しない
                  onGoogleNeedsProfile={(data) => {
                    setGooglePending(data);
                    setAuthTab('googleComplete');
                  }}
                />
              )}
            </AuthTabbedContainer>
          </div>
        )}

        {!loading && !err && isAuthenticated && (
          <div className="mt-4 space-y-2">
            {isSelf ? (
              <div className="text-sm text-gray-700">{t("ui.components.invite.inviteview.k30c3d79c")}</div>
            ) : waiting === 'seeking' ? (
              <>
                <div className="text-sm text-gray-700">{t("ui.components.invite.inviteview.k07c77959", { username: inviter?.username || "—" })}</div>
                <button
                  className="w-full px-3 py-2 rounded-xl border bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isBanned}
                  onClick={() => { if (isBanned) { setErr(t('ui.components.invite.inviteview.k23ce31c8')); return; } setOfferOpen(true); }}
                >
                  {t("ui.components.invite.inviteview.ka0dbc716")}
                </button>
                <div className="text-xs text-gray-600">
                  {t("ui.components.invite.inviteview.k6e6ea015")}
                </div>
              </>
            ) : waiting === 'playing' || waiting === 'review' ? (
              <>
                <div className="text-sm text-gray-700">{t('ui.components.invite.inviteview.k31155ba8', { username: inviter?.username })}</div>
                <button
                  className="w-full px-3 py-2 rounded-xl border bg-sky-600 text-white hover:bg-sky-700"
                  onClick={doSpectate}
                >
                  {t("ui.components.invite.inviteview.k21957db4")}
                </button>
              </>
            ) : (
              <div className="text-sm text-gray-700">{t("ui.components.invite.inviteview.k9ef28274")}</div>
            )}
          </div>
        )}

        <OfferModal
          open={offerOpen}
          options={timeControls}
          defaultCode={timeControls?.[0]?.code}
          title={t("ui.components.invite.inviteview.kcedb6d49")}
          ratingNote={inviterIsGuest ? t('ui.components.invite.inviteview.k47bff6be') : ''}
          conditionText={conditionText}
          onClose={() => setOfferOpen(false)}
          onSubmit={doOffer}
        />

        {!loading && err && (
          <div className="mt-3 flex justify-end">
            <button className="px-3 py-1 border rounded" onClick={loadInfo}>
              {t("ui.components.invite.inviteview.k60c8aac0")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}