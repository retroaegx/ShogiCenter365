from flask import Blueprint, current_app, request
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from bson import ObjectId, json_util
from datetime import datetime, timedelta
from src.utils.clock import epoch_ms, epoch_s
import logging, json, re
import secrets
import asyncio
from src.config import TIME_CONTROLS
from src.utils.maintenance_mode import is_maintenance_enabled, maintenance_message
from src.services.online_users_emitter import emit_online_users_diff
import re

# ---- async bridge for sync Flask view ----
def _run_coro(coro):
    # Flask is running in sync mode; create a fresh event loop to run the coroutine.
    return asyncio.run(coro)


# Resolve username for a given user_id using DB.
#
# NOTE:
# Avoid Flask abort() in internal helpers so API routes can consistently return
# JSON payloads with error_code.
def _resolve_username_strict(db, user_id):
    try:
        from bson import ObjectId as _OID
        if not isinstance(user_id, _OID):
            try:
                user_id = _OID(str(user_id))
            except Exception:
                return None
        doc = db['users'].find_one({'_id': user_id}, {'username': 1}) or {}
        username = doc.get('username')
        if isinstance(username, str) and username.strip():
            return username.strip()
    except Exception:
        return None
    return None

# ---- rating resolver ----
def _get_user_rating(db, user_id):
    try:
        from bson import ObjectId as _OID
        if not isinstance(user_id, _OID):
            try:
                user_id = _OID(str(user_id))
            except Exception:
                return None
        u = db['users'].find_one({'_id': user_id}, {'rating': 1})
        if u is not None:
            r = u.get('rating')
            if isinstance(r, (int, float)):
                return int(r)
    except Exception:
        return None
    return None


def _is_banned_user(db, user_id) -> bool:
    """Return True if user is banned.

    user_id must be ObjectId (preferred) or convertible.
    """
    try:
        from bson import ObjectId as _OID
        if not isinstance(user_id, _OID):
            try:
                user_id = _OID(str(user_id))
            except Exception:
                return False
        doc = db['users'].find_one({'_id': user_id}, {'is_banned': 1}) or {}
        return bool(doc.get('is_banned'))
    except Exception:
        return False


def _parse_int(val, default=None, min_value=None, max_value=None):
    """Best-effort int parser with optional clamp."""
    if val is None:
        return default
    try:
        if isinstance(val, bool):
            return default
        if isinstance(val, (int, float)):
            n = int(val)
        else:
            s = str(val).strip()
            if s == '':
                return default
            n = int(float(s))
        if min_value is not None and n < min_value:
            n = min_value
        if max_value is not None and n > max_value:
            n = max_value
        return n
    except Exception:
        return default


# rating range (±) allowed values: 100〜400, 50刻み

def _inviter_profile(db, user_id):
    # Return minimal public profile for invite display.
    try:
        u = db['users'].find_one({'_id': user_id}, {'username': 1, 'rating': 1, 'user_kind': 1, 'is_guest': 1, 'legion': 1})
        if not u:
            return {'user_id': str(user_id), 'username': '—'}
        username = u.get('username') or '—'
        rating = u.get('rating')
        uk = u.get('user_kind')
        if isinstance(uk, str):
            uk = uk.strip()
        else:
            uk = ''
        if not uk:
            uk = 'guest' if bool(u.get('is_guest')) else 'human'
        legion = u.get('legion')
        if isinstance(legion, str):
            legion = legion.strip().upper()
        else:
            legion = ''
        if not legion:
            legion = 'JP'
        return {
            'user_id': str(u.get('_id')),
            'username': username,
            'rating': rating,
            'user_kind': uk,
            'is_guest': bool(u.get('is_guest')),
            'legion': legion,
        }
    except Exception:
        return {'user_id': str(user_id), 'username': '—'}

def _normalize_rating_range(val):
    rr = _parse_int(val, default=None, min_value=0, max_value=9999)
    if rr is None:
        return None
    if rr < 100 or rr > 400:
        return None
    if rr % 50 != 0:
        return None
    return rr

lobby_bp = Blueprint('lobby', __name__, url_prefix='/api/lobby')
logger = logging.getLogger(__name__)


# ---- time control helpers (server-authoritative) ----

def _normalize_lang_code(v: str | None, default: str = 'en') -> str:
    try:
        s = str(v or '').strip().lower()
    except Exception:
        s = ''
    if not s:
        return default
    # Normalize common aliases / locale tags.
    # Examples: "ja-JP" -> "ja", "pt-BR" -> "pt"
    base = s.split('-', 1)[0].split('_', 1)[0]
    if base == 'jp':
        base = 'ja'
    if base == 'cn':
        base = 'zh'

    supported = {'ja', 'en', 'zh', 'fr', 'de', 'pl', 'it', 'pt'}
    return base if base in supported else default


def _get_request_lang(default: str = 'en') -> str:
    try:
        q = request.args.get('lang') or request.args.get('language')
        if q:
            return _normalize_lang_code(q, default=default)
        h = request.headers.get('X-Shogi-Lang') or request.headers.get('X-Language')
        if h:
            return _normalize_lang_code(h, default=default)
    except Exception:
        pass
    return default


def _tc_label(meta: dict, *, lang: str, field: str) -> str:
    """Get localized label from TIME_CONTROLS meta.

    TIME_CONTROLS entries may optionally have:
      - labels: {lang: {name, display}}
    """
    try:
        labels = meta.get('labels') if isinstance(meta, dict) else None
        if isinstance(labels, dict):
            lang_map = labels.get(lang) or labels.get('en') or labels.get('ja')
            if isinstance(lang_map, dict):
                v = lang_map.get(field)
                if isinstance(v, str):
                    return v
    except Exception:
        pass
    try:
        v2 = meta.get(field) if isinstance(meta, dict) else None
        if isinstance(v2, str):
            return v2
    except Exception:
        pass
    return ''
# Accept labels like 「早指」「早指2」, display strings like 「15分」, codes like "15min"/"hayasashi", or numbers
_TIME_LABEL_TO_CODE = {}
for code, meta in (TIME_CONTROLS or {}).items():
    nm = meta.get('name')
    disp = meta.get('display')
    if nm: _TIME_LABEL_TO_CODE[nm] = code
    if disp: _TIME_LABEL_TO_CODE[disp] = code
# common aliases
_TIME_LABEL_TO_CODE.update({
    '早指': 'hayasashi', '早指2': 'hayasashi2', '早指3': 'hayasashi3',
    '15分': '15min', '30分': '30min',
})

