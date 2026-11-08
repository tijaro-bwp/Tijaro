import { hasFeature } from './featureGate'

// ============================================================
// Business Presets & Multi-Store Configuration Helper
// Adapts placeholders, default units, and pricing terms
// across different retail domains (Grocery, Clothing, Pharmacy,
// Electronics, Hardware, General Retail).
// ============================================================

export const BUSINESS_PRESETS = [
  {
    id: 'general',
    name: 'General Retail & Mart',
    icon: 'Store',
    description: 'Department stores, stationery, cosmetics, gift shops, & general goods',
    defaultUnits: [
      { name: 'Piece', abbreviation: 'Pcs' },
      { name: 'Box', abbreviation: 'Box' },
      { name: 'Pack', abbreviation: 'Pk' },
      { name: 'Dozen', abbreviation: 'Dz' },
      { name: 'Set', abbreviation: 'Set' },
      { name: 'Pair', abbreviation: 'Pr' },
    ],
    placeholders: {
      productName: 'e.g. Wireless Mouse / Notebook / Perfume',
      sku: 'e.g. PRD-1001 or Scan Barcode',
      category: 'e.g. Stationery, Cosmetics, Accessories',
      brand: 'e.g. Sony, Casio, Faber-Castell',
      supplierName: 'e.g. Al-Madina Wholesalers',
      supplierItems: 'e.g. General Merchandise / Office Supplies',
    },
    defaultPricingMode: 'hidden', // 'hidden', 'mrp', or 'c_rate'
    defaultPriceLabel: 'MRP / List Price'
  },
  {
    id: 'grocery',
    name: 'Grocery & Supermarket',
    icon: 'ShoppingBasket',
    description: 'Food marts, fruits/veggies, bakeries, & FMCG superstores',
    defaultUnits: [
      { name: 'Piece', abbreviation: 'Pcs' },
      { name: 'Kg', abbreviation: 'Kg' },
      { name: 'Gram', abbreviation: 'g' },
      { name: 'Liter', abbreviation: 'L' },
      { name: 'Pack', abbreviation: 'Pk' },
      { name: 'Box', abbreviation: 'Box' },
      { name: 'Dozen', abbreviation: 'Dz' },
      { name: 'Carton', abbreviation: 'Ctn' },
    ],
    placeholders: {
      productName: 'e.g. Nestlé Milk 1L / Basmati Rice 5kg / Cooking Oil',
      sku: 'e.g. 896400012345 or Scan Barcode',
      category: 'e.g. Dairy, Beverages, Spices, Grains',
      brand: 'e.g. Nestlé, Shan, Dalda, Unilever',
      supplierName: 'e.g. Metro Wholesale / National Foods Dist.',
      supplierItems: 'e.g. FMCG Goods, Cooking Essentials',
    },
    defaultPricingMode: 'mrp',
    defaultPriceLabel: 'MRP (Max Retail Price)'
  },
  {
    id: 'apparel',
    name: 'Clothing, Apparel & Footwear',
    icon: 'Shirt',
    description: 'Garments, boutique, shoes, fabric & fashion accessories',
    defaultUnits: [
      { name: 'Piece', abbreviation: 'Pcs' },
      { name: 'Pair', abbreviation: 'Pr' },
      { name: 'Set', abbreviation: 'Set' },
      { name: 'Dozen', abbreviation: 'Dz' },
      { name: 'Meter', abbreviation: 'm' },
      { name: 'Box', abbreviation: 'Box' },
    ],
    placeholders: {
      productName: 'e.g. Cotton Polo T-Shirt (M) / Denim Jeans 32',
      sku: 'e.g. TSH-BLU-M or Scan Barcode',
      category: 'e.g. Menswear, Womenswear, Casuals, Shoes',
      brand: 'e.g. Levi\'s, Nike, Outfitters, Local Brand',
      supplierName: 'e.g. Textile Mills / Karachi Garments Hub',
      supplierItems: 'e.g. Ready-made Garments, Footwear',
    },
    defaultPricingMode: 'mrp',
    defaultPriceLabel: 'Tag Price / MRP'
  },
  {
    id: 'pharmacy',
    name: 'Pharmacy & Healthcare',
    icon: 'Pill',
    description: 'Medical stores, chemist, surgical & healthcare items',
    defaultUnits: [
      { name: 'Strip', abbreviation: 'Str' },
      { name: 'Box', abbreviation: 'Box' },
      { name: 'Piece', abbreviation: 'Pcs' },
      { name: 'Bottle', abbreviation: 'Btl' },
      { name: 'Pack', abbreviation: 'Pk' },
      { name: 'Tube', abbreviation: 'Tb' },
    ],
    placeholders: {
      productName: 'e.g. Panadol 500mg (Strip) / Augmentin 625mg',
      sku: 'e.g. MED-PAN-500 or Scan Barcode',
      category: 'e.g. Antibiotics, Pain Relief, Syrups, First Aid',
      brand: 'e.g. GSK, Abbott, Getz, Pfizer',
      supplierName: 'e.g. Premier Distributors / Ali Pharma Dist.',
      supplierItems: 'e.g. Pharmaceuticals & Surgical Items',
    },
    defaultPricingMode: 'mrp',
    defaultPriceLabel: 'MRP (Printed Price)'
  },
  {
    id: 'electronics',
    name: 'Electronics & Mobile Store',
    icon: 'Smartphone',
    description: 'Mobile phones, computer parts, appliances & accessories',
    defaultUnits: [
      { name: 'Piece', abbreviation: 'Pcs' },
      { name: 'Set', abbreviation: 'Set' },
      { name: 'Box', abbreviation: 'Box' },
      { name: 'Meter', abbreviation: 'm' },
    ],
    placeholders: {
      productName: 'e.g. Fast Charger 65W / Wireless Earbuds / USB Cable',
      sku: 'e.g. ELEC-CHG-65 or IMEI / Barcode',
      category: 'e.g. Accessories, Cables, Audio, Smart Devices',
      brand: 'e.g. Samsung, Apple, Anker, Xiaomi',
      supplierName: 'e.g. Tech Wholesale Market / Shenzhen Importer',
      supplierItems: 'e.g. Mobile Accessories, Gadgets',
    },
    defaultPricingMode: 'mrp',
    defaultPriceLabel: 'MSRP / List Price'
  },
  {
    id: 'hardware',
    name: 'Hardware, Sanitary & Building Materials',
    icon: 'Wrench',
    description: 'Plumbing, sanitaryware, paints, electrical & hardware supplies',
    defaultUnits: [
      { name: 'Piece', abbreviation: 'Pcs' },
      { name: 'Box', abbreviation: 'Box' },
      { name: 'Feet', abbreviation: 'ft' },
      { name: 'Meter', abbreviation: 'm' },
      { name: 'Length', abbreviation: 'Len' },
      { name: 'Kg', abbreviation: 'Kg' },
      { name: 'Bundle', abbreviation: 'Bndl' },
      { name: 'Set', abbreviation: 'Set' },
      { name: 'Bag', abbreviation: 'Bag' },
    ],
    placeholders: {
      productName: 'e.g. Single Lever Basin Mixer / PPRC Pipe 1"',
      sku: 'e.g. MIX-001 or Scan Barcode',
      category: 'e.g. Faucets & Mixers, Pipes, Sanitaryware, Paints',
      brand: 'e.g. Master, Porta, Faisal, Diamond',
      supplierName: 'e.g. Porta Pakistan / Dealer Name',
      supplierItems: 'e.g. CP Fittings, Tiles, Sanitaryware',
    },
    defaultPricingMode: 'c_rate',
    defaultPriceLabel: 'C.Rate (Company Rate)'
  }
]

