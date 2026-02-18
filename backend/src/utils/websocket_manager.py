# -*- coding: utf-8 -*-
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from bson import ObjectId

from flask import request, current_app
from flask_socketio import SocketIO, emit, join_room, leave_room, disconnect
from flask_jwt_extended import decode_token
from src.config import TIME_CONTROLS

logger = logging.getLogger(__name__)


class WebSocketManager:
    """
    Minimal, safe WebSocket manager.
    - ユーザーは connect 時に user:{id} ルームへ自動参加（auth.token があれば）
    - lobby への join/leave
    - game:{game_id} への join/leave
    - whoami/ping
    """

    def __init__(self, socketio: SocketIO):
        self.socketio = socketio
        self.connected_users: Dict[str, Dict[str, Any]] = {}   # sid -> {user_id, username, current_room}
        self.user_sessions: Dict[str, set] = {}                # user_id -> set(sid)

        # Post-game player presence (for "退室済み" indicator)
        # - _sid_game_memberships: sid -> set((game_id, role))
        # - _game_player_conn_counts: game_id -> {sente:int, gote:int}
        #
        # NOTE: This is in-memory state (resets on server restart). That's fine:
        # we only need accurate "who is currently connected".
        self._sid_game_memberships: Dict[str, set] = {}
        self._game_player_conn_counts: Dict[str, Dict[str, int]] = {}

        # NOTE: chat helpers are defined as nested functions to keep the class surface minimal.

        def _to_str_id(v) -> str:
            """Best-effort ObjectId/string normalization."""
            try:
                from bson import ObjectId as _OID
                if isinstance(v, _OID):
                    return str(v)
            except Exception:
                pass
            if isinstance(v, dict):
                return str(v.get('user_id') or v.get('id') or v.get('_id') or '')
            return str(v or '')


        def _utc_iso_ms_z(dt: Optional[datetime] = None) -> str:
            """UTC ISO8601 with millisecond precision and trailing 'Z'."""
            d = dt if isinstance(dt, datetime) else None
            if d is None:
                d = datetime.now(timezone.utc)
            try:
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                d = d.astimezone(timezone.utc)
            except Exception:
                pass
            try:
                return d.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            except Exception:
                try:
                    return d.isoformat().replace('+00:00', 'Z')
                except Exception:
                    return str(d)

        def _emit_error(sid: str, code: str, message: Optional[str] = None):
            """Emit backward-compatible error event with stable error_code."""
            try:
                c = str(code or '').strip() or 'error'
            except Exception:
                c = 'error'
            if isinstance(message, str) and message.strip():
                m = message.strip()
            else:
                m = c
            payload = {'error': c, 'error_code': c, 'message': m}
            try:
                emit('error', payload, room=sid)
            except Exception:
                try:
                    emit('error', {'message': m}, room=sid)
                except Exception:
                    pass
        def _looks_like_code(v) -> bool:
            try:
                s = str(v or '').strip()
            except Exception:
                return False
            if not s:
                return False
            for ch in s:
                if not (ch.isalnum() or ch == '_'):
                    return False
            return True

        def _ensure_error_code(payload):
            """Ensure stable error_code for forward-compatible i18n.

            - If `success` is False and `error_code` missing, derive it from
              `error` / `code` / (code-like) `message`.
            - Keep existing `message` for backward compatibility.
            """
            try:
                if not isinstance(payload, dict):
                    return payload
                if payload.get('success') is False and 'error_code' not in payload:
                    ec = payload.get('error') or payload.get('code')
                    if isinstance(ec, str) and ec.strip():
                        payload['error_code'] = ec.strip()
                    else:
                        msg = payload.get('message')
                        if _looks_like_code(msg):
                            payload['error_code'] = str(msg).strip()
                # If we have error_code but no legacy `error`, mirror it.
                if payload.get('success') is False and payload.get('error_code') and not payload.get('error'):
                    payload['error'] = payload.get('error_code')
            except Exception:
                return payload
            return payload


        def _normalize_chat_record(rec: dict, game_id: Optional[str] = None) -> dict:
            """Ensure chat record is JSON safe (timestamp -> ISO string, ids -> str)."""
            out = dict(rec or {})
            if game_id is not None and not out.get('game_id'):
                out['game_id'] = str(game_id)
            # normalize ids
            if 'game_id' in out:
                out['game_id'] = _to_str_id(out.get('game_id'))
            if 'user_id' in out:
                out['user_id'] = _to_str_id(out.get('user_id'))
            # timestamp
            try:
                ts = out.get('timestamp')
                if isinstance(ts, datetime):
                    out['timestamp'] = _utc_iso_ms_z(ts)
                elif ts is None:
                    out.pop('timestamp', None)
            except Exception:
                pass
            return out


        def _json_safe(x):
            """Recursively convert payload into JSON-serializable values.
            - datetime/date -> ISO string (UTC if naive datetime)
            - ObjectId -> str
            - set/tuple -> list
            """
            try:
                from bson import ObjectId as _OID
            except Exception:
                _OID = None  # type: ignore
            from datetime import datetime as _DT, date as _DATE, timezone as _TZ

            def conv(v):
                if v is None:
                    return None
                if _OID is not None and isinstance(v, _OID):
                    return str(v)
                if isinstance(v, (_DT,)):
                    dt = v
                    try:
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=_TZ.utc)
                        dt = dt.astimezone(_TZ.utc)
                        return dt.isoformat().replace('+00:00', 'Z')
                    except Exception:
                        try:
                            return dt.isoformat()
                        except Exception:
                            return str(dt)
                if isinstance(v, _DATE) and not isinstance(v, _DT):
                    try:
                        return v.isoformat()
                    except Exception:
                        return str(v)
                if isinstance(v, (str, int, float, bool)):
                    return v
                if isinstance(v, dict):
                    return {str(k): conv(val) for k, val in v.items()}
                if isinstance(v, (list, tuple, set)):
                    return [conv(i) for i in list(v)]
                # fallback
                try:
                    return str(v)
                except Exception:
                    return None

            return conv(x)

        # ---- lobby offer resume helpers (server-authoritative push on reconnect) ----
        _TIME_CODE_TO_NAME = {k: (v.get('name') or k) for k, v in (TIME_CONTROLS or {}).items()}

        def _time_name_from_code(code: Optional[str]) -> str:
            try:
                if not code:
                    return ''
                s = str(code).strip()
                if not s:
                    return ''
                return _TIME_CODE_TO_NAME.get(s) or s
            except Exception:
                return str(code or '')

        def _maybe_oid(val: str) -> Optional[ObjectId]:
            try:
                s = str(val or '').strip()
                if s and ObjectId.is_valid(s):
                    return ObjectId(s)
            except Exception:
                return None
            return None

        def _load_presence_doc(db, user_id_str: str) -> Optional[dict]:
            """Load online_users record for a user (ObjectId or string)."""
            try:
                oid = _maybe_oid(user_id_str)
                if oid is not None:
                    d = db['online_users'].find_one({'user_id': oid})
                    if d:
                        return d
                return db['online_users'].find_one({'user_id': user_id_str})
            except Exception:
                return None

        def _emit_pending_offer_if_any(user_id_str: str, sid: Optional[str] = None) -> None:
            """If the user has a pending incoming offer, emit offer_created so UI can show accept/decline."""
            try:
                if not user_id_str:
                    return
                db = getattr(current_app, "mongo_db", None)
                if db is None:
                    db = current_app.config.get("MONGO_DB", None)
                if db is None:
                    return

                pres = _load_presence_doc(db, str(user_id_str))
                po = (pres or {}).get('pending_offer') or {}
                if not isinstance(po, dict):
                    return
                # Receiver side has from_user_id.
                from_uid = po.get('from_user_id')
                if not from_uid:
                    return

                time_code = po.get('time_code')
                wi = (pres or {}).get('waiting_info') or {}
                if not isinstance(wi, dict):
                    wi = {}
                game_type = wi.get('game_type') or wi.get('gameType') or 'rating'
                if game_type not in ('rating', 'free'):
                    game_type = 'rating'

                # Resolve sender profile (best-effort)
                from_username = po.get('from_username')
                from_rating = None
                from_user_kind = po.get('from_user_kind')
                try:
                    u_oid = _maybe_oid(str(from_uid))
                    uq = {'_id': u_oid} if u_oid is not None else {'_id': str(from_uid)}
                    u = db['users'].find_one(uq, {'username': 1, 'rating': 1, 'user_kind': 1, 'is_guest': 1, 'legion': 1}) or None
                    if u:
                        if not from_username:
                            from_username = u.get('username')
                        r = u.get('rating')
                        if isinstance(r, (int, float)):
                            from_rating = int(r)
                        if not from_user_kind:
                            uk = u.get('user_kind')
                            if isinstance(uk, str):
                                uk = uk.strip()
                            else:
                                uk = ''
                            if not uk:
                                uk = 'guest' if bool(u.get('is_guest')) else 'human'
                            from_user_kind = uk
                except Exception:
                    pass

                payload = {
                    'type': 'offer_created',
                    'from_user_id': str(from_uid),
                    'to_user_id': str(user_id_str),
                    'game_type': game_type,
                    'requested_game_type': game_type,
                    'time_code': time_code,
                    'time_name': _time_name_from_code(time_code),
                    'from_username': from_username,
                }
                if from_rating is not None:
                    payload['from_rating'] = int(from_rating)
                if from_user_kind:
                    payload['from_user_kind'] = from_user_kind
                try:
                    ca = po.get('created_at')
                    if ca is not None:
                        payload['created_at'] = int(ca)
                except Exception:
                    pass

                target_room = sid or self._user_room(str(user_id_str))
                if target_room:
                    self.socketio.emit('lobby_offer_update', payload, room=target_room)
            except Exception:
                logger.warning('emit_pending_offer_if_any failed', exc_info=True)

        def _build_analysis_snapshot(game_doc: dict, gid: str) -> dict:
            """Build an analysis_update snapshot from game_doc for late joiners."""
            gid = str(gid or '')
            mh = game_doc.get('move_history') if isinstance(game_doc, dict) else None
            if not isinstance(mh, list):
                mh = []
            total = len(mh)
            status = str((game_doc.get('analysis_status') or '') if isinstance(game_doc, dict) else '')
            err = (game_doc.get('analysis_error') if isinstance(game_doc, dict) else None)
            try:
                progress = int(game_doc.get('analysis_progress') or 0)
            except Exception:
                progress = 0
            if progress < 0:
                progress = 0
            # infer progress if missing
            if progress == 0 and total > 0:
                try:
                    for i in range(total):
                        m = mh[i]
                        if isinstance(m, dict) and m.get('analysis') is not None:
                            progress = i + 1
                except Exception:
                    pass
            # normalize status if empty
            if not status:
                if progress >= total and total > 0:
                    status = 'done'
                elif progress > 0:
                    status = 'running'
                else:
                    status = 'none'
            updates = []
            upto = min(progress, total)
            for i in range(upto):
                m = mh[i]
                if not isinstance(m, dict):
                    continue
                if 'analysis' not in m:
                    continue
                updates.append({
                    'index': i,
                    'ply': i + 1,
                    'analysis': m.get('analysis'),
                })
            snap = {
                'game_id': gid,
                'analysis_status': status,
                'analysis_progress': progress,
                'analysis_total': total,
                'updates': updates,  # full snapshot (0..progress)
            }
            if err:
                snap['analysis_error'] = str(err)
            return _json_safe(snap)
        def _load_game_doc(gid: str) -> Optional[dict]:
            """Load game doc via GameService or raw model."""
            try:
                svc = current_app.config.get('GAME_SERVICE')
                if svc is not None and hasattr(svc, 'get_game_by_id'):
                    try:
                        doc = svc.get_game_by_id(str(gid))
                        if doc:
                            return doc
                    except Exception:
                        pass
                gm = getattr(svc, 'game_model', None) if svc is not None else None
                if gm is None:
                    return None
                try:
                    doc = gm.find_one({'_id': str(gid)})
                    if doc:
                        return doc
                except Exception:
                    pass
                try:
                    return gm.find_one({'_id': ObjectId(str(gid))})
                except Exception:
                    return None
            except Exception:
                return None

        def _get_player_user_ids(game_id: str, game_doc: Optional[dict] = None) -> tuple[str, str]:
            """Return (sente_user_id, gote_user_id) as strings (may be '')."""
            doc = game_doc if isinstance(game_doc, dict) else _load_game_doc(game_id)
            if not isinstance(doc, dict):
                return ('', '')
            players = (doc.get('players') or {}) if isinstance(doc.get('players'), dict) else {}
            s_uid = _to_str_id((players.get('sente') or {}).get('user_id') or doc.get('sente_id') or '')
            g_uid = _to_str_id((players.get('gote')  or {}).get('user_id') or doc.get('gote_id')  or '')
            return (s_uid, g_uid)

        # --- post-game presence / shared board auto-disable -------------------
        def _emit_postgame_presence(game_id: str) -> None:
            """Broadcast players' presence to the game room.

            Payload:
              { game_id, presence: { sente: bool, gote: bool } }
            """
            try:
                gid = str(game_id or '').strip()
                if not gid:
                    return
                counts = self._game_player_conn_counts.get(gid) or {'sente': 0, 'gote': 0}
                presence = {
                    'sente': bool(int(counts.get('sente') or 0) > 0),
                    'gote':  bool(int(counts.get('gote')  or 0) > 0),
                }
                self.socketio.emit('postgame_presence', {'game_id': gid, 'presence': presence}, room=f'game:{gid}')
            except Exception:
                logger.warning('emit postgame_presence failed', exc_info=True)

        def _disable_shared_board_for_absent_player(game_id: str, role: str) -> None:
            """If the game is finished and the given role has no connections left,
            disable that player's shared board flag and broadcast shared_board_status.
            """
            try:
                gid = str(game_id or '').strip()
                if not gid or role not in ('sente', 'gote'):
                    return

                doc = _load_game_doc(gid)
                if not isinstance(doc, dict) or str(doc.get('status') or '') != 'finished':
                    return

                svc = current_app.config.get('GAME_SERVICE')
                game_model = getattr(svc, 'game_model', None) if svc is not None else None
                if game_model is None:
                    return

                # Re-load via model for safe _id update
                mdoc = None
                try:
                    mdoc = game_model.find_one({'_id': str(gid)})
                except Exception:
                    mdoc = None
                if mdoc is None:
                    try:
                        mdoc = game_model.find_one({'_id': ObjectId(str(gid))})
                    except Exception:
                        mdoc = None
                if not isinstance(mdoc, dict):
                    mdoc = doc

                sb = dict((mdoc or {}).get('shared_board') or {})
                en0 = sb.get('enabled') or sb.get('players_enabled') or {}
                if not isinstance(en0, dict):
                    en0 = {}
                en = {
                    'sente': bool(en0.get('sente') or False),
                    'gote':  bool(en0.get('gote')  or False),
                }
                if not bool(en.get(role)):
                    return
                en[role] = False

                now = datetime.utcnow()
                update = {
                    'shared_board.enabled': en,
                    # backward-compat field
                    'shared_board.players_enabled': en,
                    'shared_board.updated_at': now,
                    'updated_at': now,
                }
                doc_id = (mdoc or {}).get('_id')
                try:
                    if doc_id is not None:
                        game_model.update_one({'_id': doc_id}, {'$set': update})
                    else:
                        game_model.update_one({'_id': str(gid)}, {'$set': update})
                except Exception:
                    try:
                        game_model.update_one({'_id': ObjectId(str(gid))}, {'$set': update})
                    except Exception:
                        logger.warning('shared board auto-disable persist failed', exc_info=True)
                        return

                mutual = bool(en.get('sente') and en.get('gote'))
                try:
                    self.socketio.emit('shared_board_status', {'game_id': gid, 'enabled': en, 'mutual': mutual}, room=f'game:{gid}')
                except Exception:
                    pass
            except Exception:
                logger.warning('shared board auto-disable failed', exc_info=True)

        def _presence_join_game_player(sid: str, game_id: str, role: str) -> None:
            try:
                gid = str(game_id or '').strip()
                if not sid or not gid or role not in ('sente', 'gote'):
                    return
                key = (gid, role)
                mems = self._sid_game_memberships.get(sid)
                if mems is None:
                    mems = set()
                    self._sid_game_memberships[sid] = mems
                if key in mems:
                    return
                mems.add(key)

                counts = self._game_player_conn_counts.get(gid)
                if not isinstance(counts, dict):
                    counts = {'sente': 0, 'gote': 0}
                    self._game_player_conn_counts[gid] = counts
                counts[role] = int(counts.get(role) or 0) + 1
                _emit_postgame_presence(gid)
            except Exception:
                logger.warning('presence join failed', exc_info=True)

        def _presence_leave_game_player(sid: str, game_id: Optional[str] = None) -> None:
            """Decrement presence for this sid.
            If game_id is given, only affect that game.
            """
            try:
                if not sid:
                    return
                mems = self._sid_game_memberships.get(sid)
                if not mems:
                    return
                gid_filter = str(game_id).strip() if game_id is not None else None
                targets = []
                for (gid, role) in list(mems):
                    if gid_filter and gid != gid_filter:
                        continue
                    targets.append((gid, role))

                for (gid, role) in targets:
                    try:
                        mems.discard((gid, role))
                    except Exception:
                        pass
                    counts = self._game_player_conn_counts.get(gid)
                    if isinstance(counts, dict):
                        counts[role] = max(0, int(counts.get(role) or 0) - 1)
                        # When the last connection for that player disappears, auto-disable their shared board.
                        if int(counts.get(role) or 0) <= 0:
                            _disable_shared_board_for_absent_player(gid, role)
                        # If both sides are 0, keep it clean.
                        if int(counts.get('sente') or 0) <= 0 and int(counts.get('gote') or 0) <= 0:
                            try:
                                self._game_player_conn_counts.pop(gid, None)
                            except Exception:
                                pass
                    _emit_postgame_presence(gid)

                if not mems:
                    try:
                        self._sid_game_memberships.pop(sid, None)
                    except Exception:
                        pass
            except Exception:
                logger.warning('presence leave failed', exc_info=True)

        def _emit_chat_history_to_sid(game_id: str, sid: str, requester_user_id: str = '') -> None:
            """Send chat history to a specific sid.
            - 対局中: 対局者のみ
            - 終局後: 観戦者にも送る
            """
            try:
                gid = str(game_id or '').strip()
                if not gid or not sid:
                    return
                doc = _load_game_doc(gid)
                if not isinstance(doc, dict):
                    return
                # chat history is visible to all joiners (players + spectators).

                raw = doc.get('chat_messages')
                msgs = raw if isinstance(raw, list) else []
                msgs = msgs[-100:]
                norm = [_normalize_chat_record(m, gid) for m in msgs if isinstance(m, dict)]
                self.socketio.emit('chat_history', {'game_id': gid, 'messages': norm}, room=sid)
            except Exception:
                logger.warning('emit_chat_history failed', exc_info=True)
        def _resolve_username_for_user(user_id: str, fallback: Optional[str] = None, game_doc: Optional[dict] = None) -> str:
            """Best-effort username resolver.
            Priority:
              1) fallback
              2) game_doc.players / spectators
              3) users collection
              4) user_id
            """
            try:
                if fallback:
                    fb = str(fallback).strip()
                    if fb:
                        return fb
            except Exception:
                pass
            uid = str(user_id or '').strip()
            if game_doc and uid:
                try:
                    players = (game_doc.get('players') or {}) if isinstance(game_doc.get('players'), dict) else {}
                    for side in ('sente', 'gote'):
                        pl = players.get(side) or {}
                        if str(pl.get('user_id') or '') == uid:
                            name = (pl.get('username') or pl.get('name') or '').strip()
                            if name:
                                return name
                    specs = game_doc.get('spectators') or []
                    if isinstance(specs, list):
                        for sp in specs:
                            if str((sp or {}).get('user_id') or '') == uid:
                                name = ((sp or {}).get('username') or (sp or {}).get('name') or '').strip()
                                if name:
                                    return name
                except Exception:
                    pass
            # users collection
            try:
                db = getattr(current_app, "mongo_db", None)
                if db is None:
                    db = current_app.config.get("MONGO_DB", None)
                users_coll = None
                if db is not None:
                    try:
                        users_coll = db["users"]
                    except Exception:
                        users_coll = getattr(db, "users", None)
                if users_coll is not None and uid:
                    try:
                        rec = users_coll.find_one({'_id': ObjectId(uid)})
                    except Exception:
                        rec = users_coll.find_one({'_id': uid})
                    if isinstance(rec, dict):
                        name = (rec.get('username') or rec.get('name') or '').strip()
                        if name:
                            return name
            except Exception:
                pass
            return uid or (str(fallback or '').strip() or 'unknown')

        def _emit_system_chat(game_id: str, text: str, extra: Optional[dict] = None) -> None:
            """Emit and persist a system chat message into the game's chat history.
            対局中のチャットは "対局者のみ" に配信する（観戦者へは送らない）。
            """
            try:
                gid = str(game_id or '').strip()
                if not gid or not text:
                    return
                room_name = f'game:{gid}'
                payload = {
                    'game_id': gid,
                    'text': str(text),
                    'user_id': 'system',
                    'username': '',
                    'timestamp': _utc_iso_ms_z(),
                }
                if isinstance(extra, dict):
                    for k, v in extra.items():
                        if k in payload:
                            continue
                        payload[k] = v
                # broadcast to the entire game room (players + spectators)
                self.socketio.emit('chat_message', payload, room=room_name)

                # best-effort persist (same semantics as normal chat)
                try:
                    svc = current_app.config.get('GAME_SERVICE')
                    game_model = getattr(svc, 'game_model', None) if svc is not None else None
                    if game_model is not None:
                        record = dict(payload)
                        try:
                            ts = record.get('timestamp')
                            if isinstance(ts, str) and ts.endswith('Z'):
                                from datetime import datetime as _DT
                                record['timestamp'] = _DT.fromisoformat(ts.replace('Z', '+00:00'))
                        except Exception:
                            pass
                        update = {'$push': {'chat_messages': {'$each': [record], '$slice': -100}}}
                        matched = 0
                        try:
                            res = game_model.update_one({'_id': gid}, update)
                            matched = getattr(res, 'matched_count', 0)
                        except Exception:
                            matched = 0
                        if not matched:
                            try:
                                game_model.update_one({'_id': ObjectId(str(gid))}, update)
                            except Exception:
                                pass
                except Exception:
                    logger.warning('system chat history append failed', exc_info=True)
            except Exception:
                logger.warning('emit system chat failed', exc_info=True)

        # expose helpers for other class methods (e.g. _clear_session)
        self._resolve_username_for_user = _resolve_username_for_user  # type: ignore[attr-defined]
        self._emit_system_chat = _emit_system_chat  # type: ignore[attr-defined]

        def _normalize_spectators_list(specs_raw, game_doc=None):
            """Normalize spectators list to [{user_id, username}].

            - Supports list items as dict or raw user_id strings.
            - Deduplicates by user_id.
            - Fills missing username by best-effort resolver.
            """
            try:
                if not isinstance(specs_raw, list):
                    return []
                out = []
                seen = set()
                for sp in specs_raw:
                    try:
                        if isinstance(sp, dict):
                            uid = str(sp.get('user_id') or sp.get('id') or sp.get('_id') or '').strip()
                            uname = str(sp.get('username') or sp.get('name') or '').strip()
                        else:
                            uid = str(sp or '').strip()
                            uname = ''
                        if not uid or uid in seen:
                            continue
                        seen.add(uid)
                        if not uname:
                            uname = _resolve_username_for_user(uid, fallback=None, game_doc=game_doc)
                        out.append({'user_id': uid, 'username': uname})
                    except Exception:
                        continue
                return out
            except Exception:
                return []

        # expose spectators normalizer
        self._normalize_spectators_list = _normalize_spectators_list  # type: ignore[attr-defined]


        def _deduct_paused_into_buckets(self, ts: dict, now_ms: int) -> None:
            """消費済みの paused_spent_ms を現在手番のバケットに確定反映する。
            - initial -> byoyomi -> deferment の順に引く
            - base_at は now_ms に更新（リセットではなく、消費を確定したうえでの開始点）
            """
            try:
                psm = int((ts or {}).get('paused_spent_ms') or 0)
                if psm <= 0:
                    return
                cur = str((ts or {}).get('current_player') or 'sente')
                side = dict((ts or {}).get(cur) or {})
                ini = max(0, int(side.get('initial_ms') or 0))
                byo = max(0, int(side.get('byoyomi_ms') or 0))
                dfr = max(0, int(side.get('deferment_ms') or 0))
                take = min(psm, ini); ini -= take; psm -= take
                take = min(psm, byo); byo -= take; psm -= take
                take = min(psm, dfr); dfr -= take; psm -= take
                side['initial_ms'] = max(0, ini)
                side['byoyomi_ms'] = max(0, byo)
                side['deferment_ms'] = max(0, dfr)
                ts[cur] = side
                ts.pop('paused_spent_ms', None)
                ts['base_at'] = now_ms
            except Exception as e:
                logger.warning('deduct_paused_into_buckets failed: %s', e, exc_info=True)
        # --- connect/disconnect ------------------------------------------------
        @self.socketio.on('connect')
        def _connect(auth):
            sid = request.sid
            try:
                user_id, username = self._decode_user_from_auth(auth)
                if user_id:
                    # keep existing behavior: register session (username may be None at this point)
                    self._set_session(sid, user_id, username)
                    join_room(self._user_room(user_id), sid=sid)
                try:
                    ip = (request.headers.get('X-Forwarded-For') or request.remote_addr or '').split(',')[0].strip()
                    ua = request.headers.get('User-Agent', '')
                except Exception:
                    ip, ua = '', ''
                logger.info("[ws] connect sid=%s user_id=%s username=%s ip=%s ua=%s",
                            sid, user_id, username, ip, ua)
                emit('connected', {'sid': sid, 'user_id': user_id, 'username': username}, room=sid)

                # If an incoming offer exists while the client was backgrounded, re-emit offer_created
                # so the accept/decline UI can be shown immediately after reconnect.
                try:
                    if user_id:
                        _emit_pending_offer_if_any(str(user_id), sid=sid)
                except Exception:
                    pass
                # --- auto-rejoin to active game if presence says 'playing' ---
                try:
                    if user_id:
                        db = getattr(current_app, "mongo_db", None)
                        if db is None:
                            db = current_app.config.get("MONGO_DB", None)
                        svc = current_app.config.get('GAME_SERVICE')
                        if db is not None and svc is not None:
                            # presence record
                            try:
                                uid_obj = ObjectId(user_id)
                            except Exception:
                                uid_obj = None
                            pres = None
                            if uid_obj is not None:
                                pres = db['online_users'].find_one({'user_id': uid_obj})
                            if not pres:
                                # fallback if presence stored as string (unlikely)
                                pres = db['online_users'].find_one({'user_id': user_id})
                            waiting_state = (pres or {}).get('waiting')
                            if waiting_state == 'playing':
                                gm = getattr(svc, 'game_model', None)
                                if gm is not None:
                                    active_statuses = ['active', 'ongoing', 'in_progress', 'started', 'pause']
                                    ors = []
                                    if uid_obj is not None:
                                        ors += [{'sente_id': uid_obj}, {'gote_id': uid_obj}]
                                    ors += [
                                        {'sente_id': user_id}, {'gote_id': user_id},
                                        {'players.sente.user_id': user_id},
                                        {'players.gote.user_id': user_id},
                                    ]
                                    q = {'status': {'$in': active_statuses}, '$or': ors}
                                    cursor = gm.find(q).limit(3)
                                    found_any = False
                                    for d in cursor:
                                        try:
                                            gid = d.get('_id')
                                            if not gid:
                                                continue
                                            room_name = f'game:{gid}'
                                            join_room(room_name, sid=sid)
                                            info = self.connected_users.get(sid) or {}
                                            info['current_room'] = room_name
                                            self.connected_users[sid] = info
                                            try:
                                                # Notify game channel that this user connected (for countdown UI removal)
                                                self.socketio.emit('game:user_connected', {'game_id': str(gid), 'user_id': str(user_id)}, room=room_name)
                                            except Exception:
                                                pass
                                            emit('joined_game', {'room': room_name, 'game_id': gid}, room=sid)
                                            # send past chat on (re)connect
                                            try:
                                                _emit_chat_history_to_sid(str(gid), sid, str(user_id or ''))
                                            except Exception:
                                                pass
                                            try:
                                                svc = getattr(current_app, 'game_service', None)
                                                gm = getattr(svc, 'game_model', None) if svc else None
                                                if gm is not None:
                                                    doc0 = gm.find_one({'_id': gid}) if hasattr(gm, 'find_one') else None
                                                    if not doc0 and hasattr(gm, 'find_one'):
                                                        try:
                                                            from bson import ObjectId as _OID
                                                            doc0 = gm.find_one({'_id': _OID(str(gid))})
                                                        except Exception:
                                                            doc0 = None
                                                    if doc0 and str(doc0.get('status')) in ('active','ongoing','in_progress','started','pause'):
                                                        now = datetime.utcnow()
                                                        now_ms = int(now.timestamp() * 1000)
                                                        ts0 = dict(doc0.get('time_state') or {})
                                                        ts0['base_at'] = int(datetime.utcnow().timestamp() * 1000)
                                                        gm.update_one({'_id': gid}, {'$set': {'time_state.base_at': now_ms, 'updated_at': datetime.utcnow()}})
                                            except Exception:
                                                logger.warning('base_at rebase on reconnect failed', exc_info=True)

                                            try:
                                                svc = current_app.config.get('GAME_SERVICE'); gm = getattr(svc, 'game_model', None) if svc else None
                                                # Always check finished right after rejoin
                                                try:
                                                    _doc0 = gm.find_one({'_id': gid}) if gm else None
                                                    if _doc0 and str(_doc0.get('status')) == 'finished':
                                                        _room = room_name
                                                        try:
                                                            _payload = svc.as_api_payload(gm.find_one({'_id': gid}) or gm.find_one({'_id': ObjectId(str(gid))}))
                                                        except Exception:
                                                            _payload = {'game_id': gid, 'status': 'finished'}
                                                        # notify room and the rejoined sid explicitly
                                                        self.socketio.emit('game_update', _payload, room=_room)
                                                        fin = {
                                                            'game_id': gid,
                                                            'winner': _doc0.get('winner'),
                                                            'loser': _doc0.get('loser'),
                                                            'reason': _doc0.get('finished_reason') or 'finished'
                                                        }
                                                        self.socketio.emit('game:finished', fin, room=_room)
                                                        self.socketio.emit('game:finished', fin, room=sid)
                                                        # stop any dc timers defensively
                                                        try:
                                                            dcs = current_app.config.get('DC_SCHEDULER')
                                                            if dcs is not None:
                                                                # cancel for both roles using user ids
                                                                _ps = _doc0.get('players') or {}
                                                                _suid = str((_ps.get('sente') or {}).get('user_id') or _doc0.get('sente_id') or '')
                                                                _guid = str((_ps.get('gote') or {}).get('user_id') or _doc0.get('gote_id') or '')
                                                                if _suid: dcs.cancel(str(gid), str(_suid))
                                                                if _guid: dcs.cancel(str(gid), str(_guid))
                                                        except Exception:
                                                            pass
                                                        # do not proceed further
                                                        return
                                                except Exception:
                                                    pass
                                                if gm is not None:
                                                    doc = gm.find_one({'_id': gid}) or gm.find_one({'_id': ObjectId(str(gid))})
                                                    if doc:
                                                        def _norm(v):
                                                            try:
                                                                from bson import ObjectId as _OID
                                                                if isinstance(v, _OID): return str(v)
                                                            except Exception: pass
                                                            if isinstance(v, dict): return str(v.get('user_id') or v.get('id') or '')
                                                            return str(v or '')
                                                        s_uid = _norm(doc.get('sente_id') or (doc.get('players') or {}).get('sente', {}).get('user_id'))
                                                        g_uid = _norm(doc.get('gote_id')  or (doc.get('players') or {}).get('gote',  {}).get('user_id'))
                                                        me = _norm(info.get('user_id'))
                                                        role = 'sente' if s_uid and s_uid == me else ('gote' if g_uid and g_uid == me else None)
                                                        try:
                                                            if role:
                                                                _presence_join_game_player(sid, str(gid), role)
                                                        except Exception:
                                                            pass
                                                        ts = dict(doc.get('time_state') or {}); now_ms = int(datetime.utcnow().timestamp() * 1000)
                                                        try:
                                                            if role:
                                                                dslot = (ts.setdefault('disconnect', {}).setdefault(role, {}))
                                                                rem = int(dslot.get('remaining_ms') or 90000)
                                                                was_running = bool(dslot.get('running'))
                                                                if was_running:
                                                                    started = int(dslot.get('started_at') or now_ms)
                                                                    elapsed = max(0, now_ms - started)
                                                                    dslot['remaining_ms'] = max(0, rem - elapsed)
                                                                    dslot['running'] = False; dslot['started_at'] = 0

                                                                    # persist only remaining_ms to DB (no fallback / no try-except)
                                                                    # atomic fix: persist remaining_ms + stop the running interval exactly once
                                                                    _update_base = f"time_state.disconnect.{role}"
                                                                    try:
                                                                        gm.update_one(
                                                                            {
                                                                                '_id': gid,
                                                                                f'{_update_base}.running': True,
                                                                                f'{_update_base}.started_at': started,
                                                                            },
                                                                            {
                                                                                '$set': {
                                                                                    f'{_update_base}.remaining_ms': int(dslot['remaining_ms']),
                                                                                    f'{_update_base}.running': False,
                                                                                    f'{_update_base}.started_at': 0,
                                                                                }
                                                                            }
                                                                        )
                                                                    except Exception:
                                                                        # do not fallback silently; let the error bubble up to logs in outer scope
                                                                        raise
                                                                    if gm is not None and role:

                                                                        _update_path = f"time_state.disconnect.{role}.remaining_ms"

                                                                        gm.update_one({'_id': gid}, {'$set': {_update_path: int(dslot['remaining_ms'])}})
                                                                    try:
                                                                        dcs = current_app.config.get('DC_SCHEDULER')
                                                                        if dcs is not None: dcs.cancel(str(gid), me)
                                                                    except Exception: pass

                                                                    # system chat: reconnect notice (only when a real disconnect timer was running)
                                                                    try:
                                                                        from src.utils.system_chat import emit_localized_system_chat
                                                                        uname = _resolve_username_for_user(str(user_id), fallback=(info.get('username') or username), game_doc=doc)
                                                                        emit_localized_system_chat(
                                                                            self.socketio,
                                                                            gm,
                                                                            doc,
                                                                            key='player_reconnected',
                                                                            vars={'name': uname},
                                                                            event='system_reconnect',
                                                                            extra={'target_user_id': str(user_id)},
                                                                        )
                                                                    except Exception:
                                                                        pass
                                                        except Exception: pass
                                                        s_on = bool(self.user_sessions.get(s_uid)); g_on = bool(self.user_sessions.get(g_uid))
                                                        if s_on and g_on and str(doc.get('status')) == 'pause':
                                                            try:
                                                                psm = int((ts.get('paused_spent_ms') or 0)); self._deduct_paused_into_buckets(ts, now_ms)
                                                            except Exception: pass
                                                            gm.update_one({'_id': gid, 'status': 'pause'}, {'$set': {'status': 'active', 'updated_at': datetime.utcnow()}})
                                                            try:
                                                                sch = current_app.config.get('TIMEOUT_SCHEDULER')
                                                                if sch is not None:
                                                                    fresh = gm.find_one({'_id': gid})
                                                                    sch.schedule_for_game_doc(fresh)
                                                            except Exception: pass
                                                        try:
                                                            payload = svc.as_api_payload(gm.find_one({'_id': gid}))
                                                            self.socketio.emit('game_update', payload, room=room_name)
                                                        except Exception: pass
                                            except Exception: pass
                                            # also push the latest game payload to sync client
                                            try:
                                                payload = svc.as_api_payload(d)
                                                self.socketio.emit('game_update', payload, room=room_name)
                                            except Exception:
                                                pass
                                            # Notify lobby listener to switch view (same path as offer accept)
                                            try:
                                                offer_payload = {'type': 'offer_status', 'status': 'accepted', 'game_id': gid}
                                                self.socketio.emit('lobby_offer_update', offer_payload, room=self._user_room(user_id))
                                            except Exception:
                                                pass
                                            # normalize disconnect slots on rejoin: clear started_at when not running
                                            try:
                                                svc = current_app.config.get('GAME_SERVICE') if not 'svc' in locals() else svc
                                                gm = getattr(svc, 'game_model', None) if svc else None
                                                if gm is not None and gid:
                                                    _fresh = gm.find_one({'_id': gid})
                                                    _ts = dict((_fresh or {}).get('time_state') or {})
                                                    _dc = dict(_ts.get('disconnect') or {})
                                                    for _role in ('sente','gote'):
                                                        _slot = dict(_dc.get(_role) or {})
                                                        if not bool(_slot.get('running')) and int(_slot.get('started_at') or 0) > 0:
                                                            _slot['started_at'] = 0
                                                            _dc[_role] = _slot
                                                    gm.update_one({'_id': gid}, {'$set': {'time_state.disconnect': _dc}})
                                            except Exception:
                                                pass

                                            found_any = True
                                        except Exception:
                                            logger.warning('auto-rejoin: failed to join room', exc_info=True)
                                    if not found_any:
                                        # no active games though presence says playing -> reset to lobby
                                        if uid_obj is not None:
                                            db['online_users'].update_one({'user_id': uid_obj}, {'$set': {'waiting': 'lobby', 'waiting_info': {}}})
                                        else:
                                            db['online_users'].update_one({'user_id': user_id}, {'$set': {'waiting': 'lobby', 'waiting_info': {}}})
                                        try:
                                            from src.services.online_users_emitter import emit_online_users_diff
                                            emit_online_users_diff(db, self.socketio, changed_user_ids=[uid_obj or user_id])
                                        except Exception:
                                            pass
                except Exception as e:
                    logger.warning('auto-rejoin on connect failed: %s', e, exc_info=True)
            except Exception as e:
                logger.error(f'connect error: {e}', exc_info=True)
                # do not drop connection
        @self.socketio.on('disconnect')
        # NOTE: Depending on the Socket.IO server/runtime, the disconnect handler
        # may receive a positional argument (e.g. "reason"). Accept *args/**kwargs
        # for compatibility across environments.
        def _disconnect(*args, **kwargs):
            sid = request.sid
            info = self.connected_users.get(sid) or {}
            
            logger.info("[ws] disconnect sid=%s user_id=%s username=%s",
                        sid, info.get('user_id'), info.get('username'))
            # ---- 切断確定: user_idベースで進行中の対局を検索し、手番なら時間を確定 ----
            try:
                svc = getattr(current_app, 'game_service', None)
                gm = getattr(svc, 'game_model', None) if svc else None
                user_id_raw = (self.connected_users.get(sid) or {}).get('user_id')
                user_id_str = str(user_id_raw or '')
                if gm is not None and user_id_str:
                    try:
                        from bson import ObjectId as _OID
                        user_oid = _OID(user_id_str) if _OID.is_valid(user_id_str) else None
                    except Exception:
                        user_oid = None

                    active_statuses = ['active', 'ongoing', 'in_progress', 'started', 'pause']
                    # 型差吸収: 文字列/ObjId 両対応で IN を使う
                    id_bucket = [user_id_str] + ([user_oid] if user_oid else [])
                    q = {
                        'status': {'$in': active_statuses},
                        '$or': [
                            {'players.sente.user_id': {'$in': id_bucket}},
                            {'players.gote.user_id': {'$in': id_bucket}},
                            {'sente_id': {'$in': id_bucket}},
                            {'gote_id': {'$in': id_bucket}},
                        ]
                    }
                    cursor = gm.find(q).sort([('updated_at', -1)]).limit(8)

                    now_ms = int(datetime.utcnow().timestamp() * 1000)
                    for doc in cursor:
                        try:
                            ts = dict(doc.get('time_state') or {})
                            # 役割判定（文字列/ObjId両対応）
                            def _any_eq(val, candidates):
                                try:
                                    s = {str(x) for x in candidates if x is not None}
                                    return str(val) in s
                                except Exception:
                                    return False
                            s_uid = (doc.get('players') or {}).get('sente', {}) .get('user_id', None)
                            g_uid = (doc.get('players') or {}).get('gote',  {}) .get('user_id', None)
                            s_legacy = doc.get('sente_id', None)
                            g_legacy = doc.get('gote_id', None)

                            role = None
                            if _any_eq(s_uid, id_bucket) or _any_eq(s_legacy, id_bucket):
                                role = 'sente'
                            elif _any_eq(g_uid, id_bucket) or _any_eq(g_legacy, id_bucket):
                                role = 'gote'
                            if not role:
                                continue

                            cur = str(doc.get('current_turn') or (ts.get('current_player') or 'sente'))
                            if str(doc.get('status')) not in active_statuses:
                                continue

                            base_at_prev = int(ts.get('base_at') or now_ms)
                            elapsed = max(0, now_ms - base_at_prev)
                            if elapsed <= 0:
                                continue

                            # pending_spent に合算
                            pend = dict(ts.get('pending_spent') or {})
                            pend[cur] = max(0, int(pend.get(cur) or 0) + elapsed)
                            ts['pending_spent'] = {
                                'sente': int(pend.get('sente') or 0),
                                'gote':  int(pend.get('gote')  or 0),
                            }

                            # バケットから確定減算（initial→byoyomi→deferment）
                            side = dict(ts.get(cur) or {})
                            ini = max(0, int(side.get('initial_ms')   or 0))
                            byo = max(0, int(side.get('byoyomi_ms')   or 0))
                            dfr = max(0, int(side.get('deferment_ms') or 0))
                            e = int(elapsed)
                            take = min(e, ini); ini -= take; e -= take
                            take = min(e, byo); byo -= take; e -= take
                            take = min(e, dfr); dfr -= take; e -= take
                            side['initial_ms']   = max(0, ini)
                            side['byoyomi_ms']   = max(0, byo)
                            side['deferment_ms'] = max(0, dfr)
                            ts[cur] = side

                            # 基準時刻を切断時刻へ更新（再接続後の計測起点）
                            ts['base_at'] = now_ms
                            ts['current_player'] = cur

                            gid = doc.get('_id')
                            # 競合回避: base_atが一致する場合のみ反映
                            filter_q = {'_id': gid, 'status': {'$in': active_statuses}}
                            try:
                                filter_q['time_state.base_at'] = base_at_prev
                            except Exception:
                                pass
                            res = gm.update_one(filter_q, {'$set': {'time_state': ts, 'updated_at': datetime.utcnow()}})
                            if getattr(res, 'modified_count', 1) > 0:
                                try:
                                    if svc and hasattr(svc, 'as_api_payload'):
                                        fresh = gm.find_one({'_id': gid})
                                        payload = svc.as_api_payload(fresh)
                                        self.socketio.emit('game_update', payload, room=f'game:{str(gid)}')
                                except Exception:
                                    pass
                        except Exception as _e:
                            logger.warning('disconnect deduction loop failed: %s', _e, exc_info=True)
            except Exception as _e:
                logger.warning('disconnect deduction outer failed: %s', _e, exc_info=True)

            # post-game presence (players only)
            try:
                _presence_leave_game_player(sid)
            except Exception:
                logger.warning('disconnect presence update failed', exc_info=True)
            self._clear_session(sid)

        # --- lobby -------------------------------------------------------------
        @self.socketio.on('join_lobby')
        def _join_lobby(data=None):
            sid = request.sid
            join_room('lobby', sid=sid)
            info = self.connected_users.get(sid) or {}
            try:
                logger.info('join_lobby sid=%s user_id=%s', sid, info.get('user_id'))
            except Exception:
                pass
            info['current_room'] = 'lobby'
            self.connected_users[sid] = info
            emit('joined_lobby', {'room': 'lobby'}, room=sid)

            # Join lobby is usually called from the Lobby UI after it is mounted.
            # Re-emit pending offer here as well (in case connect fired too early).
            try:
                uid = info.get('user_id')
                if uid:
                    _emit_pending_offer_if_any(str(uid), sid=sid)
            except Exception:
                pass

        @self.socketio.on('leave_lobby')
        def _leave_lobby(data=None):
            sid = request.sid
            leave_room('lobby', sid=sid)
            try:
                logger.info('leave_lobby sid=%s user_id=%s', sid, (self.connected_users.get(sid) or {}).get('user_id'))
            except Exception:
                pass
            info = self.connected_users.get(sid) or {}
            if info.get('current_room') == 'lobby':
                info['current_room'] = None
                self.connected_users[sid] = info
            emit('left_lobby', {'room': 'lobby'}, room=sid)

        # --- whoami / ping -----------------------------------------------------
        @self.socketio.on('whoami')
        def _whoami(data=None):
            sid = request.sid
            info = self.connected_users.get(sid) or {}
            emit('whoami', {'sid': sid, 'user_id': info.get('user_id'), 'username': info.get('username')}, room=sid)

        @self.socketio.on('ping')
        def _ping(data=None):
            sid = request.sid
            emit('pong', {'sid': sid, 'at': datetime.utcnow().isoformat()+'Z'}, room=sid)

        # --- game rooms --------------------------------------------------------
        @self.socketio.on('join_game')
        def _join_game(data=None):
            try:
                sid = request.sid
                data = data or {}
                game_id = (data.get('game_id') or data.get('id') or '')
                room = data.get('room')
                if not game_id and isinstance(room, str) and room.startswith('game:'):
                    game_id = room.split('game:', 1)[1]
                # Accept either raw <id> or room-style 'game:<id>'
                if isinstance(game_id, str) and game_id.startswith('game:'):
                    game_id = game_id.split('game:', 1)[1]
                if not game_id:
                    _emit_error(sid, 'game_id_required', 'game_id required')
                    return
                room_name = f'game:{game_id}'

                # join room
                join_room(room_name, sid=sid)
                info = self.connected_users.get(sid) or {}
                info['current_room'] = room_name
                self.connected_users[sid] = info

                # post-game presence (players only)
                try:
                    uid = info.get('user_id')
                    if uid:
                        doc0 = _load_game_doc(game_id)
                        s_uid, g_uid = _get_player_user_ids(game_id, doc0)
                        me = _to_str_id(uid)
                        role = 'sente' if (me and me == s_uid) else ('gote' if (me and me == g_uid) else None)
                        if role:
                            _presence_join_game_player(sid, game_id, role)
                except Exception:
                    logger.warning('join_game presence update failed', exc_info=True)

                # Always send the current presence snapshot to newcomers (players/spectators)
                try:
                    _emit_postgame_presence(str(game_id))
                except Exception:
                    pass

                # spectator handling: players以外は観戦者として登録
                try:
                    info = self.connected_users.get(sid) or {}
                    uid = info.get('user_id')
                    uname = info.get('username') or ''
                    if uid:
                        from bson import ObjectId as _OID
                        db = getattr(current_app, "mongo_db", None)
                        if db is None:
                            db = current_app.config.get("MONGO_DB", None)
                        # username がない場合は users コレクションから補完
                        if not uname and db is not None:
                            users_coll = None
                            try:
                                if hasattr(db, '__getitem__'):
                                    users_coll = db['users']
                            except Exception:
                                users_coll = None
                            if users_coll is not None:
                                try:
                                    udoc = users_coll.find_one({'_id': _OID(str(uid))}) or {}
                                    uname = udoc.get('username') or udoc.get('name') or ''
                                except Exception:
                                    pass
                        svc = current_app.config.get('GAME_SERVICE')
                        games_coll = None
                        if svc is not None and hasattr(svc, 'game_model'):
                            games_coll = svc.game_model
                        if games_coll is None and db is not None:
                            games_coll = db.get('games') if hasattr(db, 'get') else db['games']
                        doc = None
                        if svc is not None and hasattr(svc, 'get_game_by_id'):
                            try:
                                doc = svc.get_game_by_id(game_id)
                            except Exception:
                                doc = None
                        if doc is None and games_coll is not None:
                            try:
                                doc = games_coll.find_one({'_id': _OID(str(game_id))})
                            except Exception:
                                doc = None

                        def _to_str(v):
                            try:
                                from bson import ObjectId as _OID
                                if isinstance(v, _OID):
                                    return str(v)
                            except Exception:
                                pass
                            if isinstance(v, dict):
                                return str(v.get('user_id') or v.get('id') or '')
                            return str(v or '')

                        s_uid = _to_str(((doc or {}).get('players') or {}).get('sente', {}).get('user_id') or (doc or {}).get('sente_id'))
                        g_uid = _to_str(((doc or {}).get('players') or {}).get('gote', {}).get('user_id') or (doc or {}).get('gote_id'))
                        me_str = _to_str(uid)
                        is_player = me_str and (me_str == s_uid or me_str == g_uid)

                        if not is_player and games_coll is not None:
                            # presence 側: spectating に変更
                            try:
                                if db is not None:
                                    ou_coll = None
                                    try:
                                        # db が Database / dict / Collection いずれでもある程度安全に扱う
                                        if hasattr(db, '__getitem__'):
                                            ou_coll = db['online_users']
                                        else:
                                            ou_coll = db
                                    except Exception:
                                        logger.warning('online_users collection resolve failed', exc_info=True)
                                        ou_coll = None

                                    if ou_coll is not None and hasattr(ou_coll, 'update_one'):
                                        try:
                                            pres = ou_coll.find_one({'user_id': _OID(str(uid))}) or {}
                                        except Exception:
                                            pres = {}
                                        ou_coll.update_one(
                                            {'user_id': _OID(str(uid))},
                                            {'$set': {'waiting': 'spectating', 'waiting_info': {}, 'last_seen_at': datetime.utcnow()}},
                                            upsert=True,
                                        )
                                        try:
                                            from src.services.online_users_emitter import emit_online_users_diff
                                            emit_online_users_diff(db, self.socketio, changed_user_ids=[_OID(str(uid))])
                                        except Exception:
                                            pass
                            except Exception:
                                logger.warning('spectator presence update failed', exc_info=True)

                            # game ドキュメントに観戦者として追加
                            try:
                                if doc is not None:
                                    doc_id = doc.get('_id')
                                    # username を確実に埋める（空だとUI表示が不便）
                                    uname = self._resolve_username_for_user(me_str, fallback=uname, game_doc=doc)
                                    # 既存の同一 user_id エントリ（username違い等）を掃除してから addToSet
                                    try:
                                        games_coll.update_one({'_id': doc_id}, {'$pull': {'spectators': {'user_id': me_str}}})
                                    except Exception:
                                        pass
                                    result = games_coll.update_one(
                                        {'_id': doc_id},
                                        {'$addToSet': {'spectators': {'user_id': me_str, 'username': uname}}},
                                        upsert=False,
                                    )
                                    logger.info(
                                        'join_game spectators update: game_id=%r doc_id=%r matched=%s modified=%s',
                                        game_id,
                                        doc_id,
                                        getattr(result, 'matched_count', None),
                                        getattr(result, 'modified_count', None),
                                    )
                            except Exception:
                                logger.warning('spectators addToSet failed', exc_info=True)

                            # 観戦者一覧をブロードキャスト
                            try:
                                gdoc = {}
                                if doc is not None:
                                    doc_id = doc.get('_id')
                                    gdoc = games_coll.find_one({'_id': doc_id}) or {}
                                specs = self._normalize_spectators_list(gdoc.get('spectators') or [], gdoc)
                                self.socketio.emit(
                                    'spectators_update',
                                    {'game_id': str(game_id), 'spectators': specs, 'count': len(specs)},
                                    room=room_name,
                                )
                                self.socketio.emit(
                                    'lobby_spectators_update',
                                    {'game_id': str(game_id), 'count': len(specs)},
                                    room='lobby',
                                )
                            except Exception:
                                logger.warning('spectators broadcast failed', exc_info=True)
                except Exception:
                    logger.warning('spectator join handling failed', exc_info=True)

                emit('joined_game', {'room': room_name, 'game_id': game_id}, room=sid)
                # send past chat when entering/re-entering a game (players only while active)
                try:
                    info0 = self.connected_users.get(sid) or {}
                    _emit_chat_history_to_sid(str(game_id), sid, str(info0.get('user_id') or ''))
                except Exception:
                    pass

                # Send initial game state + analysis snapshot to this sid.
                # This makes spectators (or late joiners) immediately usable even without REST/JWT.
                try:
                    svc0 = current_app.config.get('GAME_SERVICE') or getattr(current_app, 'game_service', None)
                    if svc0 is not None and hasattr(svc0, 'get_game_by_id') and hasattr(svc0, 'as_api_payload'):
                        me_uid0 = (self.connected_users.get(sid) or {}).get('user_id')
                        doc0 = None
                        try:
                            doc0 = svc0.get_game_by_id(str(game_id))
                        except Exception:
                            doc0 = None
                        if not doc0:
                            # ObjectId fallback (deployments that store _id as ObjectId)
                            try:
                                from bson import ObjectId as _OID
                                gm0 = getattr(svc0, 'game_model', None)
                                if gm0 is not None:
                                    doc0 = gm0.find_one({'_id': _OID(str(game_id))})
                            except Exception:
                                doc0 = None
                        if isinstance(doc0, dict):
                            # game snapshot
                            try:
                                payload0 = svc0.as_api_payload(doc0, str(me_uid0) if me_uid0 else None)
                                if isinstance(payload0, dict):
                                    self.socketio.emit('game_update', _json_safe(payload0), room=sid)
                            except Exception:
                                logger.warning('join_game initial game_update failed', exc_info=True)
                            # analysis snapshot
                            try:
                                snap0 = _build_analysis_snapshot(doc0, str(game_id))
                                if isinstance(snap0, dict):
                                    self.socketio.emit('analysis_update', snap0, room=sid)
                            except Exception:
                                logger.warning('join_game analysis snapshot failed', exc_info=True)
                            # shared board snapshot (post-game shared review board)
                            try:
                                sb0 = (doc0 or {}).get('shared_board') or {}
                                en0 = sb0.get('enabled') or sb0.get('players_enabled') or {}
                                if not isinstance(en0, dict):
                                    en0 = {}
                                enabled0 = {
                                    'sente': bool(en0.get('sente') or False),
                                    'gote': bool(en0.get('gote') or False),
                                }
                                total_main0 = len((doc0 or {}).get('move_history') or [])
                                try:
                                    cur0 = sb0.get('cursor')
                                    cur0 = int(cur0) if cur0 is not None else int(total_main0)
                                except Exception:
                                    cur0 = int(total_main0)
                                br0 = sb0.get('branch')
                                if not isinstance(br0, dict):
                                    br0 = None
                                mutual0 = bool(enabled0.get('sente') and enabled0.get('gote'))
                                self.socketio.emit('shared_board_status', {
                                    'game_id': str(game_id),
                                    'enabled': enabled0,
                                    'mutual': mutual0,
                                }, room=sid)
                                self.socketio.emit('shared_board_state', {
                                    'game_id': str(game_id),
                                    'total_moves': int(total_main0),
                                    'cursor': int(cur0),
                                    'branch': br0,
                                }, room=sid)
                            except Exception:
                                logger.warning('join_game shared board snapshot failed', exc_info=True)
                except Exception:
                    logger.warning('join_game initial snapshot failed', exc_info=True)
            except Exception as e:
                logger.error(f'join_game error: {e}', exc_info=True)

        @self.socketio.on('leave_game')
        def _leave_game(data=None):
            try:
                sid = request.sid
                data = data or {}
                game_id = (data.get('game_id') or data.get('id') or '')
                room = data.get('room')
                if not game_id and isinstance(room, str) and room.startswith('game:'):
                    game_id = room.split('game:', 1)[1]
                # Accept either raw <id> or room-style 'game:<id>'
                if isinstance(game_id, str) and game_id.startswith('game:'):
                    game_id = game_id.split('game:', 1)[1]
                room_name = None
                if isinstance(room, str):
                    room_name = room
                if not room_name and game_id:
                    room_name = f'game:{game_id}'
                if room_name:
                    leave_room(room_name, sid=sid)
                info = self.connected_users.get(sid) or {}
                if info.get('current_room') == room_name:
                    info['current_room'] = None
                    self.connected_users[sid] = info

                # post-game presence (players only)
                try:
                    if game_id:
                        _presence_leave_game_player(sid, str(game_id))
                except Exception:
                    logger.warning('leave_game presence update failed', exc_info=True)

                # 観戦者としての退出処理
                try:
                    uid = info.get('user_id')
                    if uid and room_name:
                        from bson import ObjectId as _OID
                        db = getattr(current_app, "mongo_db", None)
                        if db is None:
                            db = current_app.config.get("MONGO_DB", None)
                        svc = current_app.config.get('GAME_SERVICE')
                        games_coll = None
                        if svc is not None and hasattr(svc, 'game_model'):
                            games_coll = svc.game_model
                        if games_coll is None and db is not None:
                            games_coll = db.get('games') if hasattr(db, 'get') else db['games']

                        if games_coll is not None and game_id:
                            try:
                                # doc_id は文字列/ObjId どちらでもあり得るため、まず実ドキュメントを引いてから更新する
                                doc = None
                                try:
                                    if svc is not None and hasattr(svc, 'get_game_by_id'):
                                        doc = svc.get_game_by_id(str(game_id))
                                except Exception:
                                    doc = None
                                if doc is None:
                                    try:
                                        doc = games_coll.find_one({'_id': str(game_id)})
                                    except Exception:
                                        doc = None
                                if doc is None:
                                    try:
                                        doc = games_coll.find_one({'_id': _OID(str(game_id))})
                                    except Exception:
                                        doc = None

                                doc_id = (doc or {}).get('_id') or str(game_id)

                                # spectators から除外（観戦者のみ）
                                try:
                                    games_coll.update_one({'_id': doc_id}, {'$pull': {'spectators': {'user_id': str(uid)}}})
                                except Exception:
                                    pass

                                gdoc = games_coll.find_one({'_id': doc_id}) or {}
                                specs = self._normalize_spectators_list(gdoc.get('spectators') or [], gdoc)

                                self.socketio.emit(
                                    'spectators_update',
                                    {'game_id': str(game_id), 'spectators': specs, 'count': len(specs)},
                                    room=room_name,
                                )
                                self.socketio.emit(
                                    'lobby_spectators_update',
                                    {'game_id': str(game_id), 'count': len(specs)},
                                    room='lobby',
                                )
                            except Exception:
                                logger.warning('spectators update on leave failed', exc_info=True)

                        # presence が spectating なら lobby に戻す
                        try:
                            from src.presence_utils import get_db
                            db2 = get_db()
                            ou_coll = db2["online_users"]
                            pres = ou_coll.find_one({'user_id': _OID(str(uid))}) or {}
                            if pres.get('waiting') == 'spectating':
                                ou_coll.update_one(
                                    {'user_id': _OID(str(uid))},
                                    {'$set': {'waiting': 'lobby', 'waiting_info': {}, 'last_seen_at': datetime.utcnow()}},
                                )
                                try:
                                    from src.services.online_users_emitter import emit_online_users_diff
                                    emit_online_users_diff(db2, self.socketio, changed_user_ids=[_OID(str(uid))])
                                except Exception:
                                    pass
                        except Exception:
                            logger.warning('spectator presence reset failed', exc_info=True)
                except Exception:
                    logger.warning('spectator leave handling failed', exc_info=True)

                emit('left_game', {'room': room_name, 'game_id': game_id}, room=sid)
            except Exception as e:
                logger.error(f'leave_game error: {e}', exc_info=True)

        # --- game actions ------------------------------------------------------
