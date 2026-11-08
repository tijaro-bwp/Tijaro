import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CircleCheck } from 'lucide-react'
import { usePortal, ErrorBox, PageTitle } from './portalUi'

const WEAK = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123456', '654321', '012345', '543210', '123123', '112233', '121212'])

function PinInput({ id, label, value, onChange, autoComplete }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-fg-2 mb-1.5">{label}</label>
      <input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete={autoComplete}
        pattern="\d{6}"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        required
        className="input min-h-12 text-base tracking-[0.3em]"
      />
    </div>
  )
}

export default function PortalChangePin() {
  const { slug, call } = usePortal()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (![current, next, confirmPin].every((p) => /^\d{6}$/.test(p))) { setError('Each PIN must be 6 digits.'); return }
    if (next !== confirmPin) { setError("The new PINs don't match."); return }
    if (next === current) { setError('Choose a PIN different from your current one.'); return }
    if (WEAK.has(next)) { setError('That PIN is too easy to guess. Choose another.'); return }
    setSaving(true)
    const { error: err } = await call('change_pin', { current_pin: current, new_pin: next })
    setSaving(false)
    if (err) { if (err.code !== 'no_session') setError(err.message); return }
    setDone(true)
  }

  if (done) {
    return (
      <div className="card p-6 text-center max-w-md mx-auto">
        <CircleCheck size={40} className="mx-auto text-success-fg" aria-hidden="true" />
        <h1 className="mt-3 text-xl font-extrabold text-fg">PIN changed</h1>
        <p className="mt-1 text-fg-muted">Use your new PIN next time you sign in. Other devices have been signed out.</p>
        <button type="button" onClick={() => navigate(`/c/${slug}`)} className="btn btn-primary w-full mt-5">Back to home</button>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto">
      <PageTitle>Change PIN</PageTitle>
      <form onSubmit={submit} className="card p-5 space-y-4">
        <PinInput id="pin-current" label="Current PIN" value={current} onChange={setCurrent} autoComplete="current-password" />
        <PinInput id="pin-new" label="New 6-digit PIN" value={next} onChange={setNext} autoComplete="new-password" />
        <PinInput id="pin-confirm" label="Type new PIN again" value={confirmPin} onChange={setConfirmPin} autoComplete="new-password" />
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="flex flex-col-reverse sm:flex-row gap-2 pt-1">
          <button type="button" onClick={() => navigate(-1)} className="btn btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary flex-1">{saving ? 'Saving…' : 'Change PIN'}</button>
        </div>
      </form>
    </div>
  )
}
