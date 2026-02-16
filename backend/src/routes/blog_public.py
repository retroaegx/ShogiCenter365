# -*- coding: utf-8 -*-
from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import os
from flask import Blueprint, Response, abort, current_app, jsonify, request

from src.utils.mailer import send_text_email, load_smtp_config

blog_public_api_bp = Blueprint("blog_public_api", __name__)
blog_public_pages_bp = Blueprint("blog_public_pages", __name__)


def _env_truthy(key: str, default: bool = False) -> bool:
    v = os.environ.get(key)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _dbm():
    dbm = current_app.config.get("DB_MANAGER") or getattr(current_app, "db_manager", None)
    if not dbm:
        raise RuntimeError("DB_MANAGER is not initialized")
    return dbm


def _iso_date(dt: Any) -> str:
    if isinstance(dt, datetime):
        return dt.strftime("%Y-%m-%d")
    s = str(dt) if dt is not None else ""
    return s[:10] if len(s) >= 10 else s


def _safe_url(url: str) -> Optional[str]:
    u = (url or "").strip().strip('"').strip("'")
    if not u:
        return None
    if u.startswith("/"):
        return u
    p = urlparse(u)
    if p.scheme in ("http", "https"):
        return u
    return None


_ALLOWED_INLINE_TAGS = {"b", "strong", "i", "em", "u", "br", "code", "mark"}


