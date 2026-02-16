from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from typing import Any, Dict, Optional, Tuple, List

from flask import Blueprint, jsonify, current_app, request
from flask_jwt_extended import jwt_required

try:
    from bson import ObjectId  # type: ignore
except Exception:  # pragma: no cover
    ObjectId = None  # type: ignore

from src.config import Config as AppConfig


# ----------------------------
# Index bootstrap (best-effort)
# ----------------------------

_INDEX_READY = False


def _ensure_indexes_best_effort():
    """Create minimal indexes to keep /api/kifu/search fast.

    This runs at most once per process.
    It is safe to call even if MongoDB is unavailable (no-op).
    """
    global _INDEX_READY
    if _INDEX_READY:
        return

    try:
        db = _get_db()
        games = _get_coll(db, "games")
        # Memory DB doesn't support create_index
        if not hasattr(games, "create_index"):
            _INDEX_READY = True
            return

        # Common filters/sort
        games.create_index([("status", 1), ("created_at", -1)], name="kifu_status_created")
        # Username search (either side)
        games.create_index([("players.sente.username", 1), ("created_at", -1)], name="kifu_sente_created")
        games.create_index([("players.gote.username", 1), ("created_at", -1)], name="kifu_gote_created")
        # Two-player exact match (either order). This helps when both players are specified.
        games.create_index(
            [("players.sente.username", 1), ("players.gote.username", 1), ("created_at", -1)],
            name="kifu_pair_sg_created",
        )
        games.create_index(
            [("players.gote.username", 1), ("players.sente.username", 1), ("created_at", -1)],
            name="kifu_pair_gs_created",
        )
    except Exception:
        # Don't fail the app if index creation isn't permitted.
        pass
    finally:
        _INDEX_READY = True


# ----------------------------
# Blueprints
# ----------------------------

# New canonical API used by frontend:
#   GET /api/kifu/search
#   GET /api/kifu/<game_id>
kifu_bp = Blueprint("kifu_api", __name__, url_prefix="/api/kifu")

# Backward-compatibility endpoint (older links):
#   GET /api/game/<game_id>/kifu
kifu_legacy_bp = Blueprint("kifu_legacy", __name__, url_prefix="/api/game")


# ----------------------------
# Helpers
# ----------------------------

def _get_db():
    """Return the active MongoDB Database instance.

    Note: PyMongo Database objects do not implement truth-value testing (bool(db)).
    Avoid using `or` to choose between candidates.
    """
    db = current_app.config.get("MONGO_DB", None)
    if db is None:
        db = getattr(current_app, "mongo_db", None)
    if db is None:
        raise RuntimeError("db_not_ready")
    return db


def _get_coll(db, name: str):
    # PyMongo Database supports dict access. Memory DB in this repo has attributes.
    try:
        return db[name]
    except Exception:
        return getattr(db, name)


def _as_object_id_maybe(s: str):
    if ObjectId is None:
        return None
    try:
        return ObjectId(str(s))
    except Exception:
        return None


def _iso(dt: Any) -> Optional[str]:
    if isinstance(dt, datetime):
        try:
            return dt.isoformat()
        except Exception:
            return None
    return None


def _safe_id(v: Any) -> str:
    try:
        return str(v)
    except Exception:
        return ""


