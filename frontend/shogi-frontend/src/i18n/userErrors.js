import { t } from '@/i18n'

/**
 * Map backend user `error_code` -> localized message key.
 *
 * Dictionary-only:
 * - We do not show server-provided fallback text.
 */
const USER_ERROR_CODE_TO_KEY = {
  "invalid_identity": "user.error.invalid_identity",
  "invalid_user_id": "user.error.invalid_user_id",
  "leaderboard_fetch_failed": "user.error.leaderboard_fetch_failed",
  "profile_not_found": "user.error.profile_not_found",
  "rating_history_fetch_failed": "user.error.rating_history_fetch_failed",
  "recommended_opponents_fetch_failed": "user.error.recommended_opponents_fetch_failed",
  "unauthorized": "user.error.unauthorized",
  "user_not_found": "user.error.user_not_found",
}

export function userErrorMessage(errorCode, _fallbackMessage) {
  const code = String(errorCode || '').trim()
  const key = USER_ERROR_CODE_TO_KEY[code] || 'user.error.default'
  return t(key)
}
