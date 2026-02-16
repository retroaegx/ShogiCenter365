import { t } from '@/i18n'

// Lobby related error codes returned from backend.
// Dictionary-only: do not show server-provided fallback text.

const INVITE_ERROR_CODE_TO_KEY = {
  "banned": "lobby.invite.error.banned",
  "broken": "lobby.invite.error.broken",
  "expired": "lobby.invite.error.expired",
  "maintenance_mode": "lobby.invite.error.maintenance_mode",
  "not_found": "lobby.invite.error.not_found",
  "not_seeking": "lobby.invite.error.not_seeking",
  "token_failed": "lobby.invite.error.token_failed",
}

const LOBBY_JOIN_ERROR_CODE_TO_KEY = {
  "banned": "lobby.join.error.banned",
  "invalid_opponent": "lobby.join.error.invalid_opponent",
  "invalid_opponent_user_id": "lobby.join.error.invalid_opponent",
  "invalid_time_code": "lobby.join.error.invalid_time_code",
  "maintenance_mode": "lobby.join.error.maintenance_mode",
  "opponent_banned": "lobby.join.error.opponent_banned",
  "opponent_not_waiting": "lobby.join.error.opponent_not_waiting",
  "rating_gap_too_large": "lobby.join.error.rating_gap_too_large",
  "self_not_in_lobby": "lobby.join.error.self_not_in_lobby",
  "self_request_not_allowed": "lobby.join.error.self_request_not_allowed",
  "time_code_required": "lobby.join.error.invalid_time_code",
}

const LOBBY_OFFER_ERROR_CODE_TO_KEY = {
  "already_playing": "lobby.offer.error.already_started",
  "already_started": "lobby.offer.error.already_started",
  "banned": "lobby.offer.error.banned",
  "maintenance_mode": "lobby.offer.error.maintenance_mode",
  "no_pending_offer": "lobby.offer.error.no_pending_offer",
  "not_applicant": "lobby.offer.error.not_applicant",
  "opponent_banned": "lobby.offer.error.opponent_banned",
  "rating_gap_too_large": "lobby.offer.error.rating_gap_too_large",
}

export function inviteErrorMessage(errorCode, _fallbackMessage) {
  const code = typeof errorCode === 'string' ? errorCode.trim() : ''
  const key = INVITE_ERROR_CODE_TO_KEY[code] || 'lobby.invite.error.default'
  return t(key)
}

/**
 * /lobby/join-by-user and similar actions.
 * data may include allowed_min/allowed_max etc.
 */
export function lobbyJoinErrorMessage(errorCode, data = null, _fallbackMessage = '', _defaultMessage = null) {
  const code = String(errorCode || '').trim()

  if (code === 'rating_out_of_range') {
    const mn = data?.allowed_min
    const mx = data?.allowed_max
    if (mn !== undefined && mx !== undefined && mn !== null && mx !== null) {
      return t('lobby.join.error.rating_out_of_range_range', { mn, mx })
    }
    return t('lobby.join.error.rating_out_of_range')
  }

  const key = LOBBY_JOIN_ERROR_CODE_TO_KEY[code] || 'lobby.join.error.default'
  return t(key)
}

/**
 * /lobby/offer/accept /decline /cancel.
 */
export function lobbyOfferErrorMessage(errorCode, data = null, _fallbackMessage = '', _defaultMessage = null) {
  const code = String(errorCode || '').trim()

  if (code === 'rating_out_of_range') {
    const mn = data?.allowed_min
    const mx = data?.allowed_max
    if (mn !== undefined && mx !== undefined && mn !== null && mx !== null) {
      return t('lobby.offer.error.rating_out_of_range_range', { mn, mx })
    }
    return t('lobby.offer.error.rating_out_of_range')
  }

  const key = LOBBY_OFFER_ERROR_CODE_TO_KEY[code] || 'lobby.offer.error.default'
  return t(key)
}
