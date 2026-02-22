# -*- coding: utf-8 -*-
"""Time helpers that are timezone-safe across server TZ settings.

Rules:
- Generate epoch seconds/milliseconds from time.time() (never from naive datetime.timestamp()).
- When converting datetime -> epoch, treat naive datetimes as UTC explicitly.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional


def epoch_s() -> int:
    return int(time.time())


def epoch_ms() -> int:
    return int(time.time() * 1000)


def utc_now() -> datetime:
    """Timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


def utc_now_naive() -> datetime:
    """Naive UTC datetime for legacy Mongo writes/comparisons that expect naive datetime."""
    return datetime.utcnow()


def _as_utc(dt: datetime) -> datetime:
    if not isinstance(dt, datetime):
        raise TypeError('dt must be datetime')
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def dt_to_epoch_s_utc(dt: datetime) -> int:
    return int(_as_utc(dt).timestamp())


def dt_to_epoch_ms_utc(dt: datetime) -> int:
    return int(_as_utc(dt).timestamp() * 1000)
