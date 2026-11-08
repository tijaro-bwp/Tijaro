// =============================================================================
// portal-api — the customer portal backend.
//
// Customers sign in with their mobile number + a 6-digit PIN on their shop's
// page (/c/<portal_slug>) and get a read-only view of their own bills, ledger
// and balance. Shop staff use the `staff_*` actions to give a customer a login,
// reset the PIN or switch it off.
//
// Security model (see docs/CUSTOMER_PORTAL.md):
//   * Runs with the service role, so it — not RLS — enforces scope: every
//     customer query is filtered by the session's (shop_id, customer_id) and
//     returns allow-listed columns only (never cost_price, created_by, …).
//   * PINs are hashed here with PBKDF2-SHA256 (+ optional pepper). Hashes and
//     session hashes live in service-role-only tables.
//   * Brute force is limited per account (lockout) and per IP and per number.
//   * Staff actions require a live staff session (`x-session-token`) whose
//     shop owns the customer, and are written to audit_logs.
//
// Deploy:  supabase functions deploy portal-api --no-verify-jwt
// Secrets: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
//          PORTAL_ALLOWED_ORIGINS="https://tijaro.example.com,http://localhost:5173" (recommended)
//          PORTAL_PIN_PEPPER="<long random string>" (recommended; never change once set)
// =============================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.1'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const PIN_PEPPER = Deno.env.get('PORTAL_PIN_PEPPER') ?? ''
const ALLOWED_ORIGINS = (Deno.env.get('PORTAL_ALLOWED_ORIGINS') ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)

const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

// ── Tunables ─────────────────────────────────────────────────────────────────

const SESSION_DAYS = 30
const PBKDF2_ITERATIONS = 100_000
const MAX_ACCOUNT_FAILURES = 5                // then lock the account…
const LOCK_MINUTES = 15                       // …for this long
const MAX_IP_FAILURES_PER_15_MIN = 20
const MAX_PHONE_FAILURES_PER_HOUR = 15        // across IPs, per shop + number
const STAFF_ROLES = new Set(['admin', 'manager', 'cashier'])
const PAGE_SIZE_MAX = 50

const WEAK_PINS = new Set([
  '000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999',
  '123456', '654321', '012345', '543210', '123123', '112233', '121212', '696969', '101010', '102030',
])

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  let allow = '*'
  if (ALLOWED_ORIGINS.length > 0) allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-token, x-portal-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  }
}

class HttpError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const bad = (msg: string) => new HttpError(400, msg)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function posInt(v: unknown, what: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw bad(`Invalid ${what}`)
  return n
}

// A bare date ("2026-01-31") as an upper bound means the end of that day.
function optDate(v: unknown, what: string, endOfDay = false): string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) throw bad(`Invalid ${what}`)
  const d = new Date(v)
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v)) d.setUTCHours(23, 59, 59, 999)
  return d.toISOString()
}

function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])?$/
const PIN_RE = /^\d{6}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PORTAL_TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/

// Same rules as normalize_pk_phone() in sql/customer_portal_migration.sql.
function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  let d = String(raw).replace(/\D/g, '')
  if (!d) return null
  if (d.startsWith('0092')) d = d.slice(2)
  if (d.length === 11 && d.startsWith('03')) return '92' + d.slice(1)
  if (d.length === 10 && d.startsWith('3')) return '92' + d
  return d
}

