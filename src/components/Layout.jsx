import { useAuth } from '../context/AuthContext'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { useEffect, useState, useRef } from 'react'
import { supabase } from '../services/supabase'
import { hasFeature } from '../utils/featureGate'
import {
  LayoutDashboard, ShoppingCart, Package, Layers, Boxes,
  Users, BookOpen, MessageSquare, Receipt, Truck,
  ShoppingBag, History, Wallet, BarChart3, UserCog,
  Settings as SettingsIcon, Trash2, LifeBuoy, Lock, Store, Sun, Moon, PackageCheck
} from 'lucide-react'
import { useTheme } from '../context/ThemeContext'
import { BRAND } from '../config/brand.js'

let lastLayoutFetchTime = 0

function Layout({ children }) {
  const { user, logout, stopImpersonating } = useAuth()
  const { resolvedMode, setTheme } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()

  const [lowStock, setLowStock] = useState([])
  const [shopName, setShopName] = useState(() => {
    const sid = user?.shop_id
    return (sid ? localStorage.getItem(`shop_name_${sid}`) : null) || BRAND.appName
  })
  const [shopLogo, setShopLogo] = useState(() => {
    const sid = user?.shop_id
    return (sid ? localStorage.getItem(`shop_logo_${sid}`) : null) || ''
  })
  const [announcements, setAnnouncements] = useState([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [showUserDropdown, setShowUserDropdown] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('sidebar_collapsed') === 'true'
  })
  const [compactMode, setCompactMode] = useState(() => {
    const saved = localStorage.getItem('compact_mode')
    return saved === null ? true : saved === 'true'
  })
  const [planInfo, setPlanInfo] = useState(null)
  const [productCount, setProductCount] = useState(0)
  const dropdownRef = useRef(null)
  const userDropdownRef = useRef(null)

  const toggleSidebar = () => {
    const newVal = !sidebarCollapsed
    setSidebarCollapsed(newVal)
    localStorage.setItem('sidebar_collapsed', String(newVal))
  }

  const toggleCompactMode = () => {
    const newVal = !compactMode
    setCompactMode(newVal)
    localStorage.setItem('compact_mode', String(newVal))
  }

  useEffect(() => {
    const now = Date.now()
    const shouldFetch = (now - lastLayoutFetchTime) > 60 * 1000

    if (shouldFetch) {
      lastLayoutFetchTime = now
      fetchLowStock()
      fetchShopName()
      fetchAnnouncements()
      fetchPlanInfo()
    }

    const interval = setInterval(() => {
      lastLayoutFetchTime = Date.now()
      fetchLowStock()
      fetchShopName()
      fetchAnnouncements()
      fetchPlanInfo()
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [user?.shop_id])

  const fetchShopName = async () => {
    if (!user?.shop_id) return
    const sid = user.shop_id
    try {
      const { data } = await supabase.from('shops').select('*').eq('id', sid).maybeSingle()
      if (data?.name) {
        setShopName(data.name)
        localStorage.setItem(`shop_name_${sid}`, data.name)
      }
      // For logo: always prefer the locally-saved version (set immediately on upload)
      // Only fall back to Supabase value if we have nothing locally
      const localLogo = localStorage.getItem(`shop_logo_${sid}`) || ''
      if (localLogo) {
        setShopLogo(localLogo)
      } else if (data?.logo_url) {
        setShopLogo(data.logo_url)
        localStorage.setItem(`shop_logo_${sid}`, data.logo_url)
      }
    } catch (e) {
      const cachedName = localStorage.getItem(`shop_name_${sid}`)
      if (cachedName) setShopName(cachedName)
      const cachedLogo = localStorage.getItem(`shop_logo_${sid}`) || ''
      if (cachedLogo) setShopLogo(cachedLogo)
    }
  }

  useEffect(() => {
    // Re-read logo + shop name whenever Settings saves them to localStorage
    const handleStorage = () => {
      const sid = user?.shop_id
      const freshLogo = sid ? localStorage.getItem(`shop_logo_${sid}`) || '' : ''
      const freshName = sid ? localStorage.getItem(`shop_name_${sid}`) || '' : ''
      if (freshLogo) setShopLogo(freshLogo)
      if (freshName) setShopName(freshName)
    }
    window.addEventListener('storage', handleStorage)

    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowNotifications(false)
      }
      if (userDropdownRef.current && !userDropdownRef.current.contains(event.target)) {
        setShowUserDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const fetchLowStock = async () => {
    if (!user?.shop_id) return
    const { data } = await supabase
      .from('products')
      .select('name, stock_quantity, low_stock_threshold')
      .eq('shop_id', user.shop_id)

    if (data) {
      const filtered = data.filter(p => Number(p.stock_quantity) <= Number(p.low_stock_threshold || 10))
      setLowStock(filtered)
    }
  }

  const fetchAnnouncements = async () => {
    try {
      const { data } = await supabase
        .from('announcements')
        .select('*')
        .eq('is_active', true)
        .or(`shop_id.is.null,shop_id.eq.${user.shop_id}`)
        .order('created_at', { ascending: false })

      if (data) setAnnouncements(data)
    } catch (e) {
      console.error('Failed to fetch announcements')
    }
  }

  const fetchPlanInfo = async () => {
    if (!user?.shop_id) return
    try {
      const { data, error } = await supabase.rpc('get_shop_config', { p_shop_id: user.shop_id })
      if (!error && data) {
        setPlanInfo(data)
        // Also fetch product count
        const { count } = await supabase.from('products').select('*', { count: 'exact', head: true }).eq('shop_id', user.shop_id)
        setProductCount(count || 0)
      }
    } catch (e) {
      console.error('Plan Fetch Error', e)
    }
  }

  const handleLogout = () => {
    logout()
    navigate('/')
  }

  const hasAccess = (moduleName, allowedRoles) => {
    if (user.role === 'admin' || user.role === 'superadmin') return true
    if (user.permissions && Array.isArray(user.permissions)) {
      return user.permissions.includes(moduleName)
    }
    return allowedRoles.includes(user.role)
  }

  const pageTitle = location.pathname.split('/').pop().replace('-', ' ').toUpperCase() || 'DASHBOARD'

  return (
    <div className={`flex h-dvh bg-app overflow-hidden text-fg ${compactMode ? 'compact-mode' : ''}`}>

      {/* Mobile Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div className={`fixed md:static inset-y-0 left-0 bg-sidebar text-sidebar-fg flex flex-col shrink-0 z-50 shadow-2xl transform transition-transform duration-300 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} ${sidebarCollapsed ? 'md:w-16' : 'md:w-64'} w-64`}>
        {/* Logo */}
        <div className={`p-4 border-b border-sidebar-line flex ${sidebarCollapsed ? 'flex-col items-center gap-3' : 'items-center justify-between gap-2'} transition-all`}>
          <div className="flex items-center gap-3 min-w-0">
            {shopLogo ? (
              <div className="w-8 h-8 rounded-lg bg-surface overflow-hidden flex-shrink-0 flex items-center justify-center p-0.5">
                <img src={shopLogo} alt="Logo" className="max-w-full max-h-full object-contain" />
              </div>
            ) : (
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-black/30 flex-shrink-0">
                {shopName.charAt(0).toUpperCase()}
              </div>
            )}
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <h1 className="text-sm font-black tracking-tighter leading-none uppercase truncate w-28 text-white">{shopName}</h1>
                <p className="text-[10px] text-sidebar-muted uppercase font-bold tracking-widest mt-0.5">Control Panel</p>
              </div>
            )}
          </div>
          
          {/* Collapse Toggle Button (Desktop Only) */}
          <button 
            onClick={toggleSidebar} 
            className="hidden md:flex items-center justify-center w-7 h-7 rounded-lg bg-sidebar-hover hover:bg-sidebar-line text-sidebar-muted hover:text-white transition cursor-pointer flex-shrink-0"
            title={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            {sidebarCollapsed ? "▶" : "◀"}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 overflow-y-auto custom-scrollbar">
          <ul className="space-y-1">
            <NavHeader label="Main" collapsed={sidebarCollapsed} />
            <NavItem to="/dashboard" icon={<LayoutDashboard size={18} />} label="Dashboard" active={location.pathname === '/dashboard'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            {hasAccess('pos', ['admin', 'manager', 'cashier']) && (
              <NavItem to="/pos" icon={<ShoppingCart size={18} />} label="POS Billing" active={location.pathname === '/pos'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}

            <NavHeader label="Inventory & Products" collapsed={sidebarCollapsed} />
            {hasAccess('products', ['admin', 'manager']) && (
              <NavItem to="/products" icon={<Package size={18} />} label="Products" active={location.pathname === '/products'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('categories', ['admin', 'manager']) && (
              <NavItem to="/master-data" icon={<Layers size={18} />} label="Master Data"
                active={location.pathname.startsWith('/master-data') || location.pathname === '/categories' || location.pathname === '/brands'}
                onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('inventory', ['admin', 'manager', 'accountant']) && (
              <NavItem to="/inventory" icon={<Boxes size={18} />} label="Stock Inventory" active={location.pathname === '/inventory'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}

            <NavHeader label="Sales & Customers" collapsed={sidebarCollapsed} />
            {hasAccess('customers', ['admin', 'manager', 'cashier']) && (
              <NavItem to="/customers" icon={<Users size={18} />} label="Customers" active={location.pathname === '/customers'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('customers', ['admin', 'manager', 'cashier']) && (
              <NavItem to="/customer-ledger" icon={<BookOpen size={18} />} label="Customer Ledger" active={location.pathname === '/customer-ledger'} locked={!hasFeature('customer_ledger')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('customers', ['admin', 'manager', 'cashier']) && (
              <NavItem to="/deliveries" icon={<PackageCheck size={18} />} label="Deliveries" active={location.pathname === '/deliveries'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('customers', ['admin', 'manager', 'cashier']) && (
              <NavItem to="/whatsapp" icon={<MessageSquare size={18} />} label="WhatsApp Reminders" active={location.pathname === '/whatsapp'} locked={!hasFeature('whatsapp')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('sales', ['admin', 'manager', 'accountant']) && (
              <NavItem to="/sales" icon={<Receipt size={18} />} label="Sales History" active={location.pathname === '/sales'} locked={!hasFeature('sales_history')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}

            <NavHeader label="Procurement" collapsed={sidebarCollapsed} />
            {hasAccess('suppliers', ['admin', 'manager']) && (
              <NavItem to="/suppliers" icon={<Truck size={18} />} label="Suppliers" active={location.pathname === '/suppliers'} locked={!hasFeature('suppliers')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('purchases', ['admin', 'manager']) && (
              <NavItem to="/purchases" icon={<ShoppingBag size={18} />} label="Purchases" active={location.pathname === '/purchases'} locked={!hasFeature('purchases')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('purchase-history', ['admin', 'manager', 'accountant']) && (
              <NavItem to="/purchase-history" icon={<History size={18} />} label="Purchase History" active={location.pathname === '/purchase-history'} locked={!hasFeature('purchases')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}

            <NavHeader label="Accounts & Admin" collapsed={sidebarCollapsed} />
            {hasAccess('expenses', ['admin']) && (
              <NavItem to="/expenses" icon={<Wallet size={18} />} label="Expenses" active={location.pathname === '/expenses'} locked={!hasFeature('expenses')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('reports', ['admin', 'manager', 'accountant']) && (
              <NavItem to="/reports" icon={<BarChart3 size={18} />} label="Reports" active={location.pathname === '/reports'} locked={!hasFeature('reports')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('users', ['admin']) && (
              <NavItem to="/users" icon={<UserCog size={18} />} label="Manage Users" active={location.pathname === '/users'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}

            <NavHeader label="Settings & System" collapsed={sidebarCollapsed} />
            {hasAccess('settings', ['admin']) && (
              <NavItem to="/settings" icon={<SettingsIcon size={18} />} label="Settings" active={location.pathname === '/settings'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            {hasAccess('trash', ['admin']) && (
              <NavItem to="/trash" icon={<Trash2 size={18} />} label="Trash Bin" active={location.pathname === '/trash'} locked={!hasFeature('trash_bin')} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
            )}
            <NavItem to="/support" icon={<LifeBuoy size={18} />} label="Help & Support" active={location.pathname === '/support'} onClick={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
          </ul>
        </nav>

        {/* Credits */}
        {!sidebarCollapsed && (
          <div className="p-4 border-t border-sidebar-line flex flex-col gap-3">
            <div className="text-center px-1">
              <p className="text-[10px] text-sidebar-muted font-bold uppercase tracking-wider mb-1">Developed with <span className="text-danger-fg">❤︎</span> by</p>
              <p className="text-xs text-sidebar-fg font-semibold leading-tight">{BRAND.developerCredit}</p>
              <p className="text-[10px] font-mono text-sidebar-muted mt-1">📞 {BRAND.supportPhone}</p>
            </div>
          </div>
        )}
      </div>

      {/* Main Container */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">

        {/* Top Header */}
        <header className="h-14 sm:h-16 bg-surface border-b border-line px-3 sm:px-4 md:px-6 flex items-center justify-between shrink-0 shadow-sm z-20 transition-all">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Open menu" className="md:hidden w-10 h-10 flex items-center justify-center text-xl text-fg-2 cursor-pointer hover:bg-surface-3 rounded-lg transition flex-shrink-0">☰</button>
            <div className="flex flex-col min-w-0">
              <span className="text-fg font-black tracking-tight text-sm sm:text-lg leading-none truncate max-w-[140px] sm:max-w-[300px]">{shopName}</span>
              <span className="text-fg-subtle font-bold tracking-tight text-[10px] uppercase mt-0.5">{pageTitle}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
            {/* Light / Dark quick toggle (full options live in Settings → Appearance) */}
            <button
              type="button"
              onClick={() => setTheme({ mode: resolvedMode === 'dark' ? 'light' : 'dark' })}
              className="w-9 h-9 rounded-xl border border-line bg-surface text-fg-3 hover:bg-surface-3 hover:text-fg flex items-center justify-center transition cursor-pointer"
              title={resolvedMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={resolvedMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {resolvedMode === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>

            {/* Compact Mode Toggle */}
            <button
              onClick={toggleCompactMode}
              className={`px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-xl border text-[10px] sm:text-xs font-bold transition flex items-center gap-1.5 cursor-pointer select-none ${
                compactMode
                  ? 'bg-primary-soft text-primary-fg border-primary-muted shadow-sm shadow-primary-soft'
                  : 'bg-surface text-fg-muted border-line hover:bg-surface-2'
              }`}
              title={compactMode ? "Switch to Normal View" : "Switch to Compact View"}
            >
              <span>{compactMode ? "🔎" : "🔍"}</span>
              <span className="hidden sm:inline">{compactMode ? "Compact UI" : "Normal UI"}</span>
            </button>

            {/* Status Indicator — dot only on mobile, full pill on sm+ */}
            <div className={`flex items-center gap-1.5 rounded-full font-black uppercase tracking-widest ${isOnline ? 'text-success-fg' : 'text-warning-fg animate-pulse'}`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isOnline ? 'bg-success' : 'bg-warning'}`}></span>
              <span className={`hidden sm:inline text-[9px] px-2 py-1 rounded-full border ${isOnline ? 'bg-success-soft border-success-muted' : 'bg-warning-soft border-warning-muted'}`}>
                {isOnline ? 'System Online' : 'Offline Mode'}
              </span>
            </div>

            {/* Notification Bell */}
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className={`p-2 rounded-full transition relative group ${showNotifications ? 'bg-primary-soft text-primary-fg' : 'text-fg-muted hover:bg-surface-3'}`}
              >
                <div className={`${lowStock.length > 0 ? 'animate-bounce-slow' : ''}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                </div>
                {lowStock.length > 0 && (
                  <span className="absolute top-1.5 right-1.5 w-4 h-4 bg-danger text-white text-[9px] font-black rounded-full flex items-center justify-center border-2 border-surface ring-1 ring-danger-muted">
                    {lowStock.length}
                  </span>
                )}
              </button>

              {/* Notification Dropdown */}
              {showNotifications && (
                <div className="absolute right-0 mt-3 w-[calc(100vw-2rem)] sm:w-80 max-w-sm bg-surface rounded-2xl shadow-2xl border border-line-subtle overflow-hidden z-50 origin-top-right">
                  <div className="p-4 bg-surface-2 border-b flex justify-between items-center">
                    <h3 className="font-bold text-fg">Alerts</h3>
                    <span className="text-[10px] font-black text-white bg-danger px-2 py-0.5 rounded-full uppercase tracking-wider">{lowStock.length} Now</span>
                  </div>
                  <div className="max-h-96 overflow-y-auto custom-scrollbar">
                    {lowStock.length === 0 ? (
                      <div className="p-10 text-center">
                        <span className="text-4xl mb-2 block">✅</span>
                        <p className="text-sm text-fg-muted font-medium">Stock levels are perfect!</p>
                      </div>
                    ) : (
                      <div className="divide-y divide-line-subtle">
                        <p className="px-4 py-2 text-[10px] font-bold text-fg-subtle uppercase tracking-widest bg-danger-soft/50">Low Stock 🚩</p>
                        {lowStock.map((p, i) => (
                          <div key={i} className="p-4 hover:bg-surface-2 transition flex justify-between items-center">
                            <div className="flex-1 pr-4">
                              <p className="text-sm font-bold text-fg truncate">{p.name}</p>
                              <p className="text-xs text-danger-fg font-medium">Only {p.stock_quantity} remaining</p>
                            </div>
                            <Link to="/inventory" onClick={() => setShowNotifications(false)} className="px-3 py-1 bg-primary-soft text-primary-fg rounded text-[10px] font-black hover:bg-primary hover:text-white transition uppercase">Restock</Link>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {lowStock.length > 0 && (
                    <div className="p-3 bg-surface-2 border-t text-center">
                      <Link to="/inventory" onClick={() => setShowNotifications(false)} className="text-xs font-bold text-fg-subtle hover:text-primary-fg transition">Go to Inventory Management →</Link>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="h-6 w-px bg-surface-4 hidden sm:block"></div>

            <div className="flex items-center gap-2 sm:gap-3 relative" ref={userDropdownRef}>
              <div className="text-right hidden sm:block">
                <p className="text-sm font-black text-fg leading-none">{user?.username}</p>
                <p className="text-[10px] text-fg-subtle font-bold uppercase mt-1">{user?.role}</p>
              </div>
              <button
                onClick={() => setShowUserDropdown(!showUserDropdown)}
                className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary-hover text-white flex items-center justify-center font-black shadow-lg shadow-primary-muted ring-4 ring-primary-muted focus:outline-none focus:ring-primary-muted transition hover:scale-105"
              >
                {user?.username?.charAt(0).toUpperCase()}
              </button>

              {/* User Dropdown */}
              {showUserDropdown && (
                <div className="absolute top-[120%] right-0 w-48 bg-surface rounded-xl shadow-2xl border border-line-subtle overflow-hidden z-50 origin-top-right">
                  <div className="p-4 border-b border-line-subtle block sm:hidden">
                    <p className="text-sm font-black text-fg leading-none">{user?.username}</p>
                    <p className="text-[10px] text-fg-subtle font-bold uppercase mt-1">{user?.role}</p>
                  </div>
                  <div className="p-2">
                    {user?.isImpersonating && (
                      <button
                        onClick={() => {
                          stopImpersonating()
                          navigate('/admin/shops')
                        }}
                        className="w-full text-left px-3 py-2.5 text-sm text-primary-fg hover:bg-primary-soft rounded-lg font-bold flex items-center gap-2 transition mb-1 cursor-pointer"
                      >
                        <span>🔙</span> Exit Shop
                      </button>
                    )}
                    <button
                      onClick={handleLogout}
                      className="w-full text-left px-3 py-2.5 text-sm text-danger-fg hover:bg-danger-soft rounded-lg font-bold flex items-center gap-2 transition"
                    >
                      <span>🚪</span> Logout
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Impersonation Banner */}
        {user?.isImpersonating && (
          <div className="bg-primary text-white px-4 py-2 flex items-center justify-between text-sm shadow-inner z-10 shrink-0">
            <div className="flex items-center gap-2 font-bold">
              <span className="animate-pulse">🕵️‍♂️</span>
              <span>SUPERADMIN MODE: You are currently viewing {shopName}'s POS system.</span>
            </div>
            <button
              onClick={() => {
                stopImpersonating()
                navigate('/admin/shops')
              }}
              className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg text-xs font-black uppercase tracking-wider transition cursor-pointer"
            >
              Exit to Superadmin
            </button>
          </div>
        )}

        {/* Global Announcements Banner */}
        {announcements.length > 0 && (
          <div className="flex flex-col shrink-0">
            {announcements.map(ann => (
              <div
                key={ann.id}
                className={`px-4 py-2 flex items-center justify-between text-sm shadow-sm z-10 ${ann.type === 'error' ? 'bg-danger text-white' :
                  ann.type === 'warning' ? 'bg-warning text-white' :
                    ann.type === 'success' ? 'bg-success text-white' :
                      'bg-primary text-white'
                  }`}
              >
                <div className="flex items-center gap-2 font-medium">
                  <span className="animate-pulse">📢</span>
                  <span>{ann.message}</span>
                </div>
                <button
                  onClick={() => setAnnouncements(announcements.filter(a => a.id !== ann.id))}
                  className="p-1 hover:bg-black/10 rounded-full transition"
                  title="Dismiss"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 overflow-x-hidden overflow-y-auto bg-app custom-scrollbar relative">
          <div className="mx-auto w-full h-full p-4 md:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--fg-subtle); }
        @keyframes bounce-slow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        .animate-bounce-slow { animation: bounce-slow 2s infinite; }

        /* Compact Mode Overrides */
        .compact-mode main > div {
          padding: 0.5rem !important;
          max-width: 100% !important;
        }
        .compact-mode header {
          height: 3rem !important;
        }
        .compact-mode h1 {
          font-size: 1.25rem !important;
          line-height: 1.75rem !important;
        }
        .compact-mode h2 {
          font-size: 1rem !important;
          line-height: 1.5rem !important;
        }
        .compact-mode h3 {
          font-size: 0.875rem !important;
          line-height: 1.25rem !important;
        }
        /* Tables general density */
        .compact-mode table th {
          padding: 0.375rem 0.5rem !important;
          font-size: 0.75rem !important;
        }
        .compact-mode table td {
          padding: 0.375rem 0.5rem !important;
          font-size: 0.75rem !important;
        }
        .compact-mode table td input,
        .compact-mode table td select {
          padding: 0.125rem 0.25rem !important;
          font-size: 0.75rem !important;
        }
        /* Forms, inputs and generic buttons */
        .compact-mode input:not([type="checkbox"]):not([type="radio"]),
        .compact-mode select,
        .compact-mode button:not(.md\\:hidden):not(.pos-floating-btn):not(.fixed):not(.flex-shrink-0) {
          padding-top: 0.375rem !important;
          padding-bottom: 0.375rem !important;
          font-size: 0.75rem !important;
          border-radius: 0.5rem !important;
        }
        .compact-mode select {
          padding-right: 2rem !important;
        }
        /* Grid gap density */
        .compact-mode .grid {
          gap: 0.5rem !important;
        }
        .compact-mode .space-y-6 > * + * {
          margin-top: 0.75rem !important;
        }
        .compact-mode .space-y-4 > * + * {
          margin-top: 0.5rem !important;
        }
        .compact-mode .p-6 {
          padding: 0.75rem !important;
        }
        .compact-mode .p-4 {
          padding: 0.5rem !important;
        }
        .compact-mode .p-3 {
          padding: 0.375rem !important;
        }
        .compact-mode .rounded-2xl {
          border-radius: 0.75rem !important;
        }
        .compact-mode .rounded-xl {
          border-radius: 0.5rem !important;
        }
        /* POS Specific overrides */
        .compact-mode .pos-product-card {
          padding: 0.375rem !important;
          border-radius: 0.5rem !important;
        }
        .compact-mode .pos-product-card p {
          font-size: 0.75rem !important;
        }
        .compact-mode .pos-cart-item {
          padding: 0.375rem !important;
          border-radius: 0.5rem !important;
        }
      `}</style>
    </div>
  )
}

function NavHeader({ label, collapsed }) {
  if (collapsed) return <li className="my-2 border-b border-sidebar-line" />
  return (
    <li className="pt-4 pb-1 px-4">
      <span className="text-[10px] font-black text-sidebar-muted uppercase tracking-[0.2em]">{label}</span>
    </li>
  )
}

function NavItem({ to, icon, label, active, onClick, locked, collapsed }) {
  return (
    <li>
      <Link
        to={to}
        onClick={onClick}
        title={collapsed ? label + (locked ? " (Locked)" : "") : undefined}
        className={`flex items-center rounded-xl transition font-bold text-sm ${
          collapsed ? 'justify-center p-3 mx-1' : 'gap-3 px-4 py-3'
        } ${
          active
            ? 'bg-primary text-white shadow-lg shadow-black/30' + (collapsed ? '' : ' translate-x-1')
            : locked
              ? 'text-sidebar-muted opacity-60 hover:bg-sidebar-hover hover:opacity-80'
              : 'text-sidebar-fg/80 hover:bg-sidebar-hover hover:text-white active:scale-95'
        }`}
      >
        <span className="flex-shrink-0 flex items-center justify-center">{icon}</span>
        {!collapsed && <span className="flex-1 truncate">{label}</span>}
        {!collapsed && locked && <Lock size={13} className="ml-auto text-sidebar-muted" />}
      </Link>
    </li>
  )
}

export default Layout
