# -*- coding: utf-8 -*-
from __future__ import annotations

from typing import Any, Dict, Optional, List, Tuple
import threading
import time
import json
import logging
from datetime import datetime

try:
    from bson import ObjectId
except Exception:
    ObjectId = None  # type: ignore

logger = logging.getLogger(__name__)

PRESENCE_COLL = 'online_users'
DEFAULT_INTERVAL_SEC = 1.0
DEFAULT_OFFER_TIMEOUT_MS = 20_000


def _now_ms() -> int:
    return int(time.time() * 1000)


def _to_oid(v: Any):
    if ObjectId is None:
        return v
    if isinstance(v, ObjectId):
        return v
    if isinstance(v, str) and len(v) == 24:
        try:
            return ObjectId(v)
        except Exception:
            return v
    return v


def _uid_str(v: Any) -> str:
    try:
        if v is None:
            return ''
        return str(v)
    except Exception:
        return ''


def _jsonable(x: Any):
    """Convert Mongo-ish values to JSON-serializable values (for hashing)."""
    try:
        if ObjectId is not None and isinstance(x, ObjectId):
            return str(x)
        if isinstance(x, datetime):
            # stable enough; we don't include it in outgoing payloads
            return int(x.timestamp() * 1000)
        if isinstance(x, dict):
            return {str(k): _jsonable(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [_jsonable(v) for v in x]
        return x
    except Exception:
        return str(x)


def _stable_sig(payload: Dict[str, Any]) -> str:
    """Stable json signature for diff detection."""
    try:
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    except Exception:
        try:
            return json.dumps(_jsonable(payload), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        except Exception:
            return ''


def _stable_hash(waiting: Any, wi: Any, po: Any) -> str:
    # Backward-compat wrapper (kept for existing callers)
    return _stable_sig({
        'waiting': waiting,
        'waiting_info': _jsonable(wi or {}),
        'pending_offer': _jsonable(po or {}),
    })


def _normalize_time_code(val: Any, time_controls: Dict[str, Any]) -> Optional[str]:
    """Normalize time into canonical code (best-effort).

    NOTE: Unlike /online-users, this is used for lobby-wide diff broadcast so
    we intentionally avoid language-dependent labels as much as possible.
    """
    try:
        if val is None:
            return None
        # already a code
        if isinstance(val, str):
            s = val.strip()
            if not s:
                return None
            if s in time_controls:
                return s

            # common label/display aliases used by clients historically
            alias = {
                '早指': 'hayasashi', '早指2': 'hayasashi2', '早指3': 'hayasashi3',
                '15分': '15min', '30分': '30min',
            }
            if s in alias:
                return alias[s]

            # "m15", "15", "15分" etc.
            if s.startswith('m') and s[1:].isdigit():
                s = s[1:]
            digits = ''.join(ch for ch in s if ch.isdigit())
            if digits.isdigit():
                val = int(digits)
        if isinstance(val, (int, float)):
            mi = int(val)
            if mi == 15:
                return '15min'
            if mi == 30:
                return '30min'
            if mi == 1:
                return 'hayasashi'
            if mi == 2:
                return 'hayasashi2'
            if mi == 3:
                return 'hayasashi3'
    except Exception:
        return None
    return None


def _time_name_from_code(code: Optional[str], time_controls: Dict[str, Any]) -> str:
    try:
        if not code:
            return ''
        meta = (time_controls or {}).get(code) or {}
        # Config.TIME_CONTROLS['name'] is JP; FE has its own localized mapping.
        return str(meta.get('name') or code)
    except Exception:
        return str(code or '')


def _to_str_id(v: Any) -> str:
    try:
        if ObjectId is not None and isinstance(v, ObjectId):
            return str(v)
    except Exception:
        pass
    if isinstance(v, dict):
        return str(v.get('user_id') or v.get('id') or '')
    return str(v or '')


def _build_current_game_map(db, user_oids: List[Any], user_strs: List[str]) -> Dict[str, str]:
    """Map user_id(str) -> active_game_id(str) for currently playing users."""
    try:
        if not user_oids and not user_strs:
            return {}
        games = db.get('games') if hasattr(db, 'get') else db['games']
        active_statuses = ['active', 'ongoing', 'in_progress', 'started', 'pause', 'review']
        ors: List[Dict[str, Any]] = []
        if user_oids:
            ors += [{'sente_id': {'$in': user_oids}}, {'gote_id': {'$in': user_oids}}]
        if user_strs:
            ors += [
                {'sente_id': {'$in': user_strs}}, {'gote_id': {'$in': user_strs}},
                {'players.sente.user_id': {'$in': user_strs}}, {'players.gote.user_id': {'$in': user_strs}},
            ]
        q = {'status': {'$in': active_statuses}, '$or': ors}
        cur = games.find(q, {'_id': 1, 'sente_id': 1, 'gote_id': 1, 'players': 1, 'status': 1}).limit(200)
        out: Dict[str, str] = {}
        for g in cur:
            try:
                gid = str(g.get('_id') or '')
                if not gid:
                    continue
                players = g.get('players') or {}
                s_uid = _to_str_id((players.get('sente') or {}).get('user_id') or g.get('sente_id') or '')
                g_uid = _to_str_id((players.get('gote') or {}).get('user_id') or g.get('gote_id') or '')
                if s_uid and s_uid not in out:
                    out[s_uid] = gid
                if g_uid and g_uid not in out:
                    out[g_uid] = gid
            except Exception:
                continue
        return out
    except Exception:
        return {}


def _normalize_rating_range(rr: Any) -> Optional[int]:
    try:
        if rr is None:
            return None
        if isinstance(rr, str) and rr.strip() == '':
            return None
        n = int(rr)
        if n <= 0:
            return None
        # UI is designed for 100..400 with step 50
        if n < 100 or n > 400:
            return None
        if (n % 50) != 0:
            return None
        return n
    except Exception:
        return None


def _build_public_user(
    db,
    presence_doc: Dict[str, Any],
    profile_doc: Optional[Dict[str, Any]] = None,
    *,
    current_game_id: Optional[str] = None,
    time_controls: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    uid = presence_doc.get('user_id')
    uid_s = _uid_str(uid)

    prof = profile_doc or {}
    username = prof.get('username') or prof.get('name') or ''
    rating = prof.get('rating')
    if rating is None:
        rating = prof.get('rate')
    try:
        rating = int(rating or 0)
    except Exception:
        rating = 0

    legion = prof.get('legion') or 'JP'
    try:
        legion = str(legion).upper()
    except Exception:
        legion = 'JP'

    user_kind = prof.get('user_kind')
    if not user_kind:
        user_kind = 'guest' if bool(prof.get('is_guest')) else 'human'

    is_guest = bool(prof.get('is_guest'))

    wi = dict(presence_doc.get('waiting_info') or {})
    po = dict(presence_doc.get('pending_offer') or {})

    tc = time_controls or {}

    # Ensure time_code exists (used by FE to resolve localized name)
    try:
        t_in = wi.get('time_code') or wi.get('timeCode') or wi.get('time_control') or wi.get('time_minutes')
        t_code = _normalize_time_code(t_in, tc)
        if t_code:
            wi['time_code'] = t_code
            # best-effort fallback label (JP, FE will override via /time-controls)
            if not wi.get('time_name'):
                wi['time_name'] = _time_name_from_code(t_code, tc)
    except Exception:
        pass

    # Keep waiting_info consistent (similar to /online-users)
    try:
        wi['username'] = username
        wi['rating'] = rating
        wi['user_kind'] = user_kind
        wi['legion'] = legion
        rr = _normalize_rating_range(wi.get('rating_range'))
        if rr is not None:
            wi['rating_range'] = rr
            wi['rating_min'] = int(rating) - int(rr)
            wi['rating_max'] = int(rating) + int(rr)
    except Exception:
        pass

    # Ensure JSON-safe nested values (Socket.IO json encoder can't handle ObjectId / datetime)
    try:
        wi = _jsonable(wi) if isinstance(wi, dict) else {}
        po = _jsonable(po) if isinstance(po, dict) else {}
    except Exception:
        wi = {}
        po = {}

    return {
        'user_id': uid_s,
        'current_game_id': str(current_game_id) if current_game_id else None,
        'username': username,
        'rating': rating,
        'user_kind': user_kind,
        'legion': legion,
        'is_guest': is_guest,
        'waiting': str(presence_doc.get('waiting') or 'lobby'),
        'waiting_info': wi,
        'pending_offer': po,
    }


class OnlineUsersDiffWorker:
    def __init__(self, app, socketio, interval_sec: float = DEFAULT_INTERVAL_SEC, offer_timeout_ms: int = DEFAULT_OFFER_TIMEOUT_MS):
        self.app = app
        self.socketio = socketio
        self.interval_sec = float(interval_sec)
        self.offer_timeout_ms = int(offer_timeout_ms)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # uid(str) -> stable_signature
        self._prev: Dict[str, str] = {}

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run_with_app, name='online-users-diff-worker', daemon=True)
        self._thread.start()
        logger.info('OnlineUsersDiffWorker started.')

    def stop(self):
        self._stop.set()

    def _run_with_app(self):
        try:
            with self.app.app_context():
                self._run()
        except Exception:
            # fallback: run without context (should still work for db via app.config)
            self._run()

    def _expire_offers(self, db, presence_docs: List[Dict[str, Any]]) -> bool:
        """Expire offers older than offer_timeout_ms.

        Returns True when DB was updated (so caller should refresh presence_docs).
        """
        try:
            now_ms = _now_ms()
            expired: List[Tuple[Any, Any]] = []  # (receiver_uid, sender_uid)
            for d in presence_docs:
                try:
                    waiting = str(d.get('waiting') or '')
                    if waiting != 'applying':
                        continue
                    po = d.get('pending_offer') or {}
                    # receiver side has from_user_id
                    from_uid = po.get('from_user_id')
                    created_at = po.get('created_at')
                    if not from_uid or created_at is None:
                        continue
                    age = now_ms - int(created_at)
                    if age >= self.offer_timeout_ms:
                        expired.append((d.get('user_id'), from_uid))
                except Exception:
                    continue

            if not expired:
                return False

            coll = db[PRESENCE_COLL]
            now_dt = datetime.utcnow()

            for receiver_uid, sender_uid in expired:
                try:
                    r_uid = _to_oid(receiver_uid)
                    s_uid = _to_oid(sender_uid)
                    # restore sender waiting from prev_waiting if present
                    prev_wait = 'lobby'
                    try:
                        sdoc = coll.find_one({'user_id': s_uid}, {'pending_offer': 1, 'waiting': 1}) or {}
                        po2 = sdoc.get('pending_offer') or {}
                        pv = po2.get('prev_waiting')
                        pv_s = str(pv or '').strip()
                        if pv_s in ('seeking', 'lobby'):
                            prev_wait = pv_s
                    except Exception:
                        prev_wait = 'lobby'

                    # receiver back to seeking (they were seeking)
                    # NOTE: auto-decline (timeout) streak is tracked server-side only.
                    streak = 1
                    try:
                        rdoc = coll.find_one({'user_id': r_uid}, {'auto_decline_streak': 1, 'waiting': 1}) or {}
                        streak = int(rdoc.get('auto_decline_streak') or 0) + 1
                    except Exception:
                        streak = 1

                    if streak >= 3:
                        # 3 consecutive timeouts -> cancel seeking (back to lobby) and notify
                        try:
                            coll.update_one({'user_id': r_uid, 'waiting': 'applying'}, {'$set': {
                                'waiting': 'lobby',
                                'waiting_info': {},
                                'pending_offer': {},
                                'last_seen_at': now_dt,
                                'auto_decline_streak': 0,
                            }})
                        except Exception:
                            pass
                        try:
                            self.socketio.emit('lobby_offer_update', {'type': 'auto_decline_limit'}, room=f'user:{_uid_str(r_uid)}')
                        except Exception:
                            pass
                    else:
                        try:
                            coll.update_one({'user_id': r_uid, 'waiting': 'applying'}, {'$set': {
                                'waiting': 'seeking',
                                'pending_offer': {},
                                'last_seen_at': now_dt,
                                'auto_decline_streak': int(streak),
                            }})
                        except Exception:
                            pass

                    # sender back
                    try:
                        coll.update_one({'user_id': s_uid, 'waiting': 'applying'}, {'$set': {
                            'waiting': prev_wait,
                            'pending_offer': {},
                            'last_seen_at': now_dt,
                        }})
                    except Exception:
                        pass

                    # notify both sides so FE clears incoming offer overlay
                    try:
                        payload = {'type': 'offer_status', 'status': 'declined', 'reason': 'timeout'}
                        self.socketio.emit('lobby_offer_update', payload, room=f'user:{_uid_str(r_uid)}')
                        self.socketio.emit('lobby_offer_update', payload, room=f'user:{_uid_str(s_uid)}')
                    except Exception:
                        pass
                except Exception:
                    logger.warning('offer expiration failed', exc_info=True)

            return True
        except Exception:
            return False

    def _run(self):
        while not self._stop.is_set():
            try:
                db = getattr(self.app, 'mongo_db', None)
                if db is None:
                    db = self.app.config.get('MONGO_DB')
                if db is None:
                    time.sleep(1.0)
                    continue

                # config (safe even if missing)
                try:
                    time_controls = dict(self.app.config.get('TIME_CONTROLS') or {})
                except Exception:
                    time_controls = {}

                coll = db[PRESENCE_COLL]
                # keep fields minimal (do NOT include last_seen_at in hash to avoid noise)
                docs = list(coll.find({}, {'user_id': 1, 'waiting': 1, 'waiting_info': 1, 'pending_offer': 1}))

                # expire offers
                if self._expire_offers(db, docs):
                    docs = list(coll.find({}, {'user_id': 1, 'waiting': 1, 'waiting_info': 1, 'pending_offer': 1}))

                presence_map: Dict[str, Dict[str, Any]] = {}
                cur_ids = set()
                user_oids: List[Any] = []
                user_strs: List[str] = []

                for d in docs:
                    uid = d.get('user_id')
                    uid_s = _uid_str(uid)
                    if not uid_s:
                        continue
                    cur_ids.add(uid_s)
                    presence_map[uid_s] = d
                    # keep both (ObjectId and string) for games query
                    if uid is not None:
                        user_oids.append(uid)
                    user_strs.append(uid_s)

                # profiles for all online users (needed to detect rating/name changes without full refresh)
                prof_map: Dict[str, Dict[str, Any]] = {}
                try:
                    # Only ObjectId values can match users._id
                    oids_valid = [x for x in user_oids if (ObjectId is None or isinstance(x, ObjectId))]
                    if oids_valid:
                        for p in db['users'].find(
                            {'_id': {'$in': oids_valid}},
                            {'username': 1, 'name': 1, 'rating': 1, 'rate': 1, 'user_kind': 1, 'is_guest': 1, 'legion': 1},
                        ):
                            pid = _uid_str(p.get('_id'))
                            if pid:
                                prof_map[pid] = p
                except Exception:
                    prof_map = {}

                # playing game ids (spectate button etc.)
                game_map = _build_current_game_map(db, user_oids=user_oids, user_strs=user_strs)

                # signatures
                cur_sig: Dict[str, str] = {}
                for uid_s in cur_ids:
                    pres = presence_map.get(uid_s) or {}
                    prof = prof_map.get(uid_s) or {}
                    username = prof.get('username') or prof.get('name') or ''
                    rating = prof.get('rating')
                    if rating is None:
                        rating = prof.get('rate')
                    try:
                        rating = int(rating or 0)
                    except Exception:
                        rating = 0
                    user_kind = prof.get('user_kind') or ('guest' if bool(prof.get('is_guest')) else 'human')
                    is_guest = bool(prof.get('is_guest'))
                    legion = prof.get('legion') or 'JP'
                    try:
                        legion = str(legion).upper()
                    except Exception:
                        legion = 'JP'

                    cur_sig[uid_s] = _stable_sig({
                        'username': username,
                        'rating': rating,
                        'user_kind': user_kind,
                        'is_guest': is_guest,
                        'legion': legion,
                        'waiting': str(pres.get('waiting') or 'lobby'),
                        'waiting_info': _jsonable(pres.get('waiting_info') or {}),
                        'pending_offer': _jsonable(pres.get('pending_offer') or {}),
                        'current_game_id': game_map.get(uid_s) or '',
                    })

                prev_ids = set(self._prev.keys())
                removed_ids = sorted(list(prev_ids - cur_ids))

                changed_ids: List[str] = []
                for uid_s in cur_ids:
                    if self._prev.get(uid_s) != cur_sig.get(uid_s, ''):
                        changed_ids.append(uid_s)

                patches: List[Dict[str, Any]] = []
                if changed_ids:
                    for uid_s in changed_ids:
                        pres = presence_map.get(uid_s)
                        if not pres:
                            continue
                        patches.append(_build_public_user(
                            db,
                            pres,
                            prof_map.get(uid_s),
                            current_game_id=game_map.get(uid_s),
                            time_controls=time_controls,
                        ))

                if patches or removed_ids:
                    try:
                        if self.socketio is None:
                            raise RuntimeError('socketio is None')
                        self.socketio.emit('online_users_update', {
                            'type': 'diff',
                            'patches': patches,
                            'removed_user_ids': removed_ids,
                        }, room='lobby')
                    except Exception as e:
                        now_t = time.time()
                        last = getattr(self, '_last_emit_err', 0.0)
                        if now_t - last > 5.0:
                            setattr(self, '_last_emit_err', now_t)
                            logger.warning('online_users_update emit failed: %s', e, exc_info=True)

                self._prev = cur_sig
                time.sleep(self.interval_sec)
            except Exception as e:
                now_t = time.time()
                last = getattr(self, '_last_loop_err', 0.0)
                if now_t - last > 5.0:
                    setattr(self, '_last_loop_err', now_t)
                    logger.warning('OnlineUsersDiffWorker loop error: %s', e, exc_info=True)
                time.sleep(1.0)


def start_online_users_diff_worker(app, socketio, interval_sec: float = DEFAULT_INTERVAL_SEC, offer_timeout_ms: int = DEFAULT_OFFER_TIMEOUT_MS):
    try:
        worker = OnlineUsersDiffWorker(app, socketio, interval_sec=interval_sec, offer_timeout_ms=offer_timeout_ms)
        worker.start()
        app.config['ONLINE_USERS_DIFF_WORKER'] = worker
        return worker
    except Exception as e:
        try:
            app.logger.warning('start_online_users_diff_worker failed: %s', e, exc_info=True)
        except Exception:
            pass
        return None
