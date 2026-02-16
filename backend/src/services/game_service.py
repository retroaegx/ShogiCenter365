from __future__ import annotations
from flask import current_app
from bson import ObjectId
from typing import Any, Dict, Optional, List
from datetime import datetime, timezone
from src.presence_utils import get_db

# --- Mongo duplicate key ---
try:
    from pymongo.errors import DuplicateKeyError  # type: ignore
except Exception:  # pragma: no cover
    DuplicateKeyError = Exception  # type: ignore


def _get_db_collection(db, name: str):
    """Get a collection/collection-like object from MongoDB Database or MemoryDB.

    - Mongo: db[name]
    - MemoryDB: getattr(db, name)
    """
    if db is None:
        return None
    # dict-like
    try:
        if isinstance(db, dict):
            return db.get(name)
    except Exception:
        pass
    # attribute
    try:
        c = getattr(db, name, None)
        if c is not None:
            return c
    except Exception:
        pass
    # item access (MongoDB Database supports this)
    try:
        return db[name]
    except Exception:
        return None


def _acquire_post_game_lock(db, game_id: str, now_dt: datetime) -> tuple[bool, str | None]:
    """Cross-process idempotency lock.

    Uses 'post_game_updates' collection with _id = game_id.
    - First caller inserts {status:'applying'} and proceeds.
    - If duplicate exists:
        - status=='done' -> skip
        - status!='done' -> treat as busy (or stale takeover if old)
    """
    coll = _get_db_collection(db, 'post_game_updates')
    if coll is None:
        # fallback to game-doc lock only
        return True, None

    gid = str(game_id)
    try:
        coll.insert_one({'_id': gid, 'status': 'applying', 'started_at': now_dt})
        return True, None
    except DuplicateKeyError:
        pass
    except Exception as e:
        s = str(e)
        if ('E11000' not in s) and ('duplicate key' not in s.lower()):
            # if we cannot lock reliably, allow proceeding (game-doc lock should still help)
            return True, 'lock_insert_failed'

    # already exists -> inspect
    try:
        ex = coll.find_one({'_id': gid}) or {}
        st = str(ex.get('status') or '')
        if st == 'done':
            return False, 'already_done'
        if st == 'error':
            # allow immediate retry after an error state (best-effort)
            try:
                coll.update_one({'_id': gid}, {'$set': {'status': 'applying', 'started_at': now_dt}})
            except Exception:
                pass
            return True, 'retry_after_error'

        started = ex.get('started_at')
        try:
            if isinstance(started, datetime):
                age = (now_dt - started).total_seconds()
                # takeover if stale (e.g., process crashed)
                if age >= 180:
                    coll.update_one({'_id': gid}, {'$set': {'status': 'applying', 'started_at': now_dt}})
                    return True, 'stale_takeover'
        except Exception:
            pass

        return False, 'lock_busy'
    except Exception:
        return False, 'lock_busy'


def _finalize_post_game_lock(db, game_id: str, now_dt: datetime, status: str, payload: dict | None = None):
    coll = _get_db_collection(db, 'post_game_updates')
    if coll is None:
        return
    try:
        upd = {'status': status, 'updated_at': now_dt}
        if status == 'done':
            upd['done_at'] = now_dt
        if payload is not None:
            upd['result'] = payload
        coll.update_one({'_id': str(game_id)}, {'$set': upd}, upsert=True)
    except Exception:
        pass

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


# === repetition / check helpers =================================================

def _normalize_sfen_key(sfen: str) -> Optional[str]:
    """Normalize SFEN to a repetition key (board + side-to-move + hands), excluding ply."""
    if not isinstance(sfen, str):
        return None
    s = sfen.strip()
    if not s:
        return None
    if s == 'startpos':
        s = DEFAULT_START_SFEN
    parts = s.split()
    if len(parts) < 3:
        return None
    return ' '.join(parts[:3])


def _find_king(board: list, role: str):
    try:
        for r in range(9):
            for c in range(9):
                cell = board[r][c]
                if cell and str(cell.get('owner')) == role and str(cell.get('piece')) == 'king':
                    return (r, c)
    except Exception:
        return None
    return None


# === nyugyoku / 27-point rule helpers =======================================

def _nyugyoku_is_enemy_camp(role: str, row: int) -> bool:
    """Return True if (row) is within opponent's camp 3 ranks for the given role."""
    try:
        r = int(row)
    except Exception:
        return False
    if str(role) == 'sente':
        return 0 <= r <= 2
    if str(role) == 'gote':
        return 6 <= r <= 8
    return False


def _nyugyoku_piece_value(piece: str) -> int:
    """Piece point for nyugyoku / jishogi (king is 0)."""
    p = str(piece or '')
    # normalize legacy names
    if p == 'horse':
        p = 'promoted_bishop'
    if p == 'dragon':
        p = 'promoted_rook'
    base = _to_base_piece(p)
    if base == 'king':
        return 0
    if base in ('rook', 'bishop'):
        return 5
    # gold/silver/knight/lance/pawn and their promotions count as 1
    return 1


def _compute_nyugyoku_stats(board: list, hands: dict, role: str) -> dict:
    """Compute nyugyoku stats for role.

    - points_camp: (own pieces in opponent camp 3 ranks, excluding king) + hands
    - points_total: (all own pieces on board, excluding king) + hands

    Notes:
      * enemy_camp_pieces counts pieces in opponent camp 3 ranks excluding king.
    """
    king_in_enemy_camp = False
    enemy_camp_pieces = 0
    points_camp = 0
    points_total = 0

    # king position
    kp = _find_king(board, role)
    if kp:
        king_in_enemy_camp = _nyugyoku_is_enemy_camp(role, int(kp[0]))

    # board pieces (exclude king)
    try:
        for r in range(9):
            for c in range(9):
                cell = board[r][c]
                if not cell:
                    continue
                if str(cell.get('owner')) != str(role):
                    continue
                piece = str(cell.get('piece') or '')
                if piece == 'king':
                    continue

                v = _nyugyoku_piece_value(piece)
                points_total += v
                if _nyugyoku_is_enemy_camp(role, r):
                    enemy_camp_pieces += 1
                    points_camp += v
    except Exception:
        pass

    # hands (always unpromoted)
    try:
        hmap = hands.get(role) if isinstance(hands, dict) else None
        if isinstance(hmap, dict):
            for p, n in hmap.items():
                try:
                    cnt = int(n or 0)
                except Exception:
                    cnt = 0
                if cnt <= 0:
                    continue

                v = _nyugyoku_piece_value(str(p)) * cnt
                points_camp += v
                points_total += v
    except Exception:
        pass

    in_check = False
    try:
        in_check = bool(_is_king_in_check(board, role))
    except Exception:
        in_check = False

    return {
        'king_in_enemy_camp': bool(king_in_enemy_camp),
        'enemy_camp_pieces': int(enemy_camp_pieces),
        # backward-compatible alias (historically meant camp+hands)
        'points': int(points_camp),
        'points_camp': int(points_camp),
        'points_total': int(points_total),
        'in_check': bool(in_check),
    }

