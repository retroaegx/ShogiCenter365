# -*- coding: utf-8 -*-
from __future__ import annotations
import logging, threading, time
from typing import Optional, Tuple
try:
    from redis import Redis
except Exception:
    Redis = None  # type: ignore

logger = logging.getLogger(__name__)
DC_ZSET_KEY = "shogi:dc_timeouts"
DC_WAKEUP_CHANNEL = "shogi:dc_wakeup"
DC_MEMBER_PREFIX = "shogi:dcptr:"

class RedisDisconnectScheduler:
    def __init__(self, redis_url: str):
        if Redis is None: raise RuntimeError("redis package is not available. Please install `redis`.")
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self.zset_key = DC_ZSET_KEY
        self.wakeup_channel = DC_WAKEUP_CHANNEL
        self.member_prefix = DC_MEMBER_PREFIX
    def _ptr_key(self, game_id: str, user_id: str) -> str:
        return f"{self.member_prefix}{game_id}:{user_id}"
    def schedule(self, game_id: str, user_id: str, due_epoch_ms: int) -> Optional[Tuple[str, int]]:
        try:
            member = f"{game_id}:{user_id}"
            k = self._ptr_key(game_id, user_id)
            prev = self.redis.get(k)
            pipe = self.redis.pipeline()
            if prev: pipe.zrem(self.zset_key, prev)
            pipe.zadd(self.zset_key, {member: int(due_epoch_ms)})
            pipe.setex(k, 24*3600, member)
            pipe.publish(self.wakeup_channel, str(due_epoch_ms))
            pipe.execute()
            return member, int(due_epoch_ms)
        except Exception as e:
            logger.warning("dc schedule failed: %s", e, exc_info=True); return None
    def cancel(self, game_id: str, user_id: str) -> bool:
        try:
            k = self._ptr_key(game_id, user_id)
            prev = self.redis.get(k)
            pipe = self.redis.pipeline()
            if prev:
                pipe.zrem(self.zset_key, prev); pipe.delete(k)
            pipe.execute(); return True
        except Exception as e:
            logger.warning("dc cancel failed: %s", e, exc_info=True); return False
