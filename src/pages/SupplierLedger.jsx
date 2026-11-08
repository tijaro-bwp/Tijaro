import React, { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { db } from '../services/db'
import { adjustSupplierBalance, adjustStock, must } from '../services/integrity'
import { hasFeature } from '../utils/featureGate'
import UpgradeWall from '../components/UpgradeWall'

function SupplierLedger() {
    const { id } = useParams()
    const { user } = useAuth()
    const navigate = useNavigate()
    const importRef = useRef()

    const [supplier, setSupplier] = useState(null)
    const [loading, setLoading] = useState(true)
    const [ledger, setLedger] = useState([])
    const [showModal, setShowModal] = useState(false)
    const [saving, setSaving] = useState(false)
    const [expandedBill, setExpandedBill] = useState(null)
    const [selectedIds, setSelectedIds] = useState(new Set())

    // Filters
    const [search, setSearch] = useState('')
    const [filterType, setFilterType] = useState('all')   // all | debit | payment | purchase | return
    const [filterFrom, setFilterFrom] = useState('')
    const [filterTo, setFilterTo] = useState('')

    // Transaction entry form
    const [txForm, setTxForm] = useState({
        bill_number: '',
        date: new Date().toISOString().slice(0, 10),
        purchase_amount: '',
        paid_amount: '',
        details: '',
        payment_mode: 'cash',
        transaction_ref: '',
        note: ''
    })

    useEffect(() => {
        if (id && user?.shop_id) fetchSupplierData()
    }, [id, user?.shop_id])

    const fetchSupplierData = async () => {
        setLoading(true)
        try {
            if (!navigator.onLine) throw new Error('Offline')

            const fetchPromise = Promise.all([
                supabase.from('suppliers').select('*').eq('id', id).maybeSingle(),
                supabase.from('purchases').select('*, purchase_items(*)').eq('supplier_id', id).order('created_at', { ascending: true }),
                supabase.from('supplier_payments').select('*').eq('supplier_id', id)
            ])
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            const [supRes, purchasesRes, paymentsRes] = await Promise.race([fetchPromise, timeoutPromise])

            setSupplier(supRes.data)
            buildLedger(purchasesRes.data || [], paymentsRes.data || [])
        } catch (e) {
            console.log('SupplierLedger: Reconstructing from local DB (Offline)')
            try {
                const [lSups, lPurchases, lItems, lPayments] = await Promise.all([
                    db.suppliers.toArray(),
                    db.purchases.toArray(),
                    db.purchase_items.toArray(),
                    db.supplier_payments.toArray()
                ])
                const sup = lSups.find(s => String(s.id) === String(id))
                if (sup) setSupplier(sup)
                const myPurchases = lPurchases.filter(p => String(p.supplier_id) === String(id))
                const myPayments = lPayments.filter(p => String(p.supplier_id) === String(id))
                buildLedger(
                    myPurchases.map(p => ({ ...p, purchase_items: lItems.filter(i => i.purchase_id === p.id) })),
                    myPayments
                )
            } catch (err) { console.error('SupplierLedger Fallback Error:', err) }
        } finally { setLoading(false) }
    }

    const buildLedger = (purchases, payments) => {
        const combined = [
            ...purchases.map(p => ({
                id: p.id,
                date: p.created_at,
                type: 'purchase',
                payment_type: p.payment_type,
                bill_number: '',
                amount: p.total_amount,
                note: `Bill #${String(p.id).slice(-8)}`,
                items: p.purchase_items || []
            })),
            ...payments.map(p => ({
                id: p.id,
                date: p.created_at,
                type: p.payment_type === 'debit' ? 'debit' : p.payment_type === 'return' ? 'return' : 'payment',
                payment_type: p.payment_type,
                bill_number: p.bill_number || '',
                amount: p.amount,
                note: p.note || (p.payment_type === 'debit' ? 'Manual Purchase Entry' : 'Cash Payment'),
                details: p.details || null,
                payment_mode: p.payment_mode || null,
                transaction_ref: p.transaction_ref || null,
                items: []
            }))
        ]
        combined.sort((a, b) => new Date(a.date) - new Date(b.date))

        let running = 0
        const withBalance = combined.map(item => {
            if (item.type === 'purchase' || item.type === 'debit') running += Number(item.amount)
            else running -= Math.abs(Number(item.amount))
            return { ...item, balance: running }
        })
        setLedger(withBalance.reverse())
    }

    // ── Computed preview for transaction entry ──────────────────────────────────
    const prevBalance = ledger.length > 0 ? ledger[0].balance : (supplier?.outstanding_balance || 0)
    const purchaseAmt = parseFloat(txForm.purchase_amount) || 0
    const paidAmt = parseFloat(txForm.paid_amount) || 0
    const newBalance = prevBalance + purchaseAmt - paidAmt

    // ── Submit transaction ──────────────────────────────────────────────────────
    const handleSubmitTransaction = async (e) => {
        e.preventDefault()
        if (purchaseAmt === 0 && paidAmt === 0) {
            alert('Purchase amount ya paid amount mein se koi ek lazmi hai.')
            return
        }

        setSaving(true)
        const now = txForm.date ? new Date(txForm.date + 'T12:00:00').toISOString() : new Date().toISOString()

        try {
            if (!navigator.onLine) throw new TypeError('Failed to fetch')

            const insertRows = []

            const commonFields = {
                shop_id: user.shop_id,
                supplier_id: id,
                bill_number: txForm.bill_number.trim() || null,
                details: txForm.details.trim() || null,
                payment_mode: txForm.payment_mode || null,
                transaction_ref: txForm.transaction_ref.trim() || null,
                created_at: now
            }

            // Debit row (purchase)
            if (purchaseAmt > 0) {
                insertRows.push({ ...commonFields, amount: purchaseAmt, payment_type: 'debit', note: txForm.note.trim() || 'Purchase Entry' })
            }

            // Credit row (payment)
            if (paidAmt > 0) {
                insertRows.push({ ...commonFields, amount: paidAmt, payment_type: 'payment', note: txForm.note.trim() || 'Payment to Supplier' })
            }

            const { error: pErr } = await supabase.from('supplier_payments').insert(insertRows)
            if (pErr) throw pErr

            // Atomic change in the database (never overwrite with a total computed from stale data)
            const r = await adjustSupplierBalance(id, purchaseAmt - paidAmt)
            if (!r.ok) alert('Entries saved, but supplier balance update failed: ' + (r.error?.message || 'unknown error'))

            alert('Transaction save ho gaya! ✅')
            resetForm()
            fetchSupplierData()
        } catch (error) {
            const errMsg = error?.message || String(error)
            if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
                // Offline: save to local DB
                const offlineCommon = { shop_id: user.shop_id, supplier_id: id, bill_number: txForm.bill_number.trim() || null, details: txForm.details.trim() || null, payment_mode: txForm.payment_mode || null, transaction_ref: txForm.transaction_ref.trim() || null, created_at: now }
                if (purchaseAmt > 0) {
                    const rec = { ...offlineCommon, id: crypto.randomUUID(), amount: purchaseAmt, payment_type: 'debit', note: txForm.note.trim() || 'Purchase Entry' }
                    await db.supplier_payments.add(rec)
                    await db.sync_queue.add({ table: 'supplier_payments', action: 'INSERT', data: rec, timestamp: now })
                }
                if (paidAmt > 0) {
                    const rec = { ...offlineCommon, id: crypto.randomUUID(), amount: paidAmt, payment_type: 'payment', note: txForm.note.trim() || 'Payment to Supplier' }
                    await db.supplier_payments.add(rec)
                    await db.sync_queue.add({ table: 'supplier_payments', action: 'INSERT', data: rec, timestamp: now })
                }
                await adjustSupplierBalance(id, purchaseAmt - paidAmt) // queued as an atomic change
                setSupplier(s => ({ ...s, outstanding_balance: (Number(s.outstanding_balance) || 0) + purchaseAmt - paidAmt }))
                alert('Offline mode: Transaction locally save ho gaya. Online hone pr sync hoga! 🔄')
                resetForm()
                fetchSupplierData()
            } else {
                alert('Error: ' + errMsg)
            }
        } finally { setSaving(false) }
    }

    const resetForm = () => {
        setTxForm({ bill_number: '', date: new Date().toISOString().slice(0, 10), purchase_amount: '', paid_amount: '', details: '', payment_mode: 'cash', transaction_ref: '', note: '' })
        setShowModal(false)
    }

    // ── Delete Transaction ──────────────────────────────────────────────────────
    // Delete one supplier-ledger entry and undo its effect with atomic changes.
    // A purchase takes its (un-returned) stock back out; only a CREDIT purchase had
    // raised the supplier balance. Balances are not clamped at 0 (advance to supplier).
    const deleteSupplierEntry = async (item) => {
        const failed = []
        if (item.type === 'purchase') {
            const lineItems = item.items || []
            if (navigator.onLine) {
                const { error: itemsErr } = await supabase.from('purchase_items').delete().eq('purchase_id', item.id)
                if (itemsErr) throw itemsErr
                const { error } = await supabase.from('purchases').delete().eq('id', item.id)
                if (error) {
                    if (lineItems.length) await supabase.from('purchase_items').upsert(lineItems)
                    throw error
                }
            } else {
                const lItems = await db.purchase_items.toArray()
                const toDelIds = lItems.filter(i => String(i.purchase_id) === String(item.id)).map(i => i.id)
                if (toDelIds.length) await db.purchase_items.bulkDelete(toDelIds)
                await db.purchases.delete(item.id)
                for (const delId of toDelIds) {
                    await db.sync_queue.add({ table: 'purchase_items', action: 'DELETE', data: { id: delId }, timestamp: new Date().toISOString() })
                }
                await db.sync_queue.add({ table: 'purchases', action: 'DELETE', data: { id: item.id }, timestamp: new Date().toISOString() })
            }
            for (const it of lineItems) {
                const remaining = Number(it.quantity || 0) - Number(it.returned_qty || 0)
                if (remaining > 0 && it.product_id != null) {
                    const r = await adjustStock(it.product_id, -remaining)
                    if (!r.ok) failed.push(it.product_name || `product ${it.product_id}`)
                }
            }
            if (item.payment_type === 'credit') {
                const r = await adjustSupplierBalance(id, -Number(item.amount))
                if (!r.ok) failed.push('supplier balance')
            }
            return failed
        }

        // debit / payment / return — from supplier_payments table
        if (navigator.onLine) {
            const { error } = await supabase.from('supplier_payments').delete().eq('id', item.id)
            if (error) throw error
        } else {
            await db.supplier_payments.delete(item.id)
            await db.sync_queue.add({ table: 'supplier_payments', action: 'DELETE', data: { id: item.id }, timestamp: new Date().toISOString() })
        }
        const delta = (item.type === 'debit') ? -Number(item.amount) : +Math.abs(Number(item.amount))
        const r = await adjustSupplierBalance(id, delta)
        if (!r.ok) failed.push('supplier balance')
        return failed
    }

    const handleDeleteTransaction = async (item) => {
        const typeLabel = item.type === 'purchase' ? 'Purchase Order'
            : item.type === 'debit' ? 'Debit Entry'
            : item.type === 'payment' ? 'Payment'
            : 'Return'
        const confirmed = window.confirm(
            `Yeh transaction delete karein?\n\nType: ${typeLabel}\nAmount: Rs. ${Number(item.amount).toLocaleString()}\nNote: ${item.note}\n\nSupplier balance bhi adjust ho ga.`
        )
        if (!confirmed) return

        try {
            const failed = await deleteSupplierEntry(item)
            if (failed.length) alert(`Deleted, but these updates failed: ${failed.join(', ')}`)
            fetchSupplierData()
        } catch (err) {
            alert('Delete nahi hua: ' + err.message)
        }
    }

    // ── Excel Export ────────────────────────────────────────────────────────────
    const handleExport = () => {
        const rows = [...ledger].reverse().map((item, idx) => ({
            'Sr#': idx + 1,
            'Date': new Date(item.date).toLocaleDateString('en-PK'),
            'Bill #': item.bill_number || (item.type === 'purchase' ? String(item.id).slice(-8) : ''),
            'Description': item.note,
            'Type': item.type === 'purchase' || item.type === 'debit' ? 'Purchase/Debit' : item.type === 'payment' ? 'Payment' : 'Return',
            'Debit (Purchase)': (item.type === 'purchase' || item.type === 'debit') ? Number(item.amount) : '',
            'Credit (Payment)': (item.type !== 'purchase' && item.type !== 'debit') ? Math.abs(Number(item.amount)) : '',
            'Balance': Number(item.balance)
        }))
        const ws = XLSX.utils.json_to_sheet(rows)
        ws['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 14 }, { wch: 30 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 14 }]
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Ledger')
        const safeName = (supplier?.name || 'supplier').replace(/[^a-z0-9]/gi, '_')
        XLSX.writeFile(wb, `${safeName}_ledger.xlsx`)
    }

    // ── Excel Import ────────────────────────────────────────────────────────────
    const handleImport = async (e) => {
        const file = e.target.files[0]
        e.target.value = ''
        if (!file) return

        try {
            const data = await file.arrayBuffer()
            const wb = XLSX.read(data, { cellDates: true })
            const ws = wb.Sheets[wb.SheetNames[0]]
            const rows = XLSX.utils.sheet_to_json(ws, { raw: false, dateNF: 'yyyy-mm-dd' })

            if (!rows.length) { alert('File mein koi data nahi mila.'); return }

            const confirmed = window.confirm(`${rows.length} transactions import karein?`)
            if (!confirmed) return

            const insertRows = []
            let balanceDelta = 0

            for (const row of rows) {
                const debit = parseFloat(row['Debit (Purchase)'] ?? row['Debit'] ?? row['debit'] ?? 0) || 0
                const credit = parseFloat(row['Credit (Payment)'] ?? row['Credit'] ?? row['credit'] ?? 0) || 0
                const dateVal = row['Date'] || row['date'] || new Date().toLocaleDateString('en-PK')
                const billNo = String(row['Bill #'] ?? row['bill_number'] ?? '').trim() || null
                const note = String(row['Description'] ?? row['Note'] ?? row['note'] ?? '').trim()

                let parsedDate
                try {
                    if (dateVal instanceof Date && !isNaN(dateVal)) {
                        parsedDate = dateVal.toISOString()
                    } else if (typeof dateVal === 'number') {
                        // Excel serial number fallback (days since 1900-01-01)
                        const d = new Date(Math.round((dateVal - 25569) * 86400 * 1000))
                        parsedDate = d.toISOString()
                    } else {
                        parsedDate = new Date(dateVal).toISOString()
                    }
                } catch { parsedDate = new Date().toISOString() }

                if (debit > 0) {
                    insertRows.push({ shop_id: user.shop_id, supplier_id: id, amount: debit, payment_type: 'debit', bill_number: billNo, note: note || 'Imported Purchase', created_at: parsedDate })
                    balanceDelta += debit
                }
                if (credit > 0) {
                    insertRows.push({ shop_id: user.shop_id, supplier_id: id, amount: credit, payment_type: 'payment', bill_number: billNo, note: note || 'Imported Payment', created_at: parsedDate })
                    balanceDelta -= credit
                }
            }

            if (!insertRows.length) { alert('Koi valid row nahi mili (Debit/Credit columns check karein).'); return }

            if (navigator.onLine) {
                const { error } = await supabase.from('supplier_payments').insert(insertRows)
                if (error) throw error
                const r = await adjustSupplierBalance(id, balanceDelta) // atomic change, not a stale total
                if (!r.ok) throw r.error || new Error('Supplier balance update failed')
            } else {
                for (const row of insertRows) {
                    const rec = { ...row, id: crypto.randomUUID() }
                    await db.supplier_payments.add(rec)
                    await db.sync_queue.add({ table: 'supplier_payments', action: 'INSERT', data: rec, timestamp: rec.created_at })
                }
                await adjustSupplierBalance(id, balanceDelta) // queued (previously never synced)
            }

            alert(`${insertRows.length} entries import ho gayi! ✅`)
            fetchSupplierData()
        } catch (err) {
            console.error('Import error:', err)
            alert('Import failed: ' + err.message)
        }
    }

    // ── Apply filters ──────────────────────────────────────────────────────────
    const filteredLedger = ledger.filter(item => {
        const q = search.trim().toLowerCase()
        if (q) {
            const inNote = item.note?.toLowerCase().includes(q)
            const inBill = (item.bill_number || '').toLowerCase().includes(q)
            const inAmount = String(item.amount).includes(q)
            if (!inNote && !inBill && !inAmount) return false
        }
        if (filterType !== 'all' && item.type !== filterType) return false
        const itemDate = new Date(item.date)
        if (filterFrom && itemDate < new Date(filterFrom)) return false
        if (filterTo && itemDate > new Date(filterTo + 'T23:59:59')) return false
        return true
    })
    const isFiltered = search || filterType !== 'all' || filterFrom || filterTo

    // ── Bulk select helpers ────────────────────────────────────────────────────
    const allSelected = filteredLedger.length > 0 && filteredLedger.every(item => selectedIds.has(item.id))

    const toggleSelect = (itemId) => {
        setSelectedIds(prev => {
            const next = new Set(prev)
            next.has(itemId) ? next.delete(itemId) : next.add(itemId)
            return next
        })
    }
    const toggleSelectAll = () => {
        if (allSelected) {
            setSelectedIds(new Set())
        } else {
            setSelectedIds(new Set(filteredLedger.map(i => i.id)))
        }
    }

    const handleClearAllLedger = async () => {
        if (!ledger.length) return
        if (!confirm(`Poora ledger clear karein? (${ledger.length} entries)\n\nSupplier balance zero ho jayega.\nYeh supplier ko delete karne ke liye zaruri hai.`)) return
        await _doDeleteItems(ledger)
    }

    const handleBulkDelete = async () => {
        const toDelete = ledger.filter(item => selectedIds.has(item.id))
        if (!toDelete.length) return
        if (!confirm(`${toDelete.length} transactions delete karein?\n\nSupplier balance bhi adjust ho ga.`)) return
        await _doDeleteItems(toDelete)
    }

    const _doDeleteItems = async (toDelete) => {
        const errors = []
        for (const item of toDelete) {
            try {
                const failed = await deleteSupplierEntry(item)
                if (failed.length) errors.push(`${item.note}: ${failed.join(', ')} not updated`)
            } catch (err) {
                errors.push(err.message)
            }
        }
        setSelectedIds(new Set())
        if (errors.length) alert(`${errors.length} entries had problems:\n${errors.slice(0, 3).join('\n')}`)
        fetchSupplierData()
    }

    const handleReconcileBalance = async () => {
        if (!ledger.length && supplier?.outstanding_balance === 0) return
        const computedBalance = ledger.length > 0 ? ledger[0].balance : 0
        const confirmed = confirm(`Balance Reconcile Karein?\n\nPresent Stored Balance: Rs. ${supplier?.outstanding_balance || 0}\nCalculated Ledger Sum: Rs. ${computedBalance}\n\nSupplier balance transaction ledger ke mutabiq sync ho jayega.`)
        if (!confirmed) return

        try {
            if (navigator.onLine) {
                await must(supabase.from('suppliers').update({ outstanding_balance: computedBalance }).eq('id', id))
            } else {
                await db.suppliers.update(parseInt(id), { outstanding_balance: computedBalance })
                await db.sync_queue.add({ table: 'suppliers', action: 'UPDATE', data: { id, outstanding_balance: computedBalance }, timestamp: new Date().toISOString() })
            }
            setSupplier(s => s ? { ...s, outstanding_balance: computedBalance } : s)
            alert(`✅ Balance reconciled successfully to Rs. ${computedBalance}`)
        } catch (err) {
            alert('Reconcile error: ' + err.message)
        }
    }

    if (!hasFeature('supplier_ledger')) return <UpgradeWall feature="supplier_ledger" />
    if (loading) return <div className="p-8">Loading ledger...</div>
    if (!supplier) return <div className="p-8 text-danger-fg">Supplier not found!</div>

    const currentBalance = supplier.outstanding_balance || 0

    return (
        <div>
            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                    <button onClick={() => navigate('/suppliers')} className="text-primary-fg mb-2 hover:underline text-sm font-semibold">← Back to Suppliers</button>
                    <h1 className="text-3xl font-bold text-fg">{supplier.name}</h1>
                    <p className="text-fg-muted text-sm">{supplier.phone}{supplier.address ? ' | ' + supplier.address : ''}</p>
                </div>
                <div className="w-full sm:w-auto flex flex-col sm:items-end gap-3">
                    <div className="bg-surface p-4 rounded-xl shadow-sm border border-line-subtle w-full sm:w-auto text-center sm:text-right">
                        <p className="text-xs text-fg-muted uppercase tracking-wider font-semibold">Total Payable Balance</p>
                        <p className={`text-3xl font-bold ${currentBalance > 0 ? 'text-warning-fg' : 'text-success-fg'}`}>
                            Rs. {Number(currentBalance).toLocaleString()}
                        </p>
                    </div>
                    <div className="flex gap-2 flex-wrap justify-end">
                        <button onClick={handleExport}
                            className="px-4 py-2 bg-success hover:bg-success-hover text-white rounded-lg text-sm font-semibold transition">
                            📥 Export Excel
                        </button>
                        <button onClick={() => importRef.current?.click()}
                            className="px-4 py-2 bg-warning hover:bg-warning-hover text-white rounded-lg text-sm font-semibold transition">
                            📤 Import Excel
                        </button>
                        <input ref={importRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImport} />
                        <button onClick={handleReconcileBalance}
                            className="px-4 py-2 bg-warning hover:bg-warning-hover text-white rounded-lg font-semibold text-sm shadow transition"
                            title="Recalculate supplier balance from transaction ledger sum">
                            ⚡ Reconcile
                        </button>
                        <button onClick={() => setShowModal(true)}
                            className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg font-semibold text-sm shadow transition">
                            ➕ Add Transaction
                        </button>
                        {ledger.length > 0 && (
                            <button
                                onClick={handleClearAllLedger}
                                className="px-4 py-2 bg-danger-soft hover:bg-danger-muted border border-danger-line text-danger-strong rounded-lg font-semibold text-sm transition">
                                🗑️ Clear All Ledger
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Filter Bar ── */}
            <div className="bg-surface rounded-xl shadow-sm border border-line-subtle p-3 mb-4 flex flex-wrap gap-3 items-end">
                {/* Search */}
                <div className="flex-1 min-w-[180px]">
                    <label className="block text-xs text-fg-muted font-semibold mb-1 uppercase tracking-wide">🔍 Search</label>
                    <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                        placeholder="Bill #, description, amount..."
                        className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
                </div>
                {/* Type filter */}
                <div className="min-w-[140px]">
                    <label className="block text-xs text-fg-muted font-semibold mb-1 uppercase tracking-wide">Type</label>
                    <select value={filterType} onChange={e => setFilterType(e.target.value)}
                        className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none bg-surface">
                        <option value="all">All Types</option>
                        <option value="debit">Purchase / Debit</option>
                        <option value="payment">Payment</option>
                        <option value="purchase">Purchase Order</option>
                        <option value="return">Return</option>
                    </select>
                </div>
                {/* Date From */}
                <div>
                    <label className="block text-xs text-fg-muted font-semibold mb-1 uppercase tracking-wide">From</label>
                    <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)}
                        className="px-3 py-2 border border-line rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
                </div>
                {/* Date To */}
                <div>
                    <label className="block text-xs text-fg-muted font-semibold mb-1 uppercase tracking-wide">To</label>
                    <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)}
                        className="px-3 py-2 border border-line rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
                </div>
                {/* Clear */}
                {isFiltered && (
                    <button onClick={() => { setSearch(''); setFilterType('all'); setFilterFrom(''); setFilterTo('') }}
                        className="px-3 py-2 bg-surface-3 hover:bg-surface-4 text-fg-3 rounded-lg text-sm font-semibold transition">
                        ✕ Clear
                    </button>
                )}
                {/* Result count */}
                {isFiltered && (
                    <span className="text-xs text-fg-subtle self-center">
                        {filteredLedger.length} of {ledger.length} entries
                    </span>
                )}
            </div>

            {/* ── Bulk Action Bar ── */}
            {selectedIds.size > 0 && (
                <div className="mb-3 flex items-center gap-3 bg-danger-soft border border-danger-line rounded-xl px-4 py-3">
                    <span className="text-sm font-bold text-danger-strong">{selectedIds.size} selected</span>
                    <button
                        onClick={handleBulkDelete}
                        className="px-4 py-1.5 bg-danger hover:bg-danger-hover text-white rounded-lg text-sm font-bold transition"
                    >🗑️ Delete Selected</button>
                    <button
                        onClick={() => setSelectedIds(new Set())}
                        className="px-3 py-1.5 bg-surface border border-line text-fg-muted hover:bg-surface-2 rounded-lg text-sm transition"
                    >✕ Clear</button>
                </div>
            )}

            {/* ── Ledger Table ── */}
            <div className="bg-surface rounded-2xl shadow-xl overflow-hidden border border-line-subtle">
                <div className="divide-y divide-line-subtle md:hidden">
                    {filteredLedger.length === 0 ? (
                        <p className="p-6 text-center text-fg-subtle text-sm">
                            {isFiltered ? `"${search || filterType}" se koi result nahi mila. Filter clear karein.` : 'Koi transaction nahi mili. "Add Transaction" se pehli entry karein.'}
                        </p>
                    ) : (
                        filteredLedger.map((item, idx) => (
                            <div key={idx} className={`p-4 ${selectedIds.has(item.id) ? 'bg-danger-soft/40' : ''}`}>
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-xs text-fg-subtle">{new Date(item.date).toLocaleDateString('en-PK')}</p>
                                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                            <span className="font-semibold text-fg">{item.note}</span>
                                            {item.bill_number && (
                                                <span className="bg-surface-3 text-fg-2 px-2 py-0.5 rounded text-xs font-mono font-bold">{item.bill_number}</span>
                                            )}
                                        </div>
                                        {item.details && <p className="mt-1 text-xs text-fg-muted">{item.details}</p>}
                                        
                                        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                            {item.payment_mode && (
                                                <span className="bg-surface-3 text-fg-3 px-2 py-0.5 rounded text-[10px] font-semibold capitalize">{item.payment_mode}</span>
                                            )}
                                            {item.transaction_ref && (
                                                <span className="text-[10px] text-fg-subtle">Ref: {item.transaction_ref}</span>
                                            )}
                                            {item.type === 'purchase' && (
                                                <button
                                                    onClick={() => setExpandedBill(expandedBill === item.id ? null : item.id)}
                                                    className="text-[10px] text-primary-fg hover:underline font-bold uppercase tracking-tighter"
                                                >
                                                    {expandedBill === item.id ? 'Collapse ▲' : 'Details ▼'}
                                                </button>
                                            )}
                                            {item.type === 'return' && <span className="px-2 py-0.5 bg-danger-muted text-danger-strong rounded-full text-[10px] uppercase font-bold">Return</span>}
                                            {item.type === 'debit' && <span className="px-2 py-0.5 bg-warning-muted text-warning-strong rounded-full text-[10px] uppercase font-bold">Manual Entry</span>}
                                        </div>
                                    </div>
                                    
                                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                                        <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)}
                                            className="w-4 h-4 rounded cursor-pointer" />
                                        <button
                                            onClick={() => handleDeleteTransaction(item)}
                                            title="Delete transaction"
                                            className="p-1 text-fg-subtle hover:text-danger-fg rounded transition text-xs"
                                        >🗑️</button>
                                    </div>
                                </div>

                                <div className="mt-3 grid grid-cols-3 gap-2 text-right text-xs">
                                    <div>
                                        <p className="text-[10px] font-bold uppercase text-fg-subtle text-left">Debit (+)</p>
                                        <p className="font-bold text-warning-fg">{(item.type === 'purchase' || item.type === 'debit') ? `+ Rs. ${Number(item.amount).toLocaleString()}` : '—'}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-bold uppercase text-fg-subtle text-left">Credit (-)</p>
                                        <p className="font-bold text-success-fg">{(item.type !== 'purchase' && item.type !== 'debit') ? `- Rs. ${Math.abs(Number(item.amount)).toLocaleString()}` : '—'}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-bold uppercase text-fg-subtle text-left">Balance</p>
                                        <p className={`font-black ${item.balance > 0 ? 'text-danger-fg' : 'text-success-strong'}`}>Rs. {Number(item.balance).toLocaleString()}</p>
                                    </div>
                                </div>

                                {item.type === 'purchase' && expandedBill === item.id && (
                                    <div className="mt-3 bg-warning-soft/50 p-3 rounded-lg border border-warning-muted/50">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="text-[10px] text-fg-subtle uppercase font-bold tracking-widest">Payment:</span>
                                            <span className={`px-3 py-0.5 rounded-full text-[10px] font-bold uppercase ${item.payment_type === 'cash' ? 'bg-success-muted text-success-strong' : 'bg-primary-muted text-primary-strong'}`}>
                                                {item.payment_type}
                                            </span>
                                        </div>
                                        <div className="flex flex-col gap-1.5">
                                            {(item.items || []).map((it, iidx) => (
                                                <div key={iidx} className="flex justify-between text-xs bg-surface/60 p-2 rounded border border-warning-muted/30">
                                                    <span className="text-fg-2 font-medium">{it.product_name}</span>
                                                    <span className="text-fg-muted font-semibold">Rs.{it.unit_price} × {it.quantity}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
                <div className="hidden overflow-x-auto md:block">
                    <table className="w-full text-sm">
                        <thead className="bg-surface-2 border-b">
                            <tr>
                                <th className="px-4 py-4 w-10">
                                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                                        className="w-4 h-4 rounded cursor-pointer" />
                                </th>
                                <th className="px-5 py-4 text-left font-semibold text-fg-3 whitespace-nowrap">Date</th>
                                <th className="px-5 py-4 text-left font-semibold text-fg-3 whitespace-nowrap">Bill #</th>
                                <th className="px-5 py-4 text-left font-semibold text-fg-3 min-w-[160px]">Description</th>
                                <th className="px-5 py-4 text-right font-semibold text-warning-fg whitespace-nowrap">Debit (Purchase)</th>
                                <th className="px-5 py-4 text-right font-semibold text-success-fg whitespace-nowrap">Credit (Payment)</th>
                                <th className="px-5 py-4 text-right font-semibold text-fg-3 whitespace-nowrap">Balance</th>
                                <th className="px-3 py-4"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-line-subtle">
                            {filteredLedger.map((item, idx) => (
                                <React.Fragment key={idx}>
                                    <tr className={`hover:bg-surface-2 transition ${selectedIds.has(item.id) ? 'bg-danger-soft/40' : ''}`}>
                                        <td className="px-4 py-3">
                                            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)}
                                                className="w-4 h-4 rounded cursor-pointer" />
                                        </td>
                                        <td className="px-5 py-3 text-fg-muted whitespace-nowrap">{new Date(item.date).toLocaleDateString('en-PK')}</td>
                                        <td className="px-5 py-3 whitespace-nowrap">
                                            {item.bill_number
                                                ? <span className="bg-surface-3 text-fg-2 px-2 py-0.5 rounded text-xs font-mono font-bold">{item.bill_number}</span>
                                                : item.type === 'purchase'
                                                    ? <span className="text-xs text-fg-subtle font-mono">{String(item.id).slice(-8)}</span>
                                                    : <span className="text-fg-faint">—</span>}
                                        </td>
                                        <td className="px-5 py-3">
                                            <div className="flex flex-col gap-0.5">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="font-medium text-fg">{item.note}</span>
                                                    {item.type === 'purchase' && (
                                                        <button onClick={() => setExpandedBill(expandedBill === item.id ? null : item.id)}
                                                            className="text-[10px] text-primary-fg hover:text-primary-strong font-bold uppercase tracking-tighter">
                                                            {expandedBill === item.id ? 'Collapse ▲' : 'Details ▼'}
                                                        </button>
                                                    )}
                                                    {item.type === 'return' && <span className="px-2 py-0.5 bg-danger-muted text-danger-strong rounded-full text-[10px] uppercase font-bold">Return</span>}
                                                    {item.type === 'debit' && <span className="px-2 py-0.5 bg-warning-muted text-warning-strong rounded-full text-[10px] uppercase font-bold">Manual Entry</span>}
                                                </div>
                                                {item.details && <span className="text-xs text-fg-muted truncate max-w-xs">{item.details}</span>}
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    {item.payment_mode && (
                                                        <span className="bg-surface-3 text-fg-3 px-2 py-0.5 rounded text-[10px] font-semibold capitalize">{item.payment_mode}</span>
                                                    )}
                                                    {item.transaction_ref && (
                                                        <span className="text-[10px] text-fg-subtle">Ref: {item.transaction_ref}</span>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-5 py-3 text-right text-warning-fg font-semibold whitespace-nowrap">
                                            {(item.type === 'purchase' || item.type === 'debit') ? `+ Rs. ${Number(item.amount).toLocaleString()}` : ''}
                                        </td>
                                        <td className="px-5 py-3 text-right text-success-fg font-semibold whitespace-nowrap">
                                            {(item.type !== 'purchase' && item.type !== 'debit') ? `- Rs. ${Math.abs(Number(item.amount)).toLocaleString()}` : ''}
                                        </td>
                                        <td className="px-5 py-3 text-right font-bold whitespace-nowrap">
                                            <span className={item.balance > 0 ? 'text-danger-fg' : 'text-success-strong'}>
                                                Rs. {Number(item.balance).toLocaleString()}
                                            </span>
                                        </td>
                                        <td className="px-3 py-3 text-right">
                                            <button onClick={() => handleDeleteTransaction(item)}
                                                title="Delete transaction"
                                                className="p-1.5 text-fg-faint hover:text-danger-fg hover:bg-danger-soft rounded-lg transition text-xs">
                                                🗑️
                                            </button>
                                        </td>
                                    </tr>
                                    {item.type === 'purchase' && expandedBill === item.id && (
                                        <tr className="bg-warning-soft/50 border-b border-line-subtle">
                                            <td colSpan="8" className="px-5 py-3">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className="text-[10px] text-fg-subtle uppercase font-bold tracking-widest">Payment:</span>
                                                    <span className={`px-3 py-0.5 rounded-full text-[10px] font-bold uppercase ${item.payment_type === 'cash' ? 'bg-success-muted text-success-strong' : 'bg-primary-muted text-primary-strong'}`}>
                                                        {item.payment_type}
                                                    </span>
                                                </div>
                                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                                    {(item.items || []).map((it, iidx) => (
                                                        <div key={iidx} className="flex justify-between text-xs bg-surface/60 p-2 rounded-lg border border-warning-muted/50 shadow-sm">
                                                            <span className="text-fg-2 font-medium">{it.product_name}</span>
                                                            <span className="text-fg-muted font-semibold">Rs.{it.unit_price} × {it.quantity}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                            {ledger.length === 0 && (
                                <tr>
                                    <td colSpan="8" className="px-6 py-12 text-center text-fg-subtle">
                                        {isFiltered ? `"${search || filterType}" se koi result nahi mila. Filter clear karein.` : 'Koi transaction nahi mili. "Add Transaction" se pehli entry karein.'}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* ── Add Transaction Modal ── */}
            {showModal && (
                <div className="fixed inset-0 bg-black/40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
                    <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-md">
                        <h2 className="text-xl font-bold text-fg mb-1">➕ Add Transaction</h2>
                        <p className="text-xs text-fg-subtle mb-4">Purchase aur payment ek saath darj kar saktay hain</p>

                        <form onSubmit={handleSubmitTransaction} className="space-y-4">

                            {/* Date + Bill # */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-fg-2 font-medium mb-1 text-sm">Date</label>
                                    <input type="date" value={txForm.date}
                                        onChange={e => setTxForm(f => ({ ...f, date: e.target.value }))}
                                        className="w-full px-3 py-2 border border-line-strong rounded-lg focus:ring-2 focus:ring-primary outline-none text-sm" />
                                </div>
                                <div>
                                    <label className="block text-fg-2 font-medium mb-1 text-sm">Bill # (Optional)</label>
                                    <input type="text" value={txForm.bill_number}
                                        onChange={e => setTxForm(f => ({ ...f, bill_number: e.target.value }))}
                                        className="w-full px-3 py-2 border border-line-strong rounded-lg focus:ring-2 focus:ring-primary outline-none text-sm"
                                        placeholder="e.g. INV-001" />
                                </div>
                            </div>

                            {/* Purchase Amount (Debit) */}
                            <div>
                                <label className="block font-semibold mb-1 text-sm text-warning-fg">
                                    📦 Total Purchase Amount (Debit)
                                </label>
                                <input type="number" min="0" step="any" value={txForm.purchase_amount}
                                    onChange={e => setTxForm(f => ({ ...f, purchase_amount: e.target.value }))}
                                    className="w-full px-4 py-2.5 border border-warning-line bg-warning-soft rounded-lg focus:ring-2 focus:ring-warning outline-none text-sm"
                                    placeholder="0  — kitna maal liya (Rs.)" />
                                <p className="text-xs text-fg-subtle mt-0.5">Supplier sy jo maal purchase kiya uski total value</p>
                            </div>

                            {/* Paid Amount (Credit) */}
                            <div>
                                <label className="block font-semibold mb-1 text-sm text-success-fg">
                                    💵 Amount Paid (Credit)
                                </label>
                                <input type="number" min="0" step="any" value={txForm.paid_amount}
                                    onChange={e => setTxForm(f => ({ ...f, paid_amount: e.target.value }))}
                                    className="w-full px-4 py-2.5 border border-success-line bg-success-soft rounded-lg focus:ring-2 focus:ring-success outline-none text-sm"
                                    placeholder="0  — kitna paisa diya (Rs.)" />
                                <p className="text-xs text-fg-subtle mt-0.5">Supplier ko abhi kitni payment ki</p>
                            </div>

                            {/* Balance Preview */}
                            <div className="bg-surface-2 rounded-xl p-4 border border-line">
                                <p className="text-xs text-fg-muted uppercase font-bold tracking-wide mb-2">Balance Calculation</p>
                                <div className="flex flex-col gap-1 text-sm">
                                    <div className="flex justify-between text-fg-3">
                                        <span>Previous Balance</span>
                                        <span className="font-semibold">Rs. {Number(prevBalance).toLocaleString()}</span>
                                    </div>
                                    {purchaseAmt > 0 && (
                                        <div className="flex justify-between text-warning-fg">
                                            <span>+ Purchase (Debit)</span>
                                            <span className="font-semibold">Rs. {purchaseAmt.toLocaleString()}</span>
                                        </div>
                                    )}
                                    {paidAmt > 0 && (
                                        <div className="flex justify-between text-success-fg">
                                            <span>− Payment (Credit)</span>
                                            <span className="font-semibold">Rs. {paidAmt.toLocaleString()}</span>
                                        </div>
                                    )}
                                    <div className="border-t border-line-strong mt-1 pt-1 flex justify-between font-bold text-base">
                                        <span className="text-fg">New Balance</span>
                                        <span className={newBalance > 0 ? 'text-danger-fg' : 'text-success-strong'}>
                                            Rs. {newBalance.toLocaleString()}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* Details */}
                            <div>
                                <label className="block text-fg-2 font-medium mb-1 text-sm">Details (Optional)</label>
                                <textarea rows="2" value={txForm.details}
                                    onChange={e => setTxForm(f => ({ ...f, details: e.target.value }))}
                                    className="w-full px-3 py-2 border border-line-strong rounded-lg focus:ring-2 focus:ring-primary outline-none text-sm resize-none"
                                    placeholder="Saman ki tafseel ya bill link..." />
                            </div>

                            {/* Payment Mode + Transaction Ref */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-fg-2 font-medium mb-1 text-sm">Payment Mode</label>
                                    <select value={txForm.payment_mode}
                                        onChange={e => setTxForm(f => ({ ...f, payment_mode: e.target.value }))}
                                        className="w-full px-3 py-2 border border-line-strong rounded-lg focus:ring-2 focus:ring-primary outline-none text-sm bg-surface">
                                        <option value="cash">Cash</option>
                                        <option value="bank">Bank Transfer</option>
                                        <option value="cheque">Cheque</option>
                                        <option value="online">Online/JazzCash</option>
                                        <option value="other">Other</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-fg-2 font-medium mb-1 text-sm">Transaction Ref</label>
                                    <input type="text" value={txForm.transaction_ref}
                                        onChange={e => setTxForm(f => ({ ...f, transaction_ref: e.target.value }))}
                                        className="w-full px-3 py-2 border border-line-strong rounded-lg focus:ring-2 focus:ring-primary outline-none text-sm"
                                        placeholder="Cheque # / Txn ID" />
                                </div>
                            </div>

                            {/* Note */}
                            <div>
                                <label className="block text-fg-2 font-medium mb-1 text-sm">Note (Optional)</label>
                                <textarea rows="2" value={txForm.note}
                                    onChange={e => setTxForm(f => ({ ...f, note: e.target.value }))}
                                    className="w-full px-3 py-2 border border-line-strong rounded-lg focus:ring-2 focus:ring-primary outline-none text-sm resize-none"
                                    placeholder="e.g. Monthly payment / Outstanding cleared..." />
                            </div>

                            <div className="flex gap-3 pt-1">
                                <button type="submit" disabled={saving}
                                    className="flex-1 py-3 bg-primary hover:bg-primary-hover text-white font-bold rounded-lg transition disabled:opacity-50">
                                    {saving ? 'Saving...' : '✅ Save Transaction'}
                                </button>
                                <button type="button" onClick={resetForm}
                                    className="flex-1 py-3 bg-surface-3 hover:bg-surface-4 text-fg-2 font-bold rounded-lg transition">
                                    Cancel
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    )
}

export default SupplierLedger
