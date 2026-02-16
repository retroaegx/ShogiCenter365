// src/components/lobby/IncomingOfferLayer.jsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { t } from '@/i18n';
import { lobbyOfferErrorMessage } from '@/i18n/lobbyErrors';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { useSound } from '@/contexts/SoundContext';
import ws from '@/services/websocketService';
import api from '@/services/apiClient';

/**
 * 受信側の対局申請モーダル。
 * - 20秒カウントダウン
 * - 未操作で自動「拒否」
 * - 承諾/拒否 API 連携
 * - WSイベントでオープン/クローズ
 */
export default function IncomingOfferLayer() {
  const { user } = useAuth();
  const isBanned = Boolean(user?.is_banned);
  const { playEnv } = useSound();

  // ---- UI state ----
  const [open, setOpen] = useState(false);

  // 申請受信時の通知音
  useEffect(() => {
    if (open) {
      try { playEnv?.('offer_received'); } catch {}
    }
  }, [open, playEnv]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [countdown, setCountdown] = useState(0);

  // 表示情報
  const [fromName, setFromName] = useState('');
  const [fromRating, setFromRating] = useState(null);
  const [fromUserKind, setFromUserKind] = useState(null);
  const [gameType, setGameType] = useState('rating');
  const [timeLabel, setTimeLabel] = useState('');
  const [timeSeconds, setTimeSeconds] = useState(null);

  const timerRef = useRef(null);

  const reset = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
    setBusy(false);
    setErr('');
    setCountdown(0);
    setFromName('');
    setFromRating(null);
    setFromUserKind(null);
    setGameType('rating');
    setTimeLabel('');
    setTimeSeconds(null);
  }, []);

  // WSイベント購読
  useEffect(() => {
    const handler = (payload) => {
      try {
        const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});

        if (p.type === 'offer_created') {
          // 受信者向けに出す
          // to_user_id が自分ならオープン
          const me = user?.id || user?._id || user?.user_id;
          if (p.to_user_id && me && String(p.to_user_id) !== String(me)) return;

          setFromName(p.from_username || '');
          const ratingVal = (p.from_rating != null) ? Number(p.from_rating) : null;
          setFromRating(Number.isFinite(ratingVal) ? ratingVal : null);
          setFromUserKind(p.from_user_kind || (p.from_user && p.from_user.user_kind) || null);
          setGameType(p.requested_game_type || p.game_type || 'rating');
          const tl = p.time_name || p.time_label || '';
          setTimeLabel(tl);
          const sec = Number(p.time_limit_seconds ?? p.time_seconds ?? NaN);
          setTimeSeconds(Number.isFinite(sec) ? sec : null);

          setErr('');
          setOpen(true);
          setCountdown(20);
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = setInterval(() => {
            setCountdown((s) => (s > 0 ? s - 1 : 0));
          }, 1000);
          return;
        }

        // これらはモーダルを閉じる
        if (
          p.type === 'offer_cancelled' ||
          p.type === 'offer_declined' ||
          p.type === 'offer_accepted' ||
          (p.type === 'offer_status')
        ) {
          reset();
          return;
        }
      } catch (e) {
        // 解析失敗は無視
        try { console.error('incoming-offer parse error', e); } catch {}
      }
    };

    try { ws.off('lobby_offer_update', handler); } catch {}
    try { ws.on('lobby_offer_update', handler); } catch {}

    return () => {
      try { ws.off('lobby_offer_update', handler); } catch {}
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [reset, user]);

  // カウントが0になったら自動拒否
  useEffect(() => {
    if (open && countdown === 0 && !busy) {
      (async () => {
        try {
          setBusy(true);
          setErr('');
          await api.post('/lobby/offer/decline');
        } catch (e) {
          const data = e?.response?.data || {};
          const code = data?.error_code || data?.error || data?.code;
          const fb = data?.message || e?.message || '';
          setErr(lobbyOfferErrorMessage(code, data, fb, t('ui.components.lobby.incomingofferlayer.k63e51036')));
        } finally {
          setBusy(false);
          reset();
        }
      })();
    }
  }, [open, countdown, busy, reset]);

  const accept = useCallback(async () => {
    if (isBanned) {
      setErr(t('ui.components.lobby.incomingofferlayer.k19242515'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await api.post('/lobby/offer/accept');
      if (!(res?.data?.success)) throw new Error('failed');
      // 成功時はサーバからの offer_accepted / offer_status で閉じる
    } catch (e) {
      const data = e?.response?.data || {};
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || e?.message || '';
      setErr(lobbyOfferErrorMessage(code, data, fb, t('ui.components.lobby.incomingofferlayer.kd4eff70a')));
    } finally {
      setBusy(false);
    }
  }, [isBanned]);

  const decline = useCallback(async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await api.post('/lobby/offer/decline');
      if (!(res?.data?.success)) throw new Error('failed');
      reset();
    } catch (e) {
      const data = e?.response?.data || {};
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || e?.message || '';
      setErr(lobbyOfferErrorMessage(code, data, fb, t('ui.components.lobby.incomingofferlayer.k11cb9637')));
    } finally {
      setBusy(false);
    }
  }, [reset]);

  const gameTypeLabel = gameType === 'rating' ? t('ui.components.lobby.incomingofferlayer.k01587212') : t('ui.components.lobby.incomingofferlayer.k036a9f3c');

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) reset(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('ui.components.lobby.incomingofferlayer.k72081225')}</AlertDialogTitle>
          <AlertDialogDescription>
            <div className="space-y-1">
              <div>
                {t('ui.components.lobby.incomingofferlayer.ka12f52f2')}: <span className="font-semibold">{fromName || '—'}</span>
                {fromRating != null ? (
                  <span className="ml-2 text-gray-500">{t('ui.common.rating.brackets', { rating: fromRating })}</span>
                ) : null}
              </div>
              <div>{t('ui.components.lobby.incomingofferlayer.kfa7fa786')}: {gameTypeLabel}</div>
              <div>{t('ui.components.lobby.incomingofferlayer.k21e72ec7')}: {timeLabel || '—'}</div>
            </div>
            {fromUserKind === 'guest' && (
              <div className="mt-2 text-xs text-red-500">
                {t('ui.components.lobby.incomingofferlayer.k47bff6be')}
              </div>
            )}
            {err && <div className="mt-3 text-red-600 text-sm">{err}</div>}
            <div className="mt-3 text-sm">{t('ui.components.lobby.incomingofferlayer.k275e88fd', { seconds: countdown })}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={decline}>{t('ui.components.lobby.incomingofferlayer.k589a7d72')}</AlertDialogCancel>
          <AlertDialogAction disabled={busy || isBanned} onClick={accept}>{t('ui.components.lobby.incomingofferlayer.kdb9d8711')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}