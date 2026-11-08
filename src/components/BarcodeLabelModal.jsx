import React, { useState, useRef } from 'react'
import { Printer, X, Tag, Copy, Sliders, CheckSquare, Layers } from 'lucide-react'
import { BRAND } from '../config/brand.js'

// Lightweight Code128B pattern generator for crisp vector SVG barcodes
function generateCode128BPattern(text) {
  if (!text) return ''
  // Code 128B character set encoding patterns (simplified robust subset)
  const patterns = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
    "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
    "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
    "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
    "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
    "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
    "114131", "311141", "411131", "211412", "211214", "211232", "2331112"
  ]
  const START_B = 104
  const STOP = 106

  let checksum = START_B
  let fullPattern = patterns[START_B]

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) - 32
    const safeCode = (code >= 0 && code <= 95) ? code : 0
    checksum += safeCode * (i + 1)
    fullPattern += patterns[safeCode] || patterns[0]
  }

  const checkVal = checksum % 103
  fullPattern += patterns[checkVal] || patterns[0]
  fullPattern += patterns[STOP]

  return fullPattern
}

function BarcodeSVG({ value, height = 36, width = 1.2 }) {
  const pattern = generateCode128BPattern(String(value || '000000'))
  if (!pattern) return null

  let x = 0
  const bars = []
  for (let i = 0; i < pattern.length; i++) {
    const w = parseInt(pattern[i], 10) * width
    if (i % 2 === 0) {
      bars.push(<rect key={i} x={x} y={0} width={w} height={height} fill="#000000" />)
    }
    x += w
  }

  return (
    <svg width={x} height={height} viewBox={`0 0 ${x} ${height}`} className="mx-auto block">
      {bars}
    </svg>
  )
}

