import api from '@/services/apiClient'
import { userErrorMessage } from '@/i18n/userErrors'

// Simple in-memory cache (tab-local). Keeps the lobby/header hover cards snappy.
const CACHE = new Map()
const DEFAULT_TTL_MS = 30_000

/**
 * Fetch a user's public profile for UI overlays.
 *
 * Response shape (backend):
 *   { profile: { id, username, rating, wins, losses, draws, games_played, win_rate } }
 */
export async function fetchUserPublicProfile(userId, opts = {}) {
  const id = (userId == null) ? '' : String(userId)
  if (!id) throw new Error(userErrorMessage('invalid_user_id'))

  const { force = false, ttlMs = DEFAULT_TTL_MS } = opts || {}
  const now = Date.now()

  const cached = CACHE.get(id)
  if (!force && cached && cached.profile && (now - cached.fetchedAt) < ttlMs) {
    return cached.profile
  }

  let res
  try {
    res = await api.get(`/user/public/${encodeURIComponent(id)}`)
  } catch (e) {
    const data = e?.response?.data
    const code = data?.error_code
    throw new Error(userErrorMessage(code, data?.message || e?.message || String(e)))
  }
  const profile = res?.data?.profile || null
  if (!profile) throw new Error(userErrorMessage('profile_not_found'))

  CACHE.set(id, { profile, fetchedAt: now })
  return profile
}

export function clearUserPublicProfileCache() {
  CACHE.clear()
}