def _normalize_time_code(val, fallback_minutes=None):
    """
    Normalize client-provided time into canonical code key defined in Config.TIME_CONTROLS.
    Accepts explicit codes, Japanese labels, display strings, or integers (minutes).
    """
    try:
        if val is None and fallback_minutes is None:
            return None
        # already a code
        if isinstance(val, str):
            s = val.strip()
            if s in TIME_CONTROLS:
                return s
            # label/display to code
            if s in _TIME_LABEL_TO_CODE:
                return _TIME_LABEL_TO_CODE[s]
            # "15", "15分", "m15"
            if s.startswith('m') and s[1:].isdigit():
                m = int(s[1:])
                # prefer 15min or 30min
                if m == 15: return '15min'
                if m == 30: return '30min'
                if m == 1: return 'hayasashi'
                if m == 2: return 'hayasashi2'
                if m == 3: return 'hayasashi3'
            ds = ''.join(ch for ch in s if ch.isdigit())
            if ds.isdigit():
                mi = int(ds)
                if mi == 15: return '15min'
                if mi == 30: return '30min'
                if mi == 1: return 'hayasashi'
                if mi == 2: return 'hayasashi2'
                if mi == 3: return 'hayasashi3'
        # numeric minutes
        if isinstance(val, (int, float)):
            mi = int(val)
            if mi == 15: return '15min'
            if mi == 30: return '30min'
            if mi == 1: return 'hayasashi'
            if mi == 2: return 'hayasashi2'
            if mi == 3: return 'hayasashi3'
        if fallback_minutes is not None:
            return _normalize_time_code(fallback_minutes, None)
    except Exception:
        pass
    return None

def _time_name_from_code(code):
    try:
        lang = _get_request_lang(default='en')
    except Exception:
        lang = 'en'
    meta = (TIME_CONTROLS or {}).get(code) or {}
    return _tc_label(meta, lang=lang, field='name') or str(code or '')


HEX24_RE = re.compile(r'^[0-9a-fA-F]{24}$')
PRESENCE_COLL = 'online_users'
INVITES_COLL = 'lobby_invites'

# ---- WebSocket notify helper (no circular import) ----
def _get_socketio():
    """Resolve SocketIO instance (extensions first, then app.config fallback)."""
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

def _notify_lobby(event: str, payload: dict|None=None):
    s = _get_socketio()
    if not s:
        logger.warning('socketio extension not available to emit %s', event)
        return
    try:
        s.emit(event, payload or {}, room='lobby')
    except Exception as e:
        logger.warning('notify failed: %s', e, exc_info=True)
def _user_room_name(user_id):
    try:
        s = str(user_id)
        if s.startswith("ObjectId("):
            s = s.split("'", 2)[1]
        return f"user:{s}"
    except Exception:
        return f"user:{user_id}"

def _emit_to_user(user_id, event, payload):
    s = _get_socketio()
    if not s or not user_id:
        return
    try:
        s.emit(event, payload or {}, room=_user_room_name(user_id))
    except Exception as e:
        logger.warning('emit_to_user failed: %s', e, exc_info=True)

def _emit_offer_update(payload, to_user_id=None, from_user_id=None):
    sio = _get_socketio()
    if not sio:
        return
    try:
        if to_user_id:
            room = _user_room_name(to_user_id)
            if room: sio.emit('lobby_offer_update', payload or {}, room=room)
        if from_user_id:
            room = _user_room_name(from_user_id)
            if room: sio.emit('lobby_offer_update', payload or {}, room=room)
    except Exception as e:
        try:
            logger.warning('_emit_offer_update failed: %s', e, exc_info=True)
        except Exception:
            pass

def _db():
    db = current_app.config.get('MONGO_DB')
    if db is None:
        raise RuntimeError('MONGO_DB is not configured on current_app')
    return db

def _now():
    return datetime.utcnow()

def _normalize_prev_waiting(val, default='lobby'):
    try:
        s = str(val or '').strip()
    except Exception:
        s = ''
    if s in ('', 'lobby'):
        return 'lobby'
    if s == 'seeking':
        return 'seeking'
    return default

def _restore_prev_waiting(db, user_id, default='lobby'):
    """Restore waiting status using pending_offer.prev_waiting if present."""
    try:
        doc = db[PRESENCE_COLL].find_one({'user_id': user_id}, {'pending_offer': 1}) or {}
        po = doc.get('pending_offer') or {}
        return _normalize_prev_waiting(po.get('prev_waiting'), default=default)
    except Exception:
        return default


def _json(obj, code=200):
    """JSON response helper.

    For forward-compatible i18n, attach error_code when an error-like response is returned.
    Existing clients can keep using `error` and/or `message`.

    Rules:
    - When HTTP status is >= 400, ensure `success: False` unless explicitly set.
    - Derive `error_code` from `error` / `code` / (code-like) `message` when missing.
    """
    try:
        if isinstance(obj, dict):
            is_error_http = isinstance(code, int) and code >= 400
            # Normalize success flag for error HTTP responses.
            if is_error_http and obj.get('success') is not True:
                obj.setdefault('success', False)

            # Attach error_code when we can.
            if (obj.get('success') is False or is_error_http) and 'error_code' not in obj:
                err = obj.get('error')
                cod = obj.get('code')
                msg = obj.get('message')
                if isinstance(err, str) and err:
                    obj['error_code'] = err
                elif isinstance(cod, str) and cod:
                    obj['error_code'] = cod
                elif isinstance(msg, str) and msg and re.match(r'^[A-Za-z0-9_]+$', msg):
                    # Only treat message as a code when it *looks* like one.
                    obj['error_code'] = msg
    except Exception:
        pass

    return current_app.response_class(
        json.dumps(obj, ensure_ascii=False, default=json_util.default),
        mimetype='application/json',
        status=code,
    )


def _id_to_objid(s):
    if isinstance(s, ObjectId):
        return s
    if not isinstance(s, str) or not HEX24_RE.match(s):
        return None
    try:
        return ObjectId(s)
    except Exception:
        return None

# waiting is a STRING status: 'lobby' | 'seeking' | 'pending' | 'playing'

# ----------------- routes -----------------


