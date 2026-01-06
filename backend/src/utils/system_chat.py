# -*- coding: utf-8 -*-
"""System chat helpers.

目的:
- 対局の終局時に、勝者と敗因を「システムチャット」として room(game:{game_id}) に送信
- 可能ならゲームdocの chat_messages にも追記（$slice -100）

重複表示対策:
- フロントは (timestamp|user_id|text) で重複排除している。
- MongoDB の datetime はミリ秒精度に丸められやすく、
  emit 時の timestamp(マイクロ秒) と history 側の timestamp(ミリ秒) がズレると
  同一メッセージでも別物扱いになって二重表示になる。
- ここでは timestamp を **最初からミリ秒精度の ISO 文字列(Z)** に固定し、
  DB にも同じ文字列を保存することで、reconnect 時の chat_history と live emit が一致し
  フロント側の重複排除が効くようにする。

注意:
- WebSocketManager 内の _emit_system_chat と同じ思想で、
  * emit は JSON safe payload
  * DB保存は best-effort
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional

try:
    from bson import ObjectId
except Exception:  # pragma: no cover
    ObjectId = None  # type: ignore


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
    """UTC now in ISO8601 string with millisecond precision and trailing 'Z'."""
    # datetime.isoformat(timespec='milliseconds') is available in Python 3.6+
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


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

    s_name = str((s.get('username') or s.get('name') or '先手') or '先手').strip() or '先手'
    g_name = str((g.get('username') or g.get('name') or '後手') or '後手').strip() or '後手'

    return Players(
        sente_user_id=s_uid,
        gote_user_id=g_uid,
        sente_name=s_name,
        gote_name=g_name,
    )


def format_game_end_system_text(*, reason: str, winner_name: str, loser_name: str) -> str:
    r = str(reason or 'finished')

    if r == 'resign':
        cause = '投了'
    elif r == 'timeout':
        cause = '時間切れ'
    elif r == 'disconnect_timeout':
        cause = '切断（時間切れ）'
    elif r == 'disconnect_four':
        cause = '切断回数超過'
    else:
        cause = r

    return f"終局：{loser_name} の{cause}。{winner_name} の勝ち。"


def emit_system_chat(
    socketio,
    game_model,
    game_id: str,
    text: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit a system chat message and (best-effort) append to chat_messages.

    Important:
      - 終局(system_game_end) は複数箇所から呼ばれ得るので、同一対局で 1 回だけ送る。
        (DB への push を原子的に行い、既に存在する場合は emit もしない)
    """
    gid = str(game_id or '').strip()
    if not gid or not text:
        return

    payload: Dict[str, Any] = {
        'game_id': gid,
        'text': str(text),
        'user_id': 'system',
        'username': 'システム',
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
                # Only once per game.
                dedupe_filter = {
                    '_id': gid,
                    '$nor': [{'chat_messages': {'$elemMatch': {'event': 'system_game_end'}}}],
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
                            '$nor': [{'chat_messages': {'$elemMatch': {'event': 'system_game_end'}}}],
                        }
                        res2 = game_model.update_one(dedupe_filter2, update)
                        pushed = bool(getattr(res2, 'matched_count', 0) or getattr(res2, 'modified_count', 0))
                    except Exception:
                        pushed = False
                if not pushed:
                    # Already emitted/persisted by another path.
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
        # DB への保存に失敗しても emit 自体は行う（best-effort）
        should_emit = True

    if not should_emit:
        return

    try:
        room = f'game:{gid}'
        socketio.emit('chat_message', payload, room=room)
    except Exception:
        pass


def emit_game_end_system_chat(
    socketio,
    game_model,
    game_doc: Dict[str, Any],
    *,
    reason: str,
    winner_role: str,
    loser_role: str,
) -> None:
    """Emit a system chat message for game end.

    Parameters:
      - winner_role/loser_role are 'sente' or 'gote'
    """
    doc = game_doc or {}
    gid = _to_str_id(doc.get('_id') or doc.get('game_id') or '')
    if not gid:
        return

    p = extract_players(doc)
    wrole = str(winner_role or '').strip() or str(doc.get('winner') or '')
    lrole = str(loser_role or '').strip() or str(doc.get('loser') or '')

    winner_name = p.sente_name if wrole == 'sente' else p.gote_name
    loser_name = p.gote_name if wrole == 'sente' else p.sente_name

    if lrole == 'sente':
        loser_name = p.sente_name
        winner_name = p.gote_name
    elif lrole == 'gote':
        loser_name = p.gote_name
        winner_name = p.sente_name

    text = format_game_end_system_text(
        reason=reason,
        winner_name=winner_name,
        loser_name=loser_name,
    )

    emit_system_chat(
        socketio,
        game_model,
        gid,
        text,
        extra={
            'event': 'system_game_end',
            'reason': reason,
            'winner_role': wrole,
            'loser_role': lrole,
        },
    )
