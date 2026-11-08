import { useEffect, useState, useRef } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { Link } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { hasFeature } from '../utils/featureGate'
import UpgradeWall from '../components/UpgradeWall'
import { db, addToSyncQueue, moveToTrash } from '../services/db'
import { adjustSupplierBalance, must } from '../services/integrity'
import PasswordModal from '../components/PasswordModal'

function Suppliers() {
  const { user } = useAuth()
  const [suppliers, setSuppliers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({
    name: '',
    phone: '',
    address: '',
    brand: '',
    product_type: '',
    other_details: '',
    outstanding_balance: 0
  })
  const [brands, setBrands] = useState([])
  const fileInputRef = useRef(null)
  const [selected, setSelected] = useState([])
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [pendingDeleteIds, setPendingDeleteIds] = useState([])
  const [wipeLedger, setWipeLedger] = useState(false)

  // ─── Transaction Modal ────────────────────────────────────────────────────
  const [showTxModal, setShowTxModal] = useState(false)
  const [txSup, setTxSup] = useState(null)
  const [txLedger, setTxLedger] = useState([])
  const [txLoading, setTxLoading] = useState(false)
  const [showAddTx, setShowAddTx] = useState(false)
  const [txSaving, setTxSaving] = useState(false)
  const [txImporting, setTxImporting] = useState(false)
  const txFileRef = useRef(null)
  const [txForm, setTxForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    bill_number: '',
    type: 'debit',
    amount: '',
    note: ''
  })

  useEffect(() => {
    if (user?.shop_id) {
      fetchSuppliers()
      fetchBrands()
    }
  }, [user?.shop_id])

  // ─── Build ledger from purchases + supplier_payments ─────────────────────
  const buildLedger = (purchases, payments) => {
    const combined = [
      ...(purchases || []).map(p => ({
        id: p.id,
        date: p.created_at,
        type: 'purchase',
        bill_number: `Bill #${String(p.id).slice(-8)}`,
        amount: p.total_amount || 0,
        note: p.note || '',
      })),
      ...(payments || []).map(p => {
        // payment_type === 'debit' means a manual debit/purchase entry
        const isDebit = p.payment_type === 'debit'
        return {
          id: p.id,
          date: p.created_at,
          type: isDebit ? 'debit' : (p.payment_type === 'return' ? 'return' : 'payment'),
          bill_number: isDebit ? (p.bill_number || '') : '',
          amount: p.amount || 0,
          note: p.note || '',
        }
      })
    ]
    combined.sort((a, b) => new Date(a.date) - new Date(b.date))
    let running = 0
    return combined.map(item => {
      if (item.type === 'purchase' || item.type === 'debit') {
        running += Number(item.amount)
      } else {
        running -= Math.abs(Number(item.amount))
      }
      return { ...item, balance: running }
    }).reverse()
  }

  const openTxModal = async (sup) => {
    setTxSup(sup)
    setTxLedger([])
    setShowAddTx(false)
    setShowTxModal(true)
    setTxLoading(true)
    try {
      if (!navigator.onLine) throw new Error('Offline')
      const [purchRes, payRes] = await Promise.all([
        supabase.from('purchases').select('*').eq('supplier_id', sup.id).order('created_at', { ascending: true }),
        supabase.from('supplier_payments').select('*').eq('supplier_id', sup.id)
      ])
      setTxLedger(buildLedger(purchRes.data || [], payRes.data || []))
    } catch {
      // Offline fallback
      const [lPurchases, lPayments] = await Promise.all([
        db.purchases.where('supplier_id').equals(sup.id).toArray(),
        db.supplier_payments.where('supplier_id').equals(sup.id).toArray()
      ])
      setTxLedger(buildLedger(lPurchases, lPayments))
    } finally {
      setTxLoading(false)
    }
  }

  const handleAddTx = async (e) => {
    e.preventDefault()
    if (!txForm.amount || parseFloat(txForm.amount) <= 0) return
    setTxSaving(true)
    const amount = parseFloat(txForm.amount)
    const isDebit = txForm.type === 'debit'
    const txDate = new Date(txForm.date).toISOString()
    const noteText = [txForm.bill_number ? `[Bill #${txForm.bill_number}]` : '', txForm.note].filter(Boolean).join(' ')

    const payload = {
      shop_id: user.shop_id,
      supplier_id: txSup.id,
      amount,
      payment_type: isDebit ? 'debit' : 'payment',
      bill_number: txForm.bill_number || null,
      note: noteText || (isDebit ? 'Manual Purchase Entry' : 'Manual Payment Entry'),
      created_at: txDate
    }
    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')
      const { error } = await supabase.from('supplier_payments').insert([payload])
      if (error) throw error

      // Update supplier outstanding_balance as an atomic change
      const delta = isDebit ? amount : -amount
      const newBal = (Number(txSup.outstanding_balance) || 0) + delta
      const r = await adjustSupplierBalance(txSup.id, delta)
      if (!r.ok) alert('Entry saved, but supplier balance update failed: ' + (r.error?.message || 'unknown error'))
      setTxSup({ ...txSup, outstanding_balance: newBal })
      setSuppliers(prev => prev.map(s => s.id === txSup.id ? { ...s, outstanding_balance: newBal } : s))

      setTxForm({ date: new Date().toISOString().slice(0, 10), bill_number: '', type: 'debit', amount: '', note: '' })
      setShowAddTx(false)
      await openTxModal({ ...txSup, outstanding_balance: newBal })
    } catch (err) {
      const msg = err?.message || String(err)
      if (msg.includes('Failed to fetch') || !navigator.onLine) {
        const offlinePayload = { ...payload, id: crypto.randomUUID() }
        await db.supplier_payments.add(offlinePayload)
        await addToSyncQueue('supplier_payments', 'INSERT', offlinePayload)
        const delta = isDebit ? amount : -amount
        const newBal = (Number(txSup.outstanding_balance) || 0) + delta
        await adjustSupplierBalance(txSup.id, delta) // queued (previously never synced)
        setTxSup({ ...txSup, outstanding_balance: newBal })
        setSuppliers(prev => prev.map(s => s.id === txSup.id ? { ...s, outstanding_balance: newBal } : s))
        setTxForm({ date: new Date().toISOString().slice(0, 10), bill_number: '', type: 'debit', amount: '', note: '' })
        setShowAddTx(false)
        await openTxModal({ ...txSup, outstanding_balance: newBal })
        alert('Offline: Locally saved, will sync when online.')
      } else {
        alert('Error: ' + msg)
      }
    } finally {
      setTxSaving(false)
    }
  }

  // ─── Export transactions to Excel ────────────────────────────────────────
  const exportTxExcel = () => {
    if (!txSup || txLedger.length === 0) return
    const rows = [...txLedger].reverse().map(item => ({
      'Date': new Date(item.date).toLocaleDateString('en-PK'),
      'Bill Number': item.bill_number || '',
      'Type': (item.type === 'purchase' || item.type === 'debit') ? 'Debit' : 'Credit',
      'Amount (Rs.)': Number(item.amount),
      'Description': item.note || '',
      'Balance (Rs.)': Number(item.balance)
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    // Column widths
    ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 30 }, { wch: 14 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions')
    XLSX.writeFile(wb, `${txSup.name.replace(/\s+/g, '_')}_Transactions_${new Date().toLocaleDateString('en-PK').replace(/\//g, '-')}.xlsx`)
  }

  // ─── Import transactions from Excel ──────────────────────────────────────
  const importTxExcel = async (e) => {
    const file = e.target.files[0]
    if (!file || !txSup) return
    e.target.value = ''

    const reader = new FileReader()
    reader.onload = async (evt) => {
      try {
        const wb = XLSX.read(evt.target.result, { type: 'binary' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(ws)

        if (rows.length === 0) { alert('File khali hai!'); return }

        // Validate columns
        const sample = rows[0]
        if (!('Amount (Rs.)' in sample) && !('Amount' in sample)) {
          alert('Column "Amount (Rs.)" nahi mili. Sahi format use karein:\nDate | Bill Number | Type | Amount (Rs.) | Description')
          return
        }

        const preview = rows.slice(0, 3).map(r =>
          `${r['Date'] || ''} | Bill#${r['Bill Number'] || '-'} | ${r['Type'] || 'Debit'} | Rs.${r['Amount (Rs.)'] || r['Amount'] || 0}`
        ).join('\n')

        if (!confirm(`${rows.length} transactions import karein?\n\nPehli entries:\n${preview}`)) return

        setTxImporting(true)

        const payloads = rows.map(r => {
          const typeRaw = String(r['Type'] || 'debit').toLowerCase()
          const isDebit = typeRaw.includes('debit') || typeRaw.includes('purchase')
          const dateStr = r['Date'] ? new Date(r['Date']).toISOString() : new Date().toISOString()
          const amount = parseFloat(r['Amount (Rs.)'] || r['Amount'] || 0)
          const billNo = String(r['Bill Number'] || r['Bill #'] || r['Bill No'] || '').trim()
          const note = String(r['Description'] || r['Note'] || '').trim()
          return {
            shop_id: user.shop_id,
            supplier_id: txSup.id,
            amount,
            payment_type: isDebit ? 'debit' : 'payment',
            bill_number: billNo || null,
            note: note || (isDebit ? 'Imported Debit Entry' : 'Imported Payment'),
            created_at: dateStr
          }
        }).filter(p => p.amount > 0)

        // Batch insert (50 at a time)
        let inserted = 0
        for (let i = 0; i < payloads.length; i += 50) {
          const batch = payloads.slice(i, i + 50)
          if (navigator.onLine) {
            const { error } = await supabase.from('supplier_payments').insert(batch)
            if (error) throw error
          } else {
            for (const p of batch) {
              const op = { ...p, id: crypto.randomUUID() }
              await db.supplier_payments.add(op)
              await addToSyncQueue('supplier_payments', 'INSERT', op)
            }
          }
          inserted += batch.length
        }

        // Recalculate balance from all transactions (re-fetch ledger)
        await openTxModal(txSup)
        alert(`✅ ${inserted} transactions import ho gayi!${!navigator.onLine ? '\n(Offline: sync hogi jab online hon)' : ''}`)
      } catch (err) {
        alert('Import error: ' + (err.message || err))
      } finally {
        setTxImporting(false)
      }
    }
    reader.readAsBinaryString(file)
  }

  // ─── Download blank import template ──────────────────────────────────────
  const downloadTxTemplate = () => {
    const sample = [
      { 'Date': '01/01/2025', 'Bill Number': '1001', 'Type': 'Debit', 'Amount (Rs.)': 50000, 'Description': 'Purchase of goods' },
      { 'Date': '15/01/2025', 'Bill Number': '',     'Type': 'Credit', 'Amount (Rs.)': 20000, 'Description': 'Cash payment' },
    ]
    const ws = XLSX.utils.json_to_sheet(sample)
    ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 30 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions')
    XLSX.writeFile(wb, 'Supplier_Transactions_Template.xlsx')
  }

  const fetchBrands = async () => {
    try {
      if (!navigator.onLine) throw new Error('Offline')
      const { data, error } = await supabase
        .from('brands')
        .select('*')
        .eq('shop_id', user.shop_id)
        .order('name')
      if (error) throw error
      if (data) {
        await db.brands.bulkPut(JSON.parse(JSON.stringify(data))).catch(() => {})
        setBrands(data)
      }
    } catch (e) {
      try {
        const localBrands = await db.brands.toArray()
        const sid = String(user.shop_id)
        setBrands(localBrands.filter(x => String(x.shop_id) === sid).sort((a, b) => a.name.localeCompare(b.name)))
      } catch { setBrands([]) }
    }
  }

  const fetchSuppliers = async () => {
    if (!user?.shop_id) {
      setLoading(false)
      console.error('Suppliers: Missing user.shop_id!')
      return
    }

    const sid = String(user.shop_id)

    // ── Step 1: Show local IndexedDB data IMMEDIATELY (instant UI) ────────────
    try {
      const localData = await db.suppliers.toArray()
      const filtered = localData.filter(x => String(x.shop_id) === sid)
      const sorted = filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      setSuppliers(sorted)
      if (sorted.length > 0) {
        setLoading(false)
      }
    } catch (localErr) {
      console.warn('Suppliers: Local DB read failed:', localErr)
    }

    // ── Step 2: Background refresh from Supabase (updates UI silently) ────────
    if (!navigator.onLine) {
      setLoading(false)
      return
    }

    try {
      const fetchPromise = supabase
        .from('suppliers')
        .select('*')
        .eq('shop_id', user.shop_id)
        .order('created_at', { ascending: false })

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000))
      const { data, error } = await Promise.race([fetchPromise, timeoutPromise])

      if (error) throw error
      if (data) {
        const cleanData = JSON.parse(JSON.stringify(data))
        await db.suppliers.bulkPut(cleanData)
      }

      const localData = await db.suppliers.toArray()
      const filtered = localData.filter(x => String(x.shop_id) === sid)
      const sorted = filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      setSuppliers(sorted)
    } catch (e) {
      console.warn('Suppliers: Supabase background refresh failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const handleExport = () => {
    const exportData = suppliers.map(s => ({
      'Name': s.name,
      'Phone': s.phone || '-',
      'Address': s.address || '-',
      'Outstanding Balance': s.outstanding_balance || 0
    }))

    const ws = XLSX.utils.json_to_sheet(exportData)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Suppliers')
    XLSX.writeFile(wb, `Suppliers_Export_${new Date().toLocaleDateString()}.xlsx`)
  }

  const handleImport = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (evt) => {
      const bstr = evt.target.result
      const wb = XLSX.read(bstr, { type: 'binary' })
      const wsname = wb.SheetNames[0]
      const ws = wb.Sheets[wsname]
      const data = XLSX.utils.sheet_to_json(ws)

      if (data.length === 0) {
        alert('Empty file!')
        return
      }

      if (!confirm(`Import ${data.length} suppliers ? `)) return

      setLoading(true)
      const formatted = data.map(row => ({
        shop_id: user.shop_id,
        name: row['Name'] || row['name'] || 'New Supplier',
        phone: row['Phone'] || row['phone'] || '',
        address: row['Address'] || row['address'] || '',
        outstanding_balance: parseFloat(row['Outstanding Balance'] || row['balance'] || 0)
      }))

      const { error } = await supabase.from('suppliers').insert(formatted)
      if (error) alert(error.message)
      else {
        alert('Suppliers imported successfully! ✅')
        fetchSuppliers()
      }
      setLoading(false)
    }
    reader.readAsBinaryString(file)
  }

  const handleEdit = (sup) => {
    setForm({
      name: sup.name,
      phone: sup.phone || '',
      address: sup.address || '',
      brand: sup.brand || '',
      product_type: sup.product_type || '',
      other_details: sup.other_details || ''
    })
    setEditingId(sup.id)
    setShowForm(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    const payload = { ...form, shop_id: user.shop_id }

    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')

      if (editingId) {
        const { error } = await supabase.from('suppliers').update(payload).eq('id', editingId)
        if (error) throw error
      } else {
        const { error } = await supabase.from('suppliers').insert([payload])
        if (error) {
          throw new Error(error.message + '\nNote: Verify if brand, product_type, and other_details columns exist in your suppliers table.')
        }
      }
      setEditingId(null)
      setForm({ name: '', phone: '', address: '', brand: '', product_type: '', other_details: '' })
      setShowForm(false)
      fetchSuppliers()
    } catch (error) {
      const errMsg = error?.message || String(error)
      if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
        const offlineData = editingId ? { ...payload, id: editingId } : { ...payload, id: crypto.randomUUID(), created_at: new Date().toISOString() }
        const action = editingId ? 'UPDATE' : 'INSERT'
        await addToSyncQueue('suppliers', action, offlineData)

        if (editingId) {
          await db.suppliers.update(editingId, offlineData)
        } else {
          await db.suppliers.add(offlineData)
        }

        setEditingId(null)
        setForm({ name: '', phone: '', address: '', brand: '', product_type: '', other_details: '' })
        setShowForm(false)
        fetchSuppliers()
        alert('Offline mode: Saved locally. Will sync automatically when online. 🔄')
      } else {
        alert('Error: ' + errMsg)
      }
    } finally {
      setSaving(false)
    }
  }

  const requestDelete = (ids) => {
    setPendingDeleteIds(ids)
    setWipeLedger(false)
    setShowPasswordModal(true)
  }

  const executeDelete = async () => {
    setShowPasswordModal(false)
    const ids = pendingDeleteIds
    setPendingDeleteIds([])
    const isWipe = wipeLedger

    let successCount = 0
    let failCount = 0
    const successfulIds = []

    for (const id of ids) {
      const item = suppliers.find(s => s.id === id)
      if (!item) continue

      try {
        if (isWipe) {
          // Deep clean — clear all records linked to this supplier
          const localPurchases = await db.purchases.where({ supplier_id: id }).toArray()
          const purchaseIds = localPurchases.map(p => p.id)

          if (navigator.onLine) {
            const { data: onlinePurchases } = await supabase.from('purchases').select('id').eq('supplier_id', id)
            const onlineIds = onlinePurchases?.map(p => p.id) || []
            const allPurchaseIds = [...new Set([...purchaseIds, ...onlineIds])]

            if (allPurchaseIds.length > 0) {
              await must(supabase.from('purchase_items').delete().in('purchase_id', allPurchaseIds))
            }
            await must(supabase.from('purchases').delete().eq('supplier_id', id))
            await must(supabase.from('supplier_payments').delete().eq('supplier_id', id))
            // Unlink products — set supplier_id = null (products themselves stay)
            await must(supabase.from('products').update({ supplier_id: null }).eq('supplier_id', id))
          } else {
            for (const pId of purchaseIds) {
              const items = await db.purchase_items.where({ purchase_id: pId }).toArray()
              for (const it of items) await addToSyncQueue('purchase_items', 'DELETE', { id: it.id })
              await addToSyncQueue('purchases', 'DELETE', { id: pId })
            }
            const localPay = await db.supplier_payments.where({ supplier_id: id }).toArray()
            for (const pay of localPay) await addToSyncQueue('supplier_payments', 'DELETE', { id: pay.id })
          }

          if (purchaseIds.length > 0) await db.purchase_items.where('purchase_id').anyOf(purchaseIds).delete()
          await db.purchases.where({ supplier_id: id }).delete()
          await db.supplier_payments.where({ supplier_id: id }).delete()
          // Unlink locally stored products
          const linkedProds = await db.products.where({ supplier_id: id }).toArray()
          for (const p of linkedProds) await db.products.update(p.id, { supplier_id: null })
        }

        if (navigator.onLine) {
          const { error } = await supabase.from('suppliers').delete().eq('id', id)
          if (error) {
            console.error('Delete failed:', error)
            failCount++
            continue
          }
        } else {
          await addToSyncQueue('suppliers', 'DELETE', { id })
        }

        await moveToTrash('suppliers', id, item, user.id, user.shop_id)
        await db.suppliers.delete(id)
        successfulIds.push(id)
        successCount++
      } catch (err) {
        console.error('Delete error:', err)
        failCount++
      }
    }

    setSuppliers(prev => prev.filter(s => !successfulIds.includes(s.id)))
    setSelected([])

    if (failCount > 0) {
      alert(`⚠️ Partially completed.\n✅ Deleted: ${successCount}\n❌ Failed: ${failCount}\n\n👉 Yeh suppliers ke purchase records abhi bhi database mein hain.\n\nSahi order:\n1. Purchase Items delete karein (Trash Bin)\n2. Purchases delete karein\n3. Phir yeh suppliers delete ho jayenge`)
    } else if (successCount > 0) {
      alert(`🗑️ ${successCount} supplier(s) moved to Trash!`)
    }
    fetchSuppliers()
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingId(null)
    setForm({ name: '', phone: '', address: '', brand: '', product_type: '', other_details: '' })
  }

  const toggleSelect = (id) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const toggleSelectAll = () => {
    if (selected.length === suppliers.length) {
      setSelected([])
    } else {
      setSelected(suppliers.map(x => x.id))
    }
  }

  if (!hasFeature('suppliers')) return <UpgradeWall feature="suppliers" />

  return (
    <div>
      {/* ── Summary Cards ── */}
      {suppliers.length > 0 && (() => {
        const totalDue = suppliers.reduce((s, x) => s + (Number(x.outstanding_balance) || 0), 0)
        const suppliersWithDue = suppliers.filter(x => (Number(x.outstanding_balance) || 0) > 0).length
        const cleared = suppliers.length - suppliersWithDue
        return (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <div className="bg-surface rounded-xl shadow p-4 border-l-4 border-danger">
              <p className="text-xs text-fg-muted uppercase font-semibold tracking-wide">Total Amount Due</p>
              <p className="text-2xl font-bold text-danger-fg mt-1">Rs. {totalDue.toLocaleString()}</p>
              <p className="text-xs text-fg-subtle mt-1">Across all suppliers</p>
            </div>
            <div className="bg-surface rounded-xl shadow p-4 border-l-4 border-warning">
              <p className="text-xs text-fg-muted uppercase font-semibold tracking-wide">Suppliers with Balance</p>
              <p className="text-2xl font-bold text-warning-fg mt-1">{suppliersWithDue}</p>
              <p className="text-xs text-fg-subtle mt-1">Have outstanding amount</p>
            </div>
            <div className="bg-surface rounded-xl shadow p-4 border-l-4 border-success">
              <p className="text-xs text-fg-muted uppercase font-semibold tracking-wide">Cleared / No Balance</p>
              <p className="text-2xl font-bold text-success-fg mt-1">{cleared}</p>
              <p className="text-xs text-fg-subtle mt-1">Out of {suppliers.length} total</p>
            </div>
          </div>
        )
      })()}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <h1 className="text-2xl font-bold text-fg">🚚 Suppliers</h1>
        <div className="flex gap-2 w-full sm:w-auto flex-wrap">
          {selected.length > 0 && (
            <button
              onClick={() => requestDelete(selected)}
              className="px-4 py-2 bg-danger hover:bg-danger-hover text-white rounded-lg transition font-bold text-sm"
            >
              🗑️ Delete Selected ({selected.length})
            </button>
          )}
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition">
            {showForm ? 'Cancel' : '+ Add Supplier / Dealer'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="bg-surface rounded-xl shadow p-6 mb-6 max-w-lg">
          <h2 className="font-semibold text-fg-2 mb-4">
            {editingId ? 'Edit Supplier / Dealer' : 'New Supplier / Dealer'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-fg-2 font-medium mb-1">Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="e.g. Metro Wholesale / National Distributors / Dealer Name"
              />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1">Phone</label>
              <input
                type="text"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="03001234567"
              />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1">Address</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="City, Pakistan"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-fg-2 font-medium mb-1">Brand (Dealer of)</label>
                <select
                  value={form.brand}
                  onChange={(e) => setForm({ ...form, brand: e.target.value })}
                  className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
                >
                  <option value="">— Select Brand —</option>
                  {brands.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                  <option value="multi">Multiple Brands</option>
                </select>
              </div>
              <div>
                <label className="block text-fg-2 font-medium mb-1">Product Type / Category</label>
                <input
                  type="text"
                  value={form.product_type}
                  onChange={(e) => setForm({ ...form, product_type: e.target.value })}
                  className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="e.g. FMCG Goods, Garments, Hardware, Electronics"
                />
              </div>
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1">Other Details</label>
              <input
                type="text"
                value={form.other_details}
                onChange={(e) => setForm({ ...form, other_details: e.target.value })}
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Alternative numbers, specific notes..."
              />
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={saving}
                className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition disabled:opacity-50">
                {saving ? 'Saving...' : editingId ? 'Update Supplier' : 'Save Supplier'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="px-6 py-2 bg-surface-4 hover:bg-surface-5 text-fg-2 rounded-lg transition">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <p className="text-fg-muted">Loading...</p>
      ) : suppliers.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-fg-subtle text-lg">No suppliers yet</p>
        </div>
      ) : (
        <div className="bg-surface rounded-xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-2 border-b">
                <tr>
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={selected.length === suppliers.length && suppliers.length > 0}
                      onChange={toggleSelectAll}
                      className="w-4 h-4 rounded"
                    />
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Name</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Contact</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Brand / Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Balance</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {suppliers.map((sup) => (
                  <tr key={sup.id} className={`hover:bg-surface-2 ${selected.includes(sup.id) ? 'bg-primary-soft' : ''}`}>
                    <td className="px-4 py-4">
                      <input
                        type="checkbox"
                        checked={selected.includes(sup.id)}
                        onChange={() => toggleSelect(sup.id)}
                        className="w-4 h-4 rounded"
                      />
                    </td>
                    <td className="px-6 py-4 font-medium text-fg whitespace-nowrap">{sup.name}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-fg text-sm font-bold">{sup.phone || '-'}</p>
                      <p className="text-fg-subtle text-xs">{sup.address || '-'}</p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-primary-fg text-xs font-black uppercase tracking-tighter">{sup.brand || 'No Brand'}</p>
                      <p className="text-fg-muted text-xs">{sup.product_type || 'General'}</p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`font-medium ${sup.outstanding_balance > 0 ? 'text-danger-fg' : 'text-success-fg'}`}>
                        Rs. {sup.outstanding_balance || 0}
                      </span>
                    </td>
                    <td className="px-6 py-4 flex gap-2 whitespace-nowrap flex-wrap">
                      <button
                        onClick={() => openTxModal(sup)}
                        className="text-info-fg hover:text-info-strong text-sm font-bold bg-info-soft px-2 py-1 rounded">
                        📋 Txns
                      </button>
                      <Link to={`/suppliers/${sup.id}`} className="text-primary-fg hover:text-primary-strong text-sm font-bold bg-primary-soft px-2 py-1 rounded">
                        Ledger
                      </Link>
                      <button
                        onClick={() => handleEdit(sup)}
                        className="text-primary-fg hover:text-primary-strong text-sm font-medium">
                        Edit
                      </button>
                      <button
                        onClick={() => requestDelete([sup.id])}
                        className="text-danger-fg hover:text-danger-strong text-sm font-medium">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showPasswordModal && (
        <PasswordModal
          title="Delete Supplier(s)"
          message={`${pendingDeleteIds.length} item(s) will be moved to Trash`}
          onConfirm={executeDelete}
          onCancel={() => { setShowPasswordModal(false); setPendingDeleteIds([]) }}
          checkboxLabel="Wipe all ledger history (purchases, payments) forever?"
          checkboxChecked={wipeLedger}
          onCheckboxChange={setWipeLedger}
        />
      )}

      {/* ── Supplier Transaction Modal ── */}
      {showTxModal && txSup && (
        <div className="fixed inset-0 bg-black/50 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-4xl max-h-[95vh] flex flex-col">

            {/* Header */}
            <div className="flex items-start justify-between p-5 border-b">
              <div>
                <h2 className="text-xl font-bold text-fg">📋 {txSup.name} — Transactions</h2>
                <p className="text-sm text-fg-muted mt-0.5">{txSup.phone || ''} {txSup.address ? '| ' + txSup.address : ''}</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="text-xs text-fg-subtle uppercase font-semibold">Outstanding</p>
                  <p className={`text-xl font-bold ${txSup.outstanding_balance > 0 ? 'text-danger-fg' : 'text-success-fg'}`}>
                    Rs. {(txSup.outstanding_balance || 0).toLocaleString()}
                  </p>
                </div>
                <button onClick={() => setShowTxModal(false)}
                  className="text-fg-subtle hover:text-fg-3 text-2xl font-light leading-none">✕</button>
              </div>
            </div>

            {/* Add Transaction Toggle + Import/Export */}
            <div className="px-5 pt-4 pb-2 flex flex-wrap justify-between items-center gap-2">
              <p className="text-sm text-fg-muted font-medium">Transaction History</p>
              <div className="flex flex-wrap gap-2">
                {/* Export */}
                <button onClick={exportTxExcel} disabled={txLedger.length === 0}
                  title="Export transactions to Excel"
                  className="px-3 py-1.5 bg-success hover:bg-success-hover text-white rounded-lg text-sm font-bold transition disabled:opacity-40">
                  📥 Export Excel
                </button>
                {/* Import */}
                <button onClick={() => txFileRef.current?.click()} disabled={txImporting}
                  title="Import transactions from Excel"
                  className="px-3 py-1.5 bg-warning hover:bg-warning-hover text-white rounded-lg text-sm font-bold transition disabled:opacity-40">
                  {txImporting ? '⏳ Importing...' : '📤 Import Excel'}
                </button>
                <input ref={txFileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={importTxExcel} />
                {/* Template download */}
                <button onClick={downloadTxTemplate}
                  title="Download blank import template"
                  className="px-3 py-1.5 bg-surface-3 hover:bg-surface-4 text-fg-3 rounded-lg text-sm font-semibold transition">
                  📋 Template
                </button>
                {/* Add manually */}
                <button
                  onClick={() => setShowAddTx(!showAddTx)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-bold transition ${showAddTx ? 'bg-surface-4 text-fg-2' : 'bg-info text-white hover:bg-info-hover'}`}>
                  {showAddTx ? '✕ Cancel' : '+ Add Entry'}
                </button>
              </div>
            </div>

            {/* Add Transaction Form */}
            {showAddTx && (
              <div className="mx-5 mb-3 p-4 bg-info-soft rounded-xl border border-info-muted">
                <form onSubmit={handleAddTx} className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-fg-3 mb-1">Date *</label>
                      <input type="date" required
                        value={txForm.date}
                        onChange={e => setTxForm({ ...txForm, date: e.target.value })}
                        className="w-full px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-info" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-fg-3 mb-1">Bill Number</label>
                      <input type="text"
                        value={txForm.bill_number}
                        onChange={e => setTxForm({ ...txForm, bill_number: e.target.value })}
                        placeholder="e.g. 1045"
                        className="w-full px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-info" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-fg-3 mb-1">Type *</label>
                      <select value={txForm.type}
                        onChange={e => setTxForm({ ...txForm, type: e.target.value })}
                        className="w-full px-3 py-2 border border-line-strong rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-info">
                        <option value="debit">🔴 Debit (Purchase / We Owe)</option>
                        <option value="payment">🟢 Credit (Payment / We Paid)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-fg-3 mb-1">Amount (Rs.) *</label>
                      <input type="number" min="1" step="any" required
                        value={txForm.amount}
                        onChange={e => setTxForm({ ...txForm, amount: e.target.value })}
                        placeholder="0"
                        className="w-full px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-info" />
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <input type="text"
                      value={txForm.note}
                      onChange={e => setTxForm({ ...txForm, note: e.target.value })}
                      placeholder="Description / Note (optional)"
                      className="flex-1 px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-info" />
                    <button type="submit" disabled={txSaving}
                      className="px-6 py-2 bg-info hover:bg-info-hover text-white rounded-lg text-sm font-bold transition disabled:opacity-50">
                      {txSaving ? '...' : '✓ Save'}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Ledger Table */}
            <div className="flex-1 overflow-auto px-5 pb-5">
              {txLoading ? (
                <div className="py-10 text-center text-fg-subtle">Loading transactions...</div>
              ) : txLedger.length === 0 ? (
                <div className="py-10 text-center text-fg-subtle">No transactions found for this supplier.</div>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 bg-surface-2 z-10">
                    <tr className="border-b">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-fg-muted uppercase whitespace-nowrap">Date</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-fg-muted uppercase whitespace-nowrap">Bill #</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-fg-muted uppercase">Description</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-warning-fg uppercase whitespace-nowrap">Debit</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-success-fg uppercase whitespace-nowrap">Credit</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-fg-muted uppercase whitespace-nowrap">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-subtle">
                    {txLedger.map((item, idx) => {
                      const isDebitRow = item.type === 'purchase' || item.type === 'debit'
                      return (
                        <tr key={item.id || idx} className="hover:bg-surface-2">
                          <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                            {new Date(item.date).toLocaleDateString('en-PK')}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            {item.bill_number
                              ? <span className="bg-surface-3 text-fg-2 px-2 py-0.5 rounded text-xs font-mono font-bold">{item.bill_number}</span>
                              : <span className="text-fg-faint">—</span>}
                          </td>
                          <td className="px-4 py-3 text-fg-2">
                            <span>{item.note || (isDebitRow ? 'Purchase' : 'Payment')}</span>
                            {item.type === 'return' && <span className="ml-2 text-[10px] bg-danger-muted text-danger-strong px-1.5 py-0.5 rounded-full font-bold uppercase">Return</span>}
                            {item.type === 'debit' && <span className="ml-2 text-[10px] bg-warning-muted text-warning-strong px-1.5 py-0.5 rounded-full font-bold uppercase">Manual</span>}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-warning-fg whitespace-nowrap">
                            {isDebitRow ? `Rs. ${Number(item.amount).toLocaleString()}` : ''}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-success-fg whitespace-nowrap">
                            {!isDebitRow ? `Rs. ${Math.abs(Number(item.amount)).toLocaleString()}` : ''}
                          </td>
                          <td className="px-4 py-3 text-right font-bold whitespace-nowrap">
                            <span className={item.balance > 0 ? 'text-danger-fg' : 'text-success-fg'}>
                              Rs. {Number(item.balance).toLocaleString()}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="bg-surface-2 border-t-2 border-line">
                    <tr>
                      <td colSpan="3" className="px-4 py-3 text-sm font-bold text-fg-2">Total Outstanding Balance</td>
                      <td colSpan="3" className="px-4 py-3 text-right">
                        <span className={`text-base font-bold ${txSup.outstanding_balance > 0 ? 'text-danger-fg' : 'text-success-fg'}`}>
                          Rs. {(txSup.outstanding_balance || 0).toLocaleString()}
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Suppliers