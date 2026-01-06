
from __future__ import annotations
from flask import Blueprint, jsonify, current_app, request
from flask_jwt_extended import jwt_required, get_jwt_identity
import json

game_bp = Blueprint('game', __name__, url_prefix='/api/game')

def _run_sync(func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    except TypeError:
        import asyncio
        loop = asyncio.get_event_loop()
        return loop.run_until_complete(func(*args, **kwargs))

@game_bp.route('/<game_id>', methods=['GET'])

@jwt_required()
def get_game(game_id: str):
    svc = getattr(current_app, 'game_service', None)
    if svc is None:
        current_app.logger.error('get_game: game_service not bound')
        return jsonify({'message': 'service_unavailable'}), 503
    me = str(get_jwt_identity())
    doc = _run_sync(svc.get_game_by_id, game_id)
    if not doc:
        return jsonify({'message': 'not_found'}), 404
    # 常に正規化ペイロードで返す（time_effective 等を含める）
    payload = _run_sync(svc.as_api_payload, doc, me)
    return jsonify(payload if isinstance(payload, dict) else {'message': 'payload_error'}), 200

@game_bp.route('/<game_id>/move', methods=['POST'])
@jwt_required()
def post_move(game_id: str):
    svc = getattr(current_app, 'game_service', None)
    if svc is None or not hasattr(svc, 'make_move'):
        return jsonify({'message': 'service_unavailable'}), 503
    me = str(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    res = _run_sync(svc.make_move, game_id, me, data)
    return jsonify(res if isinstance(res, dict) else {'success': bool(res)}), 200

@game_bp.route('/<game_id>/resign', methods=['POST'])
@jwt_required()
def post_resign(game_id: str):
    svc = getattr(current_app, 'game_service', None)
    if svc is None or not hasattr(svc, 'resign_game'):
        return jsonify({'message': 'service_unavailable'}), 503
    me = str(get_jwt_identity())
    res = _run_sync(svc.resign_game, game_id, me)
    return jsonify(res if isinstance(res, dict) else {'success': bool(res)}), 200

@game_bp.route('/spectate-by-user', methods=['POST'])
@jwt_required()
def spectate_by_user():
    svc = getattr(current_app, 'game_service', None)
    db = getattr(current_app, "mongo_db", None)
    if db is None:
        db = current_app.config.get("MONGO_DB", None)
    if svc is None or db is None:
        return jsonify({'message': 'service_unavailable'}), 503

    me_raw = str(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    target_str = str(data.get('target_user_id') or data.get('user_id') or '').strip()
    if not target_str:
        return jsonify({'error': 'target_user_id_required'}), 400

    from bson import ObjectId as _OID

    # guard: 自分が lobby か空 waiting であること
    try:
        me_oid = _OID(me_raw)
    except Exception:
        me_oid = None
    try:
        ou = db['online_users']
        pres = ou.find_one({'user_id': me_oid}) if me_oid else None
        my_waiting = (pres or {}).get('waiting') or ''
        if isinstance(my_waiting, str):
            my_waiting = my_waiting.strip()
        if my_waiting not in ('', 'lobby'):
            return jsonify({'error': 'self_not_in_lobby'}), 409
    except Exception:
        pass

    # 対象ユーザーの現在の対局を検索
    try:
        target_oid = _OID(target_str)
    except Exception:
        return jsonify({'error': 'invalid_target_user_id'}), 400

    games = db['games']

    # 対象ユーザーが参加した直近の対局を 1 件だけ取得する。
    # status は広めに許容し、pending / canceled / declined だけ除外する。
    query = {
        'status': {'$nin': ['pending', 'canceled', 'declined']},
        '$or': [
            {'sente_id': target_oid},
            {'gote_id': target_oid},
            {'players.sente.user_id': str(target_oid)},
            {'players.gote.user_id': str(target_oid)},
        ],
    }
    try:
        doc = games.find_one(query, sort=[('start_time', -1), ('_id', -1)])
    except Exception:
        doc = None
    if not doc:
        return jsonify({'error': 'no_active_game'}), 404

    gid = str(doc.get('_id'))
    return jsonify({'success': True, 'game_id': gid}), 200


game_bp_instance = game_bp

def init_game_routes(app, game_service):
    if game_service is None:
        raise RuntimeError('init_game_routes(app, game_service): game_service is required')
    setattr(app, 'game_service', game_service)
    if 'game' not in app.blueprints:
        app.register_blueprint(game_bp)
    return game_bp
