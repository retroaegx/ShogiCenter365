# -*- coding: utf-8 -*-

from __future__ import annotations

import os

from flask import abort, redirect, render_template, request, url_for

from ..security import login_required
from ..services.user_admin_service import UserAdminService, maybe_oid, uid_str


def register(app) -> None:
    svc = UserAdminService(app.dbm, moderation=getattr(app, "mod", None))

    @app.get("/users")
    @login_required
    def admin_users():
        q = (request.args.get("q") or "").strip()
        rows = svc.list_users(q=q)
        templates = svc.list_warning_templates()
        return render_template("users.html", users=rows, q=q, warning_templates=templates)

    @app.post("/users/<user_id>/warn")
    @login_required
    def admin_user_warn(user_id: str):
        msg = (request.form.get('message') or '').strip() or os.getenv(
            "ADMIN_SITE_DEFAULT_WARNING_MESSAGE", "運営からの警告です。利用規約をご確認ください。"
        )
        try:
            svc.warn_user(maybe_oid(user_id), message=msg)
        except Exception:
            pass
        return redirect(url_for("admin_users"))

    @app.post("/users/<user_id>/ban")
    @login_required
    def admin_user_ban(user_id: str):
        try:
            svc.set_banned(maybe_oid(user_id), True)
        except Exception:
            pass
        return redirect(url_for("admin_users"))

    @app.post("/users/<user_id>/unban")
    @login_required
    def admin_user_unban(user_id: str):
        try:
            svc.set_banned(maybe_oid(user_id), False)
        except Exception:
            pass
        return redirect(url_for("admin_users"))

    @app.get("/users/<user_id>/chat")
    @login_required
    def admin_user_chat(user_id: str):
        users_col = svc.users_col
        games_col = svc.games_col
        if users_col is None or games_col is None:
            abort(404)

        oid = maybe_oid(user_id)

        # clear chat warning flag (requirement)
        try:
            svc.clear_chat_warning_flag(oid)
        except Exception:
            pass

        username = svc.get_username(oid)
        msgs = svc.list_chat_messages_for_user(oid)

        # If requested, return an HTML fragment for overlay display.
        # (Keep the full page for direct navigation / no-JS fallback.)
        partial = (request.args.get("partial") or "").strip().lower()
        if partial in ("1", "true", "yes"):
            return render_template(
                "user_chat_fragment.html",
                user_id=uid_str(oid),
                username=username,
                messages=msgs,
            )

        return render_template(
            "user_chat.html",
            user_id=uid_str(oid),
            username=username,
            messages=msgs,
        )
