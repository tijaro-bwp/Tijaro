import { useEffect, useState } from 'react'
import { hasFeature } from '../utils/featureGate'
import { getShopSettings, isWholesaleEnabled } from '../utils/businessPresets'
import UpgradeWall from '../components/UpgradeWall'
import { supabase } from '../services/supabase'
import { fetchAllRows } from '../services/fetchAll'
import { useAuth } from '../context/AuthContext'
import { db, addToSyncQueue } from '../services/db'
import { toIntId, isTempId, isNetworkError, isMissingColumn, receivePurchaseStock, adjustSupplierBalance } from '../services/integrity'

function Purchases() {
  const { user } = useAuth()
  const wholesaleEnabled = isWholesaleEnabled(getShopSettings(user?.shop_id))
  const [products, setProducts] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [brands, setBrands] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedBrand, setSelectedBrand] = useState('')
  const [cart, setCart] = useState([])
  const [supplierId, setSupplierId] = useState('')
  const [paymentType, setPaymentType] = useState('cash')
  const [saving, setSaving] = useState(false)
  const [discount, setDiscount] = useState(0)

  // Hold Purchase
  const [heldPurchases, setHeldPurchases] = useState([])
  const [showHeldPurchases, setShowHeldPurchases] = useState(false)

  const [quickViewProduct, setQuickViewProduct] = useState(null)
  const [priceHistory, setPriceHistory] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [showMobileCart, setShowMobileCart] = useState(false)

  useEffect(() => {
    if (user?.shop_id) fetchData()
  }, [user?.shop_id])

  useEffect(() => {
    if (user?.shop_id) fetchHeldPurchases()
  }, [user?.shop_id])

  const fetchHeldPurchases = async () => {
    try {
      const carts = await db.held_purchases.where('shop_id').equals(user.shop_id).toArray()
      setHeldPurchases(carts)
    } catch (e) { console.warn('No held_purchases table yet') }
  }

  const fetchData = async () => {
    try {
      if (!navigator.onLine) throw new Error('Offline');
      const fetchPromise = Promise.all([
        fetchAllRows(() => supabase.from('products').select('*').eq('shop_id', user.shop_id).order('name')),
        supabase.from('suppliers').select('*').eq('shop_id', user.shop_id).order('name'),
        supabase.from('brands').select('*').eq('shop_id', user.shop_id).order('name')
      ])

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))

      const [p, s, b] = await Promise.race([fetchPromise, timeoutPromise])

      if (p.error || s.error || b.error) throw new Error('Supabase fetch failed')

      if (p.data) {
        const cleanP = JSON.parse(JSON.stringify(p.data))
        await db.products.bulkPut(cleanP)
      }
      if (s.data) {
        const cleanS = JSON.parse(JSON.stringify(s.data))
        await db.suppliers.bulkPut(cleanS)
      }
      if (b.data) {
        const cleanB = JSON.parse(JSON.stringify(b.data))
        await db.brands.bulkPut(cleanB)
      }

      // Render from local DB to merge
      const [lProds, lSups, lBrands] = await Promise.all([
        db.products.toArray(),
        db.suppliers.toArray(),
        db.brands.toArray()
      ])
      const sid = String(user.shop_id)
      setProducts(lProds.filter(x => String(x.shop_id) === sid))
      setSuppliers(lSups.filter(x => String(x.shop_id) === sid))
      setBrands(lBrands.filter(x => String(x.shop_id) === sid))
    } catch (e) {
      console.log('Purchases: Fetching from local DB (Offline Fallback)')
      try {
        const [lProds, lSups, lBrands] = await Promise.all([
          db.products.toArray(),
          db.suppliers.toArray(),
          db.brands.toArray()
        ])
        const sid = String(user.shop_id);
        setProducts(lProds.filter(x => String(x.shop_id) === sid))
        setSuppliers(lSups.filter(x => String(x.shop_id) === sid))
        setBrands(lBrands.filter(x => String(x.shop_id) === sid))
      } catch (err) { console.error('Local DB Purchases Error:', err) }
    } finally {
      setLoading(false)
    }
  }

  const fetchPriceHistory = async (productId) => {
    setLoadingHistory(true)
    setPriceHistory([])
    try {
      if (navigator.onLine) {
        const { data, error } = await supabase
          .from('purchase_items')
          .select('unit_price, quantity, total_price, purchases(created_at, supplier_id, suppliers(name))')
          .eq('product_id', productId)
          .order('id', { ascending: false })
          .limit(20)
        if (!error && data) {
          const mapped = data.map(item => ({
            date: item.purchases?.created_at,
            price: item.unit_price,
            qty: item.quantity,
            total: item.total_price,
            supplier: item.purchases?.suppliers?.name || '-'
          }))
          setPriceHistory(mapped)
        }
      } else {
        // Offline fallback from local DB
        const localItems = await db.purchase_items.where('product_id').equals(productId).toArray()
        const localPurchases = await db.purchases.toArray()
        const localSuppliers = await db.suppliers.toArray()
        const mapped = localItems.map(item => {
          const purchase = localPurchases.find(p => p.id === item.purchase_id)
          const supplier = purchase ? localSuppliers.find(s => s.id === purchase.supplier_id) : null
          return {
            date: purchase?.created_at,
            price: item.unit_price,
            qty: item.quantity,
            total: item.total_price,
            supplier: supplier?.name || '-'
          }
        }).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 20)
        setPriceHistory(mapped)
      }
    } catch (err) {
      console.error('Price history fetch error:', err)
    } finally {
      setLoadingHistory(false)
    }
  }

  const openQuickView = (product) => {
    setQuickViewProduct(product)
    fetchPriceHistory(product.id)
  }

  const addToCart = (product) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id)
      if (existing) {
        return prev.map(i => i.id === product.id ? { ...i, qty: i.qty + 1 } : i)
      }
      return [{ ...product, qty: 1, purchase_price: product.cost_price || 0 }, ...prev]
    })
  }

  const updateQty = (id, qty) => {
    const num = parseInt(qty)
    if (isNaN(num) || num < 1) return
    setCart(prev => prev.map(i => i.id === id ? { ...i, qty: num } : i))
  }

  const incrementQty = (id) => {
    setCart(prev => prev.map(i => i.id === id ? { ...i, qty: i.qty + 1 } : i))
  }

  const decrementQty = (id) => {
    setCart(prev => prev.map(i => i.id === id ? (i.qty > 1 ? { ...i, qty: i.qty - 1 } : i) : i))
  }

  const updatePrice = (id, price) => {
    const num = parseFloat(price)
    if (isNaN(num) || num < 0) return
    setCart(prev => prev.map(i => i.id === id ? { ...i, purchase_price: num } : i))
  }

  const removeFromCart = (id) => setCart(prev => prev.filter(i => i.id !== id))

  const clearCart = () => {
    setCart([]); setSupplierId(''); setPaymentType('cash'); setDiscount(0)
  }

  const subtotal = cart.reduce((sum, i) => sum + i.purchase_price * i.qty, 0)
  const totalDiscount = parseFloat(discount) || 0
  const total = Math.max(0, subtotal - totalDiscount)

  // Hold Purchase
  const handleHoldPurchase = async () => {
    if (cart.length === 0) return
    const heldData = {
      shop_id: user.shop_id,
      supplier_id: supplierId || null,
      items: cart,
      total,
      saved_at: new Date().toISOString()
    }
    try {
      await db.held_purchases.add(heldData)
      await fetchHeldPurchases()
      clearCart()
      alert('Purchase held successfully! ⏸️')
    } catch (err) {
      alert('Error holding purchase: ' + err.message)
    }
  }

  const handleResumePurchase = (held) => {
    if (cart.length > 0) {
      if (!confirm('Current cart will be replaced. Continue?')) return
    }
    setCart(held.items)
    setSupplierId(held.supplier_id || '')
    db.held_purchases.delete(held.id).then(fetchHeldPurchases)
    setShowHeldPurchases(false)
  }

  const handleDeleteHeld = async (id) => {
    await db.held_purchases.delete(id)
    fetchHeldPurchases()
  }

  const handleCompletePurchase = async () => {
    if (cart.length === 0) return alert('Khareedari ke liye products add karein!')
    if (!supplierId) return alert('Pehle supplier select karein!')

    setSaving(true)
    try {
      const clientRef = crypto.randomUUID() // idempotency key — a replay can never duplicate the purchase
      const supplierIsTemp = isTempId(String(supplierId))
      const hasUnsyncedRef = supplierIsTemp || cart.some(i => isTempId(String(i.id)))
      const purchaseData = {
        shop_id: user.shop_id,
        supplier_id: toIntId(supplierId),
        total_amount: total,
        paid_amount: paymentType === 'cash' ? total : 0,
        payment_type: paymentType,
        status: 'completed',
        client_ref: clientRef
      }

      // ── 1. Purchase header ──
      let purchase = null
      let savedOnline = false
      try {
        if (!navigator.onLine || hasUnsyncedRef) throw new TypeError('Failed to fetch')
        let { data, error: pError } = await supabase.from('purchases').insert([purchaseData]).select().single()
        if (pError && isMissingColumn(pError)) {
          const { client_ref: _omit, ...withoutRef } = purchaseData
          ;({ data, error: pError } = await supabase.from('purchases').insert([withoutRef]).select().single())
        }
        if (pError) throw pError
        purchase = data
        savedOnline = true
        await db.purchases.put(purchase)
      } catch (err) {
        if (!hasUnsyncedRef && !isNetworkError(err)) throw err
        const offlineId = crypto.randomUUID()
        purchase = { ...purchaseData, id: offlineId, supplier_id: supplierIsTemp ? supplierId : purchaseData.supplier_id }
        await db.purchases.add(purchase)
        await addToSyncQueue('purchases', 'INSERT', purchase)
      }

      // ── 2. Purchase items (a failure here never creates a second purchase) ──
      const items = cart.map(i => ({
        purchase_id: purchase.id,
        product_id: savedOnline ? toIntId(i.id) : i.id,
        product_name: i.name,
        quantity: i.qty,
        unit_price: i.purchase_price,
        total_price: i.purchase_price * i.qty
      }))
      let itemsSaved = false
      if (savedOnline) {
        const { data: resItems, error: itemsError } = await supabase.from('purchase_items').insert(items).select()
        if (!itemsError) {
          await db.purchase_items.bulkPut(resItems)
          itemsSaved = true
        } else if (!isNetworkError(itemsError)) {
          await supabase.from('purchases').delete().eq('id', purchase.id)
          await db.purchases.delete(purchase.id).catch(() => {})
          throw new Error(`${itemsError.message} — purchase was NOT saved, please try again.`)
        }
      }
      if (!itemsSaved) {
        // local rows need their own id (IndexedDB key)
        const localItems = items.map(it => ({ ...it, id: crypto.randomUUID() }))
        await db.purchase_items.bulkPut(localItems)
        await addToSyncQueue('purchase_items', 'INSERT', localItems)
      }

      // ── 3. Stock (+qty) and weighted-average cost, applied atomically in the database ──
      const failed = []
      for (const item of cart) {
        const r = await receivePurchaseStock(item.id, Number(item.qty), Number(item.purchase_price))
        if (!r.ok) failed.push(item.name)
      }

      // ── 4. Supplier balance (credit) or recorded cash payment ──
      if (paymentType === 'credit') {
        const r = await adjustSupplierBalance(supplierId, total)
        if (!r.ok) failed.push('supplier balance')
      } else if (paymentType === 'cash' && total > 0) {
        const paymentData = {
          shop_id: user.shop_id,
          supplier_id: savedOnline ? toIntId(supplierId) : supplierId,
          amount: total,
          payment_type: 'payment',
          note: `Cash Paid for Purchase PR-${String(purchase.id).slice(-6)}`
        }
        let paid = false
        if (savedOnline) {
          const { error: payErr } = await supabase.from('supplier_payments').insert([paymentData])
          if (!payErr) paid = true
          else if (!isNetworkError(payErr)) failed.push('supplier payment record')
        }
        if (!paid && !failed.includes('supplier payment record')) {
          const localPayment = { ...paymentData, id: crypto.randomUUID() }
          await db.supplier_payments.add(localPayment)
          await addToSyncQueue('supplier_payments', 'INSERT', localPayment)
        }
      }

      if (failed.length > 0) {
        alert(`Purchase saved, but these updates failed: ${failed.join(', ')}.\nPlease check stock / supplier balance.`)
      } else if (!savedOnline || !itemsSaved) {
        alert('Offline mode: Purchase saved locally. Will sync automatically when online. 🔄')
      } else {
        alert('Purchase complete! Stock and supplier balance updated.')
      }
      clearCart()
      fetchData()
    } catch (err) {
      alert('Error: ' + (err?.message || String(err)))
    } finally {
      setSaving(false)
    }
  }

  const filteredProducts = products.filter(p => {
    const q = search.trim().toLowerCase()
    let matchSearch = true
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean)
      const pName = String(p.name || '').toLowerCase()
      const pBrand = String(p.brand || '').toLowerCase()
      const pSku = String(p.sku || '').toLowerCase()
      const pId = String(p.id || '').toLowerCase()
      const searchTarget = `${pName} ${pBrand} ${pSku} ${pId}`

      matchSearch = tokens.every(token => searchTarget.includes(token))
    }
    const matchBrand = selectedBrand ? String(p.brand) === String(selectedBrand) : true
    return matchSearch && matchBrand
  })

  if (!hasFeature('purchases')) return <UpgradeWall feature="purchases" />

  return (
    <div className="flex flex-col md:flex-row gap-4 overflow-hidden" style={{ height: 'calc(100vh - 112px)' }}>

      {/* LEFT: Products */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">

        {/* Header */}
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-fg">📥 Stock Purchase</h1>
          <span className="text-xs bg-primary-muted text-primary-strong px-2 py-0.5 rounded-full font-bold">{cart.length} items in cart</span>
        </div>

        {/* Search + Filters */}
        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            placeholder="🔍 Search products / brands..."
            className="flex-1 px-3 py-2 border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary min-w-0"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            value={selectedBrand}
            onChange={e => setSelectedBrand(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm bg-surface focus:outline-none"
          >
            <option value="">All Brands</option>
            {brands.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
          </select>
          {(search || selectedBrand) && (
            <button
              onClick={() => { setSearch(''); setSelectedBrand('') }}
              className="px-3 py-2 bg-surface-3 hover:bg-surface-4 text-fg-3 rounded-lg text-sm transition"
            >
              Reset
            </button>
          )}
        </div>

        {/* Product Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 overflow-y-auto flex-1 content-start">
          {filteredProducts.length === 0 && <p className="text-fg-subtle col-span-3 text-center py-10">No products found</p>}
          {filteredProducts.map(p => (
            <div key={p.id}
              className="bg-surface rounded-xl shadow-sm p-3 text-left hover:shadow-md hover:bg-primary-soft transition border border-transparent hover:border-primary-edge h-fit group relative"
            >
              <button
                onClick={() => addToCart(p)}
                className="w-full text-left"
              >
                <p className="font-semibold text-fg text-sm leading-tight group-hover:text-primary-strong">{p.name}</p>
                {p.brand && <p className="text-xs text-fg-subtle">{p.brand}</p>}
                <div className="flex justify-between items-end mt-2">
                  <p className="text-xs font-bold text-success-fg">Stock: {p.stock_quantity}</p>
                  <p className="text-xs text-fg-muted">Cost: Rs.{p.cost_price}</p>
                </div>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); openQuickView(p) }}
                className="absolute top-2 right-2 w-6 h-6 bg-primary-muted hover:bg-primary-line text-primary-fg rounded-full text-xs font-bold flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                title="Quick View"
              >
                👁
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile Cart Floating Badge */}
      {cart.length > 0 && (
        <button
          onClick={() => setShowMobileCart(true)}
          className="md:hidden fixed bottom-5 right-5 z-40 bg-success text-white rounded-full w-16 h-16 flex flex-col items-center justify-center shadow-2xl hover:bg-success-hover transition active:scale-95"
        >
          <span className="text-lg">🛒</span>
          <span className="text-[10px] font-black">{cart.length}</span>
          <span className="absolute -top-1 -right-1 bg-danger text-white text-[10px] font-black w-6 h-6 rounded-full flex items-center justify-center">Rs.{total.toFixed(0)}</span>
        </button>
      )}

      {/* Mobile overlay backdrop */}
      {showMobileCart && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-40" onClick={() => setShowMobileCart(false)} />
      )}

      {/* RIGHT: Cart */}
      <div className={`${showMobileCart ? 'fixed inset-0 z-50 w-full flex' : 'hidden md:flex'} md:static md:w-96 flex-col gap-2 bg-surface rounded-xl shadow-lg p-4 h-[calc(100vh-80px)] md:h-full border border-line-subtle overflow-hidden`}>

        {/* Mobile close button */}
        <button onClick={() => setShowMobileCart(false)} className="md:hidden self-end text-fg-subtle hover:text-fg-2 text-2xl font-bold mb-1">✕</button>

        {/* Cart Header */}
        <h2 className="text-base font-bold text-fg border-b pb-2 shrink-0 flex justify-between items-center">
          <span>🛒 Purchase Cart</span>
          <div className="flex gap-1">
            {heldPurchases.length > 0 && (
              <button
                onClick={() => setShowHeldPurchases(true)}
                className="px-2 py-0.5 bg-warning-muted text-warning-strong rounded text-[10px] font-bold uppercase hover:bg-warning-line transition"
              >
                ⏸️ Held ({heldPurchases.length})
              </button>
            )}
          </div>
        </h2>

        {/* Supplier */}
        <select
          className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary shrink-0"
          value={supplierId}
          onChange={e => setSupplierId(e.target.value)}
        >
          <option value="">Select Supplier (Vendor)</option>
          {suppliers.map(s => (
            <option key={s.id} value={s.id}>{s.name} {s.outstanding_balance > 0 ? `(Bal: Rs.${s.outstanding_balance})` : ''}</option>
          ))}
        </select>

        {/* Payment Type */}
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setPaymentType('cash')}
            className={`flex-1 py-1.5 rounded-lg font-bold text-xs transition ${paymentType === 'cash' ? 'bg-success text-white shadow-md' : 'bg-surface-3 text-fg-3'}`}
          >
            💵 Cash Paid
          </button>
          <button
            onClick={() => setPaymentType('credit')}
            className={`flex-1 py-1.5 rounded-lg font-bold text-xs transition ${paymentType === 'credit' ? 'bg-warning text-white shadow-md' : 'bg-surface-3 text-fg-3'}`}
          >
            📒 Credit
          </button>
        </div>

        {/* Cart Items — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-1 pr-1 custom-scrollbar">
          {cart.length === 0 && <p className="text-fg-subtle text-xs text-center py-8">Products select karein ←</p>}
          {cart.map(item => (
            <div key={item.id} className="bg-surface-2 rounded-lg p-2 border border-line-subtle">
              <div className="flex items-center gap-1">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-fg truncate">{item.name}</p>
                  {item.brand && <p className="text-[10px] text-fg-subtle">{item.brand}</p>}
                </div>
                <button onClick={() => removeFromCart(item.id)} className="text-danger-fg hover:text-danger-strong font-bold pl-1 text-sm">×</button>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {/* Qty Controls */}
                <div className="flex items-center bg-surface border border-line rounded overflow-hidden">
                  <button
                    onClick={() => decrementQty(item.id)}
                    className="px-2 py-0.5 text-fg-muted hover:bg-surface-3 text-xs font-bold transition"
                  >−</button>
                  <input
                    type="number"
                    value={item.qty}
                    onChange={e => updateQty(item.id, e.target.value)}
                    className="w-10 text-center text-xs font-bold outline-none border-x border-line"
                    min="1"
                  />
                  <button
                    onClick={() => incrementQty(item.id)}
                    className="px-2 py-0.5 text-fg-muted hover:bg-surface-3 text-xs font-bold transition"
                  >+</button>
                </div>
                {/* Price */}
                <div className="flex-1 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 bg-surface border border-line rounded px-1">
                    <span className="text-[10px] text-fg-subtle">Rate</span>
                    <input
                      type="number"
                      value={item.purchase_price}
                      onChange={e => updatePrice(item.id, e.target.value)}
                      className={`w-full text-xs font-bold outline-none ${item.purchase_price > (item.cost_price || 0) ? 'text-danger-fg' : item.purchase_price < (item.cost_price || 0) ? 'text-success-fg' : 'text-primary-fg'}`}
                    />
                  </div>
                  <p className="text-[8px] text-fg-subtle">Prev Cost: Rs.{item.cost_price || 0}</p>
                </div>
              </div>
              <p className="text-right text-[10px] font-bold text-fg-muted mt-0.5">Total: Rs. {(item.purchase_price * item.qty).toLocaleString()}</p>
            </div>
          ))}
        </div>

        {/* Bottom section — fixed */}
        <div className="bg-surface-2 rounded-lg p-2 border-t shrink-0 space-y-1 mt-auto">
          {/* Totals & Discount Mini-Grid */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-fg-3">
                <span>Subtotal</span><span>Rs.{subtotal.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-fg-3">Disc (Rs):</label>
                <input type="number" value={discount} onChange={e => setDiscount(e.target.value)} className="w-16 px-1 border rounded text-right outline-none" min="0" placeholder="0" />
              </div>
            </div>
            <div className="flex flex-col justify-end text-right border-l pl-2 border-line">
              <div className="text-fg-muted text-[10px] uppercase">Net Total</div>
              <div className="font-black text-lg text-fg leading-none">Rs.{total.toLocaleString()}</div>
            </div>
          </div>

          <div className="flex gap-1 pt-1">
            <button onClick={handleHoldPurchase} disabled={cart.length === 0} className="px-2 py-1.5 bg-warning-muted text-warning-strong rounded-lg text-xs font-bold disabled:opacity-30">⏸️</button>
            <button onClick={clearCart} disabled={cart.length === 0} className="px-2 py-1.5 bg-surface-4 text-fg-2 rounded-lg text-xs font-bold disabled:opacity-30">🗑️</button>
            <button onClick={handleCompletePurchase} disabled={saving || cart.length === 0} className="flex-1 py-1.5 bg-primary text-white font-bold rounded-lg text-sm disabled:opacity-50">
              {saving ? 'Processing...' : '✅ Save Purchase'}
            </button>
          </div>
        </div>
      </div>

      {/* Quick View Modal */}
      {quickViewProduct && (
        <div className="fixed inset-0 bg-black/40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4" onClick={() => setQuickViewProduct(null)}>
          <div className="bg-surface rounded-2xl shadow-2xl p-6 w-full max-w-lg flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4 shrink-0">
              <h3 className="text-lg font-bold text-fg">📋 Product Details & Price History</h3>
              <button onClick={() => setQuickViewProduct(null)} className="text-fg-subtle hover:text-fg-3 text-2xl">×</button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3">
              <div>
                <p className="text-sm text-fg-muted">Product Name</p>
                <p className="font-bold text-fg">{quickViewProduct.name}</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-sm text-fg-muted">Brand</p>
                  <p className="font-medium text-fg-2">{quickViewProduct.brand || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-fg-muted">Stock</p>
                  <p className={`font-bold ${quickViewProduct.stock_quantity <= 5 ? 'text-danger-fg' : 'text-success-fg'}`}>{quickViewProduct.stock_quantity}</p>
                </div>
                <div>
                  <p className="text-sm text-fg-muted">C. Rate</p>
                  <p className="font-bold text-info-fg">{quickViewProduct.c_rate || 0}</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-primary-soft rounded-lg p-2 text-center">
                  <p className="text-[10px] text-primary-fg uppercase font-bold">Current Cost</p>
                  <p className="font-bold text-primary-strong text-lg">Rs. {quickViewProduct.cost_price || 0}</p>
                </div>
                <div className="bg-success-soft rounded-lg p-2 text-center">
                  <p className="text-[10px] text-success-fg uppercase font-bold">Sale Price</p>
                  <p className="font-bold text-success-strong text-lg">Rs. {quickViewProduct.sale_price || 0}</p>
                </div>
                {wholesaleEnabled && (
                  <div className="bg-wholesale-soft rounded-lg p-2 text-center sm:col-span-2">
                    <p className="text-[10px] text-wholesale-fg uppercase font-bold">Wholesale Price</p>
                    <p className="font-bold text-wholesale-strong text-lg">{Number(quickViewProduct.wholesale_price) > 0 ? `Rs. ${quickViewProduct.wholesale_price}` : '—'}</p>
                  </div>
                )}
              </div>

              {/* Purchase Price History */}
              <div className="border-t pt-3">
                <h4 className="font-bold text-fg-2 text-sm mb-2">📊 Purchase Price History</h4>
                {loadingHistory ? (
                  <p className="text-center text-fg-subtle text-xs py-4">Loading history...</p>
                ) : priceHistory.length === 0 ? (
                  <p className="text-center text-fg-subtle text-xs py-4 italic">No previous purchases found for this product.</p>
                ) : (
                  <div className="border rounded-lg overflow-hidden overflow-x-auto">
                    <table className="w-full text-xs min-w-[360px]">
                      <thead className="bg-surface-3">
                        <tr>
                          <th className="px-3 py-2 text-left text-fg-muted font-bold">Date</th>
                          <th className="px-3 py-2 text-left text-fg-muted font-bold">Supplier</th>
                          <th className="px-3 py-2 text-right text-fg-muted font-bold">Rate</th>
                          <th className="px-3 py-2 text-right text-fg-muted font-bold">Qty</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line-subtle">
                        {priceHistory.map((h, idx) => (
                          <tr key={idx} className={`hover:bg-surface-2 ${idx === 0 ? 'bg-warning-soft font-semibold' : ''}`}>
                            <td className="px-3 py-1.5 text-fg-3">{h.date ? new Date(h.date).toLocaleDateString('en-PK') : '-'}</td>
                            <td className="px-3 py-1.5 text-fg-3 truncate max-w-[100px]">{h.supplier}</td>
                            <td className={`px-3 py-1.5 text-right font-bold ${idx > 0 && h.price !== priceHistory[idx - 1]?.price ? 'text-warning-fg' : 'text-fg'}`}>Rs. {h.price}</td>
                            <td className="px-3 py-1.5 text-right text-fg-muted">{h.qty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={() => { addToCart(quickViewProduct); setQuickViewProduct(null) }}
              className="w-full mt-4 py-2.5 bg-primary hover:bg-primary-hover text-white font-bold rounded-lg shadow-md transition shrink-0"
            >
              + Add to Purchase Cart
            </button>
          </div>
        </div>
      )}

      {/* Held Purchases Modal */}
      {showHeldPurchases && (
        <div className="fixed inset-0 bg-black/40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4" onClick={() => setShowHeldPurchases(false)}>
          <div className="bg-surface rounded-2xl shadow-2xl p-6 w-full max-w-lg flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-fg">⏸️ Held Purchases</h3>
              <button onClick={() => setShowHeldPurchases(false)} className="text-fg-subtle hover:text-fg-3 text-2xl">×</button>
            </div>
            <div className="overflow-y-auto space-y-3 flex-1">
              {heldPurchases.length === 0 && <p className="text-fg-subtle text-center py-8">No held purchases</p>}
              {heldPurchases.map(held => {
                const sup = suppliers.find(s => String(s.id) === String(held.supplier_id))
                return (
                  <div key={held.id} className="bg-surface-2 rounded-lg p-3 border border-line">
                    <div className="flex justify-between items-center mb-1">
                      <p className="text-xs text-fg-muted">{new Date(held.saved_at).toLocaleString()}</p>
                      <p className="font-bold text-fg">Rs. {held.total?.toLocaleString()}</p>
                    </div>
                    {sup && <p className="text-xs text-fg-3 mb-1">Supplier: {sup.name}</p>}
                    <p className="text-xs text-fg-subtle">{held.items?.length} items</p>
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => handleResumePurchase(held)}
                        className="flex-1 py-1.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-bold transition">
                        ▶ Resume
                      </button>
                      <button onClick={() => handleDeleteHeld(held.id)}
                        className="px-3 py-1.5 bg-danger-muted hover:bg-danger-line text-danger-fg rounded-lg text-xs font-bold transition">
                        🗑
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Purchases
