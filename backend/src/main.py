# ## PYTHONPATH bootstrap for 'src' package
import os as _os, sys as _sys
_cur = _os.path.dirname(_os.path.abspath(__file__))
_parent = _os.path.dirname(_cur)  # .../backend
if _parent not in _sys.path:
    _sys.path.insert(0, _parent)
# ## end bootstrap
# -*- coding: utf-8 -*-
import os
import sys
import logging
import json
import re
import ipaddress
from datetime import timedelta
from flask import Flask, jsonify, send_from_directory, redirect, request, abort
from flask_cors import CORS
from flask_jwt_extended import JWTManager
from src.config import Config as AppConfig
from flask_socketio import SocketIO
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# ---- SysPath (backend/src 配下の "src" を解決) ----
SYSBASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BLOG_UPLOAD_DIR = os.environ.get("BLOG_UPLOAD_DIR") or os.path.abspath(os.path.join(SYSBASE, "..", "blog_uploads"))
sys.path.insert(0, os.path.abspath(os.path.join(SYSBASE)))  # backend
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

app = Flask(__name__, static_folder=None)

# === error_code middleware ===
# All JSON error responses should include a stable error_code so the frontend can i18n-map it.
# If the handler did not provide one, we synthesize it from other fields (or 'unknown_error').
_CODE_RE = re.compile(r'^[a-z0-9_]+$', re.I)

def _looks_like_code(s: str) -> bool:
    try:
        return bool(_CODE_RE.match(s or ''))
    except Exception:
        return False

@app.after_request
def _ensure_error_code(resp):
    try:
        ctype = (resp.content_type or '').lower()
        if 'application/json' not in ctype:
            return resp
        if getattr(resp, 'direct_passthrough', False):
            return resp

        # Fast-path: for 2xx/3xx, skip parsing unless it looks like { success: false }.
        raw_b = None
        if resp.status_code < 400:
            try:
                raw_b = resp.get_data()
                i = raw_b.find(b'"success"')
                if i < 0:
                    return resp
                snippet = raw_b[i:i+40].lower()
                if b'false' not in snippet:
                    return resp
            except Exception:
                raw_b = None

        # Parse JSON body
        data = None
        try:
            if raw_b is not None:
                data = json.loads(raw_b.decode('utf-8'))
            else:
                data = resp.get_json(silent=True)
        except Exception:
            data = None

        if data is None:
            try:
                raw = resp.get_data(as_text=True)
                if raw:
                    data = json.loads(raw)
            except Exception:
                data = None

        if not isinstance(data, dict):
            return resp

        is_error = (data.get('success') is False) or (resp.status_code >= 400 and data.get('success') is not True)
        if not is_error:
            return resp

        ec = data.get('error_code')
        if isinstance(ec, str) and ec.strip():
            return resp

        code = None
        for k in ('code', 'error', 'result_code'):
            v = data.get(k)
            if isinstance(v, str) and v.strip():
                code = v.strip()
                break

        # If message looks like a stable token, allow it.
        if not code:
            msg = data.get('message')
            if isinstance(msg, str) and msg.strip() and _looks_like_code(msg.strip()):
                code = msg.strip()

        data['error_code'] = code or 'unknown_error'
        if 'success' not in data:
            data['success'] = False

        resp.set_data(json.dumps(data, ensure_ascii=False))
        resp.headers['Content-Length'] = str(len(resp.get_data()))
        return resp
    except Exception:
        return resp
# === end middleware ===
# === strict config enforcement (required) ===
if not hasattr(AppConfig, "ONLINE_USERS_TTL_SECONDS"):
    raise ValueError("ONLINE_USERS_TTL_SECONDS is required in src.config.Config")
app.config["ONLINE_USERS_TTL_SECONDS"] = int(AppConfig.ONLINE_USERS_TTL_SECONDS)

# optional with default
app.config["LOBBY_TOUCH_INTERVAL_SECONDS"] = int(getattr(AppConfig, "LOBBY_TOUCH_INTERVAL_SECONDS", 300))

if not hasattr(AppConfig, "JWT_ACCESS_TOKEN_EXPIRES"):
    raise ValueError("JWT_ACCESS_TOKEN_EXPIRES is required in src.config.Config")
app.config["JWT_ACCESS_TOKEN_EXPIRES"] = AppConfig.JWT_ACCESS_TOKEN_EXPIRES
# === end enforcement ===

CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True)

app.config["JWT_SECRET_KEY"] = os.environ.get("JWT_SECRET_KEY", "dev-secret-change-me")

jwt = JWTManager(app)

