#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Internal admin site (LAN) for blog posts.

- Runs on :5003 (or ADMIN_SITE_PORT)
- Access is restricted by CIDR (ADMIN_SITE_ALLOWED_CIDRS)
- Auth is a simple session login using env credentials

Blog editor:
- Editor.js (block editor) so users can insert blocks at cursor and drag to reorder
- Image uploads insert into current position (ImageTool uploader)

DB schema (blog_posts):
{
  _id: str(uuid),
  title: str,
  published: bool,
  created_at: datetime,
  updated_at: datetime,
  content: { ...Editor.js saved JSON... },  # preferred
  excerpt: str,  # optional, for list display

  # legacy support:
  body: str,  # plain text / mini-markdown
}
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import uuid
from datetime import datetime
from functools import wraps
from typing import Any, Dict, Optional
from urllib.parse import urlparse, urlunparse

from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template_string,
    request,
    session,
    url_for,
)


DEFAULT_ALLOWED_CIDRS = "127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12"
ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


def _get_upload_dir() -> str:
    """Directory for blog image uploads.

    Shared with backend (5000) which serves /blog-uploads/<file>.
    """

    env_dir = (os.getenv("BLOG_UPLOAD_DIR") or "").strip()
    if env_dir:
        return env_dir
    base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "blog_uploads")


def _parse_allowed_cidrs(value: str):
    nets = []
    for part in (value or "").split(","):
        p = part.strip()
        if not p:
            continue
        try:
            nets.append(ipaddress.ip_network(p, strict=False))
        except Exception:
            continue
    return nets


