import { useState, useEffect } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { db, addToSyncQueue } from '../services/db'
import Categories from './Categories'
import Brands from './Brands'

// ── Default units for "Seed Defaults" button ──────────────────────────────────
const DEFAULT_UNITS = [
  { name: 'Piece', abbreviation: 'Pcs' },
  { name: 'Pack', abbreviation: 'Pk' },
  { name: 'Box', abbreviation: 'Box' },
  { name: 'Carton', abbreviation: 'Ctn' },
  { name: 'Dozen', abbreviation: 'Dz' },
  { name: 'Kg', abbreviation: 'Kg' },
  { name: 'Gram', abbreviation: 'g' },
  { name: 'Liter', abbreviation: 'L' },
  { name: 'Strip', abbreviation: 'Str' },
  { name: 'Bottle', abbreviation: 'Btl' },
  { name: 'Pair', abbreviation: 'Pr' },
  { name: 'Set', abbreviation: 'Set' },
  { name: 'Meter', abbreviation: 'm' },
  { name: 'Feet', abbreviation: 'ft' },
  { name: 'Roll', abbreviation: 'Roll' },
  { name: 'Bag', abbreviation: 'Bag' },
  { name: 'Bundle', abbreviation: 'Bndl' },
  { name: 'Length', abbreviation: 'Len' },
]