limiter = Limiter(get_remote_address, app=app, default_limits=["200/minute"])
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    message_queue=REDIS_URL,
    async_mode="eventlet",
)
app.config['SOCKETIO'] = socketio
# Ensure REDIS_URL is available from env or Config (import after sys.path is set)
try:
    from src.config import Config as _AppConfig
    app.config["REDIS_URL"] = os.environ.get("REDIS_URL", getattr(_AppConfig, "REDIS_URL", "redis://localhost:6379/0"))
except Exception:
    app.config["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

# Engine analysis service (YaneuraOu server)
app.config["ENGINE_SERVER_URL"] = os.environ.get("ENGINE_SERVER_URL", "http://127.0.0.1:5002/analyze")
try:
    app.config["ENGINE_THINK_SECONDS"] = float(os.environ.get("ENGINE_THINK_SECONDS", "1.0"))
except Exception:
    app.config["ENGINE_THINK_SECONDS"] = 1.0
try:
    app.config["ENGINE_MULTIPV"] = int(os.environ.get("ENGINE_MULTIPV", "1"))
except Exception:
    app.config["ENGINE_MULTIPV"] = 1
try:
    app.config["ENGINE_HTTP_TIMEOUT_SEC"] = int(os.environ.get("ENGINE_HTTP_TIMEOUT_SEC", "30"))
except Exception:
    app.config["ENGINE_HTTP_TIMEOUT_SEC"] = 30


logging.basicConfig(level=logging.INFO)

# ---- Engine server autostart (best-effort) ----
# 解析ワーカーが先に /analyze を叩いて ECONNREFUSED になるのを避けるため、
# main 初期化の段階で engine_server(uvicorn) を立ち上げて待つ。
try:
    from src.utils.engine_server_launcher import start_engine_server_process
    start_engine_server_process()
except Exception as e:
    try:
        app.logger.warning("Engine server autostart failed: %s", e, exc_info=True)
    except Exception:
        pass

from mimetypes import add_type
add_type('application/json', '.json')
app.logger.setLevel(logging.INFO)

# ---- Socket.IO connection logging (origin trace) ----
@socketio.on('connect')
def _on_connect():
    try:
        from flask import request, current_app
        origin = request.headers.get('Origin')
        sid = request.sid if hasattr(request, 'sid') else None
        current_app.logger.info(f"socket connect ok: origin={origin} sid={sid}")
    except Exception:
        app.logger.exception('socket connect logging failed')

@socketio.on('disconnect')
def _on_disconnect():
    try:
        from flask import request, current_app
        origin = request.headers.get('Origin')
        sid = request.sid if hasattr(request, 'sid') else None
        current_app.logger.info(f"socket disconnect: origin={origin} sid={sid}")
    except Exception:
        app.logger.exception('socket disconnect logging failed')


# ---- Frontend dist 探索（毎リクエストで再解決） ----
FRONT_CANDIDATES = [
    os.environ.get("SHOGI_FRONT_DIST"),
    os.path.abspath(os.path.join(SYSBASE, "..", "..", "frontend", "shogi-frontend", "dist")),
    os.path.abspath(os.path.join(SYSBASE, "..", "..", "frontend", "dist")),
]
def _find_dist():
    for d in FRONT_CANDIDATES:
        if not d:
            continue
        if os.path.exists(os.path.join(d, "index.html")):
            return d
    return None


# ---- Public site (frontend) CIDR guard ----
# By default, public site is NOT restricted (PUBLIC_SITE_ALLOW_REMOTE=1).
# Set PUBLIC_SITE_ALLOW_REMOTE=0 to allow only PUBLIC_SITE_ALLOWED_CIDRS.
_PUBLIC_SITE_DEFAULT_ALLOWED_CIDRS = (
    "127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,fd00::/8,fe80::/10"
)

_public_cidr_src = None
_public_cidr_nets = []

def _parse_allowed_cidrs(value: str):
    nets = []
    for part in (value or '').split(','):
        p = part.strip()
        if not p:
            continue
        try:
            nets.append(ipaddress.ip_network(p, strict=False))
        except Exception:
            continue
    return nets


def _bool_env(name: str, default: str = "0") -> bool:
    v = os.getenv(name, default)
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _public_get_client_ip() -> str:
    # If behind a reverse proxy and PUBLIC_SITE_TRUST_PROXY=1, honor X-Forwarded-For (left-most)
    if _bool_env('PUBLIC_SITE_TRUST_PROXY', '0'):
        xff = request.headers.get('X-Forwarded-For', '')
        if xff:
            return xff.split(',')[0].strip()
    return (request.remote_addr or '').strip()


def _public_get_allowed_nets():
    global _public_cidr_src, _public_cidr_nets
    src = os.getenv('PUBLIC_SITE_ALLOWED_CIDRS', _PUBLIC_SITE_DEFAULT_ALLOWED_CIDRS)
    if src != _public_cidr_src:
        _public_cidr_src = src
        _public_cidr_nets = _parse_allowed_cidrs(src)
    return _public_cidr_nets


def _is_public_site_path(path: str) -> bool:
    # Guard only the "public site" side. API stays unaffected.
    # This includes Socket.IO path (/socket.io) and SPA routes.
    return not (path or '').startswith('/api/')


@app.before_request
def _public_site_cidr_guard():
    # 1 => allow from anywhere, 0 => allow only from CIDR list
    if _bool_env('PUBLIC_SITE_ALLOW_REMOTE', '1'):
        return None
    try:
        if not _is_public_site_path(request.path or '/'):
            return None
        ip = _public_get_client_ip()
        if not ip:
            abort(403)
        ip_clean = ip.split('%')[0]  # strip IPv6 zone id (e.g., fe80::1%en0)
        addr = ipaddress.ip_address(ip_clean)
        if any(addr in net for net in _public_get_allowed_nets()):
            return None
        abort(403)
    except Exception:
        abort(403)

# ---- end public site CIDR guard ----

_BUILD_ID_META_RE = re.compile(r'<meta\s+name=["\']shogi-build-id["\']\s+content=["\']([^"\']+)["\']', re.IGNORECASE)

def _read_build_id(dist_dir: str):
    """Extract build id from built index.html (meta tag). Fallback: index.html mtime."""
    if not dist_dir:
        return None
    idx_path = os.path.join(dist_dir, 'index.html')
    try:
        if os.path.exists(idx_path):
            with open(idx_path, 'r', encoding='utf-8', errors='ignore') as f:
                html = f.read(200_000)
            m = _BUILD_ID_META_RE.search(html or '')
            if m:
                v = (m.group(1) or '').strip()
                if v:
                    return v
    except Exception:
        pass
    try:
        if os.path.exists(idx_path):
            return str(int(os.path.getmtime(idx_path)))
    except Exception:
        pass
    return None

def _vite_url():
    host = request.host.split(":")[0] or "localhost"
    return f"http://{host}:5173"

# ========================= 起動時 DI（厳格・回避なし） =========================
try:
    from src.models.database import DatabaseManager
    from src.services.game_service import GameService
    from src.utils.websocket_manager import WebSocketManager
    import src.services.game_service as game_service_module

    app.logger.info("GameService module path: %s", getattr(game_service_module, "__file__", "<unknown>"))

    dbm = DatabaseManager()
    app.db_manager = dbm
    app.config["DB_MANAGER"] = dbm

    db = getattr(dbm, "db", None)
    if db is None:
        raise RuntimeError("DatabaseManager.db が初期化されていません")

    # expose DB (routes が MONGO_DB を参照するため)
    app.mongo_db = db
    app.config["MONGO_DB"] = db

    # Moderation (warning words / user flags)
    try:
        from src.services.moderation_service import ModerationService
        app.config["MODERATION_SERVICE"] = ModerationService(db)
    except Exception as e:
        try:
            app.logger.warning("ModerationService init failed: %s", e, exc_info=True)
        except Exception:
            pass

    gs = GameService(db, socketio)
    
    # ---- Redis schedulers & workers ----
    # Initialize schedulers (timeouts and disconnects) and start workers.
    # Keep each init isolated so a failure in one doesn't break the other.
    try:
        from src.schedulers.redis_timeout_scheduler import RedisTimeoutScheduler
        redis_url = app.config.get("REDIS_URL", "redis://localhost:6379/0")
        timeout_scheduler = RedisTimeoutScheduler(redis_url)
        app.config["TIMEOUT_SCHEDULER"] = timeout_scheduler
        # Ensure workers can grab SocketIO via app.extensions
        app.extensions = getattr(app, "extensions", {}) or {}
        app.extensions["socketio"] = socketio
        from src.workers.redis_timeout_worker import start_redis_timeout_worker
        start_redis_timeout_worker(app, gs, scheduler=timeout_scheduler)
        app.logger.info("Timeout scheduler initialized with Redis at %s", redis_url)
    except Exception as e:
        app.logger.warning("Timeout scheduler init failed: %s", e, exc_info=True)

    try:
        from src.schedulers.redis_disconnect_scheduler import RedisDisconnectScheduler
        redis_url = app.config.get("REDIS_URL", "redis://localhost:6379/0")
        dc_scheduler = RedisDisconnectScheduler(redis_url)
        app.config["DC_SCHEDULER"] = dc_scheduler
        # Ensure SocketIO reference exists for worker
        app.extensions = getattr(app, "extensions", {}) or {}
        app.extensions["socketio"] = socketio
        from src.workers.redis_disconnect_worker import start_redis_disconnect_worker
        start_redis_disconnect_worker(app, gs, scheduler=dc_scheduler)
        app.logger.info("Disconnect scheduler initialized with Redis at %s", redis_url)
    except Exception as e:
        app.logger.warning("Disconnect scheduler init failed: %s", e, exc_info=True)

    try:
        # Analysis worker (game finished -> engine analyze -> save)
        redis_url = app.config.get("REDIS_URL", "redis://localhost:6379/0")
        from src.workers.redis_analysis_worker import start_redis_analysis_worker
        start_redis_analysis_worker(app, gs, redis_url=redis_url)
        app.logger.info("Analysis worker initialized with Redis at %s", redis_url)
    except Exception as e:
        app.logger.warning("Analysis worker init failed: %s", e, exc_info=True)



    try:
        # Online users diff broadcaster (presence changes via Socket.IO; FE should not poll)
        from src.workers.online_users_diff_worker import start_online_users_diff_worker
        start_online_users_diff_worker(app, socketio, interval_sec=1.0, offer_timeout_ms=20_000)
        app.logger.info("Online users diff worker initialized")
    except Exception as e:
        app.logger.warning("Online users diff worker init failed: %s", e, exc_info=True)
    from src.routes.game import init_game_routes
    init_game_routes(app, gs)  # ★ 引数なしの呼び出しは不可
    app.logger.info('BOUND game_service: %s', getattr(app, 'game_service', None))
    app.logger.info('GameService methods present: %s', [m for m in ('get_active_games','get_game_by_id','make_move','resign_game','as_api_payload') if hasattr(gs, m)])

    required = ["get_active_games", "get_game_by_id", "make_move", "resign_game"]
    present = [m for m in required if callable(getattr(gs, m, None))]
    missing = [m for m in required if m not in present]
    app.logger.info("GameService methods present: %s", present)
    if missing:
        raise RuntimeError(f"GameService が必要なインターフェースを満たしていません: missing={missing}")

    app.config["GAME_SERVICE"] = gs
    app.logger.info("GAME_SERVICE ready")

    # WebSocket handlers を登録
    app.config['WS_MANAGER'] = WebSocketManager(socketio)

except Exception:
    app.logger.exception("依存性の初期化に失敗しました。サーバーを停止します。")
    raise

# ========================= Blueprints =========================
from src.routes.lobby import lobby_bp
from src.routes.game import game_bp_instance, init_game_routes
from src.routes.auth import auth_bp
from src.routes.user import user_bp
from src.routes.kifu import kifu_bp, kifu_legacy_bp
from src.routes.offers_store import offer_bp
from src.routes.blog_public import blog_public_api_bp, blog_public_pages_bp

app.register_blueprint(lobby_bp)                             # /api/lobby (file側prefix)
app.register_blueprint(auth_bp, url_prefix='/api/auth')     # /api/auth/*
app.register_blueprint(user_bp, url_prefix='/api/user')     # /api/user/*
app.register_blueprint(kifu_bp)                             # /api/kifu/*
app.register_blueprint(kifu_legacy_bp)                      # /api/game/<id>/kifu (legacy)
app.register_blueprint(offer_bp)                            # /api/lobby/*
# Public blog (latest posts) + blog pages
app.register_blueprint(blog_public_api_bp, url_prefix="/api/public")
app.register_blueprint(blog_public_pages_bp)


try:
    init_game_routes(app, gs)                                   # /api/game/*
except Exception:
    app.logger.exception("Initialization failed")
    pass
# ========================= Health & Static =========================
@app.route("/api/build-info")
def build_info():
    dist = _find_dist()
    build_id = _read_build_id(dist) if dist else None
    if not build_id:
        build_id = 'dev'
    resp = jsonify({"buildId": build_id})
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.route("/api/health")
def health_check():
    if "GAME_SERVICE" not in app.config or app.config["GAME_SERVICE"] is None:
        return jsonify({"status": "error", "reason": "game_service_not_ready"}), 500
    return jsonify({"status": "ok"}), 200

@app.route("/")
def index_root():
    dist = _find_dist()
    if dist:
        app.logger.debug("Serving dist index.html from: %s", dist)

    # Inject WS initializer so front that calls global io() connects to BE(:5000) with JWT
    try:
        html = None
        idx_path = os.path.join(dist, "index.html")
        with open(idx_path, "r", encoding="utf-8", errors="ignore") as f:
            html = f.read()
        if html and "</body>" in html and "window.__SOCKET_INIT_DONE__" not in html:
            origin = request.host_url.rstrip("/")
            script = (
                "<script>(()=>{try{"
                "const ORIGIN='" + origin + "';"
                "if(!window.__SOCKET_INIT_DONE__&&window.io){"
                "const _io=window.io;"
                "window.io=function(url,opts){"
                "if(!url||typeof url!=='string'){url=ORIGIN;}"
                "opts=opts||{};"
                "opts.path=opts.path||'/socket.io';"
                "opts.transports=opts.transports||['websocket'];"
                "opts.withCredentials=true;"
                "if(!opts.auth){try{let t=localStorage.getItem('access_token')||sessionStorage.getItem('access_token');"
                "if(t){if(!t.startsWith('Bearer ')) t='Bearer '+t; opts.auth={token:t};}}catch(e){}}"
                "return _io(url,opts);"
                "};"
                "window.__SOCKET_INIT_DONE__=true;"
                "}"
                "}catch(e){} })();</script>"
            )
            html = html.replace("</body>", script + "</body>")
            return html, 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"}
    except Exception:
        pass
    resp = send_from_directory(dist, "index.html")
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp
    # No dist: redirect to Vite dev server
    target = _vite_url()
    app.logger.info("No dist found; redirecting / -> %s", target)
    return redirect(target, code=302)

@app.route("/assets/<path:fname>")
def assets_file(fname):
    dist = _find_dist()
    if dist:
        assets_dir = os.path.join(dist, "assets")
        path = os.path.join(assets_dir, fname)
        if os.path.exists(path):
            resp = send_from_directory(assets_dir, fname)
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp
    # fallback to Vite dev server assets
    target = f"{_vite_url()}/assets/{fname}"
    app.logger.info("No dist assets; redirecting /assets/%s -> %s", fname, target)
    return redirect(target, code=302)

@app.route("/shogi-assets/<path:fname>")
def shogi_assets_file(fname):
    dist = _find_dist()
    if dist:
        sdir = os.path.join(dist, 'shogi-assets')
        path = os.path.join(sdir, fname)
        if os.path.exists(path):
            resp = send_from_directory(sdir, fname)
            # Unhashed static assets: always revalidate
            resp.headers["Cache-Control"] = "no-cache, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            return resp
    # fallback to Vite dev server during dev
    target = f"{_vite_url()}/shogi-assets/{fname}"
    return redirect(target, code=302)

@app.route("/favicon.ico")
def favicon():
    dist = _find_dist()
    if dist and os.path.exists(os.path.join(dist, "favicon.ico")):
        return send_from_directory(dist, "favicon.ico")
    return ("", 204)


@app.route("/blog-uploads/<path:fname>")
def blog_uploads_file(fname):
    # Public blog uploads (saved by admin_server.py)
    bdir = BLOG_UPLOAD_DIR
    if bdir:
        path = os.path.join(bdir, fname)
        if os.path.exists(path):
            return send_from_directory(bdir, fname)
    return ("", 404)

# SPA fallback: /api/* 以外は index.html か Vite に流す

@app.route("/board-theme/<path:fname>")
def board_theme_file(fname):
    dist = _find_dist()
    if dist:
        bdir = os.path.join(dist, "board-theme")
        path = os.path.join(bdir, fname)
        if os.path.exists(path):
            return send_from_directory(bdir, fname)
    # fallback to Vite dev server during dev
    target = f"{_vite_url()}/board-theme/{fname}"
    app.logger.info("No dist board-theme; redirecting /board-theme/%s -> %s", fname, target)
    return redirect(target, code=302)


@app.route("/<path:subpath>")
def spa_fallback(subpath):
    if subpath.startswith("api/"):
        return ("", 404)
    dist = _find_dist()
    if dist:
        # Serve actual files if present (e.g., board-theme/config.json, any static asset)
        full = os.path.join(dist, subpath)
        if os.path.isfile(full):
            # Send from appropriate subdir or root
            base_dir = dist
            rel = subpath
            return send_from_directory(base_dir, rel)
        resp = send_from_directory(dist, "index.html")
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        return resp
    return redirect(_vite_url(), code=302)

def main():
    socketio.run(app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True)

if __name__ == "__main__":
    main()