class _MiniSanitizer(HTMLParser):
    """Very small allow-list sanitizer for Editor.js inline HTML.

    Editor.js paragraph/header/list tools store inline markup as HTML.
    We allow a small safe subset, escape everything else.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: List[str] = []

    def handle_starttag(self, tag: str, attrs):
        t = (tag or "").lower()
        if t in _ALLOWED_INLINE_TAGS:
            if t == "br":
                self.out.append("<br>")
            else:
                self.out.append(f"<{t}>")
            return

        if t == "a":
            href = None
            for k, v in (attrs or []):
                if (k or "").lower() == "href":
                    href = v
                    break
            safe = _safe_url(href or "")
            if safe:
                h = html.escape(safe, quote=True)
                self.out.append(f'<a href="{h}" target="_blank" rel="noopener">')
            else:
                # If href is unsafe, drop the link tag and keep inner text.
                self.out.append("")
            return

        # drop unknown tag
        self.out.append("")

    def handle_endtag(self, tag: str):
        t = (tag or "").lower()
        if t in _ALLOWED_INLINE_TAGS and t != "br":
            self.out.append(f"</{t}>")
            return
        if t == "a":
            self.out.append("</a>")
            return

    def handle_data(self, data: str):
        self.out.append(html.escape(data or ""))

    def handle_entityref(self, name: str):
        self.out.append(f"&{name};")

    def handle_charref(self, name: str):
        self.out.append(f"&#{name};")

    def get_html(self) -> str:
        return "".join(self.out)


def _sanitize_inline_html(s: str) -> str:
    if not s:
        return ""
    p = _MiniSanitizer()
    try:
        p.feed(s)
        p.close()
    except Exception:
        return html.escape(s)
    return p.get_html()


_TAG_STRIP_RE = re.compile(r"<[^>]+>")


def _plain_text_from_html(s: str) -> str:
    # For excerpt: strip tags, collapse whitespace.
    t = _TAG_STRIP_RE.sub(" ", s or "")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _latest_posts(limit: int = 5) -> List[Dict[str, Any]]:
    dbm = _dbm()
    col = getattr(dbm, "blog_posts", None)
    if col is None:
        return []

    if getattr(dbm, "use_mongodb", False):
        cursor = col.find({"published": True}).sort("created_at", -1).limit(int(limit))
        items = list(cursor)
    else:
        # Memory fallback (best-effort)
        try:
            items = list(getattr(col, "_b", {}).values())
        except Exception:
            items = []
        items = [d for d in items if d.get("published")]
        items.sort(key=lambda d: d.get("created_at") or "", reverse=True)
        items = items[: int(limit)]

    out: List[Dict[str, Any]] = []
    for d in items:
        excerpt = (d.get("excerpt") or "").strip()
        if not excerpt:
            content = d.get("content")
            if isinstance(content, dict):
                excerpt = _extract_excerpt_from_editorjs(content)
            else:
                excerpt = _plain_text_from_html(str(d.get("body") or ""))
        out.append(
            {
                "id": str(d.get("_id", "")),
                "title": d.get("title", "") or "",
                "date": _iso_date(d.get("created_at")),
                "excerpt": excerpt[:160],
            }
        )
    return out


def _get_post(post_id: str) -> Optional[Dict[str, Any]]:
    dbm = _dbm()
    col = getattr(dbm, "blog_posts", None)
    if col is None:
        return None
    if getattr(dbm, "use_mongodb", False):
        return col.find_one({"_id": post_id, "published": True})
    try:
        d = getattr(col, "_b", {}).get(post_id)
    except Exception:
        d = None
    if d and d.get("published"):
        return d
    return None


def _extract_excerpt_from_editorjs(content: Dict[str, Any]) -> str:
    blocks = content.get("blocks") if isinstance(content, dict) else None
    if not isinstance(blocks, list):
        return ""
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        data = b.get("data") if isinstance(b.get("data"), dict) else {}
        if t in ("paragraph", "header", "quote"):
            txt = data.get("text") or ""
            pt = _plain_text_from_html(str(txt))
            if pt:
                return pt
        if t == "list":
            items = data.get("items")
            if isinstance(items, list) and items:
                first = items[0]
                if isinstance(first, str):
                    pt = _plain_text_from_html(first)
                    if pt:
                        return pt
    return ""


def _render_legacy_body(raw: str) -> str:
    """Render a minimal markdown subset safely (legacy posts)."""

    placeholders: Dict[str, str] = {}
    idx = 0

    img_re = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
    link_re = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")

    def _img_repl(m: re.Match) -> str:
        nonlocal idx
        alt_raw = m.group(1) or "画像"
        url_raw = m.group(2) or ""
        url = _safe_url(url_raw)
        if not url:
            return m.group(0)
        ph = f"__OAI_IMG_{idx}__"
        idx += 1
        alt = html.escape(alt_raw)
        src = html.escape(url, quote=True)
        placeholders[ph] = (
            f'<figure class="blog-figure">'
            f'<a class="blog-img-link" href="{src}" target="_blank" rel="noopener">'
            f'<img src="{src}" alt="{alt}" loading="lazy" />'
            f'</a></figure>'
        )
        return ph

    def _link_repl(m: re.Match) -> str:
        nonlocal idx
        text_raw = m.group(1) or ""
        url_raw = m.group(2) or ""
        url = _safe_url(url_raw)
        if not url:
            return m.group(0)
        ph = f"__OAI_A_{idx}__"
        idx += 1
        text = html.escape(text_raw)
        href = html.escape(url, quote=True)
        placeholders[ph] = f'<a href="{href}" target="_blank" rel="noopener">{text}</a>'
        return ph

    tmp = img_re.sub(_img_repl, raw or "")
    tmp = link_re.sub(_link_repl, tmp)

    esc = html.escape(tmp)
    for ph, frag in placeholders.items():
        esc = esc.replace(html.escape(ph), frag)

    esc = esc.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")
    return esc


def _render_editorjs(content: Dict[str, Any]) -> str:
    blocks = content.get("blocks") if isinstance(content, dict) else None
    if not isinstance(blocks, list):
        return ""

    out: List[str] = []

    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        data = b.get("data") if isinstance(b.get("data"), dict) else {}

        if t == "header":
            level = int(data.get("level") or 2)
            level = 2 if level < 2 else 3 if level == 3 else 4 if level >= 4 else level
            txt = _sanitize_inline_html(str(data.get("text") or ""))
            if txt:
                out.append(f"<h{level}>{txt}</h{level}>")
            continue

        if t == "paragraph":
            txt = _sanitize_inline_html(str(data.get("text") or ""))
            if txt:
                out.append(f"<p>{txt}</p>")
            else:
                out.append("<p><br></p>")
            continue

        if t == "quote":
            txt = _sanitize_inline_html(str(data.get("text") or ""))
            cap = _sanitize_inline_html(str(data.get("caption") or ""))
            if txt:
                if cap:
                    out.append(f"<blockquote><div>{txt}</div><footer>{cap}</footer></blockquote>")
                else:
                    out.append(f"<blockquote><div>{txt}</div></blockquote>")
            continue

        if t == "delimiter":
            out.append("<hr>")
            continue

        if t == "list":
            style = (data.get("style") or "unordered").lower()
            tag = "ol" if style == "ordered" else "ul"
            items = data.get("items")
            if not isinstance(items, list) or not items:
                continue
            lis: List[str] = []
            for it in items:
                if isinstance(it, str):
                    it_html = _sanitize_inline_html(it)
                    lis.append(f"<li>{it_html}</li>")
            if lis:
                out.append(f"<{tag}>" + "".join(lis) + f"</{tag}>")
            continue

        if t == "image":
            fileobj = data.get("file") if isinstance(data.get("file"), dict) else {}
            url = _safe_url(str(fileobj.get("url") or ""))
            if not url:
                continue
            caption = _sanitize_inline_html(str(data.get("caption") or ""))
            src = html.escape(url, quote=True)
            fig = (
                f'<figure class="blog-figure">'
                f'<a class="blog-img-link" href="{src}" target="_blank" rel="noopener">'
                f'<img src="{src}" alt="" loading="lazy" />'
                f'</a>'
            )
            if caption:
                fig += f"<figcaption>{caption}</figcaption>"
            fig += "</figure>"
            out.append(fig)
            continue

        # Unknown block: ignore

    return "\n".join(out)


@blog_public_api_bp.get("/blog/latest")
def api_blog_latest():
    # Top page uses this (published only)
    return jsonify({"items": _latest_posts(limit=5)})


@blog_public_pages_bp.get("/blog/<post_id>")
def page_blog_post(post_id: str):
    post = _get_post(post_id)
    if not post:
        abort(404)

    title = html.escape(post.get("title") or "")
    date = html.escape(_iso_date(post.get("created_at")))

    content = post.get("content")
    if isinstance(content, dict) and isinstance(content.get("blocks"), list):
        body_html = _render_editorjs(content)
    else:
        body_html = _render_legacy_body(post.get("body") or "")

    page = f"""<!doctype html>
