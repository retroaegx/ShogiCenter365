import os
from datetime import timedelta
from urllib.parse import urlparse

class Config:
    LOBBY_TOUCH_INTERVAL_SECONDS = int(os.environ.get('LOBBY_TOUCH_INTERVAL_SECONDS', '300'))  # touchの更新判定間隔（秒）
    ONLINE_USERS_TTL_SECONDS = int(os.environ.get('ONLINE_USERS_TTL_SECONDS', '1800'))  # online_users TTL（秒）
    """基本設定クラス"""
    
    # Flask設定
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-secret-key-change-in-production'
    
    # JWT設定
    JWT_SECRET_KEY = os.environ.get('JWT_SECRET_KEY') or SECRET_KEY
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=30)  # JWTの有効期限（デフォルト30分）
    JWT_REFRESH_TOKEN_EXPIRES = timedelta(days=30)# MongoDB設定（URIに統一。DB名はURIから導出・後方互換用）
    MONGODB_URI = os.environ.get('MONGODB_URI') or 'mongodb://localhost:27017/shogi_site'
    _parsed = urlparse(MONGODB_URI)
    MONGODB_DB_NAME = (_parsed.path.lstrip('/') or 'shogi_site')
    
    # CORS設定
    _cors_origins_raw = os.environ.get('CORS_ORIGINS', '*')
    if _cors_origins_raw.strip() in ('', '*'):
        CORS_ORIGINS = ['*']
    else:
        CORS_ORIGINS = [o.strip() for o in _cors_origins_raw.split(',') if o.strip()]
    
# SocketIO設定
    SOCKETIO_CORS_ALLOWED_ORIGINS = '*' if (CORS_ORIGINS == ['*'] or CORS_ORIGINS == ['']) else CORS_ORIGINS
    SOCKETIO_ASYNC_MODE = os.environ.get('SOCKETIO_ASYNC_MODE') or None
    REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

    # レーティング設定
    INITIAL_RATING = int(os.environ.get('INITIAL_RATING', '1500'))
    RATING_K_FACTOR = int(os.environ.get('RATING_K_FACTOR', '32'))
    
    # ゲーム設定
    MAX_GAME_TIME = int(os.environ.get('MAX_GAME_TIME', '7200'))  # 2時間
    BYOYOMI_GRACE_PERIOD = int(os.environ.get('BYOYOMI_GRACE_PERIOD', '3'))  # 3秒
    
    # セキュリティ設定
    PEPPER = os.getenv("PEPPER", "supersecretpepper")
    
    # ログ設定
    LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')
    LOG_FILE = os.environ.get('LOG_FILE', 'shogi_site.log')
    
    # パフォーマンス設定
    MAX_CONTENT_LENGTH = int(os.environ.get('MAX_CONTENT_LENGTH', '1048576'))  # 1MB
    
    # レート制限設定
    RATELIMIT_STORAGE_URL = os.environ.get('RATELIMIT_STORAGE_URL', 'memory://')
    RATELIMIT_DEFAULT = os.environ.get('RATELIMIT_DEFAULT', '100 per hour')

    # SMTP設定 (メール検証用)
    SMTP_SENDER_EMAIL = os.getenv("SMTP_SENDER_EMAIL")
    SMTP_SENDER_PASSWORD = os.getenv("SMTP_SENDER_PASSWORD")
    SMTP_SERVER = os.getenv("SMTP_SERVER")
    SMTP_PORT = os.getenv("SMTP_PORT", 587)
    REQUIRE_EMAIL_VERIFICATION = (os.environ.get('REQUIRE_EMAIL_VERIFICATION', 'true').lower() in ('1','true','yes','on'))


    # フロントエンドURL
    FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")


