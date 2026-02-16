# -*- coding: utf-8 -*-

"""Admin-site security helpers.

- CIDR allow-list restriction (LAN-only)
- Session login (simple username/password)
- CSRF protection for form posts

This is extracted from the previous monolithic admin_server.py.
"""

from __future__ import annotations

import ipaddress
import os
import secrets
from functools import wraps
from typing import Callable, List

from flask import abort, redirect, request, session, url_for

DEFAULT_ALLOWED_CIDRS = "127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12"
CSRF_SESSION_KEY = "_csrf_token"


def parse_allowed_cidrs(value: str) -> List[ipaddress._BaseNetwork]:
    nets: List[ipaddress._BaseNetwork] = []
    for part in (value or "").split(","):
        p = part.strip()
        if not p:
            continue
        try:
            nets.append(ipaddress.ip_network(p, strict=False))
        except Exception:
            continue
    return nets


def get_client_ip() -> str:
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


def init_cidr_guard(app) -> None:
    allow_remote = os.getenv("ADMIN_SITE_ALLOW_REMOTE", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    allowed_nets = parse_allowed_cidrs(os.getenv("ADMIN_SITE_ALLOWED_CIDRS", DEFAULT_ALLOWED_CIDRS))

    @app.before_request
    def _access_guard():
        if allow_remote:
            return None
        ip = get_client_ip()
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


def get_csrf_token() -> str:
    tok = session.get(CSRF_SESSION_KEY)
    if not tok:
        tok = secrets.token_urlsafe(32)
        session[CSRF_SESSION_KEY] = tok
    return str(tok)


def init_csrf(app) -> None:
    @app.context_processor
    def _inject_csrf():
        return {"csrf_token": get_csrf_token()}

    @app.before_request
    def _csrf_protect():
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            token = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token")
            if not token or token != session.get(CSRF_SESSION_KEY):
                abort(400)


def login_required(fn: Callable):
    @wraps(fn)
    def w(*args, **kwargs):
        if session.get("admin_ok") is True:
            return fn(*args, **kwargs)
        return redirect(url_for("login"))

    return w
