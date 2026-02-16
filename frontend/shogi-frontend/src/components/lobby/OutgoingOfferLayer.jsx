// src/components/lobby/OutgoingOfferLayer.jsx
import React, { useEffect, useState, useCallback } from 'react';
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
import ws from '@/services/websocketService';
import api from '@/services/apiClient';
import { t } from '@/i18n';
import { lobbyOfferErrorMessage } from '@/i18n/lobbyErrors';

export default function OutgoingOfferLayer() {
  const { user } = useAuth();
  const myId = String(user?._id || user?.id || '');

  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = React.useRef(null);
  const acceptedRef = React.useRef(false);

  const [toName, setToName] = useState('');
  const [timeLabel, setTimeLabel] = useState('');

  const reset = useCallback(() => {
    setOpen(false);
    setErr('');
    setBusy(false);
    setToName('');
    setTimeLabel('');
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setCountdown(0);
  }, []);

  useEffect(() => {
    const handler = (payload) => {
      try {
        const p = payload && payload.detail ? payload.detail : payload;
        if (!p) return;

        // Close immediately if accepted (server sends this to both users; payload may not contain from_user_id)
        if (p.type === 'offer_status' && p.status === 'accepted') {
          acceptedRef.current = true;
          reset();
          return;
        }

        // I am the sender
        const fromId = String(p.from_user_id || p.from || '');
        if (!myId || fromId !== myId) return;

        if (p.type === 'offer_created') {
          setTimeLabel(p.time_name || '');
          // we may not know receiver name; keep blank
          setOpen(true);
          setCountdown(20);
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = setInterval(() => setCountdown((s) => (s > 0 ? s - 1 : 0)), 1000);
        }
        if (p.type === 'offer_status') {
          // accepted/declined by opponent (or timeout cleanup)
          if (p.status === 'declined') {
            reset();
            return;
          }
          if (p.status === 'accepted') {
            acceptedRef.current = true;
            reset();
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('outgoing-offer handler failed', e);
      }
    };

    try {
      ws.off('lobby_offer_update', handler);
    } catch {}
    try {
      ws.on('lobby_offer_update', handler);
    } catch {}

    return () => {
      try {
        ws.off('lobby_offer_update', handler);
      } catch {}
    };
  }, [myId, reset]);

  useEffect(() => {
    if (!open || acceptedRef.current) return;
    if (countdown <= 0) {
      // auto-cancel
      (async () => {
        try {
          await api.post('/lobby/offer/cancel');
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('auto-cancel failed', e);
        } finally {
          reset();
        }
      })();
    }
  }, [open, countdown, reset]);

  const cancel = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await api.post('/lobby/offer/cancel');
      if (!res?.data?.success) throw new Error('failed');
      reset();
    } catch (e) {
      const data = e?.response?.data || {};
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || e?.message || '';
      setErr(lobbyOfferErrorMessage(code, data, fb, t('ui.components.lobby.outgoingofferlayer.k67a770a9')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('ui.components.lobby.outgoingofferlayer.k7f1bfccb')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('ui.components.lobby.outgoingofferlayer.k60af4465')}
            {timeLabel ? <span className="ml-2">{t('ui.components.lobby.outgoingofferlayer.k15a91f8c', { time: timeLabel })}</span> : ''}
            {err && <div className="mt-3 text-red-600 text-sm">{err}</div>}
            <div className="mt-3 text-sm">{t('ui.components.lobby.outgoingofferlayer.k3be44cb4', { count: countdown })}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={cancel}>
            {t('ui.components.lobby.outgoingofferlayer.kf6245757')}
          </AlertDialogCancel>
          <AlertDialogAction disabled>{t('ui.components.lobby.outgoingofferlayer.k55e95614')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
