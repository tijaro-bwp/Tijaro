import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, rlsSession } from '../services/supabase'
import { db as localDB } from '../services/db'
import { hashPassword } from '../utils/authUtils'
import { motion, AnimatePresence } from 'framer-motion'
import {
  PhoneCall, Eye, EyeOff, User, Lock, ArrowRight, CloudOff, ScanBarcode, Boxes,
  CircleAlert, CircleCheck, WifiOff,
} from 'lucide-react'
import { BRAND } from '../config/brand.js'

const IMPERSONATION_HANDOFF_KEY = 'edgex_impersonation_handoff'

function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('') // success/info messages (e.g. offline login), shown in green
  const [loading, setLoading] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

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
    setNotice('')
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
          setError('Offline: No saved login found for this username. Please connect to internet and login once first.')
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

        setNotice('Signed in offline. Sync and reports need internet.')
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
          setError('No offline data found. Please connect to internet and login once first to enable offline access.')
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

          setNotice('Signed in offline. Sync and reports need internet.')

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

  // Show the shop's own name/logo for a returning device; otherwise the platform brand.
  const rememberedShop = platformName !== BRAND.appName || logoUrl !== BRAND.logo
  const supportTel = `tel:${String(BRAND.supportPhone).replace(/[^\d+]/g, '')}`

  const features = [
    { icon: CloudOff, title: 'Keeps selling offline', text: 'Sales are saved on the device and sync when the internet is back.' },
    { icon: ScanBarcode, title: 'Fast checkout', text: 'Barcode search, quick quantities and printed or shared receipts.' },
    { icon: Boxes, title: 'Stock and ledgers in one place', text: 'Inventory, purchases, customers and suppliers stay in step.' },
  ]

  return (
    <div className="min-h-dvh flex bg-app text-fg">
      {/* Brand panel (desktop) */}
      <aside className="hidden lg:flex lg:w-[46%] xl:w-1/2 relative overflow-hidden bg-primary text-white p-12 xl:p-16 [@media(max-height:760px)]:py-8 flex-col justify-between gap-8">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-20"
          style={{ backgroundImage: 'radial-gradient(rgb(255 255 255 / 0.55) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
        />
        <div aria-hidden="true" className="absolute -top-40 -right-40 w-[28rem] h-[28rem] rounded-full bg-white/10 blur-3xl" />
        <div aria-hidden="true" className="absolute -bottom-48 -left-32 w-[32rem] h-[32rem] rounded-full bg-black/20 blur-3xl" />

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative flex items-center gap-3"
        >
          <div className="w-12 h-12 rounded-2xl bg-white p-1.5 shadow-lg flex items-center justify-center overflow-hidden">
            <img src={BRAND.logo} alt="" className="max-w-full max-h-full object-contain" />
          </div>
          <span className="text-xl font-extrabold tracking-tight">{BRAND.appName}</span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="relative max-w-lg"
        >
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-white/70 mb-4 [@media(max-height:760px)]:mb-2">{BRAND.tagline}</p>
          <h1 className="text-4xl xl:text-5xl [@media(max-height:760px)]:text-4xl font-extrabold leading-[1.1] tracking-tight mb-5 [@media(max-height:760px)]:mb-3">
            Sell faster.
            <span className="block text-white/75">Know your shop better.</span>
          </h1>
          <p className="text-base xl:text-lg text-white/75 mb-10 [@media(max-height:760px)]:mb-6 max-w-md">
            Billing, stock and accounts for your shop, on any device, even when the internet drops.
          </p>

          <ul className="space-y-5 [@media(max-height:760px)]:space-y-3">
            {features.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex items-start gap-4">
                <span className="shrink-0 w-11 h-11 rounded-xl bg-white/15 ring-1 ring-white/20 flex items-center justify-center">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-sm text-white/70 [@media(max-height:760px)]:hidden">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </motion.div>

        <div className="relative flex flex-wrap items-center justify-between gap-4 text-sm text-white/70">
          <span>Developed by {BRAND.developerCredit}</span>
          <a
            href={supportTel}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 bg-white/10 ring-1 ring-white/20 hover:bg-white/15 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <PhoneCall size={14} aria-hidden="true" />
            <span className="font-medium">Support: {BRAND.supportPhone}</span>
          </a>
        </div>
      </aside>

      {/* Sign-in */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between gap-3 px-5 sm:px-8 pt-5">
          <div className="flex items-center gap-2 lg:invisible">
            <div className="w-9 h-9 rounded-xl bg-surface border border-line p-1 flex items-center justify-center overflow-hidden">
              <img src={BRAND.logo} alt="" className="max-w-full max-h-full object-contain" />
            </div>
            <span className="font-extrabold tracking-tight text-fg">{BRAND.appName}</span>
          </div>
          {!online && (
            <span className="badge badge-warning" role="status">
              <WifiOff size={12} aria-hidden="true" /> Offline
            </span>
          )}
        </div>

        <div className="flex-1 flex items-center justify-center px-5 sm:px-8 py-10">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="w-full max-w-sm"
          >
            {rememberedShop && (
              <div className="w-16 h-16 mb-6 rounded-2xl bg-surface border border-line shadow-sm p-1.5 flex items-center justify-center overflow-hidden">
                <img src={logoUrl} alt={platformName} className="max-w-full max-h-full object-contain" />
              </div>
            )}

            <h2 className="text-3xl font-extrabold tracking-tight text-fg">Welcome back</h2>
            <p className="mt-2 text-fg-muted">
              {rememberedShop ? <>Sign in to <span className="font-semibold text-fg-2">{platformName}</span></> : 'Sign in to your shop to continue'}
            </p>

            {!online && (
              <p className="mt-4 text-sm text-warning-strong bg-warning-soft border border-warning-line rounded-xl px-4 py-3">
                You're offline. You can still sign in if you've signed in on this device before.
              </p>
            )}

            <form onSubmit={handleLogin} className="mt-8 space-y-5">
              <div>
                <label htmlFor="login-username" className="block text-sm font-semibold text-fg-2 mb-1.5">Email or username</label>
                <div className="relative">
                  <User size={18} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
                  <input
                    id="login-username"
                    type="text"
                    placeholder="you@example.com or username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="username"
                    className="input min-h-12 pl-11 text-base"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="login-password" className="block text-sm font-semibold text-fg-2 mb-1.5">Password</label>
                <div className="relative">
                  <Lock size={18} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="input min-h-12 pl-11 pr-12 text-base"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-10 h-10 rounded-lg flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-primary"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <AnimatePresence initial={false}>
                {(error || notice) && (
                  <motion.div
                    key={error ? 'error' : 'notice'}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    role={error ? 'alert' : 'status'}
                    className={`flex items-start gap-2.5 text-sm font-medium rounded-xl px-4 py-3 border ${
                      error
                        ? 'text-danger-strong bg-danger-soft border-danger-line'
                        : 'text-success-strong bg-success-soft border-success-line'
                    }`}
                  >
                    {error
                      ? <CircleAlert size={18} aria-hidden="true" className="shrink-0 mt-px" />
                      : <CircleCheck size={18} aria-hidden="true" className="shrink-0 mt-px" />}
                    <span>{error || notice}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              <button type="submit" disabled={loading} className="btn btn-primary btn-lg w-full shadow-lg shadow-primary/25">
                {loading ? (
                  <>
                    <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" />
                    Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight size={18} aria-hidden="true" />
                  </>
                )}
              </button>
            </form>

            <p className="mt-8 text-sm text-fg-muted">
              Forgot your password or need an account?{' '}
              <a href={supportTel} className="font-semibold text-primary-fg hover:underline whitespace-nowrap">
                Call {BRAND.supportPhone}
              </a>
            </p>
          </motion.div>
        </div>

        <footer className="lg:hidden px-5 pb-6 text-center text-xs text-fg-subtle">
          {BRAND.appName} · Developed by {BRAND.developerCredit}
        </footer>
      </main>
    </div>
  )
}

export default Login
