import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { db } from '../services/db'

function CustomerLedgerOverview() {
    const { user } = useAuth()
    const [customers, setCustomers] = useState([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')

    useEffect(() => {
        if (user?.shop_id) fetchCustomers()
    }, [user?.shop_id])

    const fetchCustomers = async () => {
        setLoading(true)
        try {
            if (!navigator.onLine) throw new Error('Offline')
            const { data, error } = await supabase
                .from('customers')
                .select('id, name, phone, address, outstanding_balance, created_at')
                .eq('shop_id', user.shop_id)
                .order('outstanding_balance', { ascending: false })

            if (error) throw error
            setCustomers(data || [])
        } catch (e) {
            try {
                const local = await db.customers.toArray()
                const shopCustomers = local
                    .filter(c => String(c.shop_id) === String(user.shop_id))
                    .sort((a, b) => (b.outstanding_balance || 0) - (a.outstanding_balance || 0))
                setCustomers(shopCustomers)
            } catch (_) { setCustomers([]) }
        } finally {
            setLoading(false)
        }
    }

    const filtered = customers.filter(c =>
        (c.name || '').toLowerCase().includes(search.toLowerCase()) ||
        (c.phone || '').includes(search)
    )

    const totalReceivable = customers.reduce((sum, c) => sum + (c.outstanding_balance || 0), 0)
    const customersWithBalance = customers.filter(c => (c.outstanding_balance || 0) > 0)

    if (loading) return <div className="p-8 text-center text-fg-muted">Loading customer ledger...</div>

    return (
        <div>
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-fg">📒 Customer Ledger</h1>
                    <p className="text-fg-muted text-sm mt-1">Accounts receivable overview — all customer balances</p>
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <div className="bg-surface rounded-xl shadow-sm border border-line-subtle p-4">
                    <p className="text-xs text-fg-muted uppercase tracking-wider font-semibold">Total Receivable</p>
                    <p className={`text-2xl font-bold ${totalReceivable > 0 ? 'text-danger-fg' : 'text-success-fg'}`}>
                        Rs. {totalReceivable.toLocaleString()}
                    </p>
                </div>
                <div className="bg-surface rounded-xl shadow-sm border border-line-subtle p-4">
                    <p className="text-xs text-fg-muted uppercase tracking-wider font-semibold">Customers with Dues</p>
                    <p className="text-2xl font-bold text-warning-fg">{customersWithBalance.length}</p>
                </div>
                <div className="bg-surface rounded-xl shadow-sm border border-line-subtle p-4">
                    <p className="text-xs text-fg-muted uppercase tracking-wider font-semibold">Total Customers</p>
                    <p className="text-2xl font-bold text-primary-fg">{customers.length}</p>
                </div>
            </div>

            {/* Search */}
            <div className="mb-4">
                <input
                    type="text"
                    placeholder="Search by name or phone..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full sm:w-80 px-4 py-2.5 border border-line-strong rounded-xl focus:ring-2 focus:ring-primary outline-none"
                />
            </div>

            {/* Customer List */}
            <div className="bg-surface rounded-2xl shadow-xl overflow-hidden border border-line-subtle">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-surface-2 border-b">
                            <tr>
                                <th className="px-4 sm:px-6 py-4 text-left font-semibold text-fg-3">Customer</th>
                                <th className="px-4 sm:px-6 py-4 text-left font-semibold text-fg-3 hidden sm:table-cell">Phone</th>
                                <th className="px-4 sm:px-6 py-4 text-right font-semibold text-fg-3">Balance</th>
                                <th className="px-4 sm:px-6 py-4 text-center font-semibold text-fg-3">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-line-subtle">
                            {filtered.length === 0 && (
                                <tr>
                                    <td colSpan="4" className="px-6 py-12 text-center text-fg-subtle">
                                        {search ? 'No customers match your search.' : 'No customers found.'}
                                    </td>
                                </tr>
                            )}
                            {filtered.map(c => (
                                <tr key={c.id} className="hover:bg-surface-2 transition">
                                    <td className="px-4 sm:px-6 py-4">
                                        <div className="font-medium text-fg">{c.name}</div>
                                        <div className="text-xs text-fg-subtle sm:hidden">{c.phone || '-'}</div>
                                    </td>
                                    <td className="px-4 sm:px-6 py-4 text-fg-muted hidden sm:table-cell">{c.phone || '-'}</td>
                                    <td className="px-4 sm:px-6 py-4 text-right">
                                        <span className={`font-bold ${(c.outstanding_balance || 0) > 0 ? 'text-danger-fg' : 'text-success-fg'}`}>
                                            Rs. {(c.outstanding_balance || 0).toLocaleString()}
                                        </span>
                                    </td>
                                    <td className="px-4 sm:px-6 py-4 text-center">
                                        <Link
                                            to={`/customers/${c.id}`}
                                            className="px-3 py-1.5 bg-primary-soft text-primary-fg hover:bg-primary-muted rounded-lg text-xs font-bold transition"
                                        >
                                            View Ledger →
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}

export default CustomerLedgerOverview
