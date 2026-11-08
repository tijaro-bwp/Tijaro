// Staff controls for one customer's portal login (mobile number + 6-digit PIN).
// Lives on the customer ledger page. All work happens in the `portal-api` Edge
// Function: the PIN is generated and hashed there and shown here exactly once.
// See docs/CUSTOMER_PORTAL.md.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { KeyRound, Copy, Check, Send, RefreshCw, Power, ShieldAlert, ExternalLink } from 'lucide-react'
import { Modal, Badge } from './ui'
import { portalStaffCall, portalUrl, formatLocalPhone, portalLoginMessage } from '../services/portalApi'

const fmtDate = (v) => (v ? new Date(v).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' }) : '—')

function serviceError(error) {
  if (!error) return ''
  if (error.code === 'network') return 'No internet connection. Portal logins can only be managed online.'
  if (error.code === 'service_unavailable') {
    return 'The customer portal service is not set up yet. Ask your administrator to deploy it (docs/CUSTOMER_PORTAL.md).'
  }
  return error.message || 'Something went wrong.'
}

export default function CustomerPortalAccess({ customer, shopName, className = '' }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [duplicates, setDuplicates] = useState([])
  const [issued, setIssued] = useState(null) // { pin, login_phone, shop_slug }
  const [copied, setCopied] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    setError('')
    const { data, error: err } = await portalStaffCall('staff_status', { customer_id: customer.id })
    setLoading(false)
    if (err) { setError(serviceError(err)); return }
    setStatus(data)
  }, [customer.id])

  useEffect(() => {
    if (open) {
      setIssued(null)
      setDuplicates([])
      setCopied(false)
      setConfirmOff(false)
      loadStatus()
    }
  }, [open, loadStatus])

  const issuePin = async () => {
    setBusy('issue')
    setError('')
    setDuplicates([])
    const { data, error: err } = await portalStaffCall('staff_issue_pin', { customer_id: customer.id })
    setBusy('')
    if (err) {
      setError(serviceError(err))
      if (err.code === 'duplicate_phone') setDuplicates(err.duplicates || [])
      return
    }
    setIssued(data)
    setCopied(false)
    loadStatus()
  }

  const turnOff = async () => {
    setBusy('off')
    setError('')
    const { error: err } = await portalStaffCall('staff_disable', { customer_id: customer.id })
    setBusy('')
    setConfirmOff(false)
    if (err) { setError(serviceError(err)); return }
    setIssued(null)
    loadStatus()
  }

  const message = issued
    ? portalLoginMessage({ customerName: customer.name, shopName, slug: issued.shop_slug, phone: issued.login_phone, pin: issued.pin })
    : ''

  const sendWhatsApp = () => {
    window.open(`https://wa.me/${issued.login_phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener')
  }

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy. Select the message and copy it manually.')
    }
  }

  const locked = status?.locked_until && new Date(status.locked_until) > new Date()
  const shopOff = status && !status.shop_portal_enabled
  const hasPhone = !!status?.customer_phone

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`btn btn-secondary ${className}`}>
        <KeyRound size={16} aria-hidden="true" /> Portal Login
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Customer portal — ${customer.name}`}
        footer={<button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Close</button>}
      >
        {/* The modal can be rendered inside right-aligned headers; reset alignment. */}
        <div className="text-left">
        {loading && !status && <p className="text-sm text-fg-muted">Loading…</p>}

        {error && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-danger-line bg-danger-soft px-3 py-2.5 text-sm text-danger-strong">
            <ShieldAlert size={18} className="shrink-0 mt-px" aria-hidden="true" />
            <div>
              <p>{error}</p>
              {duplicates.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      <Link to={`/customers/${d.id}`} onClick={() => setOpen(false)} className="font-semibold underline">
                        {d.name || `Customer #${d.id}`}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {issued && (
          <div className="mb-5 rounded-2xl border border-success-line bg-success-soft p-4">
            <p className="text-sm font-semibold text-success-strong">Login ready. Send it to the customer now.</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <p className="label !mb-0.5">Mobile</p>
                <p className="font-mono font-bold text-fg">{formatLocalPhone(issued.login_phone)}</p>
              </div>
              <div>
                <p className="label !mb-0.5">PIN</p>
                <p className="font-mono text-2xl font-black tracking-[0.25em] text-fg">{issued.pin}</p>
              </div>
            </div>
            <p className="mt-2 text-xs text-fg-muted">
              This PIN is shown only once. If it's lost, use Reset PIN to make a new one.
            </p>
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface p-3 text-xs text-fg-2">{message}</pre>
            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              <button type="button" onClick={sendWhatsApp} className="btn btn-success flex-1">
                <Send size={16} aria-hidden="true" /> Send on WhatsApp
              </button>
              <button type="button" onClick={copyMessage} className="btn btn-secondary flex-1">
                {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy message'}
              </button>
            </div>
          </div>
        )}

        {status && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-fg-2">Status:</span>
              {status.enabled
                ? (locked ? <Badge tone="warning">Locked (wrong PINs)</Badge> : <Badge tone="success">Active</Badge>)
                : <Badge tone="neutral">No login</Badge>}
              {shopOff && <Badge tone="danger">Portal switched off for shop</Badge>}
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-fg-muted">Login mobile</dt>
                <dd className="font-mono text-fg">{formatLocalPhone(status.login_phone || status.customer_phone) || '—'}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Last login</dt>
                <dd className="text-fg">{fmtDate(status.last_login_at)}</dd>
              </div>
              {status.enabled && (
                <div>
                  <dt className="text-fg-muted">PIN set</dt>
                  <dd className="text-fg">{fmtDate(status.pin_set_at)}</dd>
                </div>
              )}
              {locked && (
                <div>
                  <dt className="text-fg-muted">Locked until</dt>
                  <dd className="text-fg">{fmtDate(status.locked_until)}</dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className="text-fg-muted">Portal address</dt>
                <dd className="flex items-center gap-1.5 break-all text-fg">
                  {portalUrl(status.shop_slug)}
                  <a href={portalUrl(status.shop_slug)} target="_blank" rel="noopener noreferrer" className="text-primary-fg" aria-label="Open portal">
                    <ExternalLink size={14} />
                  </a>
                </dd>
              </div>
            </dl>

            {status.enabled && status.login_phone && status.customer_phone && status.login_phone !== status.customer_phone && (
              <p className="rounded-xl border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning-strong">
                The customer's mobile number changed. Reset the PIN to move the login to the new number.
              </p>
            )}

            {!hasPhone && (
              <p className="rounded-xl border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning-strong">
                Add a mobile number to this customer before giving a portal login.
              </p>
            )}

            {shopOff ? (
              <p className="text-sm text-fg-muted">
                Turn the portal on in <Link to="/settings#portal" onClick={() => setOpen(false)} className="font-semibold text-primary-fg underline">Settings → Customer Portal</Link> first.
              </p>
            ) : (
              <div className="flex flex-col sm:flex-row gap-2 pt-1">
                <button type="button" onClick={issuePin} disabled={!!busy || !hasPhone} className="btn btn-primary flex-1">
                  {status.enabled ? <RefreshCw size={16} aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
                  {busy === 'issue' ? 'Working…' : status.enabled ? 'Reset PIN' : 'Give portal login'}
                </button>
                {status.enabled && !confirmOff && (
                  <button type="button" onClick={() => setConfirmOff(true)} disabled={!!busy} className="btn btn-secondary flex-1">
                    <Power size={16} aria-hidden="true" /> Turn off login
                  </button>
                )}
              </div>
            )}

            {status.enabled && !issued && !shopOff && (
              <p className="text-xs text-fg-subtle">Reset PIN makes a new PIN and signs the customer out on all devices.</p>
            )}

            {confirmOff && (
              <div className="rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-strong">
                <p>Turn off {customer.name}'s portal login? They will be signed out and can't log in until you give a new PIN.</p>
                <div className="mt-2 flex flex-col sm:flex-row gap-2">
                  <button type="button" onClick={turnOff} disabled={!!busy} className="btn btn-danger flex-1">
                    {busy === 'off' ? 'Turning off…' : 'Yes, turn off'}
                  </button>
                  <button type="button" onClick={() => setConfirmOff(false)} className="btn btn-secondary flex-1">Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      </Modal>
    </>
  )
}
