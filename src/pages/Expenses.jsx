import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { db, addToSyncQueue, moveToTrash } from '../services/db'
import PasswordModal from '../components/PasswordModal'
import { hasFeature } from '../utils/featureGate'
import UpgradeWall from '../components/UpgradeWall'

function Expenses() {
  const { user } = useAuth()
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)

  const [form, setForm] = useState({ category: 'Misc', amount: '', note: '' })
  const [summary, setSummary] = useState({ today: 0, monthly: 0 })
  const [selected, setSelected] = useState([])
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [pendingDeleteIds, setPendingDeleteIds] = useState([])
  const [monthlyBudget, setMonthlyBudget] = useState(() => Number(localStorage.getItem('monthly_expense_budget') || 0))
  const [editingBudget, setEditingBudget] = useState(false)
  const [budgetInput, setBudgetInput] = useState('')

  const categories = ['Rent', 'Electricity', 'Tea/Food', 'Salary', 'Misc', 'Repairing', 'Transport']

  useEffect(() => {
    if (user?.shop_id) fetchExpenses()
  }, [user?.shop_id])

  const fetchExpenses = async () => {
    setLoading(true)
    try {
      if (!navigator.onLine) throw new Error('Offline');
      const fetchPromise = supabase
        .from('expenses')
        .select('*')
        .eq('shop_id', user.shop_id)
        .order('created_at', { ascending: false })

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))

      const { data, error } = await Promise.race([fetchPromise, timeoutPromise])

      if (error) throw error
      if (data) {
        setExpenses(data)
        calculateSummary(data)
        const cleanData = JSON.parse(JSON.stringify(data))
        await db.expenses.bulkPut(cleanData)
      }
    } catch (e) {
      console.log('Expenses: Fetching from local DB (Offline Fallback)')
      try {
        const localData = await db.expenses.toArray()
        const sorted = localData.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        const filtered = sorted.filter(x => String(x.shop_id) === String(user.shop_id))
        setExpenses(filtered)
        calculateSummary(filtered)
      } catch (err) { console.error('Local DB Expenses Error:', err) }
    } finally {
      setLoading(false)
    }
  }

  const calculateSummary = (data) => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

    const todayTotal = data
      .filter(e => new Date(e.created_at) >= today)
      .reduce((sum, e) => sum + Number(e.amount), 0)

    const monthlyTotal = data
      .filter(e => new Date(e.created_at) >= firstOfMonth)
      .reduce((sum, e) => sum + Number(e.amount), 0)

    setSummary({ today: todayTotal, monthly: monthlyTotal })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    const payload = {
      ...form,
      amount: parseFloat(form.amount),
      shop_id: user.shop_id
    }

    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')

      if (editingId) {
        const { error } = await supabase.from('expenses').update(payload).eq('id', editingId)
        if (error) throw error
      } else {
        const { error } = await supabase.from('expenses').insert([payload])
        if (error) throw error
      }
      setEditingId(null)
      setForm({ category: 'Misc', amount: '', note: '' })
      setShowForm(false)
      fetchExpenses()
    } catch (error) {
      const errMsg = error?.message || String(error)
      if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
        const offlineData = editingId ? { ...payload, id: editingId } : { ...payload, id: crypto.randomUUID(), created_at: new Date().toISOString() }
        const action = editingId ? 'UPDATE' : 'INSERT'
        await addToSyncQueue('expenses', action, offlineData)
        if (editingId) {
          await db.expenses.update(editingId, offlineData)
        } else {
          await db.expenses.add(offlineData)
        }
        setEditingId(null)
        setForm({ category: 'Misc', amount: '', note: '' })
        setShowForm(false)
        fetchExpenses()
        alert('Offline mode: Saved locally. Will sync automatically when online. 🔄')
      } else {
        alert(error.message)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (exp) => {
    setForm({ category: exp.category, amount: exp.amount, note: exp.note || '' })
    setEditingId(exp.id)
    setShowForm(true)
  }

  const requestDelete = (ids) => {
    setPendingDeleteIds(ids)
    setShowPasswordModal(true)
  }

  const executeDelete = async () => {
    setShowPasswordModal(false)
    const ids = pendingDeleteIds
    setPendingDeleteIds([])

    let successCount = 0
    let failCount = 0
    const successfulIds = []

    for (const id of ids) {
      const item = expenses.find(e => e.id === id)
      if (!item) continue

      try {
        if (navigator.onLine) {
          const { error } = await supabase.from('expenses').delete().eq('id', id)
          if (error) {
            console.error('Delete failed:', error)
            failCount++
            continue
          }
        } else {
          await addToSyncQueue('expenses', 'DELETE', { id })
        }

        await moveToTrash('expenses', id, item, user.id, user.shop_id)
        await db.expenses.delete(id)
        successfulIds.push(id)
        successCount++
      } catch (err) {
        console.error('Delete error:', err)
        failCount++
      }
    }

    setExpenses(prev => prev.filter(e => !successfulIds.includes(e.id)))
    setSelected([])

    if (failCount > 0) {
      alert(`⚠️ Partially completed.\n✅ Deleted: ${successCount}\n❌ Failed: ${failCount}`)
    } else if (successCount > 0) {
      alert(`🗑️ ${successCount} expense(s) moved to Trash!`)
    }
    fetchExpenses()
  }

  const saveBudget = () => {
    const val = Number(budgetInput)
    if (!isNaN(val) && val >= 0) {
      setMonthlyBudget(val)
      localStorage.setItem('monthly_expense_budget', val)
    }
    setEditingBudget(false)
  }

  const toggleSelect = (id) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const toggleSelectAll = () => {
    if (selected.length === expenses.length) {
      setSelected([])
    } else {
      setSelected(expenses.map(x => x.id))
    }
  }

  if (!hasFeature('expenses')) return <UpgradeWall feature="expenses" />

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-fg">💸 Expenses</h1>
          <p className="text-fg-muted text-sm">Track your daily business expenditures</p>
        </div>
        <div className="flex gap-4 w-full sm:w-auto overflow-x-auto pb-1 items-center flex-wrap">
          <div className="bg-surface p-4 rounded-xl shadow-sm border border-line-subtle text-center min-w-[120px]">
            <p className="text-[10px] text-fg-subtle font-bold uppercase tracking-wider">Today</p>
            <p className="text-xl font-bold text-danger-fg">Rs. {summary.today.toLocaleString()}</p>
          </div>
          <div className="bg-surface p-4 rounded-xl shadow-sm border border-line-subtle text-center min-w-[120px]">
            <p className="text-[10px] text-fg-subtle font-bold uppercase tracking-wider">This Month</p>
            <p className="text-xl font-bold text-fg">Rs. {summary.monthly.toLocaleString()}</p>
          </div>

          {/* Monthly Budget Card */}
          {(() => {
            const pct = monthlyBudget > 0 ? Math.min((summary.monthly / monthlyBudget) * 100, 100) : 0
            const barColor = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-success'
            const textColor = pct >= 90 ? 'text-danger-fg' : pct >= 70 ? 'text-warning-fg' : 'text-success-fg'
            return (
              <div className="bg-surface p-4 rounded-xl shadow-sm border border-line-subtle min-w-[180px]">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] text-fg-subtle font-bold uppercase tracking-wider">Monthly Budget</p>
                  <button
                    onClick={() => { setBudgetInput(monthlyBudget); setEditingBudget(true) }}
                    className="text-[10px] text-primary-fg hover:text-primary-strong font-bold"
                    title="Edit budget"
                  >✏️</button>
                </div>
                {editingBudget ? (
                  <div className="flex gap-1 mt-1">
                    <input
                      type="number"
                      value={budgetInput}
                      onChange={e => setBudgetInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveBudget(); if (e.key === 'Escape') setEditingBudget(false) }}
                      autoFocus
                      className="w-24 px-2 py-1 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                      placeholder="Budget..."
                    />
                    <button onClick={saveBudget} className="px-2 py-1 bg-primary text-white rounded-lg text-xs font-bold">✓</button>
                  </div>
                ) : monthlyBudget > 0 ? (
                  <>
                    <p className={`text-lg font-bold ${textColor}`}>
                      Rs. {summary.monthly.toLocaleString()} <span className="text-xs text-fg-subtle font-normal">/ {monthlyBudget.toLocaleString()}</span>
                    </p>
                    <div className="w-full bg-surface-3 rounded-full h-2 mt-2">
                      <div className={`${barColor} h-2 rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
                    </div>
                    <p className={`text-[10px] font-bold mt-1 ${textColor}`}>{pct.toFixed(0)}% used</p>
                  </>
                ) : (
                  <p className="text-sm text-fg-subtle italic mt-1">Set a budget ✏️</p>
                )}
              </div>
            )
          })()}

          {selected.length > 0 && (
            <button
              onClick={() => requestDelete(selected)}
              className="px-4 py-2 bg-danger hover:bg-danger-hover text-white rounded-xl transition font-bold text-sm"
            >
              🗑️ Delete Selected ({selected.length})
            </button>
          )}
          <button
            onClick={() => { setShowForm(!showForm); setEditingId(null); setForm({ category: 'Misc', amount: '', note: '' }) }}
            className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-xl transition shadow-lg shadow-primary-muted font-bold"
          >
            {showForm ? 'Cancel' : '+ Add Expense'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="bg-surface rounded-2xl shadow-xl p-6 border border-primary-muted max-w-xl mx-auto md:mx-0">
          <h2 className="font-bold text-fg mb-4">{editingId ? 'Edit Expense' : 'New Expense'}</h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-fg-2 mb-1">Category</label>
              <select
                value={form.category}
                onChange={e => setForm({ ...form, category: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none"
              >
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-fg-2 mb-1">Amount (Rs.)</label>
              <input
                type="number"
                required
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none"
                placeholder="0.00"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-fg-2 mb-1">Note / Description</label>
              <textarea
                value={form.note}
                onChange={e => setForm({ ...form, note: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none"
                placeholder="Description of expenditure..."
                rows="2"
              ></textarea>
            </div>
            <div className="md:col-span-2 pt-2">
              <button
                type="submit"
                disabled={saving}
                className="w-full py-3 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl transition disabled:opacity-50"
              >
                {saving ? 'Saving...' : editingId ? 'Update Expense' : 'Save Expense'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle overflow-hidden">
        <div className="divide-y divide-line-subtle md:hidden">
          {loading ? (
            <p className="px-6 py-12 text-center text-fg-subtle">Loading expenses...</p>
          ) : expenses.length === 0 ? (
            <p className="px-6 py-12 text-center text-fg-subtle italic">No expenses recorded yet.</p>
          ) : expenses.map(exp => (
            <div key={exp.id} className={`p-4 ${selected.includes(exp.id) ? 'bg-primary-soft' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="px-2 py-0.5 bg-surface-3 text-fg-2 rounded text-[10px] font-bold uppercase">
                    {exp.category}
                  </span>
                  <p className="mt-1 font-bold text-fg text-sm">{exp.note || 'No note'}</p>
                  <p className="mt-1 text-xs text-fg-subtle">{new Date(exp.created_at).toLocaleDateString('en-PK')}</p>
                </div>
                <input type="checkbox" checked={selected.includes(exp.id)} onChange={() => toggleSelect(exp.id)} className="mt-1 h-4 w-4 rounded" />
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-lg font-black text-fg">Rs. {exp.amount.toLocaleString()}</p>
                <div className="flex gap-2">
                  <button onClick={() => handleEdit(exp)} className="rounded-lg bg-primary-soft px-3 py-2 text-sm font-bold text-primary-fg">Edit</button>
                  <button onClick={() => requestDelete([exp.id])} className="rounded-lg bg-danger-soft px-3 py-2 text-sm font-bold text-danger-fg">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left">
            <thead className="bg-surface-2 border-b">
              <tr>
                <th className="px-4 py-4 w-10">
                  <input
                    type="checkbox"
                    checked={selected.length === expenses.length && expenses.length > 0}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded"
                  />
                </th>
                <th className="px-6 py-4 text-xs font-bold text-fg-muted uppercase whitespace-nowrap">Date</th>
                <th className="px-6 py-4 text-xs font-bold text-fg-muted uppercase whitespace-nowrap">Category</th>
                <th className="px-6 py-4 text-xs font-bold text-fg-muted uppercase whitespace-nowrap min-w-[150px]">Description</th>
                <th className="px-6 py-4 text-xs font-bold text-fg-muted uppercase text-right whitespace-nowrap">Amount</th>
                <th className="px-6 py-4 text-xs font-bold text-fg-muted uppercase text-center whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {loading ? (
                <tr><td colSpan="6" className="px-6 py-12 text-center text-fg-subtle">Loading expenses...</td></tr>
              ) : expenses.length === 0 ? (
                <tr><td colSpan="6" className="px-6 py-12 text-center text-fg-subtle italic">No expenses recorded yet.</td></tr>
              ) : expenses.map(exp => (
                <tr key={exp.id} className={`hover:bg-surface-2 transition group ${selected.includes(exp.id) ? 'bg-primary-soft' : ''}`}>
                  <td className="px-4 py-4">
                    <input
                      type="checkbox"
                      checked={selected.includes(exp.id)}
                      onChange={() => toggleSelect(exp.id)}
                      className="w-4 h-4 rounded"
                    />
                  </td>
                  <td className="px-6 py-4 text-sm text-fg-muted">{new Date(exp.created_at).toLocaleDateString('en-PK')}</td>
                  <td className="px-6 py-4">
                    <span className="px-3 py-1 bg-surface-3 text-fg-2 rounded-full text-xs font-bold uppercase">
                      {exp.category}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-fg-3 italic">{exp.note || '-'}</td>
                  <td className="px-6 py-4 text-right font-bold text-fg">Rs. {exp.amount.toLocaleString()}</td>
                  <td className="px-6 py-4 text-center">
                    <div className="flex justify-center gap-3 opacity-0 group-hover:opacity-100 transition">
                      <button onClick={() => handleEdit(exp)} className="text-primary-fg hover:text-primary-strong font-bold text-sm">Edit</button>
                      <button onClick={() => requestDelete([exp.id])} className="text-danger-fg hover:text-danger-strong font-bold text-sm">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showPasswordModal && (
        <PasswordModal
          title="Delete Expense(s)"
          message={`${pendingDeleteIds.length} item(s) will be moved to Trash`}
          onConfirm={executeDelete}
          onCancel={() => { setShowPasswordModal(false); setPendingDeleteIds([]) }}
        />
      )}
    </div>
  )
}

export default Expenses
