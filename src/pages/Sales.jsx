import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { fetchAllRows } from '../services/fetchAll'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import { db, addToSyncQueue, moveToTrash } from '../services/db'
import { adjustStock, adjustCustomerBalance, isNetworkError, applySaleEffects, saleRowOnly, saleUnpaidAmount, splitReturnRefund } from '../services/integrity'
import { recordAuditLog } from '../services/auditService'
import PasswordModal from '../components/PasswordModal'
import { printHTML } from '../utils/printUtils'
import { buildBillHTML } from '../utils/billTemplates'
import { getShopSettings, isWholesaleEnabled } from '../utils/businessPresets'
import { BRAND } from '../config/brand.js'

function Sales() {
  const { user } = useAuth()
  const wholesaleEnabled = isWholesaleEnabled(getShopSettings(user?.shop_id))
  const navigate = useNavigate()
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedSale, setSelectedSale] = useState(null)
  const [saleItems, setSaleItems] = useState([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [returning, setReturning] = useState(false)
  const [returnQtys, setReturnQtys] = useState({})
  const [search, setSearch] = useState('')
  const [searchDate, setSearchDate] = useState('')
  const [filterType, setFilterType] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [tierFilter, setTierFilter] = useState('all') // 'all' | 'retail' | 'wholesale'
  const [dateFilter, setDateFilter] = useState('')
  const [refundType, setRefundType] = useState('cash') // 'cash' or 'credit'
  const [selected, setSelected] = useState([])
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [pendingDeleteIds, setPendingDeleteIds] = useState([])

  const [shopSettings, setShopSettings] = useState({})

  useEffect(() => {
    if (user?.shop_id) {
      fetchShopSettings()
      fetchSales()
    }
  }, [user?.shop_id])

  const fetchShopSettings = async () => {
    // Read from shop-scoped localStorage first for instant load
    const sid = user?.shop_id
    const cached = sid ? localStorage.getItem(`shop_settings_${sid}`) : null
    if (cached) {
      try { setShopSettings(JSON.parse(cached)) } catch (_) {}
    }
    try {
      if (!navigator.onLine) throw new Error('Offline')
      const { data } = await supabase.from('shops').select('*').eq('id', user.shop_id).maybeSingle()
      if (data) setShopSettings(prev => ({ ...prev, ...data }))
    } catch (e) {
      console.log('Sales: Using cached shop settings')
    }
  }

  const fetchSales = async () => {
    if (!user?.shop_id) {
      setLoading(false)
      console.error('Sales: Missing user.shop_id!')
      return
    }

    const sid = String(user.shop_id)

    // ── Step 1: Show local IndexedDB data IMMEDIATELY (instant UI) ────────────
    try {
      const localData = await db.sales.toArray()
      const filtered = localData.filter(x => String(x.shop_id) === sid)
      const sorted = filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      setSales(sorted)
      if (sorted.length > 0) {
        setLoading(false)
      }
    } catch (localErr) {
      console.warn('Sales: Local DB read failed:', localErr)
    }

    // ── Step 2: Background refresh from Supabase (updates UI silently) ────────
    if (!navigator.onLine) {
      setLoading(false)
      return
    }

    try {
      const fetchPromise = fetchAllRows(() => supabase
        .from('sales')
        .select('*, customers(name)')
        .eq('shop_id', user.shop_id)
        .order('created_at', { ascending: false }))

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
      const { data, error } = await Promise.race([fetchPromise, timeoutPromise])

      if (error) throw error
      if (data) {
        const cleanData = JSON.parse(JSON.stringify(data))
        await db.sales.bulkPut(cleanData)
      }

      const localData = await db.sales.toArray()
      const filtered = localData.filter(x => String(x.shop_id) === sid)
      const sorted = filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      setSales(sorted)
    } catch (e) {
      console.warn('Sales: Supabase background refresh failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const openSale = async (sale) => {
    setSelectedSale(sale)
    setReturnQtys({})
    setLoadingItems(true)
    try {
      if (!navigator.onLine) throw new Error('Offline')
      const fetchPromise = supabase
        .from('sale_items')
        .select('*, products(name, stock_quantity)')
        .eq('sale_id', sale.id)

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
      const { data, error } = await Promise.race([fetchPromise, timeoutPromise])

      if (error) throw error
      if (data) {
        const cleanData = JSON.parse(JSON.stringify(data))
        await db.sale_items.bulkPut(cleanData)
      }

      // Render from local for consistency
      const localItems = await db.sale_items.where({ sale_id: sale.id }).toArray()
      setSaleItems(localItems)
    } catch (e) {
      console.log('Sale Items: Fetching from local DB (Offline Fallback)')
      const localItems = await db.sale_items.where({ sale_id: sale.id }).toArray().catch(() => [])
      // fallback if composite index is weird, just get all and filter
      if (localItems.length === 0) {
        const all = await db.sale_items.toArray()
        setSaleItems(all.filter(i => i.sale_id === sale.id))
      } else {
        setSaleItems(localItems)
      }
    }
    setLoadingItems(false)
  }

  // Handle return
  const handleReturn = async () => {
    // Number() (not parseInt) so fractional quantities like 0.5 kg can be returned
    const qtyOf = (item) => Number(returnQtys[item.id]) || 0
    const itemsToReturn = saleItems.filter(i => qtyOf(i) > 0)
    if (itemsToReturn.length === 0) { alert('Return karne ke liye qty enter karo!'); return }

    for (const item of itemsToReturn) {
      const maxReturn = Number(item.quantity) - Number(item.returned_qty || 0)
      if (qtyOf(item) > maxReturn) { alert(`${item.product_name}: max ${maxReturn} return ho sakta hai`); return }
    }

    setReturning(true)
    // Refund what the customer actually paid for the goods: the bill discount is shared
    // across items, and unpaid (credit) goods are taken off the balance, not refunded in cash.
    const plan = splitReturnRefund({
      sale: selectedSale,
      saleItems,
      returnLines: itemsToReturn.map(it => ({ unit_price: it.unit_price, qty: qtyOf(it) })),
      refundType,
      unpaidOnSale: saleUnpaidAmount(selectedSale),
    })
    const totalReturnAmount = plan.refund
    const newSaleTotal = plan.newTotal
    const invoiceTag = `Invoice #${String(selectedSale.id).slice(-6)}`
    const refundRows = []
    if (plan.creditPart > 0) refundRows.push({ shop_id: user.shop_id, customer_id: selectedSale.customer_id, amount: -plan.creditPart, payment_type: 'return', note: `Return from ${invoiceTag} (Credited to Balance)` })
    if (plan.cashPart > 0) refundRows.push({ shop_id: user.shop_id, customer_id: selectedSale.customer_id || null, amount: -plan.cashPart, payment_type: 'refund', note: `Cash Refund from ${invoiceTag}` })
    const saleUpdate = { total_amount: plan.newTotal, discount: plan.newDiscount, paid_amount: plan.newPaid }

    // Each step is recorded once — if the network drops halfway, the remaining
    // steps are queued instead of re-applying the ones that already succeeded.
    const done = { items: new Set(), saleTotal: false, refund: false }
    let wentOffline = false

    const applyItemLocally = async (item) => {
      const newRetQty = Number(item.returned_qty || 0) + qtyOf(item)
      await db.sale_items.update(item.id, { returned_qty: newRetQty }).catch(() => {})
      await addToSyncQueue('sale_items', 'UPDATE', { id: item.id, returned_qty: newRetQty })
    }

    try {
      for (const item of itemsToReturn) {
        const newRetQty = Number(item.returned_qty || 0) + qtyOf(item)
        if (!wentOffline && navigator.onLine) {
          const { error } = await supabase.from('sale_items').update({ returned_qty: newRetQty }).eq('id', item.id)
          if (error && !isNetworkError(error)) throw error
          if (error) wentOffline = true
          else await db.sale_items.update(item.id, { returned_qty: newRetQty }).catch(() => {})
        } else {
          wentOffline = true
        }
        if (wentOffline) await applyItemLocally(item)
        // Atomic +qty (queued automatically when offline)
        const r = await adjustStock(item.product_id, qtyOf(item))
        if (!r.ok) throw r.error || new Error(`Stock update failed for ${item.product_name}`)
        done.items.add(item.id)
      }

      // Sale total
      if (!wentOffline && navigator.onLine) {
        const { error } = await supabase.from('sales').update(saleUpdate).eq('id', selectedSale.id)
        if (error && !isNetworkError(error)) throw error
        if (error) wentOffline = true
      } else wentOffline = true
      await db.sales.update(selectedSale.id, saleUpdate).catch(() => {})
      if (wentOffline) await addToSyncQueue('sales', 'UPDATE', { id: selectedSale.id, ...saleUpdate })
      done.saleTotal = true

      // Credit part reduces the customer's balance; cash part is handed back and logged
      if (plan.creditPart > 0 && selectedSale.customer_id) {
        const r = await adjustCustomerBalance(selectedSale.customer_id, -plan.creditPart)
        if (!r.ok) throw r.error || new Error('Customer balance update failed')
      }
      if (refundRows.length > 0) {
        let logged = false
        if (!wentOffline && navigator.onLine) {
          const { error } = await supabase.from('customer_payments').insert(refundRows)
          if (error && !isNetworkError(error)) throw error
          logged = !error
        }
        if (!logged) {
          const now = new Date().toISOString()
          for (const row of refundRows) {
            const localRow = { ...row, id: crypto.randomUUID(), created_at: now }
            await db.customer_payments.add(localRow).catch(() => {})
            await addToSyncQueue('customer_payments', 'INSERT', localRow)
          }
          wentOffline = true
        }
      }
      done.refund = true

      await recordAuditLog(
        'SALE_RETURN',
        'sales',
        selectedSale.id,
        {
          invoice: selectedSale.id,
          returned_amount: totalReturnAmount,
          items: itemsToReturn.map(it => ({ name: it.product_name, qty: qtyOf(it) }))
        },
        user.id,
        user.shop_id
      )

      setReturnQtys({})
      if (wentOffline) {
        alert('Offline mode: Return processed locally. Stock and Invoice updated! 🔄')
        setSelectedSale({ ...selectedSale, ...saleUpdate })
        const localUpdated = await db.sale_items.where({ sale_id: selectedSale.id }).toArray().catch(() => [])
        if (localUpdated.length > 0) setSaleItems(localUpdated)
      } else {
        alert(`Return successful! Invoice updated.\nCash to give back: Rs. ${plan.cashPart.toFixed(0)}${plan.creditPart > 0 ? `\nTaken off customer balance: Rs. ${plan.creditPart.toFixed(0)}` : ''}`)
        const { data: updatedSale } = await supabase.from('sales').select('*, customers(name)').eq('id', selectedSale.id).maybeSingle()
        if (updatedSale) setSelectedSale(updatedSale)
        const { data: updatedItems } = await supabase.from('sale_items').select('*, products(name, stock_quantity)').eq('sale_id', selectedSale.id)
        if (updatedItems) {
          const cleanItems = JSON.parse(JSON.stringify(updatedItems))
          await db.sale_items.bulkPut(cleanItems)
          setSaleItems(cleanItems)
        }
      }
      fetchSales()
    } catch (err) {
      const finished = `${done.items.size}/${itemsToReturn.length} items${done.saleTotal ? ', invoice total' : ''}${done.refund ? ', refund' : ''}`
      alert(`Error processing return: ${err?.message || err}\nCompleted before the error: ${finished}. Please review this invoice before retrying.`)
    } finally {
      setReturning(false)
    }
  }

  const printInvoice = (sale, items) => {
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
    })

    const subtotal = items.reduce((sum, item) => sum + (Number(item.unit_price || item.price || 0) * (item.quantity - (item.returned_qty || 0))), 0)
    const discount = Number(sale.discount || 0)
    const total = Math.max(0, subtotal - discount)
    const change = sale.payment_details?.change || 0

    // Construct customer object matching billTemplates expectations
    const customer = sale.customers ? {
      name: sale.customers.name,
      phone: sale.customers.phone || '',
      address: sale.customers.address || ''
    } : null

    const payload = {
      sale: {
        id: sale.id,
        created_at: sale.created_at,
        paid_amount: sale.paid_amount ?? sale.amount_paid, // column is paid_amount (amount_paid only in the old schema file)
        created_by: sale.users?.username || 'Staff',
        payment_type: sale.payment_type || sale.payment_method,
        price_tier: sale.price_tier
      },
      customer,
      walkInName: !customer ? (sale.customer_name || 'Walk-in') : null,
      items: formattedItems,
      subtotal,
      totalDiscount: discount,
      total,
      change
    }

    const html = buildBillHTML(payload, sale.sale_type === 'quotation', mergedSettings)
    printHTML(html)
  }

  const renderPaymentBadge = (sale) => {
    const pt = (sale.payment_type || sale.payment_method || 'cash').toLowerCase()
    if (pt === 'cash') {
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-surface-3 text-fg-2">💵 Cash</span>
    }
    if (pt === 'credit') {
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-warning-muted text-warning-strong">📒 Credit</span>
    }
    if (pt === 'split') {
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-info-muted text-info-strong">🔀 Split</span>
    }
    const label = pt.charAt(0).toUpperCase() + pt.slice(1)
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary-muted text-primary-strong">📱 {label}</span>
  }

  const filtered = sales.filter(s => {
    const matchSearch = (s.customers?.name || s.customer_name || 'walk-in').toLowerCase().includes(search.toLowerCase()) ||
      String(s.id).toLowerCase().includes(search.toLowerCase())
    const matchType = typeFilter !== 'all' ? s.sale_type === typeFilter : true
    const sPay = (s.payment_type || s.payment_method || 'cash').toLowerCase()
    const matchPayment = paymentFilter !== 'all' ? (
      paymentFilter === 'cash' ? sPay === 'cash' :
      paymentFilter === 'credit' ? sPay === 'credit' :
      paymentFilter === 'split' ? sPay === 'split' :
      paymentFilter === 'online' ? (sPay !== 'cash' && sPay !== 'credit' && sPay !== 'split' && sPay !== 'quotation') :
      sPay === paymentFilter
    ) : true
    const matchDate = dateFilter ? s.created_at?.startsWith(dateFilter) : true
    const sTier = s.price_tier === 'wholesale' ? 'wholesale' : 'retail'
    const matchTier = wholesaleEnabled && tierFilter !== 'all' ? sTier === tierFilter : true
    return matchSearch && matchType && matchPayment && matchDate && matchTier
  })

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

    const effectFailures = []
    for (const id of ids) {
      const item = sales.find(s => s.id === id)
      if (!item) continue
      try {
        // Line items are needed to put stock back and to restore the sale from Trash later
        let lineItems = []
        if (navigator.onLine) {
          const { data: remoteItems, error: itemsErr } = await supabase.from('sale_items').select('*').eq('sale_id', id)
          if (itemsErr && !isNetworkError(itemsErr)) throw itemsErr
          lineItems = remoteItems || []
        }
        if (lineItems.length === 0) {
          lineItems = await db.sale_items.where({ sale_id: id }).toArray().catch(() => [])
        }

        if (navigator.onLine) {
          // Cascade: delete sale_items first, then sale
          const { error: delItemsErr } = await supabase.from('sale_items').delete().eq('sale_id', id)
          if (delItemsErr) throw delItemsErr
          const { error } = await supabase.from('sales').delete().eq('id', id)
          if (error) {
            console.error('Delete failed:', error)
            // Put the line items back so the sale is not left without its items
            if (lineItems.length) await supabase.from('sale_items').upsert(lineItems.map(saleRowOnly))
            failCount++
            continue
          }
        } else {
          // Offline: queue both deletions
          for (const it of lineItems) {
            await addToSyncQueue('sale_items', 'DELETE', { id: it.id })
          }
          await addToSyncQueue('sales', 'DELETE', { id })
        }
        // Remove from local IndexedDB
        await db.sale_items.where({ sale_id: id }).delete().catch(() => {})

        // Undo what the sale did: return remaining stock, remove its unpaid amount from the customer
        const failed = await applySaleEffects(item, lineItems, 'reverse')
        if (failed.length) effectFailures.push(`#${String(id).slice(-8)}: ${failed.join(', ')}`)

        // Keep header + items together so Trash can restore the complete sale
        const clean = (o) => JSON.parse(JSON.stringify(o))
        await moveToTrash('sales', id, { ...saleRowOnly(item), __items: clean(lineItems.map(saleRowOnly)) }, user.id, user.shop_id)
        await db.sales.delete(id)
        successfulIds.push(id)
        successCount++
      } catch (err) {
        console.error('Delete error:', err)
        failCount++
      }
    }
    if (effectFailures.length) {
      alert(`Sales deleted, but some stock/balance reversals failed:\n${effectFailures.join('\n')}\nPlease check these products / customers.`)
    }

    setSales(prev => prev.filter(s => !successfulIds.includes(s.id)))
    setSelected([])

    if (failCount > 0) {
      alert(`⚠️ Partially completed.\n✅ Deleted: ${successCount}\n❌ Failed: ${failCount}\n\n👉 Yeh sales mein payments ya ledger entries linked hain.\n\nSahi order:\n1. Pehle Sale Items delete karein (Trash Bin > Sale Items filter)\n2. Phir yeh sales delete ho jayengi`)
    } else if (successCount > 0) {
      alert(`🗑️ ${successCount} sale(s) moved to Trash!`)
    }
    fetchSales()
  }

  const toggleSelect = (id) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const toggleSelectAll = () => {
    if (selected.length === filtered.length) setSelected([])
    else setSelected(filtered.map(x => x.id))
  }

  return (
    <>
      <div>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <h1 className="text-2xl font-bold text-fg">📜 Sales History</h1>
          <div className="flex gap-2 flex-wrap items-center">
            {selected.length > 0 && (
              <button onClick={() => requestDelete(selected)} className="px-4 py-2 bg-danger hover:bg-danger-hover text-white rounded-xl transition font-bold text-sm">
                🗑️ Delete Selected ({selected.length})
              </button>
            )}
          </div>
        </div>
        {/* Filters */}
        <div className="bg-surface p-4 rounded-xl shadow-sm border border-line-subtle mb-6 flex flex-col sm:flex-row gap-4 items-start sm:items-center flex-wrap">
          <div className="flex gap-4 w-full sm:w-auto">
            <input
              type="text"
              placeholder="Search invoice or customer..."
              className="flex-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary outline-none"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-2 w-full sm:w-auto overflow-x-auto pb-1 items-center">
            <select className="px-4 py-2 border rounded-lg outline-none flex-shrink-0" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="all">All Types</option>
              <option value="quotation">Quotations Only</option>
              <option value="sale">Sales Only</option>
            </select>
            <select className="px-4 py-2 border rounded-lg outline-none flex-shrink-0 bg-surface text-sm" value={paymentFilter} onChange={e => setPaymentFilter(e.target.value)}>
              <option value="all">All Payments</option>
              <option value="cash">💵 Cash Only</option>
              <option value="online">📱 Online / Bank</option>
              <option value="credit">📒 Credit Only</option>
              <option value="split">🔀 Split Payment</option>
            </select>
            {wholesaleEnabled && (
              <select aria-label="Price tier" className="px-4 py-2 border rounded-lg outline-none flex-shrink-0 bg-surface text-sm" value={tierFilter} onChange={e => setTierFilter(e.target.value)}>
                <option value="all">Retail + Wholesale</option>
                <option value="retail">Retail Only</option>
                <option value="wholesale">Wholesale Only</option>
              </select>
            )}
            <input
              type="date"
              className="px-4 py-2 border rounded-lg outline-none w-[140px] flex-shrink-0"
              value={dateFilter}
              onChange={e => setDateFilter(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <p className="text-fg-muted">Loading sales...</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-fg-subtle text-lg">No sales found</p>
          </div>
        ) : (
          <div className="bg-surface rounded-xl shadow overflow-hidden">
            <div className="divide-y divide-line-subtle md:hidden">
              {filtered.map(sale => (
                <div key={sale.id} className={`p-4 ${selected.includes(sale.id) ? 'bg-primary-soft' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-bold text-fg-muted">
                        {sale.sale_type === 'quotation' ? 'QT-' : '#'}{String(sale.id).slice(-8)}
                      </p>
                      <p className="mt-1 truncate font-bold text-fg">
                        {sale.customers?.name || sale.customer_name || 'Walk-in'}
                      </p>
                      <p className="mt-1 text-xs text-fg-subtle">{new Date(sale.created_at).toLocaleDateString('en-PK')}</p>
                    </div>
                    <input type="checkbox" checked={selected.includes(sale.id)} onChange={() => toggleSelect(sale.id)} className="mt-1 h-4 w-4 rounded" />
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-lg font-black text-fg">
                        Rs. {(Number(sale.total_amount) - Number(sale.discount || 0)).toFixed(0)}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1.5 items-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${sale.sale_type === 'quotation' ? 'bg-info-muted text-info-strong' : 'bg-success-muted text-success-strong'}`}>
                          {sale.sale_type === 'quotation' ? '📄 Quotation' : '🧾 Sale'}
                        </span>
                        {sale.price_tier === 'wholesale' && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-wholesale-muted text-wholesale-strong">Wholesale</span>}
                        {renderPaymentBadge(sale)}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => openSale(sale)} className="rounded-lg bg-primary-soft px-3 py-2 text-sm font-bold text-primary-fg">View</button>
                      <button onClick={() => requestDelete([sale.id])} className="rounded-lg bg-danger-soft px-3 py-2 text-sm font-bold text-danger-fg">Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full">
                <thead className="bg-surface-2 border-b">
                  <tr>
                    <th className="px-4 py-3 w-10"><input type="checkbox" checked={selected.length === filtered.length && filtered.length > 0} onChange={toggleSelectAll} className="w-4 h-4 rounded" /></th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Invoice ID</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Customer</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Total</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Type / Payment</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filtered.map(sale => (
                    <tr key={sale.id} className={`hover:bg-surface-2 ${selected.includes(sale.id) ? 'bg-primary-soft' : ''}`}>
                      <td className="px-4 py-3"><input type="checkbox" checked={selected.includes(sale.id)} onChange={() => toggleSelect(sale.id)} className="w-4 h-4 rounded" /></td>
                      <td className="px-4 py-3 font-mono text-xs text-fg-3">
                        {sale.sale_type === 'quotation' ? 'QT-' : '#'}{String(sale.id).slice(-8)}
                      </td>
                      <td className="px-4 py-3 text-fg">
                        {sale.customers?.name || sale.customer_name || <span className="text-fg-subtle italic">Walk-in</span>}
                      </td>
                      <td className="px-4 py-3 font-medium text-fg">
                        Rs. {(Number(sale.total_amount) - Number(sale.discount || 0)).toFixed(0)}
                        {sale.discount > 0 && <span className="text-xs text-fg-subtle ml-1">(disc: {sale.discount})</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1 items-start">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium w-fit ${sale.sale_type === 'quotation' ? 'bg-info-muted text-info-strong' : 'bg-success-muted text-success-strong'}`}>
                            {sale.sale_type === 'quotation' ? '📄 Quotation' : '🧾 Sale'}
                          </span>
                          {sale.price_tier === 'wholesale' && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold w-fit bg-wholesale-muted text-wholesale-strong">Wholesale</span>}
                          {renderPaymentBadge(sale)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-fg-muted text-sm">{new Date(sale.created_at).toLocaleDateString('en-PK')}</td>
                      <td className="px-4 py-3 flex gap-2">
                        <button onClick={() => openSale(sale)}
                          className="text-primary-fg hover:text-primary-strong text-sm font-medium">View</button>
                        <button onClick={() => requestDelete([sale.id])}
                          className="text-danger-fg hover:text-danger-strong text-sm font-medium">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
        }

        {/* Sale Detail Modal */}
        {
          selectedSale && (
            <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
              <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-2xl max-h-[90dvh] overflow-y-auto">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-lg font-bold text-fg">
                      {selectedSale.sale_type === 'quotation' ? 'Quotation QT-' : 'Invoice #'}
                      {String(selectedSale.id).slice(-8)}
                    </h2>
                    <p className="text-sm text-fg-muted">
                      {new Date(selectedSale.created_at).toLocaleString('en-PK')} |
                      {selectedSale.customers?.name || selectedSale.customer_name || ' Walk-in'} |
                      <span className={selectedSale.payment_type === 'cash' ? ' text-success-fg' : ' text-warning-fg'}>
                        {' '}{selectedSale.payment_type?.toUpperCase()}
                      </span>
                    </p>
                  </div>
                  <button onClick={() => setSelectedSale(null)} className="text-fg-subtle hover:text-fg-3 text-xl">×</button>
                </div>

                {loadingItems ? <p className="text-fg-muted text-center py-8">Loading...</p> : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full mb-4 text-sm">
                        <thead className="bg-surface-2">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs text-fg-muted whitespace-nowrap">Product</th>
                            <th className="px-3 py-2 text-right text-xs text-fg-muted whitespace-nowrap">Orig. Qty</th>
                            <th className="px-3 py-2 text-right text-xs text-danger-fg whitespace-nowrap">Returned</th>
                            <th className="px-3 py-2 text-right text-xs text-success-fg whitespace-nowrap">Net Qty</th>
                            <th className="px-3 py-2 text-right text-xs text-fg-muted whitespace-nowrap">Rate</th>
                            <th className="px-3 py-2 text-right text-xs text-fg-muted whitespace-nowrap">Net Amount</th>
                            <th className="px-3 py-2 text-center text-xs text-fg-muted whitespace-nowrap">Return Qty</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line-subtle">
                          {saleItems.map(item => {
                            const returnedQty = item.returned_qty || 0
                            const netQty = item.quantity - returnedQty
                            const netAmount = netQty * Number(item.unit_price)
                            const maxReturn = netQty
                            const fullyReturned = netQty <= 0
                            return (
                              <tr key={item.id} className={fullyReturned ? 'bg-danger-soft/40 opacity-60' : ''}>
                                <td className="px-3 py-2 text-fg whitespace-nowrap">
                                  {item.product_name}
                                  {fullyReturned && <span className="ml-1 text-[10px] bg-danger-muted text-danger-fg px-1.5 py-0.5 rounded font-bold uppercase">Fully Returned</span>}
                                </td>
                                <td className="px-3 py-2 text-right text-fg-subtle whitespace-nowrap">{item.quantity}</td>
                                <td className="px-3 py-2 text-right text-danger-fg font-medium whitespace-nowrap">
                                  {returnedQty > 0 ? `- ${returnedQty}` : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-bold text-fg whitespace-nowrap">{netQty}</td>
                                <td className="px-3 py-2 text-right text-fg-3 whitespace-nowrap">Rs. {Number(item.unit_price).toFixed(0)}</td>
                                <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                                  Rs. {netAmount.toFixed(0)}
                                  {returnedQty > 0 && (
                                    <div className="text-[10px] text-fg-subtle font-normal">
                                      orig: Rs. {(item.quantity * Number(item.unit_price)).toFixed(0)}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center whitespace-nowrap">
                                  {maxReturn > 0 ? (
                                    <input type="number" min="0" max={maxReturn}
                                      value={returnQtys[item.id] || ''}
                                      onChange={e => setReturnQtys(prev => ({ ...prev, [item.id]: e.target.value }))}
                                      className="w-16 border rounded px-2 py-1 text-center text-sm" placeholder="0" />
                                  ) : <span className="text-xs text-fg-subtle">Done</span>}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex flex-col gap-3 border-t pt-3 sm:flex-row sm:justify-between sm:items-center">
                      <div className="text-sm text-fg-3">
                        <p>Total: <b>Rs. {(Number(selectedSale.total_amount) - Number(selectedSale.discount || 0)).toFixed(0)}</b></p>
                        {selectedSale.discount > 0 && <p className="text-xs text-fg-subtle">Discount: Rs. {selectedSale.discount}</p>}
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                        {selectedSale.sale_type !== 'quotation' && (
                          <div className="flex flex-wrap items-center gap-3 bg-surface-2 border px-3 py-1.5 rounded-lg sm:mr-2">
                            <span className="text-[10px] font-bold text-fg-subtle uppercase">Refund Type:</span>
                            <label className="flex items-center gap-1 text-sm cursor-pointer">
                              <input type="radio" checked={refundType === 'cash'} onChange={() => setRefundType('cash')} className="w-4 h-4 text-primary-fg" />
                              💵 Cash
                            </label>
                            {selectedSale.customer_id && (
                              <label className="flex items-center gap-1 text-sm cursor-pointer">
                                <input type="radio" checked={refundType === 'credit'} onChange={() => setRefundType('credit')} className="w-4 h-4 text-warning-fg" />
                                📒 Ledger
                              </label>
                            )}
                          </div>
                        )}
                        {selectedSale.sale_type === 'quotation' && (
                          <button onClick={() => navigate(`/pos?convertQuote=${selectedSale.id}`)}
                            className="px-4 py-2 bg-info hover:bg-info-hover text-white rounded-lg text-sm transition font-bold">
                            🛒 Convert to Sale
                          </button>
                        )}
                        <button onClick={() => printInvoice(selectedSale, saleItems)}
                          className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm transition">
                          🖨️ Print {selectedSale.sale_type === 'quotation' ? 'Quotation' : 'Invoice'}
                        </button>
                        {selectedSale.sale_type !== 'quotation' && (
                          <button onClick={handleReturn} disabled={returning}
                            className="px-4 py-2 bg-danger hover:bg-danger-hover text-white rounded-lg text-sm transition disabled:opacity-50">
                            {returning ? 'Processing...' : '↩️ Process Return'}
                          </button>
                        )}
                        <button onClick={() => setSelectedSale(null)}
                          className="px-4 py-2 bg-surface-3 hover:bg-surface-4 text-fg-2 rounded-lg text-sm transition">
                          Close
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        }
      </div>

      {showPasswordModal && (
        <PasswordModal
          title="Delete Sale(s)"
          message={`${pendingDeleteIds.length} sale(s) will be moved to Trash. Stock will be returned and any unpaid amount removed from the customer's balance.`}
          onConfirm={executeDelete}
          onCancel={() => { setShowPasswordModal(false); setPendingDeleteIds([]) }}
        />
      )}
    </>
  )
}

export default Sales
