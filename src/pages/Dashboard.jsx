import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../services/supabase'
import { fetchAllRows } from '../services/fetchAll'
import { useAuth } from '../context/AuthContext'
import { db } from '../services/db'
import { printHTML, getShopBranding } from '../utils/printUtils'
import { getShopSettings, isWholesaleEnabled } from '../utils/businessPresets'

const StatCard = ({ title, value, icon, color, subValue }) => (
  <div className="bg-surface p-6 rounded-2xl shadow-sm border border-line-subtle hover:shadow-md transition">
    <div className="flex justify-between items-start mb-4">
      <div className={`p-3 rounded-xl ${color} bg-opacity-10 text-xl`}>
        {icon}
      </div>
      {subValue && <span className="text-xs font-bold text-fg-subtle uppercase tracking-wider">{subValue}</span>}
    </div>
    <h3 className="text-fg-muted text-sm font-medium">{title}</h3>
    <p className="text-2xl font-bold text-fg mt-1">
      {typeof value === 'number' && title.includes('Rs') ? `Rs. ${value.toLocaleString()}` : value}
    </p>
  </div>
)

function Dashboard() {
  const { user, logout } = useAuth()
  const wholesaleEnabled = isWholesaleEnabled(getShopSettings(user?.shop_id))
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({
    todaySales: 0,
    todayProfit: 0,
    todayCashSales: 0,
    todayCreditSales: 0,
    todayWholesaleSales: 0,
    monthlySales: 0,
    totalReceivables: 0,
    lowStockCount: 0,
    productCount: 0,
    planInfo: null,
    topDebtors: []
  })
  const [dailyTarget, setDailyTarget] = useState(() => Number(localStorage.getItem('daily_sales_target') || 0))
  const [editingTarget, setEditingTarget] = useState(false)
  const [targetInput, setTargetInput] = useState('')
  const [showEOD, setShowEOD] = useState(false)
  const [eodData, setEodData] = useState(null)
  const [eodLoading, setEodLoading] = useState(false)

  useEffect(() => {
    if (user?.shop_id) fetchDashboardStats()
  }, [user?.shop_id])

  const fetchDashboardStats = async () => {
    setLoading(true)
    try {
      if (!navigator.onLine) throw new Error('Offline')
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

      const fetchPromise = Promise.all([
        supabase.from('sales').select(`total_amount, discount, payment_type${wholesaleEnabled ? ', price_tier' : ''}, sale_items(cost_price, quantity, returned_qty)`).eq('shop_id', user.shop_id).eq('sale_type', 'sale').gte('created_at', today.toISOString()),
        fetchAllRows(() => supabase.from('sales').select('total_amount, discount').eq('shop_id', user.shop_id).eq('sale_type', 'sale').gte('created_at', firstDayOfMonth.toISOString())),
        fetchAllRows(() => supabase.from('customers').select('id, name, outstanding_balance').eq('shop_id', user.shop_id)),
        fetchAllRows(() => supabase.from('products').select('id, stock_quantity, low_stock_threshold').eq('shop_id', user.shop_id)),
        supabase.rpc('get_shop_config', { p_shop_id: user.shop_id })
      ])

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000))
      const [todayRes, monthRes, custRes, prodRes, shopConfigRes] = await Promise.race([fetchPromise, timeoutPromise])

      const config = shopConfigRes.data || {}
      if (config.status === 'suspended' && !user.isImpersonating) {
        alert('Aap ka account fee na-adaiyegy ki wajah se muattal (suspended) kar diya gaya hai. Log out kiya ja raha hai.')
        logout()
        navigate('/')
        return
      }

      // Update local limits cache
      localStorage.setItem('plan_limits', JSON.stringify({
        product_limit: config.product_limit || 100,
        user_limit: config.user_limit || 3,
        plan_name: config.plan_name || 'TRIAL'
      }))

      // Log non-critical errors but don't throw — use empty arrays as fallback
      if (todayRes.error) console.warn('Dashboard: todaySales fetch error', todayRes.error.message)
      if (monthRes.error) console.warn('Dashboard: monthlySales fetch error', monthRes.error.message)
      if (custRes.error) console.warn('Dashboard: customers fetch error', custRes.error.message)

      const todaySalesList = todayRes.data || []
      const todayTotal = todaySalesList.reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0)
      const todayCOGS = todaySalesList.reduce((sum, s) =>
        sum + (s.sale_items || []).reduce((iSum, i) => {
          const netQty = Math.max(0, Number(i.quantity || 0) - Number(i.returned_qty || 0))
          return iSum + Number(i.cost_price || 0) * netQty
        }, 0), 0)
      const todayCashSales = todaySalesList.filter(s => s.payment_type === 'cash').reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0)
      const todayCreditSales = todaySalesList.filter(s => s.payment_type !== 'cash').reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0)
      const monthlyTotal = (monthRes.data || []).reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0)
      const totalReceivables = (custRes.data || []).reduce((sum, c) => sum + Number(c.outstanding_balance || 0), 0)
      const productList = prodRes.data || []

      const custList = custRes.data || []
      setStats({
        todaySales: todayTotal,
        todayProfit: todayTotal - todayCOGS,
        todayCashSales,
        todayCreditSales,
        todayWholesaleSales: todaySalesList.filter(s => s.price_tier === 'wholesale').reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0),
        monthlySales: monthlyTotal,
        totalReceivables,
        lowStockCount: productList.filter(p => Number(p.stock_quantity) <= Number(p.low_stock_threshold || 10)).length,
        productCount: productList.length,
        planInfo: config,
        topDebtors: custList.filter(c => Number(c.outstanding_balance) > 0).sort((a, b) => b.outstanding_balance - a.outstanding_balance).slice(0, 5)
      })
    } catch (err) {
      console.log('Dashboard: Calculating stats from local DB (Offline)')
      try {
        const sid = String(user.shop_id)
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

        const [lSales, lCustomers, lProducts] = await Promise.all([
          db.sales.where('shop_id').equals(parseInt(sid) || sid).toArray().catch(() => db.sales.toArray()),
          db.customers.where('shop_id').equals(parseInt(sid) || sid).toArray().catch(() => db.customers.toArray()),
          db.products.where('shop_id').equals(parseInt(sid) || sid).toArray().catch(() => db.products.toArray())
        ])

        const limits = JSON.parse(localStorage.getItem('plan_limits') || '{}')

        // Safe filtering
        const mySales = lSales.filter(x => String(x.shop_id) === sid && x.sale_type === 'sale')
        const myCustomers = lCustomers.filter(x => String(x.shop_id) === sid)
        const myProducts = lProducts.filter(x => String(x.shop_id) === sid)

        const tSales = mySales.filter(s => new Date(s.created_at) >= today)
        const mSales = mySales.filter(s => new Date(s.created_at) >= firstDayOfMonth)

        // Estimate today's profit from local sale_items
        const todaySaleIds = tSales.map(s => s.id)
        const lItems = await db.sale_items.toArray().catch(() => [])
        const todayItems = lItems.filter(i => todaySaleIds.includes(i.sale_id))
        const todayCOGSOffline = todayItems.reduce((sum, i) => {
          const netQty = Math.max(0, Number(i.quantity || 0) - Number(i.returned_qty || 0))
          return sum + Number(i.cost_price || 0) * netQty
        }, 0)
        const tTotalSales = tSales.reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0)

        setStats({
          todaySales: tTotalSales,
          todayProfit: tTotalSales - todayCOGSOffline,
          todayCashSales: tSales.filter(s => s.payment_type === 'cash').reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0),
          todayCreditSales: tSales.filter(s => s.payment_type !== 'cash').reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0),
          todayWholesaleSales: tSales.filter(s => s.price_tier === 'wholesale').reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0),
          monthlySales: mSales.reduce((sum, s) => sum + (Number(s.total_amount) - Number(s.discount || 0)), 0),
          totalReceivables: myCustomers.reduce((sum, c) => sum + Number(c.outstanding_balance || 0), 0),
          lowStockCount: myProducts.filter(p => Number(p.stock_quantity) <= Number(p.low_stock_threshold || 10)).length,
          productCount: myProducts.length,
          planInfo: {
            plan_name: limits.plan_name || 'OFFLINE',
            product_limit: limits.product_limit || 100,
            next_billing_date: limits.next_billing_date || null,
            subscription_fee: limits.subscription_fee || 0
          },
          topDebtors: myCustomers.filter(c => Number(c.outstanding_balance) > 0).sort((a, b) => b.outstanding_balance - a.outstanding_balance).slice(0, 5)
        })
      } catch (localError) {
        console.error('Final Dashboard Fallback Error:', localError)
      }
    } finally {
      setLoading(false)
    }
  }

  const openEOD = async () => {
    setEodLoading(true)
    setShowEOD(true)
    try {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const [expRes, purRes] = await Promise.all([
        supabase.from('expenses').select('amount').eq('shop_id', user.shop_id).gte('created_at', today.toISOString()),
        supabase.from('purchases').select('total_amount, payment_type').eq('shop_id', user.shop_id).gte('created_at', today.toISOString())
      ])
      const todayExpenses = (expRes.data || []).reduce((s, e) => s + Number(e.amount || 0), 0)
      const todayCashPurchases = (purRes.data || []).filter(p => p.payment_type === 'cash').reduce((s, p) => s + Number(p.total_amount || 0), 0)
      const todayCreditPurchases = (purRes.data || []).filter(p => p.payment_type !== 'cash').reduce((s, p) => s + Number(p.total_amount || 0), 0)
      setEodData({
        cashSales: stats.todayCashSales,
        creditSales: stats.todayCreditSales,
        totalSales: stats.todaySales,
        profit: stats.todayProfit,
        expenses: todayExpenses,
        cashPurchases: todayCashPurchases,
        creditPurchases: todayCreditPurchases,
        netCash: stats.todayCashSales - todayExpenses - todayCashPurchases
      })
    } catch (e) {
      console.error('EOD fetch error:', e)
    } finally {
      setEodLoading(false)
    }
  }

  const shareEODWhatsApp = () => {
    const d = eodData
    if (!d) return
    const dateStr = new Date().toLocaleDateString('en-PK')
    const sid = user?.shop_id
    const shopName = (sid ? localStorage.getItem(`shop_name_${sid}`) : null) || 'My Shop'
    const msg =
      `🌙 *End of Day — ${dateStr}*\n*${shopName}*\n\n` +
      `💵 Cash Sales: Rs. ${d.cashSales.toLocaleString()}\n` +
      `📒 Credit: Rs. ${d.creditSales.toLocaleString()}\n` +
      `📊 Total Sales: Rs. ${d.totalSales.toLocaleString()}\n\n` +
      `💸 Expenses: Rs. ${d.expenses.toLocaleString()}\n` +
      `📦 Cash Purchases: Rs. ${d.cashPurchases.toLocaleString()}\n\n` +
      `📈 Gross Profit: Rs. ${d.profit.toLocaleString()}\n` +
      `💰 *Net Cash: Rs. ${d.netCash.toLocaleString()}*`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank')
  }

  const printEOD = () => {
    const d = eodData
    if (!d) return
    const branding = getShopBranding(user?.shop_id)
    const dateStr = new Date().toLocaleDateString('en-PK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    printHTML(`<html><head><title>End of Day Report</title>
      <style>
        @page{size:80mm auto;margin:2mm}
        *{box-sizing:border-box}
        body{font-family:monospace;width:302px;margin:0 auto;padding:12px 8px;font-size:13px;}
        h2,p.center{text-align:center;margin:2px 0;}
        hr{border-top:1px dashed #000;margin:8px 0;}
        .row{display:flex;justify-content:space-between;padding:4px 0;}
        .bold{font-weight:bold;} .green{color:green;} .red{color:red;} .blue{color:blue;}
      </style></head><body>
      <h2>${branding.name}</h2>
      ${branding.phone ? `<p class="center" style="font-size:11px;">${branding.phone}</p>` : ''}
      ${branding.address ? `<p class="center" style="font-size:10px;color:#555;">${branding.address}</p>` : ''}
      <p class="center bold" style="font-size:13px;margin-top:4px;">🌙 END OF DAY REPORT</p>
      <p class="center">${dateStr}</p>
      <hr/>
      <p class="center bold">SALES SUMMARY</p>
      <div class="row"><span>💵 Cash Sales</span><span class="green bold">Rs. ${d.cashSales.toLocaleString()}</span></div>
      <div class="row"><span>📒 Credit</span><span class="red bold">Rs. ${d.creditSales.toLocaleString()}</span></div>
      <div class="row bold"><span>Total Sales</span><span>Rs. ${d.totalSales.toLocaleString()}</span></div>
      <hr/>
      <p class="center bold">EXPENSES &amp; PURCHASES</p>
      <div class="row"><span>💸 Expenses</span><span class="red">Rs. ${d.expenses.toLocaleString()}</span></div>
      <div class="row"><span>📦 Cash Purchases</span><span class="red">Rs. ${d.cashPurchases.toLocaleString()}</span></div>
      <div class="row"><span>📦 Credit Purchases</span><span>Rs. ${d.creditPurchases.toLocaleString()}</span></div>
      <hr/>
      <div class="row bold"><span>📈 Gross Profit</span><span class="${d.profit >= 0 ? 'green' : 'red'}">Rs. ${d.profit.toLocaleString()}</span></div>
      <div class="row bold" style="font-size:15px;"><span>💰 Net Cash</span><span class="${d.netCash >= 0 ? 'green' : 'red'}">Rs. ${d.netCash.toLocaleString()}</span></div>
      <hr/>
      <p class="center" style="font-size:11px;color:#888;">Generated: ${new Date().toLocaleTimeString('en-PK')}</p>
      </body></html>`)
  }
  const getBillingWarning = () => {
    if (!stats.planInfo || !stats.planInfo.next_billing_date) return null
    const nextBilling = new Date(stats.planInfo.next_billing_date)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    
    if (nextBilling < today) {
      const diffTime = Math.abs(today - nextBilling)
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
      const daysRemaining = 7 - diffDays
      
      if (daysRemaining > 0) {
        return {
          overdue: true,
          daysRemaining,
          dueDate: nextBilling.toLocaleDateString('en-PK', { dateStyle: 'medium' }),
          deadlineDate: new Date(nextBilling.getTime() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-PK', { dateStyle: 'medium' })
        }
      }
    }
    return null
  }

  const billingWarning = getBillingWarning()

  return (
    <div className="max-w-6xl mx-auto">
      {billingWarning && (
        <div className="mb-6 p-4 bg-warning-soft border border-warning-line rounded-2xl flex items-center justify-between shadow-sm animate-pulse">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <h4 className="font-extrabold text-warning-strong text-sm">Subscription Overdue Notice</h4>
              <p className="text-xs text-warning-strong font-semibold mt-0.5">
                Your subscription payment was due on {billingWarning.dueDate}.
                Please pay by <strong className="underline text-danger-fg">{billingWarning.deadlineDate}</strong> to avoid service suspension.
              </p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <span className="bg-warning text-white font-black text-[10px] px-3 py-1.5 rounded-full uppercase tracking-wider">
              {billingWarning.daysRemaining} {billingWarning.daysRemaining === 1 ? 'Day' : 'Days'} Left
            </span>
          </div>
        </div>
      )}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-fg">Assalam-o-Alaikum, {user.username}! 👋</h1>
          <p className="text-fg-muted mt-1">Today's Summary</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={openEOD}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-bold rounded-xl transition shadow"
            title="End of Day Summary"
          >
            🌙 Close Day
          </button>
          <button
            onClick={fetchDashboardStats}
            className="p-2 text-fg-subtle hover:text-primary-fg transition"
            title="Refresh Stats"
          >
            🔄
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 animate-pulse">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-32 bg-surface-3 rounded-2xl"></div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard
            title="Today's Sales (Rs)"
            value={stats.todaySales}
            icon="💰"
            color="text-success-fg bg-success"
            subValue="Today"
          />
          <StatCard
            title="Today's Profit (Rs)"
            value={stats.todayProfit}
            icon="📈"
            color="text-success-fg bg-success"
            subValue="Gross"
          />
          <StatCard
            title="Monthly Sales (Rs)"
            value={stats.monthlySales}
            icon="🗓️"
            color="text-primary-fg bg-primary"
            subValue="This Month"
          />
          <StatCard
            title="Total Receivables (Rs)"
            value={stats.totalReceivables}
            icon="📒"
            color="text-warning-fg bg-warning"
            subValue="Pending"
          />
          <StatCard
            title="Low Stock Products"
            value={stats.lowStockCount}
            icon="⚠️"
            color="text-danger-fg bg-danger"
            subValue="Alert"
          />
        </div>
      )}

      {/* Today's cash vs credit breakdown */}
      {!loading && (stats.todayCashSales > 0 || stats.todayCreditSales > 0) && (
        <div className="flex gap-3 mt-3">
          <div className="flex-1 bg-success-soft border border-success-muted rounded-xl px-4 py-2 flex justify-between items-center">
            <span className="text-sm font-medium text-success-strong">💵 Cash Sales</span>
            <span className="font-bold text-success-strong">Rs. {stats.todayCashSales.toLocaleString()}</span>
          </div>
          <div className="flex-1 bg-warning-soft border border-warning-muted rounded-xl px-4 py-2 flex justify-between items-center">
            <span className="text-sm font-medium text-warning-strong">📒 Credit</span>
            <span className="font-bold text-warning-strong">Rs. {stats.todayCreditSales.toLocaleString()}</span>
          </div>
        </div>
      )}
      {!loading && wholesaleEnabled && stats.todayWholesaleSales > 0 && (
        <div className="mt-3 bg-wholesale-soft border border-wholesale-line rounded-xl px-4 py-2 flex justify-between items-center">
          <span className="text-sm font-medium text-wholesale-strong">🏷️ Wholesale Sales Today</span>
          <span className="font-bold text-wholesale-strong">Rs. {stats.todayWholesaleSales.toLocaleString()}</span>
        </div>
      )}


      {/* Daily Sales Target */}
      <div className="mt-6 bg-surface rounded-2xl border border-line-subtle shadow-sm p-4">
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-2">
            <span className="text-lg">🎯</span>
            <span className="font-bold text-fg-2 text-sm">Daily Sales Target</span>
          </div>
          {!editingTarget ? (
            <button onClick={() => { setEditingTarget(true); setTargetInput(String(dailyTarget || '')) }}
              className="text-xs text-primary-fg hover:text-primary-strong font-semibold">
              {dailyTarget ? '✏️ Edit' : '+ Set Target'}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <input type="number" value={targetInput} onChange={e => setTargetInput(e.target.value)}
                className="w-28 px-2 py-1 border rounded-lg text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="e.g. 50000" autoFocus />
              <button onClick={() => { const t = Number(targetInput) || 0; setDailyTarget(t); localStorage.setItem('daily_sales_target', t); setEditingTarget(false) }}
                className="text-xs bg-primary hover:bg-primary-hover text-white px-3 py-1 rounded-lg font-bold">Save</button>
              <button onClick={() => setEditingTarget(false)} className="text-xs text-fg-subtle hover:text-fg-3">✕</button>
            </div>
          )}
        </div>
        {dailyTarget > 0 ? (() => {
          const pct = Math.min(100, (stats.todaySales / dailyTarget) * 100)
          const color = pct >= 100 ? 'bg-success' : pct >= 70 ? 'bg-primary' : pct >= 40 ? 'bg-warning' : 'bg-danger'
          return (
            <>
              <div className="w-full bg-surface-3 rounded-full h-3 overflow-hidden">
                <div className={`h-3 rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-between mt-1 text-xs text-fg-muted">
                <span>Rs. {stats.todaySales.toLocaleString()} achieved</span>
                <span className={`font-bold ${pct >= 100 ? 'text-success-fg' : 'text-fg-3'}`}>
                  {pct >= 100 ? '🎉 Target Hit!' : `${pct.toFixed(0)}% — Rs. ${(dailyTarget - stats.todaySales).toLocaleString()} remaining`}
                </span>
              </div>
            </>
          )
        })() : (
          <p className="text-xs text-fg-subtle italic">No target set. Click "+ Set Target" to add a daily goal.</p>
        )}
      </div>

      {/* Top Debtors */}
      {stats.topDebtors.length > 0 && (
        <div className="mt-4 bg-surface rounded-2xl border border-line-subtle shadow-sm p-4">
          <div className="flex justify-between items-center mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">📒</span>
              <span className="font-bold text-fg-2 text-sm">Top Debtors</span>
            </div>
            <Link to="/customer-ledger" className="text-xs text-primary-fg hover:text-primary-strong font-semibold">View All →</Link>
          </div>
          <div className="space-y-2">
            {stats.topDebtors.map((c, i) => (
              <Link key={c.id} to={`/customers/${c.id}`} className="flex items-center justify-between hover:bg-surface-2 rounded-lg px-2 py-1.5 transition group">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black text-fg-faint w-4">{i + 1}</span>
                  <span className="text-sm font-medium text-fg-2 group-hover:text-primary-fg">{c.name}</span>
                </div>
                <span className="text-sm font-bold text-danger-fg">Rs. {Number(c.outstanding_balance).toLocaleString()}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="mt-10">
        <h2 className="text-xl font-bold text-fg mb-6">Quick Actions</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Link to="/pos" className="flex flex-col items-center p-6 bg-primary text-white rounded-2xl hover:bg-primary-hover transition shadow-lg shadow-primary-line">
            <span className="text-3xl mb-2">🛒</span>
            <span className="font-bold">New Sale</span>
          </Link>
          <Link to="/customers" className="flex flex-col items-center p-6 bg-surface border border-line text-fg-2 rounded-2xl hover:bg-surface-2 transition shadow-sm">
            <span className="text-3xl mb-2">👥</span>
            <span className="font-bold">Customers</span>
          </Link>
          <Link to="/sales" className="flex flex-col items-center p-6 bg-surface border border-line text-fg-2 rounded-2xl hover:bg-surface-2 transition shadow-sm">
            <span className="text-3xl mb-2">📜</span>
            <span className="font-bold">Sales History</span>
          </Link>
          <Link to="/products" className="flex flex-col items-center p-6 bg-surface border border-line text-fg-2 rounded-2xl hover:bg-surface-2 transition shadow-sm">
            <span className="text-3xl mb-2">📦</span>
            <span className="font-bold">Inventory</span>
          </Link>
        </div>
      </div>

      {/* Visual background element */}
      <div className="fixed top-0 right-0 -z-10 opacity-5 pointer-events-none">
        <span className="text-[400px]">🔧</span>
      </div>

      {/* EOD Modal */}
      {showEOD && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start sm:items-center justify-center z-50 overflow-y-auto py-4 px-2 sm:px-4">
          <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md">
            <div className="p-6 border-b border-line-subtle">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold text-fg">🌙 End of Day Summary</h2>
                <button onClick={() => setShowEOD(false)} className="text-fg-subtle hover:text-fg-3 text-2xl leading-none">×</button>
              </div>
              <p className="text-sm text-fg-muted mt-1">{new Date().toLocaleDateString('en-PK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
            </div>

            {eodLoading ? (
              <div className="p-8 text-center text-fg-subtle">Loading summary...</div>
            ) : eodData ? (
              <div className="p-6 space-y-4">
                <div>
                  <p className="text-xs font-bold text-fg-subtle uppercase tracking-wider mb-2">Sales</p>
                  <div className="space-y-2">
                    <div className="flex justify-between"><span className="text-fg-3">💵 Cash Sales</span><span className="font-bold text-success-fg">Rs. {eodData.cashSales.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-fg-3">📒 Credit</span><span className="font-bold text-warning-fg">Rs. {eodData.creditSales.toLocaleString()}</span></div>
                    <div className="flex justify-between border-t pt-2"><span className="font-semibold text-fg">Total Sales</span><span className="font-bold text-fg">Rs. {eodData.totalSales.toLocaleString()}</span></div>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-bold text-fg-subtle uppercase tracking-wider mb-2">Outflows</p>
                  <div className="space-y-2">
                    <div className="flex justify-between"><span className="text-fg-3">💸 Expenses</span><span className="font-bold text-danger-fg">Rs. {eodData.expenses.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-fg-3">📦 Cash Purchases</span><span className="font-bold text-danger-fg">Rs. {eodData.cashPurchases.toLocaleString()}</span></div>
                    {eodData.creditPurchases > 0 && <div className="flex justify-between"><span className="text-fg-3">📦 Credit Purchases</span><span className="font-medium text-fg-muted">Rs. {eodData.creditPurchases.toLocaleString()}</span></div>}
                  </div>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 space-y-2 border border-line-subtle">
                  <div className="flex justify-between">
                    <span className="font-semibold text-fg-2">📈 Gross Profit</span>
                    <span className={`font-bold text-lg ${eodData.profit >= 0 ? 'text-success-fg' : 'text-danger-fg'}`}>Rs. {eodData.profit.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between border-t pt-2">
                    <span className="font-bold text-fg">💰 Net Cash in Hand</span>
                    <span className={`font-black text-xl ${eodData.netCash >= 0 ? 'text-success-fg' : 'text-danger-fg'}`}>Rs. {eodData.netCash.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ) : <div className="p-8 text-center text-danger-fg">Could not load data.</div>}

            <div className="p-4 border-t border-line-subtle flex gap-3">
              {eodData && <button onClick={printEOD} className="flex-1 py-2.5 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl transition">🖨️ Print</button>}
              {eodData && <button onClick={shareEODWhatsApp} className="flex-1 py-2.5 bg-success hover:bg-success-hover text-white font-bold rounded-xl transition">📱 WhatsApp</button>}
              <button onClick={() => setShowEOD(false)} className="flex-1 py-2.5 bg-surface-3 hover:bg-surface-4 text-fg-2 font-bold rounded-xl transition">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Dashboard