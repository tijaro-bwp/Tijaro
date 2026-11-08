import { useState, useEffect } from 'react'
import { adminDb } from '../../services/adminApi'
import { logAction } from '../../services/auditService'
import { useAuth } from '../../context/AuthContext'
import { hashPassword } from '../../utils/authUtils'
import { buildWhatsAppUrl, formatUserCredentialsMessage } from '../../utils/whatsappTemplates'
import {
  X, Users, Plus, Edit2, Trash2, Save, XCircle,
  AlertTriangle, CheckCircle2, Eye, EyeOff, KeyRound, User, Copy, Check, MessageSquare
} from 'lucide-react'

const EMPTY_FORM = { username: '', email: '', password: '', role: 'cashier', is_active: true }

export default function ManageUsersModal({ shop, onClose }) {
  const { user: adminUser } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [users, setUsers] = useState([])
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  // form state — null = closed, 'add' = new user, id = editing user
  const [formMode, setFormMode] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [showPass, setShowPass] = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  // Passwords are never stored or readable in plaintext. A password set in this
  // modal (create / edit / reset) is kept in memory only, so it can be copied or
  // sent via WhatsApp right away; it is gone once the modal closes.
  const [issuedPasswords, setIssuedPasswords] = useState({})
  const [revealedPasswords, setRevealedPasswords] = useState({})
  const [copiedId, setCopiedId] = useState(null)
  const rememberIssued = (id, pwd) => { if (id) setIssuedPasswords(p => ({ ...p, [id]: pwd })) }

  // Reset Password modal
  const [resetModalUser, setResetModalUser] = useState(null)
  const [newPasswordInput, setNewPasswordInput] = useState('')
  const [resetting, setResetting] = useState(false)

  useEffect(() => { if (shop) fetchUsers() }, [shop])

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const { data, error: err } = await adminDb
        .from('users')
        .select('id, username, email, role, is_active, created_at, last_sign_in_at')
        .eq('shop_id', shop.id)
        .order('role')
      if (err) throw err

      setUsers(data || [])
    } catch (e) {
      setError('Failed to load users: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  const flash = (msg, isError = false) => {
    if (isError) { setError(msg); setSuccessMsg('') }
    else { setSuccessMsg(msg); setError('') }
    setTimeout(() => { setError(''); setSuccessMsg('') }, 4000)
  }

  const copyText = (text, id) => {
    if (!text) return
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const openAdd = () => {
    setForm(EMPTY_FORM)
    setShowPass(false)
    setFormMode('add')
  }

  const openEdit = (u) => {
    setForm({
      username: u.username,
      email: u.email || '',
      password: '',
      role: u.role,
      is_active: u.is_active
    })
    setShowPass(false)
    setFormMode(u.id)
  }

  const closeForm = () => { setFormMode(null); setForm(EMPTY_FORM) }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.username.trim()) { flash('Username is required.', true); return }
    if (formMode === 'add' && !form.password.trim()) { flash('Password is required for new user.', true); return }
    if (form.password && form.password.length < 4) { flash('Password must be at least 4 characters.', true); return }

    setSaving(true)
    try {
      if (formMode === 'add') {
        // Check username uniqueness within shop
        const { data: existing } = await adminDb
          .from('users').select('id').eq('shop_id', shop.id).ilike('username', form.username.trim()).maybeSingle()
        if (existing) { flash('Username already exists in this shop.', true); setSaving(false); return }

        const hashed = await hashPassword(form.password)
        const insertData = {
          shop_id: shop.id,
          username: form.username.trim(),
          email: form.email.trim() || null,
          password: hashed,
          role: form.role,
          is_active: form.is_active,
        }

        const { data: created, error: insErr } = await adminDb.from('users').insert([insertData]).select('id').single()
        if (insErr) throw insErr
        rememberIssued(created?.id, form.password)

        await logAction({
          actor_id: adminUser?.id, actor_email: adminUser?.email || adminUser?.username,
          action_type: 'CREATE_USER', target_type: 'USER',
          details: { username: form.username, role: form.role, shop_name: shop.name }
        })
        flash(`User "${form.username}" created successfully.`)
      } else {
        // Edit existing user
        const updateData = {
          username: form.username.trim(),
          email: form.email.trim() || null,
          role: form.role,
          is_active: form.is_active,
        }
        if (form.password.trim()) {
          updateData.password = await hashPassword(form.password)
        }

        const { error: updErr } = await adminDb.from('users').update(updateData).eq('id', formMode)
        if (updErr) throw updErr
        if (form.password.trim()) rememberIssued(formMode, form.password)

        await logAction({
          actor_id: adminUser?.id, actor_email: adminUser?.email || adminUser?.username,
          action_type: 'UPDATE_USER', target_type: 'USER', target_id: formMode,
          details: { username: form.username, passwordChanged: !!form.password, shop_name: shop.name }
        })
        flash(`User "${form.username}" updated successfully.`)
      }
      closeForm()
      fetchUsers()
    } catch (e) {
      flash('Error: ' + e.message, true)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (u) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return
    setDeletingId(u.id)
    try {
      const { error: delErr } = await adminDb.from('users').delete().eq('id', u.id)
      if (delErr) throw delErr
      await logAction({
        actor_id: adminUser?.id, actor_email: adminUser?.email || adminUser?.username,
        action_type: 'DELETE_USER', target_type: 'USER', target_id: u.id,
        details: { username: u.username, shop_name: shop.name }
      })
      flash(`User "${u.username}" deleted.`)
      fetchUsers()
    } catch (e) {
      flash('Delete failed: ' + e.message, true)
    } finally {
      setDeletingId(null)
    }
  }

  const toggleActive = async (u) => {
    try {
      const { error: e } = await adminDb.from('users').update({ is_active: !u.is_active }).eq('id', u.id)
      if (e) throw e
      flash(`User "${u.username}" is now ${!u.is_active ? 'active' : 'inactive'}.`)
      fetchUsers()
    } catch (err) {
      flash('Update failed: ' + err.message, true)
    }
  }

  const handleQuickReset = async (e) => {
    e.preventDefault()
    if (!resetModalUser || !newPasswordInput.trim()) return
    if (newPasswordInput.length < 4) return alert('Password must be at least 4 characters')

    setResetting(true)
    try {
      const hashed = await hashPassword(newPasswordInput.trim())
      const { error: rErr } = await adminDb.from('users').update({ password: hashed }).eq('id', resetModalUser.id)
      if (rErr) throw rErr
      rememberIssued(resetModalUser.id, newPasswordInput.trim())

      await logAction({
        actor_id: adminUser?.id, actor_email: adminUser?.email || adminUser?.username,
        action_type: 'RESET_USER_PASSWORD', target_type: 'USER', target_id: resetModalUser.id,
        details: { username: resetModalUser.username, shop_name: shop.name }
      })

      flash(`Password for "${resetModalUser.username}" was reset. Copy or WhatsApp it now — it is not stored.`)
      setResetModalUser(null)
      setNewPasswordInput('')
      fetchUsers()
    } catch (err) {
      alert('Password reset failed: ' + err.message)
    } finally {
      setResetting(false)
    }
  }

  const handleSendUserWhatsApp = (u) => {
    const passwordToShow = issuedPasswords[u.id]
    if (!passwordToShow) {
      // Passwords are not stored readable: set a new one first, then send it.
      setResetModalUser(u)
      setNewPasswordInput('')
      return
    }
    const msg = formatUserCredentialsMessage({
      shopName: shop.name,
      username: u.username,
      password: passwordToShow,
      role: u.role,
      loginUrl: window.location.origin
    })
    const url = buildWhatsAppUrl(shop.phone, msg)
    window.open(url, '_blank')
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-slate-100 bg-slate-50 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Users size={20} className="text-blue-600" />
              <span>Users — {shop.name}</span>
            </h2>
            <p className="text-xs text-slate-500">Add staff, reset credentials, or manage access. Passwords are never stored readable.</p>
          </div>
          <div className="flex items-center gap-2">
            {formMode === null && (
              <button onClick={openAdd}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl shadow-sm transition active:scale-95">
                <Plus size={14} /> Add User
              </button>
            )}
            <button onClick={onClose}
              className="text-slate-400 hover:text-slate-600 bg-white p-1.5 rounded-xl border border-slate-200">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Notifications */}
        {error && (
          <div className="mx-6 mt-4 p-3 bg-red-50 text-red-600 rounded-xl text-xs font-medium border border-red-100 flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" /> {error}
          </div>
        )}
        {successMsg && (
          <div className="mx-6 mt-4 p-3 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-medium border border-emerald-100 flex items-center gap-2">
            <CheckCircle2 size={14} className="shrink-0" /> {successMsg}
          </div>
        )}

        {/* Add / Edit Form Drawer */}
        {formMode !== null && (
          <form onSubmit={handleSave} className="m-6 p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
            <div className="flex justify-between items-center pb-2 border-b border-slate-200">
              <p className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                {formMode === 'add' ? '+ New Staff User' : 'Edit User'}
              </p>
              <button type="button" onClick={closeForm} className="text-slate-400 hover:text-slate-600 text-xs font-bold">
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Username */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">Username *</label>
                <div className="relative">
                  <User className="absolute left-3 top-2.5 text-slate-400" size={14} />
                  <input
                    type="text" required value={form.username}
                    onChange={e => setForm(p => ({ ...p, username: e.target.value }))}
                    placeholder="e.g. cashier1"
                    className="w-full pl-8 pr-3 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
                  />
                </div>
              </div>

              {/* Email */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">Email (optional)</label>
                <input
                  type="email" value={form.email}
                  onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                  placeholder="e.g. cashier@shop.com"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>

              {/* Password */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">
                  Password {formMode === 'add' ? '*' : '(leave blank to keep)'}
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-2.5 text-slate-400" size={14} />
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={form.password}
                    onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                    placeholder={formMode === 'add' ? 'Min. 4 characters' : 'Enter new password'}
                    className="w-full pl-8 pr-9 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
                  />
                  <button type="button" onClick={() => setShowPass(v => !v)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600">
                    {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {/* Role */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">Role *</label>
                <select value={form.role}
                  onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 font-bold">
                  <option value="cashier">Cashier</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>

            {/* Active toggle */}
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <input type="checkbox" checked={form.is_active}
                onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))}
                className="w-4 h-4 rounded accent-blue-600" />
              <span className="text-xs font-bold text-slate-600">Active (allowed to login)</span>
            </label>

            {/* Buttons */}
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition disabled:opacity-50 active:scale-95">
                <Save size={14} /> {saving ? 'Saving…' : formMode === 'add' ? 'Create User' : 'Save Changes'}
              </button>
              <button type="button" onClick={closeForm}
                className="flex items-center gap-1.5 px-4 py-2 bg-white border border-slate-200 text-slate-600 text-sm font-bold rounded-xl hover:bg-slate-50 transition active:scale-95">
                <XCircle size={14} /> Cancel
              </button>
            </div>
          </form>
        )}

        {/* Users List */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
          {loading ? (
            <div className="py-10 text-center text-slate-400 font-bold animate-pulse">Loading users…</div>
          ) : users.length === 0 ? (
            <div className="py-10 text-center">
              <Users size={36} className="mx-auto text-slate-200 mb-2" />
              <p className="text-slate-400 font-bold text-sm">No users found.</p>
              <p className="text-slate-400 text-xs mt-1">Click <strong>Add User</strong> to create the first staff account.</p>
            </div>
          ) : (
            users.map(u => (
              <div key={u.id}
                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border transition-all ${formMode === u.id ? 'border-blue-300 bg-blue-50' : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-slate-800 text-sm font-mono">{u.username}</p>
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider ${u.role === 'admin' ? 'bg-purple-100 text-purple-700' : u.role === 'manager' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                      {u.role}
                    </span>
                    {!u.is_active && (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-red-100 text-red-600">
                        Inactive
                      </span>
                    )}
                  </div>
                  {u.email && <p className="text-xs text-slate-500 mt-0.5 truncate">{u.email}</p>}

                  {/* ── PASSWORD REVEAL & WHATSAPP ROW ── */}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Password:</span>
                    {issuedPasswords[u.id] ? (
                      <div className="inline-flex items-center gap-1.5 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200 text-xs font-mono font-bold text-slate-700" title="New password — shown only until this window closes">
                        <span>{revealedPasswords[u.id] ? issuedPasswords[u.id] : '••••••'}</span>
                        <button
                          type="button"
                          onClick={() => setRevealedPasswords(p => ({ ...p, [u.id]: !p[u.id] }))}
                          title={revealedPasswords[u.id] ? 'Hide Password' : 'Show Password'}
                          className="text-slate-400 hover:text-slate-700 p-0.5"
                        >
                          {revealedPasswords[u.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => copyText(issuedPasswords[u.id], u.id)}
                          title="Copy Password"
                          className="text-slate-400 hover:text-slate-700 p-0.5"
                        >
                          {copiedId === u.id ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setResetModalUser(u); setNewPasswordInput('') }}
                        className="text-[10px] font-bold text-blue-600 hover:underline bg-blue-50 hover:bg-blue-100 px-2 py-0.5 rounded border border-blue-200 transition"
                      >
                        🔑 Reset Password
                      </button>
                    )}

                    {/* Quick WhatsApp Send */}
                    <button
                      type="button"
                      onClick={() => handleSendUserWhatsApp(u)}
                      title="Send credentials to owner via WhatsApp"
                      className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2 py-0.5 rounded transition"
                    >
                      <MessageSquare size={12} />
                      <span>WhatsApp</span>
                    </button>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 shrink-0 justify-end pt-2 sm:pt-0 border-t sm:border-0 border-slate-100">
                  <button onClick={() => toggleActive(u)}
                    title={u.is_active ? 'Deactivate' : 'Activate'}
                    className={`p-1.5 rounded-lg border text-xs font-bold transition active:scale-95 ${u.is_active ? 'border-orange-200 text-orange-500 hover:bg-orange-50' : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'}`}>
                    {u.is_active ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
                  </button>
                  <button onClick={() => openEdit(u)}
                    className="flex items-center gap-1 px-2.5 py-1.5 border border-slate-200 text-slate-600 text-xs font-bold rounded-lg hover:bg-slate-100 transition active:scale-95">
                    <Edit2 size={13} /> Edit
                  </button>
                  <button onClick={() => handleDelete(u)} disabled={deletingId === u.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 border border-red-200 text-red-500 text-xs font-bold rounded-lg hover:bg-red-50 transition active:scale-95 disabled:opacity-50">
                    <Trash2 size={13} /> {deletingId === u.id ? '…' : 'Delete'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 shrink-0 flex justify-between items-center">
          <p className="text-xs text-slate-400">{users.length} user{users.length !== 1 ? 's' : ''} in this shop</p>
          <button onClick={onClose}
            className="px-4 py-1.5 bg-white border border-slate-200 text-slate-600 text-xs font-bold rounded-xl hover:bg-slate-50 transition">
            Close
          </button>
        </div>
      </div>

      {/* ── RESET & REVEAL PASSWORD MODAL ── */}
      {resetModalUser && (
        <div className="fixed inset-0 bg-black/50 z-60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-5 max-w-sm w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                <KeyRound size={16} className="text-blue-600" />
                <span>Reset Password: {resetModalUser.username}</span>
              </h3>
              <button onClick={() => setResetModalUser(null)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <p className="text-xs text-slate-500">
              Set a new password, then copy it or send it via WhatsApp. It is shown only until this window closes and is never stored readable.
            </p>

            <form onSubmit={handleQuickReset} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">New Password</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={newPasswordInput}
                  onChange={e => setNewPasswordInput(e.target.value)}
                  placeholder="e.g. 123456 or Pass@123"
                  className="w-full px-3 py-2 border rounded-xl font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setNewPasswordInput(Math.floor(100000 + Math.random() * 900000).toString())}
                  className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl"
                >
                  Generate 6-Digit
                </button>
                <button
                  type="submit"
                  disabled={resetting || !newPasswordInput}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition disabled:opacity-50"
                >
                  {resetting ? 'Saving...' : 'Save Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
