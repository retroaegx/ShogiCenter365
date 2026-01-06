import axios from 'axios'

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

    // APIが { message: "..." } などで返している場合は、そのままUIに出せるように
    // axios error の message を差し替える（UI側は error.message を表示）
    // 参考: axios の error.response / error.response.data の扱い
    try {
      const d = response.data
      let msg = null

      if (typeof d === 'string' && d.trim()) {
        msg = d
      } else if (d && typeof d === 'object') {
        if (typeof d.message === 'string' && d.message.trim()) msg = d.message
        else if (typeof d.error === 'string' && d.error.trim()) msg = d.error
        else if (typeof d.detail === 'string' && d.detail.trim()) msg = d.detail
        // { errors: { field: [..] } } や { errors: [..] } も一応拾う
        else if (d.errors) {
          if (Array.isArray(d.errors) && d.errors.length) {
            msg = String(d.errors[0])
          } else if (typeof d.errors === 'object') {
            const firstKey = Object.keys(d.errors)[0]
            const v = d.errors[firstKey]
            if (Array.isArray(v) && v.length) msg = String(v[0])
            else if (v != null) msg = String(v)
          }
        }
      }

      if (msg && error && typeof msg === 'string') {
        error.message = msg
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