def _evaluate_nyugyoku_outcome(board: list, hands: dict, move_count: int) -> Optional[dict]:
    """Evaluate nyugyoku/jishogi end condition.

    Rules (as requested):
      - Before 256 moves:
          * If a side has entered (king in enemy camp 3 ranks) and satisfies 27-point rule:
              king in enemy camp, >=10 other pieces in enemy camp, not in check,
              points_camp >= 28 (sente) / 27 (gote)  -> win
          * If a side has entered and points_total >= 44 -> win
          * If a side has entered and points_total < 10 -> lose
      - At 256 moves: if not finished earlier -> draw

    Returns:
      None or {winner_role, loser_role, reason, extra_set}
    """
    try:
        mc = int(move_count)
    except Exception:
        mc = 0

    # 256-move draw (priority after checkmate/sennichite in caller)
    if mc >= 256:
        extra = {
            'nyugyoku_eval': {
                'move_count': int(mc),
                'rule': '256_draw',
            }
        }
        return {'winner_role': 'draw', 'loser_role': 'draw', 'reason': 'jishogi_256', 'extra_set': extra}

    stats = {}
    entered = []
    for r in ('sente', 'gote'):
        st = _compute_nyugyoku_stats(board, hands, r)
        stats[r] = st
        if st.get('king_in_enemy_camp'):
            entered.append(r)

    if not entered:
        return None

    def _win_threshold(role: str) -> int:
        return 28 if str(role) == 'sente' else 27

    win_sides = []
    lose_sides = []
    for r in entered:
        st = stats.get(r) or {}
        pts_camp = int(st.get('points_camp') or st.get('points') or 0)
        pts_total = int(st.get('points_total') or 0)
        if pts_total < 10:
            lose_sides.append(r)
            continue
        # Special long-game countermeasure: if entered and total points (board+hands) >= 44 -> win
        if pts_total >= 44:
            win_sides.append(r)
            continue
        if (
            int(st.get('enemy_camp_pieces') or 0) >= 10
            and not bool(st.get('in_check'))
            and pts_camp >= _win_threshold(r)
        ):
            win_sides.append(r)

    extra = {
        'nyugyoku_eval': {
            'move_count': int(mc),
            'stats': stats,
        }
    }

    # win
    if len(win_sides) == 1:
        w = win_sides[0]
        return {
            'winner_role': w,
            'loser_role': ('gote' if w == 'sente' else 'sente'),
            'reason': 'nyugyoku',
            'extra_set': extra,
        }
    if len(win_sides) >= 2:
        return {'winner_role': 'draw', 'loser_role': 'draw', 'reason': 'nyugyoku_both', 'extra_set': extra}

    # lose (low points)
    if len(lose_sides) == 1:
        l = lose_sides[0]
        return {
            'winner_role': ('gote' if l == 'sente' else 'sente'),
            'loser_role': l,
            'reason': 'nyugyoku_low_points',
            'extra_set': extra,
        }
    if len(lose_sides) >= 2:
        return {'winner_role': 'draw', 'loser_role': 'draw', 'reason': 'nyugyoku_low_points_both', 'extra_set': extra}

    return None


def _attacks_square(board: list, r: int, c: int, piece: str, owner: str, tr: int, tc: int) -> bool:
    """Return True if the piece at (r,c) attacks target square (tr,tc) (pseudo-legal, ignores self-check)."""
    try:
        p = str(piece or '')
        if p == 'horse':
            p = 'promoted_bishop'
        if p == 'dragon':
            p = 'promoted_rook'

        fwd = -1 if owner == 'sente' else 1
        bwd = -fwd

        def on_board(rr, cc):
            return 0 <= rr < 9 and 0 <= cc < 9

        # step attacks (non-sliding)
        if p == 'king':
            return max(abs(tr - r), abs(tc - c)) == 1
        if p in ('gold', 'promoted_pawn', 'promoted_lance', 'promoted_knight', 'promoted_silver'):
            dirs = [(fwd, 0), (fwd, -1), (fwd, 1), (0, -1), (0, 1), (bwd, 0)]
            return any((r + dr == tr and c + dc == tc) for dr, dc in dirs)
        if p == 'silver':
            dirs = [(fwd, 0), (fwd, -1), (fwd, 1), (bwd, -1), (bwd, 1)]
            return any((r + dr == tr and c + dc == tc) for dr, dc in dirs)
        if p == 'pawn':
            return (r + fwd == tr and c == tc)
        if p == 'knight':
            return (r + 2 * fwd == tr) and (c + 1 == tc or c - 1 == tc)

        # sliding pieces
        if p == 'lance':
            dr, dc = fwd, 0
            rr, cc = r + dr, c + dc
            while on_board(rr, cc):
                if rr == tr and cc == tc:
                    return True
                if board[rr][cc]:
                    return False
                rr += dr
                cc += dc
            return False

        def slide(drs):
            for dr, dc in drs:
                rr, cc = r + dr, c + dc
                while on_board(rr, cc):
                    if rr == tr and cc == tc:
                        return True
                    if board[rr][cc]:
                        break
                    rr += dr
                    cc += dc
            return False

        if p == 'bishop':
            return slide([(1, 1), (1, -1), (-1, 1), (-1, -1)])
        if p == 'rook':
            return slide([(1, 0), (-1, 0), (0, 1), (0, -1)])
        if p == 'promoted_bishop':
            if slide([(1, 1), (1, -1), (-1, 1), (-1, -1)]):
                return True
            # king-like orthogonal steps
            return any((r + dr == tr and c + dc == tc) for dr, dc in [(1,0),(-1,0),(0,1),(0,-1)])
        if p == 'promoted_rook':
            if slide([(1, 0), (-1, 0), (0, 1), (0, -1)]):
                return True
            # king-like diagonal steps
            return any((r + dr == tr and c + dc == tc) for dr, dc in [(1,1),(1,-1),(-1,1),(-1,-1)])
    except Exception:
        return False
    return False


def _is_king_in_check(board: list, defender_role: str) -> bool:
    """Return True if defender_role's king is in check."""
    if defender_role not in ('sente', 'gote'):
        return False
    attacker = 'gote' if defender_role == 'sente' else 'sente'
    kp = _find_king(board, defender_role)
    if not kp:
        return False
    tr, tc = kp
    try:
        for r in range(9):
            for c in range(9):
                cell = board[r][c]
                if not cell:
                    continue
                if str(cell.get('owner')) != attacker:
                    continue
                if _attacks_square(board, r, c, str(cell.get('piece')), attacker, tr, tc):
                    return True
    except Exception:
        return False
    return False




