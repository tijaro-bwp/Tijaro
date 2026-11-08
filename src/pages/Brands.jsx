import { useEffect, useState, useRef } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import * as XLSX from 'xlsx'
import { db, addToSyncQueue } from '../services/db'
import { hasFeature } from '../utils/featureGate'
import UpgradeWall from '../components/UpgradeWall'

function Brands() {
  const { user } = useAuth()
  const [brands, setBrands] = useState([])
  const [categories, setCategories] = useState([])
  const [selectedCategoryIds, setSelectedCategoryIds] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({
    name: ''
  })
  const fileInputRef = useRef(null)

  // View Products modal
  const [viewBrand, setViewBrand] = useState(null)
  const [brandProducts, setBrandProducts] = useState([])
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [expandedProductId, setExpandedProductId] = useState(null)
  const [productHistory, setProductHistory] = useState({})
  const [loadingHistoryId, setLoadingHistoryId] = useState(null)

  const [searchBrand, setSearchBrand] = useState('')
  const [missingBrands, setMissingBrands] = useState([])
  const [syncingMissing, setSyncingMissing] = useState(false)

  useEffect(() => {
    if (user?.shop_id) {
      fetchBrands()
      fetchCategories()
    }
  }, [user?.shop_id])

  const fetchCategories = async () => {
    try {
      const localData = await db.categories.toArray()
      const sid = String(user.shop_id)
      setCategories(localData.filter(x => String(x.shop_id) === sid).sort((a, b) => a.name.localeCompare(b.name)))
    } catch (e) { console.error('Brands: categories fetch error', e) }
  }

  const detectMissingBrands = async (currentBrands) => {
    try {
      const knownNames = new Set((currentBrands || []).map(b => b.name?.trim().toLowerCase()).filter(Boolean))
      let prods = []
      if (navigator.onLine) {
        const { data } = await supabase.from('products').select('brand, category_id').eq('shop_id', user.shop_id)
        prods = data || []
      } else {
        const local = await db.products.toArray()
        prods = local.filter(x => String(x.shop_id) === String(user.shop_id))
      }
      const missingMap = {}
      prods.forEach(p => {
        if (!p.brand) return
        const bTrim = p.brand.trim()
        if (bTrim && !knownNames.has(bTrim.toLowerCase())) {
          if (!missingMap[bTrim.toLowerCase()]) {
            missingMap[bTrim.toLowerCase()] = { name: bTrim, count: 0, categoryIds: new Set() }
          }
          missingMap[bTrim.toLowerCase()].count++
          if (p.category_id) missingMap[bTrim.toLowerCase()].categoryIds.add(p.category_id)
        }
      })
      setMissingBrands(Object.values(missingMap).map(m => ({ ...m, categoryIds: Array.from(m.categoryIds) })))
    } catch (err) {
      console.warn('Brands: detectMissingBrands error', err)
    }
  }

  const handleSyncMissingBrand = async (missingItem) => {
    setSyncingMissing(true)
    try {
      const payload = { name: missingItem.name, shop_id: user.shop_id }
      let brandId = null

      if (navigator.onLine) {
        const { data, error } = await supabase.from('brands').insert([payload]).select()
        if (error) throw error
        brandId = data?.[0]?.id
        if (brandId && missingItem.categoryIds.length > 0) {
          await supabase.from('brand_categories').insert(
            missingItem.categoryIds.map(cId => ({ brand_id: brandId, category_id: Number(cId), shop_id: user.shop_id }))
          ).catch(() => {})
        }
      } else {
        brandId = crypto.randomUUID()
        const offlineData = { ...payload, id: brandId, created_at: new Date().toISOString() }
        await addToSyncQueue('brands', 'INSERT', offlineData)
        await db.brands.add(offlineData)
      }
      alert(`✅ Brand "${missingItem.name}" Master Data mein add ho gaya!`)
      fetchBrands()
    } catch (err) {
      alert('Error adding brand: ' + (err.message || err))
    } finally {
      setSyncingMissing(false)
    }
  }

  const handleSyncAllMissing = async () => {
    if (!missingBrands.length) return
    setSyncingMissing(true)
    try {
      let count = 0
      for (const item of missingBrands) {
        const payload = { name: item.name, shop_id: user.shop_id }
        if (navigator.onLine) {
          const { data } = await supabase.from('brands').insert([payload]).select()
          const bId = data?.[0]?.id
          if (bId && item.categoryIds.length > 0) {
            await supabase.from('brand_categories').insert(
              item.categoryIds.map(cId => ({ brand_id: bId, category_id: Number(cId), shop_id: user.shop_id }))
            ).catch(() => {})
          }
        } else {
          const bId = crypto.randomUUID()
          const offlineData = { ...payload, id: bId, created_at: new Date().toISOString() }
          await addToSyncQueue('brands', 'INSERT', offlineData)
          await db.brands.add(offlineData)
        }
        count++
      }
      alert(`✅ ${count} missing brands Master Data mein successfully add ho gaye!`)
      fetchBrands()
    } catch (err) {
      alert('Error syncing brands: ' + (err.message || err))
    } finally {
      setSyncingMissing(false)
    }
  }

  const fetchBrands = async () => {
    try {
      if (!navigator.onLine) throw new Error('Offline')
      const fetchPromise = supabase.from('brands').select('*').eq('shop_id', user.shop_id).order('created_at', { ascending: false })
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))

      const { data, error } = await Promise.race([fetchPromise, timeoutPromise])
      if (error) throw error

      if (data) {
        await db.brands.bulkPut(JSON.parse(JSON.stringify(data)))
      }

      const localData = await db.brands.toArray()
      const sid = String(user.shop_id)
      const filtered = localData.filter(x => String(x.shop_id) === sid)
      const sorted = filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      setBrands(sorted)
      detectMissingBrands(sorted)
    } catch (err) {
      console.log('Brands: Fetching from local DB (Offline)')
      try {
        const localData = await db.brands.toArray()
        const sid = String(user.shop_id)
        const sorted = localData.filter(x => String(x.shop_id) === sid)
        setBrands(sorted)
        detectMissingBrands(sorted)
      } catch (e) { console.error('Local DB Brands Error', e) }
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = async (brand) => {
    setForm({ name: brand.name })
    setEditingId(brand.id)
    setShowForm(true)
    try {
      if (navigator.onLine) {
        const { data } = await supabase.from('brand_categories').select('category_id').eq('brand_id', brand.id)
        setSelectedCategoryIds((data || []).map(r => r.category_id))
      } else {
        const local = await db.brand_categories.where('brand_id').equals(brand.id).toArray()
        setSelectedCategoryIds(local.map(r => r.category_id))
      }
    } catch (e) { setSelectedCategoryIds([]) }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    const payload = { ...form, shop_id: user.shop_id }

    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')

      let brandId = editingId
      if (editingId) {
        const { error } = await supabase.from('brands').update(payload).eq('id', editingId)
        if (error) throw error
      } else {
        const { data: newBrand, error } = await supabase.from('brands').insert([payload]).select()
        if (error) throw error
        brandId = newBrand[0].id
      }

      // Save brand-category associations to Supabase
      const { error: delBcErr } = await supabase.from('brand_categories').delete().eq('brand_id', brandId)
      if (delBcErr) console.warn('brand_categories delete error:', delBcErr)
      if (selectedCategoryIds.length > 0) {
        const { error: insBcErr } = await supabase.from('brand_categories').insert(
          selectedCategoryIds.map(cId => ({ brand_id: brandId, category_id: Number(cId), shop_id: user.shop_id }))
        )
        if (insBcErr) {
          console.error('brand_categories insert error:', insBcErr)
          alert('Categories link karne mein masla hua: ' + insBcErr.message + '\n\nSQL migration dobara run karein: sql/add_brand_categories.sql')
        }
      }
      // Always sync to IndexedDB regardless of Supabase result
      await db.brand_categories.where('brand_id').equals(brandId).delete().catch(() => {})
      if (selectedCategoryIds.length > 0) {
        await db.brand_categories.bulkAdd(
          selectedCategoryIds.map(cId => ({ brand_id: brandId, category_id: Number(cId), shop_id: user.shop_id }))
        ).catch(() => {})
      }

      setEditingId(null)
      setForm({ name: '' })
      setSelectedCategoryIds([])
      setShowForm(false)
      fetchBrands()
    } catch (error) {
      const errMsg = error?.message || String(error)
      if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
        const offlineData = editingId ? { ...payload, id: editingId } : { ...payload, id: crypto.randomUUID(), created_at: new Date().toISOString() }
        const action = editingId ? 'UPDATE' : 'INSERT'
        await addToSyncQueue('brands', action, offlineData)
        if (editingId) {
          await db.brands.update(editingId, offlineData)
        } else {
          await db.brands.add(offlineData)
        }
        // Save brand-category associations offline
        const brandId = offlineData.id
        await db.brand_categories.where('brand_id').equals(brandId).delete().catch(() => {})
        if (selectedCategoryIds.length > 0) {
          await db.brand_categories.bulkAdd(
            selectedCategoryIds.map(cId => ({ brand_id: brandId, category_id: cId, shop_id: user.shop_id }))
          ).catch(() => {})
        }
        setEditingId(null)
        setForm({ name: '' })
        setSelectedCategoryIds([])
        setShowForm(false)
        fetchBrands()
        alert('Offline mode: Saved locally. Will sync automatically when online. 🔄')
      } else {
        alert('Error: ' + errMsg)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Are you sure?')) return
    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')
      const { error } = await supabase.from('brands').delete().eq('id', id)
      if (error) throw error
      fetchBrands()
    } catch (error) {
      const errMsg = error?.message || String(error)
      if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
        await db.brands.delete(id)
        await addToSyncQueue('brands', 'DELETE', { id })
        fetchBrands()
        alert('Offline mode: Brand deleted locally. Will sync when online! 🔄')
      } else {
        alert('Error: ' + errMsg)
      }
    }
  }



  const handleCancel = () => {
    setShowForm(false)
    setEditingId(null)
    setForm({ name: '' })
    setSelectedCategoryIds([])
  }

  const handleExport = () => {
    if (brands.length === 0) return alert('No data to export')
    const data = brands.map(b => ({
      'Brand Name': b.name,
      'Created At': new Date(b.created_at).toLocaleDateString()
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Brands')
    XLSX.writeFile(wb, `Brands_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const handleImport = (e) => {
    const file = e.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (evt) => {
      const bstr = evt.target.result
      const wb = XLSX.read(bstr, { type: 'binary' })
      const wsname = wb.SheetNames[0]
      const ws = wb.Sheets[wsname]
      const data = XLSX.utils.sheet_to_json(ws)

      if (data.length === 0) return alert('No data found in file')

      setLoading(true)
      let importedCount = 0
      for (const row of data) {
        const name = row['Brand Name'] || row['name'] || row['Name']

        if (name) {
          const exists = brands.find(b => b.name.toLowerCase() === name.toLowerCase())
          if (!exists) {
            const { error } = await supabase.from('brands').insert([{ name, shop_id: user.shop_id }])
            if (!error) importedCount++
            else console.warn(`Brand import skipped "${name}":`, error.message)
          }
        }
      }
      setLoading(false)
      alert(`${importedCount} new brands imported!`)
      fetchBrands()
    }
    reader.readAsBinaryString(file)
    e.target.value = null
  }

  const handleViewProducts = async (brand) => {
    setViewBrand(brand)
    setLoadingProducts(true)
    setBrandProducts([])
    setExpandedProductId(null)
    setProductHistory({})
    try {
      if (navigator.onLine) {
        const { data, error } = await supabase
          .from('products')
          .select('*')
          .eq('brand', brand.name)
          .eq('shop_id', user.shop_id)
          .order('name')
        if (!error && data) setBrandProducts(data)
      } else {
        const local = await db.products.toArray()
        const sid = String(user.shop_id)
        setBrandProducts(local.filter(p => String(p.shop_id) === sid && p.brand === brand.name).sort((a, b) => a.name.localeCompare(b.name)))
      }
    } catch (err) { console.error('View Products Error:', err) }
    finally { setLoadingProducts(false) }
  }

  const fetchProductHistory = async (productId) => {
    if (expandedProductId === productId) {
      setExpandedProductId(null)
      return
    }
    setExpandedProductId(productId)
    if (productHistory[productId]) return // already fetched
    setLoadingHistoryId(productId)
    try {
      if (navigator.onLine) {
        const { data, error } = await supabase
          .from('purchase_items')
          .select('unit_price, quantity, total_price, purchases(created_at, supplier_id, suppliers(name))')
          .eq('product_id', productId)
          .order('id', { ascending: false })
          .limit(15)
        if (!error && data) {
          const mapped = data.map(item => ({
            date: item.purchases?.created_at,
            price: item.unit_price,
            qty: item.quantity,
            supplier: item.purchases?.suppliers?.name || '-'
          }))
          setProductHistory(prev => ({ ...prev, [productId]: mapped }))
        }
      } else {
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
            supplier: supplier?.name || '-'
          }
        }).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 15)
        setProductHistory(prev => ({ ...prev, [productId]: mapped }))
      }
    } catch (err) { console.error('Fetch product history error:', err) }
    finally { setLoadingHistoryId(null) }
  }

  if (!hasFeature('brands')) return <UpgradeWall feature="brands" />

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <h1 className="text-2xl font-bold text-fg">🏷️ Brands</h1>
        <div className="flex gap-2 w-full sm:w-auto">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImport}
            className="hidden"
            accept=".xlsx, .xls, .csv"
          />
          <button
            onClick={() => fileInputRef.current.click()}
            className="px-4 py-2 bg-success hover:bg-success-hover text-white rounded-lg transition text-sm font-bold flex items-center gap-2"
          >
            📥 Import
          </button>
          <button
            onClick={handleExport}
            className="px-4 py-2 bg-contrast hover:bg-contrast-hover text-white rounded-lg transition text-sm font-bold flex items-center gap-2"
          >
            📤 Export
          </button>
          <button
            onClick={() => showForm ? handleCancel() : setShowForm(true)}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition text-sm font-bold"
          >
            {showForm ? 'Cancel' : '+ Add Brand'}
          </button>
        </div>
      </div>

      {/* Missing Brands Banner */}
      {missingBrands.length > 0 && (
        <div className="bg-warning-soft border border-warning-line rounded-xl p-4 mb-6 shadow-sm">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h3 className="font-bold text-warning-strong text-sm flex items-center gap-2">
                <span>⚠️ Missing Brands Detected</span>
                <span className="bg-warning-line text-warning-strong text-xs px-2 py-0.5 rounded-full font-black">
                  {missingBrands.length} unlisted
                </span>
              </h3>
              <p className="text-xs text-warning-strong mt-1">
                Products mein kuch brands use ho rahe hain jo Master Data brands list mein register nahi hain. Inhe add karne se POS aur filters theek ho jayenge:
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                {missingBrands.map((item, idx) => (
                  <span key={idx} className="bg-surface border border-warning-edge text-warning-strong text-xs px-2.5 py-1 rounded-lg flex items-center gap-2 font-medium">
                    <span>🏷️ <strong>{item.name}</strong> ({item.count} products)</span>
                    <button
                      onClick={() => handleSyncMissingBrand(item)}
                      disabled={syncingMissing}
                      className="text-[10px] bg-warning hover:bg-warning-hover text-white font-bold px-2 py-0.5 rounded transition disabled:opacity-50"
                    >
                      + Add
                    </button>
                  </span>
                ))}
              </div>
            </div>
            <button
              onClick={handleSyncAllMissing}
              disabled={syncingMissing}
              className="px-4 py-2 bg-warning hover:bg-warning-hover text-white rounded-lg text-xs font-bold transition whitespace-nowrap shadow-sm disabled:opacity-50"
            >
              {syncingMissing ? 'Syncing...' : '⚡ Add All Missing Brands'}
            </button>
          </div>
        </div>
      )}

      {/* Search Bar */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="🔍 Search brands..."
          value={searchBrand}
          onChange={(e) => setSearchBrand(e.target.value)}
          className="w-full sm:w-80 px-4 py-2 border border-line-strong rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {showForm && (
        <div className="bg-surface rounded-xl shadow p-6 mb-6 max-w-lg">
          <h2 className="font-semibold text-fg-2 mb-4">
            {editingId ? 'Edit Brand' : 'New Brand'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-fg-2 font-medium mb-1">Brand Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="e.g. Samsung, Nike, Nestlé, Master"
              />
            </div>
            {categories.length > 0 && (
              <div>
                <label className="block text-fg-2 font-medium mb-2">Categories (optional)</label>
                <p className="text-xs text-fg-subtle mb-2">Is brand ki categories select karein. POS aur product form mein sirf yeh categories dikhein gi.</p>
                <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto border border-line rounded-lg p-2 bg-surface-2">
                  {categories.map(cat => (
                    <label key={cat.id} className="flex items-center gap-2 cursor-pointer hover:bg-surface rounded px-1.5 py-1 transition">
                      <input
                        type="checkbox"
                        checked={selectedCategoryIds.includes(cat.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedCategoryIds(prev => [...prev, cat.id])
                          } else {
                            setSelectedCategoryIds(prev => prev.filter(id => id !== cat.id))
                          }
                        }}
                        className="w-3.5 h-3.5 rounded accent-primary"
                      />
                      <span className="text-sm text-fg-2">{cat.name}</span>
                    </label>
                  ))}
                </div>
                {selectedCategoryIds.length > 0 && (
                  <p className="text-xs text-primary-fg mt-1">{selectedCategoryIds.length} categor{selectedCategoryIds.length > 1 ? 'ies' : 'y'} selected</p>
                )}
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={saving}
                className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition disabled:opacity-50">
                {saving ? 'Saving...' : editingId ? 'Update Brand' : 'Save Brand'}
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
      ) : brands.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-fg-subtle text-lg">No brands yet</p>
        </div>
      ) : (
        <div className="bg-surface rounded-xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-2 border-y">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-bold text-fg-muted uppercase tracking-wider">Brand Name</th>
                  <th className="px-6 py-3 text-center text-xs font-bold text-fg-muted uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {brands
                  .filter(b => (b.name || '').toLowerCase().includes(searchBrand.trim().toLowerCase()))
                  .map((brand) => (
                  <tr key={brand.id} className="hover:bg-surface-2 transition">
                    <td className="px-6 py-4 whitespace-nowrap font-semibold text-fg">{brand.name}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => handleViewProducts(brand)}
                          className="px-3 py-1 bg-primary-soft hover:bg-primary-muted text-primary-fg rounded font-medium transition flex items-center gap-1"
                        >
                          📦 View Products
                        </button>
                        <button
                          onClick={() => handleEdit(brand)}
                          className="px-3 py-1 hover:bg-surface-3 text-fg-3 rounded font-medium transition border"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(brand.id)}
                          className="px-3 py-1 hover:bg-danger-soft text-danger-fg rounded font-medium transition border border-transparent hover:border-danger-line"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {brands.filter(b => (b.name || '').toLowerCase().includes(searchBrand.trim().toLowerCase())).length === 0 && (
                  <tr>
                    <td colSpan="2" className="px-6 py-8 text-center text-fg-muted">No brands match your search</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* View Products Modal */}
      {viewBrand && (
        <div className="fixed inset-0 bg-black/40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4" onClick={() => setViewBrand(null)}>
          <div className="bg-surface rounded-2xl shadow-2xl p-6 w-full max-w-4xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4 shrink-0">
              <div>
                <h2 className="text-xl font-bold text-fg">📦 Products of {viewBrand.name}</h2>
                <p className="text-xs text-fg-muted">Click any product row to view purchase price history</p>
              </div>
              <button onClick={() => setViewBrand(null)} className="text-fg-subtle hover:text-fg-3 text-2xl">×</button>
            </div>

            <div className="flex-1 overflow-auto border rounded-xl bg-surface-2">
              {loadingProducts ? (
                <p className="text-center text-fg-subtle py-10">Loading products...</p>
              ) : brandProducts.length === 0 ? (
                <p className="text-center text-fg-subtle py-10 italic">No products found for this brand.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-surface-3 sticky top-0 z-10">
                    <tr className="border-b">
                      <th className="px-4 py-2 text-left text-xs font-bold text-fg-muted uppercase">Product</th>
                      <th className="px-4 py-2 text-right text-xs font-bold text-fg-muted uppercase">C. Rate</th>
                      <th className="px-4 py-2 text-right text-xs font-bold text-fg-muted uppercase">Cost Price</th>
                      <th className="px-4 py-2 text-right text-xs font-bold text-fg-muted uppercase">Sale Price</th>
                      <th className="px-4 py-2 text-center text-xs font-bold text-fg-muted uppercase">Stock</th>
                      <th className="px-4 py-2 text-center text-xs font-bold text-fg-muted uppercase">History</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line bg-surface">
                    {brandProducts.map(p => (
                      <>
                        <tr key={p.id} className={`hover:bg-surface-2 cursor-pointer transition ${expandedProductId === p.id ? 'bg-primary-soft' : ''}`} onClick={() => fetchProductHistory(p.id)}>
                          <td className="px-4 py-3 font-medium text-fg">{p.name}</td>
                          <td className="px-4 py-3 text-right text-primary-fg font-bold">{p.c_rate || 0}</td>
                          <td className="px-4 py-3 text-right text-fg-2">Rs. {p.cost_price || 0}</td>
                          <td className="px-4 py-3 text-right font-bold text-success-fg">Rs. {p.sale_price || 0}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${p.stock_quantity <= 5 ? 'bg-danger-muted text-danger-fg' : 'bg-success-muted text-success-fg'}`}>{p.stock_quantity}</span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button className="text-primary-fg hover:text-primary-strong text-xs font-bold">
                              {expandedProductId === p.id ? '▲ Hide' : '▼ View'}
                            </button>
                          </td>
                        </tr>
                        {expandedProductId === p.id && (
                          <tr key={`${p.id}-history`}>
                            <td colSpan="6" className="px-4 py-2 bg-primary-soft/50">
                              {loadingHistoryId === p.id ? (
                                <p className="text-center text-fg-subtle text-xs py-3">Loading history...</p>
                              ) : (productHistory[p.id]?.length || 0) === 0 ? (
                                <p className="text-center text-fg-subtle text-xs py-3 italic">No previous purchases found.</p>
                              ) : (
                                <div className="border rounded-lg overflow-hidden mx-4 my-1">
                                  <table className="w-full text-xs">
                                    <thead className="bg-surface-3">
                                      <tr>
                                        <th className="px-3 py-1.5 text-left text-fg-muted font-bold">Date</th>
                                        <th className="px-3 py-1.5 text-left text-fg-muted font-bold">Supplier</th>
                                        <th className="px-3 py-1.5 text-right text-fg-muted font-bold">Purchase Rate</th>
                                        <th className="px-3 py-1.5 text-right text-fg-muted font-bold">Qty</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-line-subtle">
                                      {productHistory[p.id].map((h, idx) => (
                                        <tr key={idx} className={`${idx === 0 ? 'bg-warning-soft font-semibold' : 'hover:bg-surface-2'}`}>
                                          <td className="px-3 py-1.5 text-fg-3">{h.date ? new Date(h.date).toLocaleDateString('en-PK') : '-'}</td>
                                          <td className="px-3 py-1.5 text-fg-3">{h.supplier}</td>
                                          <td className={`px-3 py-1.5 text-right font-bold ${idx > 0 && h.price !== productHistory[p.id][idx - 1]?.price ? 'text-warning-fg' : 'text-fg'}`}>Rs. {h.price}</td>
                                          <td className="px-3 py-1.5 text-right text-fg-muted">{h.qty}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Brands
