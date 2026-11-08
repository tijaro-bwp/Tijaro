// Deliveries: bills made in POS → Delivery mode. See what is out with which
// loader, how much each bill still has to collect, receive the money against
// the bill and mark it delivered. Online only (docs/POS_MODES.md).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Truck, CircleCheck, Printer, Wallet, RefreshCw, Search, MapPin, StickyNote } from 'lucide-react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { printHTML, getShopBranding } from '../utils/printUtils'
import { buildDeliverySlipHTML } from '../utils/deliverySlip'
import { fmtRs, saleBillNo } from '../utils/billMessages'
import ReceivePaymentModal from '../components/ReceivePaymentModal'

const TABS = [
  { id: 'out', label: 'Out for delivery' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'all', label: 'All' },
]
const COLS = 'id, invoice_number, created_at, customer_id, total_amount, discount, paid_amount, prev_balance, ' +
  'delivery_status, delivery_address, delivery_note, loader_name, dispatched_at, delivered_at, ' +
  'customers(id, shop_id, name, phone, address, outstanding_balance)'

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const when = (v) => (v ? new Date(v).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')

export default function Deliveries() {
  const { user } = useAuth()
  const [tab, setTab] = useState('out')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loader, setLoader] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(null)
  const [receiveFor, setReceiveFor] = useState(null) // customer row

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    if (!navigator.onLine) { setError('You are offline. The Deliveries page needs internet.'); setLoading(false); return }
    let q = supabase.from('sales').select(COLS).eq('shop_id', user.shop_id).eq('channel', 'delivery')
    if (tab === 'out') q = q.eq('delivery_status', 'out')
    else {
      if (tab === 'delivered') q = q.eq('delivery_status', 'delivered')
      q = q.gte('created_at', new Date(Date.now() - 30 * 86_400_000).toISOString())
    }
    const { data, error: err } = await q.order('created_at', { ascending: false }).limit(300)
    if (err) {
      setError(/channel|delivery_status/.test(err.message || '')
        ? 'Deliveries need a database update (sql/pos_modes_migration.sql). Ask your administrator.'
        : `Could not load deliveries: ${err.message}`)
      setRows([]); setLoading(false); return
    }
    const sales = data || []
    // Payments recorded later against these bills.
    const collected = new Map()
    if (sales.length) {
      const { data: pays } = await supabase.from('customer_payments')
        .select('sale_id, amount').eq('payment_type', 'payment').in('sale_id', sales.map((s) => s.id))
      for (const p of pays || []) collected.set(p.sale_id, (collected.get(p.sale_id) || 0) + Math.abs(Number(p.amount) || 0))
    }
    setRows(sales.map((s) => {
      const net = r2((Number(s.total_amount) || 0) - (Number(s.discount) || 0))
      const paid = r2((Number(s.paid_amount) || 0) + (collected.get(s.id) || 0))
      return { ...s, net, paid, due: Math.max(0, r2(net - paid)) }
    }))
    setLoading(false)
  }, [tab, user.shop_id])

  useEffect(() => { load() }, [load])

  const loaders = useMemo(() => [...new Set(rows.map((r) => r.loader_name).filter(Boolean))].sort(), [rows])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) =>
      (!loader || (loader === '__none' ? !r.loader_name : r.loader_name === loader)) &&
      (!q || [r.customers?.name, r.customers?.phone, r.invoice_number, String(r.id), r.delivery_address]
        .some((v) => String(v || '').toLowerCase().includes(q))))
  }, [rows, loader, search])

  const outRows = shown.filter((r) => r.delivery_status === 'out')
  const toCollect = r2(outRows.reduce((a, r) => a + r.due, 0))

  const markDelivered = async (row) => {
    setBusy(row.id)
    const { error: err } = await supabase.from('sales')
      .update({ delivery_status: 'delivered', delivered_at: new Date().toISOString() })
      .eq('id', row.id).eq('shop_id', user.shop_id)
    setBusy(null)
    if (err) { alert(`Could not update: ${err.message}`); return }
    if (tab === 'out') setRows((rs) => rs.filter((r) => r.id !== row.id))
    else setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, delivery_status: 'delivered', delivered_at: new Date().toISOString() } : r)))
  }

  const printSlip = async (row) => {
    setBusy(row.id)
    const { data: items } = await supabase.from('sale_items').select('product_name, quantity').eq('sale_id', row.id).order('id')
    setBusy(null)
    const branding = getShopBranding(user.shop_id)
    const prev = row.prev_balance === null || row.prev_balance === undefined ? null : Number(row.prev_balance)
    const paidAtSale = Number(row.paid_amount) || 0
    printHTML(buildDeliverySlipHTML({
      shop: { name: branding.name, phone: branding.phone },
      sale: row,
      items: items || [],
      customer: row.customers,
      delivery: { address: row.delivery_address, note: row.delivery_note, loader: row.loader_name },
      total: row.net,
      paid: paidAtSale,
      account: prev === null ? null : { previous: prev, newBalance: r2(prev + row.net - paidAtSale) },
    }))
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-extrabold text-fg flex items-center gap-2"><Truck size={24} aria-hidden="true" /> Deliveries</h1>
          <p className="text-sm text-fg-muted">Bills made in POS → Delivery mode. Receive the money against each bill when the loader is back.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={load} className="btn btn-secondary btn-sm"><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
          <Link to="/pos" className="btn btn-primary btn-sm"><Truck size={16} aria-hidden="true" /> New delivery bill</Link>
        </div>
      </div>

      <div role="tablist" aria-label="Status" className="flex gap-2 overflow-x-auto pb-1 mb-3">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`btn btn-sm shrink-0 ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <label className="relative sm:col-span-2">
          <span className="sr-only">Search</span>
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Customer, phone, bill #, address" className="input !pl-9" />
        </label>
        <label>
          <span className="sr-only">Loader</span>
          <select value={loader} onChange={(e) => setLoader(e.target.value)} className="input">
            <option value="">All loaders</option>
            {loaders.map((l) => <option key={l} value={l}>{l}</option>)}
            <option value="__none">No loader set</option>
          </select>
        </label>
      </div>

      {tab === 'out' && !loading && !error && (
        <div className="card p-4 mb-3 flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-sm text-fg-muted">Out for delivery</p><p className="text-2xl font-extrabold text-fg">{outRows.length} bill{outRows.length === 1 ? '' : 's'}</p></div>
          <div className="text-right"><p className="text-sm text-fg-muted">Still to collect</p><p className="text-2xl font-extrabold text-danger-fg">Rs. {fmtRs(toCollect)}</p></div>
        </div>
      )}

      {error && <p role="alert" className="rounded-xl border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning-strong">{error}</p>}
      {loading && <p className="py-12 text-center text-sm text-fg-muted" role="status">Loading…</p>}
      {!loading && !error && shown.length === 0 && (
        <div className="card py-12 text-center">
          <p className="text-fg-muted">{tab === 'out' ? 'Nothing is out for delivery.' : 'No delivery bills in the last 30 days.'}</p>
          <p className="text-xs text-fg-subtle mt-1">In POS, switch to 🚚 Delivery (F7) to make a delivery bill.</p>
        </div>
      )}

      {!loading && !error && shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((r) => {
            const out = r.delivery_status === 'out'
            return (
              <li key={r.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-fg">
                      {r.customers?.name || 'Customer'}
                      <span className="ml-2 font-mono text-xs font-semibold text-fg-muted">#{saleBillNo(r)}</span>
                    </p>
                    <p className="text-xs text-fg-muted">
                      {r.customers?.phone ? `${r.customers.phone} · ` : ''}{when(r.dispatched_at || r.created_at)}
                      {r.loader_name ? <> · <span className="font-semibold text-fg-2">🚚 {r.loader_name}</span></> : null}
                    </p>
                    {r.delivery_address && <p className="mt-1 text-sm text-fg-2 flex items-start gap-1"><MapPin size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{r.delivery_address}</p>}
                    {r.delivery_note && <p className="mt-0.5 text-xs text-fg-muted flex items-start gap-1"><StickyNote size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{r.delivery_note}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-fg-muted">Bill Rs. {fmtRs(r.net)}</p>
                    {r.due > 0
                      ? <p className="font-extrabold text-danger-fg">Collect Rs. {fmtRs(r.due)}</p>
                      : <p className="font-extrabold text-success-fg">Paid</p>}
                    <span className={`badge mt-1 ${out ? 'badge-warning' : r.delivery_status === 'delivered' ? 'badge-success' : 'badge-neutral'}`}>
                      {out ? 'Out for delivery' : r.delivery_status === 'delivered' ? `Delivered ${when(r.delivered_at)}` : r.delivery_status}
                    </span>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.due > 0 && r.customers && (
                    <button type="button" onClick={() => setReceiveFor(r.customers)} className="btn btn-primary btn-sm">
                      <Wallet size={16} aria-hidden="true" /> Receive payment
                    </button>
                  )}
                  {out && (
                    <button type="button" onClick={() => markDelivered(r)} disabled={busy === r.id} className="btn btn-success btn-sm">
                      <CircleCheck size={16} aria-hidden="true" /> Mark delivered
                    </button>
                  )}
                  <button type="button" onClick={() => printSlip(r)} disabled={busy === r.id} className="btn btn-secondary btn-sm">
                    <Printer size={16} aria-hidden="true" /> Slip
                  </button>
                  {r.customer_id && (
                    <Link to={`/customers/${r.customer_id}`} className="btn btn-ghost btn-sm">Ledger</Link>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {receiveFor && (
        <ReceivePaymentModal
          customer={receiveFor}
          onClose={() => { setReceiveFor(null); load() }}
          onSaved={() => { /* list refreshes on close */ }}
        />
      )}
    </div>
  )
}
