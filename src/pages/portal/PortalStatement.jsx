import { useCallback, useEffect, useState } from 'react'
import { Printer } from 'lucide-react'
import { usePortal, money, fmtDate, PERIODS, periodRange, toApiRange, Spinner, ErrorBox, PageTitle } from './portalUi'
import { EntryRow } from './PortalHome'

export default function PortalStatement() {
  const { slug, shop, customerName, call } = usePortal()
  const [period, setPeriod] = useState('3m')
  const [range, setRange] = useState(() => periodRange('3m'))
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const choosePeriod = (id) => {
    setPeriod(id)
    setRange(periodRange(id))
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const { data: d, error: err } = await call('statement', toApiRange(range))
    setLoading(false)
    if (err) { if (err.code !== 'no_session') setError(err.message); return }
    setData(d)
  }, [call, range])

  useEffect(() => { load() }, [load])

  const rangeLabel = range.from || range.to
    ? `${range.from ? fmtDate(`${range.from}T00:00:00`) : 'Start'} – ${range.to ? fmtDate(`${range.to}T00:00:00`) : 'Today'}`
    : 'All time'

  return (
    <div>
      <PageTitle
        action={data && (
          <button type="button" onClick={() => window.print()} className="btn btn-secondary btn-sm print:hidden">
            <Printer size={16} aria-hidden="true" /> Print / PDF
          </button>
        )}
      >
        Statement
      </PageTitle>

      {/* Printed heading */}
      <div className="hidden print:block mb-4">
        <p className="text-lg font-bold">{shop?.name} — Account statement</p>
        <p className="text-sm">{customerName} · {rangeLabel}</p>
      </div>

      <div className="print:hidden space-y-3 mb-4">
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => choosePeriod(p.id)}
              aria-pressed={period === p.id}
              className={`btn btn-sm shrink-0 ${period === p.id ? 'btn-primary' : 'btn-secondary'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block mb-1 font-semibold text-fg-2">From</span>
            <input type="date" className="input" value={range.from} max={range.to || undefined}
              onChange={(e) => { setPeriod('custom'); setRange((r) => ({ ...r, from: e.target.value })) }} />
          </label>
          <label className="text-sm">
            <span className="block mb-1 font-semibold text-fg-2">To</span>
            <input type="date" className="input" value={range.to} min={range.from || undefined}
              onChange={(e) => { setPeriod('custom'); setRange((r) => ({ ...r, to: e.target.value })) }} />
          </label>
        </div>
      </div>

      {error && <ErrorBox onRetry={load}>{error}</ErrorBox>}
      {!error && loading && !data && <Spinner />}

      {data && !error && (
        <div className={loading ? 'opacity-60 transition-opacity' : ''}>
          <section aria-label="Summary" className="card p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
            <div><p className="text-fg-muted">Opening</p><p className="font-bold text-fg">{money(data.opening_balance)}</p></div>
            <div><p className="text-fg-muted">Bills &amp; charges</p><p className="font-bold text-danger-fg">+ {money(data.total_debit)}</p></div>
            <div><p className="text-fg-muted">Payments &amp; returns</p><p className="font-bold text-success-fg">− {money(data.total_credit)}</p></div>
            <div><p className="text-fg-muted">Closing</p><p className="font-bold text-fg">{money(data.closing_balance)}</p></div>
          </section>

          <section aria-label="Entries" className="card px-4 py-1">
            {data.entries.length === 0
              ? <p className="py-10 text-center text-sm text-fg-muted">No activity in this period.</p>
              : <div className="divide-y divide-line-subtle">{data.entries.map((e) => <EntryRow key={`${e.kind}-${e.id}`} e={e} slug={slug} />)}</div>}
          </section>

          {data.closing_balance !== data.current_balance && (
            <p className="mt-3 text-sm text-fg-muted">Your balance today is <span className="font-semibold text-fg">{money(data.current_balance)}</span>.</p>
          )}
        </div>
      )}
    </div>
  )
}