export function getShopPreset(shopSettings) {
  const presetId = shopSettings?.business_preset || 'general'
  return BUSINESS_PRESETS.find(p => p.id === presetId) || BUSINESS_PRESETS[0]
}

export function getPricingConfig(shopSettings) {
  const preset = getShopPreset(shopSettings)
  // 'hidden' | 'c_rate' | 'mrp' | 'custom'
  const mode = shopSettings?.pricing_mode || preset.defaultPricingMode
  const customLabel = shopSettings?.custom_price_label
  
  let label = preset.defaultPriceLabel
  if (mode === 'c_rate') label = 'C.Rate (Company Rate)'
  else if (mode === 'mrp') label = 'MRP / List Price'
  else if (mode === 'custom' && customLabel) label = customLabel

  return {
    enabled: mode !== 'hidden',
    mode,
    label
  }
}

// ============================================================
// Price Tiers (Retail / Wholesale)
// Wholesale is opt-in per shop: the plan must allow it AND the
// shop owner must switch it on in Settings (wholesale_enabled).
// hasFeature() returns true for unknown keys, so the shop setting
// is the real default-off switch.
// ============================================================

export function getShopSettings(shopId) {
  try {
    if (!shopId) return {}
    return JSON.parse(localStorage.getItem(`shop_settings_${shopId}`) || '{}') || {}
  } catch {
    return {}
  }
}

export function isWholesaleEnabled(shopSettings) {
  return hasFeature('wholesale') && shopSettings?.wholesale_enabled === true
}

export function normalizeTier(tier) {
  return tier === 'wholesale' ? 'wholesale' : 'retail'
}

// Returns the unit price for a product at the given tier.
// `fallback` is true when wholesale was requested but the product has
// no wholesale price, so the retail price was used instead.
export function getUnitPrice(product, tier = 'retail') {
  const retail = Number(product?.sale_price) || 0
  if (normalizeTier(tier) !== 'wholesale') return { price: retail, fallback: false }
  const wholesale = Number(product?.wholesale_price) || 0
  if (wholesale > 0) return { price: wholesale, fallback: false }
  return { price: retail, fallback: true }
}
