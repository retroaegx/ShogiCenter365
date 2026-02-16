# -*- coding: utf-8 -*-

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Tuple

from flask import redirect, render_template, request, url_for

from ..security import login_required

SETTINGS_COLL = "system_settings"
PRESENCE_COLL = "online_users"
OFFERS_COLL = "offers"  # legacy (if used)
DOC_ID = "maintenance"


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


def _get_doc(db: Any) -> Dict[str, Any]:
    coll = _get_coll(db, SETTINGS_COLL)
    if coll is None:
        return {"_id": DOC_ID, "enabled": False}
    try:
        doc = coll.find_one({"_id": DOC_ID}) or {}
    except Exception:
        doc = {}
    if not isinstance(doc, dict):
        doc = {}
    doc.setdefault("_id", DOC_ID)
    doc.setdefault("enabled", False)
    return doc


def _count_pending_requests(db: Any) -> int:
    ou = _get_coll(db, PRESENCE_COLL)
    if ou is None:
        return 0
    try:
        return int(ou.count_documents({"pending_offer": {"$exists": True, "$ne": {}}}))
    except Exception:
        return 0


def _cancel_pending_requests(db: Any) -> Tuple[int, int]:
    """Cancel all pending match requests.

    Returns: (touched_online_users, touched_offers)

    Notes:
    - This cancels only *pending requests* (申請待ち). It does not touch active games.
    - Presence schema is the newer lobby.py one: waiting in {'lobby','seeking','applying','playing'}.
    """
    now = datetime.utcnow()
    touched_ou = 0
    ou = _get_coll(db, PRESENCE_COLL)
    if ou is not None:
        try:
            cursor = ou.find(
                {"$or": [
                    {"pending_offer": {"$exists": True, "$ne": {}}},
                    {"waiting": "applying"},
                ]},
                {"user_id": 1, "waiting": 1, "pending_offer": 1},
            )
            for doc in cursor:
                uid = doc.get("user_id")
                waiting = doc.get("waiting")
                po = doc.get("pending_offer") or {}

                # Never touch active game state.
                if waiting == "playing":
                    continue

                new_waiting = None
                if isinstance(po, dict) and po:
                    if po.get("to_user_id"):
                        # sender side
                        prev = (po.get("prev_waiting") or "lobby").strip() if isinstance(po.get("prev_waiting"), str) else (po.get("prev_waiting") or "lobby")
                        if prev not in ("lobby", "seeking", "spectating"):
                            prev = "lobby"
                        new_waiting = prev
                    elif po.get("from_user_id"):
                        # receiver side
                        new_waiting = "seeking"

                # fallback: if applying but we can't decide, go back to lobby
                if new_waiting is None:
                    if waiting == "applying":
                        new_waiting = "lobby"

                if uid is not None:
                    set_fields = {"pending_offer": {}, "last_seen_at": now}
                    if new_waiting is not None:
                        set_fields["waiting"] = new_waiting
                    try:
                        r = ou.update_one({"user_id": uid}, {"$set": set_fields})
                        if r.matched_count:
                            touched_ou += 1
                    except Exception:
                        pass
        except Exception:
            pass

    touched_offers = 0
    offers = _get_coll(db, OFFERS_COLL)
    if offers is not None:
        try:
            res = offers.update_many(
                {"status": "pending"},
                {"$set": {"status": "canceled", "updated_at": now, "cancel_reason": "maintenance"}},
            )
            touched_offers = int(getattr(res, "modified_count", 0) or 0)
        except Exception:
            pass

    return touched_ou, touched_offers


def _set_doc(db: Any, enabled: bool, message: str) -> None:
    coll = _get_coll(db, SETTINGS_COLL)
    if coll is None:
        return
    doc = {
        "_id": DOC_ID,
        "enabled": bool(enabled),
        "message": message or "",
        "updated_at": datetime.utcnow(),
    }
    try:
        coll.update_one({"_id": DOC_ID}, {"$set": doc}, upsert=True)
    except Exception:
        pass


def register(app) -> None:
    @app.get("/maintenance")
    @login_required
    def admin_maintenance():
        doc = _get_doc(app.dbm.db)
        pending_count = _count_pending_requests(app.dbm.db)
        return render_template(
            "maintenance.html",
            enabled=bool(doc.get("enabled")),
            message=(doc.get("message") or "").strip(),
            updated_at=doc.get("updated_at"),
            pending_count=pending_count,
        )

    @app.post("/maintenance")
    @login_required
    def admin_maintenance_post():
        db = app.dbm.db
        before = _get_doc(db)

        enabled = bool(request.form.get("enabled"))
        message = (request.form.get("message") or "").strip()

        # turning ON: cancel existing pending requests
        touched_ou = 0
        touched_offers = 0
        if enabled and not bool(before.get("enabled")):
            touched_ou, touched_offers = _cancel_pending_requests(db)

        _set_doc(db, enabled=enabled, message=message)

        # Flash-like message (simple query param)
        return redirect(
            url_for(
                "admin_maintenance",
                saved="1",
                canceled_ou=str(touched_ou),
                canceled_offers=str(touched_offers),
            )
        )
