// ============================================================================
// Data-integrity helpers shared by POS, Purchases, Sales returns and ledgers.
//
// - toIntId / isTempId: offline-created records carry UUID ids until they sync.
//   Never parseInt() a UUID: parseInt('7c9e...') === 7 links data to record #7.
// - adjustStock / adjustCustomerBalance / adjustSupplierBalance: apply a
//   *change* atomically in the database (sql/data_integrity_migration.sql)
//   instead of writing a total computed from stale browser data. Offline (or
//   when the target record is not synced yet) the change is queued and replayed
//   by syncService as the same atomic call.
// ============================================================================
import { supabase } from './supabase'
import { db, addToSyncQueue } from './db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isTempId = (v) => typeof v === 'string' && UUID_RE.test(v.trim())

// Strict integer id: '12' → 12, 12 → 12, UUID / '' / null → null
export function toIntId(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  const s = String(v ?? '').trim()
  return /^\d+$/.test(s) ? parseInt(s, 10) : null
}

// supabase-js reports network failures as an error object (it does not throw)
export function isNetworkError(err) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true
  const msg = String(err?.message || err || '')
  return /Failed to fetch|NetworkError|Load failed|network request failed|fetch failed/i.test(msg)
}

// Function not deployed yet (migration not run) → PostgREST PGRST202 / Postgres 42883
const isMissingFunction = (err) => err && (err.code === 'PGRST202' || err.code === '42883')

const RPC_TARGETS = {
  adjust_product_stock:    { table: 'products',  column: 'stock_quantity',      idParam: 'p_product_id' },
  adjust_customer_balance: { table: 'customers', column: 'outstanding_balance', idParam: 'p_customer_id' },
  adjust_supplier_balance: { table: 'suppliers', column: 'outstanding_balance', idParam: 'p_supplier_id' },
}

async function getLocal(table, id) {
  return (await db[table].get(id)) || (toIntId(id) != null ? await db[table].get(toIntId(id)) : undefined)
}

// Apply the same delta to the local IndexedDB copy so screens update instantly
export async function applyLocalDelta(table, column, id, delta) {
  try {
    const rec = await getLocal(table, id)
    if (!rec) return
    await db[table].update(rec.id, { [column]: (Number(rec[column]) || 0) + delta })
  } catch (e) {
    console.warn(`integrity: local ${table}.${column} update failed`, e)
  }
}

/**
 * Run an atomic delta RPC online. Used by both the app and the sync queue.
 * Returns { ok: true } on success, { ok: false, network: true } when it
 * should be retried later, or { ok: false, error } for a hard failure.
 */
export async function runDeltaRpc(fn, params) {
  if (fn === 'receive_stock_weighted') return runReceiveStock(params)
  const target = RPC_TARGETS[fn]
  if (!target) return { ok: false, error: new Error(`Unknown delta function ${fn}`) }
  const delta = Number(params.p_delta) || 0
  const id = toIntId(params[target.idParam])
  if (id == null) return { ok: false, error: new Error(`${fn}: record not synced yet`), pendingRef: true }
  if (delta === 0) return { ok: true }

  const { error } = await supabase.rpc(fn, { [target.idParam]: id, p_delta: delta })
  if (!error) return { ok: true }
  if (isNetworkError(error)) return { ok: false, network: true, error }

  if (isMissingFunction(error)) {
    // Database not migrated yet: best effort read-live-then-write (still racy,
    // but never based on stale browser data). Run sql/data_integrity_migration.sql.
    console.warn(`${fn} missing — run sql/data_integrity_migration.sql. Using fallback update.`)
    const { data, error: readErr } = await supabase.from(target.table).select(target.column).eq('id', id).maybeSingle()
    if (readErr) return { ok: false, network: isNetworkError(readErr), error: readErr }
    if (!data) return { ok: false, error: new Error(`${target.table} ${id} not found`) }
    const next = (Number(data[target.column]) || 0) + delta
    const { error: writeErr } = await supabase.from(target.table).update({ [target.column]: next }).eq('id', id)
    if (writeErr) return { ok: false, network: isNetworkError(writeErr), error: writeErr }
    return { ok: true }
  }
  return { ok: false, error }
}

