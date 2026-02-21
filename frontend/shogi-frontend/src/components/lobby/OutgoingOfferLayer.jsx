// src/components/lobby/OutgoingOfferLayer.jsx
import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
import { t, getLanguage } from '@/i18n';
import { lobbyOfferErrorMessage } from '@/i18n/lobbyErrors';

export default function OutgoingOfferLayer() {
  const { user } = useAuth();
  const myId = String(user?._id || user?.id || '');

  // language (for time-control labels)
  const [lang, setLang] = useState(getLanguage());
  useEffect(() => {
    const onLang = () => {
      try { setLang(getLanguage()); } catch {}
    };
    try { window.addEventListener('shogi_language_changed', onLang); } catch {}
    return () => {
      try { window.removeEventListener('shogi_language_changed', onLang); } catch {}
    };
  }, []);

  const [code2name, setCode2name] = useState({});
  useEffect(() => {
    (async () => {
      try {
        const q = lang ? `?lang=${encodeURIComponent(lang)}` : '';
        const r = await fetch(`/api/lobby/time-controls${q}`, { credentials: 'include' });
        if (!r.ok) return;
        const j = await r.json();
        const arr = Array.isArray(j?.controls) ? j.controls : [];
        setCode2name(Object.fromEntries(arr.map(x => [x.code, x.name])));
      } catch {
        // ignore
      }
    })();
  }, [lang]);

  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = React.useRef(null);
  const acceptedRef = React.useRef(false);

  const [toName, setToName] = useState('');
  const [timeLabel, setTimeLabel] = useState('');
  const [timeCode, setTimeCode] = useState('');

  const reset = useCallback(() => {
    setOpen(false);
    setErr('');
    setBusy(false);
    setToName('');
    setTimeLabel('');
    setTimeCode('');
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

        // Close immediately on status updates.
        // NOTE: server-side timeout/accept notifications may omit from_user_id/to_user_id.
        if (p.type === 'offer_status') {
          if (p.status === 'accepted') {
            acceptedRef.current = true;
            reset();
            return;
          }
          if (p.status === 'declined') {
            reset();
            return;
          }
        }

        // I am the sender
        const fromId = String(p.from_user_id || p.from || '');
        if (!myId || fromId !== myId) return;

        if (p.type === 'offer_created') {
          const tc = String(p.time_code || '');
          setTimeCode(tc);
          // Fallback only: label will be resolved locally by code2name.
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

  const resolvedTimeLabel = useMemo(() => {
    try {
      if (timeCode && code2name && code2name[timeCode]) return code2name[timeCode];
    } catch {}
    return timeLabel || '';
  }, [timeCode, code2name, timeLabel]);

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
            {resolvedTimeLabel ? <span className="ml-2">{t('ui.components.lobby.outgoingofferlayer.k15a91f8c', { time: resolvedTimeLabel })}</span> : ''}
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
