import { useState, useEffect } from 'react'
import { X, Store, Mail, Phone, MapPin } from 'lucide-react'
import { adminDb } from '../../services/adminApi'
import { logAction } from '../../services/auditService'
import { useAuth } from '../../context/AuthContext'

export default function EditShopModal({ shop, onClose, onUpdated }) {
  const { user } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Form State
  const [shopName, setShopName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [planId, setPlanId] = useState('')
  const [allPlans, setAllPlans] = useState([])

  useEffect(() => {
    fetchPlans()
  }, [])

  const fetchPlans = async () => {
    try {
      const { data, error } = await adminDb.from('subscription_plans').select('id, name')
      if (error) throw error
      setAllPlans(data || [])
    } catch (err) {
      console.error('Failed to load plans:', err)
    }
  }

  useEffect(() => {
    if (shop) {
      setShopName(shop.name || '')
      setPhone(shop.phone || '')
      setAddress(shop.address || '')
      setEmail(shop.email || '')
      setNotes(shop.notes || '')
      setPlanId(shop.plan_id || '')
    }
  }, [shop])

  const handleSubmit = async (e) => {
    e.preventDefault()

    setError('')
    setLoading(true)

    try {
      const { error: updateError } = await adminDb
        .from('shops')
        .update({ name: shopName, phone, address, email, notes, plan_id: planId || null })
        .eq('id', shop.id)
      if (updateError) {
        if (updateError.message.includes("could not find the 'email' column")) {
          throw new Error("The 'email' column is missing from the 'shops' table. Please run this SQL in Supabase: ALTER TABLE shops ADD COLUMN email TEXT;")
        }
        throw new Error('Failed to update shop details: ' + updateError.message)
      }

      await logAction({
        actor_id: user?.id,
        actor_email: user?.email || user?.username,
        action_type: 'UPDATE_SHOP',
        target_type: 'SHOP',
        target_id: shop.id,
        details: { name: shopName, phone, address, email, notes }
      })

      onUpdated()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="flex justify-between items-center p-6 border-b border-slate-100 bg-slate-50">
          <div>
            <h2 className="text-xl font-bold text-slate-800">Edit Shop Details</h2>
            <p className="text-xs text-slate-500">Update contact info and notification email.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 bg-white p-2 rounded-xl shadow-sm border border-slate-200">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm font-medium border border-red-100">{error}</div>}

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Shop/Business Name</label>
              <div className="relative">
                <Store className="absolute left-3 top-2.5 text-slate-400" size={16} />
                <input required type="text" value={shopName} onChange={e => setShopName(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Notification Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 text-slate-400" size={16} />
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  placeholder="For expiry warnings & billing" />
              </div>
              <p className="text-[10px] text-slate-400 mt-1">This email receives the automated Resend warnings.</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Phone Number</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-2.5 text-slate-400" size={16} />
                  <input type="text" value={phone} onChange={e => setPhone(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">City/Address</label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-2.5 text-slate-400" size={16} />
                  <input type="text" value={address} onChange={e => setAddress(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Subscription Tier</label>
              <select
                value={planId}
                onChange={e => setPlanId(e.target.value)}
                className="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-bold text-slate-700"
              >
                <option value="">-- No Specific Plan --</option>
                {allPlans.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Internal Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm min-h-[80px]"
                placeholder="Add secret hints, terms, or historical notes (Only visible to Superadmins)"
              />
            </div>
          </div>

          <div className="pt-4 flex gap-3 border-t border-slate-100">
            <button type="button" onClick={onClose} disabled={loading}
              className="flex-1 py-2.5 border border-slate-200 text-slate-600 font-bold rounded-lg hover:bg-slate-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg shadow-lg shadow-blue-500/30 transition disabled:opacity-50">
              {loading ? 'Saving Changes...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
