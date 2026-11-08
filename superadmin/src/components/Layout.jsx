import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { Link, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Store, LogOut, ShieldAlert, CreditCard, Activity,
  Send, Zap, LifeBuoy, TrendingUp, Menu, X, ChevronRight, DatabaseBackup
} from 'lucide-react'

const NAV_SECTIONS = [
  {
    label: 'Main',
    items: [
      { name: 'Dashboard', path: '/', icon: LayoutDashboard },
      { name: 'Analytics', path: '/analytics', icon: TrendingUp },
    ]
  },
  {
    label: 'Business',
    items: [
      { name: 'Manage Shops', path: '/shops', icon: Store },
      { name: 'Billing & Subs', path: '/subscriptions', icon: CreditCard },
      { name: 'Subscription Plans', path: '/plans', icon: Zap },
    ]
  },
  {
    label: 'Support & System',
    items: [
      { name: 'Support Tickets', path: '/tickets', icon: LifeBuoy },
      { name: 'Shop Backups', path: '/backups', icon: DatabaseBackup },
      { name: 'System Logs', path: '/audit-logs', icon: Activity },
      { name: 'Email Broadcasts', path: '/broadcast', icon: Send },
    ]
  },
]

// Bottom tab items for mobile (most used)
const BOTTOM_TABS = [
  { name: 'Dashboard', path: '/', icon: LayoutDashboard },
  { name: 'Shops', path: '/shops', icon: Store },
  { name: 'Plans', path: '/plans', icon: Zap },
  { name: 'Billing', path: '/subscriptions', icon: CreditCard },
  { name: 'More', path: null, icon: Menu }, // opens sidebar
]

export default function Layout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const closeSidebar = () => setSidebarOpen(false)

  const allItems = NAV_SECTIONS.flatMap(s => s.items)
  const currentPage = allItems.find(i => i.path === location.pathname)

  const isActive = (path) => location.pathname === path

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden">

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-20 lg:hidden" onClick={closeSidebar} />
      )}

      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className={`
        fixed lg:static inset-y-0 left-0 z-30
        w-64 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0
        transition-transform duration-300 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>

        {/* Brand */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-xl shadow-lg shadow-blue-500/30">
              <ShieldAlert size={20} className="text-white" />
            </div>
            <div>
              <h1 className="font-black text-white text-sm leading-tight uppercase tracking-wider">EdgeX Admin</h1>
              <p className="text-[10px] text-slate-400 font-bold tracking-widest uppercase">Global Control</p>
            </div>
          </div>
          <button onClick={closeSidebar} className="lg:hidden text-slate-500 hover:text-white p-1 rounded-lg transition">
            <X size={20} />
          </button>
        </div>

        {/* Nav sections */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {NAV_SECTIONS.map(section => (
            <div key={section.label}>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 px-3 mb-1.5">
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map(item => {
                  const Icon = item.icon
                  const active = isActive(item.path)
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      onClick={closeSidebar}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl font-semibold text-sm transition-all group ${
                        active
                          ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                          : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      <Icon size={18} className={active ? 'text-white' : 'text-slate-500 group-hover:text-white'} />
                      <span className="flex-1">{item.name}</span>
                      {active && <ChevronRight size={14} className="text-blue-200" />}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-slate-800">
          <div className="bg-slate-800 rounded-xl px-4 py-3 mb-2">
            <p className="text-[10px] text-slate-500 font-bold uppercase mb-0.5">Signed in as</p>
            <p className="text-xs text-white font-semibold truncate">{user?.email}</p>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-red-500/10 hover:bg-red-500 hover:text-white text-red-400 rounded-xl font-bold text-sm transition"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Top header */}
        <header className="h-14 bg-white border-b border-slate-200 flex items-center px-4 gap-3 shrink-0 shadow-sm">
          {/* Hamburger — mobile only */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 rounded-xl text-slate-600 hover:bg-slate-100 transition"
          >
            <Menu size={20} />
          </button>

          {/* Breadcrumb */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-slate-400 font-semibold hidden sm:block">EdgeX Admin</span>
            <span className="text-slate-300 hidden sm:block">/</span>
            <h2 className="text-sm font-bold text-slate-800 truncate">
              {currentPage?.name || 'Dashboard'}
            </h2>
          </div>

          {/* Right — user pill (desktop) */}
          <div className="ml-auto hidden lg:flex items-center gap-2 bg-slate-100 rounded-full px-3 py-1.5">
            <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-black">
              {user?.email?.[0]?.toUpperCase() || 'S'}
            </div>
            <span className="text-xs font-semibold text-slate-700 max-w-[160px] truncate">{user?.email}</span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-4 lg:p-6 pb-20 lg:pb-6">
          <Outlet />
        </main>
      </div>

      {/* ── Mobile bottom nav ───────────────────────────────── */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-20 bg-white border-t border-slate-200 flex items-center shadow-lg">
        {BOTTOM_TABS.map(tab => {
          const Icon = tab.icon
          if (tab.path === null) {
            // "More" opens the sidebar
            return (
              <button
                key="more"
                onClick={() => setSidebarOpen(true)}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-slate-400 transition`}
              >
                <Icon size={20} />
                <span className="text-[10px] font-bold">{tab.name}</span>
              </button>
            )
          }
          const active = isActive(tab.path)
          return (
            <Link
              key={tab.path}
              to={tab.path}
              className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 transition ${
                active ? 'text-blue-600' : 'text-slate-400'
              }`}
            >
              <Icon size={20} />
              <span className="text-[10px] font-bold">{tab.name}</span>
              {active && <span className="absolute bottom-0 h-0.5 w-8 bg-blue-600 rounded-full" />}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