# === legality / checkmate helpers ==========================================

def _copy_board(board: list) -> list:
    """Deep-ish copy for 9x9 board of None/dict."""
    nb = []
    try:
        for row in board:
            nr = []
            for cell in row:
                if isinstance(cell, dict):
                    nr.append(dict(cell))
                else:
                    nr.append(None)
            nb.append(nr)
    except Exception:
        # fallback (best-effort)
        nb = [[(dict(c) if isinstance(c, dict) else None) for c in (row or [])] for row in (board or [])]
    return nb


def _copy_hands(hands: dict) -> dict:
    out = {'sente': {}, 'gote': {}}
    try:
        for side in ('sente', 'gote'):
            bag = (hands or {}).get(side) or {}
            if isinstance(bag, dict):
                out[side] = {str(k): int(v) for k, v in bag.items() if int(v or 0) > 0}
            else:
                out[side] = {}
    except Exception:
        pass
    return out


def _has_unpromoted_pawn_on_file(board: list, role: str, col: int) -> bool:
    try:
        for r in range(9):
            cell = board[r][col]
            if not cell:
                continue
            if str(cell.get('owner')) != role:
                continue
            if str(cell.get('piece')) == 'pawn':
                return True
    except Exception:
        return False
    return False


def _drop_rank_illegal(role: str, piece: str, r2: int) -> str | None:
    # 行き所のない駒（打つ場合）
    if role == 'sente':
        if piece in ('pawn', 'lance') and r2 == 0:
            return 'drop_last_rank'
        if piece == 'knight' and r2 <= 1:
            return 'drop_last_two_ranks'
    elif role == 'gote':
        if piece in ('pawn', 'lance') and r2 == 8:
            return 'drop_last_rank'
        if piece == 'knight' and r2 >= 7:
            return 'drop_last_two_ranks'
    return None


def _apply_legal_usi_move(board: list, hands: dict, role: str, spec: dict, *, depth: int = 0) -> dict:
    """Validate + apply a move/drop.

    Returns:
      { ok: bool, message?: str, board?: list, hands?: dict, move_rec?: dict }

    - Validates piece movement (incl. sliding blocks)
    - Validates promotion rules
    - Validates drops (nifu / illegal ranks / uchifuzume)
    - Rejects self-check
    """
    if role not in ('sente', 'gote'):
        return {'ok': False, 'message': 'bad_role'}
    if not isinstance(spec, dict):
        return {'ok': False, 'message': 'bad_payload'}

    # guard runaway recursion (uchifuzume uses mate search)
    if depth > 6:
        return {'ok': False, 'message': 'depth_limit'}

    nb = _copy_board(board)
    nh = _copy_hands(hands)

    def inb(r, c):
        return 0 <= int(r) < 9 and 0 <= int(c) < 9

    # --- normal move ---
    if spec.get('is_drop') is False and all(k in spec for k in ('from_row','from_col','to_row','to_col')):
        try:
            r1, c1 = int(spec['from_row']), int(spec['from_col'])
            r2, c2 = int(spec['to_row']),  int(spec['to_col'])
        except Exception:
            return {'ok': False, 'message': 'bad_payload'}

        if not (inb(r1, c1) and inb(r2, c2)):
            return {'ok': False, 'message': 'out_of_bounds'}
        if r1 == r2 and c1 == c2:
            return {'ok': False, 'message': 'illegal_move'}

        src = nb[r1][c1]
        dst = nb[r2][c2]
        if not (isinstance(src, dict) and str(src.get('owner')) == role):
            return {'ok': False, 'message': 'no_piece_or_not_owner'}
        if isinstance(dst, dict) and str(dst.get('owner')) == role:
            return {'ok': False, 'message': 'occupied_by_self'}
        if isinstance(dst, dict) and str(dst.get('piece')) == 'king':
            return {'ok': False, 'message': 'cannot_capture_king'}

        orig_piece = str(src.get('piece') or '')
        want_promote = bool(spec.get('promote'))

        # movement pattern + blocks
        if not _attacks_square(nb, r1, c1, orig_piece, role, r2, c2):
            return {'ok': False, 'message': 'illegal_move'}

        # promotion validation
        if want_promote and orig_piece.startswith('promoted_'):
            return {'ok': False, 'message': 'invalid_promotion'}
        if want_promote and not (_can_promote(role, orig_piece, r1, r2) or _must_promote(role, orig_piece, r2)):
            return {'ok': False, 'message': 'invalid_promotion'}

        piece_name = orig_piece
        if _must_promote(role, orig_piece, r2) or (want_promote and _can_promote(role, orig_piece, r1, r2)):
            piece_name = PROMOTABLE.get(orig_piece, orig_piece)

        did_promote = (piece_name != orig_piece) and piece_name.startswith('promoted_')

        # capture (strict: captured piece -> base in hand)
        if isinstance(dst, dict):
            cap = _to_base_piece(str(dst.get('piece') or ''))
            if cap:
                nh[role][cap] = int(nh[role].get(cap) or 0) + 1

        nb[r2][c2] = {'owner': role, 'piece': piece_name, 'promoted': bool(piece_name.startswith('promoted_'))}
        nb[r1][c1] = None

        # self-check reject
        if _is_king_in_check(nb, role):
            return {'ok': False, 'message': 'self_check'}

        move_rec = {
            'type': 'move',
            'from': {'r': r1, 'c': c1},
            'to': {'r': r2, 'c': c2},
            'by': role,
            'piece': piece_name,
            'promote': bool(did_promote),
        }
        return {'ok': True, 'board': nb, 'hands': nh, 'move_rec': move_rec}

    # --- drop ---
    if spec.get('is_drop') is True and all(k in spec for k in ('piece_type','to_row','to_col')):
        try:
            r2, c2 = int(spec['to_row']), int(spec['to_col'])
        except Exception:
            return {'ok': False, 'message': 'bad_payload'}
        if not inb(r2, c2):
            return {'ok': False, 'message': 'out_of_bounds'}
        if nb[r2][c2] is not None:
            return {'ok': False, 'message': 'occupied'}

        piece = _to_base_piece(str(spec.get('piece_type') or ''))
        if piece not in ('pawn','lance','knight','silver','gold','bishop','rook'):
            return {'ok': False, 'message': 'bad_payload'}

        cnt = int((nh.get(role) or {}).get(piece) or 0)
        if cnt <= 0:
            return {'ok': False, 'message': 'no_captured_piece'}

        # drop constraints
        rr = _drop_rank_illegal(role, piece, r2)
        if rr == 'drop_last_rank':
            return {'ok': False, 'message': 'drop_last_rank'}
        if rr == 'drop_last_two_ranks':
            return {'ok': False, 'message': 'drop_last_two_ranks'}

        # nifu
        if piece == 'pawn' and _has_unpromoted_pawn_on_file(nb, role, c2):
            return {'ok': False, 'message': 'nifu'}

        # apply
        nh[role][piece] = cnt - 1
        if nh[role][piece] <= 0:
            nh[role].pop(piece, None)

        nb[r2][c2] = {'owner': role, 'piece': piece, 'promoted': False}

        # self-check reject
        if _is_king_in_check(nb, role):
            return {'ok': False, 'message': 'self_check'}

        # uchifuzume (pawn-drop mate) reject
        if piece == 'pawn':
            opp = 'gote' if role == 'sente' else 'sente'
            try:
                if _is_king_in_check(nb, opp) and _is_checkmate(nb, nh, opp, depth=depth+1):
                    return {'ok': False, 'message': 'uchifuzume'}
            except Exception:
                pass

        move_rec = {
            'type': 'drop',
            'piece': piece,
            'to': {'r': r2, 'c': c2},
            'by': role,
        }
        return {'ok': True, 'board': nb, 'hands': nh, 'move_rec': move_rec}

    return {'ok': False, 'message': 'bad_payload'}


