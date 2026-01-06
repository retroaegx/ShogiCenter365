#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MongoDB直叩きで指定ユーザー同士の対局ドキュメントを作る（デフォルト 15min）。

注意:
- これは「サーバーのマッチング処理を通さず」games / online_users を直接書き換える管理用スクリプト。
- JWT発行や認証はしない。クライアント側のログインは別。

最新仕様:
- 盤面は board 配列ではなく **SFEN(start_sfen/sfen) が正**。
- 指し手履歴は **move_history[].usi**（USI）を正として扱う。
- captured / base_board / board_state は保存しない。

使い方:
  pip install pymongo
  python mongo_start_match_bagaba2_vs_bagaba55_15min.py --uri mongodb://localhost:27017 --db shogi

例:
  python mongo_start_match_bagaba2_vs_bagaba55_15min.py --uri mongodb://localhost:27017 --db shogi --sente bagaba2 --gote bagaba55
"""

from __future__ import annotations

import argparse
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional, Dict

from pymongo import MongoClient
from bson import ObjectId


DEFAULT_START_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"


def _connect(uri: str, db_name: str):
    client = MongoClient(uri)
    return client[db_name]


def _find_user_by_username(users_coll, username: str) -> Optional[Dict[str, Any]]:
    return users_coll.find_one({"username": username})


def _as_oid(val: Any) -> Any:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return val
    return val


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--uri", default=None, help="MongoDB URI (env: MONGO_URI / MONGODB_URI)")
    p.add_argument("--db", default=None, help="DB名 (env: MONGO_DB / MONGODB_DB, default: shogi)")
    p.add_argument("--sente", default="bagaba2", help="先手ユーザー名（users.username）")
    p.add_argument("--gote", default="bagaba55", help="後手ユーザー名（users.username）")
    p.add_argument("--initial-minutes", type=int, default=15, help="持ち時間（分）。default: 15")
    p.add_argument("--byoyomi-seconds", type=int, default=0, help="秒読み（秒）。default: 0")
    p.add_argument("--increment-ms", type=int, default=0, help="加算（ms）。default: 0")
    p.add_argument("--deferment-ms", type=int, default=0, help="猶予（ms）。default: 0")
    p.add_argument("--start-sfen", default=None, help="開始局面SFEN（未指定なら平手startpos相当）")
    args = p.parse_args(argv)

    uri = args.uri or os.getenv("MONGO_URI") or os.getenv("MONGODB_URI")
    db_name = args.db or os.getenv("MONGO_DB") or os.getenv("MONGODB_DB") or "shogi"

    if not uri:
        raise SystemExit("MongoDB URI が必要: --uri か MONGO_URI / MONGODB_URI を設定してね")

    db = _connect(uri, db_name)

    users = db["users"]
    pres = db["online_users"]
    games = db["games"]

    s_user = _find_user_by_username(users, args.sente)
    g_user = _find_user_by_username(users, args.gote)

    if not s_user:
        raise SystemExit(f"users に先手ユーザーが見つからない: {args.sente}")
    if not g_user:
        raise SystemExit(f"users に後手ユーザーが見つからない: {args.gote}")

    now = datetime.now(timezone.utc)
    game_id = str(uuid.uuid4())

    start_sfen = (args.start_sfen or DEFAULT_START_SFEN).strip()
    sfen = start_sfen

    initial_ms = int(args.initial_minutes) * 60 * 1000
    byoyomi_ms = int(args.byoyomi_seconds) * 1000
    increment_ms = int(args.increment_ms)
    deferment_ms = int(args.deferment_ms)

    time_state = {
        "config": {
            "initial_ms": initial_ms,
            "byoyomi_ms": byoyomi_ms,
            "increment_ms": increment_ms,
            "deferment_ms": deferment_ms,
        },
        "sente": {
            "initial_ms": initial_ms,
            "byoyomi_ms": byoyomi_ms,
            "deferment_ms": deferment_ms,
        },
        "gote": {
            "initial_ms": initial_ms,
            "byoyomi_ms": byoyomi_ms,
            "deferment_ms": deferment_ms,
        },
        "base_at": int(now.timestamp() * 1000),
        "current_player": "sente",
    }

    game_doc = {
        "_id": game_id,
        "status": "active",
        "players": {
            "sente": {
                "user_id": str(s_user["_id"]),
                "username": s_user.get("username") or args.sente,
                "rating": int(s_user.get("rating") or 0),
            },
            "gote": {
                "user_id": str(g_user["_id"]),
                "username": g_user.get("username") or args.gote,
                "rating": int(g_user.get("rating") or 0),
            },
        },
        # Canonical position (SFEN + USI)
        "current_turn": "sente",  # convenience: derived from SFEN, but keep for existing UI
        "start_sfen": start_sfen,
        "sfen": sfen,
        "move_history": [],
        "spectators": [],
        "chat_messages": [],
        "time_state": time_state,
        "created_at": now,
        "updated_at": now,
    }

    # Insert game
    games.insert_one(game_doc)

    # Update presence
    s_oid = _as_oid(s_user["_id"])
    g_oid = _as_oid(g_user["_id"])

    pres.update_one(
        {"user_id": s_oid},
        {"$set": {
            "user_id": s_oid,
            "waiting": "playing",
            "waiting_info": {"game_id": game_id, "role": "sente"},
            "pending_offer": {},
            "last_seen_at": now,
            "username": s_user.get("username") or args.sente,
        }},
        upsert=True,
    )
    pres.update_one(
        {"user_id": g_oid},
        {"$set": {
            "user_id": g_oid,
            "waiting": "playing",
            "waiting_info": {"game_id": game_id, "role": "gote"},
            "pending_offer": {},
            "last_seen_at": now,
            "username": g_user.get("username") or args.gote,
        }},
        upsert=True,
    )

    print(game_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