class DevelopmentConfig(Config):
    """開発環境設定"""
    DEBUG = False
    TESTING = False

    # 開発用のより緩い設定
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=24)

    # 開発用CORS設定（5173/5000/3000 を明示許可）
    CORS_ORIGINS = [
        'http://localhost:5173', 'http://127.0.0.1:5173', 'http://192.168.0.13:5173',
        'http://localhost:5000', 'http://127.0.0.1:5000', 'http://192.168.0.13:5000',
        'http://localhost:3000', 'http://127.0.0.1:3000'
    ]
    SOCKETIO_CORS_ALLOWED_ORIGINS = CORS_ORIGINS
    
class TestingConfig(Config):
    """テスト環境設定"""
    TESTING = False
    DEBUG = False
    
    # テスト用データベース
    MONGODB_DB_NAME = 'shogi_site_test'
    
    # テスト用の高速設定
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=15)
    
    # テスト用の制限緩和
    RATELIMIT_DEFAULT = '1000 per hour'


class ProductionConfig(Config):
    """本番環境設定"""
    DEBUG = False
    TESTING = False
    
    # 本番用CORS設定（環境変数から取得）
    CORS_ORIGINS = os.environ.get('CORS_ORIGINS', '').split(',')
    
    # 本番用ログ設定
    LOG_LEVEL = 'WARNING'
    
    # 本番用レート制限
    RATELIMIT_DEFAULT = '60 per hour'


# 環境に応じた設定の選択
config = {
    'development': DevelopmentConfig,
    'testing': TestingConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig
}

def get_config():
    """現在の環境に応じた設定を取得"""
    env = os.environ.get('FLASK_ENV', 'development')
    return config.get(env, config['default'])


# ログ設定
LOGGING_CONFIG = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'default': {
            'format': '[%(asctime)s] %(levelname)s in %(module)s: %(message)s',
        },
        'detailed': {
            'format': '[%(asctime)s] %(levelname)s in %(module)s [%(pathname)s:%(lineno)d]: %(message)s',
        }
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'level': 'INFO',
            'formatter': 'default',
            'stream': 'ext://sys.stdout'
        },
        'file': {
            'class': 'logging.FileHandler',
            'level': 'INFO',
            'formatter': 'detailed',
            'filename': 'shogi_site.log',
            'mode': 'a'
        }
    },
    'loggers': {
        '': {
            'level': 'INFO',
            'handlers': ['console', 'file']
        },
        'werkzeug': {
            'level': 'WARNING'
        },
        'socketio': {
            'level': 'WARNING'
        }
    }
}

# ---- 将棋の持ち時間プリセット（ロビーとタイマーが参照） ----
# フロント/APIで使うキー: '1min','3min','5min','10min','15min','30min'
# 値は JSON 直列化可能な辞書。time_service は 'initial_time' と 'byoyomi_time' を参照します。

# ============================================================
# 将棋倶楽部24 風の持ち時間プリセット
# 参考: 早指/早指2/早指3/15分/長考（公式ページの説明に準拠）
# 備考: 本システムの time_service は 'initial_time' と 'byoyomi_time' を参照します。
#       'increment' は今は未使用ですが将来の拡張のため定義してあります。
#       早指2の「猶予1分 + 30秒秒読み」は厳密には
#       「最初から30秒/手、超過分を猶予1分から消費」ですが、
#       現実装では initial_time=60, byoyomi_time=30 の近似で扱います。

