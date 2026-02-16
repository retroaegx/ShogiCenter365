import { t } from '@/i18n'

/**
 * Map backend game `error_code` -> localized message key.
 *
 * Dictionary-only:
 * - We do not show server-provided fallback text.
 */
const GAME_ERROR_CODE_TO_KEY = {
  "forbidden": "game.error.forbidden",
  "invalid_sfen": "game.error.invalid_sfen",
  "invalid_target_user_id": "game.error.invalid_target_user_id",
  "no_active_game": "game.error.no_active_game",
  "not_active": "game.error.not_active",
  "not_found": "game.error.not_found",
  "not_your_turn": "game.error.not_your_turn",
  "payload_error": "game.error.payload_error",
  "self_not_in_lobby": "game.error.self_not_in_lobby",
  "service_unavailable": "game.error.service_unavailable",
  "target_user_id_required": "game.error.target_user_id_required",
}

export function gameErrorMessage(errorCode, _fallbackMessage = '', _defaultMessage = null) {
  const code = String(errorCode || '').trim()
  const key = GAME_ERROR_CODE_TO_KEY[code] || 'game.error.default'
  return t(key)
}
