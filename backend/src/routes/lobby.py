from flask import Blueprint, current_app, request, current_app, request, abort
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from bson import ObjectId, json_util
from datetime import datetime
import logging, json, re
import asyncio
from src.config import TIME_CONTROLS

# ---- async bridge for sync Flask view ----
def _run_coro(coro):
    # Flask is running in sync mode; create a fresh event loop to run the coroutine.
    return asyncio.run(coro)


# Strictly resolve username for a given user_id using DB; no fallbacks allowed.
def _resolve_username_strict(db, user_id):
    from bson import ObjectId
    if not isinstance(user_id, ObjectId):
        try:
            user_id = ObjectId(str(user_id))
        except Exception:
            abort(400, description="invalid user_id")
    doc = db['users'].find_one({'_id': user_id}, {'username': 1})
    if not doc:
        abort(404, description="user not found")
    username = doc.get('username')
    if not isinstance(username, str) or not username:
        abort(409, description="username missing for user")
    return username

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

lobby_bp = Blueprint('lobby', __name__, url_prefix='/api/lobby')
logger = logging.getLogger(__name__)


# ---- time control helpers (server-authoritative) ----
_TIME_CODE_TO_NAME = {k: (v.get('name') or k) for k, v in (TIME_CONTROLS or {}).items()}
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
    return _TIME_CODE_TO_NAME.get(code) or code or ''


HEX24_RE = re.compile(r'^[0-9a-fA-F]{24}$')
PRESENCE_COLL = 'online_users'

# ---- WebSocket notify helper (no circular import) ----
def _get_socketio():
    try:
        return current_app.extensions.get('socketio')
    except Exception:
        return None

def _notify_lobby(event: str, payload: dict|None=None):
    s = _get_socketio()
    if not s:
        logger.warning('socketio extension not available to emit %s', event)
        return
    try:
        s.emit(event, payload or {}, room='lobby')
    except Exception as e:
        logger.warning('notify failed: %s', e)
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
        logger.warning('emit_to_user failed: %s', e)

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
            logger.warning(f"_emit_offer_update failed: {e}")
        except Exception:
            pass

def _db():
    db = current_app.config.get('MONGO_DB')
    if db is None:
        raise RuntimeError('MONGO_DB is not configured on current_app')
    return db

def _now():
    return datetime.utcnow()

def _json(obj, code=200):
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

    # --- Passive cleanup: expire pending offers older than 20s (no WS broadcast here) ---
    try:
        now_ms = int(datetime.utcnow().timestamp() * 1000)
        TWENTY_S = 20 * 1000
        # Only check receiver docs (have from_user_id)
        stale = list(db[PRESENCE_COLL].find({
            'waiting': 'applying',
            'pending_offer.from_user_id': {'$exists': True}
        }))
        for doc in stale:
            po = doc.get('pending_offer') or {}
            created = int(po.get('created_at') or 0)
            if created and (now_ms - created) >= TWENTY_S:
                recv_uid = doc.get('user_id')
                from_uid = _id_to_objid(po.get('from_user_id'))
                # reset receiver
                db[PRESENCE_COLL].update_one(
                    {'user_id': recv_uid},
                    {'$set': {'waiting': 'seeking', 'pending_offer': {}, 'last_seen_at': now_ms}},
                    upsert=False
                )
                # reset applicant
                if from_uid:
                    db[PRESENCE_COLL].update_one(
                        {'user_id': from_uid},
                        {'$set': {'waiting': 'lobby', 'pending_offer': {}, 'last_seen_at': now_ms}},
                        upsert=False
                    )
                # no broadcast here (pull API should not push events)
    except Exception as e:
        try:
            current_app.logger.warning('cleanup expired offers failed: %s', e)
        except Exception:
            pass

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
        res.append({
            'user_id': uid,
            'current_game_id': user_game_map.get(uid),
            'username': username,
            'rating': rating,
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

        payload = request.get_json(silent=True) or {}
        raw_tc = payload.get('time_code') or payload.get('time_control') or payload.get('time_minutes')
        time_code = _normalize_time_code(raw_tc, 15)

        users_coll = db['users']
        username = ''
        rating = 0
        try:
            udoc = users_coll.find_one({'_id': me}) if users_coll is not None else None
            if udoc:
                username = udoc.get('username') or udoc.get('name') or ''
                rating = int(udoc.get('rating') or udoc.get('rate') or 0)
        except Exception:
            pass

        waiting_info = {
            'username': username,
            'rating': rating,
            'time_code': time_code,
            'game_type': payload.get('game_type', 'rating'),
        }

        set_fields = {
            'waiting': 'seeking',
            'waiting_info': waiting_info,
            'pending_offer': {},
            'last_seen_at': _now(),
            'user_id': me,
        }
        db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': set_fields}, upsert=True)
        _notify_lobby('online_users_update', {'type': 'waiting_changed'})
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
        'waiting_info': {},
        'pending_offer': {},
        'last_seen_at': _now(),
    }})

    _notify_lobby('online_users_update', {'type': 'waiting_changed'})
    return _json({'success': True}, 200)