def _side_has_any_legal_move(board: list, hands: dict, role: str, *, depth: int = 0) -> bool:
    if role not in ('sente', 'gote'):
        return False

    # normal moves
    try:
        for r1 in range(9):
            for c1 in range(9):
                cell = board[r1][c1]
                if not cell:
                    continue
                if str(cell.get('owner')) != role:
                    continue
                piece = str(cell.get('piece') or '')
                # try all targets (cheap enough: 81)
                for r2 in range(9):
                    for c2 in range(9):
                        if r1 == r2 and c1 == c2:
                            continue
                        dst = board[r2][c2]
                        if isinstance(dst, dict) and str(dst.get('owner')) == role:
                            continue
                        if not _attacks_square(board, r1, c1, piece, role, r2, c2):
                            continue

                        if piece.startswith('promoted_') or piece not in PROMOTABLE:
                            promote_opts = [False]
                        else:
                            must = _must_promote(role, piece, r2)
                            can = _can_promote(role, piece, r1, r2)
                            if must:
                                promote_opts = [True]
                            elif can:
                                promote_opts = [False, True]
                            else:
                                promote_opts = [False]

                        for pr in promote_opts:
                            spec = {'is_drop': False, 'from_row': r1, 'from_col': c1, 'to_row': r2, 'to_col': c2, 'promote': bool(pr)}
                            res = _apply_legal_usi_move(board, hands, role, spec, depth=depth)
                            if isinstance(res, dict) and res.get('ok'):
                                return True
    except Exception:
        pass

    # drops
    try:
        bag = (hands or {}).get(role) or {}
        if isinstance(bag, dict):
            for piece, cnt in list(bag.items()):
                if int(cnt or 0) <= 0:
                    continue
                for r2 in range(9):
                    for c2 in range(9):
                        if board[r2][c2] is not None:
                            continue
                        spec = {'is_drop': True, 'piece_type': str(piece), 'to_row': r2, 'to_col': c2}
                        res = _apply_legal_usi_move(board, hands, role, spec, depth=depth)
                        if isinstance(res, dict) and res.get('ok'):
                            return True
    except Exception:
        pass

    return False


