import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabaseAdmin } from '../services/supabase'
import { Store, Users, Activity, TrendingUp, CreditCard, DollarSign, AlertCircle, Megaphone, Trash2, Plus, Clock, RefreshCw, CheckCircle, MessageSquare } from 'lucide-react'
import { buildWhatsAppUrl, formatRenewalMessage } from '../utils/whatsappTemplates'

export default function Dashboard() {
  const [stats, setStats] = useState({ shops: 0, users: 0, activeShops: 0, mrr: 0, totalRevenue: 0, overdue: 0, onTrial: 0, gmv: 0, activeToday: 0 })
  const [announcements, setAnnouncements] = useState([])
  const [shopsList, setShopsList] = useState([])
  const [upcomingRenewals, setUpcomingRenewals] = useState([])
  const [newAnnouncement, setNewAnnouncement] = useState({ message: '', type: 'info', shop_id: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pushingUpdate, setPushingUpdate] = useState(false)
  const [lastPushTime, setLastPushTime] = useState(() => localStorage.getItem('last_push_update_time') || null)

  useEffect(() => {
    fetchStats()
  }, [])

  const fetchStats = async () => {
    if (!supabaseAdmin) {
      setError('This legacy portal is retired. Use /admin in EdgeX POS.')
      setLoading(false)
      return
    }

    try {
      const [shopsRes, usersRes, paymentsRes, salesRes] = await Promise.all([
        supabaseAdmin.from('shops').select('id, name, status, subscription_plan, subscription_fee, next_billing_date'),
        supabaseAdmin.from('users').select('id', { count: 'exact' }),
        supabaseAdmin.from('shop_payments').select('amount'),
        supabaseAdmin.from('sales').select('total_amount, created_at, shop_id')
      ])

      const shops = shopsRes.data || []
      const totalShops = shops.length
      const activeShops = shops.filter(s => s.status === 'active').length
      const totalUsers = usersRes.count || usersRes.data?.length || 0

      let mrr = 0
      let overdue = 0
      let onTrial = 0
      const today = new Date()

      shops.forEach(s => {
        if (s.status === 'active' && s.subscription_plan) {
          if (s.subscription_plan === 'monthly') mrr += Number(s.subscription_fee || 0)
          if (s.subscription_plan === 'annually') mrr += Number(s.subscription_fee || 0) / 12
          if (s.subscription_plan === 'trial') onTrial++
        }

        if (s.next_billing_date && new Date(s.next_billing_date) < today) {
          overdue++
        }
      })

      // Upcoming Renewals (Next 7 days)
      const sevenDaysFromNow = new Date()
      sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)

      const upcoming = shops.filter(s => {
        if (!s.next_billing_date || s.status !== 'active') return false
        const expiry = new Date(s.next_billing_date)
        return expiry >= today && expiry <= sevenDaysFromNow
      }).sort((a, b) => new Date(a.next_billing_date) - new Date(b.next_billing_date))

      setUpcomingRenewals(upcoming)

      const totalRevenue = (paymentsRes.data || []).reduce((sum, p) => sum + Number(p.amount || 0), 0)

      let gmv = 0;
      let activeShopsSet = new Set();
      const todayString = today.toISOString().split('T')[0];

      (salesRes.data || []).forEach(s => {
        gmv += Number(s.total_amount || 0);
        if (s.created_at && s.created_at.startsWith(todayString)) {
          activeShopsSet.add(s.shop_id);
        }
      });

      setStats({
        shops: totalShops,
        activeShops,
        users: totalUsers,
        mrr: Math.round(mrr),
        totalRevenue,
        overdue,
        onTrial,
        gmv: Math.round(gmv),
        activeToday: activeShopsSet.size
      })

      // Fetch Announcements
      const { data: annData } = await supabaseAdmin
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false })
      setAnnouncements(annData || [])
      setShopsList(shops)

    } catch (error) {
      console.error('Error fetching stats:', error)
    } finally {
      setLoading(false)
    }
  }

  const handlePostAnnouncement = async (e) => {
    e.preventDefault()
    if (!newAnnouncement.message.trim()) return

    try {
      const payload = {
        message: newAnnouncement.message,
        type: newAnnouncement.type,
        is_active: true,
        shop_id: newAnnouncement.shop_id ? Number(newAnnouncement.shop_id) : null,
      }
      const { error } = await supabaseAdmin.from('announcements').insert([payload])
      if (error) throw error
      setNewAnnouncement({ message: '', type: 'info', shop_id: '' })
      fetchStats()
    } catch (err) {
      alert('Error posting announcement: ' + err.message)
    }
  }

  const handleDeleteAnnouncement = async (id) => {
    if (!confirm('Are you sure you want to delete this announcement?')) return
    try {
      await supabaseAdmin.from('announcements').delete().eq('id', id)
      fetchStats()
    } catch {
      alert('Error deleting announcement')
    }
  }

  const handlePushUpdate = async () => {
    if (!supabaseAdmin) return alert('Service role key required.')
    if (!confirm('This will force ALL active POS clients to reload within 5 minutes. Continue?')) return
    setPushingUpdate(true)
    try {
      const newVersion = String(Date.now())
      const { error } = await supabaseAdmin
        .from('system_configs')
        .upsert({ key: 'force_refresh_version', value: newVersion, updated_at: new Date().toISOString() })
      if (error) throw error
      const timeStr = new Date().toLocaleString('en-PK')
      localStorage.setItem('last_push_update_time', timeStr)
      setLastPushTime(timeStr)
      alert('✅ Update signal sent! All POS clients will reload within 5 minutes.')
    } catch (err) {
      alert('Failed to push update: ' + err.message)
    } finally {
      setPushingUpdate(false)
    }
  }

  if (error) return <div className="p-8 text-red-600 bg-red-50 rounded-2xl font-bold">{error}</div>
  if (loading) return <div className="animate-pulse flex gap-4"><div className="h-32 w-1/4 bg-slate-200 rounded-2xl"></div></div>

  const cards = [
    { title: 'Total Registered Shops', value: stats.shops, icon: <Store size={24} className="text-blue-500" />, bg: 'bg-blue-50' },
    { title: 'Active Subscriptions', value: stats.activeShops, icon: <Activity size={24} className="text-emerald-500" />, bg: 'bg-emerald-50' },
    { title: 'Total Platform Users', value: stats.users, icon: <Users size={24} className="text-purple-500" />, bg: 'bg-purple-50' },
    { title: 'Shops Active Today', value: stats.activeToday, icon: <Activity size={24} className="text-indigo-500" />, bg: 'bg-indigo-50' },
    { title: 'Global Platform GMV', value: `Rs. ${stats.gmv.toLocaleString()}`, icon: <TrendingUp size={24} className="text-emerald-500" />, bg: 'bg-emerald-50' },
    { title: 'Clients on Trial', value: stats.onTrial, icon: <Clock size={24} className="text-orange-500" />, bg: 'bg-orange-50' },
    { title: 'Overdue Accounts', value: stats.overdue, icon: <AlertCircle size={24} className="text-red-500" />, bg: 'bg-red-50' },
    { title: 'Monthly Recurring Rev.', value: `Rs. ${stats.mrr.toLocaleString()}`, icon: <TrendingUp size={24} className="text-emerald-500" />, bg: 'bg-emerald-50' },
    { title: 'Total Revenue Collected', value: `Rs. ${stats.totalRevenue.toLocaleString()}`, icon: <DollarSign size={24} className="text-blue-500" />, bg: 'bg-blue-50' },
  ]

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {cards.map((c, i) => (
          <div key={i} className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 flex items-center gap-4">
            <div className={`w-14 h-14 rounded-xl flex items-center justify-center shrink-0 ${c.bg}`}>
              {c.icon}
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">{c.title}</p>
              <h3 className="text-3xl font-black text-slate-800 mt-1">{c.value}</h3>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-8">
        <div className="lg:col-span-4 bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100">
          <h2 className="text-xl font-bold text-slate-800 mb-2">Welcome, Superadmin</h2>
          <p className="text-slate-500 mb-6 text-sm">
            Manage your POS platform, monitor GMV, and handle shop subscriptions from one central dashboard.
          </p>

          <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100 mb-4">
            <h3 className="font-bold text-blue-900 mb-2 flex items-center gap-2 text-sm"><Activity size={18} /> Quick Tips</h3>
            <ul className="text-xs text-blue-800 space-y-2 list-disc list-inside">
              <li>Billing stats update automatically.</li>
              <li>Past-due shops are auto-suspended.</li>
              <li>Global announcements sync to all POS screens.</li>
            </ul>
          </div>

          {/* Push Update Button */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4">
            <h3 className="font-bold text-slate-800 mb-1 flex items-center gap-2 text-sm"><RefreshCw size={16} className="text-indigo-500" /> Force Client Update</h3>
            <p className="text-xs text-slate-500 mb-3">After deploying a new build, click this to force all active POS clients to reload within 5 minutes.</p>
            {lastPushTime && (
              <p className="text-[10px] text-slate-400 mb-2 flex items-center gap-1"><CheckCircle size={10} className="text-emerald-500" /> Last push: {lastPushTime}</p>
            )}
            <button
              onClick={handlePushUpdate}
              disabled={pushingUpdate}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-xl font-bold text-sm transition-all shadow-lg shadow-indigo-500/20 active:scale-95"
            >
              <RefreshCw size={16} className={pushingUpdate ? 'animate-spin' : ''} />
              {pushingUpdate ? 'Sending Signal…' : '🚀 Push Update to All Clients'}
            </button>
          </div>

          <Link
            to="/analytics"
            className="mt-6 flex items-center justify-center gap-2 w-full py-3 bg-slate-900 text-white rounded-xl font-bold text-sm hover:bg-black transition-all shadow-lg shadow-slate-200"
          >
            <TrendingUp size={18} /> View Detailed Analytics
          </Link>
        </div>

        <div className="lg:col-span-3 bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-blue-100 p-2 rounded-lg text-blue-600">
              <Clock size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">Renewals</h2>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Next 7 Days</p>
            </div>
          </div>

          <div className="space-y-3 overflow-y-auto max-h-[300px] pr-2 custom-scrollbar">
            {upcomingRenewals.length === 0 ? (
              <p className="text-center text-slate-400 py-8 text-sm italic">No renewals due this week</p>
            ) : (
              upcomingRenewals.map(shop => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const expiry = new Date(shop.next_billing_date);
                const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
                return (
                  <div key={shop.id} className="p-3 rounded-xl border border-slate-100 bg-slate-50/50 flex justify-between items-center hover:bg-slate-50 transition">
                    <div>
                      <p className="font-bold text-slate-800 text-xs">{shop.name}</p>
                      <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest">{shop.subscription_plan}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-right">
                        <p className={`text-[10px] font-black ${daysLeft <= 2 ? 'text-red-500' : 'text-orange-500'}`}>
                          {daysLeft === 0 ? 'Expires Today' : `In ${daysLeft} Day${daysLeft > 1 ? 's' : ''}`}
                        </p>
                        <p className="text-[9px] text-slate-400">{expiry.toLocaleDateString()}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const bankDetails = localStorage.getItem('superadmin_bank_details') || 'Bank: Meezan Bank / HBL\nJazzCash / EasyPaisa: 0300-1234567\nAccount Title: EdgeX POS'
                          const msg = formatRenewalMessage({
                            shopName: shop.name,
                            planName: shop.subscription_plan,
                            expiryDate: shop.next_billing_date,
                            amount: shop.subscription_fee,
                            bankDetails: bankDetails,
                            isOverdue: false
                          })
                          const url = buildWhatsAppUrl(shop.phone, msg)
                          window.open(url, '_blank')
                        }}
                        title="Send WhatsApp Renewal Reminder"
                        className="p-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg border border-emerald-200 transition active:scale-95"
                      >
                        <MessageSquare size={13} />
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="lg:col-span-5 bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100 flex flex-col">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-orange-100 p-2 rounded-lg text-orange-600">
              <Megaphone size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">Global Announcements</h2>
              <p className="text-xs text-slate-500">Broadcast messages to all active client POS screens</p>
            </div>
          </div>

          <form onSubmit={handlePostAnnouncement} className="mb-6 space-y-3">
            {/* Row 1: Target audience toggle */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider mr-1">Send To:</span>
              <button
                type="button"
                onClick={() => setNewAnnouncement({ ...newAnnouncement, shop_id: '' })}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${!newAnnouncement.shop_id
                  ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'}`}
              >
                📢 All Shops
              </button>
              <button
                type="button"
                onClick={() => setNewAnnouncement({ ...newAnnouncement, shop_id: shopsList[0]?.id?.toString() || '' })}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${newAnnouncement.shop_id
                  ? 'bg-orange-500 text-white border-orange-500 shadow-sm'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-orange-300'}`}
              >
                🏪 Specific Shop
              </button>
              {newAnnouncement.shop_id && (
                <select
                  className="flex-1 border border-orange-200 bg-orange-50 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-orange-400 outline-none font-medium text-orange-800"
                  value={newAnnouncement.shop_id}
                  onChange={e => setNewAnnouncement({ ...newAnnouncement, shop_id: e.target.value })}
                >
                  {shopsList.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
            </div>
            {/* Row 2: Type + Message + Post */}
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                value={newAnnouncement.type}
                onChange={e => setNewAnnouncement({ ...newAnnouncement, type: e.target.value })}
              >
                <option value="info">Info (Blue)</option>
                <option value="warning">Warning (Orange)</option>
                <option value="error">Critical (Red)</option>
                <option value="success">Success (Green)</option>
              </select>
              <input
                type="text"
                required
                className="flex-1 border border-slate-200 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder={newAnnouncement.shop_id
                  ? `Message for ${shopsList.find(s => String(s.id) === String(newAnnouncement.shop_id))?.name || 'selected shop'}...`
                  : 'Type announcement for ALL shops...'}
                value={newAnnouncement.message}
                onChange={e => setNewAnnouncement({ ...newAnnouncement, message: e.target.value })}
              />
              <button type="submit" className={`text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition ${newAnnouncement.shop_id ? 'bg-orange-500 hover:bg-orange-600' : 'bg-blue-600 hover:bg-blue-700'}`}>
                <Plus size={18} /> Post
              </button>
            </div>
          </form>

          <div className="flex-1 overflow-y-auto min-h-[200px] border border-slate-100 rounded-xl bg-slate-50 p-4">
            {announcements.length === 0 ? (
              <p className="text-center text-slate-400 py-8 text-sm">No active announcements</p>
            ) : (
              <div className="space-y-3">
                {announcements.map(ann => (
                  <div key={ann.id} className={`bg-white p-4 rounded-lg shadow-sm border flex justify-between gap-4 ${ann.shop_id ? 'border-orange-200 bg-orange-50/40' : 'border-slate-200'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center flex-wrap gap-2 mb-1">
                        <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full ${ann.type === 'error' ? 'bg-red-100 text-red-700' :
                          ann.type === 'warning' ? 'bg-orange-100 text-orange-700' :
                            ann.type === 'success' ? 'bg-emerald-100 text-emerald-700' :
                              'bg-blue-100 text-blue-700'
                          }`}>
                          {ann.type}
                        </span>
                        {ann.shop_id ? (
                          <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 flex items-center gap-1">
                            🏪 {shopsList.find(s => s.id === ann.shop_id)?.name || `Shop #${ann.shop_id}`}
                          </span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                            📢 Global
                          </span>
                        )}
                        <span className="text-xs text-slate-400">
                          {new Date(ann.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-slate-800">{ann.message}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteAnnouncement(ann.id)}
                      className="text-slate-400 hover:text-red-500 transition self-start p-1"
                      title="Delete Announcement"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
