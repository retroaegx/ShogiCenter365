# -*- coding: utf-8 -*-
"""Simple SMTP mail sender (env-driven).

This project intentionally avoids heavy mail frameworks.
All configuration is read from environment variables so that
wrappers (dev.py / serve_eventlet.py) can map DEV_*/PROD_*.

Required to enable sending:
  SMTP_SERVER
  SMTP_SENDER_EMAIL

Optional:
  SMTP_PORT (default: 587)
  SMTP_USERNAME (default: SMTP_SENDER_EMAIL)
  SMTP_SENDER_PASSWORD
  SMTP_SENDER_NAME
  SMTP_USE_SSL (default: 0)
  SMTP_USE_STARTTLS (default: 1 when not SSL)
  SMTP_TIMEOUT_SEC (default: 10)

Notes:
  - 587 + STARTTLS is common.
  - 465 + SSL is also common.
  - Some providers (e.g. SendGrid) require SMTP_USERNAME != sender email.
"""

from __future__ import annotations

import os
import smtplib
from dataclasses import dataclass
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Optional


def _env_truthy(key: str, default: bool = False) -> bool:
    v = os.getenv(key)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _safe_header_value(s: str, *, max_len: int = 180) -> str:
    """Prevent header injection by removing CR/LF and truncating."""
    s = (s or "").replace("\r", " ").replace("\n", " ").strip()
    if len(s) > max_len:
        s = s[:max_len]
    return s


@dataclass(frozen=True)
class SmtpConfig:
    server: str
    port: int
    username: str
    sender_email: str
    sender_password: Optional[str]
    sender_name: Optional[str]
    use_ssl: bool
    use_starttls: bool
    timeout_sec: int


def load_smtp_config() -> Optional[SmtpConfig]:
    server = (os.getenv("SMTP_SERVER") or "").strip()
    sender_email = (os.getenv("SMTP_SENDER_EMAIL") or "").strip()
    sender_password = os.getenv("SMTP_SENDER_PASSWORD")
    sender_name = (os.getenv("SMTP_SENDER_NAME") or "").strip() or None

    # Optional login name (e.g. SendGrid: username=apikey)
    username = (os.getenv("SMTP_USERNAME") or "").strip() or sender_email

    if not server or not sender_email:
        return None

    try:
        port = int(os.getenv("SMTP_PORT", "587"))
    except Exception:
        port = 587

    use_ssl = _env_truthy("SMTP_USE_SSL", default=False)
    # SSL のときは starttls しない
    use_starttls = _env_truthy("SMTP_USE_STARTTLS", default=(not use_ssl)) and (not use_ssl)

    try:
        timeout_sec = int(os.getenv("SMTP_TIMEOUT_SEC", "10"))
    except Exception:
        timeout_sec = 10

    return SmtpConfig(
        server=server,
        port=port,
        username=username,
        sender_email=sender_email,
        sender_password=(sender_password or None),
        sender_name=sender_name,
        use_ssl=use_ssl,
        use_starttls=use_starttls,
        timeout_sec=timeout_sec,
    )


def send_text_email(
    *,
    to_email: str,
    subject: str,
    body: str,
    reply_to: Optional[str] = None,
) -> None:
    cfg = load_smtp_config()
    if cfg is None:
        raise RuntimeError("SMTP is not configured (SMTP_SERVER / SMTP_SENDER_EMAIL)")

    to_email = (to_email or "").strip()
    if not to_email:
        raise ValueError("to_email is required")

    subject = _safe_header_value(subject)
    from_name = _safe_header_value(cfg.sender_name or "") or None
    from_email = _safe_header_value(cfg.sender_email)

    msg = MIMEText(body or "", "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr((str(Header(from_name, "utf-8")) if from_name else "", from_email))
    msg["To"] = to_email
    if reply_to:
        msg["Reply-To"] = _safe_header_value(reply_to)

    if cfg.use_ssl:
        server = smtplib.SMTP_SSL(cfg.server, cfg.port, timeout=cfg.timeout_sec)
    else:
        server = smtplib.SMTP(cfg.server, cfg.port, timeout=cfg.timeout_sec)

    try:
        if cfg.use_starttls:
            server.ehlo()
            server.starttls()
            server.ehlo()

        # Only try AUTH when password is provided.
        if cfg.sender_password:
            server.login(cfg.username, cfg.sender_password)

        server.send_message(msg)
    finally:
        try:
            server.quit()
        except Exception:
            try:
                server.close()
            except Exception:
                pass
