import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { fetchAllRows } from '../services/fetchAll'
import { useAuth } from '../context/AuthContext'
import { db, addToSyncQueue } from '../services/db'
import PasswordModal from '../components/PasswordModal'
import * as XLSX from 'xlsx'
import { buildSalesReportHTML, buildBillHTML } from '../utils/billTemplates'
import { hasFeature } from '../utils/featureGate'
import { printHTML } from '../utils/printUtils'
import { syncOfflineData, getSyncQueueStatus, retryFailedSyncItems } from '../services/syncService'
import { BUSINESS_PRESETS } from '../utils/businessPresets'
import { Store, Tag, Receipt, ShieldCheck, Printer, MessageCircle, Database, BarChart3, CreditCard, AlertTriangle, Palette, KeyRound } from 'lucide-react'
import AppearanceSection from '../components/settings/AppearanceSection'
import CustomerPortalSettings from '../components/CustomerPortalSettings'
import { BRAND } from '../config/brand.js'
import { DEFAULT_BILL_TEMPLATE, DEFAULT_PAYMENT_TEMPLATE, resolveBillTemplate } from '../utils/billMessages'

// Sidebar sections. `form: true` sections share the single profile form and its Save button.
const SETTINGS_SECTIONS = [
  { id: 'profile',  label: 'Shop Profile',      icon: Store,         form: true, desc: 'Name, contact details and logo shown on prints and invoices.' },
  { id: 'business', label: 'Business & Pricing', icon: Tag,          form: true, desc: 'Store type, price fields, tax number and Wholesale Mode.' },
  { id: 'pos',      label: 'POS & Receipts',    icon: Printer,       form: true, desc: 'POS screen layout, receipt footers, invoice prefix, print size and bill template.' },
  { id: 'appearance', label: 'Appearance',     icon: Palette,       desc: 'Light or dark mode and brand colour for this shop. Applies instantly on this device.' },
  { id: 'whatsapp', label: 'WhatsApp',          icon: MessageCircle, form: true, desc: 'Message templates for reminders, bills and supplier reorders.' },
  { id: 'portal',   label: 'Customer Portal',   icon: KeyRound,      desc: 'Let customers see their bills and balance online with their mobile number and PIN.' },
  { id: 'data',     label: 'Data & Backup',     icon: Database,      desc: 'Sync, import, export or back up your store data.' },
  { id: 'reports',  label: 'Sales Reports',     icon: BarChart3,     desc: 'Print a daily, weekly or monthly sales summary.' },
  { id: 'plan',     label: 'Plan & Updates',    icon: CreditCard,    desc: 'Your subscription tier, limits and software version.' },
  { id: 'danger',   label: 'Danger Zone',       icon: AlertTriangle, desc: 'Irreversible actions — proceed with extreme caution.' },
]
const SECTION_IDS = SETTINGS_SECTIONS.map(x => x.id)
// Hides the top divider of the first block in a section so each section starts cleanly
const SECTION_GROUP = 'space-y-4 [&>*:first-child]:border-t-0 [&>*:first-child]:pt-0'

