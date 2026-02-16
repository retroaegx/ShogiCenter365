# -*- coding: utf-8 -*-
"""System chat helpers.

目的:
- 対局の終局時・切断/再接続などを「システムチャット」として room(game:{game_id}) に送信
- 可能ならゲームdocの chat_messages にも追記（$slice -100）

重複表示対策:
- フロントは (timestamp|user_id|text) で重複排除している。
- MongoDB の datetime はミリ秒精度に丸められやすく、
  live emit と history がズレると二重表示になる。
- ここでは timestamp を **ミリ秒精度の ISO 文字列(Z)** に固定し、
  DB にも同じ文字列を保存する。

i18n:
- システム文言は backend/src/i18n/system_chat/<lang>.json に定義する。
- 対局者2名の language が異なる場合は、両方の言語メッセージを送る。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
import re
from typing import Any, Dict, Optional, Set

try:
    from bson import ObjectId
except Exception:  # pragma: no cover
    ObjectId = None  # type: ignore


_VAR_RE = re.compile(r"\{(\w+)\}")
_SYS_I18N_CACHE: Dict[str, Dict[str, Any]] = {}


def _to_str_id(v: Any) -> str:
    try:
        if ObjectId is not None and isinstance(v, ObjectId):
            return str(v)
    except Exception:
        pass
    if isinstance(v, dict):
        return str(v.get('user_id') or v.get('id') or v.get('_id') or '')
    return str(v or '')


def _utc_iso_ms_z() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _normalize_lang_code(v: Any, default: str = 'en') -> str:
    try:
        s = str(v or '').strip().lower()
    except Exception:
        s = ''
    if not s:
        return default
    base = s.split('-', 1)[0].split('_', 1)[0]
    if base == 'jp':
        base = 'ja'
    if base == 'cn':
        base = 'zh'

    supported = {'ja', 'en', 'zh', 'fr', 'de', 'pl', 'it', 'pt'}
    return base if base in supported else default


def _load_system_chat_locale(lang: str) -> Dict[str, Any]:
    code = _normalize_lang_code(lang, default='en')
    cached = _SYS_I18N_CACHE.get(code)
    if isinstance(cached, dict):
        return cached

    base = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'i18n', 'system_chat'))
    path = os.path.join(base, f'{code}.json')
    data: Dict[str, Any] = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            obj = json.load(f)
            if isinstance(obj, dict):
                data = obj
    except Exception:
        data = {}

    _SYS_I18N_CACHE[code] = data
    return data


def _render_tpl(tpl: Any, vars: Optional[Dict[str, Any]] = None) -> str:
    if not isinstance(tpl, str) or not tpl:
        return ''
    vars = vars or {}

    def repl(m):
        k = m.group(1)
        v = vars.get(k)
        return '' if v is None else str(v)

    try:
        return _VAR_RE.sub(repl, tpl)
    except Exception:
        return str(tpl)


def system_chat_username(lang: str) -> str:
    loc = _load_system_chat_locale(lang)
    return _render_tpl(loc.get('system_username'))


def system_chat_text(lang: str, key: str, vars: Optional[Dict[str, Any]] = None) -> str:
    loc = _load_system_chat_locale(lang)
    return _render_tpl(loc.get(str(key) or ''), vars)


@dataclass
class Players:
    sente_user_id: str
    gote_user_id: str
    sente_name: str
    gote_name: str


def extract_players(game_doc: Dict[str, Any]) -> Players:
    doc = game_doc or {}
    players = doc.get('players') if isinstance(doc.get('players'), dict) else {}

    s = players.get('sente') or {}
    g = players.get('gote') or {}

    s_uid = _to_str_id(s.get('user_id') or doc.get('sente_id') or '')
    g_uid = _to_str_id(g.get('user_id') or doc.get('gote_id') or '')

    s_name = str((s.get('username') or s.get('name') or 'sente') or 'sente').strip() or 'sente'
    g_name = str((g.get('username') or g.get('name') or 'gote') or 'gote').strip() or 'gote'

    return Players(
        sente_user_id=s_uid,
        gote_user_id=g_uid,
        sente_name=s_name,
        gote_name=g_name,
    )


def _users_collection_from_game_model(game_model):
    try:
        db = getattr(game_model, 'database', None)
        if db is not None:
            return db.get_collection('users')
    except Exception:
        pass
    return None


def _get_user_language(users_coll, user_id: str) -> Optional[str]:
    # NOTE: PyMongo Collection does not support truth-value testing.
    # Use explicit None checks instead.
    if users_coll is None or not user_id:
        return None
    q = None
    try:
        q = {'_id': ObjectId(str(user_id))} if ObjectId is not None else {'_id': str(user_id)}
    except Exception:
        q = {'_id': str(user_id)}
    try:
        doc = users_coll.find_one(q, {'language': 1})
        if isinstance(doc, dict):
            return _normalize_lang_code(doc.get('language'))
    except Exception:
        return None
    return None


def _game_player_languages(game_model, game_doc: Dict[str, Any]) -> Set[str]:
    doc = game_doc or {}
    players = doc.get('players') if isinstance(doc.get('players'), dict) else {}

    s = players.get('sente') or {}
    g = players.get('gote') or {}
    langs: Set[str] = set()

    # Prefer language in game_doc players if already present
    for x in (s, g):
        try:
            l = x.get('language')
            if l:
                langs.add(_normalize_lang_code(l))
        except Exception:
            pass

    # Fall back to users collection
    users_coll = _users_collection_from_game_model(game_model)
    p = extract_players(doc)
    for uid in (p.sente_user_id, p.gote_user_id):
        if not uid:
            continue
        l2 = _get_user_language(users_coll, uid)
        if l2:
            langs.add(_normalize_lang_code(l2))

    if not langs:
        langs.add('en')
    # keep only supported for now
    out: Set[str] = set()
    for l in langs:
        out.add(_normalize_lang_code(l))
    return out


def _iter_langs(langs: Set[str]):
    order = {'ja': 0, 'en': 1}
    return sorted((langs or {'en'}), key=lambda x: order.get(_normalize_lang_code(x), 9))


def _name_for_lang(name: str, lang: str) -> str:
    nm = str(name or '').strip()
    if not nm:
        return ''
    if _normalize_lang_code(lang) == 'ja':
        if nm.endswith('さん'):
            return nm
        return nm + 'さん'
    return nm


def emit_system_chat(
    socketio,
    game_model,
    game_id: str,
    text: str,
    extra: Optional[Dict[str, Any]] = None,
    *,
    username: Optional[str] = None,
) -> None:
    """Emit a system chat message and (best-effort) append to chat_messages.

    Dedupe:
      - event == system_game_end は同一対局で1回だけ（言語が違う場合は言語ごとに1回）
    """
    gid = str(game_id or '').strip()
    if not gid or not text:
        return

    payload: Dict[str, Any] = {
        'game_id': gid,
        'text': str(text),
        'user_id': 'system',
        'username': str(username or ''),
        'timestamp': _utc_iso_ms_z(),
    }
    if isinstance(extra, dict):
        for k, v in extra.items():
            if k in payload:
                continue
            payload[k] = v

    should_emit = True

    # persist best-effort
    try:
        if game_model is not None:
            record = dict(payload)
            update = {'$push': {'chat_messages': {'$each': [record], '$slice': -100}}}

            is_game_end = bool(isinstance(extra, dict) and extra.get('event') == 'system_game_end')
            if is_game_end:
                lang = None
                try:
                    lang = extra.get('lang') if isinstance(extra, dict) else None
                except Exception:
                    lang = None

                elem = {'event': 'system_game_end'}
                if lang:
                    elem['lang'] = str(lang)

                # Only once per game (per language)
                dedupe_filter = {
                    '_id': gid,
                    '$nor': [{'chat_messages': {'$elemMatch': elem}}],
                }

                pushed = False
                try:
                    res = game_model.update_one(dedupe_filter, update)
                    pushed = bool(getattr(res, 'matched_count', 0) or getattr(res, 'modified_count', 0))
                except Exception:
                    pushed = False
                if (not pushed) and ObjectId is not None:
                    try:
                        dedupe_filter2 = {
                            '_id': ObjectId(str(gid)),
                            '$nor': [{'chat_messages': {'$elemMatch': elem}}],
                        }
                        res2 = game_model.update_one(dedupe_filter2, update)
                        pushed = bool(getattr(res2, 'matched_count', 0) or getattr(res2, 'modified_count', 0))
                    except Exception:
                        pushed = False
                if not pushed:
                    should_emit = False
            else:
                matched = 0
                try:
                    res = game_model.update_one({'_id': gid}, update)
                    matched = getattr(res, 'matched_count', 0)
                except Exception:
                    matched = 0
                if not matched and ObjectId is not None:
                    try:
                        game_model.update_one({'_id': ObjectId(str(gid))}, update)
                    except Exception:
                        pass
    except Exception:
        should_emit = True

    if not should_emit:
        return

    try:
        room = f'game:{gid}'
        socketio.emit('chat_message', payload, room=room)
    except Exception:
        pass


def emit_localized_system_chat(
    socketio,
    game_model,
    game_doc: Dict[str, Any],
    *,
    key: str,
    vars: Optional[Dict[str, Any]] = None,
    event: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit one or two localized system chat messages.

    If both players use different languages, emit both languages.
    """
    doc = game_doc or {}
    gid = _to_str_id(doc.get('_id') or doc.get('game_id') or '')
    if not gid:
        return

    langs = _game_player_languages(game_model, doc)
    for lang in _iter_langs(langs):
        text = system_chat_text(lang, key, vars)
        if not text:
            continue
        uname = system_chat_username(lang)
        ex = dict(extra or {})
        ex['lang'] = _normalize_lang_code(lang)
        if event:
            ex['event'] = str(event)
        emit_system_chat(socketio, game_model, gid, text, extra=ex, username=uname)


