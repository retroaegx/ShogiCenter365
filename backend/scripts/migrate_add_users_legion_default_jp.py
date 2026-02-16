# -*- coding: utf-8 -*-
"""Add users.legion field for existing users (default JP).

Usage:
  python backend/scripts/migrate_add_users_legion_default_jp.py

Env:
  MONGODB_URI: MongoDB connection string (defaults to mongodb://localhost:27017/shogi)

Behavior:
  - If legion is missing/empty: set to 'JP'
"""

import os
from urllib.parse import urlparse

from pymongo import MongoClient


DEFAULT_URI = os.environ.get('MONGODB_URI') or 'mongodb://localhost:27017/shogi'


def _get_db(uri: str):
    client = MongoClient(uri)
    parsed = urlparse(uri)
    db_name = (parsed.path or '').lstrip('/') or 'shogi'
    return client[db_name]


def main():
    uri = DEFAULT_URI
    db = _get_db(uri)
    col = db['users']

    q_missing = {
        '$or': [
            {'legion': {'$exists': False}},
            {'legion': None},
            {'legion': ''},
        ]
    }

    r = col.update_many(q_missing, {'$set': {'legion': 'JP'}})

    print('migrate_add_users_legion_default_jp')
    print(f"updated: {getattr(r, 'modified_count', 0)}")


if __name__ == '__main__':
    main()
