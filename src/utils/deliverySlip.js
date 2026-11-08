// Delivery slip (80mm) that goes with the loader: who to deliver to, what,
// how much to collect, and blanks for cash collected and signatures.
// Literal colours on purpose: this HTML is printed.
import { fmtRs, saleBillNo } from './billMessages'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * @param {object} p
 * @param {{name,phone,address}} p.shop
 * @param {object} p.sale        saved sale row (id, invoice_number, created_at, …)
 * @param {Array}  p.items       [{ name|product_name, qty|quantity }]
 * @param {{name,phone}} p.customer
 * @param {{address,note,loader}} p.delivery
 * @param {number} p.total       bill total (after discount)
 * @param {number} p.paid        paid when the bill was made
 * @param {{previous,newBalance}|null} p.account
 */
export function buildDeliverySlipHTML({ shop, sale, items, customer, delivery, total, paid, account }) {
  const due = Math.max(0, Number(total || 0) - Number(paid || 0))
  const row = (l, r, cls = '') => `<div class="row ${cls}"><span>${l}</span><span>${r}</span></div>`
  const lines = (items || []).map((i) => `<tr><td>${esc(i.name ?? i.product_name)}</td><td class="q">${esc(i.qty ?? i.quantity)}</td></tr>`).join('')

  return `<html><head><title>Delivery slip</title><meta charset="utf-8">
  <style>
    @page{size:80mm auto;margin:2mm}
    *{box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;width:302px;margin:0 auto;padding:10px 8px;font-size:12.5px;color:#111}
    h2,.c{text-align:center;margin:3px 0}
    hr{border:0;border-top:1px dashed #000;margin:8px 0}
    .row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
    .b{font-weight:bold}.big{font-size:15px}.muted{color:#555;font-size:11px}
    table{width:100%;border-collapse:collapse}td{padding:3px 0;border-bottom:1px dotted #bbb;vertical-align:top}td.q{text-align:right;width:50px;font-weight:bold}
    .box{border:1.5px solid #000;border-radius:6px;padding:8px;margin-top:8px}
    .line{border-bottom:1px solid #000;height:22px}
  </style></head><body>
  <h2>${esc(shop?.name || 'Shop')}</h2>
  ${shop?.phone ? `<p class="c muted">${esc(shop.phone)}</p>` : ''}
  <p class="c b big" style="margin-top:6px">DELIVERY SLIP</p>
  <hr/>
  ${row('Bill', `<b>#${esc(saleBillNo(sale))}</b>`)}
  ${row('Date', esc(new Date(sale?.created_at || Date.now()).toLocaleString('en-PK')))}
  ${delivery?.loader ? row('Loader', `<b>${esc(delivery.loader)}</b>`) : ''}
  <hr/>
  <p class="b" style="margin:2px 0">${esc(customer?.name || '')}</p>
  ${customer?.phone ? `<p style="margin:2px 0">${esc(customer.phone)}</p>` : ''}
  ${delivery?.address ? `<p style="margin:2px 0">${esc(delivery.address)}</p>` : ''}
  ${delivery?.note ? `<p class="muted" style="margin:4px 0">Note: ${esc(delivery.note)}</p>` : ''}
  <hr/>
  <table><tbody>${lines}</tbody></table>
  <hr/>
  ${row('Bill total', `Rs. ${fmtRs(total)}`)}
  ${Number(paid) > 0 ? row('Paid at shop', `Rs. ${fmtRs(paid)}`) : ''}
  ${row('To collect for this bill', `Rs. ${fmtRs(due)}`, 'b big')}
  ${account ? row('Previous balance', `Rs. ${fmtRs(account.previous)}`) : ''}
  ${account ? row('Total balance', `Rs. ${fmtRs(account.newBalance)}`, 'b') : ''}
  <div class="box">
    <div class="row b"><span>Cash collected</span><span>Rs. ____________</span></div>
    <p class="muted" style="margin:10px 0 2px">Received by (customer)</p><div class="line"></div>
    <p class="muted" style="margin:10px 0 2px">Loader signature</p><div class="line"></div>
  </div>
  </body></html>`
}
