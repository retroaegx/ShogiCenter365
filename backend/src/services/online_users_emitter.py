# -*- coding: utf-8 -*-
"""online_users_update diff emitter.

Frontend contract:
  - event: 'online_users_update'
  - payload: { type: 'diff', patches: [...], removed_user_ids: [...] }

This module builds minimal patch user objects consistent with
`/api/lobby/online-users` entries.

It is intentionally self-contained (no imports from routes) to avoid circular
imports.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple
import logging
from datetime import datetime, date

from flask import current_app

logger = logging.getLogger(__name__)

# Match what the UI considers "in game" for a spectate/join button.
_ACTIVE_GAME_STATUSES = [
    'active', 'ongoing', 'in_progress', 'started', 'pause', 'review'
]


def _get_socketio_fallback():
    """Resolve SocketIO instance from current_app.

    We prefer `current_app.extensions['socketio']` because this project stores
    it there.
    """
    try:
        ex = getattr(current_app, 'extensions', None) or {}
        sio = ex.get('socketio')
        if sio:
            return sio
    except Exception:
        pass
    try:
        sio = current_app.config.get('SOCKETIO')
        if sio:
            return sio
    except Exception:
        pass
    return None


def _oid_helpers():
    try:
        from bson import ObjectId
        return ObjectId
    except Exception:
        return None


def _to_oid(v) -> Optional[Any]:
    ObjectId = _oid_helpers()
    if ObjectId is None:
        return None
    if v is None:
        return None
    if isinstance(v, ObjectId):
        return v
    # dict-ish forms
    if isinstance(v, dict):
        for k in ('$oid', 'oid', 'id', 'user_id'):
            if k in v:
                v = v.get(k)
                break
    try:
        s = str(v)
    except Exception:
        return None
    try:
        if hasattr(ObjectId, 'is_valid') and ObjectId.is_valid(s):
            return ObjectId(s)
    except Exception:
        pass
    return None


def _id_to_str(v) -> str:
    if v is None:
        return ''
    ObjectId = _oid_helpers()
    if ObjectId is not None and isinstance(v, ObjectId):
        return str(v)
    if isinstance(v, dict):
        return _id_to_str(v.get('user_id') or v.get('_id') or v.get('$oid') or v.get('id') or v.get('oid'))
    try:
        return str(v)
    except Exception:
        return ''



def _json_safe(x: Any):
    """Recursively convert values to JSON-serializable ones.

    Socket.IO JSON encoding cannot handle ObjectId/datetime/set/etc.
    """
    try:
        from bson import ObjectId as _OID
    except Exception:
        _OID = None

    def conv(v):
        if v is None:
            return None
        try:
            if _OID is not None and isinstance(v, _OID):
                return str(v)
        except Exception:
            pass
        if isinstance(v, (datetime,)):
            try:
                return v.isoformat().replace('+00:00', 'Z')
            except Exception:
                return str(v)
        if isinstance(v, (date,)) and not isinstance(v, datetime):
            try:
                return v.isoformat()
            except Exception:
                return str(v)
        if isinstance(v, (str, int, float, bool)):
            return v
        if isinstance(v, dict):
            return {str(k): conv(val) for k, val in v.items()}
        if isinstance(v, (list, tuple, set)):
            return [conv(i) for i in list(v)]
        try:
            return str(v)
        except Exception:
            return None

    return conv(x)

def _normalize_rating_range(v) -> Optional[int]:
    """Allowed: 100..400 step 50; None means no limit."""
    if v is None:
        return None
    if isinstance(v, str) and v.strip() == '':
        return None
    try:
        n = int(v)
    except Exception:
        return None
    if n < 100 or n > 400:
        return None
    if n % 50 != 0:
        return None
    return n


def _extract_profile_fields(prof: Dict[str, Any]) -> Tuple[str, int, str, str, bool]:
    username = (prof.get('username') or prof.get('name') or 'unknown')
    try:
        rating = int(prof.get('rating') or prof.get('rate') or 0)
    except Exception:
        rating = 0

    user_kind = prof.get('user_kind')
    if isinstance(user_kind, str):
        user_kind = user_kind.strip()
    else:
        user_kind = ''
    if not user_kind:
        user_kind = 'guest' if bool(prof.get('is_guest')) else 'human'

    legion = prof.get('legion')
    if isinstance(legion, str):
        legion = legion.strip().upper()
    else:
        legion = ''
    if not legion:
        legion = 'JP'

    is_guest = bool(prof.get('is_guest'))
    return str(username), int(rating), str(user_kind), str(legion), is_guest


def _build_current_game_map(db, user_oid_list: List[Any], user_str_list: List[str]) -> Dict[str, str]:
    """user_id(str) -> game_id(str) for active/review games."""
    game_map: Dict[str, str] = {}
    try:
        games = db.get('games') if hasattr(db, 'get') else db['games']
    except Exception:
        return game_map

    ors: List[Dict[str, Any]] = []
    if user_oid_list:
        ors += [{'sente_id': {'$in': user_oid_list}}, {'gote_id': {'$in': user_oid_list}}]
    if user_str_list:
        ors += [
            {'players.sente.user_id': {'$in': user_str_list}},
            {'players.gote.user_id': {'$in': user_str_list}},
            {'sente_id': {'$in': user_str_list}},
            {'gote_id': {'$in': user_str_list}},
        ]
    if not ors:
        return game_map

    try:
        cursor = games.find(
            {'status': {'$in': _ACTIVE_GAME_STATUSES}, '$or': ors},
            {'players': 1, 'sente_id': 1, 'gote_id': 1}
        )
    except Exception:
        return game_map

    def _uid(v):
        return _id_to_str(v.get('user_id') if isinstance(v, dict) else v)

    try:
        for g in cursor:
            gid = _id_to_str(g.get('_id'))
            players = g.get('players') or {}
            s_uid = _uid((players.get('sente') or {}).get('user_id')) or _id_to_str(g.get('sente_id'))
            g_uid = _uid((players.get('gote') or {}).get('user_id')) or _id_to_str(g.get('gote_id'))
            if s_uid:
                game_map[s_uid] = gid
            if g_uid:
                game_map[g_uid] = gid
    except Exception:
        return game_map

    return game_map


def build_online_user_patches(db, user_ids: Iterable[Any]) -> List[Dict[str, Any]]:
    """Build patch objects for the given user ids."""
    user_ids = list(user_ids or [])
    if not user_ids:
        return []

    oids: List[Any] = []
    strs: List[str] = []
    for uid in user_ids:
        s = _id_to_str(uid)
        if s:
            strs.append(s)
        oid = _to_oid(uid)
        if oid is not None:
            oids.append(oid)

    # Presence docs
    try:
        ou = db.get('online_users') if hasattr(db, 'get') else db['online_users']
    except Exception:
        return []

    q_or: List[Dict[str, Any]] = []
    if oids:
        q_or.append({'user_id': {'$in': oids}})
    if strs:
        q_or.append({'user_id': {'$in': strs}})
    if not q_or:
        return []

    try:
        pres_docs = list(ou.find({'$or': q_or}))
    except Exception:
        pres_docs = []

    # Profiles
    profiles: Dict[str, Dict[str, Any]] = {}
    try:
        users = db.get('users') if hasattr(db, 'get') else db['users']
        if oids:
            for d in users.find({'_id': {'$in': oids}}):
                profiles[_id_to_str(d.get('_id'))] = d
    except Exception:
        pass

    game_map = _build_current_game_map(db, oids, strs)

    patches: List[Dict[str, Any]] = []
    for pres in pres_docs:
        uid = pres.get('user_id') or pres.get('_id')
        uid_str = _id_to_str(uid)
        prof = profiles.get(uid_str) or {}

        username, rating, user_kind, legion, is_guest = _extract_profile_fields(prof)

        wi = pres.get('waiting_info') if isinstance(pres.get('waiting_info'), dict) else {}
        wi = dict(wi or {})

        # Keep wi aligned with profile.
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

        pending_offer = pres.get('pending_offer') if isinstance(pres.get('pending_offer'), dict) else (pres.get('pending_offer') or {})

        # Ensure JSON-safe nested values
        try:
            wi = _json_safe(wi) if isinstance(wi, dict) else {}
            pending_offer = _json_safe(pending_offer) if isinstance(pending_offer, dict) else {}
        except Exception:
            wi = {}
            pending_offer = {}

        patches.append({
            'user_id': uid_str,
            'current_game_id': game_map.get(uid_str),
            'username': username,
            'rating': rating,
            'user_kind': user_kind,
            'legion': legion,
            'is_guest': is_guest,
            'waiting': pres.get('waiting', 'lobby') or 'lobby',
            'waiting_info': wi,
            'pending_offer': pending_offer,
        })

    return patches


def emit_online_users_diff(
    db,
    socketio=None,
    *,
    changed_user_ids: Optional[Iterable[Any]] = None,
    removed_user_ids: Optional[Iterable[Any]] = None,
    room: str = 'lobby',
) -> bool:
    """Emit diff payload to lobby.

    Returns True if an emit was attempted.
    """
    try:
        changed = list(changed_user_ids or [])
        removed = list(removed_user_ids or [])
    except Exception:
        changed, removed = [], []

    patches = []
    if changed and db is not None:
        try:
            patches = build_online_user_patches(db, changed)
        except Exception:
            logger.warning('build_online_user_patches failed', exc_info=True)
            patches = []
        if changed and not patches:
            logger.warning('emit_online_users_diff: changed=%s but produced 0 patches', [ _id_to_str(x) for x in changed ])

    removed_strs = [_id_to_str(x) for x in removed if _id_to_str(x)]

    if not patches and not removed_strs:
        return False

    sio = socketio or _get_socketio_fallback()
    if not sio:
        logger.warning('socketio not available: online_users_update diff skipped')
        return False

    payload = {
        'type': 'diff',
        'patches': patches,
        'removed_user_ids': removed_strs,
    }

    try:
        sio.emit('online_users_update', payload, room=room)
        return True
    except Exception as e:
        logger.warning('emit_online_users_diff failed: %s', e, exc_info=True)
        return False
