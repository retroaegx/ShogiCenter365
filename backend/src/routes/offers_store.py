# -*- coding: utf-8 -*-
from __future__ import annotations
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt_identity
from datetime import datetime
from bson import ObjectId
import uuid

from src.utils.maintenance_mode import is_maintenance_enabled, maintenance_message

offer_bp = Blueprint('offer', __name__, url_prefix='/api/lobby')


def _is_banned_user(db, user_oid: ObjectId) -> bool:
    try:
        doc = db['users'].find_one({'_id': user_oid}, {'is_banned': 1}) or {}
        return bool(doc.get('is_banned'))
    except Exception:
        return False

def _db():
    db = current_app.config.get('MONGO_DB')
    if db is None:
        db = getattr(current_app, 'mongo_db', None)
    if db is None:
        raise RuntimeError('MONGO_DB is not configured on current_app')
    return db

@offer_bp.before_request
def _before():
    # 必要なインデックスの保証（冪等）
    db = current_app.config.get('MONGO_DB')
    if db is not None:
        db['offers'].create_index([('status', 1)])
        db['offers'].create_index([('created_at', -1)])
        db['games'].create_index([('status', 1)])
        db['games'].create_index([('created_at', -1)])

@offer_bp.route('/offers/create', methods=['POST'])
@jwt_required()
def create():
    me = get_jwt_identity()
    payload = request.get_json(silent=True) or {}
    target_user = payload.get('target_user')
    time_limit = int(payload.get('time_limit', 0))
    if not target_user:
        return jsonify({'success': False, 'error_code': 'target_user_required', 'message': 'target_user required'}), 400

    # --- status gate: only allow when my status is 'lobby' or '' ---
    db = _db()
    if is_maintenance_enabled(db):
        return jsonify({'success': False, 'error': 'maintenance_mode', 'error_code': 'maintenance_mode', 'message': maintenance_message(db)}), 503

    # Identity is ObjectId string
    try:
        me_oid = ObjectId(me) if not isinstance(me, ObjectId) else me
    except Exception:
        return jsonify({'success': False, 'error_code': 'invalid_identity', 'message': 'invalid_identity'}), 400

    if _is_banned_user(db, me_oid):
        return jsonify({'success': False, 'error_code': 'banned', 'message': 'banned'}), 403

    # Presence doc may store waiting as string ('lobby'|'seeking'|'pending'|'playing') or boolean
    pres = db['online_users'].find_one({'user_id': me_oid}, {'waiting': 1}) or {}
    waiting_raw = pres.get('waiting', '')
    if isinstance(waiting_raw, bool):
        # Map legacy boolean: False -> 'lobby' (idle), True -> 'seeking' (looking for game)
        waiting_state = 'seeking' if waiting_raw else 'lobby'
    else:
        waiting_state = str(waiting_raw or '')

    # Block unless 'lobby' or empty string
    if waiting_state not in ('lobby', ''):
        return jsonify({'success': False, 'error_code': 'cannot_create_offer_in_current_status', 'message': 'cannot_create_offer_in_current_status', 'status': waiting_state}), 409

    doc = {
        'from': me,
        'to': target_user,
        'status': 'pending',
        'time_limit': time_limit,
        'created_at': datetime.utcnow(),
        'updated_at': datetime.utcnow(),
    }
    db = _db()
    db['offers'].insert_one(doc)
    return jsonify({'ok': True}), 200

@offer_bp.route('/offers/pending', methods=['GET'])
@jwt_required()
def pending():
    me = get_jwt_identity()
    db = _db()
    cur = db['offers'].find({'to': me, 'status': 'pending'}).sort([('created_at', -1)])
    out = []
    for d in cur:
        out.append({
            'id': str(d['_id']),
            'from': d.get('from'),
            'to': d.get('to'),
            'time_limit': d.get('time_limit', 0),
            'status': d.get('status'),
        })
    return jsonify(out), 200

@offer_bp.route('/offers/cancel', methods=['POST'])
@jwt_required()
def cancel():
    me = get_jwt_identity()
    payload = request.get_json(silent=True) or {}
    oid = payload.get('offer_id')
    if not oid:
        return jsonify({'success': False, 'error_code': 'offer_id_required', 'message': 'offer_id required'}), 400
    db = _db()
    res = db['offers'].update_one({'_id': ObjectId(oid), 'from': me, 'status': 'pending'}, {'$set': {'status': 'canceled', 'updated_at': datetime.utcnow()}})
    return jsonify({'ok': res.matched_count == 1}), 200

@offer_bp.route('/offers/decline', methods=['POST'])
@jwt_required()
def decline():
    me = get_jwt_identity()
    payload = request.get_json(silent=True) or {}
    oid = payload.get('offer_id')
    if not oid:
        return jsonify({'success': False, 'error_code': 'offer_id_required', 'message': 'offer_id required'}), 400
    db = _db()
    res = db['offers'].update_one({'_id': ObjectId(oid), 'to': me, 'status': 'pending'}, {'$set': {'status': 'declined', 'updated_at': datetime.utcnow()}})
    return jsonify({'ok': res.matched_count == 1}), 200

