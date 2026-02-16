# -*- coding: utf-8 -*-

"""Maintenance mode helpers.

Maintenance mode freezes matchmaking-related actions while keeping already
started games running.

MongoDB:
- Collection: system_settings
- Document id: 'maintenance'

Schema (best-effort):
{
  _id: 'maintenance',
  enabled: bool,
  message: str (optional),
  updated_at: datetime (optional)
}

If DB is unavailable, maintenance is treated as disabled.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

try:
    from flask import current_app
except Exception:  # pragma: no cover
    current_app = None  # type: ignore

SETTINGS_COLL = "system_settings"
DOC_ID = "maintenance"


def _get_db_from_app() -> Any:
    try:
        if current_app is None:
            return None
        db = getattr(current_app, "mongo_db", None)
        if db is None:
            db = current_app.config.get("MONGO_DB") if hasattr(current_app, "config") else None
        return db
    except Exception:
        return None


def _get_coll(db: Any, name: str):
    if db is None:
        return None
    try:
        return db[name]
    except Exception:
        try:
            return getattr(db, name)
        except Exception:
            return None


def get_maintenance_doc(db: Any = None) -> Dict[str, Any]:
    """Return maintenance doc, or default if missing."""
    dbi = db if db is not None else _get_db_from_app()
    coll = _get_coll(dbi, SETTINGS_COLL)
    if coll is None:
        return {"_id": DOC_ID, "enabled": False}
    try:
        doc = coll.find_one({"_id": DOC_ID}) or {}
    except Exception:
        doc = {}
    if not isinstance(doc, dict):
        doc = {}
    if "_id" not in doc:
        doc["_id"] = DOC_ID
    if "enabled" not in doc:
        doc["enabled"] = False
    return doc


def is_maintenance_enabled(db: Any = None) -> bool:
    try:
        doc = get_maintenance_doc(db=db)
        return bool(doc.get("enabled"))
    except Exception:
        return False


def maintenance_message(db: Any = None, default: str = "メンテナンス中です") -> str:
    try:
        doc = get_maintenance_doc(db=db)
        msg = (doc.get("message") or "").strip()
        return msg if msg else default
    except Exception:
        return default


def set_maintenance(db: Any, enabled: bool, message: Optional[str] = None) -> bool:
    """Best-effort setter.

    This is mainly for scripts/tests. Admin UI can update Mongo directly too.
    """
    coll = _get_coll(db, SETTINGS_COLL)
    if coll is None:
        return False
    doc: Dict[str, Any] = {"_id": DOC_ID, "enabled": bool(enabled), "updated_at": datetime.utcnow()}
    if message is not None:
        doc["message"] = str(message)
    try:
        coll.update_one({"_id": DOC_ID}, {"$set": doc}, upsert=True)
        return True
    except Exception:
        return False
