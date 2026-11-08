import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { fetchAllRows } from '../services/fetchAll'
import { useAuth } from '../context/AuthContext'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'
import { db } from '../services/db'
import { hasFeature } from '../utils/featureGate'
import UpgradeWall from '../components/UpgradeWall'
import { getShopSettings, isWholesaleEnabled } from '../utils/businessPresets'

// Net sales and gross profit split by price tier (sales.price_tier; missing = retail)
function computeTierSplit(sales, items) {
  const split = { retail: { count: 0, sales: 0, profit: 0 }, wholesale: { count: 0, sales: 0, profit: 0 } }
  const tierBySale = {}
  sales.forEach(s => {
    const tier = s.price_tier === 'wholesale' ? 'wholesale' : 'retail'
    tierBySale[s.id] = tier
    const net = Number(s.total_amount || 0) - Number(s.discount || 0)
    split[tier].count += 1
    split[tier].sales += net
    split[tier].profit += net
  })
  items.forEach(i => {
    const tier = tierBySale[i.sale_id]
    if (!tier) return
    const qty = Number(i.quantity) - Number(i.returned_qty || 0)
    split[tier].profit -= Number(i.cost_price || 0) * qty
  })
  return split
}
import { printHTML, getShopBranding, brandedA4Header } from '../utils/printUtils'