@lobby_bp.route('/online-users', methods=['GET'])
@jwt_required(optional=True)
def online_users():
    db = _db()

    # --- Build response ---
    cur = list(db[PRESENCE_COLL].find({}, {
        'user_id': 1, 'last_seen_at': 1, 'waiting': 1, 'waiting_info': 1, 'pending_offer': 1
    }))

    ids = [u.get('user_id') or u.get('_id') for u in cur]
    profiles = {d['_id']: d for d in db['users'].find({'_id': {'$in': [i for i in ids if i]}})}

    # map user_id ->現在対局中/感想戦中の game_id（観戦ボタン用）
    user_game_map = {}
    try:
        games_coll = db.get('games') if hasattr(db, 'get') else db['games']
        active_docs = games_coll.find(
            {'status': {'$in': ['active', 'ongoing', 'in_progress', 'started', 'pause', 'review']}},
            {'players': 1, 'sente_id': 1, 'gote_id': 1}
        )
        for g in active_docs:
            gid = g.get('_id')
            players = g.get('players') or {}
            def _uid(v):
                try:
                    from bson import ObjectId as _OID
                    if isinstance(v, _OID):
                        return v
                except Exception:
                    pass
                if isinstance(v, dict):
                    v = v.get('user_id') or v.get('id')
                return v
            s_uid = _uid((players.get('sente') or {}).get('user_id') or g.get('sente_id'))
            g_uid = _uid((players.get('gote') or {}).get('user_id') or g.get('gote_id'))
            if s_uid:
                user_game_map[s_uid] = str(gid)
            if g_uid:
                user_game_map[g_uid] = str(gid)
    except Exception:
        user_game_map = {}
    res = []
    for u in cur:
        wi = (u.get('waiting_info') or {}).copy()
        # time_code/time_name
        time_code = wi.get('time_code') or _normalize_time_code(wi.get('time_control'))
        if time_code:
            wi['time_code'] = time_code
            wi['time_name'] = _time_name_from_code(time_code)
        uid = u.get('user_id') or u.get('_id')
        prof = profiles.get(uid) or {}
        username = prof.get('username') or 'unknown'
        rating = int(prof.get('rating') or 0)

        # derive kind/legion/guest flag from profile
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

        # Keep waiting_info consistent with latest profile (rating may change).
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
        res.append({
            'user_id': uid,
            'current_game_id': user_game_map.get(uid),
            'username': username,
            'rating': rating,
            'user_kind': user_kind,
            'legion': legion,
            'is_guest': is_guest,
            'last_seen_at': u.get('last_seen_at'),
            'waiting': u.get('waiting', 'lobby'),
            'waiting_info': wi,
            'pending_offer': u.get('pending_offer') or {}
        })
    return _json({'users': res, 'count': len(res)}, 200)
@lobby_bp.route('/waiting/start', methods=['POST'])
@jwt_required()
def waiting_start():
    try:
        db = _db()
        sub = get_jwt_identity()
        me = _id_to_objid(sub)
        if not me:
            return _json({'error': 'invalid_identity'}, 400)

        # ban guard (receiver)
        if _is_banned_user(db, me):
            try:
                now2 = _now()
                db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {'waiting': 'lobby', 'waiting_info': {}, 'pending_offer': {}, 'last_seen_at': now2}})
            except Exception:
                pass
            return _json({'error': 'banned'}, 403)

        # maintenance mode guard
        if is_maintenance_enabled(db):
            return _json({'success': False, 'error': 'maintenance_mode', 'message': maintenance_message(db)}, 503)

        payload = request.get_json(silent=True) or {}
        raw_tc = payload.get('time_code') or payload.get('time_control') or payload.get('time_minutes')
        time_code = _normalize_time_code(raw_tc, 15)

        users_coll = db['users']
        username = ''
        rating = 0
        try:
            udoc = users_coll.find_one({'_id': me}) if users_coll is not None else None
            if udoc:
                if bool(udoc.get('is_banned')):
                    return _json({'error': 'banned'}, 403)
                username = udoc.get('username') or udoc.get('name') or ''
                rating = int(udoc.get('rating') or udoc.get('rate') or 0)
        except Exception:
            pass

        # rating range (±). None means "no limit".
        raw_range = payload.get('rating_range')
        if raw_range is None:
            raw_range = payload.get('rate_span')
        if raw_range is None:
            raw_range = payload.get('rateSpan')
        rating_range = None
        if raw_range is not None and not (isinstance(raw_range, str) and raw_range.strip() == ''):
            rating_range = _normalize_rating_range(raw_range)
            if rating_range is None:
                return _json({'error': 'invalid_rating_range', 'allowed_min': 100, 'allowed_max': 400, 'step': 50}, 400)
        rating_min = None
        rating_max = None
        if rating_range is not None and isinstance(rating, int):
            rating_min = int(rating) - int(rating_range)
            rating_max = int(rating) + int(rating_range)

        # game type (rated/free)
        gt_raw = payload.get('game_type')
        if gt_raw is None:
            gt_raw = payload.get('gameType')
        game_type = str(gt_raw or 'rating').strip().lower()
        if game_type not in ('rating', 'free'):
            game_type = 'rating'

        # reserved-wait flag (先約待ち) - display only
        reserved = bool(payload.get('reserved') or payload.get('reserved_wait') or payload.get('has_reservation') or payload.get('reservation'))

        # handicap (free only)
        h_enabled = bool(payload.get('handicap_enabled') or payload.get('handicapEnabled') or payload.get('handicap'))
        h_type_raw = payload.get('handicap_type')
        if h_type_raw is None:
            h_type_raw = payload.get('handicapType')
        try:
            from src.utils.handicap import normalize_handicap_type
            h_type = normalize_handicap_type(h_type_raw)
        except Exception:
            h_type = None
        if game_type != 'free':
            h_enabled = False
            h_type = None
        if not h_enabled:
            h_type = None
        if h_enabled and not h_type:
            return _json({'error': 'invalid_handicap_type'}, 400)

        waiting_info = {
            'username': username,
            'rating': rating,
            'time_code': time_code,
            'game_type': game_type,
            'reserved': bool(reserved),
            'handicap_enabled': bool(h_enabled),
            'handicap_type': h_type,
            'rating_range': rating_range,
            'rating_min': rating_min,
            'rating_max': rating_max,
        }

        set_fields = {
            'waiting': 'seeking',
            'auto_decline_streak': 0,
            'late_cancel_streak': 0,
            'waiting_info': waiting_info,
            'pending_offer': {},
            'last_seen_at': _now(),
            'user_id': me,
        }
        db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': set_fields}, upsert=True)
        emit_online_users_diff(db, changed_user_ids=[me])
        return _json({'success': True, 'waiting': 'seeking', 'waiting_info': waiting_info}, 200)
    except Exception as e:
        logger.error(f'/waiting/start failed: {e}', exc_info=True)
        return _json({'error': 'waiting_start_failed'}, 500)

@lobby_bp.route('/waiting/stop', methods=['POST'])
@jwt_required()
def waiting_stop():
    db = _db()
    sub = get_jwt_identity()
    me = _id_to_objid(sub)
    if not me:
        return _json({'error': 'invalid_identity'}, 400)

    db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {
        'waiting': 'lobby',
        'auto_decline_streak': 0,
        'late_cancel_streak': 0,
        'waiting_info': {},
        'pending_offer': {},
        'last_seen_at': _now(),
    }})

    emit_online_users_diff(db, changed_user_ids=[me])
    return _json({'success': True}, 200)


