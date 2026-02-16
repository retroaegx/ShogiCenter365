"""レーティングシステムサービス（SC24 風 + Elo 互換）

- 下限0・上限なし（SC24プロファイル）
- 帯および仮レート（対局数）で K を調整
- 旧API名もラッパで維持（後方互換）

このモジュールは `src.config` の下記設定を優先して参照します:
    RATING_SYSTEMS: 複数プロファイル（"sc24" / "elo" など）
    DEFAULT_RATING_SYSTEM: 既定システムキー（例: "sc24"）

上記が無い場合は、既存の `RATING_SYSTEM` をフォールバックとして使います。
"""

from __future__ import annotations
import math
from typing import Dict, Any, Optional, Tuple

from src.models.database import DatabaseManager
try:
    from src.config import RATING_SYSTEMS, DEFAULT_RATING_SYSTEM
except Exception:
    # 後方互換: 単一システムの設定しか無い環境を想定
    from src.config import RATING_SYSTEM as _LEGACY
    RATING_SYSTEMS = {
        "legacy": {
            "name": "Legacy",
            "initial_rating": _LEGACY.get("initial_rating", 1500),
            "k_base": _LEGACY.get("k_factor", 32),
            "min_rating": _LEGACY.get("min_rating", 0),
            "max_rating": _LEGACY.get("max_rating", None),
            "provisional_games": _LEGACY.get("provisional_games", 20),
            "k_bands": [],           # 帯なし
            "draw_factor": 0.5,
        }
    }
    DEFAULT_RATING_SYSTEM = "legacy"


