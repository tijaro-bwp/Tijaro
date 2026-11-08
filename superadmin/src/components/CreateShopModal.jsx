import { useState, useEffect } from 'react'
import { supabaseAdmin } from '../services/supabase'
import { X, Store, User, Mail, Key, Zap, AlertTriangle, CheckCircle2, MessageSquare, Copy, Check } from 'lucide-react'
import { hashPassword } from '../utils/authUtils'
import { buildWhatsAppUrl, formatOnboardingMessage } from '../utils/whatsappTemplates'

const STORE_TYPES = [
  { id: 'general', name: 'General Retail / Mart' },
  { id: 'grocery', name: 'Grocery & Supermarket (FMCG)' },
  { id: 'apparel', name: 'Clothing, Shoes & Apparel' },
  { id: 'pharmacy', name: 'Pharmacy & Medical Store' },
  { id: 'electronics', name: 'Mobile, Computers & Electronics' },
  { id: 'hardware', name: 'Hardware, Sanitary & Building' },
]

export default function CreateShopModal({ onClose, onCreated }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Form State
  const [shopName, setShopName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [businessType, setBusinessType] = useState('general')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerUsername, setOwnerUsername] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [selectedPlanId, setSelectedPlanId] = useState('')

  // Success State for WhatsApp Onboarding
  const [createdData, setCreatedData] = useState(null)
  const [copied, setCopied] = useState(false)

  // Plans
  const [plans, setPlans] = useState([])
  const [plansLoading, setPlansLoading] = useState(true)

  useEffect(() => {
    fetchPlans()
  }, [])

  const fetchPlans = async () => {
    try {
      const { data, error } = await supabaseAdmin
        .from('subscription_plans')
        .select('id, name, price, billing_cycle')
        .order('price', { ascending: true })
      if (!error) setPlans(data || [])
    } catch (err) {
      console.error('Failed to load plans:', err)
    } finally {
      setPlansLoading(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!supabaseAdmin) {
      setError("This legacy portal is retired. Use /admin in EdgeX POS.")
      return
    }
    if (!selectedPlanId) {
      setError('Please select a subscription plan for this shop.')
      return
    }

    setError('')
    setLoading(true)

    try {
      // 1. Create the Shop with plan_id and business_type
      let shopInsert = {
        name: shopName,
        phone,
        address,
        email: ownerEmail,
        status: 'active',
        plan_id: selectedPlanId,
        business_type: businessType
      }

      let { data: shopData, error: shopError } = await supabaseAdmin
        .from('shops')
        .insert([shopInsert])
        .select()
        .single()

      // Fallback in case business_type column is not yet migrated in Supabase
      if (shopError && shopError.message?.includes('business_type')) {
        delete shopInsert.business_type
        const retry = await supabaseAdmin.from('shops').insert([shopInsert]).select().single()
        if (retry.error) throw new Error('Failed to create shop: ' + retry.error.message)
        shopData = retry.data
      } else if (shopError) {
        throw new Error('Failed to create shop: ' + shopError.message)
      }

      // 2. Create the Owner Auth User via Admin API
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: ownerEmail,
        password: ownerPassword,
        email_confirm: true,
        user_metadata: {
          role: 'admin',
          shop_id: shopData.id
        }
      })

      if (authError) {
        // Rollback shop if user creation fails
        await supabaseAdmin.from('shops').delete().eq('id', shopData.id)
        throw new Error('Failed to create user account: ' + authError.message)
      }

      // 3. Ensure the public users table is updated with raw_password for superadmin helpdesk
      const hashedPassword = await hashPassword(ownerPassword)
      let userInsert = {
        id: authData.user.id,
        username: ownerUsername || ownerEmail.split('@')[0],
        email: ownerEmail,
        password: hashedPassword,
        raw_password: ownerPassword,
        role: 'admin',
        shop_id: shopData.id,
        is_active: true
      }

      let { error: profileError } = await supabaseAdmin.from('users').insert([userInsert])
      // Fallback if raw_password column is not yet migrated
      if (profileError && profileError.message?.includes('raw_password')) {
        delete userInsert.raw_password
        profileError = (await supabaseAdmin.from('users').insert([userInsert])).error
      }

      if (profileError) {
        console.warn('Profile update warning:', profileError)
      }

      const activePlan = plans.find(p => p.id === selectedPlanId)

      setCreatedData({
        shopName: shopData.name,
        phone: phone,
        username: ownerUsername || ownerEmail.split('@')[0],
        password: ownerPassword,
        planName: activePlan?.name || 'Selected Plan',
        loginUrl: import.meta.env.VITE_POS_URL || 'https://pos.edgexsuite.com'
      })

      if (onCreated) onCreated()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const selectedPlan = plans.find(p => p.id === selectedPlanId)

  const handleCopyCredentials = () => {
    if (!createdData) return
    const text = `EdgeX POS Credentials\nShop: ${createdData.shopName}\nLogin: ${createdData.loginUrl}\nUsername: ${createdData.username}\nPassword: ${createdData.password}\nPlan: ${createdData.planName}`
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  const handleSendWhatsApp = () => {
    if (!createdData) return
    const msg = formatOnboardingMessage(createdData)
    const url = buildWhatsAppUrl(createdData.phone, msg)
    window.open(url, '_blank')
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center p-6 border-b border-slate-100 bg-slate-50 shrink-0">
          <div>
            <h2 className="text-xl font-bold text-slate-800">
              {createdData ? '🎉 Tenant Ready' : 'Register New Tenant'}
            </h2>
            <p className="text-xs text-slate-500">
              {createdData ? 'Shop created! Dispatch login credentials to owner.' : 'Create a shop and its owner account instantly.'}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 bg-white p-2 rounded-xl shadow-sm border border-slate-200">
            <X size={20} />
          </button>
        </div>

        {/* ── ONBOARDING SUCCESS SCREEN ── */}
        {createdData ? (
          <div className="p-6 space-y-5 overflow-y-auto">
            <div className="text-center py-2">
              <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3 shadow-inner">
                <CheckCircle2 size={32} />
              </div>
              <h3 className="text-xl font-black text-slate-800">{createdData.shopName}</h3>
              <p className="text-xs text-slate-500 mt-0.5">Account has been provisioned and is active now.</p>
            </div>

            {/* Credentials Card */}
            <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 space-y-3">
              <div className="flex justify-between items-center text-xs pb-2 border-b border-slate-200">
                <span className="text-slate-500 font-medium">Login Portal</span>
                <a href={createdData.loginUrl} target="_blank" rel="noreferrer" className="font-bold text-blue-600 hover:underline">
                  {createdData.loginUrl}
                </a>
              </div>
              <div className="flex justify-between items-center text-xs pb-2 border-b border-slate-200">
                <span className="text-slate-500 font-medium">Owner Username</span>
                <span className="font-mono font-bold text-slate-800 bg-white px-2 py-0.5 rounded border">
                  {createdData.username}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs pb-2 border-b border-slate-200">
                <span className="text-slate-500 font-medium">Temporary Password</span>
                <span className="font-mono font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  {createdData.password}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500 font-medium">Assigned Plan</span>
                <span className="font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                  {createdData.planName}
                </span>
              </div>
            </div>

            {/* WhatsApp & Copy Buttons */}
            <div className="space-y-2 pt-2">
              <button
                type="button"
                onClick={handleSendWhatsApp}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow-lg shadow-emerald-600/30 flex items-center justify-center gap-2 transition"
              >
                <MessageSquare size={18} />
                <span>Send Credentials via WhatsApp</span>
              </button>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCopyCredentials}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl flex items-center justify-center gap-2 transition text-xs"
                >
                  {copied ? <Check size={16} className="text-emerald-600" /> : <Copy size={16} />}
                  <span>{copied ? 'Copied to Clipboard!' : 'Copy Credentials'}</span>
                </button>

                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition text-xs"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ── CREATION FORM ── */
          <form onSubmit={handleSubmit} className="p-6 space-y-6 overflow-y-auto">
            {error && (
              <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm font-medium border border-red-100 flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}

            {/* Subscription Plan — first & required */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800 mb-3 pb-2 border-b border-slate-100">
                <Zap size={18} className="text-amber-500" /> Subscription Plan <span className="text-red-500 text-xs font-bold ml-1">Required</span>
              </h3>
              {plansLoading ? (
                <div className="text-xs text-slate-400 py-2">Loading plans...</div>
              ) : plans.length === 0 ? (
                <div className="p-3 bg-amber-50 text-amber-700 rounded-lg text-xs border border-amber-200 font-medium">
                  No plans found. Please create a plan in <strong>Subscription Plans</strong> first.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {plans.map(plan => (
                    <button
                      key={plan.id}
                      type="button"
                      onClick={() => setSelectedPlanId(plan.id)}
                      className={`text-left p-3 rounded-xl border-2 transition-all ${
                        selectedPlanId === plan.id
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                      }`}
                    >
                      <p className={`font-bold text-sm ${selectedPlanId === plan.id ? 'text-blue-700' : 'text-slate-800'}`}>
                        {plan.name}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Rs. {plan.price?.toLocaleString()} / {plan.billing_cycle || 'month'}
                      </p>
                    </button>
                  ))}
                </div>
              )}
              {selectedPlan && (
                <p className="text-xs text-blue-600 font-bold mt-2">
                  ✓ Selected: {selectedPlan.name} — Rs. {selectedPlan.price?.toLocaleString()}/{selectedPlan.billing_cycle || 'month'}
                </p>
              )}
            </div>

            {/* Business Domain / Store Type */}
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Store Type / Industry Vertical</label>
              <select
                value={businessType}
                onChange={e => setBusinessType(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-semibold text-slate-800"
              >
                {STORE_TYPES.map(st => (
                  <option key={st.id} value={st.id}>{st.name}</option>
                ))}
              </select>
              <p className="text-[10px] text-slate-400 mt-1">Configures default units, product placeholders, and pricing modes.</p>
            </div>

            {/* Shop Details */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800 mb-3 pb-2 border-b border-slate-100">
                <Store size={18} className="text-blue-500" /> Business Details
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Shop / Business Name *</label>
                  <input required type="text" value={shopName} onChange={e => setShopName(e.target.value)}
                    placeholder="e.g. Al-Madina Super Mart"
                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">WhatsApp Phone *</label>
                    <input required type="text" value={phone} onChange={e => setPhone(e.target.value)}
                      placeholder="03001234567"
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">City / Address</label>
                    <input type="text" value={address} onChange={e => setAddress(e.target.value)}
                      placeholder="e.g. Lahore"
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
                  </div>
                </div>
              </div>
            </div>

            {/* Owner Account Details */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800 mb-3 pb-2 border-b border-slate-100">
                <User size={18} className="text-purple-500" /> Owner Login Credentials
              </h3>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Owner Email *</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-2.5 text-slate-400" size={16} />
                      <input required type="email" value={ownerEmail}
                        onChange={e => {
                          setOwnerEmail(e.target.value)
                          if (!ownerUsername) setOwnerUsername(e.target.value.split('@')[0])
                        }}
                        placeholder="owner@gmail.com"
                        className="w-full pl-10 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Login Username *</label>
                    <input required type="text" value={ownerUsername} onChange={e => setOwnerUsername(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono"
                      placeholder="e.g. madina_admin" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Password *</label>
                  <div className="relative">
                    <Key className="absolute left-3 top-2.5 text-slate-400" size={16} />
                    <input required type="text" value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)}
                      placeholder="Enter a secure password (e.g. Shop@123)"
                      className="w-full pl-10 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono" />
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">This password will be securely stored and readable for Superadmin support.</p>
                </div>
              </div>
            </div>

            <div className="pt-2 flex gap-3">
              <button type="button" onClick={onClose} disabled={loading}
                className="flex-1 py-2.5 border border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition">
                Cancel
              </button>
              <button type="submit" disabled={loading || !selectedPlanId || plans.length === 0}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-xl shadow-lg shadow-blue-500/30 transition disabled:opacity-50">
                {loading ? 'Provisioning Shop...' : 'Initialize Tenant'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
