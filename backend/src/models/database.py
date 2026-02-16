import os
import uuid
from datetime import datetime
from typing import Dict, Optional, Any

try:
    from pymongo import MongoClient
except Exception:
    MongoClient = None

class _MemoryCollection:
    def __init__(self, backing: Dict):
        self._b = backing

    def insert_one(self, doc: Dict):
        _id = doc.get('_id') or str(uuid.uuid4())
        doc['_id'] = _id
        if _id in self._b:
            # emulate MongoDB duplicate key error
            raise Exception('duplicate key')
        self._b[_id] = doc
        return {'inserted_id': _id}

    def find_one(self, query: Dict):
        if not query:
            return None
        if '_id' in query:
            return self._b.get(query['_id'])
        for v in self._b.values():
            ok = True
            for k, val in query.items():
                if v.get(k) != val:
                    ok = False
                    break
            if ok:
                return v
        return None

    def update_one(self, query: Dict, update: Dict, upsert: bool=False):
        target = self.find_one(query)
        if not target:
            if upsert:
                doc = {}
                if '$set' in update:
                    doc.update(update['$set'])
                if '_id' in query:
                    doc['_id'] = query['_id']
                self.insert_one(doc)
                return {'matched_count': 1, 'modified_count': 1, 'upserted': True}
            return {'matched_count': 0, 'modified_count': 0}
        if '$set' in update:
            for k, v in update['$set'].items():
                target[k] = v
        return {'matched_count': 1, 'modified_count': 1}

    def delete_one(self, query: Dict):
        target = self.find_one(query)
        if not target:
            return {'deleted_count': 0}
        del self._b[target['_id']]
        return {'deleted_count': 1}

class _MemoryDB:
    def __init__(self):
        self._store = {
            'games': {},
            'users': {},
            'blog_posts': {},
            'post_game_updates': {},
            'warning_words': {},
            'warning_templates': {},
        }
        self.games = _MemoryCollection(self._store['games'])
        self.users = _MemoryCollection(self._store['users'])
        self.blog_posts = _MemoryCollection(self._store['blog_posts'])
        self.post_game_updates = _MemoryCollection(self._store['post_game_updates'])
        self.warning_words = _MemoryCollection(self._store['warning_words'])
        self.warning_templates = _MemoryCollection(self._store['warning_templates'])

class DatabaseManager:
    """アプリ全体で使うDBハンドル。
    - 本番: MongoDB に接続し .db と各コレクションを提供
    - フォールバック: メモリDB（Mongo風の最小API）
    このクラスは main.py の「DatabaseManager.db が初期化されていること」を満たす。
    """
    def __init__(self, mongo_uri: Optional[str] = None, db_name: Optional[str] = None, use_memory_fallback: bool = True):
        self.client = None
        self.db = None
        self.games = None
        self.users = None
        self.use_mongodb = False
        self.warning_words = None
        self.warning_templates = None

        uri = mongo_uri or os.getenv('MONGO_URI') or os.getenv('MONGODB_URI')
        name = db_name or os.getenv('MONGO_DB') or os.getenv('MONGODB_DB') or 'shogi'

        if MongoClient and uri:
            try:
                self.client = MongoClient(uri, serverSelectionTimeoutMS=4000)
                self.client.admin.command('ping')
                self.db = self.client.get_database(name)
                self.games = self.db.get_collection('games')
                self.users = self.db.get_collection('users')
                self.blog_posts = self.db.get_collection('blog_posts')
                self.post_game_updates = self.db.get_collection('post_game_updates')
                self.warning_words = self.db.get_collection('warning_words')
                self.warning_templates = self.db.get_collection('warning_templates')
                try:
                    self.blog_posts.create_index([('created_at', -1)])
                except Exception:
                    pass
                try:
                    self.warning_words.create_index([('word_lc', 1)], unique=True)
                except Exception:
                    pass
                try:
                    self.warning_templates.create_index([('message_lc', 1)], unique=True)
                except Exception:
                    pass
                # Guest account TTL (documents with expiresAt will be auto-deleted by MongoDB)
                try:
                    self.users.create_index([('expiresAt', 1)], expireAfterSeconds=0, name='expiresAt_ttl')
                except Exception:
                    pass
                self.use_mongodb = True
            except Exception:
                # フォールバック
                mem = _MemoryDB()
                self.db = mem
                self.games = mem.games
                self.users = mem.users
                self.blog_posts = mem.blog_posts
                self.post_game_updates = mem.post_game_updates
                self.warning_words = mem.warning_words
                self.warning_templates = mem.warning_templates
                self.use_mongodb = False
        else:
            mem = _MemoryDB()
            self.db = mem
            self.games = mem.games
            self.users = mem.users
            self.blog_posts = mem.blog_posts
            self.post_game_updates = mem.post_game_updates
            self.warning_words = mem.warning_words
            self.warning_templates = mem.warning_templates
            self.use_mongodb = False


    def get_blog_posts_collection(self):
        """ブログ記事コレクション（Mongo / Memory 共通）"""
        return self.blog_posts

    def get_game_model(self):
        return GameModel(self)

    def get_user_model(self):
        """routes/kifu などが期待している UserModel を返す。"""
        return UserModel(self)

