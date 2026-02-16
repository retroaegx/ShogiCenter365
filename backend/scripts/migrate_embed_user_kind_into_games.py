"""
既存のgamesドキュメントに players.sente / players.gote の user_kind / legion を埋め込むスクリプト。

- users.user_kind / users.is_guest / users.legion を参照して決定する。
- すでに user_kind が入っている場合は上書きしない（追記のみ）。
"""

import os
from typing import Dict, Any

from bson import ObjectId
from pymongo import MongoClient


MONGODB_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017/shogi")


def _user_snapshot(users_coll, uid: str) -> Dict[str, Any]:
    """ユーザーの kind / legion を取得する。"""
    try:
        try:
            oid = ObjectId(uid)
        except Exception:
            oid = uid
        u = users_coll.find_one(
            {"_id": oid},
            {"user_kind": 1, "is_guest": 1, "legion": 1},
        ) or {}
    except Exception:
        u = {}

    uk = u.get("user_kind")
    if isinstance(uk, str):
        uk = uk.strip()
    else:
        uk = ""
    if not uk:
        uk = "guest" if bool(u.get("is_guest")) else "human"

    legion = u.get("legion")
    if isinstance(legion, str):
        legion = legion.strip().upper()
    else:
        legion = ""
    if not legion:
        legion = "JP"

    return {"user_kind": uk, "legion": legion}


def main() -> None:
    client = MongoClient(MONGODB_URI)
    db = client.get_default_database()

    users = db["users"]
    games = db["games"]

    # 全件イテレート。件数が多い場合は必要に応じてクエリを絞る。
    cur = games.find(
        {},
        {
            "_id": 1,
            "players": 1,
        },
    )

    updated = 0
    total = 0

    for g in cur:
        total += 1
        players = g.get("players") or {}
        if not isinstance(players, dict):
            continue

        update_fields: Dict[str, Any] = {}

        for role in ("sente", "gote"):
            side = players.get(role) or {}
            if not isinstance(side, dict):
                continue
            uid = side.get("user_id")
            # すでに user_kind があればスキップ
            if side.get("user_kind") or not uid:
                continue

            snap = _user_snapshot(users, str(uid))
            if snap:
                update_fields.setdefault(f"players.{role}.user_kind", snap["user_kind"])
                update_fields.setdefault(f"players.{role}.legion", snap["legion"])

        if not update_fields:
            continue

        games.update_one({"_id": g["_id"]}, {"$set": update_fields})
        updated += 1

    print(f"done: updated={updated}, scanned={total}")


if __name__ == "__main__":
    main()