// ── Crypto ───────────────────────────────────────────────────────────────────

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function pbkdf2(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(PIN_PEPPER + pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
  return new Uint8Array(bits)
}

async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await pbkdf2(pin, salt, PBKDF2_ITERATIONS)
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`
}

async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$')
  if (scheme !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false
  const iterations = Number(iter)
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false
  const actual = await pbkdf2(pin, fromB64url(salt), iterations)
  return timingSafeEqual(actual, fromB64url(hash))
}

// A burned-in dummy hash so unknown numbers cost the same time as real ones.
let dummyHash: Promise<string> | null = null
const getDummyHash = () => (dummyHash ??= hashPin('000000'))

function randomPin(): string {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0]
    if (n >= 4_294_000_000) continue // avoid modulo bias
    const pin = String(n % 1_000_000).padStart(6, '0')
    if (!WEAK_PINS.has(pin)) return pin
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Audit ────────────────────────────────────────────────────────────────────

async function audit(
  req: Request,
  shopId: number,
  actor: { id: string | null; label: string },
  action_type: string,
  customerId: number | null,
  details: Record<string, unknown> = {},
) {
  const { error } = await db.from('audit_logs').insert({
    shop_id: shopId,
    actor_id: actor.id,
    actor_email: actor.label.slice(0, 200),
    action_type,
    target_type: 'customer',
    target_id: customerId === null ? null : String(customerId),
    details: { ...details, via: 'portal-api' },
    ip_address: clientIp(req),
  })
  if (error) console.error('audit log failed:', error.message)
}

// ── Shops ────────────────────────────────────────────────────────────────────

interface ShopRow {
  id: number
  name: string
  phone: string | null
  address: string | null
  logo_url: string | null
  status: string | null
  portal_slug: string
  portal_enabled: boolean
}

const SHOP_COLS = 'id, name, phone, address, logo_url, status, portal_slug, portal_enabled'

function shopIsOpen(shop: ShopRow): boolean {
  return shop.portal_enabled !== false && (shop.status ?? 'active') !== 'suspended'
}

function publicShop(shop: ShopRow) {
  return { name: shop.name, phone: shop.phone, address: shop.address, logo_url: shop.logo_url, slug: shop.portal_slug }
}

async function shopBySlug(slugRaw: unknown): Promise<ShopRow> {
  const slug = typeof slugRaw === 'string' ? slugRaw.trim().toLowerCase() : ''
  if (!SLUG_RE.test(slug)) throw new HttpError(404, 'Shop not found')
  const { data, error } = await db.from('shops').select(SHOP_COLS).eq('portal_slug', slug).maybeSingle()
  if (error || !data || !shopIsOpen(data as ShopRow)) throw new HttpError(404, 'Shop not found')
  return data as ShopRow
}

// ── Public: shop branding for the login page ─────────────────────────────────

async function shopInfo(body: Record<string, unknown>) {
  const shop = await shopBySlug(body.shop)
  return { data: publicShop(shop), error: null }
}

// ── Public: login ────────────────────────────────────────────────────────────

async function countSince(table: string, filters: Record<string, unknown>, sinceMs: number): Promise<number> {
  let q = db.from(table).select('id', { count: 'exact', head: true })
    .gte('created_at', new Date(Date.now() - sinceMs).toISOString())
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v)
  const { count } = await q
  return count ?? 0
}

async function recordFailure(req: Request, shopId: number, phone: string | null) {
  await db.from('customer_portal_login_failures').insert({ ip_address: clientIp(req), shop_id: shopId, phone_normalized: phone })
}

const LOGIN_FAILED = () => new HttpError(401, 'Mobile number or PIN is incorrect', 'invalid_credentials')

async function login(req: Request, body: Record<string, unknown>) {
  const shop = await shopBySlug(body.shop)
  const phone = normalizePhone(body.phone)
  const pin = typeof body.pin === 'string' ? body.pin.trim() : ''
  if (!phone || phone.length < 10 || phone.length > 15) throw bad('Enter a valid mobile number')
  if (!PIN_RE.test(pin)) throw bad('PIN must be 6 digits')

  // Throttle before doing any expensive work.
  const ip = clientIp(req)
  const [ipFails, phoneFails] = await Promise.all([
    countSince('customer_portal_login_failures', { ip_address: ip }, 15 * 60_000),
    countSince('customer_portal_login_failures', { shop_id: shop.id, phone_normalized: phone }, 60 * 60_000),
  ])
  if (ipFails >= MAX_IP_FAILURES_PER_15_MIN || phoneFails >= MAX_PHONE_FAILURES_PER_HOUR) {
    throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.', 'rate_limited')
  }

  const { data: acct } = await db.from('customer_portal_accounts')
    .select('customer_id, pin_hash, is_enabled, failed_attempts, locked_until, must_change_pin')
    .eq('shop_id', shop.id).eq('phone_normalized', phone).eq('is_enabled', true)
    .maybeSingle()

  if (!acct) {
    await verifyPin(pin, await getDummyHash()) // equalise timing
    await recordFailure(req, shop.id, phone)
    throw LOGIN_FAILED()
  }

  if (acct.locked_until && new Date(acct.locked_until) > new Date()) {
    throw new HttpError(423, 'Too many wrong PINs. Try again later or ask the shop to reset your PIN.', 'locked')
  }

  const ok = await verifyPin(pin, acct.pin_hash)
  if (!ok) {
    const failed = (acct.failed_attempts ?? 0) + 1
    const lock = failed >= MAX_ACCOUNT_FAILURES
    await db.from('customer_portal_accounts').update({
      failed_attempts: lock ? 0 : failed,
      locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('customer_id', acct.customer_id)
    await recordFailure(req, shop.id, phone)
    if (lock) {
      await audit(req, shop.id, { id: null, label: 'customer-portal' }, 'PORTAL_ACCOUNT_LOCKED', acct.customer_id)
      throw new HttpError(423, `Too many wrong PINs. Try again in ${LOCK_MINUTES} minutes.`, 'locked')
    }
    throw LOGIN_FAILED()
  }

  // Customer must still exist in this shop.
  const { data: cust } = await db.from('customers').select('id, name')
    .eq('id', acct.customer_id).eq('shop_id', shop.id).maybeSingle()
  if (!cust) throw LOGIN_FAILED()

  const token = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  const { error: sErr } = await db.from('customer_sessions').insert({
    token_hash: await sha256Hex(token),
    shop_id: shop.id,
    customer_id: cust.id,
    expires_at: expires.toISOString(),
    ip_address: ip,
    user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300),
  })
  if (sErr) throw new HttpError(500, 'Could not start session')

  await db.from('customer_portal_accounts').update({
    failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('customer_id', cust.id)
  await audit(req, shop.id, { id: null, label: 'customer-portal' }, 'PORTAL_LOGIN', cust.id)

  // Opportunistic cleanup of expired sessions / old failure rows.
  if (Math.random() < 0.05) db.rpc('customer_portal_cleanup').then(() => {}, () => {})

  return {
    data: {
      token,
      expires_at: expires.toISOString(),
      must_change_pin: acct.must_change_pin === true,
      customer: { name: cust.name },
      shop: publicShop(shop),
    },
    error: null,
  }
}

// ── Customer session ─────────────────────────────────────────────────────────

interface CustomerCtx {
  shop: ShopRow
  customerId: number
  tokenHash: string
}

async function requireCustomer(req: Request): Promise<CustomerCtx> {
  const token = req.headers.get('x-portal-token') ?? ''
  if (!PORTAL_TOKEN_RE.test(token)) throw new HttpError(401, 'Please sign in', 'no_session')
  const tokenHash = await sha256Hex(token)

  const { data: sess } = await db.from('customer_sessions')
    .select('shop_id, customer_id, expires_at, last_seen_at')
    .eq('token_hash', tokenHash).maybeSingle()
  if (!sess || new Date(sess.expires_at) <= new Date()) throw new HttpError(401, 'Session expired. Please sign in again.', 'no_session')

  const [{ data: shop }, { data: acct }] = await Promise.all([
    db.from('shops').select(SHOP_COLS).eq('id', sess.shop_id).maybeSingle(),
    db.from('customer_portal_accounts').select('is_enabled, shop_id').eq('customer_id', sess.customer_id).maybeSingle(),
  ])
  if (!shop || !shopIsOpen(shop as ShopRow) || !acct || !acct.is_enabled || acct.shop_id !== sess.shop_id) {
    await db.from('customer_sessions').delete().eq('token_hash', tokenHash)
    throw new HttpError(401, 'Portal access is not available. Please contact the shop.', 'no_session')
  }

  // Touch at most once an hour.
  if (Date.now() - new Date(sess.last_seen_at).getTime() > 3_600_000) {
    db.from('customer_sessions').update({ last_seen_at: new Date().toISOString() })
      .eq('token_hash', tokenHash).then(() => {}, () => {})
  }
  return { shop: shop as ShopRow, customerId: sess.customer_id, tokenHash }
}

// ── Ledger (single source of truth for the portal) ───────────────────────────
// Mirrors src/pages/CustomerLedger.jsx, except quotations are excluded: they
// are price quotes, not debts.

interface SaleRow {
  id: number
  created_at: string
  total_amount: number | null
  discount: number | null
  paid_amount: number | null
  payment_type: string | null
  sale_type: string | null
}

interface PaymentRow {
  id: number
  created_at: string
  amount: number | null
  payment_type: string | null
  note: string | null
  bill_number: string | null
  payment_mode: string | null
}

const SALE_COLS = 'id, created_at, total_amount, discount, paid_amount, payment_type, sale_type'
const PAYMENT_COLS = 'id, created_at, amount, payment_type, note, bill_number, payment_mode'

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const isQuotation = (s: SaleRow) => s.sale_type === 'quotation' || s.payment_type === 'quotation'
const billNo = (id: number) => String(id).slice(-8)
const saleNet = (s: SaleRow) => num(s.total_amount) - num(s.discount)
const saleDue = (s: SaleRow) => Math.max(0, saleNet(s) - num(s.paid_amount))

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999)
    if (error) throw new HttpError(500, 'Could not load data')
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
    if (from > 50_000) return out
  }
}

interface LedgerEntry {
  kind: 'bill' | 'payment' | 'return' | 'refund' | 'charge' | 'opening'
  id: number | null
  date: string
  description: string
  debit: number   // increases what the customer owes
  credit: number  // decreases it
  amount: number  // bill total or payment amount, for display
  paid_at_sale?: number
  payment_mode?: string | null
  balance: number
}

async function buildLedger(ctx: CustomerCtx): Promise<{ entries: LedgerEntry[]; balance: number }> {
  const { shop, customerId } = ctx
  const [sales, payments, custRes] = await Promise.all([
    fetchAll<SaleRow>((a, b) => db.from('sales').select(SALE_COLS)
      .eq('shop_id', shop.id).eq('customer_id', customerId)
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(a, b)),
    fetchAll<PaymentRow>((a, b) => db.from('customer_payments').select(PAYMENT_COLS)
      .eq('shop_id', shop.id).eq('customer_id', customerId)
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(a, b)),
    db.from('customers').select('outstanding_balance, created_at').eq('id', customerId).eq('shop_id', shop.id).maybeSingle(),
  ])

  type Raw = { date: string; sale?: SaleRow; pay?: PaymentRow }
  const raw: Raw[] = [
    ...sales.filter((s) => !isQuotation(s)).map((s) => ({ date: s.created_at, sale: s })),
    ...payments.map((p) => ({ date: p.created_at, pay: p })),
  ]
  raw.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  let running = 0
  const entries: LedgerEntry[] = raw.map(({ sale, pay }) => {
    if (sale) {
      const due = saleDue(sale)
      running += due
      return {
        kind: 'bill', id: sale.id, date: sale.created_at, description: `Bill #${billNo(sale.id)}`,
        debit: due, credit: 0, amount: saleNet(sale), paid_at_sale: num(sale.paid_amount),
        payment_mode: sale.payment_type, balance: running,
      }
    }
    const p = pay as PaymentRow
    const amt = num(p.amount)
    if (p.payment_type === 'debit') {
      running += amt
      return { kind: 'charge', id: p.id, date: p.created_at, description: p.note || 'Charge', debit: amt, credit: 0, amount: amt, balance: running }
    }
    if (p.payment_type === 'refund') {
      return { kind: 'refund', id: p.id, date: p.created_at, description: p.note || 'Cash refund', debit: 0, credit: 0, amount: amt, payment_mode: p.payment_mode, balance: running }
    }
    running -= Math.abs(amt)
    const isReturn = p.payment_type === 'return'
    return {
      kind: isReturn ? 'return' : 'payment', id: p.id, date: p.created_at,
      description: p.note || (isReturn ? 'Goods returned' : 'Payment received'),
      debit: 0, credit: Math.abs(amt), amount: Math.abs(amt), payment_mode: p.payment_mode, balance: running,
    }
  })

  // Same fallback as the shop ledger: no transactions but a carried-over balance.
  const ob = num(custRes.data?.outstanding_balance)
  if (entries.length === 0 && ob !== 0) {
    running = ob
    entries.push({
      kind: 'opening', id: null, date: custRes.data?.created_at ?? new Date().toISOString(),
      description: 'Opening balance (previous dues)', debit: Math.max(0, ob), credit: Math.max(0, -ob),
      amount: Math.abs(ob), balance: ob,
    })
  }

  const round = (n: number) => Math.round(n * 100) / 100
  for (const e of entries) e.balance = round(e.balance)
  return { entries, balance: round(running) }
}