# ============================================================
# 将棋倶楽部24 風の持ち時間プリセット
# 参考: 早指/早指2/早指3/15分/長考（公式ページの説明に準拠）
# 備考: 本システムの time_service は 'initial_time' と 'byoyomi_time' を参照します。
#       'increment' は今は未使用ですが将来の拡張のため定義してあります。
#       早指2の「猶予1分 + 30秒秒読み」は厳密には
#       「最初から30秒/手、超過分を猶予1分から消費」ですが、
#       現実装では initial_time=60, byoyomi_time=30 の近似で扱います。
TIME_CONTROLS = {
    'hayasashi': {
        'name': '早指',
        'display': '早指（1分 + 30秒）',
        'labels': {
            'ja': {'name': '早指', 'display': '早指（1分 + 30秒）'},
            'en': {'name': 'Quick', 'display': 'Quick (1 min + 30 sec)'},
            'zh': {'name': '快棋', 'display': '快棋（1分钟 + 30秒）'},
            'fr': {'name': 'Rapide', 'display': 'Rapide (1 min + 30 s)'},
            'de': {'name': 'Schnell', 'display': 'Schnell (1 Min + 30 Sek)'},
            'pl': {'name': 'Szybka', 'display': 'Szybka (1 min + 30 s)'},
            'it': {'name': 'Veloce', 'display': 'Veloce (1 min + 30 s)'},
            'pt': {'name': 'Rápido', 'display': 'Rápido (1 min + 30 s)'},
        },
        'initial_time': 60,
        'byoyomi_time': 30,
        'increment': 0,
        'deferment_time': 0
    },
    'hayasashi2': {
        'name': '早指2',
        'display': '早指2（30秒秒読み + 秒読み後の猶予1分）',
        'labels': {
            'ja': {'name': '早指2', 'display': '早指2（30秒秒読み + 秒読み後の猶予1分）'},
            'en': {'name': 'Quick 2', 'display': 'Quick 2 (30 sec byoyomi + 1 min grace after byoyomi)'},
            'zh': {'name': '快棋2', 'display': '快棋2（30秒读秒 + 读秒后的1分钟宽限）'},
            'fr': {'name': 'Rapide 2', 'display': 'Rapide 2 (byoyomi 30 s + 1 min de grâce après le byoyomi)'},
            'de': {'name': 'Schnell 2', 'display': 'Schnell 2 (Byoyomi 30 Sek + 1 Min Kulanz nach Byoyomi)'},
            'pl': {'name': 'Szybka 2', 'display': 'Szybka 2 (byoyomi 30 s + 1 min zapasu po byoyomi)'},
            'it': {'name': 'Veloce 2', 'display': 'Veloce 2 (byoyomi 30 s + 1 min di tolleranza dopo il byoyomi)'},
            'pt': {'name': 'Rápido 2', 'display': 'Rápido 2 (byoyomi 30 s + 1 min de tolerância após o byoyomi)'},
        },
        'initial_time': 0,
        'byoyomi_time': 30,
        'increment': 0,
        'deferment_time': 60
    },
    'hayasashi3': {
        'name': '早指3',
        'display': '早指3（5分 + フィッシャー5秒）',
        'labels': {
            'ja': {'name': '早指3', 'display': '早指3（5分 + フィッシャー5秒）'},
            'en': {'name': 'Quick 3', 'display': 'Quick 3 (5 min + Fisher 5 sec)'},
            'zh': {'name': '快棋3', 'display': '快棋3（5分钟 + Fischer 5秒）'},
            'fr': {'name': 'Rapide 3', 'display': 'Rapide 3 (5 min + Fischer 5 s)'},
            'de': {'name': 'Schnell 3', 'display': 'Schnell 3 (5 Min + Fischer 5 Sek)'},
            'pl': {'name': 'Szybka 3', 'display': 'Szybka 3 (5 min + Fischer 5 s)'},
            'it': {'name': 'Veloce 3', 'display': 'Veloce 3 (5 min + Fischer 5 s)'},
            'pt': {'name': 'Rápido 3', 'display': 'Rápido 3 (5 min + Fischer 5 s)'},
        },
        'initial_time': 300,
        'byoyomi_time': 0,
        'increment': 5,
        'deferment_time': 0
    },
    '15min': {
        'name': '15分',
        'display': '15分 + 60秒',
        'labels': {
            'ja': {'name': '15分', 'display': '15分 + 60秒'},
            'en': {'name': '15 min', 'display': '15 min + 60 sec'},
            'zh': {'name': '15分钟', 'display': '15分钟 + 60秒'},
            'fr': {'name': '15 min', 'display': '15 min + 60 s'},
            'de': {'name': '15 Min', 'display': '15 Min + 60 Sek'},
            'pl': {'name': '15 min', 'display': '15 min + 60 s'},
            'it': {'name': '15 min', 'display': '15 min + 60 s'},
            'pt': {'name': '15 min', 'display': '15 min + 60 s'},
        },
        'initial_time': 900,
        'byoyomi_time': 60,
        'increment': 0,
        'deferment_time': 0
    },
    '30min': {
        'name': '長考',
        'display': '30分 + 60秒',
        'labels': {
            'ja': {'name': '長考', 'display': '30分 + 60秒'},
            'en': {'name': 'Long', 'display': '30 min + 60 sec'},
            'zh': {'name': '长考', 'display': '30分钟 + 60秒'},
            'fr': {'name': 'Long', 'display': '30 min + 60 s'},
            'de': {'name': 'Lang', 'display': '30 Min + 60 Sek'},
            'pl': {'name': 'Długa', 'display': '30 min + 60 s'},
            'it': {'name': 'Lungo', 'display': '30 min + 60 s'},
            'pt': {'name': 'Longo', 'display': '30 min + 60 s'},
        },
        'initial_time': 1800,
        'byoyomi_time': 60,
        'increment': 0,
        'deferment_time': 0
    }
}