// Online when possible, otherwise queued. Local copy is always updated once.
async function adjust(fn, id, delta) {
  const target = RPC_TARGETS[fn]
  const d = Number(delta) || 0
  if (!d || id == null || id === '') return { ok: true }
  const params = { [target.idParam]: id, p_delta: d }

  let result = { ok: false, network: true }
  if (navigator.onLine && !isTempId(String(id))) {
    result = await runDeltaRpc(fn, params)
  }
  if (!result.ok && (result.network || isTempId(String(id)))) {
    await addToSyncQueue(fn, 'RPC', params)
    result = { ok: true, queued: true }
  }
  if (result.ok) await applyLocalDelta(target.table, target.column, id, d)
  return result
}

export const adjustStock = (productId, delta) => adjust('adjust_product_stock', productId, delta)
export const adjustCustomerBalance = (customerId, delta) => adjust('adjust_customer_balance', customerId, delta)
export const adjustSupplierBalance = (supplierId, delta) => adjust('adjust_supplier_balance', supplierId, delta)

// Unique-violation on client_ref means the row already exists (earlier attempt
// reached the server). Fetch it instead of creating a duplicate.
export async function findByClientRef(table, clientRef) {
  if (!clientRef) return null
  const { data } = await supabase.from(table).select('*').eq('client_ref', clientRef).maybeSingle()
  return data || null
}

// Strip columns an un-migrated database does not have yet (PGRST204 / 42703)
export const isMissingColumn = (err) => err && (err.code === 'PGRST204' || err.code === '42703')

// ── Sale delete / restore ────────────────────────────────────────────
// A completed sale removed stock and (for credit) raised the customer's balance.
// Deleting it must undo both; restoring it from Trash must apply them again.

// Columns of a `sales` row only — drops joined objects such as `customers(name)`
// that came from list queries and would break an insert/upsert.
export function saleRowOnly(sale) {
  const row = {}
  for (const [k, v] of Object.entries(sale || {})) {
    if (k.startsWith('__')) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'payment_details') continue
    row[k] = v
  }
  return row
}

// Amount the sale added to the customer's balance (net total minus what was paid toward it)
export function saleUnpaidAmount(sale) {
  const net = Math.max(0, Number(sale?.total_amount || 0) - Number(sale?.discount || 0))
  const paid = Math.min(net, Number(sale?.paid_amount ?? sale?.amount_paid ?? 0))
  return Math.max(0, net - paid)
}

/**
 * direction = 'reverse' (sale deleted: stock back, balance down)
 *           | 'apply'   (sale restored: stock out, balance up)
 * Returns the names of updates that failed (empty array = all good / queued).
 */
export async function applySaleEffects(sale, items, direction) {
  if (!sale || sale.sale_type === 'quotation') return []
  const sign = direction === 'reverse' ? 1 : -1
  const failed = []
  for (const it of items || []) {
    const remaining = Number(it.quantity || 0) - Number(it.returned_qty || 0)
    if (remaining <= 0 || it.product_id == null) continue
    const r = await adjustStock(it.product_id, sign * remaining)
    if (!r.ok) failed.push(it.product_name || `product ${it.product_id}`)
  }
  const unpaid = saleUnpaidAmount(sale)
  if (sale.customer_id && unpaid > 0) {
    const r = await adjustCustomerBalance(sale.customer_id, -sign * unpaid)
    if (!r.ok) failed.push('customer balance')
  }
  return failed
}

/**
 * How a sale return is refunded.
 * - The bill-level discount is shared across all items in proportion to their value,
 *   so returning goods from a discounted bill refunds what was actually paid for them.
 * - Goods that were never paid for (credit sale) come off the customer's balance;
 *   only the remainder is handed back as cash. With refundType 'credit' the whole
 *   refund goes to the balance (store credit).
 * Returns the refund split plus the sale's new total / discount / paid_amount.
 */
