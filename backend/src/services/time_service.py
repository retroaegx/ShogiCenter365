"""
時間管理サービス

将棋の持ち時間と秒読みの管理
"""

import threading
import time
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, Callable
import logging

from src.models.database import DatabaseManager
from src.config import TIME_CONTROLS

logger = logging.getLogger(__name__)


class GameTimer:
    """個別ゲームの時間管理"""
    
    def __init__(self, game_id: str, time_control: str, callback: Optional[Callable] = None):
        self.game_id = game_id
        self.time_control = time_control
        info = TIME_CONTROLS.get(time_control)
        if not info:
            raise ValueError(f"Unknown time_control: {time_control}")
        self.time_control_info = info
        self.callback = callback
        
        # 時間状態
        self.sente_time_left = self.time_control_info['initial_time']
        self.gote_time_left = self.time_control_info['initial_time']
        self.sente_byoyomi_count = 0
        self.gote_byoyomi_count = 0
        
        # タイマー状態
        self.current_player = 'sente'
        self.is_running = False
        self.is_in_byoyomi = False
        self.move_start_time = None
        self.timer_thread = None
        self.stop_event = threading.Event()
        
        # 秒読み設定
        self.byoyomi_time = self.time_control_info['byoyomi_time']
        self.grace_period = 3  # 秒読み後の猶予時間（3秒）
    
    def start_timer(self, player: str):
        """指定プレイヤーの時間計測開始"""
        try:
            if self.is_running:
                self.stop_timer()
            
            self.current_player = player
            self.is_running = True
            self.move_start_time = datetime.utcnow()
            
            # タイマースレッド開始
            self.timer_thread = threading.Thread(target=self._timer_loop)
            self.timer_thread.daemon = True
            self.timer_thread.start()
            
            logger.info(f"タイマー開始: game {self.game_id}, player {player}")
            
        except Exception as e:
            logger.error(f"タイマー開始エラー: {e}")
    
    def stop_timer(self):
        """時間計測停止"""
        try:
            if not self.is_running:
                return
            
            self.is_running = False
            self.stop_event.set()
            
            if self.timer_thread and self.timer_thread.is_alive():
                self.timer_thread.join(timeout=1.0)
            
            # 使用時間を計算して減算
            if self.move_start_time:
                elapsed = (datetime.utcnow() - self.move_start_time).total_seconds()
                self._consume_time(elapsed)
            
            self.move_start_time = None
            self.stop_event.clear()
            
            logger.info(f"タイマー停止: game {self.game_id}")
            
        except Exception as e:
            logger.error(f"タイマー停止エラー: {e}")
    
    def switch_player(self, next_player: str):
        """プレイヤー切り替え"""
        try:
            if self.is_running:
                # 現在のプレイヤーの時間を更新
                if self.move_start_time:
                    elapsed = (datetime.utcnow() - self.move_start_time).total_seconds()
                    self._consume_time(elapsed)
                
                # 次のプレイヤーに切り替え
                self.current_player = next_player
                self.move_start_time = datetime.utcnow()
                self.is_in_byoyomi = False
                
                # 秒読み状態をリセット
                if next_player == 'sente':
                    self.sente_byoyomi_count = 0
                else:
                    self.gote_byoyomi_count = 0
                
                logger.info(f"プレイヤー切り替え: game {self.game_id}, next {next_player}")
            
        except Exception as e:
            logger.error(f"プレイヤー切り替えエラー: {e}")
    
    def _consume_time(self, elapsed_seconds: float):
        """時間を消費"""
        try:
            if self.current_player == 'sente':
                if self.sente_time_left > 0:
                    # 持ち時間から消費
                    self.sente_time_left = max(0, self.sente_time_left - elapsed_seconds)
                else:
                    # 秒読み中
                    self.is_in_byoyomi = True
                    if elapsed_seconds > self.byoyomi_time + self.grace_period:
                        self.sente_byoyomi_count += 1
            else:
                if self.gote_time_left > 0:
                    # 持ち時間から消費
                    self.gote_time_left = max(0, self.gote_time_left - elapsed_seconds)
                else:
                    # 秒読み中
                    self.is_in_byoyomi = True
                    if elapsed_seconds > self.byoyomi_time + self.grace_period:
                        self.gote_byoyomi_count += 1
            
        except Exception as e:
            logger.error(f"時間消費エラー: {e}")
    
    def _timer_loop(self):
        """タイマーループ"""
        try:
            while self.is_running and not self.stop_event.is_set():
                time.sleep(1)  # 1秒間隔で更新
                
                if not self.is_running or not self.move_start_time:
                    continue
                
                # 経過時間計算
                elapsed = (datetime.utcnow() - self.move_start_time).total_seconds()
                current_time_left = self._get_current_time_left()
                
                # 時間切れチェック
                if self._is_time_up(elapsed):
                    self._handle_timeout()
                    break
                
                # 秒読み開始チェック
                if current_time_left <= 0 and not self.is_in_byoyomi:
                    self.is_in_byoyomi = True
                    if self.callback:
                        self.callback('byoyomi_start', {
                            'game_id': self.game_id,
                            'player': self.current_player
                        })
                
                # 時間更新通知（10秒間隔）
                if int(elapsed) % 10 == 0 and self.callback:
                    self.callback('time_update', {
                        'game_id': self.game_id,
                        'time_state': self.get_time_state()
                    })
            
        except Exception as e:
            logger.error(f"タイマーループエラー: {e}")
    
    def _get_current_time_left(self) -> float:
        """現在のプレイヤーの残り時間取得"""
        if self.current_player == 'sente':
            return self.sente_time_left
        else:
            return self.gote_time_left
    
    def _is_time_up(self, elapsed: float) -> bool:
        """時間切れかどうかチェック"""
        current_time_left = self._get_current_time_left()
        
        if current_time_left > 0:
            # 持ち時間中
            return False
        else:
            # 秒読み中
            return elapsed > self.byoyomi_time + self.grace_period
    
    def _handle_timeout(self):
        """時間切れ処理"""
        try:
            self.is_running = False
            
            if self.callback:
                self.callback('timeout', {
                    'game_id': self.game_id,
                    'player': self.current_player,
                    'winner': 'gote' if self.current_player == 'sente' else 'sente'
                })
            
            logger.info(f"時間切れ: game {self.game_id}, player {self.current_player}")
            
        except Exception as e:
            logger.error(f"時間切れ処理エラー: {e}")
    
    def get_time_state(self) -> Dict[str, Any]:
        """現在の時間状態取得"""
        try:
            # 現在の経過時間を考慮した残り時間計算
            current_elapsed = 0
            if self.is_running and self.move_start_time:
                current_elapsed = (datetime.utcnow() - self.move_start_time).total_seconds()
            
            # 現在のプレイヤーの残り時間を調整
            sente_display_time = self.sente_time_left
            gote_display_time = self.gote_time_left
            
            if self.is_running and self.current_player == 'sente':
                sente_display_time = max(0, self.sente_time_left - current_elapsed)
            elif self.is_running and self.current_player == 'gote':
                gote_display_time = max(0, self.gote_time_left - current_elapsed)
            
            return {
                'sente_time_left': sente_display_time,
                'gote_time_left': gote_display_time,
                'sente_byoyomi_count': self.sente_byoyomi_count,
                'gote_byoyomi_count': self.gote_byoyomi_count,
                'current_player': self.current_player,
                'is_running': self.is_running,
                'is_in_byoyomi': self.is_in_byoyomi,
                'byoyomi_time': self.byoyomi_time,
                'time_control': self.time_control_info
            }
            
        except Exception as e:
            logger.error(f"時間状態取得エラー: {e}")
            return {}
    
    def pause(self):
        """タイマー一時停止"""
        if self.is_running:
            self.stop_timer()
    
    def resume(self):
        """タイマー再開"""
        if not self.is_running:
            self.start_timer(self.current_player)
    
    def add_time(self, player: str, seconds: int):
        """時間追加（切れ負け救済など）"""
        try:
            if player == 'sente':
                self.sente_time_left += seconds
            else:
                self.gote_time_left += seconds
            
            logger.info(f"時間追加: game {self.game_id}, player {player}, +{seconds}秒")
            
        except Exception as e:
            logger.error(f"時間追加エラー: {e}")


