import { createClient } from '@supabase/supabase-js'

// RETIRED APP — see superadmin/src/App.jsx and docs/ADMIN_EDGE_FUNCTIONS.md.
// This legacy portal used to create a privileged (RLS-bypassing) client in the
// browser. That is gone for good: privileged work now runs only in the
// `admin-api` Edge Function used by the main POS app's /admin pages.

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// To prevent "Multiple GoTrueClient instances" warnings during Vite HMR reloads
export const supabase = globalThis.__supabaseClient || createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storageKey: 'sb-superadmin-auth-token',
    persistSession: true,
    autoRefreshToken: true
  }
})

if (import.meta.env.DEV) {
  globalThis.__supabaseClient = supabase
}

// Kept only so the unused legacy modules still import cleanly. Always null.
export const supabaseAdmin = null
