import { t } from '@/i18n'

/**
 * Map backend kifu `error_code` -> localized message key.
 *
 * Dictionary-only:
 * - We do not show server-provided fallback text.
 */
const KIFU_ERROR_CODE_TO_KEY = {
  "kifu_not_found": "kifu.error.not_found",
  "kifu_search_failed": "kifu.error.search_failed",
  "not_found": "kifu.error.not_found",
  "search_failed": "kifu.error.search_failed",
}

export function kifuErrorMessage(errorCode, _fallbackMessage = '', _defaultMessage = null) {
  const code = String(errorCode || '').trim()
  const key = KIFU_ERROR_CODE_TO_KEY[code] || 'kifu.error.default'
  return t(key)
}
