import { useState, useEffect } from 'react'
import { supabaseAdmin } from '../services/supabase'
import { Plus, Zap, Check, AlertTriangle, Edit2, Trash2, ShieldCheck } from 'lucide-react'
import { logAction } from '../services/auditService'
import { useAuth } from '../context/AuthContext'

export default function PlanManagement() {
    const { user: adminUser } = useAuth()
    const [plans, setPlans] = useState([])
    const [loading, setLoading] = useState(true)
    const [isAdding, setIsAdding] = useState(false)
    const [editingPlan, setEditingPlan] = useState(null)

    const FEATURE_LABELS = {
        pos:              'POS / Billing Screen',
        products:         'Product Catalog',
        categories:       'Categories',
        customers:        'Customers',
        sales_history:    'Sales History',
        discount:         'Discount on POS',
        brands:           'Brands Management',
        suppliers:        'Suppliers',
        purchases:        'Purchases & Orders',
        customer_ledger:  'Customer Credit Ledger',
        reports:          'Revenue Reports',
        data_export:      'Data Export (Backup)',
        offline_sync:     'Offline Mode & Sync',
        expenses:         'Expense Tracking',
        supplier_ledger:  'Supplier Ledger',
        trash_bin:        'Trash / Restore Deleted',
        bulk_import:      'Bulk Product Import',
        audit_logs:       'Audit Trail Logs',
        advanced_reports: 'Advanced Analytics',
        barcode_labels:   'Barcode Sticker Generator',
        whatsapp:         'WhatsApp Messaging',
        api_access:       'API / Integrations',
        wholesale:        'Wholesale Mode (Retail ⇄ Wholesale prices)',
    }

    const DEFAULT_FEATURES = Object.fromEntries(Object.keys(FEATURE_LABELS).map(k => [k, false]))

    // Form State
    const [form, setForm] = useState({
        name: '',
        price: 0,
        billing_cycle: 'monthly',
        product_limit: 100,
        user_limit: 3,
        features: { ...DEFAULT_FEATURES, print_templates: 1 }
    })

    useEffect(() => {
        fetchPlans()
    }, [])

    const fetchPlans = async () => {
        if (!supabaseAdmin) return
        try {
            const { data, error } = await supabaseAdmin
                .from('subscription_plans')
                .select('*')
                .order('price', { ascending: true })
            if (error) throw error
            setPlans(data)
        } catch (err) {
            console.error('Failed to fetch plans:', err)
        } finally {
            setLoading(false)
        }
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        try {
            if (editingPlan) {
                const { error } = await supabaseAdmin
                    .from('subscription_plans')
                    .update(form)
                    .eq('id', editingPlan.id)
                if (error) throw error

                await logAction({
                    actor_id: adminUser?.id,
                    actor_email: adminUser?.email || adminUser?.username,
                    action_type: 'UPDATE_PLAN',
                    target_type: 'PLAN',
                    target_id: editingPlan.id,
                    details: form
                })
            } else {
                const { data, error } = await supabaseAdmin
                    .from('subscription_plans')
                    .insert([form])
                    .select()
                if (error) throw error

                await logAction({
                    actor_id: adminUser?.id,
                    actor_email: adminUser?.email || adminUser?.username,
                    action_type: 'CREATE_PLAN',
                    target_type: 'PLAN',
                    target_id: data[0].id,
                    details: form
                })
            }
            fetchPlans()
            resetForm()
        } catch (err) {
            alert('Failed to save plan: ' + err.message)
        }
    }

    const resetForm = () => {
        setForm({ name: '', price: 0, billing_cycle: 'monthly', product_limit: 100, user_limit: 3, features: { ...DEFAULT_FEATURES, print_templates: 1 } })
        setIsAdding(false)
        setEditingPlan(null)
    }

    const startEdit = (plan) => {
        setEditingPlan(plan)
        setForm({
            name: plan.name,
            price: plan.price,
            billing_cycle: plan.billing_cycle,
            product_limit: plan.product_limit,
            user_limit: plan.user_limit,
            features: { ...DEFAULT_FEATURES, print_templates: 1, ...(plan.features || {}) }
        })
        setIsAdding(true)
    }

    const toggleFeature = (key) => {
        setForm(f => ({ ...f, features: { ...f.features, [key]: !f.features[key] } }))
    }

    if (loading) return <div className="p-8 text-center text-slate-500 font-bold">Loading Plans...</div>

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <div className="flex justify-between items-end">
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
                        <Zap className="text-amber-500 fill-amber-500" size={32} />
                        Subscription Tiers
                    </h1>
                    <p className="text-slate-500 font-medium tracking-wide mt-1 text-sm">Define feature limits and pricing for your SaaS platform.</p>
                </div>
                <button
                    onClick={() => setIsAdding(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-blue-500/30 transition-all active:scale-95"
                >
                    <Plus size={20} /> Create New Plan
                </button>
            </div>

            {isAdding && (
                <div className="bg-white rounded-2xl shadow-xl border border-blue-100 overflow-hidden ring-4 ring-blue-50/50">
                    <div className="bg-blue-50 px-8 py-4 border-b border-blue-100 flex justify-between items-center">
                        <h3 className="font-bold text-blue-900 flex items-center gap-2 uppercase tracking-widest text-xs">
                            {editingPlan ? 'Edit Configuration' : 'Design New Tier'}
                        </h3>
                    </div>
                    <form onSubmit={handleSubmit} className="p-8">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase mb-2 tracking-widest text-[10px]">Plan Name</label>
                                <input
                                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold text-slate-700"
                                    value={form.name}
                                    onChange={e => setForm({ ...form, name: e.target.value })}
                                    placeholder="e.g. Basic, Pro, Gold"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase mb-2 tracking-widest text-[10px]">Price (Rs.)</label>
                                <input
                                    type="number"
                                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold text-slate-700"
                                    value={form.price}
                                    onChange={e => setForm({ ...form, price: Number(e.target.value) })}
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase mb-2 tracking-widest text-[10px]">Billing Cycle</label>
                                <select
                                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold text-slate-700"
                                    value={form.billing_cycle}
                                    onChange={e => setForm({ ...form, billing_cycle: e.target.value })}
                                >
                                    <option value="monthly">Monthly</option>
                                    <option value="annually">Annually</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase mb-2 tracking-widest text-[10px]">Product Limit</label>
                                <input
                                    type="number"
                                    className="w-full px-4 py-3 bg-emerald-50/50 border border-emerald-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 font-bold text-emerald-900"
                                    value={form.product_limit}
                                    onChange={e => setForm({ ...form, product_limit: Number(e.target.value) })}
                                    required
                                />
                                <p className="text-[10px] text-slate-400 mt-1 font-bold">Max products allowed in inventory</p>
                            </div>
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase mb-2 tracking-widest text-[10px]">Staff Account Limit</label>
                                <input
                                    type="number"
                                    className="w-full px-4 py-3 bg-emerald-50/50 border border-emerald-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 font-bold text-emerald-900"
                                    value={form.user_limit}
                                    onChange={e => setForm({ ...form, user_limit: Number(e.target.value) })}
                                    required
                                />
                                <p className="text-[10px] text-slate-400 mt-1 font-bold">Max sub-users (Cashiers)</p>
                            </div>
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase mb-2 tracking-widest text-[10px]">Print Templates</label>
                                <select
                                    className="w-full px-4 py-3 bg-emerald-50/50 border border-emerald-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 font-bold text-emerald-900"
                                    value={form.features?.print_templates || 1}
                                    onChange={e => setForm(f => ({ ...f, features: { ...f.features, print_templates: Number(e.target.value) } }))}
                                >
                                    <option value={1}>1 — Simple only</option>
                                    <option value={2}>2 — Simple + Classic</option>
                                    <option value={3}>3 — All Templates</option>
                                </select>
                                <p className="text-[10px] text-slate-400 mt-1 font-bold">Billing template options available to shop</p>
                            </div>
                        </div>

                        {/* Feature Toggles */}
                        <div className="mt-8 pt-6 border-t border-slate-100">
                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Feature Access</h4>
                            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                {Object.entries(FEATURE_LABELS).map(([key, label]) => (
                                    <label
                                        key={key}
                                        className={`flex items-center gap-2 p-3 rounded-xl border cursor-pointer transition select-none ${
                                            form.features?.[key]
                                                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                                : 'bg-slate-50 border-slate-200 text-slate-400'
                                        }`}
                                    >
                                        <input
                                            type="checkbox"
                                            className="sr-only"
                                            checked={!!form.features?.[key]}
                                            onChange={() => toggleFeature(key)}
                                        />
                                        <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] font-black flex-shrink-0 ${
                                            form.features?.[key] ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-400'
                                        }`}>
                                            {form.features?.[key] ? '✓' : '✗'}
                                        </span>
                                        <span className="text-xs font-bold leading-tight">{label}</span>
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="mt-8 flex justify-end gap-3">
                            <button type="button" onClick={resetForm} className="px-6 py-3 font-bold text-slate-500 hover:text-slate-800 transition">Cancel</button>
                            <button type="submit" className="px-8 py-3 bg-blue-600 text-white rounded-xl font-black text-sm uppercase tracking-widest shadow-lg shadow-blue-500/20 active:scale-95 transition">
                                {editingPlan ? 'Save Changes' : 'Launch Plan'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {plans.map(plan => (
                    <div key={plan.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden flex flex-col group hover:shadow-md transition-all duration-300">
                        <div className={`p-6 bg-slate-50 border-b border-slate-100 group-hover:bg-blue-50/30 transition-colors`}>
                            <div className="flex justify-between items-start">
                                <div>
                                    <h4 className="text-xl font-black text-slate-800 leading-tight">{plan.name}</h4>
                                    <span className="text-[10px] font-black text-slate-400 tracking-widest uppercase">{plan.billing_cycle}</span>
                                </div>
                                <div className="text-right">
                                    <p className="text-lg font-black text-blue-600">Rs. {plan.price.toLocaleString()}</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-6 flex-1 space-y-4">
                            <div className="flex items-center gap-3 p-3 bg-emerald-50/50 rounded-xl border border-emerald-50">
                                <Check className="text-emerald-600 shrink-0" size={18} />
                                <span className="text-xs font-bold text-emerald-800"><b>{plan.product_limit.toLocaleString()}</b> Products Included</span>
                            </div>
                            <div className="flex items-center gap-3 p-3 bg-emerald-50/50 rounded-xl border border-emerald-50">
                                <Check className="text-emerald-600 shrink-0" size={18} />
                                <span className="text-xs font-bold text-emerald-800"><b>{plan.user_limit}</b> Staff Accounts</span>
                            </div>
                            <div className="flex items-center gap-3 p-3 bg-slate-50/50 rounded-xl">
                                <ShieldCheck className="text-slate-400 shrink-0" size={18} />
                                <span className="text-xs font-bold text-slate-500">Global POS Support</span>
                            </div>
                        </div>
                        <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-2">
                            <button
                                onClick={() => startEdit(plan)}
                                className="flex-1 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-100 transition flex items-center justify-center gap-1"
                            >
                                <Edit2 size={12} /> Edit
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