function Settings() {
  const { user } = useAuth()
  const [shop, setShop] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeSection, setActiveSection] = useState(() => {
    const h = (typeof window !== 'undefined' ? window.location.hash : '').replace('#', '')
    return SECTION_IDS.includes(h) ? h : 'profile'
  })
  const currentSection = SETTINGS_SECTIONS.find(x => x.id === activeSection) || SETTINGS_SECTIONS[0]
  const goToSection = (id) => {
    setActiveSection(id)
    try { window.history.replaceState(null, '', `#${id}`) } catch { /* ignore */ }
    document.querySelector('main')?.scrollTo?.({ top: 0, behavior: 'smooth' })
  }
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
      logo_url: (sid ? localStorage.getItem(`shop_logo_${sid}`) : null) || '',
      invoice_footer: 'شکریہ! دوبارہ تشریف لائیں',
      quotation_footer: 'یہ صرف قیمت نامہ ہے',
      print_size: 'thermal',
      print_mode: 'manual',
      wa_reminder_template: 'Hello [Name], this is a reminder from [Shop Name] regarding your outstanding balance of Rs. [Amount]. Please clear your dues at your earliest convenience. Thank you!',
      wa_bill_template: 'Hello [Name], thank you for shopping at [Shop Name]! Your bill summary for Invoice #[ID] is Rs. [Amount]. Thank you for your business!',
      wa_reorder_template: 'Assalam-o-Alaikum *[Supplier Name]*! 🙏\n\n*[Shop Name]* se order:\n\n[Items]\n\nMeharbani farma kar jald supply karein. Shukriya!',
      wa_payment_template: DEFAULT_PAYMENT_TEMPLATE,
      invoice_prefix: '',
      business_preset: 'general',
      pricing_mode: 'hidden',
      custom_price_label: '',
      wholesale_enabled: false,
      tax_number: '',
      pos_layout: 'two_stage'
    }
  })
  // Logo is managed completely separately from the rest of form state
  // LOGO_KEY is stable once user.shop_id is known
  const LOGO_KEY = `shop_logo_${user?.shop_id}`
  const [logoUrl, setLogoUrl] = useState(() => {
    const sid = user?.shop_id
    return (sid ? localStorage.getItem(`shop_logo_${sid}`) : null) || ''
  })

  // Re-read logo from localStorage whenever user.shop_id becomes available
  // (handles any edge case where it wasn't ready on first render)
  useEffect(() => {
    if (!user?.shop_id) return
    const saved = localStorage.getItem(`shop_logo_${user.shop_id}`)
    if (saved) setLogoUrl(saved)
  }, [user?.shop_id])

  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [syncStatus, setSyncStatus] = useState({ pending: 0, failed: 0, failedItems: [] })
  const refreshSyncStatus = async () => {
    try { setSyncStatus(await getSyncQueueStatus()) } catch { /* local DB unavailable */ }
  }
  useEffect(() => {
    refreshSyncStatus()
    window.addEventListener('sync_completed', refreshSyncStatus)
    return () => window.removeEventListener('sync_completed', refreshSyncStatus)
  }, [])
  const [planInfo, setPlanInfo] = useState(null)
  const [printTemplate, setPrintTemplate] = useState(() => {
    const sid = user?.shop_id
    return (sid ? localStorage.getItem(`print_template_${sid}`) : null) || localStorage.getItem('print_template') || '2'
  })
  const [reportPeriod, setReportPeriod] = useState('today')
  const [reportLoading, setReportLoading] = useState(false)
  const [previewTemplateId, setPreviewTemplateId] = useState(null)
  const [previewSize, setPreviewSize] = useState('thermal')

  const getDummyItems = (presetId) => {
    switch (presetId) {
      case 'grocery':
        return [
          { name: 'Nestlé Milk 1L TetraPak', brand: 'Nestlé', qty: 3, custom_price: 290, sku: 'GROC-MLK-1L' },
          { name: 'Super Basmati Rice 5kg', brand: 'Guard', qty: 1, custom_price: 1850, sku: 'GROC-RICE-5K' },
          { name: 'Cooking Oil 1L Pouch', brand: 'Dalda', qty: 2, custom_price: 540, sku: 'GROC-OIL-1L' }
        ]
      case 'apparel':
        return [
          { name: 'Cotton Polo T-Shirt Navy (L)', brand: 'Polo', qty: 1, custom_price: 2450, sku: 'APP-POLO-NV-L' },
          { name: 'Slim Fit Denim Jeans 32', brand: "Levi's", qty: 1, custom_price: 3800, sku: 'APP-JNS-BLU-32' },
          { name: 'Casual Sports Socks (Pair)', brand: 'Nike', qty: 3, custom_price: 250, sku: 'APP-SOX-01' }
        ]
      case 'pharmacy':
        return [
          { name: 'Panadol Extra 500mg (Strip)', brand: 'GSK', qty: 5, custom_price: 45, sku: 'MED-PAN-EXT' },
          { name: 'Augmentin 625mg Tablets', brand: 'GSK', qty: 1, custom_price: 340, sku: 'MED-AUG-625' },
          { name: 'Surgical Face Mask (Pack 50)', brand: 'Pharmatec', qty: 1, custom_price: 450, sku: 'MED-MSK-50' }
        ]
      case 'electronics':
        return [
          { name: 'Fast Charger 65W GaN Type-C', brand: 'Anker', qty: 1, custom_price: 3200, sku: 'ELEC-CHG-65W' },
          { name: 'True Wireless Earbuds Pro', brand: 'Xiaomi', qty: 1, custom_price: 4500, sku: 'ELEC-TWS-PRO' },
          { name: 'Braided USB-C Cable 2m', brand: 'Baseus', qty: 2, custom_price: 650, sku: 'ELEC-CAB-2M' }
        ]
      case 'hardware':
        return [
          { name: 'Single Lever Basin Mixer', brand: 'Master', qty: 1, custom_price: 6500, sku: 'SAN-MIX-01' },
          { name: 'PPRC Elbow 25mm Brass', brand: 'Popular', qty: 6, custom_price: 220, sku: 'PIP-ELB-25' },
          { name: 'CP Waste Coupling 1.25" Brass', brand: 'Local', qty: 2, custom_price: 450, sku: 'CP-WST-125' }
        ]
      default: // general
        return [
          { name: 'Wireless Optical Mouse 2.4G', brand: 'Logitech', qty: 1, custom_price: 1850, sku: 'RET-MOU-01' },
          { name: 'Executive Hardcover Notebook A5', brand: 'Deli', qty: 2, custom_price: 450, sku: 'RET-NTB-A5' },
          { name: 'Ballpoint Pen Box (Pack of 10)', brand: 'Piano', qty: 1, custom_price: 300, sku: 'RET-PEN-10' }
        ]
    }
  }

  const dummyItems = getDummyItems(form.business_preset)
  const dummySubtotal = dummyItems.reduce((acc, i) => acc + (i.custom_price * i.qty), 0)
  const dummyDiscount = 200
  const dummyTotal = dummySubtotal - dummyDiscount

  const dummyInvoiceData = {
    sale: {
      id: 87654321,
      created_at: new Date().toISOString(),
      created_by: user?.username || 'Staff Cashier',
      payment_type: 'cash',
      paid_amount: dummyTotal,
    },
    items: dummyItems,
    customer: {
      name: 'Ahmed Tariq',
      phone: '0300-1234567'
    },
    total: dummyTotal,
    subtotal: dummySubtotal,
    totalDiscount: dummyDiscount,
    change: 0
  }

  const getPreviewHTML = (templateId, size) => {
    const tempSettings = {
      name: form.name || `${BRAND.appName} Demo`,
      address: form.address || '123 Main Bazaar',
      phone: form.phone || BRAND.supportPhone,
      logo_url: form.logo_url || '',
      invoice_footer: form.invoice_footer || 'شکریہ! دوبارہ تشریف لائیں',
      quotation_footer: form.quotation_footer || 'یہ صرف قیمت نامہ ہے',
      invoice_prefix: form.invoice_prefix || 'INV',
      print_size: size,
      print_template: templateId,
      shop_id: user?.shop_id
    }
    
    let html = buildBillHTML(dummyInvoiceData, false, tempSettings)
    
    // Strip print scripts to prevent triggering browser print dialog in preview iframe
    html = html.replace(/<script>[\s\S]*?<\/script>/gi, '')
    
    return html
  }

  useEffect(() => {
    fetchShop()
    fetchPlanInfo()
  }, [])

  const fetchShop = async () => {
    try {
      if (!navigator.onLine) throw new Error('Offline')
      // Ensure shop_id is a number for the query
      const sid = Number(user.shop_id)
      const fetchPromise = supabase.from('shops').select('*').eq('id', sid).maybeSingle()
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
      const { data, error } = await Promise.race([fetchPromise, timeoutPromise])
      if (error) throw error

      if (data) {
        setShop(data)
        setSettingsForm(data)
        // Store in local DB for offline access
        await db.shops.put(JSON.parse(JSON.stringify(data)))
      }
    } catch (e) {
      console.log('Settings: Loading from local DB (Offline)')
      try {
        const sid = Number(user.shop_id)
        const localData = await db.shops.get(sid)
        if (localData) {
          setShop(localData)
          setSettingsForm(localData)
        }
      } catch (err) { console.error('Local Shop Fetch Error:', err) }
    } finally {
      setLoading(false)
    }
  }

  const setSettingsForm = (data) => {
    // Read the full saved settings from localStorage — this is what the user last saved.
    let saved = {}
    const sid = user?.shop_id
    try { saved = JSON.parse((sid ? localStorage.getItem(`shop_settings_${sid}`) : null) || '{}') } catch (_) {}

    setForm(prev => {
      const updated = {
        name:                 data.name                 || saved.name                 || prev.name                 || BRAND.appName,
        phone:                data.phone                || saved.phone                || prev.phone                || '',
        address:              data.address              || saved.address              || prev.address              || '',
        logo_url:             data.logo_url             || saved.logo_url             || prev.logo_url             || '',
        invoice_footer:       data.invoice_footer       || saved.invoice_footer       || prev.invoice_footer       || 'شکریہ! دوبارہ تشریف لائیں',
        quotation_footer:     data.quotation_footer     || saved.quotation_footer     || prev.quotation_footer     || 'یہ صرف قیمت نامہ ہے',
        print_size:           data.print_size           || saved.print_size           || prev.print_size           || 'thermal',
        print_mode:           data.print_mode           || saved.print_mode           || prev.print_mode           || 'manual',
        wa_reminder_template: data.wa_reminder_template || saved.wa_reminder_template || prev.wa_reminder_template || '',
        wa_bill_template:     resolveBillTemplate(data.wa_bill_template || saved.wa_bill_template || prev.wa_bill_template),
        wa_reorder_template:  data.wa_reorder_template  || saved.wa_reorder_template  || prev.wa_reorder_template  || '',
        wa_payment_template:  data.wa_payment_template  || saved.wa_payment_template  || prev.wa_payment_template  || DEFAULT_PAYMENT_TEMPLATE,
        invoice_prefix:       data.invoice_prefix       || saved.invoice_prefix       || prev.invoice_prefix       || '',
        business_preset:      data.business_preset      || saved.business_preset      || prev.business_preset      || 'general',
        pricing_mode:         data.pricing_mode         || saved.pricing_mode         || prev.pricing_mode         || 'hidden',
        custom_price_label:   data.custom_price_label   || saved.custom_price_label   || prev.custom_price_label   || '',
        tax_number:           data.tax_number           || saved.tax_number           || prev.tax_number           || '',
        wholesale_enabled:    typeof data.wholesale_enabled === 'boolean' ? data.wholesale_enabled : (saved.wholesale_enabled ?? prev.wholesale_enabled ?? false),
        // Appearance is a local, per-shop preference (not stored in the shops table) — keep it.
        theme_mode:           saved.theme_mode   || prev.theme_mode,
        theme_accent:         saved.theme_accent || prev.theme_accent,
      }

      // Sync immediately to localStorage to ensure consistent branding/printing across pages
      if (sid) {
        const fullSettings = { ...updated, print_template: data.print_template || saved.print_template || localStorage.getItem(`print_template_${sid}`) || '2' }
        localStorage.setItem(`shop_settings_${sid}`, JSON.stringify(fullSettings))
        localStorage.setItem(`shop_name_${sid}`, updated.name)
        if (updated.logo_url) {
          localStorage.setItem(`shop_logo_${sid}`, updated.logo_url)
        }
      }
      return updated
    })

    const tmpl = data.print_template || saved.print_template || (sid ? localStorage.getItem(`print_template_${sid}`) : null) || '2'
    setPrintTemplate(tmpl)
    if (sid) {
      localStorage.setItem(`print_template_${sid}`, tmpl)
    }

    const logo = data.logo_url || saved.logo_url || (sid ? localStorage.getItem(`shop_logo_${sid}`) : null) || ''
    setLogoUrl(logo)
    if (sid && logo) {
      localStorage.setItem(`shop_logo_${sid}`, logo)
    }
  }

  const fetchPlanInfo = async () => {
    const sid = user?.shop_id
    // Try localStorage first for instant info
    const cached = sid ? localStorage.getItem(`plan_limits_${sid}`) : null
    if (cached) {
      try {
        setPlanInfo(JSON.parse(cached))
      } catch (e) { /* ignore */ }
    }

    if (!navigator.onLine || !sid) return
    try {
      const { data, error } = await supabase.rpc('get_shop_config', { p_shop_id: sid })
      if (!error && data) {
        setPlanInfo(data)
        localStorage.setItem(`plan_limits_${sid}`, JSON.stringify(data))
        if (data.features) {
          localStorage.setItem(`plan_features_${sid}`, JSON.stringify(data.features))
        }
      }
    } catch (e) {
      console.error('Settings Plan Fetch Error', e)
    }
  }

  const handleUpdate = async (e) => {
    e.preventDefault()
    if (!String(form.name || '').trim()) {
      goToSection('profile')
      alert('Store / Shop Name is required')
      return
    }
    setSaving(true)

    const sid = Number(user.shop_id)

    // Merge latest logo and print template into full settings for localStorage / bill printing
    const fullSettings = { ...form, logo_url: logoUrl, print_template: printTemplate }

    // Save everything to localStorage immediately — this is the source of truth
    // for print preferences, WA templates, footers, print size etc.
    localStorage.setItem(`shop_settings_${sid}`, JSON.stringify(fullSettings))
    localStorage.setItem(`shop_name_${sid}`, form.name || BRAND.appName)

    // Send all columns that exist in the shops table to Supabase.
    const supabasePayload = {
      name: form.name,
      phone: form.phone,
      address: form.address,
      invoice_footer: form.invoice_footer,
      quotation_footer: form.quotation_footer,
      print_size: form.print_size,
      print_mode: form.print_mode,
      print_template: printTemplate,
      wa_reminder_template: form.wa_reminder_template,
      wa_bill_template: form.wa_bill_template,
      wa_reorder_template: form.wa_reorder_template,
      // wa_payment_template is saved online only (via the RPC below): an offline
      // queued UPDATE with a column an older database lacks would be dropped.
      invoice_prefix: form.invoice_prefix,
    }

    try {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')

      // Use RPC to bypass RLS (direct table UPDATE is silently blocked)
      const baseParams = {
        p_shop_id: sid,
        p_name: form.name,
        p_phone: form.phone,
        p_address: form.address,
        p_invoice_footer: form.invoice_footer,
        p_quotation_footer: form.quotation_footer,
        p_print_size: form.print_size,
        p_print_mode: form.print_mode,
        p_print_template: printTemplate,
        p_wa_reminder_template: form.wa_reminder_template,
        p_wa_bill_template: form.wa_bill_template,
        p_wa_reorder_template: form.wa_reorder_template,
        p_invoice_prefix: form.invoice_prefix,
      }
      const pricingParams = {
        p_business_preset: form.business_preset || null,
        p_pricing_mode: form.pricing_mode || null,
        p_custom_price_label: form.custom_price_label || null,
        p_wholesale_enabled: !!form.wholesale_enabled,
      }
      let { data: rpcResult, error } = await supabase.rpc('update_shop_settings', { ...baseParams, ...pricingParams, p_wa_payment_template: form.wa_payment_template || null })
      // Backward compatibility: PostgREST returns PGRST202 when no function matches
      // the named params. Older databases: no payment template
      // (sql/bill_payments_migration.sql), then no pricing (sql/wholesale_mode_migration.sql).
      if (error && error.code === 'PGRST202') {
        console.warn('update_shop_settings: payment template not supported yet — run sql/bill_payments_migration.sql')
        ;({ data: rpcResult, error } = await supabase.rpc('update_shop_settings', { ...baseParams, ...pricingParams }))
      }
      if (error && error.code === 'PGRST202') {
        console.warn('update_shop_settings: pricing params not supported yet — run sql/wholesale_mode_migration.sql')
        ;({ data: rpcResult, error } = await supabase.rpc('update_shop_settings', baseParams))
        if (!error && form.wholesale_enabled) {
          // Wholesale needs the new DB columns (sales.price_tier, products.wholesale_price) — keep it off until migrated.
          const safeSettings = { ...fullSettings, wholesale_enabled: false }
          localStorage.setItem(`shop_settings_${sid}`, JSON.stringify(safeSettings))
          setForm(prev => ({ ...prev, wholesale_enabled: false }))
          alert('Wholesale Mode needs a database update first (sql/wholesale_mode_migration.sql). Other settings were saved.')
          await db.shops.put({ ...safeSettings, id: sid })
          window.dispatchEvent(new Event('storage'))
          return
        }
      }
      if (error) throw error
      if (rpcResult && !rpcResult.success) throw new Error(rpcResult.error || 'Update failed')

      // Also persist full settings to Dexie for offline reads
      await db.shops.put({ ...fullSettings, id: sid })

      window.dispatchEvent(new Event('storage'))
      alert('Settings saved successfully! ✅')
    } catch (err) {
      const errMsg = err?.message || String(err)
      if (errMsg.includes('Failed to fetch') || !navigator.onLine) {
        await db.shops.put({ ...fullSettings, id: sid })
        await addToSyncQueue('shops', 'UPDATE', { id: sid, ...supabasePayload })
        window.dispatchEvent(new Event('storage'))
        alert('Offline mode: Settings saved to device. Will sync when online. 🔄')
      } else {
        alert('Save failed: ' + errMsg)
      }
    } finally {
      setSaving(false)
    }
  }

  // Compress image using canvas — reduces a 2MB photo to ~15-30KB
  const compressImage = (file) => {
    return new Promise((resolve) => {
      const img = new Image()
      const objectUrl = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(objectUrl)
        const MAX = 300
        let w = img.width
        let h = img.height
        // Scale down proportionally
        if (w > h && w > MAX) { h = Math.round(h * MAX / w); w = MAX }
        else if (h > MAX) { w = Math.round(w * MAX / h); h = MAX }
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        // JPEG at 75% quality — typically 10-30KB for a logo
        resolve(canvas.toDataURL('image/jpeg', 0.75))
      }
      img.onerror = () => {
        // Fallback: read as-is if canvas fails
        const reader = new FileReader()
        reader.onload = evt => resolve(evt.target.result)
        reader.readAsDataURL(file)
      }
      img.src = objectUrl
    })
  }

  const handleLogoUpload = async (e) => {
    const sid = Number(user.shop_id)
    const file = e.target.files[0]
    if (!file) return

    setSaving(true)
    try {
      const compressed = await compressImage(file)

      // 1. Update dedicated logo state immediately — this is the single source of truth
      setLogoUrl(compressed)
      localStorage.setItem(`shop_logo_${sid}`, compressed)   // shop-specific key

      // 2. Keep form.logo_url in sync so bill printing works
      // Use functional updater but write localStorage AFTER setForm to avoid race
      const updatedForm = { ...form, logo_url: compressed }
      setForm(updatedForm)
      localStorage.setItem(`shop_settings_${sid}`, JSON.stringify(updatedForm))

      // 3. Save to Dexie
      try { await db.shops.update(sid, { logo_url: compressed }) } catch (_) { /* ignore */ }

      // 4. Notify Layout (and any other listener) to refresh logo immediately
      window.dispatchEvent(new Event('storage'))

      // 5. Save to Supabase via RPC — required so logo shows on other devices
      if (navigator.onLine) {
        const { data: rpcResult, error } = await supabase.rpc('update_shop_settings', {
          p_shop_id: sid,
          p_logo_url: compressed,
        })
        if (error || (rpcResult && !rpcResult.success)) {
          const msg = error?.message || rpcResult?.error || 'Unknown error'
          console.warn('Logo Supabase save failed:', msg)
          alert('Logo saved on this device ✅\n⚠️ Could not sync to server: ' + msg + '\nLogo will not show on other devices until synced.')
        } else {
          alert('Logo saved & synced to server ✅')
        }
      } else {
        alert('Logo saved on this device ✅\n(Offline — will sync when connected)')
      }
    } catch (err) {
      console.error('Logo upload error:', err)
      alert('Logo upload failed: ' + (err?.message || String(err)))
    } finally {
      setSaving(false)
    }
  }

  const printSalesReport = async () => {
    setReportLoading(true)
    try {
      const now = new Date()
      let fromDate
      if (reportPeriod === 'today') {
        fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      } else if (reportPeriod === 'week') {
        const d = new Date(now); d.setDate(d.getDate() - 6); d.setHours(0,0,0,0)
        fromDate = d.toISOString()
      } else {
        const d = new Date(now.getFullYear(), now.getMonth(), 1)
        fromDate = d.toISOString()
      }

      let sales = [], saleItems = []
      if (navigator.onLine) {
        const { data: s } = await supabase.from('sales').select('*').eq('shop_id', user.shop_id).gte('created_at', fromDate).order('created_at', { ascending: false })
        sales = s || []
        if (sales.length > 0) {
          const ids = sales.map(s => s.id)
          const { data: si } = await supabase.from('sale_items').select('*').in('sale_id', ids)
          saleItems = si || []
        }
      } else {
        sales = await db.sales.where('shop_id').equals(user.shop_id).filter(s => s.created_at >= fromDate).toArray()
        const ids = sales.map(s => s.id)
        saleItems = await db.sale_items.where('sale_id').anyOf(ids).toArray()
      }

      if (sales.length === 0) {
        alert('No sales found for the selected period.')
        return
      }

      const shopSettings = { ...form, print_template: printTemplate }
      printHTML(buildSalesReportHTML(sales, saleItems, reportPeriod, shopSettings))
    } catch (err) {
      alert('Report failed: ' + err.message)
    } finally {
      setReportLoading(false)
    }
  }

  if (loading) return <div className="p-8">Loading settings...</div>

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl font-bold text-fg">⚙️ Settings</h1>
        <span className="px-2 py-1 bg-surface-3 text-fg-subtle text-[10px] font-bold uppercase rounded tracking-widest italic tracking-tighter">Shop ID: {user.shop_id}</span>
      </div>


      <div className="flex flex-col md:flex-row gap-6 items-start">
        {/* Section navigation: horizontal chips on phones, sticky sidebar on md+ */}
        <nav aria-label="Settings sections" className="w-full md:w-56 shrink-0 md:sticky md:top-0">
          <ul className="flex md:flex-col gap-1.5 overflow-x-auto md:overflow-visible pb-1 md:pb-0 bg-surface md:p-2 md:rounded-2xl md:border md:border-line-subtle md:shadow-sm">
            {SETTINGS_SECTIONS.map(sec => {
              const Icon = sec.icon
              const active = sec.id === activeSection
              const danger = sec.id === 'danger'
              return (
                <li key={sec.id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => goToSection(sec.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary border md:border-0 ${
                      active
                        ? (danger ? 'bg-danger-soft text-danger-strong border-danger-line' : 'bg-primary-soft text-primary-strong border-primary-line')
                        : (danger ? 'text-danger-fg hover:bg-danger-soft border-line' : 'text-fg-3 hover:bg-surface-2 hover:text-fg border-line')
                    }`}
                  >
                    <Icon size={17} className="shrink-0" aria-hidden="true" />
                    <span>{sec.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="flex-1 min-w-0 w-full space-y-6">
      {currentSection.form && (
      <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle">
        <div className="bg-surface-2 px-6 py-4 border-b rounded-t-2xl">
          <h2 className="font-bold text-fg-2">{currentSection.label}</h2>
          <p className="text-xs text-fg-subtle">{currentSection.desc}</p>
        </div>

        <form onSubmit={handleUpdate} className="p-6 space-y-4">
          {activeSection === 'profile' && (
          <div className={SECTION_GROUP}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-bold text-fg-3 mb-1">Store / Shop Name</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none text-lg font-medium"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-bold text-fg-3 mb-1">Store Logo</label>
              <div className="flex gap-4 items-center">
                {/* Preview — reads from logoUrl state, never from form */}
                <div className="w-16 h-16 rounded-xl border-2 border-dashed border-line bg-surface-2 flex items-center justify-center overflow-hidden flex-shrink-0">
                  {logoUrl
                    ? <img src={logoUrl} alt="Logo" className="max-w-full max-h-full object-contain" />
                    : <span className="text-2xl">🏪</span>
                  }
                </div>
                <div className="flex flex-col gap-2">
                  <input
                    type="file"
                    id="logo-upload"
                    accept="image/*"
                    className="hidden"
                    onChange={handleLogoUpload}
                  />
                  <label
                    htmlFor="logo-upload"
                    className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-bold cursor-pointer transition shadow-sm"
                  >
                    {saving ? '⏳ Saving...' : '📁 Upload New Logo'}
                  </label>
                  {logoUrl && (
                    <button
                      type="button"
                      onClick={async () => {
                        const sid = Number(user.shop_id)
                        setLogoUrl('')
                        localStorage.removeItem(`shop_logo_${sid}`)
                        const updatedForm = { ...form, logo_url: '' }
                        setForm(updatedForm)
                        localStorage.setItem(`shop_settings_${sid}`, JSON.stringify(updatedForm))
                        window.dispatchEvent(new Event('storage'))
                        try { await db.shops.update(sid, { logo_url: '' }) } catch (_) { /* ignore */ }
                        if (navigator.onLine) {
                          supabase.rpc('update_shop_settings', { p_shop_id: sid, p_logo_url: '' }).then(() => {})
                        }
                      }}
                      className="text-xs text-danger-fg hover:text-danger-strong font-bold text-left"
                    >
                      ✕ Remove Logo
                    </button>
                  )}
                  <p className="text-[10px] text-fg-subtle leading-relaxed">JPG, PNG, or SVG. Saved automatically on select.</p>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold text-fg-3 mb-1">Contact Phone</label>
              <input
                type="text"
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none"
                placeholder="e.g. 0300-1234567"
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-fg-3 mb-1">Location / City</label>
              <input
                type="text"
                value={form.address}
                onChange={e => setForm({ ...form, address: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none"
                placeholder="e.g. Lahore, Pakistan"
              />
            </div>
          </div>

          </div>
          )}

          {activeSection === 'business' && (
          <div className={SECTION_GROUP}>
          {/* Industry Preset & Business Type */}
          <div className="pt-5 border-t">
            <div className="flex items-center gap-2 mb-1.5">
              <Store size={18} className="text-primary-fg" />
              <h3 className="text-sm font-black text-fg uppercase tracking-wider">Business Type & Store Domain</h3>
            </div>
            <p className="text-xs text-fg-muted mb-4">
              Selecting your store type tailors item placeholders, default units, and suggested pricing structures across the system.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {BUSINESS_PRESETS.map((preset) => {
                const isSelected = form.business_preset === preset.id
                return (
                  <div
                    key={preset.id}
                    onClick={() => {
                      setForm(prev => ({
                        ...prev,
                        business_preset: preset.id,
                        pricing_mode: prev.pricing_mode === 'c_rate' && preset.id !== 'hardware' ? 'mrp' : prev.pricing_mode
                      }))
                    }}
                    className={`p-3.5 rounded-xl border-2 cursor-pointer transition flex flex-col justify-between ${
                      isSelected
                        ? 'border-primary bg-primary-soft/50 shadow-sm'
                        : 'border-line hover:border-line-strong bg-surface'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-black text-sm text-fg">{preset.name}</span>
                        {isSelected && <span className="text-xs text-primary-fg font-black">✓ Active</span>}
                      </div>
                      <p className="text-[11px] text-fg-muted leading-snug">{preset.description}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Pricing Model & Terminology Configuration */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-5 border-t">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Tag size={16} className="text-primary-fg" />
                <label className="block text-sm font-bold text-fg-2">Secondary / Catalog Price Field</label>
              </div>
              <select
                value={form.pricing_mode}
                onChange={e => setForm({ ...form, pricing_mode: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none bg-surface font-semibold text-sm"
              >
                <option value="hidden">Standard Retail (Only Cost & Sale Price)</option>
                <option value="mrp">MRP / Printed List Price (Recommended for Grocery / Pharmacy / Mart)</option>
                <option value="c_rate">Company Rate (C.Rate) with Discount Matrix (Hardware / Sanitary)</option>
                <option value="custom">Custom Tag / Wholesale Price Label</option>
              </select>
              <p className="text-[11px] text-fg-subtle mt-1">
                Controls whether a catalog rate/MRP column is visible in Products, Inventory, and POS.
              </p>
            </div>

            {form.pricing_mode === 'custom' && (
              <div>
                <label className="block text-sm font-bold text-fg-2 mb-1">Custom Price Label Name</label>
                <input
                  type="text"
                  value={form.custom_price_label}
                  onChange={e => setForm({ ...form, custom_price_label: e.target.value })}
                  placeholder="e.g. Tag Price / MSRP / Distributor Price"
                  className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none text-sm"
                />
              </div>
            )}

            <div>
              <div className="flex items-center gap-2 mb-1">
                <Receipt size={16} className="text-primary-fg" />
                <label className="block text-sm font-bold text-fg-2">Tax / NTN / STRN No. (Optional)</label>
              </div>
              <input
                type="text"
                value={form.tax_number}
                onChange={e => setForm({ ...form, tax_number: e.target.value })}
                placeholder="e.g. NTN: 1234567-8 or STRN / GST No."
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none text-sm"
              />
              <p className="text-[11px] text-fg-subtle mt-1">Printed at the top of customer receipts & invoices</p>
            </div>
          </div>

          {/* Wholesale Mode (opt-in per shop, plan must allow it) */}
          {hasFeature('wholesale') && (
            <div className="pt-5 border-t">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!form.wholesale_enabled}
                  onChange={e => setForm(prev => ({ ...prev, wholesale_enabled: e.target.checked }))}
                  className="mt-1 h-5 w-5 rounded border-line-strong text-wholesale-fg focus:ring-2 focus:ring-wholesale"
                />
                <span>
                  <span className="block text-sm font-black text-fg uppercase tracking-wider">Wholesale Mode</span>
                  <span className="block text-xs text-fg-muted mt-0.5">
                    Adds a Wholesale Price to products, a one-click Retail ⇄ Wholesale switch on POS (F8),
                    and a Retail/Wholesale type on customers. Each sale records which price tier was used.
                  </span>
                </span>
              </label>
            </div>
          )}

          </div>
          )}

          {activeSection === 'pos' && (
          <div className={SECTION_GROUP}>
          {/* POS Layout Preference */}
          <div className="pt-5 border-t">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-lg">🖥️</span>
              <h3 className="text-sm font-black text-fg uppercase tracking-wider">POS Screen & Checkout Layout</h3>
            </div>
            <p className="text-xs text-fg-muted mb-3">
              Choose how the product cart and checkout controls are arranged on your POS register screen.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div
                onClick={() => setForm(prev => ({ ...prev, pos_layout: 'two_stage' }))}
                className={`p-3.5 rounded-xl border-2 cursor-pointer transition flex flex-col justify-between ${
                  (form.pos_layout || 'two_stage') === 'two_stage'
                    ? 'border-primary bg-primary-soft/50 shadow-sm'
                    : 'border-line hover:border-line-strong bg-surface'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-black text-sm text-fg">⚡ Two-Stage Flow</span>
                    {(form.pos_layout || 'two_stage') === 'two_stage' && (
                      <span className="text-xs text-primary-fg font-black">✓ Active</span>
                    )}
                  </div>
                  <p className="text-[11px] text-fg-muted leading-snug">
                    <strong className="text-fg-2">Shopify / Square style:</strong> Maximum vertical space for cart list (~15 items visible). Tapping "Charge (F4)" opens a slide-up tender sheet with quick cash note chips and online wallets.
                  </p>
                </div>
              </div>

              <div
                onClick={() => setForm(prev => ({ ...prev, pos_layout: 'bottom_dock' }))}
                className={`p-3.5 rounded-xl border-2 cursor-pointer transition flex flex-col justify-between ${
                  form.pos_layout === 'bottom_dock'
                    ? 'border-primary bg-primary-soft/50 shadow-sm'
                    : 'border-line hover:border-line-strong bg-surface'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-black text-sm text-fg">🖥️ Global Bottom Dock</span>
                    {form.pos_layout === 'bottom_dock' && (
                      <span className="text-xs text-primary-fg font-black">✓ Active</span>
                    )}
                  </div>
                  <p className="text-[11px] text-fg-muted leading-snug">
                    <strong className="text-fg-2">Supermarket / Register style:</strong> Tendered input, cash chips, and payment buttons span horizontally at the bottom of the screen. Right cart list is 100% full height.
                  </p>
                </div>
              </div>

              <div
                onClick={() => setForm(prev => ({ ...prev, pos_layout: 'compact_dock' }))}
                className={`p-3.5 rounded-xl border-2 cursor-pointer transition flex flex-col justify-between ${
                  form.pos_layout === 'compact_dock'
                    ? 'border-primary bg-primary-soft/50 shadow-sm'
                    : 'border-line hover:border-line-strong bg-surface'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-black text-sm text-fg">📱 Compact Sidebar</span>
                    {form.pos_layout === 'compact_dock' && (
                      <span className="text-xs text-primary-fg font-black">✓ Active</span>
                    )}
                  </div>
                  <p className="text-[11px] text-fg-muted leading-snug">
                    <strong className="text-fg-2">All-in-one Sidebar:</strong> All payment buttons, quick cash notes, and tender inputs stay inside the right sidebar below the cart.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t">
            <div>
              <label className="block text-sm font-bold text-fg-3 mb-1">Invoice Footer (Urdu/Eng)</label>
              <input
                type="text"
                value={form.invoice_footer}
                onChange={e => setForm({ ...form, invoice_footer: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none"
                placeholder="e.g. شکریہ! دوبارہ تشریف لائیں"
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-fg-3 mb-1">Quotation Footer (Urdu/Eng)</label>
              <input
                type="text"
                value={form.quotation_footer}
                onChange={e => setForm({ ...form, quotation_footer: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none"
                placeholder="e.g. یہ صرف قیمت نامہ ہے"
              />
            </div>
          </div>

          <div className="pt-4 border-t">
            <div className="max-w-xs">
              <label className="block text-sm font-bold text-fg-3 mb-1">Invoice Number Prefix</label>
              <input
                type="text"
                value={form.invoice_prefix}
                onChange={e => setForm({ ...form, invoice_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9\-]/g, '').slice(0, 10) })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none font-mono"
                placeholder="e.g. MALIK or INV"
                maxLength={10}
              />
              <p className="text-xs text-fg-subtle mt-1">
                Invoices will appear as: <span className="font-mono font-bold text-primary-fg">{form.invoice_prefix || 'INV'}-00001234</span>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t">
            <div>
              <label className="block text-sm font-bold text-fg-3 mb-1">Print Size</label>
              <select
                value={form.print_size}
                onChange={e => setForm({ ...form, print_size: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none bg-surface font-bold"
              >
                <option value="thermal">Thermal (80mm)</option>
                <option value="a4">A4 (Full Page)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-bold text-fg-3 mb-1">Print Flow</label>
              <select
                value={form.print_mode}
                onChange={e => setForm({ ...form, print_mode: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none bg-surface font-bold"
              >
                <option value="manual">Manual (Show Dialog)</option>
                <option value="auto">Auto (Print Direct)</option>
              </select>
            </div>
          </div>

          </div>
          )}

          {activeSection === 'whatsapp' && (
          <div className={SECTION_GROUP}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t">
            <div className="md:col-span-2">
              <h3 className="text-sm font-black text-primary-fg uppercase tracking-wider mb-3">WhatsApp Messaging Templates</h3>
              <p className="text-[10px] text-fg-subtle mb-4">
                Customer templates: <code className="bg-surface-3 px-1 rounded">[Name]</code> <code className="bg-surface-3 px-1 rounded">[Amount]</code> <code className="bg-surface-3 px-1 rounded">[Shop Name]</code> <code className="bg-surface-3 px-1 rounded">[ID]</code> <code className="bg-surface-3 px-1 rounded">[Portal Link]</code>
                &nbsp;·&nbsp; Bill &amp; payment templates also: <code className="bg-surface-3 px-1 rounded">[Bill Total]</code> <code className="bg-surface-3 px-1 rounded">[Paid Now]</code> <code className="bg-surface-3 px-1 rounded">[Bill Balance]</code> <code className="bg-surface-3 px-1 rounded">[Previous Balance]</code> <code className="bg-surface-3 px-1 rounded">[New Balance]</code> <code className="bg-surface-3 px-1 rounded">[Bill Link]</code> (no-login link to the bill)
                &nbsp;·&nbsp; Payment template only: <code className="bg-surface-3 px-1 rounded">[Bills]</code> (one line per bill paid)
                &nbsp;·&nbsp; A line whose value is missing (e.g. no link offline) is left out.
                &nbsp;·&nbsp; Reorder template: <code className="bg-surface-3 px-1 rounded">[Supplier Name]</code> <code className="bg-surface-3 px-1 rounded">[Shop Name]</code> <code className="bg-surface-3 px-1 rounded">[Items]</code>
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-bold text-fg-3 mb-1">💬 Debt Reminder Template</label>
              <textarea
                value={form.wa_reminder_template}
                onChange={e => setForm({ ...form, wa_reminder_template: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none text-sm h-20"
                placeholder="Hello [Name], your balance is Rs. [Amount]..."
              />
            </div>
            <div className="md:col-span-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <label htmlFor="wa-bill-template" className="block text-sm font-bold text-fg-3">🧾 New Bill / Sale Template</label>
                <button type="button" onClick={() => setForm({ ...form, wa_bill_template: DEFAULT_BILL_TEMPLATE })} className="text-xs font-semibold text-primary-fg hover:underline">
                  Use recommended (with balances)
                </button>
              </div>
              <textarea
                id="wa-bill-template"
                value={form.wa_bill_template}
                onChange={e => setForm({ ...form, wa_bill_template: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none text-sm h-28"
                placeholder="Hello [Name], thank you for shopping! Bill #[ID] for Rs. [Amount]..."
              />
            </div>
            <div className="md:col-span-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <label htmlFor="wa-payment-template" className="block text-sm font-bold text-fg-3">💵 Payment Received Template</label>
                <button type="button" onClick={() => setForm({ ...form, wa_payment_template: DEFAULT_PAYMENT_TEMPLATE })} className="text-xs font-semibold text-primary-fg hover:underline">
                  Use recommended
                </button>
              </div>
              <textarea
                id="wa-payment-template"
                value={form.wa_payment_template}
                onChange={e => setForm({ ...form, wa_payment_template: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none text-sm h-40"
              />
              <p className="text-[10px] text-fg-subtle mt-1">Sent from Customer Ledger → Receive Payment, after a payment is recorded against bills.</p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-bold text-fg-3 mb-1">📦 Low Stock Reorder Template (Inventory → Reorder WA)</label>
              <textarea
                value={form.wa_reorder_template}
                onChange={e => setForm({ ...form, wa_reorder_template: e.target.value })}
                className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none text-sm h-24"
                placeholder="Assalam-o-Alaikum *[Supplier Name]*!&#10;&#10;*[Shop Name]* se order:&#10;&#10;[Items]&#10;&#10;Meharbani farma kar supply karein."
              />
              <p className="text-[10px] text-fg-subtle mt-1">
                <code className="bg-surface-3 px-1 rounded">[Items]</code> is auto-filled with low stock product names, current stock and suggested reorder quantity.
              </p>
            </div>
          </div>

          </div>
          )}

          <div className="sticky bottom-0 -mx-6 -mb-6 px-6 py-4 bg-surface/95 backdrop-blur border-t rounded-b-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-[11px] text-fg-subtle font-medium sm:max-w-[320px]">
              Saves Shop Profile, Business & Pricing, POS & Receipts and WhatsApp settings together.
            </div>
            <button
              type="submit"
              disabled={saving}
              className="w-full sm:w-auto px-8 py-3 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl transition shadow-lg shadow-primary-muted disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
      )}

      {activeSection === 'appearance' && (
        <AppearanceSection
          title={currentSection.label}
          desc={currentSection.desc}
          onThemeChange={t => setForm(prev => ({ ...prev, theme_mode: t.mode, theme_accent: t.accent }))}
        />
      )}

      {activeSection === 'data' && (syncStatus.pending > 0 || syncStatus.failed > 0) && (
        <div className={`rounded-2xl border p-4 ${syncStatus.failed > 0 ? 'bg-danger-soft border-danger-line' : 'bg-warning-soft border-warning-line'}`} role="status">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className={`font-bold ${syncStatus.failed > 0 ? 'text-danger-strong' : 'text-warning-strong'}`}>
                {syncStatus.pending} change(s) waiting to sync{syncStatus.failed > 0 ? ` · ${syncStatus.failed} failed` : ''}
              </p>
              <p className="text-xs text-fg-3 mt-0.5">
                Offline sales, purchases and stock changes stay on this device until they reach the server. Failed items are kept — nothing is deleted.
              </p>
            </div>
            {syncStatus.failed > 0 && (
              <button
                type="button"
                onClick={async () => { await retryFailedSyncItems(); await refreshSyncStatus() }}
                className="w-full sm:w-auto px-4 py-2.5 bg-danger hover:bg-danger-hover text-white font-bold rounded-xl text-sm"
              >
                Retry failed
              </button>
            )}
          </div>
          {syncStatus.failedItems.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-danger-strong max-h-40 overflow-y-auto">
              {syncStatus.failedItems.slice(0, 20).map(it => (
                <li key={it.id} className="break-words"><b>{it.table}</b> {it.action}: {it.last_error || 'unknown error'}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {activeSection === 'portal' && (
      <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle p-6">
        <h3 className="font-bold text-fg mb-3">Customer Portal</h3>
        <CustomerPortalSettings />
      </div>
      )}

      {activeSection === 'data' && (
      <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle p-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="font-bold text-fg">Data Management & Backup</h3>
            <p className="text-xs text-fg-subtle mt-0.5">Import, export or reset your local store data.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {hasFeature('offline_sync') && <button
              onClick={async () => {
                if (!navigator.onLine) {
                  alert('Aap abhi offline hain! Pehle internet se connect karein.');
                  return;
                }
                setSaving(true);
                try {
                  const shopEq = 'shop_id';
                  const [p, c, cu, su, sa, pu, ex, us] = await Promise.all([
                    fetchAllRows(() => supabase.from('products').select('*').eq(shopEq, user.shop_id)),
                    supabase.from('categories').select('*').eq(shopEq, user.shop_id),
                    fetchAllRows(() => supabase.from('customers').select('*').eq(shopEq, user.shop_id)),
                    supabase.from('suppliers').select('*').eq(shopEq, user.shop_id),
                    fetchAllRows(() => supabase.from('sales').select('*').eq(shopEq, user.shop_id)),
                    supabase.from('purchases').select('*').eq(shopEq, user.shop_id),
                    supabase.from('expenses').select('*').eq(shopEq, user.shop_id),
                    supabase.from('users').select('*').eq(shopEq, user.shop_id)
                  ]);

                  const saleIds = sa.data ? sa.data.map(s => s.id) : [];
                  let siReq = { data: [] };
                  if (saleIds.length > 0) {
                    siReq = await supabase.from('sale_items').select('*').in('sale_id', saleIds);
                  }

                  const purchaseIds = pu.data ? pu.data.map(p => p.id) : [];
                  let piReq = { data: [] };
                  if (purchaseIds.length > 0) {
                    piReq = await supabase.from('purchase_items').select('*').in('purchase_id', purchaseIds);
                  }

                  const safePut = async (table, reqData) => {
                    if (reqData && reqData.length > 0) {
                      await db[table].clear();
                      await db[table].bulkPut(JSON.parse(JSON.stringify(reqData)));
                    }
                  };

                  await safePut('products', p.data);
                  await safePut('categories', c.data);
                  await safePut('customers', cu.data);
                  await safePut('suppliers', su.data);
                  await safePut('sales', sa.data);
                  await safePut('purchases', pu.data);
                  await safePut('expenses', ex.data);
                  await safePut('users', us.data);
                  await safePut('sale_items', siReq.data);
                  await safePut('purchase_items', piReq.data);

                  alert('Sari online data successfully local device mein save ho gayi hai! Ab aap offline aram se kaam kar sakte hain. ✅');
                } catch (e) {
                  alert('Sync failed: ' + e.message);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="px-4 py-2 border border-success-line bg-success-soft hover:bg-success-muted text-success-strong rounded-xl transition font-bold text-sm shadow-sm disabled:opacity-50"
            >
              {saving ? '⏳ Downloading...' : '⬇️ Download All for Offline'}
            </button>}
            <button
              onClick={async () => {
                if (confirm('Local cache clear krne se data re-fetch hoga. Continue?')) {
                  await db.products.clear()
                  await db.categories.clear()
                  await db.customers.clear()
                  await db.suppliers.clear()
                  await db.sales.clear()
                  await db.sale_items.clear()
                  await db.purchases.clear()
                  await db.purchase_items.clear()
                  await db.expenses.clear()
                  await db.users.clear()
                  alert('All local cache cleared! Page refresh karein.')
                  alert('Cache reset instructions complete.')
                }
              }}
              className="px-4 py-2 border border-line hover:bg-surface-2 text-fg-2 rounded-xl transition font-bold text-sm shadow-sm"
            >
              🧹 Clear All Cache
            </button>
            {hasFeature('offline_sync') && <button
              onClick={async () => {
                await syncOfflineData()
                alert('Sync process triggered! Check status in header.')
                fetchShop()
              }}
              className="px-4 py-2 border border-primary-line bg-primary-soft hover:bg-primary-muted text-primary-strong rounded-xl transition font-bold text-sm shadow-sm"
            >
              🔄 Sync Now
            </button>}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {hasFeature('data_export') ? (
          <div className="p-4 bg-success-soft/50 rounded-2xl border border-success-muted flex flex-col gap-3">
            <div>
              <p className="font-bold text-success-strong text-sm">Export All Data</p>
              <p className="text-[10px] text-success-fg">Save a complete backup of all products, customers, and suppliers.</p>
            </div>
            <button
              onClick={async () => {
                try {
                  const data = {
                    products: await db.products.toArray(),
                    categories: await db.categories.toArray(),
                    brands: await db.brands.toArray(),
                    customers: await db.customers.toArray(),
                    suppliers: await db.suppliers.toArray(),
                    sales: await db.sales.toArray(),
                    sale_items: await db.sale_items.toArray(),
                    purchases: await db.purchases.toArray(),
                    purchase_items: await db.purchase_items.toArray(),
                    expenses: await db.expenses.toArray(),
                    users: await db.users.toArray(),
                    sync_queue: await db.sync_queue.toArray(),
                    exported_at: new Date().toISOString(),
                    shop_id: user.shop_id,
                    version: '3.0'
                  }
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `${BRAND.shortName}POS_FullBackup_${new Date().toISOString().slice(0, 10)}.json`
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  URL.revokeObjectURL(url)
                  alert('Full backup downloaded! 💾 Is file ko safe rakhein.')
                } catch (err) {
                  alert('Backup failed: ' + err.message)
                }
              }}
              className="w-full py-2 bg-success hover:bg-success-hover text-white rounded-lg transition font-bold text-xs shadow-md"
            >
              📥 Download System Backup (.json)
            </button>

            <button
              onClick={async () => {
                try {
                  const data = {
                    Products: await db.products.toArray(),
                    Customers: await db.customers.toArray(),
                    Suppliers: await db.suppliers.toArray(),
                    Sales: await db.sales.toArray(),
                    SaleItems: await db.sale_items.toArray(),
                    Purchases: await db.purchases.toArray(),
                    Expenses: await db.expenses.toArray()
                  }

                  const workbook = XLSX.utils.book_new()

                  // Convert each table to a worksheet and append
                  for (const [sheetName, rows] of Object.entries(data)) {
                    // Only add sheet if there is data
                    if (rows.length > 0) {
                      const worksheet = XLSX.utils.json_to_sheet(rows)
                      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
                    } else {
                      // Add empty sheet so user knows it exported but was empty
                      const worksheet = XLSX.utils.json_to_sheet([{ Message: 'No data exists' }])
                      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
                    }
                  }

                  const fileName = `${BRAND.shortName}POS_ExcelReports_${new Date().toISOString().slice(0, 10)}.xlsx`
                  XLSX.writeFile(workbook, fileName)
                  alert('Excel reports generated and downloaded successfully! 📊')
                } catch (err) {
                  alert('Excel Export failed: ' + err.message)
                }
              }}
              className="w-full py-2 bg-success hover:bg-success-hover text-white rounded-lg transition font-bold text-xs shadow-md"
            >
              📊 Export to Excel
            </button>
          </div>
          ) : (
          <div className="p-4 bg-surface-2/50 rounded-2xl border border-line flex flex-col gap-3 opacity-60">
            <div>
              <p className="font-bold text-fg-muted text-sm flex items-center gap-2">Export All Data <span className="text-xs">🔒</span></p>
              <p className="text-[10px] text-fg-subtle">Upgrade your plan to enable data export and backup.</p>
            </div>
          </div>
          )}

          <div className="p-4 bg-primary-soft/50 rounded-2xl border border-primary-muted flex flex-col gap-3">
            <div>
              <p className="font-bold text-primary-strong text-sm">Import / Restore Data</p>
              <p className="text-[10px] text-primary-fg">Restore your database from a previous backup file.</p>
            </div>
            <div className="relative">
              <input
                type="file"
                accept=".json"
                id="import-backup"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files[0]
                  if (!file) return

                  if (!confirm('Warning: Is se apka mojooda local data replace ho jayega. Continue?')) return

                  const reader = new FileReader()
                  reader.onload = async (event) => {
                    try {
                      const data = JSON.parse(event.target.result)

                      // Basic Validation
                      if (!data.products || !data.customers) {
                        throw new Error('Invalid backup file format.')
                      }

                      // Restore tables
                      await db.transaction('rw',
                        db.products, db.categories, db.brands, db.customers, db.suppliers,
                        db.sales, db.sale_items, db.purchases, db.purchase_items,
                        db.expenses, db.users, async () => {

                          await db.products.clear()
                          await db.categories.clear()
                          await db.brands.clear()
                          await db.customers.clear()
                          await db.suppliers.clear()
                          await db.sales.clear()
                          await db.sale_items.clear()
                          await db.purchases.clear()
                          await db.purchase_items.clear()
                          await db.expenses.clear()
                          await db.users.clear()

                          if (data.products?.length) await db.products.bulkAdd(data.products)
                          if (data.categories?.length) await db.categories.bulkAdd(data.categories)
                          if (data.brands?.length) await db.brands.bulkAdd(data.brands)
                          if (data.customers?.length) await db.customers.bulkAdd(data.customers)
                          if (data.suppliers?.length) await db.suppliers.bulkAdd(data.suppliers)
                          if (data.sales?.length) await db.sales.bulkAdd(data.sales)
                          if (data.sale_items?.length) await db.sale_items.bulkAdd(data.sale_items)
                          if (data.purchases?.length) await db.purchases.bulkAdd(data.purchases)
                          if (data.purchase_items?.length) await db.purchase_items.bulkAdd(data.purchase_items)
                          if (data.expenses?.length) await db.expenses.bulkAdd(data.expenses)
                          if (data.users?.length) await db.users.bulkAdd(data.users)
                        })

                      alert('Data restored successfully! ✅ Page refresh ho raha hai.')
                      window.location.reload()
                    } catch (err) {
                      alert('Import failed: ' + err.message)
                    }
                  }
                  reader.readAsText(file)
                }}
              />
              <label
                htmlFor="import-backup"
                className="flex items-center justify-center w-full py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition font-bold text-xs cursor-pointer shadow-md"
              >
                📤 Upload & Restore
              </label>
            </div>
          </div>
        </div>
      </div>


      )}

      {/* ── Billing Template Selector (shown under POS & Receipts) ── */}
      {activeSection === 'pos' && (
      <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle overflow-hidden">
        <div className="bg-surface-2 px-6 py-4 border-b">
          <h2 className="font-bold text-fg-2">Billing Template</h2>
          <p className="text-xs text-fg-subtle">Choose how your receipts and invoices look when printed. Works for both 80mm thermal and A4.</p>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-4 gap-4">
          {[
            { id: '1', name: 'Simple', desc: 'Minimal & clean. No logo area, compact spacing. Fast to print.', icon: '📄' },
            { id: '2', name: 'Classic', desc: 'Standard receipt style with logo, dashed lines and item table. Recommended.', icon: '🧾' },
            { id: '3', name: 'Professional', desc: 'Full invoice look — letterhead, invoice number box, PAID stamp, signature line.', icon: '📋' },
            { id: '4', name: 'Modern', desc: 'Elegant & spacious. System sans-serif font, thin grey borders, cards for totals. (Premium)', icon: '✨' },
          ].map(t => (
            <div
              key={t.id}
              className={`flex flex-col justify-between p-4 rounded-xl border-2 transition ${printTemplate === t.id ? 'border-primary bg-primary-soft/30' : 'border-line hover:border-line-strong'}`}
            >
              <div>
                <div className="text-2xl mb-2">{t.icon}</div>
                <div className="font-bold text-fg flex items-center gap-2">
                  {t.name}
                  {printTemplate === t.id && <span className="text-[10px] font-black bg-primary text-white px-2 py-0.5 rounded-full uppercase">Active</span>}
                </div>
                <p className="text-xs text-fg-muted mt-1 leading-relaxed mb-4">{t.desc}</p>
              </div>
              
              <div className="flex gap-2 mt-auto pt-2 border-t border-line-subtle">
                <button
                  type="button"
                  onClick={() => {
                    const sid = user?.shop_id
                    setPrintTemplate(t.id)
                    localStorage.setItem(sid ? `print_template_${sid}` : 'print_template', t.id)
                    if (sid) {
                      let saved = {}
                      try { saved = JSON.parse(localStorage.getItem(`shop_settings_${sid}`) || '{}') } catch (_) {}
                      saved.print_template = t.id
                      localStorage.setItem(`shop_settings_${sid}`, JSON.stringify(saved))
                      if (navigator.onLine) {
                        supabase.rpc('update_shop_settings', {
                          p_shop_id: Number(sid),
                          p_print_template: t.id
                        }).catch(err => console.warn('Could not sync print template choice:', err))
                      }
                    }
                  }}
                  className={`flex-1 text-center py-1.5 px-3 rounded-lg text-xs font-bold transition ${printTemplate === t.id ? 'bg-primary hover:bg-primary-hover text-white shadow-sm' : 'bg-surface-3 hover:bg-surface-4 text-fg-2'}`}
                >
                  {printTemplate === t.id ? 'Selected' : 'Select'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewTemplateId(t.id)
                    setPreviewSize(form.print_size || 'thermal')
                  }}
                  className="bg-surface hover:bg-surface-2 border border-line text-fg-3 px-2 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 shadow-sm"
                  title="Quick View Template"
                >
                  👁️ Preview
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      )}

      {/* ── Sales Reports ── */}
      {activeSection === 'reports' && (
      <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle overflow-hidden">
        <div className="bg-surface-2 px-6 py-4 border-b">
          <h2 className="font-bold text-fg-2">Print Sales Report</h2>
          <p className="text-xs text-fg-subtle">Generate and print a daily, weekly, or monthly sales summary with revenue breakdown.</p>
        </div>
        <div className="p-6">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
            <div className="flex gap-2 flex-wrap">
              {[
                { id: 'today', label: "📅 Today" },
                { id: 'week',  label: "📆 This Week" },
                { id: 'month', label: "🗓️ This Month" },
              ].map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setReportPeriod(p.id)}
                  className={`px-4 py-2 rounded-xl border font-bold text-sm transition ${reportPeriod === p.id ? 'bg-primary text-white border-primary' : 'border-line text-fg-2 hover:bg-surface-2'}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <button
              onClick={printSalesReport}
              disabled={reportLoading}
              className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl transition shadow-md shadow-primary-muted disabled:opacity-50 text-sm whitespace-nowrap"
            >
              {reportLoading ? '⏳ Loading...' : '🖨️ Print Report'}
            </button>
          </div>
          <p className="text-xs text-fg-subtle mt-4">Report includes: total revenue, cash/card/credit breakdown, outstanding balance, discount given, and full transaction list.</p>
        </div>
      </div>

      )}

      {/* Plan & Subscription */}
      {activeSection === 'plan' && !planInfo && (
        <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle p-6 text-sm text-fg-muted">
          Plan details are not available right now. Connect to the internet and reopen this page.
        </div>
      )}
      {activeSection === 'plan' && planInfo && (
        <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle overflow-hidden">
          <div className="bg-primary-soft px-6 py-4 border-b">
            <h2 className="font-bold text-primary-strong">Plan & Subscription</h2>
            <p className="text-[10px] text-primary-fg font-bold uppercase tracking-wider">Your Current Service Tier</p>
          </div>
          <div className="p-6">
            <div className="flex flex-col md:flex-row justify-between gap-6">
              <div className="space-y-4 flex-1">
                <div>
                  <label className="text-[10px] font-black text-fg-subtle uppercase tracking-widest block mb-1">Active Plan</label>
                  <p className="text-xl font-black text-fg">{planInfo.plan_name} <span className="text-primary-fg italic">Tier</span></p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-fg-subtle uppercase tracking-widest block mb-1">Product Limit</label>
                    <p className="font-bold text-fg">{planInfo.product_limit} items</p>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-fg-subtle uppercase tracking-widest block mb-1">Users Limit</label>
                    <p className="font-bold text-fg">{planInfo.user_limit} accounts</p>
                  </div>
                </div>
              </div>
              
              <div className="md:border-l md:pl-6 space-y-4">
                <div>
                  <label className="text-[10px] font-black text-fg-subtle uppercase tracking-widest block mb-1">Next Billing Date</label>
                  <p className="font-mono font-black text-fg bg-surface-2 px-3 py-1 rounded-lg border">
                    {planInfo.next_billing_date ? new Date(planInfo.next_billing_date).toLocaleDateString('en-PK', { dateStyle: 'long' }) : 'N/A'}
                  </p>
                </div>
                <div className="p-3 bg-primary-soft rounded-xl border border-primary-muted">
                  <p className="text-[10px] text-primary-strong font-bold leading-tight">Need more capacity? Contact support to upgrade your plan.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSection === 'plan' && (
      <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle p-6 flex items-center justify-between">
        <div>
          <h3 className="font-bold text-fg">Software Updates</h3>
          <p className="text-xs text-fg-subtle mt-0.5">Your POS is currently running the latest version v2.1.0-Premium</p>
        </div>
        <div className="flex -space-x-2">
          <span className="w-8 h-8 rounded-full bg-primary-muted border-2 border-surface flex items-center justify-center text-[10px] font-bold text-primary-fg">AS</span>
          <span className="w-8 h-8 rounded-full bg-primary-muted border-2 border-surface flex items-center justify-center text-[10px] font-bold text-primary-fg">SM</span>
        </div>
      </div>

      )}

      {/* Danger Zone */}
      {activeSection === 'danger' && (
      <div className="bg-danger-soft rounded-2xl shadow-sm border-2 border-danger-line p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-danger-muted rounded-full flex items-center justify-center">
            <span className="text-xl">⚠️</span>
          </div>
          <div>
            <h3 className="font-bold text-danger-strong text-lg">Danger Zone</h3>
            <p className="text-xs text-danger-fg">Irreversible actions — proceed with extreme caution</p>
          </div>
        </div>
        <div className="bg-surface rounded-xl p-4 border border-danger-muted">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="font-bold text-fg">🗑️ Clear All Shop Data</p>
              <p className="text-xs text-fg-muted mt-1">Permanently delete ALL products, suppliers, customers, sales, purchases, expenses, and payments for this shop. This cannot be undone!</p>
            </div>
            <button
              onClick={() => setShowPasswordModal(true)}
              disabled={clearing}
              className="px-6 py-3 bg-danger hover:bg-danger-hover text-white font-bold rounded-xl transition whitespace-nowrap shadow-lg shadow-danger-line disabled:opacity-50"
            >
              {clearing ? 'Clearing...' : '🔥 Clear All Data'}
            </button>
          </div>
        </div>
      </div>

      )}
        </div>
      </div>

      {showPasswordModal && (
        <PasswordModal
          title="⚠️ Clear ALL Shop Data"
          message="This will permanently delete ALL data. Enter your password to confirm."
          onConfirm={async () => {
            setShowPasswordModal(false)
            // Second confirmation: type shop name
            const shopName = form.name || 'My Shop'
            const typed = prompt(`Type "${shopName}" to confirm permanent deletion of ALL data:`)
            if (typed !== shopName) {
              alert('Shop name does not match. Operation cancelled.')
              return
            }
            setClearing(true)
            try {
              if (navigator.onLine) {
                // Delete child items first (no shop_id column — must delete by parent IDs)
                const { data: shopSales } = await supabase.from('sales').select('id').eq('shop_id', user.shop_id)
                const saleIds = (shopSales || []).map(s => s.id)
                if (saleIds.length) await supabase.from('sale_items').delete().in('sale_id', saleIds)

                const { data: shopPurchases } = await supabase.from('purchases').select('id').eq('shop_id', user.shop_id)
                const purchaseIds = (shopPurchases || []).map(p => p.id)
                if (purchaseIds.length) await supabase.from('purchase_items').delete().in('purchase_id', purchaseIds)

                // Now delete all shop_id-scoped tables
                const shopIdTables = ['products', 'categories', 'brands', 'customers', 'suppliers', 'sales', 'purchases', 'expenses', 'customer_payments', 'supplier_payments', 'audit_logs']
                for (const t of shopIdTables) {
                  await supabase.from(t).delete().eq('shop_id', user.shop_id)
                }
              }
              // Clear all local Dexie tables
              const allTables = ['products', 'categories', 'brands', 'customers', 'suppliers', 'sales', 'sale_items', 'purchases', 'purchase_items', 'expenses', 'customer_payments', 'supplier_payments', 'audit_logs']
              for (const t of allTables) {
                if (db[t]) await db[t].clear()
              }
              await db.trash.clear()
              await db.sync_queue.clear()
              alert('✅ All shop data has been cleared successfully!')
              window.location.reload()
            } catch (err) {
              alert('Error clearing data: ' + err.message)
            } finally {
              setClearing(false)
            }
          }}
          onCancel={() => setShowPasswordModal(false)}
        />
      )}

      {/* ── Billing Template Quick View Modal ── */}
      {previewTemplateId && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden border border-line-subtle">
            {/* Header */}
            <div className="bg-contrast text-white px-6 py-4 flex items-center justify-between">
              <div>
                <h3 className="font-extrabold text-lg flex items-center gap-2">
                  <span>✨</span> Quick View Template Preview
                </h3>
                <p className="text-xs text-fg-subtle">See exactly how your invoice will print.</p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewTemplateId(null)}
                className="text-fg-subtle hover:text-white transition text-xl p-1 font-bold"
              >
                ✕
              </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">
              {/* Left Control Column */}
              <div className="w-full md:w-80 bg-surface-2 border-r border-line-subtle p-6 flex flex-col justify-between overflow-y-auto">
                <div className="space-y-6">
                  <div>
                    <span className="text-[10px] uppercase font-black tracking-wider text-fg-subtle block mb-2">Select Format Size</span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setPreviewSize('thermal')}
                        className={`py-2.5 px-3 rounded-xl font-bold text-xs border-2 transition ${previewSize === 'thermal' ? 'bg-primary text-white border-primary' : 'bg-surface border-line text-fg-3 hover:border-line-strong'}`}
                      >
                        📟 Thermal (80mm)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewSize('a4')}
                        className={`py-2.5 px-3 rounded-xl font-bold text-xs border-2 transition ${previewSize === 'a4' ? 'bg-primary text-white border-primary' : 'bg-surface border-line text-fg-3 hover:border-line-strong'}`}
                      >
                        📄 A4 Page
                      </button>
                    </div>
                  </div>

                  <div className="bg-surface rounded-xl border border-line/60 p-4 shadow-sm">
                    <h4 className="font-extrabold text-fg text-sm mb-2">Template Specs</h4>
                    <ul className="text-xs text-fg-muted space-y-2">
                      <li className="flex justify-between"><span className="text-fg-subtle">Option:</span> <span className="font-semibold text-fg-2">{previewTemplateId === '1' ? 'Simple' : previewTemplateId === '2' ? 'Classic' : previewTemplateId === '3' ? 'Professional' : 'Modern'}</span></li>
                      <li className="flex justify-between"><span className="text-fg-subtle">Paper Width:</span> <span className="font-semibold text-fg-2">{previewSize === 'thermal' ? '80mm (Thermal)' : '210mm (A4)'}</span></li>
                      <li className="flex justify-between"><span className="text-fg-subtle">Layout type:</span> <span className="font-semibold text-fg-2">{previewSize === 'thermal' ? 'Continuous Roll' : 'Portrait Sheet'}</span></li>
                    </ul>
                  </div>

                  <div className="p-3 bg-primary-soft/50 rounded-xl border border-primary-muted/50 text-[11px] text-primary-strong leading-relaxed">
                    💡 <strong>Tip:</strong> The printed layout is dynamic and will adjust perfectly according to the printer size defined in settings.
                  </div>
                </div>

                <div className="mt-8 space-y-2">
                  <button
                    type="button"
                    onClick={() => {
                      const sid = user?.shop_id
                      setPrintTemplate(previewTemplateId)
                      localStorage.setItem(sid ? `print_template_${sid}` : 'print_template', previewTemplateId)
                      if (sid) {
                        let saved = {}
                        try { saved = JSON.parse(localStorage.getItem(`shop_settings_${sid}`) || '{}') } catch (_) {}
                        saved.print_template = previewTemplateId
                        localStorage.setItem(`shop_settings_${sid}`, JSON.stringify(saved))
                        if (navigator.onLine) {
                          supabase.rpc('update_shop_settings', {
                            p_shop_id: Number(sid),
                            p_print_template: previewTemplateId
                          }).catch(err => console.warn('Could not sync print template choice:', err))
                        }
                      }
                      setPreviewTemplateId(null)
                      alert('Template applied successfully!')
                    }}
                    className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-xl text-xs font-bold transition shadow-lg shadow-primary-muted flex items-center justify-center gap-2"
                  >
                    <span>✓</span> Apply This Template
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewTemplateId(null)}
                    className="w-full py-3 bg-surface hover:bg-surface-3 border border-line text-fg-2 rounded-xl text-xs font-bold transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              {/* Right Iframe Preview Area */}
              <div className="flex-1 bg-surface-4 p-6 flex items-center justify-center overflow-y-auto">
                <div 
                  className="bg-surface shadow-2xl transition-all duration-300 overflow-hidden border border-line-strong rounded"
                  style={{
                    width: previewSize === 'thermal' ? '320px' : '650px',
                    height: previewSize === 'thermal' ? '500px' : '750px',
                    maxHeight: '100%'
                  }}
                >
                  <iframe
                    srcDoc={getPreviewHTML(previewTemplateId, previewSize)}
                    className="w-full h-full border-none bg-surface"
                    title="Invoice Template Preview"
                    sandbox="allow-same-origin"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Settings
