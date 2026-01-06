from __future__ import annotations
from flask import current_app
from bson import ObjectId
from typing import Any, Dict, Optional, List
from datetime import datetime, timezone
from src.presence_utils import get_db

def _json_safe(obj: Any):
    """Convert Mongo / datetime values into JSON-serializable shapes (recursive)."""
    try:
        from bson import ObjectId as _OID  # type: ignore
    except Exception:
        _OID = None

    if isinstance(obj, datetime):
        dt = obj
        try:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dt = dt.astimezone(timezone.utc)
        except Exception:
            pass
        return dt.isoformat().replace("+00:00", "Z")

    if _OID is not None and isinstance(obj, _OID):
        return str(obj)

    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}

    if isinstance(obj, (list, tuple, set)):
        return [_json_safe(v) for v in obj]

    return obj



def _set_players_presence_review(game_doc, now=None):
    # STRICT: Do not swallow errors; raise if anything is off.
    from datetime import datetime
    from bson import ObjectId
    from flask import current_app

    db = getattr(current_app, "mongo_db", None)
    if db is None:
        db = current_app.config.get("MONGO_DB", None)
    if db is None:
        raise RuntimeError("db_not_ready")

    players = (game_doc or {}).get('players') or {}
    s_uid = ((players.get('sente') or {}).get('user_id') or game_doc.get('sente_id') or None)
    g_uid = ((players.get('gote')  or {}).get('user_id')  or game_doc.get('gote_id')  or None)

    now_val = now or datetime.utcnow()

    def to_oid(x, role_label):
        if x is None:
            raise ValueError(f"missing_user_id_for_{role_label}")
        try:
            return ObjectId(str(x))
        except Exception:
            raise ValueError(f"invalid_object_id_for_{role_label}: {x}")

    for role_label, uid in (("sente", s_uid), ("gote", g_uid)):
        oid = to_oid(uid, role_label)
        res = db['online_users'].update_one({'user_id': oid}, {'$set': {
            'waiting': 'review',
            'waiting_info': {},
            'pending_offer': {},
            'last_seen_at': now_val,
        }}, upsert=True)
        # Optional: ensure write happened (matched or upserted). If not, treat as error.
        if getattr(res, "matched_count", 0) == 0 and getattr(res, "upserted_id", None) is None:
            raise RuntimeError(f"presence_update_no_effect_for_{role_label}")

    # Review context: skip *waiting_changed* but still notify lobby to refresh presence.
    sio = getattr(current_app, 'socketio', None)
    if sio is not None:
        try:
            sio.emit('online_users_update', {'type': 'presence_changed'})
        except Exception as _e:
            # strict: surface errors
            raise
    return


def _set_disconnect_timeout_presence(game_doc, dc_user_id, now=None):
    """切断タイムアウト時のpresence更新。
    - 切断した側を lobby
    - 接続中の相手側を review
    既存の機能は消さず、エラーは握りつぶさない（raise）。
    """
    from datetime import datetime
    from bson import ObjectId
    from flask import current_app

    db = getattr(current_app, "mongo_db", None)
    if db is None:
        db = current_app.config.get("MONGO_DB", None)
    if db is None:
        raise RuntimeError("db_not_ready")

    now = now or datetime.utcnow()

    players = (game_doc or {}).get('players') or {}
    s_uid = ((players.get('sente') or {}).get('user_id') or game_doc.get('sente_id') or None)
    g_uid = ((players.get('gote')  or {}).get('user_id')  or game_doc.get('gote_id')  or None)

    def to_oid(x, role_label):
        if x is None:
            raise ValueError(f"missing_user_id_for_{role_label}")
        try:
            return ObjectId(str(x))
        except Exception:
            raise ValueError(f"invalid_object_id_for_{role_label}: {x}")

    dc_uid_str = str(dc_user_id)
    # 判定（どちらが切断か）
    dc_role = None
    if s_uid is not None and str(s_uid) == dc_uid_str:
        dc_role = 'sente'
    elif g_uid is not None and str(g_uid) == dc_uid_str:
        dc_role = 'gote'
    else:
        # 該当なしは厳格にエラー
        raise ValueError(f"disconnect_user_not_in_game: {dc_user_id}")

    # 切断ユーザー → lobby、相手 → review
    s_oid = to_oid(s_uid, 'sente')
    g_oid = to_oid(g_uid, 'gote')

    if dc_role == 'sente':
        dc_oid, peer_oid = s_oid, g_oid
    else:
        dc_oid, peer_oid = g_oid, s_oid

    # 切断者: lobby
    res1 = db['online_users'].update_one({'user_id': dc_oid}, {'$set': {
        'waiting': 'lobby',
        'waiting_info': {},
        'pending_offer': {},
        'last_seen_at': now,
    }}, upsert=True)
    # 相手: review
    res2 = db['online_users'].update_one({'user_id': peer_oid}, {'$set': {
        'waiting': 'review',
        'waiting_info': {},
        'pending_offer': {},
        'last_seen_at': now,
    }}, upsert=True)

    # ロビーへpresence更新を通知
    sio = getattr(current_app, 'socketio', None)
    if sio is not None:
        sio.emit('online_users_update', {'type': 'presence_changed'})

    return {'ok': True, 'dc_role': dc_role}

PROMOTABLE = {'pawn':'promoted_pawn','lance':'promoted_lance','knight':'promoted_knight','silver':'promoted_silver','bishop':'promoted_bishop','rook':'promoted_rook'}

# Canonical start position (hirate) in SFEN.
# (USI "position startpos" corresponds to this SFEN.)
DEFAULT_START_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"

# Map promoted pieces back to their base piece when captured (STRICT capture -> base piece)
BASE_PIECE = {
    'promoted_pawn': 'pawn',
    'promoted_lance': 'lance',
    'promoted_knight': 'knight',
    'promoted_silver': 'silver',
    'promoted_bishop': 'bishop',
    'promoted_rook': 'rook',
    # idempotent entries
    'pawn': 'pawn', 'lance': 'lance', 'knight': 'knight', 'silver': 'silver',
    'gold': 'gold', 'bishop': 'bishop', 'rook': 'rook', 'king': 'king',
}
def _to_base_piece(name: str) -> str:
    return BASE_PIECE.get(name, name)

def _is_in_promo_zone(role: str, row: int) -> bool:
    # board row 0 is top (sente's opponent side)
    if role == 'sente':
        return 0 <= row <= 2
    else:
        return 6 <= row <= 8

def _can_promote(role: str, piece: str, r1: int, r2: int) -> bool:
    if piece not in PROMOTABLE: return False
    return _is_in_promo_zone(role, r1) or _is_in_promo_zone(role, r2)

