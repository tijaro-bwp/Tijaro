// WhatsApp message helpers for bills and payments.
// Placeholders (all optional in a template):
//   [Name] [Shop Name] [ID] [Amount] [Bill Total] [Paid Now] [Bill Balance]
//   [Previous Balance] [New Balance] [Bills] [Bill Link] [Portal Link]
// Unknown or empty values are removed, and lines left empty by a missing link
// are dropped, so one template works with or without a link.

// The shops table's own column default (older text) still applies to existing
// shops; Settings offers "Use recommended" to switch to these.
export const DEFAULT_BILL_TEMPLATE = [
  'Assalam o Alaikum [Name],',
  '',
  'Thank you for shopping at [Shop Name].',
  'Bill #[ID]: Rs. [Bill Total]',
  'Paid: Rs. [Paid Now]',
  'Remaining on this bill: Rs. [Bill Balance]',
  '',
  'Previous balance: Rs. [Previous Balance]',
  'New balance: Rs. [New Balance]',
  '',
  'View your bill: [Bill Link]',
].join('\n')

export const DEFAULT_PAYMENT_TEMPLATE = [
  'Assalam o Alaikum [Name],',
  '',
  'We have received Rs. [Paid Now]. Thank you!',
  '',
  '[Bills]',
  '',
  'Previous balance: Rs. [Previous Balance]',
  'New balance: Rs. [New Balance]',
  '',
  'View your bill: [Bill Link]',
  '',
  '[Shop Name]',
].join('\n')

// Sent when a delivery bill leaves the shop with a loader (POS → Delivery).
export const DEFAULT_DELIVERY_TEMPLATE = [
  'Assalam o Alaikum [Name],',
  '',
  'Your order from [Shop Name] is on the way.',
  'Delivered by: [Loader]',
  'Bill #[ID]: Rs. [Bill Total]',
  'Paid: Rs. [Paid Now]',
  'To pay on delivery: Rs. [Bill Balance]',
  '',
  'Previous balance: Rs. [Previous Balance]',
  'New balance: Rs. [New Balance]',
  '',
  'View your bill: [Bill Link]',
].join('\n')

// Built-in texts from before balances and links existed. Every shop got this
// one as its stored default, so a stored copy means "never customised".
const LEGACY_BILL_TEMPLATES = [
  'Hello [Name], thank you for shopping at [Shop Name]! Your bill summary for Invoice #[ID] is Rs. [Amount]. Thank you for your business!',
]
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/** The bill template to use: the shop's own, or the current default if empty / an old built-in one. */
export function resolveBillTemplate(stored) {
  const t = norm(stored)
  if (!t || LEGACY_BILL_TEMPLATES.some((l) => norm(l) === t)) return DEFAULT_BILL_TEMPLATE
  return stored
}

/** The payment template to use: the shop's own, or the current default. */
export function resolvePaymentTemplate(stored) {
  return norm(stored) ? stored : DEFAULT_PAYMENT_TEMPLATE
}

/** Rs amounts without decimals unless needed: 1500 -> "1,500", 99.5 -> "99.5". */
export function fmtRs(v) {
  const n = Number(v) || 0
  return n.toLocaleString('en-PK', { maximumFractionDigits: 2 })
}

/** 03001234567 / 3001234567 / +92 300... -> 923001234567 (for wa.me). */
export function waPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '')
  if (d.startsWith('0092')) d = d.slice(2)
  if (d.startsWith('03') && d.length === 11) d = '92' + d.slice(1)
  else if (d.length === 10 && d.startsWith('3')) d = '92' + d
  return d
}

export const billNo = (id) => String(id ?? '').slice(-8)

/**
 * The number printed on a bill: the shop's own sequence (INV-0042, set by the
 * database: sql/pos_modes_migration.sql) or, for older / not-yet-synced bills,
 * the last 8 digits of its id.
 */
export function saleBillNo(sale) {
  if (sale?.invoice_number) return String(sale.invoice_number)
  return billNo(sale?.id)
}

/** One line per bill for the [Bills] placeholder. */
export function billLines(bills = []) {
  return bills.map((b) =>
    `Bill #${b.bill_no || billNo(b.sale_id)}: total Rs. ${fmtRs(b.net_total)}, paid now Rs. ${fmtRs(b.paid_now)}, ` +
    (Number(b.due) > 0 ? `remaining Rs. ${fmtRs(b.due)}` : 'fully paid ✓')
  ).join('\n')
}

const KEYS = {
  name: '[Name]',
  shopName: '[Shop Name]',
  id: '[ID]',
  amount: '[Amount]',
  billTotal: '[Bill Total]',
  paidNow: '[Paid Now]',
  billBalance: '[Bill Balance]',
  previousBalance: '[Previous Balance]',
  newBalance: '[New Balance]',
  bills: '[Bills]',
  billLink: '[Bill Link]',
  portalLink: '[Portal Link]',
  loader: '[Loader]',
}
const MONEY = new Set(['amount', 'billTotal', 'paidNow', 'billBalance', 'previousBalance', 'newBalance'])

/**
 * Fill a template. `values` uses the camelCase keys above; money values are
 * numbers and get formatted. On multi-line templates, a line whose placeholder
 * has no value (no link, walk-in without balance…) is dropped instead of
 * leaving "New balance: Rs. " behind. One-line templates just get blanks.
 */
export function fillTemplate(template, values = {}) {
  let out = String(template || '')
  const multiLine = out.includes('\n')
  for (const [key, ph] of Object.entries(KEYS)) {
    if (!out.includes(ph)) continue
    const raw = values[key]
    const has = raw !== undefined && raw !== null && raw !== '' && !(MONEY.has(key) && !Number.isFinite(Number(raw)))
    if (!has && multiLine) {
      out = out.split('\n').filter((line) => !line.includes(ph)).join('\n')
      continue
    }
    const text = !has ? '' : MONEY.has(key) ? fmtRs(raw) : String(raw)
    out = out.split(ph).join(text)
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Opens WhatsApp (app on phones, web on desktop) with the text ready to send. */
export function openWhatsApp(phone, text) {
  const p = waPhone(phone)
  const url = p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`
  window.open(url, '_blank', 'noopener')
}
