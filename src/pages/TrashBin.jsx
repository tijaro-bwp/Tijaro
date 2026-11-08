import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { db, restoreFromTrash, addToSyncQueue } from '../services/db'
import { applySaleEffects, saleRowOnly, isNetworkError } from '../services/integrity'
import PasswordModal from '../components/PasswordModal'
import { hasFeature } from '../utils/featureGate'
import UpgradeWall from '../components/UpgradeWall'

// Deletion priority — lower number = delete first (no dependencies)
const DELETION_ORDER = {
    sale_items: 1,
    purchase_items: 1,
    expenses: 2,
    sales: 3,
    purchases: 3,
    products: 4,
    customers: 5,
    suppliers: 5,
}

const SAFETY_BADGE = {
    sale_items: { label: 'Safe to delete', color: 'bg-success-muted text-success-strong' },
    purchase_items: { label: 'Safe to delete', color: 'bg-success-muted text-success-strong' },
    expenses: { label: 'Safe to delete', color: 'bg-success-muted text-success-strong' },
    sales: { label: 'Delete after items', color: 'bg-warning-muted text-warning-strong' },
    purchases: { label: 'Delete after items', color: 'bg-warning-muted text-warning-strong' },
    products: { label: 'Delete last', color: 'bg-danger-muted text-danger-fg' },
    customers: { label: 'Delete last', color: 'bg-danger-muted text-danger-fg' },
    suppliers: { label: 'Delete last', color: 'bg-danger-muted text-danger-fg' },
}

