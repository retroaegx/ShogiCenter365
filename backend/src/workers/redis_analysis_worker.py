# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import time
import threading
import logging
import datetime
from typing import Dict, Any, List, Optional

import requests

from src.services.analysis_queue import dequeue_game_id_blocking, try_enqueue_game_analysis

logger = logging.getLogger(__name__)

# 平手開始局面 SFEN
START_SFEN = os.getenv(
    "SHOGI_START_SFEN",
    "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
)


def _normalize_game_id(game_id: Any) -> str:
    """Return a canonical game id string.

    Canonical Socket.IO game rooms are named:  game:<game_id>
    If a room string is accidentally passed where a raw id is expected,
    double-prefixing can happen and emits will go to the wrong room.

    This helper makes the analysis worker tolerant of those mistakes.
    """
    s = str(game_id or "").strip()
    if not s:
        return ""
    if s.startswith("game:"):
        s = s.split("game:", 1)[1].strip()
    return s


def _json_safe(obj: Any) -> Any:
    """Best-effort convert a python object into JSON-serializable primitives.

    Socket.IO emits will crash on non-serializable types (e.g., datetime, ObjectId).
    This function makes emits resilient without changing DB storage.
    """
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj

    # datetime/date
    if isinstance(obj, (datetime.datetime, datetime.date)):
        try:
            return obj.isoformat()
        except Exception:
            return str(obj)

    # bytes
    if isinstance(obj, (bytes, bytearray)):
        try:
            return bytes(obj).decode("utf-8", errors="replace")
        except Exception:
            return str(obj)

    # bson ObjectId (optional)
    try:
        from bson import ObjectId  # type: ignore
        if isinstance(obj, ObjectId):
            return str(obj)
    except Exception:
        pass

    # dict / list / tuple / set
    if isinstance(obj, dict):
        out: Dict[str, Any] = {}
        for k, v in obj.items():
            out[str(k)] = _json_safe(v)
        return out

    if isinstance(obj, (list, tuple, set)):
        return [_json_safe(v) for v in list(obj)]

    # fallback
    return str(obj)


def _emit_analysis_update(
    game_service,
    *,
    game_id: str,
    status: str,
    progress: int,
    total: int,
    updates: Optional[List[Dict[str, Any]]] = None,
    error: Optional[str] = None,
    emit_game_update: bool = True,
    include_all_results: bool = True,
) -> None:
    """Emit analysis progress/results to all subscribers in the game room.

    - analysis_update : lightweight diff event (status/progress + per-move analysis)
    - game_update     : full game payload (optional; keeps existing FE in sync)
    """
    sio = getattr(game_service, "socketio", None)
    if sio is None:
        return
    gid = _normalize_game_id(game_id)
    if not gid:
        return
    room = f"game:{gid}"

    # Optional diagnostic log (helps catch wrong room names quickly)
    if str(os.getenv("ANALYSIS_LOG_EMIT", "")).strip().lower() in ("1", "true", "yes", "on"):
        try:
            logger.info(
                "analysis emit event=analysis_update game_id=%s room=%s status=%s progress=%s/%s updates=%s",
                str(game_id), room, status, progress, total, (len(updates) if updates is not None else None)
            )
        except Exception:
            pass

    payload: Dict[str, Any] = {
        "game_id": str(gid),
        "analysis_status": str(status),
        "analysis_progress": int(progress),
        "analysis_total": int(total),
    }
    # By default we keep the original "updates" behavior (delta per batch).
    # If you want the server to always send *all* results so far under the same key,
    # set ANALYSIS_UPDATES_MODE=full (default).
    raw_mode = str(os.getenv("ANALYSIS_UPDATES_MODE", "full")).strip().lower()
    updates_mode = raw_mode if raw_mode in ("full", "delta") else "full"
    if updates is not None and updates_mode == "delta":
        payload["updates"] = updates
    if error:
        payload["analysis_error"] = str(error)

    # Optionally include a full cumulative snapshot of analysis results so far.
    # This makes the client-side logic simple (replace state with what the server sends).
    raw_all = str(os.getenv("ANALYSIS_EMIT_ALL_RESULTS", "1")).strip().lower()
    want_all = include_all_results and raw_all not in ("0", "false", "no", "off")
    if want_all:
        try:
            proj = {
                "move_history": 1,
                "analysis_started_at": 1,
                "analysis_updated_at": 1,
                "analysis_done_at": 1,
            }
            doc = game_service.game_model.find_one({"_id": str(gid)}, proj)
            if doc:
                mh = doc.get("move_history") or []
                if not isinstance(mh, list):
                    mh = []
                all_results: List[Dict[str, Any]] = []
                # include analyses up to current progress
                up_to = max(0, int(progress))
                for idx, m in enumerate(mh[:up_to]):
                    if not isinstance(m, dict):
                        continue
                    a = m.get("analysis")
                    if a is None:
                        continue
                    all_results.append({"index": int(idx), "ply": int(idx + 1), "analysis": a})
                # If updates_mode=full, we publish the full snapshot under "updates"
                # to avoid requiring FE changes.
                if updates_mode == "full":
                    payload["updates"] = all_results
                    if updates is not None:
                        payload["delta_updates"] = updates
                else:
                    payload["all_results"] = all_results
                payload["analysis_started_at"] = doc.get("analysis_started_at")
                payload["analysis_updated_at"] = doc.get("analysis_updated_at")
                payload["analysis_done_at"] = doc.get("analysis_done_at")
        except Exception as e:
            logger.warning("collect all_results failed game=%s: %s", game_id, e, exc_info=True)

    # Make absolutely sure payload is JSON serializable.
    safe_payload = _json_safe(payload)
    try:
        sio.emit("analysis_update", safe_payload, room=room)
    except Exception as e:
        logger.warning("analysis_update emit failed game=%s: %s", game_id, e, exc_info=True)

    if emit_game_update:
        try:
            doc = game_service.game_model.find_one({"_id": str(gid)})
            if doc:
                sio.emit("game_update", _json_safe(game_service.as_api_payload(doc)), room=room)
        except Exception as e:
            logger.warning("game_update emit failed (from analysis) game=%s: %s", game_id, e, exc_info=True)



