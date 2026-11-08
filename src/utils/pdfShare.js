import { BRAND } from '../config/brand.js'
// pdfShare.js — Generate PDFs and share via WhatsApp
// Uses action-time dynamic imports so PDF libraries do not bloat route chunks.

async function loadJsPDF() {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ])
  return { jsPDF, autoTable }
}

function sanitizeBillHTML(htmlString) {
  const template = document.createElement('template')
  template.innerHTML = htmlString
  template.content.querySelectorAll('script').forEach(node => node.remove())
  template.content.querySelectorAll('*').forEach(node => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim().toLowerCase()
      if (name.startsWith('on') || value.startsWith('javascript:')) {
        node.removeAttribute(attr.name)
      }
    }
  })
  return template.innerHTML
}

// ─── Bill / Quotation PDF (renders existing bill HTML) ────────────────────────

/**
 * Generate a PDF from the bill HTML string.
 * Returns a Blob (PDF).
 */
export async function generateBillPDF(htmlString) {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas')
  ])

  // Mount the HTML in a hidden offscreen div
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;background:#fff;z-index:-1;font-size:12px;'
  container.innerHTML = sanitizeBillHTML(htmlString)
  document.body.appendChild(container)

  try {
    // Wait briefly for fonts/images
    await new Promise(r => setTimeout(r, 300))

    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      logging: false,
    })

    const imgData = canvas.toDataURL('image/jpeg', 0.92)
    const pxW = canvas.width
    const pxH = canvas.height

    // A4 page width in mm = 210, with 10mm margins = 190mm usable
    const pdfW = 190
    const pdfH = (pxH / pxW) * pdfW
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    pdf.addImage(imgData, 'JPEG', 10, 10, pdfW, pdfH)

    return pdf.output('blob')
  } finally {
    document.body.removeChild(container)
  }
}

// ─── Outstanding Balance PDF ──────────────────────────────────────────────────

/**
 * Generate an outstanding statement PDF.
 * @param {object} customer  — { name, phone, address, outstanding_balance }
 * @param {Array}  ledger    — [{ date, type, amount, paid_amount, note, balance }]
 * @param {string|object} shopInfo — shop name string OR { name, phone, address }
 * Returns a Blob (PDF).
 */
export async function generateOutstandingPDF(customer, ledger, shopInfo) {
  const { jsPDF, autoTable } = await loadJsPDF()
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const today = new Date().toLocaleDateString('en-PK')

  // Support both legacy string and new shopInfo object
  const shopName    = (typeof shopInfo === 'string' ? shopInfo : shopInfo?.name)   || 'Shop'
  const shopPhone   = typeof shopInfo === 'object' ? (shopInfo?.phone   || '') : ''
  const shopAddress = typeof shopInfo === 'object' ? (shopInfo?.address || '') : ''

  // Header
  pdf.setFontSize(16)
  pdf.setFont('helvetica', 'bold')
  pdf.text(shopName, 105, 18, { align: 'center' })

  let headerY = 26
  pdf.setFontSize(10)
  pdf.setFont('helvetica', 'normal')
  if (shopPhone || shopAddress) {
    const contactLine = [shopPhone, shopAddress].filter(Boolean).join('  |  ')
    pdf.text(contactLine, 105, headerY, { align: 'center' })
    headerY += 7
  }

  pdf.setFontSize(11)
  pdf.setFont('helvetica', 'normal')
  pdf.text('Customer Outstanding Statement', 105, headerY, { align: 'center' })

  pdf.setFontSize(9)
  pdf.text(`Date: ${today}`, 195, 18, { align: 'right' })

  const customerInfoY = headerY + 10
  // Customer info
  pdf.setFontSize(10)
  pdf.setFont('helvetica', 'bold')
  pdf.text('Customer:', 14, customerInfoY)
  pdf.setFont('helvetica', 'normal')
  pdf.text(`${customer.name}  |  ${customer.phone || ''}  |  ${customer.address || ''}`, 38, customerInfoY)

  // Outstanding box
  const bal = customer.outstanding_balance || 0
  pdf.setFillColor(bal > 0 ? 255 : 230, bal > 0 ? 230 : 255, 230)
  pdf.roundedRect(14, customerInfoY + 4, 182, 10, 2, 2, 'F')
  pdf.setFontSize(10)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(bal > 0 ? 180 : 0, 0, bal > 0 ? 0 : 0)
  pdf.text(`Total Outstanding: Rs. ${(bal || 0).toLocaleString()}`, 105, customerInfoY + 11, { align: 'center' })
  pdf.setTextColor(0, 0, 0)

  // Ledger table
  const rows = ledger.map(item => {
    const date = item.date ? new Date(item.date).toLocaleDateString('en-PK') : ''
    const desc = item.type === 'payment'
      ? `Payment${item.note ? ' — ' + item.note : ''}`
      : item.type === 'return'
        ? `Return${item.note ? ' — ' + item.note : ''}`
        : `Sale${item.note ? ' — ' + item.note : ''}`
    const debit  = item.type === 'sale'    ? `Rs. ${(item.amount || 0).toLocaleString()}` : ''
    const credit = item.type === 'payment' ? `Rs. ${(item.paid_amount || item.amount || 0).toLocaleString()}` : ''
    const ret    = item.type === 'return'  ? `Rs. ${(item.amount || 0).toLocaleString()}` : ''
    const runBal = item.balance !== undefined ? `Rs. ${(item.balance || 0).toLocaleString()}` : ''
    return [date, desc, debit, credit || ret, runBal]
  })

  autoTable(pdf, {
    startY: customerInfoY + 18,
    head: [['Date', 'Description', 'Debit (Sale)', 'Credit (Payment)', 'Balance']],
    body: rows,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 70 },
      2: { cellWidth: 28, halign: 'right' },
      3: { cellWidth: 32, halign: 'right' },
      4: { cellWidth: 28, halign: 'right' },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  })

  // Footer
  const finalY = pdf.lastAutoTable.finalY + 6
  pdf.setFontSize(8)
  pdf.setFont('helvetica', 'italic')
  pdf.text(`Generated by ${BRAND.appName}`, 105, finalY, { align: 'center' })

  return pdf.output('blob')
}