def _parse_date_ymd(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.strptime(str(s), "%Y-%m-%d")
    except Exception:
        return None


def _infer_time_code(doc: Dict[str, Any]) -> Optional[str]:
    # If stored explicitly, prefer it
    tc = doc.get("time_code")
    if isinstance(tc, str) and tc:
        return tc

    cfg = (((doc.get("time_state") or {}).get("config")) or {})
    if not isinstance(cfg, dict):
        return None

    init_ms = int(cfg.get("initial_ms") or 0)
    byo_ms = int(cfg.get("byoyomi_ms") or 0)
    inc_ms = int(cfg.get("increment_ms") or 0)
    def_ms = int(cfg.get("deferment_ms") or 0)

    for code, meta in (getattr(AppConfig, "TIME_CONTROLS", None) or {}).items():
        try:
            if int(meta.get("initial_time") or 0) * 1000 != init_ms:
                continue
            if int(meta.get("byoyomi_time") or 0) * 1000 != byo_ms:
                continue
            if int(meta.get("increment") or 0) * 1000 != inc_ms:
                continue
            if int(meta.get("deferment_time") or 0) * 1000 != def_ms:
                continue
            return str(code)
        except Exception:
            continue
    return None


def _time_display(code: Optional[str]) -> str:
    if not code:
        return ""
    meta = (getattr(AppConfig, "TIME_CONTROLS", None) or {}).get(code) or {}
    disp = meta.get("display") or meta.get("name") or ""
    try:
        return str(disp)
    except Exception:
        return ""


def _regex_exact_ci(s: str):
    s = str(s)
    return {"$regex": f"^{re.escape(s)}$", "$options": "i"}


def _format_kif(
    moves: List[Dict[str, Any]],
    header: Optional[Dict[str, Any]] = None,
) -> str:
    """Render KIF text (柿木形式).

    - 文字コードはAPIではUTF-8のまま返す（拡張子は .kif でもOK）。
    - 指し手の消費時間は (分:秒/時:分:秒) を出力する。
      参考: https://kakinoki.o.oo7.jp/kif_format.html
    """

    def _strip_mark(s: str) -> str:
        s = str(s)
        if s.startswith("▲") or s.startswith("△"):
            return s[1:]
        return s

    def _fix_promo_tail(s: str) -> str:
        # 旧データ互換: "...(... )成" のように末尾に成が来ている場合は
        # "...成(... )" に並べ替える。
        s0 = str(s)
        s = _strip_mark(s0)
        if not s.endswith(")成"):
            return s
        try:
            i = s.rindex("(")
            j = s.rindex(")")
        except ValueError:
            return s
        if i < 0 or j < 0 or j <= i:
            return s
        pre = s[:i]
        origin = s[i + 1 : j]

        # 末尾の "成" は promotion を意味するので、駒が成駒表記になっているときは基底駒へ戻す。
        promoted_piece_to_base = {
            "と": "歩",
            "成香": "香",
            "成桂": "桂",
            "成銀": "銀",
            "馬": "角",
            "龍": "飛",
            "竜": "飛",
        }
        # 先頭2文字は移動先（例: "７六"）
        dst = pre[:2]
        piece = pre[2:]
        piece = promoted_piece_to_base.get(piece, piece)

        return f"{dst}{piece}成({origin})"

    def _fmt_mmss(total_seconds: int) -> str:
        total_seconds = max(0, int(total_seconds or 0))
        m = total_seconds // 60
        s = total_seconds % 60
        return f"{m}:{s:02d}"

    def _fmt_hhmmss(total_seconds: int) -> str:
        total_seconds = max(0, int(total_seconds or 0))
        h = total_seconds // 3600
        m = (total_seconds % 3600) // 60
        s = total_seconds % 60
        return f"{h:02d}:{m:02d}:{s:02d}"

    def _parse_iso_to_jst(iso_s: Any) -> Optional[datetime]:
        if not iso_s:
            return None
        try:
            s = str(iso_s)
            # fromisoformat cannot parse 'Z'
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone(timedelta(hours=9)))
        except Exception:
            return None

    def _fmt_jst(dt: Optional[datetime]) -> str:
        if not dt:
            return ""
        # 例: 2025/12/25(木) 19:07
        wd = "月火水木金土日"[dt.weekday()]
        return dt.strftime(f"%Y/%m/%d({wd}) %H:%M")

    meta = header or {}
    lines: List[str] = []
    lines.append("# ---- Shogi Center 365 KIF ----")

    started = _parse_iso_to_jst(meta.get("created_at"))
    ended = _parse_iso_to_jst(meta.get("updated_at"))

    if started:
        lines.append(f"開始日時：{_fmt_jst(started)}")
    if ended and (meta.get("winner") or meta.get("reason")):
        # 終局済みっぽいときだけ出す（引き分けは winner が無い場合がある）
        lines.append(f"終了日時：{_fmt_jst(ended)}")

    lines.append("手合割：平手")

    players = meta.get("players") or {}
    s_name = ((players.get("sente") or {}).get("username") or "").strip()
    g_name = ((players.get("gote") or {}).get("username") or "").strip()
    if s_name:
        lines.append(f"先手：{s_name}")
    if g_name:
        lines.append(f"後手：{g_name}")

    if meta.get("time_display"):
        lines.append(f"持ち時間：{meta.get('time_display')}")

    if meta.get("reason"):
        # DBの終局理由コードはそのまま残す
        lines.append(f"備考：finished_reason={meta.get('reason')}")

    lines.append("手数----指手---------消費時間--")

    # 累積消費時間（先手/後手）
    cum: Dict[str, int] = {"sente": 0, "gote": 0}

    # 本譜
    # NOTE: KIFの手数は、印字した行番号（終局語彙行を含む）で揃える。
    last_ply_printed: int = 0
    for idx, rec in enumerate(moves or []):
        d = rec if isinstance(rec, dict) else {}
        try:
            ply = int(d.get("ply") or 0)
        except Exception:
            ply = idx + 1
        if ply <= 0:
            ply = idx + 1

        role = d.get("by") if d.get("by") in ("sente", "gote") else None
        kif = d.get("kif") if isinstance(d.get("kif"), str) else None
        usi = d.get("usi") if isinstance(d.get("usi"), str) else None

        try:
            spent_s = int((d.get("spent_ms") or 0) / 1000)
        except Exception:
            spent_s = 0

        if role in cum:
            cum[role] += max(0, spent_s)

        move_text = None
        if kif:
            move_text = _fix_promo_tail(kif)
        elif usi:
            move_text = usi.strip()
        else:
            move_text = "(unknown)"

        # 表示は手番記号を省略
        move_text = _strip_mark(move_text)

        # 消費時間: (分:秒/時:分:秒)
        cum_s = cum.get(role) if role in cum else 0
        # 時間表記は例に合わせ、末尾に余計な空白を入れない。
        lines.append(f"{ply:>4} {move_text} ( {_fmt_mmss(spent_s)}/{_fmt_hhmmss(cum_s)})")
        last_ply_printed = ply

    # 終局表記（KIFの終局語彙は柿木形式に準拠）
    winner = meta.get("winner")
    reason = str(meta.get("reason") or "")
    actual_moves = len([m for m in (moves or []) if isinstance(m, dict)])

    reason_to_endword = {
        "resign": ("投了", "投了"),
        "checkmate": ("詰み", "詰み"),
        "timeout": ("切れ負け", "切れ負け"),
        "timeup": ("切れ負け", "切れ負け"),
        "illegal": ("反則負け", "反則勝ち"),
        "disconnect_timeout": ("反則負け", "反則勝ち"),
        "disconnect_four": ("反則負け", "反則勝ち"),
        # 入玉宣言法（24/27点法拡張）
        "nyugyoku": ("入玉宣言", "入玉宣言"),
        "nyugyoku_low_points": ("入玉宣言(点数不足)", "入玉宣言(点数不足)"),
    }
    endword_loser, endword_winner = reason_to_endword.get(reason, (None, None))

    # 0手終局や不整合データのときは、無理に終局手を足さず、必要ならコメントだけ出す。
    if actual_moves > 0 and endword_loser:
        # 終局手の消費時間は 0 扱いにする。
        end_ply = actual_moves + 1
        lines.append(f"{end_ply:>4} {endword_loser} ( 0:00/00:00:00)")
        last_ply_printed = end_ply

        # 「反則負け」の内容はコメントで残せる（柿木形式）。
        if reason in ("disconnect_timeout", "disconnect_four"):
            lines.append("*切断")

    # 終局の要約（UI表示用）。
    # 柿木形式では「*」で始まる行は直前の指し手コメントになる。
    # 末尾の要約行も、終局手（投了/切れ負け/反則負け...）に紐づくコメントとして扱う。
    # 参考: https://kakinoki.o.oo7.jp/kif_format.html
    if last_ply_printed > 0 and winner in ("sente", "gote"):
        who = "先手" if winner == "sente" else "後手"
        # 括弧内の終局理由は、基本的に終局語彙（投了/切れ負け/反則負け...）を使う。
        suffix = f"({endword_loser})" if endword_loser else ""
        lines.append(f"*まで{last_ply_printed}手で{who}の勝ち{suffix}")
    elif actual_moves > 0 and (
        winner == "draw"
        or reason in (
            "sennichite",
            "draw",
            "jishogi_256",
            "nyugyoku_both",
            "nyugyoku_low_points_both",
        )
    ):
        # 引き分け系。宣言法の特殊引き分けや 256手到達のシステム引き分けもここで表記する。
        draw_word = {
            "sennichite": "千日手",
            "draw": "引き分け",
            "jishogi_256": "システムによる引き分け",
            "nyugyoku_both": "引き分け",
            "nyugyoku_low_points_both": "引き分け",
        }.get(str(reason), "引き分け")
        suffix = ""
        if str(reason) == "jishogi_256":
            suffix = "(256手到達のため)"
        elif str(reason) == "nyugyoku_both":
            suffix = "(入玉宣言)"
        elif str(reason) == "nyugyoku_low_points_both":
            suffix = "(入玉宣言/点数不足)"
        lines.append(f"*まで{actual_moves}手で{draw_word}{suffix}")

    return "\n".join([str(x) for x in lines if x is not None]).rstrip() + "\n"


