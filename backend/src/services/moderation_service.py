# -*- coding: utf-8 -*-

"""Moderation / Abuse prevention helpers.

Used by:
  - websocket_manager: detect warning words and set per-user flags
  - admin_server: user management (warn/ban) and warning-word management
  - routes: ban checks

This file aims to be safe to import even when some optional modules are missing.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

try:
    from bson import ObjectId
except Exception:  # pragma: no cover
    ObjectId = None  # type: ignore


def _maybe_oid(v: Any):
    """Convert to ObjectId if possible. Returns original if not convertible."""
    if v is None:
        return None
    if ObjectId is None:
        return v
    try:
        if isinstance(v, ObjectId):
            return v
        s = str(v)
        return ObjectId(s)
    except Exception:
        return v


class ModerationService:
    def __init__(self, db):
        self.db = db
        self.users = self._get_coll('users')
        self.games = self._get_coll('games')
        self.warning_words = self._get_coll('warning_words')
        self.warning_templates = self._get_coll('warning_templates')

        # Best-effort indexes (Mongo only)
        try:
            if self.warning_words is not None and hasattr(self.warning_words, 'create_index'):
                self.warning_words.create_index([('word_lc', 1)], unique=True)
                self.warning_words.create_index([('created_at', -1)])
        except Exception:
            pass
        try:
            if self.warning_templates is not None and hasattr(self.warning_templates, 'create_index'):
                self.warning_templates.create_index([('message_lc', 1)], unique=True)
                self.warning_templates.create_index([('created_at', -1)])
        except Exception:
            pass
        try:
            if self.users is not None and hasattr(self.users, 'create_index'):
                self.users.create_index([('chat_warning_flag', 1), ('username', 1)])
        except Exception:
            pass

    def _get_coll(self, name: str):
        if self.db is None:
            return None
        try:
            return self.db[name]
        except Exception:
            return getattr(self.db, name, None)

    # --- warning words -------------------------------------------------
    def list_warning_words(self) -> List[Dict[str, Any]]:
        col = self.warning_words
        if col is None:
            return []
        # Mongo
        if hasattr(col, 'find'):
            try:
                cur = col.find({}).sort([('word_lc', 1)])
                return [dict(d) for d in cur]
            except Exception:
                pass
        # Memory fallback
        try:
            items = list(getattr(col, '_b', {}).values())
            items.sort(key=lambda d: str((d or {}).get('word_lc') or ''))
            return [dict(d) for d in items]
        except Exception:
            return []

    def add_warning_word(self, word: str) -> Optional[str]:
        col = self.warning_words
        if col is None:
            return None
        w = (word or '').strip()
        if not w:
            return None
        lc = w.lower()
        now = datetime.utcnow()

        # de-dup
        try:
            exist = col.find_one({'word_lc': lc})
            if exist:
                return str(exist.get('_id'))
        except Exception:
            pass

        doc = {'word': w, 'word_lc': lc, 'created_at': now}
        try:
            r = col.insert_one(doc)
            _id = getattr(r, 'inserted_id', None)
            if _id is None and isinstance(r, dict):
                _id = r.get('inserted_id')
            return str(_id) if _id is not None else None
        except Exception:
            # upsert fallback
            try:
                col.update_one({'word_lc': lc}, {'$set': doc}, upsert=True)
                exist = col.find_one({'word_lc': lc})
                return str((exist or {}).get('_id')) if exist else None
            except Exception:
                return None

    def delete_warning_word(self, word_id: str) -> bool:
        col = self.warning_words
        if col is None:
            return False
        oid = _maybe_oid(word_id)
        # Try by _id (ObjectId), then by string.
        try:
            res = col.delete_one({'_id': oid})
            if getattr(res, 'deleted_count', 0):
                return True
        except Exception:
            pass
        try:
            res = col.delete_one({'_id': str(word_id)})
            return bool(getattr(res, 'deleted_count', 0))
        except Exception:
            # memory fallback
            try:
                b = getattr(col, '_b', None)
                if isinstance(b, dict):
                    b.pop(str(word_id), None)
                    return True
            except Exception:
                pass
        return False

    # --- warning templates --------------------------------------------

    @staticmethod
    def default_warning_templates() -> List[Dict[str, str]]:
        """Built-in templates (shown even when DB is empty)."""
        return [
            {
                'name': 'チャットマナー',
                'message': 'チャットの言葉遣い・表現が他者を不快にする可能性があります。以後ご注意ください。繰り返された場合、利用制限（BAN等）を行います。',
            },
            {
                'name': '不適切ワード',
                'message': '不適切な表現（警告ワード）を含むチャットが確認されました。以後送信しないでください。',
            },
            {
                'name': '荒らし行為',
                'message': '荒らし行為とみなされる行動が確認されました。今後同様の行為が続く場合、利用制限（BAN等）を行います。',
            },
            {
                'name': 'スパム/宣伝',
                'message': 'スパム・宣伝目的と思われる投稿が確認されました。以後同様の投稿は行わないでください。',
            },
            {
                'name': '複数アカウント疑い',
                'message': '複数アカウントの利用が疑われる状況が確認されました。心当たりがある場合は停止してください。改善がない場合、利用制限（BAN等）を行います。',
            },
        ]

    def list_warning_templates(self) -> List[Dict[str, Any]]:
        col = self.warning_templates
        items: List[Dict[str, Any]] = []

        # DB templates
        if col is not None and hasattr(col, 'find'):
            try:
                cur = col.find({}).sort([('created_at', -1)])
                for d in cur:
                    if not isinstance(d, dict):
                        continue
                    items.append({
                        'id': str(d.get('_id')),
                        'name': (d.get('name') or '').strip() or 'テンプレート',
                        'message': (d.get('message') or '').strip(),
                        'is_builtin': False,
                    })
            except Exception:
                items = []
        elif col is not None:
            try:
                raw = list(getattr(col, '_b', {}).values())
                for d in raw:
                    if not isinstance(d, dict):
                        continue
                    items.append({
                        'id': str(d.get('_id')),
                        'name': (d.get('name') or '').strip() or 'テンプレート',
                        'message': (d.get('message') or '').strip(),
                        'is_builtin': False,
                    })
            except Exception:
                items = []

        # Built-ins
        builtins = [
            {
                'id': f'builtin-{i+1}',
                'name': t.get('name', 'テンプレート'),
                'message': t.get('message', ''),
                'is_builtin': True,
            }
            for i, t in enumerate(self.default_warning_templates())
        ]

        # merge (dedupe by message)
        merged: List[Dict[str, Any]] = []
        seen = set()
        for t in (builtins + items):
            msg = (t.get('message') or '').strip()
            key = msg.lower()
            if not msg or key in seen:
                continue
            seen.add(key)
            merged.append(t)

        return merged

    def add_warning_template(self, name: str, message: str) -> Optional[str]:
        col = self.warning_templates
        if col is None:
            return None
        msg = (message or '').strip()
        if not msg:
            return None
        nm = (name or '').strip()
        if not nm:
            nm = msg[:18] + ('…' if len(msg) > 18 else '')
        lc = msg.lower()
        now = datetime.utcnow()

        # de-dup by message_lc
        try:
            exist = col.find_one({'message_lc': lc})
            if exist:
                return str(exist.get('_id'))
        except Exception:
            pass

        doc = {'name': nm, 'message': msg, 'message_lc': lc, 'created_at': now}
        try:
            r = col.insert_one(doc)
            _id = getattr(r, 'inserted_id', None)
            if _id is None and isinstance(r, dict):
                _id = r.get('inserted_id')
            return str(_id) if _id is not None else None
        except Exception:
            try:
                col.update_one({'message_lc': lc}, {'$set': doc}, upsert=True)
                exist = col.find_one({'message_lc': lc})
                return str((exist or {}).get('_id')) if exist else None
            except Exception:
                return None

    def delete_warning_template(self, template_id: str) -> bool:
        col = self.warning_templates
        if col is None:
            return False
        oid = _maybe_oid(template_id)
        try:
            res = col.delete_one({'_id': oid})
            if getattr(res, 'deleted_count', 0):
                return True
        except Exception:
            pass
        try:
            res = col.delete_one({'_id': str(template_id)})
            return bool(getattr(res, 'deleted_count', 0))
        except Exception:
            try:
                b = getattr(col, '_b', None)
                if isinstance(b, dict):
                    b.pop(str(template_id), None)
                    return True
            except Exception:
                pass
        return False

    # --- scanning ------------------------------------------------------
    def scan_text(self, text: str) -> List[str]:
        """Return matched warning words.

        Matching policy: case-insensitive substring.
        """
        s = (text or '').strip()
        if not s:
            return []
        s_lc = s.lower()
        words = self.list_warning_words()
        hits: List[str] = []
        for d in words:
            w = (d.get('word') or '').strip()
            if not w:
                continue
            if (d.get('word_lc') or str(w).lower()) in s_lc:
                hits.append(w)
        # unique keep order
        out: List[str] = []
        seen = set()
        for w in hits:
            if w in seen:
                continue
            seen.add(w)
            out.append(w)
        return out

    # --- user flags / actions -----------------------------------------
    def is_banned(self, user_id: Any) -> bool:
        col = self.users
        if col is None:
            return False
        oid = _maybe_oid(user_id)
        try:
            u = col.find_one({'_id': oid}, {'is_banned': 1})
        except Exception:
            try:
                u = col.find_one({'_id': str(user_id)}, {'is_banned': 1})
            except Exception:
                u = None
        return bool((u or {}).get('is_banned'))

    def set_banned(self, user_id: Any, banned: bool) -> bool:
        col = self.users
        if col is None:
            return False
        oid = _maybe_oid(user_id)
        patch = {'is_banned': bool(banned), 'banned_at': datetime.utcnow() if banned else None}
        if not banned:
            patch.pop('banned_at', None)
        try:
            if banned:
                col.update_one({'_id': oid}, {'$set': patch})
            else:
                col.update_one({'_id': oid}, {'$set': {'is_banned': False}, '$unset': {'banned_at': ''}})
            return True
        except Exception:
            try:
                col.update_one({'_id': str(user_id)}, {'$set': patch})
                return True
            except Exception:
                return False
    # Compatibility alias used by older admin UIs
    def set_ban(self, user_id: Any, is_banned: bool = True) -> bool:
        """Alias for set_banned(user_id, banned).

        admin_server.py historically called set_ban(user_id, is_banned=...).
        """
        return self.set_banned(user_id, bool(is_banned))


    def warn_user(self, user_id: Any, message: Optional[str] = None) -> bool:
        col = self.users
        if col is None:
            return False
        msg = (message or '').strip() or '運営からの警告です。利用規約をご確認ください。'
        oid = _maybe_oid(user_id)

        try:
            u = col.find_one({'_id': oid}) or {}
        except Exception:
            try:
                u = col.find_one({'_id': str(user_id)}) or {}
            except Exception:
                u = {}
        cur = int(u.get('warning_count') or 0)
        new_count = cur + 1

        patch = {
            'warning_count': new_count,
            'login_warning_pending': True,
            'login_warning_message': msg,
            'last_warned_at': datetime.utcnow(),
        }

        try:
            col.update_one({'_id': oid}, {'$set': patch})
            return True
        except Exception:
            try:
                col.update_one({'_id': str(user_id)}, {'$set': patch})
                return True
            except Exception:
                return False

    def set_chat_warning_flag(self, user_id: Any, *, hits: Sequence[str] = (), game_id: str = '', text: str = '') -> bool:
        col = self.users
        if col is None:
            return False
        oid = _maybe_oid(user_id)
        patch = {
            'chat_warning_flag': True,
            'chat_warning_last_at': datetime.utcnow(),
            'chat_warning_last_game_id': str(game_id or ''),
            'chat_warning_last_hits': list(hits) if hits else [],
        }
        try:
            col.update_one({'_id': oid}, {'$set': patch})
            return True
        except Exception:
            try:
                col.update_one({'_id': str(user_id)}, {'$set': patch})
                return True
            except Exception:
                return False

    def clear_chat_warning_flag(self, user_id: Any) -> bool:
        col = self.users
        if col is None:
            return False
        oid = _maybe_oid(user_id)
        try:
            col.update_one({'_id': oid}, {'$set': {'chat_warning_flag': False}, '$unset': {
                'chat_warning_last_at': '',
                'chat_warning_last_game_id': '',
                'chat_warning_last_hits': '',
            }})
            return True
        except Exception:
            try:
                col.update_one({'_id': str(user_id)}, {'$set': {'chat_warning_flag': False}})
                return True
            except Exception:
                return False

    def consume_login_warning(self, user_doc: Dict[str, Any]) -> Optional[str]:
        """Return pending warning message and clear it (one-time)."""
        if not user_doc:
            return None
        if not bool(user_doc.get('login_warning_pending')):
            return None
        msg = (user_doc.get('login_warning_message') or '').strip() or '運営からの警告です。利用規約をご確認ください。'
        oid = user_doc.get('_id')
        try:
            if self.users is not None:
                self.users.update_one({'_id': oid}, {'$set': {'login_warning_pending': False, 'login_warning_shown_at': datetime.utcnow()}, '$unset': {'login_warning_message': ''}})
        except Exception:
            pass
        return msg

    # --- admin helpers -------------------------------------------------
    def list_users_for_admin(self) -> List[Dict[str, Any]]:
        col = self.users
        if col is None:
            return []
        fields = {
            'username': 1,
            'email': 1,
            'warning_count': 1,
            'is_banned': 1,
            'chat_warning_flag': 1,
            'created_at': 1,
        }
        items: List[Dict[str, Any]] = []

        if hasattr(col, 'find'):
            try:
                cur = col.find({}, fields)
                # primary sort in python to keep behavior stable even when field missing
                items = [dict(d) for d in cur]
            except Exception:
                items = []
        else:
            try:
                items = [dict(d) for d in list(getattr(col, '_b', {}).values())]
            except Exception:
                items = []

        def key(d: Dict[str, Any]):
            flagged = 1 if bool(d.get('chat_warning_flag')) else 0
            name = str(d.get('username') or '').lower()
            return (-flagged, name)

        items.sort(key=key)
        return items
