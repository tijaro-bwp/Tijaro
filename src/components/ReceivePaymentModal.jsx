// Receive a payment from a customer against specific bills (oldest first by
// default), then send the customer a WhatsApp message with the receipt:
// what each bill still owes and previous -> new balance.
// Online only: the database function record_bill_payment does the whole
// update atomically (sql/bill_payments_migration.sql).
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, CircleCheck, Printer, MessageCircle, Wand2 } from 'lucide-react'
import { supabase } from '../services/supabase'
import { printHTML } from '../utils/printUtils'
import { generateBillPDF, shareOrDownloadPDF } from '../utils/pdfShare'
import { createBillLink, fillPortalLink } from '../services/portalApi'
import { resolvePaymentTemplate, fillTemplate, billLines, billNo, fmtRs, waPhone, openWhatsApp } from '../utils/billMessages'
import { buildPaymentReceiptHTML } from '../utils/paymentReceipt'

const MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'online', label: 'Online / JazzCash / Easypaisa' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
]

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
// Local calendar day (toISOString would give the UTC day: wrong after midnight in Pakistan).
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Spread `amount` over bills oldest first. */
function autoAllocate(bills, amount) {
  let left = r2(amount)
  const out = {}
  for (const b of bills) {
    const take = Math.min(left, Number(b.due))
    out[b.sale_id] = take > 0 ? String(r2(take)) : ''
    left = r2(left - take)
  }
  return out
}