class GameModel:
    """ゲームモデル（GameService と整合するスキーマで作成・取得）"""
    def __init__(self, db_manager: DatabaseManager):
        self.dbm = db_manager

    async def create_game(self, game_data: Dict) -> str:
        game_id = game_data.get('_id') or str(uuid.uuid4())
        game_data['_id'] = game_id

        now = datetime.utcnow()
        # Ensure timestamps exist for search_kifu (created_at range filter)
        game_data.setdefault('created_at', now)
        game_data.setdefault('updated_at', now)

        # ---- Canonical schema (SFEN + USI) ----
        # - Current position is stored as SFEN.
        # - Move history is stored as USI.
        # - No board arrays / no captured arrays are persisted.
        game_data.setdefault('status', 'ongoing')
        game_data.setdefault('players', {'sente': {}, 'gote': {}})

        # Attach user_kind / legion snapshot for players so that rating/guest logic
        # can rely on game documents without extra username lookups.
        try:
            players = game_data.get('players') or {}
            if not isinstance(players, dict):
                players = {}
            users_coll = getattr(self.dbm, 'users', None)

            def _fill_role(role: str):
                side = players.get(role) or {}
                uid = side.get('user_id')
                if not uid or users_coll is None:
                    players[role] = side
                    return
                try:
                    from bson import ObjectId as _OID
                    try:
                        qid = _OID(uid)
                    except Exception:
                        qid = uid
                    u = users_coll.find_one({'_id': qid}, {'user_kind': 1, 'is_guest': 1, 'legion': 1}) or {}
                except Exception:
                    u = {}
                uk = u.get('user_kind')
                if isinstance(uk, str):
                    uk = uk.strip()
                else:
                    uk = ''
                if not uk:
                    uk = 'guest' if bool(u.get('is_guest')) else 'human'
                legion = u.get('legion')
                if isinstance(legion, str):
                    legion = legion.strip().upper()
                else:
                    legion = None
                if not legion:
                    legion = 'JP'
                side.setdefault('user_kind', uk)
                side.setdefault('legion', legion)
                players[role] = side

            _fill_role('sente')
            _fill_role('gote')
            game_data['players'] = players
        except Exception:
            # best-effort only; game creation itself must not fail due to snapshot issues.
            pass

        game_data.setdefault('move_history', [])

        DEFAULT_START_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
        start_sfen = game_data.get('start_sfen') or DEFAULT_START_SFEN
        sfen = game_data.get('sfen') or start_sfen
        game_data['start_sfen'] = start_sfen
        game_data['sfen'] = sfen

        # Remove legacy / redundant fields if present
        for k in ['board_state', 'board', 'captured', 'kifu', 'move_count', 'sente_time_left', 'gote_time_left',
                  'last_move_at', 'winner', 'loser', 'draw_reason']:
            if k in game_data:
                del game_data[k]

        self.dbm.games.insert_one(game_data)
        return game_id
    async def get_game_by_id(self, game_id: str) -> Optional[Dict]:
        return self.dbm.games.find_one({'_id': game_id})

class UserModel:
    """ユーザー用の最小モデル。
    既存の routes/kifu.py などが呼ぶであろうメソッドを提供する。
    必要最小限: get_user_by_id / get_user_by_username / upsert_user
    """
    def __init__(self, db_manager: DatabaseManager):
        self.dbm = db_manager

    def get_user_by_id(self, user_id: Any) -> Optional[Dict]:
        return self.dbm.users.find_one({'_id': user_id})

    def get_user_by_username(self, username: str) -> Optional[Dict]:
        return self.dbm.users.find_one({'username': username})

    def upsert_user(self, user: Dict) -> str:
        _id = user.get('_id') or str(uuid.uuid4())
        user['_id'] = _id
        self.dbm.users.update_one({'_id': _id}, {'$set': user}, upsert=True)
        return _id