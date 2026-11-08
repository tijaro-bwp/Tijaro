// Customer portal (/c/:slug/*): a customer of one shop signs in with mobile
// number + PIN and sees their balance, bills and statement. Read-only.
// Lives outside ProtectedRoute/Layout; talks only to the portal-api Edge
// Function. See docs/CUSTOMER_PORTAL.md.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Routes, Route, NavLink, Navigate, useNavigate, useParams } from 'react-router-dom'
import { Home, ReceiptText, BookOpen, KeyRound, LogOut, Phone, MessageCircle, MoreVertical } from 'lucide-react'
import { portalCall, getPortalToken, setPortalToken } from '../../services/portalApi'
import { BRAND } from '../../config/brand.js'
import { PortalContext, Spinner, ErrorBox } from './portalUi'
import PortalLogin from './PortalLogin'
import PortalHome from './PortalHome'
import PortalBills from './PortalBills'
import PortalBill from './PortalBill'
import PortalStatement from './PortalStatement'
import PortalChangePin from './PortalChangePin'

// Keep the portal out of search engines (vercel.json also sends X-Robots-Tag).
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
}

const NAV = [
  { to: '', label: 'Home', icon: Home, end: true },
  { to: 'bills', label: 'Bills', icon: ReceiptText },
  { to: 'statement', label: 'Statement', icon: BookOpen },
]

function waLink(phone) {
  let d = String(phone || '').replace(/\D/g, '')
  if (d.startsWith('03') && d.length === 11) d = '92' + d.slice(1)
  return d ? `https://wa.me/${d}` : null
}

