import { useState } from 'react'
import { Phone, KeyRound, Eye, EyeOff, ArrowRight } from 'lucide-react'
import { portalCall } from '../../services/portalApi'
import { ErrorBox } from './portalUi'

export default function PortalLogin({ slug, shop, onLoggedIn }) {
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!/^\d{6}$/.test(pin)) { setError('PIN must be 6 digits.'); return }
    setLoading(true)
    const { data, error: err } = await portalCall(slug, 'login', { phone, pin })
    setLoading(false)
    if (err) { setError(err.message || 'Could not sign in.'); setPin(''); return }
    onLoggedIn(data)
  }

  const tel = shop?.phone ? `tel:${String(shop.phone).replace(/[^\d+]/g, '')}` : null

  return (
    <div className="min-h-dvh bg-app flex flex-col">
      <main className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center text-center mb-8">
            {shop?.logo_url ? (
              <div className="w-20 h-20 mb-4 rounded-2xl bg-surface border border-line shadow-sm p-2 flex items-center justify-center overflow-hidden">
                <img src={shop.logo_url} alt="" className="max-w-full max-h-full object-contain" />
              </div>
            ) : (
              <div className="w-20 h-20 mb-4 rounded-2xl bg-primary text-white flex items-center justify-center text-3xl font-black" aria-hidden="true">
                {(shop?.name || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <h1 className="text-2xl font-extrabold tracking-tight text-fg">{shop?.name}</h1>
            <p className="mt-1 text-fg-muted">See your bills and balance</p>
          </div>

          <form onSubmit={submit} className="card p-5 sm:p-6 space-y-5">
            <div>
              <label htmlFor="portal-phone" className="block text-sm font-semibold text-fg-2 mb-1.5">Mobile number</label>
              <div className="relative">
                <Phone size={18} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
                <input
                  id="portal-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="03xx-xxxxxxx"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  autoFocus
                  className="input min-h-12 pl-11 text-base"
                />
              </div>
            </div>

            <div>
              <label htmlFor="portal-pin" className="block text-sm font-semibold text-fg-2 mb-1.5">6-digit PIN</label>
              <div className="relative">
                <KeyRound size={18} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
                <input
                  id="portal-pin"
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  autoComplete="current-password"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="••••••"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  required
                  className="input min-h-12 pl-11 pr-12 text-base tracking-[0.3em]"
                />
                <button
                  type="button"
                  onClick={() => setShowPin((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 w-10 h-10 rounded-lg flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-surface-3"
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  aria-pressed={showPin}
                >
                  {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {error && <ErrorBox>{error}</ErrorBox>}

            <button type="submit" disabled={loading} className="btn btn-primary btn-lg w-full">
              {loading
                ? <><span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" /> Signing in…</>
                : <>Sign in <ArrowRight size={18} aria-hidden="true" /></>}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-fg-muted">
            Don't have a PIN or forgot it? Ask the shop
            {tel ? <> — <a href={tel} className="font-semibold text-primary-fg whitespace-nowrap">call {shop.phone}</a></> : '.'}
          </p>
        </div>
      </main>
    </div>
  )
}