// ── Customer actions ─────────────────────────────────────────────────────────

async function summary(ctx: CustomerCtx) {
  const [{ data: cust }, ledger, { data: acct }] = await Promise.all([
    db.from('customers').select('name, phone, address').eq('id', ctx.customerId).eq('shop_id', ctx.shop.id).maybeSingle(),
    buildLedger(ctx),
    db.from('customer_portal_accounts').select('must_change_pin').eq('customer_id', ctx.customerId).maybeSingle(),
  ])
  const bills = ledger.entries.filter((e) => e.kind === 'bill')
  const lastPayment = [...ledger.entries].reverse().find((e) => e.kind === 'payment') ?? null
  return {
    data: {
      shop: publicShop(ctx.shop),
      customer: { name: cust?.name ?? '', phone: cust?.phone ?? '', address: cust?.address ?? '' },
      balance: ledger.balance,
      bill_count: bills.length,
      last_bill: bills.length ? { id: bills[bills.length - 1].id, date: bills[bills.length - 1].date, amount: bills[bills.length - 1].amount } : null,
      last_payment: lastPayment ? { date: lastPayment.date, amount: lastPayment.amount } : null,
      recent: ledger.entries.slice(-5).reverse(),
      must_change_pin: acct?.must_change_pin === true,
    },
    error: null,
  }
}