def _filter_analysis_result_for_mongo(result: Dict[str, Any], *, app=None) -> Dict[str, Any]:
    """Drop debug_* fields from analysis payload before writing to MongoDB.

    Control via env/config:
      - ANALYSIS_DB_DEBUG_LEVEL=off|basic|full  (default: off)
        * off   : remove all keys starting with "debug_"
        * basic : keep a small, helpful subset of debug_* keys
        * full  : keep all debug_* keys
      - ANALYSIS_DB_DEBUG=1 (compat): treated as full

    This only affects what we store in MongoDB; the engine server can still compute debug data.
    """
    level = None
    try:
        if app is not None:
            level = app.config.get("ANALYSIS_DB_DEBUG_LEVEL")
    except Exception:
        level = None

    raw = str(level or os.getenv("ANALYSIS_DB_DEBUG_LEVEL") or "").strip().lower()
    if not raw:
        # compat: simple boolean toggle
        raw = str(os.getenv("ANALYSIS_DB_DEBUG") or "").strip().lower()
        if raw in ("1", "true", "yes", "on"):
            raw = "full"
        elif raw in ("0", "false", "no", "off", ""):
            raw = "off"

    if not raw:
        raw = "full"

    if raw in ("full", "all", "verbose", "debug"):
        return result

    keep_basic = {
        "debug_position_cmd",
        "debug_go_cmd",
        "debug_expected_side",
        "debug_engine_side",
        "debug_effective_sfen",
        "debug_stderr_tail",
    }

    out: Dict[str, Any] = {}
    for k, v in (result or {}).items():
        if not str(k).startswith("debug_"):
            out[k] = v
            continue
        if raw in ("basic", "min", "minimal") and k in keep_basic:
            out[k] = v
    return out

_PIECE_TO_USI = {
    "pawn": "P",
    "lance": "L",
    "knight": "N",
    "silver": "S",
    "gold": "G",
    "bishop": "B",
    "rook": "R",
    "king": "K",
}


def _sq_usi(r: int, c: int) -> str:
    # internal: row 0..8 (top->bottom), col 0..8 (left->right)
    # USI: file 9..1, rank a..i (top->bottom)
    file_ = 9 - int(c)
    rank_ = chr(ord("a") + int(r))
    return f"{file_}{rank_}"


def _move_obj_to_usi(obj: Dict[str, Any]) -> Optional[str]:
    try:
        t = obj.get("type")
        if t == "move":
            fr = obj.get("from") or {}
            to = obj.get("to") or {}
            usi = _sq_usi(int(fr["r"]), int(fr["c"])) + _sq_usi(int(to["r"]), int(to["c"]))
            if obj.get("promote") is True:
                usi += "+"
            return usi
        if t == "drop":
            to = obj.get("to") or {}
            p = str(obj.get("piece") or "").lower()
            letter = _PIECE_TO_USI.get(p)
            if not letter:
                return None
            return f"{letter}*{_sq_usi(int(to['r']), int(to['c']))}"
    except Exception:
        return None
    return None