@lobby_bp.route('/join-by-user', methods=['POST'])
@jwt_required()
def join_by_user():
    db = _db()
    sub = get_jwt_identity()
    me = _id_to_objid(sub)
    if not me:
        return _json({'error': 'invalid_identity'}, 400)

    # maintenance mode guard
    if is_maintenance_enabled(db):
        return _json({'success': False, 'error': 'maintenance_mode', 'message': maintenance_message(db)}, 503)

    # --- guard: self must be in lobby or empty to send offers ---
    try:
        my_presence = db[PRESENCE_COLL].find_one({'user_id': me}, {'waiting': 1}) or {}
        my_waiting = str(my_presence.get('waiting') or '').strip()
    except Exception:
        return _json({'error': 'presence_lookup_failed'}, 500)
    if my_waiting not in ('lobby', '', 'seeking'):
        return _json({'error': 'self_not_in_lobby'}, 409)

    body = request.get_json(silent=True) or {}
    opp_str = body.get('opponent_user_id')
    opp = _id_to_objid(opp_str)
    if not opp:
        return _json({'error': 'invalid_opponent'}, 400)
    if opp == me:
        return _json({'error': 'self_request_not_allowed'}, 409)

    # banned opponent cannot be challenged
    try:
        oprof = db['users'].find_one({'_id': opp}, {'is_banned': 1}) or {}
        if bool(oprof.get('is_banned')):
            return _json({'error': 'opponent_banned'}, 409)
    except Exception:
        pass

    # --- sender profile (authoritative rating/username) ---
    me_doc = db['users'].find_one({'_id': me}, {'username': 1, 'rating': 1, 'is_banned': 1, 'user_kind': 1, 'is_guest': 1, 'legion': 1})
    if not me_doc:
        return _json({'error': 'self_not_found'}, 404)
    if bool(me_doc.get('is_banned')):
        return _json({'error': 'banned'}, 403)
    if not me_doc.get('username'):
        return _json({'error': 'sender_profile_incomplete', 'field': 'username'}, 409)
    if me_doc.get('rating') is None:
        return _json({'error': 'sender_profile_incomplete', 'field': 'rating'}, 409)
    sender_rating = int(me_doc.get('rating') or 0)
    me_user_kind = me_doc.get('user_kind')
    if isinstance(me_user_kind, str):
        me_user_kind = me_user_kind.strip()
    else:
        me_user_kind = ''
    if not me_user_kind:
        me_user_kind = 'guest' if bool(me_doc.get('is_guest')) else 'human'

    # --- receiver must be seeking ---
    # If opponent is banned, do not allow sending offers.
    try:
        if _is_banned_user(db, opp):
            return _json({'error': 'opponent_banned'}, 409)
    except Exception:
        pass

    opp_presence = db[PRESENCE_COLL].find_one({'user_id': opp}) or {}
    if opp_presence.get('waiting') != 'seeking':
        return _json({'error': 'opponent_not_waiting'}, 409)

    wi = (opp_presence.get('waiting_info') or {})
    game_type = wi.get('game_type')
    if game_type not in ('rating', 'free'):
        return _json({'error': 'opponent_waiting_info_invalid', 'field': 'game_type'}, 409)

    # --- challenge restriction (Shogi Club 24 rule) ---
    # Rated games only: cannot challenge someone >=400 below you.
    receiver_rating = _get_user_rating(db, opp)
    if receiver_rating is None:
        receiver_rating = _parse_int(wi.get('rating'), default=None)
    if game_type == 'rating' and receiver_rating is not None and (int(sender_rating) - int(receiver_rating)) >= 400:
        try:
            _emit_offer_update({
                'type': 'offer_status',
                'status': 'declined',
                'reason': 'rating_gap_too_large',
                'limit': 400,
                'your_rating': int(sender_rating),
                'opponent_rating': int(receiver_rating),
            }, from_user_id=me)
        except Exception:
            pass
        return _json({
            'error': 'rating_gap_too_large',
            'limit': 400,
            'your_rating': int(sender_rating),
            'opponent_rating': int(receiver_rating),
        }, 409)

    # --- rating range check (receiver side) ---
    rr = _normalize_rating_range(wi.get('rating_range'))
    if rr is not None:
        # Prefer stored min/max; otherwise derive from latest receiver rating.
        r_min = _parse_int(wi.get('rating_min'), default=None)
        r_max = _parse_int(wi.get('rating_max'), default=None)
        if r_min is None or r_max is None:
            # Derive from receiver's current rating if available.
            if receiver_rating is None:
                receiver_rating = _get_user_rating(db, opp)
                if receiver_rating is None:
                    receiver_rating = _parse_int(wi.get('rating'), default=None)
            if receiver_rating is not None:
                r_min = int(receiver_rating) - int(rr)
                r_max = int(receiver_rating) + int(rr)
        if r_min is not None and r_max is not None and (sender_rating < int(r_min) or sender_rating > int(r_max)):
            # "Auto decline" (notify requester) without changing receiver state.
            try:
                _emit_offer_update({
                    'type': 'offer_status',
                    'status': 'declined',
                    'reason': 'rating_out_of_range',
                    'allowed_min': int(r_min),
                    'allowed_max': int(r_max),
                }, from_user_id=me)
            except Exception:
                pass
            return _json({
                'error': 'rating_out_of_range',
                'allowed_min': int(r_min),
                'allowed_max': int(r_max),
                'your_rating': int(sender_rating),
            }, 409)

    # ---- strict validation & normalized time control (server-authoritative) ----
    time_code_in = body.get('time_code')
    if not time_code_in:
        return _json({'error': 'time_code_required'}, 400)
    time_code = _normalize_time_code(time_code_in, None) or _normalize_time_code(time_code_in, wi.get('time_control'))
    if not time_code:
        return _json({'error': 'invalid_time_code'}, 400)

    now = _now()
    now_ms = epoch_ms()

    # --- transition state (race-safe) ---
    res_opp = db[PRESENCE_COLL].update_one(
        {'user_id': opp, 'waiting': 'seeking'},
        {'$set': {'waiting': 'applying', 'last_seen_at': now}}
    )
    if res_opp.matched_count != 1:
        return _json({'error': 'opponent_not_waiting'}, 409)

    # applicant becomes applying (best-effort)
    try:
        db[PRESENCE_COLL].update_one(
            {'user_id': me, 'waiting': {'$in': ['lobby', '', 'seeking']}},
            {'$set': {'waiting': 'applying', 'last_seen_at': now}},
            upsert=True
        )
    except Exception:
        pass

    # Resolve receiver username for outgoing UI convenience (best-effort)
    opp_user = db['users'].find_one({'_id': opp}, {'username': 1}) or {}
    opp_username = opp_user.get('username')

    # Persist minimal pending_offer for both sides
    try:
        db[PRESENCE_COLL].update_one(
            {'user_id': opp},
            {'$set': {'pending_offer': {
                'from_user_id': str(me),
                'from_username': me_doc.get('username'),
                'time_code': time_code,
                'created_at': now_ms,
            }}},
            upsert=True
        )
    except Exception:
        pass
    try:
        db[PRESENCE_COLL].update_one(
            {'user_id': me},
            {'$set': {
                'waiting': 'applying',
                'pending_offer': {
                    'to_user_id': str(opp),
                    'to_username': opp_username,
                    'time_code': time_code,
                    'created_at': now_ms,
                    'prev_waiting': my_waiting,
                },
                'last_seen_at': now,
            }},
            upsert=True
        )
    except Exception:
        pass

    payload = {
        'type': 'offer_created',
        'from_user_id': str(me),
        'to_user_id': str(opp),
        'game_type': game_type,
        'time_code': time_code,
        'time_name': _time_name_from_code(time_code),
        'from_username': me_doc.get('username'),
        'from_rating': int(sender_rating),
        'from_user_kind': me_user_kind,
        'requested_game_type': game_type,
    }

    _emit_offer_update(payload, to_user_id=opp, from_user_id=me)
    return _json({'success': True}, 200)







