// White-label branding. Every product/company string shown to shop users, admins,
// customers (WhatsApp, PDFs, receipts) and the PWA manifest comes from here.
//
// Values come from VITE_BRAND_* environment variables (set per Vercel project),
// falling back to the EdgeX defaults below — so an unconfigured build looks exactly
// like the original product. Plain JS (no Vite-only APIs at module level) so
// vite.config.js can reuse resolveBrand() with loadEnv().

export const BRAND_DEFAULTS = {
  appName: 'EdgeX POS',                         // VITE_BRAND_APP_NAME
  appFullName: 'EdgeX Digital POS',             // VITE_BRAND_APP_FULL_NAME (PWA manifest name)
  tagline: 'Multipurpose Point of Sale',        // VITE_BRAND_TAGLINE (browser tab title)
  companyName: 'EdgeX Digital',                 // VITE_BRAND_COMPANY ("Powered by …")
  developerCredit: 'EdgeX Digital & Babar Joya', // VITE_BRAND_CREDIT ("Developed with ❤ by …")
  supportName: 'Babar Joya',                    // VITE_BRAND_SUPPORT_NAME
  supportPhone: '0301-2616367',                 // VITE_BRAND_SUPPORT_PHONE
  shortName: 'EdgeX',                           // VITE_BRAND_SHORT_NAME ("EdgeX Admin", export file names)
  logo: '/edgex_pos_logo_platform.png',         // VITE_BRAND_LOGO (public/ path or URL)
  icon: '/edgex_icon.svg',                      // VITE_BRAND_ICON (favicon)
  themeColor: '#2563eb',                        // VITE_BRAND_THEME_COLOR (PWA/browser chrome)
}

const ENV_KEYS = {
  appName: 'VITE_BRAND_APP_NAME',
  appFullName: 'VITE_BRAND_APP_FULL_NAME',
  tagline: 'VITE_BRAND_TAGLINE',
  companyName: 'VITE_BRAND_COMPANY',
  developerCredit: 'VITE_BRAND_CREDIT',
  supportName: 'VITE_BRAND_SUPPORT_NAME',
  supportPhone: 'VITE_BRAND_SUPPORT_PHONE',
  shortName: 'VITE_BRAND_SHORT_NAME',
  logo: 'VITE_BRAND_LOGO',
  icon: 'VITE_BRAND_ICON',
  themeColor: 'VITE_BRAND_THEME_COLOR',
}

export function resolveBrand(env = {}) {
  const brand = {}
  for (const [key, envKey] of Object.entries(ENV_KEYS)) {
    const v = typeof env[envKey] === 'string' ? env[envKey].trim() : ''
    brand[key] = v || BRAND_DEFAULTS[key]
  }
  return Object.freeze(brand)
}

// import.meta.env only exists inside Vite-processed code; guard so Node (vite.config) can import this file.
const viteEnv = (() => { try { return import.meta.env || {} } catch { return {} } })()

export const BRAND = resolveBrand(viteEnv)