async function bills(ctx: CustomerCtx, body: Record<string, unknown>) {
  const page = body.page === undefined ? 1 : posInt(body.page, 'page')
  const pageSize = Math.min(PAGE_SIZE_MAX, body.page_size === undefined ? 20 : posInt(body.page_size, 'page_size'))
  const from = optDate(body.from, 'from')
  const to = optDate(body.to, 'to', true)

  let q = db.from('sales').select(SALE_COLS, { count: 'exact' })
    .eq('shop_id', ctx.shop.id).eq('customer_id', ctx.customerId)
    // Exclude quotations; NULLs must survive (neq alone drops NULL rows).
    .or([
      'and(sale_type.is.null,payment_type.is.null)',
      'and(sale_type.is.null,payment_type.neq.quotation)',
      'and(sale_type.neq.quotation,payment_type.is.null)',
      'and(sale_type.neq.quotation,payment_type.neq.quotation)',
    ].join(','))
  if (from) q = q.gte('created_at', from)
  if (to) q = q.lte('created_at', to)
  const start = (page - 1) * pageSize
  const { data, count, error } = await q
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(start, start + pageSize - 1)
  if (error) throw new HttpError(500, 'Could not load bills')

  return {
    data: {
      page, page_size: pageSize, total: count ?? 0,
      bills: (data ?? []).map((s: SaleRow) => ({
        id: s.id, bill_no: billNo(s.id), date: s.created_at,
        subtotal: num(s.total_amount), discount: num(s.discount), total: saleNet(s),
        paid: num(s.paid_amount), due: saleDue(s), payment_mode: s.payment_type,
      })),
    },
    error: null,
  }
}

