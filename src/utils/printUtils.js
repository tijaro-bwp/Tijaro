/**
 * printUtils.js — Mobile-safe print helper
 *
 * Uses a hidden <iframe> injected into the current page instead of
 * window.open('', '_blank'). This bypasses mobile browser popup-blockers
 * (iOS Safari, Android Chrome) which block blank popups triggered by JS.
 *
 * Usage:  import { printHTML } from '../utils/printUtils'
 *         printHTML(myHtmlString)
 */

export function printHTML(html) {
  // Re-use an existing frame if present, otherwise create one
  let frame = document.getElementById('__pos_print_frame')
  if (!frame) {
    frame = document.createElement('iframe')
    frame.id = '__pos_print_frame'
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText =
      'position:fixed;width:1px;height:1px;border:0;left:-9999px;top:-9999px;opacity:0;pointer-events:none;'
    document.body.appendChild(frame)
  }

  const doc = frame.contentWindow.document
  doc.open()
  doc.write(html)
  doc.close()

  // Wait for images to load before printing
  const win = frame.contentWindow
  const doprint = () => {
    try { win.focus(); win.print() } catch (_) {}
  }

  const imgs = doc.images
  if (!imgs || imgs.length === 0) {
    setTimeout(doprint, 400)
    return
  }

  let loaded = 0
  const onLoad = () => { if (++loaded >= imgs.length) setTimeout(doprint, 300) }
  for (let i = 0; i < imgs.length; i++) {
    if (imgs[i].complete) onLoad()
    else { imgs[i].onload = onLoad; imgs[i].onerror = onLoad }
  }
}

/**
 * getShopBranding(shopId)
 * Reads shop branding from localStorage (populated at login / Settings save).
 * Returns { name, phone, address, logo_url } — all strings, never null/undefined.
 */
export function getShopBranding(shopId) {
  const sid = shopId ? String(shopId) : null
  let settings = {}
  try { settings = JSON.parse((sid ? localStorage.getItem(`shop_settings_${sid}`) : null) || '{}') } catch (_) {}
  const name     = (sid ? localStorage.getItem(`shop_name_${sid}`) : null) || settings.name     || 'Our Shop'
  const logo_url = (sid ? localStorage.getItem(`shop_logo_${sid}`)  : null) || settings.logo_url || ''
  const phone    = settings.phone   || ''
  const address  = settings.address || ''
  return { name, phone, address, logo_url }
}

/**
 * brandedA4Header(branding, docTitle, subtitle)
 * Returns an HTML string for a clean A4 report header with shop branding.
 * Use inside any printHTML() template that needs a standardised top section.
 */
export function brandedA4Header(branding, docTitle, subtitle = '') {
  const { name, phone, address, logo_url } = branding
  const logoHtml = logo_url
    ? `<img src="${logo_url}" alt="logo" style="height:52px;object-fit:contain;margin-right:14px;" />`
    : ''
  const contactLine = [phone, address].filter(Boolean).join('  |  ')
  return `
    <div style="display:flex;align-items:center;border-bottom:2px solid #1e3a5f;padding-bottom:12px;margin-bottom:18px;">
      ${logoHtml}
      <div style="flex:1;">
        <div style="font-size:20px;font-weight:800;color:#1e3a5f;">${name}</div>
        ${contactLine ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${contactLine}</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:16px;font-weight:700;color:#1e3a5f;">${docTitle}</div>
        ${subtitle ? `<div style="font-size:11px;color:#64748b;margin-top:3px;">${subtitle}</div>` : ''}
        <div style="font-size:10px;color:#94a3b8;margin-top:3px;">Date: ${new Date().toLocaleDateString('en-PK')}</div>
      </div>
    </div>`
}
