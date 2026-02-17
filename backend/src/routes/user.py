# -*- coding: utf-8 -*-
from flask import Blueprint, jsonify, current_app, request
from flask_jwt_extended import jwt_required, get_jwt_identity
from bson import ObjectId

user_bp = Blueprint("user", __name__)


def _err(code: str, message: str, status: int = 400, **extra):
    """Standard error response.

    Backward compatible: keep `message` while adding `error_code`.
    """
    payload = {'success': False, 'error_code': str(code), 'message': str(message)}
    if extra:
        payload.update(extra)
    return jsonify(payload), int(status)

def _db():
    db = getattr(current_app, "mongo_db", None)
    if db is not None:
        return db
    return current_app.config.get("MONGO_DB")

def _shape(user_doc):
    # user_kind: human | computer | guest
    user_kind = (user_doc.get('user_kind') or '').strip() if isinstance(user_doc.get('user_kind'), str) else ''
    if not user_kind:
        # backward compatibility
        user_kind = 'guest' if bool(user_doc.get('is_guest')) else 'human'

    # legion: ISO 3166-1 alpha-2 (e.g., JP)
    legion = (user_doc.get('legion') or '').strip() if isinstance(user_doc.get('legion'), str) else ''
    if not legion:
        legion = 'JP'
    legion = legion.upper()

    return {
        "id": str(user_doc.get("_id")),
        "username": user_doc.get("username"),
        "email": user_doc.get("email"),
        "rating": user_doc.get("rating", 1500),
        "games_played": user_doc.get("games_played", 0),
        "wins": user_doc.get("wins", 0),
        "losses": user_doc.get("losses", 0),
        "draws": user_doc.get("draws", 0),
        "user_kind": user_kind,
        "legion": legion,
        "language": (user_doc.get('language') or 'en'),
        "is_guest": bool(user_doc.get("is_guest", False)),
        "created_at": user_doc.get("created_at"),
        "is_active": user_doc.get("is_active", True),
        "is_email_verified": user_doc.get("is_email_verified", False),
        "is_banned": bool(user_doc.get("is_banned", False)),
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
        return _err('invalid_identity', '認証情報が不正です', 400)

    user = db.users.find_one({"_id": uid}, {
        "username": 1, "email": 1, "rating": 1,
        "games_played": 1, "wins": 1, "losses": 1, "draws": 1,
        "user_kind": 1, "legion": 1, "is_guest": 1,
        "created_at": 1, "is_active": 1, "is_email_verified": 1, "is_banned": 1, "settings": 1,
        "language": 1,
    })
    if not user:
        return _err('user_not_found', 'ユーザーが見つかりません', 404)

    return jsonify({"profile": _shape(user)}), 200


@user_bp.route("/public/<user_id>", methods=["GET"])
@jwt_required(locations=["headers", "cookies"])
def get_public_profile(user_id: str):
    """Public profile for overlays (no email, no settings).

    Intended for lobby / header hover/tap cards.
    """
    db = _db()
    try:
        uid = ObjectId(user_id)
    except Exception:
        return _err('invalid_user_id', 'ユーザーIDが不正です', 400)

    user = db.users.find_one({"_id": uid}, {
        "username": 1,
        "rating": 1,
        "games_played": 1,
        "wins": 1,
        "losses": 1,
        "draws": 1,
        "user_kind": 1,
        "legion": 1,
        "is_guest": 1,
    })
    if not user:
        return _err('user_not_found', 'ユーザーが見つかりません', 404)

    wins = int(user.get("wins", 0) or 0)
    losses = int(user.get("losses", 0) or 0)
    draws = int(user.get("draws", 0) or 0)
    total = wins + losses + draws

    profile = {
        "id": str(user.get("_id")),
        "username": user.get("username"),
        "rating": user.get("rating", 1500),
        "games_played": int(user.get("games_played", 0) or 0),
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "win_rate": (wins / total) if total > 0 else None,
        "user_kind": (user.get('user_kind') or ('guest' if bool(user.get('is_guest')) else 'human')),
        "legion": (user.get('legion') or 'JP'),
        "is_guest": bool(user.get('is_guest', False)),
    }
    return jsonify({"profile": profile}), 200


@user_bp.route("/settings", methods=["PUT"])
@jwt_required(locations=["headers", "cookies"])
def update_settings():
    db = _db()
    sub = get_jwt_identity()
    try:
        uid = ObjectId(sub)
    except Exception:
        return _err('invalid_identity', '認証情報が不正です', 400)

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

    # Move confirmation (client-side UI only)
    if isinstance(settings.get("moveConfirmEnabled"), bool):
        merged["moveConfirmEnabled"] = settings["moveConfirmEnabled"]
        changed = True

    # Review-mode visual helpers (client-side UI only)
    if isinstance(settings.get("reviewDrawNextMove"), bool):
        merged["reviewDrawNextMove"] = settings["reviewDrawNextMove"]
        changed = True
    if isinstance(settings.get("reviewDrawBestMove"), bool):
        merged["reviewDrawBestMove"] = settings["reviewDrawBestMove"]
        changed = True

    # Last move visual effects (client-side UI only)
    if isinstance(settings.get("lastMoveFromHighlightEnabled"), bool):
        merged["lastMoveFromHighlightEnabled"] = settings["lastMoveFromHighlightEnabled"]
        changed = True
    if isinstance(settings.get("lastMovePieceHighlightEnabled"), bool):
        merged["lastMovePieceHighlightEnabled"] = settings["lastMovePieceHighlightEnabled"]
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
        "created_at": 1, "is_active": 1, "is_email_verified": 1, "is_banned": 1, "settings": 1,
        "settings": 1,
    })
    if not user:
        return _err('user_not_found', 'ユーザーが見つかりません', 404)

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
        return _err('unauthorized', 'ログインしてください', 401)
    db = _db()
    try:
        uid = ObjectId(sub)
    except Exception:
        return _err('invalid_identity', '認証情報が不正です', 400)
    user = db.users.find_one({'_id': uid}, {'username':1, 'rating':1, 'created_at':1, 'is_banned':1, 'settings':1})
    if not user:
        return _err('user_not_found', 'ユーザーが見つかりません', 404)
    return jsonify({'profile': _shape(user)}), 200