async function bill(ctx: CustomerCtx, body: Record<string, unknown>) {
  const id = posInt(body.id, 'bill id')
  const { data: s } = await db.from('sales').select(SALE_COLS)
    .eq('id', id).eq('shop_id', ctx.shop.id).eq('customer_id', ctx.customerId).maybeSingle()
  if (!s || isQuotation(s as SaleRow)) throw new HttpError(404, 'Bill not found')

  const { data: items, error } = await db.from('sale_items')
    .select('product_name, quantity, unit_price, line_total, returned_qty')
    .eq('sale_id', id).order('id', { ascending: true })
  if (error) throw new HttpError(500, 'Could not load bill')

  const sale = s as SaleRow
  return {
    data: {
      shop: publicShop(ctx.shop),
      id: sale.id, bill_no: billNo(sale.id), date: sale.created_at, payment_mode: sale.payment_type,
      subtotal: num(sale.total_amount), discount: num(sale.discount), total: saleNet(sale),
      paid: num(sale.paid_amount), due: saleDue(sale),
      items: (items ?? []).map((i) => ({
        name: i.product_name, quantity: num(i.quantity), unit_price: num(i.unit_price),
        line_total: num(i.line_total), returned_qty: num(i.returned_qty),
      })),
    },
    error: null,
  }
}

