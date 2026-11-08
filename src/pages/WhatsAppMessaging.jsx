import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { db } from '../services/db'
import { Link } from 'react-router-dom'
import { hasFeature } from '../utils/featureGate'
import UpgradeWall from '../components/UpgradeWall'

function WhatsAppMessaging() {
  const { user } = useAuth()
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [shop, setShop] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      // Fetch Shop Settings (for templates)
      const { data: shopData } = await supabase.from('shops').select('*').eq('id', user.shop_id).maybeSingle()
      setShop(shopData)
      if (shopData) await db.shops.put(shopData)

      // Fetch Customers with outstanding balance
      const { data: custData, error } = await supabase
        .from('customers')
        .select('*')
        .eq('shop_id', user.shop_id)
        .gt('outstanding_balance', 0)
        .order('outstanding_balance', { ascending: false })

      if (error) throw error
      setCustomers(custData || [])
    } catch (err) {
      console.error('WhatsApp Logic Error:', err)
      // Fallback to local DB
      const localCustomers = await db.customers
        .where('shop_id').equals(user.shop_id)
        .filter(c => c.outstanding_balance > 0)
        .toArray()
      setCustomers(localCustomers.sort((a,b) => b.outstanding_balance - a.outstanding_balance))
      
      const localShop = await db.shops.get(user.shop_id)
      setShop(localShop)
    } finally {
      setLoading(false)
    }
  }

  const getWhatsAppLink = (customer) => {
    const phone = customer.phone?.replace(/[^0-9]/g, '')
    if (!phone) return null

    // Format: 923001234567 (Pakistan code if missing)
    let formattedPhone = phone
    if (phone.startsWith('03')) formattedPhone = '92' + phone.substring(1)
    else if (phone.length === 10) formattedPhone = '92' + phone

    const template = shop?.wa_reminder_template || "Hello [Name], this is a reminder from [Shop Name] regarding your outstanding balance of Rs. [Amount]. Please clear your dues at your earliest convenience. Thank you!"
    
    const message = template
      .replace(/\[Name\]/g, customer.name)
      .replace(/\[Amount\]/g, customer.outstanding_balance.toLocaleString())
      .replace(/\[Shop Name\]/g, shop?.name || 'our shop')

    return `https://wa.me/${formattedPhone}?text=${encodeURIComponent(message)}`
  }

  const filteredCustomers = customers.filter(c => 
    c.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    (c.phone || '').includes(searchTerm)
  )

  if (!hasFeature('whatsapp')) return <UpgradeWall feature="whatsapp" />
  if (loading) return <div className="p-8">Loading debt list...</div>

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-fg">📲 WhatsApp Reminders</h1>
          <p className="text-sm text-fg-muted">Send debt reminders to customers with outstanding balances.</p>
        </div>
        <Link to="/settings" className="px-4 py-2 bg-surface border border-line rounded-xl text-xs font-bold text-fg-3 hover:bg-surface-2 transition shadow-sm">
          ⚙️ Edit Templates
        </Link>
      </div>

      <div className="bg-surface rounded-2xl shadow-sm border border-line-subtle overflow-hidden">
        <div className="p-4 bg-surface-2 border-b">
          <input 
            type="text" 
            placeholder="Search by name or phone..."
            className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-primary outline-none text-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface text-fg-subtle text-[10px] font-black uppercase tracking-widest border-b">
                <th className="px-6 py-4">Customer</th>
                <th className="px-6 py-4 text-right">Balance</th>
                <th className="px-6 py-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {filteredCustomers.length === 0 ? (
                <tr>
                  <td colSpan="3" className="px-6 py-10 text-center text-fg-subtle italic text-sm">
                    No customers found with outstanding balance.
                  </td>
                </tr>
              ) : (
                filteredCustomers.map(customer => {
                  const waLink = getWhatsAppLink(customer)
                  return (
                    <tr key={customer.id} className="hover:bg-primary-soft/30 transition group">
                      <td className="px-6 py-4">
                        <div className="font-bold text-fg text-sm">{customer.name}</div>
                        <div className="text-[10px] text-fg-subtle font-medium">{customer.phone || 'No Phone'}</div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="font-black text-danger-fg">Rs. {customer.outstanding_balance?.toLocaleString()}</div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {waLink ? (
                          <a 
                            href={waLink} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-success hover:bg-success-hover text-white rounded-xl text-xs font-black transition shadow-lg shadow-success-muted uppercase"
                          >
                            <span>💬</span>
                            <span>Send Reminder</span>
                          </a>
                        ) : (
                          <span className="text-[10px] text-warning-fg font-bold uppercase py-2 block">Missing Phone</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="p-4 bg-primary-soft border border-primary-muted rounded-2xl flex items-start gap-4">
        <span className="text-xl">💡</span>
        <div>
          <p className="text-xs text-primary-strong font-bold">Pro-Tip: Keeping it Free</p>
          <p className="text-[10px] text-primary-fg leading-relaxed mt-1">
            We use the official WhatsApp Link system which is free. When you click "Send Reminder", it will open WhatsApp Web or the App with the message ready. You just need to press <b>Enter</b> to send it!
          </p>
        </div>
      </div>
    </div>
  )
}

export default WhatsAppMessaging
