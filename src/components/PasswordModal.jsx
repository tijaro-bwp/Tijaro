import { useState } from 'react'
import { supabase } from '../services/supabase'
import { db } from '../services/db'
import { useAuth } from '../context/AuthContext'
import { hashPassword } from '../utils/authUtils'

function PasswordModal({ title, message, onConfirm, onCancel, checkboxLabel, checkboxChecked, onCheckboxChange }) {
    const { user } = useAuth()
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [verifying, setVerifying] = useState(false)

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (!password.trim()) { setError('Password is required'); return }
        setVerifying(true)
        setError('')

        try {
            const hashed = await hashPassword(password)

            // ── Check 1: localStorage cached hash (fastest, set at login) ──
            const cachedHash = localStorage.getItem('user_pw_hash')
            if (cachedHash && cachedHash === hashed) {
                onConfirm()
                return
            }

            // ── Check 2: Dexie IndexedDB (offline cache from last login) ──
            try {
                const localUser = await db.users.get(user?.id)
                if (localUser?.password === hashed) {
                    localStorage.setItem('user_pw_hash', hashed) // re-cache
                    onConfirm()
                    return
                }
            } catch (_) { /* ignore */ }

            // ── Check 3: secure_login RPC — same function used by Login page ──
            // This bypasses RLS entirely and works for any existing session
            if (navigator.onLine && user?.username) {
                try {
                    const { data: result } = await supabase.rpc('secure_login', {
                        p_username: user.username,
                        p_password_hash: hashed
                    })
                    if (result && result.success && result.user?.id) {
                        // Cache for next time so future checks are instant
                        localStorage.setItem('user_pw_hash', hashed)
                        try { await db.users.put({ id: result.user.id, username: result.user.username, password: hashed, shop_id: result.user.shop_id, role: result.user.role, is_active: true }) } catch (_) {}
                        onConfirm()
                        return
                    }
                } catch (_) { /* RPC failed — treat as wrong password */ }
            }

            // All checks failed
            setError('Incorrect password! ❌')
        } catch (err) {
            setError('Verification failed: ' + (err.message || String(err)))
        } finally {
            setVerifying(false)
        }
    }

    return (
        <div className="fixed inset-0 bg-black/50 flex items-start sm:items-center justify-center z-[100] overflow-y-auto py-4 px-2 sm:px-4">
            <div className="bg-surface rounded-2xl shadow-2xl p-6 w-full max-w-sm animate-[fadeIn_0.2s_ease-out]">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 bg-danger-muted rounded-full flex items-center justify-center flex-shrink-0">
                        <span className="text-lg">🔒</span>
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-fg">{title || 'Password Required'}</h2>
                        <p className="text-xs text-fg-muted">{message || 'Enter your password to proceed'}</p>
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <input
                            type="password"
                            autoFocus
                            required
                            value={password}
                            onChange={e => { setPassword(e.target.value); setError('') }}
                            className="w-full px-4 py-3 border border-line-strong rounded-xl focus:ring-2 focus:ring-danger outline-none text-lg"
                            placeholder="Enter your password..."
                        />
                        {error && (
                            <p className="text-danger-fg text-sm mt-2 font-medium">{error}</p>
                        )}
                    </div>
                    <div className="flex gap-3">
                        <button
                            type="submit"
                            disabled={verifying}
                            className="flex-1 py-3 bg-danger hover:bg-danger-hover text-white font-bold rounded-xl transition disabled:opacity-50"
                        >
                            {verifying ? 'Verifying...' : 'Confirm'}
                        </button>
                        <button
                            type="button"
                            onClick={onCancel}
                            className="flex-1 py-3 bg-surface-3 hover:bg-surface-4 text-fg-2 font-bold rounded-xl transition"
                        >
                            Cancel
                        </button>
                    </div>
                    {checkboxLabel && (
                        <div className="pt-2 border-t mt-4">
                            <label className="flex items-center gap-3 cursor-pointer group">
                                <input
                                    type="checkbox"
                                    checked={checkboxChecked}
                                    onChange={(e) => onCheckboxChange && onCheckboxChange(e.target.checked)}
                                    className="w-5 h-5 rounded border-line-strong text-danger-fg focus:ring-danger accent-danger"
                                />
                                <span className="text-sm font-bold text-danger-fg select-none group-hover:text-danger-strong transition">
                                    {checkboxLabel}
                                </span>
                            </label>
                        </div>
                    )}
                </form>
            </div>
        </div>
    )
}

export default PasswordModal
