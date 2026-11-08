import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { db } from '../services/db'
import { hashPassword, verifyPassword } from '../utils/authUtils'

function Users() {
  const { user } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'cashier', is_active: true, permissions: [] })

  // Change password state
  const [showChangePw, setShowChangePw] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [changingPw, setChangingPw] = useState(false)

  const [limits] = useState(() => {
    try {
      const sid = user?.shop_id
      return JSON.parse((sid ? localStorage.getItem(`plan_limits_${sid}`) : null) || localStorage.getItem('plan_limits') || '{"user_limit": 2, "plan_name": "TRIAL"}')
    } catch {
      return { user_limit: 2, plan_name: 'TRIAL' }
    }
  })

  const AVAILABLE_MODULES = [
    { id: 'pos', label: 'POS Billing' },
    { id: 'products', label: 'Products' },
    { id: 'categories', label: 'Categories' },
    { id: 'suppliers', label: 'Suppliers' },
    { id: 'customers', label: 'Customers' },
    { id: 'sales', label: 'Sales History' },
    { id: 'purchase-history', label: 'Purchase History' },
    { id: 'expenses', label: 'Expenses' },
    { id: 'purchases', label: 'Purchases' },
    { id: 'inventory', label: 'Stock Inventory' },
    { id: 'reports', label: 'Reports' }
  ]

  useEffect(() => {
    if (user?.shop_id) fetchUsers()
  }, [user?.shop_id])

  const fetchUsers = async () => {
    try {
      if (!navigator.onLine) throw new Error('Offline');
      const fetchPromise = supabase
        .from('users')
        .select('id, username, email, role, is_active, created_at, permissions')
        .eq('shop_id', user.shop_id)
        .neq('role', 'superadmin')
        .order('created_at', { ascending: false })

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))

      const { data, error } = await Promise.race([fetchPromise, timeoutPromise])

      if (error) throw error
      if (data) {
        setUsers(data)
        const cleanData = JSON.parse(JSON.stringify(data))
        await db.users.bulkPut(cleanData)
      }
    } catch (e) {
      console.log('Users: Fetching from local DB (Offline Fallback)')
      try {
        const localData = await db.users.toArray()
        const sorted = localData.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        setUsers(sorted.filter(x => String(x.shop_id) === String(user.shop_id)))
      } catch (err) { console.error('Local DB Users Error:', err) }
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (u) => {
    setForm({
      username: u.username,
      email: u.email || '',
      password: '',
      role: u.role,
      is_active: u.is_active,
      permissions: u.permissions || []
    })
    setEditingId(u.id)
    setShowForm(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)

    if (editingId) {
      const updateData = { username: form.username, email: form.email, role: form.role, is_active: form.is_active, permissions: form.permissions }
      if (form.password) updateData.password = await hashPassword(form.password)
      const { error } = await supabase.from('users').update(updateData).eq('id', editingId)
      if (error) {
        if (error.message?.toLowerCase().includes('row-level security') || error.message?.toLowerCase().includes('rls')) {
          alert('⚠️ Session Expired: Meharbani karke app se Log Out karke dobara Log In karein taake server connection refresh ho sake.')
        } else {
          alert('Error: ' + error.message)
        }
      }
      else { setEditingId(null); setForm({ username: '', email: '', password: '', role: 'cashier', is_active: true, permissions: [] }); setShowForm(false); fetchUsers() }
    } else {
      // Dynamic Limit Enforcement
      if (users.length >= (limits.user_limit || 2)) {
        alert(`Limit Reached! Aapka ${limits.plan_name || 'TRIAL'} plan sirf ${limits.user_limit || 2} staff accounts ki ijazat deta hai. Meharbani karke Superadmin se plan upgrade karwayein.`)
        setSaving(false)
        return
      }
      if (!form.password) { alert('Password zaroori hai!'); setSaving(false); return }
      const hashedPassword = await hashPassword(form.password)
      const { error } = await supabase.from('users').insert([{ ...form, password: hashedPassword, shop_id: user.shop_id }])
      if (error) {
        if (error.message?.toLowerCase().includes('row-level security') || error.message?.toLowerCase().includes('rls')) {
          alert('⚠️ Session Expired: Meharbani karke app se Log Out karke dobara Log In karein taake server connection refresh ho sake.')
        } else {
          alert('Error: ' + error.message)
        }
      }
      else { setForm({ username: '', email: '', password: '', role: 'cashier', is_active: true, permissions: [] }); setShowForm(false); fetchUsers() }
    }
    setSaving(false)
  }

  const toggleActive = async (u) => {
    const { error } = await supabase.from('users').update({ is_active: !u.is_active }).eq('id', u.id)
    if (error) alert('Could not update user: ' + error.message)
    fetchUsers()
  }

  const handleDelete = async (id) => {
    if (id === user.id) { alert('Aap apna khud ka account delete nahi kar sakte!'); return }
    if (!confirm('Is user ko delete karo?')) return
    const { error } = await supabase.from('users').delete().eq('id', id).eq('shop_id', user.shop_id)
    if (error) alert('Could not delete user: ' + error.message)
    fetchUsers()
  }

  const handleCancel = () => {
    setShowForm(false); setEditingId(null)
    setForm({ username: '', email: '', password: '', role: 'cashier', is_active: true, permissions: [] })
  }

  const togglePermission = (moduleId) => {
    setForm(prev => {
      if (prev.permissions.includes(moduleId)) {
        return { ...prev, permissions: prev.permissions.filter(id => id !== moduleId) }
      } else {
        return { ...prev, permissions: [...prev.permissions, moduleId] }
      }
    })
  }

  const handleChangePassword = async (e) => {
    e.preventDefault()
    if (!currentPw || !newPw || !confirmPw) { alert('Tamam fields fill karo!'); return }
    if (newPw.length < 4) { alert('Naya password kam az kam 4 characters ka hona chahiye!'); return }
    if (newPw !== confirmPw) { alert('Naya password aur confirm password match nahi karte!'); return }

    setChangingPw(true)
    try {
      // Verify current password
      const storedHash = localStorage.getItem('user_pw_hash')
      if (!storedHash) {
        // Try to get from DB
        const localUser = await db.users.get(user.id)
        if (!localUser?.password) {
          alert('Current password verify nahi ho saka. Please logout aur dobara login karein.')
          setChangingPw(false)
          return
        }
        const isValid = await verifyPassword(currentPw, localUser.password)
        if (!isValid) { alert('Current password ghalat hai!'); setChangingPw(false); return }
      } else {
        const isValid = await verifyPassword(currentPw, storedHash)
        if (!isValid) { alert('Current password ghalat hai!'); setChangingPw(false); return }
      }

      // Hash new password and update
      const newHash = await hashPassword(newPw)
      const { error } = await supabase.from('users').update({ password: newHash }).eq('id', user.id)
      if (error) throw error

      // Update local cache
      localStorage.setItem('user_pw_hash', newHash)
      await db.users.update(user.id, { password: newHash })

      alert('Password successfully change ho gaya! ✅')
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
      setShowChangePw(false)
    } catch (err) {
      alert('Error: ' + (err.message || err))
    } finally {
      setChangingPw(false)
    }
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-fg">👨‍💼 Users</h1>
          <p className="text-sm text-fg-muted mt-1">
            Shop Limit ({limits.plan_name || 'TRIAL'}):
            <span className={users.length >= (limits.user_limit || 2) ? 'text-danger-fg font-bold ml-1' : 'text-primary-fg font-bold ml-1'}>
              {users.length} / {limits.user_limit || 2}
            </span> users
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowChangePw(!showChangePw)}
            className={`px-4 py-2 rounded-lg transition font-medium text-sm ${showChangePw ? 'bg-surface-4 text-fg-2' : 'bg-success hover:bg-success-hover text-white'}`}>
            {showChangePw ? '✕ Close' : '🔑 Change My Password'}
          </button>
          <button
            onClick={() => {
              if (!showForm && users.length >= (limits.user_limit || 2) && !editingId) {
                alert(`Plan Limit! Aapka current plan max ${limits.user_limit || 2} users allow karta hai.`)
                return
              }
              setShowForm(!showForm)
            }}
            className={`px-4 py-2 text-white rounded-lg transition ${users.length >= (limits.user_limit || 2) && !showForm && !editingId ? 'bg-fg-subtle cursor-not-allowed' : 'bg-primary hover:bg-primary-hover'}`}>
            {showForm ? 'Cancel' : '+ Add User'}
          </button>
        </div>
      </div>

      {/* Change My Password */}
      {showChangePw && (
        <div className="bg-surface rounded-xl shadow p-6 mb-6 max-w-md border-2 border-success-muted">
          <h2 className="font-bold text-fg mb-1 flex items-center gap-2">🔑 Change My Password</h2>
          <p className="text-xs text-fg-muted mb-4">Apna password yahan change karein. Current password zaroori hai.</p>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <div>
              <label className="block text-fg-2 font-medium mb-1 text-sm">Current Password *</label>
              <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)}
                required className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-success"
                placeholder="Purana password" />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1 text-sm">New Password *</label>
              <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                required className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-success"
                placeholder="Naya password (min 4 characters)" />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1 text-sm">Confirm New Password *</label>
              <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                required className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-success"
                placeholder="Naya password dobara darj karein" />
              {newPw && confirmPw && newPw !== confirmPw && (
                <p className="text-danger-fg text-xs mt-1">❌ Passwords match nahi karte</p>
              )}
            </div>
            <div className="flex gap-3 pt-1">
              <button type="submit" disabled={changingPw}
                className="px-6 py-2 bg-success hover:bg-success-hover text-white rounded-lg transition disabled:opacity-50 font-bold">
                {changingPw ? 'Changing...' : '✅ Update Password'}
              </button>
              <button type="button" onClick={() => { setShowChangePw(false); setCurrentPw(''); setNewPw(''); setConfirmPw('') }}
                className="px-6 py-2 bg-surface-4 hover:bg-surface-5 text-fg-2 rounded-lg transition">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {showForm && (
        <div className="bg-surface rounded-xl shadow p-6 mb-6 max-w-lg">
          <h2 className="font-semibold text-fg-2 mb-4">{editingId ? 'Edit User' : 'New User'}</h2>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-fg-2 font-medium mb-1">Username *</label>
              <input type="text" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}
                required className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="e.g. cashier1" />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1">Email *</label>
              <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                required className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="e.g. ali@shop.com" />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1">
                Password {editingId && <span className="text-fg-subtle text-xs">(khali chhorein agar change nahi karna)</span>}
              </label>
              <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}
                className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder={editingId ? 'Naya password (optional)' : 'Password'} />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1">Role</label>
              <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
                className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary">
                <option value="cashier">Cashier</option>
                <option value="manager">Manager</option>
                <option value="accountant">Accountant</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            {/* Custom Permissions */}
            <div className="bg-surface-2 border border-line rounded-xl p-4 mt-4">
              <label className="block text-fg font-bold mb-3">Allowed Modules (Custom Permissions)</label>
              {form.role === 'admin' ? (
                <div className="text-sm text-primary-fg bg-primary-soft p-3 rounded-lg border border-primary-muted italic">
                  Admins implicitly have full access to all modules natively. Custom restrictions are ignored.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {AVAILABLE_MODULES.map(mod => (
                    <label key={mod.id} className="flex items-center gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={form.permissions.includes(mod.id)}
                        onChange={() => togglePermission(mod.id)}
                        className="w-4 h-4 text-primary-fg rounded border-line-strong focus:ring-primary"
                      />
                      <span className="text-sm text-fg-2 font-medium group-hover:text-primary-fg transition-colors">
                        {mod.label}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 pt-2">
              <input type="checkbox" id="is_active" checked={form.is_active}
                onChange={e => setForm({ ...form, is_active: e.target.checked })}
                className="w-4 h-4 text-primary-fg" />
              <label htmlFor="is_active" className="text-fg-2 font-medium">Active (login kar sakta hai)</label>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={saving}
                className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition disabled:opacity-50">
                {saving ? 'Saving...' : editingId ? 'Update User' : 'Save User'}
              </button>
              <button type="button" onClick={handleCancel}
                className="px-6 py-2 bg-surface-4 hover:bg-surface-5 text-fg-2 rounded-lg transition">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? <p className="text-fg-muted">Loading...</p> : users.length === 0 ? (
        <div className="text-center py-12"><p className="text-fg-subtle text-lg">No users yet</p></div>
      ) : (
        <div className="bg-surface rounded-xl shadow overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[520px]">
            <thead className="bg-surface-2 border-b">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase">User Info</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase">Role</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map(u => (
                <tr key={u.id} className="hover:bg-surface-2">
                  <td className="px-6 py-4">
                    <div className="font-bold text-fg">
                      {u.username} {u.id === user.id && <span className="text-xs text-primary-fg font-normal ml-1">(You)</span>}
                    </div>
                    {u.email && <div className="text-xs text-fg-muted mt-0.5">{u.email}</div>}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${u.role === 'admin' ? 'bg-info-muted text-info-strong' : 'bg-primary-muted text-primary-strong'}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <button onClick={() => toggleActive(u)}
                      className={`px-2 py-1 rounded-full text-xs font-medium cursor-pointer ${u.is_active ? 'bg-success-muted text-success-strong' : 'bg-danger-muted text-danger-strong'}`}>
                      {u.is_active ? '✅ Active' : '❌ Inactive'}
                    </button>
                  </td>
                  <td className="px-6 py-4 flex gap-3">
                    <button onClick={() => handleEdit(u)} className="text-primary-fg hover:text-primary-strong text-sm font-medium">Edit</button>
                    <button onClick={() => handleDelete(u.id)} className="text-danger-fg hover:text-danger-strong text-sm font-medium">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default Users