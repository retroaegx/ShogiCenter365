# このブロックを既存の GameService クラス内（class の末尾）に追記してください。
# 依存 import は不要（型注釈なし）。_normalize_doc があれば呼びますが、無ければスキップします。

def as_api_payload(self, doc, me):
    """フロント用に安全整形して返す。必ず players/captured/time_state を揃える。"""
    try:
        # あれば使う（なければ例外を握りつぶす）
        doc = self._normalize_doc(doc)  # type: ignore[attr-defined]
    except Exception:
        pass

    players = doc.get('players') if isinstance(doc.get('players'), dict) else {}
    cap = doc.get('captured') if isinstance(doc.get('captured'), dict) else {}
    ts  = doc.get('time_state') if isinstance(doc.get('time_state'), dict) else None

    # time_state がない場合は time_limit から合成
    if ts is None:
        tl = int(doc.get('time_limit') or 0)
        ts = {'time_limit': tl, 'sente': {'left_ms': tl * 1000}, 'gote': {'left_ms': tl * 1000}}

    # 役割判定
    role = None
    try:
        if str((players.get('sente') or {}).get('user_id')) == str(me):
            role = 'sente'
        if str((players.get('gote') or {}).get('user_id')) == str(me):
            role = 'gote'
    except Exception:
        role = None

    # board は board_state.board もフォールバック参照（初期化直後対策）
    board = doc.get('board')
    if board is None and isinstance(doc.get('board_state'), dict):
        board = (doc.get('board_state') or {}).get('board')

    return {
        'game_id': str(doc.get('_id')),
        'status': doc.get('status', 'ongoing'),
        'role': role,
        'players': {
            'sente': players.get('sente') or {},
            'gote':  players.get('gote')  or {},
        },
        'game_state': {
            'board': board,
            'captured': {
                'sente': cap.get('sente') or [],
                'gote':  cap.get('gote')  or [],
            },
            'current_turn': doc.get('current_turn', 'sente'),
            'move_history': doc.get('move_history', []),
        },
        'time_state': {
            'time_limit': int(ts.get('time_limit') or 0),
            'sente': {'left_ms': int((ts.get('sente') or {}).get('left_ms') or 0)},
            'gote':  {'left_ms': int((ts.get('gote')  or {}).get('left_ms') or 0)},
        },
        'chat': doc.get('chat_messages', []),
    }
