# -*- coding: utf-8 -*-
"""Handicap (駒落ち) helpers.

This module centralizes handicap normalization and SFEN transformation.

Design notes:
- We treat the "upper" player as the one who starts waiting (host) and
  remove pieces from the upper player's side.
- SFEN orientation:
  - Uppercase = sente, lowercase = gote
  - board[0] is gote camp (top rank), board[8] is sente camp (bottom rank)
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from src.services.game_service import DEFAULT_START_SFEN, _build_sfen, _parse_sfen


# Canonical handicap codes used across backend/frontend.
HANDICAP_CODES = {
    'even_lower_first',
    'lance',
    'double_lance',
    'bishop',
    'rook',
    'rook_lance',
    'rook_double_lance',
    'two_piece',
    'four_piece',
    'six_piece',
    'eight_piece',
    'ten_piece',
}


_ALIAS: Dict[str, str] = {
    # Japanese labels
    '平手（下位者先手）': 'even_lower_first',
    '平手(下位者先手)': 'even_lower_first',
    '平手': 'even_lower_first',
    '香落ち': 'lance',
    '両香落ち': 'double_lance',
    '角落ち': 'bishop',
    '飛落ち': 'rook',
    '飛車落ち': 'rook',
    '飛香落ち': 'rook_lance',
    '飛両香落ち': 'rook_double_lance',
    '二枚落ち': 'two_piece',
    '四枚落ち': 'four_piece',
    '六枚落ち': 'six_piece',
    '八枚落ち': 'eight_piece',
    '十枚落ち': 'ten_piece',
    # Common variants
    '2枚落ち': 'two_piece',
    '4枚落ち': 'four_piece',
    '6枚落ち': 'six_piece',
    '8枚落ち': 'eight_piece',
    '10枚落ち': 'ten_piece',
    # English-ish
    'even': 'even_lower_first',
    'even_lower': 'even_lower_first',
    'even_lower_first': 'even_lower_first',
    'kyosha': 'lance',
    'lance': 'lance',
    'double_lance': 'double_lance',
    'kaku': 'bishop',
    'bishop': 'bishop',
    'hisha': 'rook',
    'rook': 'rook',
    'rook_lance': 'rook_lance',
    'rook_double_lance': 'rook_double_lance',
    'two_piece': 'two_piece',
    'four_piece': 'four_piece',
    'six_piece': 'six_piece',
    'eight_piece': 'eight_piece',
    'ten_piece': 'ten_piece',
}


def normalize_handicap_type(raw: object) -> Optional[str]:
    """Return canonical handicap code or None."""
    if raw is None:
        return None
    try:
        s = str(raw).strip()
    except Exception:
        return None
    if not s:
        return None

    # Normalize simple bracket variants.
    s = s.replace('（', '(').replace('）', ')')

    v = _ALIAS.get(s)
    if v in HANDICAP_CODES:
        return v

    # Lowercase search
    s2 = s.lower().strip()
    v = _ALIAS.get(s2)
    if v in HANDICAP_CODES:
        return v

    return s2 if s2 in HANDICAP_CODES else None


# Squares (rank, fileIndex) from SFEN-parsed board.
# fileIndex is 0..8 corresponding to file 9..1.
_SQ: Dict[str, Dict[str, Tuple[int, int]]] = {
    'sente': {
        'left_lance': (8, 0),
        'right_lance': (8, 8),
        'left_knight': (8, 1),
        'right_knight': (8, 7),
        'left_silver': (8, 2),
        'right_silver': (8, 6),
        'left_gold': (8, 3),
        'right_gold': (8, 5),
        'bishop': (7, 1),
        'rook': (7, 7),
    },
    'gote': {
        'left_lance': (0, 8),
        'right_lance': (0, 0),
        'left_knight': (0, 7),
        'right_knight': (0, 1),
        'left_silver': (0, 6),
        'right_silver': (0, 2),
        'left_gold': (0, 5),
        'right_gold': (0, 3),
        'bishop': (1, 7),
        'rook': (1, 1),
    },
}


_DEF: Dict[str, List[str]] = {
    # special (no piece removal)
    'even_lower_first': [],
    # piece handicaps
    'lance': ['left_lance'],
    'double_lance': ['left_lance', 'right_lance'],
    'bishop': ['bishop'],
    'rook': ['rook'],
    'rook_lance': ['rook', 'left_lance'],
    'rook_double_lance': ['rook', 'left_lance', 'right_lance'],
    'two_piece': ['rook', 'bishop'],
    'four_piece': ['rook', 'bishop', 'left_lance', 'right_lance'],
    'six_piece': ['rook', 'bishop', 'left_lance', 'right_lance', 'left_knight', 'right_knight'],
    'eight_piece': ['rook', 'bishop', 'left_lance', 'right_lance', 'left_knight', 'right_knight', 'left_silver', 'right_silver'],
    'ten_piece': ['rook', 'bishop', 'left_lance', 'right_lance', 'left_knight', 'right_knight', 'left_silver', 'right_silver', 'left_gold', 'right_gold'],
}


def apply_handicap_to_sfen(
    start_sfen: Optional[str],
    *,
    upper_role: str,
    handicap_type: str,
) -> Optional[str]:
    """Apply handicap by removing upper player's pieces from start SFEN.

    upper_role: 'sente' or 'gote'
    handicap_type: canonical code (see HANDICAP_CODES)

    Returns a new SFEN, or the original start_sfen if transformation fails.
    """
    base = (start_sfen or DEFAULT_START_SFEN).strip() if isinstance(start_sfen, str) else DEFAULT_START_SFEN
    ht = normalize_handicap_type(handicap_type)
    if not ht:
        return base
    if ht == 'even_lower_first':
        return base

    side = 'sente' if str(upper_role) == 'sente' else 'gote'

    state = _parse_sfen(base)
    if not state:
        return base

    board = state.get('board')
    hands = state.get('hands')
    if not isinstance(board, list) or not isinstance(hands, dict):
        return base

    keys = _DEF.get(ht) or []
    sq_map = _SQ.get(side) or {}

    for k in keys:
        sq = sq_map.get(k)
        if not sq:
            continue
        r, c = sq
        try:
            if 0 <= r < 9 and 0 <= c < 9:
                board[r][c] = None
        except Exception:
            continue

    # Always start with sente to move, ply=1.
    built = _build_sfen(board, 'sente', hands, 1)
    return built or base
