// websocketService.js (fixed)
import { io } from 'socket.io-client';

function readCookie(name) {
  try {
    const list = (typeof document !== 'undefined' && document.cookie) ? document.cookie.split(';') : [];
    const p = name + '=';
    for (let c of list) {
      c = c.trim();
      if (c.startsWith(p)) return decodeURIComponent(c.slice(p.length));
    }
  } catch {}
  return null;
}

function pickToken(explicit) {
  if (explicit) return explicit.startsWith('Bearer ') ? explicit.slice(7) : explicit;
  const keys = ['access_token','token','jwt','auth_token','authorization','Authorization'];
  for (const k of keys) {
    const v =
      (typeof localStorage !== 'undefined' && localStorage.getItem(k)) ||
      (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(k)) ||
      readCookie(k);
    if (v) return v.startsWith('Bearer ') ? v.slice(7) : v;
  }
  return null;
}

class WebsocketService {
  _lastGameId = null;
  constructor(baseUrl) {
    this.baseUrl = baseUrl || undefined;
    this.socket = null;
    this._onMap = new Map();
    this._recentEvents = [];   // evt -> Set<fn>
    this._autoJoinLobby = true;
  }

  connect(token) {
    const jwt = pickToken(token);
    if (this.socket) {
      // Reuse the existing socket instance to avoid duplicated connections/listeners
      // (React StrictMode can call connect() twice before the first socket is connected).
      try { if (jwt) this.socket.auth = { token: jwt }; } catch {}
      try { if (!this.socket.connected) this.socket.connect(); } catch {}
      return this.socket;
    }

    this.socket = io(this.baseUrl, {
      transports: ['websocket'],
      withCredentials: true,
      auth: jwt ? { token: jwt } : {},
      autoConnect: true,
    });

    const rejoin = () => {
      if (this._autoJoinLobby) this.joinLobby();
      if (this._lastGameId) this.joinGame(this._lastGameId);
    };
    this.socket.on('connect', rejoin);
    // forward connection state to subscribers (App.jsx expects these)
    this.socket.on('connect', () => {
      try { if (typeof window !== 'undefined') { window.dispatchEvent(new CustomEvent('connect')); } } catch {}
      try { const set = this._onMap.get('connect'); if (set) set.forEach(fn => { try { fn(); } catch {} }); } catch {}
    });
    this.socket.on('disconnect', (reason) => {
      try { if (typeof window !== 'undefined') { window.dispatchEvent(new CustomEvent('disconnect', { detail: { reason } })); } } catch {}
      try { const set = this._onMap.get('disconnect'); if (set) set.forEach(fn => { try { fn({ reason }); } catch {} }); } catch {}
    });


    // forward server events to window with same event name
    this.socket.onAny((ev, ...args) => {
  if (this.isDuplicateEvent && this.isDuplicateEvent(ev, args && args[0])) return;
  try { if (typeof window !== 'undefined') { window.dispatchEvent(new CustomEvent(ev, { detail: args[0] })); } } catch {}
  try { const set = this._onMap.get(ev); if (set) set.forEach(fn => { try { fn(...args); } catch {} }); } catch {}
})

    return this.socket;
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.disconnect(); } catch {}
      this.socket = null;
    }
  }

  // return true if event should be suppressed as duplicate
  isDuplicateEvent(evName, payload) {
    try {
      const p = (payload && payload.detail) ? payload.detail : payload;
      const now = Date.now();
      // Normalize to stable key (focus on lobby offer updates)
      let key;
      if (evName === 'lobby_offer_update' && p && typeof p === 'object') {
        const t = p.type || '';
        const s = p.status || '';
        const f = p.from_user_id || p.from || '';
        const to = p.to_user_id || p.to || '';
        key = [evName, t, s, String(f), String(to)].join(':');
      } else if (evName === 'shared_board_offer' && p && typeof p === 'object') {
        const gid = p.game_id ?? p.gameId ?? p.id ?? '';
        const iu = p.initiator_user_id ?? '';
        const ir = p.initiator_role ?? '';
        key = [evName, String(gid), String(iu), String(ir)].join(':');
      } else {
        // Fallback: coarse key using event + first-level fields
        key = evName + ':' + JSON.stringify(p || {});
      }
      // GC old entries
      const windowMs = 1200;
      this._recentEvents = (this._recentEvents || []).filter(e => (now - e.ts) <= windowMs);
      const seen = (this._recentEvents || []).some(e => e.key === key);
      if (!seen) {
        this._recentEvents.push({ key, ts: now });
      }
      return seen;
    } catch {
      return false;
    }
  }

  isSocketConnected() {
    return !!(this.socket && this.socket.connected);
  }

  on(evt, fn) { if (!this._onMap.has(evt)) this._onMap.set(evt, new Set()); this._onMap.get(evt).add(fn); }

  off(evt, fn) { const set = this._onMap.get(evt); if (set) set.delete(fn); }

  emit(evt, payload) {
    if (this.socket) { try { this.socket.emit(evt, payload); } catch {} }
  }

  // --- lobby / game (use only the canonical event names) ---
  joinLobby()  { this.emit('join_lobby',  { room: 'lobby' }); }
  leaveLobby() { this.emit('leave_lobby', { room: 'lobby' }); }

  joinGame(id)  {
    const gid = (id && typeof id === 'object') ? (id.game_id || id.id) : id;
    const s = (gid != null) ? String(gid) : '';
    if (s) this._lastGameId = s;
    this.emit('join_game',  { room: `game:${s}` });
  }
  leaveGame(id) {
    const gid = (id && typeof id === 'object') ? (id.game_id || id.id) : id;
    const s = (gid != null) ? String(gid) : '';
    this.emit('leave_game', { room: `game:${s}` });
    if (s && this._lastGameId === s) this._lastGameId = null;
  }
  // Send chat message (supports both lobby/game rooms)
  sendChatMessage(message, roomType = 'lobby', roomId = null) {
    try {
      const payload = { message, room_type: roomType, room_id: roomId };
      // Try canonical event name first; if the server expects a different one,
      // we keep a single emit the service can handle.
      this.emit('send_chat', payload);
    } catch {}
  }
}

// one singleton per page even if imported multiple times
const __inst =
  (typeof window !== 'undefined')
    ? (window.__appWS ||= new WebsocketService())
    : new WebsocketService();

export default __inst;