def _extract_usi_moves(move_history: List[Dict[str, Any]]) -> List[str]:
    moves: List[str] = []
    for m in move_history:
        if not isinstance(m, dict):
            continue

        # Canonical: already stored as USI string
        u = m.get("usi")
        if isinstance(u, str):
            u = u.strip()
            if u:
                moves.append(u)
                continue

        # Backward-compat: legacy stored obj
        obj = m.get("obj")
        if isinstance(obj, dict):
            u2 = obj.get("usi")
            if isinstance(u2, str):
                u2 = u2.strip()
                if u2:
                    moves.append(u2)
                    continue
            usi = _move_obj_to_usi(obj)
            if usi:
                moves.append(usi)
    return moves


def _post_analyze(url: str, *, sfen: str, moves: List[str], think_seconds: float, multipv: int, timeout_sec: int) -> Dict[str, Any]:
    payload = {
        "sfen": sfen,
        "moves": moves,
        "think_seconds": float(think_seconds),
        "multipv": int(multipv),
    }
    # engine server 起動直後は ECONNREFUSED になりやすいので、短時間だけリトライする
    retry_total_sec = float(os.getenv("ENGINE_HTTP_RETRY_TOTAL_SEC", "10"))
    start = time.time()
    attempt = 0
    while True:
        try:
            r = requests.post(url, json=payload, timeout=timeout_sec)
            if r.status_code >= 400:
                raise requests.exceptions.HTTPError(f"{r.status_code} {r.reason}: {r.text}", response=r)
            # OK

            return r.json()
        except requests.exceptions.ConnectionError as e:
            if (time.time() - start) >= retry_total_sec:
                raise
            attempt += 1
            # 0.2s -> 0.4s -> 0.8s ... (最大 2s)
            sleep_sec = min(0.2 * (2 ** (attempt - 1)), 2.0)
            time.sleep(sleep_sec)
            continue