async function statement(ctx: CustomerCtx, body: Record<string, unknown>) {
  const from = optDate(body.from, 'from')
  const to = optDate(body.to, 'to', true)
  const { entries, balance } = await buildLedger(ctx)

  const fromMs = from ? new Date(from).getTime() : -Infinity
  const toMs = to ? new Date(to).getTime() : Infinity
  let opening = 0
  const rows: LedgerEntry[] = []
  for (const e of entries) {
    const t = new Date(e.date).getTime()
    if (t < fromMs) opening = e.balance
    else if (t <= toMs) rows.push(e)
  }
  const closing = rows.length ? rows[rows.length - 1].balance : opening
  return {
    data: {
      shop: publicShop(ctx.shop),
      from, to, opening_balance: opening, closing_balance: closing, current_balance: balance,
      total_debit: rows.reduce((a, e) => a + e.debit, 0),
      total_credit: rows.reduce((a, e) => a + e.credit, 0),
      entries: rows,
    },
    error: null,
  }
}

async function changePin(req: Request, ctx: CustomerCtx, body: Record<string, unknown>) {
  const current = typeof body.current_pin === 'string' ? body.current_pin.trim() : ''
  const next = typeof body.new_pin === 'string' ? body.new_pin.trim() : ''
  if (!PIN_RE.test(current) || !PIN_RE.test(next)) throw bad('PIN must be 6 digits')
  if (WEAK_PINS.has(next)) throw bad('That PIN is too easy to guess. Choose another.')
  if (current === next) throw bad('New PIN must be different')

  const { data: acct } = await db.from('customer_portal_accounts').select('pin_hash')
    .eq('customer_id', ctx.customerId).maybeSingle()
  if (!acct || !(await verifyPin(current, acct.pin_hash))) {
    await recordFailure(req, ctx.shop.id, null)
    throw new HttpError(401, 'Current PIN is incorrect', 'invalid_credentials')
  }
  await db.from('customer_portal_accounts').update({
    pin_hash: await hashPin(next), must_change_pin: false, pin_set_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('customer_id', ctx.customerId)
  // Sign out every other device.
  await db.from('customer_sessions').delete().eq('customer_id', ctx.customerId).neq('token_hash', ctx.tokenHash)
  await audit(req, ctx.shop.id, { id: null, label: 'customer-portal' }, 'PORTAL_PIN_CHANGED', ctx.customerId)
  return { data: { ok: true }, error: null }
}

async function customerLogout(ctx: CustomerCtx) {
  await db.from('customer_sessions').delete().eq('token_hash', ctx.tokenHash)
  return { data: { ok: true }, error: null }
}

// ── Staff actions ────────────────────────────────────────────────────────────

interface StaffCtx {
  userId: string
  username: string
  role: string
  shopId: number
  impersonating: boolean
}

async function requireStaff(req: Request): Promise<StaffCtx> {
  const token = req.headers.get('x-session-token') ?? ''
  if (!UUID_RE.test(token)) throw new HttpError(401, 'Missing or invalid session token')

  const { data: sess } = await db.from('sessions').select('user_id, shop_id, expires_at').eq('token', token).maybeSingle()
  if (!sess || sess.shop_id === null) throw new HttpError(401, 'Session not found')
  if (sess.expires_at && new Date(sess.expires_at) <= new Date()) throw new HttpError(401, 'Session expired')

  const { data: user } = await db.from('users').select('id, username, role, is_active, shop_id').eq('id', sess.user_id).maybeSingle()
  if (!user || user.is_active === false) throw new HttpError(403, 'Account inactive')
  // Superadmin impersonation sessions carry a shop but the user has none.
  const impersonating = user.role === 'superadmin' && user.shop_id === null
  if (!impersonating && (!STAFF_ROLES.has(user.role) || String(user.shop_id) !== String(sess.shop_id))) {
    throw new HttpError(403, 'Not allowed')
  }
  return { userId: user.id, username: user.username ?? '', role: user.role, shopId: Number(sess.shop_id), impersonating }
}

async function staffCustomer(staff: StaffCtx, body: Record<string, unknown>) {
  const customerId = posInt(body.customer_id, 'customer_id')
  const { data: cust } = await db.from('customers').select('id, name, phone')
    .eq('id', customerId).eq('shop_id', staff.shopId).maybeSingle()
  if (!cust) throw new HttpError(404, 'Customer not found')
  const { data: shop } = await db.from('shops').select(SHOP_COLS).eq('id', staff.shopId).maybeSingle()
  if (!shop) throw new HttpError(404, 'Shop not found')
  return { cust, shop: shop as ShopRow }
}

async function staffStatus(staff: StaffCtx, body: Record<string, unknown>) {
  const { cust, shop } = await staffCustomer(staff, body)
  const { data: acct } = await db.from('customer_portal_accounts')
    .select('is_enabled, phone_normalized, must_change_pin, locked_until, pin_set_at, last_login_at')
    .eq('customer_id', cust.id).maybeSingle()
  return {
    data: {
      shop_slug: shop.portal_slug,
      shop_portal_enabled: shop.portal_enabled !== false,
      customer_phone: normalizePhone(cust.phone),
      enabled: !!acct?.is_enabled,
      login_phone: acct?.phone_normalized ?? null,
      must_change_pin: acct?.must_change_pin ?? false,
      locked_until: acct?.locked_until ?? null,
      pin_set_at: acct?.pin_set_at ?? null,
      last_login_at: acct?.last_login_at ?? null,
    },
    error: null,
  }
}

// Enables the login (if needed) and issues a fresh PIN. The PIN is returned
// once, so staff can send it on WhatsApp; it is never stored in readable form.
async function staffIssuePin(req: Request, staff: StaffCtx, body: Record<string, unknown>) {
  const { cust, shop } = await staffCustomer(staff, body)
  if (!shopIsOpen(shop)) throw new HttpError(409, 'The customer portal is switched off for this shop')

  const phone = normalizePhone(cust.phone)
  if (!phone || phone.length < 10 || phone.length > 15) {
    throw new HttpError(409, 'Add a valid mobile number to this customer first', 'no_phone')
  }

  // Refuse if another customer in this shop uses the same number.
  const { data: others } = await db.from('customers').select('id, name, phone')
    .eq('shop_id', staff.shopId).neq('id', cust.id).not('phone', 'is', null)
  const dupes = (others ?? []).filter((o) => normalizePhone(o.phone) === phone)
  if (dupes.length) {
    return {
      data: null,
      error: {
        message: 'Another customer has the same mobile number. Merge or correct them first.',
        code: 'duplicate_phone',
        status: 409,
        duplicates: dupes.map((d) => ({ id: d.id, name: d.name })),
      },
    }
  }

  const pin = randomPin()
  const now = new Date().toISOString()
  const { data: existing } = await db.from('customer_portal_accounts').select('customer_id, is_enabled')
    .eq('customer_id', cust.id).maybeSingle()
  const row = {
    customer_id: cust.id, shop_id: staff.shopId, phone_normalized: phone, pin_hash: await hashPin(pin),
    is_enabled: true, must_change_pin: false, failed_attempts: 0, locked_until: null, pin_set_at: now, updated_at: now,
  }
  const { error } = existing
    ? await db.from('customer_portal_accounts').update(row).eq('customer_id', cust.id)
    : await db.from('customer_portal_accounts').insert(row)
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(409, 'Another portal login already uses this mobile number in your shop', 'duplicate_phone')
    }
    throw new HttpError(500, 'Could not save portal login')
  }

  // A new PIN signs out old devices.
  await db.from('customer_sessions').delete().eq('customer_id', cust.id)
  await audit(req, staff.shopId, { id: staff.userId, label: staff.username },
    existing?.is_enabled ? 'PORTAL_PIN_RESET' : 'PORTAL_ENABLED', cust.id)

  return {
    data: { pin, login_phone: phone, shop_slug: shop.portal_slug, customer_name: cust.name },
    error: null,
  }
}