def _total_moves_from_doc(doc: Dict[str, Any]) -> int:
    """Return total ply count for display (総手数).

    We count the stored move_history length and, for common end reasons,
    add one terminal record (投了/切れ負け/反則負け...) to match KIF numbering.
    """
    base = 0

    ml = doc.get("move_len")
    if isinstance(ml, int):
        base = max(0, int(ml))
    else:
        mh = doc.get("move_history")
        if isinstance(mh, list):
            base = len([m for m in mh if isinstance(m, dict)])

    reason = doc.get("finished_reason")
    if reason is None:
        reason = doc.get("reason")
    reason = str(reason or "")

    if base > 0 and reason in ("resign", "checkmate", "timeout", "illegal", "disconnect_timeout", "disconnect_four"):
        return base + 1
    return base


def _summary_from_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    players = doc.get("players") or {}
    sente = players.get("sente") or {}
    gote = players.get("gote") or {}

    def _safe_int(v: Any) -> Optional[int]:
        if v is None:
            return None
        # bool is a subclass of int in Python; avoid accidental 0/1.
        if isinstance(v, bool):
            return None
        try:
            s = str(v).strip()
            if s == "":
                return None
            return int(float(s))
        except Exception:
            return None

    # Try to use rating snapshot stored inside players.* (typically set at game creation time).
    # Fallback: post_game_updates_result.*.old_rating (best-effort for legacy docs).
    pgu = doc.get("post_game_updates_result") or {}
    pgu_s = (pgu.get("sente") or {}) if isinstance(pgu, dict) else {}
    pgu_g = (pgu.get("gote") or {}) if isinstance(pgu, dict) else {}
    sente_rating = _safe_int(sente.get("rating"))
    gote_rating = _safe_int(gote.get("rating"))
    if sente_rating is None:
        sente_rating = _safe_int(pgu_s.get("old_rating"))
    if gote_rating is None:
        gote_rating = _safe_int(pgu_g.get("old_rating"))

    created_at = doc.get("created_at") or doc.get("updated_at")
    updated_at = doc.get("updated_at") or doc.get("created_at")

    game_type = doc.get("game_type")
    if not isinstance(game_type, str) or not game_type:
        # Backward compat: old games didn't store game_type; treat as rating by default
        game_type = "rating"

    time_code = _infer_time_code(doc)
    total_moves = _total_moves_from_doc(doc)
    return {
        "id": _safe_id(doc.get("_id")),
        "created_at": _iso(created_at),
        "updated_at": _iso(updated_at),
        "players": {
            "sente": {
                "username": sente.get("username") or "",
                "user_id": _safe_id(sente.get("user_id") or ""),
                "rating": sente_rating,
            },
            "gote": {
                "username": gote.get("username") or "",
                "user_id": _safe_id(gote.get("user_id") or ""),
                "rating": gote_rating,
            },
        },
        "winner": doc.get("winner"),
        "reason": doc.get("finished_reason"),
        "game_type": game_type,
        "time_code": time_code,
        "time_display": _time_display(time_code),
        "total_moves": int(total_moves or 0),
    }


