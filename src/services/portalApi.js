// =============================================================================
// Customer portal API client (Edge Function `portal-api`).
//
// Two callers:
//   * the public customer portal (/c/:slug) — customer token in `x-portal-token`,
//     stored per shop so one browser can hold logins for several shops;
//   * shop staff pages — the normal staff `session_token` in `x-session-token`.
// Every call resolves to `{ data, error }` and never throws.
// See docs/CUSTOMER_PORTAL.md.
// =============================================================================

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const PORTAL_FN_URL = `${supabaseUrl}/functions/v1/portal-api`

const tokenKey = (slug) => `portal_token_${slug}`

export function getPortalToken(slug) {
  try { return localStorage.getItem(tokenKey(slug)) || '' } catch { return '' }
}

export function setPortalToken(slug, token) {
  try {
    if (token) localStorage.setItem(tokenKey(slug), token)
    else localStorage.removeItem(tokenKey(slug))
  } catch { /* storage blocked: the session just won't persist */ }
}

async function post(body, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${supabaseAnonKey}`,
    ...extraHeaders,
  }
  let res
  try {
    res = await fetch(PORTAL_FN_URL, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' })
  } catch (err) {
    return { data: null, error: { message: 'Cannot reach the server. Check your internet connection.', code: 'network', detail: err?.message } }
  }
  let payload = null
  try { payload = await res.json() } catch { payload = null }
  if (!payload) return { data: null, error: { message: `Server error (HTTP ${res.status})`, status: res.status } }
  if (!res.ok && !payload.error) payload.error = { message: `Server error (HTTP ${res.status})`, status: res.status }
  return payload
}

/** Customer-side call. Public actions (shop_info, login) need no token. */
export async function portalCall(slug, action, params = {}) {
  const token = getPortalToken(slug)
  const result = await post({ action, shop: slug, ...params }, token ? { 'x-portal-token': token } : {})
  if (action === 'login' && result.data?.token) setPortalToken(slug, result.data.token)
  if (action === 'logout' || result.error?.code === 'no_session') setPortalToken(slug, '')
  return result
}

/** Staff-side call: staff_status | staff_issue_pin | staff_disable. */
export function portalStaffCall(action, params = {}) {
  let token = ''
  try { token = localStorage.getItem('session_token') || '' } catch { token = '' }
  return post({ action, ...params }, token ? { 'x-session-token': token } : {})
}

/** Public portal address for a shop, e.g. https://app.example.com/c/al-madina-12 */
export function portalUrl(slug) {
  return `${window.location.origin}/c/${slug}`
}
