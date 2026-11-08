import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { usePortal, money, fmtDate, modeLabel, Spinner, ErrorBox } from './portalUi'

export default function PortalBill() {
  const { id } = useParams()
  const { slug, shop, call } = usePortal()
  const [bill, setBill] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    const { data, error: err } = await call('bill', { id: Number(id) })
    if (err) { if (err.code !== 'no_session') setError(err.message); return }
    setBill(data)
  }, [call, id])

  useEffect(() => { load() }, [load])

  const back = (
    <Link to={`/c/${slug}/bills`} className="inline-flex items-center gap-1.5 mb-4 text-sm font-semibold text-primary-fg print:hidden">
      <ArrowLeft size={16} aria-hidden="true" /> All bills
    </Link>
  )

  if (error) return <div>{back}<ErrorBox onRetry={load}>{error}</ErrorBox></div>
  if (!bill) return <div>{back}<Spinner /></div>

  return (
    <div>
      {back}
      <article className="card p-5 sm:p-6 print:shadow-none print:border-0">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
          <div>
            <p className="text-sm text-fg-muted">{shop?.name}</p>
            <h1 className="text-xl font-extrabold text-fg">Bill #{bill.bill_no}</h1>
            <p className="text-sm text-fg-muted">{fmtDate(bill.date, true)}{bill.payment_mode ? ` · ${modeLabel(bill.payment_mode)}` : ''}</p>
          </div>
          {bill.due > 0
            ? <span className="badge badge-danger">Due {money(bill.due)}</span>
            : <span className="badge badge-success">Paid</span>}
        </header>

        <ul className="divide-y divide-line-subtle">
          {bill.items.map((it, i) => (
            <li key={i} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-semibold text-fg">{it.name}</p>
                <p className="text-sm text-fg-muted">{it.quantity} × {money(it.unit_price)}</p>
                {it.returned_qty > 0 && <p className="text-xs text-warning-strong">{it.returned_qty} returned</p>}
              </div>
              <p className="font-semibold text-fg shrink-0">{money(it.line_total)}</p>
            </li>
          ))}
          {bill.items.length === 0 && <li className="py-6 text-center text-sm text-fg-muted">No item details for this bill.</li>}
        </ul>

        <dl className="mt-2 border-t border-line pt-4 space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-fg-muted">Subtotal</dt><dd className="text-fg">{money(bill.subtotal)}</dd></div>
          {bill.discount > 0 && <div className="flex justify-between"><dt className="text-fg-muted">Discount</dt><dd className="text-fg">− {money(bill.discount)}</dd></div>}
          <div className="flex justify-between text-base font-bold"><dt className="text-fg">Total</dt><dd className="text-fg">{money(bill.total)}</dd></div>
          <div className="flex justify-between"><dt className="text-fg-muted">Paid at purchase</dt><dd className="text-success-fg">{money(bill.paid)}</dd></div>
          {bill.due > 0 && <div className="flex justify-between font-semibold"><dt className="text-fg">Left to pay on this bill</dt><dd className="text-danger-fg">{money(bill.due)}</dd></div>}
        </dl>
        {bill.due > 0 && (
          <p className="mt-3 text-xs text-fg-subtle">Later payments are shown in your statement and reduce your overall balance.</p>
        )}
      </article>

      <button type="button" onClick={() => window.print()} className="btn btn-secondary w-full mt-4 print:hidden">
        <Printer size={16} aria-hidden="true" /> Print or save as PDF
      </button>
    </div>
  )
}
