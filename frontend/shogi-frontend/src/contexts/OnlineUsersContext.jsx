import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import api from '@/services/apiClient';
import websocketService from '@/services/websocketService';
import { useAuth } from '@/contexts/AuthContext';

const OnlineUsersContext = createContext(null);

export const useOnlineUsers = () => useContext(OnlineUsersContext);

function idToStr(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return String(v.$oid ?? v.oid ?? v.id ?? v);
  return String(v);
}

function normalizeUser(u) {
  if (!u || typeof u !== 'object') return u;
  const uid = idToStr(u.user_id || u._id || u.id);
  const wi = (u.waiting_info && typeof u.waiting_info === 'object') ? u.waiting_info : {};
  const po = (u.pending_offer && typeof u.pending_offer === 'object')
    ? u.pending_offer
    : (u.pending_offer ? u.pending_offer : {});
  return {
    ...u,
    user_id: uid,
    waiting_info: wi,
    pending_offer: po,
  };
}

function applyDiff(prevUsers, patches, removedIds) {
  const ps = Array.isArray(patches) ? patches : [];
  const rs = Array.isArray(removedIds) ? removedIds : [];
  if (!ps.length && !rs.length) return Array.isArray(prevUsers) ? prevUsers : [];

  const map = new Map();
  for (const u of (Array.isArray(prevUsers) ? prevUsers : [])) {
    const nu = normalizeUser(u);
    const id = idToStr(nu?.user_id);
    if (id) map.set(id, nu);
  }

  for (const rid of rs) {
    const id = idToStr(rid);
    if (id) map.delete(id);
  }

  for (const patch of ps) {
    const nu = normalizeUser(patch);
    const id = idToStr(nu?.user_id);
    if (!id) continue;
    const existing = map.get(id) || {};
    const merged = { ...existing, ...nu };
    if (nu.waiting_info !== undefined) merged.waiting_info = nu.waiting_info;
    if (nu.pending_offer !== undefined) merged.pending_offer = nu.pending_offer;
    map.set(id, merged);
  }

  return Array.from(map.values());
}

export function OnlineUsersProvider({ children }) {
  const { isAuthenticated, user } = useAuth();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState(''); // e.g. 'fetch_failed'
  const [initialized, setInitialized] = useState(false);

  const jwtTokenRef = useRef(null);
  const connectedOnceRef = useRef(false);
  const disconnectedSinceLastConnectRef = useRef(false);
  const loginFetchDoneRef = useRef(false);

  const applyUserDiff = useCallback((patches, removedIds) => {
    setUsers((prev) => applyDiff(prev, patches, removedIds));
  }, []);

  const refreshUsers = useCallback(async () => {
    if (!isAuthenticated) return [];

    setLoading(true);
    try {
      const res = await api.get('/lobby/online-users');
      const list = Array.isArray(res?.data?.users) ? res.data.users : [];
      const norm = list.map(normalizeUser);
      setUsers(norm);
      setErrorCode('');
      setInitialized(true);
      return norm;
    } catch (e) {
      if (e?.response?.status !== 401) {
        setErrorCode('fetch_failed');
      }
      // eslint-disable-next-line no-console
      console.error('online-users fetch failed', e);
      setInitialized(true);
      return [];
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  // login/logout
  useEffect(() => {
    if (!isAuthenticated) {
      setUsers([]);
      setLoading(false);
      setErrorCode('');
      setInitialized(false);
      loginFetchDoneRef.current = false;
      jwtTokenRef.current = null;
      connectedOnceRef.current = false;
      disconnectedSinceLastConnectRef.current = false;
      return;
    }

    // record current token (for jwt_updated de-dup)
    try {
      const tok = (typeof window !== 'undefined' && window.localStorage)
        ? (window.localStorage.getItem('access_token') || window.localStorage.getItem('token'))
        : null;
      jwtTokenRef.current = tok;
    } catch {}

    // login triggers full refresh exactly once per auth session
    if (!loginFetchDoneRef.current) {
      loginFetchDoneRef.current = true;
      refreshUsers();
    }
  }, [isAuthenticated, user?.user_id, user?._id, user?.id, refreshUsers]);

  // wss diff
  useEffect(() => {
    const onUsersUpdate = (payload) => {
      const p = payload && payload.detail ? payload.detail : payload;
      if (!p) return;
      if (Array.isArray(p.patches) || Array.isArray(p.removed_user_ids) || Array.isArray(p.removed_ids)) {
        applyUserDiff(p.patches, p.removed_user_ids || p.removed_ids);
      }
    };

    try { websocketService.on('online_users_update', onUsersUpdate); } catch {}
    return () => {
      try { websocketService.off('online_users_update', onUsersUpdate); } catch {}
    };
  }, [applyUserDiff]);

  // JWT updated => full refresh
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onJwtUpdated = (e) => {
      if (!isAuthenticated) return;
      const tok = e?.detail?.token;
      if (!tok) return;
      if (jwtTokenRef.current === tok) return;
      jwtTokenRef.current = tok;
      refreshUsers();
    };

    try { window.addEventListener('jwt_updated', onJwtUpdated); } catch {}
    return () => {
      try { window.removeEventListener('jwt_updated', onJwtUpdated); } catch {}
    };
  }, [isAuthenticated, refreshUsers]);

  // wss reconnect => full refresh
  useEffect(() => {
    const onConnect = () => {
      if (!isAuthenticated) return;
      if (connectedOnceRef.current && disconnectedSinceLastConnectRef.current) {
        refreshUsers();
      }
      connectedOnceRef.current = true;
      disconnectedSinceLastConnectRef.current = false;
    };

    const onDisconnect = () => {
      if (!connectedOnceRef.current) return;
      disconnectedSinceLastConnectRef.current = true;
    };

    try {
      websocketService.on('connect', onConnect);
      websocketService.on('disconnect', onDisconnect);
    } catch {}

    return () => {
      try {
        websocketService.off('connect', onConnect);
        websocketService.off('disconnect', onDisconnect);
      } catch {}
    };
  }, [isAuthenticated, refreshUsers]);

  const userMap = useMemo(() => {
    const m = new Map();
    for (const u of (Array.isArray(users) ? users : [])) {
      const id = idToStr(u?.user_id);
      if (id) m.set(id, u);
    }
    return m;
  }, [users]);

  const getUserById = useCallback((id) => {
    const key = id != null ? String(id) : '';
    if (!key) return null;
    return userMap.get(key) || null;
  }, [userMap]);

  const value = useMemo(() => {
    return {
      users,
      loading,
      errorCode,
      initialized,
      refreshUsers,
      applyUserDiff,
      getUserById,
    };
  }, [users, loading, errorCode, initialized, refreshUsers, applyUserDiff, getUserById]);

  return (
    <OnlineUsersContext.Provider value={value}>
      {children}
    </OnlineUsersContext.Provider>
  );
}

export default OnlineUsersContext;
