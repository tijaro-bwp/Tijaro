import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ReceiptText, BookOpen, ChevronRight, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { usePortal, money, fmtDate, balanceTone, Spinner, ErrorBox } from './portalUi'

const KIND = {
  bill: { label: 'Bill', icon: ArrowUpRight, cls: 'text-danger-fg bg-danger-soft' },
  charge: { label: 'Charge', icon: ArrowUpRight, cls: 'text-danger-fg bg-danger-soft' },
  payment: { label: 'Payment', icon: ArrowDownLeft, cls: 'text-success-fg bg-success-soft' },
  return: { label: 'Return', icon: ArrowDownLeft, cls: 'text-success-fg bg-success-soft' },
  refund: { label: 'Refund', icon: ArrowDownLeft, cls: 'text-fg-muted bg-surface-3' },
  opening: { label: 'Opening', icon: ArrowUpRight, cls: 'text-fg-muted bg-surface-3' },
}

export function EntryRow({ e, slug, showBalance = true }) {
  const k = KIND[e.kind] || KIND.opening
  const Icon = k.icon
  const amount = e.debit > 0 ? `+ ${money(e.debit)}` : e.credit > 0 ? `− ${money(e.credit)}` : money(e.amount)
  const body = (
    <div className="flex items-center gap-3 py-3">
      <span className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${k.cls}`} aria-hidden="true"><Icon size={18} /></span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-fg truncate">{e.description}</p>
        <p className="text-xs text-fg-muted">
          {fmtDate(e.date)}
          {e.kind === 'bill' && e.amount !== e.debit ? ` · Bill ${money(e.amount)}, paid ${money(e.paid_at_sale)}` : ''}
          {e.kind === 'refund' ? ' · no change to balance' : ''}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className={`font-bold ${e.debit > 0 ? 'text-danger-fg' : e.credit > 0 ? 'text-success-fg' : 'text-fg-muted'}`}>{amount}</p>
        {showBalance && <p className="text-xs text-fg-subtle">Bal {money(e.balance)}</p>}
      </div>
      {e.kind === 'bill' && slug && <ChevronRight size={18} className="shrink-0 text-fg-subtle print:hidden" aria-hidden="true" />}
    </div>
  )
  return e.kind === 'bill' && slug
    ? <Link to={`/c/${slug}/bills/${e.id}`} className="block rounded-xl -mx-2 px-2 hover:bg-surface-3">{body}</Link>
    : body
}

export default function PortalHome() {
  const { slug, call, setCustomerName } = usePortal()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    const { data: d, error: err } = await call('summary')
    if (err) { if (err.code !== 'no_session') setError(err.message); return }
    setData(d)
    setCustomerName(d.customer?.name || '')
  }, [call, setCustomerName])

  useEffect(() => { load() }, [load])

  if (error) return <ErrorBox onRetry={load}>{error}</ErrorBox>
  if (!data) return <Spinner />

  const tone = balanceTone(data.balance)

  return (
    <div className="space-y-5">
      <p className="text-fg-muted">Assalam o Alaikum{data.customer?.name ? `, ${data.customer.name}` : ''}</p>

      <section aria-label="Balance" className="card p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-fg-muted">Current balance</p>
          <span className={`badge ${tone.chip}`}>{tone.label}</span>
        </div>
        <p className={`mt-2 text-4xl font-extrabold tracking-tight ${tone.cls}`}>{money(Math.abs(data.balance))}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-surface-2 p-3">
            <p className="text-fg-muted">Last bill</p>
            <p className="font-semibold text-fg">{data.last_bill ? money(data.last_bill.amount) : '—'}</p>
            <p className="text-xs text-fg-subtle">{data.last_bill ? fmtDate(data.last_bill.date) : 'No bills yet'}</p>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <p className="text-fg-muted">Last payment</p>
            <p className="font-semibold text-fg">{data.last_payment ? money(data.last_payment.amount) : '—'}</p>
            <p className="text-xs text-fg-subtle">{data.last_payment ? fmtDate(data.last_payment.date) : 'No payments yet'}</p>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3">
        <Link to={`/c/${slug}/bills`} className="card p-4 flex items-center gap-3 hover:border-primary-line">
          <span className="w-10 h-10 rounded-xl bg-primary-soft text-primary-strong flex items-center justify-center" aria-hidden="true"><ReceiptText size={20} /></span>
          <span>
            <span className="block font-bold text-fg">Bills</span>
            <span className="block text-xs text-fg-muted">{data.bill_count} total</span>
          </span>
        </Link>
        <Link to={`/c/${slug}/statement`} className="card p-4 flex items-center gap-3 hover:border-primary-line">
          <span className="w-10 h-10 rounded-xl bg-primary-soft text-primary-strong flex items-center justify-center" aria-hidden="true"><BookOpen size={20} /></span>
          <span>
            <span className="block font-bold text-fg">Statement</span>
            <span className="block text-xs text-fg-muted">Full ledger</span>
          </span>
        </Link>
      </div>

      <section aria-label="Recent activity" className="card p-4 sm:p-5">
        <h2 className="font-bold text-fg mb-1">Recent activity</h2>
        {data.recent.length === 0
          ? <p className="py-6 text-center text-sm text-fg-muted">Nothing here yet.</p>
          : <div className="divide-y divide-line-subtle">{data.recent.map((e) => <EntryRow key={`${e.kind}-${e.id}`} e={e} slug={slug} />)}</div>}
      </section>
    </div>
  )
}
