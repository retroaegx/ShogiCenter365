export function resolveApiOrigin() {
  const envBase = import.meta?.env?.VITE_API_BASE
  if (envBase) return envBase.replace(/\/$/, '')

  if (typeof window !== 'undefined' && window?.location) {
    const { protocol, hostname, port } = window.location
    // Vite dev server uses 5173 by default; backend is typically 5000
    if (port === '5173') {
      return `${protocol}//${hostname}:5000`
    }
    // Otherwise, same origin (works for prod or when front is served by backend)
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`
  }
  // Fallback for non-browser
  return 'http://127.0.0.1:5000'
}

export const API_ORIGIN = resolveApiOrigin()

export function apiUrl(path = ''){
  const p = path.startsWith('/') ? path : `/${path}`
  return `${API_ORIGIN}/api${p}`
}