<html lang=\"ja\">
<head>
  <meta charset=\"UTF-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />
  <title>{title} - 将棋センター365</title>
  <link rel=\"icon\" type=\"image/x-icon\" href=\"/favicon.ico\" />
  <link rel=\"stylesheet\" href=\"/shogi-assets/site.css\" />
</head>
<body class=\"shogi-static-body blog-post-page\">
  <div class=\"shogi-static\">
    <div id=\"staticHeader\"></div>

    <main>
      <section class=\"section-spacing\" style=\"padding-top: 18px;\">
        <div class=\"container\">
          <div class=\"blog-post-pane\">
            <header class=\"blog-post-head\">
              <h1 class=\"blog-post-title\">{title}</h1>
              <p class=\"blog-post-meta\">{date}</p>
            </header>
            <div class=\"blog-post-body\">{body_html}</div>
          </div>
        </div>
      </section>
    </main>

    <div id=\"staticFooter\"></div>
  </div>

  <script defer src=\"/shogi-assets/static_shell.js\"></script>
</body>
</html>"""

    return Response(page, mimetype="text/html; charset=utf-8")


@blog_public_api_bp.route("/contact", methods=["POST"])
def public_contact_send():
    """Public contact form -> SMTP send.

    Expects JSON:
      { name, subject, email, body }

    Recipient is configured via CONTACT_RECEIVER_EMAIL.
    """
    if load_smtp_config() is None:
        return jsonify({'success': False, 'error_code': 'contact_smtp_not_configured', 'message': 'サーバーのメール送信設定が未完了です（SMTP）'}), 500

    to_email = (os.getenv('CONTACT_RECEIVER_EMAIL') or '').strip()
    if not to_email:
        return jsonify({'success': False, 'error_code': 'contact_receiver_not_configured', 'message': 'サーバーの問い合わせ受信先が未設定です'}), 500

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        data = {}

    name = str(data.get('name') or '').strip()
    subject = str(data.get('subject') or '').strip()
    email = str(data.get('email') or '').strip()
    body = str(data.get('body') or '').strip()

    if not name or not subject or not email or not body:
        return jsonify({'success': False, 'error_code': 'contact_missing_fields', 'message': 'name / subject / email / body は必須です'}), 400

    # Minimal validation to reduce abuse/header-injection
    if any(x in subject for x in ('\r', '\n')) or any(x in name for x in ('\r', '\n')):
        return jsonify({'success': False, 'error_code': 'contact_invalid_input', 'message': '入力が不正です'}), 400
    if any(x in email for x in ('\r', '\n')):
        return jsonify({'success': False, 'error_code': 'contact_invalid_email', 'message': '入力が不正です'}), 400
    if len(body) > 8000:
        return jsonify({'success': False, 'error_code': 'contact_body_too_long', 'message': '本文が長すぎます'}), 400

    mail_subject = f"[問い合わせ] {subject}"
    mail_body = (
        "お問い合わせフォームから送信されました。\n\n"
        f"名前: {name}\n"
        f"メール: {email}\n"
        "\n"
        "---\n"
        f"{body}\n"
    )

    try:
        send_text_email(to_email=to_email, subject=mail_subject, body=mail_body, reply_to=email)
    except Exception:
        current_app.logger.exception('Failed to send contact email')
        return jsonify({'success': False, 'error_code': 'contact_send_failed', 'message': '送信に失敗しました'}), 500

    return jsonify({'success': True, 'result_code': 'contact_sent', 'message': '送信しました'}), 200
