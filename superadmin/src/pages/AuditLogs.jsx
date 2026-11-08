import { useState, useEffect } from 'react'
import { supabaseAdmin } from '../services/supabase'
import { Search, Activity, CalendarClock, User, ShieldAlert } from 'lucide-react'

export default function AuditLogs() {
    const [logs, setLogs] = useState([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [filterType, setFilterType] = useState('ALL')

    useEffect(() => {
        fetchLogs()
    }, [])

    const fetchLogs = async () => {
        if (!supabaseAdmin) {
            setLoading(false)
            return
        }

        setLoading(true)
        try {
            const { data, error } = await supabaseAdmin
                .from('audit_logs')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(200)

            if (error) throw error
            setLogs(data)
        } catch (error) {
            console.error('Fetch error:', error)
        } finally {
            setLoading(false)
        }
    }

    const filteredLogs = logs.filter(log => {
        const matchesSearch =
            log.actor_email?.toLowerCase().includes(search.toLowerCase()) ||
            log.target_id?.toLowerCase().includes(search.toLowerCase()) ||
            log.action_type?.toLowerCase().includes(search.toLowerCase())

        if (filterType === 'ALL') return matchesSearch
        return log.action_type === filterType && matchesSearch
    })

    const getActionColor = (type) => {
        if (type.includes('SUSPEND')) return 'text-red-600 bg-red-50 border-red-200'
        if (type.includes('ACTIVATE')) return 'text-emerald-600 bg-emerald-50 border-emerald-200'
        if (type.includes('PAYMENT')) return 'text-blue-600 bg-blue-50 border-blue-200'
        return 'text-slate-600 bg-slate-50 border-slate-200'
    }

    const actionTypes = ['ALL', 'SUSPEND_SHOP', 'ACTIVATE_SHOP', 'RECORD_PAYMENT', 'REFUND_PAYMENT', 'UPDATE_SUBSCRIPTION_PLAN']

    return (
        <div className="space-y-6 max-w-7xl mx-auto">
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
                        <Activity className="text-blue-600" size={32} />
                        System Audit Logs
                    </h1>
                    <p className="text-slate-500 font-medium tracking-wide mt-1 text-sm">Monitor all critical Superadmin & System actions</p>
                </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-2.5 text-slate-400" size={20} />
                    <input
                        type="text"
                        placeholder="Search by Admin Email, Action, or Target ID..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                    />
                </div>
                <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    className="px-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm font-semibold text-slate-700"
                >
                    {actionTypes.map(type => Object.assign(<option key={type} value={type}>{type.replace(/_/g, ' ')}</option>))}
                </select>
                <button
                    onClick={fetchLogs}
                    className="px-4 py-2 font-bold text-blue-600 bg-blue-50 rounded-xl hover:bg-blue-100 transition"
                >
                    Refresh Log
                </button>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[700px]">
                    <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-xs uppercase tracking-wider text-slate-500 font-bold">
                            <th className="p-4 pl-6">Timestamp & Admin</th>
                            <th className="p-4">Action Taken</th>
                            <th className="p-4">Target Entity</th>
                            <th className="p-4">Context Details</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                        {loading ? (
                            <tr><td colSpan="4" className="p-8 text-center text-slate-400 font-bold">Loading audit trails...</td></tr>
                        ) : filteredLogs.length === 0 ? (
                            <tr><td colSpan="4" className="p-8 text-center text-slate-400">No logs match your search.</td></tr>
                        ) : (
                            filteredLogs.map(log => (
                                <tr key={log.id} className="hover:bg-slate-50/50 transition align-top">
                                    <td className="p-4 pl-6">
                                        <div className="flex items-start gap-3">
                                            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center shrink-0 mt-1">
                                                <User className="text-slate-400" size={16} />
                                            </div>
                                            <div>
                                                <p className="font-bold text-slate-800">{log.actor_email || 'System'}</p>
                                                <p className="text-[11px] text-slate-400 font-mono mt-0.5 flex items-center gap-1">
                                                    <CalendarClock size={12} />
                                                    {new Date(log.created_at).toLocaleString()}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="p-4 pt-5">
                                        <span className={`px-3 py-1 text-xs font-bold border rounded-lg uppercase tracking-wider ${getActionColor(log.action_type)}`}>
                                            {log.action_type.replace(/_/g, ' ')}
                                        </span>
                                    </td>
                                    <td className="p-4 pt-5">
                                        <div className="flex items-center gap-1.5 text-slate-600">
                                            <span className="font-bold text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-500">{log.target_type}</span>
                                            <span className="font-mono text-xs">{log.target_id || 'Global'}</span>
                                        </div>
                                    </td>
                                    <td className="p-4 text-xs font-mono text-slate-500 bg-slate-50/50">
                                        <div className="max-w-xs break-words whitespace-pre-wrap rounded">
                                            {log.details ? JSON.stringify(log.details, null, 2).replace(/[{}"]/g, '') : '-'}
                                        </div>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