def _is_checkmate(board: list, hands: dict, defender_role: str, *, depth: int = 0) -> bool:
    if defender_role not in ('sente', 'gote'):
        return False
    if depth > 6:
        return False
    try:
        if not _is_king_in_check(board, defender_role):
            return False
    except Exception:
        return False
    return not _side_has_any_legal_move(board, hands, defender_role, depth=depth)

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

    # -------------------- post-game (rating / stats) --------------------

    def _to_user_id(self, x) -> Optional[Any]:
        if x is None:
            return None
        try:
            if isinstance(x, ObjectId):
                return x
        except Exception:
            pass
        try:
            s = str(x)
            if not s:
                return None
            # Mongo環境: 24hex の ObjectId を優先
            try:
                return ObjectId(s)
            except Exception:
                # メモリDB等: そのまま文字列ID
                return s
        except Exception:
            return None

    def _extract_player_ids(self, doc: dict) -> Dict[str, Optional[Any]]:
        players = (doc or {}).get('players') or {}
        s_uid = ((players.get('sente') or {}).get('user_id') or doc.get('sente_id'))
        g_uid = ((players.get('gote')  or {}).get('user_id') or doc.get('gote_id'))
        return {
            'sente': self._to_user_id(s_uid),
            'gote':  self._to_user_id(g_uid),
        }

    def apply_post_game_updates(self, game_id: str) -> Dict[str, Any]:
        """終局後に一度だけ、レーティング/戦績を反映する。

        - 多重適用は game_doc の post_game_updates_status で防ぐ（軽量）。
        - 400点以上の差 / 4000以上アカウントはレーティング変動なし（sc24_rating.should_skip_rating）。
        """
        doc = self.get_game_by_id(game_id)
        if not doc:
            return {'applied': False, 'reason': 'not_found'}
        if str(doc.get('status')) != 'finished':
            return {'applied': False, 'reason': 'not_finished'}

        now_dt = self._now()

        st = str(doc.get('post_game_updates_status') or '')
        if st == 'done':
            return {'applied': False, 'reason': 'already_done', 'result': doc.get('post_game_updates_result')}

        def _is_stale(d: dict) -> bool:
            try:
                started = d.get('post_game_updates_started_at')
                if isinstance(started, datetime):
                    return (now_dt - started).total_seconds() >= 180
            except Exception:
                pass
            return False

        if st == 'applying' and not _is_stale(doc):
            return {'applied': False, 'reason': 'already_applying'}

        # ---- claim (or stale takeover) ----
        try:
            if st != 'applying':
                r = self.game_model.update_one(
                    {'_id': game_id, 'post_game_updates_status': {'$nin': ['applying', 'done']}},
                    {'$set': {'post_game_updates_status': 'applying', 'post_game_updates_started_at': now_dt}},
                )
                if getattr(r, 'modified_count', 0) == 0:
                    doc2 = self.get_game_by_id(game_id) or {}
                    if str(doc2.get('post_game_updates_status') or '') == 'done':
                        return {'applied': False, 'reason': 'already_done', 'result': doc2.get('post_game_updates_result')}
                    return {'applied': False, 'reason': 'already_applying'}
            else:
                started0 = doc.get('post_game_updates_started_at')
                r = self.game_model.update_one(
                    {'_id': game_id, 'post_game_updates_status': 'applying', 'post_game_updates_started_at': started0},
                    {'$set': {'post_game_updates_started_at': now_dt}},
                )
                if getattr(r, 'modified_count', 0) == 0:
                    return {'applied': False, 'reason': 'already_applying'}
        except Exception:
            return {'applied': False, 'reason': 'lock_failed'}

        doc = self.get_game_by_id(game_id) or doc

        # game_type: rating only
        game_type = str(doc.get('game_type') or 'rating')
        if game_type != 'rating':
            result = {
                'game_type': game_type,
                'rating_applied': False,
                'stats_applied': False,
                'reason': 'non_rated_game',
            }
            try:
                self.game_model.update_one({'_id': game_id}, {'$set': {
                    'post_game_updates_status': 'done',
                    'post_game_updates_done_at': now_dt,
                    'post_game_updates_result': result,
                }})
            except Exception:
                pass
            return {'applied': True, 'result': result}

        # Players
        pids = self._extract_player_ids(doc)
        s_id = pids.get('sente')
        g_id = pids.get('gote')
        if not s_id or not g_id:
            err = 'missing_player_ids'
            try:
                self.game_model.update_one({'_id': game_id}, {'$set': {
                    'post_game_updates_status': 'error',
                    'post_game_updates_error': err,
                }})
            except Exception:
                pass
            return {'applied': False, 'reason': err}

        # DB
        try:
            db = get_db()
            users = db['users'] if isinstance(db, dict) else db.users
        except Exception:
            err = 'db_not_ready'
            try:
                self.game_model.update_one({'_id': game_id}, {'$set': {
                    'post_game_updates_status': 'error',
                    'post_game_updates_error': err,
                }})
            except Exception:
                pass
            return {'applied': False, 'reason': err}

        # Winner
        winner_role = doc.get('winner')
        if winner_role not in ('sente', 'gote'):
            winner_role = 'draw'

        # user snapshot
        def _safe_user(uid):
            try:
                return users.find_one(
                    {'_id': uid},
                    {
                        'rating': 1,
                        'games_played': 1,
                        'wins': 1,
                        'losses': 1,
                        'draws': 1,
                        'username': 1,
                        'user_kind': 1,
                        'is_guest': 1,
                    },
                ) or {}
            except Exception:
                return users.find_one({'_id': uid}) or {}

        s_user = _safe_user(s_id)
        g_user = _safe_user(g_id)

        players = doc.get('players') or {}
        if not isinstance(players, dict):
            players = {}
        s_player = players.get('sente') or {}
        g_player = players.get('gote') or {}

        def _user_kind_from(player_side: dict, user_doc: dict) -> str:
            k = player_side.get('user_kind')
            if isinstance(k, str):
                k = k.strip()
            else:
                k = ''
            if not k and user_doc:
                v = user_doc.get('user_kind')
                if isinstance(v, str):
                    v = v.strip()
                else:
                    v = ''
                k = v
            if not k and user_doc:
                k = 'guest' if bool(user_doc.get('is_guest')) else 'human'
            if not k:
                k = 'human'
            return k

        s_kind = _user_kind_from(s_player, s_user)
        g_kind = _user_kind_from(g_player, g_user)

        def _effective_games_played(uid, user_doc):
            """Return games_played for rating, excluding guest games."""
            try:
                coll = self.game_model
            except Exception:
                coll = None
            if coll is None:
                try:
                    return int(user_doc.get('games_played') or 0)
                except Exception:
                    return 0
            try:
                from bson import ObjectId as _OID
                if isinstance(uid, _OID):
                    uid_str = str(uid)
                else:
                    uid_str = str(uid)
            except Exception:
                uid_str = str(uid)
            conds = {
                'status': 'finished',
                '$and': [
                    {
                        '$or': [
                            {'players.sente.user_id': uid_str},
                            {'players.gote.user_id': uid_str},
                        ]
                    },
                    {
                        '$or': [
                            {'game_type': 'rating'},
                            {'game_type': {'$exists': False}},
                            {'game_type': None},
                            {'game_type': ''},
                        ]
                    },
                    {
                        '$or': [
                            {'players.sente.user_id': uid_str, 'players.sente.user_kind': {'$ne': 'guest'}},
                            {'players.gote.user_id': uid_str, 'players.gote.user_kind': {'$ne': 'guest'}},
                        ]
                    },
                ],
            }
            try:
                if hasattr(coll, 'count_documents'):
                    return int(coll.count_documents(conds))
                cur = coll.find(conds, {'_id': 1})
                return sum(1 for _ in cur)
            except Exception:
                try:
                    return int(user_doc.get('games_played') or 0)
                except Exception:
                    return 0

        s_rating = int(s_user.get('rating') or 0)
        g_rating = int(g_user.get('rating') or 0)
        s_games = _effective_games_played(s_id, s_user)
        g_games = _effective_games_played(g_id, g_user)

        from src.services.sc24_rating import compute_match_updates, should_skip_rating
        guest_involved = (s_kind == 'guest' or g_kind == 'guest')
        if guest_involved:
            skip_reason = 'guest_involved'
            stats_applied = False
            rating_applied = False
        else:
            skip_reason = should_skip_rating(s_rating, g_rating, s_games, g_games)
            stats_applied = (skip_reason != 'rating_account_4000')
            rating_applied = (skip_reason is None and winner_role in ('sente', 'gote'))

        # rating
        if rating_applied:
            sente_u, gote_u, _ = compute_match_updates(
                sente_rating=s_rating,
                gote_rating=g_rating,
                sente_games=s_games,
                gote_games=g_games,
                winner_role=winner_role,
            )
            s_new = int(sente_u.new_rating)
            g_new = int(gote_u.new_rating)
            s_delta = int(sente_u.delta)
            g_delta = int(gote_u.delta)
            s_formula = sente_u.formula
            g_formula = gote_u.formula
        else:
            s_new = s_rating
            g_new = g_rating
            s_delta = 0
            g_delta = 0
            s_formula = 'none'
            g_formula = 'none'

        # stats increments
        def _inc(role: str) -> Dict[str, int]:
            inc = {'games_played': 0, 'wins': 0, 'losses': 0, 'draws': 0}
            if not stats_applied:
                return inc
            inc['games_played'] = 1
            if winner_role == 'draw':
                inc['draws'] = 1
            elif winner_role == role:
                inc['wins'] = 1
            else:
                inc['losses'] = 1
            return inc

        s_inc = _inc('sente')
        g_inc = _inc('gote')

        # ---- apply ----
        try:
            if rating_applied:
                users.update_one({'_id': s_id}, {'$set': {'rating': s_new}, '$inc': s_inc})
                users.update_one({'_id': g_id}, {'$set': {'rating': g_new}, '$inc': g_inc})
            else:
                # rating unchanged
                if any(v != 0 for v in s_inc.values()):
                    users.update_one({'_id': s_id}, {'$inc': s_inc})
                if any(v != 0 for v in g_inc.values()):
                    users.update_one({'_id': g_id}, {'$inc': g_inc})
        except Exception as e:
            err = str(e)
            try:
                self.game_model.update_one({'_id': game_id}, {'$set': {
                    'post_game_updates_status': 'error',
                    'post_game_updates_error': err,
                }})
            except Exception:
                pass
            return {'applied': False, 'reason': 'user_update_failed', 'detail': err}

        result = {
            'game_type': 'rating',
            'winner': winner_role,
            'rating_applied': bool(rating_applied),
            'stats_applied': bool(stats_applied),
            'skip_reason': skip_reason,
            'sente': {
                'user_id': str(s_id),
                'username': s_user.get('username'),
                'old_rating': s_rating,
                'new_rating': s_new,
                'delta': s_delta,
                'formula': s_formula,
            },
            'gote': {
                'user_id': str(g_id),
                'username': g_user.get('username'),
                'old_rating': g_rating,
                'new_rating': g_new,
                'delta': g_delta,
                'formula': g_formula,
            },
        }

        try:
            self.game_model.update_one({'_id': game_id}, {'$set': {
                'post_game_updates_status': 'done',
                'post_game_updates_done_at': now_dt,
                'post_game_updates_result': result,
            }})
        except Exception:
            pass

        return {'applied': True, 'result': result}

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
    # === finish helpers (commonized) =========================================

    def _get_socketio(self):
        try:
            if self.socketio is not None:
                return self.socketio
        except Exception:
            pass
        try:
            sio = getattr(current_app, 'socketio', None)
            if sio is not None:
                return sio
        except Exception:
            pass
        try:
            return current_app.config.get('SOCKETIO')
        except Exception:
            return None

    def _get_player_meta(self, doc: dict) -> dict:
        players = (doc.get('players') or {}) if isinstance(doc.get('players'), dict) else {}
        s_pl = (players.get('sente') or {}) if isinstance(players.get('sente'), dict) else {}
        g_pl = (players.get('gote')  or {}) if isinstance(players.get('gote'),  dict) else {}

        s_uid = str(s_pl.get('user_id') or doc.get('sente_id') or '')
        g_uid = str(g_pl.get('user_id') or doc.get('gote_id')  or '')

        s_name = str((s_pl.get('username') or s_pl.get('name') or '先手') or '先手')
        g_name = str((g_pl.get('username') or g_pl.get('name') or '後手') or '後手')

        return {'s_uid': s_uid, 'g_uid': g_uid, 's_name': s_name, 'g_name': g_name}

    def _post_finish_cleanup(self, game_id: str, doc: dict) -> None:
        # Stop scheduled jobs (best-effort): timeout + disconnect.
        try:
            sch = current_app.config.get('TIMEOUT_SCHEDULER')
            if sch is not None:
                sch.unschedule_for_game(str(game_id))
        except Exception:
            pass
        try:
            dcs = current_app.config.get('DC_SCHEDULER')
            if dcs is not None:
                meta = self._get_player_meta(doc or {})
                if meta.get('s_uid'):
                    dcs.cancel(str(game_id), str(meta.get('s_uid')))
                if meta.get('g_uid'):
                    dcs.cancel(str(game_id), str(meta.get('g_uid')))
        except Exception:
            pass

    def _emit_finished_events(self, game_id: str, doc: dict, winner_role: str, loser_role: str, reason: str) -> None:
        sio = self._get_socketio()
        if sio is None:
            return

        room = f"game:{game_id}"

        try:
            payload = self.as_api_payload(doc)
        except Exception:
            payload = {"id": game_id, "status": "finished", "winner": winner_role, "loser": loser_role, "finished_reason": reason}

        try:
            sio.emit('game_update', payload, room=room)
        except Exception:
            pass

        meta = self._get_player_meta(doc or {})
        s_uid = str(meta.get('s_uid') or '')
        g_uid = str(meta.get('g_uid') or '')
        s_name = str(meta.get('s_name') or '先手')
        g_name = str(meta.get('g_name') or '後手')

        if winner_role in ('sente', 'gote'):
            winner_uid = s_uid if winner_role == 'sente' else g_uid
            loser_uid  = g_uid if winner_role == 'sente' else s_uid
            winner_un  = s_name if winner_role == 'sente' else g_name
            loser_un   = g_name if winner_role == 'sente' else s_name
        else:
            # draw or unknown
            winner_uid = ''
            loser_uid = ''
            winner_un = '引き分け'
            loser_un = ''

        try:
            sio.emit('game:finished', {
                'game_id': str(game_id),
                'winner': winner_role,
                'loser': loser_role,
                'reason': str(reason),
                'winner_user_id': winner_uid,
                'loser_user_id': loser_uid,
                'winner_username': winner_un,
                'loser_username': loser_un,
            }, room=room)
        except Exception:
            pass

        # system chat: announce game end (persist to chat history; deduped by DB)
        try:
            from src.utils.system_chat import emit_game_end_system_chat
            emit_game_end_system_chat(
                sio,
                self.game_model,
                doc or {},
                reason=str(reason),
                winner_role=str(winner_role),
                loser_role=str(loser_role),
            )
        except Exception:
            import logging
            logging.getLogger(__name__).warning('emit_game_end_system_chat failed', exc_info=True)

    def finish_game(
        self,
        game_id: str,
        winner_role: str,
        loser_role: str,
        reason: str,
        *,
        presence_mode: str = 'review',   # 'review' | 'disconnect' | 'none'
        disconnect_user_id: str | None = None,
        extra_set: dict | None = None,
        emit: bool = True,
    ) -> tuple[bool, dict]:
        """End game atomically and run common post-finish steps.

        Returns (finished_now, latest_doc).
        """
        doc0 = None
        try:
            doc0 = self.game_model.find_one({'_id': game_id})
            if doc0 and str(doc0.get('status')) == 'finished':
                return (False, doc0)
        except Exception:
            doc0 = None

        update = {
            'status': 'finished',
            'winner': winner_role,
            'loser': loser_role,
            'finished_reason': str(reason),
            'updated_at': self._now(),
        }
        if isinstance(extra_set, dict) and extra_set:
            update.update(extra_set)

        try:
            res = self.game_model.update_one({'_id': game_id, 'status': {'$ne': 'finished'}}, {'$set': update})
            if getattr(res, 'modified_count', 1) == 0:
                try:
                    doc_end = self.get_game_by_id(game_id) or doc0 or {}
                except Exception:
                    doc_end = doc0 or {}
                return (False, doc_end)
        except Exception:
            try:
                doc_end = self.get_game_by_id(game_id) or doc0 or {}
            except Exception:
                doc_end = doc0 or {}
            return (False, doc_end)

        # enqueue engine analysis (best-effort; idempotent on DB)
        try:
            from src.services.analysis_queue import try_enqueue_game_analysis
            try_enqueue_game_analysis(self, str(game_id), redis_url=current_app.config.get("REDIS_URL"))
        except Exception:
            pass

        # reload latest doc for meta/payload
        try:
            doc_end = self.get_game_by_id(game_id) or doc0 or {}
        except Exception:
            doc_end = doc0 or {}

        # presence
        try:
            if str(presence_mode) == 'disconnect':
                if disconnect_user_id is not None:
                    _set_disconnect_timeout_presence(doc_end, disconnect_user_id)
                else:
                    _set_players_presence_review(doc_end)
            elif str(presence_mode) == 'review':
                _set_players_presence_review(doc_end)
        except Exception:
            pass

        # stop schedulers
        try:
            self._post_finish_cleanup(str(game_id), doc_end)
        except Exception:
            pass

        # rating / stats (idempotent)
        try:
            if hasattr(self, 'apply_post_game_updates'):
                self.apply_post_game_updates(str(game_id))
                try:
                    doc_end = self.get_game_by_id(game_id) or doc_end
                except Exception:
                    pass
        except Exception:
            pass

        if emit:
            try:
                self._emit_finished_events(str(game_id), doc_end, winner_role, loser_role, str(reason))
            except Exception:
                pass

        return (True, doc_end)



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
        cur = cur if cur in ('sente', 'gote') else 'sente'

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

        winner_role = self._opponent(cur)
        loser_role = cur

        finished, _doc_end = self.finish_game(
            game_id=str(game_id),
            winner_role=winner_role,
            loser_role=loser_role,
            reason='timeout',
            presence_mode='review',
            emit=True,
        )
        return bool(finished)


    def as_api_payload(self, doc, me: Optional[str] = None):
        now_ms = int(self._now().timestamp() * 1000)
        doc = self._ensure_sfen_fields(doc)


        # Auto-finish: if an active game position is already checkmated, end it.
        # (This can happen in legacy DB due to missing legality checks.)
        try:
            if str(doc.get('status') or '') != 'finished' and doc.get('_id'):
                parsed0 = _parse_sfen(doc.get('sfen') or '')
                if parsed0 and parsed0.get('turn') in ('sente', 'gote'):
                    b0 = parsed0.get('board')
                    h0 = parsed0.get('hands')
                    t0 = parsed0.get('turn')
                    if b0 is not None and h0 is not None and _is_checkmate(b0, h0, t0, depth=0):
                        winner_role = self._opponent(t0)
                        finished, doc_end = self.finish_game(
                            game_id=str(doc.get('_id')),
                            winner_role=winner_role,
                            loser_role=t0,
                            reason='checkmate',
                            presence_mode='review',
                            emit=True,
                        )
                        if finished or str((doc_end or {}).get('status')) == 'finished':
                            return self.as_api_payload(doc_end, me)
        except Exception:
            pass


        # Auto-finish: nyugyoku / long-game (256 moves)
        try:
            st0 = str(doc.get('status') or '')
            if st0 in ('active', 'ongoing', 'in_progress', 'started') and doc.get('_id'):
                parsed0 = _parse_sfen(doc.get('sfen') or '')
                if parsed0 and parsed0.get('turn') in ('sente', 'gote'):
                    b0 = parsed0.get('board')
                    h0 = parsed0.get('hands')
                    mc0 = len(doc.get('move_history') or [])
                    if b0 is not None and h0 is not None:
                        outcome0 = _evaluate_nyugyoku_outcome(b0, h0, mc0)
                        if isinstance(outcome0, dict) and outcome0.get('reason'):
                            finished, doc_end = self.finish_game(
                                game_id=str(doc.get('_id')),
                                winner_role=str(outcome0.get('winner_role')),
                                loser_role=str(outcome0.get('loser_role')),
                                reason=str(outcome0.get('reason')),
                                presence_mode='review',
                                extra_set=(outcome0.get('extra_set') if isinstance(outcome0.get('extra_set'), dict) else None),
                                emit=True,
                            )
                            if finished or str((doc_end or {}).get('status')) == 'finished':
                                return self.as_api_payload(doc_end, me)
        except Exception:
            pass

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
            # --- rating / stats (optional fields; present when post-game updates run) ---
            "post_game_updates_status": doc.get("post_game_updates_status"),
            "post_game_updates_result": doc.get("post_game_updates_result"),
            "post_game_updates_error": doc.get("post_game_updates_error"),
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
                "post_game_updates_status": payload.get("post_game_updates_status"),
                "post_game_updates_result": payload.get("post_game_updates_result"),
                "post_game_updates_error": payload.get("post_game_updates_error"),
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



        # Auto-finish: if the side-to-move is already checkmated (legacy illegal positions), end now.
        try:
            cur_side = str(doc.get('current_turn') or 'sente')
            if cur_side in ('sente', 'gote') and _is_checkmate(board, hands, cur_side, depth=0):
                winner_role = self._opponent(cur_side)
                finished, doc_end = self.finish_game(
                    game_id=str(game_id),
                    winner_role=winner_role,
                    loser_role=cur_side,
                    reason='checkmate',
                    presence_mode='review',
                    emit=True,
                )
                if finished or str((doc_end or {}).get('status')) == 'finished':
                    return dict(success=True, **self.as_api_payload(doc_end, me))
        except Exception:
            pass

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
                loser_role = cur
                winner_role = 'gote' if cur == 'sente' else 'sente'
                try:
                    self.finish_game(
                        game_id=str(game_id),
                        winner_role=winner_role,
                        loser_role=loser_role,
                        reason='timeout',
                        presence_mode='review',
                        emit=True,
                    )
                except Exception:
                    pass
                return {'success': False, 'message': 'timeout', 'error': 'timeout'}
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
        # --- Apply move with strict legality validation (server-authoritative) ---
        apply_res = _apply_legal_usi_move(board, hands, role, parsed_usi, depth=0)
        if not (isinstance(apply_res, dict) and apply_res.get('ok')):
            msg = (apply_res or {}).get('message') if isinstance(apply_res, dict) else None
            return {'success': False, 'message': (msg or 'illegal_move')}

        board = apply_res['board']
        hands = apply_res['hands']
        move_rec = dict(apply_res.get('move_rec') or {})
        move_rec['ts'] = self._now().isoformat()
        move_rec['spent_ms'] = spent
        move_rec['ply'] = ply


        # Determine next turn (after this move)
        next_turn = 'gote' if role == 'sente' else 'sente'

        # Check flag: does this move give check to opponent?
        gives_check = False
        try:
            gives_check = _is_king_in_check(board, next_turn)
        except Exception:
            gives_check = False

        # Increment and byoyomi reset
        inc = max(0, int(cfg.get('increment_ms') or 0))
        if inc > 0:
            ts[role]['initial_ms'] = max(0, int(ts[role].get('initial_ms') or 0)) + inc
        ts[role]['byoyomi_ms'] = max(0, int(cfg.get('byoyomi_ms') or 0))

        # Switch turn and restart base_at
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

        entry['check'] = bool(gives_check)
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
        old_sfen = doc.get('sfen')
        doc['sfen'] = new_sfen
        doc['updated_at'] = self._now()
        doc['time_state'] = ts

        # --- repetition (sennichite) tracking ---
        repetition_triggered = False
        rep_offender = None  # 'sente' or 'gote' when perpetual check

        try:
            rep = doc.get('repetition') or {}
            keys = list(rep.get('keys') or [])
            counts = dict(rep.get('counts') or {})

            cur_key = _normalize_sfen_key(old_sfen or '')
            if cur_key:
                if not keys:
                    keys = [cur_key]
                    counts[cur_key] = int(counts.get(cur_key) or 0) + 1 if counts else 1
                else:
                    # repair: ensure current position is represented as the latest key
                    if str(keys[-1]) != str(cur_key):
                        keys.append(cur_key)
                        counts[cur_key] = int(counts.get(cur_key) or 0) + 1

            new_key = _normalize_sfen_key(new_sfen or '')
            if new_key:
                keys.append(new_key)
                counts[new_key] = int(counts.get(new_key) or 0) + 1

                if int(counts.get(new_key) or 0) >= 4:
                    repetition_triggered = True

                    # perpetual check (連続王手) detection:
                    # examine moves from the earliest of the last 4 occurrences to now.
                    pos_idx = [i for i, k in enumerate(keys) if str(k) == str(new_key)]
                    if len(pos_idx) >= 4:
                        i_start = int(pos_idx[-4])
                        segment = list(move_hist[i_start:])  # move_hist[i] -> keys[i] => keys[i+1]
                        sente_all = False
                        gote_all = False
                        s_moves = [m for m in segment if str(m.get('by')) == 'sente']
                        g_moves = [m for m in segment if str(m.get('by')) == 'gote']
                        if s_moves and all(bool(m.get('check')) for m in s_moves):
                            sente_all = True
                        if g_moves and all(bool(m.get('check')) for m in g_moves):
                            gote_all = True
                        if sente_all and not gote_all:
                            rep_offender = 'sente'
                        elif gote_all and not sente_all:
                            rep_offender = 'gote'
        except Exception:
            # keep moving even if repetition tracking fails
            keys = None
            counts = None

        if isinstance(keys, list) and isinstance(counts, dict):
            doc['repetition'] = {'keys': keys, 'counts': counts}


        upd = {
            'sfen': new_sfen,
            'move_history': move_hist,
            'current_turn': next_turn,
            'updated_at': doc['updated_at'],
            'time_state': ts,
        }

        if isinstance(doc.get('repetition'), dict):
            upd['repetition'] = doc.get('repetition')
        self.game_model.update_one({"_id": game_id}, {"$set": upd, "$unset": {'board': '', 'captured': ''}})


        # If the move checkmates the opponent, end now (priority over repetition).
        try:
            if _is_checkmate(board, hands, next_turn, depth=0):
                winner_role = role
                loser_role = next_turn
                _finished, doc_end = self.finish_game(
                    game_id=str(game_id),
                    winner_role=winner_role,
                    loser_role=loser_role,
                    reason='checkmate',
                    presence_mode='review',
                    emit=True,
                )
                return dict(success=True, **self.as_api_payload(doc_end, me))
        except Exception:
            pass

        # If repetition reached 4th occurrence, auto-finish.

        if repetition_triggered:
            try:
                if rep_offender in ('sente', 'gote'):
                    # Perpetual check: offender loses
                    winner_role = self._opponent(rep_offender)
                    loser_role = rep_offender
                    _finished, doc_end = self.finish_game(
                        game_id=str(game_id),
                        winner_role=winner_role,
                        loser_role=loser_role,
                        reason='perpetual_check_sennichite',
                        presence_mode='review',
                        emit=True,
                    )
                    return dict(success=True, **self.as_api_payload(doc_end, me))
                else:
                    # Normal sennichite: draw
                    _finished, doc_end = self.finish_game(
                        game_id=str(game_id),
                        winner_role='draw',
                        loser_role='draw',
                        reason='sennichite',
                        presence_mode='review',
                        emit=True,
                    )
                    return dict(success=True, **self.as_api_payload(doc_end, me))
            except Exception:
                pass


        # --- nyugyoku / long-game (256 moves) ---
        try:
            outcome = _evaluate_nyugyoku_outcome(board, hands, len(move_hist))
            if isinstance(outcome, dict) and outcome.get('reason'):
                _finished, doc_end = self.finish_game(
                    game_id=str(game_id),
                    winner_role=str(outcome.get('winner_role')),
                    loser_role=str(outcome.get('loser_role')),
                    reason=str(outcome.get('reason')),
                    presence_mode='review',
                    extra_set=(outcome.get('extra_set') if isinstance(outcome.get('extra_set'), dict) else None),
                    emit=True,
                )
                return dict(success=True, **self.as_api_payload(doc_end, me))
        except Exception:
            pass

        return dict(success=True, **self.as_api_payload(doc, me))



    def resign_game(self, game_id: str, me: str):
        doc = self.game_model.find_one({"_id": game_id})
        if not doc:
            return {'success': False, 'message': 'not_found'}

        role = self._role_of(doc, me)
        if role is None:
            return {'success': False, 'message': 'forbidden'}

        winner_role = self._opponent(role)
        loser_role = role

        if str(doc.get('status')) == 'finished':
            return {'success': False, 'message': 'already_finished', 'winner': doc.get('winner'), 'reason': doc.get('finished_reason')}

        finished, _doc_end = self.finish_game(
            game_id=str(game_id),
            winner_role=winner_role,
            loser_role=loser_role,
            reason='resign',
            presence_mode='review',
            emit=True,
        )
        if not finished:
            return {'success': False, 'message': 'already_finished'}

        return {'success': True, 'winner': winner_role, 'reason': 'resign'}


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