export default function CustomerPortal() {
  const { slug: rawSlug } = useParams()
  const slug = (rawSlug || '').toLowerCase()
  const navigate = useNavigate()
  useNoIndex()

  const [shop, setShop] = useState(null)
  const [shopError, setShopError] = useState('')
  const [authed, setAuthed] = useState(() => !!getPortalToken(slug))
  const [customerName, setCustomerName] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  // A different shop address in the same tab starts from scratch.
  useEffect(() => {
    setShop(null)
    setCustomerName('')
    setAuthed(!!getPortalToken(slug))
  }, [slug])

  const loadShop = useCallback(async () => {
    setShopError('')
    const { data, error } = await portalCall(slug, 'shop_info')
    if (error) setShopError(error.status === 404 && error.code !== 'service_unavailable'
      ? 'not_found'
      : error.message || 'Could not load this page.')
    else setShop(data)
  }, [slug])

  useEffect(() => { loadShop() }, [loadShop])

  useEffect(() => {
    document.title = shop ? `${shop.name} · Customer portal` : 'Customer portal'
  }, [shop])

  // Close the account menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  // Every authenticated call goes through here so an expired session drops back to login.
  const call = useCallback(async (action, params) => {
    const result = await portalCall(slug, action, params)
    if (result.error?.code === 'no_session') setAuthed(false)
    return result
  }, [slug])

  const onLoggedIn = (data) => {
    setCustomerName(data.customer?.name || '')
    if (data.shop) setShop(data.shop)
    setAuthed(true)
    navigate(data.must_change_pin ? `/c/${slug}/pin` : `/c/${slug}`, { replace: true })
  }

  const logout = async () => {
    setMenuOpen(false)
    await call('logout')
    setPortalToken(slug, '')
    setAuthed(false)
    navigate(`/c/${slug}`, { replace: true })
  }

  const ctx = useMemo(() => ({ slug, shop, customerName, setCustomerName, call }), [slug, shop, customerName, call])

  if (shopError === 'not_found') {
    return (
      <div className="min-h-dvh bg-app flex items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-xl font-extrabold text-fg">Page not found</h1>
          <p className="mt-2 text-fg-muted">This customer portal link isn't valid, or the shop has switched it off. Please check the link with the shop.</p>
        </div>
      </div>
    )
  }
  if (shopError) {
    return <div className="min-h-dvh bg-app p-6 flex items-center"><div className="mx-auto w-full max-w-sm"><ErrorBox onRetry={loadShop}>{shopError}</ErrorBox></div></div>
  }
  if (!shop) return <div className="min-h-dvh bg-app"><Spinner /></div>

  if (!authed) return <PortalLogin slug={slug} shop={shop} onLoggedIn={onLoggedIn} />

  const tel = shop.phone ? `tel:${String(shop.phone).replace(/[^\d+]/g, '')}` : null
  const wa = waLink(shop.phone)

  return (
    <PortalContext.Provider value={ctx}>
      <div className="min-h-dvh bg-app text-fg flex flex-col">
        <header className="sticky top-0 z-20 bg-surface/95 backdrop-blur border-b border-line print:static print:border-0">
          <div className="mx-auto max-w-3xl px-4 h-16 flex items-center gap-3">
            {shop.logo_url
              ? <img src={shop.logo_url} alt="" className="w-10 h-10 rounded-xl border border-line object-contain bg-surface p-0.5" />
              : <span className="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center font-black" aria-hidden="true">{shop.name.charAt(0).toUpperCase()}</span>}
            <div className="min-w-0 flex-1">
              <p className="font-extrabold leading-tight truncate">{shop.name}</p>
              {customerName && <p className="text-xs text-fg-muted truncate">{customerName}</p>}
            </div>

            <nav aria-label="Portal" className="hidden sm:flex items-center gap-1 print:hidden">
              {NAV.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={label}
                  to={to ? `/c/${slug}/${to}` : `/c/${slug}`}
                  end={end}
                  className={({ isActive }) => `btn btn-sm ${isActive ? 'bg-primary-soft text-primary-strong' : 'btn-ghost'}`}
                >
                  <Icon size={16} aria-hidden="true" /> {label}
                </NavLink>
              ))}
            </nav>

            <div className="relative print:hidden" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="btn btn-ghost !min-h-10 !w-10 !p-0"
                aria-label="Account menu"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <MoreVertical size={20} />
              </button>
              {menuOpen && (
                <div role="menu" className="absolute right-0 mt-2 w-56 card p-1.5 shadow-lg">
                  {tel && <a role="menuitem" href={tel} className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm hover:bg-surface-3"><Phone size={16} /> Call shop</a>}
                  {wa && <a role="menuitem" href={wa} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm hover:bg-surface-3"><MessageCircle size={16} /> WhatsApp shop</a>}
                  <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); navigate(`/c/${slug}/pin`) }} className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm hover:bg-surface-3"><KeyRound size={16} /> Change PIN</button>
                  <button role="menuitem" type="button" onClick={logout} className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-danger-fg hover:bg-danger-soft"><LogOut size={16} /> Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 w-full mx-auto max-w-3xl px-4 py-5 pb-28 sm:pb-10 print:p-0">
          <Routes>
            <Route index element={<PortalHome />} />
            <Route path="bills" element={<PortalBills />} />
            <Route path="bills/:id" element={<PortalBill />} />
            <Route path="statement" element={<PortalStatement />} />
            <Route path="pin" element={<PortalChangePin />} />
            <Route path="*" element={<Navigate to={`/c/${slug}`} replace />} />
          </Routes>
        </main>

        <footer className="hidden sm:block pb-6 text-center text-xs text-fg-subtle print:hidden">
          Powered by {BRAND.appName}
        </footer>

        {/* Phone tab bar */}
        <nav aria-label="Portal" className="sm:hidden fixed bottom-0 inset-x-0 z-20 bg-surface border-t border-line pb-[env(safe-area-inset-bottom)] print:hidden">
          <div className="grid grid-cols-3">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={label}
                to={to ? `/c/${slug}/${to}` : `/c/${slug}`}
                end={end}
                className={({ isActive }) => `flex flex-col items-center justify-center gap-0.5 py-2.5 text-xs font-semibold ${isActive ? 'text-primary-fg' : 'text-fg-muted'}`}
              >
                <Icon size={22} aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </PortalContext.Provider>
  )
}
