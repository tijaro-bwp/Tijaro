import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { Navigate } from 'react-router-dom'
import { KeyRound, Mail, AlertCircle, Eye, EyeOff, ShieldAlert, CheckCircle } from 'lucide-react'
import { supabase } from '../services/supabase'

const SUPERADMIN_EMAIL = 'babarjoya@gmail.com'
const SUPERADMIN_URL = import.meta.env.VITE_SUPERADMIN_URL || window.location.origin

export default function Login() {
  const { user, login } = useAuth()

  // Login form state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Forgot password state
  const [showForgot, setShowForgot] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const [resetError, setResetError] = useState('')

  if (user) return <Navigate to="/" replace />

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleForgotPassword = async (e) => {
    e.preventDefault()
    setResetError('')
    setResetLoading(true)
    try {
      const resetEmail = email.trim() || SUPERADMIN_EMAIL
      const redirectTo = `${SUPERADMIN_URL}/reset-password`
      const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, { redirectTo })
      if (error) throw new Error(error.message)
      setResetSent(true)
    } catch (err) {
      setResetError(err.message)
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">

        {/* Header */}
        <div className="bg-slate-900 p-6 text-center">
          <div className="w-12 h-12 bg-blue-500 rounded-xl flex items-center justify-center mx-auto mb-3 shadow-lg shadow-blue-500/30">
            <ShieldAlert className="text-white" size={24} />
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">Superadmin Portal</h1>
          <p className="text-slate-400 text-xs mt-1">EdgeX SaaS Management Dashboard</p>
        </div>

        {/* ── Login form ── */}
        {!showForgot && (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm flex gap-2 items-start border border-red-100">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <p>{error}</p>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 text-slate-400" size={16} />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  placeholder="admin@example.com"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase">Password</label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-2.5 text-slate-400" size={16} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full pl-10 pr-10 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition disabled:opacity-50 mt-2"
            >
              {loading ? 'Authenticating…' : 'Secure Login'}
            </button>

            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => { setShowForgot(true); setError('') }}
                className="text-xs text-slate-400 hover:text-blue-600 font-semibold transition-colors"
              >
                Forgot password?
              </button>
            </div>
          </form>
        )}

        {/* ── Forgot password panel ── */}
        {showForgot && (
          <div className="p-6 space-y-4">
            {!resetSent ? (
              <>
                <div className="text-center space-y-1">
                  <p className="text-slate-700 font-bold text-sm">Reset Superadmin Password</p>
                  <p className="text-slate-400 text-xs">
                    A reset link will be sent to<br />
                    <span className="font-bold text-slate-600">{SUPERADMIN_EMAIL}</span>
                  </p>
                </div>

                {resetError && (
                  <div className="bg-red-50 text-red-600 p-3 rounded-lg text-xs flex gap-2 items-start border border-red-100">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    {resetError}
                  </div>
                )}

                <form onSubmit={handleForgotPassword} className="space-y-3">
                  <button
                    type="submit"
                    disabled={resetLoading}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition disabled:opacity-50"
                  >
                    {resetLoading ? 'Sending…' : 'Send Reset Email'}
                  </button>
                </form>

                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => { setShowForgot(false); setResetError('') }}
                    className="text-xs text-slate-400 hover:text-slate-600 font-semibold transition-colors"
                  >
                    ← Back to Login
                  </button>
                </div>
              </>
            ) : (
              <div className="text-center space-y-3 py-2">
                <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
                  <CheckCircle size={24} className="text-emerald-500" />
                </div>
                <p className="text-slate-800 font-black">Check Your Email</p>
                <p className="text-slate-500 text-xs">
                  A password reset link was sent to<br />
                  <span className="font-bold text-slate-600">{SUPERADMIN_EMAIL}</span>.<br />
                  Click the link in the email to set a new password.
                </p>
                <p className="text-[10px] text-slate-400">Link expires in 1 hour.</p>
                <button
                  type="button"
                  onClick={() => { setShowForgot(false); setResetSent(false) }}
                  className="text-xs text-blue-600 hover:underline font-bold"
                >
                  ← Back to Login
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