@lobby_bp.route('/offer/accept', methods=['POST'])
@jwt_required()
def offer_accept():
    try:
        db = _db()
        sub = get_jwt_identity()
        me = _id_to_objid(sub)
        if not me:
            return _json({'error': 'invalid_identity'}, 400)

        # ban guard (receiver)
        if _is_banned_user(db, me):
            try:
                now2 = _now()
                db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {'waiting': 'lobby', 'waiting_info': {}, 'pending_offer': {}, 'last_seen_at': now2}})
            except Exception:
                pass
            return _json({'error': 'banned'}, 403)

        # maintenance mode guard
        if is_maintenance_enabled(db):
            return _json({'success': False, 'error': 'maintenance_mode', 'message': maintenance_message(db)}, 503)

        me_doc = db[PRESENCE_COLL].find_one({'user_id': me})
        if not me_doc:
            return _json({'error': 'self_not_found'}, 404)

        offer = (me_doc.get('pending_offer') or {}).copy()
        wi = (me_doc.get('waiting_info') or {}).copy()

        try:
            tc_in = offer.get('time_code') or wi.get('time_code') or wi.get('timeCode') or wi.get('time_control')
            time_code = _normalize_time_code(tc_in, wi.get('time_control'))
        except Exception:
            time_code = (offer.get('time_code') or wi.get('time_code') or '15min')

        from_uid = _id_to_objid(offer.get('from_user_id'))
        if not from_uid:
            return _json({'error': 'invalid_from_user'}, 400)

        # ban guard (sender)
        if _is_banned_user(db, from_uid):
            try:
                now2 = _now()
                db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {'waiting': 'seeking', 'pending_offer': {}, 'last_seen_at': now2}})
                db[PRESENCE_COLL].update_one({'user_id': from_uid}, {'$set': {'waiting': _restore_prev_waiting(db, from_uid, default='lobby'), 'pending_offer': {}, 'last_seen_at': now2}})
            except Exception:
                pass
            return _json({'error': 'opponent_banned'}, 409)

        # --- game type (rated/free) ---
        game_type = (wi.get('game_type') or 'rating')
        if game_type not in ('rating', 'free'):
            game_type = 'rating'

        # --- re-check receiver's rating range at accept time (defense in depth) ---
        try:
            rr = _normalize_rating_range(wi.get('rating_range'))
            if rr is not None:
                recv_rating = _get_user_rating(db, me)
                if recv_rating is None:
                    recv_rating = _parse_int(wi.get('rating'), default=0)
                r_min = _parse_int(wi.get('rating_min'), default=None)
                r_max = _parse_int(wi.get('rating_max'), default=None)
                if r_min is None or r_max is None:
                    r_min = int(recv_rating) - int(rr)
                    r_max = int(recv_rating) + int(rr)
                sender_rating = _get_user_rating(db, from_uid)
                if sender_rating is None:
                    sender_rating = 0
                if int(sender_rating) < int(r_min) or int(sender_rating) > int(r_max):
                    # reset both sides (auto decline)
                    now2 = _now()
                    db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {
                        'waiting': 'seeking',
                        'pending_offer': {},
                        'last_seen_at': now2,
                    }})
                    db[PRESENCE_COLL].update_one({'user_id': from_uid}, {'$set': {
                        'waiting': _restore_prev_waiting(db, from_uid, default='lobby'),
                        'pending_offer': {},
                        'last_seen_at': now2,
                    }})
                    payload = {
                        'type': 'offer_status',
                        'status': 'declined',
                        'reason': 'rating_out_of_range',
                        'allowed_min': int(r_min),
                        'allowed_max': int(r_max),
                        'from_user_id': str(from_uid),
                        'to_user_id': str(me),
                    }
                    try:
                        _emit_offer_update(payload, to_user_id=me, from_user_id=from_uid)
                    except Exception:
                        pass
                    emit_online_users_diff(db, changed_user_ids=[me, from_uid])
                    return _json({
                        'error': 'rating_out_of_range',
                        'allowed_min': int(r_min),
                        'allowed_max': int(r_max),
                        'your_rating': int(sender_rating),
                    }, 409)
        except Exception:
            pass

        # --- re-check challenge restriction (defense in depth) ---
        try:
            if game_type == 'rating':
                recv_rating = _get_user_rating(db, me)
                if recv_rating is None:
                    recv_rating = _parse_int(wi.get('rating'), default=None)
                sender_rating2 = _get_user_rating(db, from_uid)
                if sender_rating2 is None:
                    sender_rating2 = None
                if recv_rating is not None and sender_rating2 is not None and (int(sender_rating2) - int(recv_rating)) >= 400:
                    now2 = _now()
                    db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {
                        'waiting': 'seeking',
                        'pending_offer': {},
                        'last_seen_at': now2,
                    }})
                    db[PRESENCE_COLL].update_one({'user_id': from_uid}, {'$set': {
                        'waiting': _restore_prev_waiting(db, from_uid, default='lobby'),
                        'pending_offer': {},
                        'last_seen_at': now2,
                    }})
                    payload = {
                        'type': 'offer_status',
                        'status': 'declined',
                        'reason': 'rating_gap_too_large',
                        'limit': 400,
                        'from_user_id': str(from_uid),
                        'to_user_id': str(me),
                    }
                    try:
                        _emit_offer_update(payload, to_user_id=me, from_user_id=from_uid)
                    except Exception:
                        pass
                    emit_online_users_diff(db, changed_user_ids=[me, from_uid])
                    return _json({
                        'error': 'rating_gap_too_large',
                        'limit': 400,
                        'your_rating': int(sender_rating2),
                        'opponent_rating': int(recv_rating),
                    }, 409)
        except Exception:
            pass

        import random
        from_doc = db[PRESENCE_COLL].find_one({'user_id': from_uid}) or {}
        from_username = from_doc.get('username') if isinstance(from_doc.get('username'), str) and from_doc.get('username').strip() else None
        me_username = me_doc.get('username') if isinstance(me_doc.get('username'), str) and me_doc.get('username').strip() else None

        if not from_username:
            from_username = _resolve_username_strict(_db(), from_uid)
        if not me_username:
            me_username = _resolve_username_strict(_db(), me)

        if not from_username or not me_username:
            # Keep API JSON contract (no Flask abort -> HTML).
            return _json({'success': False, 'error': 'username_missing', 'message': 'username_missing'}, 409)

        # --- handicap / role assignment (host=receiver=me is treated as 上手) ---
        handicap_enabled = False
        handicap_type = None
        try:
            handicap_enabled = bool(wi.get('handicap_enabled') or wi.get('handicapEnabled'))
            raw_ht = wi.get('handicap_type') or wi.get('handicapType')
            from src.utils.handicap import normalize_handicap_type
            handicap_type = normalize_handicap_type(raw_ht)
        except Exception:
            handicap_enabled = False
            handicap_type = None

        if game_type != 'free':
            handicap_enabled = False
            handicap_type = None
        if not handicap_enabled:
            handicap_type = None

        upper_role = None
        if handicap_enabled and handicap_type:
            if handicap_type == 'even_lower_first':
                # 平手（下位者先手）:
                #   - 待機開始者（上手）は後手固定
                #   - 申込者（下手）が先手
                sente = {'user_id': str(from_uid), 'username': from_username}
                gote  = {'user_id': str(me),       'username': me_username}
                my_role = 'gote'
                upper_role = 'gote'
            else:
                # 駒落ち: 原則として上手（待機開始者）が先手
                sente = {'user_id': str(me),       'username': me_username}
                gote  = {'user_id': str(from_uid), 'username': from_username}
                my_role = 'sente'
                upper_role = 'sente'
        else:
            if random.random() < 0.5:
                sente = {'user_id': str(from_uid), 'username': from_username}
                gote  = {'user_id': str(me),       'username': me_username}
                my_role = 'gote'
            else:
                sente = {'user_id': str(me),       'username': me_username}
                gote  = {'user_id': str(from_uid), 'username': from_username}
                my_role = 'sente'

        tc_meta = (TIME_CONTROLS or {}).get(time_code) or {}

        # Build multi-bucket time controls (ms)
        init_ms = max(0, int(tc_meta.get('initial_time') or 0))   * 1000
        byo_ms  = max(0, int(tc_meta.get('byoyomi_time') or 0))   * 1000
        inc_ms  = max(0, int(tc_meta.get('increment') or 0))      * 1000
        def_ms  = max(0, int(tc_meta.get('deferment_time') or 0)) * 1000

        time_state = {
            'config': {
                'initial_ms':   init_ms,
                'byoyomi_ms':   byo_ms,
                'increment_ms': inc_ms,
                'deferment_ms': def_ms,
            },
            'sente': {'initial_ms': init_ms, 'byoyomi_ms': byo_ms, 'deferment_ms': def_ms},
            'gote':  {'initial_ms': init_ms, 'byoyomi_ms': byo_ms, 'deferment_ms': def_ms},
            'base_at': epoch_ms(),
            'current_player': 'sente',
        }
        # Canonical: store only SFEN (no board arrays / no captured arrays).
        # start_sfen is kept so we can reconstruct review/analysis from USI move list.
        from src.services.game_service import DEFAULT_START_SFEN
        start_sfen = DEFAULT_START_SFEN
        # Apply handicap by removing pieces from the upper player's side (free games only).
        try:
            if handicap_enabled and handicap_type and handicap_type != 'even_lower_first':
                from src.utils.handicap import apply_handicap_to_sfen
                start_sfen = apply_handicap_to_sfen(start_sfen, upper_role=(upper_role or 'sente'), handicap_type=handicap_type) or start_sfen
        except Exception:
            pass
        sfen = start_sfen

        from src.models.database import DatabaseManager
        dm = getattr(current_app, 'db_manager', None)
        if dm is None:
            current_app.logger.error('db_manager is not configured (startup DI failed)')
            return _json({'success': False, 'error': 'db_manager_not_configured', 'message': 'db_manager_not_configured'}, 500)
        gm = dm.get_game_model()

        
        # attach ratings to players for frontend display
        try:
            _dbi = _db()
            if isinstance(sente, dict):
                r = _get_user_rating(_dbi, sente.get('user_id'))
                if r is not None:
                    sente['rating'] = r
            if isinstance(gote, dict):
                r = _get_user_rating(_dbi, gote.get('user_id'))
                if r is not None:
                    gote['rating'] = r
        except Exception:
            pass
        game_data = {
            "game_type": game_type,
            "handicap": (
                {
                    "enabled": True,
                    "type": handicap_type,
                    "host_user_id": str(me),
                    "upper_role": upper_role,
                } if (handicap_enabled and handicap_type) else None
            ),
            "players": {"sente": sente, "gote": gote},
            "status": "active",
            "current_turn": "sente",
            "start_sfen": start_sfen,
            "sfen": sfen,
            "move_history": [],
            "spectators": [],
            "chat_messages": [],
            "time_state": time_state,
        }
        game_id = _run_coro(gm.create_game(game_data))
        # schedule first deadline right after game creation (no moves yet)
        try:
            gs = current_app.config.get('GAME_SERVICE')
            scheduler = current_app.config.get('TIMEOUT_SCHEDULER')
            if gs and scheduler and game_id:
                doc = gs.get_game_by_id(game_id)
                if doc:
                    scheduler.schedule_for_game_doc(doc)
        except Exception:
            current_app.logger.warning('initial timeout schedule failed', exc_info=True)
  # sync call

        db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {
            'waiting': 'playing',
            'auto_decline_streak': 0,
            'late_cancel_streak': 0,
            'waiting_info': {},
            'pending_offer': {},
            'last_seen_at': _now(),
        }})
        db[PRESENCE_COLL].update_one({'user_id': from_uid}, {'$set': {
            'waiting': 'playing',
            'late_cancel_streak': 0,
            'waiting_info': {},
            'pending_offer': {},
            'last_seen_at': _now(),
        }})

        payload = {'type': 'offer_status', 'status': 'accepted', 'game_id': game_id}
        try:
            _emit_offer_update(payload, to_user_id=me, from_user_id=from_uid)
        except Exception:
            pass
        emit_online_users_diff(db, changed_user_ids=[me, from_uid])
        return _json({'success': True, 'game_id': game_id, 'role': my_role}, 200)

    except Exception as e:
        logger.error(f'/offer/accept failed: {e}', exc_info=True)
        return _json({'error': 'offer_accept_failed'}, 500)