def _must_promote(role: str, piece: str, r2: int) -> bool:
    if role == 'sente':
        if piece in ('pawn','lance') and r2 == 0: return True
        if piece == 'knight' and r2 <= 1: return True
    else:  # gote
        if piece in ('pawn','lance') and r2 == 8: return True
        if piece == 'knight' and r2 >= 7: return True
    return False


# === SFEN helpers (canonical on DB / wire) ==================================

_SFEN_PIECE_TO_NAME = {
    'P': 'pawn',
    'L': 'lance',
    'N': 'knight',
    'S': 'silver',
    'G': 'gold',
    'B': 'bishop',
    'R': 'rook',
    'K': 'king',
}

_NAME_TO_SFEN_PIECE = {v: k for k, v in _SFEN_PIECE_TO_NAME.items()}


def _parse_sfen(sfen: str) -> Optional[dict]:
    """Parse SFEN (4 fields) to {board, hands, turn, ply}.

    - board: 9x9 of None or {owner, piece, promoted}
    - hands: {'sente': {piece: n}, 'gote': {piece: n}}
    - turn:  'sente'|'gote'
    - ply:   int (>=1)
    """
    if not isinstance(sfen, str):
        return None
    s = sfen.strip()
    if not s:
        return None

    # allow 'startpos' as a shorthand
    if s == 'startpos':
        s = DEFAULT_START_SFEN

    parts = s.split()
    if len(parts) < 4:
        return None

    board_part, turn_part, hands_part, ply_part = parts[0], parts[1], parts[2], parts[3]

    ranks = board_part.split('/')
    if len(ranks) != 9:
        return None

    board: list[list[Optional[dict]]] = [[None for _ in range(9)] for __ in range(9)]
    for r, rank in enumerate(ranks):
        c = 0
        i = 0
        while i < len(rank):
            ch = rank[i]
            if ch.isdigit():
                n = int(ch)
                c += n
                i += 1
                continue
            promoted = False
            if ch == '+':
                promoted = True
                i += 1
                if i >= len(rank):
                    return None
                ch = rank[i]
            if c >= 9:
                return None
            owner = 'sente' if ch.isupper() else 'gote'
            base_letter = ch.upper()
            base_name = _SFEN_PIECE_TO_NAME.get(base_letter)
            if not base_name:
                return None
            name = PROMOTABLE.get(base_name, base_name) if promoted else base_name
            board[r][c] = {
                'owner': owner,
                'piece': name,
                'promoted': bool(name.startswith('promoted_')),
            }
            c += 1
            i += 1
        if c != 9:
            return None

    turn = 'sente' if turn_part == 'b' else 'gote' if turn_part == 'w' else None
    if not turn:
        return None

    hands = {'sente': {}, 'gote': {}}
    if hands_part != '-':
        num = ''
        for ch in hands_part:
            if ch.isdigit():
                num += ch
                continue
            count = int(num) if num else 1
            num = ''
            owner = 'sente' if ch.isupper() else 'gote'
            base_letter = ch.upper()
            base_name = _SFEN_PIECE_TO_NAME.get(base_letter)
            if not base_name:
                return None
            # Hands are always unpromoted pieces.
            base_name = _to_base_piece(base_name)
            hands[owner][base_name] = int(hands[owner].get(base_name) or 0) + count
        if num:
            return None

    try:
        ply = max(1, int(ply_part))
    except Exception:
        ply = 1

    return {'board': board, 'hands': hands, 'turn': turn, 'ply': ply}


def _hands_to_sfen(hands: dict) -> str:
    """Serialize hands to SFEN 3rd field."""
    if not isinstance(hands, dict):
        return '-'
    s_map = hands.get('sente') if isinstance(hands.get('sente'), dict) else {}
    g_map = hands.get('gote') if isinstance(hands.get('gote'), dict) else {}
    order = ['R', 'B', 'G', 'S', 'N', 'L', 'P']
    out = []
    for letter in order:
        name = _SFEN_PIECE_TO_NAME[letter]
        n = int(s_map.get(name) or 0)
        if n > 0:
            out.append((str(n) if n > 1 else '') + letter)
    for letter in order:
        name = _SFEN_PIECE_TO_NAME[letter]
        n = int(g_map.get(name) or 0)
        if n > 0:
            out.append((str(n) if n > 1 else '') + letter.lower())
    return ''.join(out) if out else '-'


def _board_to_sfen_board(board: list) -> Optional[str]:
    if not (isinstance(board, list) and len(board) == 9 and all(isinstance(r, list) and len(r) == 9 for r in board)):
        return None
    ranks = []
    for r in range(9):
        run = 0
        s = ''
        for c in range(9):
            cell = board[r][c]
            if not cell:
                run += 1
                continue
            if run:
                s += str(run)
                run = 0
            owner = str(cell.get('owner') or '')
            piece = str(cell.get('piece') or '')
            base = _to_base_piece(piece)
            letter = _NAME_TO_SFEN_PIECE.get(base)
            if not letter:
                return None
            is_promoted = bool(piece.startswith('promoted_')) or bool(cell.get('promoted'))
            if is_promoted and base in PROMOTABLE:
                s += '+'
            s += (letter if owner == 'sente' else letter.lower())
        if run:
            s += str(run)
        ranks.append(s)
    return '/'.join(ranks)


def _build_sfen(board: list, turn: str, hands: dict, ply: int) -> Optional[str]:
    b = _board_to_sfen_board(board)
    if not b:
        return None
    t = 'b' if turn == 'sente' else 'w' if turn == 'gote' else None
    if not t:
        return None
    h = _hands_to_sfen(hands)
    try:
        p = max(1, int(ply))
    except Exception:
        p = 1
    return f"{b} {t} {h} {p}"


