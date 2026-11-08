// Shared bits for the customer portal pages (/c/:slug/...).
import { createContext, useContext } from 'react'
import { CircleAlert } from 'lucide-react'

export const PortalContext = createContext(null)

/** { slug, shop, customerName, call(action, params) } — call() signs out on an expired session. */
export function usePortal() {
  return useContext(PortalContext)
}

export function money(v) {
  const n = Number(v) || 0
  return `Rs ${n.toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
}

export function fmtDate(v, withTime = false) {
  if (!v) return '—'
  return new Date(v).toLocaleString('en-PK', withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
}

const MODES = { cash: 'Cash', credit: 'Credit', online: 'Online', split: 'Split', card: 'Card', bank: 'Bank' }
export const modeLabel = (m) => (m ? MODES[m] || m.charAt(0).toUpperCase() + m.slice(1) : '')

/** How to describe a balance: positive = customer owes, negative = advance with the shop. */
export function balanceTone(balance) {
  const b = Number(balance) || 0
  if (b > 0) return { label: 'You owe', cls: 'text-danger-fg', chip: 'badge-danger' }
  if (b < 0) return { label: 'Advance with shop', cls: 'text-info-fg', chip: 'badge-info' }
  return { label: 'All clear', cls: 'text-success-fg', chip: 'badge-success' }
}

// yyyy-mm-dd in local time, for <input type="date"> and API date ranges.
export function isoDay(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

export const PERIODS = [
  { id: 'month', label: 'This month' },
  { id: '3m', label: 'Last 3 months' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
]

export function periodRange(id) {
  const now = new Date()
  if (id === 'month') return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDay(now) }
  if (id === '3m') return { from: isoDay(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: isoDay(now) }
  if (id === 'year') return { from: isoDay(new Date(now.getFullYear(), 0, 1)), to: isoDay(now) }
  return { from: '', to: '' }
}

export function ErrorBox({ children, onRetry }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger-strong">
      <CircleAlert size={18} className="shrink-0 mt-px" aria-hidden="true" />
      <div className="flex-1">
        <p>{children}</p>
        {onRetry && <button type="button" onClick={onRetry} className="mt-1 font-semibold underline">Try again</button>}
      </div>
    </div>
  )
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-fg-muted" role="status">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-primary" aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function PageTitle({ children, action }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h1 className="text-xl font-extrabold tracking-tight text-fg">{children}</h1>
      {action}
    </div>
  )
}

/** Local-day yyyy-mm-dd bounds -> ISO instants for the API (start of `from`, end of `to`). */
export function toApiRange({ from, to }) {
  return {
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  }
}
