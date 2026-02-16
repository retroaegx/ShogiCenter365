# -*- coding: utf-8 -*-

"""Admin-only user moderation services."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

try:
    from bson import ObjectId
except Exception:  # pragma: no cover
    ObjectId = None  # type: ignore


def maybe_oid(v: Any):
    if v is None:
        return None
    if ObjectId is None:
        return v
    try:
        if isinstance(v, ObjectId):
            return v
        return ObjectId(str(v))
    except Exception:
        return v


def uid_str(v: Any) -> str:
    try:
        return str(v)
    except Exception:
        return ""


class UserAdminService:
    def __init__(self, dbm, moderation=None):
        self.dbm = dbm
        self.mod = moderation

    @property
    def users_col(self):
        return getattr(self.dbm, "users", None)

    @property
    def games_col(self):
        return getattr(self.dbm, "games", None)

    def list_users(self, q: str = "") -> List[Dict[str, Any]]:
        q = (q or "").strip()
        q_lc = q.lower()
        rows: List[Dict[str, Any]] = []

        if self.mod is not None and hasattr(self.mod, "list_users_for_admin"):
            try:
                docs = list(self.mod.list_users_for_admin())
            except Exception:
                docs = []
        else:
            col = self.users_col
            if col is None:
                docs = []
            elif getattr(self.dbm, "use_mongodb", False):
                docs = list(col.find({}, {"username": 1, "name": 1, "email": 1, "warning_count": 1, "is_banned": 1, "chat_warning_flag": 1}))
            else:
                docs = list(getattr(col, "_b", {}).values())

        for d in docs:
            if not isinstance(d, dict):
                continue
            username = (d.get("username") or d.get("name") or d.get("email") or "").strip()
            if q and q_lc not in username.lower():
                continue
            rows.append(
                {
                    "id": uid_str(d.get("_id")),
                    "username": username,
                    "warning_count": int(d.get("warning_count") or 0),
                    "is_banned": bool(d.get("is_banned")),
                    "chat_warning_flag": bool(d.get("chat_warning_flag")),
                }
            )

        # sort: chat_warning_flag desc, username asc
        rows.sort(key=lambda r: ((0 if r.get("chat_warning_flag") else 1), (r.get("username") or "").lower()))
        return rows

    def get_username(self, user_id: Any) -> str:
        col = self.users_col
        if col is None:
            return ""
        oid = maybe_oid(user_id)
        doc = None
        try:
            if getattr(self.dbm, "use_mongodb", False):
                doc = col.find_one({"_id": oid}, {"username": 1, "name": 1, "email": 1})
            else:
                doc = getattr(col, "_b", {}).get(uid_str(oid))
        except Exception:
            doc = None
        if isinstance(doc, dict):
            return (doc.get("username") or doc.get("name") or doc.get("email") or "").strip()
        return ""

    def warn_user(self, user_id: Any, message: str) -> None:
        if self.mod is None:
            return
        self.mod.warn_user(maybe_oid(user_id), message=message)

    def list_warning_templates(self) -> List[Dict[str, Any]]:
        if self.mod is None or not hasattr(self.mod, 'list_warning_templates'):
            return []
        try:
            return list(self.mod.list_warning_templates())
        except Exception:
            return []

    def add_warning_template(self, name: str, message: str) -> Any:
        if self.mod is None or not hasattr(self.mod, 'add_warning_template'):
            return None
        try:
            return self.mod.add_warning_template(name=name, message=message)
        except Exception:
            return None

    def set_banned(self, user_id: Any, banned: bool) -> None:
        if self.mod is None:
            return
        # keep backward compatible method names
        if hasattr(self.mod, "set_ban"):
            self.mod.set_ban(maybe_oid(user_id), is_banned=bool(banned))
        else:
            self.mod.set_banned(maybe_oid(user_id), bool(banned))

    def clear_chat_warning_flag(self, user_id: Any) -> None:
        if self.mod is None:
            return
        self.mod.clear_chat_warning_flag(maybe_oid(user_id))

    def list_chat_messages_for_user(self, user_id: Any, limit_games: int = 200) -> List[Dict[str, Any]]:
        games_col = self.games_col
        if games_col is None:
            return []
        uid_s = uid_str(maybe_oid(user_id))
        msgs: List[Dict[str, Any]] = []

        try:
            if getattr(self.dbm, "use_mongodb", False):
                cur = games_col.find({"chat_messages.user_id": uid_s}, {"chat_messages": 1, "updated_at": 1}).sort("updated_at", -1).limit(limit_games)
                games = list(cur)
            else:
                games = list(getattr(games_col, "_b", {}).values())
        except Exception:
            games = []

        for g in games:
            if not isinstance(g, dict):
                continue
            g_id = uid_str(g.get("_id"))
            cms = g.get("chat_messages") if isinstance(g.get("chat_messages"), list) else []
            for m in cms:
                if not isinstance(m, dict):
                    continue
                if uid_str(m.get("user_id")) != uid_s:
                    continue
                ts = m.get("timestamp")
                ts_s = ""
                if isinstance(ts, str):
                    ts_s = ts[:19].replace("T", " ")
                elif isinstance(ts, datetime):
                    ts_s = ts.isoformat()[:19].replace("T", " ")
                msgs.append(
                    {
                        "timestamp": ts_s,
                        "game_id": uid_str(m.get("game_id") or g_id),
                        "text": m.get("text") or "",
                        "flagged": bool(m.get("flagged")),
                        "hit_words": m.get("hit_words") or [],
                    }
                )

        msgs.sort(key=lambda d: d.get("timestamp") or "", reverse=True)
        return msgs
