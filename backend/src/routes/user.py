# -*- coding: utf-8 -*-
from flask import Blueprint, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt_identity
from bson import ObjectId

user_bp = Blueprint("user", __name__)

def _db():
    db = getattr(current_app, "mongo_db", None)
    if db is not None:
        return db
    return current_app.config.get("MONGO_DB")

def _shape(user_doc):
    return {
        "id": str(user_doc.get("_id")),
        "username": user_doc.get("username"),
        "email": user_doc.get("email"),
        "rating": user_doc.get("rating", 1500),
        "games_played": user_doc.get("games_played", 0),
        "wins": user_doc.get("wins", 0),
        "losses": user_doc.get("losses", 0),
        "draws": user_doc.get("draws", 0),
        "created_at": user_doc.get("created_at"),
        "is_active": user_doc.get("is_active", True),
        "is_email_verified": user_doc.get("is_email_verified", False),
        "settings": user_doc.get("settings", {}),
    }

@user_bp.route("/profile", methods=["GET"])
@jwt_required(locations=["headers", "cookies"])
def get_profile():
    db = _db()
    sub = get_jwt_identity()
    try:
        uid = ObjectId(sub)
    except Exception:
        return jsonify({"message": "invalid identity"}), 400

    user = db.users.find_one({"_id": uid}, {
        "username": 1, "email": 1, "rating": 1,
        "games_played": 1, "wins": 1, "losses": 1, "draws": 1,
        "created_at": 1, "is_active": 1, "is_email_verified": 1, "settings": 1
    })
    if not user:
        return jsonify({"message": "user not found"}), 404

    return jsonify({"profile": _shape(user)}), 200
@user_bp.route("/settings", methods=["PUT"])
@jwt_required(locations=["headers", "cookies"])
def update_settings():
    db = _db()
    sub = get_jwt_identity()
    try:
        uid = ObjectId(sub)
    except Exception:
        return jsonify({"message": "invalid identity"}), 400

    from flask import request
    payload = request.get_json(silent=True) or {}
    settings = payload.get("settings") or {}

    # Merge updates into the existing settings so we don't accidentally drop fields.
    existing = db.users.find_one({"_id": uid}, {"settings": 1}) or {}
    merged = existing.get("settings") or {}
    changed = False

    if isinstance(settings.get("envSoundVolume"), (int, float)):
        merged["envSoundVolume"] = max(0, min(100, int(settings["envSoundVolume"])))
        changed = True
    if isinstance(settings.get("sfxVolume"), (int, float)):
        merged["sfxVolume"] = max(0, min(100, int(settings["sfxVolume"])))
        changed = True
    if isinstance(settings.get("boardDesignPreset"), str):
        merged["boardDesignPreset"] = settings["boardDesignPreset"]
        changed = True

    # Board theme set selections (strings; empty string is allowed).
    if isinstance(settings.get("boardBackgroundSet"), str):
        merged["boardBackgroundSet"] = (settings.get("boardBackgroundSet") or "").strip()
        changed = True
    if isinstance(settings.get("boardPieceSet"), str):
        merged["boardPieceSet"] = (settings.get("boardPieceSet") or "").strip()
        changed = True

    # Game UI (match screen)
    if isinstance(settings.get("coordVisible"), bool):
        merged["coordVisible"] = settings["coordVisible"]
        changed = True

    swm = settings.get("shellWidthMode")
    if isinstance(swm, str):
        m = (swm or "").strip().lower()
        if m in ("normal", "wide"):
            merged["shellWidthMode"] = m
            changed = True

    bl = settings.get("blockList")
    if isinstance(bl, list):
        merged["blockList"] = [str(x).strip() for x in bl if str(x).strip()]
        changed = True

    if changed:
        db.users.update_one({"_id": uid}, {"$set": {"settings": merged}})

    user = db.users.find_one({"_id": uid}, {
        "username": 1, "email": 1, "rating": 1,
        "games_played": 1, "wins": 1, "losses": 1, "draws": 1,
        "created_at": 1, "is_active": 1, "is_email_verified": 1, "settings": 1,
        "settings": 1,
    })
    if not user:
        return jsonify({"message": "user not found"}), 404

    profile = _shape(user)
    profile["settings"] = user.get("settings", {})

    return jsonify({"profile": profile, "settings": profile["settings"]}), 200


# --- added to satisfy import in main.py ---
def init_user_routes(app):
    """Compatibility shim: older main.py expects this symbol.
    This function is intentionally a no-op.
    """
    return None


@user_bp.route('/refresh', methods=['POST'])
@jwt_required(optional=True)
def user_refresh():
    sub = get_jwt_identity()
    if not sub:
        return jsonify({'message': 'unauthorized'}), 401
    db = _db()
    try:
        uid = ObjectId(sub)
    except Exception:
        return jsonify({'message':'invalid identity'}), 400
    user = db.users.find_one({'_id': uid}, {'username':1, 'rating':1, 'created_at':1, 'settings':1})
    if not user:
        return jsonify({'message':'user not found'}), 404
    return jsonify({'profile': _shape(user)}), 200
