// =============================================================================
// Superadmin API client.
//
// All privileged platform operations go through the `admin-api` Supabase Edge
// Function, which verifies the caller's session token belongs to an active
// superadmin before using the service role server-side. The service-role key
// must never be shipped to the browser.
//
// `adminDb.from(table)` mimics the small part of the supabase-js query builder
// the admin pages use (select/insert/update/upsert/delete + filters, order,
// limit, single). The Edge Function enforces which tables and verbs are allowed.
// =============================================================================

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const ADMIN_FN_URL = `${supabaseUrl}/functions/v1/admin-api`

async function post(body, { authorization } = {}) {
  const token = localStorage.getItem('session_token') || ''
  const headers = {
    'Content-Type': 'application/json',
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${authorization || supabaseAnonKey}`,
  }
  if (token) headers['x-session-token'] = token

  let res
  try {
    res = await fetch(ADMIN_FN_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (err) {
    return { data: null, error: { message: 'Admin service unreachable: ' + (err?.message || 'network error') }, count: null }
  }

  let payload = null
  try { payload = await res.json() } catch (_) { payload = null }
  if (!payload) {
    return { data: null, error: { message: `Admin service error (HTTP ${res.status})`, status: res.status }, count: null }
  }
  if (!res.ok && !payload.error) payload.error = { message: `Admin service error (HTTP ${res.status})`, status: res.status }
  return { count: null, ...payload }
}

/**
 * Call a dedicated admin action, e.g. adminCall('impersonate', { shop_id: 5 }).
 * Resolves to `{ data, error, ... }` — it never throws.
 */
export function adminCall(action, params = {}, options) {
  return post({ action, ...params }, options)
}

class AdminQuery {
  constructor(table) {
    this.spec = { action: 'db', table, op: 'select', filters: [], order: [] }
  }

  select(columns = '*', opts = {}) {
    if (this.spec.op === 'select') {
      this.spec.columns = columns
      if (opts.count) this.spec.count = opts.count
      if (opts.head) this.spec.head = true
    } else {
      // e.g. .insert(...).select() → return the written rows
      this.spec.returning = true
      this.spec.columns = columns
    }
    return this
  }

  insert(values) { this.spec.op = 'insert'; this.spec.values = values; return this }
  update(values) { this.spec.op = 'update'; this.spec.values = values; return this }
  delete() { this.spec.op = 'delete'; return this }
  upsert(values, opts = {}) {
    this.spec.op = 'upsert'
    this.spec.values = values
    if (opts.onConflict) this.spec.onConflict = opts.onConflict
    return this
  }

  _filter(op, column, value) { this.spec.filters.push([column, op, value]); return this }
  eq(c, v) { return this._filter('eq', c, v) }
  neq(c, v) { return this._filter('neq', c, v) }
  gt(c, v) { return this._filter('gt', c, v) }
  gte(c, v) { return this._filter('gte', c, v) }
  lt(c, v) { return this._filter('lt', c, v) }
  lte(c, v) { return this._filter('lte', c, v) }
  in(c, v) { return this._filter('in', c, v) }
  ilike(c, v) { return this._filter('ilike', c, v) }
  like(c, v) { return this._filter('like', c, v) }
  is(c, v) { return this._filter('is', c, v) }

  order(column, opts = {}) { this.spec.order.push({ column, ascending: opts.ascending !== false }); return this }
  limit(n) { this.spec.limit = n; return this }
  range(from, to) { this.spec.range = [from, to]; return this }
  single() { this.spec.single = 'single'; return this }
  maybeSingle() { this.spec.single = 'maybe'; return this }

  then(resolve, reject) {
    return post(this.spec).then(resolve, reject)
  }
}

export const adminDb = {
  from: (table) => new AdminQuery(table),
  rpc: (fn, args = {}) => adminCall('rpc', { fn, args }),
}

export default adminDb
