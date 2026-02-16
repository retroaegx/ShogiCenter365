# -*- coding: utf-8 -*-

from __future__ import annotations

import os

from flask import redirect, render_template, request, session, url_for

from ..security import login_required


def register(app) -> None:
    @app.get("/")
    def root():
        return redirect(url_for("menu") if session.get("admin_ok") else url_for("login"))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        error = None
        if request.method == "POST":
            u = (request.form.get("username") or "").strip()
            p = request.form.get("password") or ""
            if not app.admin_user or not app.admin_pass:
                error = "環境変数 ADMIN_SITE_USERNAME / ADMIN_SITE_PASSWORD が未設定です"
            elif u == app.admin_user and p == app.admin_pass:
                session["admin_ok"] = True
                return redirect(url_for("menu"))
            else:
                error = "ユーザー名かパスワードが違います"
        return render_template("login.html", error=error)

    @app.get("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.get("/menu")
    @login_required
    def menu():
        return render_template("menu.html")
