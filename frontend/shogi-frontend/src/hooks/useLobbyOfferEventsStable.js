// src/hooks/useLobbyOfferEventsStable.js
import React, { useEffect, useRef, useCallback } from 'react';
import ws from '@/services/websocketService';
import { t } from '@/i18n';

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
  const refreshTimerRef = useRef(null);
  const inflightRef = useRef(false);
  const lastFetchRef = useRef(0);

  const scheduleUsersRefresh = useCallback((delay = 150) => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(async () => {
      refreshTimerRef.current = null;
      if (inflightRef.current) return;
      const now = Date.now();
      if (now - lastFetchRef.current < 500) return; // cooldown
      inflightRef.current = true;
      try {
        lastFetchRef.current = Date.now();
        if (typeof fetchUsers === 'function') {
          await fetchUsers();
        }
      } catch (e) {
        try { console.error('[ws fetchUsers]', e); } catch {}
      } finally {
        inflightRef.current = false;
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
            scheduleUsersRefresh(0);
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
          scheduleUsersRefresh(0);
        }
        else if (
          evt.type === 'waiting_update' ||
          evt.type === 'lobby_users_update' ||
          evt.type === 'online_users_update'
        ) {
          scheduleUsersRefresh(0);
        }
      } catch (e) {
        if (typeof setErr === 'function') setErr(t('ui.hooks.uselobbyoffereventsstable.k46f4909d'));
        try { console.error('[ws handler]', e); } catch {}
      }
    };

    try { ws.on('lobby_offer_update', handler); } catch {}
    try { ws.on('lobby_users_update', handler); } catch {}
    try { ws.on('online_users_update', handler); } catch {}

    return () => {
      if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
      try { ws.off('lobby_offer_update', handler); } catch {}
      try { ws.off('lobby_users_update', handler); } catch {}
      try { ws.off('online_users_update', handler); } catch {}
      try { ws.leaveLobby(); } catch {}
    };
  }, [myId, setSendingLock, setSendingTo, setSendingMinutes, setErr, fetchUsers, scheduleUsersRefresh]);
}
