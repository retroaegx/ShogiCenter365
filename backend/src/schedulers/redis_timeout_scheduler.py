# -*- coding: utf-8 -*-
from __future__ import annotations
from typing import Optional, Tuple, Dict, Any
import time
import logging

try:
    from redis import Redis
except Exception:
    Redis = None  # type: ignore

logger = logging.getLogger(__name__)

DEFAULT_ZSET_KEY = "shogi:timeouts"
DEFAULT_WAKEUP_CHANNEL = "shogi:wakeup"
DEFAULT_MEMBER_KEY_PREFIX = "shogi:deadline:game:"

def _to_int(x, default=0) -> int:
    try:
        return int(x)
    except Exception:
        return int(default)

def _epoch_ms() -> int:
    return int(time.time() * 1000)

def _get_grace_ms(ts: Dict[str, Any]) -> int:
    # default 3000ms if config import fails
    grace_ms = 3000
    try:
        # project-level default (seconds)
        from ..config import TIMEOUT_GRACE_SECONDS  # type: ignore
        grace_ms = int(TIMEOUT_GRACE_SECONDS) * 1000
    except Exception:
        pass
    # per-game override
    try:
        cfg = ts.get('config') or {}
        if cfg.get('time_grace_ms') is not None:
            grace_ms = _to_int(cfg.get('time_grace_ms') or 0, 0)
    except Exception:
        pass
    return max(0, grace_ms)

def _get_epsilon_ms(ts: Dict[str, Any]) -> int:
    # small safety margin to avoid boundary race; default 30ms
    eps = 30
    try:
        from ..config import TIMEOUT_GRACE_EPSILON_MS  # optional
        eps = int(TIMEOUT_GRACE_EPSILON_MS)  # type: ignore
    except Exception:
        pass
    try:
        cfg = ts.get('config') or {}
        if cfg.get('time_grace_epsilon_ms') is not None:
            eps = _to_int(cfg.get('time_grace_epsilon_ms') or 0, eps)
    except Exception:
        pass
    return max(0, eps)

def _get_notify_delay_ms(ts: Dict[str, Any]) -> int:
    """Extra delay after the computed deadline to fire the auto timeout notification.
    Default +1000ms. Can be overridden by:
      - per game:  time_state.config.time_notify_delay_ms
      - global:    config.TIMEOUT_NOTIFY_DELAY_MS (milliseconds)
    """
    delay = 1000  # +1s by default
    try:
        from ..config import TIMEOUT_NOTIFY_DELAY_MS  # optional (ms)
        delay = int(TIMEOUT_NOTIFY_DELAY_MS)  # type: ignore
    except Exception:
        pass
    try:
        cfg = ts.get('config') or {}
        if cfg.get('time_notify_delay_ms') is not None:
            delay = _to_int(cfg.get('time_notify_delay_ms') or 0, delay)
    except Exception:
        pass
    return max(0, delay)

def _allowed_core_ms(ts: Dict[str, Any], role: str) -> int:
    cfg  = (ts.get('config') or {}) if isinstance(ts.get('config'), dict) else {}
    side = ts.get(role) or {}
    init = _to_int(side.get('initial_ms') if side.get('initial_ms') is not None else cfg.get('initial_ms'), 0)
    byo  = _to_int(side.get('byoyomi_ms') if side.get('byoyomi_ms') is not None else cfg.get('byoyomi_ms'), 0)
    defer= _to_int(side.get('deferment_ms') if side.get('deferment_ms') is not None else cfg.get('deferment_ms'), 0)
    core = (init + byo) if init > 0 else byo
    return max(0, core + defer)

class RedisTimeoutScheduler:
    def unschedule_for_game(self, game_id: str) -> bool:
        try:
            k = f"{DEFAULT_MEMBER_KEY_PREFIX}{game_id}"
            prev = self.redis.get(k)
            pipe = self.redis.pipeline()
            if prev:
                pipe.zrem(self.zset_key, prev)
                pipe.delete(k)
            pipe.execute()
            return True
        except Exception as e:
            logger.warning("unschedule_for_game failed: %s", e, exc_info=True)
            return False

    def __init__(self, redis_url: str, zset_key: str = DEFAULT_ZSET_KEY, wakeup_channel: str = DEFAULT_WAKEUP_CHANNEL):
        if Redis is None:
            raise RuntimeError("redis package is not available. Please install `redis`.")
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self.zset_key = zset_key
        self.wakeup_channel = wakeup_channel
        self.member_key_prefix = DEFAULT_MEMBER_KEY_PREFIX

    def schedule_for_game_doc(self, doc: Dict[str, Any]) -> Optional[Tuple[str, int]]:
        """Schedule (or reschedule) the timeout for a game.
        Uses base_at and current player from time_state.
        Member id is "{game_id}:{base_at}" so old entries are removable.
        The scheduled deadline includes grace + epsilon + notify_delay to align with inclusive move-acceptance.
        """
        try:
            game_id = str(doc.get('_id') or '')
            if not game_id:
                return None

            ts = doc.get('time_state') or {}
            cur = str(doc.get('current_turn') or ts.get('current_player') or 'sente')
            base_at = _to_int(ts.get('base_at') or _epoch_ms(), _epoch_ms())

            allowed_core = _allowed_core_ms(ts, cur)
            grace_ms = _get_grace_ms(ts)
            eps = _get_epsilon_ms(ts)
            notify_delay = _get_notify_delay_ms(ts)

            deadline = base_at + allowed_core + grace_ms + eps + notify_delay

            member = f"{game_id}:{base_at}"
            k = f"{self.member_key_prefix}{game_id}"
            prev = self.redis.get(k)
            pipe = self.redis.pipeline()
            if prev:
                pipe.zrem(self.zset_key, prev)
            pipe.zadd(self.zset_key, {member: int(deadline)})
            # keep a short-lived pointer to last member for quick removal (24h)
            pipe.setex(k, 24*3600, member)
            # nudge worker to wake up
            pipe.publish(self.wakeup_channel, str(deadline))
            pipe.execute()
            return member, int(deadline)
        except Exception as e:
            logger.warning("schedule_for_game_doc failed: %s", e, exc_info=True)
            return None
