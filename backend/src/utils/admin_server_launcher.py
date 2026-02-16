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

_ADMIN_PROC: Optional[subprocess.Popen] = None


def _port_open(host: str, port: int) -> bool:
    # When binding to 0.0.0.0/::, probe via loopback.
    test_host = host
    if host in ("0.0.0.0", "::", "0:0:0:0:0:0:0:0"):
        test_host = "127.0.0.1"
    try:
        with socket.create_connection((test_host, port), timeout=0.3):
            return True
    except Exception:
        return False


def start_admin_server_process() -> Optional[subprocess.Popen]:
    """内部向け管理サイト（Flask）をサブプロセスで起動する。"""
    global _ADMIN_PROC
    if _ADMIN_PROC is not None:
        return _ADMIN_PROC

    enabled = os.getenv("ADMIN_SITE_ENABLED", "1").strip()
    if enabled in ("0", "false", "False", "no", "NO"):
        logger.info("Admin site disabled (ADMIN_SITE_ENABLED=%s)", enabled)
        return None

    username = os.getenv("ADMIN_SITE_USERNAME", "").strip()
    password = os.getenv("ADMIN_SITE_PASSWORD", "").strip()
    if not username or not password:
        logger.warning("Admin site credentials not set; skipping start (set ADMIN_SITE_USERNAME/ADMIN_SITE_PASSWORD)")
        return None

    host = os.getenv("ADMIN_SITE_BIND", "127.0.0.1")
    port = int(os.getenv("ADMIN_SITE_PORT", "5003"))

    # If already running, don't spawn.
    if _port_open(host, port):
        logger.info("Admin site already listening on %s:%s", host, port)
        return None

    repo_root = Path(__file__).resolve().parents[3]  # .../shogi-complete
    script = repo_root / "admin_server.py"
    if not script.exists():
        logger.warning("admin_server.py not found: %s", script)
        return None

    cmd = [sys.executable, "-u", str(script), "--host", host, "--port", str(port)]
    env = os.environ.copy()

    try:
        _ADMIN_PROC = subprocess.Popen(cmd, cwd=str(repo_root), env=env)
    except Exception as e:
        logger.warning("Failed to start admin site: %s", e, exc_info=True)
        _ADMIN_PROC = None
        return None

    # Wait for port open (best-effort)
    timeout_sec = float(os.getenv("ADMIN_SITE_STARTUP_TIMEOUT_SEC", "5"))
    t0 = time.time()
    while time.time() - t0 < timeout_sec:
        if _port_open(host, port):
            break
        time.sleep(0.1)

    def _cleanup():
        global _ADMIN_PROC
        if _ADMIN_PROC is None:
            return
        try:
            _ADMIN_PROC.terminate()
            _ADMIN_PROC.wait(timeout=3)
        except Exception:
            try:
                _ADMIN_PROC.kill()
            except Exception:
                pass
        _ADMIN_PROC = None

    atexit.register(_cleanup)
    return _ADMIN_PROC
