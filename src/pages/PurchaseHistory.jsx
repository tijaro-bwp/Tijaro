import { useEffect, useState } from 'react'
import { hasFeature } from '../utils/featureGate'
import UpgradeWall from '../components/UpgradeWall'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { db, addToSyncQueue, moveToTrash } from '../services/db'
import { adjustStock, adjustSupplierBalance, must } from '../services/integrity'
import { recordAuditLog } from '../services/auditService'
import PasswordModal from '../components/PasswordModal'
import * as XLSX from 'xlsx'
import { printHTML } from '../utils/printUtils'
import { buildBillHTML } from '../utils/billTemplates'
import { BRAND } from '../config/brand.js'

function PurchaseHistory() {
    const { user } = useAuth()
    const [purchases, setPurchases] = useState([])
    const [loading, setLoading] = useState(true)
    const [selectedPurchase, setSelectedPurchase] = useState(null)
    const [purchaseItems, setPurchaseItems] = useState([])
    const [loadingItems, setLoadingItems] = useState(false)
    const [search, setSearch] = useState('')
    const [filterType, setFilterType] = useState('')
    const [paymentFilter, setPaymentFilter] = useState('all')
    const [dateFilter, setDateFilter] = useState('')
    const [selected, setSelected] = useState([])
    const [showPasswordModal, setShowPasswordModal] = useState(false)
    const [pendingDeleteIds, setPendingDeleteIds] = useState([])

    const [shopSettings, setShopSettings] = useState({})

    // Return feature state
    const [returnQtys, setReturnQtys] = useState({})
    const [returning, setReturning] = useState(false)

    useEffect(() => {
        if (user?.shop_id) {
            fetchPurchases()
            fetchShopSettings()
        }
    }, [user?.shop_id])

    const fetchShopSettings = async () => {
        // Load from shop-scoped localStorage first, then refresh from Supabase
        const sid = user?.shop_id
        const cached = sid ? localStorage.getItem(`shop_settings_${sid}`) : null
        if (cached) { try { setShopSettings(JSON.parse(cached)) } catch (_) {} }
        try {
            if (!navigator.onLine) throw new Error('Offline')
            const { data } = await supabase.from('shops').select('*').eq('id', user.shop_id).maybeSingle()
            if (data) setShopSettings(prev => ({ ...prev, ...data }))
        } catch (e) {
            console.log('PurchaseHistory: Using cached settings')
        }
    }

    const fetchPurchases = async () => {
        setLoading(true)
        try {
            if (!navigator.onLine) throw new Error('Offline');
            const fetchPromise = supabase
                .from('purchases')
                .select('*, suppliers(name)')
                .eq('shop_id', user.shop_id)
                .order('created_at', { ascending: false })

            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))

            const { data, error } = await Promise.race([fetchPromise, timeoutPromise])

            if (error) throw error
            if (data) {
                const cleanData = JSON.parse(JSON.stringify(data))
                await db.purchases.bulkPut(cleanData)
            }

            // Always render from local DB to include pending items
            const localData = await db.purchases.toArray()
            const sid = String(user.shop_id)
            const filtered = localData.filter(x => String(x.shop_id) === sid)
            const sorted = filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
            setPurchases(sorted)
        } catch (e) {
            console.log('Purchases: Fetching from local DB (Offline Fallback)')
            try {
                const localData = await db.purchases.toArray()
                const sorted = localData.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
                setPurchases(sorted.filter(x => String(x.shop_id) === String(user.shop_id)))
            } catch (err) { console.error('Local DB PurchaseHistory Error:', err) }
        } finally {
            setLoading(false)
        }
    }

    const openPurchase = async (purchase) => {
        setSelectedPurchase(purchase)
        setReturnQtys({})
        setLoadingItems(true)
        try {
            if (!navigator.onLine) throw new Error('Offline')
            const fetchPromise = supabase
                .from('purchase_items')
                .select('*, products(name, stock_quantity)')
                .eq('purchase_id', purchase.id)

            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            const { data, error } = await Promise.race([fetchPromise, timeoutPromise])

            if (error) throw error
            if (data) {
                const cleanData = JSON.parse(JSON.stringify(data))
                await db.purchase_items.bulkPut(cleanData)
            }

            // Render from local for consistency
            const localItems = await db.purchase_items.where({ purchase_id: purchase.id }).toArray()
            setPurchaseItems(localItems)
        } catch (e) {
            console.log('Purchase Items: Fetching from local DB')
            const localItems = await db.purchase_items.where({ purchase_id: purchase.id }).toArray().catch(() => [])
            if (localItems.length === 0) {
                const all = await db.purchase_items.toArray()
                setPurchaseItems(all.filter(i => i.purchase_id === purchase.id))
            } else {
                setPurchaseItems(localItems)
            }
        }
        setLoadingItems(false)
    }

    // Handle purchase return (supplier return / stock out)
    const handleReturn = async () => {
        const itemsToReturn = purchaseItems.filter(i => returnQtys[i.id] > 0)
        if (itemsToReturn.length === 0) { alert('Return karne ke liye qty enter karo!'); return }

        for (const item of itemsToReturn) {
            const returnQty = parseInt(returnQtys[item.id]) || 0
            const alreadyReturned = item.returned_qty || 0
            const maxReturn = item.quantity - alreadyReturned
            if (returnQty > maxReturn) { alert(`${item.product_name}: max ${maxReturn} return ho sakta hai`); return }
        }

        setReturning(true)
        let totalReturnAmount = 0

        try {
            if (!navigator.onLine) throw new TypeError('Failed to fetch')

            for (const item of itemsToReturn) {
                const returnQty = parseInt(returnQtys[item.id]) || 0
                const returnAmount = item.unit_price * returnQty
                totalReturnAmount += returnAmount

                // Update returned_qty on purchase_item
                await must(supabase.from('purchase_items')
                    .update({ returned_qty: (item.returned_qty || 0) + returnQty })
                    .eq('id', item.id))

                // Reduce stock as an atomic change (local copy updated by the helper)
                const sr = await adjustStock(item.product_id, -returnQty)
                if (!sr.ok) throw sr.error || new Error(`Stock update failed for ${item.product_name}`)
            }

            // Update purchase record total
            const newPurchaseTotal = Math.max(0, (selectedPurchase.total_amount || 0) - totalReturnAmount)
            await must(supabase.from('purchases').update({ total_amount: newPurchaseTotal }).eq('id', selectedPurchase.id))

            // If credit purchase, reduce supplier balance
            if (selectedPurchase.payment_type === 'credit' && selectedPurchase.supplier_id) {
                const br = await adjustSupplierBalance(selectedPurchase.supplier_id, -totalReturnAmount)
                if (!br.ok) throw br.error || new Error('Supplier balance update failed')

                // Log payment return in supplier_payments
                await must(supabase.from('supplier_payments').insert([{
                    shop_id: user.shop_id,
                    supplier_id: selectedPurchase.supplier_id,
                    amount: -totalReturnAmount,
                    payment_type: 'return',
                    note: `Return from Purchase PR-${String(selectedPurchase.id).slice(-6)}`
                }]))
            }

            // Audit Log
            await recordAuditLog(
                'PURCHASE_RETURN',
                'purchases',
                selectedPurchase.id,
                {
                    purchase: selectedPurchase.id,
                    returned_amount: totalReturnAmount,
                    items: itemsToReturn.map(it => ({ name: it.product_name, qty: returnQtys[it.id] }))
                },
                user.id,
                user.shop_id
            )

            alert('Return successful! Purchase invoice updated.')
            setReturning(false)
            setReturnQtys({})

            // Re-fetch updated purchase
            const { data: updatedPurchase } = await supabase.from('purchases').select('*, suppliers(name)').eq('id', selectedPurchase.id).maybeSingle()
            if (updatedPurchase) setSelectedPurchase(updatedPurchase)
            fetchPurchases()
        } catch (err) {
            const errMsg = err?.message || String(err)
            if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
                // OFFLINE RETURN LOGIC
                totalReturnAmount = 0
                for (const item of itemsToReturn) {
                    const returnQty = parseInt(returnQtys[item.id]) || 0
                    totalReturnAmount += item.unit_price * returnQty

                    // 1. Update local purchase_item
                    const newRetQty = (item.returned_qty || 0) + returnQty
                    await db.purchase_items.update(item.id, { returned_qty: newRetQty })
                    await db.sync_queue.add({ table: 'purchase_items', action: 'UPDATE', data: { id: item.id, returned_qty: newRetQty }, timestamp: new Date().toISOString() })

                    // 2. Update local stock (subtract for purchase return)
                    // queued as an atomic change (never replays a stale absolute stock value)
                    await adjustStock(item.product_id, -returnQty)
                }

                // Update local purchase total
                const newPurchaseTotal = Math.max(0, (selectedPurchase.total_amount || 0) - totalReturnAmount)
                await db.purchases.update(selectedPurchase.id, { total_amount: newPurchaseTotal })
                await db.sync_queue.add({ table: 'purchases', action: 'UPDATE', data: { id: selectedPurchase.id, total_amount: newPurchaseTotal }, timestamp: new Date().toISOString() })

                alert('Offline mode: Return processed locally. Stock and Invoice updated! 🔄')
                setReturning(false)
                setReturnQtys({})
                setSelectedPurchase({ ...selectedPurchase, total_amount: newPurchaseTotal })
                fetchPurchases()
            } else {
                alert('Error processing return: ' + errMsg)
                setReturning(false)
            }
        }
    }

    const handleExport = () => {
        const data = filtered.map(p => ({
            'ID': `PR-${String(p.id).slice(-6)}`,
            'Supplier': p.suppliers?.name || 'Unknown',
            'Total Amount': p.total_amount,
            'Paid Amount': p.paid_amount,
            'Payment Type': p.payment_type.toUpperCase(),
            'Date': new Date(p.created_at).toLocaleDateString('en-PK')
        }))
        const ws = XLSX.utils.json_to_sheet(data)
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Purchases')
        XLSX.writeFile(wb, `PurchaseHistory_${new Date().toISOString().slice(0, 10)}.xlsx`)
    }

    const printPurchase = (p, items) => {
        const sid = user?.shop_id
        const savedSettings = (() => {
            try { return JSON.parse((sid ? localStorage.getItem(`shop_settings_${sid}`) : null) || '{}') } catch (_) { return {} }
        })()
        const freshLogo = (sid ? localStorage.getItem(`shop_logo_${sid}`) : null) || savedSettings.logo_url || shopSettings.logo_url || ''
        const mergedSettings = {
            ...shopSettings,
            ...savedSettings,
            logo_url: freshLogo,
            shop_id: sid,
            print_template: (sid ? localStorage.getItem(`print_template_${sid}`) : null) || savedSettings.print_template || localStorage.getItem('print_template') || '2'
        }
        mergedSettings.name = (sid ? localStorage.getItem(`shop_name_${sid}`) : null) || mergedSettings.name || BRAND.appName

        // Format items matching billTemplates expectations
        const formattedItems = items.map(i => {
            const returnedQty = i.returned_qty || 0
            const netQty = i.quantity - returnedQty
            
            const returnNote = returnedQty > 0 ? ` (Returned: ${returnedQty})` : ''
            return {
                name: (i.product_name || i.products?.name || '') + returnNote,
                qty: netQty,
                price: Number(i.unit_price || i.price || 0),
                sku: i.products?.sku || '',
                brand: i.products?.brand || ''
            }
        }).filter(i => i.qty > 0)

        const subtotal = items.reduce((sum, item) => sum + (Number(item.unit_price || item.price || 0) * (item.quantity - (item.returned_qty || 0))), 0)
        const discount = Number(p.discount || 0)
        const total = Math.max(0, subtotal - discount)

        // Construct supplier object matching billTemplates customer expectations
        const supplier = p.suppliers ? {
            name: p.suppliers.name,
            phone: p.suppliers.phone || '',
            address: p.suppliers.address || ''
        } : null

        const payload = {
            sale: {
                id: p.id,
                created_at: p.created_at,
                paid_amount: p.paid_amount,
                created_by: p.users?.username || 'Staff',
                payment_type: p.payment_type || p.payment_method
            },
            customer: supplier,
            walkInName: !supplier ? 'Unknown Supplier' : null,
            items: formattedItems,
            subtotal,
            totalDiscount: discount,
            total,
            change: 0
        }

        const html = buildBillHTML(payload, false, mergedSettings, true)
        printHTML(html)
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
            const item = purchases.find(p => p.id === id)
            if (!item) continue
            try {
                if (navigator.onLine) {
                    const { error } = await supabase.from('purchases').delete().eq('id', id)
                    if (error) {
                        console.error('Delete failed:', error)
                        failCount++
                        continue
                    }
                } else {
                    await addToSyncQueue('purchases', 'DELETE', { id })
                }

                await moveToTrash('purchases', id, item, user.id, user.shop_id)
                await db.purchases.delete(id)
                successfulIds.push(id)
                successCount++
            } catch (err) {
                console.error('Delete error:', err)
                failCount++
            }
        }

        setPurchases(prev => prev.filter(p => !successfulIds.includes(p.id)))
        setSelected([])

        if (failCount > 0) {
            alert(`⚠️ Partially completed.\n✅ Deleted: ${successCount}\n❌ Failed: ${failCount}\n\n👉 Yeh purchases mein ledger entries linked hain.\n\nSahi order:\n1. Pehle Purchase Items delete karein (Trash Bin > Purchase Items filter)\n2. Phir yeh purchases delete ho jayenge`)
        } else if (successCount > 0) {
            alert(`🗑️ ${successCount} purchase(s) moved to Trash!`)
        }
        fetchPurchases()
    }

    const toggleSelect = (id) => {
        setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
    }

    const toggleSelectAll = () => {
        if (selected.length === filtered.length) setSelected([])
        else setSelected(filtered.map(x => x.id))
    }

    const filtered = purchases.filter(p => {
        const matchSearch = (p.suppliers?.name || '').toLowerCase().includes(search.toLowerCase()) ||
            String(p.id).toLowerCase().includes(search.toLowerCase())
        const matchPayment = paymentFilter !== 'all' ? p.payment_type === paymentFilter : true
        const matchDate = dateFilter ? p.created_at?.startsWith(dateFilter) : true
        return matchSearch && matchPayment && matchDate
    })

    // Summary stats
    const totalPurchaseValue = filtered.reduce((sum, p) => sum + Number(p.total_amount || 0), 0)
    const cashCount = filtered.filter(p => p.payment_type === 'cash').length
    const creditCount = filtered.filter(p => p.payment_type === 'credit').length

    if (!hasFeature('purchases')) return <UpgradeWall feature="purchases" />

    return (
        <>
            <div>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                    <div>
                        <h1 className="text-2xl font-bold text-fg">📦 Purchase History</h1>
                        <p className="text-fg-muted text-sm">View and manage previous stock-in records</p>
                    </div>
                    <div className="flex gap-3 items-center overflow-x-auto pb-1 max-w-full">
                        {/* Summary cards */}
                        <div className="bg-surface px-4 py-2 rounded-xl shadow-sm border border-line-subtle text-center min-w-[100px]">
                            <p className="text-[10px] text-fg-subtle font-bold uppercase">Total</p>
                            <p className="text-sm font-bold text-primary-fg">Rs. {totalPurchaseValue.toLocaleString()}</p>
                        </div>
                        <div className="bg-surface px-3 py-2 rounded-xl shadow-sm border border-line-subtle text-center min-w-[100px]">
                            <p className="text-[10px] text-fg-subtle font-bold uppercase">Cash</p>
                            <p className="text-sm font-bold text-success-fg">{cashCount}</p>
                        </div>
                        <div className="bg-surface px-3 py-2 rounded-xl shadow-sm border border-line-subtle text-center min-w-[100px]">
                            <p className="text-[10px] text-fg-subtle font-bold uppercase">Credit</p>
                            <p className="text-sm font-bold text-warning-fg">{creditCount}</p>
                        </div>
                    </div>
                    {selected.length > 0 && (
                        <button onClick={() => requestDelete(selected)} className="px-4 py-2 bg-danger hover:bg-danger-hover text-white rounded-xl transition font-bold text-sm">
                            🗑️ Delete Selected ({selected.length})
                        </button>
                    )}
                </div>
                <div className="bg-surface p-4 rounded-xl shadow-sm border border-line-subtle flex flex-col sm:flex-row gap-4 items-start sm:items-center flex-wrap">
                    <input
                        type="text"
                        placeholder="Search PR- ID or Supplier..."
                        className="flex-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary outline-none w-full sm:w-auto"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                    <div className="flex gap-2 w-full sm:w-auto overflow-x-auto pb-1 items-center">
                        <select
                            className="px-4 py-2 border rounded-lg outline-none flex-shrink-0"
                            value={paymentFilter}
                            onChange={e => setPaymentFilter(e.target.value)}
                        >
                            <option value="all">All Payments</option>
                            <option value="cash">Cash Only</option>
                            <option value="credit">Credit Only</option>
                        </select>
                        <input
                            type="date"
                            className="px-4 py-2 border rounded-lg outline-none w-[140px] flex-shrink-0"
                            value={dateFilter}
                            onChange={e => setDateFilter(e.target.value)}
                        />
                        <button
                            onClick={handleExport}
                            className="px-4 py-2 bg-success-soft text-success-strong hover:bg-success-muted font-bold rounded-lg border border-success-line transition text-sm flex-shrink-0"
                        >
                            📤 Export Excel
                        </button>
                        <button
                            onClick={fetchPurchases}
                            className="p-2 text-fg-subtle hover:text-primary-fg transition flex-shrink-0"
                            title="Refresh Data"
                        >
                            🔄
                        </button>
                    </div>
                </div>

                {loading ? (
                    <p className="text-fg-muted italic">Loading purchase records...</p>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-12"><p className="text-fg-subtle text-lg">No purchases found.</p></div>
                ) : (
                    <div className="bg-surface rounded-xl shadow overflow-hidden">
                        <div className="divide-y divide-line-subtle md:hidden">
                            {filtered.map(p => (
                                <div key={p.id} className={`p-4 ${selected.includes(p.id) ? 'bg-primary-soft' : ''}`}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="font-mono text-xs font-bold text-fg-muted font-black">
                                                PR-{String(p.id).slice(-6)}
                                            </p>
                                            <p className="mt-1 truncate font-bold text-fg">
                                                {p.suppliers?.name || 'Unknown'}
                                            </p>
                                            <p className="mt-1 text-xs text-fg-subtle">{new Date(p.created_at).toLocaleDateString('en-PK')}</p>
                                        </div>
                                        <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggleSelect(p.id)} className="mt-1 h-4 w-4 rounded" />
                                    </div>
                                    <div className="mt-3 flex items-center justify-between gap-3">
                                        <div>
                                            <p className="text-lg font-black text-fg">
                                                Rs. {Number(p.total_amount).toLocaleString()}
                                            </p>
                                            <div className="mt-1 flex flex-wrap gap-1.5">
                                                <span className={`px-2 py-1 rounded-full text-xs font-medium ${p.payment_type === 'cash' ? 'bg-success-muted text-success-strong' : 'bg-warning-muted text-warning-strong'}`}>
                                                    {p.payment_type === 'cash' ? '💵 Cash' : '📒 Credit'}
                                                </span>
                                                {p.paid_amount != null && Number(p.paid_amount) < Number(p.total_amount) && (
                                                    <span className="bg-warning-soft text-warning-fg border border-warning-line px-2 py-0.5 rounded text-[10px] font-bold">
                                                        Paid: {Number(p.paid_amount).toLocaleString()}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={() => openPurchase(p)} className="rounded-lg bg-primary-soft px-3 py-2 text-sm font-bold text-primary-fg">View</button>
                                            <button onClick={() => requestDelete([p.id])} className="rounded-lg bg-danger-soft px-3 py-2 text-sm font-bold text-danger-fg">Delete</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="hidden overflow-x-auto md:block">
                            <table className="w-full">
                                <thead className="bg-surface-2 border-b">
                                    <tr>
                                        <th className="px-4 py-4 w-10"><input type="checkbox" checked={selected.length === filtered.length && filtered.length > 0} onChange={toggleSelectAll} className="w-4 h-4 rounded" /></th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-fg-muted uppercase whitespace-nowrap">Invoice ID</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-fg-muted uppercase whitespace-nowrap">Supplier</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-fg-muted uppercase whitespace-nowrap">Total</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-fg-muted uppercase whitespace-nowrap">Payment</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-fg-muted uppercase whitespace-nowrap">Date</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-fg-muted uppercase whitespace-nowrap">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-line">
                                    {filtered.map(p => (
                                        <tr key={p.id} className={`hover:bg-surface-2 transition ${selected.includes(p.id) ? 'bg-primary-soft' : ''}`}>
                                            <td className="px-4 py-3"><input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggleSelect(p.id)} className="w-4 h-4 rounded" /></td>
                                            <td className="px-4 py-3 font-mono text-xs text-primary-fg font-bold">PR-{String(p.id).slice(-6)}</td>
                                            <td className="px-4 py-3 text-fg font-medium">{p.suppliers?.name || <span className="text-fg-subtle italic">Unknown</span>}</td>
                                            <td className="px-4 py-3 font-medium text-fg">
                                                Rs. {Number(p.total_amount).toLocaleString()}
                                                {p.paid_amount != null && Number(p.paid_amount) < Number(p.total_amount) && (
                                                    <span className="text-xs text-warning-fg ml-1">(Paid: {Number(p.paid_amount).toLocaleString()})</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex flex-col gap-1">
                                                    <span className={`px-2 py-1 rounded-full text-xs font-medium w-fit ${p.payment_type === 'cash' ? 'bg-success-muted text-success-strong' : 'bg-warning-muted text-warning-strong'}`}>
                                                        {p.payment_type === 'cash' ? '💵 Cash' : '📒 Credit'}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-fg-muted text-sm">{new Date(p.created_at).toLocaleDateString('en-PK')}</td>
                                            <td className="px-4 py-3">
                                                <div className="flex gap-2">
                                                    <button onClick={() => openPurchase(p)}
                                                        className="text-primary-fg hover:text-primary-strong text-sm font-medium">View</button>
                                                    <button onClick={() => requestDelete([p.id])}
                                                        className="text-danger-fg hover:text-danger-strong text-sm font-medium">Delete</button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Detail Modal */}
                {selectedPurchase && (
                    <div className="fixed inset-0 bg-black/40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
                        <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-2xl max-h-[90dvh] overflow-y-auto">
                            <div className="flex justify-between items-start mb-4">
                                <div>
                                    <h2 className="text-lg font-bold text-fg">
                                        Purchase Invoice PR-{String(selectedPurchase.id).slice(-8)}
                                    </h2>
                                    <p className="text-sm text-fg-muted">
                                        {new Date(selectedPurchase.created_at).toLocaleString('en-PK')} |
                                        {' '}{selectedPurchase.suppliers?.name || 'Unknown'} |
                                        <span className={selectedPurchase.payment_type === 'cash' ? ' text-success-fg' : ' text-warning-fg'}>
                                            {' '}{selectedPurchase.payment_type?.toUpperCase()}
                                        </span>
                                    </p>
                                </div>
                                <button onClick={() => setSelectedPurchase(null)} className="text-fg-subtle hover:text-fg-3 text-xl">×</button>
                            </div>

                            {/* Info Grid */}
                            <div className="grid grid-cols-2 gap-4 mb-4 bg-surface-2 p-4 rounded-xl border border-line-subtle text-sm">
                                <p><span className="text-fg-subtle font-medium uppercase text-[10px] block">Supplier</span> <b>{selectedPurchase.suppliers?.name || 'Unknown'}</b></p>
                                <p><span className="text-fg-subtle font-medium uppercase text-[10px] block">Date</span> <b>{new Date(selectedPurchase.created_at).toLocaleString('en-PK')}</b></p>
                                <p><span className="text-fg-subtle font-medium uppercase text-[10px] block">Total Amount</span> <b className="text-lg">Rs. {Number(selectedPurchase.total_amount).toLocaleString()}</b></p>
                                <p><span className="text-fg-subtle font-medium uppercase text-[10px] block">Payment Type</span> <b className="uppercase">{selectedPurchase.payment_type}</b>
                                    {selectedPurchase.paid_amount != null && <span className="text-xs text-fg-subtle ml-2">(Paid: Rs. {Number(selectedPurchase.paid_amount).toLocaleString()})</span>}
                                </p>
                            </div>

                            {loadingItems ? (
                                <p className="text-center py-8 text-fg-muted">Loading items...</p>
                            ) : (
                                <>
                                    <div className="overflow-x-auto">
                                        <table className="w-full mb-6">
                                            <thead className="bg-surface-2">
                                                <tr>
                                                    <th className="px-4 py-3 text-left text-xs text-fg-muted uppercase font-bold whitespace-nowrap">Product</th>
                                                    <th className="px-4 py-3 text-right text-xs text-fg-muted uppercase font-bold whitespace-nowrap">Qty</th>
                                                    <th className="px-4 py-3 text-right text-xs text-fg-muted uppercase font-bold whitespace-nowrap">Rate</th>
                                                    <th className="px-4 py-3 text-right text-xs text-fg-muted uppercase font-bold whitespace-nowrap">Amount</th>
                                                    <th className="px-4 py-3 text-center text-xs text-fg-muted uppercase font-bold bg-warning-soft whitespace-nowrap">Ret. Qty</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-line-subtle">
                                                {purchaseItems.map((item, idx) => {
                                                    const maxReturn = item.quantity - (item.returned_qty || 0)
                                                    return (
                                                        <tr key={idx} className="hover:bg-surface-2">
                                                            <td className="px-4 py-3 text-fg whitespace-nowrap">{item.product_name}</td>
                                                            <td className="px-4 py-3 text-right text-fg-3 whitespace-nowrap">
                                                                {item.quantity}
                                                                {item.returned_qty > 0 && <span className="text-xs text-danger-fg ml-1 block">(-{item.returned_qty} ret)</span>}
                                                            </td>
                                                            <td className="px-4 py-3 text-right text-fg-3 whitespace-nowrap">Rs. {Number(item.unit_price).toFixed(0)}</td>
                                                            <td className="px-4 py-3 text-right font-medium text-fg whitespace-nowrap">Rs. {Number(item.total_price || item.line_total).toFixed(0)}</td>
                                                            <td className="px-4 py-3 text-center align-middle whitespace-nowrap">
                                                                {maxReturn > 0 ? (
                                                                    <input
                                                                        type="number"
                                                                        min="0"
                                                                        max={maxReturn}
                                                                        value={returnQtys[item.id] || ''}
                                                                        onChange={e => setReturnQtys(prev => ({ ...prev, [item.id]: e.target.value }))}
                                                                        className="w-16 border rounded px-2 py-1 text-center text-sm shadow-inner"
                                                                        placeholder="0"
                                                                    />
                                                                ) : (
                                                                    <span className="text-xs text-fg-subtle italic">Fully Ret</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    )
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-t border-line-subtle pt-4 mt-4 gap-4">
                                        <div className="text-sm">
                                            <p className="text-fg-muted">Total Amount: <b className="text-fg text-lg">Rs. {Number(selectedPurchase.total_amount).toLocaleString()}</b></p>
                                            {selectedPurchase.paid_amount != null && <p className="text-fg-muted">Paid Amount: <b className="text-fg">Rs. {Number(selectedPurchase.paid_amount).toLocaleString()}</b></p>}
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <button onClick={() => printPurchase(selectedPurchase, purchaseItems)}
                                                className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm transition">
                                                🖨️ Print Invoice
                                            </button>
                                            <button onClick={handleReturn} disabled={returning}
                                                className="px-4 py-2 bg-danger hover:bg-danger-hover text-white rounded-lg text-sm transition disabled:opacity-50">
                                                {returning ? 'Processing...' : '↩️ Process Return'}
                                            </button>
                                            <button onClick={() => setSelectedPurchase(null)}
                                                className="px-4 py-2 bg-surface-3 hover:bg-surface-4 text-fg-2 rounded-lg text-sm transition">
                                                Close
                                            </button>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {
                showPasswordModal && (
                    <PasswordModal
                        title="Delete Purchase(s)"
                        message={`${pendingDeleteIds.length} purchase(s) will be moved to Trash`}
                        onConfirm={executeDelete}
                        onCancel={() => { setShowPasswordModal(false); setPendingDeleteIds([]) }}
                    />
                )
            }
        </>
    )
}

export default PurchaseHistory
