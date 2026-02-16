#!/usr/bin/env python3
# 本番入口（eventlet／PROD_*のみ読む／:5000固定デフォルト／Viteフォールバック無効）
import os, sys
from pathlib import Path

# eventlet は最初に
import eventlet
eventlet.monkey_patch()

try:
    from dotenv import load_dotenv
except Exception:
    raise SystemExit("python-dotenv が必要です: pip install python-dotenv")

ROOT = Path(__file__).resolve().parent

# 1) 直下の .env を読み込む（これだけ）
load_dotenv(ROOT / ".env")

# 2) SHOGI_FRONT_DIST を正規化（相対→絶対）。未設定なら既定 dist が存在する場合に自動設定
dist_env = os.getenv("SHOGI_FRONT_DIST")
if dist_env:
    p = Path(dist_env)
    if not p.is_absolute():
        os.environ["SHOGI_FRONT_DIST"] = str((ROOT / p).resolve())
else:
    default_dist = ROOT / "frontend" / "shogi-frontend" / "dist"
    if default_dist.exists():
        os.environ["SHOGI_FRONT_DIST"] = str(default_dist.resolve())

# 3) Vite(5173)フォールバックは無効
os.environ["DISABLE_VITE_FALLBACK"] = "1"

# 4) PROD_* だけを "無印" 環境変数に反映（DEV_*や無印は見ない）
def set_from_prod(name: str, *, default=None, required: bool=False, alts=None):
    v = os.getenv(f"PROD_{name}")
    if v is None and alts:
        for a in alts:
            v = os.getenv(f"PROD_{a}")
            if v is not None:
                break
    if v is not None:
        os.environ[name] = v
    elif default is not None:
        os.environ[name] = str(default)
    elif required:
        raise SystemExit(f"Missing required env: PROD_{name}")

# ホスト/ポート（:5000 既定）
set_from_prod("HOST", default="0.0.0.0")
set_from_prod("PORT", default=5000)

# セキュリティは必須
set_from_prod("SECRET_KEY", required=True)
set_from_prod("JWT_SECRET_KEY", required=True)

# 接続系（既定はローカル）
set_from_prod("MONGODB_URI", default="mongodb://localhost:27017/shogi")
set_from_prod("REDIS_URL", default="redis://localhost:6379/0")
set_from_prod("ENGINE_SERVER_ENABLED", default="1", alts=["ENGINE_SERVER_AUTOSTART"])
set_from_prod("ENGINE_SERVER_PORT", default=5002)
set_from_prod("ENGINE_SERVER_BIND", default="127.0.0.1")
set_from_prod("ENGINE_SERVER_URL", default="http://127.0.0.1:5002/analyze")
set_from_prod("ENGINE_THINK_SECONDS", default=1.0)
set_from_prod("ENGINE_MULTIPV", default=1)
set_from_prod("ENGINE_HTTP_TIMEOUT_SEC", default=30)

# 内部管理サイト（既定: 127.0.0.1:5003）
set_from_prod("ADMIN_SITE_ENABLED", default="1")
set_from_prod("ADMIN_SITE_PORT", default=5003)
set_from_prod("ADMIN_SITE_BIND", default="127.0.0.1")
set_from_prod("ADMIN_SITE_ALLOWED_CIDRS", default="127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12")
set_from_prod("ADMIN_SITE_TRUST_PROXY", default="0")
set_from_prod("ADMIN_SITE_ALLOW_REMOTE", default="0")
set_from_prod("ADMIN_SITE_STARTUP_TIMEOUT_SEC", default=5)

# 管理ログイン情報（.env に定義が必須）
set_from_prod("ADMIN_SITE_USERNAME")
set_from_prod("ADMIN_SITE_PASSWORD")

# 公開サイト（フロント）CIDR制限
set_from_prod("PUBLIC_SITE_ALLOW_REMOTE", default="1")
set_from_prod("PUBLIC_SITE_ALLOWED_CIDRS", default="127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,fd00::/8,fe80::/10")
set_from_prod("PUBLIC_SITE_TRUST_PROXY", default="0")


set_from_prod("ENGINE_SERVER_LOG_LEVEL", default="info")
set_from_prod("ENGINE_SERVER_STARTUP_TIMEOUT_SEC", default=8)
set_from_prod("ENGINE_SERVER_ALLOW_REMOTE", default="0")
set_from_prod("ENGINE_SERVER_ALLOWED_CIDRS", default="127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,fd00::/8,fe80::/10")
set_from_prod("ENGINE_SERVER_TRUST_PROXY", default="0")

# engine_server.py に渡す（子プロセスが参照）
set_from_prod("YANEO_SERVER_BASE_DIR")
set_from_prod("YANEO_ENGINE_DIR")
set_from_prod("YANEO_ENGINE_BIN")
set_from_prod("YANEO_ENGINE_PATH")
set_from_prod("YANEO_EVAL_DIR")
set_from_prod("YANEO_ENGINE_INSTANCES")
set_from_prod("YANEO_ENGINE_THREADS")
set_from_prod("YANEO_ENGINE_HASH_MB")
set_from_prod("YANEO_FV_SCALE")


# CORS / Socket.IO 許可オリジン（PROD_CORS_ORIGINS のみ利用）
prod_origin = os.getenv("PROD_CORS_ORIGINS")
if prod_origin:
    os.environ["CORS_ORIGINS"] = prod_origin
    os.environ["SOCKETIO_CORS_ALLOWED_ORIGINS"] = prod_origin

# ---- Mail / Contact / Email verification ----
# FRONTEND_URL: 認証メールのリンク生成に使う（未設定なら PROD_CORS_ORIGINS を流用）
set_from_prod("FRONTEND_URL", default=(prod_origin or ""))
set_from_prod("REQUIRE_EMAIL_VERIFICATION")

set_from_prod("SMTP_SERVER")
set_from_prod("SMTP_PORT")
set_from_prod("SMTP_USERNAME")
set_from_prod("SMTP_SENDER_EMAIL")
set_from_prod("SMTP_SENDER_PASSWORD")
set_from_prod("SMTP_SENDER_NAME")
set_from_prod("SMTP_USE_SSL")
set_from_prod("SMTP_USE_STARTTLS")
set_from_prod("SMTP_TIMEOUT_SEC")

set_from_prod("CONTACT_RECEIVER_EMAIL")

# 5) import path & 起動
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.src.main import app, socketio  # app/socketio を既存コードから利用
from backend.src.utils.engine_server_launcher import start_engine_server_process
from backend.src.utils.admin_server_launcher import start_admin_server_process
start_engine_server_process()
start_admin_server_process()


def main():
    host = os.environ["HOST"]
    port = int(os.environ["PORT"])
    socketio.run(app, host=host, port=port, debug=False)

if __name__ == "__main__":
    main()
