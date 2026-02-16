# -*- coding: utf-8 -*-
from __future__ import annotations
from typing import Optional, Dict, Any, Tuple
import threading
import time
import logging

try:
    from redis import Redis
except Exception:
    Redis = None  # type: ignore

from src.schedulers.redis_timeout_scheduler import DEFAULT_ZSET_KEY

logger = logging.getLogger(__name__)
from src.services.game_service import _set_players_presence_review
from src.utils.system_chat import emit_game_end_system_chat

CLAIM_LUA = """
-- KEYS[1] zset key
-- ARGV[1] member
-- ARGV[2] nowEpochMs
local s = redis.call('ZSCORE', KEYS[1], ARGV[1])
if (not s) or (tonumber(s) > tonumber(ARGV[2])) then
  return 0
end
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
"""

def _epoch_ms() -> int:
    return int(time.time() * 1000)

def _allowed_this_move_ms(ts: Dict[str, Any], role: str) -> int:
    cfg = (ts.get('config') or {}) if isinstance(ts.get('config'), dict) else {}
    side = ts.get(role) or {}
    init = int((side.get('initial_ms') if side.get('initial_ms') is not None else cfg.get('initial_ms') or 0) or 0)
    byo  = int((side.get('byoyomi_ms') if side.get('byoyomi_ms') is not None else cfg.get('byoyomi_ms') or 0) or 0)
    defer= int((side.get('deferment_ms') if side.get('deferment_ms') is not None else cfg.get('deferment_ms') or 0) or 0)
    core = (init + byo) if init > 0 else byo
    return max(0, core + defer)

class RedisTimeoutWorker:
    def __init__(self, redis_url: str, game_service, socketio, zset_key: str = DEFAULT_ZSET_KEY, app=None):
        if Redis is None:
            raise RuntimeError("redis package is not available. Please install `redis`.")
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self.zset_key = zset_key
        self.game_service = game_service
        self.socketio = socketio
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._claim_sha = self.redis.script_load(CLAIM_LUA)
        self.app = app

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run_with_app, name="redis-timeout-worker", daemon=True)
        self._thread.start()
        logger.info("RedisTimeoutWorker started.")

    def _run_with_app(self):
        if getattr(self, 'app', None) is not None:
            try:
                with self.app.app_context():
                    self._run()
                return
            except Exception:
                logger.warning('failed to enter app_context; running without it', exc_info=True)
        self._run()

    def stop(self):
        self._stop.set()

    def _run(self):
        max_sleep_ms = 100
        batch = 128
        while not self._stop.is_set():
            now = _epoch_ms()
            try:
                due = self.redis.zrangebyscore(self.zset_key, '-inf', now, start=0, num=batch)
                if due:
                    for member in due:
                        try:
                            claimed = self.redis.evalsha(self._claim_sha, 1, self.zset_key, member, str(now))
                        except Exception:
                            claimed = self.redis.eval(CLAIM_LUA, 1, self.zset_key, member, str(now))
                        if not claimed:
                            continue
                        self._handle_due(member)
                    continue
                nxt = self.redis.zrange(self.zset_key, 0, 0, withscores=True)
                if nxt:
                    wait = max(1, min(int(nxt[0][1]) - now, max_sleep_ms))
                else:
                    wait = max_sleep_ms * 2
                self._stop.wait(wait / 1000.0)
            except Exception as e:
                logger.warning("timeout worker loop error: %s", e, exc_info=True)
                self._stop.wait(max_sleep_ms / 1000.0)

    def _handle_due(self, member: str):
        try:
            game_id, base_at_s = member.split(':', 1)
        except ValueError:
            logger.warning('invalid member format: %s', member); return
        base_at = int(base_at_s)
        try:
            if hasattr(self.game_service, 'check_and_finish_timeout'):
                # Preferred: GameService側の終局処理に寄せる（grace判定/二重終局防止/emit整合）
                self.game_service.check_and_finish_timeout(game_id, base_at)
            else:
                # fallback: emit minimal timeout end (+ system chat)
                doc = self.game_service.get_game_by_id(game_id)
                if not doc:
                    return
                if str(doc.get('status')) == 'finished':
                    return
                ts = (doc.get('time_state') or {}) if isinstance(doc.get('time_state'), dict) else {}
                if int(ts.get('base_at') or doc.get('base_at') or 0) != base_at:
                    return

                loser_role = str(doc.get('current_turn') or ts.get('current_player') or 'sente')
                winner_role = 'gote' if loser_role == 'sente' else 'sente'

                update = {'status': 'finished', 'finished_reason': 'timeout', 'winner': winner_role, 'loser': loser_role}
                try:
                    res = self.game_service.game_model.update_one(
                        {'_id': game_id, 'status': {'$ne': 'finished'}},
                        {'$set': update},
                    )
                    if getattr(res, 'modified_count', 0) == 0:
                        return
                except Exception:
                    return

                try:
                    _set_players_presence_review(doc)
                except Exception:
                    pass

                # refresh doc for names/ids (best-effort)
                doc_end = None
                try:
                    doc_end = self.game_service.get_game_by_id(game_id)
                except Exception:
                    doc_end = None

                # system chat: game end (winner + defeat reason)
                try:
                    emit_game_end_system_chat(
                        self.socketio,
                        self.game_service.game_model,
                        doc_end or doc,
                        reason='timeout',
                        winner_role=winner_role,
                        loser_role=loser_role,
                    )
                except Exception:
                    logger.warning('emit_game_end_system_chat failed (timeout worker)', exc_info=True)

                room = f'game:{game_id}'
                try:
                    payload = self.game_service.as_api_payload(doc_end or self.game_service.get_game_by_id(game_id))
                except Exception:
                    payload = {'game_id': game_id, **update}

                self.socketio.emit('game_update', payload, room=room)
                self.socketio.emit('game:finished', {
                    'game_id': game_id,
                    'winner': winner_role,
                    'loser': loser_role,
                    'reason': 'timeout',
                }, room=room)
                self.socketio.emit('game:timeout', {'game_id': game_id, 'loser': loser_role, 'winner': winner_role}, room=room)
        except Exception as e:
            logger.warning('handle_due error: %s', e, exc_info=True)


def start_redis_timeout_worker(app, game_service, scheduler=None):
    """Create and start the RedisTimeoutWorker in background thread and keep a reference on app.config."""
    try:
        socketio = getattr(app, "extensions", {}).get("socketio") or None
        if not socketio:
            socketio = app.config.get("SOCKETIO")  # fallback if stored
        redis_url = app.config.get("REDIS_URL", "redis://localhost:6379/0")
        worker = RedisTimeoutWorker(redis_url, game_service, socketio, app=app)
        worker.start()
        app.config["TIMEOUT_WORKER"] = worker
        return worker
    except Exception as e:
        app.logger.warning("start_redis_timeout_worker failed: %s", e, exc_info=True)
        return None