@offer_bp.route('/offers/accept', methods=['POST'])
@jwt_required()
def accept():
    me = get_jwt_identity()
    payload = request.get_json(silent=True) or {}
    oid = payload.get('offer_id')
    if not oid:
        return jsonify({'success': False, 'error_code': 'offer_id_required', 'message': 'offer_id required'}), 400

    db = _db()

    if is_maintenance_enabled(db):
        return jsonify({'success': False, 'error': 'maintenance_mode', 'error_code': 'maintenance_mode', 'message': maintenance_message(db)}), 503

    # banned user cannot accept offers
    try:
        me_oid = ObjectId(me) if not isinstance(me, ObjectId) else me
        if _is_banned_user(db, me_oid):
            return jsonify({'success': False, 'error_code': 'banned', 'message': 'banned'}), 403
    except Exception:
        pass
    offer = db['offers'].find_one({'_id': ObjectId(oid), 'to': me, 'status': 'pending'})
    if not offer:
        return jsonify({'success': False, 'error_code': 'offer_not_found', 'message': 'offer_not_found'}), 404

    # ---- Canonical schema: SFEN (position) + USI (moves) ----
    # DBには board/captured の配列は保存しない。
    now = datetime.utcnow()
    try:
        from src.services.game_service import DEFAULT_START_SFEN
        start_sfen = DEFAULT_START_SFEN
    except Exception:
        start_sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"

    time_limit_ms = int(offer.get('time_limit', 0) or 0) * 1000
    time_state = {
        'config': {
            'initial_ms':   time_limit_ms,
            'byoyomi_ms':   0,
            'increment_ms': 0,
            'deferment_ms': 0,
        },
        'sente': {'initial_ms': time_limit_ms, 'byoyomi_ms': 0, 'deferment_ms': 0},
        'gote':  {'initial_ms': time_limit_ms, 'byoyomi_ms': 0, 'deferment_ms': 0},
        'base_at': int(now.timestamp() * 1000),
        'current_player': 'sente',
    }

    # Resolve usernames best-effort (optional)
    def _resolve_username(uid_str: str) -> str:
        try:
            udoc = db['users'].find_one({'_id': ObjectId(uid_str)}) or {}
            return str(udoc.get('username') or '')
        except Exception:
            return ''

    sente_uid = str(offer.get('from') or '')
    gote_uid  = str(offer.get('to') or '')
    s_name = _resolve_username(sente_uid) or ''
    g_name = _resolve_username(gote_uid) or ''

    users_coll = db.get('users') if hasattr(db, 'get') else db['users']

    def _user_snapshot(uid: str, fallback_name: str):
        snap = {'user_id': uid}
        username = fallback_name or _resolve_username(uid) or ''
        snap['username'] = username
        uk = 'human'
        legion = 'JP'
        rating = 0
        if users_coll is not None:
            try:
                try:
                    qid = ObjectId(uid)
                except Exception:
                    qid = uid
                u = users_coll.find_one({'_id': qid}, {'username': 1, 'rating': 1, 'user_kind': 1, 'is_guest': 1, 'legion': 1}) or {}
            except Exception:
                u = {}
            if u.get('username'):
                snap['username'] = u.get('username')
            try:
                r = u.get('rating')
                if isinstance(r, (int, float)):
                    rating = int(r)
            except Exception:
                pass
            ukv = u.get('user_kind')
            if isinstance(ukv, str):
                ukv = ukv.strip()
            else:
                ukv = ''
            if not ukv:
                ukv = 'guest' if bool(u.get('is_guest')) else 'human'
            uk = ukv
            legion_v = u.get('legion')
            if isinstance(legion_v, str):
                legion_v = legion_v.strip().upper()
            else:
                legion_v = ''
            if legion_v:
                legion = legion_v
        snap['rating'] = rating
        snap['user_kind'] = uk
        snap['legion'] = legion
        return snap

    s_snap = _user_snapshot(sente_uid, s_name)
    g_snap = _user_snapshot(gote_uid, g_name)
    players = {
        'sente': s_snap,
        'gote':  g_snap,
    }

    # Use canonical creator so legacy fields are stripped.
    dm = getattr(current_app, 'db_manager', None)
    if dm is None:
        # fallback: build minimal insert without legacy fields
        game_id = str(uuid.uuid4())
        db['games'].insert_one({
            '_id': game_id,
            'status': 'ongoing',
            'players': players,
            'current_turn': 'sente',
            'start_sfen': start_sfen,
            'sfen': start_sfen,
            'move_history': [],
            'spectators': [],
            'chat_messages': [],
            'time_state': time_state,
            'created_at': now,
            'updated_at': now,
        })
    else:
        gm = dm.get_game_model()
        game_id = _run_coro(gm.create_game({
            'players': players,
            'status': 'ongoing',
            'current_turn': 'sente',
            'start_sfen': start_sfen,
            'sfen': start_sfen,
            'move_history': [],
            'spectators': [],
            'chat_messages': [],
            'time_state': time_state,
        }))

    # オファーを accept に更新
    db['offers'].update_one({'_id': offer['_id']}, {'$set': {'status': 'accepted', 'game_id': str(game_id), 'updated_at': now}})

    return jsonify({'ok': True, 'game_id': str(game_id)}), 200

def _run_coro(coro):
    """Run an async coroutine in a sync Flask route.
    Flask routes normally run without an active asyncio loop, so asyncio.run is OK.
    """
    import asyncio
    return asyncio.run(coro)
