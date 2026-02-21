import axios from 'axios'

function normalizeLang(v) {
  try {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return 'en';
    const base = s.split('-', 1)[0].split('_', 1)[0];
    const m = (base === 'jp') ? 'ja' : (base === 'cn') ? 'zh' : base;
    const supported = new Set(['ja', 'en', 'zh', 'fr', 'de', 'pl', 'it', 'pt']);
    return supported.has(m) ? m : 'en';
  } catch {
    return 'en';
  }
}

function readPreferredLang() {
  try {
    const ls = (typeof localStorage !== 'undefined') ? localStorage.getItem('shogi_language') : null;
    return normalizeLang(ls);
  } catch {
    return 'en';
  }
}

function readCookie(name) {
  try {
    const list = (typeof document !== 'undefined' && document.cookie) ? document.cookie.split(';') : []
    const prefix = name + '='
    for (let c of list) {
      c = c.trim()
      if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length))
    }
  } catch {}
  return null
}

const ENABLE_AUTO_REFRESH = false;

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 15000,
})

api.interceptors.request.use((config) => {
  try {
    const ls = (typeof localStorage !== 'undefined') ? localStorage.getItem('access_token') : null
    const ss = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('access_token') : null
    const ck = readCookie('access_token') || readCookie('token') || readCookie('jwt')
    const token = ls || ss || ck
    if (token) {
      config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` }
    }
  } catch {}

  // Backend-side i18n (e.g., time control labels in WS payloads)
  try {
    const lang = readPreferredLang();
    config.headers = { ...(config.headers || {}), 'X-Shogi-Lang': lang };
  } catch {}
  return config
})

let refreshingPromise = null
let lastFailAt = 0
let backoffMs = 0
const MIN_GAP_MS = 30000
const FIRST_BACKOFF = 5000
const MAX_BACKOFF = 60000

async function tryRefreshTokenOnce() {
  const candidates = ['/auth/refresh', '/user/refresh', '/auth/token']
  for (const p of candidates) {
    try {
      const res = await axios.post('/api' + p, {}, { withCredentials: true })
      if (res && (res.status === 200 || res.status === 204)) return true
    } catch {}
  }
  return false
}

async function tryRefreshToken() {
  const now = Date.now()
  if (now - lastFailAt < MIN_GAP_MS && refreshingPromise === null) {
    const key = 'shogi_hard_reloaded'
    if (typeof window !== 'undefined' && !sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1')
      window.location.reload()
      return new Promise(()=>{})
    }
    return false
  }

  if (!refreshingPromise) {
    refreshingPromise = (async () => {
      const ok = await tryRefreshTokenOnce()
      if (!ok) {
        lastFailAt = Date.now()
        backoffMs = backoffMs ? Math.min(MAX_BACKOFF, backoffMs * 2) : FIRST_BACKOFF
        await new Promise(r => setTimeout(r, backoffMs))
      } else {
        backoffMs = 0
      }
      refreshingPromise = null
      return ok
    })()
  }
  return refreshingPromise
}

api.interceptors.response.use(
  resp => resp,
  async (error) => {
    const { response, config } = error || {}
    if (!response || !config) throw error

    // Backend may return structured error payloads.
    // Attach them to the Error object for UI code to inspect (error_code/message/etc).
    // Do NOT overwrite `error.message` here; UI should use error_code-based mapping.
    try {
      const d = response.data
      if (error) {
        // keep raw payload for callers
        error.api_data = d
        if (d && typeof d === 'object') {
          const raw = (
            (typeof d.error_code === 'string' && d.error_code.trim()) ? d.error_code.trim()
              : (typeof d.code === 'string' && d.code.trim()) ? d.code.trim()
              : (typeof d.error === 'string' && d.error.trim()) ? d.error.trim()
              : (typeof d.result_code === 'string' && d.result_code.trim()) ? d.result_code.trim()
              : null
          )
          if (raw && typeof raw === 'string') {
            error.error_code = raw
          }
        }
      }
    } catch {}

    if (response.status === 401) {
      if (typeof window !== 'undefined' && window.__onAuthExpired) { try { window.__onAuthExpired(); } catch {}
      }
    }
    throw error
  }
)

export default api
