import apiNaming from '@/config/apiNaming'

// Patch window.fetch for /api/* requests.
// - Adds Authorization header from storage/cookie token (if present)
// - Defaults credentials to 'include'
// - Applies a compatibility remap for join-by-user payload keys
//
// Note: This module must not depend on language-specific strings.

(() => {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return

  const originalFetch = window.fetch
  const HEX24 = /^[0-9a-fA-F]{24}$/

  function readCookie(name) {
    try {
      const list = (typeof document !== 'undefined' && document.cookie)
        ? document.cookie.split(';')
        : []
      const prefix = name + '='
      for (let c of list) {
        c = c.trim()
        if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length))
      }
    } catch {}
    return null
  }

  function pickToken() {
    try {
      const ks = ['access_token', 'token', 'jwt', 'auth_token', 'authorization', 'Authorization']
      for (const k of ks) {
        const ls = (typeof localStorage !== 'undefined') ? localStorage.getItem(k) : null
        const ss = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem(k) : null
        const ck = readCookie(k)
        const v = ls || ss || ck
        if (v) return v
      }
    } catch {}
    return null
  }

  function extractHexId(v) {
    if (v == null) return null
    if (typeof v === 'string' && HEX24.test(v)) return v
    if (typeof v === 'object') {
      const cand =
        v.$oid || v['$oid'] || v.oid ||
        (v._id && (v._id.$oid || v._id['$oid'])) ||
        (v.user_id && (v.user_id.$oid || v.user_id['$oid']))
      if (typeof cand === 'string' && HEX24.test(cand)) return cand
    }
    return null
  }

  function parseMinutesLike(v) {
    if (v == null) return null
    if (typeof v === 'number' && Number.isFinite(v)) return v
    const s = String(v).trim()
    // Extract the first integer group, regardless of suffix.
    const m = s.match(/(\d+)/)
    if (!m) return null
    const n = parseInt(m[1], 10)
    return Number.isNaN(n) ? null : n
  }

  function isJoinByUser(url, init) {
    if (String(init?.method || 'GET').toUpperCase() !== 'POST') return false
    const path = apiNaming?.joinByUser?.path || '/lobby/join-by-user'
    return typeof url === 'string' && url.endsWith(path)
  }

  function remapJoinBody(init) {
    const cfg = apiNaming?.joinByUser || {}
    const oppServer = cfg.opponentField || 'opponent_user_id'
    const minServer = cfg.minutesField || 'minutes'
    const oppClient = Array.isArray(cfg.clientOpponentKeys) ? cfg.clientOpponentKeys : []
    const minClient = Array.isArray(cfg.clientMinutesKeys) ? cfg.clientMinutesKeys : []

    let body = {}
    if (init?.body != null) {
      try {
        body = (typeof init.body === 'string') ? JSON.parse(init.body) : init.body
      } catch {
        body = {}
      }
    }

    const out = (body && typeof body === 'object') ? { ...body } : {}

    // opponent id
    let oppVal = null
    for (const k of [...oppClient, oppServer]) {
      if (body && body[k] != null && body[k] !== '') {
        oppVal = body[k]
        break
      }
    }
    if (!oppVal && body && typeof body.user === 'object') {
      oppVal = body.user._id || body.user.user_id || null
    }
    const hex = extractHexId(oppVal)
    if (hex) out[oppServer] = hex
    for (const k of oppClient) {
      if (k !== oppServer) delete out[k]
    }

    // minutes (legacy). If a time_code exists, we keep it and avoid touching minutes.
    const hasTimeCode = (out.time_code != null && out.time_code !== '') || (out.timeCode != null && out.timeCode !== '')
    let minKey = null
    let minVal = null
    for (const k of [...minClient, minServer]) {
      if (body && body[k] != null) {
        minKey = k
        minVal = body[k]
        break
      }
    }

    if (!hasTimeCode && minKey != null) {
      const parsed = parseMinutesLike(minVal)
      out[minServer] = (parsed != null) ? parsed : minVal
    }
    for (const k of minClient) {
      if (k !== minServer) delete out[k]
    }

    return JSON.stringify(out)
  }

  window.fetch = async function patchedFetch(input, init) {
    const url = (typeof input === 'string')
      ? input
      : (input && typeof input.url === 'string')
        ? input.url
        : ''

    const isApi = typeof url === 'string' && url.startsWith('/api/')
    if (isApi) {
      init = init || {}
      const headers = new Headers(init.headers || {})
      const token = pickToken()
      if (token && !headers.has('Authorization')) {
        headers.set('Authorization', token.startsWith('Bearer ') ? token : `Bearer ${token}`)
      }
      if (!init.credentials) init.credentials = 'include'
      init.headers = headers

      if (isJoinByUser(url, init)) {
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
        init.body = remapJoinBody(init)
      }
    }

    return originalFetch(input, init)
  }
})()