export default function BarcodeLabelModal({ isOpen, onClose, products = [], defaultProduct = null, shopName = BRAND.appName }) {
  const [selectedProduct, setSelectedProduct] = useState(() => defaultProduct || products[0] || null)
  const [quantity, setQuantity] = useState(12)
  const [labelFormat, setLabelFormat] = useState('thermal-50x25') // 'thermal-50x25', 'thermal-40x30', 'a4-24', 'a4-30'
  const [showShopName, setShowShopName] = useState(true)
  const [showPrice, setShowPrice] = useState(true)
  const [showSku, setShowSku] = useState(true)
  const [customPrice, setCustomPrice] = useState('')

  const printAreaRef = useRef(null)

  if (!isOpen) return null

  const activePrice = customPrice !== '' ? Number(customPrice) : Number(selectedProduct?.sale_price || 0)
  const barcodeValue = selectedProduct?.sku || selectedProduct?.id?.toString() || '10001'

  const handlePrint = () => {
    const printContent = printAreaRef.current?.innerHTML
    if (!printContent) return

    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    document.body.appendChild(iframe)

    const pageStyle = labelFormat === 'thermal-50x25'
      ? '@page { size: 50mm 25mm; margin: 0; }'
      : labelFormat === 'thermal-40x30'
        ? '@page { size: 40mm 30mm; margin: 0; }'
        : '@page { size: A4 portrait; margin: 8mm; }'

    const doc = iframe.contentWindow.document
    doc.open()
    doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Print Barcode Labels - ${selectedProduct?.name || 'Product'}</title>
          <style>
            ${pageStyle}
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .label-item {
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              text-align: center;
              overflow: hidden;
              page-break-inside: avoid;
            }
            .label-thermal-50x25 {
              width: 50mm;
              height: 25mm;
              padding: 1.5mm;
              page-break-after: always;
            }
            .label-thermal-40x30 {
              width: 40mm;
              height: 30mm;
              padding: 2mm;
              page-break-after: always;
            }
            .a4-grid-24 {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 2mm;
            }
            .label-a4-24 {
              width: 64mm;
              height: 33.8mm;
              border: 1px dashed #e2e8f0;
              padding: 3mm;
            }
            .a4-grid-30 {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 2mm;
            }
            .label-a4-30 {
              width: 64mm;
              height: 27mm;
              border: 1px dashed #e2e8f0;
              padding: 2mm;
            }
            .shop-title { font-size: 8px; font-weight: 800; text-transform: uppercase; color: #1e293b; margin-bottom: 1px; letter-spacing: 0.5px; }
            .prod-title { font-size: 9px; font-weight: 700; color: #0f172a; line-height: 1.1; margin-bottom: 2px; max-width: 95%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .price-tag { font-size: 11px; font-weight: 800; color: #000; margin-top: 1px; }
            .sku-text { font-size: 7.5px; font-family: monospace; font-weight: 600; color: #475569; letter-spacing: 1px; margin-top: 1px; }
          </style>
        </head>
        <body>
          ${printContent}
        </body>
      </html>
    `)
    doc.close()

    iframe.contentWindow.focus()
    setTimeout(() => {
      iframe.contentWindow.print()
      setTimeout(() => document.body.removeChild(iframe), 1500)
    }, 400)
  }

  // Label card markup generator
  const renderSingleLabel = (idx) => {
    let containerClass = ''
    if (labelFormat === 'thermal-50x25') containerClass = 'label-thermal-50x25'
    else if (labelFormat === 'thermal-40x30') containerClass = 'label-thermal-40x30'
    else if (labelFormat === 'a4-24') containerClass = 'label-a4-24'
    else if (labelFormat === 'a4-30') containerClass = 'label-a4-30'

    return (
      <div key={idx} className={`label-item ${containerClass} bg-white flex flex-col items-center justify-center`}>
        {showShopName && (
          <p className="shop-title text-[9px] font-black uppercase text-black/80 tracking-wider truncate w-full text-center leading-tight">
            {shopName}
          </p>
        )}
        <p className="prod-title text-[10px] font-bold text-black truncate w-full text-center leading-tight">
          {selectedProduct?.name || 'Product Name'}
        </p>

        <div className="my-0.5">
          <BarcodeSVG value={barcodeValue} height={labelFormat === 'thermal-50x25' ? 24 : 28} width={1.05} />
        </div>

        {showSku && (
          <p className="sku-text text-[8px] font-mono text-black/70 tracking-widest leading-none">
            {barcodeValue}
          </p>
        )}

        {showPrice && (
          <p className="price-tag text-[12px] font-black text-black leading-tight mt-0.5">
            Rs. {activePrice.toLocaleString()}
          </p>
        )}
      </div>
    )
  }

  const labelList = Array.from({ length: Math.max(1, parseInt(quantity) || 1) }, (_, i) => i)

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden border border-line-subtle animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-line-subtle flex items-center justify-between bg-surface-2/70">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-primary text-white flex items-center justify-center shadow-md shadow-primary/20">
              <Tag size={18} />
            </div>
            <div>
              <h2 className="text-lg font-black text-fg tracking-tight">Barcode & Price Sticker Generator</h2>
              <p className="text-xs text-fg-muted">Print custom barcode labels for shelves, clothes, boxes, or packages</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-surface-4 text-fg-subtle hover:text-fg-2 flex items-center justify-center transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content Body: Sidebar Controls + Live Preview */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-12 overflow-hidden">
          
          {/* Controls Panel (5 cols) */}
          <div className="md:col-span-5 p-5 border-r border-line-subtle space-y-4 overflow-y-auto custom-scrollbar bg-surface">
            
            {/* Product Picker */}
            <div>
              <label className="block text-xs font-bold text-fg-3 uppercase tracking-wider mb-1.5">Select Product</label>
              <select
                value={selectedProduct?.id || ''}
                onChange={(e) => {
                  const p = products.find(prod => String(prod.id) === e.target.value)
                  setSelectedProduct(p || null)
                }}
                className="w-full px-3.5 py-2 border border-line rounded-xl text-sm font-semibold text-fg bg-surface focus:ring-2 focus:ring-primary outline-none transition"
              >
                {products.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.sku ? `(${p.sku})` : ''} - Rs. {p.sale_price}
                  </option>
                ))}
              </select>
            </div>

            {/* Sticker Quantity */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-fg-3 uppercase tracking-wider mb-1.5">Sticker Count</label>
                <input
                  type="number"
                  min="1"
                  max="500"
                  value={quantity}
                  onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full px-3.5 py-2 border border-line rounded-xl text-sm font-bold text-fg focus:ring-2 focus:ring-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-fg-3 uppercase tracking-wider mb-1.5">Price (Rs.)</label>
                <input
                  type="number"
                  placeholder={selectedProduct?.sale_price || '0'}
                  value={customPrice}
                  onChange={e => setCustomPrice(e.target.value)}
                  className="w-full px-3.5 py-2 border border-line rounded-xl text-sm font-bold text-primary-fg focus:ring-2 focus:ring-primary outline-none"
                />
              </div>
            </div>

            {/* Paper / Roll Format */}
            <div>
              <label className="block text-xs font-bold text-fg-3 uppercase tracking-wider mb-1.5">Print Sheet / Roll Format</label>
              <select
                value={labelFormat}
                onChange={e => setLabelFormat(e.target.value)}
                className="w-full px-3.5 py-2 border border-line rounded-xl text-sm font-semibold text-fg bg-surface focus:ring-2 focus:ring-primary outline-none transition"
              >
                <option value="thermal-50x25">Thermal Roll (50mm × 25mm) - Standard</option>
                <option value="thermal-40x30">Thermal Roll (40mm × 30mm) - Compact</option>
                <option value="a4-24">A4 Sheet (24 Labels - 3×8 grid)</option>
                <option value="a4-30">A4 Sheet (30 Labels - 3×10 grid)</option>
              </select>
            </div>

            {/* Toggles */}
            <div className="pt-2 border-t border-line-subtle space-y-2.5">
              <span className="block text-xs font-bold text-fg-muted uppercase tracking-wider">Include on Label</span>
              
              <label className="flex items-center gap-2.5 text-xs font-bold text-fg-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showShopName}
                  onChange={e => setShowShopName(e.target.checked)}
                  className="w-4 h-4 text-primary-fg rounded border-line-strong focus:ring-primary"
                />
                <span>Store Name ({shopName})</span>
              </label>

              <label className="flex items-center gap-2.5 text-xs font-bold text-fg-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showPrice}
                  onChange={e => setShowPrice(e.target.checked)}
                  className="w-4 h-4 text-primary-fg rounded border-line-strong focus:ring-primary"
                />
                <span>Sale Price (Rs. {activePrice.toLocaleString()})</span>
              </label>

              <label className="flex items-center gap-2.5 text-xs font-bold text-fg-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showSku}
                  onChange={e => setShowSku(e.target.checked)}
                  className="w-4 h-4 text-primary-fg rounded border-line-strong focus:ring-primary"
                />
                <span>SKU / Barcode Digits</span>
              </label>
            </div>

          </div>

          {/* Live Preview Panel (7 cols) */}
          <div className="md:col-span-7 bg-surface-3 p-5 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-fg-muted uppercase tracking-wider flex items-center gap-1.5">
                <Layers size={14} /> Live Print Preview ({quantity} Stickers)
              </span>
              <span className="text-[11px] font-semibold text-fg-subtle bg-surface px-2 py-0.5 rounded-md border border-line">
                Format: {labelFormat}
              </span>
            </div>

            {/* Preview Box */}
            <div className="flex-1 bg-surface border border-line rounded-xl p-4 overflow-y-auto custom-scrollbar flex items-start justify-center shadow-inner">
              <div
                ref={printAreaRef}
                className={
                  labelFormat === 'a4-24'
                    ? 'a4-grid-24 w-full'
                    : labelFormat === 'a4-30'
                      ? 'a4-grid-30 w-full'
                      : 'flex flex-wrap gap-2 justify-center w-full'
                }
              >
                {labelList.map((idx) => renderSingleLabel(idx))}
              </div>
            </div>

            <p className="text-[11px] text-fg-subtle text-center mt-2">
              💡 Tip: In print dialog, set Margins to <strong>None</strong> and Scale to <strong>100%</strong> for exact alignment.
            </p>
          </div>

        </div>

        {/* Footer Actions */}
        <div className="px-6 py-3.5 border-t border-line-subtle bg-surface-2 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-fg-3 hover:text-fg hover:bg-surface-3 rounded-xl transition"
          >
            Cancel
          </button>
          
          <button
            onClick={handlePrint}
            className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-xl font-black text-sm flex items-center gap-2 shadow-lg shadow-primary/20 hover:shadow-primary/30 transition cursor-pointer"
          >
            <Printer size={16} />
            Print {quantity} Label{quantity > 1 ? 's' : ''}
          </button>
        </div>

      </div>
    </div>
  )
}
