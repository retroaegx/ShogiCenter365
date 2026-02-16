"""SC24 (将棋倶楽部24) 風レーティング計算。

ユーザーから提示された「公式ページ記載ベース」の式を、DB更新に使える形で実装する。

前提:
  - 入力はすべて「この対局開始時点の値」（旧R / 対局数N / 相手R）。
  - 出力は整数（四捨五入）。

式:
  初期式（登録直後〜24局目まで）:
    新R = 旧R + ((相手R - 旧R) ± 400) / (N + 1)
    N = 通算対局数（この対局を含めた数）

    実装上の注意:
      - DBの `games_played` は「この対局開始前に完了した対局数」（0,1,2,...)。
      - 上式の N は 1 始まり（1局目は N=1）として扱う。
      - よって初期式の分母 (N+1) は `games_played + 2` になる。

  通常式（25局目以降）:
    新R = 旧R + ((相手R - 旧R) ± 400) / 25

付帯ルール（ユーザー提示）:
  - R>=2800 は対局数が少なくても通常式。
  - R<=200 は通常式で、負けの減りが通常の半分、かつ 0未満にならない。
  - 計算上「勝ってマイナス/0」「負けてプラス/0」になりそうなら下限（勝ち:+1 / 負け:-1）。
  - 通常式は 1局あたりの増減を +31 / -31 に制限。
  - 両者のR差が400以上の対局は、R計算しない。
  - R4000以上のアカウントが絡む対局は、R点も勝敗変動もしない。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Optional, Tuple

Result = Literal["win", "loss", "draw"]


@dataclass(frozen=True)
class RatingUpdate:
    old_rating: int
    new_rating: int
    delta: int
    formula: str  # "initial" / "normal" / "none"


def _round_half_away_from_zero(x: float) -> int:
    """Python の round は 0.5 を偶数丸めするので、四捨五入を明示する。"""
    if x >= 0:
        return int(math.floor(x + 0.5))
    return int(math.ceil(x - 0.5))


def should_skip_rating(
    rating_a: int,
    rating_b: int,
    games_a: int,
    games_b: int,
) -> Optional[str]:
    """レーティング計算をスキップする理由を返す。None なら計算する。"""
    try:
        ra = int(rating_a)
        rb = int(rating_b)
        ga = int(games_a)
        gb = int(games_b)
    except Exception:
        return "invalid_input"

    if ra >= 4000 or rb >= 4000:
        return "rating_account_4000"

    if abs(ra - rb) >= 400:
        return "rating_gap_400_or_more"

    return None


def _denominator(old_rating: int, games_played: int) -> Tuple[int, str]:
    """分母と式種別を返す。"""
    r = int(old_rating)
    n = int(games_played)
    if r >= 2800:
        return 25, "normal"
    if n < 24:
        # `games_played` は「対局開始前の通算対局数」(0,1,2,...)。
        # 公式説明での N は 1 始まり（1局目は N=1）として扱うため、
        # 初期式の分母 (N+1) は `games_played + 2`。
        return max(2, n + 2), "initial"
    return 25, "normal"


def compute_sc24_update(
    *,
    old_rating: int,
    opponent_rating: int,
    games_played: int,
    result: Result,
) -> RatingUpdate:
    """単体プレイヤーの更新量を返す。"""
    r0 = int(old_rating)
    ro = int(opponent_rating)
    n = int(games_played)

    # draw は仕様提示が無いので「変動なし」に寄せる
    if result == "draw":
        return RatingUpdate(old_rating=r0, new_rating=r0, delta=0, formula="none")

    denom, formula = _denominator(r0, n)
    bonus = 400 if result == "win" else -400
    num = (ro - r0) + bonus
    raw = num / float(denom)
    delta = _round_half_away_from_zero(raw)

    # 下限（勝ち:+1 / 負け:-1）
    if result == "win" and delta <= 0:
        delta = 1
    if result == "loss" and delta >= 0:
        delta = -1

    # 通常式の上限
    if denom == 25:
        delta = max(-31, min(31, int(delta)))

    # 低レート特例（通常式のみ）
    if denom == 25 and r0 <= 200 and result == "loss":
        # 「半分」: 減りを弱める方向（負数は ceil で 0 方向へ寄せる）
        if abs(delta) >= 2:
            delta = int(math.ceil(delta / 2.0))
        # ただし負け下限は維持
        if delta == 0:
            delta = -1

    r1 = r0 + int(delta)
    if r1 < 0:
        r1 = 0
        delta = -r0

    return RatingUpdate(old_rating=r0, new_rating=int(r1), delta=int(delta), formula=formula)


def compute_match_updates(
    *,
    sente_rating: int,
    gote_rating: int,
    sente_games: int,
    gote_games: int,
    winner_role: Literal["sente", "gote", "draw"],
) -> Tuple[RatingUpdate, RatingUpdate, Optional[str]]:
    """対局単位の更新（両者分）。

    Returns:
      (sente_update, gote_update, skip_reason)
    """
    if winner_role not in ("sente", "gote"):
        su = compute_sc24_update(old_rating=sente_rating, opponent_rating=gote_rating, games_played=sente_games, result="draw")
        gu = compute_sc24_update(old_rating=gote_rating, opponent_rating=sente_rating, games_played=gote_games, result="draw")
        return su, gu, None

    skip = should_skip_rating(sente_rating, gote_rating, sente_games, gote_games)
    if skip:
        # スキップ時は変動なし（ただし勝敗統計は別ロジックで処理）
        su = RatingUpdate(old_rating=int(sente_rating), new_rating=int(sente_rating), delta=0, formula="none")
        gu = RatingUpdate(old_rating=int(gote_rating), new_rating=int(gote_rating), delta=0, formula="none")
        return su, gu, skip

    if winner_role == "sente":
        su = compute_sc24_update(old_rating=sente_rating, opponent_rating=gote_rating, games_played=sente_games, result="win")
        gu = compute_sc24_update(old_rating=gote_rating, opponent_rating=sente_rating, games_played=gote_games, result="loss")
    else:
        su = compute_sc24_update(old_rating=sente_rating, opponent_rating=gote_rating, games_played=sente_games, result="loss")
        gu = compute_sc24_update(old_rating=gote_rating, opponent_rating=sente_rating, games_played=gote_games, result="win")

    return su, gu, None
