import { t } from './index'

// 将棋ロジックのエラーコード -> 表示文言（キー参照のみ）
const SHOGI_MOVE_ERROR_CODE_TO_KEY = {
  "cannot_drop_to": "shogi.move.error.cannot_drop_to",
  "cannot_move_to": "shogi.move.error.cannot_move_to",
  "cannot_promote": "shogi.move.error.cannot_promote",
  "invalid_move": "shogi.move.error.invalid_move",
  "must_escape_check": "shogi.move.error.must_escape_check",
  "no_piece_in_hand": "shogi.move.error.no_piece_in_hand",
}

export function shogiMoveErrorMessage(errorCode) {
  const code = String(errorCode || '').trim()
  const key = SHOGI_MOVE_ERROR_CODE_TO_KEY[code] || 'shogi.move.error.default'
  return t(key)
}
