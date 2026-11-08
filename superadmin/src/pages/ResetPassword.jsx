import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, supabaseAdmin } from '../services/supabase'
import { hashPassword } from '../utils/authUtils'
import { KeyRound, ShieldAlert, CheckCircle, AlertCircle, Eye, EyeOff } from 'lucide-react'

export default function ResetPassword() {
  const navigate = useNavigate()

  const [stage, setStage] = useState('checking') // checking | ready | success | invalid
  const [session, setSession] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // Supabase v2 automatically parses the #access_token from URL hash
    // and fires PASSWORD_RECOVERY event in onAuthStateChange
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, sess) => {
      if (event === 'PASSWORD_RECOVERY') {
        setSession(sess)
        setStage('ready')
      } else if (event === 'SIGNED_IN' && sess) {
        // Fallback — already signed in via the link
        setSession(sess)
        setStage('ready')
      }
    })

    // Also check existing session (handles page refresh cases)
    supabase.auth.getSession().then(({ data: { session: sess } }) => {
      if (sess) {
        setSession(sess)
        setStage('ready')
      } else {
        // Give onAuthStateChange a moment to fire before declaring invalid
        setTimeout(() => {
          setStage(prev => prev === 'checking' ? 'invalid' : prev)
        }, 2500)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleReset = async (e) => {
    e.preventDefault()
    if (newPassword !== confirm) { setError('Passwords do not match.'); return }
    if (newPassword.length < 6) { setError('Password must be at least 6 characters.'); return }

    setLoading(true)
    setError('')

    try {
      // 1. Update password in Supabase Auth
      const { error: authError } = await supabase.auth.updateUser({ password: newPassword })
      if (authError) throw new Error(authError.message)

      // 2. Sync hashed password to custom users table (keeps POS-style login in sync)
      if (supabaseAdmin && session?.user?.email) {
        const hashed = await hashPassword(newPassword)
        const { error: dbError } = await supabaseAdmin
          .from('users')
          .update({ password: hashed })
          .eq('email', session.user.email)
          .eq('role', 'superadmin')
        if (dbError) console.warn('Custom users table sync warning:', dbError.message)
      }

      // Sign out from Supabase Auth (we use custom session, not Supabase session)
      await supabase.auth.signOut()

      setStage('success')
      setTimeout(() => navigate('/login'), 3000)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Stages ──────────────────────────────────────────────────────

  if (stage === 'checking') {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-600 font-semibold text-sm">Verifying reset link…</p>
        </div>
      </div>
    )
  }

  if (stage === 'invalid') {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center space-y-3">
          <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle size={24} className="text-red-500" />
          </div>
          <h2 className="text-slate-800 font-black text-lg">Link Invalid or Expired</h2>
          <p className="text-slate-500 text-sm">Password reset links expire after 1 hour. Please request a new one.</p>
          <button
            onClick={() => navigate('/login')}
            className="mt-2 text-blue-600 text-sm font-bold hover:underline"
          >
            ← Back to Login
          </button>
        </div>
      </div>
    )
  }

  if (stage === 'success') {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center space-y-3">
          <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle size={24} className="text-emerald-500" />
          </div>
          <h2 className="text-slate-800 font-black text-lg">Password Updated!</h2>
          <p className="text-slate-500 text-sm">Your new password is active. Redirecting to login…</p>
        </div>
      </div>
    )
  }

  // stage === 'ready'
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
        {/* Header */}
        <div className="bg-slate-900 p-6 text-center">
          <div className="w-12 h-12 bg-blue-500 rounded-xl flex items-center justify-center mx-auto mb-3 shadow-lg shadow-blue-500/30">
            <ShieldAlert className="text-white" size={24} />
          </div>
          <h1 className="text-xl font-bold text-white">Set New Password</h1>
          <p className="text-slate-400 text-xs mt-1">{session?.user?.email}</p>
        </div>

        {/* Form */}
        <form onSubmit={handleReset} className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm flex gap-2 items-start border border-red-100">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase">New Password</label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-2.5 text-slate-400" size={16} />
              <input
                type={showPass ? 'text' : 'password'}
                required
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Min. 6 characters"
                className="w-full pl-10 pr-10 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <button type="button" onClick={() => setShowPass(!showPass)}
                className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600">
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase">Confirm Password</label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-2.5 text-slate-400" size={16} />
              <input
                type={showPass ? 'text' : 'password'}
                required
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat new password"
                className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>
            {newPassword && confirm && newPassword !== confirm && (
              <p className="text-xs text-red-500 font-medium mt-1">Passwords do not match</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || !newPassword || newPassword !== confirm}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition disabled:opacity-50 mt-2"
          >
            {loading ? 'Updating Password…' : 'Set New Password'}
          </button>

          <button type="button" onClick={() => navigate('/login')}
            className="w-full text-slate-400 text-xs hover:text-slate-600 transition py-1">
            ← Back to Login
          </button>
        </form>
      </div>
    </div>
  )
}