class TimeService:
    """時間管理サービス"""
    
    def __init__(self, db_manager: DatabaseManager):
        self.db_manager = db_manager
        self.game_model = db_manager.get_game_model()
        
        # アクティブなタイマー管理
        self.active_timers: Dict[str, GameTimer] = {}
        
        # コールバック関数
        self.event_callbacks: Dict[str, Callable] = {}
    
    def register_callback(self, event_type: str, callback: Callable):
        """イベントコールバック登録"""
        self.event_callbacks[event_type] = callback
    
    def create_timer(self, game_id: str, time_control: str) -> bool:
        """ゲーム用タイマー作成"""
        try:
            if game_id in self.active_timers:
                # 既存のタイマーを停止
                self.stop_timer(game_id)
            
            # 新しいタイマー作成
            timer = GameTimer(
                game_id=game_id,
                time_control=time_control,
                callback=self._handle_timer_event
            )
            
            self.active_timers[game_id] = timer
            
            logger.info(f"タイマー作成: game {game_id}, control {time_control}")
            return True
            
        except Exception as e:
            logger.error(f"タイマー作成エラー: {e}")
            return False
    
    def start_timer(self, game_id: str, player: str) -> bool:
        """タイマー開始"""
        try:
            if game_id not in self.active_timers:
                logger.warning(f"タイマーが見つかりません: game {game_id}")
                return False
            
            timer = self.active_timers[game_id]
            timer.start_timer(player)
            
            return True
            
        except Exception as e:
            logger.error(f"タイマー開始エラー: {e}")
            return False
    
    def stop_timer(self, game_id: str) -> bool:
        """タイマー停止"""
        try:
            if game_id not in self.active_timers:
                return True
            
            timer = self.active_timers[game_id]
            timer.stop_timer()
            
            return True
            
        except Exception as e:
            logger.error(f"タイマー停止エラー: {e}")
            return False
    
    def switch_player(self, game_id: str, next_player: str) -> bool:
        """プレイヤー切り替え"""
        try:
            if game_id not in self.active_timers:
                logger.warning(f"タイマーが見つかりません: game {game_id}")
                return False
            
            timer = self.active_timers[game_id]
            timer.switch_player(next_player)
            
            return True
            
        except Exception as e:
            logger.error(f"プレイヤー切り替えエラー: {e}")
            return False
    
    def get_time_state(self, game_id: str) -> Optional[Dict[str, Any]]:
        """時間状態取得"""
        try:
            if game_id not in self.active_timers:
                return None
            
            timer = self.active_timers[game_id]
            return timer.get_time_state()
            
        except Exception as e:
            logger.error(f"時間状態取得エラー: {e}")
            return None
    
    def pause_timer(self, game_id: str) -> bool:
        """タイマー一時停止"""
        try:
            if game_id not in self.active_timers:
                return False
            
            timer = self.active_timers[game_id]
            timer.pause()
            
            return True
            
        except Exception as e:
            logger.error(f"タイマー一時停止エラー: {e}")
            return False
    
    def resume_timer(self, game_id: str) -> bool:
        """タイマー再開"""
        try:
            if game_id not in self.active_timers:
                return False
            
            timer = self.active_timers[game_id]
            timer.resume()
            
            return True
            
        except Exception as e:
            logger.error(f"タイマー再開エラー: {e}")
            return False
    
    def add_time(self, game_id: str, player: str, seconds: int) -> bool:
        """時間追加"""
        try:
            if game_id not in self.active_timers:
                return False
            
            timer = self.active_timers[game_id]
            timer.add_time(player, seconds)
            
            return True
            
        except Exception as e:
            logger.error(f"時間追加エラー: {e}")
            return False
    
    def remove_timer(self, game_id: str):
        """タイマー削除"""
        try:
            if game_id in self.active_timers:
                timer = self.active_timers[game_id]
                timer.stop_timer()
                del self.active_timers[game_id]
                
                logger.info(f"タイマー削除: game {game_id}")
            
        except Exception as e:
            logger.error(f"タイマー削除エラー: {e}")
    
    def _handle_timer_event(self, event_type: str, event_data: Dict):
        """タイマーイベント処理"""
        try:
            if event_type == 'timeout':
                # 時間切れ処理
                self._handle_timeout(event_data)
            elif event_type == 'byoyomi_start':
                # 秒読み開始処理
                self._handle_byoyomi_start(event_data)
            elif event_type == 'time_update':
                # 時間更新処理
                self._handle_time_update(event_data)
            
            # 登録されたコールバックを呼び出し
            if event_type in self.event_callbacks:
                self.event_callbacks[event_type](event_data)
            
        except Exception as e:
            logger.error(f"タイマーイベント処理エラー: {e}")
    
    def _handle_timeout(self, event_data: Dict):
        """時間切れ処理"""
        try:
            game_id = event_data['game_id']
            winner = event_data['winner']
            
            # ゲーム終了処理
            update_data = {
                'status': 'finished',
                'result': {
                    'winner': winner,
                    'reason': 'timeout',
                    'finished_at': datetime.utcnow().isoformat()
                }
            }
            
            self.game_model.update_game(game_id, update_data)
            
            # タイマー削除
            self.remove_timer(game_id)
            
            logger.info(f"時間切れによるゲーム終了: game {game_id}, winner {winner}")
            
        except Exception as e:
            logger.error(f"時間切れ処理エラー: {e}")
    
    def _handle_byoyomi_start(self, event_data: Dict):
        """秒読み開始処理"""
        try:
            game_id = event_data['game_id']
            player = event_data['player']
            
            logger.info(f"秒読み開始: game {game_id}, player {player}")
            
        except Exception as e:
            logger.error(f"秒読み開始処理エラー: {e}")
    
    def _handle_time_update(self, event_data: Dict):
        """時間更新処理"""
        try:
            game_id = event_data['game_id']
            time_state = event_data['time_state']
            
            # データベースの時間情報を更新
            update_data = {
                'time_state': time_state,
                'last_time_update': datetime.utcnow().isoformat()
            }
            
            self.game_model.update_game(game_id, update_data)
            
        except Exception as e:
            logger.error(f"時間更新処理エラー: {e}")
    
    def get_all_active_timers(self) -> Dict[str, Dict]:
        """全アクティブタイマー状態取得"""
        try:
            timer_states = {}
            for game_id, timer in self.active_timers.items():
                timer_states[game_id] = timer.get_time_state()
            
            return timer_states
            
        except Exception as e:
            logger.error(f"全タイマー状態取得エラー: {e}")
            return {}
    
    def cleanup_finished_games(self):
        """終了したゲームのタイマーをクリーンアップ"""
        try:
            finished_games = []
            
            for game_id in list(self.active_timers.keys()):
                game = self.game_model.get_game(game_id)
                if not game or game.get('status') != 'active':
                    finished_games.append(game_id)
            
            for game_id in finished_games:
                self.remove_timer(game_id)
            
            if finished_games:
                logger.info(f"タイマークリーンアップ: {len(finished_games)}件")
            
        except Exception as e:
            logger.error(f"タイマークリーンアップエラー: {e}")