function Reports() {
  const { user } = useAuth()
  const wholesaleEnabled = isWholesaleEnabled(getShopSettings(user?.shop_id))
  const [tierSplit, setTierSplit] = useState(null)
  const [loading, setLoading] = useState(true)
  // Set when figures come from this device's saved data instead of the server
  const [fromCache, setFromCache] = useState(null)
  const [range, setRange] = useState('month') // today, week, month, all

  const [stats, setStats] = useState({
    grossSales: 0,
    costOfSales: 0,
    grossProfit: 0,
    expenses: 0,
    netProfit: 0,
    totalDiscount: 0,
    purchases: 0
  })

  const [topProducts, setTopProducts] = useState([])
  const [expenseBreakdown, setExpenseBreakdown] = useState([])
  const [salesTrend, setSalesTrend] = useState([])
  const [categoryData, setCategoryData] = useState([])

  useEffect(() => {
    if (user?.shop_id) fetchReportData()
  }, [range, user?.shop_id])

  const fetchReportData = async () => {
    setLoading(true)
    setFromCache(null)

    let startDate = new Date()
    startDate.setHours(0, 0, 0, 0)

    if (range === 'week') startDate.setDate(startDate.getDate() - 7)
    else if (range === 'month') startDate.setDate(1) // First of current month
    else if (range === 'year') startDate = new Date(new Date().getFullYear(), 0, 1) // First of current year
    else if (range === 'all') startDate = new Date(2000, 0, 1)

    const startISO = startDate.toISOString()

    try {
      if (!navigator.onLine) throw new Error('Offline')

      // Parallel fetching
      const fetchPromise = Promise.all([
        fetchAllRows(() => supabase.from('sales').select('*').eq('shop_id', user.shop_id).eq('sale_type', 'sale').gte('created_at', startISO)),
        fetchAllRows(() => supabase.from('sale_items').select('*, sales!inner(created_at, sale_type, shop_id)').eq('sales.shop_id', user.shop_id).eq('sales.sale_type', 'sale').gte('sales.created_at', startISO)),
        supabase.from('expenses').select('*').eq('shop_id', user.shop_id).gte('created_at', startISO),
        supabase.from('purchases').select('*').eq('shop_id', user.shop_id).gte('created_at', startISO)
      ])

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
      const [salesRes, itemsRes, expensesRes, purchasesRes] = await Promise.race([fetchPromise, timeoutPromise])

      const sales = salesRes.data || []
      const items = itemsRes.data || []
      const expenses = expensesRes.data || []
      const purchases = purchasesRes.data || []

      // Cache for offline use
      if (salesRes.data) await db.sales.bulkPut(JSON.parse(JSON.stringify(salesRes.data)))
      if (itemsRes.data) await db.sale_items.bulkPut(JSON.parse(JSON.stringify(itemsRes.data)))
      if (expensesRes.data) await db.expenses.bulkPut(JSON.parse(JSON.stringify(expensesRes.data)))
      if (purchasesRes.data) await db.purchases.bulkPut(JSON.parse(JSON.stringify(purchasesRes.data)))

      // Calculations
      const grossSales = sales.reduce((sum, s) => sum + Number(s.total_amount), 0)
      const totalDiscount = sales.reduce((sum, s) => sum + Number(s.discount || 0), 0)

      // Net Sales (sales after individual items, but here total_amount usually includes items - discounts)
      // Actually in our POS, total_amount is sum(item_totals) and then we subtract a global discount.
      const netSalesValue = grossSales - totalDiscount

      const costOfSales = items.reduce((sum, i) => {
        const qty = Number(i.quantity) - Number(i.returned_qty || 0)
        return sum + (Number(i.cost_price || 0) * qty)
      }, 0)

      const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0)
      const totalPurchases = purchases.reduce((sum, p) => sum + Number(p.total_amount), 0)

      const grossProfit = netSalesValue - costOfSales
      const netProfit = grossProfit - totalExpenses

      setTierSplit(computeTierSplit(sales, items))
      setStats({
        grossSales,
        costOfSales,
        grossProfit,
        expenses: totalExpenses,
        netProfit,
        totalDiscount,
        purchases: totalPurchases
      })

      // Top Products
      const prodMap = {}
      items.forEach(i => {
        const qty = Number(i.quantity) - Number(i.returned_qty || 0)
        if (qty <= 0) return
        if (!prodMap[i.product_name]) prodMap[i.product_name] = { name: i.product_name, qty: 0, revenue: 0 }
        prodMap[i.product_name].qty += qty
        prodMap[i.product_name].revenue += (qty * Number(i.unit_price))
      })
      const sortedProds = Object.values(prodMap).sort((a, b) => b.revenue - a.revenue).slice(0, 5)
      setTopProducts(sortedProds)

      // Expense Breakdown
      const expMap = {}
      expenses.forEach(e => {
        if (!expMap[e.category]) expMap[e.category] = 0
        expMap[e.category] += Number(e.amount)
      })
      setExpenseBreakdown(Object.entries(expMap).map(([cat, val]) => ({ cat, val })).sort((a, b) => b.val - a.val))

      // Sales Trend (Line Chart)
      const trendMap = {}
      sales.forEach(s => {
        const date = new Date(s.created_at).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })
        trendMap[date] = (trendMap[date] || 0) + Number(s.total_amount)
      })
      setSalesTrend(Object.entries(trendMap).map(([date, amount]) => ({ date, amount })))

      // Category Distribution (Pie Chart)
      const catMap = {}
      items.forEach(i => {
        const catName = i.products?.categories?.name || 'Uncategorized'
        const profit = (Number(i.unit_price) - Number(i.cost_price || 0)) * (Number(i.quantity) - Number(i.returned_qty || 0))
        catMap[catName] = (catMap[catName] || 0) + profit
      })
      setCategoryData(Object.entries(catMap).map(([name, value]) => ({ name, value })).filter(c => c.value > 0))
    } catch (e) {
      console.log('Reports: Offline mode, calculating from local DB...')
      setFromCache(!navigator.onLine ? 'offline' : (e?.message === 'Timeout' ? 'timeout' : 'error'))
      try {
        const sid = String(user.shop_id)
        const [lSales, lItems, lExpenses, lPurchases, lProducts, lCats] = await Promise.all([
          db.sales.toArray(),
          db.sale_items.toArray(),
          db.expenses.toArray(),
          db.purchases.toArray(),
          db.products.toArray(),
          db.categories.toArray()
        ])

        const sales = lSales.filter(x => String(x.shop_id) === sid && x.sale_type === 'sale' && new Date(x.created_at) >= startDate)
        const saleIds = new Set(sales.map(s => s.id))
        const items = lItems.filter(i => saleIds.has(i.sale_id))
        const expenses = lExpenses.filter(x => String(x.shop_id) === sid && new Date(x.created_at) >= startDate)
        const purchases = lPurchases.filter(x => String(x.shop_id) === sid && new Date(x.created_at) >= startDate)

        // Totals
        const grossSales = sales.reduce((sum, s) => sum + Number(s.total_amount), 0)
        const totalDiscount = sales.reduce((sum, s) => sum + Number(s.discount || 0), 0)
        const netSalesValue = grossSales - totalDiscount
        const costOfSales = items.reduce((sum, i) => sum + (Number(i.cost_price || 0) * (Number(i.quantity) - Number(i.returned_qty || 0))), 0)
        const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0)
        const totalPurchases = purchases.reduce((sum, p) => sum + Number(p.total_amount), 0)

        setTierSplit(computeTierSplit(sales, items))
        setStats({
          grossSales, costOfSales, grossProfit: netSalesValue - costOfSales,
          expenses: totalExpenses, netProfit: (netSalesValue - costOfSales) - totalExpenses,
          totalDiscount, purchases: totalPurchases
        })

        // Top Products
        const prodMap = {}
        items.forEach(i => {
          const qty = Number(i.quantity) - Number(i.returned_qty || 0)
          if (qty <= 0) return
          if (!prodMap[i.product_name]) prodMap[i.product_name] = { name: i.product_name, qty: 0, revenue: 0 }
          prodMap[i.product_name].qty += qty
          prodMap[i.product_name].revenue += (qty * Number(i.unit_price))
        })
        setTopProducts(Object.values(prodMap).sort((a, b) => b.revenue - a.revenue).slice(0, 5))

        // Expenses
        const expMap = {}
        expenses.forEach(e => {
          if (!expMap[e.category]) expMap[e.category] = 0
          expMap[e.category] += Number(e.amount)
        })
        setExpenseBreakdown(Object.entries(expMap).map(([cat, val]) => ({ cat, val })).sort((a, b) => b.val - a.val))

        // Category Pie
        const catMap = {}
        items.forEach(i => {
          const prod = lProducts.find(p => p.id === i.product_id)
          const cat = lCats.find(c => c.id === prod?.category_id)
          const catName = cat?.name || 'Uncategorized'
          const profit = (Number(i.unit_price) - Number(i.cost_price || 0)) * (Number(i.quantity) - Number(i.returned_qty || 0))
          catMap[catName] = (catMap[catName] || 0) + profit
        })
        setCategoryData(Object.entries(catMap).map(([name, value]) => ({ name, value })).filter(c => c.value > 0))

        // Trend
        const trendMap = {}
        sales.forEach(s => {
          const date = new Date(s.created_at).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })
          trendMap[date] = (trendMap[date] || 0) + Number(s.total_amount)
        })
        setSalesTrend(Object.entries(trendMap).map(([date, amount]) => ({ date, amount })))

      } catch (err) {
        console.error('Final Reports Fallback Error:', err)
      } finally {
        setLoading(false)
      }
    } finally {
      setLoading(false)
    }
  }

  const handlePrintSummary = () => {
    const branding = getShopBranding(user?.shop_id)
    const header = brandedA4Header(branding, 'Business Performance Report', `Period: ${range.toUpperCase()}`)
    printHTML(`
      <html><head><title>Business Report - ${range.toUpperCase()}</title>
      <style>
        @page{size:A4 portrait;margin:12mm}
        *{box-sizing:border-box;print-color-adjust:exact;-webkit-print-color-adjust:exact}
        body { font-family: 'Segoe UI', sans-serif; padding: 0; line-height: 1.6; }
        .stat-grid { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
        .stat-item { border: 1px solid #ddd; padding: 12px; border-radius: 8px; flex: 1; min-width: 45%; }
        .stat-label { color: #666; font-size: 11px; font-weight: bold; text-transform: uppercase; }
        .stat-value { font-size: 18px; font-weight: bold; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border-bottom: 1px solid #eee; padding: 10px; text-align: left; }
        th { color: #666; font-size: 12px; }
        .total-box { background: #f9f9f9; padding: 16px; border-radius: 8px; margin-top: 20px; border: 1px solid #eee; }
        .total-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
        .final-profit { border-top: 2px solid #333; padding-top: 10px; margin-top: 10px; font-size: 20px; font-weight: bold; display: flex; justify-content: space-between; }
      </style></head><body>
      ${header}

      <div class="stat-grid">
        <div class="stat-item">
          <div class="stat-label">Gross Sales</div>
          <div class="stat-value">Rs. ${stats.grossSales.toLocaleString()}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Total Discounts</div>
          <div class="stat-value">Rs. ${stats.totalDiscount.toLocaleString()}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Cost of Goods Sold</div>
          <div class="stat-value">Rs. ${stats.costOfSales.toLocaleString()}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Operating Expenses</div>
          <div class="stat-value">Rs. ${stats.expenses.toLocaleString()}</div>
        </div>
      </div>

      <div class="total-box">
        <div class="total-row"><span>Gross Profit</span><span>Rs. ${stats.grossProfit.toLocaleString()}</span></div>
        <div class="total-row"><span>Purchases (Stock In)</span><span>Rs. ${stats.purchases.toLocaleString()}</span></div>
        <div class="final-profit"><span>Net Business Profit:</span><span>Rs. ${stats.netProfit.toLocaleString()}</span></div>
      </div>

      <h2>Top Products</h2>
      <table>
        <thead><tr><th>Product Name</th><th>Qty</th><th>Revenue</th></tr></thead>
        <tbody>
          ${topProducts.map(p => `<tr><td>${p.name}</td><td>${p.qty}</td><td>Rs. ${p.revenue.toLocaleString()}</td></tr>`).join('')}
        </tbody>
      </table>
      </body></html>
    `)
  }

  if (!hasFeature('reports')) return <UpgradeWall feature="reports" />

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-fg">📊 Business Analytics</h1>
          <p className="text-fg-muted text-sm">Profit, Loss and Sales performance</p>
        </div>
        <div className="flex bg-surface rounded-xl shadow-sm border p-1">
          {['today', 'week', 'month', 'year', 'all'].map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-4 py-1.5 rounded-lg text-sm font-bold transition ${range === r ? 'bg-primary text-white shadow' : 'text-fg-muted hover:bg-surface-2'}`}
            >
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
        <button
          onClick={handlePrintSummary}
          className="ml-4 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-xl transition font-bold text-sm shadow-sm flex items-center gap-2"
        >
          🖨️ Print Summary
        </button>
      </div>

      {loading ? (
        <div className="py-20 text-center text-fg-subtle animate-pulse text-lg">Calculating statistics...</div>
      ) : (
        <>
          {fromCache && (
            <div role="status" className="rounded-xl border border-warning-edge bg-warning-soft px-4 py-3 text-sm text-warning-strong flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span>
                ⚠️ Showing figures saved on this device — {fromCache === 'offline' ? 'you are offline' : fromCache === 'timeout' ? 'the server took too long to answer' : 'the server could not be reached'}.
                Numbers may be incomplete.
              </span>
              <button type="button" onClick={fetchReportData} className="shrink-0 rounded-lg bg-warning px-3 py-1.5 font-bold text-white hover:bg-warning-hover">Try again</button>
            </div>
          )}

          {/* Main Stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard title="Gross Sales" value={stats.grossSales} sub={`Disc: Rs. ${stats.totalDiscount}`} color="blue" />
            <StatCard title="Cost of Goods" value={stats.costOfSales} sub="Purchase value of sold items" color="orange" />
            <StatCard title="Gross Profit" value={stats.grossProfit} sub="Sales - Cost of Goods" color="emerald" />
            <StatCard title="Net Profit" value={stats.netProfit} sub="Gross Profit - Expenses" color="indigo" highlight />
          </div>

          {/* Retail vs Wholesale split */}
          {wholesaleEnabled && tierSplit && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[['retail', 'Retail', 'border-primary-line bg-primary-soft/50 text-primary-strong'], ['wholesale', 'Wholesale', 'border-wholesale-line bg-wholesale-soft/60 text-wholesale-strong']].map(([key, label, cls]) => {
                const t = tierSplit[key]
                const margin = t.sales > 0 ? (t.profit / t.sales) * 100 : 0
                return (
                  <div key={key} className={`rounded-2xl border p-4 ${cls}`}>
                    <p className="text-xs font-black uppercase tracking-wider">{label} Sales · {t.count} bill(s)</p>
                    <p className="mt-1 text-2xl font-black text-fg">Rs. {Math.round(t.sales).toLocaleString()}</p>
                    <p className="mt-0.5 text-sm font-semibold">
                      Gross profit Rs. {Math.round(t.profit).toLocaleString()} · {margin.toFixed(1)}% margin
                    </p>
                  </div>
                )
              })}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Sales Trend Chart */}
            <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle p-6">
              <h3 className="font-bold text-fg mb-6 flex items-center gap-2">
                <span className="w-2 h-6 bg-primary rounded-full"></span>
                Sales Trend
              </h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={salesTrend}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                    <Tooltip
                      contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
                      itemStyle={{ color: '#2563eb', fontWeight: 'bold' }}
                    />
                    <Line type="monotone" dataKey="amount" stroke="#2563eb" strokeWidth={3} dot={{ r: 4, fill: '#2563eb', strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Category Pie Chart */}
            <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle p-6">
              <h3 className="font-bold text-fg mb-6 flex items-center gap-2">
                <span className="w-2 h-6 bg-info rounded-full"></span>
                Profit by Category
              </h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={categoryData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {categoryData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981'][index % 5]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Net Breakdown */}
            <div className="lg:col-span-2 bg-surface rounded-2xl shadow-sm border border-line-subtle p-6">
              <h3 className="font-bold text-fg mb-6 flex items-center gap-2">
                <span className="w-2 h-6 bg-primary rounded-full"></span>
                Detailed Summary
              </h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center pb-2 border-b border-dashed">
                  <span className="text-fg-3">Total Sales (Inc. Discount)</span>
                  <span className="font-bold">Rs. {stats.grossSales.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b border-dashed">
                  <span className="text-fg-3">Total Discounts Given</span>
                  <span className="font-bold text-danger-fg">- Rs. {stats.totalDiscount.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b border-dashed">
                  <span className="text-fg-3 font-bold">Net Sales Value</span>
                  <span className="font-bold text-primary-fg">Rs. {(stats.grossSales - stats.totalDiscount).toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b border-dashed">
                  <span className="text-fg-3">Cost of Goods Sold (COGS)</span>
                  <span className="font-bold text-warning-fg">- Rs. {stats.costOfSales.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b border-dashed">
                  <span className="text-fg-3 font-bold text-lg">Gross Profit</span>
                  <span className="font-bold text-success-fg text-lg">Rs. {stats.grossProfit.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b border-dashed">
                  <span className="text-fg-3">Total Operating Expenses</span>
                  <span className="font-bold text-danger-fg">- Rs. {stats.expenses.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center pt-2">
                  <span className="text-xl font-black text-fg uppercase tracking-tight">Net Business Profit</span>
                  <span className={`text-2xl font-black ${stats.netProfit >= 0 ? 'text-primary-strong' : 'text-danger-strong'}`}>
                    Rs. {stats.netProfit.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            {/* Expenses Side */}
            <div className="space-y-6">
              <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle p-6">
                <h3 className="font-bold text-fg mb-4">Expense Breakdown</h3>
                <div className="space-y-3">
                  {expenseBreakdown.map(e => (
                    <div key={e.cat} className="flex flex-col gap-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-fg-3 font-medium">{e.cat}</span>
                        <span className="font-bold">Rs. {e.val.toLocaleString()}</span>
                      </div>
                      <div className="w-full h-1.5 bg-surface-3 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-danger"
                          style={{ width: `${(e.val / stats.expenses) * 100}%` }}
                        ></div>
                      </div>
                    </div>
                  ))}
                  {expenseBreakdown.length === 0 && <p className="text-center text-fg-subtle py-4 text-sm italic">No expenses in this period</p>}
                </div>
              </div>

              <div className="bg-primary rounded-2xl shadow-lg p-6 text-white">
                <h3 className="font-bold mb-1">New Purchases</h3>
                <p className="text-xs text-white/80 mb-4">Inventory added in this period</p>
                <p className="text-2xl font-black">Rs. {stats.purchases.toLocaleString()}</p>
              </div>
            </div>
          </div>

          {/* Top Products */}
          <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle p-6">
            <h3 className="font-bold text-fg mb-6">Top Selling Products (by Revenue)</h3>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs text-fg-subtle uppercase tracking-widest border-b">
                    <th className="pb-3">Product Name</th>
                    <th className="pb-3 text-center">Qty Sold</th>
                    <th className="pb-3 text-right">Revenue</th>
                    <th className="pb-3 text-right">Weightage</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {topProducts.map(p => (
                    <tr key={p.name} className="hover:bg-surface-2 group transition">
                      <td className="py-4 font-bold text-fg-2">{p.name}</td>
                      <td className="py-4 text-center font-medium text-fg-muted">{p.qty}</td>
                      <td className="py-4 text-right font-black text-fg">Rs. {p.revenue.toLocaleString()}</td>
                      <td className="py-4 text-right">
                        <span className="px-2 py-1 bg-primary-soft text-primary-fg text-[10px] font-bold rounded">
                          {((p.revenue / (stats.grossSales || 1)) * 100).toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                  {topProducts.length === 0 && <tr><td colSpan="4" className="py-10 text-center text-fg-subtle italic">No sales recorded</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ title, value, sub, color, highlight }) {
  const colors = {
    blue: 'border-primary-muted text-primary-fg',
    orange: 'border-warning-muted text-warning-fg',
    emerald: 'border-success-muted text-success-fg',
    indigo: 'border-primary-muted text-primary-strong bg-primary-soft'
  }

  return (
    <div className={`bg-surface p-5 rounded-2xl shadow-sm border ${colors[color] || 'border-line-subtle'} ${highlight ? 'ring-2 ring-primary ring-offset-2' : ''}`}>
      <p className="text-xs font-bold uppercase tracking-wider text-fg-subtle mb-1">{title}</p>
      <p className="text-2xl font-black">Rs. {value.toLocaleString()}</p>
      <p className="text-[10px] text-fg-subtle mt-1 font-medium">{sub}</p>
    </div>
  )
}

export default Reports
