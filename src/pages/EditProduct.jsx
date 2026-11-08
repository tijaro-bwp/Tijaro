import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { useNavigate, useParams } from 'react-router-dom'
import { db, addToSyncQueue } from '../services/db'
import { toIntId } from '../services/integrity'
import { getShopPreset, getPricingConfig, isWholesaleEnabled } from '../utils/businessPresets'

function EditProduct() {
  const { id } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()

  const shopSettings = (() => {
    try {
      const sid = user?.shop_id
      return JSON.parse((sid ? localStorage.getItem(`shop_settings_${sid}`) : null) || '{}')
    } catch (_) { return {} }
  })()
  const preset = getShopPreset(shopSettings)
  const pricingConfig = getPricingConfig(shopSettings)
  const wholesaleEnabled = isWholesaleEnabled(shopSettings)
  const priceFieldCount = 2 + (pricingConfig.enabled ? 1 : 0) + (wholesaleEnabled ? 1 : 0)

  const [categories, setCategories] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [brands, setBrands] = useState([])
  const [units, setUnits] = useState([])
  const [brandCategoryMap, setBrandCategoryMap] = useState({})
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [showNewBrandInput, setShowNewBrandInput] = useState(false)
  const [newBrandName, setNewBrandName] = useState('')
  const [form, setForm] = useState({
    name: '',
    sku: '',
    brand: '',
    category_id: '',
    supplier_id: '',
    unit_id: '',
    c_rate: '',
    cost_price: '',
    wholesale_price: '',
    sale_price: '',
    stock_quantity: '',
    low_stock_threshold: '10',
    status: 'active'
  })

  useEffect(() => {
    fetchData()
  }, [id])

  const fetchData = async () => {
    try {
      if (!navigator.onLine) throw new Error('Offline')

      // Fetch product and relationships
      const fetchPromise = Promise.all([
        supabase.from('products').select('*').eq('id', id).eq('shop_id', user.shop_id).maybeSingle(),
        supabase.from('categories').select('*').eq('shop_id', user.shop_id).order('name'),
        supabase.from('suppliers').select('*').eq('shop_id', user.shop_id).order('name'),
        supabase.from('brands').select('*').eq('shop_id', user.shop_id).order('name'),
        supabase.from('units').select('*').eq('shop_id', user.shop_id).order('name')
      ])

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
      const [prodResult, catResult, supResult, brandResult, unitResult] = await Promise.race([fetchPromise, timeoutPromise])

      if (prodResult.error || !prodResult.data) throw new Error('Product not found')

      const product = prodResult.data
      if (unitResult?.data) { setUnits(unitResult.data); try { await db.units.bulkPut(JSON.parse(JSON.stringify(unitResult.data))) } catch (_) {} }
      setForm({
        name: product.name || '',
        sku: product.sku || '',
        brand: product.brand || '',
        category_id: product.category_id || '',
        supplier_id: product.supplier_id || '',
        unit_id: product.unit_id || '',
        c_rate: product.c_rate || '',
        cost_price: product.cost_price || '',
        wholesale_price: product.wholesale_price || '',
        sale_price: product.sale_price || '',
        stock_quantity: product.stock_quantity || '',
        low_stock_threshold: product.low_stock_threshold || '10',
        status: product.status || 'active'
      })

      const sid = String(user.shop_id)

      if (catResult.data) {
        setCategories(catResult.data)
        await db.categories.bulkPut(JSON.parse(JSON.stringify(catResult.data)))
      }
      if (supResult.data) {
        setSuppliers(supResult.data)
        await db.suppliers.bulkPut(JSON.parse(JSON.stringify(supResult.data)))
      }
      if (brandResult.data) {
        setBrands(brandResult.data)
        await db.brands.bulkPut(JSON.parse(JSON.stringify(brandResult.data)))
      }

      // Load brand-category map
      const sid2 = String(user.shop_id)
      const lBrandCats = await db.brand_categories.toArray().catch(() => [])
      const myBrandCats = lBrandCats.filter(x => String(x.shop_id) === sid2)
      const bcMap = {}
      myBrandCats.forEach(bc => {
        if (!bcMap[bc.brand_id]) bcMap[bc.brand_id] = []
        bcMap[bc.brand_id].push(bc.category_id)
      })
      setBrandCategoryMap(bcMap)

    } catch (e) {
      console.log('EditProduct: Fetching from local DB (Offline)')
      try {
        const localProd = await db.products.get(id)
        if (localProd) {
            setForm({
                name: localProd.name || '',
                sku: localProd.sku || '',
                brand: localProd.brand || '',
                category_id: localProd.category_id || '',
                supplier_id: localProd.supplier_id || '',
                unit_id: localProd.unit_id || '',
                c_rate: localProd.c_rate || '',
                cost_price: localProd.cost_price || '',
                wholesale_price: localProd.wholesale_price || '',
                sale_price: localProd.sale_price || '',
                stock_quantity: localProd.stock_quantity || '',
                low_stock_threshold: localProd.low_stock_threshold || '10',
                status: localProd.status || 'active'
            })
        }
        const offlineSid = String(user.shop_id)
        const lUnits = await db.units.toArray().catch(() => [])
        setUnits(lUnits.filter(x => String(x.shop_id) === offlineSid))

        const [lCats, lSups, lBrands] = await Promise.all([
          db.categories.toArray(),
          db.suppliers.toArray(),
          db.brands.toArray()
        ])
        setCategories(lCats.filter(x => String(x.shop_id) === offlineSid))
        setSuppliers(lSups.filter(x => String(x.shop_id) === offlineSid))
        setBrands(lBrands.filter(x => String(x.shop_id) === offlineSid))
        const lBrandCats = await db.brand_categories.toArray().catch(() => [])
        const myBrandCats = lBrandCats.filter(x => String(x.shop_id) === offlineSid)
        const bcMap = {}
        myBrandCats.forEach(bc => {
          if (!bcMap[bc.brand_id]) bcMap[bc.brand_id] = []
          bcMap[bc.brand_id].push(bc.category_id)
        })
        setBrandCategoryMap(bcMap)
      } catch (err) {
        console.error('Local DB EditProduct Error:', err)
      }
    } finally {
        setFetching(false)
    }
  }

  const handleAddBrand = async () => {
    if (!newBrandName.trim()) return

    const brandData = { id: crypto.randomUUID(), name: newBrandName.trim(), shop_id: user.shop_id }

    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')

      // Strip the local UUID id — brands.id is SERIAL (integer) in Supabase
      const { id: _localId, ...supabasePayload } = brandData
      const { data, error } = await supabase.from('brands').insert([supabasePayload]).select()
      if (error) throw error

      setBrands([...brands, data[0]])
      setForm({ ...form, brand: data[0].name })
    } catch (err) {
      const errMsg = err?.message || String(err)
      if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
        await db.brands.add(brandData)
        await addToSyncQueue('brands', 'INSERT', brandData)
        setBrands([...brands, brandData])
        setForm({ ...form, brand: brandData.name })
        alert('Offline mode: Brand added locally. Will sync when online! 🔄')
      } else {
        alert('Error adding brand: ' + errMsg)
      }
    }

    setNewBrandName('')
    setShowNewBrandInput(false)
  }

  const handleChange = (e) => {
    const { name, value } = e.target
    if (name === 'brand') {
      const brandObj = brands.find(b => b.name === value)
      const allowedCatIds = brandObj ? brandCategoryMap[brandObj.id] : null
      const currentCatAllowed = !allowedCatIds || allowedCatIds.includes(parseInt(form.category_id))
      setForm(prev => ({ ...prev, brand: value, category_id: currentCatAllowed ? prev.category_id : '' }))
    } else {
      setForm({ ...form, [name]: value })
    }
  }

  // Filtered categories based on selected brand
  const brandObj = brands.find(b => b.name === form.brand)
  const filteredCategories = brandObj && brandCategoryMap[brandObj.id]?.length
    ? categories.filter(c => brandCategoryMap[brandObj.id].includes(c.id))
    : categories

  const autoGenerateSKU = () => {
    const prefix = (form.name || 'PRD').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase()
    const suffix = Math.floor(1000 + Math.random() * 9000)
    setForm(prev => ({ ...prev, sku: `${prefix}-${suffix}` }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)

    const updatedProductData = { ...form }
    
    // Ensure numeric fields are parsed correctly, treating empty strings as null/0 based on DB defaults
    if(updatedProductData.c_rate === '') updatedProductData.c_rate = 0;
    // Only send wholesale_price when the shop uses Wholesale Mode (keeps un-migrated DBs working)
    if (wholesaleEnabled) updatedProductData.wholesale_price = Number(updatedProductData.wholesale_price) || 0
    else delete updatedProductData.wholesale_price

    // Sanitize integer FK fields — offline-created records have UUID ids which
    // Supabase cannot cast to INTEGER. Parse to int; if it fails (UUID), set null.
    const toIntOrNull = toIntId // strict: never parseInt a UUID
    updatedProductData.category_id = updatedProductData.category_id ? toIntOrNull(updatedProductData.category_id) : null
    updatedProductData.supplier_id = updatedProductData.supplier_id ? toIntOrNull(updatedProductData.supplier_id) : null
    updatedProductData.unit_id = updatedProductData.unit_id ? toIntOrNull(updatedProductData.unit_id) : null

    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')

      const { error } = await supabase.from('products').update(updatedProductData).eq('id', id)
      if (error) throw error

      alert('Product updated successfully!')
      navigate('/products')
    } catch (error) {
      const errMsg = error?.message || String(error)
      if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
        // Offline: Save to Local DB and Queue Sync
        await db.products.update(id, updatedProductData)
        await addToSyncQueue('products', 'UPDATE', { id, ...updatedProductData })
        alert('Offline mode: Product updated locally! It will sync automatically when you are back online. 🔄')
        navigate('/products')
      } else {
        alert('Error: ' + error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  if (fetching) {
      return <div className="text-fg-muted p-6">Loading product data...</div>
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-fg mb-6">✏️ Edit Product</h1>

      <div className="bg-surface rounded-xl shadow p-6 max-w-3xl">
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Basic Info */}
          <h2 className="font-semibold text-fg-2 border-b pb-2">Basic Information</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-fg-2 font-medium mb-1">Product Name *</label>
              <input
                type="text"
                name="name"
                value={form.name}
                onChange={handleChange}
                required
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder={preset.placeholders.productName}
              />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1 flex justify-between">
                <span>Brand</span>
                <button
                  type="button"
                  onClick={() => setShowNewBrandInput(!showNewBrandInput)}
                  className="text-[10px] text-primary-fg font-bold uppercase hover:underline"
                >
                  {showNewBrandInput ? '← Select' : '+ New Brand'}
                </button>
              </label>
              {showNewBrandInput ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newBrandName}
                    onChange={(e) => setNewBrandName(e.target.value)}
                    className="flex-1 px-4 py-2 border border-primary-edge bg-primary-soft rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="Brand name..."
                  />
                  <button
                     type="button"
                    onClick={handleAddBrand}
                    className="px-3 bg-primary text-white rounded-lg font-bold"
                  >
                    Add
                  </button>
                </div>
              ) : (
                <select
                  name="brand"
                  value={form.brand}
                  onChange={handleChange}
                  className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">Select brand</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.name}>{b.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-fg-2 font-medium mb-1">SKU / Barcode</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  name="sku"
                  value={form.sku}
                  onChange={handleChange}
                  onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
                  className="flex-1 px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-mono"
                  placeholder={preset.placeholders.sku}
                />
                <button type="button" onClick={autoGenerateSKU}
                  className="px-3 py-2 bg-surface-3 hover:bg-primary-muted text-fg-3 hover:text-primary-strong rounded-lg text-xs font-bold transition whitespace-nowrap border border-line">
                  ⚡ Auto
                </button>
              </div>
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1">Category</label>
              <select
                name="category_id"
                value={form.category_id}
                onChange={handleChange}
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">Select category</option>
                {filteredCategories.map((cat) => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-fg-2 font-medium mb-1">Supplier</label>
            <select
              name="supplier_id"
              value={form.supplier_id}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">Select supplier</option>
              {suppliers.map((sup) => (
                <option key={sup.id} value={sup.id}>{sup.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-fg-2 font-medium mb-1">Unit of Measure</label>
            <select name="unit_id" value={form.unit_id} onChange={handleChange}
              className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary">
              <option value="">Select unit...</option>
              {units.map(u => <option key={u.id} value={u.id}>{u.name}{u.abbreviation ? ` (${u.abbreviation})` : ''}</option>)}
            </select>
            {units.length === 0 && <p className="text-xs text-fg-subtle mt-1">Units add karne ke liye Master Data → Units mein jayein</p>}
          </div>

          {/* Pricing */}
          <h2 className="font-semibold text-fg-2 border-b pb-2 pt-2">Pricing</h2>

          <div className={`grid gap-4 grid-cols-1 ${priceFieldCount === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : priceFieldCount === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
            {pricingConfig.enabled && (
              <div>
                <label className="block text-fg-2 font-medium mb-1">{pricingConfig.label}</label>
                <input
                  type="number"
                  name="c_rate"
                  value={form.c_rate}
                  onChange={handleChange}
                  className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="0"
                />
              </div>
            )}
            <div>
              <label className="block text-fg-2 font-medium mb-1">Purchase / Cost Price *</label>
              <input
                type="number"
                name="cost_price"
                value={form.cost_price}
                onChange={handleChange}
                required
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="0"
              />
            </div>
            {wholesaleEnabled && (
              <div>
                <label className="block text-fg-2 font-medium mb-1">Wholesale Price</label>
                <input
                  type="number"
                  name="wholesale_price"
                  value={form.wholesale_price}
                  onChange={handleChange}
                  className="w-full px-4 py-2 border border-wholesale-edge rounded-lg focus:outline-none focus:ring-2 focus:ring-wholesale"
                  placeholder="0 = use retail"
                />
              </div>
            )}
            <div>
              <label className="block text-fg-2 font-medium mb-1">{wholesaleEnabled ? 'Retail Price *' : 'Sale / Selling Price *'}</label>
              <input
                type="number"
                name="sale_price"
                value={form.sale_price}
                onChange={handleChange}
                required
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="0"
              />
            </div>
          </div>

          {/* Profit Preview */}
          {form.cost_price && form.sale_price && (
            <div className="bg-success-soft border border-success-line rounded-lg p-3">
              <p className="text-success-strong font-medium">
                💰 Profit per unit: Rs. {(parseFloat(form.sale_price) - parseFloat(form.cost_price)).toFixed(2)}
                <span className="ml-3 text-success-fg">
                  ({(((parseFloat(form.sale_price) - parseFloat(form.cost_price)) / parseFloat(form.cost_price)) * 100).toFixed(1)}%)
                </span>
              </p>
            </div>
          )}
          {wholesaleEnabled && form.cost_price && Number(form.wholesale_price) > 0 && (
            <div className={`${Number(form.wholesale_price) < Number(form.cost_price) ? 'bg-danger-soft border-danger-line text-danger-strong' : 'bg-wholesale-soft border-wholesale-line text-wholesale-strong'} border rounded-lg p-3 font-medium`}>
              {Number(form.wholesale_price) < Number(form.cost_price)
                ? `⚠️ Wholesale price is below cost — loss of Rs. ${(Number(form.cost_price) - Number(form.wholesale_price)).toFixed(2)} per unit`
                : `🏷️ Wholesale profit per unit: Rs. ${(Number(form.wholesale_price) - Number(form.cost_price)).toFixed(2)}`}
            </div>
          )}

          {/* Stock */}
          <h2 className="font-semibold text-fg-2 border-b pb-2 pt-2">Stock</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-fg-2 font-medium mb-1">Stock Quantity *</label>
              <input
                type="number"
                name="stock_quantity"
                value={form.stock_quantity}
                onChange={handleChange}
                required
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-fg-2 font-medium mb-1">Low Stock Alert</label>
              <input
                type="number"
                name="low_stock_threshold"
                value={form.low_stock_threshold}
                onChange={handleChange}
                className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="10"
              />
            </div>
          </div>

          <div>
            <label className="block text-fg-2 font-medium mb-1">Status</label>
            <select
              name="status"
              value={form.status}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-line-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition disabled:opacity-50">
              {loading ? 'Saving Update...' : 'Update Product'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/products')}
              className="px-6 py-2 bg-surface-4 hover:bg-surface-5 text-fg-2 rounded-lg transition">
              Cancel
            </button>
          </div>

        </form>
      </div>
    </div>
  )
}

export default EditProduct
