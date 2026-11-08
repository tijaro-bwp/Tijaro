/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useAuth } from './AuthContext'

// Theme is a per-shop preference stored inside `shop_settings_${shopId}` as
// `theme_mode` (light | dark | system) and `theme_accent` (see THEME_ACCENTS).
// The last applied theme is mirrored to LAST_THEME_KEY so pre-login screens and
// the inline script in index.html can paint the right colours before React loads.

export const THEME_MODES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

// Accents deliberately exclude purple (Quotation/info), red (danger) and amber (Wholesale).
export const THEME_ACCENTS = [
  { id: 'blue', label: 'Ocean Blue', swatch: '#2563eb' },
  { id: 'indigo', label: 'Indigo', swatch: '#4f46e5' },
  { id: 'teal', label: 'Teal', swatch: '#0d9488' },
  { id: 'graphite', label: 'Graphite', swatch: '#334155' },
]

const LAST_THEME_KEY = 'edgex_theme_last'
const DEFAULT_THEME = { mode: 'light', accent: 'blue' }

const validMode = m => (THEME_MODES.some(x => x.id === m) ? m : null)
const validAccent = a => (THEME_ACCENTS.some(x => x.id === a) ? a : null)

function readLastTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(LAST_THEME_KEY) || '{}') || {}
    return { mode: validMode(t.mode) || DEFAULT_THEME.mode, accent: validAccent(t.accent) || DEFAULT_THEME.accent }
  } catch {
    return { ...DEFAULT_THEME }
  }
}

export function readShopTheme(shopId) {
  if (!shopId) return readLastTheme()
  try {
    const s = JSON.parse(localStorage.getItem(`shop_settings_${shopId}`) || '{}') || {}
    return {
      mode: validMode(s.theme_mode) || DEFAULT_THEME.mode,
      accent: validAccent(s.theme_accent) || DEFAULT_THEME.accent,
    }
  } catch {
    return { ...DEFAULT_THEME }
  }
}

const prefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches

export function resolveMode(mode) {
  return mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode
}

export function applyTheme(theme) {
  const root = document.documentElement
  const resolved = resolveMode(theme.mode)
  root.dataset.theme = resolved
  root.dataset.accent = theme.accent
  try { localStorage.setItem(LAST_THEME_KEY, JSON.stringify(theme)) } catch { /* storage full/blocked */ }
  return resolved
}

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const { user } = useAuth()
  const shopId = user?.shop_id
  const [theme, setThemeState] = useState(() => readShopTheme(shopId))
  const [resolvedMode, setResolvedMode] = useState(() => resolveMode(theme.mode))

  // Re-read when the signed-in shop changes (account switch / logout).
  useEffect(() => {
    setThemeState(readShopTheme(shopId))
  }, [shopId])

  useEffect(() => {
    setResolvedMode(applyTheme(theme))
    if (theme.mode !== 'system' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setResolvedMode(applyTheme(theme))
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [theme])

  // Another tab (or a Settings save) rewrote shop_settings — pick up the theme from it.
  useEffect(() => {
    const onStorage = () => {
      const next = readShopTheme(shopId)
      setThemeState(prev => (prev.mode === next.mode && prev.accent === next.accent ? prev : next))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [shopId])

  const setTheme = useCallback((patch) => {
    setThemeState(prev => {
      const next = {
        mode: validMode(patch.mode) || prev.mode,
        accent: validAccent(patch.accent) || prev.accent,
      }
      if (shopId) {
        try {
          const key = `shop_settings_${shopId}`
          const current = JSON.parse(localStorage.getItem(key) || '{}') || {}
          localStorage.setItem(key, JSON.stringify({ ...current, theme_mode: next.mode, theme_accent: next.accent }))
        } catch { /* keep the in-memory theme even if storage fails */ }
      }
      return next
    })
  }, [shopId])

  return (
    <ThemeContext.Provider value={{ ...theme, resolvedMode, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}