def emit_game_end_system_chat(
    socketio,
    game_model,
    game_doc: Dict[str, Any],
    *,
    reason: str,
    winner_role: str,
    loser_role: str,
) -> None:
    """Emit localized system chat message(s) for game end."""
    doc = game_doc or {}
    gid = _to_str_id(doc.get('_id') or doc.get('game_id') or '')
    if not gid:
        return

    p = extract_players(doc)
    wrole = str(winner_role or '').strip() or str(doc.get('winner') or '')
    lrole = str(loser_role or '').strip() or str(doc.get('loser') or '')
    r = str(reason or '').strip() or 'finished'

    # Determine raw winner name for win case
    winner_name_raw = p.sente_name if wrole == 'sente' else p.gote_name
    if lrole == 'sente':
        winner_name_raw = p.gote_name
    elif lrole == 'gote':
        winner_name_raw = p.sente_name

    langs = _game_player_languages(game_model, doc)
    for lang in _iter_langs(langs):
        key = 'game_end_win'
        vars = {}
        if r in ('draw', 'sennichite'):
            key = 'game_end_draw'
            vars = {}
        else:
            vars = {'winner': _name_for_lang(winner_name_raw, lang)}

        text = system_chat_text(lang, key, vars)
        if not text:
            continue
        uname = system_chat_username(lang)
        ex = {
            'event': 'system_game_end',
            'lang': _normalize_lang_code(lang),
            'reason': r,
            'winner_role': wrole,
            'loser_role': lrole,
        }
        emit_system_chat(socketio, game_model, gid, text, extra=ex, username=uname)