@lobby_bp.route('/offer/decline', methods=['POST'])
@jwt_required()
def offer_decline():
    db = _db()
    sub = get_jwt_identity()
    me = _id_to_objid(sub)
    if not me:
        return _json({'error': 'invalid_identity'}, 400)

    # try to fetch from_user_id from my pending_offer
    me_doc = db[PRESENCE_COLL].find_one({'user_id': me}) or {}
    po = (me_doc.get('pending_offer') or {})
    from_uid = _id_to_objid(po.get('from_user_id'))
    # reset me (receiver)
    db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {
        'waiting': 'seeking',
        'auto_decline_streak': 0,
        'late_cancel_streak': 0,
        'pending_offer': {},
        'last_seen_at': _now(),
    }})
    # reset sender if known
    if from_uid:
        db[PRESENCE_COLL].update_one({'user_id': from_uid}, {'$set': {
            'waiting': _restore_prev_waiting(db, from_uid, default='lobby'),
            'late_cancel_streak': 0,
            'pending_offer': {},
            'last_seen_at': _now(),
        }})
    # notify both
    payload = {'type': 'offer_status', 'status': 'declined', 'to_user_id': str(me), 'from_user_id': (str(from_uid) if from_uid else None)}
    try:
        _emit_offer_update(payload, to_user_id=me, from_user_id=from_uid if from_uid else None)
    except Exception:
        pass
    emit_online_users_diff(db, changed_user_ids=[me] + ([from_uid] if from_uid else []))
    return _json({'success': True}, 200)



