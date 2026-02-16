# -*- coding: utf-8 -*-

from __future__ import annotations

import os
import uuid

from flask import Flask

from .security import init_cidr_guard, init_csrf

# DB manager is part of backend
try:
    from backend.src.models.database import DatabaseManager
except Exception:  # pragma: no cover
    try:
        from src.models.database import DatabaseManager  # type: ignore
    except Exception:
        DatabaseManager = None  # type: ignore


def _get_upload_dir() -> str:
    """Directory for blog image uploads.

    Shared with backend (5000) which serves /blog-uploads/<file>.
    """
    env_dir = (os.getenv("BLOG_UPLOAD_DIR") or "").strip()
    if env_dir:
        return env_dir
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "blog_uploads")


def create_app() -> Flask:
    app = Flask(__name__, template_folder="templates")
    app.secret_key = os.getenv("ADMIN_SITE_SECRET_KEY") or os.getenv("SECRET_KEY") or str(uuid.uuid4())
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

    # DB
    if DatabaseManager is None:
        raise RuntimeError("DatabaseManager import failed")

    app.dbm = DatabaseManager()

    # Moderation helper (warning words / flags)
    ModerationService = None
    try:
        from backend.src.services.moderation_service import ModerationService as _MS
        ModerationService = _MS
    except Exception:
        try:
            from src.services.moderation_service import ModerationService as _MS  # type: ignore
            ModerationService = _MS
        except Exception:
            ModerationService = None
    app.mod = ModerationService(app.dbm.db) if ModerationService else None

    # Admin creds (env)
    app.admin_user = (os.getenv("ADMIN_SITE_USERNAME") or os.getenv("ADMIN_USERNAME") or "").strip()
    app.admin_pass = os.getenv("ADMIN_SITE_PASSWORD") or os.getenv("ADMIN_PASSWORD") or ""

    # Uploads
    app.blog_upload_dir = _get_upload_dir()
    os.makedirs(app.blog_upload_dir, exist_ok=True)

    # Security
    init_cidr_guard(app)
    init_csrf(app)

    # Routes
    from .routes.auth import register as _auth
    from .routes.blog import register as _blog
    from .routes.users import register as _users
    from .routes.warning_words import register as _warn_words
    from .routes.warning_templates import register as _warn_templates
    from .routes.maintenance import register as _maintenance

    _auth(app)
    _blog(app)
    _users(app)
    _maintenance(app)
    _warn_words(app)
    _warn_templates(app)

    return app
