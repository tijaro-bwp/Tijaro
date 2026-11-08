// No-login bill page (/b/:token): the link a customer gets on WhatsApp.
// Read-only: one bill, payments against it and the account balance.
// Talks only to portal-api `public_bill`. See docs/BILL_PAYMENTS.md.
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Printer, Phone, LogIn } from 'lucide-react'
import { publicBillCall, portalUrl } from '../../services/portalApi'
import { BRAND } from '../../config/brand.js'
import { money, fmtDate, balanceTone, Spinner, ErrorBox } from './portalUi'
import BillView from './BillView'

function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
}

export default function PublicBill() {
  const { token } = useParams()
  useNoIndex()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const { data: d, error: err } = await publicBillCall(token)
    if (err) setError(err)
    else setData(d)
  }, [token])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    document.title = data ? `Bill #${data.bill.bill_no} · ${data.shop.name}` : 'Bill'
  }, [data])

  if (error) {
    const invalid = error.code === 'link_invalid' || error.status === 404
    return (
      <div className="min-h-dvh bg-app flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          {invalid ? (
            <>
              <h1 className="text-xl font-extrabold text-fg">Link not valid</h1>
              <p className="mt-2 text-fg-muted">This bill link has expired or is not valid. Please ask the shop to send it again.</p>
            </>
          ) : (
            <ErrorBox onRetry={load}>{error.message}</ErrorBox>
          )}
        </div>
      </div>
    )
  }
  if (!data) return <div className="min-h-dvh bg-app"><Spinner /></div>

  const { shop, customer, balance, balance_as_of: asOf, bill } = data
  const tone = balanceTone(balance)
  const tel = shop.phone ? `tel:${String(shop.phone).replace(/[^\d+]/g, '')}` : null

  return (
    <div className="min-h-dvh bg-app text-fg">
      <header className="bg-surface border-b border-line print:border-0">
        <div className="mx-auto max-w-2xl px-4 h-16 flex items-center gap-3">
          {shop.logo_url
            ? <img src={shop.logo_url} alt="" className="w-10 h-10 rounded-xl border border-line object-contain bg-surface p-0.5" />
            : <span className="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center font-black" aria-hidden="true">{shop.name.charAt(0).toUpperCase()}</span>}
          <div className="min-w-0 flex-1">
            <p className="font-extrabold leading-tight truncate">{shop.name}</p>
            {shop.address && <p className="text-xs text-fg-muted truncate">{shop.address}</p>}
          </div>
          {tel && (
            <a href={tel} className="btn btn-ghost btn-sm print:hidden" aria-label={`Call ${shop.name}`}>
              <Phone size={16} aria-hidden="true" /> <span className="hidden sm:inline">Call</span>
            </a>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-5 space-y-4">
        <p className="text-fg-2">Assalam o Alaikum <span className="font-semibold">{customer.first_name}</span>, here is your bill.</p>

        <section aria-label="Account balance" className="card p-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-fg-muted">{tone.label}</p>
            <p className={`text-2xl font-extrabold ${tone.cls}`}>{money(Math.abs(balance))}</p>
          </div>
          <p className="text-xs text-fg-subtle text-right">Account balance<br />as of {fmtDate(asOf, true)}</p>
        </section>

        <BillView bill={bill} shopName={null} />

        <div className="flex flex-col sm:flex-row gap-2 print:hidden">
          <button type="button" onClick={() => window.print()} className="btn btn-secondary flex-1">
            <Printer size={16} aria-hidden="true" /> Print or save as PDF
          </button>
          {shop.portal_enabled && shop.slug && (
            <a href={portalUrl(shop.slug)} className="btn btn-primary flex-1">
              <LogIn size={16} aria-hidden="true" /> All bills &amp; statement
            </a>
          )}
        </div>
        {shop.portal_enabled && shop.slug && (
          <p className="text-xs text-fg-subtle text-center print:hidden">Sign in with your mobile number and PIN to see all your bills.</p>
        )}
      </main>

      <footer className="pb-8 text-center text-xs text-fg-subtle print:hidden">Powered by {BRAND.appName}</footer>
    </div>
  )
}