@lobby_bp.route('/join-by-user', methods=['POST'])
@jwt_required()
def join_by_user():
    db = _db()
    sub = get_jwt_identity()
    me = _id_to_objid(sub)
    if not me:
        return _json({'error': 'invalid_identity'}, 400)
    # --- guard: self must be in lobby or empty to send offers ---
    try:
        my_presence = db[PRESENCE_COLL].find_one({'user_id': me}, {'waiting': 1}) or {}
        my_waiting = (my_presence.get('waiting') or '').strip()
    except Exception:
        return _json({'error': 'presence_lookup_failed'}, 500)
    if my_waiting not in ('lobby', ''):
        return _json({'error': 'self_not_in_lobby'}, 409)



    body = request.get_json(silent=True) or {}
    opp_str = body.get('opponent_user_id')
    opp = _id_to_objid(opp_str)
    if not opp:
        return _json({'error': 'invalid_opponent'}, 400)
    if opp == me:
        return _json({'error': 'self_request_not_allowed'}, 409)

    me_doc = db['users'].find_one({'_id': me}, {'username':1,'rating':1})
    opp_doc = db[PRESENCE_COLL].find_one({'user_id': opp})
    if not me_doc:
        return _json({'error': 'self_not_found'}, 404)
    if me_doc.get('waiting') == 'playing':
        return _json({'error': 'self_playing'}, 409)
    if not (opp_doc and opp_doc.get('waiting') == 'seeking'):
        return _json({'error': 'opponent_not_waiting'}, 409)

    time_control = body.get('time_control')
    time_code_in = body.get('time_code')

    # mark opponent as pending, but do NOT persist extra fields into pending_offer here
    db[PRESENCE_COLL].update_one({'user_id': opp}, {'$set': {
        'waiting': 'applying',
        'last_seen_at': _now(),
    }})
    # also mark applicant as pending
    try:
        db[PRESENCE_COLL].update_one({'user_id': me}, {'$set': {
            'waiting': 'applying',
            'last_seen_at': _now(),
        }}, upsert=True)
    except Exception:
        pass
