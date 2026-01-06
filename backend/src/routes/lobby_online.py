# backend/src/routes/lobby_online.py
from datetime import datetime, timezone, timedelta
from flask import Blueprint, jsonify, current_app, request
from flask_jwt_extended import jwt_required, get_jwt_identity
from src.presence_utils import ensure_online_ttl
from bson import ObjectId

online_bp = Blueprint("online_bp", __name__, url_prefix="/api/lobby")

def _db():
    db = getattr(current_app, "mongo_db", None)
    if db is None:
        db = current_app.config.get("MONGO_DB", None)
    return db

def _ensure_ttl(db):
    ensure_online_ttl()
