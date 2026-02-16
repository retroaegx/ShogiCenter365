# -*- coding: utf-8 -*-
from __future__ import annotations
from typing import Optional, Tuple, Dict, Any
import logging, threading, time
try:
    from redis import Redis
except Exception:
    Redis = None  # type: ignore
from src.schedulers.redis_disconnect_scheduler import DC_ZSET_KEY
logger = logging.getLogger(__name__)
from src.services.analysis_queue import try_enqueue_game_analysis
from src.services.game_service import _set_players_presence_review, _set_disconnect_timeout_presence

CLAIM_LUA = """
local zkey = KEYS[1]
local now = tonumber(ARGV[1])
local items = redis.call('zrangebyscore', zkey, '-inf', now, 'LIMIT', 0, 64)
if #items == 0 then return {} end
redis.call('zrem', zkey, unpack(items))
return items
"""

class RedisDisconnectWorker:
    def __init__(self, redis_url: str, game_service, socketio, zset_key: str = DC_ZSET_KEY, app=None):
        if Redis is None: raise RuntimeError("redis package is not available. Please install `redis`.")
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self.redis_url = redis_url
        self.zset_key = zset_key
        self.game_service = game_service
        self.socketio = socketio
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._claim_sha = self.redis.script_load(CLAIM_LUA)
        self.app = app
    def start(self):
        if self._thread and self._thread.is_alive(): return
        self._thread = threading.Thread(target=self._run_with_app, name="redis-dc-worker", daemon=True)
        self._thread.start(); logger.info("RedisDisconnectWorker started.")

    def _run_with_app(self):
        if getattr(self, 'app', None) is not None:
            try:
                from flask import current_app
                with self.app.app_context():
                    self._run()
                return
            except Exception:
                # fall through to raw run (explicitに落ちる方が良い)
                pass
        # アプリコンテキストなし（明示的にエラーにしたい場合はここでraiseでも良い）
        self._run()

    def stop(self): self._stop.set()
    def _run(self):
        while not self._stop.is_set():
            try:
                now = int(time.time() * 1000)
                items = self.redis.evalsha(self._claim_sha, 1, self.zset_key, now)
                for member in items or []:
                    try: self._handle_due(member)
                    except Exception as e: logger.warning('dc handle_due failed: %s', e, exc_info=True)
                time.sleep(0.5)
            except Exception: time.sleep(1.0)
    def _handle_due(self, member: str):
        try: game_id, user_id = member.split(':', 1)
        except ValueError: logger.warning('invalid dc member: %s', member); return
        doc = self.game_service.get_game_by_id(game_id)
        if not doc or str(doc.get('status')) == 'finished': return
        ts = (doc.get('time_state') or {}) if isinstance(doc.get('time_state'), dict) else {}
        # figure out which role timed out
        def norm(v):
            try:
                from bson import ObjectId as _OID
                if isinstance(v, _OID): return str(v)
            except Exception: pass
            if isinstance(v, dict): return str(v.get('user_id') or v.get('id') or '')
            return str(v or '')
        s_uid = norm(doc.get('sente_id') or (doc.get('players') or {}).get('sente', {}).get('user_id'))
        g_uid = norm(doc.get('gote_id')  or (doc.get('players') or {}).get('gote',  {}).get('user_id'))
        role = 'sente' if s_uid and s_uid == str(user_id) else ('gote' if g_uid and g_uid == str(user_id) else None)
        if role is None: return
        winner = 'gote' if role == 'sente' else 'sente'
        # Prefer: GameService側の共通終局処理に寄せる
        try:
            if hasattr(self.game_service, 'finish_game'):
                self.game_service.finish_game(
                    game_id=str(game_id),
                    winner_role=winner,
                    loser_role=role,
                    reason='disconnect_timeout',
                    presence_mode='disconnect',
                    disconnect_user_id=str(user_id),
                    emit=True,
                )
                return
        except Exception as e:
            logger.warning('finish_game failed: %s', e, exc_info=True)

        # fallback (legacy path)
        result = None
        try:
            result = self.game_service.game_model.update_one({'_id': game_id, 'status': {'$ne': 'finished'}}, {'$set': {
                'status': 'finished', 'finished_reason': 'disconnect_timeout',
                'winner': winner, 'loser': role, 'updated_at': self.game_service._now()
            }})
        except Exception:
            result = None
        if getattr(result, 'modified_count', 0) <= 0:
            return
        # enqueue engine analysis (best-effort; idempotent on DB)
        try:
            try_enqueue_game_analysis(self.game_service, str(game_id), redis_url=self.redis_url)
        except Exception:
            pass
        room = f'game:{game_id}'
        try:
            payload = self.game_service.as_api_payload(self.game_service.get_game_by_id(game_id))
            try:
                _set_disconnect_timeout_presence(self.game_service.get_game_by_id(game_id), user_id)
            except Exception as _e:
                logger.warning('presence update failed on dc-timeout: %s', _e, exc_info=True)
        except Exception:
            payload = {'game_id': game_id, 'status': 'finished', 'winner': winner, 'loser': role, 'reason': 'disconnect_timeout'}
        self.socketio.emit('game_update', payload, room=room)
        self.socketio.emit('game:finished', {'game_id': game_id, 'winner': winner, 'loser': role, 'reason': 'disconnect_timeout'}, room=room)


def start_redis_disconnect_worker(app, game_service, scheduler=None):
    try:
        socketio = getattr(app, "extensions", {}).get("socketio") or None
        if not socketio: socketio = app.config.get("SOCKETIO")
        redis_url = app.config.get("REDIS_URL", "redis://localhost:6379/0")
        worker = RedisDisconnectWorker(redis_url, game_service, socketio, app=app)
        worker.start(); app.config["DC_WORKER"] = worker; return worker
    except Exception as e:
        app.logger.warning("start_redis_disconnect_worker failed: %s", e, exc_info=True); return None