def _process_one(app, game_service, game_id: str) -> None:
    with app.app_context():
        try:
            gid = _normalize_game_id(game_id)
            if not gid:
                return
            # queued -> running を原子的に
            now = None
            try:
                now = game_service._now()
            except Exception:
                now = None

            upd = {"$set": {"analysis_status": "running"}}
            if now is not None:
                upd["$set"]["analysis_started_at"] = now  # type: ignore[index]

            res = game_service.game_model.update_one({"_id": str(gid), "analysis_status": "queued"}, upd)
            if getattr(res, "modified_count", 0) <= 0:
                return

            doc = game_service.game_model.find_one({"_id": str(gid)})
            if not doc:
                return

            move_history = doc.get("move_history") or []
            if not isinstance(move_history, list):
                move_history = []

            usi_moves = _extract_usi_moves(move_history)

            # how often to publish updates (10 plies by default)
            try:
                emit_every_n = int(os.getenv("ANALYSIS_EMIT_EVERY_N", "10"))
            except Exception:
                emit_every_n = 10
            if emit_every_n <= 0:
                emit_every_n = 10

            # also send full game_update every batch by default (keeps existing FE in sync)
            raw_emit_game_update = str(os.getenv("ANALYSIS_EMIT_GAME_UPDATE", "1")).strip().lower()
            emit_game_update = raw_emit_game_update not in ("0", "false", "no", "off")

            total_plies = int(len(usi_moves))

            # store total once
            try:
                game_service.game_model.update_one({"_id": str(gid)}, {"$set": {"analysis_total": total_plies}})
            except Exception:
                pass

            # Canonical start position (can be non-hirate for handicap/tsume/etc.)
            start_sfen = str(doc.get("start_sfen") or START_SFEN)

            # progress (ply index)
            try:
                start_i = int(doc.get("analysis_progress") or 0)
            except Exception:
                start_i = 0
            if start_i < 0:
                start_i = 0

            # NOTE: We intentionally do NOT emit at progress=0.
            # Requirement: emit every N moves, or once at completion.
            # If you want an initial "running" ping, set ANALYSIS_EMIT_INITIAL_STATUS=1.
            raw_initial = str(os.getenv("ANALYSIS_EMIT_INITIAL_STATUS", "0")).strip().lower()
            emit_initial = raw_initial in ("1", "true", "yes", "on")
            if emit_initial and start_i > 0:
                _emit_analysis_update(
                    game_service,
                    game_id=str(gid),
                    status="running",
                    progress=int(start_i),
                    total=total_plies,
                    updates=None,
                    emit_game_update=emit_game_update,
                )

            engine_url = app.config.get("ENGINE_SERVER_URL") or os.getenv("ENGINE_SERVER_URL") or "http://127.0.0.1:5002/analyze"
            think_seconds = float(app.config.get("ENGINE_THINK_SECONDS") or os.getenv("ENGINE_THINK_SECONDS") or 1.0)
            multipv = int(app.config.get("ENGINE_MULTIPV") or os.getenv("ENGINE_MULTIPV") or 1)
            timeout_sec = int(app.config.get("ENGINE_HTTP_TIMEOUT_SEC") or os.getenv("ENGINE_HTTP_TIMEOUT_SEC") or 30)

            # 1手ずつ直列に解析して保存
            batch_updates: List[Dict[str, Any]] = []
            last_emitted_progress: Optional[int] = None
            for i in range(start_i, len(usi_moves)):
                try:
                    result = _post_analyze(
                        engine_url,
                        sfen=start_sfen,
                        moves=usi_moves[: i + 1],
                        think_seconds=think_seconds,
                        multipv=multipv,
                        timeout_sec=timeout_sec,
                    )
                except Exception as e:
                    logger.warning("analysis http failed game=%s ply=%s: %s", gid, i + 1, e, exc_info=True)
                    game_service.game_model.update_one(
                        {"_id": str(gid)},
                        {"$set": {"analysis_status": "error", "analysis_error": str(e), "analysis_progress": i}},
                    )
                    # publish error to subscribers
                    try:
                        _emit_analysis_update(
                            game_service,
                            game_id=str(gid),
                            status="error",
                            progress=int(i),
                            total=total_plies,
                            updates=None,
                            error=str(e),
                            emit_game_update=emit_game_update,
                        )
                    except Exception:
                        pass
                    return

                # move_history.{i}.analysis に格納
                now2 = None
                try:
                    now2 = game_service._now()
                except Exception:
                    now2 = None

                filtered = _filter_analysis_result_for_mongo(result, app=app)
                set_doc = {
                    f"move_history.{i}.analysis": filtered,
                    "analysis_progress": i + 1,
                }
                if now2 is not None:
                    set_doc["analysis_updated_at"] = now2
                game_service.game_model.update_one({"_id": str(gid)}, {"$set": set_doc})
                

                # queue publish every N moves (or at end)
                batch_updates.append({"index": int(i), "ply": int(i + 1), "analysis": filtered})
                is_boundary = ((i + 1) % emit_every_n == 0) or (i + 1 == total_plies)
                if is_boundary:
                    _emit_analysis_update(
                        game_service,
                        game_id=str(gid),
                        status="running" if (i + 1) < total_plies else "done",
                        progress=int(i + 1),
                        total=total_plies,
                        updates=batch_updates,
                        emit_game_update=emit_game_update,
                    )
                    last_emitted_progress = int(i + 1)
                    batch_updates = []

            # 完了
            done = {"analysis_status": "done"}
            now3 = None
            try:
                now3 = game_service._now()
            except Exception:
                now3 = None
            if now3 is not None:
                done["analysis_done_at"] = now3
            game_service.game_model.update_one({"_id": str(gid)}, {"$set": done})

            # publish final state (DB is now 'done')
            # Ensure at least one 'done' emit is sent (even for < N moves).
            if last_emitted_progress != int(total_plies):
                _emit_analysis_update(
                    game_service,
                    game_id=str(gid),
                    status="done",
                    progress=int(total_plies),
                    total=int(total_plies),
                    updates=(batch_updates if batch_updates else []),
                    emit_game_update=emit_game_update,
                )

        except Exception as e:
            gid2 = _normalize_game_id(game_id)
            logger.warning("analysis worker crashed for game=%s: %s", (gid2 or game_id), e, exc_info=True)
            try:
                if gid2:
                    game_service.game_model.update_one({"_id": str(gid2)}, {"$set": {"analysis_status": "error", "analysis_error": str(e)}})
            except Exception:
                pass
            try:
                # best-effort publish crash
                if gid2:
                    _emit_analysis_update(
                        game_service,
                        game_id=str(gid2),
                        status="error",
                        progress=int(0),
                        total=int(0),
                        updates=None,
                        error=str(e),
                        emit_game_update=True,
                    )
            except Exception:
                pass


def start_redis_analysis_worker(app, game_service, *, redis_url: Optional[str] = None) -> None:
    """解析ジョブのワーカーを1本起動する（全対局で直列）。"""
    if getattr(app, "_analysis_worker_started", False):
        return
    app._analysis_worker_started = True  # type: ignore[attr-defined]

    rurl = redis_url or app.config.get("REDIS_URL") or os.getenv("REDIS_URL")

    def _loop():
        logger.info("analysis worker started (queue=%s)", os.getenv("ANALYSIS_QUEUE_KEY", "shogi:analysis_queue"))
        while True:
            gid = None
            try:
                gid = dequeue_game_id_blocking(redis_url=rurl, timeout_sec=5)
            except Exception:
                gid = None
            if not gid:
                time.sleep(0.1)
                continue
            _process_one(app, game_service, gid)

    th = threading.Thread(target=_loop, daemon=True, name="RedisAnalysisWorker")
    th.start()