// ── Units Tab ─────────────────────────────────────────────────────────────────
function UnitsTab() {
  const { user } = useAuth()
  const [units, setUnits] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ name: '', abbreviation: '' })

  useEffect(() => {
    if (user?.shop_id) fetchUnits()
  }, [user?.shop_id])

  const fetchUnits = async () => {
    setLoading(true)
    try {
      if (!navigator.onLine) throw new Error('Offline')
      const { data, error } = await supabase
        .from('units').select('*').eq('shop_id', user.shop_id).order('name')
      if (error) throw error
      if (data) await db.units.bulkPut(JSON.parse(JSON.stringify(data))).catch(() => {})
      setUnits(data || [])
    } catch {
      try {
        const local = await db.units.toArray()
        setUnits(local.filter(x => String(x.shop_id) === String(user.shop_id)))
      } catch (e) { console.error(e) }
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    setShowForm(false); setEditingId(null); setForm({ name: '', abbreviation: '' })
  }

  const handleEdit = (u) => {
    setForm({ name: u.name, abbreviation: u.abbreviation || '' })
    setEditingId(u.id); setShowForm(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    const payload = { name: form.name.trim(), abbreviation: form.abbreviation.trim(), shop_id: user.shop_id }
    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')
      if (editingId) {
        const { error } = await supabase.from('units').update(payload).eq('id', editingId)
        if (error) throw error
        await db.units.update(editingId, payload)
      } else {
        const { data, error } = await supabase.from('units').insert([payload]).select()
        if (error) throw error
        if (data?.[0]) await db.units.put(data[0]).catch(() => {})
      }
      handleCancel(); fetchUnits()
    } catch (err) {
      const msg = err?.message || String(err)
      if (msg.includes('Failed to fetch') || !navigator.onLine) {
        const offlineData = editingId
          ? { ...payload, id: editingId }
          : { ...payload, id: crypto.randomUUID(), created_at: new Date().toISOString() }
        await addToSyncQueue('units', editingId ? 'UPDATE' : 'INSERT', offlineData)
        if (editingId) await db.units.update(editingId, offlineData)
        else await db.units.add(offlineData)
        handleCancel(); fetchUnits()
        alert('Offline: Locally save ho gaya. Online hone par sync hoga.')
      } else {
        alert('Error: ' + msg)
      }
    } finally { setSaving(false) }
  }

  const handleDelete = async (u) => {
    if (!confirm(`"${u.name}" delete karein?`)) return
    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')
      const { error } = await supabase.from('units').delete().eq('id', u.id)
      if (error) throw error
      await db.units.delete(u.id)
      fetchUnits()
    } catch (err) {
      const msg = err?.message || String(err)
      if (msg.includes('Failed to fetch') || !navigator.onLine) {
        await db.units.delete(u.id)
        await addToSyncQueue('units', 'DELETE', { id: u.id })
        fetchUnits()
      } else { alert('Error: ' + msg) }
    }
  }

  const handleSeedDefaults = async () => {
    if (!confirm(`${DEFAULT_UNITS.length} default units add karein?`)) return
    setSaving(true)
    try {
      const existingNames = new Set(units.map(u => u.name.toLowerCase()))
      const toInsert = DEFAULT_UNITS
        .filter(u => !existingNames.has(u.name.toLowerCase()))
        .map(u => ({ ...u, shop_id: user.shop_id }))
      if (!toInsert.length) { alert('Tamam default units pehle se mojood hain.'); setSaving(false); return }
      if (navigator.onLine) {
        const { error } = await supabase.from('units').insert(toInsert)
        if (error) throw error
      } else {
        for (const u of toInsert) {
          const local = { ...u, id: crypto.randomUUID(), created_at: new Date().toISOString() }
          await db.units.add(local)
          await addToSyncQueue('units', 'INSERT', local)
        }
      }
      fetchUnits()
      alert(`${toInsert.length} units add ho gayi! ✅`)
    } catch (err) { alert('Error: ' + err.message) }
    finally { setSaving(false) }
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <h2 className="text-xl font-bold text-fg">📐 Units of Measure</h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleSeedDefaults} disabled={saving}
            className="px-4 py-2 bg-surface-3 hover:bg-surface-4 text-fg-2 rounded-lg text-sm font-bold transition disabled:opacity-50">
            🌱 Seed Defaults
          </button>
          <button onClick={() => showForm ? handleCancel() : setShowForm(true)}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-bold transition">
            {showForm ? 'Cancel' : '+ Add Unit'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="bg-surface rounded-xl shadow p-6 mb-6 max-w-md">
          <h3 className="font-semibold text-fg-2 mb-4">{editingId ? 'Edit Unit' : 'New Unit'}</h3>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-fg-2 font-medium mb-1 text-sm">Name *</label>
              <input type="text" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Feet, Kg, Box"
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm" />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1 text-sm">Abbreviation</label>
              <input type="text" value={form.abbreviation} onChange={e => setForm(f => ({ ...f, abbreviation: e.target.value }))}
                placeholder="e.g. ft, Kg, Box"
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm" />
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={saving}
                className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition disabled:opacity-50 text-sm font-semibold">
                {saving ? 'Saving...' : editingId ? 'Update' : 'Save'}
              </button>
              <button type="button" onClick={handleCancel}
                className="px-6 py-2 bg-surface-3 hover:bg-surface-4 text-fg-2 rounded-lg transition text-sm">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? <p className="text-fg-subtle">Loading...</p> : units.length === 0 ? (
        <div className="text-center py-12 text-fg-subtle">
          <p className="text-lg mb-2">Koi unit nahi mili</p>
          <p className="text-sm">
            "Seed Defaults" dabayein 14 standard units add karne ke liye,<br />ya manually add karein.
          </p>
        </div>
      ) : (
        <div className="bg-surface rounded-xl shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-bold text-fg-muted uppercase">Sr.</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-fg-muted uppercase">Unit Name</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-fg-muted uppercase">Abbreviation</th>
                <th className="px-6 py-3 text-center text-xs font-bold text-fg-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {units.map((u, idx) => (
                <tr key={u.id} className="hover:bg-surface-2">
                  <td className="px-6 py-3 text-fg-subtle">{idx + 1}</td>
                  <td className="px-6 py-3 font-semibold text-fg">{u.name}</td>
                  <td className="px-6 py-3">
                    <span className="bg-primary-soft text-primary-strong px-2 py-0.5 rounded font-mono text-xs font-bold">
                      {u.abbreviation || '—'}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-center">
                    <div className="flex gap-2 justify-center">
                      <button onClick={() => handleEdit(u)} className="px-3 py-1 hover:bg-surface-3 text-fg-3 rounded text-xs font-medium">Edit</button>
                      <button onClick={() => handleDelete(u)} className="px-3 py-1 hover:bg-danger-soft text-danger-fg rounded text-xs font-medium">Delete</button>
                    </div>
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

// ── Master Data Page ──────────────────────────────────────────────────────────
function MasterData() {
  const [activeTab, setActiveTab] = useState(() => {
    return localStorage.getItem('masterDataTab') || 'categories'
  })

  const setTab = (tab) => {
    setActiveTab(tab)
    localStorage.setItem('masterDataTab', tab)
  }

  const tabs = [
    { id: 'categories', label: '🗂️ Categories' },
    { id: 'brands', label: '🏷️ Brands' },
    { id: 'units', label: '📐 Units' },
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-fg mb-4">⚙️ Master Data</h1>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b border-line">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-2.5 font-bold text-sm rounded-t-lg transition ${
              activeTab === t.id
                ? 'bg-primary text-white border-b-2 border-primary'
                : 'text-fg-muted hover:text-fg-2 hover:bg-surface-3'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'categories' && <Categories />}
      {activeTab === 'brands' && <Brands />}
      {activeTab === 'units' && <UnitsTab />}
    </div>
  )
}

export default MasterData
