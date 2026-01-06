# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import sys
import socket
import subprocess
import atexit
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_ENGINE_PROC: Optional[subprocess.Popen] = None


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=0.3):
            return True
    except Exception:
        return False


def start_engine_server_process() -> Optional[subprocess.Popen]:
    """uvicorn で engine_server:app を別プロセス起動する（:5002 デフォルト）。"""
    global _ENGINE_PROC
    if _ENGINE_PROC is not None:
        return _ENGINE_PROC

    enabled = os.getenv("ENGINE_SERVER_ENABLED", "1")
    if str(enabled).lower() in ("0", "false", "no", "off"):
        logger.info("Engine server disabled by ENGINE_SERVER_ENABLED=%s", enabled)
        return None

    bind = os.getenv("ENGINE_SERVER_BIND", "127.0.0.1")
    port = int(os.getenv("ENGINE_SERVER_PORT", "5002"))

    # すでに立っているなら何もしない
    if _port_open(bind, port):
        logger.info("Engine server already listening at %s:%s", bind, port)
        return None

    repo_root = Path(__file__).resolve().parents[3]  # backend/src/utils -> project root
    env = os.environ.copy()
    env["PYTHONPATH"] = str(repo_root) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")

    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "engine_server:app",
        "--host",
        bind,
        "--port",
        str(port),
        "--log-level",
        os.getenv("ENGINE_SERVER_LOG_LEVEL", "info"),
    ]

    try:
        _ENGINE_PROC = subprocess.Popen(cmd, cwd=str(repo_root), env=env)
    except Exception as e:
        logger.warning("Failed to start engine server: %s", e, exc_info=True)
        _ENGINE_PROC = None
        return None

    # 起動を待つ（main.py のワーカーが先に叩いて ECONNREFUSED になるのを防ぐ）
    timeout_sec = float(os.getenv("ENGINE_SERVER_STARTUP_TIMEOUT_SEC", "8"))
    deadline = time.time() + max(0.0, timeout_sec)
    while time.time() < deadline:
        if _port_open(bind, port):
            break
        # 早期終了した場合は待っても意味がない
        if _ENGINE_PROC.poll() is not None:
            logger.warning("Engine server exited early (code=%s)", _ENGINE_PROC.returncode)
            _ENGINE_PROC = None
            return None
        time.sleep(0.2)

    if not _port_open(bind, port):
        logger.warning("Engine server did not become ready within %.1fs (%s:%s)", timeout_sec, bind, port)

    def _stop():
        global _ENGINE_PROC
        p = _ENGINE_PROC
        _ENGINE_PROC = None
        if p is None:
            return
        try:
            p.terminate()
        except Exception:
            pass

    atexit.register(_stop)
    logger.info("Engine server started (pid=%s) at %s:%s", getattr(_ENGINE_PROC, "pid", None), bind, port)
    return _ENGINE_PROC