// Shop-wide switch and the shop's portal address (Settings → Customer Portal).
async function staffShopPortal(staff: StaffCtx) {
  const { data: shop } = await db.from('shops').select(SHOP_COLS).eq('id', staff.shopId).maybeSingle()
  if (!shop) throw new HttpError(404, 'Shop not found')
  const { count } = await db.from('customer_portal_accounts').select('customer_id', { count: 'exact', head: true })
    .eq('shop_id', staff.shopId).eq('is_enabled', true)
  return {
    data: {
      slug: (shop as ShopRow).portal_slug,
      enabled: (shop as ShopRow).portal_enabled !== false,
      suspended: (shop as ShopRow).status === 'suspended',
      active_logins: count ?? 0,
      can_manage: staff.role === 'admin' || staff.impersonating,
    },
    error: null,
  }
}

async function staffSetShopPortal(req: Request, staff: StaffCtx, body: Record<string, unknown>) {
  if (!(staff.role === 'admin' || staff.impersonating)) throw new HttpError(403, 'Only the shop admin can change this')
  if (typeof body.enabled !== 'boolean') throw bad('enabled must be true or false')
  const { error } = await db.from('shops').update({ portal_enabled: body.enabled }).eq('id', staff.shopId)
  if (error) throw new HttpError(500, 'Could not save')
  // Switching off ends every customer session for the shop.
  if (!body.enabled) await db.from('customer_sessions').delete().eq('shop_id', staff.shopId)
  await audit(req, staff.shopId, { id: staff.userId, label: staff.username },
    body.enabled ? 'PORTAL_SHOP_ENABLED' : 'PORTAL_SHOP_DISABLED', null)
  return staffShopPortal(staff)
}