function TrashBin() {
    const { user } = useAuth()
    const [trashItems, setTrashItems] = useState([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState([])
    const [filterTable, setFilterTable] = useState('')
    const [showPasswordModal, setShowPasswordModal] = useState(false)
    const [pendingAction, setPendingAction] = useState(null)
    const [showGuide, setShowGuide] = useState(false)

    useEffect(() => {
        fetchTrash()
    }, [])

    const fetchTrash = async () => {
        setLoading(true)
        try {
            const all = await db.trash.toArray()
            const sid = String(user.shop_id)
            const sorted = all
                .filter(x => String(x.shop_id) === sid)
                .sort((a, b) => {
                    const orderDiff = (DELETION_ORDER[a.original_table] || 9) - (DELETION_ORDER[b.original_table] || 9)
                    if (orderDiff !== 0) return orderDiff
                    return new Date(b.deleted_at) - new Date(a.deleted_at)
                })
            setTrashItems(sorted)
        } catch (err) {
            console.error('Trash fetch error:', err)
        } finally {
            setLoading(false)
        }
    }

    const getItemLabel = (item) => {
        const d = item.data
        if (d?.name) return d.name
        if (d?.product_name) return d.product_name
        if (d?.note) return d.note
        if (d?.category) return `${d.category} - Rs. ${d.amount}`
        return `#${String(item.original_id).slice(-8)}`
    }

    const tableLabels = {
        products: '📦 Product',
        suppliers: '🚚 Supplier',
        customers: '👥 Customer',
        expenses: '💸 Expense',
        purchases: '🛒 Purchase',
        sales: '📜 Sale',
        purchase_items: '📋 Purchase Item',
        sale_items: '📋 Sale Item'
    }

    // Restore a deleted sale completely: header + line items, then take the stock
    // out again and re-add its unpaid amount to the customer (undone on delete).
    const restoreSale = async (item) => {
        const lineItems = Array.isArray(item.data?.__items) ? item.data.__items : []
        const header = saleRowOnly(item.data)
        let online = navigator.onLine
        if (online) {
            const { error } = await supabase.from('sales').upsert([header])
            if (error && !isNetworkError(error)) throw new Error(`Sale #${String(header.id).slice(-8)}: ${error.message}`)
            if (error) online = false
            else if (lineItems.length) {
                const { error: itemsErr } = await supabase.from('sale_items').upsert(lineItems)
                if (itemsErr && !isNetworkError(itemsErr)) throw new Error(`Sale #${String(header.id).slice(-8)} items: ${itemsErr.message}`)
                if (itemsErr) await addToSyncQueue('sale_items', 'INSERT', lineItems)
            }
        }
        if (!online) {
            await addToSyncQueue('sales', 'INSERT', header)
            if (lineItems.length) await addToSyncQueue('sale_items', 'INSERT', lineItems)
        }
        await db.sales.put(header)
        if (lineItems.length) await db.sale_items.bulkPut(lineItems)
        await db.trash.delete(item.id)
        // Sales deleted before this fix never had stock/balance reversed — don't apply them twice
        if (!Array.isArray(item.data?.__items)) return []
        return applySaleEffects(header, lineItems, 'apply')
    }

    const handleRestore = async (items) => {
        try {
            const effectFailures = []
            for (const item of items) {
                if (item.original_table === 'sales') {
                    const failed = await restoreSale(item)
                    if (failed.length) effectFailures.push(`#${String(item.original_id).slice(-8)}: ${failed.join(', ')}`)
                    continue
                }
                await restoreFromTrash(item)
                if (navigator.onLine) {
                    const { error } = await supabase.from(item.original_table).upsert([item.data])
                    if (error && !isNetworkError(error)) throw new Error(`${item.original_table}: ${error.message}`)
                    if (error) await addToSyncQueue(item.original_table, 'INSERT', item.data)
                } else {
                    await addToSyncQueue(item.original_table, 'INSERT', item.data)
                }
            }
            if (effectFailures.length) {
                alert(`Restored, but some stock/balance updates failed:\n${effectFailures.join('\n')}`)
            }
            alert(`✅ ${items.length} item(s) restored successfully!`)
            setSelected([])
            fetchTrash()
        } catch (err) {
            alert('Restore failed: ' + err.message)
        }
    }

    const handlePermanentDelete = async (items) => {
        try {
            for (const item of items) {
                await db.trash.delete(item.id)
            }
            alert(`🗑️ ${items.length} item(s) permanently deleted!`)
            setSelected([])
            fetchTrash()
        } catch (err) {
            alert('Delete failed: ' + err.message)
        }
    }

    const handleDeleteInOrder = async (items) => {
        const sorted = [...items].sort((a, b) =>
            (DELETION_ORDER[a.original_table] || 9) - (DELETION_ORDER[b.original_table] || 9)
        )
        await handlePermanentDelete(sorted)
    }

    const requestPasswordAction = (action, items) => {
        setPendingAction({ action, items })
        setShowPasswordModal(true)
    }

    const onPasswordConfirm = () => {
        setShowPasswordModal(false)
        if (pendingAction?.action === 'delete') {
            handlePermanentDelete(pendingAction.items)
        } else if (pendingAction?.action === 'delete_ordered') {
            handleDeleteInOrder(pendingAction.items)
        } else if (pendingAction?.action === 'restore') {
            handleRestore(pendingAction.items)
        }
        setPendingAction(null)
    }

    const toggleSelect = (id) => {
        setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
    }

    const toggleSelectAll = () => {
        if (selected.length === filtered.length) {
            setSelected([])
        } else {
            setSelected(filtered.map(x => x.id))
        }
    }

    const filtered = trashItems.filter(x => filterTable ? x.original_table === filterTable : true)
    const uniqueTables = [...new Set(trashItems.map(x => x.original_table))]

    if (!hasFeature('trash_bin')) return <UpgradeWall feature="trash_bin" />

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-fg">🗑️ Trash Bin</h1>
                    <p className="text-fg-muted text-sm">Deleted items can be restored or permanently removed</p>
                </div>
                <div className="flex gap-2 items-center flex-wrap">
                    <select
                        className="px-4 py-2 border rounded-lg outline-none text-sm"
                        value={filterTable}
                        onChange={e => setFilterTable(e.target.value)}
                    >
                        <option value="">All Types ({trashItems.length})</option>
                        {uniqueTables.map(t => (
                            <option key={t} value={t}>{tableLabels[t] || t} ({trashItems.filter(x => x.original_table === t).length})</option>
                        ))}
                    </select>

                    {selected.length > 0 && (
                        <>
                            <button
                                onClick={() => {
                                    const items = filtered.filter(x => selected.includes(x.id))
                                    handleRestore(items)
                                }}
                                className="px-4 py-2 bg-success hover:bg-success-hover text-white rounded-lg transition font-bold text-sm"
                            >
                                ♻️ Restore Selected ({selected.length})
                            </button>
                            <button
                                onClick={() => {
                                    const items = filtered.filter(x => selected.includes(x.id))
                                    requestPasswordAction('delete', items)
                                }}
                                className="px-4 py-2 bg-danger hover:bg-danger-hover text-white rounded-lg transition font-bold text-sm"
                            >
                                🔥 Delete Forever ({selected.length})
                            </button>
                        </>
                    )}

                    {trashItems.length > 0 && (
                        <>
                            <button
                                onClick={() => requestPasswordAction('delete_ordered', trashItems)}
                                className="px-4 py-2 border border-primary-line bg-primary-soft hover:bg-primary-muted text-primary-strong rounded-lg transition font-bold text-sm"
                            >
                                🔄 Delete In Order
                            </button>
                            <button
                                onClick={() => requestPasswordAction('delete', trashItems)}
                                className="px-4 py-2 border border-danger-line bg-danger-soft hover:bg-danger-muted text-danger-strong rounded-lg transition font-bold text-sm"
                            >
                                Empty Trash
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Deletion Order Guide */}
            <div className="bg-warning-soft border border-warning-line rounded-xl overflow-hidden">
                <button
                    onClick={() => setShowGuide(g => !g)}
                    className="w-full flex items-center justify-between px-4 py-3 text-warning-strong font-bold text-sm text-left"
                >
                    <span>💡 Deletion Order Guide — Kya pehle delete karein?</span>
                    <span className="text-xs">{showGuide ? '▲ Band karein' : '▼ Dekhein'}</span>
                </button>
                {showGuide && (
                    <div className="px-4 pb-4 text-sm text-warning-strong space-y-3">
                        <p className="text-xs text-warning-strong italic">Agar deletion fail ho raha hai (Foreign Key error), neeche diya hua order follow karein:</p>
                        <ol className="space-y-2">
                            <li className="flex items-start gap-2">
                                <span className="bg-success-muted text-success-strong font-bold px-2 py-0.5 rounded text-xs min-w-fit">Step 1</span>
                                <span><strong>📋 Sale Items & Purchase Items</strong> — Pehle yeh delete karein. Inke koi children nahi hote.</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <span className="bg-warning-muted text-warning-strong font-bold px-2 py-0.5 rounded text-xs min-w-fit">Step 2</span>
                                <span><strong>📜 Sales & 🛒 Purchases</strong> — Sale/Purchase Items delete hone ke baad yeh delete ho sakte hain.</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <span className="bg-danger-muted text-danger-strong font-bold px-2 py-0.5 rounded text-xs min-w-fit">Step 3</span>
                                <span><strong>📦 Products / 👥 Customers / 🚚 Suppliers</strong> — Sab sales/purchases clear hone ke baad in ko delete karein.</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <span className="bg-surface-3 text-fg-2 font-bold px-2 py-0.5 rounded text-xs min-w-fit">Any time</span>
                                <span><strong>💸 Expenses</strong> — Kabhi bhi delete ho sakte hain, koi dependency nahi.</span>
                            </li>
                        </ol>
                        <p className="text-xs text-warning-strong bg-warning-muted px-3 py-2 rounded-lg">
                            💡 <strong>Shortcut:</strong> "<strong>🔄 Delete In Order</strong>" button use karein — yeh automatically sahi order mein delete karta hai.
                        </p>
                    </div>
                )}
            </div>

            <div className="bg-surface rounded-xl shadow-sm border border-line-subtle overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-surface-2 border-b">
                            <tr>
                                <th className="px-4 py-3 w-10">
                                    <input
                                        type="checkbox"
                                        checked={selected.length === filtered.length && filtered.length > 0}
                                        onChange={toggleSelectAll}
                                        className="w-4 h-4 rounded"
                                    />
                                </th>
                                <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase">Type</th>
                                <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase">Name / Description</th>
                                <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase hidden sm:table-cell">Status</th>
                                <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase">Deleted On</th>
                                <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-line-subtle">
                            {loading ? (
                                <tr><td colSpan="6" className="px-6 py-12 text-center text-fg-subtle">Loading trash...</td></tr>
                            ) : filtered.length === 0 ? (
                                <tr><td colSpan="6" className="px-6 py-12 text-center text-fg-subtle italic">
                                    {trashItems.length === 0 ? '🎉 Trash is empty! No deleted items.' : 'No items match the filter.'}
                                </td></tr>
                            ) : filtered.map(item => {
                                const badge = SAFETY_BADGE[item.original_table]
                                return (
                                    <tr key={item.id} className="hover:bg-surface-2 transition">
                                        <td className="px-4 py-3">
                                            <input
                                                type="checkbox"
                                                checked={selected.includes(item.id)}
                                                onChange={() => toggleSelect(item.id)}
                                                className="w-4 h-4 rounded"
                                            />
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="px-2 py-1 bg-surface-3 text-fg-3 rounded-full text-[10px] font-bold uppercase">
                                                {tableLabels[item.original_table] || item.original_table}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 font-medium text-fg">{getItemLabel(item)}</td>
                                        <td className="px-4 py-3 hidden sm:table-cell">
                                            {badge && (
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badge.color}`}>
                                                    {badge.label}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-fg-muted">
                                            {new Date(item.deleted_at).toLocaleString('en-PK')}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <div className="flex justify-center gap-2">
                                                <button
                                                    onClick={() => handleRestore([item])}
                                                    className="px-3 py-1 bg-success-soft hover:bg-success-muted text-success-strong rounded-lg text-xs font-bold transition"
                                                >
                                                    ♻️ Restore
                                                </button>
                                                <button
                                                    onClick={() => requestPasswordAction('delete', [item])}
                                                    className="px-3 py-1 bg-danger-soft hover:bg-danger-muted text-danger-strong rounded-lg text-xs font-bold transition"
                                                >
                                                    🔥 Delete
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {showPasswordModal && (
                <PasswordModal
                    title="Confirm Action"
                    message="Enter your password to proceed with this critical operation"
                    onConfirm={onPasswordConfirm}
                    onCancel={() => { setShowPasswordModal(false); setPendingAction(null) }}
                />
            )}
        </div>
    )
}

export default TrashBin
