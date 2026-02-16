# -*- coding: utf-8 -*-
"""Add users.user_kind field for existing users.

Usage:
  python backend/scripts/migrate_add_user_kind.py

Env:
  MONGODB_URI: MongoDB connection string (defaults to config.py's default)

Behavior:
  - If user_kind is missing: set to 'guest' when is_guest is true, else 'human'
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
            {'user_kind': {'$exists': False}},
            {'user_kind': None},
            {'user_kind': ''},
        ]
    }

    # Guests first
    r1 = col.update_many(
        {**q_missing, 'is_guest': True},
        {'$set': {'user_kind': 'guest'}}
    )

    # Everyone else
    r2 = col.update_many(
        q_missing,
        {'$set': {'user_kind': 'human'}}
    )

    print('migrate_add_user_kind')
    print(f"guest set: {getattr(r1, 'modified_count', 0)}")
    print(f"human set: {getattr(r2, 'modified_count', 0)}")


if __name__ == '__main__':
    main()
