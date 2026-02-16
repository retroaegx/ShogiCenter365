# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import queue as _queue
import logging
from typing import Optional

try:
    from redis import Redis
except Exception:
    Redis = None  # type: ignore

logger = logging.getLogger(__name__)

ANALYSIS_QUEUE_KEY = os.getenv("ANALYSIS_QUEUE_KEY", "shogi:analysis_queue")

# In-process fallback (Redisが無い/使えない環境用)
_LOCAL_Q: "_queue.Queue[str]" = _queue.Queue()


def _get_redis(redis_url: Optional[str]):
    if Redis is None or not redis_url:
        return None
    try:
        return Redis.from_url(redis_url)
    except Exception:
        return None


def try_enqueue_game_analysis(game_service, game_id: str, *, redis_url: Optional[str] = None) -> bool:
    """終局済み対局の解析をキューに積む。DB側で queued を原子的に立てて、多重enqueueを防ぐ。"""
    try:
        # 終局したものだけ対象
        filt = {
            "_id": str(game_id),
            "status": "finished",
            "analysis_status": {"$nin": ["queued", "running", "done"]},
        }
        now = None
        try:
            now = game_service._now()
        except Exception:
            now = None

        update = {"$set": {"analysis_status": "queued"}}
        if now is not None:
            update["$set"]["analysis_queued_at"] = now  # type: ignore[index]

        res = game_service.game_model.update_one(filt, update)
        if getattr(res, "modified_count", 0) <= 0:
            return False
    except Exception as e:
        logger.warning("analysis enqueue mark failed: %s", e, exc_info=True)
        return False

    # enqueue into Redis list (preferred) else local queue
    r = _get_redis(redis_url or os.getenv("REDIS_URL"))
    if r is not None:
        try:
            r.lpush(ANALYSIS_QUEUE_KEY, str(game_id))
            return True
        except Exception as e:
            logger.warning("analysis redis lpush failed; fallback local queue: %s", e, exc_info=True)

    try:
        _LOCAL_Q.put_nowait(str(game_id))
        return True
    except Exception:
        return False


def dequeue_game_id_blocking(*, redis_url: Optional[str] = None, timeout_sec: int = 5) -> Optional[str]:
    """解析キューから1件取り出す（ブロッキング）。"""
    r = _get_redis(redis_url or os.getenv("REDIS_URL"))
    if r is not None:
        try:
            item = r.brpop(ANALYSIS_QUEUE_KEY, timeout=timeout_sec)
            if not item:
                return None
            # item is (key, value)
            return item[1].decode("utf-8") if isinstance(item[1], (bytes, bytearray)) else str(item[1])
        except Exception:
            # fallthrough
            pass

    try:
        return _LOCAL_Q.get(timeout=timeout_sec)
    except Exception:
        return None
