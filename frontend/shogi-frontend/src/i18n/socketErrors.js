import { t } from '@/i18n'

/**
 * Map WebSocket 'error' event codes -> localized message key.
 *
 * Dictionary-only:
 * - We do not show server-provided fallback text.
 */
const SOCKET_ERROR_CODE_TO_KEY = {
  "action_required": "socket.error.action_required",
  "chat_for_players_only": "socket.error.chat_for_players_only",
  "chat_not_allowed": "socket.error.chat_not_allowed",
  "game_id_and_text_required": "socket.error.game_id_and_text_required",
  "game_id_required": "socket.error.game_id_required",
  "game_not_found": "socket.error.game_not_found",
  "not_found": "socket.error.not_found",
  "players_only": "socket.error.players_only",
  "service_unavailable": "socket.error.service_unavailable",
  "shared_board_enable_required": "socket.error.shared_board_enable_required",
  "shared_board_postgame_only": "socket.error.shared_board_postgame_only",
  "unauthorized": "socket.error.unauthorized",
  "unknown_action": "socket.error.unknown_action",
  "username_required": "socket.error.username_required",
  "usi_required": "socket.error.usi_required",
}

export function socketErrorMessage(errorCode, _fallbackMessage = '', _defaultMessage = null) {
  const code = String(errorCode || '').trim()
  const key = SOCKET_ERROR_CODE_TO_KEY[code] || 'socket.error.default'
  return t(key)
}
