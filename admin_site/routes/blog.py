# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from typing import Any, Dict, Optional
from urllib.parse import urlparse, urlunparse

from flask import abort, jsonify, redirect, render_template, request, url_for

from ..security import login_required
from ..services.blog_service import BlogService, make_excerpt, strip_tags, ALLOWED_IMAGE_EXTS


def _public_base() -> str:
    """Return base URL of the public site (5000).

    Priority:
    - PUBLIC_SITE_BASE_URL / BLOG_PUBLIC_BASE_URL
    - Derived from current request host by swapping admin port -> public port
    """
    raw = (os.getenv("PUBLIC_SITE_BASE_URL") or os.getenv("BLOG_PUBLIC_BASE_URL") or "").strip()
    if raw:
        return raw.rstrip("/")

    try:
        u = urlparse(request.host_url)
        scheme = u.scheme or "http"
        host = u.hostname or "127.0.0.1"
        admin_port = int(os.getenv("ADMIN_SITE_PORT", "5003"))
        public_port = int(os.getenv("PUBLIC_SITE_PORT", "5000"))
        port = u.port
        if port == admin_port:
            port = public_port

        if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
            netloc = f"{host}:{port}"
        else:
            netloc = host
        return urlunparse((scheme, netloc, "", "", "", "")).rstrip("/")
    except Exception:
        return "http://127.0.0.1:5000"


def _public_url(post_id: str) -> str:
    return f"{_public_base()}/blog/{post_id}"


def register(app) -> None:
    blog = BlogService(app.dbm, app.blog_upload_dir)

    @app.post("/api/upload")
    @login_required
    def api_upload():
        f = request.files.get("file") or request.files.get("image")
        if not f or not getattr(f, "filename", ""):
            return jsonify({"success": 0, "error": "file missing"}), 400
        filename = f.filename or ""
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_IMAGE_EXTS:
            return jsonify({"success": 0, "error": "unsupported"}), 400
        try:
            _, url = blog.save_upload(f)
            return jsonify({"success": 1, "file": {"url": url}})
        except Exception:
            return jsonify({"success": 0, "error": "save failed"}), 500

    def _load_post_any(post_id: str) -> Optional[Dict[str, Any]]:
        return blog.load_post(post_id)

    @app.route("/posts/new", methods=["GET", "POST"])
    @login_required
    def new_post():
        error = None
        ok = None
        title = ""
        published = True
        initial_data: Dict[str, Any] = blog.default_editor_data()

        if request.method == "POST":
            title = (request.form.get("title") or "").strip()
            published = request.form.get("published") == "1"
            content_json = request.form.get("content_json") or ""
            try:
                content = json.loads(content_json) if content_json else None
            except Exception:
                content = None

            if not title:
                error = "タイトルが空です"
            elif not content or not isinstance(content, dict) or not isinstance(content.get("blocks"), list):
                error = "本文が空です"
            else:
                now = datetime.utcnow()
                doc = {
                    "_id": str(uuid.uuid4()),
                    "title": title,
                    "published": bool(published),
                    "created_at": now,
                    "updated_at": now,
                    "content": content,
                    "excerpt": make_excerpt(content, ""),
                }
                try:
                    blog.insert_post(doc)
                    ok = "保存しました（トップは最新5件だけ表示）"
                    title = ""
                    published = True
                    initial_data = blog.default_editor_data()
                except Exception:
                    error = "DB保存に失敗しました"

        return render_template(
            "post_editor.html",
            page_title="ブログ記事作成",
            heading="ブログ記事作成",
            form_action=url_for("new_post"),
            public_url=None,
            delete_url=None,
            title=title,
            published=published,
            initial_data=initial_data,
            error=error,
            ok=ok,
        )

    @app.route("/posts/<post_id>/edit", methods=["GET", "POST"])
    @login_required
    def edit_post(post_id: str):
        error = None
        ok = None
        post = _load_post_any(post_id)
        if not post:
            abort(404)

        title = post.get("title") or ""
        published = bool(post.get("published", False))
        initial_data = post.get("content") if isinstance(post.get("content"), dict) else None
        if not initial_data:
            body = post.get("body") or ""
            initial_data = {
                "time": int(datetime.utcnow().timestamp() * 1000),
                "blocks": [{"type": "paragraph", "data": {"text": strip_tags(body).replace("\n", "<br>")}}],
            }

        if request.method == "POST":
            title = (request.form.get("title") or "").strip()
            published = request.form.get("published") == "1"
            content_json = request.form.get("content_json") or ""
            try:
                content = json.loads(content_json) if content_json else None
            except Exception:
                content = None

            if not title:
                error = "タイトルが空です"
            elif not content or not isinstance(content, dict) or not isinstance(content.get("blocks"), list):
                error = "本文が空です"
            else:
                patch = {
                    "title": title,
                    "published": bool(published),
                    "updated_at": datetime.utcnow(),
                    "content": content,
                    "excerpt": make_excerpt(content, ""),
                }
                try:
                    blog.update_post(post_id, patch)
                    ok = "更新しました"
                    initial_data = content
                except Exception:
                    error = "更新に失敗しました"

        public_url = _public_url(post_id) if published else None

        return render_template(
            "post_editor.html",
            page_title="記事編集",
            heading="記事編集",
            form_action=url_for("edit_post", post_id=post_id),
            public_url=public_url,
            delete_url=url_for("delete_post", post_id=post_id),
            title=title,
            published=published,
            initial_data=initial_data,
            error=error,
            ok=ok,
        )

    @app.post("/posts/<post_id>/delete")
    @login_required
    def delete_post(post_id: str):
        post = _load_post_any(post_id)
        if not post:
            abort(404)
        try:
            blog.maybe_delete_uploads_for_post(post)
            blog.delete_post(post_id)
        except Exception:
            abort(500)
        return redirect(url_for("list_posts"))

    @app.get("/posts")
    @login_required
    def list_posts():
        posts = []
        items = blog.list_posts(limit=100)

        for d in items:
            dt = d.get("created_at")
            date = dt.strftime("%Y-%m-%d") if isinstance(dt, datetime) else (str(dt)[:10] if dt else "")
            pid = str(d.get("_id", ""))
            content = d.get("content") if isinstance(d.get("content"), dict) else None
            excerpt = d.get("excerpt") or make_excerpt(content, d.get("body") or "")
            posts.append(
                {
                    "id": pid,
                    "date": date,
                    "title": d.get("title", ""),
                    "published": bool(d.get("published", False)),
                    "excerpt": excerpt,
                    "edit_url": url_for("edit_post", post_id=pid),
                    "public_url": _public_url(pid) if d.get("published") else "",
                }
            )

        return render_template("posts_list.html", posts=posts)