class GameService:
    def __init__(self, db, socketio=None, logger=None):
        self.db = db
        self.socketio = socketio
        self.logger = logger
        # collection resolve
        if hasattr(db, "games"):
            self.game_model = db.games
        elif isinstance(db, dict) and "games" in db:
            self.game_model = db["games"]
        else:
            raise RuntimeError("db.games collection missing")

    # ---- helpers (placeholders: real project should have concrete impls) -----
    def _now(self):
        return datetime.now(timezone.utc)
    def _compute_effective_time(self, ts: dict, current_turn: str, now_ms: int):
        """Return (sente_eff_ms, gote_eff_ms) after applying elapsed to side to move."""
        base_at = int(ts.get('base_at') or now_ms)
        elapsed = max(0, now_ms - base_at)

        def sum_buckets(side: dict) -> int:
            ini = max(0, int((side or {}).get('initial_ms') or 0))
            byo = max(0, int((side or {}).get('byoyomi_ms') or 0))
            dfr = max(0, int((side or {}).get('deferment_ms') or 0))
            return ini + byo + dfr

        def deduct(side: dict, ms: int) -> dict:
            ini = max(0, int((side or {}).get('initial_ms') or 0))
            byo = max(0, int((side or {}).get('byoyomi_ms') or 0))
            dfr = max(0, int((side or {}).get('deferment_ms') or 0))
            take = min(ms, ini); ms -= take; ini -= take
            take = min(ms, byo); ms -= take; byo -= take
            take = min(ms, dfr); ms -= take; dfr -= take
            return {'initial_ms': ini, 'byoyomi_ms': byo, 'deferment_ms': dfr}

        s = dict(ts.get('sente') or {})
        g = dict(ts.get('gote')  or {})
        if current_turn == 'sente':
            s_after = deduct(s, elapsed)
            return sum_buckets(s_after), sum_buckets(g)
        elif current_turn == 'gote':
            g_after = deduct(g, elapsed)
            return sum_buckets(s), sum_buckets(g_after)
        else:
            return sum_buckets(s), sum_buckets(g)


    def _role_of(self, doc, user_id: str) -> Optional[str]:
        """Resolve player's role from game doc.
        Accepts both legacy schema (sente_id/gote_id) and
        canonical schema (players.sente.user_id / players.gote.user_id)."""
        if not doc or not user_id:
            return None
        # Legacy fields
        if doc.get('sente_id') == user_id:
            return 'sente'
        if doc.get('gote_id') == user_id:
            return 'gote'
        # Canonical nested players
        players = doc.get('players') or {}
        try:
            if isinstance(players, dict):
                s_uid = str((players.get('sente') or {}).get('user_id') or '')
                g_uid = str((players.get('gote')  or {}).get('user_id') or '')
                if s_uid and s_uid == str(user_id):
                    return 'sente'
                if g_uid and g_uid == str(user_id):
                    return 'gote'
        except Exception:
            pass
        return None

    def _opponent(self, role: str) -> str:
        return 'gote' if role == 'sente' else 'sente'
    def _ensure_clock_fields(self, doc):
        """Ensure time_state has multi-bucket structure (initial/byoyomi/deferment/increment).
        Convert legacy fields if present."""
        ts = doc.get('time_state') or {}
        # preserve custom extras (disconnect counters / paused fragment)
        _extras_disconnect = ts.get('disconnect') if isinstance(ts.get('disconnect'), dict) else None
        _extra_paused = ts.get('paused_spent_ms')
        cfg = ts.get('config') or {}
        def clamp(x):
            try: return max(0, int(x))
            except Exception: return 0

        # legacy -> new
        if not cfg and (doc.get('time_limit') is not None or (isinstance(ts.get('sente'), dict) and 'left_ms' in (ts.get('sente') or {}))):
            tl = int(doc.get('time_limit') or 0)
            tl_ms = tl * 1000 if tl < 10000 else clamp(tl)
            s_left = clamp(((ts.get('sente') or {}).get('left_ms') or tl_ms) or 0)
            g_left = clamp(((ts.get('gote')  or {}).get('left_ms')  or tl_ms) or 0)
            now_ms = int(self._now().timestamp() * 1000)
            ts = {
                'config': {'initial_ms': tl_ms, 'byoyomi_ms': 0, 'increment_ms': 0, 'deferment_ms': 0},
                'sente':  {'initial_ms': s_left, 'byoyomi_ms': 0, 'deferment_ms': 0},
                'gote':   {'initial_ms': g_left, 'byoyomi_ms': 0, 'deferment_ms': 0},
                'base_at': int(ts.get('base_at') or now_ms),
                'current_player': str(ts.get('current_player') or doc.get('current_turn') or 'sente'),
            }
        else:
            ts = {
                'config': {
                    'initial_ms':   clamp(cfg.get('initial_ms')   or 0),
                    'byoyomi_ms':   clamp(cfg.get('byoyomi_ms')   or 0),
                    'increment_ms': clamp(cfg.get('increment_ms') or 0),
                    'deferment_ms': clamp(cfg.get('deferment_ms') or 0),
                },
                'sente': {
                    'initial_ms': clamp(((ts.get('sente') or {}).get('initial_ms') if ((ts.get('sente') or {}).get('initial_ms') is not None) else (cfg.get('initial_ms') or 0))),
                    'byoyomi_ms': clamp(((ts.get('sente') or {}).get('byoyomi_ms') if ((ts.get('sente') or {}).get('byoyomi_ms') is not None) else (cfg.get('byoyomi_ms') or 0))),
                    'deferment_ms': clamp(((ts.get('sente') or {}).get('deferment_ms') if ((ts.get('sente') or {}).get('deferment_ms') is not None) else (cfg.get('deferment_ms') or 0))),
                },
                'gote': {
                    'initial_ms': clamp(((ts.get('gote') or {}).get('initial_ms') if ((ts.get('gote') or {}).get('initial_ms') is not None) else (cfg.get('initial_ms') or 0))),
                    'byoyomi_ms': clamp(((ts.get('gote') or {}).get('byoyomi_ms') if ((ts.get('gote') or {}).get('byoyomi_ms') is not None) else (cfg.get('byoyomi_ms') or 0))),
                    'deferment_ms': clamp(((ts.get('gote') or {}).get('deferment_ms') if ((ts.get('gote') or {}).get('deferment_ms') is not None) else (cfg.get('deferment_ms') or 0))),
                },
                'base_at': int(ts.get('base_at') or int(self._now().timestamp() * 1000)),
                'current_player': str(ts.get('current_player') or doc.get('current_turn') or 'sente'),
            }
        
        # --- preserve extras (disconnect counters / paused / pending) ---
        try:
            if _extras_disconnect is not None and isinstance(_extras_disconnect, dict):
                ts['disconnect'] = _extras_disconnect
        except Exception:
            pass
        try:
            if _extra_paused is not None and int(_extra_paused or 0) > 0:
                ts['paused_spent_ms'] = int(_extra_paused or 0)
        except Exception:
            pass
        try:
            _extra_pending = (doc.get('time_state') or {}).get('pending_spent')
            if isinstance(_extra_pending, dict):
                # normalize to sente/gote
                s = int(_extra_pending.get('sente') or 0); g = int(_extra_pending.get('gote') or 0)
                ts['pending_spent'] = {'sente': max(0, s), 'gote': max(0, g)}
        except Exception:
            pass
        doc['time_state'] = ts
        return {'time_state': ts}

    def _apply_elapsed(self, doc):
        """Apply elapsed to the current player and mutate time_state.
        Returns (eff_sente_ms, eff_gote_ms, spent_ms_current, over_ms, breakdown)."""
        ts = (doc.get('time_state') or {})
        ensured = self._ensure_clock_fields(doc)
        ts = ensured['time_state']
        now_ms = int(self._now().timestamp() * 1000)
        base_at = int(ts.get('base_at') or now_ms)
        cur = str(doc.get('current_turn') or ts.get('current_player') or 'sente')
        move_hist = list(doc.get('move_history') or [])
        ply = len(move_hist) + 1

        elapsed = max(0, now_ms - base_at)

        def deduct(side: dict, ms: int):
            ini = max(0, int(side.get('initial_ms') or 0))
            byo = max(0, int(side.get('byoyomi_ms') or 0))
            dfr = max(0, int(side.get('deferment_ms') or 0))
            take = min(ms, ini); ms -= take; ini -= take
            take = min(ms, byo); ms -= take; byo -= take
            take = min(ms, dfr); ms -= take; dfr -= take
            over = ms
            return {'initial_ms': ini, 'byoyomi_ms': byo, 'deferment_ms': dfr}, int(elapsed - over), int(over)

        s = dict(ts.get('sente') or {'initial_ms':0,'byoyomi_ms':0,'deferment_ms':0})
        g = dict(ts.get('gote')  or {'initial_ms':0,'byoyomi_ms':0,'deferment_ms':0})

        if cur == 'sente':
            s_after, spent, over = deduct(s, elapsed)
            ts['sente'] = s_after
        elif cur == 'gote':
            g_after, spent, over = deduct(g, elapsed)
            ts['gote'] = g_after
        else:
            spent = 0; over = 0

        eff_s, eff_g = self._compute_effective_time(ts, cur, now_ms)
        doc['time_state'] = ts
        return eff_s, eff_g, int(spent), int(over), {'sente': ts.get('sente'), 'gote': ts.get('gote')}


    def get_game_by_id(self, game_id: str):
        return self.game_model.find_one({"_id": game_id})

    def _ensure_sfen_fields(self, doc: dict) -> dict:
        """Ensure doc has canonical SFEN fields.

        - Required: start_sfen, sfen
        - If legacy fields (board/captured) exist, migrate to SFEN once and drop them.
        """
        if not isinstance(doc, dict):
            return doc
        game_id = doc.get('_id')
        move_hist = list(doc.get('move_history') or [])
        ply = len(move_hist) + 1

        start_sfen = doc.get('start_sfen')
        if not (isinstance(start_sfen, str) and len(start_sfen.split()) >= 4):
            start_sfen = DEFAULT_START_SFEN
            doc['start_sfen'] = start_sfen

        sfen = doc.get('sfen')
        if not (isinstance(sfen, str) and len(sfen.split()) >= 4):
            # migrate from legacy board/captured if possible
            board = doc.get('board')
            captured = doc.get('captured') or {}
            hands = {'sente': {}, 'gote': {}}
            if isinstance(captured, dict):
                for side in ('sente', 'gote'):
                    bag = captured.get(side) or []
                    if isinstance(bag, list):
                        for p in bag:
                            bp = _to_base_piece(str(p))
                            hands[side][bp] = int(hands[side].get(bp) or 0) + 1
            cur = str(doc.get('current_turn') or (doc.get('time_state') or {}).get('current_player') or 'sente')
            cur = cur if cur in ('sente', 'gote') else 'sente'
            built = _build_sfen(board, cur, hands, ply)
            if built:
                sfen = built
                doc['sfen'] = sfen

        # Persist + cleanup legacy fields.
        try:
            set_fields = {}
            if isinstance(doc.get('start_sfen'), str) and len(str(doc.get('start_sfen')).split()) >= 4:
                set_fields['start_sfen'] = doc.get('start_sfen')
            if isinstance(doc.get('sfen'), str) and len(str(doc.get('sfen')).split()) >= 4:
                set_fields['sfen'] = doc.get('sfen')

            # Only drop legacy fields once we have a valid canonical SFEN.
            unset_fields = {}
            if set_fields.get('sfen'):
                if 'board' in doc:
                    unset_fields['board'] = ''
                if 'captured' in doc:
                    unset_fields['captured'] = ''

            if game_id and (set_fields or unset_fields):
                upd = {}
                if set_fields:
                    upd['$set'] = set_fields
                if unset_fields:
                    upd['$unset'] = unset_fields
                self.game_model.update_one({'_id': game_id}, upd)
                if unset_fields:
                    doc.pop('board', None)
                    doc.pop('captured', None)
        except Exception:
            pass
        return doc
    def check_and_finish_timeout(self, game_id: str, base_at_expected: int | None = None) -> bool:
        """時間切れを**投了と同じ経路**で終局するための厳密チェック。

        - initial/byoyomi/deferment を考慮

        - base_at の一致も確認（古い予約ガード）

        """

        doc = self.game_model.find_one({"_id": game_id})

        if not doc or str(doc.get('status')) == 'finished':

            return False

        ensured = self._ensure_clock_fields(doc)

        ts = ensured['time_state']

        cur = str(doc.get('current_turn') or ts.get('current_player') or 'sente')

        # 古い予約なら抜ける

        if base_at_expected is not None:

            cur_base = int(ts.get('base_at') or doc.get('base_at') or 0)

            if int(base_at_expected) != cur_base:

                return False

        # 経過を適用して超過判定

        _s, _g, spent, over, _bd = self._apply_elapsed(doc)

        # grace-inclusive boundary: within grace -> do not finish
        grace_ms = 3000
        try:
            from ..config import TIMEOUT_GRACE_SECONDS
            grace_ms = int(TIMEOUT_GRACE_SECONDS) * 1000
        except Exception:
            pass
        try:
            gcfg = ts.get('config') or {}
            if gcfg.get('time_grace_ms') is not None:
                grace_ms = int(gcfg.get('time_grace_ms') or 0)
        except Exception:
            pass
        if over <= grace_ms:
            return False

        # winner/loser 決定

        winner_role = self._opponent(cur)

        loser_role  = cur

        # DB反映（finished_reason=timeout）

        update = {"status": "finished", "winner": winner_role, "finished_reason": "timeout", "updated_at": self._now()}

        _set_players_presence_review(doc)
        res = self.game_model.update_one({"_id": game_id, "status": {"$ne": "finished"}}, {"$set": update})

        if getattr(res, 'modified_count', 1) == 0:

            return False

        # enqueue engine analysis (best-effort; idempotent on DB)
        try:
            from src.services.analysis_queue import try_enqueue_game_analysis
            try_enqueue_game_analysis(self, str(game_id), redis_url=current_app.config.get("REDIS_URL"))
        except Exception:
            pass

        doc.update(update)

        
        # Set both players to 'review' (感想戦) in lobby presence
        _set_players_presence_review(doc)
        # 送信（game_update と game:finished）

        try:

            room = f"game:{game_id}"

            try:

                payload = self.as_api_payload(doc)

            except Exception:

                payload = {"id": game_id, **update}

            if self.socketio:

                self.socketio.emit('game_update', payload, room=room)

                players = doc.get('players') or {}

                s_uid = str(((players.get('sente') or {}).get('user_id') or doc.get('sente_id') or '') or '')

                g_uid = str(((players.get('gote')  or {}).get('user_id')  or doc.get('gote_id')  or '') or '')

                s_name = str(((players.get('sente') or {}).get('username') or '先手') or '先手')

                g_name = str(((players.get('gote')  or {}).get('username') or '後手') or '後手')

                winner_uid  = s_uid if winner_role == 'sente' else g_uid

                loser_uid   = g_uid if winner_role == 'sente' else s_uid

                winner_un   = s_name if winner_role == 'sente' else g_name

                loser_un    = g_name if winner_role == 'sente' else s_name

                self.socketio.emit('game:finished', {

                    'game_id': game_id,

                    'winner': winner_role,

                    'loser': loser_role,

                    'reason': 'timeout',

                    'winner_user_id': winner_uid,

                    'loser_user_id': loser_uid,

                    'winner_username': winner_un,

                    'loser_username': loser_un,

                }, room=room)

        except Exception:

            pass

        return True


    def as_api_payload(self, doc, me: Optional[str] = None):
        now_ms = int(self._now().timestamp() * 1000)
        doc = self._ensure_sfen_fields(doc)
        ensured = self._ensure_clock_fields(doc)
        ts = ensured['time_state']
        # freeze elapsed while paused by overriding base_at during payload computation
        try:
            if str(doc.get('status')) == 'pause':
                ts = dict(ts)
                ts['base_at'] = now_ms
        except Exception:
            pass
        # Canonical current turn comes from SFEN if possible.
        cur = None
        try:
            parsed = _parse_sfen(doc.get('sfen') or '')
            if parsed and parsed.get('turn') in ('sente', 'gote'):
                cur = parsed.get('turn')
        except Exception:
            cur = None
        cur = str(cur or doc.get('current_turn') or ts.get('current_player') or 'sente')
        move_hist = list(doc.get('move_history') or [])
        ply = len(move_hist) + 1

        s_eff, g_eff = self._compute_effective_time(ts, cur, now_ms)

        def after_deduct(side: dict, ms: int) -> dict:
            ini = max(0, int(side.get('initial_ms') or 0))
            byo = max(0, int(side.get('byoyomi_ms') or 0))
            dfr = max(0, int(side.get('deferment_ms') or 0))
            take = min(ms, ini); ms -= take; ini -= take
            take = min(ms, byo); ms -= take; byo -= take
            take = min(ms, dfr); ms -= take; dfr -= take
            return {'initial_ms': ini, 'byoyomi_ms': byo, 'deferment_ms': dfr}

        elapsed = max(0, now_ms - int(ts.get('base_at') or now_ms))
        if cur == 'sente':
            s_after = after_deduct(dict(ts['sente']), elapsed)
            g_after = dict(ts['gote'])
        elif cur == 'gote':
            g_after = after_deduct(dict(ts['gote']), elapsed)
            s_after = dict(ts['sente'])
        else:
            s_after = dict(ts['sente']); g_after = dict(ts['gote'])

        payload = {
            "id": doc.get("_id"),
            "status": doc.get("status"),
            "current_turn": cur,
            "start_sfen": doc.get("start_sfen"),
            "sfen": doc.get("sfen"),
            "move_history": doc.get("move_history"),
            # --- post-game engine analysis (optional fields) ---
            "analysis_status": doc.get("analysis_status"),
            "analysis_progress": doc.get("analysis_progress"),
            "analysis_total": doc.get("analysis_total"),
            "analysis_error": doc.get("analysis_error"),
            "analysis_started_at": doc.get("analysis_started_at"),
            "analysis_updated_at": doc.get("analysis_updated_at"),
            "analysis_done_at": doc.get("analysis_done_at"),
            "winner": doc.get("winner"),
            "finished_reason": doc.get("finished_reason"),
            "time_state": ts,
            "time_effective": {"server_ts": now_ms, "sente_ms": s_eff, "gote_ms": g_eff},
            "time_effective_breakdown": {"sente": s_after, "gote": g_after},
            "time_config": ts.get("config"),
            "updated_at": (doc.get("updated_at") or self._now()).isoformat(),
        }
        specs = doc.get("spectators")
        if isinstance(specs, list):
            payload["spectators"] = specs
        else:
            payload["spectators"] = []

        # Nested game_state for FE clients expecting it
        try:
            payload_game_state = {
                "id": payload.get("id"),
                "status": payload.get("status"),
                "current_turn": payload.get("current_turn"),
                "start_sfen": payload.get("start_sfen"),
                "sfen": payload.get("sfen"),
                "move_history": payload.get("move_history"),
                "analysis_status": payload.get("analysis_status"),
                "analysis_progress": payload.get("analysis_progress"),
                "analysis_total": payload.get("analysis_total"),
                "analysis_error": payload.get("analysis_error"),
                "analysis_started_at": payload.get("analysis_started_at"),
                "analysis_updated_at": payload.get("analysis_updated_at"),
                "analysis_done_at": payload.get("analysis_done_at"),
                "winner": payload.get("winner"),
                "finished_reason": payload.get("finished_reason"),
                "players": (doc.get("players") or {}),
                "time_state": payload.get("time_state"),
                "time_config": payload.get("time_config"),
                "time_effective": payload.get("time_effective"),
                "time_effective_breakdown": payload.get("time_effective_breakdown"),
                "spectators": payload.get("spectators"),
            }
            payload["game_state"] = payload_game_state
        except Exception:
            pass
        return _json_safe(payload)


    def make_move(self, game_id: str, me: str, data: Dict[str, Any]):


        # presence: update mover's last_seen_at (upsert)


        try:


            db = get_db()


            me_oid = ObjectId(str(me))


            from datetime import datetime, timezone


            db['online_users'].update_one({'user_id': me_oid}, {'$set': {'last_seen_at': datetime.now(timezone.utc)}}, upsert=True)


        except Exception:


            pass

        doc = self.game_model.find_one({"_id": game_id})
        if not doc:
            return {'success': False, 'message': 'not_found'}

        role = self._role_of(doc, me)
        if role is None:
            return {'success': False, 'message': 'forbidden'}
        if doc.get('status') not in ('active', 'ongoing'):
            return {'success': False, 'message': 'not_active'}

        # Canonical: load from SFEN (DB is SFEN-first).
        doc = self._ensure_sfen_fields(doc)
        state = _parse_sfen(doc.get('sfen') or '')
        if not state:
            return {'success': False, 'message': 'invalid_sfen'}
        board = state['board']
        hands = state['hands']
        cur_from_sfen = state.get('turn')
        if cur_from_sfen in ('sente', 'gote'):
            doc['current_turn'] = cur_from_sfen

        # Turn enforcement
        if role != str(doc.get('current_turn') or 'sente'):
            return {'success': False, 'message': 'not_your_turn'}

        # Apply elapsed before move
        eff_s, eff_g, spent, over, _bd = self._apply_elapsed(doc)
        ts = doc['time_state']
        cfg = ts.get('config') or {}
        now_ms = int(self._now().timestamp() * 1000)
        # 再接続前に消費された pending_spent を move の spent に合算し、その後リセット
        try:
            role_for_spent = str(doc.get('current_turn') or (ts.get('current_player') if isinstance(ts, dict) else '') or 'sente')
            pend_map = ts.get('pending_spent') if isinstance(ts, dict) else None
            pend_ms = 0
            if isinstance(pend_map, dict):
                pend_ms = int(pend_map.get(role_for_spent) or 0)
                if pend_ms < 0:
                    pend_ms = 0
            spent = int(spent) + int(pend_ms)
            if isinstance(pend_map, dict):
                pend_map[role_for_spent] = 0
                ts['pending_spent'] = pend_map
        except Exception:
            pass


        cur = str(doc.get('current_turn') or ts.get('current_player') or 'sente')
        move_hist = list(doc.get('move_history') or [])
        ply = len(move_hist) + 1

        
        if over > 0:
            # 遅着猶予（config.py の TIMEOUT_GRACE_SECONDS * 1000ms）
            grace_ms = 3000
            try:
                from ..config import TIMEOUT_GRACE_SECONDS
                grace_ms = int(TIMEOUT_GRACE_SECONDS) * 1000
            except Exception:
                pass
            # 対局ごと上書き: time_state.config.time_grace_ms（0で無効）
            try:
                gcfg = ts.get('config') or {}
                if gcfg.get('time_grace_ms') is not None:
                    grace_ms = int(gcfg.get('time_grace_ms') or 0)
            except Exception:
                pass
        
            if over <= grace_ms:
                # グレース内 → タイムアウト扱いにしないで続行
                pass
            else:
                loser = cur
                winner_role = 'gote' if cur == 'sente' else 'sente'
                update = {"status": "finished", "winner": winner_role, "finished_reason": "timeout", "updated_at": self._now()}
                # atomic finish to avoid duplicate emits
                result = self.game_model.update_one({"_id": game_id, "status": {"$ne": "finished"}}, {"$set": update})
                # merge into doc for payload
                doc.update(update)
                # Set both players to 'review' (感想戦) in lobby presence
                _set_players_presence_review(doc)
                if getattr(result, 'modified_count', 1) != 0:
                    # enqueue engine analysis (best-effort; idempotent on DB)
                    try:
                        from src.services.analysis_queue import try_enqueue_game_analysis
                        try_enqueue_game_analysis(self, str(game_id), redis_url=current_app.config.get("REDIS_URL"))
                    except Exception:
                        pass
                    # Emit the same finished event shape as resign
                    try:
                        if self.socketio:
                            players = doc.get('players') or {}
                            s_uid = str(((players.get('sente') or {}).get('user_id') or doc.get('sente_id') or '') or '')
                            g_uid = str(((players.get('gote')  or {}).get('user_id') or doc.get('gote_id')  or '') or '')
                            s_name = str(((players.get('sente') or {}).get('username') or '先手') or '先手')
                            g_name = str(((players.get('gote')  or {}).get('username') or '後手') or '後手')
                            winner_uid  = s_uid if winner_role == 'sente' else g_uid
                            loser_uid   = g_uid if winner_role == 'sente' else s_uid
                            winner_un   = s_name if winner_role == 'sente' else g_name
                            loser_un    = g_name if winner_role == 'sente' else s_name
        
                            self.socketio.emit('game:finished', {
                                'game_id': game_id,
                                'winner': winner_role,
                                'loser': loser_role,
                                'reason': 'timeout',
                                'winner_user_id': winner_uid,
                                'loser_user_id': loser_uid,
                                'winner_username': winner_un,
                                'loser_username': loser_un,
                            }, room=f'game:{game_id}')
                    except Exception:
                        pass
        
                return dict(success=True, **self.as_api_payload(doc, me))
        # --- Canonical input: USI ---
        # Only accept { usi: "7g7f" } or { usi: "P*7f" }.
        client_usi = ''
        try:
            client_usi = str((data or {}).get('usi') or '').strip()
        except Exception:
            client_usi = ''

        if not client_usi:
            return {'success': False, 'message': 'missing_usi'}

        def _rc_to_usi_sq(r: int, c: int) -> str:
            # row 0 = 'a', col 0 = file 9
            f = 9 - int(c)
            rk = chr(ord('a') + int(r))
            return f"{f}{rk}"

        def _usi_sq_to_rc(sq: str):
            if not isinstance(sq, str) or len(sq) != 2:
                return None
            try:
                f = int(sq[0])
            except Exception:
                return None
            rk = sq[1]
            if not (1 <= f <= 9):
                return None
            if not ('a' <= rk <= 'i'):
                return None
            r = ord(rk) - ord('a')
            c = 9 - f
            if 0 <= r < 9 and 0 <= c < 9:
                return (r, c)
            return None

        def _parse_usi(usi: str):
            s = (usi or '').strip()
            if not s:
                return None
            # drop: P*7f
            if len(s) == 4 and s[1] == '*':
                letter = s[0]
                sq = s[2:4]
                rc = _usi_sq_to_rc(sq)
                if not rc:
                    return None
                piece_map = {
                    'P': 'pawn', 'L': 'lance', 'N': 'knight', 'S': 'silver',
                    'G': 'gold', 'B': 'bishop', 'R': 'rook', 'K': 'king'
                }
                pt = piece_map.get(letter)
                if not pt:
                    return None
                return {'is_drop': True, 'piece_type': pt, 'to_row': rc[0], 'to_col': rc[1]}

            # move: 7g7f or 2b3c+
            if len(s) == 4 or (len(s) == 5 and s.endswith('+')):
                promote = (len(s) == 5)
                fr = _usi_sq_to_rc(s[0:2])
                to = _usi_sq_to_rc(s[2:4])
                if not fr or not to:
                    return None
                return {
                    'is_drop': False,
                    'from_row': fr[0], 'from_col': fr[1],
                    'to_row': to[0], 'to_col': to[1],
                    'promote': promote,
                }
            return None

        parsed_usi = _parse_usi(client_usi) if client_usi else None
        if not parsed_usi:
            return {'success': False, 'message': 'invalid_usi'}

        if parsed_usi:
            # rewrite to legacy keys so existing validation and rules apply
            data = dict(data or {})
            data.pop('usi', None)
            data.update(parsed_usi)

        if all(k in data for k in ('from_row','from_col','to_row','to_col')):
            r1, c1 = int(data['from_row']), int(data['from_col'])
            r2, c2 = int(data['to_row']),  int(data['to_col'])
            want_promote = bool(data.get('promote'))
            if not (0 <= r1 < 9 and 0 <= c1 < 9 and 0 <= r2 < 9 and 0 <= c2 < 9):
                return {'success': False, 'message': 'out_of_bounds'}
            src = board[r1][c1]; dst = board[r2][c2]
            if not (isinstance(src, dict) and src.get('owner') == role):
                return {'success': False, 'message': 'no_piece_or_not_owner'}
            if isinstance(dst, dict):
                if dst.get('owner') == role: return {'success': False, 'message': 'occupied_by_self'}
                cap = _to_base_piece(str(dst.get('piece') or ''))
                if cap:
                    hands[role][cap] = int(hands[role].get(cap) or 0) + 1
            orig_piece_name = src.get('piece')

            piece_name = orig_piece_name

            # If client explicitly requests promotion (+), validate it.
            if want_promote and not (_can_promote(role, piece_name, r1, r2) or _must_promote(role, piece_name, r2)):
                return {'success': False, 'message': 'invalid_promotion'}

            if _must_promote(role, piece_name, r2) or (want_promote and _can_promote(role, piece_name, r1, r2)):
                piece_name = PROMOTABLE.get(piece_name, piece_name)

            did_promote = (piece_name != orig_piece_name) and piece_name.startswith('promoted_')

            board[r2][c2] = {'owner': role, 'piece': piece_name, 'promoted': piece_name.startswith('promoted_')}

            board[r1][c1] = None

            move_rec = {'type': 'move', 'from': {'r': r1,'c': c1}, 'to': {'r': r2,'c': c2}, 'by': role, 'piece': piece_name,

                        'promote': bool(did_promote),

                        'ts': self._now().isoformat(), 'spent_ms': spent, 'ply': ply}

        elif data.get('is_drop') is True and all(k in data for k in ('piece_type','to_row','to_col')):
            r2, c2 = int(data['to_row']), int(data['to_col'])
            if not (0 <= r2 < 9 and 0 <= c2 < 9): return {'success': False, 'message': 'out_of_bounds'}
            if board[r2][c2] is not None: return {'success': False, 'message': 'occupied'}
            piece = _to_base_piece(str(data['piece_type']))
            if not piece:
                return {'success': False, 'message': 'bad_payload'}
            cnt = int((hands.get(role) or {}).get(piece) or 0)
            if cnt <= 0:
                return {'success': False, 'message': 'no_captured_piece'}
            hands[role][piece] = cnt - 1
            if hands[role][piece] <= 0:
                hands[role].pop(piece, None)
            board[r2][c2] = {'owner': role, 'piece': piece, 'promoted': False}
            move_rec = {'type': 'drop', 'piece': piece, 'to': {'r': r2,'c': c2}, 'by': role,
                        'ts': self._now().isoformat(), 'spent_ms': spent, 'ply': ply}
        else:
            return {'success': False, 'message': 'bad_payload'}

        # Increment and byoyomi reset
        inc = max(0, int(cfg.get('increment_ms') or 0))
        if inc > 0:
            ts[role]['initial_ms'] = max(0, int(ts[role].get('initial_ms') or 0)) + inc
        ts[role]['byoyomi_ms'] = max(0, int(cfg.get('byoyomi_ms') or 0))

        # Switch turn and restart base_at
        next_turn = 'gote' if role == 'sente' else 'sente'
        doc['current_turn'] = next_turn
        ts['current_player'] = next_turn
        ts['base_at'] = now_ms

        # --- canonical record: also store USI ---
        final_usi = None
        try:
            if move_rec.get('type') == 'move':
                fr = move_rec.get('from') or {}
                to = move_rec.get('to') or {}
                frsq = _rc_to_usi_sq(int(fr.get('r')), int(fr.get('c')))
                tosq = _rc_to_usi_sq(int(to.get('r')), int(to.get('c')))
                final_usi = frsq + tosq + ('+' if move_rec.get('promote') else '')
            elif move_rec.get('type') == 'drop':
                to = move_rec.get('to') or {}
                tosq = _rc_to_usi_sq(int(to.get('r')), int(to.get('c')))
                letter_map = {
                    'pawn': 'P', 'lance': 'L', 'knight': 'N', 'silver': 'S',
                    'gold': 'G', 'bishop': 'B', 'rook': 'R', 'king': 'K'
                }
                letter = letter_map.get(_to_base_piece(str(move_rec.get('piece'))))
                if letter and tosq:
                    final_usi = f"{letter}*{tosq}"
        except Exception:
            final_usi = None

        if final_usi:
            move_rec['usi'] = final_usi

        # ---- Persist minimal move record (USI is canonical) ----
        # Store only what we cannot cheaply re-derive later.
        kif_str = self._safe_kif(role, move_rec)
        entry = {
            'ply': int(ply),
            'usi': (final_usi or client_usi or None),
            'by': role,
            'spent_ms': int(spent) if spent is not None else 0,
            'ts': str(move_rec.get('ts') or self._now().isoformat()),
        }
        if kif_str:
            entry['kif'] = kif_str

        # Drop Nones
        move_hist.append({k: v for k, v in entry.items() if v is not None})
        doc['move_history'] = move_hist

        # Update canonical SFEN (board + hands + side-to-move + ply)
        new_ply = len(move_hist) + 1
        new_sfen = _build_sfen(board, next_turn, hands, new_ply)
        if not new_sfen:
            return {'success': False, 'message': 'sfen_build_failed'}
        doc['sfen'] = new_sfen
        doc['updated_at'] = self._now()
        doc['time_state'] = ts

        upd = {
            'sfen': new_sfen,
            'move_history': move_hist,
            'current_turn': next_turn,
            'updated_at': doc['updated_at'],
            'time_state': ts,
        }
        self.game_model.update_one({"_id": game_id}, {"$set": upd, "$unset": {'board': '', 'captured': ''}})

        return dict(success=True, **self.as_api_payload(doc, me))


    def resign_game(self, game_id: str, me: str):
        # Load current doc
        doc = self.game_model.find_one({"_id": game_id})
        if not doc:
            return {'success': False, 'message': 'not_found'}

        # Identify role and winner
        role = self._role_of(doc, me)
        if role is None:
            return {'success': False, 'message': 'forbidden'}
        winner = self._opponent(role)

        # Idempotency: if already finished, do nothing
        if str(doc.get('status')) == 'finished':
            return {'success': False, 'message': 'already_finished', 'winner': doc.get('winner'), 'reason': doc.get('finished_reason')}

        update = {'status': 'finished', 'finished_reason': 'resign', 'winner': winner, 'updated_at': self._now()}
        _set_players_presence_review(doc)
        # Atomic update: set finished only if not already finished (avoid race / double emits)
        result = self.game_model.update_one({"_id": game_id, "status": {"$ne": "finished"}}, {"$set": update})

        if getattr(result, 'modified_count', 1) == 0:
            # Someone else finished first; do not emit duplicate
            return {'success': False, 'message': 'already_finished'}

        # enqueue engine analysis (best-effort; idempotent on DB)
        try:
            from src.services.analysis_queue import try_enqueue_game_analysis
            try_enqueue_game_analysis(self, str(game_id), redis_url=current_app.config.get("REDIS_URL"))
        except Exception:
            pass

        # Re-read latest for player info
        doc = self.game_model.find_one({"_id": game_id}) or doc
        try:
            if self.socketio:
                # --- build detailed finish payload (winner/loser ids & names included) ---
                players = doc.get('players') or {}
                s_uid = str(((players.get('sente') or {}).get('user_id') or doc.get('sente_id') or '') or '')
                g_uid = str(((players.get('gote')  or {}).get('user_id') or doc.get('gote_id')  or '') or '')
                s_name = str(((players.get('sente') or {}).get('username') or (players.get('sente') or {}).get('name') or '') or '')
                g_name = str(((players.get('gote')  or {}).get('username') or (players.get('gote')  or {}).get('name') or '') or '')

                winner_role = winner
                loser_role  = 'gote' if winner_role == 'sente' else 'sente'
                winner_uid  = s_uid if winner_role == 'sente' else g_uid
                loser_uid   = g_uid if winner_role == 'sente' else s_uid
                winner_un   = s_name if winner_role == 'sente' else g_name
                loser_un    = g_name if winner_role == 'sente' else s_name

                self.socketio.emit('game:finished', {
                    'game_id': game_id,
                    'winner': winner_role,
                    'loser': loser_role,
                    'reason': 'resign',
                    'winner_user_id': winner_uid,
                    'loser_user_id': loser_uid,
                    'winner_username': winner_un,
                    'loser_username': loser_un,
                }, room=f'game:{game_id}')
        except Exception:
            pass

        return {'success': True, 'winner': winner, 'reason': 'resign'}
    def get_active_games(self, limit: int = 50, include_waiting: bool = True):
        """
        ロビー/監視用にアクティブな対局一覧を返す。
        - include_waiting=True のとき、マッチング待ち("waiting")も含める
        戻り値は API 用の軽量ペイロード配列
        """
        statuses = ['active', 'ongoing', 'in_progress', 'started']
        if include_waiting:
            statuses = ['waiting'] + statuses
        cur = self.game_model.find({"status": {"$in": statuses}}).limit(int(limit))
        out = []
        for doc in cur:
            try:
                out.append(self.as_api_payload(doc))
            except Exception:
                out.append({
                    "id": doc.get("_id"),
                    "status": doc.get("status"),
                    "current_turn": doc.get("current_turn"),
                    "updated_at": (doc.get("updated_at") or self._now()).isoformat(),
                })
    # --- KIF helpers ---
    def _piece_kanji(self, piece: str) -> str:
        mp = {
            'pawn': '歩', 'lance': '香', 'knight': '桂', 'silver': '銀',
            'gold': '金', 'bishop': '角', 'rook': '飛', 'king': '玉',
            'promoted_pawn': 'と', 'promoted_lance': '成香', 'promoted_knight': '成桂',
            'promoted_silver': '成銀', 'horse': '馬', 'dragon': '龍',
            'promoted_bishop': '馬', 'promoted_rook': '龍',
        }
        return mp.get(str(piece), str(piece))

    def _to_kif(self, by: str, rec: dict) -> str:
        typ = rec.get('type')

        # KIF notation (柿木形式):
        #   <指し手> = [<手番>]<移動先座標><駒>[<装飾子>]<移動元座標>
        # 本システムでは、KIF出力時は手番(▲/△)を省略します。
        # 参考: https://kakinoki.o.oo7.jp/kif_format.html

        raw_piece = rec.get('piece') or rec.get('piece_type') or ''

        # 「成」のときは、駒名を成駒にせず「歩成」「角成」などの形にする。
        promoted_to_base = {
            'promoted_pawn': 'pawn',
            'promoted_lance': 'lance',
            'promoted_knight': 'knight',
            'promoted_silver': 'silver',
            'horse': 'bishop',
            'dragon': 'rook',
            'promoted_bishop': 'bishop',
            'promoted_rook': 'rook',
        }

        is_promo_move = bool(
            rec.get('promote')
            or rec.get('promoted')
            or rec.get('is_promote')
            or rec.get('is_promotion')
        )

        disp_piece_key = promoted_to_base.get(str(raw_piece), str(raw_piece)) if is_promo_move else str(raw_piece)
        piece = self._piece_kanji(disp_piece_key)
        to = rec.get('to') or {}
        fr = rec.get('from') or {}
        fw = '０１２３４５６７８９'
        rows = ['','一','二','三','四','五','六','七','八','九']
        tc = 9 - int(to.get('c') or to.get('col') or to.get('x') or 0)
        tr = int(to.get('r') or to.get('row') or to.get('y') or 0) + 1
        tc_fw = fw[tc] if 0 <= tc <= 9 else str(tc)
        tr_kan = rows[tr] if 0 <= tr < len(rows) else str(tr)
        if typ == 'drop':
            return f"{tc_fw}{tr_kan}{piece}打"
        fc = 9 - int(fr.get('c') or fr.get('col') or fr.get('x') or 0)
        frw= int(fr.get('r') or fr.get('row') or fr.get('y') or 0) + 1
        promo = '成' if is_promo_move else ''
        # 「成」は移動元座標の前に付ける (例: ２三歩成(24))
        return f"{tc_fw}{tr_kan}{piece}{promo}({fc}{frw})"

    def _safe_kif(self, by: str, rec: dict):
        try:
            return self._to_kif(by, rec)
        except Exception:
            return None
        return out
