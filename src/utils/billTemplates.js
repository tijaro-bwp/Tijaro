import { BRAND } from '../config/brand.js'
// ============================================================
// Bill Templates Utility — 3 templates × 2 sizes (80mm / A4)
// Usage: buildBillHTML(r, isQuotation, shopSettings)
// ============================================================

const safeNum = (v) => Number(v || 0)
const safeStr = (v, fb = '') => v || fb
// Wholesale bills (sale.price_tier === 'wholesale') get a distinct title
const isWholesaleBill = (r) => r?.sale?.price_tier === 'wholesale'

// Print script — works in both window.open popup AND hidden iframe.
// Note: window.close() is intentionally omitted — iframe doesn't need it.
const printScript = `<script>
window.onload = function() {
  var imgs = document.images;
  if (!imgs.length) { setTimeout(function(){ window.print(); }, 500); return; }
  var n = 0;
  function done() { if (++n >= imgs.length) setTimeout(function(){ window.print(); }, 400); }
  for (var i = 0; i < imgs.length; i++) {
    if (imgs[i].complete) done(); else { imgs[i].onload = done; imgs[i].onerror = done; }
  }
};<\/script>`

// Build item rows for both sizes
function itemRows(items, thermal) {
  return items.map(i => {
    const price = safeNum(i.custom_price ?? i.unit_price ?? i.price)
    const qty   = safeNum(i.qty ?? i.quantity)
    const amt   = price * qty
    const name  = `${safeStr(i.name)}${i.brand ? ` (${i.brand})` : ''}`
    const skuLine = i.sku ? `<span style="display:block;font-size:0.72em;color:#aaa;font-style:italic">${i.sku}</span>` : ''
    if (thermal) {
      return `<tr>
        <td style="padding:3px 0;vertical-align:top;max-width:130px;word-break:break-word">${name}${skuLine}</td>
        <td style="padding:3px 4px;text-align:right;white-space:nowrap">${qty}×${price.toFixed(0)}</td>
        <td style="padding:3px 0;text-align:right;font-weight:bold;white-space:nowrap">${amt.toFixed(0)}</td>
      </tr>`
    }
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${name}${skuLine}</td>
      <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0f0f0">${qty}</td>
      <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0f0f0">Rs. ${price.toFixed(0)}</td>
      <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0f0f0;font-weight:600">Rs. ${amt.toFixed(0)}</td>
    </tr>`
  }).join('')
}

function paymentLine(r) {
  if (!r.sale) return ''
  if (r.sale.payment_type === 'split' && r.sale.payment_details?.length) {
    return r.sale.payment_details.map(p => {
      const provStr = p.provider ? ` [${String(p.provider).toUpperCase()}]` : ''
      const refStr = p.ref ? ` (TID: ${p.ref})` : ''
      return `<p style="margin:1px 0;padding-left:8px;font-size:0.85em">— ${String(p.method).toUpperCase()}${provStr}${refStr}: Rs. ${safeNum(p.amount).toFixed(0)}</p>`
    }).join('')
  }
  const firstDetail = Array.isArray(r.sale.payment_details) && r.sale.payment_details[0]
  const prov = firstDetail?.provider || r.sale.online_provider
  const provStr = prov ? ` [${String(prov).toUpperCase()}]` : ''
  const ref = firstDetail?.ref || r.sale.transaction_ref
  const refStr = ref ? ` (TID: ${ref})` : ''
  const typeStr = String(r.sale.payment_type || r.paymentType || 'Cash').toUpperCase()
  return `<p style="margin:2px 0">Payment: ${typeStr}${provStr}${refStr}</p>`
}

function customerLine(r) {
  if (r.customer) return `${r.customer.name}${r.customer.phone ? ' · ' + r.customer.phone : ''}`
  if (r.walkInName) return `${r.walkInName} (Walk-in)`
  return 'Walk-in Customer'
}

// ── TEMPLATE 1 — SIMPLE / MINIMAL ────────────────────────────
function template1(r, isQuotation, s, isPurchase = false) {
  const isThermal = s.print_size !== 'a4'
  const footer = isPurchase ? '' : (isQuotation ? safeStr(s.quotation_footer, 'یہ صرف قیمت نامہ ہے') : safeStr(s.invoice_footer, 'شکریہ! دوبارہ تشریف لائیں'))
  const invoiceNo = isPurchase ? `PR-${String(r.sale?.id ?? Date.now()).slice(-8)}` : ((!isQuotation && r.sale?.invoice_number) || `${isQuotation ? 'QT' : (s.invoice_prefix || 'INV')}-${String(r.sale?.id ?? Date.now()).slice(-8)}`)
  const dateStr = r.sale?.created_at ? new Date(r.sale.created_at).toLocaleString('en-PK') : new Date().toLocaleString('en-PK')
  const remaining = r.sale ? safeNum(r.total) - safeNum(r.sale.paid_amount) : 0

  if (isThermal) {
    return `<html><head><title>${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Receipt' : 'Receipt'))}</title>
    <style>
      @page{size:80mm auto;margin:2mm}
      *{box-sizing:border-box}
      body{font-family:monospace;width:302px;margin:0 auto;padding:10px 8px;font-size:12px;background:#fff}
      p{margin:2px 0;line-height:1.4}
      .c{text-align:center} .r{text-align:right}
      .dot{border-top:1px dashed #000;margin:6px 0}
      table{width:100%;border-collapse:collapse}
      .tot{font-size:1.15em;font-weight:bold}
    </style></head><body>
    <p class="c" style="font-size:1.4em;font-weight:bold;margin-bottom:4px">${safeStr(s.name, 'Shop')}</p>
    ${s.address ? `<p class="c" style="font-size:0.9em">${s.address}</p>` : ''}
    ${s.phone ? `<p class="c" style="font-size:0.9em">Ph: ${s.phone}</p>` : ''}
    ${s.tax_number ? `<p class="c" style="font-size:0.85em;font-weight:bold">${s.tax_number}</p>` : ''}
    <div class="dot"></div>
    <p>${isPurchase ? 'PURCHASE RECORD' : (isQuotation ? 'QUOTATION' : (isWholesaleBill(r) ? 'WHOLESALE RECEIPT' : 'RECEIPT'))}: ${invoiceNo}</p>
    <p>${dateStr}</p>
    <p>${isPurchase ? 'Supplier' : 'Customer'}: ${customerLine(r)}</p>
    ${r.sale?.created_by ? `<p>Cashier: ${r.sale.created_by}</p>` : ''}
    <div class="dot"></div>
    <table>${itemRows(r.items, true)}</table>
    <div class="dot"></div>
    ${r.totalDiscount > 0 ? `<p class="r">Discount: -Rs. ${safeNum(r.totalDiscount).toFixed(0)}</p>` : ''}
    <p class="r tot">TOTAL: Rs. ${safeNum(r.total).toFixed(0)}</p>
    ${!isQuotation && remaining > 0 ? `<p class="r" style="color:red">Balance: Rs. ${remaining.toFixed(0)}</p>` : ''}
    ${!isQuotation && remaining <= 0 ? `<p class="r" style="color:green;font-weight:bold">✓ PAID</p>` : ''}
    <div class="dot"></div>
    <p class="c" style="font-size:1.1em;margin-top:6px">${footer}</p>
    ${printScript}</body></html>`
  }

  // A4 Simple
  return `<html><head><title>${isPurchase ? 'Purchase Invoice' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Invoice' : 'Invoice'))}</title>
  <style>
    @page{size:A4 portrait;margin:15mm}
    *{box-sizing:border-box;print-color-adjust:exact;-webkit-print-color-adjust:exact}
    body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0;color:#333;font-size:14px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:16px;margin-bottom:24px}
    .shop-name{font-size:24px;font-weight:800;letter-spacing:-0.5px}
    .inv-box{text-align:right}
    .inv-no{font-size:18px;font-weight:700}
    table{width:100%;border-collapse:collapse;margin:16px 0}
    th{background:#f5f5f5;padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #ddd}
    th:last-child,td:last-child{text-align:right}
    tr:last-child td{border-bottom:none}
    .totals{margin-left:auto;width:260px;border-top:2px solid #333;padding-top:12px}
    .tot-row{display:flex;justify-content:space-between;padding:4px 0}
    .grand{font-size:18px;font-weight:800;border-top:1px solid #ddd;padding-top:8px;margin-top:4px}
    .footer-line{margin-top:40px;border-top:1px solid #ddd;padding-top:12px;text-align:center;font-size:13px;color:#666}
  </style></head><body>
  <div class="header">
    <div>
      ${s.logo_url ? `<img src="${s.logo_url}" style="max-height:60px;margin-bottom:8px;display:block">` : ''}
      <div class="shop-name">${safeStr(s.name, 'Shop')}</div>
      ${s.address ? `<div style="font-size:13px;color:#666;margin-top:2px">${s.address}</div>` : ''}
      ${s.phone ? `<div style="font-size:13px;color:#666">Ph: ${s.phone}</div>` : ''}
      ${s.tax_number ? `<div style="font-size:12px;color:#444;font-weight:600">${s.tax_number}</div>` : ''}
    </div>
    <div class="inv-box">
      <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px">${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Invoice' : 'Invoice'))}</div>
      <div class="inv-no"># ${invoiceNo}</div>
      <div style="font-size:13px;color:#666;margin-top:6px">${dateStr}</div>
      <div style="font-size:13px;margin-top:4px"><b>${isPurchase ? 'Supplier' : 'Customer'}:</b> ${customerLine(r)}</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${itemRows(r.items, false)}</tbody>
  </table>
  <div class="totals">
    ${r.totalDiscount > 0 ? `<div class="tot-row"><span>Discount</span><span>-Rs. ${safeNum(r.totalDiscount).toFixed(0)}</span></div>` : ''}
    <div class="tot-row grand"><span>TOTAL</span><span>Rs. ${safeNum(r.total).toFixed(0)}</span></div>
    ${!isQuotation && remaining > 0 ? `<div class="tot-row" style="color:red"><span>Balance Due</span><span>Rs. ${remaining.toFixed(0)}</span></div>` : ''}
    ${!isQuotation && remaining <= 0 ? `<div class="tot-row" style="color:green"><span>Status</span><span>✓ PAID IN FULL</span></div>` : ''}
  </div>
  <div class="footer-line">${footer}</div>
  ${printScript}</body></html>`
}

// ── TEMPLATE 2 — CLASSIC (enhanced current style) ────────────
function template2(r, isQuotation, s, isPurchase = false) {
  const isThermal = s.print_size !== 'a4'
  const footer = isPurchase ? '' : (isQuotation ? safeStr(s.quotation_footer, 'یہ صرف قیمت نامہ ہے') : safeStr(s.invoice_footer, 'شکریہ! دوبارہ تشریف لائیں'))
  const invoiceNo = isPurchase ? `PR-${String(r.sale?.id ?? Date.now()).slice(-8)}` : ((!isQuotation && r.sale?.invoice_number) || `${isQuotation ? 'QT' : (s.invoice_prefix || 'INV')}-${String(r.sale?.id ?? Date.now()).slice(-8)}`)
  const dateStr = r.sale?.created_at ? new Date(r.sale.created_at).toLocaleString('en-PK') : new Date().toLocaleString('en-PK')
  const remaining = r.sale ? safeNum(r.total) - safeNum(r.sale.paid_amount) : 0

  if (isThermal) {
    return `<html><head><title>${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Receipt' : 'Receipt'))}</title>
    <style>
      @page{size:80mm auto;margin:2mm}
      *{box-sizing:border-box}
      body{font-family:monospace;width:302px;margin:0 auto;padding:12px 8px;font-size:12px;background:#fff}
      p{margin:2px 0;line-height:1.5}
      .c{text-align:center} .r{text-align:right} .b{font-weight:bold}
      hr{border:none;border-top:1px dashed #000;margin:6px 0}
      table{width:100%;border-collapse:collapse}
      th{text-align:left;font-size:0.9em;border-bottom:1px dashed #000;padding:3px 0}
      th:last-child{text-align:right} th:nth-child(2){text-align:right}
    </style></head><body>
    ${s.logo_url ? `<img src="${s.logo_url}" style="display:block;margin:0 auto 6px;max-width:80px;max-height:60px">` : ''}
    <p class="c b" style="font-size:1.3em">${safeStr(s.name, 'Shop')}</p>
    ${s.address ? `<p class="c">${s.address}</p>` : ''}
    ${s.phone ? `<p class="c">Ph: ${s.phone}</p>` : ''}
    ${s.tax_number ? `<p class="c" style="font-size:0.85em;font-weight:bold">${s.tax_number}</p>` : ''}
    <hr/>
    <p class="c b">${isPurchase ? '— PURCHASE RECORD —' : (isQuotation ? '— QUOTATION —' : (isWholesaleBill(r) ? '— WHOLESALE RECEIPT —' : '— RECEIPT —'))}</p>
    <p>#: ${invoiceNo}</p>
    <p>Date: ${dateStr}</p>
    ${r.sale?.created_by ? `<p>Cashier: ${r.sale.created_by}</p>` : ''}
    <p>${isPurchase ? 'Supplier' : 'Customer'}: ${customerLine(r)}</p>
    ${paymentLine(r)}
    <hr/>
    <table>
      <thead><tr><th>Item</th><th style="text-align:right">Qty×Rate</th><th style="text-align:right">Amt</th></tr></thead>
      <tbody>${itemRows(r.items, true)}</tbody>
    </table>
    <hr/>
    <table style="width:180px;margin-left:auto">
      <tr><td>Subtotal</td><td class="r">Rs. ${safeNum(r.subtotal ?? r.total).toFixed(0)}</td></tr>
      ${r.totalDiscount > 0 ? `<tr><td>Discount</td><td class="r">-Rs. ${safeNum(r.totalDiscount).toFixed(0)}</td></tr>` : ''}
      <tr><td class="b">TOTAL</td><td class="r b" style="font-size:1.1em">Rs. ${safeNum(r.total).toFixed(0)}</td></tr>
      ${!isQuotation && r.sale?.paid_amount ? `<tr><td>Paid</td><td class="r">Rs. ${safeNum(r.sale.paid_amount).toFixed(0)}</td></tr>` : ''}
      ${!isQuotation && remaining > 0 ? `<tr style="color:red"><td class="b">Balance</td><td class="r b">Rs. ${remaining.toFixed(0)}</td></tr>` : ''}
      ${!isQuotation && r.change > 0 ? `<tr style="color:green"><td>Change</td><td class="r">Rs. ${safeNum(r.change).toFixed(0)}</td></tr>` : ''}
    </table>
    <hr/>
    <p class="c" style="font-size:1.1em;font-weight:bold;margin-top:8px">${footer}</p>
    ${printScript}</body></html>`
  }

  // A4 Classic
  return `<html><head><title>${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Invoice' : 'Invoice'))}</title>
  <style>
    @page{size:A4 portrait;margin:12mm}
    *{box-sizing:border-box;print-color-adjust:exact;-webkit-print-color-adjust:exact}
    body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0;color:#333;font-size:14px}
    .page{padding:24px;max-width:100%;margin:auto}
    .header-box{background:#1e3a5f;color:#fff;padding:20px 24px}
    .shop-name{font-size:24px;font-weight:800}
    .inv-badge{background:rgba(255,255,255,0.2);padding:10px 16px;border-radius:8px;text-align:right;min-width:160px}
    .meta{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e5e7eb;margin-bottom:14px}
    table{width:100%;border-collapse:collapse}
    thead tr{background:#f3f4f6}
    th{padding:9px 12px;text-align:left;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#555;border-bottom:2px solid #e5e7eb}
    td{padding:8px 12px;border-bottom:1px solid #f0f0f0}
    th:not(:first-child),td:not(:first-child){text-align:right}
    .tot-section{margin-top:8px;display:flex;justify-content:flex-end}
    .tot-box{width:240px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
    .tot-row{display:flex;justify-content:space-between;padding:7px 12px;border-bottom:1px solid #f0f0f0}
    .tot-row:last-child{border-bottom:none;background:#1e3a5f;color:#fff;font-weight:700;font-size:15px}
    .footer-area{margin-top:24px;padding-top:10px;border-top:1px dashed #ccc;display:flex;justify-content:space-between;align-items:flex-end}
    @media print{.page{padding:0}}
  </style></head><body><div class="page">
  <div class="header-box" style="display:flex;justify-content:space-between;align-items:center">
    <div>
      ${s.logo_url ? `<img src="${s.logo_url}" style="max-height:55px;margin-bottom:8px;display:block;filter:brightness(10)">` : ''}
      <div class="shop-name">${safeStr(s.name, 'Shop')}</div>
      <div style="font-size:13px;opacity:0.85;margin-top:4px">${[s.address, s.phone, s.tax_number].filter(Boolean).join(' · ')}</div>
    </div>
    <div class="inv-badge">
      <div style="font-size:11px;opacity:0.8;letter-spacing:1px">${isPurchase ? 'PURCHASE RECORD' : (isQuotation ? 'QUOTATION' : (isWholesaleBill(r) ? 'WHOLESALE INVOICE' : 'INVOICE'))}</div>
      <div style="font-size:22px;font-weight:800">#${invoiceNo}</div>
      <div style="font-size:12px;opacity:0.8;margin-top:4px">${dateStr}</div>
    </div>
  </div>
  <div class="meta">
    <div>
      <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">${isPurchase ? 'Supplier' : 'Bill To'}</div>
      <div style="font-weight:600;font-size:15px">${customerLine(r)}</div>
    </div>
    ${r.sale?.created_by ? `<div style="text-align:right"><div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Cashier</div><div style="font-weight:600">${r.sale.created_by}</div></div>` : ''}
  </div>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
    <tbody>${itemRows(r.items, false)}</tbody>
  </table>
  <div class="tot-section">
    <div class="tot-box">
      ${r.totalDiscount > 0 ? `<div class="tot-row"><span>Discount</span><span>-Rs. ${safeNum(r.totalDiscount).toFixed(0)}</span></div>` : ''}
      ${!isQuotation && r.sale?.paid_amount ? `<div class="tot-row"><span>Paid</span><span>Rs. ${safeNum(r.sale.paid_amount).toFixed(0)}</span></div>` : ''}
      ${!isQuotation && remaining > 0 ? `<div class="tot-row" style="color:#dc2626"><span>Balance Due</span><span>Rs. ${remaining.toFixed(0)}</span></div>` : ''}
      <div class="tot-row"><span>TOTAL</span><span>Rs. ${safeNum(r.total).toFixed(0)}</span></div>
    </div>
  </div>
  <div class="footer-area">
    <div style="font-size:13px;color:#666;font-style:italic">${footer}</div>
  </div>
  </div>${printScript}</body></html>`
}

// ── TEMPLATE 3 — PROFESSIONAL ────────────────────────────────
function template3(r, isQuotation, s, isPurchase = false) {
  const isThermal = s.print_size !== 'a4'
  const footer = isPurchase ? '' : (isQuotation ? safeStr(s.quotation_footer, 'یہ صرف قیمت نامہ ہے') : safeStr(s.invoice_footer, 'شکریہ! دوبارہ تشریف لائیں'))
  const invoiceNo = isPurchase ? `PR-${String(r.sale?.id ?? Date.now()).slice(-8)}` : ((!isQuotation && r.sale?.invoice_number) || `${isQuotation ? 'QT' : (s.invoice_prefix || 'INV')}-${String(r.sale?.id ?? Date.now()).slice(-8)}`)
  const dateStr = r.sale?.created_at ? new Date(r.sale.created_at).toLocaleString('en-PK') : new Date().toLocaleString('en-PK')
  const remaining = r.sale ? safeNum(r.total) - safeNum(r.sale.paid_amount) : 0

  if (isThermal) {
    return `<html><head><title>${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Receipt' : 'Receipt'))}</title>
    <style>
      @page{size:80mm auto;margin:2mm}
      *{box-sizing:border-box}
      body{font-family:monospace;width:302px;margin:0 auto;padding:10px 6px;font-size:12px;background:#fff;position:relative}
      p{margin:2px 0;line-height:1.5}
      .c{text-align:center} .r{text-align:right} .b{font-weight:bold}
      hr{border:none;border-top:1px dashed #000;margin:5px 0}
      .double{border-top:3px double #000}
      table{width:100%;border-collapse:collapse}
      th{font-size:0.85em;border-bottom:1px solid #000;padding:2px 0}
      th:not(:first-child){text-align:right}
      .box{border:1px solid #000;padding:3px 6px;display:inline-block}
    </style></head><body>
    ${s.logo_url ? `<img src="${s.logo_url}" style="display:block;margin:0 auto 4px;max-width:70px;max-height:55px">` : ''}
    <p class="c b" style="font-size:1.35em;letter-spacing:1px">${safeStr(s.name, 'Shop')}</p>
    ${s.address ? `<p class="c" style="font-size:0.9em">${s.address}</p>` : ''}
    ${s.phone ? `<p class="c" style="font-size:0.9em">☎ ${s.phone}</p>` : ''}
    <hr class="double" style="margin:8px 0"/>
    <p class="c b">${isPurchase ? '✦ PURCHASE RECORD ✦' : (isQuotation ? '✦ QUOTATION ✦' : (isWholesaleBill(r) ? '✦ WHOLESALE RECEIPT ✦' : '✦ SALES RECEIPT ✦'))}</p>
    <hr/>
    <table style="width:100%;font-size:0.9em"><tbody>
      <tr><td>${isPurchase ? 'Purchase #' : 'Invoice #'}</td><td class="r"><span class="box">${invoiceNo}</span></td></tr>
      <tr><td>Date</td><td class="r">${dateStr}</td></tr>
      ${r.sale?.created_by ? `<tr><td>Cashier</td><td class="r">${r.sale.created_by}</td></tr>` : ''}
      <tr><td>${isPurchase ? 'Supplier' : 'Customer'}</td><td class="r" style="max-width:140px;word-break:break-word">${customerLine(r)}</td></tr>
    </tbody></table>
    <hr/>
    <p class="b" style="font-size:0.85em;text-decoration:underline">ITEMS (${r.items.length} total):</p>
    <table>
      <thead><tr><th style="text-align:left">Item</th><th>Qty×Rate</th><th>Amt</th></tr></thead>
      <tbody>${itemRows(r.items, true)}</tbody>
    </table>
    <hr class="double" style="margin:6px 0"/>
    <table style="width:190px;margin-left:auto;font-size:0.95em">
      <tr><td>Subtotal</td><td class="r">Rs. ${safeNum(r.subtotal ?? r.total).toFixed(0)}</td></tr>
      ${r.totalDiscount > 0 ? `<tr><td>Discount</td><td class="r" style="color:green">-Rs. ${safeNum(r.totalDiscount).toFixed(0)}</td></tr>` : ''}
      <tr style="font-size:1.15em"><td class="b">NET TOTAL</td><td class="r b">Rs. ${safeNum(r.total).toFixed(0)}</td></tr>
      ${!isQuotation && r.sale?.paid_amount ? `<tr><td>Amount Paid</td><td class="r" style="color:green">Rs. ${safeNum(r.sale.paid_amount).toFixed(0)}</td></tr>` : ''}
      ${!isQuotation && remaining > 0 ? `<tr style="color:red"><td class="b">BALANCE DUE</td><td class="r b">Rs. ${remaining.toFixed(0)}</td></tr>` : ''}
      ${!isQuotation && r.change > 0 ? `<tr style="color:blue"><td>Change</td><td class="r">Rs. ${safeNum(r.change).toFixed(0)}</td></tr>` : ''}
    </table>
    ${paymentLine(r)}
    <hr class="double" style="margin:8px 0"/>
    <p class="c b" style="font-size:1.15em">${footer}</p>
    <p class="c" style="font-size:0.8em;color:#666;margin-top:6px">★ Thank you for your business ★</p>
    ${printScript}</body></html>`
  }

  // A4 Professional
  return `<html><head><title>${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Invoice' : 'Invoice'))}</title>
  <style>
    @page{size:A4 portrait;margin:0}
    *{box-sizing:border-box;print-color-adjust:exact;-webkit-print-color-adjust:exact}
    body{font-family:'Segoe UI',Arial,sans-serif;margin:0;color:#1a1a2e;font-size:13px;background:#fff}
    .page{padding:0;max-width:794px;margin:auto;display:flex;flex-direction:column}
    .letterhead{background:linear-gradient(135deg,#1e3a5f 0%,#2d6a9f 100%);padding:24px 32px;color:#fff}
    .letterhead-row{display:flex;justify-content:space-between;align-items:center;gap:16px}
    .shop-name{font-size:24px;font-weight:900;letter-spacing:-0.5px}
    .inv-number-box{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:10px;padding:12px 18px;text-align:center;min-width:160px;flex-shrink:0}
    .body-section{padding:20px 32px;flex:1}
    .info-row{display:flex;gap:16px;margin-bottom:18px;padding:14px 18px;background:#f8fafc;border-radius:8px;border:1px solid #e8edf2}
    .info-cell{flex:1}
    .info-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;margin-bottom:3px}
    .info-value{font-size:13px;font-weight:600;color:#1e293b}
    table{width:100%;border-collapse:collapse;margin-bottom:18px}
    thead tr{background:#1e3a5f;color:#fff}
    th{padding:9px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;text-align:left}
    td{padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px}
    tbody tr:nth-child(even){background:#f8fafc}
    tbody tr:last-child td{border-bottom:2px solid #e2e8f0}
    th:not(:first-child),td:not(:first-child){text-align:right}
    .totals-wrap{display:flex;justify-content:flex-end}
    .totals-card{width:260px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
    .totals-card-header{background:#f8fafc;padding:8px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#64748b;border-bottom:1px solid #e2e8f0}
    .tot-r{display:flex;justify-content:space-between;padding:7px 14px;border-bottom:1px solid #f1f5f9;font-size:13px}
    .grand-r{display:flex;justify-content:space-between;padding:10px 14px;background:#1e3a5f;color:#fff;font-weight:800;font-size:15px}
    .footer-section{margin-top:20px;border-top:1px solid #e2e8f0;padding:16px 32px;display:flex;justify-content:space-between;align-items:flex-end;background:#f8fafc}
    .sig-line{border-top:1px solid #333;width:140px;padding-top:5px;font-size:11px;color:#666;text-align:center}
    @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><div class="page">
  <div class="letterhead">
    <div class="letterhead-row">
      <div>
        ${s.logo_url ? `<img src="${s.logo_url}" style="max-height:55px;margin-bottom:8px;display:block;filter:brightness(10)">` : ''}
        <div class="shop-name">${safeStr(s.name, 'Shop')}</div>
        ${s.address ? `<div style="font-size:12px;opacity:0.8;margin-top:5px">📍 ${s.address}</div>` : ''}
        ${s.phone ? `<div style="font-size:12px;opacity:0.8">☎ ${s.phone}</div>` : ''}
      </div>
      <div class="inv-number-box">
        <div style="font-size:10px;opacity:0.8;letter-spacing:1px;margin-bottom:5px">${isPurchase ? 'PURCHASE RECORD' : (isQuotation ? 'QUOTATION' : (isWholesaleBill(r) ? 'WHOLESALE TAX INVOICE' : 'TAX INVOICE'))}</div>
        <div style="font-size:20px;font-weight:900"># ${invoiceNo}</div>
        <div style="font-size:11px;opacity:0.75;margin-top:5px">${dateStr}</div>
      </div>
    </div>
  </div>
  <div class="body-section">
    <div class="info-row">
      <div class="info-cell">
        <div class="info-label">${isPurchase ? 'Supplier' : 'Bill To'}</div>
        <div class="info-value">${customerLine(r)}</div>
      </div>
      <div class="info-cell">
        <div class="info-label">Cashier</div>
        <div class="info-value">${safeStr(r.sale?.created_by, 'Staff')}</div>
      </div>
      ${!isQuotation && r.sale?.payment_type ? `
      <div class="info-cell">
        <div class="info-label">Payment</div>
        <div class="info-value">${String(r.sale.payment_type).toUpperCase()}</div>
      </div>` : ''}
      ${!isQuotation && remaining > 0 ? `
      <div class="info-cell">
        <div class="info-label">Balance Due</div>
        <div class="info-value" style="color:#dc2626">Rs. ${remaining.toFixed(0)}</div>
      </div>` : ''}
    </div>
    <table>
      <thead><tr><th>#</th><th style="text-align:left">Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
      <tbody>
        ${r.items.map((i, idx) => {
          const price = safeNum(i.custom_price ?? i.unit_price ?? i.price)
          const qty   = safeNum(i.qty ?? i.quantity)
          return `<tr>
            <td style="color:#94a3b8;font-size:11px">${idx + 1}</td>
            <td>${safeStr(i.name)}${i.brand ? `<br><span style="font-size:11px;color:#94a3b8">${i.brand}</span>` : ''}</td>
            <td style="text-align:right">${qty}</td>
            <td style="text-align:right">Rs. ${price.toFixed(0)}</td>
            <td style="text-align:right;font-weight:600">Rs. ${(price * qty).toFixed(0)}</td>
          </tr>`
        }).join('')}
      </tbody>
    </table>
    <div class="totals-wrap">
      <div class="totals-card">
        <div class="totals-card-header">Summary</div>
        <div class="tot-r"><span>Subtotal (${r.items.length} items)</span><span>Rs. ${safeNum(r.subtotal ?? r.total).toFixed(0)}</span></div>
        ${r.totalDiscount > 0 ? `<div class="tot-r" style="color:#16a34a"><span>Discount</span><span>-Rs. ${safeNum(r.totalDiscount).toFixed(0)}</span></div>` : ''}
        ${!isQuotation && r.sale?.paid_amount ? `<div class="tot-r"><span>Amount Paid</span><span>Rs. ${safeNum(r.sale.paid_amount).toFixed(0)}</span></div>` : ''}
        ${!isQuotation && remaining > 0 ? `<div class="tot-r" style="color:#dc2626;font-weight:700"><span>Balance Due</span><span>Rs. ${remaining.toFixed(0)}</span></div>` : ''}
        <div class="grand-r"><span>TOTAL</span><span>Rs. ${safeNum(r.total).toFixed(0)}</span></div>
      </div>
    </div>
  </div>
  <div class="footer-section">
    <div>
      <div style="font-weight:700;color:#1e3a5f;font-size:14px">${footer}</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:3px">★ Thank you for your business ★</div>
    </div>
    <div style="text-align:center">
      <div class="sig-line">Authorized Signature</div>
    </div>
  </div>
  </div>${printScript}</body></html>`
}


// ── TEMPLATE 4 — MODERN ──────────────────────────────────────
function template4(r, isQuotation, s, isPurchase = false) {
  const isThermal = s.print_size !== 'a4'
  const footer = isPurchase ? '' : (isQuotation ? safeStr(s.quotation_footer, 'یہ صرف قیمت نامہ ہے') : safeStr(s.invoice_footer, 'شکریہ! دوبارہ تشریف لائیں'))
  const invoiceNo = isPurchase ? `PR-${String(r.sale?.id ?? Date.now()).slice(-8)}` : ((!isQuotation && r.sale?.invoice_number) || `${isQuotation ? 'QT' : (s.invoice_prefix || 'INV')}-${String(r.sale?.id ?? Date.now()).slice(-8)}`)
  const dateStr = r.sale?.created_at ? new Date(r.sale.created_at).toLocaleString('en-PK') : new Date().toLocaleString('en-PK')
  const remaining = r.sale ? safeNum(r.total) - safeNum(r.sale.paid_amount) : 0

  if (isThermal) {
    return `<html><head><title>${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Receipt' : 'Receipt'))}</title>
    <style>
      @page{size:80mm auto;margin:1.5mm}
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:system-ui,-apple-system,sans-serif;width:302px;margin:0 auto;padding:12px 6px;font-size:12px;color:#1e293b;background:#fff;line-height:1.4}
      p{margin:3px 0}
      .c{text-align:center} .r{text-align:right} .b{font-weight:700}
      .line{border-top:1px solid #cbd5e1;margin:8px 0}
      .header-card{text-align:center;margin-bottom:8px;padding-bottom:4px}
      .shop-title{font-size:1.4em;font-weight:800;color:#0f172a;letter-spacing:-0.3px}
      .badge{display:inline-block;padding:2px 8px;background:#f1f5f9;color:#475569;border-radius:4px;font-size:0.85em;font-weight:600;text-transform:uppercase;margin:4px 0}
      table{width:100%;border-collapse:collapse;margin:4px 0}
      th{font-size:0.85em;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;padding:4px 0;text-align:left}
      th:not(:first-child){text-align:right}
      .total-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;margin:8px 0}
      .total-row{display:flex;justify-content:space-between;padding:3px 0;font-size:0.95em}
      .grand-row{display:flex;justify-content:space-between;padding:5px 0;margin-top:4px;border-top:1px solid #e2e8f0;font-weight:800;font-size:1.15em;color:#0f172a}
    </style></head><body>
    <div class="header-card">
      ${s.logo_url ? `<img src="${s.logo_url}" style="display:block;margin:0 auto 6px;max-height:55px;object-contain:true">` : ''}
      <p class="shop-title">${safeStr(s.name, 'Shop')}</p>
      ${s.address ? `<p style="font-size:0.9em;color:#64748b">${s.address}</p>` : ''}
      ${s.phone ? `<p style="font-size:0.9em;color:#64748b;font-weight:500">📞 ${s.phone}</p>` : ''}
      <span class="badge">${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Receipt' : 'Sales Receipt'))}</span>
    </div>
    <div class="line"></div>
    <div style="font-size:0.9em;color:#475569;margin-bottom:6px">
      <p><span style="color:#94a3b8">Invoice:</span> <span class="b" style="color:#0f172a">${invoiceNo}</span></p>
      <p><span style="color:#94a3b8">Date:</span> ${dateStr}</p>
      <p><span style="color:#94a3b8">Customer:</span> ${customerLine(r)}</p>
      ${r.sale?.created_by ? `<p><span style="color:#94a3b8">Cashier:</span> ${r.sale.created_by}</p>` : ''}
    </div>
    <div class="line"></div>
    <table>
      <thead><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>
        ${r.items.map(i => {
          const price = safeNum(i.custom_price ?? i.unit_price ?? i.price)
          const qty   = safeNum(i.qty ?? i.quantity)
          const amt   = price * qty
          const name  = `${safeStr(i.name)}${i.brand ? ` (${i.brand})` : ''}`
          const skuLine = i.sku ? `<span style="display:block;font-size:0.72em;color:#94a3b8;font-style:italic">${i.sku}</span>` : ''
          return `<tr>
            <td style="padding:4px 0;vertical-align:top;max-width:130px;word-break:break-word;font-weight:500">${name}${skuLine}</td>
            <td style="padding:4px 0;text-align:right;vertical-align:top">${qty}</td>
            <td style="padding:4px 0;text-align:right;vertical-align:top">${price.toFixed(0)}</td>
            <td style="padding:4px 0;text-align:right;vertical-align:top;font-weight:700;color:#0f172a">${amt.toFixed(0)}</td>
          </tr>`
        }).join('')}
      </tbody>
    </table>
    <div class="line"></div>
    <div class="total-card">
      <div class="total-row"><span>Subtotal</span><span>Rs. ${safeNum(r.subtotal ?? r.total).toFixed(0)}</span></div>
      ${r.totalDiscount > 0 ? `<div class="total-row" style="color:#16a34a"><span>Discount</span><span>-Rs. ${safeNum(r.totalDiscount).toFixed(0)}</span></div>` : ''}
      ${!isQuotation && r.sale?.paid_amount ? `<div class="total-row"><span>Amount Paid</span><span>Rs. ${safeNum(r.sale.paid_amount).toFixed(0)}</span></div>` : ''}
      ${!isQuotation && remaining > 0 ? `<div class="total-row" style="color:#dc2626;font-weight:600"><span>Balance Due</span><span>Rs. ${remaining.toFixed(0)}</span></div>` : ''}
      ${!isQuotation && r.change > 0 ? `<div class="total-row" style="color:#2563eb"><span>Change</span><span>Rs. ${safeNum(r.change).toFixed(0)}</span></div>` : ''}
      <div class="grand-row"><span>TOTAL</span><span>Rs. ${safeNum(r.total).toFixed(0)}</span></div>
    </div>
    ${paymentLine(r)}
    <div class="line"></div>
    <p class="c b" style="font-size:1.1em;color:#0f172a;margin-top:6px">${footer}</p>
    <p class="c" style="font-size:0.8em;color:#94a3b8;margin-top:4px">★ Powered by ${BRAND.companyName} ★</p>
    ${printScript}</body></html>`
  }

  // A4 Modern
  return `<html><head><title>${isPurchase ? 'Purchase Record' : (isQuotation ? 'Quotation' : (isWholesaleBill(r) ? 'Wholesale Invoice' : 'Invoice'))}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    @page{size:A4 portrait;margin:0}
    *{box-sizing:border-box;margin:0;padding:0;print-color-adjust:exact;-webkit-print-color-adjust:exact}
    body{font-family:'Inter',sans-serif;color:#0f172a;background:#f8fafc;padding:30px;font-size:13px;line-height:1.5}
    .wrapper{max-width:794px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.05),0 8px 10px -6px rgba(0,0,0,0.05);border:1px solid #f1f5f9;overflow:hidden;display:flex;flex-direction:column;min-height:920px}
    .top-bar{height:6px;background:linear-gradient(90deg,#0ea5e9 0%,#2563eb 50%,#1e3a5f 100%)}
    .header-block{padding:32px;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #f1f5f9}
    .logo-container{max-height:60px;margin-bottom:12px;display:block}
    .shop-title{font-size:24px;font-weight:800;color:#0f172a;letter-spacing:-0.5px}
    .meta-badge{background:#eff6ff;border:1px solid #dbeafe;color:#2563eb;font-weight:700;padding:4px 10px;border-radius:6px;font-size:0.85em;text-transform:uppercase;display:inline-block;margin-bottom:8px}
    .invoice-card{text-align:right}
    .inv-title{font-size:20px;font-weight:800;color:#0f172a;margin-top:4px}
    .main-body{padding:24px 32px;flex:1}
    .info-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:24px}
    .cell-label{font-size:0.75em;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px}
    .cell-val{font-size:0.95em;font-weight:600;color:#0f172a}
    table{width:100%;border-collapse:collapse;margin-bottom:24px}
    thead tr{background:#0f172a}
    th{padding:10px 14px;color:#fff;font-size:0.85em;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
    th:first-child{border-top-left-radius:8px;border-bottom-left-radius:8px}
    th:last-child{border-top-right-radius:8px;border-bottom-right-radius:8px}
    td{padding:10px 14px;border-bottom:1px solid #f1f5f9}
    tbody tr:hover{background:#fafafa}
    tbody tr:last-child td{border-bottom:none}
    th:not(:nth-child(2)),td:not(:nth-child(2)){text-align:right}
    th:nth-child(2),td:nth-child(2){text-align:left}
    .summary-section{display:flex;justify-content:flex-end}
    .summary-card{width:280px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.02)}
    .summary-row{display:flex;justify-content:space-between;padding:8px 16px;border-bottom:1px solid #f1f5f9;font-size:0.95em}
    .summary-grand{display:flex;justify-content:space-between;padding:12px 16px;background:#0f172a;color:#fff;font-weight:800;font-size:1.15em}
    .footer-block{padding:24px 32px;background:#f8fafc;border-top:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:flex-end}
    .stamp-text{font-size:11px;color:#94a3b8;margin-top:4px}
    .signature-box{text-align:center}
    .sig-line{border-top:1px solid #cbd5e1;width:150px;margin:0 auto;padding-top:6px;font-size:0.8em;color:#64748b;font-weight:500}
    @media print{body{padding:0} .wrapper{border-radius:0;box-shadow:none;border:none;min-height:auto}}
  </style></head><body><div class="wrapper">
    <div class="top-bar"></div>
    <div class="header-block">
      <div>
        ${s.logo_url ? `<img src="${s.logo_url}" class="logo-container">` : ''}
        <div class="shop-title">${safeStr(s.name, 'Shop')}</div>
        ${s.address ? `<div style="color:#64748b;font-size:0.95em;margin-top:6px">📍 ${s.address}</div>` : ''}
        ${s.phone ? `<div style="color:#64748b;font-size:0.95em">📞 ${s.phone}</div>` : ''}
      </div>
      <div class="invoice-card">
        <span class="meta-badge">${isPurchase ? 'Purchase' : (isQuotation ? 'Quotation' : 'Tax Invoice')}</span>
        <div class="inv-title"># ${invoiceNo}</div>
        <div style="color:#64748b;margin-top:6px;font-size:0.95em">${dateStr}</div>
      </div>
    </div>
    <div class="main-body">
      <div class="info-grid">
        <div class="cell">
          <div class="cell-label">${isPurchase ? 'Supplier' : 'Customer'}</div>
          <div class="cell-val">${customerLine(r)}</div>
        </div>
        <div class="cell">
          <div class="cell-label">Cashier</div>
          <div class="cell-val">${safeStr(r.sale?.created_by, 'Staff')}</div>
        </div>
        <div class="cell">
          <div class="cell-label">Payment Mode</div>
          <div class="cell-val">${!isQuotation && r.sale?.payment_type ? String(r.sale.payment_type).toUpperCase() : 'N/A'}</div>
        </div>
        <div class="cell">
          <div class="cell-label">Status</div>
          <div class="cell-val" style="color:${isQuotation ? '#f59e0b' : (remaining > 0 ? '#dc2626' : '#16a34a')}">
            ${isQuotation ? 'QUOTATION' : (remaining > 0 ? 'PARTIAL' : '✓ PAID')}
          </div>
        </div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
        <tbody>
          ${r.items.map((i, idx) => {
            const price = safeNum(i.custom_price ?? i.unit_price ?? i.price)
            const qty   = safeNum(i.qty ?? i.quantity)
            const skuLine = i.sku ? `<br><span style="font-size:0.8em;color:#94a3b8;font-style:italic">SKU: ${i.sku}</span>` : ''
            return `<tr>
              <td style="color:#94a3b8;font-size:0.9em;width:30px">${idx + 1}</td>
              <td style="font-weight:500">${safeStr(i.name)}${i.brand ? ` <span style="font-weight:400;color:#94a3b8;font-size:0.9em">(${i.brand})</span>` : ''}${skuLine}</td>
              <td>${qty}</td>
              <td>Rs. ${price.toFixed(0)}</td>
              <td style="font-weight:600;color:#0f172a">Rs. ${(price * qty).toFixed(0)}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
      <div class="summary-section">
        <div class="summary-card">
          <div class="summary-row"><span>Subtotal (${r.items.length} items)</span><span>Rs. ${safeNum(r.subtotal ?? r.total).toFixed(0)}</span></div>
          ${r.totalDiscount > 0 ? `<div class="summary-row" style="color:#16a34a;font-weight:500"><span>Discount</span><span>-Rs. ${safeNum(r.totalDiscount).toFixed(0)}</span></div>` : ''}
          ${!isQuotation && r.sale?.paid_amount ? `<div class="summary-row"><span>Paid Amount</span><span>Rs. ${safeNum(r.sale.paid_amount).toFixed(0)}</span></div>` : ''}
          ${!isQuotation && remaining > 0 ? `<div class="summary-row" style="color:#dc2626;font-weight:600"><span>Balance Due</span><span>Rs. ${remaining.toFixed(0)}</span></div>` : ''}
          <div class="summary-grand"><span>TOTAL</span><span>Rs. ${safeNum(r.total).toFixed(0)}</span></div>
        </div>
      </div>
    </div>
    <div class="footer-block">
      <div>
        <div style="font-weight:700;color:#0f172a;font-size:1.15em">${footer}</div>
        <div class="stamp-text">★ Thank you for shopping with us ★</div>
      </div>
      <div class="signature-box">
        <div class="sig-line">Authorized Signature</div>
      </div>
    </div>
  </div>${printScript}</body></html>`
}

// Customer account block (previous balance + this bill - paid = new balance),
// added under any template when the receipt carries `r.account`.
function accountBlock(a) {
  const rs = (v) => `Rs. ${Math.abs(safeNum(v)).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
  const row = (l, v, extra = '') => `<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;${extra}"><span>${l}</span><span>${v}</span></div>`
  const nb = safeNum(a.newBalance)
  return `<div style="max-width:320px;margin:12px auto 4px;border:1px dashed #555;border-radius:6px;padding:8px 10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;background:#fff">
    <div style="text-align:center;font-weight:bold;letter-spacing:.5px;margin-bottom:4px">ACCOUNT SUMMARY</div>
    ${row('Previous balance', `${safeNum(a.previous) < 0 ? '-' : ''}${rs(a.previous)}`)}
    ${row('This bill', `+ ${rs(a.bill)}`)}
    ${row('Paid', `- ${rs(a.paid)}`)}
    ${row(nb < 0 ? 'Advance with shop' : 'New balance', rs(nb), 'font-weight:bold;font-size:13px;border-top:1px solid #999;margin-top:3px;padding-top:4px')}
  </div>`
}

// ── PUBLIC API ───────────────────────────────────────────────
export function buildBillHTML(r, isQuotation = false, shopSettings = {}, isPurchase = false) {
  const template = shopSettings.print_template || localStorage.getItem(`print_template_${shopSettings.shop_id || ''}`) || localStorage.getItem('print_template') || '2'
  let html
  if (template === '1') html = template1(r, isQuotation, shopSettings, isPurchase)
  else if (template === '3') html = template3(r, isQuotation, shopSettings, isPurchase)
  else if (template === '4') html = template4(r, isQuotation, shopSettings, isPurchase)
  else html = template2(r, isQuotation, shopSettings, isPurchase)
  if (r?.account && !isQuotation && !isPurchase && html.includes(printScript)) {
    html = html.replace(printScript, accountBlock(r.account) + printScript)
  }
  return html
}

// ── SALES REPORT (daily / weekly / monthly) ──────────────────
export function buildSalesReportHTML(sales, saleItems, period, shopSettings) {
  const s = shopSettings
  const total   = sales.reduce((acc, s) => acc + safeNum(s.total_amount || s.net_amount), 0)
  const paid    = sales.reduce((acc, s) => acc + safeNum(s.amount_paid), 0)
  const balance = total - paid
  const disc    = sales.reduce((acc, s) => acc + safeNum(s.discount), 0)
  const cash    = sales.filter(s => s.payment_method === 'cash').reduce((acc, s) => acc + safeNum(s.net_amount || s.total_amount), 0)
  const card    = sales.filter(s => s.payment_method === 'card').reduce((acc, s) => acc + safeNum(s.net_amount || s.total_amount), 0)
  const credit  = sales.filter(s => s.payment_method === 'credit').reduce((acc, s) => acc + safeNum(s.net_amount || s.total_amount), 0)

  const periodLabel = {
    today: "Today's Sales Report",
    week:  "This Week's Sales Report",
    month: "This Month's Sales Report"
  }[period] || 'Sales Report'

  const rows = sales.map(sale => {
    const items = saleItems.filter(i => i.sale_id === sale.id)
    const itemCount = items.reduce((a, i) => a + safeNum(i.quantity || i.qty), 0)
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#64748b">${new Date(sale.created_at).toLocaleString('en-PK')}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-weight:600">${sale.invoice_number || `INV-${String(sale.id).slice(-8)}`}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${sale.customer_name || 'Walk-in'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${itemCount}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:12px;color:#64748b">${sale.payment_method || 'cash'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:700">Rs. ${safeNum(sale.net_amount || sale.total_amount).toFixed(0)}</td>
    </tr>`
  }).join('')

  return `<html><head><title>${periodLabel}</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:30px;color:#1a1a2e;font-size:13px}
    .header{background:#1e3a5f;color:#fff;padding:20px 28px;border-radius:10px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center}
    .shop-name{font-size:22px;font-weight:800}
    .period{font-size:13px;opacity:0.8;margin-top:4px}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
    .stat{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px}
    .stat-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8}
    .stat-value{font-size:20px;font-weight:800;color:#1e293b;margin-top:4px}
    .payment-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
    .pay-card{padding:12px 16px;border-radius:8px;font-weight:700}
    table{width:100%;border-collapse:collapse}
    thead tr{background:#1e3a5f;color:#fff}
    th{padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;text-align:left}
    th:not(:first-child):not(:nth-child(2)):not(:nth-child(3)){text-align:right}
    th:last-child{text-align:right}
    .grand-row{background:#f8fafc;font-weight:800;font-size:15px}
    .grand-row td{padding:12px;border-top:2px solid #1e3a5f}
    @media print{body{padding:10px}}
  </style></head><body>
  <div class="header">
    <div>
      <div class="shop-name">${safeStr(s?.name, 'Shop')}</div>
      ${s?.phone   ? `<div style="font-size:12px;opacity:0.85;margin-top:2px;">${s.phone}</div>` : ''}
      ${s?.address ? `<div style="font-size:11px;opacity:0.7;margin-top:1px;">${s.address}</div>` : ''}
      <div class="period">${periodLabel}</div>
      <div style="font-size:12px;opacity:0.7;margin-top:2px;">Generated: ${new Date().toLocaleString('en-PK')}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:32px;font-weight:900">${sales.length}</div>
      <div style="font-size:12px;opacity:0.8">Total Transactions</div>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-label">Total Revenue</div><div class="stat-value" style="color:#16a34a">Rs. ${total.toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Amount Collected</div><div class="stat-value" style="color:#2563eb">Rs. ${paid.toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Outstanding</div><div class="stat-value" style="color:${balance > 0 ? '#dc2626' : '#16a34a'}">Rs. ${balance.toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Total Discount</div><div class="stat-value" style="color:#f59e0b">Rs. ${disc.toFixed(0)}</div></div>
  </div>
  <div class="payment-grid">
    <div class="pay-card" style="background:#dcfce7;color:#166534">💵 Cash: Rs. ${cash.toFixed(0)}</div>
    <div class="pay-card" style="background:#dbeafe;color:#1e40af">💳 Card: Rs. ${card.toFixed(0)}</div>
    <div class="pay-card" style="background:#fef3c7;color:#92400e">📒 Credit: Rs. ${credit.toFixed(0)}</div>
  </div>
  <table>
    <thead><tr><th>Date & Time</th><th>Invoice #</th><th>Customer</th><th style="text-align:center">Items</th><th>Payment</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      ${rows}
      <tr class="grand-row">
        <td colspan="5">TOTAL (${sales.length} sales)</td>
        <td style="text-align:right">Rs. ${total.toFixed(0)}</td>
      </tr>
    </tbody>
  </table>
  <script>window.onload = function(){ window.print(); };<\/script>
  </body></html>`
}
