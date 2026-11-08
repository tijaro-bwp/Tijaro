import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { usePortal, money, fmtDate, PERIODS, periodRange, toApiRange, Spinner, ErrorBox, PageTitle } from './portalUi'

export default function PortalBills() {
  const { slug, call } = usePortal()
  const [period, setPeriod] = useState('all')
  const [bills, setBills] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (p, reset) => {
    setLoading(true)
    setError('')
    const { data, error: err } = await call('bills', { page: p, page_size: 20, ...toApiRange(periodRange(period)) })
    setLoading(false)
    if (err) { if (err.code !== 'no_session') setError(err.message); return }
    setTotal(data.total)
    setPage(p)
    setBills((prev) => (reset ? data.bills : [...prev, ...data.bills]))
  }, [call, period])

  useEffect(() => { load(1, true) }, [load])

  return (
    <div>
      <PageTitle>Bills</PageTitle>

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPeriod(p.id)}
            aria-pressed={period === p.id}
            className={`btn btn-sm shrink-0 ${period === p.id ? 'btn-primary' : 'btn-secondary'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && <ErrorBox onRetry={() => load(1, true)}>{error}</ErrorBox>}

      {!error && bills.length === 0 && loading && <Spinner />}
      {!error && bills.length === 0 && !loading && (
        <p className="card py-10 text-center text-sm text-fg-muted">No bills in this period.</p>
      )}

      {bills.length > 0 && (
        <ul className="card divide-y divide-line-subtle overflow-hidden">
          {bills.map((b) => (
            <li key={b.id}>
              <Link to={`/c/${slug}/bills/${b.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-fg">Bill #{b.bill_no}</p>
                  <p className="text-xs text-fg-muted">{fmtDate(b.date, true)}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-fg">{money(b.total)}</p>
                  {b.due > 0
                    ? <span className="badge badge-danger">Due {money(b.due)}</span>
                    : <span className="badge badge-success">Paid</span>}
                </div>
                <ChevronRight size={18} className="text-fg-subtle shrink-0" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {bills.length > 0 && bills.length < total && (
        <button type="button" onClick={() => load(page + 1, false)} disabled={loading} className="btn btn-secondary w-full mt-4">
          {loading ? 'Loading…' : `Show more (${total - bills.length} left)`}
        </button>
      )}
    </div>
  )
}