# ----------------------------
# API: search
# ----------------------------

@kifu_bp.route("/search", methods=["GET"])
@jwt_required()
def search_kifu():
    # Keep this endpoint fast even on large datasets.
    _ensure_indexes_best_effort()

    db = _get_db()
    games = _get_coll(db, "games")

    player1 = request.args.get("player1", "").strip()
    player2 = request.args.get("player2", "").strip()
    date_from = _parse_date_ymd(request.args.get("date_from"))
    date_to = _parse_date_ymd(request.args.get("date_to"))
    game_type = request.args.get("game_type")
    result = request.args.get("result")
    time_code = request.args.get("time_code")  # optional (new param)

    try:
        page = int(request.args.get("page", "1"))
    except Exception:
        page = 1
    try:
        per_page = int(request.args.get("per_page", "30"))
    except Exception:
        per_page = 30

    if page < 1:
        page = 1
    if per_page < 1:
        per_page = 30
    # hard cap
    if per_page > 50:
        per_page = 50

    q: Dict[str, Any] = {"status": "finished"}

    # players filter (username exact match)
    # NOTE: we intentionally avoid case-insensitive regex here because it can
    # force a full collection scan and lead to client timeouts.
    if player1 and player2:
        q["$or"] = [
            {"players.sente.username": player1, "players.gote.username": player2},
            {"players.sente.username": player2, "players.gote.username": player1},
        ]
    elif player1:
        q["$or"] = [{"players.sente.username": player1}, {"players.gote.username": player1}]
    elif player2:
        q["$or"] = [{"players.sente.username": player2}, {"players.gote.username": player2}]

    # date range (created_at)
    if date_from or date_to:
        dr: Dict[str, Any] = {}
        if date_from:
            dr["$gte"] = date_from
        if date_to:
            # inclusive end-date
            dr["$lt"] = date_to + timedelta(days=1)
        q["created_at"] = dr

    # game_type (rating/free). Old docs may not have it; treat missing as rating.
    if isinstance(game_type, str) and game_type in ("rating", "free"):
        if game_type == "free":
            q["game_type"] = "free"
        else:
            q["$and"] = q.get("$and", []) + [
                {"$or": [{"game_type": "rating"}, {"game_type": {"$exists": False}}, {"game_type": None}]}
            ]

    # result (winner role)
    if isinstance(result, str) and result in ("sente", "gote"):
        q["winner"] = result
    elif isinstance(result, str) and result == "draw":
        # winner='draw' の新データと、winner無しで finished_reason が引き分け系の旧データを両方拾う
        draw_reasons = ["draw", "sennichite", "jishogi_256", "nyugyoku_both", "nyugyoku_low_points_both"]
        q["$and"] = q.get("$and", []) + [
            {
                "$or": [
                    {"winner": "draw"},
                    {"winner": {"$exists": False}, "finished_reason": {"$in": draw_reasons}},
                    {"winner": None, "finished_reason": {"$in": draw_reasons}},
                ]
            }
        ]

    # time_code: filter by exact config match via precomputed config values
    if isinstance(time_code, str) and time_code:
        meta = (getattr(AppConfig, "TIME_CONTROLS", None) or {}).get(time_code)
        if isinstance(meta, dict):
            q["time_state.config.initial_ms"] = int(meta.get("initial_time") or 0) * 1000
            q["time_state.config.byoyomi_ms"] = int(meta.get("byoyomi_time") or 0) * 1000
            q["time_state.config.increment_ms"] = int(meta.get("increment") or 0) * 1000
            q["time_state.config.deferment_ms"] = int(meta.get("deferment_time") or 0) * 1000
    # projection (minimize payload)
    # NOTE: move_history can be very large. We compute its length on MongoDB side.
    proj = {
        "_id": 1,
        "created_at": 1,
        "updated_at": 1,
        "players": 1,
        "winner": 1,
        "finished_reason": 1,
        "game_type": 1,
        "time_code": 1,
        "time_state": 1,
        "status": 1,
        # computed
        "move_len": {"$size": {"$ifNull": ["$move_history", []]}},
    }

    skip = (page - 1) * per_page

    try:
        # Prefer aggregation for computed fields without transferring full arrays.
        pipeline = [
            {"$match": q},
            {"$sort": {"created_at": -1, "_id": -1}},
            {"$skip": skip},
            {"$limit": per_page + 1},
            {"$project": proj},
        ]
        docs_plus = list(games.aggregate(pipeline, maxTimeMS=8000))
    except Exception as e:
        # Fallback: old-style find (may transfer move_history).
        try:
            proj_fallback = {k: v for k, v in proj.items() if k != "move_len"}
            proj_fallback["move_history"] = 1
            cur = (
                games.find(q, proj_fallback)
                .sort([("created_at", -1), ("_id", -1)])
                .skip(skip)
                .limit(per_page + 1)
            )
            try:
                cur = cur.max_time_ms(8000)
            except Exception:
                pass
            docs_plus = list(cur)
        except Exception as e2:
            current_app.logger.exception("kifu.search failed: %s", e2)
            return jsonify({"success": False, "error_code": "kifu_search_failed", "message": "search_failed"}), 500

    has_more = len(docs_plus) > per_page
    docs = docs_plus[:per_page]
    items = [_summary_from_doc(d if isinstance(d, dict) else {}) for d in docs]

    return jsonify(
        {
            "success": True,
            "games": items,
            "page": page,
            "per_page": per_page,
            "has_more": has_more,
            "next_page": (page + 1) if has_more else None,
        }
    ), 200


