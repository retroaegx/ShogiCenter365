# -*- coding: utf-8 -*-
"""小さなユーティリティ: 非同期/同期を気にせず呼び出すためのラッパー。Flask[async]不要。"""
from __future__ import annotations

import inspect
import asyncio

def run_maybe_awaitable(func, *args, **kwargs):
    """func(*args, **kwargs) がコルーチンなら asyncio.run() で実行して結果を返す。
    同期関数ならそのまま返す。Flask側の ensure_sync を使わないので 'async extra' は不要。
    """
    result = func(*args, **kwargs)
    if inspect.isawaitable(result):
        # FlaskのWSGI環境では通常イベントループは走っていないはず
        return asyncio.run(result)
    return result
