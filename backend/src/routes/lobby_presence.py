
# backend/src/routes/lobby_presence.py
from datetime import datetime, timezone, timedelta
from bson import ObjectId
from flask import Blueprint, jsonify, current_app, request
from flask_jwt_extended import jwt_required, get_jwt_identity
from src.presence_utils import ensure_online_ttl
from src.utils.maintenance_mode import is_maintenance_enabled, maintenance_message

presence_bp = Blueprint("presence_bp", __name__, url_prefix="/api/lobby")

def _db():
    # Always use the app's prepared db (set at startup)
    db = getattr(current_app, "mongo_db", None)
    if db is None:
        db = current_app.config.get("MONGO_DB", None)
    return db

@presence_bp.record
def _ensure_indexes(setup_state):
    app = setup_state.app
    db = getattr(app, "mongo_db", None) or app.config.get("MONGO_DB", None)
    if db is None:
        return
    coll = db["online_users"]
    try:
        coll.create_index("user_id", unique=True)
        coll.create_index("last_seen_at")
    except Exception:
        pass

def _to_oid(maybe):
    if isinstance(maybe, ObjectId):
        return maybe
    if isinstance(maybe, str) and len(maybe) == 24:
        try:
            return ObjectId(maybe)
        except Exception:
            return maybe
    return maybe

@presence_bp.route("/active", methods=["POST"])
@jwt_required()
def active():
    """
    Heartbeat: upsert into online_users and refresh last_seen_at.
    Also refresh username/rating from users collection so FE can display even
    if initial insert was empty.
    """
    db = _db()
    if db is None:
        # Backward compatible: keep `error` while adding `error_code`.
        return jsonify({"success": False, "error": "db_not_ready", "error_code": "db_not_ready", "message": "db_not_ready"}), 500

    uid_raw = get_jwt_identity()
    uid = _to_oid(uid_raw)

    users = db.get("users")
    ou = db.get("online_users")

    now = datetime.now(timezone.utc)
    username = None
    rating = None
    if users is not None:
        try:
            udoc = users.find_one({"_id": uid}) or users.find_one({"_id": _to_oid(str(uid_raw))})
            if udoc:
                username = udoc.get("username") or udoc.get("name")
                rating = udoc.get("rating") or udoc.get("rate") or 0
        except Exception:
            pass

    ou.update_one(
        {"user_id": uid},
        {
            "$set": {
                "user_id": uid,
                "last_seen_at": now,
                "username": username if username is not None else "",
                "rating": rating if rating is not None else 0,
            },
            "$setOnInsert": {
                "waiting": False,
                "waiting_info": {},
            }
        },
        upsert=True,
    )
    return jsonify({"success": True})

@presence_bp.route("/start", methods=["POST"])
@jwt_required()
def start_waiting():
    """Start waiting with conditions (stored in online_users)."""
    db = _db()
    if db is None:
        return jsonify({"success": False, "error": "db_not_ready", "error_code": "db_not_ready", "message": "db_not_ready"}), 500

    if is_maintenance_enabled(db):
        # message is dynamic (configured on server) so keep it as-is.
        return jsonify({"success": False, "error": "maintenance_mode", "error_code": "maintenance_mode", "message": maintenance_message(db)}), 503
    data = request.get_json(silent=True) or {}
    game_type = data.get("game_type", "rating")
    time_minutes = int(data.get("time_minutes") or 10)
    rating_span = int(data.get("rating_span") or 0)

    uid = _to_oid(get_jwt_identity())
    now = datetime.now(timezone.utc)
    db["online_users"].update_one(
        {"user_id": uid},
        {
            "$set": {
                "user_id": uid,
                "last_seen_at": now,
                "waiting": True,
                "waiting_info": {
                    "game_type": game_type,
                    "time_minutes": time_minutes,
                    "rating_span": rating_span,
                },
            }
        },
        upsert=True,
    )
    return jsonify({"success": True})

@presence_bp.route("/stop", methods=["POST"])
@jwt_required()
def stop_waiting():
    """Stop waiting (clear flags)."""
    db = _db()
    if db is None:
        return jsonify({"success": False, "error": "db_not_ready", "error_code": "db_not_ready", "message": "db_not_ready"}), 500
    uid = _to_oid(get_jwt_identity())
    db["online_users"].update_one(
        {"user_id": uid},
        {"$set": {"waiting": False, "waiting_info": {}}},
        upsert=True,
    )
    return jsonify({"success": True})