@lobby_bp.route('/offer/cancel', methods=['POST'])
@jwt_required()
def offer_cancel():
    db = _db()
    sub = get_jwt_identity()
    me = _id_to_objid(sub)
    if not me:
        return _json({'error': 'invalid_identity'}, 400)

    me_doc = db[PRESENCE_COLL].find_one({'user_id': me}) or {}
    po = (me_doc.get('pending_offer') or {})

    # guards: cannot cancel if already playing or no matching pending offer
    if me_doc.get('waiting') == 'playing':
        return _json({'error': 'already_playing'}, 409)

    to_uid = _id_to_objid(po.get('to_user_id')) if po.get('to_user_id') else None
    if not to_uid:
        return _json({'error': 'no_pending_offer'}, 409)

    opp_doc = db[PRESENCE_COLL].find_one({'user_id': to_uid}) or {}
    if opp_doc.get('waiting') == 'playing':
        return _json({'error': 'already_started'}, 409)

    opp_po = (opp_doc.get('pending_offer') or {})
    if _id_to_objid(opp_po.get('from_user_id')) != me:
        return _json({'error': 'not_applicant'}, 409)

    # reset me (applicant)
    db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {
        'waiting': _normalize_prev_waiting(po.get('prev_waiting'), default='lobby'),
        'pending_offer': {},
        'last_seen_at': _now(),
    }})

    # reset opponent if known
    late_cancel_limit_hit = False
    if to_uid:
        now_dt = _now()
        now_ms = epoch_ms()
        created_raw = po.get('created_at')
        try:
            created_ms = int(created_raw)
        except Exception:
            created_ms = 0
        elapsed_ms = max(0, now_ms - created_ms) if created_ms > 0 else 0
        is_late_cancel = elapsed_ms >= 4000

        if is_late_cancel:
            tdoc = db[PRESENCE_COLL].find_one({'user_id': to_uid}, {'late_cancel_streak': 1, 'waiting': 1}) or {}
            streak = int(tdoc.get('late_cancel_streak') or 0) + 1
            if streak >= 5:
                late_cancel_limit_hit = True
                db[PRESENCE_COLL].update_one({'user_id': to_uid}, {'$set': {
                    'waiting': 'lobby',
                    'waiting_info': {},
                    'pending_offer': {},
                    'auto_decline_streak': 0,
                    'late_cancel_streak': 0,
                    'last_seen_at': now_dt,
                }})
                try:
                    sio = _get_socketio()
                    if sio:
                        room = _user_room_name(to_uid)
                        if room:
                            sio.emit('lobby_offer_update', {'type': 'late_cancel_limit'}, room=room)
                except Exception:
                    pass
            else:
                db[PRESENCE_COLL].update_one({'user_id': to_uid}, {'$set': {
                    'waiting': 'seeking',
                    'pending_offer': {},
                    'late_cancel_streak': int(streak),
                    'last_seen_at': now_dt,
                }})
        else:
            db[PRESENCE_COLL].update_one({'user_id': to_uid}, {'$set': {
                'waiting': 'seeking',
                'pending_offer': {},
                'last_seen_at': now_dt,
            }})

    # notify both as declined/cancelled
    payload = {'type': 'offer_status', 'status': 'declined', 'from_user_id': str(me), 'to_user_id': (str(to_uid) if to_uid else None)}
    try:
        _emit_offer_update(payload, to_user_id=to_uid if to_uid else None, from_user_id=me)
    except Exception:
        pass
    emit_online_users_diff(db, changed_user_ids=[me] + ([to_uid] if to_uid else []))
    return _json({'success': True}, 200)