def _get_client_ip() -> str:
    """Return best-effort client IP.

    If ADMIN_SITE_TRUST_PROXY=1, X-Forwarded-For is honored (left-most).
    """

    trust = os.getenv("ADMIN_SITE_TRUST_PROXY", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if trust:
        xff = request.headers.get("X-Forwarded-For", "")
        if xff:
            return xff.split(",")[0].strip()
    return (request.remote_addr or "").strip()


_TAG_RE = re.compile(r"<[^>]+>")


def _strip_tags(s: str) -> str:
    return _TAG_RE.sub("", s or "")


def _make_excerpt(content: Optional[Dict[str, Any]], fallback_body: str = "", limit: int = 120) -> str:
    text = ""
    if content and isinstance(content, dict):
        blocks = content.get("blocks")
        if isinstance(blocks, list):
            parts = []
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                data = b.get("data") or {}
                if t in ("paragraph", "header"):
                    parts.append(_strip_tags(str(data.get("text") or "")))
                elif t == "list":
                    items = data.get("items")
                    if isinstance(items, list):
                        parts.extend([_strip_tags(str(x)) for x in items[:3]])
                if sum(len(p) for p in parts) > limit * 2:
                    break
            text = " ".join([p for p in parts if p]).strip()
    if not text:
        text = _strip_tags(fallback_body).strip().replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


try:
    from backend.src.models.database import DatabaseManager
except Exception:
    from src.models.database import DatabaseManager  # type: ignore


LOGIN_TEMPLATE = r"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>管理ログイン</title>
  <style>
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, "Hiragino Sans", "Yu Gothic", sans-serif; background:#f3f4f6; }
    .wrap { min-height: 100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { width: min(520px, 100%); background:#fff; border:1px solid rgba(0,0,0,.08); border-radius:16px; box-shadow: 0 10px 30px rgba(0,0,0,.08); padding:20px 20px 16px; }
    h1 { margin: 0 0 14px; font-size: 20px; }
    label { display:block; font-size: 13px; opacity: .8; margin: 10px 0 6px; }
    input { width:100%; padding: 12px 12px; border:1px solid rgba(0,0,0,.18); border-radius: 12px; font-size: 15px; }
    button { margin-top: 14px; width:100%; padding: 12px; border:0; border-radius: 12px; font-size: 15px; font-weight: 700; background:#111827; color:#fff; cursor:pointer; }
    .err { margin-top: 10px; color:#b91c1c; font-size: 13px; }
    .hint { margin-top: 10px; opacity:.7; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <form class="card" method="post" action="{{ url_for('login') }}">
      <h1>管理ログイン</h1>
      <label>ユーザー名</label>
      <input name="username" autocomplete="username" required />
      <label>パスワード</label>
      <input name="password" type="password" autocomplete="current-password" required />
      <button type="submit">ログイン</button>
      {% if error %}<div class="err">{{ error }}</div>{% endif %}
      <div class="hint">LAN内のみ（許可CIDR内）で使う想定。</div>
    </form>
  </div>
</body>
</html>"""


MENU_TEMPLATE = r"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>管理メニュー</title>
  <style>
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, "Hiragino Sans", "Yu Gothic", sans-serif; background:#f3f4f6; }
    .wrap { min-height: 100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { width: min(720px, 100%); background:#fff; border:1px solid rgba(0,0,0,.08); border-radius:16px; box-shadow: 0 10px 30px rgba(0,0,0,.08); padding:20px; }
    h1 { margin: 0 0 12px; font-size: 20px; }
    .grid { display:grid; grid-template-columns: 1fr; gap: 10px; }
    a.btn { display:block; text-decoration:none; padding: 12px 14px; border-radius: 12px; border:1px solid rgba(0,0,0,.12); color:#111827; font-weight:700; background: #fff; }
    a.btn:hover { background:#f9fafb; }
    .top { display:flex; align-items:center; justify-content:space-between; gap: 10px; }
    .muted { opacity:.7; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="top">
        <h1>管理メニュー</h1>
        <div><a class="btn" href="{{ url_for('logout') }}">ログアウト</a></div>
      </div>
      <div class="muted">ブログ投稿 → トップに最新5件だけ表示（公開のみ）</div>
      <div class="grid" style="margin-top: 14px;">
        <a class="btn" href="{{ url_for('new_post') }}">ブログ記事を作成</a>
        <a class="btn" href="{{ url_for('list_posts') }}">記事一覧</a>
      </div>
    </div>
  </div>
</body>
</html>"""


EDITOR_TEMPLATE = r"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{ page_title }}</title>
  <style>
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, "Hiragino Sans", "Yu Gothic", sans-serif; background:#f3f4f6; }
    .wrap { padding: 24px; max-width: 1040px; margin: 0 auto; }
    .card { background:#fff; border:1px solid rgba(0,0,0,.08); border-radius:16px; box-shadow: 0 10px 30px rgba(0,0,0,.08); padding:18px; }
    h1 { margin: 0 0 12px; font-size: 20px; }
    label { display:block; font-size: 13px; opacity: .85; margin: 12px 0 6px; }
    input[type="text"] { width:100%; padding: 12px 12px; border:1px solid rgba(0,0,0,.18); border-radius: 12px; font-size: 15px; }
    .row { display:flex; gap: 10px; align-items:center; margin-top: 12px; }
    .row input[type="checkbox"] { width:auto; }
    .actions { display:flex; gap: 10px; justify-content:flex-end; margin-top: 14px; flex-wrap: wrap; }
    button, a.btn { padding: 11px 14px; border-radius: 12px; border:1px solid rgba(0,0,0,.12); background:#111827; color:#fff; font-weight:700; font-size: 14px; cursor:pointer; text-decoration:none; }
    a.btn { background:#fff; color:#111827; }
    .danger { background:#b91c1c !important; border-color:#b91c1c !important; color:#fff !important; }
    .err { margin-top: 10px; color:#b91c1c; font-size: 13px; }
    .ok { margin-top: 10px; color:#047857; font-size: 13px; }
    .hint { margin-top: 8px; font-size: 12px; opacity: .75; line-height: 1.55; }

    /* Editor.js surface */
    #editorjs {
      background: rgba(17,24,39,.03);
      border: 1px solid rgba(0,0,0,.12);
      border-radius: 14px;
      padding: 14px 12px;
      min-height: 380px;
    }
    .ce-block__content, .ce-toolbar__content { max-width: 920px; }
    .ce-paragraph { font-size: 15px; line-height: 1.8; }
    .ce-header { padding: 0.2em 0; }
    .ce-header[data-level="2"]{ font-size: 22px; }
    .ce-header[data-level="3"]{ font-size: 18px; }
    .cdx-list__item { line-height: 1.7; }

    /* Make drag handle easier to grab */
    .ce-toolbar__actions { right: 6px; }
    .ce-toolbar__settings-btn, .ce-toolbar__plus { transform: scale(1.05); }

    /* Image block */
    .image-tool__image img { border-radius: 12px; border: 1px solid rgba(0,0,0,.12); }
    .image-tool__caption { font-size: 13px; opacity: .75; }

    /* Reduce "powered by" noise */
    .codex-editor__redactor { padding-bottom: 32px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div style="display:flex; justify-content:space-between; gap: 10px; align-items:center; flex-wrap: wrap;">
        <h1>{{ heading }}</h1>
        <div style="display:flex; gap:10px;">
          <a class="btn" href="{{ url_for('menu') }}">メニューへ</a>
          <a class="btn" href="{{ url_for('list_posts') }}">一覧へ</a>
        </div>
      </div>

      <form id="postForm" method="post" action="{{ form_action }}">
        <label>タイトル</label>
        <input name="title" value="{{ title or '' }}" required maxlength="120" />

        <label>本文</label>
        <div id="editorjs"></div>
        <div class="hint">+ ボタンで段落/見出し/箇条書き/画像を追加。ドラッグで順番を変えられるよ。</div>

        <input type="hidden" name="content_json" id="content_json" />

        <div class="row">
          <input id="published" type="checkbox" name="published" value="1" {% if published %}checked{% endif %} />
          <label for="published" style="margin:0;">公開する</label>
        </div>

        <div class="actions">
          {% if public_url %}
            <a class="btn" href="{{ public_url }}" target="_blank" rel="noopener">公開ページを開く</a>
          {% endif %}
          {% if delete_url %}
            <form method="post" action="{{ delete_url }}" style="display:inline;" onsubmit="return confirm('この記事を削除しますか？（元に戻せません）');">
              <button type="submit" class="btn danger">削除</button>
            </form>
          {% endif %}
          <a class="btn" href="{{ url_for('menu') }}">戻る</a>
          <button type="button" id="saveBtn">保存</button>
        </div>

        {% if error %}<div class="err">{{ error }}</div>{% endif %}
        {% if ok %}<div class="ok">{{ ok }}</div>{% endif %}
      </form>
    </div>
  </div>

  <!-- Editor.js via CDN -->
  <script src="https://cdn.jsdelivr.net/npm/@editorjs/editorjs@2.30.6"></script>
  <script src="https://cdn.jsdelivr.net/npm/@editorjs/header@2.8.8"></script>
  <script src="https://cdn.jsdelivr.net/npm/@editorjs/list@1.9.0"></script>
  <script src="https://cdn.jsdelivr.net/npm/@editorjs/image@2.10.2"></script>
  <script src="https://cdn.jsdelivr.net/npm/@editorjs/delimiter@1.4.2"></script>
  <script src="https://cdn.jsdelivr.net/npm/editorjs-drag-drop@1.1.14"></script>

  <script>
  (function(){
    const initialData = {{ initial_data|tojson }};

    async function uploadImage(file){
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('{{ url_for("api_upload") }}', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin'
      });
      if(!res.ok){
        const txt = await res.text().catch(()=> '');
        throw new Error('upload failed: ' + res.status + ' ' + txt);
      }
      const j = await res.json();
      if(!j || !j.success){
        throw new Error('upload failed');
      }
      return j;
    }

    const editor = new EditorJS({
      holder: 'editorjs',
      placeholder: 'ここに本文を入力',
      data: initialData,
      tools: {
        header: {
          class: Header,
          config: {
            levels: [2, 3],
            defaultLevel: 2
          }
        },
        list: {
          class: List,
          inlineToolbar: true
        },
        delimiter: Delimiter,
        image: {
          class: ImageTool,
          config: {
            captionPlaceholder: 'キャプション（任意）',
            uploader: {
              uploadByFile: async (file) => {
                return await uploadImage(file);
              }
            }
          }
        }
      }
    });

    try{ new DragDrop(editor); }catch(e){}

    const form = document.getElementById('postForm');
    const btn = document.getElementById('saveBtn');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '保存中...';
      try{
        const out = await editor.save();
        document.getElementById('content_json').value = JSON.stringify(out);
        form.submit();
      }catch(e){
        alert('保存に失敗しました: ' + (e && e.message ? e.message : e));
      }finally{
        btn.disabled = false;
        btn.textContent = '保存';
      }
    });
  })();
  </script>
</body>
</html>"""


LIST_TEMPLATE = r"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>記事一覧</title>
  <style>
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, "Hiragino Sans", "Yu Gothic", sans-serif; background:#f3f4f6; }
    .wrap { padding: 24px; max-width: 1040px; margin: 0 auto; }
    .card { background:#fff; border:1px solid rgba(0,0,0,.08); border-radius:16px; box-shadow: 0 10px 30px rgba(0,0,0,.08); padding:18px; }
    h1 { margin: 0 0 12px; font-size: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align:left; padding: 10px 8px; border-bottom: 1px solid rgba(0,0,0,.08); font-size: 13px; }
    th { opacity: .8; }
    .badge { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid rgba(0,0,0,.15); }
    .pub { background:#ecfdf5; border-color:#10b981; color:#047857; }
    .draft { background:#fffbeb; border-color:#f59e0b; color:#92400e; }
    a { color:#111827; }
    .top { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap: wrap; }
    a.btn { padding: 10px 12px; border-radius: 12px; border:1px solid rgba(0,0,0,.12); background:#fff; color:#111827; font-weight:700; font-size: 14px; text-decoration:none; }
    .muted { opacity:.7; }
    .op { display:flex; gap: 10px; align-items:center; flex-wrap: wrap; }
    .linkbtn { background:none; border:0; padding:0; margin:0; color:#111827; cursor:pointer; text-decoration: underline; font: inherit; }
    .linkbtn.danger { color:#b91c1c; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="top">
        <h1>記事一覧</h1>
        <div style="display:flex; gap:10px; flex-wrap: wrap;">
          <a class="btn" href="{{ url_for('new_post') }}">新規作成</a>
          <a class="btn" href="{{ url_for('menu') }}">メニューへ</a>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>日付</th><th>タイトル</th><th>状態</th><th>操作</th></tr>
        </thead>
        <tbody>
          {% for p in posts %}
            <tr>
              <td>{{ p.date }}</td>
              <td>
                <div style="font-weight:700;">{{ p.title }}</div>
                {% if p.excerpt %}<div class="muted" style="margin-top:2px;">{{ p.excerpt }}</div>{% endif %}
              </td>
              <td>
                {% if p.published %}
                  <span class="badge pub">公開</span>
                {% else %}
                  <span class="badge draft">下書き</span>
                {% endif %}
              </td>
              <td>
                <div class="op">
                  <a href="{{ p.edit_url }}">編集</a>
                  {% if p.public_url %}
                    <a href="{{ p.public_url }}" target="_blank" rel="noopener">公開</a>
                  {% endif %}
                  <form method="post" action="{{ url_for('delete_post', post_id=p.id) }}" style="display:inline;" onsubmit="return confirm('この記事を削除しますか？（元に戻せません）');">
                    <button type="submit" class="linkbtn danger">削除</button>
                  </form>
                </div>
              </td>
            </tr>
          {% endfor %}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>"""


def create_app() -> Flask:
    app = Flask(__name__)
    app.secret_key = os.getenv("ADMIN_SITE_SECRET_KEY") or os.getenv("SECRET_KEY") or str(uuid.uuid4())
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

    # DB
    app.dbm = DatabaseManager()

    # Creds (env)
    app.admin_user = (os.getenv("ADMIN_SITE_USERNAME") or os.getenv("ADMIN_USERNAME") or "").strip()
    app.admin_pass = os.getenv("ADMIN_SITE_PASSWORD") or os.getenv("ADMIN_PASSWORD") or ""

    # Uploads
    app.blog_upload_dir = _get_upload_dir()
    os.makedirs(app.blog_upload_dir, exist_ok=True)

    # access guard
    allow_remote = os.getenv("ADMIN_SITE_ALLOW_REMOTE", "0").strip().lower() in ("1", "true", "yes", "on")
    allowed_raw = os.getenv("ADMIN_SITE_ALLOWED_CIDRS", DEFAULT_ALLOWED_CIDRS)
    allowed_nets = _parse_allowed_cidrs(allowed_raw) or _parse_allowed_cidrs(DEFAULT_ALLOWED_CIDRS)

    @app.before_request
    def _access_guard():
        if allow_remote:
            return None
        ip = _get_client_ip()
        if not ip:
            abort(403)
        ip_clean = ip.split("%")[0]
        try:
            addr = ipaddress.ip_address(ip_clean)
        except Exception:
            abort(403)
        if any(addr in net for net in allowed_nets):
            return None
        abort(403)

    def login_required(fn):
        @wraps(fn)
        def w(*args, **kwargs):
            if session.get("admin_ok") is True:
                return fn(*args, **kwargs)
            return redirect(url_for("login"))

        return w

    def _col():
        return getattr(app.dbm, "blog_posts", None)

    def _public_base() -> str:
        """Return base URL of the public site (5000).

        Priority:
        - PUBLIC_SITE_BASE_URL / BLOG_PUBLIC_BASE_URL
        - Derived from current request host by swapping admin port -> public port
        """

        raw = (os.getenv("PUBLIC_SITE_BASE_URL") or os.getenv("BLOG_PUBLIC_BASE_URL") or "").strip()
        if raw:
            return raw.rstrip("/")

        # Best-effort derivation from current request
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
        return render_template_string(LOGIN_TEMPLATE, error=error)

    @app.get("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.get("/menu")
    @login_required
    def menu():
        return render_template_string(MENU_TEMPLATE)

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
            save_name = f"{uuid.uuid4().hex}{ext}"
            save_path = os.path.join(app.blog_upload_dir, save_name)
            f.save(save_path)
            url = f"/blog-uploads/{save_name}"
            return jsonify({"success": 1, "file": {"url": url}})
        except Exception:
            return jsonify({"success": 0, "error": "save failed"}), 500

    def _load_post_any(post_id: str) -> Optional[Dict[str, Any]]:
        col = _col()
        if col is None:
            return None
        if getattr(app.dbm, "use_mongodb", False):
            return col.find_one({"_id": post_id})
        try:
            return getattr(col, "_b", {}).get(post_id)
        except Exception:
            return None

    def _save_post(doc: Dict[str, Any]):
        col = _col()
        if col is None:
            raise RuntimeError("blog_posts not initialized")
        if getattr(app.dbm, "use_mongodb", False):
            col.insert_one(doc)
            return
        # memory fallback
        try:
            b = getattr(col, "_b", None)
            if b is None:
                col._b = {}
                b = col._b
            b[doc["_id"]] = doc
        except Exception:
            pass

    def _update_post(post_id: str, patch: Dict[str, Any]):
        col = _col()
        if col is None:
            raise RuntimeError("blog_posts not initialized")
        if getattr(app.dbm, "use_mongodb", False):
            col.update_one({"_id": post_id}, {"$set": patch})
            return
        try:
            d = getattr(col, "_b", {}).get(post_id)
            if d:
                d.update(patch)
        except Exception:
            pass

    def _delete_post_any(post_id: str):
        col = _col()
        if col is None:
            raise RuntimeError("blog_posts not initialized")
        if getattr(app.dbm, "use_mongodb", False):
            col.delete_one({"_id": post_id})
            return
        try:
            b = getattr(col, "_b", None)
            if isinstance(b, dict):
                b.pop(post_id, None)
        except Exception:
            pass

    def _maybe_delete_uploads_for_post(post: Dict[str, Any]):
        """Optionally delete uploaded files referenced by this post.

        Disabled by default to avoid deleting images reused by other posts.
        Enable by setting ADMIN_SITE_DELETE_UPLOADS=1.
        """

        if os.getenv("ADMIN_SITE_DELETE_UPLOADS", "0").strip().lower() not in ("1", "true", "yes", "on"):
            return

        content = post.get("content") if isinstance(post.get("content"), dict) else None
        if not content:
            return
        blocks = content.get("blocks")
        if not isinstance(blocks, list):
            return

        for b in blocks:
            if not isinstance(b, dict):
                continue
            if b.get("type") != "image":
                continue
            data = b.get("data") or {}
            file_obj = data.get("file") or {}
            url = file_obj.get("url")
            if not isinstance(url, str):
                continue
            if not url.startswith("/blog-uploads/"):
                continue
            name = url.split("/blog-uploads/", 1)[1].split("?", 1)[0]
            # basic path safety: no separators
            if not name or "/" in name or "\\" in name:
                continue
            path = os.path.join(app.blog_upload_dir, name)
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except Exception:
                pass

    def _default_editor_data() -> Dict[str, Any]:
        return {"time": int(datetime.utcnow().timestamp() * 1000), "blocks": [{"type": "paragraph", "data": {"text": ""}}]}

    @app.route("/posts/new", methods=["GET", "POST"])
    @login_required
    def new_post():
        error = None
        ok = None
        title = ""
        published = True
        initial_data: Dict[str, Any] = _default_editor_data()

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
                    "excerpt": _make_excerpt(content, ""),
                }
                try:
                    _save_post(doc)
                    ok = "保存しました（トップは最新5件だけ表示）"
                    title = ""
                    published = True
                    initial_data = _default_editor_data()
                except Exception:
                    error = "DB保存に失敗しました"

        return render_template_string(
            EDITOR_TEMPLATE,
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
            # legacy body -> single paragraph
            body = post.get("body") or ""
            initial_data = {
                "time": int(datetime.utcnow().timestamp() * 1000),
                "blocks": [{"type": "paragraph", "data": {"text": _strip_tags(body).replace("\n", "<br>")}}],
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
                    "excerpt": _make_excerpt(content, ""),
                }
                try:
                    _update_post(post_id, patch)
                    ok = "更新しました"
                    initial_data = content
                except Exception:
                    error = "更新に失敗しました"

        public_url = _public_url(post_id) if published else None

        return render_template_string(
            EDITOR_TEMPLATE,
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
            _maybe_delete_uploads_for_post(post)
            _delete_post_any(post_id)
        except Exception:
            # keep it simple for LAN tool
            abort(500)
        return redirect(url_for("list_posts"))

    @app.get("/posts")
    @login_required
    def list_posts():
        posts = []
        col = _col()

        if col is not None and getattr(app.dbm, "use_mongodb", False):
            items = list(col.find({}).sort("created_at", -1).limit(100))
        else:
            try:
                items = list(getattr(col, "_b", {}).values()) if col is not None else []
            except Exception:
                items = []
            items.sort(key=lambda d: d.get("created_at") or "", reverse=True)
            items = items[:100]

        for d in items:
            dt = d.get("created_at")
            date = dt.strftime("%Y-%m-%d") if isinstance(dt, datetime) else (str(dt)[:10] if dt else "")
            pid = str(d.get("_id", ""))
            content = d.get("content") if isinstance(d.get("content"), dict) else None
            excerpt = d.get("excerpt") or _make_excerpt(content, d.get("body") or "")
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

        return render_template_string(LIST_TEMPLATE, posts=posts)

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("ADMIN_SITE_BIND", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("ADMIN_SITE_PORT", "5003")))
    args = parser.parse_args()

    app = create_app()
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
