# -*- coding: utf-8 -*-

"""Warning word admin service."""

from __future__ import annotations

from typing import Any, Dict, List


class WarningWordService:
    def __init__(self, moderation=None):
        self.mod = moderation

    def list(self) -> List[Dict[str, Any]]:
        if self.mod is None:
            return []
        try:
            return list(self.mod.list_warning_words())
        except Exception:
            return []

    def add(self, word: str) -> Any:
        if self.mod is None:
            return None
        return self.mod.add_warning_word(word)

    def delete(self, word_id: Any) -> bool:
        if self.mod is None:
            return False
        return bool(self.mod.delete_warning_word(word_id))
