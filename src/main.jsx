import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import './services/syncService'
import { BRAND } from './config/brand.js'

// ── RLS error interceptor ─────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  const originalAlert = window.alert;
  window.alert = (message) => {
    const msgStr = String(message || '');
    if (msgStr.toLowerCase().includes('row-level security policy') || msgStr.toLowerCase().includes('row violates row-level security')) {
      originalAlert(
        "⚠️ Login Session Required / Expired\n\n" +
        "Your login session is expired or unregistered in the database.\n\n" +
        "To resolve this, please:\n" +
        "1. Log out of the application.\n" +
        "2. Log back in to establish a fresh security session."
      );
    } else {
      originalAlert(message);
    }
  };
}

// ── Force-update polling (checks Supabase every 5 minutes) ───────────────
// When superadmin clicks "Push Update", force_refresh_version is incremented.
// This app detects the mismatch, activates the waiting SW, and reloads.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const VERSION_KEY = 'edgex_app_version'

async function checkForForceUpdate() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !navigator.onLine) return
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/system_configs?key=eq.force_refresh_version&select=value`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        signal: AbortSignal.timeout(5000),
      }
    )
    if (!res.ok) return
    const rows = await res.json()
    const remoteVersion = rows?.[0]?.value
    if (!remoteVersion) return

    const localVersion = localStorage.getItem(VERSION_KEY) || '0'

    if (remoteVersion !== localVersion) {
      console.log(`[${BRAND.shortName}] New version detected (${localVersion} → ${remoteVersion}). Flushing cache and reloading…`)
      localStorage.setItem(VERSION_KEY, remoteVersion)

      // Flush CacheStorage to ensure brand new JS/CSS bundles are downloaded
      if ('caches' in window) {
        try {
          const cacheKeys = await caches.keys()
          await Promise.all(cacheKeys.map(k => caches.delete(k)))
        } catch (_) {}
      }

      // Ask the waiting SW to take control immediately, then reload
      if ('serviceWorker' in navigator) {
        try {
          const reg = await navigator.serviceWorker.getRegistration()
          if (reg?.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' })
            navigator.serviceWorker.addEventListener('controllerchange', () => {
              window.location.reload()
            }, { once: true })
            return
          } else if (reg?.update) {
            await reg.update()
          }
        } catch (_) {}
      }
      window.location.reload()
    }
  } catch (_) {
    // Silently ignore — network error or table not yet created
  }
}

// Run on load (after a short delay so app initialises first)
setTimeout(checkForForceUpdate, 3000)
// Then every 5 minutes
setInterval(checkForForceUpdate, 5 * 60 * 1000)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
