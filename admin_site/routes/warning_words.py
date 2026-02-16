# -*- coding: utf-8 -*-

from __future__ import annotations

from flask import redirect, render_template, request, url_for

from ..security import login_required
from ..services.warning_word_service import WarningWordService
from ..services.user_admin_service import maybe_oid, uid_str


def register(app) -> None:
    svc = WarningWordService(getattr(app, "mod", None))

    @app.route("/warning-words", methods=["GET", "POST"])
    @login_required
    def admin_warning_words():
        message = None
        if request.method == "POST":
            word = (request.form.get("word") or "").strip()
            if word:
                try:
                    svc.add(word)
                    message = "追加しました"
                except Exception:
                    message = "追加に失敗しました"

        words = []
        try:
            for w in svc.list():
                words.append({"id": uid_str(w.get("_id")), "word": w.get("word") or ""})
        except Exception:
            words = []
        words.sort(key=lambda d: (d.get("word") or "").lower())
        return render_template("warning_words.html", words=words, message=message)

    @app.post("/warning-words/<word_id>/delete")
    @login_required
    def admin_warning_word_delete(word_id: str):
        try:
            svc.delete(maybe_oid(word_id))
        except Exception:
            pass
        return redirect(url_for("admin_warning_words"))