@lobby_bp.route('/touch', methods=['POST'])
@jwt_required()
def touch():
    db = _db()
    me = _id_to_objid(get_jwt_identity())
    if not me:
        return _json({'error': 'invalid_identity'}, 400)
    force = str(request.args.get('force') or '').strip()
    res = db[PRESENCE_COLL].update_one(
        {'user_id': me},
        {
            '$set': {
                'user_id': me,
                'last_seen_at': _now(),
            },
            '$setOnInsert': {
                'waiting': 'lobby',
                'waiting_info': {},
                'pending_offer': {},
            },
        },
        upsert=True
    )

    # 他ユーザー側へ: ログイン(初回upsert)やforce=1のときは差分を通知する
    try:
        inserted = getattr(res, 'upserted_id', None) is not None
    except Exception:
        inserted = False
    if inserted or force == '1':
        emit_online_users_diff(db, changed_user_ids=[me])

    # 残り有効時間を確認して、5分以内なら新しいトークンを発行
    try:
        claims = get_jwt()
        exp_ts = int(claims.get('exp', 0))
        now_ts = epoch_s()
        remain = exp_ts - now_ts
    except Exception:
        remain = -1  # 失敗したら強制的に -1 扱い（更新しない）

    # ロビー待機中（waiting=='lobby'）はトークンを更新しない（フロント側の抑止に加えてサーバ側でも保険）
    try:
        pres = db[PRESENCE_COLL].find_one({'user_id': me}, {'waiting': 1}) or {}
        if pres.get('waiting') == 'lobby':
            return _json({'success': True, 'remain_seconds': remain, 'skipped': 'lobby'}, 200)
    except Exception:
        pass

    threshold = int(current_app.config.get('LOBBY_TOUCH_INTERVAL_SECONDS', 300))
    if remain >= 0 and remain <= threshold:
        try:
            from flask_jwt_extended import create_access_token
            new_token = create_access_token(identity=str(me))
            return _json({'success': True, 'access_token': new_token, 'remain_seconds': remain}, 200)
        except Exception as e:
            # 明示的にエラーを出す（フォールバックしない）
            return _json({'success': False, 'error': 'rotate_failed', 'detail': str(e)}, 500)

    return _json({'success': True, 'remain_seconds': remain}, 200)

@lobby_bp.route('/active', methods=['POST'])
@jwt_required()
def active():
    return touch()

@lobby_bp.route('/invite/create', methods=['POST'])
@jwt_required()
def invite_create():
    db = _db()
    me = ObjectId(get_jwt_identity())

    if _is_banned_user(db, me):
        return _json({'success': False, 'error': 'banned'}, 403)

    # must be actively waiting (seeking) to create an invite
    me_doc = db[PRESENCE_COLL].find_one({'user_id': me}, {'waiting': 1, 'waiting_info': 1}) or {}
    if me_doc.get('waiting') != 'seeking':
        return _json({'success': False, 'error': 'not_seeking', 'message': '待機中のみ招待URLを作れます'}, 400)

    # expiry: default 1 hour (can be changed via config)
    ttl_sec = int(current_app.config.get('INVITE_TTL_SECONDS', 3600))
    now = _now()
    expires_at = now + timedelta(seconds=ttl_sec)

    # generate unique token
    token = None
    for _ in range(5):
        t = secrets.token_urlsafe(24)
        if not db[INVITES_COLL].find_one({'token': t}, {'_id': 1}):
            token = t
            break
    if not token:
        return _json({'success': False, 'error': 'token_failed', 'message': '招待トークンの生成に失敗しました'}, 500)

    db[INVITES_COLL].insert_one({
        'token': token,
        'inviter_user_id': me,
        'created_at': now,
        'expires_at': expires_at,
    })

    # IMPORTANT: do not return absolute URL here (proxy/https mismatch prone).
    path = f"/?invite={token}"
    return _json({'success': True, 'token': token, 'path': path, 'expires_in': ttl_sec}, 200)


@lobby_bp.route('/invite/<token>', methods=['GET'])
@jwt_required(optional=True)
def invite_info(token):
    db = _db()
    doc = db[INVITES_COLL].find_one({'token': token})
    if not doc:
        return _json({'success': False, 'error': 'not_found', 'message': '招待が見つかりません'}, 404)

    expires_at = doc.get('expires_at')
    now = _now()
    if expires_at and now > expires_at:
        try:
            db[INVITES_COLL].delete_one({'_id': doc.get('_id')})
        except Exception:
            pass
        return _json({'success': False, 'error': 'expired', 'message': '招待の有効期限が切れました'}, 410)

    inviter_id = doc.get('inviter_user_id')
    if not inviter_id:
        return _json({'success': False, 'error': 'broken', 'message': '招待情報が壊れています'}, 500)

    # current presence
    pres = db[PRESENCE_COLL].find_one({'user_id': inviter_id}, {'waiting': 1, 'waiting_info': 1, 'last_seen_at': 1}) or {}
    waiting = pres.get('waiting') or 'offline'
    waiting_info = pres.get('waiting_info') or {}

    # if inviter is in an active game, treat as playing/review for UI hints
    try:
        games_coll = db.get('games') if hasattr(db, 'get') else db['games']
        active_docs = games_coll.find(
            {'status': {'$in': ['active', 'ongoing', 'in_progress', 'started', 'pause', 'review']}},
            {'players': 1, 'sente_id': 1, 'gote_id': 1}
        )
        def _uid(v):
            try:
                from bson import ObjectId as _OID
                if isinstance(v, _OID):
                    return v
            except Exception:
                pass
            if isinstance(v, dict):
                v = v.get('user_id') or v.get('id')
            return v
        for g in active_docs:
            players = g.get('players') or {}
            s_uid = _uid((players.get('sente') or {}).get('user_id') or g.get('sente_id'))
            g_uid = _uid((players.get('gote') or {}).get('user_id') or g.get('gote_id'))
            if inviter_id and (inviter_id == s_uid or inviter_id == g_uid):
                # prefer 'review' if game status indicates
                st = (g.get('status') or '').lower()
                waiting = 'review' if st == 'review' else 'playing'
                break
    except Exception:
        pass

    prof = _inviter_profile(db, inviter_id)

    remain = None
    if expires_at:
        try:
            remain = int((expires_at - now).total_seconds())
        except Exception:
            remain = None

    return _json({
        'success': True,
        'token': token,
        'inviter': prof,
        'waiting': waiting,
        'waiting_info': waiting_info,
        'expires_in': remain,
    }, 200)


@lobby_bp.route('/time-controls', methods=['GET'])
@jwt_required(optional=True)
def time_controls():
    # Expose configured time controls as [{code, name}] (viewer language)
    lang = _get_request_lang(default='en')
    controls = []
    for code, meta in (TIME_CONTROLS or {}).items():
        try:
            name = _tc_label((meta or {}), lang=lang, field='name')
        except Exception:
            name = ''
        if not name:
            name = str(code or '')
        controls.append({'code': str(code or ''), 'name': name})

    # Fallback: keep codes only (no hardcoded language strings)
    if not controls:
        controls = [{'code': c, 'name': c} for c in ['hayasashi', 'hayasashi2', 'hayasashi3', '15min', '30min']]
    return _json({'controls': controls}, 200)