# ----------------------------
# API: kifu detail
# ----------------------------

def _find_game_doc(game_id: str) -> Optional[Dict[str, Any]]:
    db = _get_db()
    games = _get_coll(db, "games")

    # Try string id first
    doc = None
    try:
        doc = games.find_one({"_id": game_id})
    except Exception:
        doc = None
    if doc:
        return doc

    # Fallback to ObjectId
    oid = _as_object_id_maybe(game_id)
    if oid is None:
        return None
    try:
        return games.find_one({"_id": oid})
    except Exception:
        return None


@kifu_bp.route("/<game_id>", methods=["GET"])
@jwt_required()
def get_kifu_detail(game_id: str):
    doc = _find_game_doc(game_id)
    if not doc:
        return jsonify({"success": False, "error_code": "kifu_not_found", "message": "not_found"}), 404

    moves = doc.get("move_history") or []
    moves = moves if isinstance(moves, list) else []

    summary = _summary_from_doc(doc if isinstance(doc, dict) else {})
    kif_text = _format_kif([m for m in moves if isinstance(m, dict)], header=summary)

    return jsonify(
        {
            "success": True,
            "kifu": {
                "game": summary,
                "kif_text": kif_text,
                "moves": moves,
            },
        }
    ), 200


# ----------------------------
# Legacy endpoint
# ----------------------------

@kifu_legacy_bp.route("/<game_id>/kifu", methods=["GET"])
@jwt_required()
def legacy_get_kifu(game_id: str):
    # Return the same payload as /api/kifu/<id>, but keep old path.
    return get_kifu_detail(game_id)