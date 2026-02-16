import { t } from '@/i18n'

/**
 * Map backend auth `error_code` -> localized message key.
 *
 * Dictionary-only:
 * - We do not show server-provided fallback text.
 * - Missing keys render as empty (handled by t()).
 */
const AUTH_ERROR_CODE_TO_KEY = {
  "email_required": "auth.error.email_required",
  "email_send_failed": "auth.error.email_send_failed",
  "email_taken": "auth.error.email_taken",
  "email_unverified": "auth.error.email_unverified",
  "google_account_invalid": "auth.error.google_account_invalid",
  "google_token_verification_failed": "auth.error.google_token_verification_failed",
  "id_token_required": "auth.error.id_token_required",
  "invalid_credentials": "auth.error.invalid_credentials",
  "missing_credentials": "auth.error.missing_fields",
  "missing_fields": "auth.error.missing_fields",
  "password_need_digit": "auth.error.password_need_digit",
  "password_need_lower": "auth.error.password_need_lower",
  "password_need_upper": "auth.error.password_need_upper",
  "password_too_short": "auth.error.password_too_short",
  "rating_invalid": "auth.error.rating_invalid",
  "rating_out_of_range": "auth.error.rating_out_of_range",
  "rating_required": "auth.error.rating_required",
  "rating_step": "auth.error.rating_step",
  "signup_token_invalid_or_expired": "auth.error.signup_token_invalid_or_expired",
  "signup_token_required": "auth.error.signup_token_required",
  "smtp_not_configured": "auth.error.smtp_not_configured",
  "token_expired": "auth.error.token_expired",
  "token_invalid": "auth.error.token_invalid",
  "token_invalid_or_expired": "auth.error.token_invalid_or_expired",
  "token_payload_invalid": "auth.error.token_payload_invalid",
  "token_required": "auth.error.token_required",
  "token_revoked": "auth.error.token_invalid",
  "token_wrong_type": "auth.error.token_wrong_type",
  "username_invalid_chars": "auth.error.username_invalid_chars",
  "username_required": "auth.error.username_required",
  "username_taken": "auth.error.username_taken",
  "username_too_short": "auth.error.username_too_short",
}

export function authErrorMessage(errorCode, _fallbackMessage = '') {
  const code = String(errorCode || '').trim()
  const key = AUTH_ERROR_CODE_TO_KEY[code] || 'auth.error.default'
  return t(key)
}
