// One bill: items, totals, payments made against it and what it still owes.
// Shared by the logged-in portal (/c/:slug/bills/:id) and no-login links (/b/:token).
import { money, fmtDate, modeLabel } from './portalUi'

export default function BillView({ bill, shopName }) {
  // Older portal-api versions return only `paid` (= paid at purchase).
  const paidAtSale = bill.paid_at_sale ?? bill.paid
  const payments = bill.payments || []

  return (
    <article className="card p-5 sm:p-6 print:shadow-none print:border-0">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
        <div>
          {shopName && <p className="text-sm text-fg-muted">{shopName}</p>}
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
        <div className="flex justify-between"><dt className="text-fg-muted">Paid at purchase</dt><dd className="text-success-fg">{money(paidAtSale)}</dd></div>
        {payments.map((p) => (
          <div key={p.id} className="flex justify-between">
            <dt className="text-fg-muted">Paid {fmtDate(p.date)}{p.payment_mode ? ` · ${modeLabel(p.payment_mode)}` : ''}</dt>
            <dd className="text-success-fg">{money(p.amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between font-semibold border-t border-line-subtle pt-1.5">
          <dt className="text-fg">{bill.due > 0 ? 'Left to pay on this bill' : 'Bill status'}</dt>
          <dd className={bill.due > 0 ? 'text-danger-fg' : 'text-success-fg'}>{bill.due > 0 ? money(bill.due) : 'Fully paid'}</dd>
        </div>
      </dl>
    </article>
  )
}
