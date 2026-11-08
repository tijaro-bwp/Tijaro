// =============================================================================
// admin-api — every privileged superadmin operation for EdgeX POS.
//
// The browser never holds the service-role key. It sends its custom session
// token (`x-session-token`, issued by the `secure_login` RPC); this function
// checks that the token is a live session of an active `users.role =
// 'superadmin'` account with no shop, then performs ONE allow-listed operation
// with the service role and records it in `audit_logs`.
//
// Deploy:  supabase functions deploy admin-api --no-verify-jwt
// Secrets: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
//          Optional ADMIN_ALLOWED_ORIGINS="https://pos.example.com,http://localhost:5173"
// See docs/ADMIN_EDGE_FUNCTIONS.md.
// =============================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.1'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ALLOWED_ORIGINS = (Deno.env.get('ADMIN_ALLOWED_ORIGINS') ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)

const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  let allow = '*'
  if (ALLOWED_ORIGINS.length > 0) allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-token, x-application-name',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const bad = (msg: string) => new HttpError(400, msg)

// ── Validation helpers ───────────────────────────────────────────────────────

const IDENT = /^[a-z_][a-z0-9_]*$/
const SELECT_RE = /^[A-Za-z0-9_,*()\s:!.]*$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function ident(v: unknown, what: string): string {
  if (typeof v !== 'string' || !IDENT.test(v) || v.length > 63) throw bad(`Invalid ${what}`)
  return v
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function shopId(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw bad('Invalid shop_id')
  return n
}

function str(v: unknown, what: string, max = 500, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${what} is required`)
    return ''
  }
  if (typeof v !== 'string' || v.length > max) throw bad(`Invalid ${what}`)
  return v.trim()
}

// ── Authorization ────────────────────────────────────────────────────────────

interface Actor {
  id: string
  email: string
  username: string
  token: string
}

async function requireSuperadmin(req: Request): Promise<Actor> {
  const token = req.headers.get('x-session-token') ?? ''
  if (!UUID_RE.test(token)) throw new HttpError(401, 'Missing or invalid session token')

  const { data: sess, error } = await admin
    .from('sessions')
    .select('user_id, shop_id, expires_at')
    .eq('token', token)
    .maybeSingle()
  if (error || !sess) throw new HttpError(401, 'Session not found')
  if (sess.expires_at && new Date(sess.expires_at) <= new Date()) throw new HttpError(401, 'Session expired')
  // Superadmin sessions never carry a shop. Impersonation and tenant sessions do.
  if (sess.shop_id !== null) throw new HttpError(403, 'Not a superadmin session')

  const { data: user, error: uErr } = await admin
    .from('users')
    .select('id, email, username, role, is_active, shop_id')
    .eq('id', sess.user_id)
    .maybeSingle()
  if (uErr || !user || user.role !== 'superadmin' || user.is_active === false || user.shop_id !== null) {
    throw new HttpError(403, 'Superadmin access required')
  }
  return { id: user.id, email: user.email ?? '', username: user.username ?? '', token }
}

function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
}

async function audit(
  req: Request,
  actor: { id: string | null; email: string },
  action_type: string,
  target_type: string | null,
  target_id: unknown,
  details: Record<string, unknown> = {},
) {
  const { error } = await admin.from('audit_logs').insert({
    actor_id: actor.id,
    actor_email: actor.email,
    action_type: action_type.slice(0, 100),
    target_type,
    target_id: target_id === null || target_id === undefined ? null : String(target_id).slice(0, 200),
    details: { ...details, via: 'admin-api' },
    ip_address: clientIp(req),
  })
  if (error) console.error('audit log failed:', error.message)
}

// ── Generic, allow-listed table access ───────────────────────────────────────
// Superadmins legitimately need broad read access (dashboards, backups,
// analytics) and CRUD on platform tables. Every table and verb is listed here;
// anything else — notably `sessions` — is refused.

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

const TENANT_READ_ONLY: Op[] = ['select']
const TABLES: Record<string, Op[]> = {
  shops: ['select', 'insert', 'update', 'delete'],
  users: ['select', 'insert', 'update', 'delete'],
  subscription_plans: ['select', 'insert', 'update', 'upsert', 'delete'],
  shop_payments: ['select', 'insert', 'update', 'delete'],
  announcements: ['select', 'insert', 'update', 'delete'],
  email_templates: ['select', 'insert', 'update', 'upsert', 'delete'],
  support_tickets: ['select', 'update'],
  system_configs: ['select', 'upsert'],
  shop_backups: ['select', 'insert'],
  audit_logs: ['select'],
  categories: TENANT_READ_ONLY,
  brands: TENANT_READ_ONLY,
  products: TENANT_READ_ONLY,
  suppliers: TENANT_READ_ONLY,
  customers: TENANT_READ_ONLY,
  sales: TENANT_READ_ONLY,
  sale_items: TENANT_READ_ONLY,
  purchases: TENANT_READ_ONLY,
  purchase_items: TENANT_READ_ONLY,
  expenses: TENANT_READ_ONLY,
  customer_payments: TENANT_READ_ONLY,
  supplier_payments: TENANT_READ_ONLY,
}

const FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'ilike', 'like', 'is'])
const MAX_ROWS = 10000

function stripSecrets(table: string, rows: unknown): unknown {
  if (table !== 'users' || !rows) return rows
  const scrub = (r: unknown) => {
    if (!isPlainObject(r)) return r
    const { password: _pw, raw_password: _raw, ...rest } = r
    return rest
  }
  return Array.isArray(rows) ? rows.map(scrub) : scrub(rows)
}

function checkUserValues(values: unknown) {
  const list = Array.isArray(values) ? values : [values]
  for (const v of list) {
    if (!isPlainObject(v)) throw bad('Invalid values')
    if (v.role === 'superadmin') throw new HttpError(403, 'Superadmin accounts cannot be created or promoted here')
    if ('raw_password' in v) throw bad('Plaintext passwords are not stored')
    if ('shop_id' in v && v.shop_id === null) throw bad('Users must belong to a shop')
  }
}

function checkValues(values: unknown) {
  const list = Array.isArray(values) ? values : [values]
  if (list.length === 0 || list.length > 1000) throw bad('Invalid values')
  for (const v of list) {
    if (!isPlainObject(v)) throw bad('Invalid values')
    for (const k of Object.keys(v)) ident(k, 'column')
  }
}

async function handleDb(req: Request, actor: Actor, body: Record<string, unknown>) {
  const table = ident(body.table, 'table')
  const op = body.op as Op
  const allowed = TABLES[table]
  if (!allowed) throw new HttpError(403, `Table "${table}" is not available to the admin API`)
  if (!allowed.includes(op)) throw new HttpError(403, `"${op}" is not allowed on "${table}"`)

  const columns = body.columns === undefined ? '*' : body.columns
  if (typeof columns !== 'string' || columns.length > 500 || !SELECT_RE.test(columns)) throw bad('Invalid columns')

  const filters = Array.isArray(body.filters) ? body.filters : []
  if (filters.length > 20) throw bad('Too many filters')
  if ((op === 'update' || op === 'delete') && filters.length === 0) {
    throw bad(`${op} requires at least one filter`)
  }

  const values = body.values
  if (op === 'insert' || op === 'update' || op === 'upsert') {
    checkValues(values)
    if (table === 'users') checkUserValues(values)
  }
  if (table === 'users' && (op === 'update' || op === 'delete')) {
    // Never let the generic path touch superadmin rows.
    filters.push(['role', 'neq', 'superadmin'])
  }

  const countMode = body.count === 'exact' ? 'exact' : undefined
  const head = body.head === true
  const returning = body.returning === true

  // deno-lint-ignore no-explicit-any
  let q: any = admin.from(table)
  if (op === 'select') q = q.select(columns, { count: countMode, head })
  else if (op === 'insert') q = q.insert(values)
  else if (op === 'update') q = q.update(values)
  else if (op === 'delete') q = q.delete()
  else if (op === 'upsert') {
    const onConflict = body.onConflict === undefined ? undefined : ident(body.onConflict, 'onConflict')
    q = q.upsert(values, onConflict ? { onConflict } : undefined)
  }
  if (op !== 'select' && returning) q = q.select(columns)

  for (const f of filters) {
    if (!Array.isArray(f) || f.length !== 3) throw bad('Invalid filter')
    const [col, fop, val] = f
    ident(col, 'filter column')
    if (typeof fop !== 'string' || !FILTER_OPS.has(fop)) throw bad('Invalid filter operator')
    if (fop === 'in') {
      if (!Array.isArray(val) || val.length > 1000) throw bad('Invalid "in" filter')
    } else if (val !== null && !['string', 'number', 'boolean'].includes(typeof val)) {
      throw bad('Invalid filter value')
    }
    q = q[fop](col, val)
  }

  const order = Array.isArray(body.order) ? body.order : []
  for (const o of order.slice(0, 5)) {
    if (!isPlainObject(o)) throw bad('Invalid order')
    q = q.order(ident(o.column, 'order column'), { ascending: o.ascending !== false })
  }

  if (body.range !== undefined) {
    const r = body.range
    if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n) && n >= 0) || r[1] - r[0] >= MAX_ROWS) {
      throw bad('Invalid range')
    }
    q = q.range(r[0], r[1])
  } else if (body.limit !== undefined) {
    const n = body.limit
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_ROWS) throw bad('Invalid limit')
    q = q.limit(n)
  }

  if (body.single === 'single') q = q.single()
  else if (body.single === 'maybe') q = q.maybeSingle()

  const { data, error, count } = await q
  if (error) return { data: null, error: { message: error.message, code: error.code, details: error.details }, count: null }

  if (op !== 'select') {
    const idFilter = filters.find((f: unknown[]) => f[0] === 'id' && f[1] === 'eq')
    await audit(req, actor, `DB_${op.toUpperCase()}`, table, idFilter ? idFilter[2] : null, {
      filters: filters.map((f: unknown[]) => [f[0], f[1], Array.isArray(f[2]) ? `[${f[2].length} values]` : f[2]]),
      columns: values ? Object.keys(Array.isArray(values) ? values[0] ?? {} : values) : [],
      rows: Array.isArray(values) ? values.length : values ? 1 : 0,
    })
  }

  return { data: stripSecrets(table, data), error: null, count: count ?? null }
}

// ── Allow-listed RPCs ────────────────────────────────────────────────────────

const RPCS = new Set(['get_global_growth_stats', 'get_top_performing_shops', 'get_inactive_shops'])

async function handleRpc(body: Record<string, unknown>) {
  const fn = ident(body.fn, 'function')
  if (!RPCS.has(fn)) throw new HttpError(403, `RPC "${fn}" is not available to the admin API`)
  const args = isPlainObject(body.args) ? body.args : {}
  const { data, error } = await admin.rpc(fn, args)
  if (error) return { data: null, error: { message: error.message, code: error.code } }
  return { data, error: null }
}

// ── Dedicated operations ─────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function createShop(req: Request, actor: Actor, body: Record<string, unknown>) {
  const shop = isPlainObject(body.shop) ? body.shop : {}
  const owner = isPlainObject(body.owner) ? body.owner : {}

  const name = str(shop.name, 'Shop name', 200)
  const email = str(owner.email, 'Owner email', 200).toLowerCase()
  if (!EMAIL_RE.test(email)) throw bad('Invalid owner email')
  const password = str(owner.password, 'Owner password', 200)
  if (password.length < 6) throw bad('Owner password must be at least 6 characters')
  const username = str(owner.username, 'Owner username', 100, false) || email.split('@')[0]
  const planId = shop.plan_id
  if (planId === undefined || planId === null || planId === '') throw bad('Subscription plan is required')

  const shopInsert: Record<string, unknown> = {
    name,
    phone: str(shop.phone, 'phone', 50, false) || null,
    address: str(shop.address, 'address', 500, false) || null,
    email,
    status: 'active',
    plan_id: planId,
  }
  const businessType = str(shop.business_type, 'business_type', 50, false)
  if (businessType) shopInsert.business_type = businessType

  let { data: shopData, error: shopError } = await admin.from('shops').insert([shopInsert]).select().single()
  if (shopError && shopError.message?.includes('business_type')) {
    delete shopInsert.business_type
    const retry = await admin.from('shops').insert([shopInsert]).select().single()
    shopData = retry.data
    shopError = retry.error
  }
  if (shopError || !shopData) throw bad('Failed to create shop: ' + (shopError?.message ?? 'unknown error'))

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'admin', shop_id: shopData.id },
  })
  if (authError || !authData?.user) {
    await admin.from('shops').delete().eq('id', shopData.id)
    throw bad('Failed to create user account: ' + (authError?.message ?? 'unknown error'))
  }

  const userInsert: Record<string, unknown> = {
    id: authData.user.id,
    username,
    email,
    password: await sha256Hex(password), // plaintext is never stored
    role: 'admin',
    shop_id: shopData.id,
    is_active: true,
  }
  const { error: profileError } = await admin.from('users').insert([userInsert])

  await audit(req, actor, 'CREATE_SHOP', 'SHOP', shopData.id, { shopName: name, ownerEmail: email, planId })
  return {
    data: { shop: shopData, owner: { id: authData.user.id, username, email } },
    error: null,
    warning: profileError ? 'Profile insert warning: ' + profileError.message : null,
  }
}

const SHOP_CHILD_TABLES = [
  'customer_payments', 'supplier_payments', 'expenses', 'products', 'sales', 'purchases',
  'customers', 'suppliers', 'categories', 'brands', 'users',
]

async function deleteShop(req: Request, actor: Actor, body: Record<string, unknown>) {
  const id = shopId(body.shop_id)
  const confirmName = str(body.confirm_name, 'confirm_name', 200)
  const { data: shop, error } = await admin.from('shops').select('id, name').eq('id', id).maybeSingle()
  if (error || !shop) throw new HttpError(404, 'Shop not found')
  if (String(shop.name).trim() !== confirmName) throw bad('Shop name did not match')

  const warnings: string[] = []
  await admin.from('sessions').delete().eq('shop_id', id)
  for (const t of SHOP_CHILD_TABLES) {
    const { error: e } = await admin.from(t).delete().eq('shop_id', id)
    if (e) warnings.push(`${t}: ${e.message}`)
  }
  const { error: delErr } = await admin.from('shops').delete().eq('id', id)
  if (delErr) throw bad('Delete failed: ' + delErr.message)

  await audit(req, actor, 'DELETE_SHOP', 'SHOP', id, { shopName: shop.name, warnings })
  return { data: { deleted: id }, error: null, warnings }
}

const IMPERSONATION_HOURS = 12

async function impersonate(req: Request, actor: Actor, body: Record<string, unknown>) {
  const id = shopId(body.shop_id)
  const { data: shop } = await admin.from('shops').select('id, name').eq('id', id).maybeSingle()
  if (!shop) throw new HttpError(404, 'Shop not found')

  let { data: users } = await admin.from('users').select('id')
    .eq('shop_id', id).eq('is_active', true).neq('role', 'superadmin').limit(1)
  if (!users || users.length === 0) {
    ;({ data: users } = await admin.from('users').select('id').eq('shop_id', id).neq('role', 'superadmin').limit(1))
  }
  if (!users || users.length === 0) throw bad('Cannot impersonate: This shop has no registered users in the database.')

  const token = crypto.randomUUID()
  const { error } = await admin.from('sessions').insert([{
    token,
    user_id: users[0].id,
    shop_id: id,
    expires_at: new Date(Date.now() + IMPERSONATION_HOURS * 3600 * 1000).toISOString(),
  }])
  if (error) throw bad('Failed to establish secure database session: ' + error.message)

  await audit(req, actor, 'IMPERSONATE_SHOP', 'SHOP', id, { shopName: shop.name, asUser: users[0].id, hours: IMPERSONATION_HOURS })
  return { data: { session_token: token, expires_in_hours: IMPERSONATION_HOURS }, error: null }
}

const BACKUP_TABLES: { name: string; label: string; singleRow?: boolean; parent?: string; fk?: string }[] = [
  { name: 'shops', label: 'Shop Info', singleRow: true },
  { name: 'users', label: 'Users' },
  { name: 'categories', label: 'Categories' },
  { name: 'brands', label: 'Brands' },
  { name: 'suppliers', label: 'Suppliers' },
  { name: 'products', label: 'Products' },
  { name: 'customers', label: 'Customers' },
  { name: 'sales', label: 'Sales' },
  { name: 'sale_items', label: 'Sale Items', parent: 'sales', fk: 'sale_id' },
  { name: 'purchases', label: 'Purchases' },
  { name: 'purchase_items', label: 'Purchase Items', parent: 'purchases', fk: 'purchase_id' },
  { name: 'customer_payments', label: 'Customer Payments' },
  { name: 'expenses', label: 'Expenses' },
]

async function fetchAll(table: string, col: string, val: unknown): Promise<unknown[]> {
  const out: unknown[] = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await admin.from(table).select('*').eq(col, val).range(from, from + page - 1)
    if (error) throw bad(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < page) break
  }
  return out
}

async function backupShop(req: Request, actor: Actor, body: Record<string, unknown>) {
  const id = shopId(body.shop_id)
  const sheets: { label: string; rows: unknown[] }[] = []
  let totalRows = 0
  for (const t of BACKUP_TABLES) {
    let rows: unknown[] = []
    if (t.singleRow) {
      const { data } = await admin.from(t.name).select('*').eq('id', id).limit(1)
      rows = data ?? []
    } else if (t.parent && t.fk) {
      const parents = await fetchAll(t.parent, 'shop_id', id) as { id: unknown }[]
      const ids = parents.map((p) => p.id)
      for (let i = 0; i < ids.length; i += 500) {
        const { data, error } = await admin.from(t.name).select('*').in(t.fk, ids.slice(i, i + 500))
        if (error) throw bad(`${t.name}: ${error.message}`)
        rows.push(...(data ?? []))
      }
    } else {
      rows = await fetchAll(t.name, 'shop_id', id)
    }
    rows = stripSecrets(t.name, rows) as unknown[]
    totalRows += rows.length
    sheets.push({ label: t.label, rows })
  }
  const backedUpAt = new Date().toISOString()
  await admin.from('shop_backups').insert([{ shop_id: id, backup_rows: totalRows, backed_up_by: actor.email || actor.username || 'superadmin' }])
  await audit(req, actor, 'BACKUP_SHOP', 'SHOP', id, { totalRows })
  return { data: { shop_id: id, sheets, total_rows: totalRows, backed_up_at: backedUpAt }, error: null }
}

async function logAction(req: Request, actor: Actor, body: Record<string, unknown>) {
  const actionType = str(body.action_type, 'action_type', 100)
  if (!/^[A-Z0-9_]+$/.test(actionType)) throw bad('Invalid action_type')
  const targetType = str(body.target_type, 'target_type', 50, false) || null
  const details = isPlainObject(body.details) ? body.details : {}
  if (JSON.stringify(details).length > 10000) throw bad('details too large')
  await audit(req, actor, actionType, targetType, body.target_id ?? null, details)
  return { data: { ok: true }, error: null }
}

// Password-recovery flow (ResetPassword.jsx): the caller proves email ownership
// with the Supabase Auth recovery session, not a POS session.
async function resetSuperadminPassword(req: Request, body: Record<string, unknown>) {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) throw new HttpError(401, 'Missing recovery session')
  const { data: authUser, error } = await admin.auth.getUser(jwt)
  const email = authUser?.user?.email
  if (error || !email) throw new HttpError(401, 'Recovery session is invalid or expired')

  const hash = str(body.password_hash, 'password_hash', 64)
  if (!/^[0-9a-f]{64}$/.test(hash)) throw bad('Invalid password_hash')

  const { data: rows, error: upErr } = await admin.from('users')
    .update({ password: hash })
    .ilike('email', email)
    .eq('role', 'superadmin')
    .select('id')
  if (upErr) throw bad(upErr.message)
  const ids = (rows ?? []).map((r: { id: string }) => r.id)
  if (ids.length > 0) await admin.from('sessions').delete().in('user_id', ids) // sign out everywhere
  await audit(req, { id: ids[0] ?? null, email }, 'SUPERADMIN_PASSWORD_RESET', 'USER', ids[0] ?? null, { updated: ids.length })
  return { data: { updated: ids.length }, error: null }
}

async function logout(actor: Actor) {
  await admin.from('sessions').delete().eq('token', actor.token)
  return { data: { ok: true }, error: null }
}

// ── Entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (req.method !== 'POST') return json(405, { data: null, error: { message: 'Method not allowed' } })
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json(500, { data: null, error: { message: 'Server is not configured' } })

  try {
    const body = await req.json().catch(() => null)
    if (!isPlainObject(body)) throw bad('Invalid JSON body')
    const action = body.action

    if (action === 'reset_superadmin_password') return json(200, await resetSuperadminPassword(req, body))

    const actor = await requireSuperadmin(req)
    switch (action) {
      case 'whoami':
        return json(200, { data: { id: actor.id, email: actor.email, username: actor.username }, error: null })
      case 'db':
        return json(200, await handleDb(req, actor, body))
      case 'rpc':
        return json(200, await handleRpc(body))
      case 'create_shop':
        return json(200, await createShop(req, actor, body))
      case 'delete_shop':
        return json(200, await deleteShop(req, actor, body))
      case 'impersonate':
        return json(200, await impersonate(req, actor, body))
      case 'backup_shop':
        return json(200, await backupShop(req, actor, body))
      case 'log_action':
        return json(200, await logAction(req, actor, body))
      case 'logout':
        return json(200, await logout(actor))
      default:
        throw bad('Unknown action')
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    const message = err instanceof HttpError ? err.message : 'Internal error'
    if (!(err instanceof HttpError)) console.error(err)
    return json(status, { data: null, error: { message, status } })
  }
})
