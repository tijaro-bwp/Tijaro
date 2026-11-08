import { useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../services/supabase'
import { fetchAllRows } from '../services/fetchAll'
import { useAuth } from '../context/AuthContext'
import { db, addToSyncQueue } from '../services/db'
import { toIntId, isTempId, isNetworkError, isMissingColumn, adjustStock, adjustCustomerBalance } from '../services/integrity'
import { recordAuditLog } from '../services/auditService'
import { buildBillHTML } from '../utils/billTemplates'
import { hasFeature } from '../utils/featureGate'
import { generateBillPDF, shareOrDownloadPDF } from '../utils/pdfShare'
import { printHTML } from '../utils/printUtils'
import { getPricingConfig, getShopSettings, isWholesaleEnabled, getUnitPrice, normalizeTier } from '../utils/businessPresets'
import { BRAND } from '../config/brand.js'
const PAKISTANI_PAYMENT_PROVIDERS = [
  { id: 'jazzcash', name: 'JazzCash', icon: '📱' },
  { id: 'easypaisa', name: 'Easypaisa', icon: '🟢' },
  { id: 'sadapay', name: 'SadaPay', icon: '💳' },
  { id: 'nayapay', name: 'NayaPay', icon: '🟣' }
]

const getCategoryColor = (catName = '') => {
  const lower = String(catName || '').toLowerCase()
  if (lower.includes('pipe') || lower.includes('fitting') || lower.includes('pvc') || lower.includes('upvc'))
    return { border: 'border-t-success', pill: 'bg-success-muted text-success-strong border-success-line' }
  if (lower.includes('tile') || lower.includes('ceramic') || lower.includes('marble') || lower.includes('granite'))
    return { border: 'border-t-warning', pill: 'bg-warning-muted text-warning-strong border-warning-line' }
  if (lower.includes('paint') || lower.includes('chemical') || lower.includes('color') || lower.includes('distemper'))
    return { border: 'border-t-info', pill: 'bg-info-muted text-info-strong border-info-line' }
  if (lower.includes('sanitary') || lower.includes('tap') || lower.includes('shower') || lower.includes('faucet') || lower.includes('basin'))
    return { border: 'border-t-primary', pill: 'bg-primary-muted text-primary-strong border-primary-line' }
  if (lower.includes('electric') || lower.includes('wire') || lower.includes('cable') || lower.includes('switch') || lower.includes('light'))
    return { border: 'border-t-warning', pill: 'bg-warning-muted text-warning-strong border-warning-line' }
  if (lower.includes('tool') || lower.includes('hardware') || lower.includes('iron') || lower.includes('valve') || lower.includes('screw'))
    return { border: 'border-t-contrast', pill: 'bg-surface-4 text-fg border-line-strong' }
  return { border: 'border-t-line-strong', pill: 'bg-surface-3 text-fg-2 border-line' }
}

function POS() {
  const { user } = useAuth()
  const shopSettings = getShopSettings(user?.shop_id)
  const pricingConfig = getPricingConfig(shopSettings)
  const wholesaleEnabled = isWholesaleEnabled(shopSettings)
  const [searchParams] = useSearchParams()

  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [customers, setCustomers] = useState([])
  const [brands, setBrands] = useState([])

  const [brandCategoryMap, setBrandCategoryMap] = useState({}) // brandId -> [categoryId,...]
  const [cardQtys, setCardQtys] = useState({}) // productId -> qty string

  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedBrand, setSelectedBrand] = useState('')

  const [cart, setCart] = useState([])

  // ── Price tier (Retail / Wholesale) ──────────────────────────
  // baseTier = cashier's chosen default (persisted per shop); priceTier = tier for the current bill
  // (a wholesale customer can switch it for one bill; clearing the cart returns to baseTier).
  const tierKey = `pos_price_tier_${user?.shop_id}`
  const [baseTier, setBaseTier] = useState(() => {
    if (!wholesaleEnabled) return 'retail'
    try { return normalizeTier(localStorage.getItem(tierKey)) } catch { return 'retail' }
  })
  const [priceTier, setPriceTier] = useState(baseTier)
  const [tierNotice, setTierNotice] = useState('')
  const activeTier = wholesaleEnabled ? priceTier : 'retail'
  const isWholesale = activeTier === 'wholesale'
  const tierPrice = (product) => getUnitPrice(product, activeTier).price
  const [customerId, setCustomerId] = useState('')
  const [walkInName, setWalkInName] = useState('')
  const [paymentType, setPaymentType] = useState('cash')
  const [onlineProvider, setOnlineProvider] = useState('jazzcash')
  const [transactionRef, setTransactionRef] = useState('')
  const searchInputRef = useRef(null)
  const [receivedAmount, setReceivedAmount] = useState('') // New state for partial payments
  const [payments, setPayments] = useState([]) // [{method, amount}]
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [discount, setDiscount] = useState(0)
  const [discountMode, setDiscountMode] = useState('fixed') // 'fixed' | 'percent'
  const [discountPercent, setDiscountPercent] = useState('')
  const [saleType, setSaleType] = useState('sale')

  const subtotal = cart.reduce((sum, i) => sum + i.custom_price * i.qty, 0)
  const rawDiscount = discountMode === 'percent'
    ? Math.round((subtotal * (parseFloat(discountPercent) || 0)) / 100 * 100) / 100
    : parseFloat(discount) || 0
  // Never more than the bill, never negative (a bigger discount used to save a negative net sale)
  const totalDiscount = Math.min(subtotal, Math.max(0, rawDiscount))
  const total = Math.max(0, subtotal - totalDiscount)
  const totalProfit = cart.reduce((sum, i) => sum + (i.custom_price - (i.cost_price || 0)) * i.qty, 0) - totalDiscount
  const [saving, setSaving] = useState(false)
  const [lastReceipt, setLastReceipt] = useState(null)
  const [showQuotationSearch, setShowQuotationSearch] = useState(false)
  const [quotationIdInput, setQuotationIdInput] = useState('')
  const [form, setForm] = useState(() => {
    const sid = user?.shop_id
    const saved = sid ? localStorage.getItem(`shop_settings_${sid}`) : null
    if (saved) {
      try {
        return JSON.parse(saved)
      } catch (e) { /* fallback */ }
    }
    return {
      name: (sid ? localStorage.getItem(`shop_name_${sid}`) : null) || BRAND.appName,
      phone: '',
      address: '',
      invoice_footer: 'شکریہ! دوبارہ تشریف لائیں',
      quotation_footer: 'یہ صرف قیمت نامہ ہے',
      print_size: 'thermal',
      print_mode: 'manual',
      logo_url: (sid ? localStorage.getItem(`shop_logo_${sid}`) : null) || '',
      wa_reminder_template: 'Hello [Name], this is a reminder from [Shop Name] regarding your outstanding balance of Rs. [Amount]. Please clear your dues at your earliest convenience. Thank you!',
      wa_bill_template: 'Hello [Name], thank you for shopping at [Shop Name]! Your bill summary for Invoice #[ID] is Rs. [Amount]. Thank you for your business!'
    }
  })

  // POS Layout configuration (two_stage | bottom_dock | compact_dock)
  const [posLayout, setPosLayout] = useState(() => {
    const sid = user?.shop_id
    const saved = sid ? localStorage.getItem(`shop_settings_${sid}`) : null
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed.pos_layout) return parsed.pos_layout
      } catch (_) {}
    }
    return 'two_stage'
  })
  const [showTenderSheet, setShowTenderSheet] = useState(false)

  const switchPosLayout = (newLayout) => {
    setPosLayout(newLayout)
    const sid = user?.shop_id
    if (sid) {
      try {
        const saved = localStorage.getItem(`shop_settings_${sid}`)
        const current = saved ? JSON.parse(saved) : {}
        current.pos_layout = newLayout
        localStorage.setItem(`shop_settings_${sid}`, JSON.stringify(current))
        window.dispatchEvent(new Event('storage'))
      } catch (_) {}
    }
  }

  // Sync layout changes across tabs and from Settings page
  useEffect(() => {
    const handleStorageChange = () => {
      const sid = user?.shop_id
      const saved = sid ? localStorage.getItem(`shop_settings_${sid}`) : null
      if (saved) {
        try {
          const parsed = JSON.parse(saved)
          if (parsed.pos_layout && parsed.pos_layout !== posLayout) {
            setPosLayout(parsed.pos_layout)
          }
        } catch (_) {}
      }
    }
    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [user?.shop_id, posLayout])

  // Keyboard shortcut: F4 triggers Charge / Tender Sheet, Escape closes it
  useEffect(() => {
    const handlePOSKeyShortcuts = (e) => {
      if (e.key === 'F4') {
        e.preventDefault()
        if (cart.length > 0 && saleType === 'sale') {
          setShowTenderSheet(prev => !prev)
        }
      }
      if (e.key === 'Escape' && showTenderSheet) {
        e.preventDefault()
        setShowTenderSheet(false)
      }
    }
    window.addEventListener('keydown', handlePOSKeyShortcuts)
    return () => window.removeEventListener('keydown', handlePOSKeyShortcuts)
  }, [cart.length, saleType, showTenderSheet])

  // Barcode scanner mode
  const [barcodeMode, setBarcodeMode] = useState(false) // Off by default — user must click to enable
  const [barcodeInput, setBarcodeInput] = useState('')
  const barcodeRef = useRef(null)

  useEffect(() => {
    if (barcodeMode && barcodeRef.current) barcodeRef.current.focus()
  }, [barcodeMode])

  // When barcode mode is active, route physical scanner keystrokes to the hidden input.
  // Only active after the user explicitly enables barcode mode via the toggle button.
  useEffect(() => {
    if (!barcodeMode) return; // Do nothing when barcode mode is off

    const handleGlobalKeyDown = (e) => {
      const activeEl = document.activeElement;
      // If any real input/select already has focus, let it handle the keystroke normally
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
         activeEl.tagName === 'TEXTAREA' ||
         activeEl.tagName === 'SELECT' ||
         activeEl.isContentEditable)
      ) {
        if (activeEl === barcodeRef.current) return;
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1) {
        setBarcodeInput(prev => prev + e.key);
        if (barcodeRef.current && activeEl !== barcodeRef.current) {
          barcodeRef.current.focus()
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [barcodeMode]);

  const handleBarcodeSubmit = (e) => {
    e.preventDefault()
    const rawSku = barcodeInput.trim()
    if (!rawSku) return
    const skuLower = rawSku.toLowerCase()
    const cleanSku = rawSku.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()

    const product = products.find(p => {
      const pSku = String(p.sku || '').trim().toLowerCase()
      const pId = String(p.id || '').trim()
      const pName = String(p.name || '').trim().toLowerCase()
      const cleanPSku = pSku.replace(/[^a-zA-Z0-9]/g, '')

      return (
        (pSku && (pSku === skuLower || cleanPSku === cleanSku)) ||
        (pId && pId === rawSku) ||
        (pName && pName === skuLower)
      )
    })

    if (product) {
      addToCart(product)
    } else {
      try {
        const beep = new AudioContext()
        const osc = beep.createOscillator()
        osc.connect(beep.destination)
        osc.frequency.value = 200
        osc.start(); osc.stop(beep.currentTime + 0.15)
      } catch (_) {}
      alert(`❌ SKU / Barcode "${rawSku}" — product not found. Add SKU in Products page.`)
    }
    setBarcodeInput('')
    setTimeout(() => barcodeRef.current?.focus(), 50)
  }

  // Save walk-in as customer
  const [showSaveCustomer, setShowSaveCustomer] = useState(false)
  const [saveCustomerForm, setSaveCustomerForm] = useState({ name: '', mobile: '' })
  const [savingCustomer, setSavingCustomer] = useState(false)

  // Brand bulk discount modal
  const [showBrandDiscount, setShowBrandDiscount] = useState(false)
  const [brandDiscountType, setBrandDiscountType] = useState('percent')
  const [brandDiscountValue, setBrandDiscountValue] = useState('')
  const [brandDiscountMode, setBrandDiscountMode] = useState('cart_only') // 'cart_only' or 'add_all'

  // Held Carts
  const [heldCarts, setHeldCarts] = useState([])
  const [showHeldCarts, setShowHeldCarts] = useState(false)
  const [showQuickView, setShowQuickView] = useState(false)
  const [showMobileCart, setShowMobileCart] = useState(false)

  useEffect(() => {
    if (user?.shop_id) fetchAll()
  }, [user?.shop_id])

  // Auto-load quotation if ID is in URL
  useEffect(() => {
    const qId = searchParams.get('convertQuote')
    if (qId && products.length > 0) {
      handleAutoConvert(qId)
    }
  }, [searchParams, products])

  useEffect(() => {
    fetchHeldCarts()
    
    // Listen for cross-tab settings updates
    const handleSync = () => {
      console.log('POS: Syncing settings from storage/focus change...')
      fetchAll()
    }
    
    window.addEventListener('storage', handleSync)
    window.addEventListener('focus', handleSync)
    
    return () => {
      window.removeEventListener('storage', handleSync)
      window.removeEventListener('focus', handleSync)
    }
  }, [])

  const fetchHeldCarts = async () => {
    const carts = await db.held_carts.where('shop_id').equals(user.shop_id).toArray()
    setHeldCarts(carts)
  }

  const handleAutoConvert = async (id) => {
    const { data: sale, error } = await supabase
      .from('sales')
      .select('*, sale_items(*)')
      .eq('id', id)
      .maybeSingle()

    if (sale) {
      const items = sale.sale_items.map(si => {
        const prod = products.find(p => p.id === si.product_id)
        return {
          ...prod,
          id: si.product_id,
          name: si.product_name,
          qty: si.quantity,
          custom_price: si.unit_price,
          cost_price: si.cost_price,
          price_overridden: true
        }
      })
      if (wholesaleEnabled) setPriceTier(normalizeTier(sale.price_tier))
      setCart(items)
      setCustomerId(sale.customer_id || '')
      setWalkInName(sale.customer_name || '')
      setSaleType('sale')
    }
  }

  const fetchAll = async () => {
    if (!user?.shop_id) {
      console.error('POS: Missing user.shop_id!')
      return
    }

    const sid = String(user.shop_id)

    // ── Step 1: Show local IndexedDB data IMMEDIATELY (instant UI) ────────────
    try {
      const [lProds, lCats, lCustomers, lBrands, lBrandCats] = await Promise.all([
        db.products.toArray(),
        db.categories.toArray(),
        db.customers.toArray(),
        db.brands.toArray(),
        db.brand_categories.toArray().catch(() => [])
      ])
      const myProds = lProds.filter(x => String(x.shop_id) === sid)
      const myCats = lCats.filter(x => String(x.shop_id) === sid)
      const myCustomers = lCustomers.filter(x => String(x.shop_id) === sid)
      const myBrands = lBrands.filter(x => String(x.shop_id) === sid)
      const myBrandCats = lBrandCats.filter(x => String(x.shop_id) === sid)
      const bcMap = {}
      myBrandCats.forEach(bc => {
        if (!bcMap[bc.brand_id]) bcMap[bc.brand_id] = []
        bcMap[bc.brand_id].push(bc.category_id)
      })
      setProducts(myProds)
      setCategories(myCats)
      setCustomers(myCustomers)
      setBrands(myBrands)
      setBrandCategoryMap(bcMap)
    } catch (localErr) {
      console.warn('POS: Local DB read failed:', localErr)
    }

    // ── Step 2: Background refresh from Supabase (updates UI silently) ────────
    if (!navigator.onLine) return;
    try {
      const [p, c, cu, b, s] = await Promise.all([
        fetchAllRows(() => supabase.from('products').select('*, categories(name)').eq('shop_id', user.shop_id).or('status.eq.active,status.is.null')),
        supabase.from('categories').select('*').eq('shop_id', user.shop_id),
        fetchAllRows(() => supabase.from('customers').select('*').eq('shop_id', user.shop_id).order('name')),
        supabase.from('brands').select('*').eq('shop_id', user.shop_id).order('name'),
        supabase.from('shops').select('*').eq('id', user.shop_id).maybeSingle()
      ])

      if (p.data) await db.products.bulkPut(JSON.parse(JSON.stringify(p.data)))
      if (c.data) await db.categories.bulkPut(JSON.parse(JSON.stringify(c.data)))
      if (cu.data) await db.customers.bulkPut(JSON.parse(JSON.stringify(cu.data)))
      if (b.data) await db.brands.bulkPut(JSON.parse(JSON.stringify(b.data)))

      if (s.data) {
        setForm(prev => {
          const localLogo = localStorage.getItem(`shop_logo_${user?.shop_id}`) || ''
          return {
            ...prev,
            name: s.data.name || prev.name,
            phone: s.data.phone || prev.phone,
            address: s.data.address || prev.address,
            invoice_footer: s.data.invoice_footer || prev.invoice_footer,
            quotation_footer: s.data.quotation_footer || prev.quotation_footer,
            print_size: s.data.print_size || prev.print_size,
            print_mode: s.data.print_mode || prev.print_mode,
            logo_url: localLogo || s.data.logo_url || prev.logo_url || '',
            wa_reminder_template: s.data.wa_reminder_template || prev.wa_reminder_template,
            wa_bill_template: s.data.wa_bill_template || prev.wa_bill_template
          }
        })
      }

      // Re-render from merged local DB (cloud data + any pending offline records)
      const [lProds, lCats, lCustomers, lBrands, lBrandCats] = await Promise.all([
        db.products.toArray(),
        db.categories.toArray(),
        db.customers.toArray(),
        db.brands.toArray(),
        db.brand_categories.toArray().catch(() => [])
      ])

      const sid = String(user.shop_id);
      const myProds = lProds.filter(x => String(x.shop_id) === sid)
      const myCats = lCats.filter(x => String(x.shop_id) === sid)
      const myCustomers = lCustomers.filter(x => String(x.shop_id) === sid)
      const myBrands = lBrands.filter(x => String(x.shop_id) === sid)
      const myBrandCats = lBrandCats.filter(x => String(x.shop_id) === sid)
      const bcMap = {}
      myBrandCats.forEach(bc => {
        if (!bcMap[bc.brand_id]) bcMap[bc.brand_id] = []
        bcMap[bc.brand_id].push(bc.category_id)
      })

      setProducts(myProds)
      setCategories(myCats)
      setCustomers(myCustomers)
      setBrands(myBrands)
      setBrandCategoryMap(bcMap)
    } catch (e) {
      console.log('POS: Fetching from local DB (Offline Fallback)')
      try {
        const [lProds, lCats, lCustomers, lBrands, lBrandCats] = await Promise.all([
          db.products.toArray(),
          db.categories.toArray(),
          db.customers.toArray(),
          db.brands.toArray(),
          db.brand_categories.toArray().catch(() => [])
        ])

        // Filter locally for shop_id just in case, ensuring type safety
        const sid = String(user.shop_id);
        const myProds = lProds.filter(x => String(x.shop_id) === sid)
        const myCats = lCats.filter(x => String(x.shop_id) === sid)
        const myCustomers = lCustomers.filter(x => String(x.shop_id) === sid)
        const myBrands = lBrands.filter(x => String(x.shop_id) === sid)
        const myBrandCats = lBrandCats.filter(x => String(x.shop_id) === sid)
        const bcMap = {}
        myBrandCats.forEach(bc => {
          if (!bcMap[bc.brand_id]) bcMap[bc.brand_id] = []
          bcMap[bc.brand_id].push(bc.category_id)
        })

        setProducts(myProds)
        setCategories(myCats)
        setCustomers(myCustomers)
        setBrands(myBrands)
        setBrandCategoryMap(bcMap)

        // Load shop settings from local DB too
        const sidNumber = Number(user.shop_id)
        const localShop = await db.shops.get(sidNumber)
        if (localShop) {
          setForm(prev => {
            const localLogo = localStorage.getItem(`shop_logo_${user?.shop_id}`) || ''
            return {
              ...prev,
              name: localShop.name || prev.name,
              phone: localShop.phone || prev.phone,
              address: localShop.address || prev.address,
              logo_url: localLogo || localShop.logo_url || prev.logo_url || '',
              invoice_footer: localShop.invoice_footer || prev.invoice_footer,
              quotation_footer: localShop.quotation_footer || prev.quotation_footer,
              print_size: localShop.print_size || prev.print_size,
              print_mode: localShop.print_mode || prev.print_mode,
              wa_reminder_template: localShop.wa_reminder_template || prev.wa_reminder_template,
              wa_bill_template: localShop.wa_bill_template || prev.wa_bill_template
            }
          })
        }
      } catch (err) { console.error('Local DB POS Error', err) }
    }
  }

  // Union of brands from brands table AND products to guarantee zero missing brands
  const displayBrands = Array.from(new Set([
    ...brands.map(b => b.name?.trim()),
    ...products.map(p => p.brand?.trim())
  ])).filter(Boolean).sort((a, b) => a.localeCompare(b))

  // Filter categories by selected brand (brand-category link)
  const brandObj = brands.find(b => b.name?.toLowerCase() === selectedBrand?.trim().toLowerCase())
  const posCategories = brandObj && brandCategoryMap[brandObj.id]?.length
    ? categories.filter(c => brandCategoryMap[brandObj.id].includes(c.id))
    : categories

  // Reset selectedCategory if it's not in the filtered list
  useEffect(() => {
    if (selectedCategory && brandObj && brandCategoryMap[brandObj.id]?.length) {
      const allowed = brandCategoryMap[brandObj.id].map(String)
      if (!allowed.includes(String(selectedCategory))) setSelectedCategory('')
    }
  }, [selectedBrand])

  // Counter Keyboard Shortcuts (F2: search, F4: tender, F8: retail/wholesale, F9 / Ctrl+Enter: complete sale, Esc: clear/dismiss)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't intercept when typing in active text inputs except for function keys & Ctrl+Enter
      const activeEl = document.activeElement
      const isInputFocused = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')

      if (e.key === 'F8') {
        e.preventDefault()
        if (wholesaleEnabled) applyTier(isWholesale ? 'retail' : 'wholesale', { manual: true })
      } else if (e.key === 'F2') {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      } else if (e.key === 'F4') {
        e.preventDefault()
        if (cart.length > 0) {
          setShowTenderSheet(prev => !prev)
          setPaymentType('cash')
          if (!receivedAmount) setReceivedAmount(total.toString())
        }
      } else if (e.key === 'F9' || (e.ctrlKey && e.key === 'Enter')) {
        e.preventDefault()
        if (cart.length > 0 && !saving) {
          handleCompleteSale()
        }
      } else if (e.key === 'Escape') {
        if (showTenderSheet) setShowTenderSheet(false)
        else if (showPaymentModal) setShowPaymentModal(false)
        else if (showQuickView) setShowQuickView(false)
        else if (showBrandDiscount) setShowBrandDiscount(false)
        else if (showSaveCustomer) setShowSaveCustomer(false)
        else if (showQuotationSearch) setShowQuotationSearch(false)
        else if (showHeldCarts) setShowHeldCarts(false)
        else if (lastReceipt) setLastReceipt(null)
        else if (search) setSearch('')
      } else if (e.key === 'Enter' && lastReceipt && !isInputFocused) {
        e.preventDefault()
        printReceipt()
        setLastReceipt(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [total, cart, saving, showTenderSheet, showPaymentModal, showQuickView, showBrandDiscount, showSaveCustomer, showQuotationSearch, showHeldCarts, lastReceipt, search, receivedAmount, wholesaleEnabled, isWholesale, priceTier, products])

  const categoryNameMap = categories.reduce((acc, c) => {
    acc[String(c.id)] = c.name
    return acc
  }, {})

  const filtered = products.filter(p => {
    const q = search.trim().toLowerCase()
    let matchSearch = true
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean)
      const pName = String(p.name || '').toLowerCase()
      const pBrand = String(p.brand || '').toLowerCase()
      const pSku = String(p.sku || '').toLowerCase()
      const pId = String(p.id || '').toLowerCase()
      const pCat = String(categoryNameMap[String(p.category_id)] || p.categories?.name || '').toLowerCase()
      const searchTarget = `${pName} ${pBrand} ${pSku} ${pId} ${pCat}`

      matchSearch = tokens.every(token => searchTarget.includes(token))
    }
    const matchCat = selectedCategory ? String(p.category_id) === String(selectedCategory) : true
    const matchBrand = selectedBrand ? String(p.brand) === String(selectedBrand) : true
    return matchSearch && matchCat && matchBrand
  })

  const addToCart = (product, qty = 1) => {
    const parsedQty = parseFloat(qty)
    const addQty = isNaN(parsedQty) || parsedQty <= 0 ? 1 : parsedQty
    const stock = Number(product.stock_quantity) || 0
    // Quotations may include items not in stock; real sales may not.
    const enforceStock = saleType !== 'quotation'
    const existing = cart.find(i => i.id === product.id)
    const wantedQty = Math.round(((existing ? Number(existing.qty) : 0) + addQty) * 1000) / 1000

    if (enforceStock && stock <= 0) {
      alert(`${product.name} is out of stock (stock: ${stock}).`)
      return
    }
    if (enforceStock && wantedQty > stock) {
      if (existing) { alert(`Not enough stock! Only ${stock} available.`); return }
    }
    // New line: never add more than the available stock (and never 0 or a negative quantity)
    const lineQty = existing ? wantedQty : (enforceStock ? Math.min(addQty, stock) : addQty)
    if (!(lineQty > 0)) return

    setCart(prev => {
      if (prev.some(i => i.id === product.id)) {
        return prev.map(i => i.id === product.id ? { ...i, qty: lineQty } : i)
      }
      const { price, fallback } = getUnitPrice(product, activeTier)
      return [{ ...product, qty: lineQty, custom_price: price, price_fallback: fallback, price_overridden: false }, ...prev]
    })
  }

  const updateQty = (id, qty) => {
    const num = parseFloat(qty)
    if (isNaN(num) || num <= 0) return
    const product = products.find(p => p.id === id)
    if (saleType !== 'quotation' && product && num > Number(product.stock_quantity)) { alert(`Not enough stock! Only ${product.stock_quantity} available.`); return }
    setCart(prev => prev.map(i => i.id === id ? { ...i, qty: num } : i))
  }

  const updatePrice = (id, price) => {
    const num = parseFloat(price)
    if (isNaN(num) || num < 0) return
    setCart(prev => prev.map(i => i.id === id ? { ...i, custom_price: num, price_overridden: true } : i))
  }

  // Switch the bill between Retail and Wholesale. Lines whose price was edited by hand
  // (or set by a brand discount / loaded quotation) keep their price.
  const applyTier = (newTier, { manual = false } = {}) => {
    if (!wholesaleEnabled) return
    const tier = normalizeTier(newTier)
    if (manual) {
      setBaseTier(tier)
      try { localStorage.setItem(tierKey, tier) } catch { /* storage unavailable */ }
    }
    if (tier === priceTier) return
    setPriceTier(tier)
    const kept = cart.filter(i => i.price_overridden).length
    setCart(prev => prev.map(i => {
      if (i.price_overridden) return i
      const source = products.find(p => p.id === i.id) || i
      const { price, fallback } = getUnitPrice(source, tier)
      return { ...i, custom_price: price, price_fallback: fallback }
    }))
    const label = tier === 'wholesale' ? 'Wholesale' : 'Retail'
    setTierNotice(kept > 0 ? `${label} prices applied · ${kept} manually priced item(s) kept` : `${label} prices applied`)
    setTimeout(() => setTierNotice(''), 3000)
  }

  const handleCustomerChange = (id) => {
    setCustomerId(id)
    if (!wholesaleEnabled || !id) return
    const c = customers.find(c => String(c.id) === String(id))
    if (c?.price_tier === 'wholesale') applyTier('wholesale')
  }

  const handleFixedDiscountChange = (val) => {
    setDiscount(val)
    const num = parseFloat(val)
    if (!isNaN(num) && subtotal > 0) {
      setDiscountPercent(((num / subtotal) * 100).toFixed(1))
    } else {
      setDiscountPercent('')
    }
  }

  const handlePercentDiscountChange = (val) => {
    setDiscountPercent(val)
    const num = parseFloat(val)
    if (!isNaN(num) && subtotal > 0) {
      const rs = Math.round((subtotal * num) / 100)
      setDiscount(rs.toString())
    } else {
      setDiscount('0')
    }
  }

  const removeFromCart = (id) => setCart(prev => prev.filter(i => i.id !== id))

  const clearCart = () => {
    setCart([]); setCustomerId(''); setWalkInName(''); setPaymentType('cash'); setReceivedAmount(''); setPayments([]); setDiscount(0); setDiscountPercent(''); setDiscountMode('fixed')
    setPriceTier(baseTier)
  }

  const handleSaveCustomer = async () => {
    const name = saveCustomerForm.name.trim()
    if (!name) return alert('Customer ka naam zaroor darj karein')
    setSavingCustomer(true)
    const newCustomer = {
      name,
      phone: saveCustomerForm.mobile.trim(),
      shop_id: user.shop_id,
      outstanding_balance: 0,
      created_at: new Date().toISOString()
    }
    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')
      const { data, error } = await supabase.from('customers').insert([newCustomer]).select()
      if (error) throw error
      const saved = data[0]
      await db.customers.put(JSON.parse(JSON.stringify(saved)))
      setCustomers(prev => [...prev, saved])
      setCustomerId(String(saved.id))
      setWalkInName('')
      setShowSaveCustomer(false)
      setSaveCustomerForm({ name: '', mobile: '' })
    } catch (err) {
      const errMsg = err?.message || String(err)
      if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
        const localCust = { ...newCustomer, id: crypto.randomUUID() }
        await db.customers.add(localCust)
        await addToSyncQueue('customers', 'INSERT', localCust)
        setCustomers(prev => [...prev, localCust])
        setCustomerId(String(localCust.id))
        setWalkInName('')
        setShowSaveCustomer(false)
        setSaveCustomerForm({ name: '', mobile: '' })
        alert('Offline: Customer locally save hua. Online hone par sync hoga.')
      } else {
        alert('Error: ' + errMsg)
      }
    } finally {
      setSavingCustomer(false)
    }
  }

  const handleHoldBill = async () => {
    if (cart.length === 0) return

    const heldData = {
      shop_id: user.shop_id,
      customer_id: customerId || null,
      customer_name: customerId ? null : walkInName,
      items: cart,
      total,
      price_tier: activeTier,
      saved_at: new Date().toISOString()
    }

    try {
      await db.held_carts.add(heldData)
      await fetchHeldCarts()
      clearCart()
      alert('Bill held successfully! ⏸️')
    } catch (err) {
      alert('Error holding bill: ' + err.message)
    }
  }

  const handleResumeCart = (held) => {
    if (cart.length > 0) {
      if (!confirm('Current cart replace ho jayegi. Continue?')) return
    }
    setCart(held.items)
    if (wholesaleEnabled) setPriceTier(normalizeTier(held.price_tier))
    setCustomerId(held.customer_id || '')
    setWalkInName(held.customer_name || '')
    db.held_carts.delete(held.id).then(fetchHeldCarts)
    setShowHeldCarts(false)
  }

  const applyBrandDiscount = () => {
    if (!selectedBrand) { alert('Pehle brand select karo!'); return }
    const brandProducts = products.filter(p => p.brand === selectedBrand)
    const val = parseFloat(brandDiscountValue) || 0

    // Check for loss items before applying
    const lossItems = []
    brandProducts.forEach(product => {
      const isInCart = cart.find(i => i.id === product.id)
      if (brandDiscountMode === 'cart_only' && !isInCart) return
      const cRate = parseFloat(product.c_rate) || 0
      let discountedPrice
      if (brandDiscountType === 'percent' && cRate > 0) {
        const currentPrice = isInCart ? isInCart.custom_price : tierPrice(product)
        const currentDiscPct = (1 - currentPrice / cRate) * 100
        discountedPrice = cRate * (1 - (currentDiscPct + val) / 100)
      } else if (brandDiscountType === 'percent') {
        const currentPrice = isInCart ? isInCart.custom_price : tierPrice(product)
        discountedPrice = currentPrice - (currentPrice * val / 100)
      } else {
        const currentPrice = isInCart ? isInCart.custom_price : tierPrice(product)
        discountedPrice = currentPrice - val
      }
      discountedPrice = Math.max(0, parseFloat(discountedPrice.toFixed(2)))
      const costPrice = parseFloat(product.cost_price) || 0
      if (discountedPrice < costPrice) {
        lossItems.push({ name: product.name, cRate, costPrice, discountedPrice })
      }
    })

    if (lossItems.length > 0) {
      const details = lossItems.map(({ name, cRate, costPrice, discountedPrice }) =>
        `• ${name}${cRate > 0 ? ` (C.Rate: Rs.${cRate})` : ''} | Purchase: Rs.${costPrice} | Discount Price: Rs.${discountedPrice}`
      ).join('\n')
      const confirmed = window.confirm(
        `⚠️ Nuqsan (Loss) Alert!\n\nYeh brand discount apply karne se in products par nuqsan hoga:\n${details}\n\nPhir bhi apply karein?`
      )
      if (!confirmed) return
    }

    setCart(prev => {
      let updated = [...prev]
      brandProducts.forEach(product => {
        const cRate = parseFloat(product.c_rate) || 0
        const isInCart = updated.find(i => i.id === product.id)

        // In cart-only mode, skip products not already in the cart
        if (brandDiscountMode === 'cart_only' && !isInCart) return

        let discountedPrice
        if (brandDiscountType === 'percent' && cRate > 0) {
          // c_rate-based calculation:
          // 1. Find current discount% from c_rate that custom_price (or sale_price) represents
          const currentPrice = isInCart ? isInCart.custom_price : tierPrice(product)
          const currentDiscPct = (1 - currentPrice / cRate) * 100
          // 2. Add the brand discount %
          const newDiscPct = currentDiscPct + val
          // 3. New price = c_rate * (1 - newDiscPct / 100)
          discountedPrice = cRate * (1 - newDiscPct / 100)
        } else if (brandDiscountType === 'percent') {
          // Fallback if c_rate is 0: apply % on sale_price
          const currentPrice = isInCart ? isInCart.custom_price : tierPrice(product)
          discountedPrice = currentPrice - (currentPrice * val / 100)
        } else {
          // Fixed amount discount
          const currentPrice = isInCart ? isInCart.custom_price : tierPrice(product)
          discountedPrice = currentPrice - val
        }
        discountedPrice = Math.max(0, parseFloat(discountedPrice.toFixed(2)))

        if (isInCart) {
          updated = updated.map(i => i.id === product.id ? { ...i, custom_price: discountedPrice, price_overridden: true } : i)
        } else {
          // Only reached in 'add_all' mode
          updated = [...updated, { ...product, qty: 1, custom_price: discountedPrice, price_overridden: true }]
        }
      })
      return updated
    })
    setShowBrandDiscount(false)
    setBrandDiscountValue('')
  }

  const handleCompleteSale = async () => {
    if (cart.length === 0) { alert('Cart khali hai!'); return }

    // If split payment not used, default to single payment
    const singleMethod = paymentType === 'online' ? onlineProvider : paymentType
    const finalPayments = payments.length > 0
      ? payments
      : [{
          method: singleMethod,
          provider: paymentType === 'online' ? onlineProvider : null,
          ref: paymentType === 'online' ? transactionRef : null,
          amount: (receivedAmount === '' ? total : Number(receivedAmount))
        }]
    const totalPaid = finalPayments.reduce((s, p) => s + Number(p.amount), 0)

    // Only admin / manager may sell below cost (via a typed price, brand discount or bill discount)
    const canSellBelowCost = user.role === 'admin' || user.role === 'manager'
    if (saleType === 'sale' && !canSellBelowCost) {
      const belowCost = cart.filter(i => Number(i.cost_price) > 0 && Number(i.custom_price) < Number(i.cost_price))
      if (belowCost.length > 0) {
        alert(`These items are priced below cost:\n${belowCost.map(i => `• ${i.name}: Rs. ${i.custom_price} (cost Rs. ${i.cost_price})`).join('\n')}\n\nOnly an admin or manager can sell below cost.`)
        return
      }
      if (totalProfit < 0) {
        alert('This discount makes the bill a loss. Only an admin or manager can approve it.')
        return
      }
    }

    if ((paymentType === 'credit' || totalPaid < total) && !customerId) {
      alert('Balance amount (Credit) ke liye customer select karna zaroori hai!');
      return
    }

    setSaving(true)

    // Sanitize integer FK — offline-created customers have UUID ids
    const toIntOrNull = toIntId // strict: never parseInt a UUID (parseInt('7c9e…') === 7)

    const primaryPaymentMethod = saleType === 'quotation'
      ? 'quotation'
      : (finalPayments.length > 1 ? 'split' : singleMethod)

    // Generate Sale Object
    const saleData = {
      shop_id: user.shop_id,
      customer_id: toIntOrNull(customerId),
      customer_name: customerId ? null : walkInName,
      total_amount: subtotal,
      discount: totalDiscount,
      paid_amount: saleType === 'quotation' ? 0 : Math.min(total, totalPaid),
      payment_type: primaryPaymentMethod,
      payment_method: primaryPaymentMethod,
      online_provider: paymentType === 'online' ? onlineProvider : null,
      transaction_ref: paymentType === 'online' ? (transactionRef || null) : null,
      sale_type: saleType,
      status: 'completed',
      created_by: user.username,
      created_at: new Date().toISOString(),
      ...(wholesaleEnabled ? { price_tier: activeTier } : {})
    }

    // Include payment_details for split or online/ref metadata
    if (saleType !== 'quotation') {
      saleData.payment_details = finalPayments
    }

    let finalSale = null;
    // Idempotency key: the database rejects a second row with the same client_ref,
    // so a retry/offline replay after a lost response can never duplicate the sale.
    const clientRef = crypto.randomUUID()
    saleData.client_ref = clientRef
    // Sales that reference a record not synced yet (offline-created customer/product)
    // must go through the queue so syncService can swap in the real ids.
    const hasUnsyncedRef = isTempId(String(customerId || '')) || cart.some(i => isTempId(String(i.id)))
    const balanceIncrease = customerId ? total - Math.min(total, totalPaid) : 0
    let savedOnline = false

    // ── 1. Sale header ────────────────────────────────────────────
    try {
      if (!navigator.onLine || hasUnsyncedRef) throw new TypeError('Failed to fetch')

      let { data: sale, error: saleError } = await supabase.from('sales').insert([saleData]).select().single()

      // Resilient fallback if optional columns are not migrated in Supabase yet
      if (saleError && (isMissingColumn(saleError) || saleError.message?.includes('online_provider') || saleError.message?.includes('transaction_ref'))) {
        console.warn('POS: optional sales columns not found in database yet. Retrying without them (payment details kept in payment_details JSONB).')
        const fallbackSaleData = { ...saleData }
        delete fallbackSaleData.online_provider
        delete fallbackSaleData.transaction_ref
        delete fallbackSaleData.price_tier
        delete fallbackSaleData.client_ref
        ;({ data: sale, error: saleError } = await supabase.from('sales').insert([fallbackSaleData]).select().single())
      }

      if (saleError) throw saleError
      finalSale = sale
      savedOnline = true
      // Mirror to local DB so Sales history / ledger shows up immediately without reload
      await db.sales.put(sale)
    } catch (error) {
      if (!hasUnsyncedRef && !isNetworkError(error)) {
        alert('Error completing sale: ' + (error?.message || String(error)))
        setSaving(false)
        return
      }
      // OFFLINE: nothing reached the database (or the response was lost — client_ref
      // makes the replay safe). Queue the whole sale.
      console.log('POS: routing sale to local queue...')
      const offlineId = crypto.randomUUID()
      const offlineSaleData = {
        ...saleData,
        id: offlineId,
        // keep an unsynced customer's temp id so the sync queue can map it to the real one
        customer_id: isTempId(String(customerId || '')) ? customerId : saleData.customer_id
      }
      finalSale = offlineSaleData
      await db.sales.add(offlineSaleData)
      await addToSyncQueue('sales', 'INSERT', offlineSaleData)
    }

    // ── 2. Line items (never create a second sale if this step fails) ──
    const items = cart.map(i => ({
      sale_id: finalSale.id,
      product_id: savedOnline ? toIntOrNull(i.id) : i.id,
      product_name: i.name,
      quantity: i.qty,
      unit_price: i.custom_price,
      cost_price: i.cost_price || 0,
      line_total: i.custom_price * i.qty,
      returned_qty: 0,
    }))
    let itemsSaved = false
    if (savedOnline) {
      const { data: resItems, error: itemsError } = await supabase.from('sale_items').insert(items).select()
      if (!itemsError) {
        await db.sale_items.bulkPut(resItems)
        itemsSaved = true
      } else if (!isNetworkError(itemsError)) {
        // Hard failure: remove the header so we never keep a sale without its items
        await supabase.from('sales').delete().eq('id', finalSale.id)
        await db.sales.delete(finalSale.id).catch(() => {})
        alert('Error completing sale (items): ' + itemsError.message + '\nSale was NOT saved — please try again.')
        setSaving(false)
        return
      }
    }
    if (!itemsSaved) {
      const localItems = items.map(it => ({ ...it, id: crypto.randomUUID() }))
      await db.sale_items.bulkPut(localItems)
      await addToSyncQueue('sale_items', 'INSERT', localItems)
    }

    // ── 3. Stock & customer balance as atomic changes (online, or queued) ──
    if (saleType === 'sale') {
      const failed = []
      for (const item of cart) {
        const r = await adjustStock(item.id, -Number(item.qty))
        if (!r.ok) failed.push(item.name)
      }
      if (customerId && balanceIncrease !== 0) {
        const r = await adjustCustomerBalance(customerId, balanceIncrease)
        if (!r.ok) failed.push('customer balance')
      }
      if (failed.length > 0) {
        alert(`Sale saved, but these updates failed: ${failed.join(', ')}.\nPlease check stock / customer balance.`)
      }
    }

    if (!savedOnline || !itemsSaved) {
      alert('Offline mode: Sale saved locally. Will sync automatically when online. 🔄')
    }

    const customer = customers.find(c => String(c.id) === String(customerId))
    const tendered = receivedAmount !== '' ? Number(receivedAmount) : totalPaid
    const changeDueVal = (tendered > total && paymentType === 'cash') ? (tendered - total) : 0

    setLastReceipt({
      sale: finalSale,
      items: cart,
      customer,
      walkInName: customerId ? null : walkInName,
      subtotal,
      totalDiscount,
      total,
      paymentType,
      receivedAmount: tendered,
      changeDue: changeDueVal,
      totalProfit,
      isQuotation: saleType === 'quotation'
    })

    // Auto print for quotation
    if (saleType === 'quotation') {
      printHTML(buildReceiptHTML({
        sale: finalSale, items: cart, customer, subtotal, totalDiscount, total, paymentType
      }, true))
    }

    // Audit Log
    recordAuditLog(
      saleType === 'quotation' ? 'CREATE_QUOTATION' : 'PROCESS_SALE',
      'sales',
      finalSale.id,
      {
        total,
        discount: totalDiscount,
        items_count: cart.length,
        payment_type: paymentType,
        price_overrides: cart
          .filter(i => i.price_overridden && Number(i.custom_price) !== Number(i.sale_price))
          .map(i => ({ product: i.name, list_price: Number(i.sale_price), sold_at: Number(i.custom_price) })),
        customer: customerId ? customers.find(c => c.id === customerId)?.name : walkInName
      },
      user.id,
      user.shop_id
    )

    clearCart()
    setShowTenderSheet(false)
    fetchAll()
    setSaving(false)
  }

  const handleSearchQuotation = async () => {
    if (!quotationIdInput) return
    let qId = quotationIdInput.trim()

    const loadSaleToCart = (sale) => {
      const items = sale.sale_items.map(si => {
        const prod = products.find(p => p.id === si.product_id)
        return {
          ...prod,
          id: si.product_id,
          name: si.product_name,
          qty: si.quantity,
          custom_price: si.unit_price,
          cost_price: si.cost_price,
          price_overridden: true
        }
      })
      if (wholesaleEnabled) setPriceTier(normalizeTier(sale.price_tier))

      setCart(items)
      setCustomerId(sale.customer_id || '')
      setWalkInName(sale.customer_name || '')
      setSaleType('sale') // Switch to sale mode
      setShowQuotationSearch(false)
      setQuotationIdInput('')
    }

    // Support searching with 'QT-' prefix or just the last 8 chars
    if (qId.startsWith('QT-')) qId = qId.replace('QT-', '')

    const query = supabase
      .from('sales')
      .select('*, sale_items(*)')
      .eq('shop_id', user.shop_id)
      .eq('sale_type', 'quotation')

    // If it's a number, try exact match first for performance
    if (!isNaN(qId)) {
      const { data, error } = await query.eq('id', parseInt(qId)).maybeSingle()
      if (data) {
        loadSaleToCart(data)
        return
      }
    }

    // Fallback: search by partial match. Since ID is integer, we need to cast (if DB allows) 
    // or just search with exact if qId is long enough. 
    // Most users will enter the full number if it's an integer.
    const { data: sale, error } = await query
      .filter('id', 'raw', `"id"::text ilike '%${qId}'`)
      .single()

    if (error || !sale) {
      alert('Quotation nahi mili! Sahi number check karein.')
      return
    }

    loadSaleToCart(sale)
  }

  const buildReceiptHTML = (r, isQuotation = false) => {
    // Always read shop settings fresh from localStorage at print time.
    // Uses shop_id-scoped keys for full multitenancy.
    const sid = user?.shop_id
    let saved = {}
    try { saved = JSON.parse((sid ? localStorage.getItem(`shop_settings_${sid}`) : null) || '{}') } catch (_) {}

    const freshLogo = (sid ? localStorage.getItem(`shop_logo_${sid}`) : null)
      || saved.logo_url || form.logo_url || ''

    const shopSettings = {
      ...form,
      name:             saved.name             || form.name,
      phone:            saved.phone            || form.phone,
      address:          saved.address          || form.address,
      invoice_footer:   saved.invoice_footer   || form.invoice_footer,
      quotation_footer: saved.quotation_footer || form.quotation_footer,
      print_size:       saved.print_size       || form.print_size       || 'thermal',
      print_mode:       saved.print_mode       || form.print_mode       || 'manual',
      print_template:   (sid ? localStorage.getItem(`print_template_${sid}`) : null) || saved.print_template || localStorage.getItem('print_template') || '2',
      logo_url:         freshLogo,
      shop_id:          sid,
    }
    return buildBillHTML(r, isQuotation, shopSettings)
  }

  const printReceipt = () => {
    printHTML(buildReceiptHTML(lastReceipt, false))
  }

  const printQuotation = () => {
    const customer = customers.find(c => String(c.id) === String(customerId))
    const sub = cart.reduce((s, i) => s + i.custom_price * i.qty, 0)
    const disc = parseFloat(discount) || 0
    const tot = Math.max(0, sub - disc)
    const fakeSale = { id: Date.now(), created_at: new Date().toISOString(), created_by: user?.username || 'Staff', payment_type: paymentType, payment_details: null, paid_amount: tot }
    printHTML(buildReceiptHTML({ sale: fakeSale, items: cart, customer, subtotal: sub, totalDiscount: disc, total: tot, paymentType }, true))
  }

  const waQuotation = async (e) => {
    const btn = e?.currentTarget
    if (btn) { btn.disabled = true; btn.textContent = '⏳...' }
    try {
      const customer = customers.find(c => String(c.id) === String(customerId))
      const sub = cart.reduce((s, i) => s + i.custom_price * i.qty, 0)
      const disc = parseFloat(discount) || 0
      const tot = Math.max(0, sub - disc)
      const fakeSale = { id: Date.now(), created_at: new Date().toISOString(), created_by: user?.username || 'Staff', payment_type: paymentType, payment_details: null, paid_amount: tot }
      const html = buildReceiptHTML({ sale: fakeSale, items: cart, customer, subtotal: sub, totalDiscount: disc, total: tot, paymentType }, true)
      const pdfBlob = await generateBillPDF(html)

      let formattedPhone = ''
      if (customer?.phone) {
        const ph = customer.phone.replace(/[^0-9]/g, '')
        formattedPhone = ph.startsWith('03') ? '92' + ph.substring(1) : ph.length === 10 ? '92' + ph : ph
      }

      const msg = `${form.name || 'Shop'} — Quotation\nTotal: Rs. ${tot.toFixed(0)}\n${customer ? 'Customer: ' + customer.name : walkInName ? 'Customer: ' + walkInName : ''}`
      await shareOrDownloadPDF(pdfBlob, `quotation-${String(fakeSale.id).slice(-8)}.pdf`, formattedPhone || null, msg)
    } catch (err) {
      console.error('Quotation PDF failed:', err)
      alert('PDF nahi ban saka.')
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '💬' }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Upper Main Workspace (Catalog on Left + Cart on Right) */}
      <div className="flex-1 flex min-h-0 flex-col gap-3 overflow-hidden md:flex-row pb-1">

        {/* LEFT: Products */}
        <div className="flex-1 flex flex-col gap-3 min-w-0 min-h-0">

        {/* Sale / Quotation toggle */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button onClick={() => setSaleType('sale')}
            className={`flex-1 py-2 rounded-lg font-semibold text-sm transition ${saleType === 'sale' ? 'bg-primary text-white' : 'bg-surface text-fg-3 border'}`}>
            🧾 Sale
          </button>
          <button onClick={() => setSaleType('quotation')}
            className={`flex-1 py-2 rounded-lg font-semibold text-sm transition ${saleType === 'quotation' ? 'bg-info text-white' : 'bg-surface text-fg-3 border'}`}>
            📄 Quotation
          </button>
          <button onClick={() => setShowQuotationSearch(true)}
            className="flex-1 py-2 bg-surface-3 hover:bg-surface-4 text-fg-2 rounded-lg font-semibold text-sm border border-transparent transition">
            🔍 Search Quotation
          </button>
          <button onClick={() => setBarcodeMode(b => !b)}
            className={`flex-1 py-2 rounded-lg font-semibold text-sm transition border ${barcodeMode ? 'bg-success text-white border-success' : 'bg-surface text-fg-3 border-line hover:bg-success-soft hover:border-success-edge'}`}>
            📷 {barcodeMode ? 'Scanning...' : 'Barcode Scan'}
          </button>
        </div>

        {/* Barcode Scanner Input */}
        {barcodeMode && (
          <form onSubmit={handleBarcodeSubmit} className="flex gap-2 items-center bg-success-soft border-2 border-success rounded-xl px-3 py-2">
            <span className="text-success-fg text-lg">📷</span>
            <input
              ref={barcodeRef}
              type="text"
              value={barcodeInput}
              onChange={e => setBarcodeInput(e.target.value)}
              placeholder="Scan barcode or type SKU → Enter"
              className="flex-1 bg-transparent outline-none text-sm font-mono text-success-strong placeholder-success-fg"
              autoComplete="off"
            />
            <button type="submit" className="text-xs bg-success hover:bg-success-hover text-white px-3 py-1 rounded-lg font-bold">Add</button>
            <button type="button" onClick={() => { setBarcodeMode(false); setBarcodeInput('') }} className="text-xs text-success-fg hover:text-danger-fg font-bold px-2">✕ Exit</button>
          </form>
        )}

        {/* Search + Filters */}
        <div className="flex gap-2 flex-wrap">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="🔍 Search products / brand (F2)..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary min-w-0 shadow-sm"
          />
          <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm bg-surface focus:outline-none shadow-sm">
            <option value="">All Categories</option>
            {posCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={selectedBrand} onChange={e => setSelectedBrand(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm bg-surface focus:outline-none shadow-sm">
            <option value="">All Brands</option>
            {displayBrands.map(bName => <option key={bName} value={bName}>{bName}</option>)}
          </select>
          {selectedBrand && (
            <button onClick={() => setShowBrandDiscount(true)}
              className="px-3 py-2 bg-warning hover:bg-warning-hover text-white rounded-lg text-sm transition whitespace-nowrap shadow-sm">
              % Brand Discount
            </button>
          )}
        </div>

        {/* Product Grid - High-Visibility Responsive Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 overflow-y-auto flex-1 min-h-0 content-start pb-24 md:pb-0 custom-scrollbar">
          {filtered.length === 0 && <p className="text-fg-subtle col-span-full text-center py-10">No products found</p>}
          {filtered.map(p => {
            const isOutOfStock = Number(p.stock_quantity) <= 0
            const isLowStock = !isOutOfStock && Number(p.stock_quantity) <= (p.low_stock_threshold || 5)
            const catName = categoryNameMap[String(p.category_id)] || p.categories?.name || ''
            const catStyle = getCategoryColor(catName)

            return (
              <div
                key={p.id}
                onClick={() => { addToCart(p, parseFloat(cardQtys[p.id]) || 1); setCardQtys(prev => ({ ...prev, [p.id]: '' })) }}
                className={`pos-product-card group bg-surface rounded-xl shadow-xs hover:shadow-md p-3 text-left transition-all border cursor-pointer flex flex-col justify-between select-none relative border-t-4 ${catStyle.border} ${
                  isOutOfStock
                    ? 'border-danger-line bg-danger-soft/20 opacity-80'
                    : isLowStock
                      ? 'border-warning-line bg-warning-soft/15 hover:border-warning'
                      : 'border-line/80 hover:border-primary hover:bg-primary-soft/30'
                }`}
              >
                {/* Row 1: Dedicated Product Name (100% visible, multi-line wrapping allowed) */}
                <div className="w-full mb-1">
                  <h3 className="font-bold text-fg text-xs sm:text-sm leading-snug break-words w-full" title={p.name}>
                    {p.name}
                  </h3>
                </div>

                {/* Row 2: Separate Price Line & Category / Brand / Stock Status Badges */}
                <div className="flex items-center justify-between gap-1 mb-1.5 pt-1 border-t border-line-subtle/70">
                  <span className={`font-black text-sm sm:text-base tracking-tight ${isWholesale ? 'text-wholesale-fg' : 'text-primary-fg'}`}>
                    Rs. {Number(tierPrice(p)).toLocaleString()}
                    {isWholesale && getUnitPrice(p, 'wholesale').fallback && <span className="ml-1 text-[9px] font-bold text-wholesale-strong align-middle">(R)</span>}
                  </span>

                  <div className="flex items-center gap-1 shrink-0">
                    {catName && (
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border truncate max-w-[75px] ${catStyle.pill}`} title={catName}>
                        {catName}
                      </span>
                    )}
                    {p.brand && (
                      <span className="text-[10px] font-semibold text-fg-muted bg-surface-3 px-1.5 py-0.5 rounded border border-line/60 truncate max-w-[80px]">
                        {p.brand}
                      </span>
                    )}
                    {isOutOfStock ? (
                      <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-danger-muted text-danger-strong">
                        Out
                      </span>
                    ) : isLowStock ? (
                      <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-warning-muted text-warning-strong">
                        Low
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Row 3: Stock, Cost & Quick Qty Action */}
                <div className="flex items-center justify-between pt-1 border-t border-line-subtle mt-0.5">
                  <div className="text-[11px] flex items-center gap-1 text-fg-muted">
                    <span className={isOutOfStock ? 'text-danger-fg font-bold' : isLowStock ? 'text-warning-fg font-semibold' : 'text-fg-muted'}>
                      Stock: <span className="font-semibold">{p.stock_quantity}</span>
                    </span>
                    {(user.role === 'admin' || user.role === 'manager') && p.cost_price != null && (
                      <span className="text-fg-subtle text-[10px] hidden sm:inline">
                        · Cost: {p.cost_price}
                      </span>
                    )}
                  </div>

                  <div onClick={e => e.stopPropagation()} className="flex items-center gap-1 shrink-0">
                    <input
                      type="number"
                      step="any"
                      min="0.001"
                      max={p.stock_quantity > 0 ? p.stock_quantity : undefined}
                      value={cardQtys[p.id] || ''}
                      onChange={e => setCardQtys(prev => ({ ...prev, [p.id]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.stopPropagation();
                          addToCart(p, parseFloat(cardQtys[p.id]) || 1);
                          setCardQtys(prev => ({ ...prev, [p.id]: '' }))
                        }
                      }}
                      placeholder="Qty"
                      title="Custom quantity"
                      className="w-12 text-[11px] font-medium text-center border border-line rounded px-1 py-0.5 outline-none focus:border-primary bg-surface"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        addToCart(p, parseFloat(cardQtys[p.id]) || 1);
                        setCardQtys(prev => ({ ...prev, [p.id]: '' }))
                      }}
                      title="Add to cart"
                      className="px-2 py-0.5 bg-primary-soft hover:bg-primary text-primary-fg hover:text-white rounded text-xs font-black transition border border-primary-line hover:border-transparent active:scale-95"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Mobile Cart Floating Badge */}
      {cart.length > 0 && (
        <button
          onClick={() => setShowMobileCart(true)}
          className="md:hidden fixed bottom-5 right-5 z-40 bg-primary text-white rounded-full w-16 h-16 flex flex-col items-center justify-center shadow-2xl hover:bg-primary-hover transition active:scale-95"
        >
          <span className="text-lg">🛒</span>
          <span className="text-[10px] font-black">{cart.length}</span>
          <span className="absolute -top-1 -right-1 bg-danger text-white text-[10px] font-black w-6 h-6 rounded-full flex items-center justify-center">Rs.{total.toFixed(0)}</span>
        </button>
      )}

      {/* RIGHT: Cart — hidden on mobile, overlay when toggled */}
      {/* Mobile overlay backdrop */}
      {showMobileCart && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-40" onClick={() => setShowMobileCart(false)} />
      )}
      <div className={`${showMobileCart ? 'fixed inset-x-2 top-2 bottom-2 z-50 flex max-h-[calc(100dvh-1rem)]' : 'hidden md:flex'} md:static md:w-96 lg:w-[410px] xl:w-[430px] flex-col gap-2 bg-surface bg-gradient-to-b from-primary-soft/95 via-primary-soft/40 to-primary-soft/80 rounded-2xl shadow-xl border-2 border-primary-line/90 p-3 h-full min-h-0 overflow-hidden shrink-0`}>

        {/* Mobile close button */}
        <button onClick={() => setShowMobileCart(false)} className="md:hidden self-end text-fg-subtle hover:text-fg-2 text-xl font-bold -mt-1 -mr-1 p-1">✕</button>

        {/* Cart Header */}
        <div className="border-b border-primary-line/80 pb-2 shrink-0 flex justify-between items-center gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-black text-primary-strong tracking-tight flex items-center gap-1.5">
              <span>🛒 Cart</span>
              <span className="bg-primary text-white text-[10px] font-black px-1.5 py-0.5 rounded-full">{cart.length}</span>
            </h2>
            {saleType === 'quotation' && <span className="text-info-fg font-bold text-[10px] uppercase bg-info-soft px-1.5 py-0.5 rounded border border-info-line">Quotation</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {/* Quick POS Layout Switcher */}
            <div className="hidden sm:flex items-center bg-surface/90 p-0.5 rounded-lg border border-primary-line/80 text-[10px] font-bold shadow-2xs">
              <button
                type="button"
                onClick={() => switchPosLayout('two_stage')}
                title="Two-Stage Flow (Max Vertical Cart)"
                className={`px-1.5 py-0.5 rounded transition ${posLayout === 'two_stage' ? 'bg-primary text-white shadow-2xs font-black' : 'text-fg-3 hover:text-primary-strong'}`}
              >
                ⚡ 2-Stage
              </button>
              <button
                type="button"
                onClick={() => switchPosLayout('bottom_dock')}
                title="Global Bottom Dock (Full-height Cart)"
                className={`px-1.5 py-0.5 rounded transition ${posLayout === 'bottom_dock' ? 'bg-primary text-white shadow-2xs font-black' : 'text-fg-3 hover:text-primary-strong'}`}
              >
                🖥️ Dock
              </button>
              <button
                type="button"
                onClick={() => switchPosLayout('compact_dock')}
                title="Compact Sidebar"
                className={`px-1.5 py-0.5 rounded transition ${posLayout === 'compact_dock' ? 'bg-primary text-white shadow-2xs font-black' : 'text-fg-3 hover:text-primary-strong'}`}
              >
                📱 Side
              </button>
            </div>

            {heldCarts.length > 0 && (
              <button
                onClick={() => setShowHeldCarts(true)}
                className="px-2 py-1 bg-warning-soft hover:bg-warning-muted text-warning-strong border border-warning-line/80 rounded-lg text-[10px] font-bold uppercase transition flex items-center gap-1"
              >
                <span>⏸️</span> Held ({heldCarts.length})
              </button>
            )}
            <button
              onClick={() => setShowQuickView(true)}
              className="px-2 py-1 bg-surface hover:bg-primary-muted text-primary-strong border border-primary-line/80 rounded-lg text-[10px] font-black uppercase transition flex items-center gap-1 shadow-2xs"
            >
              <span>🔍</span> Quick
            </button>
          </div>
        </div>

        {/* Retail ⇄ Wholesale one-click switch (F8) */}
        {wholesaleEnabled && (
          <div className={`shrink-0 rounded-xl border p-1.5 ${isWholesale ? 'bg-wholesale-soft border-wholesale-edge' : 'bg-surface/95 border-primary-line/90'}`}>
            <div className="flex items-center gap-2">
              <div role="group" aria-label="Price tier" className="flex flex-1 rounded-lg bg-surface-3 p-0.5 text-xs font-black">
                <button
                  type="button"
                  aria-pressed={!isWholesale}
                  onClick={() => applyTier('retail', { manual: true })}
                  className={`flex-1 min-h-9 rounded-md px-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${!isWholesale ? 'bg-primary text-white shadow-2xs' : 'text-fg-3 hover:text-primary-strong'}`}
                >
                  Retail
                </button>
                <button
                  type="button"
                  aria-pressed={isWholesale}
                  onClick={() => applyTier('wholesale', { manual: true })}
                  className={`flex-1 min-h-9 rounded-md px-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-wholesale ${isWholesale ? 'bg-wholesale text-white shadow-2xs' : 'text-fg-3 hover:text-wholesale-strong'}`}
                >
                  Wholesale
                </button>
              </div>
              <kbd className="hidden sm:inline text-[10px] font-bold text-fg-subtle border border-line rounded px-1">F8</kbd>
            </div>
            {isWholesale && (
              <p className="mt-1 text-[10px] font-black uppercase tracking-wider text-wholesale-strong">● Wholesale prices active</p>
            )}
            {tierNotice && <p role="status" className="mt-1 text-[10px] font-semibold text-fg-3">{tierNotice}</p>}
          </div>
        )}

        {/* Compact Customer Selector with Real-Time Credit Badge */}
        <div className="flex flex-col gap-1 shrink-0 bg-surface/95 p-1.5 rounded-xl border border-primary-line/90 shadow-2xs">
          <div className="flex items-center gap-1.5">
            <select
              value={customerId}
              onChange={e => handleCustomerChange(e.target.value)}
              className="flex-1 min-w-0 px-2.5 py-1.5 bg-surface-2 border border-line rounded-lg text-xs font-semibold text-fg focus:outline-none focus:ring-2 focus:ring-primary shadow-xs truncate"
            >
              <option value="">👤 Walk-in Customer</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}{wholesaleEnabled && c.price_tier === 'wholesale' ? ' [W]' : ''} {c.outstanding_balance > 0 ? `(Rs.${c.outstanding_balance} credit)` : ''}
                </option>
              ))}
            </select>

            {!customerId && (
              <>
                <input
                  type="text"
                  placeholder="Walk-in Name"
                  value={walkInName}
                  onChange={e => setWalkInName(e.target.value)}
                  className="w-28 sm:w-32 px-2 py-1.5 border border-primary-line rounded-lg text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary bg-surface placeholder:text-fg-subtle"
                />
                {walkInName.trim() && (
                  <button
                    onClick={() => { setSaveCustomerForm({ name: walkInName, mobile: '' }); setShowSaveCustomer(true) }}
                    title="Save customer permanently"
                    className="px-2 py-1.5 bg-success hover:bg-success-hover text-white rounded-lg text-xs font-bold transition shrink-0 shadow-xs"
                  >
                    + Save
                  </button>
                )}
              </>
            )}
          </div>

          {/* Real-time Customer Credit / Balance Summary Badge */}
          {customerId && (() => {
            const selectedCust = customers.find(c => String(c.id) === String(customerId))
            if (!selectedCust) return null
            const bal = Number(selectedCust.outstanding_balance || 0)
            return (
              <div className={`flex items-center justify-between px-2.5 py-1 rounded-lg text-xs font-bold border transition ${
                bal > 0 ? 'bg-danger-soft text-danger-strong border-danger-line' : 'bg-success-soft text-success-strong border-success-line'
              }`}>
                <span className="flex items-center gap-1 font-semibold truncate max-w-[200px]">
                  <span>👤 {selectedCust.name}</span>
                  {selectedCust.phone && <span className="text-[10px] text-fg-muted">({selectedCust.phone})</span>}
                </span>
                <span className="font-mono font-black shrink-0">
                  {bal > 0 ? `🔴 Udhaar: Rs. ${bal.toLocaleString()}` : `🟢 Previous Due: Clean`}
                </span>
              </div>
            )
          })()}
        </div>

        {/* Cart Items — Expanded High-Density Scrollable View */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-1.5 pr-0.5 custom-scrollbar">
          {cart.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full py-12 text-center text-fg-subtle">
              <span className="text-3xl mb-1 opacity-50">🛍️</span>
              <p className="text-xs font-semibold">Cart is empty</p>
              <p className="text-[10px] text-fg-subtle mt-0.5">Click products on left panel to add</p>
            </div>
          )}
          {cart.map(item => {
            const itemProfit = (item.custom_price - (item.cost_price || 0)) * item.qty
            const isAdminOrManager = (user.role === 'admin' || user.role === 'manager' || user.role === 'accountant')
            return (
              <div key={item.id} className="group bg-surface hover:bg-primary-soft/40 border border-primary-muted hover:border-primary-edge rounded-lg px-2 py-1 transition duration-150 shadow-2xs">
                <div className="flex items-center justify-between gap-1.5">
                  {/* Left: Product Name, Brand & Unit Price edit */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <p className="text-xs font-bold text-fg truncate leading-tight">{item.name}</p>
                      {item.brand && <span className="text-[9px] text-fg-subtle font-medium shrink-0">({item.brand})</span>}
                    </div>

                    <div className="flex items-center gap-1 mt-0.5 text-[10px]">
                      <span className="font-bold text-fg-subtle uppercase">Unit:</span>
                      <div className="flex items-center bg-surface border border-primary-line rounded px-1 py-0.2 shadow-2xs" title="Editable Unit Price">
                        <span className="font-bold text-fg-subtle mr-0.5">Rs.</span>
                        <input
                          type="number"
                          value={item.custom_price}
                          onChange={e => updatePrice(item.id, e.target.value)}
                          className="w-14 text-xs font-bold text-primary-strong outline-none p-0 bg-transparent"
                        />
                      </div>

                      {isWholesale && item.price_fallback && !item.price_overridden && (
                        <span className="font-bold px-1 py-0.2 rounded bg-wholesale-muted text-wholesale-strong" title="No wholesale price set — retail price used">No W.price</span>
                      )}
                      {isAdminOrManager && itemProfit !== 0 && (
                        <span className={`font-bold px-1 py-0.2 rounded ${itemProfit < 0 ? 'bg-danger-muted text-danger-strong' : 'bg-success-muted text-success-strong'}`}>
                          {itemProfit < 0 ? '⚠️ -' : '+'}{Math.abs(itemProfit).toFixed(0)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right: Stepper + Line Total + Remove button */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <div className="flex items-center bg-surface border border-line rounded px-0.5 py-0.2 shadow-2xs">
                      <button
                        onClick={() => updateQty(item.id, Math.max(1, (parseFloat(item.qty) || 1) - 1))}
                        className="w-4 h-4 flex items-center justify-center text-xs font-bold text-fg-muted hover:bg-surface-3 rounded select-none"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        step="any"
                        min="0.001"
                        value={item.qty}
                        onChange={e => updateQty(item.id, e.target.value)}
                        className="w-9 text-center text-xs font-bold text-fg border-none outline-none p-0 bg-transparent"
                      />
                      <button
                        onClick={() => updateQty(item.id, (parseFloat(item.qty) || 0) + 1)}
                        className="w-4 h-4 flex items-center justify-center text-xs font-bold text-fg-muted hover:bg-surface-3 rounded select-none"
                      >
                        +
                      </button>
                    </div>

                    <span className="font-black text-xs text-fg min-w-[58px] text-right" title="Item Total">
                      {Number(item.qty) > 1 ? `= Rs.${(item.custom_price * item.qty).toFixed(0)}` : `Rs.${(item.custom_price).toFixed(0)}`}
                    </span>

                    <button
                      onClick={() => removeFromCart(item.id)}
                      className="text-fg-subtle hover:text-danger-fg font-bold px-0.5 text-xs transition"
                      title="Remove item"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* 1. BOTTOM DOCK MODE: Slim Cart Footer (checkout controls sit in Global Bottom Dock) */}
        {posLayout === 'bottom_dock' && (
          <div className="shrink-0 pt-1.5 border-t border-primary-line/70 flex items-center justify-between text-xs bg-surface/90 px-3 py-1.5 rounded-xl border border-primary-line/80 shadow-2xs">
            <div className="flex items-center gap-1.5 text-fg-2 font-bold">
              <span>🛒 {cart.length} items</span>
              <span className="text-fg-subtle">·</span>
              <span className="text-fg font-black">Subtotal: Rs. {subtotal.toFixed(0)}</span>
            </div>
            <span className="text-[10px] font-black uppercase text-primary-strong bg-primary-muted/80 px-2 py-0.5 rounded-full border border-primary-edge/60">
              Terminal Below ↓
            </span>
          </div>
        )}

        {/* 2. TWO-STAGE MODE: Maximum Cart Items Height + Streamlined Charge Button */}
        {posLayout === 'two_stage' && (
          <div className="shrink-0 space-y-2 border-t border-line-subtle pt-2 bg-surface">
            {/* Subtotal & Discount Summary Card */}
            <div className="bg-surface-2/80 rounded-xl p-2 border border-line/60 space-y-1 text-xs">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-fg-3 font-medium">
                  <span>Subtotal ({cart.reduce((a, c) => a + (parseFloat(c.qty) || 0), 0)} pcs):</span>
                  <span className="font-bold text-fg">Rs. {subtotal.toFixed(0)}</span>
                </div>

                {hasFeature('discount') && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-bold text-fg-muted">Disc:</span>
                    <div className="flex bg-surface-4/80 rounded p-0.5 text-[9px] font-bold">
                      <button
                        type="button"
                        onClick={() => setDiscountMode('fixed')}
                        className={`px-1 py-0.2 rounded transition ${discountMode === 'fixed' ? 'bg-primary text-white shadow-2xs' : 'text-fg-3'}`}
                      >
                        Rs
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountMode('percent')}
                        className={`px-1 py-0.2 rounded transition ${discountMode === 'percent' ? 'bg-primary text-white shadow-2xs' : 'text-fg-3'}`}
                      >
                        %
                      </button>
                    </div>

                    {discountMode === 'percent' ? (
                      <div className="flex items-center gap-0.5">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          max="100"
                          value={discountPercent}
                          onChange={e => handlePercentDiscountChange(e.target.value)}
                          placeholder="0"
                          className="w-12 px-1 py-0.5 border border-primary-edge rounded text-right text-xs font-bold text-primary-strong bg-surface outline-none"
                        />
                        <span className="text-[10px] font-bold text-fg-subtle">%</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-0.5">
                        <span className="text-[10px] text-fg-subtle">Rs.</span>
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={discount}
                          onChange={e => handleFixedDiscountChange(e.target.value)}
                          placeholder="0"
                          className="w-14 px-1 py-0.5 border border-primary-edge rounded text-right text-xs font-bold text-primary-strong bg-surface outline-none"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Quick % Presets */}
              {hasFeature('discount') && (
                <div className="flex items-center gap-1 pt-0.5 border-t border-line/50">
                  <span className="text-[9px] text-fg-subtle font-semibold shrink-0">Quick %:</span>
                  {[2, 5, 10, 15, 20].map(pct => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        setDiscountMode('percent')
                        handlePercentDiscountChange(pct.toString())
                      }}
                      className={`px-1.5 py-0.2 rounded text-[9px] font-bold border transition shrink-0 ${
                        discountMode === 'percent' && Number(discountPercent) === pct
                          ? 'bg-primary text-white border-primary'
                          : 'bg-surface text-fg-3 border-line hover:bg-surface-3'
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                  {(Number(totalDiscount) > 0 || Number(discountPercent) > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setDiscount(0)
                        setDiscountPercent('')
                      }}
                      className="text-[9px] text-danger-fg hover:underline ml-1 font-bold shrink-0"
                    >
                      Clear
                    </button>
                  )}
                  {Number(totalDiscount) > 0 && (
                    <span className="text-[10px] font-bold text-danger-fg ml-auto">
                      −Rs. {Number(totalDiscount).toFixed(0)}
                    </span>
                  )}
                </div>
              )}

              {/* Net Total & Profit */}
              <div className="flex justify-between items-center pt-1 border-t border-line/70">
                <div>
                  <span className="text-fg-muted text-[10px] uppercase font-black tracking-wider block">Net Total</span>
                  {(user.role === 'admin' || user.role === 'manager' || user.role === 'accountant') && totalProfit !== 0 && (
                    <div className={`text-[10px] font-bold ${totalProfit >= 0 ? 'text-success-fg' : 'text-danger-fg'}`}>
                      Profit: Rs. {totalProfit.toFixed(0)}
                    </div>
                  )}
                </div>
                <div className="font-black text-xl text-fg tracking-tight leading-none">
                  Rs. {total.toFixed(0)}
                </div>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="flex gap-1.5 pt-0.5">
              <button
                onClick={handleHoldBill}
                disabled={cart.length === 0}
                title="Hold this cart"
                className="px-3 py-2.5 bg-warning-muted hover:bg-warning-line text-warning-strong rounded-xl text-xs font-bold transition disabled:opacity-40 shrink-0"
              >
                ⏸️
              </button>
              <button
                onClick={clearCart}
                disabled={cart.length === 0}
                title="Clear cart"
                className="px-3 py-2.5 bg-surface-3 hover:bg-danger-muted hover:text-danger-strong text-fg-3 rounded-xl text-xs font-bold transition disabled:opacity-40 shrink-0"
              >
                🗑️
              </button>

              {saleType === 'quotation' ? (
                <>
                  <button
                    onClick={handleCompleteSale}
                    disabled={saving || cart.length === 0}
                    className="flex-1 py-2.5 bg-info hover:bg-info-hover text-white font-black text-sm rounded-xl transition shadow-md shadow-info-line active:scale-[0.99] disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {saving ? 'Processing...' : '🖨️ Print Quote'}
                  </button>
                  {cart.length > 0 && (
                    <button
                      onClick={waQuotation}
                      title="Send quotation via WhatsApp"
                      className="px-3 py-2.5 bg-success hover:bg-success-hover text-white rounded-xl text-sm font-bold transition shrink-0 shadow-xs"
                    >
                      💬
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowTenderSheet(true)}
                  disabled={cart.length === 0}
                  className="flex-1 py-2.5 bg-gradient-to-r from-primary via-primary to-primary-hover hover:from-primary-hover hover:to-primary-hover text-white font-black text-sm rounded-xl transition shadow-lg shadow-primary-line active:scale-[0.99] disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span>💳 Charge Rs. {total.toFixed(0)}</span>
                  <span className="text-[10px] bg-white/25 px-1.5 py-0.5 rounded font-mono font-normal">F4 →</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* 3. COMPACT DOCK MODE: Standard Compact Sidebar Toolbar */}
        {posLayout === 'compact_dock' && (
          <div className="shrink-0 space-y-2 border-t border-line-subtle pt-2 bg-surface">
            {/* Subtotal & Discount Summary Card */}
            <div className="bg-surface-2/80 rounded-xl p-2 border border-line/60 space-y-1 text-xs">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-fg-3 font-medium">
                  <span>Subtotal ({cart.reduce((a, c) => a + (parseFloat(c.qty) || 0), 0)} pcs):</span>
                  <span className="font-bold text-fg">Rs. {subtotal.toFixed(0)}</span>
                </div>

                {hasFeature('discount') && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-bold text-fg-muted">Disc:</span>
                    <div className="flex bg-surface-4/80 rounded p-0.5 text-[9px] font-bold">
                      <button
                        type="button"
                        onClick={() => setDiscountMode('fixed')}
                        className={`px-1 py-0.2 rounded transition ${discountMode === 'fixed' ? 'bg-primary text-white shadow-2xs' : 'text-fg-3'}`}
                      >
                        Rs
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountMode('percent')}
                        className={`px-1 py-0.2 rounded transition ${discountMode === 'percent' ? 'bg-primary text-white shadow-2xs' : 'text-fg-3'}`}
                      >
                        %
                      </button>
                    </div>

                    {discountMode === 'percent' ? (
                      <div className="flex items-center gap-0.5">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          max="100"
                          value={discountPercent}
                          onChange={e => handlePercentDiscountChange(e.target.value)}
                          placeholder="0"
                          className="w-12 px-1 py-0.5 border border-primary-edge rounded text-right text-xs font-bold text-primary-strong bg-surface outline-none"
                        />
                        <span className="text-[10px] font-bold text-fg-subtle">%</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-0.5">
                        <span className="text-[10px] text-fg-subtle">Rs.</span>
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={discount}
                          onChange={e => handleFixedDiscountChange(e.target.value)}
                          placeholder="0"
                          className="w-14 px-1 py-0.5 border border-primary-edge rounded text-right text-xs font-bold text-primary-strong bg-surface outline-none"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Quick % Presets */}
              {hasFeature('discount') && (
                <div className="flex items-center gap-1 pt-0.5 border-t border-line/50">
                  <span className="text-[9px] text-fg-subtle font-semibold shrink-0">Quick %:</span>
                  {[2, 5, 10, 15, 20].map(pct => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        setDiscountMode('percent')
                        handlePercentDiscountChange(pct.toString())
                      }}
                      className={`px-1.5 py-0.2 rounded text-[9px] font-bold border transition shrink-0 ${
                        discountMode === 'percent' && Number(discountPercent) === pct
                          ? 'bg-primary text-white border-primary'
                          : 'bg-surface text-fg-3 border-line hover:bg-surface-3'
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                  {(Number(totalDiscount) > 0 || Number(discountPercent) > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setDiscount(0)
                        setDiscountPercent('')
                      }}
                      className="text-[9px] text-danger-fg hover:underline ml-1 font-bold shrink-0"
                    >
                      Clear
                    </button>
                  )}
                  {Number(totalDiscount) > 0 && (
                    <span className="text-[10px] font-bold text-danger-fg ml-auto">
                      −Rs. {Number(totalDiscount).toFixed(0)}
                    </span>
                  )}
                </div>
              )}

              {/* Net Total */}
              <div className="flex justify-between items-center pt-1 border-t border-line/70">
                <div>
                  <span className="text-fg-muted text-[10px] uppercase font-black tracking-wider block">Net Total</span>
                  {(user.role === 'admin' || user.role === 'manager' || user.role === 'accountant') && totalProfit !== 0 && (
                    <div className={`text-[10px] font-bold ${totalProfit >= 0 ? 'text-success-fg' : 'text-danger-fg'}`}>
                      Net Profit: Rs. {totalProfit.toFixed(0)}
                    </div>
                  )}
                </div>
                <div className="font-black text-xl text-fg tracking-tight leading-none">
                  Rs. {total.toFixed(0)}
                </div>
              </div>
            </div>

            {/* Tendered & Payment Section */}
            {saleType === 'sale' && (
              <div className="flex flex-col gap-1 bg-gradient-to-br from-primary-soft/80 to-primary-soft/50 p-2 rounded-xl border border-primary-muted shadow-2xs">
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] font-bold text-primary-strong">💵 Tendered:</span>
                    <div className="flex items-center bg-surface border border-primary-edge rounded-md px-1.5 py-0.5 shadow-2xs">
                      <span className="text-[10px] font-bold text-fg-subtle mr-0.5">Rs.</span>
                      <input
                        type="number"
                        value={receivedAmount}
                        onChange={e => {
                          const val = e.target.value;
                          setReceivedAmount(val);
                          if (val !== '' && Number(val) < total) setPaymentType('partial');
                          else if (val !== '' && Number(val) >= total) setPaymentType('cash');
                        }}
                        placeholder={total.toFixed(0)}
                        className="w-20 text-right font-black text-primary-strong text-xs outline-none bg-transparent"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar">
                    <button
                      type="button"
                      onClick={() => { setPaymentType('cash'); setReceivedAmount(total.toString()) }}
                      className="px-1.5 py-0.5 text-[9px] font-black rounded bg-success hover:bg-success-hover text-white transition shrink-0 shadow-2xs"
                    >
                      Exact
                    </button>
                    {(() => {
                      const ceil100 = Math.ceil(total / 100) * 100
                      const ceil500 = Math.ceil(total / 500) * 500
                      const ceil1000 = Math.ceil(total / 1000) * 1000
                      const notes = [
                        ceil100 > total ? ceil100 : null,
                        ceil500 > total && ceil500 !== ceil100 ? ceil500 : null,
                        ceil1000 > total && ceil1000 !== ceil500 ? ceil1000 : null,
                        500 > total ? 500 : null,
                        1000 > total ? 1000 : null,
                        5000 > total ? 5000 : null
                      ].filter((v, i, arr) => v !== null && arr.indexOf(v) === i).sort((a,b) => a - b).slice(0, 3)

                      return notes.map(note => (
                        <button
                          key={note}
                          type="button"
                          onClick={() => { setPaymentType('cash'); setReceivedAmount(note.toString()) }}
                          className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-surface border border-primary-line hover:bg-primary-muted text-primary-strong transition shrink-0 shadow-2xs"
                        >
                          Rs.{note}
                        </button>
                      ))
                    })()}
                  </div>
                </div>

                {receivedAmount !== '' && Number(receivedAmount) > total && (
                  <div className="flex items-center justify-between bg-success text-white px-2 py-0.5 rounded-lg text-xs font-bold shadow-2xs">
                    <span>🟢 Change Due:</span>
                    <span className="text-sm font-black">Rs. {(Number(receivedAmount) - total).toFixed(0)}</span>
                  </div>
                )}
                {receivedAmount !== '' && Number(receivedAmount) < total && (
                  <div className="flex items-center justify-between bg-warning text-white px-2 py-0.5 rounded-lg text-xs font-bold shadow-2xs">
                    <span>🟠 Balance (Credit):</span>
                    <span className="text-sm font-black">Rs. {(total - Number(receivedAmount)).toFixed(0)}</span>
                  </div>
                )}

                <div className="grid grid-cols-4 gap-1">
                  <button onClick={() => { setPaymentType('cash'); setReceivedAmount(total.toString()) }}
                    className={`py-1 rounded-lg font-bold text-[10px] uppercase transition flex items-center justify-center gap-1 ${paymentType === 'cash' ? 'bg-success text-white shadow-xs' : 'bg-surface text-fg-2 border border-line hover:bg-surface-2'}`}>
                    💵 Cash
                  </button>
                  <button onClick={() => { setPaymentType('online'); setReceivedAmount(total.toString()) }}
                    className={`py-1 rounded-lg font-bold text-[10px] uppercase transition flex items-center justify-center gap-1 ${paymentType === 'online' ? 'bg-primary text-white shadow-xs' : 'bg-surface text-fg-2 border border-line hover:bg-surface-2'}`}>
                    📱 Online
                  </button>
                  <button onClick={() => { setPaymentType('credit'); setReceivedAmount('0') }}
                    className={`py-1 rounded-lg font-bold text-[10px] uppercase transition flex items-center justify-center gap-1 ${paymentType === 'credit' ? 'bg-warning text-white shadow-xs' : 'bg-surface text-fg-2 border border-line hover:bg-surface-2'}`}>
                    📒 Credit
                  </button>
                  <button onClick={() => { setPaymentType('split'); setShowPaymentModal(true); if (payments.length === 0) setPayments([{ method: 'cash', amount: total }]) }}
                    className={`py-1 rounded-lg font-bold text-[10px] uppercase transition flex items-center justify-center gap-1 ${paymentType === 'split' ? 'bg-info text-white shadow-xs' : 'bg-surface text-fg-2 border border-line hover:bg-surface-2'}`}>
                    🔀 Split
                  </button>
                </div>

                {paymentType === 'online' && (
                  <div className="p-1.5 bg-surface border border-primary-line rounded-lg space-y-1 shadow-2xs">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-primary-strong shrink-0">Provider:</span>
                      <select
                        value={onlineProvider}
                        onChange={e => setOnlineProvider(e.target.value)}
                        className="w-full text-xs font-semibold px-2 py-0.5 bg-surface-2 border border-primary-edge rounded-md focus:ring-1 focus:ring-primary outline-none text-fg"
                      >
                        <optgroup label="Mobile Wallets & FinTech">
                          <option value="jazzcash">📱 JazzCash</option>
                          <option value="easypaisa">🟢 Easypaisa</option>
                          <option value="sadapay">💳 SadaPay</option>
                          <option value="nayapay">🟣 NayaPay</option>
                        </optgroup>
                        <optgroup label="Pakistani Banks (IBFT / Raast)">
                          <option value="meezan">🏦 Meezan Bank</option>
                          <option value="hbl">🏦 HBL (Habib Bank)</option>
                          <option value="ubl">🏦 UBL (United Bank)</option>
                          <option value="mcb">🏦 MCB Bank</option>
                          <option value="abl">🏦 Allied Bank (ABL)</option>
                          <option value="alfalah">🏦 Bank Alfalah</option>
                          <option value="faysal">🏦 Faysal Bank</option>
                          <option value="bop">🏦 Bank of Punjab (BOP)</option>
                          <option value="askari">🏦 Askari Bank</option>
                          <option value="other_bank">🏛️ Other Bank Transfer / Raast</option>
                        </optgroup>
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-semibold text-primary-strong shrink-0">TID / Ref:</span>
                      <input
                        type="text"
                        value={transactionRef}
                        onChange={e => setTransactionRef(e.target.value)}
                        placeholder="e.g. TID-98214 (optional)"
                        className="w-full text-xs px-2 py-0.5 bg-surface-2 border border-primary-line rounded-md outline-none focus:border-primary placeholder:text-fg-subtle font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons Row */}
            <div className="flex gap-1.5 pt-1">
              <button
                onClick={handleHoldBill}
                disabled={cart.length === 0}
                title="Hold this cart"
                className="px-3 py-2 bg-warning-muted hover:bg-warning-line text-warning-strong rounded-xl text-xs font-bold transition disabled:opacity-40 shrink-0"
              >
                ⏸️
              </button>
              <button
                onClick={clearCart}
                disabled={cart.length === 0}
                title="Clear cart"
                className="px-3 py-2 bg-surface-3 hover:bg-danger-muted hover:text-danger-strong text-fg-3 rounded-xl text-xs font-bold transition disabled:opacity-40 shrink-0"
              >
                🗑️
              </button>
              <button
                onClick={handleCompleteSale}
                disabled={saving || cart.length === 0}
                className={`flex-1 py-2.5 text-white text-sm font-black rounded-xl transition duration-150 shadow-md active:scale-[0.99] disabled:opacity-50 flex items-center justify-center gap-2 ${
                  saleType === 'quotation'
                    ? 'bg-info hover:bg-info-hover shadow-info-line'
                    : 'bg-gradient-to-r from-primary to-primary hover:from-primary-hover hover:to-primary-hover shadow-primary-line'
                }`}
              >
                {saving ? 'Processing...' : saleType === 'quotation' ? '🖨️ Print Quote' : (isWholesale ? '✅ Complete Wholesale' : '✅ Complete Sale')}
              </button>
              {saleType === 'quotation' && cart.length > 0 && (
                <button
                  onClick={waQuotation}
                  title="Send quotation via WhatsApp"
                  className="px-3 py-2 bg-success hover:bg-success-hover text-white rounded-xl text-sm font-bold transition shrink-0 shadow-xs"
                >
                  💬
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {/* End Upper Main Workspace */}
      </div>

      {/* 4. GLOBAL BOTTOM DOCK (renders across bottom when posLayout === 'bottom_dock') */}
      {posLayout === 'bottom_dock' && (
        <div className="shrink-0 bg-surface-3/95 border-t-[3px] border-line-strong shadow-[0_-8px_20px_rgba(0,0,0,0.06)] px-4 py-2 z-30 relative text-fg">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            {/* LEFT / CENTER: Remaining Area of the Dock (Tender, Notes, Methods, Hold/Clear) */}
            <div className="flex-1 min-w-0 flex flex-wrap items-center justify-between gap-2.5">
              {/* Tendered Input & Smart Quick Notes */}
              {saleType === 'sale' && (
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1.5 bg-surface px-2.5 py-1.5 rounded-xl border border-line/90 shadow-2xs shrink-0">
                    <span className="text-xs font-bold text-fg-3 shrink-0 whitespace-nowrap">💵 Tendered:</span>
                    <div className="flex items-center bg-surface-2 border border-line-strong rounded-lg px-2 py-0.5 shrink-0 focus-within:border-primary focus-within:bg-surface transition">
                      <span className="text-xs font-bold text-fg-subtle mr-1 shrink-0">Rs.</span>
                      <input
                        type="number"
                        value={receivedAmount}
                        onChange={e => {
                          const val = e.target.value;
                          setReceivedAmount(val);
                          if (val !== '' && Number(val) < total) setPaymentType('partial');
                          else if (val !== '' && Number(val) >= total) setPaymentType('cash');
                        }}
                        placeholder={total.toFixed(0)}
                        className="w-20 font-black text-xs text-primary-strong bg-transparent text-right outline-none font-mono"
                      />
                    </div>

                    {/* Quick exact & smart round note buttons */}
                    <button
                      type="button"
                      onClick={() => { setPaymentType('cash'); setReceivedAmount(total.toString()) }}
                      className="px-2.5 py-1 text-xs font-black rounded-lg bg-success hover:bg-success-hover text-white transition shadow-2xs shrink-0 active:scale-95"
                    >
                      Exact
                    </button>
                    {(() => {
                      if (total <= 0) return null;
                      const next100 = Math.ceil(total / 100) * 100;
                      const next500 = Math.ceil(total / 500) * 500;
                      const next1000 = Math.ceil(total / 1000) * 1000;
                      const next5000 = Math.ceil(total / 5000) * 5000;
                      const candidates = [next100, next500, next1000, next5000, 1000, 5000];
                      const notes = candidates
                        .filter((v, i, arr) => v > total && arr.indexOf(v) === i)
                        .sort((a, b) => a - b)
                        .slice(0, 2);

                      return notes.map(note => (
                        <button
                          key={note}
                          type="button"
                          onClick={() => { setPaymentType('cash'); setReceivedAmount(note.toString()) }}
                          className="px-2 py-1 text-xs font-bold rounded-lg bg-surface-2 hover:bg-primary-soft hover:text-primary-strong text-fg-2 border border-line transition shrink-0 active:scale-95 whitespace-nowrap shadow-2xs"
                        >
                          Rs.{note}
                        </button>
                      ));
                    })()}
                  </div>

                  {/* Live Change Due / Balance Indicator */}
                  {receivedAmount !== '' && Number(receivedAmount) > total && (
                    <div className="bg-success-soft border border-success-line text-success-strong px-2.5 py-1 rounded-xl text-xs font-bold shrink-0 flex items-center gap-1 shadow-2xs">
                      <span>🟢 Change:</span>
                      <span className="font-mono font-black text-success-strong text-sm">Rs. {(Number(receivedAmount) - total).toFixed(0)}</span>
                    </div>
                  )}
                  {receivedAmount !== '' && Number(receivedAmount) < total && (
                    <div className="bg-warning-soft border border-warning-line text-warning-strong px-2.5 py-1 rounded-xl text-xs font-bold shrink-0 flex items-center gap-1 shadow-2xs">
                      <span>🟠 Balance:</span>
                      <span className="font-mono font-black text-warning-strong text-sm">Rs. {(total - Number(receivedAmount)).toFixed(0)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Payment Method Tabs & Online Details */}
              {saleType === 'sale' && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="flex items-center bg-surface p-1 rounded-xl border border-line/90 shadow-2xs">
                    <button
                      type="button"
                      onClick={() => { setPaymentType('cash'); setReceivedAmount(total.toString()) }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 ${paymentType === 'cash' ? 'bg-success text-white shadow-xs' : 'text-fg-3 hover:text-fg hover:bg-surface-2'}`}
                    >
                      💵 Cash
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPaymentType('online'); setReceivedAmount(total.toString()) }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 ${paymentType === 'online' ? 'bg-primary text-white shadow-xs' : 'text-fg-3 hover:text-fg hover:bg-surface-2'}`}
                    >
                      📱 Online
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPaymentType('credit'); setReceivedAmount('0') }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 ${paymentType === 'credit' ? 'bg-warning text-white shadow-xs' : 'text-fg-3 hover:text-fg hover:bg-surface-2'}`}
                    >
                      📒 Credit
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPaymentType('split'); setShowPaymentModal(true); if (payments.length === 0) setPayments([{ method: 'cash', amount: total }]) }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 ${paymentType === 'split' ? 'bg-info text-white shadow-xs' : 'text-fg-3 hover:text-fg hover:bg-surface-2'}`}
                    >
                      🔀 Split
                    </button>
                  </div>

                  {paymentType === 'online' && (
                    <div className="flex items-center gap-1.5 bg-surface p-1 rounded-xl border border-primary-line shadow-2xs">
                      <select
                        value={onlineProvider}
                        onChange={e => setOnlineProvider(e.target.value)}
                        className="text-xs font-semibold px-2 py-0.5 bg-surface-2 border border-line rounded-lg text-fg outline-none focus:border-primary"
                      >
                        <optgroup label="Wallets">
                          <option value="jazzcash">JazzCash</option>
                          <option value="easypaisa">Easypaisa</option>
                          <option value="sadapay">SadaPay</option>
                          <option value="nayapay">NayaPay</option>
                        </optgroup>
                        <optgroup label="Banks">
                          <option value="meezan">Meezan Bank</option>
                          <option value="hbl">HBL</option>
                          <option value="ubl">UBL</option>
                          <option value="mcb">MCB</option>
                          <option value="abl">ABL</option>
                          <option value="alfalah">Bank Alfalah</option>
                          <option value="other_bank">Other Bank</option>
                        </optgroup>
                      </select>
                      <input
                        type="text"
                        value={transactionRef}
                        onChange={e => setTransactionRef(e.target.value)}
                        placeholder="TID/Ref"
                        className="w-24 text-xs px-2 py-0.5 bg-surface-2 border border-line rounded-lg text-fg outline-none placeholder:text-fg-subtle font-mono focus:border-primary"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Hold & Clear Buttons */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={handleHoldBill}
                  disabled={cart.length === 0}
                  title="Hold this cart"
                  className="px-3 py-2 bg-warning-soft hover:bg-warning-muted text-warning-strong border border-warning-line rounded-xl text-xs font-bold transition disabled:opacity-40 flex items-center gap-1 shadow-2xs active:scale-95"
                >
                  ⏸️ Hold
                </button>
                <button
                  onClick={clearCart}
                  disabled={cart.length === 0}
                  title="Clear cart"
                  className="px-3 py-2 bg-surface-2 hover:bg-danger-soft text-fg-3 hover:text-danger-strong border border-line hover:border-danger-line rounded-xl text-xs font-bold transition disabled:opacity-40 flex items-center gap-1 shadow-2xs active:scale-95"
                >
                  🗑️ Clear
                </button>
              </div>
            </div>

            {/* RIGHT: Aligned Below the Cart Sidebar (Totals & Discount + Complete Sale) */}
            <div className="w-full md:w-96 lg:w-[410px] xl:w-[430px] shrink-0 flex items-center justify-between gap-2.5 md:pl-3 md:border-l-2 md:border-line-strong/80">
              {/* Totals & Discount Card */}
              <div className="bg-surface border border-primary-line/90 rounded-xl px-3 py-2 shadow-2xs flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase font-black text-fg-subtle tracking-wider leading-none">Net Payable</span>
                  {hasFeature('discount') && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="font-bold text-fg-muted text-[11px]">Disc:</span>
                      <button
                        type="button"
                        onClick={() => setDiscountMode(m => m === 'percent' ? 'fixed' : 'percent')}
                        className="px-2 py-0.5 rounded-md text-[10px] font-black bg-primary hover:bg-primary-hover text-white transition shadow-2xs"
                      >
                        {discountMode === 'percent' ? '%' : 'Rs'}
                      </button>
                      {discountMode === 'percent' ? (
                        <div className="flex items-center bg-surface-2 border border-line-strong rounded-lg px-2 py-0.5 focus-within:border-primary focus-within:bg-surface transition">
                          <input
                            type="number"
                            step="any"
                            min="0"
                            max="100"
                            value={discountPercent}
                            onChange={e => handlePercentDiscountChange(e.target.value)}
                            placeholder="0"
                            className="w-16 text-center text-xs font-black text-primary-strong bg-transparent outline-none"
                          />
                          <span className="text-[10px] font-bold text-fg-subtle ml-0.5">%</span>
                        </div>
                      ) : (
                        <div className="flex items-center bg-surface-2 border border-line-strong rounded-lg px-2 py-0.5 focus-within:border-primary focus-within:bg-surface transition">
                          <span className="text-[10px] font-bold text-fg-subtle mr-1">Rs.</span>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={discount}
                            onChange={e => handleFixedDiscountChange(e.target.value)}
                            placeholder="0"
                            className="w-20 text-right text-xs font-black text-primary-strong bg-transparent outline-none font-mono"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-baseline justify-between gap-1 mt-1">
                  <div className="text-xl font-black text-fg leading-tight tracking-tight">Rs. {total.toFixed(0)}</div>
                  <div className="text-[10px] text-fg-muted font-medium">Subtotal: Rs. {subtotal.toFixed(0)}</div>
                </div>
              </div>

              {/* Complete Sale Primary Action */}
              <button
                onClick={handleCompleteSale}
                disabled={saving || cart.length === 0}
                className={`px-4 py-2.5 text-white text-sm font-black rounded-xl transition shadow-md active:scale-95 disabled:opacity-40 flex items-center justify-center gap-1.5 shrink-0 ${
                  saleType === 'quotation'
                    ? 'bg-info hover:bg-info-hover shadow-info-line'
                    : 'bg-gradient-to-r from-primary via-primary to-primary-hover hover:from-primary-hover hover:to-primary-hover shadow-primary-line'
                }`}
              >
                {saving ? 'Processing...' : saleType === 'quotation' ? '🖨️ Quote' : (isWholesale ? '✅ Complete Wholesale' : '✅ Complete Sale')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. TWO-STAGE TENDER SHEET MODAL */}
      {showTenderSheet && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-3 sm:p-4 animate-in fade-in duration-150">
          <div className="bg-surface rounded-2xl shadow-2xl border border-line w-full max-w-lg overflow-hidden flex flex-col max-h-[92dvh]">
            {/* Tender Header */}
            <div className="bg-gradient-to-r from-primary-hover via-primary-hover to-primary-hover text-white p-4 flex justify-between items-center shrink-0">
              <div>
                <span className="text-[10px] uppercase tracking-wider font-bold text-white/80 block">{BRAND.shortName} Checkout</span>
                <h3 className="text-xl font-black flex items-center gap-2">
                  <span>💳 Total Payable:</span>
                  <span className="text-white/70">Rs. {total.toFixed(0)}</span>
                </h3>
              </div>
              <button
                onClick={() => setShowTenderSheet(false)}
                className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white font-bold text-sm transition"
                title="Close (Esc)"
              >
                ✕
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-4">
              {/* Customer Info Reminder */}
              <div className="flex items-center justify-between bg-surface-2 px-3 py-2 rounded-xl border border-line text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-fg-2">
                  <span>👤 Customer:</span>
                  <span className="font-bold text-primary-strong">
                    {customerId ? customers.find(c => String(c.id) === String(customerId))?.name : (walkInName || 'Walk-in Customer')}
                  </span>
                </div>
                {customerId && (() => {
                  const cust = customers.find(c => String(c.id) === String(customerId))
                  return cust?.outstanding_balance > 0 ? (
                    <span className="text-warning-strong bg-warning-soft border border-warning-line px-2 py-0.5 rounded-full text-[11px] font-bold">
                      Prev Due: Rs. {cust.outstanding_balance}
                    </span>
                  ) : null
                })()}
              </div>

              {/* Tendered Input & Quick Cash Notes */}
              <div className="bg-gradient-to-br from-primary-soft/90 to-primary-soft/60 p-3 rounded-xl border border-primary-line/80 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-black text-primary-strong uppercase tracking-wide">💵 Received / Tendered Amount</label>
                  <span className="text-[11px] text-primary-fg font-semibold">Bill: Rs. {total.toFixed(0)}</span>
                </div>

                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 font-bold text-fg-subtle text-sm">Rs.</span>
                  <input
                    type="number"
                    autoFocus
                    value={receivedAmount}
                    onChange={e => {
                      const val = e.target.value;
                      setReceivedAmount(val);
                      if (val !== '' && Number(val) < total) setPaymentType('partial');
                      else if (val !== '' && Number(val) >= total) setPaymentType('cash');
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCompleteSale();
                      }
                    }}
                    placeholder={total.toFixed(0)}
                    className="w-full pl-10 pr-3 py-2.5 bg-surface border-2 border-primary rounded-xl text-lg font-black text-fg outline-none focus:ring-2 focus:ring-primary shadow-inner"
                  />
                </div>

                {/* Quick Cash Presets */}
                <div className="flex items-center gap-1.5 pt-1 overflow-x-auto custom-scrollbar">
                  <span className="text-[10px] font-bold text-primary-strong shrink-0">Quick Cash:</span>
                  <button
                    type="button"
                    onClick={() => { setPaymentType('cash'); setReceivedAmount(total.toString()) }}
                    className="px-2.5 py-1 text-xs font-black rounded-lg bg-success hover:bg-success-hover text-white transition shadow-xs shrink-0"
                  >
                    Exact (Rs. {total.toFixed(0)})
                  </button>
                  {(() => {
                    const ceil100 = Math.ceil(total / 100) * 100
                    const ceil500 = Math.ceil(total / 500) * 500
                    const ceil1000 = Math.ceil(total / 1000) * 1000
                    const ceil5000 = Math.ceil(total / 5000) * 5000
                    const notes = [
                      ceil100 > total ? ceil100 : null,
                      ceil500 > total && ceil500 !== ceil100 ? ceil500 : null,
                      ceil1000 > total && ceil1000 !== ceil500 ? ceil1000 : null,
                      ceil5000 > total && ceil5000 !== ceil1000 ? ceil5000 : null,
                      500 > total ? 500 : null,
                      1000 > total ? 1000 : null,
                      5000 > total ? 5000 : null
                    ].filter((v, i, arr) => v !== null && arr.indexOf(v) === i).sort((a,b) => a - b).slice(0, 4)

                    return notes.map(note => (
                      <button
                        key={note}
                        type="button"
                        onClick={() => { setPaymentType('cash'); setReceivedAmount(note.toString()) }}
                        className="px-2.5 py-1 text-xs font-bold rounded-lg bg-surface border border-primary-edge hover:bg-primary-muted text-primary-strong transition shadow-xs shrink-0"
                      >
                        Rs. {note}
                      </button>
                    ))
                  })()}
                </div>

                {/* Change Due / Balance Warning */}
                {receivedAmount !== '' && Number(receivedAmount) > total && (
                  <div className="flex items-center justify-between bg-success text-white px-3 py-2 rounded-xl text-sm font-bold shadow-sm">
                    <span className="flex items-center gap-1.5">🟢 Wapis Karein (Change Due):</span>
                    <span className="text-lg font-black tracking-tight">Rs. {(Number(receivedAmount) - total).toFixed(0)}</span>
                  </div>
                )}
                {receivedAmount !== '' && Number(receivedAmount) < total && (
                  <div className="flex items-center justify-between bg-warning text-white px-3 py-2 rounded-xl text-sm font-bold shadow-sm">
                    <span className="flex items-center gap-1.5">🟠 Baqaya (Credit Balance):</span>
                    <span className="text-lg font-black tracking-tight">Rs. {(total - Number(receivedAmount)).toFixed(0)}</span>
                  </div>
                )}
              </div>

              {/* Payment Methods */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-fg-2 uppercase tracking-wide">Payment Method</label>
                <div className="grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => { setPaymentType('cash'); setReceivedAmount(total.toString()) }}
                    className={`py-2.5 rounded-xl font-bold text-xs uppercase transition flex flex-col items-center justify-center gap-1 border ${
                      paymentType === 'cash' ? 'bg-success text-white border-success shadow-md' : 'bg-surface text-fg-2 border-line hover:bg-surface-2'
                    }`}
                  >
                    <span className="text-base">💵</span>
                    <span>Cash</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPaymentType('online'); setReceivedAmount(total.toString()) }}
                    className={`py-2.5 rounded-xl font-bold text-xs uppercase transition flex flex-col items-center justify-center gap-1 border ${
                      paymentType === 'online' ? 'bg-primary text-white border-primary shadow-md' : 'bg-surface text-fg-2 border-line hover:bg-surface-2'
                    }`}
                  >
                    <span className="text-base">📱</span>
                    <span>Online</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPaymentType('credit'); setReceivedAmount('0') }}
                    className={`py-2.5 rounded-xl font-bold text-xs uppercase transition flex flex-col items-center justify-center gap-1 border ${
                      paymentType === 'credit' ? 'bg-warning text-white border-warning shadow-md' : 'bg-surface text-fg-2 border-line hover:bg-surface-2'
                    }`}
                  >
                    <span className="text-base">📒</span>
                    <span>Credit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentType('split');
                      setShowPaymentModal(true);
                      if (payments.length === 0) setPayments([{ method: 'cash', amount: total }]);
                    }}
                    className={`py-2.5 rounded-xl font-bold text-xs uppercase transition flex flex-col items-center justify-center gap-1 border ${
                      paymentType === 'split' ? 'bg-info text-white border-info shadow-md' : 'bg-surface text-fg-2 border-line hover:bg-surface-2'
                    }`}
                  >
                    <span className="text-base">🔀</span>
                    <span>Split</span>
                  </button>
                </div>
              </div>

              {/* Online Provider Selection & TID Input */}
              {paymentType === 'online' && (
                <div className="p-3 bg-primary-soft/70 border border-primary-line rounded-xl space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="text-xs font-bold text-primary-strong shrink-0">Select Bank / Wallet:</span>
                    <select
                      value={onlineProvider}
                      onChange={e => setOnlineProvider(e.target.value)}
                      className="flex-1 text-xs font-semibold px-2.5 py-1.5 bg-surface border border-primary-edge rounded-lg focus:ring-2 focus:ring-primary outline-none text-fg"
                    >
                      <optgroup label="Mobile Wallets & FinTech">
                        <option value="jazzcash">📱 JazzCash</option>
                        <option value="easypaisa">🟢 Easypaisa</option>
                        <option value="sadapay">💳 SadaPay</option>
                        <option value="nayapay">🟣 NayaPay</option>
                      </optgroup>
                      <optgroup label="Pakistani Banks (IBFT / Raast)">
                        <option value="meezan">🏦 Meezan Bank</option>
                        <option value="hbl">🏦 HBL (Habib Bank)</option>
                        <option value="ubl">🏦 UBL (United Bank)</option>
                        <option value="mcb">🏦 MCB Bank</option>
                        <option value="abl">🏦 Allied Bank (ABL)</option>
                        <option value="alfalah">🏦 Bank Alfalah</option>
                        <option value="faysal">🏦 Faysal Bank</option>
                        <option value="bop">🏦 Bank of Punjab (BOP)</option>
                        <option value="askari">🏦 Askari Bank</option>
                        <option value="other_bank">🏛️ Other Bank Transfer / Raast</option>
                      </optgroup>
                    </select>
                  </div>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="text-xs font-semibold text-primary-strong shrink-0">Transaction Ref / TID:</span>
                    <input
                      type="text"
                      value={transactionRef}
                      onChange={e => setTransactionRef(e.target.value)}
                      placeholder="e.g. TID-98214 (optional)"
                      className="flex-1 text-xs px-2.5 py-1.5 bg-surface border border-primary-edge rounded-lg outline-none focus:ring-2 focus:ring-primary placeholder:text-fg-subtle font-mono"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Tender Footer Actions */}
            <div className="p-3 bg-surface-2 border-t border-line flex items-center justify-between gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowTenderSheet(false)}
                className="px-4 py-2.5 bg-surface border border-line-strong hover:bg-surface-3 text-fg-2 rounded-xl text-xs font-bold transition"
              >
                ← Back to Cart
              </button>
              <button
                type="button"
                onClick={handleCompleteSale}
                disabled={saving || cart.length === 0}
                className="flex-1 py-3 bg-gradient-to-r from-success to-success hover:from-success-hover hover:to-success-hover text-white font-black text-sm rounded-xl transition shadow-lg shadow-success-line active:scale-[0.99] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? 'Processing...' : `✅ Complete ${isWholesale ? 'Wholesale ' : ''}Sale (Rs. ${total.toFixed(0)})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save Walk-in as Customer Modal */}
      {showSaveCustomer && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-sm">
            <h3 className="font-bold text-fg text-lg mb-1">👤 Customer Save Karein</h3>
            <p className="text-sm text-fg-muted mb-4">Yeh walk-in customer ko apni customer list mein add karein</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-fg-2 mb-1">Naam *</label>
                <input
                  type="text"
                  value={saveCustomerForm.name}
                  onChange={e => setSaveCustomerForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Customer ka naam"
                  autoFocus
                  className="w-full px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-success"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-fg-2 mb-1">Mobile Number</label>
                <input
                  type="tel"
                  value={saveCustomerForm.mobile}
                  onChange={e => setSaveCustomerForm(f => ({ ...f, mobile: e.target.value }))}
                  placeholder="0300-0000000"
                  className="w-full px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-success"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={handleSaveCustomer}
                disabled={savingCustomer}
                className="flex-1 py-2.5 bg-success hover:bg-success-hover text-white rounded-lg font-bold transition disabled:opacity-50"
              >
                {savingCustomer ? 'Saving...' : '✅ Save Customer'}
              </button>
              <button
                onClick={() => { setShowSaveCustomer(false); setSaveCustomerForm({ name: '', mobile: '' }) }}
                className="flex-1 py-2.5 bg-surface-3 hover:bg-surface-4 text-fg-2 rounded-lg font-bold transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Brand Discount Modal */}
      {showBrandDiscount && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-sm">
            <h3 className="font-bold text-fg mb-2">🏷️ {selectedBrand} — Brand Discount</h3>

            {/* Mode Toggle */}
            <div className="flex gap-2 mb-3">
              <button onClick={() => setBrandDiscountMode('cart_only')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition ${brandDiscountMode === 'cart_only' ? 'bg-success text-white' : 'bg-surface-3 text-fg-3'}`}>
                🛒 Cart Only
              </button>
              <button onClick={() => setBrandDiscountMode('add_all')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition ${brandDiscountMode === 'add_all' ? 'bg-warning text-white' : 'bg-surface-3 text-fg-3'}`}>
                📦 Add All Products
              </button>
            </div>
            <p className="text-xs text-fg-muted mb-3">
              {brandDiscountMode === 'cart_only'
                ? 'Sirf cart mein mojood is brand ke products ki price update hogi.'
                : 'Is brand ke tamam products cart mein add honge discount ke saath.'}
            </p>

            {/* Discount Type */}
            <div className="flex gap-2 mb-3">
              <button onClick={() => setBrandDiscountType('percent')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium ${brandDiscountType === 'percent' ? 'bg-primary text-white' : 'bg-surface-3 text-fg-3'}`}>
                % Percent ({pricingConfig.label})
              </button>
              <button onClick={() => setBrandDiscountType('fixed')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium ${brandDiscountType === 'fixed' ? 'bg-primary text-white' : 'bg-surface-3 text-fg-3'}`}>
                Rs. Fixed
              </button>
            </div>
            <input type="number" value={brandDiscountValue} onChange={e => setBrandDiscountValue(e.target.value)}
              placeholder={brandDiscountType === 'percent' ? `e.g. 1 (extra % from ${pricingConfig.label})` : 'e.g. 50 (Rs.)'}
              className="w-full px-4 py-2 border rounded-lg mb-3 focus:outline-none focus:ring-2 focus:ring-primary" />

            {/* Preview */}
            {brandDiscountType === 'percent' && brandDiscountValue && (() => {
              const val = parseFloat(brandDiscountValue) || 0
              const cartBrandItems = cart.filter(i => i.brand === selectedBrand)
              const previewItems = brandDiscountMode === 'cart_only'
                ? cartBrandItems
                : products.filter(p => p.brand === selectedBrand).map(p => {
                    const inCart = cartBrandItems.find(c => c.id === p.id)
                    return inCart || p
                  })
              if (previewItems.length === 0) return <p className="text-xs text-fg-subtle mb-3 italic">No matching items in cart.</p>
              return (
                <div className="bg-surface-2 rounded-lg p-2 mb-3 max-h-32 overflow-y-auto">
                  <p className="text-[10px] font-bold text-fg-muted uppercase mb-1">Preview</p>
                  {previewItems.slice(0, 5).map(item => {
                    const cRate = parseFloat(item.c_rate) || 0
                    const currentPrice = item.custom_price || item.sale_price
                    let newPrice = currentPrice
                    if (cRate > 0) {
                      const currentDisc = (1 - currentPrice / cRate) * 100
                      newPrice = cRate * (1 - (currentDisc + val) / 100)
                    } else {
                      newPrice = currentPrice - (currentPrice * val / 100)
                    }
                    newPrice = Math.max(0, newPrice)
                    return (
                      <div key={item.id} className="flex justify-between text-xs text-fg-3">
                        <span className="truncate flex-1">{item.name}</span>
                        <span className="text-fg-subtle line-through mx-1">{Math.round(currentPrice)}</span>
                        <span className="text-success-fg font-bold">{Math.round(newPrice)}</span>
                      </div>
                    )
                  })}
                  {previewItems.length > 5 && <p className="text-[10px] text-fg-subtle">+{previewItems.length - 5} more...</p>}
                </div>
              )
            })()}

            <div className="flex gap-3">
              <button onClick={applyBrandDiscount} className="flex-1 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition">
                {brandDiscountMode === 'cart_only' ? '✅ Apply to Cart' : 'Apply & Add All'}
              </button>
              <button onClick={() => setShowBrandDiscount(false)} className="flex-1 py-2 bg-surface-3 hover:bg-surface-4 text-fg-2 rounded-lg transition">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Modal */}
      {lastReceipt && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-sm">
            <div className="text-center mb-4">
              <div className="text-4xl mb-1">✅</div>
              <h2 className="text-xl font-bold text-fg">Sale Complete!</h2>
              <p className="text-fg-muted text-sm">{lastReceipt.paymentType === 'credit' ? '📒 Credit sale' : '💵 Cash sale'}</p>
              {form.logo_url && (
                <div className="mt-2 flex justify-center">
                  <img src={form.logo_url} alt="Logo Preview" className="h-10 object-contain opacity-50 sepia-[.5]" />
                </div>
              )}
              {lastReceipt.changeDue > 0 && (
                <div className="bg-gradient-to-r from-success via-success to-success-hover text-white rounded-2xl p-3.5 text-center shadow-xl my-3 border-2 border-success-edge transform transition">
                  <p className="text-[11px] uppercase font-black tracking-widest text-white/80">🟢 WAPIS KAREIN (CHANGE DUE)</p>
                  <p className="text-3xl font-black font-mono mt-1 tracking-tight">Rs. {lastReceipt.changeDue.toFixed(0)}</p>
                  <div className="flex justify-center gap-3 text-[10px] text-white/80 mt-1 font-semibold pt-1 border-t border-success/50">
                    <span>Paid: Rs. {lastReceipt.receivedAmount}</span>
                    <span>•</span>
                    <span>Total: Rs. {lastReceipt.total.toFixed(0)}</span>
                  </div>
                </div>
              )}
            </div>
            <div className="bg-surface-2 rounded-lg p-3 mb-4 text-sm space-y-1">
              {lastReceipt.items.map(i => (
                <div key={i.id} className="flex justify-between text-xs">
                  <span>{i.name} × {i.qty} @ Rs.{i.custom_price}</span>
                  <span>Rs. {(i.custom_price * i.qty).toFixed(0)}</span>
                </div>
              ))}
              <div className="border-t pt-1 flex justify-between font-bold">
                <span>Total</span><span>Rs. {lastReceipt.total.toFixed(0)}</span>
              </div>
              {(user.role === 'admin' || user.role === 'manager' || user.role === 'accountant') && (
                <div className={`flex justify-between text-xs ${lastReceipt.totalProfit >= 0 ? 'text-success-fg' : 'text-danger-fg'}`}>
                  <span>Profit</span><span>Rs. {lastReceipt.totalProfit.toFixed(0)}</span>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex gap-3">
                <button onClick={printReceipt} className="flex-1 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition">🖨️ Print</button>
                {lastReceipt.customer?.phone && (
                  <button
                    onClick={async (e) => {
                      const btn = e.currentTarget
                      btn.disabled = true
                      btn.textContent = '⏳ Generating PDF...'
                      try {
                        const phone = lastReceipt.customer.phone.replace(/[^0-9]/g, '')
                        let formattedPhone = phone
                        if (phone.startsWith('03')) formattedPhone = '92' + phone.substring(1)
                        else if (phone.length === 10) formattedPhone = '92' + phone

                        const template = form.wa_bill_template || 'Hello [Name], thank you for shopping at [Shop Name]! Your bill summary for Invoice #[ID] is Rs. [Amount]. Thank you for your business!'
                        const msg = template
                          .replace(/\[Name\]/g, lastReceipt.customer.name || 'Customer')
                          .replace(/\[Amount\]/g, lastReceipt.total.toFixed(0))
                          .replace(/\[Shop Name\]/g, form.name || 'our shop')
                          .replace(/\[ID\]/g, String(lastReceipt.sale.id).slice(-8))

                        const billHtml = buildReceiptHTML(lastReceipt, false)
                        const pdfBlob = await generateBillPDF(billHtml)
                        const invoiceId = String(lastReceipt.sale.id).slice(-8)
                        await shareOrDownloadPDF(pdfBlob, `bill-${invoiceId}.pdf`, formattedPhone, msg)
                      } catch (err) {
                        console.error('PDF share failed:', err)
                        alert('PDF nahi ban saka. WhatsApp text message bheja ja raha hai.')
                        const phone = lastReceipt.customer.phone.replace(/[^0-9]/g, '')
                        let formattedPhone = phone
                        if (phone.startsWith('03')) formattedPhone = '92' + phone.substring(1)
                        else if (phone.length === 10) formattedPhone = '92' + phone
                        const msg = `${form.name || 'Shop'} - Bill Rs. ${lastReceipt.total.toFixed(0)}`
                        window.open(`https://wa.me/${formattedPhone}?text=${encodeURIComponent(msg)}`, '_blank')
                      } finally {
                        btn.disabled = false
                        btn.innerHTML = '<span>💬</span> WhatsApp'
                      }
                    }}
                    className="flex-1 py-2 bg-success hover:bg-success-hover text-white rounded-lg font-medium transition flex items-center justify-center gap-2"
                  >
                    <span>💬</span> WhatsApp
                  </button>
                )}
              </div>
              <button onClick={() => setLastReceipt(null)} className="w-full py-2 bg-surface-3 hover:bg-surface-4 text-fg-2 rounded-lg transition font-medium">Close</button>
            </div>
          </div>
        </div>
      )}
      {/* Quotation Search Modal */}
      {showQuotationSearch && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-sm">
            <h2 className="text-xl font-bold text-fg mb-4">Search Quotation</h2>
            <p className="text-sm text-fg-muted mb-4">Quotation number (e.g. QT-abcd1234) enter karein jo bill par likha hai.</p>
            <div className="space-y-4">
              <input
                type="text"
                autoFocus
                placeholder="Last 8 digits or full ID..."
                value={quotationIdInput}
                onChange={e => setQuotationIdInput(e.target.value)}
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-info outline-none"
              />
              <div className="flex gap-3">
                <button
                  onClick={handleSearchQuotation}
                  className="flex-1 py-2 bg-info hover:bg-info-hover text-white font-bold rounded-lg transition"
                >
                  Load to Cart
                </button>
                <button
                  onClick={() => setShowQuotationSearch(false)}
                  className="px-6 py-2 bg-surface-3 hover:bg-surface-4 text-fg-2 font-bold rounded-lg transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Held Carts Modal */}
      {showHeldCarts && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-fg">⏸️ Held Bills</h2>
              <button onClick={() => setShowHeldCarts(false)} className="text-fg-subtle hover:text-fg-3 text-2xl">×</button>
            </div>
            <div className="max-height-[400px] overflow-y-auto space-y-3">
              {heldCarts.map(held => (
                <div key={held.id} className="p-4 border rounded-xl hover:border-primary hover:bg-primary-soft transition cursor-pointer group" onClick={() => handleResumeCart(held)}>
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="font-bold text-fg">{held.customer_name || 'Walk-in Customer'}</p>
                      <p className="text-[10px] text-fg-subtle uppercase font-bold tracking-tighter">
                        Saved: {new Date(held.saved_at).toLocaleTimeString()}
                      </p>
                    </div>
                    <p className="font-black text-primary-fg">Rs. {held.total.toFixed(0)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {held.items.slice(0, 3).map((it, idx) => (
                      <span key={idx} className="text-[10px] bg-surface border px-1.5 py-0.5 rounded text-fg-muted">
                        {it.name} × {it.qty}
                      </span>
                    ))}
                    {held.items.length > 3 && <span className="text-[10px] text-fg-subtle ml-1">+{held.items.length - 3} more</span>}
                  </div>
                  <button className="w-full mt-3 py-1.5 bg-primary text-white rounded-lg text-xs font-bold opacity-0 group-hover:opacity-100 transition">Resume Bill</button>
                </div>
              ))}
              {heldCarts.length === 0 && (
                <div className="text-center py-10 text-fg-subtle italic">No held bills found</div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Split Payment Modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl p-4 sm:p-6 w-full max-w-sm">
            <h2 className="text-xl font-bold text-fg mb-4">🔀 Split Payment</h2>
            <div className="space-y-3 mb-4 max-h-[340px] overflow-y-auto">
              {payments.map((p, idx) => (
                <div key={idx} className="flex flex-col gap-1.5 bg-surface-2 p-2.5 rounded-lg border border-line">
                  <div className="flex gap-2 items-center">
                    <select
                      value={p.method}
                      onChange={(e) => {
                        const newP = [...payments]; newP[idx].method = e.target.value; setPayments(newP)
                      }}
                      className="flex-1 bg-surface border border-line-strong rounded px-2 py-1.5 text-xs font-semibold outline-none focus:border-primary"
                    >
                      <option value="cash">💵 Cash</option>
                      <optgroup label="Mobile Wallets & FinTech">
                        <option value="jazzcash">📱 JazzCash</option>
                        <option value="easypaisa">🟢 Easypaisa</option>
                        <option value="sadapay">💳 SadaPay</option>
                        <option value="nayapay">🟣 NayaPay</option>
                      </optgroup>
                      <optgroup label="Pakistani Banks">
                        <option value="meezan">🏦 Meezan Bank</option>
                        <option value="hbl">🏦 HBL (Habib Bank)</option>
                        <option value="ubl">🏦 UBL (United Bank)</option>
                        <option value="mcb">🏦 MCB Bank</option>
                        <option value="abl">🏦 Allied Bank (ABL)</option>
                        <option value="bank">🏛️ Bank Transfer / Raast</option>
                        <option value="card">💳 Card</option>
                      </optgroup>
                    </select>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={p.amount}
                      onChange={(e) => {
                        const newP = [...payments]; newP[idx].amount = e.target.value; setPayments(newP)
                      }}
                      className="w-24 border border-line-strong rounded px-2 py-1.5 text-xs font-bold text-right"
                      placeholder="Amount"
                    />
                    <button onClick={() => setPayments(payments.filter((_, i) => i !== idx))} className="text-danger-fg font-bold px-1 text-sm hover:bg-danger-soft rounded">✕</button>
                  </div>
                  <input
                    type="text"
                    value={p.ref || ''}
                    onChange={(e) => {
                      const newP = [...payments]; newP[idx].ref = e.target.value; setPayments(newP)
                    }}
                    className="w-full text-[11px] border border-line rounded px-2 py-1 bg-surface outline-none focus:border-primary placeholder:text-fg-subtle"
                    placeholder="TID / Ref # / Account (optional)"
                  />
                </div>
              ))}
            </div>

            <div className="border-t pt-3 space-y-2">
              <div className="flex justify-between text-sm">
                <span>Total Bill:</span><span className="font-bold">Rs. {total.toFixed(0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>Paid So Far:</span><span className="font-bold text-success-fg">Rs. {payments.reduce((s, p) => s + Number(p.amount), 0).toFixed(0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>Remaining:</span>
                <span className={`font-bold ${total - payments.reduce((s, p) => s + Number(p.amount), 0) > 0 ? 'text-danger-fg' : 'text-fg-subtle'}`}>
                  Rs. {(total - payments.reduce((s, p) => s + Number(p.amount), 0)).toFixed(0)}
                </span>
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  const remaining = total - payments.reduce((s, p) => s + Number(p.amount), 0)
                  setPayments([...payments, { method: 'jazzcash', amount: Math.max(0, remaining), ref: '' }])
                }}
                className="flex-1 py-1.5 border border-info-line text-info-fg rounded-lg text-xs font-bold hover:bg-info-soft"
              >
                + Add Payment
              </button>
              <button onClick={() => setShowPaymentModal(false)} className="flex-1 py-1.5 bg-primary text-white rounded-lg text-xs font-bold">Done</button>
            </div>
          </div>
        </div>
      )}
      {/* Quick View Modal */}
      {showQuickView && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl p-6 w-full max-w-4xl flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center mb-4 shrink-0">
              <h2 className="text-xl font-bold text-fg flex items-center gap-2">
                <span>🔍 Cart Quick View</span>
                <span className="text-sm font-normal text-fg-muted">({cart.length} items)</span>
              </h2>
              <button onClick={() => setShowQuickView(false)} className="text-fg-subtle hover:text-fg-3 text-2xl">×</button>
            </div>

            <div className="flex-1 overflow-y-auto mb-4 border rounded-xl">
              <table className="w-full text-left border-collapse">
                <thead className="bg-surface-2 sticky top-0 border-b">
                  <tr>
                    <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase">Product</th>
                    <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase text-center">Price (Rs.)</th>
                    <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase text-center">Quantity</th>
                    <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase text-right">Total (Rs.)</th>
                    <th className="px-4 py-3 text-xs font-bold text-fg-muted uppercase text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-subtle">
                  {cart.map(item => (
                    <tr key={item.id} className="hover:bg-surface-2">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-fg">{item.name}</p>
                        {item.brand && <p className="text-xs text-fg-subtle">{item.brand}</p>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <input type="number" value={item.custom_price} onChange={e => updatePrice(item.id, e.target.value)}
                          className="w-24 px-2 py-1 border rounded text-center font-semibold text-primary-fg focus:ring-1 focus:ring-primary outline-none" />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button onClick={() => updateQty(item.id, Math.max(0.01, item.qty - 1))} className="w-8 h-8 flex items-center justify-center bg-surface-3 rounded-lg hover:bg-surface-4 font-bold">-</button>
                          <input type="number" step="any" min="0.001" value={item.qty} onChange={e => updateQty(item.id, e.target.value)}
                            className="w-20 px-2 py-1 border rounded text-center focus:ring-1 focus:ring-primary outline-none" />
                          <button onClick={() => updateQty(item.id, item.qty + 1)} className="w-8 h-8 flex items-center justify-center bg-surface-3 rounded-lg hover:bg-surface-4 font-bold">+</button>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-fg">
                        {(item.custom_price * item.qty).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button onClick={() => removeFromCart(item.id)} className="text-danger-fg hover:text-danger-strong font-bold p-2">🗑️</button>
                      </td>
                    </tr>
                  ))}
                  {cart.length === 0 && (
                    <tr><td colSpan="5" className="px-4 py-10 text-center text-fg-subtle italic">Cart is empty</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="shrink-0 flex justify-between items-center p-4 bg-surface-2 rounded-xl border border-line-subtle">
              <div className="space-y-1">
                <p className="text-fg-muted text-xs">Subtotal: Rs. {subtotal.toLocaleString()}</p>
                {totalDiscount > 0 && <p className="text-danger-fg text-xs">Discount: - Rs. {totalDiscount.toLocaleString()}</p>}
                <p className="text-2xl font-black text-fg">Total: Rs. {total.toLocaleString()}</p>
              </div>
              <button onClick={() => setShowQuickView(false)} className="px-8 py-3 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl shadow-lg shadow-primary-muted transition">Return to POS</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default POS