class RatingService:
    """レーティング管理サービス"""

    def __init__(self, db_manager: DatabaseManager):
        self.db_manager = db_manager
        self.user_model = db_manager.get_user_model()

        # 複数システム対応（既定キーでフォールバック値も保持）
        self.systems: Dict[str, Dict[str, Any]] = RATING_SYSTEMS
        self.default_system: str = DEFAULT_RATING_SYSTEM
        base = self.systems[self.default_system]

        # 旧コード互換で参照するプロパティも残す
        self.initial_rating = base.get("initial_rating", 1500)
        self.k_factor = base.get("k_base", 32)  # 互換用（直接は使わない）
        self.min_rating = base.get("min_rating", 0)
        self.max_rating = base.get("max_rating", None)  # None は上限なし
        self.provisional_games = base.get("provisional_games", 20)

    # ================= 内部ユーティリティ =================

    def _pick_cfg(self, system_key: Optional[str]) -> Dict[str, Any]:
        key = system_key or self.default_system
        return self.systems.get(key, self.systems[self.default_system])

    def _expected(self, ra: float, rb: float) -> float:
        # Elo 期待値
        try:
            return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))
        except Exception:
            # 極端な差など数値例外時の安全弁
            if ra > rb:
                return 0.99
            return 0.01

    def _k_factor(self, cfg: Dict[str, Any], rating: float, games_played: int) -> float:
        # ベース
        k = float(cfg.get("k_base", 32))
        # 仮レート期間は大きめ（最低40）
        if games_played < int(cfg.get("provisional_games", 0)):
            k = max(k, 40.0)
        # 帯で調整（SC24 近似）
        bands = cfg.get("k_bands", [])
        last = k
        for band in bands:
            if "lt" in band and rating < band["lt"]:
                return float(band["k"])
            if "ge" in band and rating >= band["ge"]:
                last = float(band["k"])
        return last

    def _apply_bounds(self, cfg: Dict[str, Any], rating: float) -> float:
        # 下限0、上限は None なら無制限
        min_r = cfg.get("min_rating", 0) or 0
        rating = max(min_r, rating)
        max_r = cfg.get("max_rating", None)
        if isinstance(max_r, (int, float)):
            rating = min(max_r, rating)
        return rating

    # ================== 計算API（新） ==================

    def calculate_new_ratings(
        self,
        rating_a: int, rating_b: int,
        result: str,           # "win" / "loss" / "draw" （a視点）
        games_a: int = 0, games_b: int = 0,
        rating_system: Optional[str] = None
    ) -> Tuple[int, int]:
        """2人の新レーティングを返す（四捨五入）"""
        cfg = self._pick_cfg(rating_system)

        exp_a = self._expected(rating_a, rating_b)
        exp_b = self._expected(rating_b, rating_a)

        if result == "win":
            score_a, score_b = 1.0, 0.0
        elif result == "loss":
            score_a, score_b = 0.0, 1.0
        else:
            # draw
            score_a = score_b = float(cfg.get("draw_factor", 0.5))

        k_a = self._k_factor(cfg, rating_a, games_a)
        k_b = self._k_factor(cfg, rating_b, games_b)

        new_a = self._apply_bounds(cfg, rating_a + k_a * (score_a - exp_a))
        new_b = self._apply_bounds(cfg, rating_b + k_b * (score_b - exp_b))

        return int(round(new_a)), int(round(new_b))

    # ================== DB更新API ==================

    def update_ratings(self, winner_id: str, loser_id: str, result: str) -> Dict[str, Any]:
        """ユーザーIDで受け取り、DBを更新して変化を返す

        result: "win" / "loss" / "draw"
          - a.k.a 旧実装は "win" / "draw" しか受けなかったので拡張
        """
        try:
            winner = self.user_model.get_user_by_id(winner_id)
            loser = self.user_model.get_user_by_id(loser_id)
            if not winner or not loser:
                return {"success": False, "error_code": "user_not_found", "message": "ユーザーが見つかりません"}

            # 個別設定があれば優先。食い違いは既定にフォールバック
            sys_w = winner.get("rating_system")
            sys_l = loser.get("rating_system")
            sys_used = sys_w if sys_w and sys_w == sys_l else self.default_system

            ra = int(winner.get("rating", self.initial_rating))
            rb = int(loser.get("rating", self.initial_rating))
            ga = int(winner.get("games_played", 0))
            gb = int(loser.get("games_played", 0))

            # winner視点の result を前提に計算
            if result not in {"win", "loss", "draw"}:
                return {"success": False, "error_code": "invalid_result", "message": "無効な結果です"}

            new_w, new_l = self.calculate_new_ratings(
                ra, rb, result, games_a=ga, games_b=gb, rating_system=sys_used
            )

            # 差分
            delta_w = new_w - ra
            delta_l = new_l - rb

            # 反映
            self.user_model.update_rating(winner_id, new_w)
            self.user_model.update_rating(loser_id, new_l)

            # 統計
            if result == "win":
                self.user_model.update_game_stats(winner_id, "win")
                self.user_model.update_game_stats(loser_id, "loss")
            elif result == "loss":
                self.user_model.update_game_stats(loser_id, "win")
                self.user_model.update_game_stats(winner_id, "loss")
            else:
                self.user_model.update_game_stats(winner_id, "draw")
                self.user_model.update_game_stats(loser_id, "draw")

            return {
                "success": True,
                "message": "レーティングを更新しました",
                "rating_changes": {
                    "winner": {
                        "user_id": winner_id,
                        "old_rating": ra,
                        "new_rating": new_w,
                        "change": delta_w,
                    },
                    "loser": {
                        "user_id": loser_id,
                        "old_rating": rb,
                        "new_rating": new_l,
                        "change": delta_l,
                    },
                },
                "system_used": sys_used,
            }
        except Exception as e:
            return {"success": False, "error_code": "rating_update_failed", "message": "レーティング更新に失敗しました"}

    # ================== 統計 / 補助API ==================

    def calculate_expected_score(self, rating_a: int, rating_b: int) -> float:
        """後方互換（旧名）。内部の _expected を呼ぶ"""
        return self._expected(rating_a, rating_b)

    def calculate_new_rating(
        self,
        current_rating: int,
        expected_score: float,
        actual_score: float,
        games_played: int = 0,
        rating_system: Optional[str] = None
    ) -> int:
        """後方互換（旧の単体更新API）。期待値は引数をそのまま使う。
        
        計算式は新しい K/境界処理に置き換え。
        """
        cfg = self._pick_cfg(rating_system)
        k = self._k_factor(cfg, current_rating, games_played)
        new_rating = self._apply_bounds(cfg, current_rating + k * (actual_score - expected_score))
        return int(round(new_rating))

    def get_rating_statistics(self, user_id: str) -> Dict[str, Any]:
        try:
            user = self.user_model.get_user_by_id(user_id)
            if not user:
                return {"success": False, "error_code": "user_not_found", "message": "ユーザーが見つかりません"}

            rating = int(user.get("rating", self.initial_rating))
            games_played = int(user.get("games_played", 0))
            wins = int(user.get("wins", 0))
            losses = int(user.get("losses", 0))
            draws = int(user.get("draws", 0))

            win_rate = round((wins / games_played) * 100, 1) if games_played > 0 else 0.0
            rating_class = self._get_rating_class(rating)
            is_provisional = games_played < int(self.provisional_games)

            return {
                "success": True,
                "statistics": {
                    "rating": rating,
                    "rating_class": rating_class,
                    "is_provisional": is_provisional,
                    "games_played": games_played,
                    "wins": wins,
                    "losses": losses,
                    "draws": draws,
                    "win_rate": win_rate,
                    "provisional_games_remaining": max(0, int(self.provisional_games) - games_played),
                },
            }
        except Exception as e:
            return {"success": False, "error_code": "rating_stats_failed", "message": "統計の取得に失敗しました"}

    def _get_rating_class(self, rating: int) -> Dict[str, str]:
        # （元の区分けを踏襲）
        if rating >= 2800:
            return {'name': '竜王', 'color': '#FFD700'}
        elif rating >= 2600:
            return {'name': '名人', 'color': '#FF6B35'}
        elif rating >= 2400:
            return {'name': '九段', 'color': '#FF1744'}
        elif rating >= 2200:
            return {'name': '八段', 'color': '#E91E63'}
        elif rating >= 2000:
            return {'name': '七段', 'color': '#9C27B0'}
        elif rating >= 1800:
            return {'name': '六段', 'color': '#673AB7'}
        elif rating >= 1600:
            return {'name': '五段', 'color': '#3F51B5'}
        elif rating >= 1400:
            return {'name': '四段', 'color': '#2196F3'}
        elif rating >= 1200:
            return {'name': '三段', 'color': '#03A9F4'}
        elif rating >= 1000:
            return {'name': '二段', 'color': '#00BCD4'}
        elif rating >= 800:
            return {'name': '初段', 'color': '#009688'}
        elif rating >= 600:
            return {'name': '1級', 'color': '#4CAF50'}
        elif rating >= 400:
            return {'name': '2級', 'color': '#8BC34A'}
        elif rating >= 200:
            return {'name': '3級', 'color': '#CDDC39'}
        else:
            return {'name': '4級', 'color': '#FFC107'}

    def get_leaderboard(self, limit: int = 50) -> Dict[str, Any]:
        try:
            if getattr(self.db_manager, 'use_mongodb', False):
                pipeline = [
                    {'$match': {'games_played': {'$gte': int(self.provisional_games)}}},
                    {'$sort': {'rating': -1}},
                    {'$limit': int(limit)},
                    {'$project': {
                        'username': 1, 'rating': 1, 'games_played': 1,
                        'wins': 1, 'losses': 1, 'draws': 1
                    }}
                ]
                cursor = self.db_manager.db.users.aggregate(pipeline)
                users = list(cursor)
            else:
                users = []
                for user in self.db_manager.data.get('users', {}).values():
                    if int(user.get('games_played', 0)) >= int(self.provisional_games):
                        users.append({
                            'username': user.get('username'),
                            'rating': int(user.get('rating', self.initial_rating)),
                            'games_played': int(user.get('games_played', 0)),
                            'wins': int(user.get('wins', 0)),
                            'losses': int(user.get('losses', 0)),
                            'draws': int(user.get('draws', 0)),
                        })
                users.sort(key=lambda x: x['rating'], reverse=True)
                users = users[: int(limit)]

            for i, user in enumerate(users):
                user['rank'] = i + 1
                user['rating_class'] = self._get_rating_class(int(user['rating']))
                gp = int(user.get('games_played', 0))
                w = int(user.get('wins', 0))
                user['win_rate'] = round((w / gp) * 100, 1) if gp > 0 else 0.0

            return {'success': True, 'leaderboard': users, 'total_count': len(users)}
        except Exception as e:
            return {'success': False, 'error_code': 'leaderboard_fetch_failed', 'message': 'ランキング取得に失敗しました'}

    def get_rating_history(self, user_id: str, limit: int = 20) -> Dict[str, Any]:
        try:
            user = self.user_model.get_user_by_id(user_id)
            if not user:
                return {'success': False, 'error_code': 'user_not_found', 'message': 'ユーザーが見つかりません'}

            # DBに履歴が無い前提のモック（元の実装踏襲）
            current_rating = int(user.get('rating', self.initial_rating))
            games_played = int(user.get('games_played', 0))

            history = []
            rating = int(self.initial_rating)
            for i in range(min(games_played, int(limit))):
                change = (-20 + (i % 40)) if i % 3 == 0 else (10 - (i % 20))
                rating += change
                rating = int(self._apply_bounds(self._pick_cfg(None), rating))
                history.append({
                    'game_number': i + 1,
                    'rating': rating,
                    'change': change,
                    'date': '2024-10-01',  # モック
                })

            if history:
                history[-1]['rating'] = current_rating

            return {'success': True, 'history': history}
        except Exception as e:
            return {'success': False, 'error_code': 'rating_history_fetch_failed', 'message': '履歴取得に失敗しました'}

    def calculate_rating_difference_restriction(self, rating1: int, rating2: int, max_difference: int = 400) -> bool:
        return abs(int(rating1) - int(rating2)) <= int(max_difference)

    def get_recommended_opponents(self, user_id: str, limit: int = 10) -> Dict[str, Any]:
        try:
            user = self.user_model.get_user_by_id(user_id)
            if not user:
                return {'success': False, 'error_code': 'user_not_found', 'message': 'ユーザーが見つかりません'}

            user_rating = int(user.get('rating', self.initial_rating))
            rating_range = 200
            min_rating = user_rating - rating_range
            max_rating = user_rating + rating_range

            candidates = []
            if getattr(self.db_manager, 'use_mongodb', False):
                query = {
                    '_id': {'$ne': user_id},
                    'rating': {'$gte': min_rating, '$lte': max_rating},
                    'is_active': True
                }
                cursor = self.db_manager.db.users.find(query).limit(int(limit))
                candidates = list(cursor)
            else:
                for uid, cand in self.db_manager.data.get('users', {}).items():
                    if (uid != user_id
                        and min_rating <= int(cand.get('rating', self.initial_rating)) <= max_rating
                        and cand.get('is_active', True)):
                        candidates.append(cand)
                candidates = candidates[: int(limit)]

            for cand in candidates:
                cr = int(cand.get('rating', self.initial_rating))
                diff = abs(user_rating - cr)
                cand['recommendation_score'] = round(max(0.0, 100.0 - diff / 2.0), 1)
                cand['rating_difference'] = diff

            candidates.sort(key=lambda x: x['recommendation_score'], reverse=True)
            return {'success': True, 'recommended_opponents': candidates}
        except Exception as e:
            return {'success': False, 'error_code': 'recommended_opponents_fetch_failed', 'message': '推奨対戦相手の取得に失敗しました'}
