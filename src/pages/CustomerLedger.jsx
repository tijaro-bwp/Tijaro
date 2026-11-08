import React, { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../services/supabase'
import { fetchAllRows } from '../services/fetchAll'
import { useAuth } from '../context/AuthContext'
import { printHTML, getShopBranding } from '../utils/printUtils'
import { db } from '../services/db'
import { adjustCustomerBalance, applySaleEffects, must } from '../services/integrity'
import { generateOutstandingPDF, shareOrDownloadPDF } from '../utils/pdfShare'

function CustomerLedger() {
    const { id } = useParams()
    const { user } = useAuth()
    const navigate = useNavigate()

    const importRef = useRef()
    const [customer, setCustomer] = useState(null)
    const [loading, setLoading] = useState(true)
    const [ledger, setLedger] = useState([])
    const [showTxModal, setShowTxModal] = useState(false)
    const [txForm, setTxForm] = useState({
        date: new Date().toISOString().slice(0, 10),
        bill_number: '',
        sale_amount: '',
        payment_amount: '',
        details: '',
        payment_mode: 'cash',
        transaction_ref: '',
        note: ''
    })
    const [saving, setSaving] = useState(false)
    const [expandedSale, setExpandedSale] = useState(null)
    const [lastPayment, setLastPayment] = useState(null) // for print voucher after recording
    const [selectedIds, setSelectedIds] = useState(new Set())

    useEffect(() => {
        if (id && user?.shop_id) fetchCustomerData()
    }, [id, user?.shop_id])

    const fetchCustomerData = async () => {
        setLoading(true)
        try {
            if (!navigator.onLine) throw new Error('Offline')

            const fetchPromise = Promise.all([
                supabase.from('customers').select('*').eq('id', id).eq('shop_id', user.shop_id).maybeSingle(),
                fetchAllRows(() => supabase.from('sales').select('*, sale_items(*)').eq('customer_id', id).eq('shop_id', user.shop_id).order('created_at', { ascending: true })),
                supabase.from('customer_payments').select('*').eq('customer_id', id).eq('shop_id', user.shop_id)
            ])
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            const [custRes, salesRes, paymentsRes] = await Promise.race([fetchPromise, timeoutPromise])

            // If customer not found, show not-found screen
            if (!custRes.data) { setLoading(false); return }
            setCustomer(custRes.data)

            const sales = salesRes.error ? [] : (salesRes.data || [])
            const payments = paymentsRes.error ? [] : (paymentsRes.data || [])

            // 4. Combine into Ledger
            const combined = [
                ...(sales || []).map(s => ({
                    id: s.id,
                    date: s.created_at,
                    type: 'sale',
                    payment_type: s.payment_type,
                    amount: s.total_amount - (s.discount || 0),
                    paid_amount: s.paid_amount || 0,
                    note: `Invoice #${String(s.id).slice(-8)}`,
                    items: s.sale_items || []
                })),
                ...(payments || []).map(p => ({
                    id: p.id,
                    date: p.created_at,
                    type: p.payment_type === 'return' ? 'return' : p.payment_type === 'debit' ? 'debit' : 'payment',
                    payment_type: p.payment_type,
                    amount: p.amount,
                    note: p.note || 'Cash Payment',
                    bill_number: p.bill_number || null,
                    details: p.details || null,
                    payment_mode: p.payment_mode || null,
                    transaction_ref: p.transaction_ref || null,
                }))
            ]

            // Sort by date
            combined.sort((a, b) => new Date(a.date) - new Date(b.date))

            // Calculate running balance
            let running = 0
            const withBalance = combined.map(item => {
                if (item.type === 'sale') {
                    const owed = Math.max(0, item.amount - (item.paid_amount || 0))
                    if (owed > 0) running += owed
                } else if (item.type === 'debit') {
                    running += Number(item.amount)
                } else if (item.payment_type === 'refund') {
                    // cash refund — no balance change
                } else {
                    running -= Math.abs(item.amount)
                }
                return { ...item, balance: running }
            })

            const ob = custRes.data.outstanding_balance || 0
            if (withBalance.length === 0 && ob !== 0) {
                withBalance.push({
                    id: 'opening',
                    date: custRes.data.created_at || new Date().toISOString(),
                    type: 'sale',
                    payment_type: 'credit',
                    amount: Math.abs(ob),
                    note: 'Opening Balance (previous dues)',
                    items: [],
                    balance: ob
                })
            }

            setLedger(withBalance.reverse()) // newest first for display
        } catch (e) {
            console.log('CustomerLedger: Reconstructing from local DB (Offline)')
            try {
                const sid = String(user.shop_id)
                const [lCusts, lSales, lItems, lPayments] = await Promise.all([
                    db.customers.toArray(),
                    db.sales.toArray(),
                    db.sale_items.toArray(),
                    db.customer_payments.toArray()
                ])

                const cust = lCusts.find(c => String(c.id) === String(id))
                if (cust) setCustomer(cust)

                const mySales = lSales.filter(s => String(s.customer_id) === String(id))
                const myPayments = lPayments.filter(p => String(p.customer_id) === String(id))

                const combined = [
                    ...mySales.map(s => ({
                        id: s.id,
                        date: s.created_at,
                        type: 'sale',
                        payment_type: s.payment_type,
                        amount: s.total_amount - (s.discount || 0),
                        paid_amount: s.paid_amount || 0,
                        note: `Invoice #${String(s.id).slice(-8)}`,
                        items: lItems.filter(i => i.sale_id === s.id)
                    })),
                    ...myPayments.map(p => ({
                        id: p.id,
                        date: p.created_at,
                        type: p.payment_type === 'return' ? 'return' : p.payment_type === 'debit' ? 'debit' : 'payment',
                        payment_type: p.payment_type,
                        amount: p.amount,
                        note: p.note || 'Cash Payment',
                        bill_number: p.bill_number || null,
                        details: p.details || null,
                        payment_mode: p.payment_mode || null,
                        transaction_ref: p.transaction_ref || null,
                    }))
                ]

                combined.sort((a, b) => new Date(a.date) - new Date(b.date))
                let running = 0
                const withBalance = combined.map(item => {
                    if (item.type === 'sale') {
                        const owed = Math.max(0, item.amount - (item.paid_amount || 0))
                        if (owed > 0) running += owed
                    } else if (item.type === 'debit') {
                        running += Number(item.amount)
                    } else if (item.payment_type === 'refund') {
                        // no balance change
                    } else {
                        running -= Math.abs(item.amount)
                    }
                    return { ...item, balance: running }
                })
                // Opening balance if no transactions but customer has dues
                const cOb = cust?.outstanding_balance || 0
                if (withBalance.length === 0 && cOb !== 0) {
                    withBalance.push({
                        id: 'opening', date: cust?.created_at || new Date().toISOString(),
                        type: 'sale', payment_type: 'credit', amount: Math.abs(cOb),
                        note: 'Opening Balance (previous dues)', items: [], balance: cOb
                    })
                }
                setLedger(withBalance.reverse())
            } catch (err) { console.error('Final CustomerLedger Fallback Error:', err) }
        } finally {
            setLoading(false)
        }
    }

    const printPaymentVoucher = (amount, note, date) => {
        const branding = getShopBranding(user?.shop_id)
        printHTML(`<html><head><title>Payment Receipt</title>
        <style>
          @page{size:80mm auto;margin:2mm}
          *{box-sizing:border-box}
          body{font-family:monospace;width:302px;margin:0 auto;padding:12px 8px;font-size:13px;}
          h2,p.c{text-align:center;margin:3px 0;}
          hr{border-top:1px dashed #000;margin:8px 0;}
          .row{display:flex;justify-content:space-between;padding:3px 0;}
          .bold{font-weight:bold;}
        </style></head><body>
        <h2>${branding.name}</h2>
        ${branding.phone ? `<p class="c" style="font-size:11px;">${branding.phone}</p>` : ''}
        ${branding.address ? `<p class="c" style="font-size:10px;color:#555;">${branding.address}</p>` : ''}
        <p class="c bold" style="font-size:15px;">PAYMENT RECEIPT</p>
        <hr/>
        <div class="row"><span>Customer:</span><span class="bold">${customer.name}</span></div>
        <div class="row"><span>Phone:</span><span>${customer.phone || '-'}</span></div>
        <div class="row"><span>Date:</span><span>${new Date(date || Date.now()).toLocaleString('en-PK')}</span></div>
        <hr/>
        <div class="row bold" style="font-size:16px;"><span>Amount Received</span><span>Rs. ${Number(amount).toLocaleString()}</span></div>
        ${note ? `<div class="row"><span>Note:</span><span>${note}</span></div>` : ''}
        <hr/>
        <div class="row"><span>Remaining Balance:</span><span class="bold">Rs. ${Math.max(0, (customer.outstanding_balance || 0) - Number(amount)).toLocaleString()}</span></div>
        <hr/>
        <p class="c" style="font-size:11px;color:#888;">Thank you! Payment received in full.</p>
        </body></html>`)
    }

    // ── Excel Export ──────────────────────────────────────────────────────────
    const handleExport = () => {
        if (!ledger.length) return alert('Koi transaction nahi hai export karne ke liye.')
        const rows = [...ledger].reverse().map((item, idx) => ({
            'Sr#': idx + 1,
            'Date': new Date(item.date).toLocaleDateString('en-PK'),
            'Bill #': item.bill_number || (item.type === 'sale' ? `INV-${String(item.id).slice(-8)}` : ''),
            'Description': item.note,
            'Type': item.type === 'sale' ? 'Sale' : item.type === 'debit' ? 'Manual Sale' : item.type === 'return' ? 'Return' : 'Payment',
            'Debit (Sale)': (item.type === 'sale' || item.type === 'debit') ? Number(item.amount) : '',
            'Credit (Payment)': (item.type === 'payment' || item.type === 'return') ? Math.abs(Number(item.amount)) : '',
            'Balance': Number(item.balance),
            'Details': item.details || '',
            'Payment Mode': item.payment_mode || '',
            'Transaction Ref': item.transaction_ref || '',
        }))
        const ws = XLSX.utils.json_to_sheet(rows)
        ws['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 14 }, { wch: 30 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 30 }, { wch: 14 }, { wch: 18 }]
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Ledger')
        const safeName = (customer?.name || 'customer').replace(/[^a-z0-9]/gi, '_')
        XLSX.writeFile(wb, `${safeName}_ledger.xlsx`)
    }

    // ── Excel Import ──────────────────────────────────────────────────────────
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

            const confirmed = window.confirm(`${rows.length} transactions import karein?\n\nNote: "Debit (Sale)" column se sale entries aur "Credit (Payment)" column se payment entries banegi.`)
            if (!confirmed) return

            const insertRows = []
            let balanceDelta = 0

            for (const row of rows) {
                const debit = parseFloat(row['Debit (Sale)'] ?? row['Debit'] ?? row['debit'] ?? 0) || 0
                const credit = parseFloat(row['Credit (Payment)'] ?? row['Credit'] ?? row['credit'] ?? 0) || 0
                const dateVal = row['Date'] || row['date'] || new Date().toLocaleDateString('en-PK')
                const billNo = String(row['Bill #'] ?? row['bill_number'] ?? '').trim() || null
                const note = String(row['Description'] ?? row['Note'] ?? row['note'] ?? '').trim()
                const details = String(row['Details'] ?? row['details'] ?? '').trim() || null
                const paymentMode = String(row['Payment Mode'] ?? row['payment_mode'] ?? '').trim() || null
                const txRef = String(row['Transaction Ref'] ?? row['transaction_ref'] ?? '').trim() || null

                let parsedDate
                try {
                    if (dateVal instanceof Date && !isNaN(dateVal)) {
                        parsedDate = dateVal.toISOString()
                    } else if (typeof dateVal === 'number') {
                        parsedDate = new Date(Math.round((dateVal - 25569) * 86400 * 1000)).toISOString()
                    } else {
                        parsedDate = new Date(dateVal).toISOString()
                    }
                } catch { parsedDate = new Date().toISOString() }

                const common = { shop_id: user.shop_id, customer_id: id, bill_number: billNo, details, payment_mode: paymentMode, transaction_ref: txRef, created_at: parsedDate }
                if (debit > 0) {
                    insertRows.push({ ...common, amount: debit, payment_type: 'debit', note: note || 'Imported Sale Entry' })
                    balanceDelta += debit
                }
                if (credit > 0) {
                    insertRows.push({ ...common, amount: credit, payment_type: 'payment', note: note || 'Imported Payment' })
                    balanceDelta -= credit
                }
            }

            if (!insertRows.length) { alert('Koi valid row nahi mili (Debit/Credit columns check karein).'); return }

            if (navigator.onLine) {
                const { error } = await supabase.from('customer_payments').insert(insertRows)
                if (error) throw error
                const r = await adjustCustomerBalance(id, balanceDelta)
                if (r.ok) setCustomer(c => c ? { ...c, outstanding_balance: (Number(c.outstanding_balance) || 0) + balanceDelta } : c)
                else alert('Entries saved, but customer balance update failed: ' + (r.error?.message || 'unknown error'))
            } else {
                for (const row of insertRows) {
                    const rec = { ...row, id: crypto.randomUUID() }
                    await db.customer_payments.add(rec)
                    await db.sync_queue.add({ table: 'customer_payments', action: 'INSERT', data: rec, timestamp: rec.created_at })
                }
                await adjustCustomerBalance(id, balanceDelta) // queued while offline
                setCustomer(c => c ? { ...c, outstanding_balance: (Number(c.outstanding_balance) || 0) + balanceDelta } : c)
            }

            alert(`${insertRows.length} entries import ho gayi! ✅`)
            fetchCustomerData()
        } catch (err) {
            console.error('Import error:', err)
            alert('Import failed: ' + err.message)
        }
    }

    const resetTxForm = () => {
        setTxForm({ date: new Date().toISOString().slice(0, 10), bill_number: '', sale_amount: '', payment_amount: '', details: '', payment_mode: 'cash', transaction_ref: '', note: '' })
        setShowTxModal(false)
    }

    const handleAddTransaction = async (e) => {
        e.preventDefault()
        const saleAmt = parseFloat(txForm.sale_amount) || 0
        const payAmt = parseFloat(txForm.payment_amount) || 0
        if (saleAmt === 0 && payAmt === 0) return alert('Sale amount ya payment amount mein se koi ek lazmi hai.')
        setSaving(true)
        const now = txForm.date ? new Date(txForm.date + 'T12:00:00').toISOString() : new Date().toISOString()
        const commonFields = {
            shop_id: user.shop_id,
            customer_id: id,
            bill_number: txForm.bill_number.trim() || null,
            details: txForm.details.trim() || null,
            payment_mode: txForm.payment_mode || null,
            transaction_ref: txForm.transaction_ref.trim() || null,
            created_at: now
        }
        const insertRows = []
        if (saleAmt > 0) insertRows.push({ ...commonFields, amount: saleAmt, payment_type: 'debit', note: txForm.note.trim() || 'Manual Sale Entry' })
        if (payAmt > 0) insertRows.push({ ...commonFields, amount: payAmt, payment_type: 'payment', note: txForm.note.trim() || 'Cash Received' })

        try {
            if (!navigator.onLine) throw new TypeError('Failed to fetch')
            const { error } = await supabase.from('customer_payments').insert(insertRows)
            if (error) throw error
            const delta = saleAmt - payAmt
            const r = await adjustCustomerBalance(id, delta)
            if (r.ok) setCustomer(c => c ? { ...c, outstanding_balance: (Number(c.outstanding_balance) || 0) + delta } : c)
            else alert('Entry saved, but customer balance update failed: ' + (r.error?.message || 'unknown error'))
            if (payAmt > 0) setLastPayment({ amount: payAmt, note: txForm.note.trim() || 'Cash Received', date: now })
            resetTxForm()
            fetchCustomerData()
        } catch (error) {
            const errMsg = error?.message || String(error)
            if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
                const ts = new Date().toISOString()
                for (const row of insertRows) {
                    const rec = { ...row, id: crypto.randomUUID() }
                    await db.customer_payments.add(rec)
                    await db.sync_queue.add({ table: 'customer_payments', action: 'INSERT', data: rec, timestamp: ts })
                }
                const delta = saleAmt - payAmt
                await adjustCustomerBalance(id, delta) // queued as an atomic change
                setCustomer(c => c ? { ...c, outstanding_balance: (Number(c.outstanding_balance) || 0) + delta } : c)
                if (payAmt > 0) setLastPayment({ amount: payAmt, note: txForm.note.trim() || 'Cash Received', date: ts })
                resetTxForm()
                fetchCustomerData()
                alert('Offline mode: Transaction locally save ho gaya. Online hone par sync hoga! 🔄')
            } else {
                alert('Error: ' + errMsg)
            }
        } finally {
            setSaving(false)
        }
    }

    // Delete one ledger entry and undo its effect with atomic changes:
    // a sale returns its stock and removes its unpaid amount; a debit/payment/return
    // reverses its balance effect. Balances are never clamped at 0 (an overpayment is
    // a real advance the customer has with the shop).
    const deleteLedgerEntry = async (item) => {
        if (item.type === 'sale') {
            const lineItems = item.items || []
            if (navigator.onLine) {
                const { error: itemsErr } = await supabase.from('sale_items').delete().eq('sale_id', item.id)
                if (itemsErr) throw itemsErr
                const { error } = await supabase.from('sales').delete().eq('id', item.id)
                if (error) {
                    if (lineItems.length) await supabase.from('sale_items').upsert(lineItems)
                    throw error
                }
            } else {
                const lItems = await db.sale_items.toArray()
                const toDelIds = lItems.filter(i => String(i.sale_id) === String(item.id)).map(i => i.id)
                await db.sale_items.bulkDelete(toDelIds)
                await db.sales.delete(item.id)
                for (const delId of toDelIds) {
                    await db.sync_queue.add({ table: 'sale_items', action: 'DELETE', data: { id: delId }, timestamp: new Date().toISOString() })
                }
                await db.sync_queue.add({ table: 'sales', action: 'DELETE', data: { id: item.id }, timestamp: new Date().toISOString() })
            }
            return applySaleEffects(
                { sale_type: 'sale', customer_id: id, total_amount: item.amount, discount: 0, paid_amount: item.paid_amount },
                lineItems,
                'reverse'
            )
        }

        // payment, debit or return — delete from customer_payments
        if (navigator.onLine) {
            const { error } = await supabase.from('customer_payments').delete().eq('id', item.id)
            if (error) throw error
        } else {
            await db.customer_payments.delete(item.id)
            await db.sync_queue.add({ table: 'customer_payments', action: 'DELETE', data: { id: item.id }, timestamp: new Date().toISOString() })
        }
        let delta = 0
        if (item.payment_type === 'refund') delta = 0                   // cash handed back: no balance effect
        else if (item.payment_type === 'debit') delta = -Number(item.amount)
        else delta = Math.abs(Number(item.amount))                      // payment / return had lowered the balance
        if (!delta) return []
        const r = await adjustCustomerBalance(id, delta)
        return r.ok ? [] : ['customer balance']
    }

    const handleDeleteTransaction = async (item) => {
        if (item.id === 'opening') { alert('Opening balance entry directly delete nahi ho sakti.'); return }
        const label = item.type === 'sale' ? 'Sale/Invoice' : item.type === 'payment' ? 'Payment' : 'Return'
        if (!confirm(`Yeh transaction delete karein?\n\nType: ${label}\nAmount: Rs. ${Number(item.amount).toLocaleString()}\nNote: ${item.note}\n\nCustomer ka outstanding balance bhi adjust ho ga.`)) return

        try {
            const failed = await deleteLedgerEntry(item)
            if (failed.length) alert(`Deleted, but these updates failed: ${failed.join(', ')}`)
            fetchCustomerData()
        } catch (err) {
            alert('Delete nahi hua: ' + err.message)
        }
    }

    const selectableItems = ledger.filter(item => item.id !== 'opening')
    const allSelected = selectableItems.length > 0 && selectableItems.every(item => selectedIds.has(item.id))

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
            setSelectedIds(new Set(selectableItems.map(i => i.id)))
        }
    }

    const handleBulkDelete = async () => {
        const toDelete = ledger.filter(item => selectedIds.has(item.id) && item.id !== 'opening')
        if (!toDelete.length) return
        if (!confirm(`${toDelete.length} transactions delete karein?\n\nCustomer ka outstanding balance bhi adjust ho ga.`)) return

        const failures = []
        try {
            for (const item of toDelete) {
                const failed = await deleteLedgerEntry(item)
                if (failed.length) failures.push(`${item.note}: ${failed.join(', ')}`)
            }
            if (failures.length) alert(`Deleted, but some updates failed:\n${failures.join('\n')}`)
            setSelectedIds(new Set())
        } catch (err) {
            alert('Kuch entries delete nahi huin: ' + err.message)
        } finally {
            fetchCustomerData()
        }
    }

    const handleReconcileBalance = async () => {
        if (!ledger.length && customer?.outstanding_balance === 0) return
        const computedBalance = ledger.length > 0 ? ledger[0].balance : 0
        const confirmed = confirm(`Balance Reconcile Karein?\n\nPresent Stored Balance: Rs. ${customer?.outstanding_balance || 0}\nCalculated Ledger Sum: Rs. ${computedBalance}\n\nCustomer balance transaction ledger ke mutabiq sync ho jayega.`)
        if (!confirmed) return

        try {
            if (navigator.onLine) {
                await must(supabase.from('customers').update({ outstanding_balance: computedBalance }).eq('id', id))
            } else {
                await db.customers.update(parseInt(id), { outstanding_balance: computedBalance })
                await db.sync_queue.add({ table: 'customers', action: 'UPDATE', data: { id, outstanding_balance: computedBalance }, timestamp: new Date().toISOString() })
            }
            setCustomer(c => c ? { ...c, outstanding_balance: computedBalance } : c)
            alert(`✅ Balance reconciled successfully to Rs. ${computedBalance}`)
        } catch (err) {
            alert('Reconcile error: ' + err.message)
        }
    }

    if (loading) return <div className="p-8">Loading ledger...</div>
    if (!customer) return <div className="p-8 text-danger-fg">Customer not found!</div>

    return (
        <div>
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                    <button onClick={() => navigate('/customers')} className="text-primary-fg mb-2 hover:underline text-sm font-semibold">← Back to Customers</button>
                    <h1 className="text-3xl font-bold text-fg">{customer.name}</h1>
                    <p className="text-fg-muted">{customer.phone} | {customer.address}</p>
                </div>
                <div className="w-full sm:w-auto text-left sm:text-right flex flex-col sm:items-end gap-3">
                    <div className="bg-surface p-4 rounded-xl shadow-sm border border-line-subtle flex-1 w-full sm:w-auto">
                        <p className="text-sm text-fg-muted uppercase tracking-wider font-semibold">Total Outstanding</p>
                        <p className={`text-3xl font-bold ${customer.outstanding_balance > 0 ? 'text-danger-fg' : 'text-success-fg'}`}>
                            Rs. {customer.outstanding_balance || 0}
                        </p>
                    </div>
                    <div className="flex gap-2 flex-wrap justify-end">
                        {customer.phone && (
                            <button
                                onClick={async (e) => {
                                    const btn = e.currentTarget
                                    btn.disabled = true
                                    btn.innerHTML = '⏳ Generating PDF...'
                                    try {
                                        const { data: shop } = await supabase.from('shops').select('*').eq('id', user.shop_id).maybeSingle()
                                        const phone = customer.phone.replace(/[^0-9]/g, '')
                                        let formattedPhone = phone
                                        if (phone.startsWith('03')) formattedPhone = '92' + phone.substring(1)
                                        else if (phone.length === 10) formattedPhone = '92' + phone

                                        const template = shop?.wa_reminder_template || "Hello [Name], this is a reminder from [Shop Name] regarding your outstanding balance of Rs. [Amount]. Please clear your dues at your earliest convenience. Thank you!"
                                        const msg = template
                                            .replace(/\[Name\]/g, customer.name)
                                            .replace(/\[Amount\]/g, (customer.outstanding_balance || 0).toLocaleString())
                                            .replace(/\[Shop Name\]/g, shop?.name || 'our shop')

                                        const shopInfo = { name: shop?.name || 'Shop', phone: shop?.phone || '', address: shop?.address || '' }
                                        const pdfBlob = generateOutstandingPDF(customer, ledger, shopInfo)
                                        await shareOrDownloadPDF(pdfBlob, `outstanding-${customer.name.replace(/\s+/g, '-')}.pdf`, formattedPhone, msg)
                                    } catch (err) {
                                        console.error('Outstanding PDF failed:', err)
                                        const phone = customer.phone.replace(/[^0-9]/g, '')
                                        let formattedPhone = phone
                                        if (phone.startsWith('03')) formattedPhone = '92' + phone.substring(1)
                                        else if (phone.length === 10) formattedPhone = '92' + phone
                                        const msg = `${customer.name} — Outstanding: Rs. ${(customer.outstanding_balance || 0).toLocaleString()}`
                                        window.open(`https://wa.me/${formattedPhone}?text=${encodeURIComponent(msg)}`, '_blank')
                                    } finally {
                                        btn.disabled = false
                                        btn.innerHTML = '<span>💬</span> WhatsApp Reminder'
                                    }
                                }}
                                className="w-full sm:w-auto px-4 py-2.5 bg-success hover:bg-success-hover text-white rounded-lg transition font-semibold shadow-lg flex items-center justify-center gap-2"
                            >
                                <span>💬</span> WhatsApp Reminder
                            </button>
                        )}
                        <button
                            onClick={handleReconcileBalance}
                            className="w-full sm:w-auto px-4 py-2.5 bg-warning hover:bg-warning-hover text-white rounded-lg transition font-semibold shadow-lg flex items-center justify-center gap-1.5"
                            title="Recalculate customer balance from transaction ledger sum"
                        >
                            ⚡ Reconcile
                        </button>
                        <button
                            onClick={() => setShowTxModal(true)}
                            className="w-full sm:w-auto px-6 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg transition font-semibold shadow-lg">
                            ➕ Add Transaction
                        </button>
                    </div>
                </div>
            </div>

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

            <div className="bg-surface rounded-2xl shadow-xl overflow-hidden border border-line-subtle">
                <div className="divide-y divide-line-subtle md:hidden">
                    {ledger.length === 0 ? (
                        <p className="p-6 text-center text-fg-subtle text-sm">No transactions found for this customer.</p>
                    ) : (
                        ledger.map((item, idx) => (
                            <div key={idx} className={`p-4 ${selectedIds.has(item.id) ? 'bg-danger-soft/40' : ''}`}>
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-xs text-fg-subtle">{new Date(item.date).toLocaleDateString('en-PK')}</p>
                                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                            <span className="font-semibold text-fg">{item.note}</span>
                                            {item.bill_number && (
                                                <span className="bg-primary-soft text-primary-strong border border-primary-line px-2 py-0.5 rounded text-[10px] font-bold">Bill #{item.bill_number}</span>
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
                                            {item.type === 'payment' && (
                                                <button
                                                    onClick={() => printPaymentVoucher(item.amount, item.note, item.date)}
                                                    className="text-[10px] text-primary-fg hover:underline font-bold uppercase tracking-tighter"
                                                >🖨️ Print</button>
                                            )}
                                            {item.type === 'sale' && (
                                                <button
                                                    onClick={() => setExpandedSale(expandedSale === item.id ? null : item.id)}
                                                    className="text-[10px] text-primary-fg hover:underline font-bold uppercase tracking-tighter"
                                                >
                                                    {expandedSale === item.id ? 'Collapse ▲' : 'Details ▼'}
                                                </button>
                                            )}
                                            {item.type === 'return' && <span className="px-2 py-0.5 bg-danger-muted text-danger-strong rounded-full text-[10px] uppercase font-bold">Return</span>}
                                            {item.type === 'debit' && <span className="px-2 py-0.5 bg-warning-muted text-warning-strong rounded-full text-[10px] uppercase font-bold">Manual Sale</span>}
                                        </div>
                                    </div>
                                    
                                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                                        {item.id !== 'opening' && (
                                            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)}
                                                className="w-4 h-4 rounded cursor-pointer" />
                                        )}
                                        {item.id !== 'opening' && (
                                            <button
                                                onClick={() => handleDeleteTransaction(item)}
                                                title="Delete transaction"
                                                className="p-1 text-fg-subtle hover:text-danger-fg rounded transition text-xs"
                                            >🗑️</button>
                                        )}
                                    </div>
                                </div>

                                <div className="mt-3 grid grid-cols-3 gap-2 text-right text-xs">
                                    <div>
                                        <p className="text-[10px] font-bold uppercase text-fg-subtle text-left">Debit (+)</p>
                                        <p className="font-bold text-danger-fg">{(item.type === 'sale' || item.type === 'debit') ? `+ Rs. ${Number(item.amount).toFixed(0)}` : '—'}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-bold uppercase text-fg-subtle text-left">Credit (-)</p>
                                        <p className="font-bold text-success-fg">{(item.type === 'payment' || item.type === 'return') ? `- Rs. ${Math.abs(item.amount).toFixed(0)}` : '—'}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-bold uppercase text-fg-subtle text-left">Balance</p>
                                        <p className="font-black text-fg">Rs. {item.balance.toFixed(0)}</p>
                                    </div>
                                </div>

                                {item.type === 'sale' && expandedSale === item.id && (
                                    <div className="mt-3 bg-primary-soft/50 p-3 rounded-lg border border-primary-muted/50">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="text-[10px] text-fg-subtle uppercase font-bold tracking-widest">Payment:</span>
                                            <span className={`px-3 py-0.5 rounded-full text-[10px] font-bold uppercase ${item.payment_type === 'cash' ? 'bg-success-muted text-success-strong' : 'bg-warning-muted text-warning-strong'}`}>
                                                {item.payment_type}
                                            </span>
                                        </div>
                                        <div className="flex flex-col gap-1.5">
                                            {(item.items || []).map((it, iidx) => (
                                                <div key={iidx} className="flex justify-between text-xs bg-surface/60 p-2 rounded border border-primary-muted/30">
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
                                <th className="px-6 py-4 text-left font-semibold text-fg-3 whitespace-nowrap">Date</th>
                                <th className="px-6 py-4 text-left font-semibold text-fg-3 min-w-[200px]">Description</th>
                                <th className="px-6 py-4 text-right font-semibold text-fg-3 whitespace-nowrap">Debit (Sale)</th>
                                <th className="px-6 py-4 text-right font-semibold text-fg-3 whitespace-nowrap">Credit (Payment)</th>
                                <th className="px-6 py-4 text-right font-semibold text-fg-3 whitespace-nowrap">Balance</th>
                                <th className="px-4 py-4 text-right font-semibold text-fg-3 whitespace-nowrap">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-line-subtle">
                        {ledger.length === 0 && (
                            <tr><td colSpan="7" className="px-6 py-12 text-center text-fg-subtle text-sm">No transactions found for this customer.</td></tr>
                        )}
                        {ledger.map((item, idx) => (
                            <React.Fragment key={idx}>
                                <tr className={`hover:bg-surface-2 transition ${selectedIds.has(item.id) ? 'bg-danger-soft/40' : ''}`}>
                                    <td className="px-4 py-4">
                                        {item.id !== 'opening' && (
                                            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)}
                                                className="w-4 h-4 rounded cursor-pointer" />
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-fg-muted font-normal">{new Date(item.date).toLocaleDateString('en-PK')}</td>
                                    <td className="px-6 py-4">
                                        <div className="flex flex-col gap-0.5">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-medium text-fg">{item.note}</span>
                                                {item.bill_number && (
                                                    <span className="bg-primary-soft text-primary-strong border border-primary-line px-2 py-0.5 rounded text-[10px] font-bold">Bill #{item.bill_number}</span>
                                                )}
                                                {item.type === 'sale' && (
                                                    <button
                                                        onClick={() => setExpandedSale(expandedSale === item.id ? null : item.id)}
                                                        className="text-[10px] text-primary-fg hover:text-primary-strong font-bold uppercase tracking-tighter"
                                                    >
                                                        {expandedSale === item.id ? 'Collapse ▲' : 'Details ▼'}
                                                    </button>
                                                )}
                                            </div>
                                            {item.details && <span className="text-xs text-fg-muted truncate max-w-xs">{item.details}</span>}
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                {item.payment_mode && (
                                                    <span className="bg-surface-3 text-fg-3 px-2 py-0.5 rounded text-[10px] font-semibold capitalize">{item.payment_mode}</span>
                                                )}
                                                {item.transaction_ref && (
                                                    <span className="text-[10px] text-fg-subtle">Ref: {item.transaction_ref}</span>
                                                )}
                                                {item.type === 'payment' && (
                                                    <button
                                                        onClick={() => printPaymentVoucher(item.amount, item.note, item.date)}
                                                        className="text-[10px] text-fg-subtle hover:text-success-fg font-medium transition"
                                                        title="Print Payment Voucher"
                                                    >🖨️ Print</button>
                                                )}
                                                {item.type === 'return' && <span className="px-2 py-0.5 bg-danger-muted text-danger-strong rounded-full text-[10px] uppercase font-bold">Return</span>}
                                                {item.type === 'debit' && <span className="px-2 py-0.5 bg-warning-muted text-warning-strong rounded-full text-[10px] uppercase font-bold">Manual Sale</span>}
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right text-danger-fg font-semibold">
                                        {(item.type === 'sale' || item.type === 'debit') ? `+ Rs. ${Number(item.amount).toFixed(0)}` : ''}
                                    </td>
                                    <td className="px-6 py-4 text-right text-success-fg font-semibold">
                                        {(item.type === 'payment' || item.type === 'return') ? `- Rs. ${Math.abs(item.amount).toFixed(0)}` : ''}
                                    </td>
                                    <td className="px-6 py-4 text-right font-bold text-fg">
                                        Rs. {item.balance.toFixed(0)}
                                    </td>
                                    <td className="px-4 py-4 text-right">
                                        {item.id !== 'opening' && (
                                            <button
                                                onClick={() => handleDeleteTransaction(item)}
                                                title="Delete transaction"
                                                className="p-1.5 text-fg-faint hover:text-danger-fg hover:bg-danger-soft rounded-lg transition text-xs"
                                            >🗑️</button>
                                        )}
                                    </td>
                                </tr>
                                {item.type === 'sale' && expandedSale === item.id && (
                                    <tr className="bg-primary-soft/50 border-b border-line-subtle">
                                        <td colSpan="7" className="px-6 py-3">
                                            <div className="flex flex-col gap-2">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] text-fg-subtle uppercase font-bold tracking-widest">Payment:</span>
                                                    <span className={`px-3 py-0.5 rounded-full text-[10px] font-bold uppercase ${item.payment_type === 'cash' ? 'bg-success-muted text-success-strong' : 'bg-warning-muted text-warning-strong'}`}>
                                                        {item.payment_type}
                                                    </span>
                                                </div>
                                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                                    {(item.items || []).map((it, iidx) => (
                                                        <div key={iidx} className="flex justify-between text-xs bg-surface/60 p-2 rounded-lg border border-primary-muted/50 shadow-sm">
                                                            <span className="text-fg-2 font-medium">{it.product_name}</span>
                                                            <span className="text-fg-muted font-semibold">Rs.{it.unit_price} × {it.quantity}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        ))}
                    </tbody>
                </table>
                </div>
            </div>

            {/* Payment Success Banner */}
            {lastPayment && (
                <div className="fixed bottom-6 right-6 z-50 bg-success text-white rounded-2xl shadow-2xl p-4 flex items-center gap-4 animate-bounce-once max-w-sm">
                    <div>
                        <p className="font-bold text-sm">✅ Payment Recorded!</p>
                        <p className="text-xs opacity-90">Rs. {Number(lastPayment.amount).toLocaleString()} — {lastPayment.note}</p>
                    </div>
                    <button
                        onClick={() => printPaymentVoucher(lastPayment.amount, lastPayment.note, lastPayment.date)}
                        className="bg-surface text-success-strong font-bold text-xs px-3 py-2 rounded-xl hover:bg-success-soft transition whitespace-nowrap"
                    >
                        🖨️ Print
                    </button>
                    <button onClick={() => setLastPayment(null)} className="text-white/70 hover:text-white text-lg leading-none ml-1">×</button>
                </div>
            )}

            {/* Add Transaction Modal */}
            {showTxModal && (() => {
                const prevBalance = ledger.length > 0 ? ledger[0].balance : (customer?.outstanding_balance || 0)
                const saleAmt = parseFloat(txForm.sale_amount) || 0
                const payAmt = parseFloat(txForm.payment_amount) || 0
                const newBalance = prevBalance + saleAmt - payAmt
                return (
                    <div className="fixed inset-0 bg-black/40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
                        <div className="bg-surface rounded-2xl shadow-2xl p-6 w-full max-w-md">
                            <h2 className="text-xl font-bold text-fg mb-1">➕ Add Transaction</h2>
                            <p className="text-xs text-fg-subtle mb-4">Sale aur payment ek saath ya alag alag darj karein</p>
                            <form onSubmit={handleAddTransaction} className="space-y-4">

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

                                {/* Sale Amount (Debit) */}
                                <div>
                                    <label className="block font-semibold mb-1 text-sm text-warning-fg">🛒 Sale Amount / Debit</label>
                                    <input type="number" min="0" step="any" value={txForm.sale_amount}
                                        onChange={e => setTxForm(f => ({ ...f, sale_amount: e.target.value }))}
                                        className="w-full px-4 py-2.5 border border-warning-line bg-warning-soft rounded-lg focus:ring-2 focus:ring-warning outline-none text-sm"
                                        placeholder="0  — kitna maal becha (Rs.)" />
                                    <p className="text-xs text-fg-subtle mt-0.5">Customer ko jo maal diya uski value</p>
                                </div>

                                {/* Payment Received (Credit) */}
                                <div>
                                    <label className="block font-semibold mb-1 text-sm text-success-fg">💵 Payment Received / Credit</label>
                                    <input type="number" min="0" step="any" value={txForm.payment_amount}
                                        onChange={e => setTxForm(f => ({ ...f, payment_amount: e.target.value }))}
                                        className="w-full px-4 py-2.5 border border-success-line bg-success-soft rounded-lg focus:ring-2 focus:ring-success outline-none text-sm"
                                        placeholder="0  — kitni payment ayi (Rs.)" />
                                    <p className="text-xs text-fg-subtle mt-0.5">Customer sy jo payment mili</p>
                                </div>

                                {/* Balance Preview */}
                                <div className="bg-surface-2 rounded-xl p-3 border border-line">
                                    <p className="text-xs text-fg-muted uppercase font-bold tracking-wide mb-2">Balance Calculation</p>
                                    <div className="flex flex-col gap-1 text-sm">
                                        <div className="flex justify-between text-fg-3">
                                            <span>Previous Balance</span>
                                            <span className="font-semibold">Rs. {Number(prevBalance).toLocaleString()}</span>
                                        </div>
                                        {saleAmt > 0 && (
                                            <div className="flex justify-between text-warning-fg">
                                                <span>+ Sale (Debit)</span>
                                                <span className="font-semibold">Rs. {saleAmt.toLocaleString()}</span>
                                            </div>
                                        )}
                                        {payAmt > 0 && (
                                            <div className="flex justify-between text-success-fg">
                                                <span>− Payment (Credit)</span>
                                                <span className="font-semibold">Rs. {payAmt.toLocaleString()}</span>
                                            </div>
                                        )}
                                        <div className="border-t border-line-strong mt-1 pt-1 flex justify-between font-bold text-base">
                                            <span className="text-fg">New Balance</span>
                                            <span className={newBalance > 0 ? 'text-danger-fg' : 'text-success-strong'}>Rs. {newBalance.toLocaleString()}</span>
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
                                        placeholder="e.g. Advance payment / Credit sale..." />
                                </div>

                                <div className="flex gap-3 pt-1">
                                    <button type="submit" disabled={saving}
                                        className="flex-1 py-3 bg-primary hover:bg-primary-hover text-white font-bold rounded-lg transition disabled:opacity-50">
                                        {saving ? 'Saving...' : '✅ Save Transaction'}
                                    </button>
                                    <button type="button" onClick={resetTxForm}
                                        className="flex-1 py-3 bg-surface-3 hover:bg-surface-4 text-fg-2 font-bold rounded-lg transition">
                                        Cancel
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )
            })()}
        </div >
    )
}

export default CustomerLedger