// ─── Purchase Order PDF ───────────────────────────────────────────────────────

/**
 * Generate a purchase order PDF.
 * @param {object} bySupplier — { supplierName: { phone, items: [product...] } }
 * @param {string|object} shopInfo — shop name string OR { name, phone, address }
 * Returns a Blob (PDF).
 */
export async function generatePurchaseOrderPDF(bySupplier, shopInfo) {
  const { jsPDF, autoTable } = await loadJsPDF()
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const today = new Date().toLocaleDateString('en-PK')
  const supplierNames = Object.keys(bySupplier)

  // Support both legacy string and new shopInfo object
  const shopName    = (typeof shopInfo === 'string' ? shopInfo : shopInfo?.name)   || 'Purchase Order'
  const shopPhone   = typeof shopInfo === 'object' ? (shopInfo?.phone   || '') : ''
  const shopAddress = typeof shopInfo === 'object' ? (shopInfo?.address || '') : ''

  // Header
  pdf.setFontSize(16)
  pdf.setFont('helvetica', 'bold')
  pdf.text(shopName, 105, 18, { align: 'center' })

  let headerY = 26
  pdf.setFontSize(10)
  pdf.setFont('helvetica', 'normal')
  if (shopPhone || shopAddress) {
    const contactLine = [shopPhone, shopAddress].filter(Boolean).join('  |  ')
    pdf.text(contactLine, 105, headerY, { align: 'center' })
    headerY += 7
  }

  pdf.setFontSize(11)
  pdf.setFont('helvetica', 'normal')
  pdf.text('Reorder / Purchase Order', 105, headerY, { align: 'center' })

  pdf.setFontSize(9)
  pdf.text(`Date: ${today}`, 195, 18, { align: 'right' })

  let currentY = headerY + 8

  supplierNames.forEach((supName, idx) => {
    const sup = bySupplier[supName]

    // Supplier section header
    pdf.setFontSize(10)
    pdf.setFont('helvetica', 'bold')
    pdf.setFillColor(229, 231, 235)
    pdf.rect(14, currentY, 182, 7, 'F')
    pdf.text(`Supplier: ${supName}${sup.phone ? '  |  ' + sup.phone : ''}`, 16, currentY + 5)
    currentY += 9

    const rows = sup.items.map(p => {
      const need = Math.max(0, (p.low_stock_threshold || 10) * 2 - p.stock_quantity)
      return [
        p.name || '',
        p.categories?.name || '',
        String(p.stock_quantity ?? 0),
        String(p.low_stock_threshold || 10),
        String(need),
        p.cost_price ? `Rs. ${p.cost_price}` : '',
      ]
    })

    autoTable(pdf, {
      startY: currentY,
      head: [['Product', 'Category', 'In Stock', 'Min Stock', 'Order Qty', 'Cost Price']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 55 },
        1: { cellWidth: 30 },
        2: { cellWidth: 18, halign: 'center' },
        3: { cellWidth: 18, halign: 'center' },
        4: { cellWidth: 22, halign: 'center' },
        5: { cellWidth: 25, halign: 'right' },
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: 14, right: 14 },
    })

    currentY = pdf.lastAutoTable.finalY + 8

    // Add new page if running out of space
    if (idx < supplierNames.length - 1 && currentY > 250) {
      pdf.addPage()
      currentY = 14
    }
  })

  // Footer
  pdf.setFontSize(8)
  pdf.setFont('helvetica', 'italic')
  pdf.text(`Generated by ${BRAND.appName}`, 105, currentY + 4, { align: 'center' })

  return pdf.output('blob')
}

// ─── Share / Download Helper ──────────────────────────────────────────────────

/**
 * Download the PDF and open WhatsApp Web in a new tab.
 * On Android Chrome, also tries native share sheet (file attach).
 * On desktop (Windows/Mac), skips share dialog — just downloads + opens WA.
 *
 * @param {Blob}   pdfBlob
 * @param {string} filename    e.g. 'bill-12345.pdf'
 * @param {string} phone       formatted phone (e.g. '923001234567') — optional
 * @param {string} message     text message for WA
 */
export async function shareOrDownloadPDF(pdfBlob, filename, phone, message) {
  // On Android Chrome, Web Share with files opens the OS share sheet (includes WhatsApp app)
  // On Windows/Mac, navigator.canShare returns true but opens Windows share dialog (no WhatsApp)
  // So only use Web Share on touch/mobile devices
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  const file = new File([pdfBlob], filename, { type: 'application/pdf' })

  if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename, text: message || '' })
      return
    } catch (err) {
      if (err.name === 'AbortError') return // user cancelled
      // fall through to download + WA link
    }
  }

  // Desktop / fallback: auto-download the PDF, then open WhatsApp Web tab
  const url = URL.createObjectURL(pdfBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)

  // Open WhatsApp with message — user can attach the downloaded PDF manually
  if (phone || message) {
    const waUrl = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(message || '')}`
      : `https://wa.me/?text=${encodeURIComponent(message || '')}`
    setTimeout(() => window.open(waUrl, '_blank'), 600)
  }
}