# ------------------------------------------------------------
# 将棋倶楽部24 風のルール設定（参照用の定数・既存コード未使用なら無害）
REPETITION_RULE = 'JSA_4FOLD'
PERPETUAL_CHECK_LOSS = True
JISHOGI_DECLARATION = 'DECL_24_POINT'
# ============================================================


# ------------------------------------------------------------
# 将棋倶楽部24 風のルール設定（参照用の定数・既存コード未使用なら無害）

# ---- レーティング設定（複数システム対応；既定は sc24） ----
RATING_SYSTEMS = {
    "sc24": {
        "name": "Shogi Club 24",
        "initial_rating": 0,
        "k_base": 32,
        "min_rating": 0,
        "max_rating": None,       # 上限なし
        "provisional_games": 30,
        "k_bands": [
            {"lt": 800,  "k": 40},
            {"lt": 1600, "k": 32},
            {"lt": 2000, "k": 24},
            {"ge": 2000, "k": 16}
        ],
        "draw_factor": 0.5
    },
    "elo": {
        "name": "Standard Elo",
        "initial_rating": 1500,
        "k_base": 32,
        "min_rating": 0,
        "max_rating": None,
        "provisional_games": 20,
        "k_bands": [],
        "draw_factor": 0.5
    }
}
# 既定は環境変数 DEFAULT_RATING_SYSTEM で上書き可（未設定なら sc24）
DEFAULT_RATING_SYSTEM = os.environ.get("DEFAULT_RATING_SYSTEM", "sc24")

# ---- 後方互換: 単一システム参照の旧コード用 ----
RATING_SYSTEM = {
    'initial_rating': RATING_SYSTEMS[DEFAULT_RATING_SYSTEM]['initial_rating'],
    'k_factor':       RATING_SYSTEMS[DEFAULT_RATING_SYSTEM]['k_base'],
    'min_rating':     RATING_SYSTEMS[DEFAULT_RATING_SYSTEM]['min_rating'],
    # 旧コードは数値上限を想定していることがあるので None を大きな数字で代替
    'max_rating':     (RATING_SYSTEMS[DEFAULT_RATING_SYSTEM]['max_rating'] 
                       if RATING_SYSTEMS[DEFAULT_RATING_SYSTEM]['max_rating'] is not None else 999999),
    'provisional_games': RATING_SYSTEMS[DEFAULT_RATING_SYSTEM]['provisional_games'],
}

# --------------------------------------
# 遅着許容（秒）: ここで指定した秒数 * 1000ms をサーバが許容します
TIMEOUT_GRACE_SECONDS = int(os.environ.get("TIMEOUT_GRACE_SECONDS", "3"))
