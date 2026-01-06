// src/hooks/useLobbyOfferEventsStable.js
import { useEffect } from 'react';
import ws from '@/services/websocketService';

/**
 * Lobby offer events (WebSocket) with stable lifecycle.
 */
export default function useLobbyOfferEventsStable({
  myId,
  setSendingLock,
  setSendingTo,
  setSendingMinutes,
  setErr,
  fetchUsers,
}) {
    // Debounce + single-flight for online users refresh
  const _refreshTimerRef = React.useRef(null);
  const _inflightRef = React.useRef(false);
  const _lastFetchRef = React.useRef(0);
  const scheduleUsersRefresh = React.useCallback((delay=150) => {
    if (_refreshTimerRef.current) return;
    _refreshTimerRef.current = setTimeout(async () => {
      _refreshTimerRef.current = null;
      if (_inflightRef.current) return;
      const now = Date.now();
      if (now - _lastFetchRef.current < 500) return; // cooldown
      _inflightRef.current = true
      try {
        scheduleUsersRefresh(0);
        _lastFetchRef.current = Date.now();
      } catch {} finally {
        _inflightRef.current = false;
      }
    }, delay);
  }, [fetchUsers]);
useEffect(() => {
    // configure & connect
    try {
      ws.configure({
        url: (import.meta?.env?.VITE_API_BASE) || (typeof window !== 'undefined' ? window.location.origin : '/'),
        getToken: () => {
          try {
            return localStorage.getItem('access_token') ||
                   localStorage.getItem('token') ||
                   sessionStorage.getItem('access_token') ||
                   '';
          } catch { return ''; }
        },
      });
      ws.connect();
    } catch {}

    // join lobby
    try { ws.joinLobby(); } catch {}

    const handler = async (evt) => {
      if (!evt || !evt.type) return;
      const me = String(myId || '');

      try {
        if (evt.type === 'offer_created') {
          if (String(evt.to_user_id || '') === me) {
            scheduleUsersRefresh(0).catch(() => {});
          }
        }
        else if (
          evt.type === 'offer_status' ||
          evt.type === 'offer_accepted' ||
          evt.type === 'offer_declined' ||
          evt.type === 'offer_cancelled'
        ) {
          if (typeof setSendingLock === 'function') setSendingLock(false);
          if (typeof setSendingTo === 'function') setSendingTo(null);
          scheduleUsersRefresh(0).catch(() => {});
        }
        else if (
          evt.type === 'waiting_update' ||
          evt.type === 'lobby_users_update' ||
          evt.type === 'online_users_update'
        ) {
          scheduleUsersRefresh(0).catch(() => {});
        }
      } catch (e) {
        if (typeof setErr === 'function') setErr('イベントの処理に失敗しました');
        try { console.error('[ws handler]', e); } catch {}
      }
    };

    try { ws.on('lobby_offer_update', handler); } catch {}
    try { ws.on('lobby_users_update', handler); } catch {}
    try { ws.on('online_users_update', handler); } catch {}

    return () => {
      if (_refreshTimerRef.current) { clearTimeout(_refreshTimerRef.current); _refreshTimerRef.current = null; }
      try { ws.off('lobby_offer_update', handler); } catch {}
      try { ws.off('lobby_users_update', handler); } catch {}
      try { ws.off('online_users_update', handler); } catch {}
      try { ws.leaveLobby(); } catch {}
    };
  }, [myId, setSendingLock, setSendingTo, setSendingMinutes, setErr, fetchUsers]);
}
