import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, rlsSession } from '../services/supabase'
import { db as localDB } from '../services/db'
import { hashPassword } from '../utils/authUtils'
import { motion, AnimatePresence } from 'framer-motion'
import { ShieldCheck, Zap, PhoneCall, Eye, EyeOff } from 'lucide-react'
import { BRAND } from '../config/brand.js'

const IMPERSONATION_HANDOFF_KEY = 'edgex_impersonation_handoff'

function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [logoUrl, setLogoUrl] = useState(() => {
    const lastShopId = localStorage.getItem('last_shop_id')
    return lastShopId ? localStorage.getItem(`shop_logo_${lastShopId}`) || BRAND.logo : BRAND.logo
  })
  const [platformName, setPlatformName] = useState(() => {
    const lastShopId = localStorage.getItem('last_shop_id')
    return lastShopId ? localStorage.getItem(`shop_name_${lastShopId}`) || BRAND.appName : BRAND.appName
  })

  useEffect(() => {
    document.title = platformName ? `${platformName} - Login` : BRAND.appName
  }, [platformName])

  const { login, impersonate } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Handle impersonation from the superadmin portal.
  // Security: impersonation used to be accepted from any URL (`?impersonateId=5&sessionToken=…`),
  // so anyone could open a shop UI as "admin" and session tokens leaked into browser history.
  // Now the portal hands off through this tab's sessionStorage (never the URL), the handoff
  // expires after 60s, and the session token is verified against the database before use.
  useEffect(() => {
    const legacyId = searchParams.get('impersonateId')
    const handoffFlag = searchParams.get('impersonate')
    if (!legacyId && !handoffFlag) return

    // Always remove any credentials from the address bar / history first
    try { window.history.replaceState(null, '', window.location.pathname) } catch (_) {}

    if (legacyId) {
      setError('Impersonation links are no longer accepted. Please start impersonation from the Superadmin portal.')
      return
    }

    let handoff = null
    try { handoff = JSON.parse(sessionStorage.getItem(IMPERSONATION_HANDOFF_KEY) || 'null') } catch (_) { handoff = null }
    sessionStorage.removeItem(IMPERSONATION_HANDOFF_KEY)

    if (!handoff || !handoff.impersonateId || !handoff.sessionToken || Date.now() - Number(handoff.ts || 0) > 60000) {
      setError('Impersonation request expired or invalid. Please start again from the Superadmin portal.')
      return
    }

    const impId = String(handoff.impersonateId)
    const shopName = handoff.shopName || 'Impersonated Shop'
    const logoUrl = handoff.logoUrl || ''
    const sessionToken = handoff.sessionToken

    ;(async () => {
      // Verify the token is a live session for exactly this shop (RLS only returns the row for its own token)
      const previousToken = localStorage.getItem('session_token')
      localStorage.setItem('session_token', sessionToken)
      const { data: sess, error: sessErr } = await supabase
        .from('sessions')
        .select('shop_id, expires_at')
        .eq('token', sessionToken)
        .maybeSingle()
      const valid = !sessErr && sess && String(sess.shop_id) === impId && (!sess.expires_at || new Date(sess.expires_at) > new Date())
      if (!valid) {
        if (previousToken) localStorage.setItem('session_token', previousToken)
        else localStorage.removeItem('session_token')
        setError('Impersonation session could not be verified. Please start again from the Superadmin portal.')
        return
      }

      // Build the impersonated user object
      const impersonatedUser = {
        id: `impersonated-${impId}`,
        username: `Superadmin (${shopName})`,
        role: 'admin',
        shop_id: String(impId),
        isImpersonating: true
      }

      // Synchronously wipe any previous session so no stale shop bleeds through
      localStorage.removeItem('user')
      localStorage.removeItem('originalUser')

      // Write all new shop data before the page reload
      localStorage.setItem('user', JSON.stringify(impersonatedUser))
      localStorage.setItem(`shop_name_${impId}`, shopName)
      if (logoUrl) {
        localStorage.setItem(`shop_logo_${impId}`, logoUrl)
      } else {
        localStorage.removeItem(`shop_logo_${impId}`)
      }

      // Also update React context (best-effort — page will reload anyway)
      try { impersonate(impId, { name: shopName, logo_url: logoUrl }) } catch (_) {}


      // Full reload so AuthContext re-initialises cleanly from the new localStorage state
      window.location.href = '/dashboard'
    })()
  }, [searchParams])  // intentionally omit `impersonate` — we write localStorage directly above

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const isOffline = !navigator.onLine

    // ── Offline fast-path: skip RPC entirely ──────────────────────────────
    if (isOffline) {
      try {
        const hashedPassword = await hashPassword(password)
        const allUsers = await localDB.users.toArray()
        const localUser = allUsers.find(u =>
          u.username?.toLowerCase() === username.trim().toLowerCase()
        )

        if (!localUser) {
          setError('⚠️ Offline: No saved login found for this username. Please connect to internet and login once first.')
          setLoading(false)
          return
        }

        if (localUser.password !== hashedPassword) {
          setError('Offline: Incorrect password.')
          setLoading(false)
          return
        }

        if (localUser.is_active === false) {
          setError('Offline: This account is marked inactive.')
          setLoading(false)
          return
        }

        // Restore branding from IndexedDB
        if (localUser.shop_id) {
          localStorage.setItem('last_shop_id', localUser.shop_id)
          try {
            const localShop = await localDB.shops.get(localUser.shop_id)
            if (localShop?.name) localStorage.setItem(`shop_name_${localUser.shop_id}`, localShop.name)
            if (localShop?.logo_url) localStorage.setItem(`shop_logo_${localUser.shop_id}`, localShop.logo_url)
          } catch (_) {}
        }

        login({
          id: localUser.id,
          username: localUser.username,
          email: localUser.email || '',
          role: localUser.role,
          shop_id: localUser.shop_id,
          permissions: localUser.permissions || []
        })

        setError('✅ Logged in offline. Some features (sync, reports) require internet.')
        setTimeout(() => navigate('/dashboard'), 1500)
      } catch (err) {
        setError('Offline login failed. Please connect to internet.')
      } finally {
        setLoading(false)
      }
      return
    }

    // ── Online path ───────────────────────────────────────────────────────
    try {
      const hashedPassword = await hashPassword(password)

      // Use secure_login RPC (handles auth + shop status check + RLS setup)
      // Wrap in a 5s timeout so offline users don't wait forever
      const rpcPromise = supabase.rpc('secure_login', {
        p_username: username.trim(),
        p_password_hash: hashedPassword
      })
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Network unavailable — switching to offline login')), 5000)
      )
      const { data: loginResult, error: loginError } = await Promise.race([rpcPromise, timeoutPromise])

      // Handle RPC errors
      if (loginError) {
        console.error('Login RPC error:', loginError)

        // Detect network/fetch errors and fall back to offline login
        const errMsg = (loginError.message || '').toLowerCase()
        const isNetworkError = errMsg.includes('fetch') ||
          errMsg.includes('network') ||
          errMsg.includes('failed to fetch') ||
          errMsg.includes('load failed') ||
          errMsg.includes('networkerror') ||
          loginError.code === 'NETWORK_ERROR' ||
          !navigator.onLine

        if (isNetworkError) {
          console.log('Network error detected, attempting offline login...')
          // Fall through to offline fallback below
          throw new Error('Network unavailable — switching to offline login')
        }

        setError('Login failed. Please try again or contact support.')
        setLoading(false)
        return
      }

      // Handle login failure (invalid credentials, suspended account, etc.)
      if (!loginResult || !loginResult.success) {
        const errorMsg = loginResult?.error || 'Invalid username or password'

        // User-friendly error messages
        if (errorMsg.includes('suspended')) {
          const reasonStr = loginResult?.suspension_reason ? ` (Reason: ${loginResult.suspension_reason})` : ''
          setError(`Your account has been suspended${reasonStr}. Please contact support: ${BRAND.supportPhone}`)
        } else if (errorMsg.includes('Multiple accounts')) {
          setError('Multiple accounts found. Please use your email to login.')
        } else {
          setError('Invalid username or password')
        }

        setLoading(false)
        return
      }

      const userData = loginResult.user
      const shopConfig = loginResult.shop_config
      const sessionToken = loginResult.session_token

      if (sessionToken) {
        localStorage.setItem('session_token', sessionToken)
      }

      // If user is a superadmin, immediately navigate to superadmin portal
      // Role comes from the server (secure_login) — never from the typed username.
      if (userData.role === 'superadmin') {
        login({
          id: userData.id,
          username: userData.username,
          email: userData.email || '',
          role: 'superadmin',
          shop_id: null,
          permissions: []
        })
        localStorage.setItem('user_pw_hash', hashedPassword)
        navigate('/admin')
        return
      }
      if (userData.shop_id) {
        localStorage.setItem('last_shop_id', userData.shop_id)
        // Fetch and cache shop name/logo immediately to avoid lag or missing branding
        try {
          const { data: shopData } = await supabase
            .from('shops')
            .select('name, logo_url')
            .eq('id', userData.shop_id)
            .maybeSingle()
          if (shopData) {
            if (shopData.name) {
              localStorage.setItem(`shop_name_${userData.shop_id}`, shopData.name)
            }
            if (shopData.logo_url) {
              localStorage.setItem(`shop_logo_${userData.shop_id}`, shopData.logo_url)
            }
            // Save to IndexedDB shops table as well so offline operations are fully supported
            try {
              await localDB.shops.put({ id: userData.shop_id, name: shopData.name, logo_url: shopData.logo_url })
            } catch (dbErr) {
              console.warn('Could not save shop details to localDB:', dbErr)
            }
          }
        } catch (shopErr) {
          console.warn('Could not fetch shop branding on login:', shopErr)
        }
      }

      // Validate response data
      if (!userData.id || !userData.shop_id || !userData.role) {
        setError('Invalid login response. Please contact support.')
        setLoading(false)
        return
      }

      // Store plan limits for client-side enforcement
      localStorage.setItem(`plan_limits_${userData.shop_id}`, JSON.stringify({
        product_limit: shopConfig?.product_limit || 100,
        user_limit: shopConfig?.user_limit || 3,
        plan_name: shopConfig?.plan_name || 'Trial',
        status: shopConfig?.status || 'active',
        next_billing_date: shopConfig?.next_billing_date || null,
        subscription_fee: shopConfig?.subscription_fee || 0
      }))
      // Store feature flags for feature gating
      localStorage.setItem(`plan_features_${userData.shop_id}`, JSON.stringify(shopConfig?.features || {}))

      // Save user to IndexedDB for offline access
      try {
        await localDB.users.put({
          id: userData.id,
          username: userData.username,
          email: userData.email || '',
          password: hashedPassword,
          role: userData.role,
          shop_id: userData.shop_id,
          is_active: true,
          permissions: userData.permissions || [],
          last_sync: new Date().toISOString()
        })
      } catch (dbError) {
        console.warn('Could not save to IndexedDB:', dbError)
        // Don't fail login if offline storage fails
      }

      // Cache hashed password in localStorage so PasswordModal can verify
      // even when Supabase is unreachable and IndexedDB is empty
      localStorage.setItem('user_pw_hash', hashedPassword)

      // Set RLS session claims (already done by secure_login, but ensure it's set)
      await rlsSession.setSession({
        id: userData.id,
        shop_id: userData.shop_id,
        role: userData.role
      })

      // Update React context
      login({
        id: userData.id,
        username: userData.username,
        email: userData.email || '',
        role: userData.role,
        shop_id: userData.shop_id,
        permissions: userData.permissions || []
      })

      // Navigate to dashboard
      navigate('/dashboard')

    } catch (networkError) {
      console.error('Network error during login:', networkError)

      // Offline fallback - try IndexedDB
      try {
        const hashedPassword = await hashPassword(password)
        const allUsers = await localDB.users.toArray()
        const localUser = allUsers.find(u =>
          u.username?.toLowerCase() === username.trim().toLowerCase()
        )

        if (!localUser) {
          setError('⚠️ No offline data found. Please connect to internet and login once first to enable offline access.')
          setLoading(false)
          return
        }

        if (localUser && localUser.password === hashedPassword && localUser.is_active !== false) {
          // Offline login successful
          console.log('✅ Offline login successful')

          if (localUser.shop_id) {
            localStorage.setItem('last_shop_id', localUser.shop_id)
            try {
              const localShop = await localDB.shops.get(localUser.shop_id)
              if (localShop) {
                if (localShop.name) {
                  localStorage.setItem(`shop_name_${localUser.shop_id}`, localShop.name)
                }
                if (localShop.logo_url) {
                  localStorage.setItem(`shop_logo_${localUser.shop_id}`, localShop.logo_url)
                }
              }
            } catch (dbErr) {
              console.warn('Could not restore offline shop branding:', dbErr)
            }
          }

          login({
            id: localUser.id,
            username: localUser.username,
            email: localUser.email || '',
            role: localUser.role,
            shop_id: localUser.shop_id,
            permissions: localUser.permissions || []
          })

          setError('✅ Logged in offline. Some features (sync, reports) require internet.')

          setTimeout(() => {
            navigate('/dashboard')
          }, 1500)
        } else {
          setError('Offline mode: Incorrect password.')
        }
      } catch (offlineError) {
        console.error('Offline login error:', offlineError)
        setError('Unable to login. Please check your internet connection.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-2 flex">
      {/* Left Side - Branding */}
      <div className="hidden lg:flex w-1/2 bg-[url('/inventory-bg.png')] bg-cover bg-left relative p-12 flex-col justify-between overflow-hidden">
        <div className="absolute inset-0 bg-contrast/60 z-0" />
        <div className="absolute top-0 right-0 w-96 h-96 bg-primary/20 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-success/20 rounded-full blur-3xl translate-y-1/3 -translate-x-1/3" />

        <div className="relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="flex items-center gap-3 mb-16"
          >
            <div className="w-16 h-16 bg-white/10 backdrop-blur-md rounded-2xl border border-white/20 p-2 shadow-xl flex items-center justify-center overflow-hidden">
              <img src={logoUrl} alt={platformName} className="max-w-full max-h-full object-contain drop-shadow-md" />
            </div>
            <span className="text-2xl font-black text-white tracking-widest uppercase">{platformName}</span>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="max-w-xl"
          >
            <h1 className="text-5xl font-black text-white leading-tight mb-6">
              Smart Retail Management
              <span className="block text-primary-fg">Simplified.</span>
            </h1>
            <p className="text-lg text-white/60 mb-12">
              Enterprise-grade POS system with bank-level security and multi-tenant isolation.
            </p>

            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                  <Zap className="text-primary-fg" size={20} />
                </div>
                <div>
                  <h3 className="text-white font-semibold">Lightning Fast</h3>
                  <p className="text-sm text-white/60">Offline-first architecture</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center">
                  <ShieldCheck className="text-success-fg" size={20} />
                </div>
                <div>
                  <h3 className="text-white font-semibold">Enterprise Security</h3>
                  <p className="text-sm text-white/60">Row-level security & data encryption</p>
                </div>
              </div>
            </div>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.6 }}
          className="relative z-10"
        >
          <p className="text-sm text-white/50 font-medium">
            Developed with <span className="text-danger-fg">❤︎</span> by {BRAND.developerCredit}
          </p>
          <div className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-contrast-hover/50 rounded-lg border border-contrast-hover/50">
            <PhoneCall size={14} className="text-white/60" />
            <span className="font-mono text-sm text-fg-on-contrast">Support: {BRAND.supportPhone}</span>
          </div>
        </motion.div>
      </div>

      {/* Right Side - Login Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-contrast relative border-l border-contrast-hover">
        <div className="absolute top-1/4 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl pointer-events-none" />

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="w-full max-w-md relative z-10"
        >
          {/* Mobile Logo */}
          <div className="lg:hidden text-center mb-10 flex flex-col items-center">
            <div className="w-20 h-20 mb-4 rounded-xl border border-contrast-hover p-1 bg-contrast-hover shadow-sm flex items-center justify-center overflow-hidden">
              <img src={logoUrl} alt={platformName} className="max-w-full max-h-full object-contain" />
            </div>
            <h1 className="text-2xl font-black text-white tracking-tight uppercase">{platformName}</h1>
          </div>

          {/* Desktop Logo */}
          <div className="hidden lg:flex flex-col items-center mb-10">
            <div className="w-28 h-28 mb-4 rounded-2xl border-2 border-contrast-hover p-2 bg-contrast-hover/50 backdrop-blur-md shadow-2xl flex items-center justify-center overflow-hidden">
              <img src={logoUrl} alt={platformName} className="max-w-full max-h-full object-contain drop-shadow-lg" />
            </div>
          </div>

          <div className="mb-10 text-center lg:text-left">
            <h2 className="text-3xl font-bold text-white mb-2">Welcome Back</h2>
            <p className="text-white/60">Please sign in to your dashboard</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-fg-on-contrast mb-2">Email or Username</label>
              <input
                type="text"
                placeholder="Enter email or username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                className="w-full px-5 py-4 bg-contrast-hover/50 border border-contrast-hover text-white placeholder-white/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary focus:bg-contrast-hover transition-all shadow-inner"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-fg-on-contrast mb-2">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full px-5 py-4 bg-contrast-hover/50 border border-contrast-hover text-white placeholder-white/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary focus:bg-contrast-hover transition-all shadow-inner"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white/80 transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginBottom: 20 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  className="overflow-hidden"
                >
                  <p className="text-danger-fg text-sm font-medium bg-danger-soft border border-danger-muted px-4 py-3 rounded-xl">
                    {error}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl transition-all disabled:opacity-70 disabled:cursor-not-allowed shadow-lg shadow-primary/30 active:scale-[0.98] flex justify-center items-center h-14"
            >
              {loading ? (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                  className="w-6 h-6 border-2 border-white/20 border-t-white rounded-full"
                />
              ) : (
                'Sign In to Dashboard'
              )}
            </button>
          </form>

          <div className="mt-10 lg:hidden text-center">
            <div className="inline-flex items-center justify-center gap-2 px-4 py-3 bg-contrast-hover/50 rounded-xl border border-contrast-hover">
              <PhoneCall size={16} className="text-white/60" />
              <span className="font-mono font-bold text-white/60">Support: {BRAND.supportPhone}</span>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}

export default Login