# ---- strict validation & normalized time control (server-authoritative)
    if not me_doc.get('username'):
        return _json({'error': 'sender_profile_incomplete', 'field': 'username'}, 409)
    if me_doc.get('rating') is None:
        return _json({'error': 'sender_profile_incomplete', 'field': 'rating'}, 409)

    wi = opp_doc.get('waiting_info') or {}
    game_type = wi.get('game_type')
    if game_type not in ('rating','free'):
        return _json({'error': 'opponent_waiting_info_invalid', 'field': 'game_type'}, 409)

        # applicant must provide time_code; do not fallback to opponent preference
    if not time_code_in:
        return _json({'error': 'time_code_required'}, 400)
    time_code = _normalize_time_code(time_code_in, None) or _normalize_time_code(time_code_in, wi.get('time_control'))
    if not time_code:
        return _json({'error': 'invalid_time_code'}, 400)

    # Minimal, tamper-proof payload (IDs + codes only). Client recreates labels from config.
    payload = {
        'type': 'offer_created',
        'from_user_id': str(me),
        'to_user_id': str(opp),
        'game_type': game_type,
        'time_code': time_code,
        'time_name': _time_name_from_code(time_code),
        'from_username': me_doc.get('username'),
        'from_rating': int(me_doc.get('rating') or 0),
        'requested_game_type': game_type,
        # 'offer_id': str(offer_oid)  # 将来ID採番するならここで
    }

    

    # also persist time_code/name into receiver's pending_offer for UI convenience
    # also persist time_code/name into receiver's pending_offer for UI convenience
    try:
        db[PRESENCE_COLL].update_one(
            {'user_id': opp},
            {'$set': {'pending_offer': {
                'from_user_id': str(me),
                'from_username': me_doc.get('username'),
                'time_code': time_code,
                'created_at': int(datetime.utcnow().timestamp() * 1000),
            }}},
            upsert=True
        )
    except Exception:
        pass

    # also mark applicant as pending and store outgoing pending_offer for convenience
    try:
        db[PRESENCE_COLL].update_one(
            {'user_id': me},
            {'$set': {
                'waiting': 'applying',
                'pending_offer': {
                    'to_user_id': str(opp),
                    'to_username': opp_doc.get('username') if opp_doc else None,
                    'time_code': time_code,
                    'created_at': int(datetime.utcnow().timestamp() * 1000),
                },
                'last_seen_at': _now(),
            }},
            upsert=True
        )
    except Exception:
        pass

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

        import random
        try:
            from_doc = db[PRESENCE_COLL].find_one({'user_id': from_uid}) or {}
            from_username = from_doc.get('username') if from_doc.get('username') else _resolve_username_strict(_db(), from_uid)
            me_username = me_doc.get('username') or _resolve_username_strict(_db(), me)
            if random.random() < 0.5:
                sente = {'user_id': str(from_uid), 'username': from_username}
                gote  = {'user_id': str(me),       'username': me_username}
                my_role = 'gote'
            else:
                sente = {'user_id': str(me),       'username': me_username}
                gote  = {'user_id': str(from_uid), 'username': from_username}
                my_role = 'sente'
        except Exception:
            sente = {'user_id': str(from_uid), 'username': _resolve_username_strict(_db(), from_uid)}
            gote  = {'user_id': str(me),       'username': _resolve_username_strict(_db(), me)}
            my_role = 'gote'

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
            'base_at': int(datetime.utcnow().timestamp() * 1000),
            'current_player': 'sente',
        }

        # Canonical: store only SFEN (no board arrays / no captured arrays).
        # start_sfen is kept so we can reconstruct review/analysis from USI move list.
        from src.services.game_service import DEFAULT_START_SFEN
        start_sfen = DEFAULT_START_SFEN
        sfen = start_sfen

        from src.models.database import DatabaseManager
        dm = getattr(current_app, 'db_manager', None)
        if dm is None:
            from flask import abort
            current_app.logger.error('db_manager is not configured (startup DI failed)')
            abort(500, description='db_manager_not_configured')
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
            'waiting_info': {},
            'pending_offer': {},
            'last_seen_at': _now(),
        }})
        db[PRESENCE_COLL].update_one({'user_id': from_uid}, {'$set': {
            'waiting': 'playing',
            'waiting_info': {},
            'pending_offer': {},
            'last_seen_at': _now(),
        }})

        payload = {'type': 'offer_status', 'status': 'accepted', 'game_id': game_id}
        try:
            _emit_offer_update(payload, to_user_id=me, from_user_id=from_uid)
        except Exception:
            pass
        _notify_lobby('online_users_update', {'type': 'waiting_changed'})
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
        'pending_offer': {},
        'last_seen_at': _now(),
    }})
    # reset sender if known
    if from_uid:
        db[PRESENCE_COLL].update_one({'user_id': from_uid}, {'$set': {
            'waiting': 'lobby',
            'pending_offer': {},
            'last_seen_at': _now(),
        }})
    # notify both
    payload = {'type': 'offer_status', 'status': 'declined', 'to_user_id': str(me), 'from_user_id': (str(from_uid) if from_uid else None)}
    try:
        _emit_offer_update(payload, to_user_id=me, from_user_id=from_uid if from_uid else None)
    except Exception:
        pass
    _notify_lobby('online_users_update', {'type': 'waiting_changed'})
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
        'waiting': 'lobby',
        'pending_offer': {},
        'last_seen_at': _now(),
    }})

    # reset opponent if known
    if to_uid:
        db[PRESENCE_COLL].update_one({'user_id': to_uid}, {'$set': {
            'waiting': 'seeking',
            'pending_offer': {},
            'last_seen_at': _now(),
        }})

    # notify both as declined/cancelled
    payload = {'type': 'offer_status', 'status': 'declined', 'from_user_id': str(me), 'to_user_id': (str(to_uid) if to_uid else None)}
    try:
        _emit_offer_update(payload, to_user_id=to_uid if to_uid else None, from_user_id=me)
    except Exception:
        pass
    _notify_lobby('online_users_update', {'type': 'waiting_changed'})
    return _json({'success': True}, 200)

@lobby_bp.route('/touch', methods=['POST'])
@jwt_required()
def touch():
    db = _db()
    me = _id_to_objid(get_jwt_identity())
    if not me:
        return _json({'error': 'invalid_identity'}, 400)
    db[PRESENCE_COLL].update_one(
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

    # 残り有効時間を確認して、5分以内なら新しいトークンを発行
    try:
        claims = get_jwt()
        exp_ts = int(claims.get('exp', 0))
        now_ts = int(datetime.utcnow().timestamp())
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
@lobby_bp.route('/time-controls', methods=['GET'])
@jwt_required(optional=True)
def time_controls():
    # Expose configured time controls as [{code, name}]
    controls = [{'code': code, 'name': (TIME_CONTROLS.get(code, {}) or {}).get('name') or code}
                for code in (TIME_CONTROLS or {}).keys()]
    # Fallback to common presets if empty
    if not controls:
        controls = [{'code':'hayasashi','name':'早指'},
                    {'code':'hayasashi2','name':'早指2'},
                    {'code':'hayasashi3','name':'早指3'},
                    {'code':'15min','name':'15分'},
                    {'code':'30min','name':'30分'}]
    return _json({'controls': controls}, 200)