# --- game actions ------------------------------------------------------

        @self.socketio.on('chat_message')
        def _chat_message(data=None):
            """Game chat: receive and broadcast to game room."""
            try:
                sid = request.sid
                data = data or {}
                game_id = str(data.get('game_id') or data.get('id') or '').strip()
                text = (data.get('text') or '').strip()
                if not game_id or not text:
                    _emit_error(sid, 'game_id_and_text_required', 'game_id and text required'); return

                info = self.connected_users.get(sid) or {}
                user_id = str(info.get('user_id') or '')
                username = info.get('username') or None

                # resolve username strictly if missing: users collection -> GameService players/spectators
                if user_id and not username:
                    try:
                        db = getattr(current_app, "mongo_db", None)
                        if db is None:
                            db = current_app.config.get("MONGO_DB", None)
                        users_coll = None
                        if db is not None:
                            try:
                                users_coll = db["users"]
                            except Exception:
                                users_coll = getattr(db, "users", None)
                        if users_coll is not None:
                            try:
                                rec = users_coll.find_one({'_id': ObjectId(str(user_id))})
                            except Exception:
                                rec = users_coll.find_one({'_id': user_id})
                            if isinstance(rec, dict):
                                username = rec.get('username') or rec.get('name') or username
                    except Exception:
                        pass

                if user_id and not username:
                    try:
                        svc = current_app.config.get('GAME_SERVICE')
                        if svc is not None:
                            doc = svc.get_game_by_id(game_id) or {}
                            players = doc.get('players') or {}
                            for side in ('sente', 'gote'):
                                pl = players.get(side) or {}
                                if str(pl.get('user_id') or '') == user_id:
                                    username = pl.get('username') or username
                                    break
                            if not username:
                                specs = doc.get('spectators') or []
                                for sp in specs:
                                    if str(sp.get('user_id') or '') == user_id:
                                        username = sp.get('username') or username
                                        break
                    except Exception:
                        pass

                if not user_id or not username:
                    _emit_error(sid, 'username_required'); return

                # Chat permission:
                # - 対局中（finished 以外）: 対局者のみ送信可
                # - 終局後（finished）: 対局者 + 観戦者（spectators に登録済み）のみ送信可
                gdoc = _load_game_doc(game_id) or {}
                status = str((gdoc or {}).get('status') or '')
                s_uid, g_uid = _get_player_user_ids(game_id, gdoc)
                me_id = str(user_id or '')
                is_player = bool(me_id) and me_id in (str(s_uid), str(g_uid))
                is_finished = (status == 'finished')

                if not is_finished and not is_player:
                    _emit_error(sid, 'chat_for_players_only')
                    return

                if is_finished and not is_player:
                    # allow only registered spectators
                    try:
                        specs = (gdoc or {}).get('spectators') or []
                        ok = False
                        if isinstance(specs, list):
                            for sp in specs:
                                try:
                                    if str((sp or {}).get('user_id') or '') == me_id:
                                        ok = True
                                        break
                                except Exception:
                                    continue
                        if not ok:
                            _emit_error(sid, 'chat_not_allowed')
                            return
                    except Exception:
                        _emit_error(sid, 'chat_not_allowed')
                        return

                room_name = f'game:{game_id}'
                payload = {
                    'game_id': game_id,
                    'text': text,
                    'user_id': user_id,
                    'username': username,
                    'timestamp': _utc_iso_ms_z(),
                }

                # Moderation: warning-word scan (case-insensitive substring)
                try:
                    hits = []
                    flagged = False
                    mod = current_app.config.get('MODERATION_SERVICE')
                    if mod is not None:
                        try:
                            hits = list(mod.scan_text(text))
                        except Exception:
                            hits = []
                        if hits:
                            flagged = True
                            payload['flagged'] = True
                            payload['hit_words'] = hits
                            # Set per-user chat warning flag for admin review.
                            try:
                                mod.set_chat_warning_flag(user_id, hits=hits, game_id=game_id, text=text)
                            except Exception:
                                pass
                except Exception:
                    pass
                # chat is visible to everyone in the game room (players + spectators)
                self.socketio.emit('chat_message', payload, room=room_name)

                # best-effort: append to game's chat history so reconnect/late-join can see messages
                try:
                    svc = current_app.config.get('GAME_SERVICE')
                    game_model = getattr(svc, 'game_model', None) if svc is not None else None
                    if game_model is not None:
                        record = dict(payload)
                        try:
                            ts = record.get('timestamp')
                            if isinstance(ts, str) and ts.endswith('Z'):
                                from datetime import datetime as _DT
                                record['timestamp'] = _DT.fromisoformat(ts.replace('Z', '+00:00'))
                        except Exception:
                            pass
                        update = {'$push': {'chat_messages': {'$each': [record], '$slice': -100}}}
                        gid = record.get('game_id')
                        if gid:
                            matched = 0
                            try:
                                res = game_model.update_one({'_id': gid}, update)
                                matched = getattr(res, 'matched_count', 0)
                            except Exception:
                                matched = 0
                            if not matched:
                                try:
                                    game_model.update_one({'_id': ObjectId(str(gid))}, update)
                                except Exception:
                                    pass
                except Exception as _e:
                    logger.warning('chat_message history append failed: %s', _e, exc_info=True)

            except Exception as e:
                logger.error(f'chat_message error: {e}', exc_info=True)
        @self.socketio.on('make_move')
        def _make_move(data=None):
            try:
                sid = request.sid
                data = data or {}
                # resolve game_id and convert payload to service format
                game_id = str(data.get('game_id') or data.get('id') or '')
                if not game_id:
                    _emit_error(sid, 'game_id_required', 'game_id required'); return
                                # STRICT: pass-through payload to service (no normalization)
                payload = data or {}
                svc = current_app.config.get('GAME_SERVICE')
                if not svc:
                    _emit_error(sid, 'service_unavailable'); return

                info = self.connected_users.get(sid) or {}
                me = str(info.get('user_id') or '')
                if not me:
                    _emit_error(sid, 'unauthorized'); return


                # --- strict timeout precheck (投了と同じ扱い) ---
                try:
                    doc0 = svc.get_game_by_id(game_id) or {}
                    if str((doc0 or {}).get('status')) != 'finished':
                        ts0 = (doc0.get('time_state') or {}) if isinstance(doc0.get('time_state'), dict) else {}
                        cur = str(doc0.get('current_turn') or (ts0.get('current_player') or 'sente'))
                        base_at0 = int(ts0.get('base_at') or doc0.get('base_at') or 0)
                        side0 = ts0.get(cur) or {}
                        cfg0 = (ts0.get('config') or {}) if isinstance(ts0.get('config'), dict) else {}
                        # remaining initial time, if tracked
                        left = side0.get('left_ms')
                        init = int((side0.get('initial_ms') if side0.get('initial_ms') is not None else (left if left is not None else 0)) or 0)
                        byo  = int((side0.get('byoyomi_ms') if side0.get('byoyomi_ms') is not None else (cfg0.get('byoyomi_ms') or 0)) or 0)
                        defer= int((side0.get('deferment_ms') if side0.get('deferment_ms') is not None else (cfg0.get('deferment_ms') or 0)) or 0)
                        allowed = (init + byo) if init > 0 else byo
                        allowed += defer
                        import time as _t
                        now_ms = int(_t.time() * 1000)
                        if base_at0 and now_ms > base_at0 + max(0, allowed):
                            # Timeout handling is centralized in GameService.
                            finished = False
                            try:
                                finished = bool(svc.check_and_finish_timeout(game_id, base_at_expected=base_at0))
                            except Exception:
                                try:
                                    finished = bool(svc.check_and_finish_timeout(game_id))
                                except Exception:
                                    finished = False

                            if finished:
                                # Backward compatible: keep `error` while adding `error_code`.
                                emit(
                                    'move_result',
                                    {'success': False, 'error': 'timeout', 'error_code': 'timeout', 'message': 'timeout', 'game_id': game_id},
                                    room=sid,
                                )
                                return
                except Exception:
                    logger.warning('precheck timeout failed', exc_info=True)

                res = svc.make_move(game_id, me, payload)

                # notify sender with result
                payload_res = dict(res or {})
                _ensure_error_code(payload_res)
                payload_res['game_id'] = game_id
                emit('move_result', payload_res, room=sid)
                # broadcast to room if success
                if isinstance(res, dict) and res.get('success'):
                    room_name = f'game:{game_id}'
                    # emit concise move event for any clients using it
                    self.socketio.emit('game:move', dict(res or {}, game_id=game_id), room=room_name)
                    # also emit canonical game_update with normalized payload so both players/spectators update
                    try:
                        doc = svc.get_game_by_id(game_id)
                        payload2 = svc.as_api_payload(doc, me) if hasattr(svc, 'as_api_payload') else {'game_id': game_id}
                        self.socketio.emit('game_update', payload2, room=room_name)
                        # schedule / refresh timeout in Redis ZSET
                        try:
                            scheduler = current_app.config.get('TIMEOUT_SCHEDULER')
                            if scheduler:
                                scheduler.schedule_for_game_doc(doc)
                        except Exception:
                            logger.warning('failed to schedule timeout after move', exc_info=True)
                    except Exception:
                        logger.warning('failed to emit game_update after move', exc_info=True)
            except Exception as e:
                logger.error(f'connect error: {e}', exc_info=True)
                # do not drop connection



        # --- whoami / ping -----------------------------------------------------


        # --- game rooms --------------------------------------------------------


        # --- game actions ------------------------------------------------------



        @self.socketio.on('resign')
        def _resign(data=None):
            try:
                sid = request.sid
                data = data or {}
                game_id = str(data.get('game_id') or data.get('id') or '')
                if not game_id:
                    _emit_error(sid, 'game_id_required', 'game_id required'); return
                info = self.connected_users.get(sid) or {}
                me = str(info.get('user_id') or '')
                if not me:
                    _emit_error(sid, 'unauthorized'); return
                svc = current_app.config.get('GAME_SERVICE')
                if not svc:
                    _emit_error(sid, 'service_unavailable'); return
                res = svc.resign_game(game_id, me)
                if isinstance(res, dict) and res.get('success'):
                    room_name = f'game:{game_id}'
                    try:
                        doc = svc.get_game_by_id(game_id)
                        payload2 = (svc.as_api_payload(doc, me) if hasattr(svc, 'as_api_payload') else {'game_id': game_id})
                        self.socketio.emit('game_update', payload2, room=room_name)
                    except Exception:
                        logger.warning('failed to emit game_update after resign', exc_info=True)
            except Exception as e:
                logger.error(f'resign error: {e}', exc_info=True)
    # ---------------- utilities ------------------------------------------------
        # --- shared review board (post-game, server-synced) -----------------------
        @self.socketio.on('shared_board_toggle')
        def _shared_board_toggle(data=None):
            try:
                sid = request.sid
                data = data or {}
                game_id = str(data.get('game_id') or data.get('id') or '').strip()
                if not game_id:
                    _emit_error(sid, 'game_id_required', 'game_id required'); return
                info = self.connected_users.get(sid) or {}
                me = str(info.get('user_id') or '').strip()
                if not me:
                    _emit_error(sid, 'unauthorized'); return

                svc = current_app.config.get('GAME_SERVICE')
                game_model = getattr(svc, 'game_model', None) if svc is not None else None
                if game_model is None:
                    _emit_error(sid, 'service_unavailable'); return

                # Load current doc
                doc = None
                try:
                    doc = game_model.find_one({'_id': str(game_id)})
                except Exception:
                    doc = None
                if doc is None:
                    try:
                        doc = game_model.find_one({'_id': ObjectId(str(game_id))})
                    except Exception:
                        doc = None
                if not isinstance(doc, dict):
                    _emit_error(sid, 'game_not_found'); return

                # Only post-game
                if str(doc.get('status')) != 'finished':
                    _emit_error(sid, 'shared_board_postgame_only'); return

                s_uid, g_uid = _get_player_user_ids(game_id, doc)
                role = 'sente' if (s_uid and s_uid == me) else ('gote' if (g_uid and g_uid == me) else None)
                if role is None:
                    _emit_error(sid, 'players_only'); return

                enabled_req = bool(data.get('enabled'))
                sb = dict(doc.get('shared_board') or {})
                en = sb.get('enabled')
                if not isinstance(en, dict):
                    en = {}
                en = {'sente': bool(en.get('sente') or False), 'gote': bool(en.get('gote') or False)}
                en[role] = bool(enabled_req)

                total_main = len((doc.get('move_history') or []))
                # default cursor to end of mainline
                try:
                    cur = sb.get('cursor')
                    cur = int(cur) if cur is not None else int(total_main)
                except Exception:
                    cur = int(total_main)
                br = sb.get('branch')
                if not isinstance(br, dict):
                    br = None

                offer_sent = bool(sb.get('offer_sent') or False)
                # If first enable in this game, notify others once
                should_offer = (enabled_req and not offer_sent)
                if should_offer:
                    offer_sent = True

                mutual = bool(en.get('sente') and en.get('gote'))

                new_sb = {
                    'enabled': en,
                    'cursor': int(cur),
                    'branch': br,
                    'offer_sent': bool(offer_sent),
                    'updated_at': datetime.utcnow(),
                }

                # persist
                try:
                    doc_id = doc.get('_id')
                    if doc_id is not None:
                        game_model.update_one({'_id': doc_id}, {'$set': {'shared_board': new_sb, 'updated_at': datetime.utcnow()}})
                    else:
                        game_model.update_one({'_id': str(game_id)}, {'$set': {'shared_board': new_sb, 'updated_at': datetime.utcnow()}})
                except Exception:
                    # best effort fallback
                    try:
                        game_model.update_one({'_id': ObjectId(str(game_id))}, {'$set': {'shared_board': new_sb, 'updated_at': datetime.utcnow()}})
                    except Exception:
                        logger.warning('shared_board_toggle persist failed', exc_info=True)

                room_name = f'game:{game_id}'

                # send offer popup once (exclude sender)
                if should_offer:
                    try:
                        self.socketio.emit('shared_board_offer', {
                            'game_id': str(game_id),
                            'initiator_user_id': me,
                            'initiator_role': role,
                        }, room=room_name, include_self=False)
                    except Exception:
                        # fallback: skip_sid supported in most setups
                        try:
                            self.socketio.emit('shared_board_offer', {
                                'game_id': str(game_id),
                                'initiator_user_id': me,
                                'initiator_role': role,
                            }, room=room_name, skip_sid=sid)
                        except Exception:
                            logger.warning('shared_board_offer emit failed', exc_info=True)

                # broadcast status/state to all
                try:
                    self.socketio.emit('shared_board_status', {
                        'game_id': str(game_id),
                        'enabled': en,
                        'mutual': mutual,
                    }, room=room_name)
                except Exception:
                    pass
                try:
                    self.socketio.emit('shared_board_state', {
                        'game_id': str(game_id),
                        'total_moves': int(total_main),
                        'cursor': int(cur),
                        'branch': br,
                    }, room=room_name)
                except Exception:
                    pass

            except Exception as e:
                logger.error(f'shared_board_toggle error: {e}', exc_info=True)

        @self.socketio.on('shared_board_update')
        def _shared_board_update(data=None):
            try:
                sid = request.sid
                data = data or {}
                game_id = str(data.get('game_id') or data.get('id') or '').strip()
                if not game_id:
                    _emit_error(sid, 'game_id_required', 'game_id required'); return
                info = self.connected_users.get(sid) or {}
                me = str(info.get('user_id') or '').strip()
                if not me:
                    _emit_error(sid, 'unauthorized'); return

                svc = current_app.config.get('GAME_SERVICE')
                game_model = getattr(svc, 'game_model', None) if svc is not None else None
                if game_model is None:
                    _emit_error(sid, 'service_unavailable'); return

                doc = None
                try:
                    doc = game_model.find_one({'_id': str(game_id)})
                except Exception:
                    doc = None
                if doc is None:
                    try:
                        doc = game_model.find_one({'_id': ObjectId(str(game_id))})
                    except Exception:
                        doc = None
                if not isinstance(doc, dict):
                    _emit_error(sid, 'game_not_found'); return

                if str(doc.get('status')) != 'finished':
                    _emit_error(sid, 'shared_board_postgame_only'); return

                s_uid, g_uid = _get_player_user_ids(game_id, doc)
                role = 'sente' if (s_uid and s_uid == me) else ('gote' if (g_uid and g_uid == me) else None)
                if role is None:
                    _emit_error(sid, 'players_only'); return

                sb = dict(doc.get('shared_board') or {})
                en = sb.get('enabled')
                if not isinstance(en, dict):
                    en = {}
                en = {'sente': bool(en.get('sente') or False), 'gote': bool(en.get('gote') or False)}
                # Only the player who has enabled shared board can update it.
                if not bool(en.get(role)):
                    _emit_error(sid, 'shared_board_enable_required'); return

                total_main = len((doc.get('move_history') or []))
                try:
                    cur = sb.get('cursor')
                    cur = int(cur) if cur is not None else int(total_main)
                except Exception:
                    cur = int(total_main)
                br = sb.get('branch')
                if not isinstance(br, dict):
                    br = None

                action = str(data.get('action') or '').strip()
                if not action:
                    _emit_error(sid, 'action_required', 'action required'); return

                # normalize existing branch info
                if br is not None:
                    try:
                        base_index = int(br.get('baseIndex') if br.get('baseIndex') is not None else br.get('base_index'))
                    except Exception:
                        base_index = 0
                    usi_moves = br.get('usiMoves') if isinstance(br.get('usiMoves'), list) else br.get('usi_moves')
                    if not isinstance(usi_moves, list):
                        usi_moves = []
                    usi_moves = [str(x) for x in usi_moves if str(x).strip()]
                    if base_index < 0:
                        base_index = 0
                    if base_index > total_main:
                        base_index = total_main
                    br = {'baseIndex': int(base_index), 'usiMoves': usi_moves}
                # helpers to read mainline usi at a cursor
                def _mainline_usi_at(idx: int) -> str:
                    try:
                        mh = (doc.get('move_history') or [])
                        if 0 <= idx < len(mh):
                            it = mh[idx]
                            if isinstance(it, dict):
                                u = it.get('usi') or ((it.get('obj') or {}).get('usi') if isinstance(it.get('obj'), dict) else None)
                                return str(u or '').strip()
                    except Exception:
                        pass
                    return ''

                new_cursor = int(cur)
                new_branch = br

                if action == 'navigate':
                    try:
                        delta = int(data.get('delta') or 0)
                    except Exception:
                        delta = 0
                    if new_branch is not None:
                        base_index = int(new_branch.get('baseIndex') or 0)
                        new_cursor = base_index + delta
                        new_branch = None
                    else:
                        new_cursor = int(cur) + delta
                        new_branch = None
                    if new_cursor < 0:
                        new_cursor = 0
                    if new_cursor > total_main:
                        new_cursor = total_main

                elif action == 'set_cursor':
                    try:
                        tgt = int(data.get('cursor') if data.get('cursor') is not None else 0)
                    except Exception:
                        tgt = 0
                    if tgt < 0:
                        tgt = 0
                    if tgt > total_main:
                        tgt = total_main
                    new_cursor = int(tgt)
                    new_branch = None

                elif action == 'manual_move':
                    usi = str(data.get('usi') or '').strip()
                    if not usi:
                        _emit_error(sid, 'usi_required', 'usi required'); return

                    if new_branch is None:
                        # If it matches mainline next move, advance without branching
                        next_usi = _mainline_usi_at(int(cur))
                        if next_usi and next_usi == usi and int(cur) < total_main:
                            new_cursor = int(cur) + 1
                            new_branch = None
                        else:
                            base_index = int(cur)
                            if base_index < 0:
                                base_index = 0
                            if base_index > total_main:
                                base_index = total_main
                            new_branch = {'baseIndex': base_index, 'usiMoves': [usi]}
                            new_cursor = base_index + 1
                    else:
                        base_index = int(new_branch.get('baseIndex') or 0)
                        usi_moves = list(new_branch.get('usiMoves') or [])
                        # cursor position within branch (truncate redo)
                        try:
                            rel = int(cur) - base_index
                        except Exception:
                            rel = len(usi_moves)
                        if rel < 0:
                            rel = 0
                        if rel > len(usi_moves):
                            rel = len(usi_moves)
                        usi_moves = usi_moves[:rel] + [usi]
                        new_branch = {'baseIndex': base_index, 'usiMoves': usi_moves}
                        new_cursor = base_index + len(usi_moves)

                else:
                    _emit_error(sid, 'unknown_action'); return

                # persist updated shared_board
                new_sb = {
                    'enabled': en,
                    'cursor': int(new_cursor),
                    'branch': new_branch,
                    'offer_sent': bool(sb.get('offer_sent') or False),
                    'updated_at': datetime.utcnow(),
                }
                try:
                    doc_id = doc.get('_id')
                    if doc_id is not None:
                        game_model.update_one({'_id': doc_id}, {'$set': {'shared_board': new_sb, 'updated_at': datetime.utcnow()}})
                    else:
                        game_model.update_one({'_id': str(game_id)}, {'$set': {'shared_board': new_sb, 'updated_at': datetime.utcnow()}})
                except Exception:
                    try:
                        game_model.update_one({'_id': ObjectId(str(game_id))}, {'$set': {'shared_board': new_sb, 'updated_at': datetime.utcnow()}})
                    except Exception:
                        logger.warning('shared_board_update persist failed', exc_info=True)

                room_name = f'game:{game_id}'
                try:
                    self.socketio.emit('shared_board_state', {
                        'game_id': str(game_id),
                        'total_moves': int(total_main),
                        'cursor': int(new_cursor),
                        'branch': new_branch,
                    }, room=room_name)
                except Exception:
                    pass

            except Exception as e:
                logger.error(f'shared_board_update error: {e}', exc_info=True)
    def _dc_get_slot(self, ts: dict, role: str) -> dict:
        d = ts.setdefault('disconnect', {'sente':{}, 'gote':{}})
        slot = d.setdefault(role, {})
        slot.setdefault('remaining_ms', 90000)
        slot.setdefault('count_total', 0)
        slot.setdefault('running', False)
        slot.setdefault('started_at', 0)
        return slot

    def _user_room(self, user_id: str) -> str:
        return f'user:{user_id}'

    def _set_session(self, sid: str, user_id: Optional[str], username: Optional[str] = None):
        self.connected_users[sid] = {'user_id': user_id, 'username': username, 'current_room': None}
        if user_id:
            self.user_sessions.setdefault(user_id, set()).add(sid)

    def _clear_session(self, sid: str):
        info = self.connected_users.pop(sid, None)
        try:
            user_id = (info or {}).get('user_id')
            current_room = (info or {}).get('current_room')
            if isinstance(current_room, str) and current_room.startswith('game:') and user_id:
                game_id = current_room.split('game:', 1)[1]
                role = None
                try:
                    svc = current_app.config.get('GAME_SERVICE')
                    gm = getattr(svc, 'game_model', None) if svc else None
                    if gm is not None:
                        doc = gm.find_one({'_id': game_id}) or gm.find_one({'_id': ObjectId(str(game_id))})
                        if doc:
                            s_uid = _norm(doc.get('sente_id') or (doc.get('players') or {}).get('sente', {}).get('user_id'))
                            g_uid = _norm(doc.get('gote_id')  or (doc.get('players') or {}).get('gote',  {}).get('user_id'))
                            role = 'sente' if s_uid and s_uid == str(user_id) else ('gote' if g_uid and g_uid == str(user_id) else None)
                            ts = dict(doc.get('time_state') or {})

                            # spectator disconnect: spectators から除外し、観戦者一覧だけを更新通知
                            if role is None:
                                try:
                                    doc_id = doc.get('_id')
                                    if doc_id:
                                        try:
                                            gm.update_one({'_id': doc_id}, {'$pull': {'spectators': {'user_id': str(user_id)}}})
                                        except Exception:
                                            pass
                                        try:
                                            gdoc = gm.find_one({'_id': doc_id}) or doc
                                        except Exception:
                                            gdoc = doc
                                        specs = self._normalize_spectators_list((gdoc or {}).get('spectators') or [], gdoc)
                                        try:
                                            self.socketio.emit('spectators_update', {
                                                'game_id': str(game_id),
                                                'spectators': specs,
                                                'count': len(specs),
                                            }, room=current_room)
                                            self.socketio.emit('lobby_spectators_update', {
                                                'game_id': str(game_id),
                                                'count': len(specs),
                                            }, room='lobby')
                                        except Exception:
                                            pass
                                        # presence が spectating なら lobby に戻す
                                        try:
                                            from src.presence_utils import get_db
                                            db2 = get_db(); ou_coll = db2['online_users']
                                            try:
                                                from bson import ObjectId as _OID
                                                uid_oid = _OID(str(user_id)) if _OID.is_valid(str(user_id)) else None
                                            except Exception:
                                                uid_oid = None
                                            if uid_oid is not None:
                                                pres = ou_coll.find_one({'user_id': uid_oid}) or {}
                                                if pres.get('waiting') == 'spectating':
                                                    ou_coll.update_one({'user_id': uid_oid}, {'$set': {'waiting': 'lobby', 'waiting_info': {}, 'last_seen_at': datetime.utcnow()}})
                                                    try:
                                                        from src.services.online_users_emitter import emit_online_users_diff
                                                        emit_online_users_diff(db2, self.socketio, changed_user_ids=[uid_oid])
                                                    except Exception:
                                                        pass
                                        except Exception:
                                            # presence 更新は best-effort
                                            pass
                                except Exception:
                                    logger.warning('spectator cleanup on disconnect failed', exc_info=True)

                            if role:
                                slot = self._dc_get_slot(ts, role)
                                remaining_ms = int(slot.get('remaining_ms') or 90000)
                                # remaining disconnect count: after this disconnect (count_total will be incremented later)
                                try:
                                    ct = int(slot.get('count_total') or 0)
                                except Exception:
                                    ct = 0
                                remaining_disconnects = max(0, 4 - (ct + 1))
                                payload = {
                                    'game_id': game_id,
                                    'user_id': str(user_id),
                                    'code': 'user_disconnected',
                                    'role': role,
                                    'remaining_ms': remaining_ms,
                                    'remaining_disconnects': remaining_disconnects,
                                    'disconnect_count_total_next': ct + 1,
                                }
                            else:
                                payload = {'game_id': game_id, 'user_id': str(user_id), 'code': 'user_disconnected'}
                        else:
                            payload = {'game_id': game_id, 'user_id': str(user_id), 'code': 'user_disconnected'}
                    else:
                        payload = {'game_id': game_id, 'user_id': str(user_id), 'code': 'user_disconnected'}
                except Exception:
                    payload = {'game_id': game_id, 'user_id': str(user_id), 'code': 'user_disconnected'}
                try:
                    self.socketio.emit('game:user_disconnected', payload, room=current_room)
                except Exception:
                    pass
                try:
                    svc = current_app.config.get('GAME_SERVICE')
                    gm = getattr(svc, 'game_model', None) if svc else None
                    if gm is not None:
                        doc = gm.find_one({'_id': game_id}) or gm.find_one({'_id': ObjectId(str(game_id))})
                        if doc:
                            s_uid = _norm(doc.get('sente_id') or (doc.get('players') or {}).get('sente', {}).get('user_id'))
                            g_uid = _norm(doc.get('gote_id')  or (doc.get('players') or {}).get('gote',  {}).get('user_id'))
                            role = 'sente' if s_uid and s_uid == str(user_id) else ('gote' if g_uid and g_uid == str(user_id) else None)
                            ts = dict(doc.get('time_state') or {})
                            cur = str(doc.get('current_turn') or ts.get('current_player') or 'sente')
                            now_ms = int(datetime.utcnow().timestamp() * 1000)
                            # system chat: disconnect notice (players only, non-finished)
                            try:
                                if role and str(doc.get('status')) != 'finished':
                                    slot0 = self._dc_get_slot(ts, role)
                                    ct0 = int(slot0.get('count_total') or 0)
                                    remaining_dc = max(0, 4 - (ct0 + 1))
                                    from src.utils.system_chat import emit_localized_system_chat
                                    uname0 = self._resolve_username_for_user(str(user_id), fallback=(info or {}).get('username'), game_doc=doc)
                                    emit_localized_system_chat(
                                        self.socketio,
                                        gm,
                                        doc,
                                        key='player_disconnected',
                                        vars={'name': uname0, 'remaining': remaining_dc},
                                        event='system_disconnect',
                                        extra={
                                            'target_user_id': str(user_id),
                                            'remaining_disconnects': remaining_dc,
                                        },
                                    )
                            except Exception:
                                pass
                            if str(doc.get('status')) == 'active':
                                try:
                                    base_at = int((ts.get('base_at') or now_ms)); self._deduct_paused_into_buckets(ts, now_ms)  # replaced paused accumulation; ts['base_at'] = now_ms
                                except Exception: pass
                                gm.update_one({'_id': game_id, 'status': 'active'}, {'$set': {'status': 'pause', 'updated_at': datetime.utcnow()}})
                            if role:
                                slot = self._dc_get_slot(ts, role)
                                # count_total: increment exactly once here
                                try:
                                    _ct = int(slot.get('count_total') or 0)
                                except Exception:
                                    _ct = 0
                                slot['count_total'] = _ct + 1
                                try:
                                    cfg = ts.get('config') or {}
                                    if int(cfg.get('byoyomi_ms') or 0) > 0 and cur != role:
                                        def _remain_byoyomi(ts_local, elapsed):
                                            side = dict(ts_local.get(cur) or {})
                                            ini = int(side.get('initial_ms') or 0); byo = int(side.get('byoyomi_ms') or 0)
                                            dfr = int(side.get('deferment_ms') or 0); e=int(elapsed)
                                            take=min(e,ini); e-=take; ini-=take; take=min(e,byo); e-=take; byo-=take; return max(0, byo)
                                        base_at = int((ts.get('base_at') or now_ms)); elapsed_now = max(0, now_ms - base_at)
                                        paused_spent = int(ts.get('paused_spent_ms') or 0); byo_rem = _remain_byoyomi(ts, paused_spent + elapsed_now)
                                        if byo_rem <= 10000:
                                            side = dict(ts.get(cur) or {}); side['byoyomi_ms'] = max(0, int(side.get('byoyomi_ms') or 0)) + 10000; ts[cur] = side
                                except Exception: pass

                                # 4-disconnect -> finish
                                if int(slot.get('count_total') or 0) >= 4:
                                    winner = 'gote' if role == 'sente' else 'sente'
                                    try:
                                        svc.finish_game(
                                            game_id=str(game_id),
                                            winner_role=winner,
                                            loser_role=role,
                                            reason='disconnect_four',
                                            presence_mode='disconnect',
                                            disconnect_user_id=str(user_id),
                                            emit=True,
                                        )
                                    except Exception:
                                        try:
                                            gm.update_one(
                                                {'_id': game_id, 'status': {'$ne': 'finished'}},
                                                {'$set': {'status': 'finished', 'winner': winner, 'loser': role, 'finished_reason': 'disconnect_four', 'updated_at': datetime.utcnow()}},
                                            )
                                        except Exception:
                                            pass
                                    return
                                else:
                                    try:
                                        sch = current_app.config.get('TIMEOUT_SCHEDULER');
                                        if sch is not None: sch.unschedule_for_game(str(game_id))
                                    except Exception: pass
                                    if not bool(slot.get('running')):
                                        slot['running'] = True
                                        slot['started_at'] = now_ms
                                        ts['disconnect'][role] = slot
                                        try:
                                            dcs = current_app.config.get('DC_SCHEDULER')
                                            if dcs is not None: dcs.schedule(str(game_id), str(user_id), now_ms + int(slot.get('remaining_ms') or 90000))
                                        except Exception: pass
                                    gm.update_one({'_id': game_id}, {'$set': {'time_state': ts}})
                except Exception as _e:
                    logger.warning('disconnect handling failed: %s', _e, exc_info=True)
        except Exception: pass
        try:
            uid = info.get('user_id') if isinstance(info, dict) else None
            if uid and uid in self.user_sessions:
                self.user_sessions[uid].discard(sid)
                if not self.user_sessions[uid]:
                    self.user_sessions.pop(uid, None)
        except Exception:
            pass

    def _decode_user_from_auth(self, auth) -> (Optional[str], Optional[str]):
        try:
            token = None
            if isinstance(auth, dict):
                token = auth.get('token') or auth.get('Authorization') or auth.get('authorization')
            if not token and request and request.args:
                token = request.args.get('token')
            if not token:
                return None, None
            decoded = decode_token(token)
            claims = decoded.get('sub') or decoded.get('identity') or {}
            if isinstance(claims, dict):
                return str(claims.get('id') or claims.get('user_id') or ''), claims.get('username') or None
            return str(claims), None
        except Exception:
            return None, None

    # public emits
    def emit_to_user(self, event: str, payload: dict, user_id: str):
        try:
            self.socketio.emit(event, payload or {}, room=self._user_room(user_id))
        except Exception as e:
            logger.warning('emit_to_user failed: %s', e)

    def broadcast(self, event: str, payload: dict):
        try:
            self.socketio.emit(event, payload or {}, broadcast=True)
        except Exception as e:
            logger.warning('broadcast failed: %s', e)


def _norm(v):
    """Return string id; handles ObjectId safely. None -> ''."""
    try:
        from bson import ObjectId as _OID
        if isinstance(v, _OID):
            return str(v)
    except Exception:
        pass
    return '' if v is None else str(v)