export default function ReceivePaymentModal({ customer, onClose, onSaved }) {
  const [bills, setBills] = useState([])
  const [shop, setShop] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [amount, setAmount] = useState('')
  const [alloc, setAlloc] = useState({})
  const [manual, setManual] = useState(false)
  const [mode, setMode] = useState('cash')
  const [ref, setRef] = useState('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(today())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [sending, setSending] = useState(false)
  // One key per opened form: a retry after a lost response can't pay twice.
  const clientRef = useRef(crypto.randomUUID())
  const amountRef = useRef(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!navigator.onLine) { setLoadError('You are offline. Receiving payments against bills needs internet. Use "Add Transaction" to record it offline.'); setLoading(false); return }
      const [billsRes, shopRes] = await Promise.all([
        supabase.rpc('customer_bills_due', { p_customer_id: Number(customer.id), p_only_open: true }),
        supabase.from('shops').select('*').eq('id', customer.shop_id).maybeSingle(),
      ])
      if (!alive) return
      if (billsRes.error) {
        setLoadError(billsRes.error.code === 'PGRST202'
          ? 'This feature needs a database update (sql/bill_payments_migration.sql). Ask your administrator.'
          : `Could not load bills: ${billsRes.error.message}`)
      } else {
        setBills((billsRes.data || []).map((b) => ({ ...b, due: Number(b.due), net_total: Number(b.net_total) })))
      }
      setShop(shopRes.data || null)
      setLoading(false)
      setTimeout(() => amountRef.current?.focus(), 50)
    })()
    return () => { alive = false }
  }, [customer.id, customer.shop_id])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const totalDue = useMemo(() => r2(bills.reduce((a, b) => a + b.due, 0)), [bills])
  const allocated = useMemo(() => r2(Object.values(alloc).reduce((a, v) => a + (Number(v) || 0), 0)), [alloc])
  const amt = r2(amount)
  const extra = r2(amt - allocated)
  const newBalance = r2((Number(customer.outstanding_balance) || 0) - amt)
  const overBill = bills.find((b) => (Number(alloc[b.sale_id]) || 0) > b.due + 0.009)

  const onAmount = (v) => {
    setAmount(v)
    if (!manual) setAlloc(autoAllocate(bills, v))
  }
  const onBillAmount = (saleId, v) => {
    setManual(true)
    setAlloc((a) => ({ ...a, [saleId]: v }))
  }
  const resetAuto = () => { setManual(false); setAlloc(autoAllocate(bills, amount)) }
  // Tapping a bill's "due" pays it in full and raises the amount if needed.
  const payFull = (b) => {
    const next = { ...alloc, [b.sale_id]: String(b.due) }
    const sum = r2(Object.values(next).reduce((a, v) => a + (Number(v) || 0), 0))
    setManual(true)
    setAlloc(next)
    if (amt < sum) setAmount(String(sum))
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!(amt > 0)) { setError('Enter the amount received.'); return }
    if (overBill) { setError(`Bill #${billNo(overBill.sale_id)} only has Rs. ${fmtRs(overBill.due)} left to pay.`); return }
    if (extra < -0.009) { setError(`The bills add up to Rs. ${fmtRs(allocated)}, more than the Rs. ${fmtRs(amt)} received.`); return }
    setSaving(true)
    const allocations = bills
      .map((b) => ({ sale_id: b.sale_id, amount: r2(alloc[b.sale_id]) }))
      .filter((a) => a.amount > 0)
    const paidAt = date === today() ? new Date().toISOString() : new Date(`${date}T12:00:00`).toISOString()
    const { data, error: err } = await supabase.rpc('record_bill_payment', {
      p_customer_id: Number(customer.id),
      p_allocations: allocations,
      p_extra_amount: Math.max(0, extra),
      p_payment_mode: mode,
      p_transaction_ref: ref.trim() || null,
      p_note: note.trim() || null,
      p_paid_at: paidAt,
      p_client_ref: clientRef.current,
    })
    setSaving(false)
    if (err) {
      setError(/fetch|network/i.test(err.message || '') ? 'No connection. Nothing was saved — try again.' : err.message)
      return
    }
    setResult({ ...data, date: paidAt })
    onSaved?.(data)
  }

  // ── After saving: receipt + WhatsApp ─────────────────────────────────────
  const receiptHTML = () => buildPaymentReceiptHTML({
    shop: { name: shop?.name, phone: shop?.phone, address: shop?.address },
    customer, result, mode: MODES.find((m) => m.value === mode)?.label || mode, ref: ref.trim(), date: result.date,
  })

  const buildMessage = async () => {
    const template = resolvePaymentTemplate(shop?.wa_payment_template)
    // Link to the most recent bill paid (it also shows the account balance).
    const linkBill = (result.bills || [])[result.bills.length - 1]
    const billLink = template.includes('[Bill Link]') && linkBill ? await createBillLink(linkBill.sale_id) : ''
    const one = result.bills?.length === 1 ? result.bills[0] : null
    return fillTemplate(fillPortalLink(template, shop), {
      name: customer.name || 'Customer',
      shopName: shop?.name || '',
      id: one ? billNo(one.sale_id) : '',
      amount: result.total_paid,
      paidNow: result.total_paid,
      billTotal: one?.net_total,
      billBalance: one?.due,
      previousBalance: result.prev_balance,
      newBalance: result.new_balance,
      bills: billLines(result.bills),
      billLink,
    })
  }

  const sendWhatsApp = async (withPdf) => {
    setSending(true)
    try {
      const msg = await buildMessage()
      if (withPdf) {
        const blob = await generateBillPDF(receiptHTML())
        await shareOrDownloadPDF(blob, `payment-${String(customer.name || 'customer').replace(/\s+/g, '-')}.pdf`, waPhone(customer.phone), msg)
      } else {
        openWhatsApp(customer.phone, msg)
      }
    } catch (err) {
      console.error('WhatsApp send failed:', err)
      openWhatsApp(customer.phone, await buildMessage().catch(() => ''))
    } finally {
      setSending(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <div className="modal-panel max-w-lg text-left" role="dialog" aria-modal="true" aria-labelledby="rp-title">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-line">
          <div className="min-w-0">
            <h2 id="rp-title" className="text-lg font-extrabold text-fg">{result ? 'Payment recorded' : 'Receive payment'}</h2>
            <p className="text-xs text-fg-muted truncate">{customer.name} · Balance Rs. {fmtRs(customer.outstanding_balance)}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="btn btn-ghost !min-h-10 !w-10 !p-0" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {result ? (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-success-line bg-success-soft p-4">
              <CircleCheck size={22} className="text-success-fg shrink-0 mt-0.5" aria-hidden="true" />
              <div className="text-sm text-success-strong">
                <p className="font-bold">Rs. {fmtRs(result.total_paid)} received{result.already_recorded ? ' (already saved earlier)' : ''}.</p>
                <p>Previous balance Rs. {fmtRs(result.prev_balance)} → new balance <b>Rs. {fmtRs(result.new_balance)}</b></p>
              </div>
            </div>
            {result.bills?.length > 0 && (
              <ul className="divide-y divide-line-subtle rounded-xl border border-line">
                {result.bills.map((b) => (
                  <li key={b.sale_id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="font-semibold text-fg">Bill #{billNo(b.sale_id)}</span>
                    <span className="text-fg-muted">paid Rs. {fmtRs(b.paid_now)}</span>
                    {Number(b.due) > 0
                      ? <span className="badge badge-danger">Left Rs. {fmtRs(b.due)}</span>
                      : <span className="badge badge-success">Paid</span>}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col sm:flex-row gap-2">
              {customer.phone && (
                <button type="button" onClick={() => sendWhatsApp(true)} disabled={sending} className="btn btn-success flex-1">
                  <MessageCircle size={18} aria-hidden="true" /> {sending ? 'Preparing…' : 'WhatsApp + receipt'}
                </button>
              )}
              <button type="button" onClick={() => printHTML(receiptHTML())} className="btn btn-secondary flex-1">
                <Printer size={18} aria-hidden="true" /> Print receipt
              </button>
            </div>
            {customer.phone && (
              <button type="button" onClick={() => sendWhatsApp(false)} disabled={sending} className="btn btn-ghost btn-sm w-full">
                Send text message only
              </button>
            )}
            {!customer.phone && <p className="text-xs text-fg-muted">Add a mobile number to this customer to send WhatsApp messages.</p>}
            <button type="button" onClick={onClose} className="btn btn-primary w-full">Done</button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col min-h-0 flex-1">
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {loading && <p className="py-8 text-center text-sm text-fg-muted" role="status">Loading bills…</p>}
              {loadError && <p className="rounded-xl border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning-strong">{loadError}</p>}

              {!loading && !loadError && (
                <>
                  <div>
                    <label htmlFor="rp-amount" className="label">Amount received (Rs.)</label>
                    <input
                      id="rp-amount" ref={amountRef} type="number" inputMode="decimal" min="0" step="any"
                      value={amount} onChange={(e) => onAmount(e.target.value)}
                      className="input min-h-12 text-lg font-bold" placeholder="0" required
                    />
                    {totalDue > 0 && (
                      <button type="button" onClick={() => onAmount(String(totalDue))} className="mt-1.5 text-xs font-semibold text-primary-fg hover:underline">
                        Pay all open bills: Rs. {fmtRs(totalDue)}
                      </button>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="label !mb-0">Against bills</span>
                      {manual && bills.length > 0 && (
                        <button type="button" onClick={resetAuto} className="btn btn-ghost btn-sm !min-h-8">
                          <Wand2 size={14} aria-hidden="true" /> Oldest first
                        </button>
                      )}
                    </div>
                    {bills.length === 0 ? (
                      <p className="rounded-xl border border-line px-4 py-3 text-sm text-fg-muted">No unpaid bills. The amount will go towards the account balance.</p>
                    ) : (
                      <ul className="divide-y divide-line-subtle rounded-xl border border-line max-h-64 overflow-y-auto">
                        {bills.map((b) => {
                          const v = alloc[b.sale_id] ?? ''
                          const over = (Number(v) || 0) > b.due + 0.009
                          return (
                            <li key={b.sale_id} className="flex items-center gap-3 px-3 py-2.5">
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-fg">Bill #{billNo(b.sale_id)}</p>
                                <p className="text-xs text-fg-muted">
                                  {new Date(b.created_at).toLocaleDateString('en-PK')} · total Rs. {fmtRs(b.net_total)} ·{' '}
                                  <button type="button" onClick={() => payFull(b)} className="font-semibold text-danger-fg hover:underline">
                                    due Rs. {fmtRs(b.due)}
                                  </button>
                                </p>
                              </div>
                              <label className="sr-only" htmlFor={`rp-b-${b.sale_id}`}>Amount for bill {billNo(b.sale_id)}</label>
                              <input
                                id={`rp-b-${b.sale_id}`} type="number" inputMode="decimal" min="0" step="any"
                                value={v} onChange={(e) => onBillAmount(b.sale_id, e.target.value)}
                                className={`input !w-28 text-right ${over ? '!border-danger' : ''}`} placeholder="0"
                                aria-invalid={over}
                              />
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>

                  {amt > 0 && (
                    <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm space-y-1">
                      <div className="flex justify-between"><span className="text-fg-muted">Against bills</span><span className="font-semibold">Rs. {fmtRs(allocated)}</span></div>
                      {extra > 0.009 && <div className="flex justify-between"><span className="text-fg-muted">Towards old balance / advance</span><span className="font-semibold">Rs. {fmtRs(extra)}</span></div>}
                      <div className="flex justify-between border-t border-line pt-1"><span className="text-fg-muted">New balance</span><span className="font-bold text-fg">Rs. {fmtRs(newBalance)}</span></div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="rp-mode" className="label">Paid by</label>
                      <select id="rp-mode" value={mode} onChange={(e) => setMode(e.target.value)} className="input">
                        {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="rp-date" className="label">Date</label>
                      <input id="rp-date" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} className="input" />
                    </div>
                  </div>
                  {mode !== 'cash' && (
                    <div>
                      <label htmlFor="rp-ref" className="label">Transaction ref (optional)</label>
                      <input id="rp-ref" value={ref} onChange={(e) => setRef(e.target.value)} className="input" maxLength={100} />
                    </div>
                  )}
                  <div>
                    <label htmlFor="rp-note" className="label">Note (optional)</label>
                    <input id="rp-note" value={note} onChange={(e) => setNote(e.target.value)} className="input" maxLength={200} placeholder="e.g. collected by loader Ali" />
                  </div>
                </>
              )}
              {error && <p role="alert" className="rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger-strong">{error}</p>}
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-2 px-5 py-4 border-t border-line">
              <button type="button" onClick={onClose} disabled={saving} className="btn btn-secondary flex-1">Cancel</button>
              <button type="submit" disabled={saving || loading || !!loadError || !(amt > 0)} className="btn btn-primary flex-1">
                {saving ? 'Saving…' : `Receive Rs. ${fmtRs(amt)}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
