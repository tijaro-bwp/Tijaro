// Printable / shareable payment receipt (80mm) for a payment recorded against
// bills. Literal colours on purpose: this HTML is printed and turned into PDF.
import { fmtRs, billNo } from './billMessages'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * @param {object} p
 * @param {{name,phone,address}} p.shop
 * @param {{name,phone}} p.customer
 * @param {object} p.result   record_bill_payment() result
 * @param {string} p.mode     payment mode
 * @param {string} [p.ref]    transaction reference
 * @param {string} p.date     ISO date of the payment
 */
export function buildPaymentReceiptHTML({ shop, customer, result, mode, ref, date }) {
  const bills = result?.bills || []
  const billed = bills.reduce((a, b) => a + Number(b.paid_now || 0), 0)
  const extra = Math.max(0, Number(result?.total_paid || 0) - billed)
  const row = (l, r, cls = '') => `<div class="row ${cls}"><span>${l}</span><span>${r}</span></div>`

  return `<html><head><title>Payment Receipt</title><meta charset="utf-8">
  <style>
    @page{size:80mm auto;margin:2mm}
    *{box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;width:302px;margin:0 auto;padding:12px 8px;font-size:12.5px;color:#111}
    h2,.c{text-align:center;margin:3px 0}
    hr{border:0;border-top:1px dashed #000;margin:8px 0}
    .row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
    .b{font-weight:bold}
    .big{font-size:15px}
    .muted{color:#555;font-size:11px}
    .bill{border:1px solid #ddd;border-radius:6px;padding:6px;margin:6px 0}
  </style></head><body>
  <h2>${esc(shop?.name || 'Shop')}</h2>
  ${shop?.phone ? `<p class="c muted">${esc(shop.phone)}</p>` : ''}
  ${shop?.address ? `<p class="c muted">${esc(shop.address)}</p>` : ''}
  <p class="c b big" style="margin-top:6px">PAYMENT RECEIPT</p>
  <hr/>
  ${row('Customer', `<b>${esc(customer?.name || '')}</b>`)}
  ${customer?.phone ? row('Phone', esc(customer.phone)) : ''}
  ${row('Date', esc(new Date(date || Date.now()).toLocaleString('en-PK')))}
  ${row('Mode', esc(mode || 'cash'))}
  ${ref ? row('Ref', esc(ref)) : ''}
  <hr/>
  ${row('Amount received', `Rs. ${fmtRs(result?.total_paid)}`, 'b big')}
  ${bills.map((b) => `<div class="bill">
      ${row(`<b>Bill #${esc(b.bill_no || billNo(b.sale_id))}</b>`, `Rs. ${fmtRs(b.net_total)}`)}
      ${row('Paid earlier', `Rs. ${fmtRs(b.paid_before)}`)}
      ${row('Paid now', `Rs. ${fmtRs(b.paid_now)}`)}
      ${row(Number(b.due) > 0 ? 'Remaining on bill' : 'Bill status', Number(b.due) > 0 ? `Rs. ${fmtRs(b.due)}` : 'PAID ✓', 'b')}
    </div>`).join('')}
  ${extra > 0 ? row('Towards old balance', `Rs. ${fmtRs(extra)}`) : ''}
  <hr/>
  ${row('Previous balance', `Rs. ${fmtRs(result?.prev_balance)}`)}
  ${row('Received', `- Rs. ${fmtRs(result?.total_paid)}`)}
  ${row(Number(result?.new_balance) < 0 ? 'Advance with shop' : 'New balance', `Rs. ${fmtRs(Math.abs(Number(result?.new_balance) || 0))}`, 'b big')}
  <hr/>
  <p class="c muted">Thank you!</p>
  </body></html>`
}
