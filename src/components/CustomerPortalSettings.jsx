// Settings → Customer Portal: shop-wide on/off switch, the shop's portal
// address and how many customers have a login. Changes go through portal-api
// (admin only). See docs/CUSTOMER_PORTAL.md.
import { useEffect, useState } from 'react'
import { Copy, Check, ExternalLink, ShieldAlert } from 'lucide-react'
import { portalStaffCall, portalUrl } from '../services/portalApi'

export default function CustomerPortalSettings() {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    portalStaffCall('staff_shop_portal').then(({ data, error: err }) => {
      if (!alive) return
      if (err) setError(err.code === 'service_unavailable'
        ? 'The customer portal service is not set up yet. Ask your administrator to run the migration and deploy portal-api (docs/CUSTOMER_PORTAL.md).'
        : err.message)
      else setInfo(data)
    })
    return () => { alive = false }
  }, [])

  const toggle = async () => {
    if (!info) return
    const next = !info.enabled
    if (!next && !confirm('Turn off the customer portal? All customers will be signed out and nobody can log in until you turn it back on.')) return
    setSaving(true)
    setError('')
    const { data, error: err } = await portalStaffCall('staff_set_shop_portal', { enabled: next })
    setSaving(false)
    if (err) { setError(err.message); return }
    setInfo(data)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(portalUrl(info.slug))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        Customers log in with their mobile number and a 6-digit PIN to see their bills, ledger and balance.
        Give each customer a login from their ledger page (<span className="font-semibold">Portal Login</span> button).
      </p>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger-line bg-danger-soft px-3 py-2.5 text-sm text-danger-strong">
          <ShieldAlert size={18} className="shrink-0 mt-px" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {!info && !error && <p className="text-sm text-fg-muted">Loading…</p>}

      {info && (
        <>
          <div className="card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="font-bold text-fg">Customer portal</p>
              <p className="text-sm text-fg-muted">
                {info.suspended
                  ? 'Unavailable while the shop account is suspended.'
                  : info.enabled ? 'On — customers with a login can sign in.' : 'Off — nobody can sign in.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={info.enabled}
              onClick={toggle}
              disabled={saving || !info.can_manage}
              className={`btn ${info.enabled ? 'btn-secondary' : 'btn-primary'} sm:w-40`}
              title={info.can_manage ? undefined : 'Only the shop admin can change this'}
            >
              {saving ? 'Saving…' : info.enabled ? 'Turn off' : 'Turn on'}
            </button>
          </div>

          <div className="card p-4 space-y-2">
            <p className="label">Portal address</p>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <code className="flex-1 break-all rounded-lg bg-surface-3 px-3 py-2 text-sm text-fg">{portalUrl(info.slug)}</code>
              <div className="flex gap-2">
                <button type="button" onClick={copy} className="btn btn-secondary flex-1 sm:flex-none">
                  {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <a href={portalUrl(info.slug)} target="_blank" rel="noopener noreferrer" className="btn btn-secondary flex-1 sm:flex-none">
                  <ExternalLink size={16} aria-hidden="true" /> Open
                </a>
              </div>
            </div>
            <p className="text-xs text-fg-subtle">
              {info.active_logins} customer{info.active_logins === 1 ? '' : 's'} with an active login.
              Add <code className="bg-surface-3 px-1 rounded">[Portal Link]</code> to your WhatsApp bill or reminder templates to include this address.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
