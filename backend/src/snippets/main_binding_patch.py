# main.py の GameService 生成直後に必ず貼ってください（固定バインド・フォールバック禁止）
from src.routes.game import init_game_routes
init_game_routes(app, gs)  # ★ 引数なし呼び出しは不可