export function splitReturnRefund({ sale, saleItems, returnLines, refundType, unpaidOnSale }) {
  const round2 = (n) => Math.round(n * 100) / 100
  const gross = (saleItems || []).reduce((s, it) => s + Number(it.unit_price || 0) * Number(it.quantity || 0), 0)
  const discount = Number(sale?.discount || 0)
  const ratio = gross > 0 ? Math.min(1, Math.max(0, discount / gross)) : 0
  const returnGross = (returnLines || []).reduce((s, l) => s + Number(l.unit_price || 0) * Number(l.qty || 0), 0)
  const refund = round2(returnGross * (1 - ratio))
  const discountShare = round2(returnGross * ratio)

  const hasCustomer = !!sale?.customer_id
  let creditPart = 0
  if (hasCustomer) {
    creditPart = refundType === 'credit' ? refund : Math.min(refund, Math.max(0, Number(unpaidOnSale || 0)))
  }
  creditPart = round2(creditPart)
  const cashPart = round2(refund - creditPart)

  return {
    refund,
    creditPart,
    cashPart,
    newTotal: round2(Math.max(0, Number(sale?.total_amount || 0) - returnGross)),
    newDiscount: round2(Math.max(0, discount - discountShare)),
    newPaid: round2(Math.max(0, Number(sale?.paid_amount ?? sale?.amount_paid ?? 0) - cashPart)),
  }
}

// Await a Supabase query and throw if it failed (supabase-js returns errors
// instead of throwing, so a bare `await supabase.from(...).update(...)` silently
// ignores failures).
export async function must(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

// ── Weighted-average cost on stock receipt (sql/weighted_cost_migration.sql) ──
// Receiving stock blends the cost price instead of overwriting it with the
// latest purchase price:  (stock × cost + qty × unitCost) / (stock + qty).
// With no stock on hand (0 or negative) the new cost is the purchase price.
export function weightedCost(stock, cost, qty, unitCost) {
  const s = Number(stock) || 0
  const c = Number(cost) || 0
  const q = Number(qty) || 0
  const u = Number(unitCost) || 0
  if (s > 0 && s + q > 0) return Math.round(((s * c + q * u) / (s + q)) * 100) / 100
  return u
}

async function runReceiveStock(params) {
  const id = toIntId(params.p_product_id)
  if (id == null) return { ok: false, error: new Error('receive_stock_weighted: product not synced yet'), pendingRef: true }
  const qty = Number(params.p_qty) || 0
  const unitCost = Number(params.p_unit_cost) || 0
  const { error } = await supabase.rpc('receive_stock_weighted', { p_product_id: id, p_qty: qty, p_unit_cost: unitCost })
  if (!error) return { ok: true }
  if (isNetworkError(error)) return { ok: false, network: true, error }
  if (isMissingFunction(error)) {
    // Database not migrated yet: read live values, then write stock + blended cost
    console.warn('receive_stock_weighted missing — run sql/weighted_cost_migration.sql. Using fallback update.')
    const { data, error: readErr } = await supabase.from('products').select('stock_quantity, cost_price').eq('id', id).maybeSingle()
    if (readErr) return { ok: false, network: isNetworkError(readErr), error: readErr }
    if (!data) return { ok: false, error: new Error(`product ${id} not found`) }
    const next = {
      stock_quantity: (Number(data.stock_quantity) || 0) + qty,
      cost_price: weightedCost(data.stock_quantity, data.cost_price, qty, unitCost),
    }
    const { error: writeErr } = await supabase.from('products').update(next).eq('id', id)
    if (writeErr) return { ok: false, network: isNetworkError(writeErr), error: writeErr }
    return { ok: true }
  }
  return { ok: false, error }
}

/** Receive purchased stock: +qty and weighted-average cost, atomically (queued offline). */
export async function receivePurchaseStock(productId, qty, unitCost) {
  const q = Number(qty) || 0
  if (!q || productId == null || productId === '') return { ok: true }
  const params = { p_product_id: productId, p_qty: q, p_unit_cost: Number(unitCost) || 0 }

  let result = { ok: false, network: true }
  if (navigator.onLine && !isTempId(String(productId))) result = await runReceiveStock(params)
  if (!result.ok && (result.network || isTempId(String(productId)))) {
    await addToSyncQueue('receive_stock_weighted', 'RPC', params)
    result = { ok: true, queued: true }
  }
  if (result.ok) {
    // Same blend on the local copy so screens update immediately
    try {
      const rec = await getLocal('products', productId)
      if (rec) {
        await db.products.update(rec.id, {
          cost_price: weightedCost(rec.stock_quantity, rec.cost_price, q, params.p_unit_cost),
          stock_quantity: (Number(rec.stock_quantity) || 0) + q,
        })
      }
    } catch (e) {
      console.warn('integrity: local stock/cost update failed', e)
    }
  }
  return result
}