async function staffDisable(req: Request, staff: StaffCtx, body: Record<string, unknown>) {
  const { cust } = await staffCustomer(staff, body)
  await db.from('customer_portal_accounts').update({ is_enabled: false, updated_at: new Date().toISOString() })
    .eq('customer_id', cust.id).eq('shop_id', staff.shopId)
  await db.from('customer_sessions').delete().eq('customer_id', cust.id)
  await audit(req, staff.shopId, { id: staff.userId, label: staff.username }, 'PORTAL_DISABLED', cust.id)
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

    switch (action) {
      // Public
      case 'shop_info': return json(200, await shopInfo(body))
      case 'login': return json(200, await login(req, body))

      // Customer (x-portal-token)
      case 'summary': return json(200, await summary(await requireCustomer(req)))
      case 'bills': return json(200, await bills(await requireCustomer(req), body))
      case 'bill': return json(200, await bill(await requireCustomer(req), body))
      case 'statement': return json(200, await statement(await requireCustomer(req), body))
      case 'change_pin': { const ctx = await requireCustomer(req); return json(200, await changePin(req, ctx, body)) }
      case 'logout': return json(200, await customerLogout(await requireCustomer(req)))

      // Shop staff (x-session-token)
      case 'staff_status': return json(200, await staffStatus(await requireStaff(req), body))
      case 'staff_issue_pin': {
        const staff = await requireStaff(req)
        const result = await staffIssuePin(req, staff, body)
        return json(result.error ? 409 : 200, result)
      }
      case 'staff_disable': { const staff = await requireStaff(req); return json(200, await staffDisable(req, staff, body)) }
      case 'staff_shop_portal': return json(200, await staffShopPortal(await requireStaff(req)))
      case 'staff_set_shop_portal': { const staff = await requireStaff(req); return json(200, await staffSetShopPortal(req, staff, body)) }

      default: throw bad('Unknown action')
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    const message = err instanceof HttpError ? err.message : 'Internal error'
    const code = err instanceof HttpError ? err.code : undefined
    if (!(err instanceof HttpError)) console.error(err)
    return json(status, { data: null, error: { message, status, code } })
  }
})
