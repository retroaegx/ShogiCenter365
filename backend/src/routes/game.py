
from __future__ import annotations
from flask import Blueprint, jsonify, current_app, request
from flask_jwt_extended import jwt_required, get_jwt_identity
import json

game_bp = Blueprint('game', __name__, url_prefix='/api/game')


def _with_error_code(obj, status_code: int):
    """Attach error_code for forward-compatible i18n.

    Existing clients may rely on `message` or `error`. Newer clients can
    prefer `error_code` for translation.
    """
    try:
        if not isinstance(obj, dict):
            return obj
        # service style: { success: False, message: '...' }
        if obj.get('success') is False:
            if 'error_code' not in obj:
                ec = obj.get('error') or obj.get('code') or obj.get('message')
                if isinstance(ec, str) and ec.strip():
                    obj['error_code'] = ec.strip()
            return obj

        # route style: { message: '...' } / { error: '...' } with 4xx/5xx
        if status_code >= 400 and 'error_code' not in obj:
            ec = obj.get('error') or obj.get('message')
            if isinstance(ec, str) and ec.strip():
                obj['error_code'] = ec.strip()
    except Exception:
        return obj
    return obj

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
        body = _with_error_code({'success': False, 'message': 'service_unavailable'}, 503)
        return jsonify(body), 503
    me = str(get_jwt_identity())
    doc = _run_sync(svc.get_game_by_id, game_id)
    if not doc:
        body = _with_error_code({'success': False, 'message': 'not_found'}, 404)
        return jsonify(body), 404
    # 常に正規化ペイロードで返す（time_effective 等を含める）
    payload = _run_sync(svc.as_api_payload, doc, me)
    if isinstance(payload, dict):
        payload = _with_error_code(payload, 200)
        return jsonify(payload), 200
    body = _with_error_code({'success': False, 'message': 'payload_error'}, 200)
    return jsonify(body), 200

@game_bp.route('/<game_id>/move', methods=['POST'])
@jwt_required()
def post_move(game_id: str):
    svc = getattr(current_app, 'game_service', None)
    if svc is None or not hasattr(svc, 'make_move'):
        body = _with_error_code({'success': False, 'message': 'service_unavailable'}, 503)
        return jsonify(body), 503
    me = str(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    res = _run_sync(svc.make_move, game_id, me, data)
    if isinstance(res, dict):
        res = _with_error_code(res, 200)
        return jsonify(res), 200
    return jsonify({'success': bool(res)}), 200

@game_bp.route('/<game_id>/resign', methods=['POST'])
@jwt_required()
def post_resign(game_id: str):
    svc = getattr(current_app, 'game_service', None)
    if svc is None or not hasattr(svc, 'resign_game'):
        body = _with_error_code({'success': False, 'message': 'service_unavailable'}, 503)
        return jsonify(body), 503
    me = str(get_jwt_identity())
    res = _run_sync(svc.resign_game, game_id, me)
    if isinstance(res, dict):
        res = _with_error_code(res, 200)
        return jsonify(res), 200
    return jsonify({'success': bool(res)}), 200

@game_bp.route('/spectate-by-user', methods=['POST'])
@jwt_required()
def spectate_by_user():
    svc = getattr(current_app, 'game_service', None)
    db = getattr(current_app, "mongo_db", None)
    if db is None:
        db = current_app.config.get("MONGO_DB", None)
    if svc is None or db is None:
        body = _with_error_code({'success': False, 'message': 'service_unavailable'}, 503)
        return jsonify(body), 503

    me_raw = str(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    target_str = str(data.get('target_user_id') or data.get('user_id') or '').strip()
    if not target_str:
        body = _with_error_code({'success': False, 'error': 'target_user_id_required', 'message': 'target_user_id_required'}, 400)
        return jsonify(body), 400

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
            body = _with_error_code({'success': False, 'error': 'self_not_in_lobby', 'message': 'self_not_in_lobby'}, 409)
            return jsonify(body), 409
    except Exception:
        pass

    # 対象ユーザーの現在の対局を検索
    try:
        target_oid = _OID(target_str)
    except Exception:
        body = _with_error_code({'success': False, 'error': 'invalid_target_user_id', 'message': 'invalid_target_user_id'}, 400)
        return jsonify(body), 400

    games = db['games']

    # 対象ユーザーが参加している「いまの対局」を 1 件だけ取得する。
    # NOTE:
    # - 古いデータにだけ start_time が残っていると、start_time ソートで過去対局を拾ってしまう。
    # - created_at を基準に新しい対局を優先し、presence(waiting) に応じて status を絞る。
    base_or = [
        {'sente_id': target_oid},
        {'gote_id': target_oid},
        {'players.sente.user_id': str(target_oid)},
        {'players.gote.user_id': str(target_oid)},
    ]

    def _find_one(status_q):
        q = {
            'status': status_q,
            '$or': base_or,
        }
        try:
            return games.find_one(q, sort=[('created_at', -1)])
        except Exception:
            return None

    # target presence を best-effort で取得（UI が playing/review を表示している前提）
    target_waiting = ''
    try:
        ou = db['online_users']
        tpres = ou.find_one({'user_id': target_oid}, {'waiting': 1}) or {}
        target_waiting = (tpres.get('waiting') or '')
        if isinstance(target_waiting, str):
            target_waiting = target_waiting.strip()
    except Exception:
        target_waiting = ''

    active_statuses = ['active', 'ongoing', 'in_progress', 'started', 'pause']

    doc = None
    if target_waiting == 'playing':
        # 対局中は finished を避けたい
        doc = _find_one({'$in': active_statuses})
        if not doc:
            doc = _find_one({'$nin': ['pending', 'canceled', 'declined']})
    elif target_waiting == 'review':
        # 感想戦は基本 finished を優先
        doc = _find_one({'$in': ['finished']})
        if not doc:
            doc = _find_one({'$in': active_statuses + ['review']})
        if not doc:
            doc = _find_one({'$nin': ['pending', 'canceled', 'declined']})
    else:
        # 状態不明なら従来どおり広めに拾う
        doc = _find_one({'$nin': ['pending', 'canceled', 'declined']})

    if not doc:
        body = _with_error_code({'success': False, 'error': 'no_active_game', 'message': 'no_active_game'}, 404)
        return jsonify(body), 404

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
