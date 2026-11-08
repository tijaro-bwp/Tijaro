import { useState, useEffect } from 'react'
import { supabaseAdmin } from '../services/supabase'
import { Search, CreditCard, Clock, CheckCircle2, AlertTriangle, FileText, User, MessageSquare } from 'lucide-react'
import { logAction } from '../services/auditService'
import { useAuth } from '../context/AuthContext'
import { buildWhatsAppUrl, formatRenewalMessage } from '../utils/whatsappTemplates'
import * as XLSX from 'xlsx'

export default function Subscriptions() {
    const { user } = useAuth()
    const [shops, setShops] = useState([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [errorMsg, setErrorMsg] = useState('')

    // Modals state
    const [paymentModalOpen, setPaymentModalOpen] = useState(false)
    const [selectedShop, setSelectedShop] = useState(null)
    const [ledgerModalOpen, setLedgerModalOpen] = useState(false)
    const [ledgerData, setLedgerData] = useState([])
    const [ledgerLoading, setLedgerLoading] = useState(false)
    const [extendModalOpen, setExtendModalOpen] = useState(false)
    const [extendDays, setExtendDays] = useState('7')
    const [subFilter, setSubFilter] = useState('all')

    // WhatsApp Reminder Modal
    const [whatsAppModalOpen, setWhatsAppModalOpen] = useState(false)
    const [whatsAppShop, setWhatsAppShop] = useState(null)
    const [bankDetails, setBankDetails] = useState(() => localStorage.getItem('superadmin_bank_details') || 'Bank: Meezan Bank / HBL\nJazzCash / EasyPaisa: 0300-1234567\nAccount Title: EdgeX POS')

    // Payment Form State
    const [paymentAmount, setPaymentAmount] = useState('')
    const [paymentType, setPaymentType] = useState('bank_transfer')
    const [remarks, setRemarks] = useState('')
    const [processing, setProcessing] = useState(false)
    const [extensionPeriod, setExtensionPeriod] = useState('auto')
    const [customExtensionDays, setCustomExtensionDays] = useState('')

    // Plan Edit State
    const [editingPlanShopId, setEditingPlanShopId] = useState(null)
    const [planForm, setPlanForm] = useState({ planId: '', fee: 0 })
    const [allPlans, setAllPlans] = useState([])

    useEffect(() => {
        fetchSubscriptions()
        fetchAllPlans()
    }, [])

    const fetchAllPlans = async () => {
        try {
            const { data, error } = await supabaseAdmin.from('subscription_plans').select('*').order('price', { ascending: true })
            if (error) throw error
            setAllPlans(data || [])
        } catch (err) {
            console.error('Fetch all plans error:', err)
        }
    }

    const fetchSubscriptions = async () => {
        if (!supabaseAdmin) {
            setErrorMsg('Service Role Key required.')
            setLoading(false)
            return
        }

        setLoading(true)
        try {
            const { data, error } = await supabaseAdmin
                .from('shops')
                .select('id, name, phone, subscription_plan, subscription_fee, next_billing_date, status, plan_id, subscription_plans(name)')
                .order('name', { ascending: true })

            if (error) throw error
            setShops(data)
        } catch (error) {
            console.error('Fetch error:', error)
            setErrorMsg('Failed to load subscriptions: ' + error.message)
        } finally {
            setLoading(false)
        }
    }

    const handleRecordPayment = async (e) => {
        e.preventDefault()
        if (!supabaseAdmin || !selectedShop || !paymentAmount) return

        setProcessing(true)
        try {
            const isRefund = paymentType === 'refund'
            const finalAmount = isRefund ? -Math.abs(parseFloat(paymentAmount)) : parseFloat(paymentAmount)

            // 1. Insert Payment Record
            const { error: paymentError } = await supabaseAdmin.from('shop_payments').insert([{
                shop_id: selectedShop.id,
                amount: finalAmount,
                payment_type: paymentType,
                remarks: remarks
            }])

            if (paymentError) throw paymentError

            // 2. Extend Subscription Date & Update Status (only if not a refund)
            const shopUpdates = {}
            shopUpdates.status = 'active'
            shopUpdates.suspension_reason = null

            if (!isRefund && extensionPeriod !== 'none') {
                let nextDate = new Date(selectedShop.next_billing_date || new Date())
                const today = new Date()
                if (nextDate < today) {
                    nextDate = today
                }

                if (extensionPeriod === 'auto') {
                    if (selectedShop.subscription_plan === 'annually') {
                        nextDate.setFullYear(nextDate.getFullYear() + 1)
                    } else {
                        nextDate.setMonth(nextDate.getMonth() + 1)
                    }
                } else if (extensionPeriod === '1_month') {
                    nextDate.setDate(nextDate.getDate() + 30)
                } else if (extensionPeriod === '3_months') {
                    nextDate.setDate(nextDate.getDate() + 90)
                } else if (extensionPeriod === '6_months') {
                    nextDate.setDate(nextDate.getDate() + 180)
                } else if (extensionPeriod === '1_year') {
                    nextDate.setDate(nextDate.getDate() + 365)
                } else if (extensionPeriod === 'custom') {
                    const days = parseInt(customExtensionDays) || 0
                    nextDate.setDate(nextDate.getDate() + days)
                }

                shopUpdates.next_billing_date = nextDate.toISOString().split('T')[0]
            } else if (isRefund) {
                delete shopUpdates.status
                delete shopUpdates.suspension_reason
            }

            if (Object.keys(shopUpdates).length > 0) {
                const { error: updateError } = await supabaseAdmin
                    .from('shops')
                    .update(shopUpdates)
                    .eq('id', selectedShop.id)

                if (updateError) throw updateError
            }

            alert(isRefund ? 'Refund recorded successfully!' : 'Payment recorded successfully! Next billing date updated.')

            await logAction({
                actor_id: user?.id,
                actor_email: user?.email || user?.username,
                action_type: isRefund ? 'REFUND_PAYMENT' : 'RECORD_PAYMENT',
                target_type: 'SHOP',
                target_id: selectedShop.id,
                details: { amount: finalAmount, type: paymentType, remarks, extensionPeriod }
            })

            setPaymentModalOpen(false)
            fetchSubscriptions()
        } catch (err) {
            console.error(err)
            alert('Error recording payment: ' + err.message)
        } finally {
            setProcessing(false)
        }
    }

    const handleExtendBilling = async (e) => {
        e.preventDefault()
        if (!supabaseAdmin || !selectedShop || !extendDays) return

        setProcessing(true)
        try {
            let nextDate = new Date(selectedShop.next_billing_date || new Date())
            const today = new Date()
            if (nextDate < today) {
                nextDate = today
            }
            nextDate.setDate(nextDate.getDate() + parseInt(extendDays))

            const { error: updateError } = await supabaseAdmin
                .from('shops')
                .update({ 
                    next_billing_date: nextDate.toISOString().split('T')[0],
                    status: 'active',
                    suspension_reason: null
                })
                .eq('id', selectedShop.id)

            if (updateError) throw updateError

            alert(`Billing date extended by ${extendDays} days. Shop status updated to active.`)

            await logAction({
                actor_id: user?.id,
                actor_email: user?.email || user?.username,
                action_type: 'EXTEND_BILLING_CYCLE',
                target_type: 'SHOP',
                target_id: selectedShop.id,
                details: { extendDays, nextBillingDate: nextDate.toISOString().split('T')[0] }
            })

            setExtendModalOpen(false)
            fetchSubscriptions()
        } catch (err) {
            console.error(err)
            alert('Error extending billing: ' + err.message)
        } finally {
            setProcessing(false)
        }
    }

    const openExtendModal = (shop) => {
        setSelectedShop(shop)
        setExtendDays('7')
        setExtendModalOpen(true)
    }

    const openPaymentModal = (shop) => {
        setSelectedShop(shop)
        setPaymentAmount(shop.subscription_fee || '')
        setPaymentType('bank_transfer')
        setRemarks(`Subscription Payment for ${shop.subscription_plans?.name || shop.subscription_plan || 'TRIAL'} plan`)
        setExtensionPeriod('auto')
        setCustomExtensionDays('')
        setPaymentModalOpen(true)
    }

    const openLedgerModal = async (shop) => {
        setSelectedShop(shop)
        setLedgerModalOpen(true)
        setLedgerLoading(true)
        try {
            const { data, error } = await supabaseAdmin
                .from('shop_payments')
                .select('*')
                .eq('shop_id', shop.id)
                .order('payment_date', { ascending: false })

            if (error) throw error
            setLedgerData(data)
        } catch (err) {
            console.error(err)
            alert('Failed to load ledger: ' + err.message)
        } finally {
            setLedgerLoading(false)
        }
    }

    const handleSavePlan = async (shopId) => {
        try {
            let updates = {
                plan_id: planForm.planId || null,
                subscription_fee: parseFloat(planForm.fee)
            }

            const { error } = await supabaseAdmin
                .from('shops')
                .update(updates)
                .eq('id', shopId)

            if (error) throw error

            await logAction({
                actor_id: user?.id,
                actor_email: user?.email || user?.username,
                action_type: 'UPDATE_SUBSCRIPTION_PLAN',
                target_type: 'SHOP',
                target_id: shopId,
                details: updates
            })

            fetchSubscriptions()
            setEditingPlanShopId(null)
        } catch (err) {
            alert('Failed to update plan: ' + err.message)
        }
    }

    const handleExportSubscriptions = () => {
        const dataToExport = filtered.map(shop => ({
            'Shop ID': shop.id,
            'Shop Name': shop.name,
            'Phone': shop.phone || 'N/A',
            'Plan': shop.subscription_plan || 'none',
            'Fee': shop.subscription_fee || 0,
            'Next Billing': shop.next_billing_date || 'N/A',
            'Status': shop.status || 'active'
        }))

        const ws = XLSX.utils.json_to_sheet(dataToExport)
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Subscriptions')
        XLSX.writeFile(wb, `EdgeX_Subscriptions_Export_${new Date().toISOString().split('T')[0]}.xlsx`)
    }

    const handleExportLedger = () => {
        if (!selectedShop || ledgerData.length === 0) return

        const dataToExport = ledgerData.map(entry => ({
            'Entry ID': entry.id,
            'Date': new Date(entry.payment_date).toLocaleDateString(),
            'Type': entry.payment_type.replace('_', ' ').toUpperCase(),
            'Amount': entry.amount,
            'Remarks': entry.remarks || 'No notes'
        }))

        const ws = XLSX.utils.json_to_sheet(dataToExport)
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Ledger')
        XLSX.writeFile(wb, `Ledger_${selectedShop.name}_${new Date().toISOString().split('T')[0]}.xlsx`)
    }

    const getStats = () => {
        let activeCount = 0
        let overdueCount = 0
        let suspendedCount = 0
        let projectedRevenue = 0

        const today = new Date()
        today.setHours(0, 0, 0, 0)

        shops.forEach(s => {
            const isActive = s.status === 'active' || !s.status
            const nextBilling = s.next_billing_date ? new Date(s.next_billing_date) : null

            if (isActive) {
                activeCount++
                projectedRevenue += Number(s.subscription_fee || 0)
                
                if (nextBilling && nextBilling < today) {
                    overdueCount++
                }
            } else if (s.status === 'suspended') {
                suspendedCount++
            }
        })

        return { activeCount, overdueCount, suspendedCount, projectedRevenue }
    }

    const stats = getStats()

    const filtered = shops.filter(s => {
        const matchesSearch = s.name?.toLowerCase().includes(search.toLowerCase()) || String(s.id).includes(search)
        if (!matchesSearch) return false

        const isActive = s.status === 'active' || !s.status
        const nextBilling = s.next_billing_date ? new Date(s.next_billing_date) : null
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const isOverdue = nextBilling && nextBilling < today && isActive

        if (subFilter === 'active') return isActive && !isOverdue
        if (subFilter === 'overdue') return isOverdue
        if (subFilter === 'suspended') return s.status === 'suspended'
        return true
    })

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
                <h1 className="text-2xl font-bold text-slate-800 flex-1">💳 Billing & Subscriptions</h1>
                <div className="flex bg-slate-100 p-1 rounded-xl gap-1 shrink-0">
                    {['all', 'active', 'overdue', 'suspended'].map(filter => (
                        <button
                            key={filter}
                            type="button"
                            onClick={() => setSubFilter(filter)}
                            className={`px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wider transition ${
                                subFilter === filter
                                    ? 'bg-white text-blue-600 shadow-sm border border-slate-200/50'
                                    : 'text-slate-500 hover:text-slate-800'
                            }`}
                        >
                            {filter}
                        </button>
                    ))}
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
                    <button
                        onClick={handleExportSubscriptions}
                        className="flex items-center justify-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-600 font-bold rounded-xl shadow-sm hover:bg-slate-50 transition"
                    >
                        <FileText size={18} className="text-emerald-500" />
                        Export Excel
                    </button>
                    <div className="relative flex-1 sm:w-72">
                        <Search className="absolute left-3 top-2.5 text-slate-400" size={20} />
                        <input
                            type="text"
                            placeholder="Search by shop name or ID..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                        />
                    </div>
                </div>
            </div>

            {/* KPI Metrics row */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500 font-bold">
                        <CheckCircle2 size={24} />
                    </div>
                    <div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Active plans</p>
                        <h4 className="text-xl font-black text-slate-800">{stats.activeCount}</h4>
                    </div>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-amber-50 flex items-center justify-center text-amber-500 font-bold">
                        <Clock size={24} />
                    </div>
                    <div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Overdue (Grace)</p>
                        <h4 className="text-xl font-black text-slate-800">{stats.overdueCount}</h4>
                    </div>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center text-red-500 font-bold">
                        <AlertTriangle size={24} />
                    </div>
                    <div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Suspended</p>
                        <h4 className="text-xl font-black text-slate-800">{stats.suspendedCount}</h4>
                    </div>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-500 font-bold">
                        <CreditCard size={24} />
                    </div>
                    <div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Monthly Revenue</p>
                        <h4 className="text-xl font-black text-slate-800 font-mono">Rs. {stats.projectedRevenue.toLocaleString()}</h4>
                    </div>
                </div>
            </div>

            {errorMsg && (
                <div className="bg-red-50 text-red-600 p-4 rounded-xl flex items-center gap-2 font-bold mb-4">
                    <AlertTriangle size={20} /> {errorMsg}
                </div>
            )}

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden overflow-x-auto text-sm">
                <table className="w-full text-left border-collapse min-w-[700px]">
                    <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-xs uppercase tracking-wider text-slate-500 font-bold">
                            <th className="p-4 pl-6">Client / Shop</th>
                            <th className="p-4">Plan / Fee</th>
                            <th className="p-4">Next Billing Date</th>
                            <th className="p-4">Status</th>
                            <th className="p-4 text-right pr-6">Payment Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {loading ? (
                            <tr><td colSpan="5" className="p-8 text-center text-slate-400">Loading subscriptions...</td></tr>
                        ) : filtered.length === 0 ? (
                            <tr><td colSpan="5" className="p-8 text-center text-slate-400">No matching subscriptions found.</td></tr>
                        ) : (
                            filtered.map(shop => {
                                const isOverdue = shop.next_billing_date && new Date(shop.next_billing_date) < new Date()
                                const daysRemaining = shop.next_billing_date ? Math.ceil((new Date(shop.next_billing_date) - new Date()) / (1000 * 60 * 60 * 24)) : 999
                                const isEditing = editingPlanShopId === shop.id

                                return (
                                    <tr key={shop.id} className="hover:bg-slate-50 transition">
                                        <td className="p-4 pl-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold shrink-0">
                                                    {shop.name.charAt(0).toUpperCase()}
                                                </div>
                                                <div>
                                                    <p className="font-bold text-slate-800">{shop.name}</p>
                                                    <p className="text-xs text-slate-400">ID: {shop.id} • {shop.phone || 'No Phone'}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-4">
                                            {isEditing ? (
                                                <div className="flex flex-col gap-2 max-w-[150px]">
                                                    <select
                                                        className="border rounded p-1 text-xs font-bold"
                                                        value={planForm.planId}
                                                        onChange={e => {
                                                            const p = allPlans.find(pl => String(pl.id) === e.target.value)
                                                            setPlanForm({ ...planForm, planId: e.target.value, fee: p ? p.price : 0 })
                                                        }}
                                                    >
                                                        <option value="">Legacy / Manual</option>
                                                        {allPlans.map(p => (
                                                            <option key={p.id} value={p.id}>{p.name}</option>
                                                        ))}
                                                    </select>

                                                    <input
                                                        type="number"
                                                        className="border rounded p-1 text-xs"
                                                        value={planForm.fee}
                                                        onChange={e => setPlanForm({ ...planForm, fee: e.target.value })}
                                                        placeholder="Fee amount"
                                                    />

                                                    <div className="flex gap-1">
                                                        <button onClick={() => handleSavePlan(shop.id)} className="bg-blue-600 text-white px-2 py-1 rounded text-xs">Save</button>
                                                        <button onClick={() => setEditingPlanShopId(null)} className="bg-slate-200 text-slate-700 px-2 py-1 rounded text-xs">Cancel</button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div>
                                                    <p className="font-black text-blue-700 capitalize flex items-center gap-2">
                                                        {shop.subscription_plans?.name || shop.subscription_plan || 'TRIAL'}
                                                        <button onClick={() => {
                                                            setEditingPlanShopId(shop.id)
                                                            setPlanForm({
                                                                planId: shop.plan_id || '',
                                                                fee: shop.subscription_fee || 0
                                                            })
                                                        }} className="text-blue-500 text-[10px] hover:underline font-bold bg-blue-50 px-1 rounded">Edit</button>
                                                    </p>
                                                    <p className="text-slate-500 font-mono text-xs">Rs. {Number(shop.subscription_fee || 0).toLocaleString()}</p>
                                                </div>
                                            )}
                                        </td>
                                        <td className="p-4">
                                            {shop.next_billing_date ? (
                                                <div className={`flex items-center gap-2 font-medium ${isOverdue ? 'text-red-500' : 'text-slate-600'}`}>
                                                    {isOverdue ? <AlertTriangle size={16} /> : <Clock size={16} />}
                                                    {new Date(shop.next_billing_date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                                </div>
                                            ) : (
                                                <span className="text-slate-400 text-xs italic">Not Set</span>
                                            )}
                                        </td>
                                        <td className="p-4">
                                            {shop.status === 'suspended' ? (
                                                <span className="bg-red-50 text-red-600 font-bold px-2.5 py-1 rounded-lg text-xs">Suspended</span>
                                            ) : isOverdue ? (
                                                <span className="bg-amber-50 text-amber-600 font-bold px-2.5 py-1 rounded-lg text-xs">Overdue (Grace)</span>
                                            ) : (
                                                <span className="bg-emerald-50 text-emerald-600 font-bold px-2.5 py-1 rounded-lg text-xs">Active</span>
                                            )}
                                        </td>
                                        <td className="p-4 pr-6 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                <button
                                                    onClick={() => openLedgerModal(shop)}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
                                                    title="View Payment Ledger"
                                                >
                                                    <FileText size={14} /> Ledger
                                                </button>
                                                <button
                                                    onClick={() => { setWhatsAppShop(shop); setWhatsAppModalOpen(true) }}
                                                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                                                        isOverdue
                                                            ? 'text-red-700 bg-red-100 hover:bg-red-200'
                                                            : daysRemaining <= 7
                                                                ? 'text-amber-700 bg-amber-100 hover:bg-amber-200'
                                                                : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                                                    }`}
                                                    title="Send WhatsApp Expiry Reminder"
                                                >
                                                    <MessageSquare size={14} /> Remind
                                                </button>
                                                <button
                                                    onClick={() => openExtendModal(shop)}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition"
                                                    title="Extend Billing Date"
                                                >
                                                    <Clock size={14} /> Extend
                                                </button>
                                                <button
                                                    onClick={() => openPaymentModal(shop)}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-emerald-700 bg-emerald-100 hover:bg-emerald-200 rounded-lg shadow-sm transition"
                                                    title="Record Manual Payment"
                                                >
                                                    <CreditCard size={14} /> Pay
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                )
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {/* Payment Modal */}
            {paymentModalOpen && selectedShop && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                        <div className="p-6 border-b border-gray-100 bg-slate-50 flex justify-between items-center">
                            <div>
                                <h3 className="text-xl font-bold text-gray-800">Record Payment</h3>
                                <p className="text-sm text-gray-500">For {selectedShop.name}</p>
                            </div>
                        </div>
                        <form onSubmit={handleRecordPayment} className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-gray-700 mb-1">Amount (Rs.)</label>
                                <input
                                    type="number"
                                    required
                                    value={paymentAmount}
                                    onChange={e => setPaymentAmount(e.target.value)}
                                    className="w-full p-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 mb-1">Payment Method</label>
                                <select
                                    required
                                    value={paymentType}
                                    onChange={e => setPaymentType(e.target.value)}
                                    className="w-full p-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500"
                                >
                                    <option value="bank_transfer">Bank Transfer</option>
                                    <option value="cash">Cash</option>
                                    <option value="card">Credit/Debit Card</option>
                                    <option value="refund" className="font-bold text-red-600">Refund / Return</option>
                                    <option value="other">Other</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 mb-1">Billing Extension Period</label>
                                <select
                                    required
                                    value={extensionPeriod}
                                    onChange={e => setExtensionPeriod(e.target.value)}
                                    className="w-full p-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 bg-white"
                                >
                                    <option value="auto">Auto (Plan default)</option>
                                    <option value="none">No Extension</option>
                                    <option value="1_month">1 Month (30 days)</option>
                                    <option value="3_months">3 Months (90 days)</option>
                                    <option value="6_months">6 Months (180 days)</option>
                                    <option value="1_year">1 Year (365 days)</option>
                                    <option value="custom">Custom Days</option>
                                </select>
                            </div>
                            {extensionPeriod === 'custom' && (
                                <div>
                                    <label className="block text-sm font-bold text-gray-700 mb-1">Custom Extension Days</label>
                                    <input
                                        type="number"
                                        required
                                        min="1"
                                        placeholder="e.g. 15"
                                        value={customExtensionDays}
                                        onChange={e => setCustomExtensionDays(e.target.value)}
                                        className="w-full p-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                            )}
                            <div>
                                <label className="block text-sm font-bold text-gray-700 mb-1">Remarks / Note</label>
                                <input
                                    type="text"
                                    value={remarks}
                                    onChange={e => setRemarks(e.target.value)}
                                    placeholder="e.g. Cleared via EasyPaisa"
                                    className="w-full p-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div className={`p-4 rounded-xl text-sm flex items-start gap-2 ${paymentType === 'refund' ? 'bg-red-50 text-red-800' : 'bg-blue-50 text-blue-800'}`}>
                                {paymentType === 'refund' ? (
                                    <>
                                        <AlertTriangle size={24} className="shrink-0 text-red-500" />
                                        <p>This will be recorded as a REDUCTION in revenue. It does NOT extend their billing date.</p>
                                    </>
                                ) : (
                                    <>
                                        <CheckCircle2 size={24} className="shrink-0 text-blue-500" />
                                        <p>Recording this payment will automatically activate their account and extend their Next Billing Date.</p>
                                    </>
                                )}
                            </div>
                            <div className="flex gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={() => setPaymentModalOpen(false)}
                                    className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold rounded-xl transition"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={processing}
                                    className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg transition disabled:opacity-50"
                                >
                                    {processing ? 'Saving...' : 'Confirm Payment'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Ledger Modal */}
            {ledgerModalOpen && selectedShop && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
                        <div className="p-6 border-b border-gray-100 bg-slate-50 flex justify-between items-center shrink-0">
                            <div>
                                <h3 className="text-xl font-bold text-gray-800">Payment Ledger</h3>
                                <p className="text-sm text-gray-500">{selectedShop.name} ({selectedShop.subscription_plan} plan)</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleExportLedger}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 rounded-lg transition"
                                >
                                    <FileText size={14} /> Export CSV
                                </button>
                                <button onClick={() => setLedgerModalOpen(false)} className="text-slate-400 hover:text-slate-600 font-bold text-xl px-2">&times;</button>
                            </div>
                        </div>
                        <div className="p-6 overflow-y-auto bg-slate-50/50">
                            {ledgerLoading ? (
                                <p className="text-center text-slate-400 py-8">Loading records...</p>
                            ) : ledgerData.length === 0 ? (
                                <p className="text-center text-slate-400 py-8">No payment records found for this client.</p>
                            ) : (
                                <div className="space-y-3">
                                    {ledgerData.map(entry => (
                                        <div key={entry.id} className="bg-white border text-sm border-slate-200 p-4 rounded-xl shadow-sm flex justify-between items-center">
                                            <div className="flex gap-4 items-center">
                                                <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-500">
                                                    <CreditCard size={18} />
                                                </div>
                                                <div>
                                                    <p className="font-bold text-slate-800">Rs. {Number(entry.amount).toLocaleString()}</p>
                                                    <p className="text-xs text-slate-500 capitalize">{entry.payment_type.replace('_', ' ')} • {entry.remarks || 'No notes'}</p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-sm font-medium text-slate-700">
                                                    {new Date(entry.payment_date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                                </p>
                                                <p className="text-xs text-slate-400">Ref: #{entry.id}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
            {/* Extend Billing Modal */}
            {extendModalOpen && selectedShop && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                        <div className="p-6 border-b border-gray-100 bg-slate-50 flex justify-between items-center">
                            <div>
                                <h3 className="text-xl font-bold text-gray-800">Extend Billing Cycle</h3>
                                <p className="text-sm text-gray-500">For {selectedShop.name}</p>
                            </div>
                        </div>
                        <form onSubmit={handleExtendBilling} className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-gray-700 mb-1">Days to Extend</label>
                                <select
                                    required
                                    value={extendDays}
                                    onChange={e => setExtendDays(e.target.value)}
                                    className="w-full p-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 bg-white font-bold"
                                >
                                    <option value="3">3 Days (Quick grace)</option>
                                    <option value="7">7 Days (Standard extension)</option>
                                    <option value="15">15 Days (Half month)</option>
                                    <option value="30">30 Days (Full month)</option>
                                </select>
                            </div>
                            <div className="p-4 rounded-xl text-sm bg-blue-50 text-blue-800 flex items-start gap-2">
                                <CheckCircle2 size={24} className="shrink-0 text-blue-500" />
                                <p>This will extend the next billing date without recording a payment transaction, and automatically activate the shop if suspended.</p>
                            </div>
                            <div className="flex gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={() => setExtendModalOpen(false)}
                                    className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold rounded-xl transition"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={processing}
                                    className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg transition disabled:opacity-50"
                                >
                                    {processing ? 'Saving...' : 'Confirm Extension'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* WhatsApp Reminder Modal */}
            {whatsAppModalOpen && whatsAppShop && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
                        <div className="p-6 border-b border-gray-100 bg-slate-50 flex justify-between items-center">
                            <div>
                                <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                                    <MessageSquare className="text-emerald-600" size={20} />
                                    <span>Send WhatsApp Reminder</span>
                                </h3>
                                <p className="text-xs text-gray-500">For {whatsAppShop.name} ({whatsAppShop.phone || 'No phone'})</p>
                            </div>
                            <button onClick={() => setWhatsAppModalOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
                        </div>
                        <div className="p-6 space-y-4 overflow-y-auto">
                            <div>
                                <label className="block text-xs font-bold text-gray-600 uppercase mb-1">Your Bank / JazzCash / EasyPaisa Details</label>
                                <textarea
                                    rows={3}
                                    value={bankDetails}
                                    onChange={e => {
                                        setBankDetails(e.target.value)
                                        localStorage.setItem('superadmin_bank_details', e.target.value)
                                    }}
                                    placeholder="Enter your payment accounts to include in the reminder..."
                                    className="w-full p-2.5 border border-gray-200 rounded-xl text-xs font-mono focus:ring-2 focus:ring-blue-500"
                                />
                                <p className="text-[10px] text-gray-400 mt-0.5">Saved automatically for future reminders.</p>
                            </div>

                            {/* Message Preview */}
                            <div>
                                <label className="block text-xs font-bold text-gray-600 uppercase mb-1">Message Preview</label>
                                <div className="p-3.5 bg-emerald-50/60 border border-emerald-200 rounded-xl text-xs font-mono whitespace-pre-wrap text-emerald-950 max-h-56 overflow-y-auto leading-relaxed">
                                    {formatRenewalMessage({
                                        shopName: whatsAppShop.name,
                                        planName: whatsAppShop.subscription_plans?.name || whatsAppShop.subscription_plan,
                                        expiryDate: whatsAppShop.next_billing_date,
                                        amount: whatsAppShop.subscription_fee,
                                        bankDetails: bankDetails,
                                        isOverdue: whatsAppShop.next_billing_date && new Date(whatsAppShop.next_billing_date) < new Date()
                                    })}
                                </div>
                            </div>

                            <div className="flex gap-3 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setWhatsAppModalOpen(false)}
                                    className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold rounded-xl text-xs transition"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const msg = formatRenewalMessage({
                                            shopName: whatsAppShop.name,
                                            planName: whatsAppShop.subscription_plans?.name || whatsAppShop.subscription_plan,
                                            expiryDate: whatsAppShop.next_billing_date,
                                            amount: whatsAppShop.subscription_fee,
                                            bankDetails: bankDetails,
                                            isOverdue: whatsAppShop.next_billing_date && new Date(whatsAppShop.next_billing_date) < new Date()
                                        })
                                        const url = buildWhatsAppUrl(whatsAppShop.phone, msg)
                                        window.open(url, '_blank')
                                        setWhatsAppModalOpen(false)
                                    }}
                                    className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow-lg shadow-emerald-600/30 text-xs flex items-center justify-center gap-2 transition"
                                >
                                    <MessageSquare size={16} /> Open WhatsApp
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
