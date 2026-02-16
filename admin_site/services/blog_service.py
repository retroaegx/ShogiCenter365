# -*- coding: utf-8 -*-

"""Blog admin services.

Keeps blog-post persistence and excerpt logic out of route functions.
"""

from __future__ import annotations

import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple


ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
_TAG_RE = re.compile(r"<[^>]+>")


def strip_tags(s: str) -> str:
    return _TAG_RE.sub("", s or "")


def make_excerpt(content: Optional[Dict[str, Any]], fallback_body: str = "", limit: int = 120) -> str:
    text = ""
    if content and isinstance(content, dict):
        blocks = content.get("blocks")
        if isinstance(blocks, list):
            parts: List[str] = []
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                data = b.get("data") or {}
                if t in ("paragraph", "header"):
                    parts.append(strip_tags(str(data.get("text") or "")))
                elif t == "list":
                    items = data.get("items")
                    if isinstance(items, list):
                        parts.extend([strip_tags(str(x)) for x in items[:3]])
                if sum(len(p) for p in parts) > limit * 2:
                    break
            text = " ".join([p for p in parts if p]).strip()
    if not text:
        text = strip_tags(fallback_body).strip().replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


class BlogService:
    def __init__(self, dbm, upload_dir: str):
        self.dbm = dbm
        self.upload_dir = upload_dir

    @property
    def col(self):
        return getattr(self.dbm, "blog_posts", None)

    def default_editor_data(self) -> Dict[str, Any]:
        return {
            "time": int(datetime.utcnow().timestamp() * 1000),
            "blocks": [{"type": "paragraph", "data": {"text": ""}}],
        }

    def load_post(self, post_id: str) -> Optional[Dict[str, Any]]:
        col = self.col
        if col is None:
            return None
        if getattr(self.dbm, "use_mongodb", False):
            try:
                return col.find_one({"_id": post_id})
            except Exception:
                return None
        try:
            return getattr(col, "_b", {}).get(post_id)
        except Exception:
            return None

    def insert_post(self, doc: Dict[str, Any]) -> None:
        col = self.col
        if col is None:
            raise RuntimeError("blog_posts not initialized")
        if getattr(self.dbm, "use_mongodb", False):
            col.insert_one(doc)
            return
        # memory fallback
        b = getattr(col, "_b", None)
        if b is None:
            col._b = {}
            b = col._b
        b[doc["_id"]] = doc

    def update_post(self, post_id: str, patch: Dict[str, Any]) -> None:
        col = self.col
        if col is None:
            raise RuntimeError("blog_posts not initialized")
        if getattr(self.dbm, "use_mongodb", False):
            col.update_one({"_id": post_id}, {"$set": patch})
            return
        d = getattr(col, "_b", {}).get(post_id)
        if d:
            d.update(patch)

    def delete_post(self, post_id: str) -> None:
        col = self.col
        if col is None:
            raise RuntimeError("blog_posts not initialized")
        if getattr(self.dbm, "use_mongodb", False):
            col.delete_one({"_id": post_id})
            return
        b = getattr(col, "_b", None)
        if isinstance(b, dict):
            b.pop(post_id, None)

    def list_posts(self, limit: int = 100) -> List[Dict[str, Any]]:
        col = self.col
        items: List[Dict[str, Any]] = []
        if col is not None and getattr(self.dbm, "use_mongodb", False):
            try:
                items = list(col.find({}).sort("created_at", -1).limit(limit))
            except Exception:
                items = []
        else:
            try:
                items = list(getattr(col, "_b", {}).values()) if col is not None else []
            except Exception:
                items = []
            items.sort(key=lambda d: d.get("created_at") or "", reverse=True)
            items = items[:limit]
        return items

    def save_upload(self, file_storage) -> Tuple[str, str]:
        """Save a blog upload and return (filename, url)."""
        if not file_storage or not getattr(file_storage, "filename", ""):
            raise ValueError("file missing")
        filename = file_storage.filename or ""
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_IMAGE_EXTS:
            raise ValueError("unsupported")
        os.makedirs(self.upload_dir, exist_ok=True)
        save_name = f"{uuid.uuid4().hex}{ext}"
        save_path = os.path.join(self.upload_dir, save_name)
        file_storage.save(save_path)
        url = f"/blog-uploads/{save_name}"
        return save_name, url

    def maybe_delete_uploads_for_post(self, post: Dict[str, Any]) -> None:
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
            if not name or "/" in name or "\\" in name:
                continue
            path = os.path.join(self.upload_dir, name)
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except Exception:
                pass
