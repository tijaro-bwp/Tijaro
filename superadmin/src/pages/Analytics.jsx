import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabaseAdmin } from '../services/supabase'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, AreaChart, Area } from 'recharts'
import { TrendingUp, Users, Activity, AlertTriangle, Filter, Download, Calendar, ArrowUpRight, ArrowDownRight, Layers } from 'lucide-react'

export default function Analytics() {
    const navigate = useNavigate()
    const [loading, setLoading] = useState(true)
    const [growthData, setGrowthData] = useState([])
    const [topShops, setTopShops] = useState([])
    const [inactiveShops, setInactiveShops] = useState([])
    const [stats, setStats] = useState({ totalGMV: 0, avgOrderValue: 0, growthRate: 0 })
    const [error, setError] = useState(null)
    const [analyticsTab, setAnalyticsTab] = useState('retail')
    const [saasStats, setSaasStats] = useState({
        mrr: 0,
        arr: 0,
        arpu: 0,
        churnRate: 0,
        ltv: 0,
        totalCash: 0,
        activeShops: 0,
        suspendedShops: 0
    })
    const [saasTierData, setSaasTierData] = useState([])
    const [saasCashTrend, setSaasCashTrend] = useState([])
    const [saasSignupsTrend, setSaasSignupsTrend] = useState([])

    useEffect(() => {
        fetchAnalytics()
    }, [])

    const fetchAnalytics = async () => {
        setLoading(true)
        try {
            const [growthRes, topsRes, inactiveRes, shopsRes, paymentsRes] = await Promise.all([
                supabaseAdmin.rpc('get_global_growth_stats'),
                supabaseAdmin.rpc('get_top_performing_shops'),
                supabaseAdmin.rpc('get_inactive_shops'),
                supabaseAdmin.from('shops').select('id, name, created_at, subscription_plan, subscription_fee, status, plan_id, subscription_plans(name)'),
                supabaseAdmin.from('shop_payments').select('id, amount, payment_date, payment_type')
            ])

            if (growthRes.error) throw growthRes.error
            if (topsRes.error) throw topsRes.error
            if (inactiveRes.error) throw inactiveRes.error
            if (shopsRes.error) throw shopsRes.error
            if (paymentsRes.error) throw paymentsRes.error

            const rawGrowth = growthRes.data || []
            const formattedGrowth = rawGrowth.map(d => ({
                name: new Date(d.month).toLocaleDateString('en-US', { month: 'short' }),
                gmv: Number(d.gmv),
                orders: d.orders_count
            }))

            setGrowthData(formattedGrowth)
            setTopShops(topsRes.data || [])
            setInactiveShops(inactiveRes.data || [])

            // Calculate basic stats
            const totalGMV = rawGrowth.reduce((sum, d) => sum + Number(d.gmv), 0)
            const totalOrders = rawGrowth.reduce((sum, d) => sum + Number(d.orders_count), 0)

            let growthRate = 0
            if (rawGrowth.length >= 2) {
                const lastMonth = Number(rawGrowth[rawGrowth.length - 1].gmv)
                const prevMonth = Number(rawGrowth[rawGrowth.length - 2].gmv)
                if (prevMonth > 0) {
                    growthRate = ((lastMonth - prevMonth) / prevMonth) * 100
                }
            }

            setStats({
                totalGMV,
                avgOrderValue: totalOrders > 0 ? totalGMV / totalOrders : 0,
                growthRate
            })

            // Calculate SaaS stats
            const rawShops = shopsRes.data || []
            const rawPayments = paymentsRes.data || []

            const activeShopsList = rawShops.filter(s => s.status === 'active' || !s.status)
            const suspendedShopsList = rawShops.filter(s => s.status === 'suspended')
            const activeShopsCount = activeShopsList.length
            const suspendedShopsCount = suspendedShopsList.length
            const totalShopsCount = rawShops.length

            const mrr = activeShopsList.reduce((sum, s) => sum + Number(s.subscription_fee || 0), 0)
            const arr = mrr * 12
            const arpu = activeShopsCount > 0 ? mrr / activeShopsCount : 0
            const churnRate = totalShopsCount > 0 ? (suspendedShopsCount / totalShopsCount) * 100 : 0
            const ltv = churnRate > 0 ? arpu / (churnRate / 100) : 0
            const totalCash = rawPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0)

            setSaasStats({
                mrr,
                arr,
                arpu,
                churnRate,
                ltv,
                totalCash,
                activeShops: activeShopsCount,
                suspendedShops: suspendedShopsCount
            })

            // SaaS Tier Distribution
            const plansMap = {}
            rawShops.forEach(s => {
                const planName = s.subscription_plans?.name || s.subscription_plan || 'Trial'
                plansMap[planName] = (plansMap[planName] || 0) + 1
            })
            setSaasTierData(Object.entries(plansMap).map(([name, count]) => ({ name, count })))

            // SaaS Collections Trend
            const collectionsMap = {}
            rawPayments.forEach(p => {
                if (!p.payment_date) return
                const date = new Date(p.payment_date)
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
                collectionsMap[monthKey] = (collectionsMap[monthKey] || 0) + Number(p.amount || 0)
            })
            setSaasCashTrend(Object.entries(collectionsMap)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([month, amount]) => ({
                    name: new Date(month + '-02').toLocaleDateString('en-US', { month: 'short' }),
                    amount
                }))
            )

            // SaaS Shop Signups Trend
            const signupsMap = {}
            rawShops.forEach(s => {
                if (!s.created_at) return
                const date = new Date(s.created_at)
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
                signupsMap[monthKey] = (signupsMap[monthKey] || 0) + 1
            })
            setSaasSignupsTrend(Object.entries(signupsMap)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([month, count]) => ({
                    name: new Date(month + '-02').toLocaleDateString('en-US', { month: 'short' }),
                    signups: count
                }))
            )

        } catch (err) {
            console.error('Analytics Fetch Error:', err)
            setError('Analytics failed to load. Please ensure you have run analytics_rpc.sql in Supabase. Error: ' + err.message)
        } finally {
            setLoading(false)
        }
    }

    if (loading) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
    )

    return (
        <div className="space-y-6 pb-12">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight">Analytics & Growth</h1>
                    <p className="text-slate-500 font-medium mt-1">Deep dive into platform performance and shop trends.</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex bg-slate-100 p-1 rounded-xl gap-1 shadow-inner">
                        <button
                            type="button"
                            onClick={() => setAnalyticsTab('retail')}
                            className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition ${
                                analyticsTab === 'retail'
                                    ? 'bg-white text-blue-600 shadow-sm border border-slate-200/50'
                                    : 'text-slate-500 hover:text-slate-800'
                            }`}
                        >
                            Shop GMV
                        </button>
                        <button
                            type="button"
                            onClick={() => setAnalyticsTab('saas')}
                            className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition ${
                                analyticsTab === 'saas'
                                    ? 'bg-white text-blue-600 shadow-sm border border-slate-200/50'
                                    : 'text-slate-500 hover:text-slate-800'
                            }`}
                        >
                            SaaS Platform
                        </button>
                    </div>
                    <button
                        onClick={fetchAnalytics}
                        className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-50 shadow-sm transition"
                    >
                        <Activity size={16} /> Refresh Data
                    </button>
                </div>
            </div>

            {error && (
                <div className="p-4 bg-red-50 border border-red-200 text-red-600 rounded-xl flex items-center gap-2 font-bold mb-6">
                    <AlertTriangle size={20} /> {error}
                </div>
            )}

            {/* Quick Stats Grid - Retail */}
            {analyticsTab === 'retail' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm overflow-hidden relative group">
                        <div className="absolute -right-4 -bottom-4 bg-emerald-50 w-24 h-24 rounded-full opacity-50 group-hover:scale-110 transition-transform"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Lifetime GMV</p>
                        <h3 className="text-2xl font-black text-slate-800">Rs. {stats.totalGMV.toLocaleString()}</h3>
                        <div className={`mt-2 flex items-center gap-1 text-[10px] font-bold ${stats.growthRate >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            {stats.growthRate >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                            {Math.abs(stats.growthRate).toFixed(1)}% vs Prev Month
                        </div>
                    </div>

                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm overflow-hidden relative group">
                        <div className="absolute -right-4 -bottom-4 bg-blue-50 w-24 h-24 rounded-full opacity-50 group-hover:scale-110 transition-transform"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Avg. Order Value</p>
                        <h3 className="text-2xl font-black text-slate-800">Rs. {Math.round(stats.avgOrderValue).toLocaleString()}</h3>
                    </div>

                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm overflow-hidden relative group">
                        <div className="absolute -right-4 -bottom-4 bg-orange-50 w-24 h-24 rounded-full opacity-50 group-hover:scale-110 transition-transform"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Struggling Shops</p>
                        <h3 className="text-2xl font-black text-slate-800">{inactiveShops.length}</h3>
                        <p className="text-[10px] text-slate-400 font-bold mt-2 italic">Inactive {'>'} 14 Days</p>
                    </div>
                </div>
            )}

            {/* Quick Stats Grid - SaaS */}
            {analyticsTab === 'saas' && (
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
                    <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative group overflow-hidden">
                        <div className="absolute -right-4 -bottom-4 bg-blue-50 w-16 h-16 rounded-full opacity-50"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Current MRR</p>
                        <h3 className="text-lg font-black text-slate-800">Rs. {saasStats.mrr.toLocaleString()}</h3>
                        <p className="text-[9px] text-slate-400 font-bold mt-1">Monthly Recurring</p>
                    </div>

                    <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative group overflow-hidden">
                        <div className="absolute -right-4 -bottom-4 bg-indigo-50 w-16 h-16 rounded-full opacity-50"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Current ARR</p>
                        <h3 className="text-lg font-black text-slate-800">Rs. {saasStats.arr.toLocaleString()}</h3>
                        <p className="text-[9px] text-slate-400 font-bold mt-1">ARR (MRR * 12)</p>
                    </div>

                    <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative group overflow-hidden">
                        <div className="absolute -right-4 -bottom-4 bg-emerald-50 w-16 h-16 rounded-full opacity-50"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Avg ARPU</p>
                        <h3 className="text-lg font-black text-slate-800">Rs. {Math.round(saasStats.arpu).toLocaleString()}</h3>
                        <p className="text-[9px] text-slate-400 font-bold mt-1">Per Active Shop</p>
                    </div>

                    <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative group overflow-hidden">
                        <div className="absolute -right-4 -bottom-4 bg-red-50 w-16 h-16 rounded-full opacity-50"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Account Churn</p>
                        <h3 className="text-lg font-black text-slate-800">{saasStats.churnRate.toFixed(1)}%</h3>
                        <p className="text-[9px] text-slate-400 font-bold mt-1">{saasStats.suspendedShops} Suspended</p>
                    </div>

                    <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative group overflow-hidden">
                        <div className="absolute -right-4 -bottom-4 bg-amber-50 w-16 h-16 rounded-full opacity-50"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Customer LTV</p>
                        <h3 className="text-lg font-black text-slate-800">
                            {saasStats.churnRate > 0 ? `Rs. ${Math.round(saasStats.ltv).toLocaleString()}` : 'N/A (0% Churn)'}
                        </h3>
                        <p className="text-[9px] text-slate-400 font-bold mt-1">Projected Lifetime</p>
                    </div>

                    <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative group overflow-hidden">
                        <div className="absolute -right-4 -bottom-4 bg-teal-50 w-16 h-16 rounded-full opacity-50"></div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Total Cash</p>
                        <h3 className="text-lg font-black text-slate-800">Rs. {saasStats.totalCash.toLocaleString()}</h3>
                        <p className="text-[9px] text-slate-400 font-bold mt-1">Lifetime Revenue</p>
                    </div>
                </div>
            )}

            {/* Charts Section - Retail */}
            {analyticsTab === 'retail' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Growth Chart */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm">
                        <h3 className="font-black text-slate-800 mb-6 flex items-center gap-2">
                            <TrendingUp size={20} className="text-blue-600" /> Platform GMV Trend
                        </h3>
                        <div className="h-72 w-full mt-4">
                            <ResponsiveContainer width="100%" height="100%" minHeight={300}>
                                <AreaChart data={growthData}>
                                    <defs>
                                        <linearGradient id="colorGmv" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1} />
                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold', fill: '#94a3b8' }} />
                                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold', fill: '#94a3b8' }} />
                                    <Tooltip
                                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)', fontSize: '12px', fontWeight: 'bold' }}
                                    />
                                    <Area type="monotone" dataKey="gmv" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorGmv)" />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Top Shops Leaderboard */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm">
                        <h3 className="font-black text-slate-800 mb-6 flex items-center gap-2">
                            <ArrowUpRight size={20} className="text-emerald-500" /> Top Performing Shops (Last 30 Days)
                        </h3>
                        <div className="space-y-4">
                            {topShops.length === 0 ? (
                                <p className="text-center text-slate-400 py-12 text-sm italic">No data yet</p>
                            ) : (
                                topShops.map((shop, i) => (
                                    <div key={shop.shop_id} className="flex items-center justify-between p-3 rounded-xl border border-slate-100 bg-slate-50/50 hover:bg-white hover:border-blue-200 transition group">
                                        <div className="flex items-center gap-4">
                                            <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center font-black text-slate-400 text-xs shadow-sm">
                                                {i + 1}
                                            </div>
                                            <div>
                                                <p className="font-black text-slate-700 text-sm truncate max-w-[150px]">{shop.shop_name}</p>
                                                <p className="text-[10px] text-slate-400 font-bold uppercase">{shop.order_count} Orders</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-black text-blue-600">Rs. {Math.round(shop.gmv).toLocaleString()}</p>
                                            <div className="w-24 h-1 bg-slate-100 rounded-full mt-1 overflow-hidden">
                                                <div
                                                    className="h-full bg-blue-500 rounded-full transition-all duration-1000"
                                                    style={{ width: `${(shop.gmv / topShops[0].gmv) * 100}%` }}
                                                ></div>
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Charts Section - SaaS */}
            {analyticsTab === 'saas' && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Collections Trend */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm lg:col-span-2">
                        <h3 className="font-black text-slate-800 mb-6 flex items-center gap-2">
                            <TrendingUp size={20} className="text-emerald-500" /> Monthly Subscription Income (Cash Collected)
                        </h3>
                        <div className="h-72 w-full mt-4">
                            <ResponsiveContainer width="100%" height="100%" minHeight={300}>
                                <BarChart data={saasCashTrend}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold', fill: '#94a3b8' }} />
                                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold', fill: '#94a3b8' }} />
                                    <Tooltip
                                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)', fontSize: '12px', fontWeight: 'bold' }}
                                        formatter={(val) => [`Rs. ${Number(val).toLocaleString()}`, 'Collections']}
                                    />
                                    <Bar dataKey="amount" fill="#10b981" radius={[8, 8, 0, 0]} maxBarSize={45} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Tier Distribution */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm">
                        <h3 className="font-black text-slate-800 mb-6 flex items-center gap-2">
                            <Layers size={20} className="text-blue-500" /> Plan Distribution
                        </h3>
                        <div className="h-72 w-full mt-4">
                            <ResponsiveContainer width="100%" height="100%" minHeight={300}>
                                <BarChart data={saasTierData} layout="vertical">
                                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold', fill: '#94a3b8' }} />
                                    <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold', fill: '#475569' }} width={80} />
                                    <Tooltip
                                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)', fontSize: '12px', fontWeight: 'bold' }}
                                    />
                                    <Bar dataKey="count" fill="#3b82f6" radius={[0, 8, 8, 0]} maxBarSize={30} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Signups Growth */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm lg:col-span-3">
                        <h3 className="font-black text-slate-800 mb-6 flex items-center gap-2">
                            <Users size={20} className="text-indigo-500" /> New Shop Signups Growth Trend
                        </h3>
                        <div className="h-72 w-full mt-4">
                            <ResponsiveContainer width="100%" height="100%" minHeight={300}>
                                <LineChart data={saasSignupsTrend}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold', fill: '#94a3b8' }} />
                                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold', fill: '#94a3b8' }} />
                                    <Tooltip
                                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)', fontSize: '12px', fontWeight: 'bold' }}
                                    />
                                    <Line type="monotone" dataKey="signups" stroke="#6366f1" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
            )}

            {/* Inactive Shops Section - Retail Only */}
            {analyticsTab === 'retail' && (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                    <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                        <h3 className="font-black text-slate-800 flex items-center gap-2">
                            <AlertTriangle size={20} className="text-orange-500" /> At Risk: Inactive Shops (14+ Days)
                        </h3>
                        <span className="bg-orange-100 text-orange-700 text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-wider">
                            Needs Attention
                        </span>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead className="bg-slate-50">
                                <tr>
                                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Shop Name</th>
                                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Last Activity</th>
                                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Days Since Sale</th>
                                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Owner Contact</th>
                                    <th className="px-6 py-4"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {inactiveShops.length === 0 ? (
                                    <tr>
                                        <td colSpan="5" className="px-6 py-12 text-center text-slate-400 text-sm font-medium">All active shops are actively transacting. Great job!</td>
                                    </tr>
                                ) : (
                                    inactiveShops.map(shop => {
                                        const lastSale = shop.last_sale ? new Date(shop.last_sale) : null
                                        const daysAgo = lastSale ? Math.floor((new Date() - lastSale) / (1000 * 60 * 60 * 24)) : 'N/A'

                                        return (
                                            <tr key={shop.shop_id} className="hover:bg-slate-50/50 transition">
                                                <td className="px-6 py-4 font-black text-slate-700 text-sm">{shop.shop_name}</td>
                                                <td className="px-6 py-4 text-xs font-bold text-slate-500">
                                                    {lastSale ? lastSale.toLocaleDateString() : 'Never'}
                                                </td>
                                                <td className="px-6 py-4 italic">
                                                    <span className={`px-2 py-1 rounded-lg text-[10px] font-black ${daysAgo > 30 ? 'bg-red-50 text-red-600' : 'bg-orange-50 text-orange-600'}`}>
                                                        {daysAgo} Days Inactive
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-blue-600 font-bold text-sm tracking-tight">{shop.owner_phone || 'N/A'}</td>
                                                <td className="px-6 py-4 text-right">
                                                    <button
                                                        onClick={() => navigate(`/broadcast?shopId=${shop.shop_id}`)}
                                                        className="px-4 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-[10px] font-black uppercase hover:bg-blue-600 hover:text-white transition"
                                                    >
                                                        Reach Out
                                                    </button>
                                                </td>
                                            </tr>
                                        )
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    )
}
