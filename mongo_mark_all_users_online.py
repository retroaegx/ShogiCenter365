#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MongoDB直叩きで「全ユーザーをロビーに居る(online_usersに居る)」状態にする。

注意:
- このスクリプトはJWTを発行しないので、"ログイン"(認証)そのものにはならない。
  このプロジェクトはFlask-JWT-ExtendedのステートレスJWTなので、DBにセッションを書くだけではログインできない。
- やるのは online_users コレクションの upsert（presenceの種まき）だけ。

使い方:
  pip install pymongo
  python mongo_mark_all_users_online.py --uri mongodb://localhost:27017 --db shogi

環境変数でも可:
  MONGO_URI / MONGODB_URI
  MONGO_DB  / MONGODB_DB
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from typing import Optional


def _connect(uri: str, db_name: str):
    from pymongo import MongoClient
    client = MongoClient(uri)
    return client.get_database(db_name)


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--uri', default=None, help='MongoDB URI (env: MONGO_URI / MONGODB_URI)')
    p.add_argument('--db', default=None, help='DB名 (env: MONGO_DB / MONGODB_DB, default: shogi)')
    p.add_argument('--waiting', default='lobby', choices=['lobby', 'seeking', 'applying', 'playing', 'review'], help='waiting状態')
    p.add_argument('--limit', type=int, default=0, help='対象ユーザー数上限（0で無制限）')
    args = p.parse_args(argv)

    import os

    uri = args.uri or os.getenv('MONGO_URI') or os.getenv('MONGODB_URI')
    db_name = args.db or os.getenv('MONGO_DB') or os.getenv('MONGODB_DB') or 'shogi'

    if not uri:
        raise SystemExit('MongoDB URI が必要: --uri か MONGO_URI / MONGODB_URI を設定してね')

    db = _connect(uri, db_name)

    users = db['users']
    pres = db['online_users']

    now = datetime.now(timezone.utc)

    cursor = users.find({}, {'_id': 1, 'username': 1})
    if args.limit and args.limit > 0:
        cursor = cursor.limit(args.limit)

    n = 0
    for u in cursor:
        uid = u.get('_id')
        if uid is None:
            continue
        # presence TTL は last_seen_at に Date 型が必要
        pres.update_one(
            {'user_id': uid},
            {'$set': {
                'user_id': uid,
                'waiting': args.waiting,
                'waiting_info': {},
                'pending_offer': {},
                'last_seen_at': now,
                # 任意。offer_accept が参照するので入れておくと安全。
                'username': u.get('username') or '',
            }},
            upsert=True,
        )
        n += 1

    print(f'updated online_users: {n} users -> waiting={args.waiting}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
