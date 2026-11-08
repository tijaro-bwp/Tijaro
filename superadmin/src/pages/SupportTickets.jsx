import { useEffect, useState, Fragment } from 'react'
import { supabaseAdmin } from '../services/supabase'

function SupportTickets() {
    const [tickets, setTickets] = useState([])
    const [loading, setLoading] = useState(true)
    const [replyDraft, setReplyDraft] = useState({})   // { [ticketId]: string }
    const [expandedReply, setExpandedReply] = useState(null) // ticketId with open reply box

    useEffect(() => {
        fetchTickets()
    }, [])

    const fetchTickets = async () => {
        try {
            const { data, error } = await supabaseAdmin
                .from('support_tickets')
                .select('*, shops(name)')
                .order('created_at', { ascending: false })

            if (error) throw error
            setTickets(data || [])
        } catch (err) {
            console.error('Fetch tickets error:', err)
        } finally {
            setLoading(false)
        }
    }

    const updateStatusAndReply = async (id, status, reply) => {
        try {
            const payload = { status }
            if (reply !== undefined) payload.admin_reply = reply || null
            const { error } = await supabaseAdmin
                .from('support_tickets')
                .update(payload)
                .eq('id', id)

            if (error) throw error
            setExpandedReply(null)
            fetchTickets()
        } catch (err) {
            alert('Failed to update ticket: ' + err.message)
        }
    }

    const openReplyBox = (id, existingReply) => {
        setExpandedReply(id)
        setReplyDraft(prev => ({ ...prev, [id]: existingReply || '' }))
    }

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-black text-slate-800">🆘 Support Tickets</h1>
                    <p className="text-slate-500">Manage help requests from shops</p>
                </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden overflow-x-auto">
                <table className="w-full text-left min-w-[640px]">
                    <thead className="bg-slate-50 border-b">
                        <tr>
                            <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase">Shop</th>
                            <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase">Issue</th>
                            <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase">Status</th>
                            <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {loading ? (
                            <tr><td colSpan="4" className="px-6 py-10 text-center text-slate-400">Loading tickets...</td></tr>
                        ) : tickets.length === 0 ? (
                            <tr><td colSpan="4" className="px-6 py-10 text-center text-slate-400 font-medium">No tickets found. Good job! ✅</td></tr>
                        ) : tickets.map(t => (
                            <Fragment key={t.id}>
                                <tr className={`hover:bg-slate-50 transition ${t.status === 'in_progress' ? 'bg-blue-50/40' : ''}`}>
                                    <td className="px-6 py-4">
                                        <p className="font-bold text-slate-800">{t.shops?.name}</p>
                                        <p className="text-[10px] text-slate-400 font-mono italic">{new Date(t.created_at).toLocaleString()}</p>
                                    </td>
                                    <td className="px-6 py-4">
                                        <p className="font-bold text-slate-700">{t.subject}</p>
                                        <p className="text-xs text-slate-500 max-w-md line-clamp-2">{t.message}</p>
                                        {t.admin_reply && (
                                            <p className="text-xs text-blue-600 mt-1 italic">
                                                💬 Reply: <span className="line-clamp-1">{t.admin_reply}</span>
                                            </p>
                                        )}
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest ${
                                            t.status === 'open' ? 'bg-red-100 text-red-600' :
                                            t.status === 'in_progress' ? 'bg-blue-100 text-blue-600' :
                                            'bg-green-100 text-green-600'
                                        }`}>
                                            {t.status.replace('_', ' ')}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-right space-x-2">
                                        {t.status === 'open' && (
                                            <button
                                                onClick={() => openReplyBox(t.id, t.admin_reply)}
                                                className="px-2 py-1 bg-blue-50 text-blue-600 rounded text-[10px] font-bold uppercase hover:bg-blue-600 hover:text-white transition"
                                            >
                                                Start Work
                                            </button>
                                        )}
                                        {t.status === 'in_progress' && (
                                            <button
                                                onClick={() => openReplyBox(t.id, t.admin_reply)}
                                                className="px-2 py-1 bg-blue-50 text-blue-600 rounded text-[10px] font-bold uppercase hover:bg-blue-600 hover:text-white transition"
                                            >
                                                ✏️ Edit Reply
                                            </button>
                                        )}
                                        {t.status !== 'closed' && (
                                            <button
                                                onClick={() => updateStatusAndReply(t.id, 'closed', t.admin_reply)}
                                                className="px-2 py-1 bg-green-50 text-green-600 rounded text-[10px] font-bold uppercase hover:bg-green-600 hover:text-white transition"
                                            >
                                                Close
                                            </button>
                                        )}
                                    </td>
                                </tr>
                                {expandedReply === t.id && (
                                    <tr className="bg-blue-50 border-t border-blue-100">
                                        <td colSpan="4" className="px-6 py-4">
                                            <div className="flex flex-col gap-2 max-w-2xl">
                                                <p className="text-xs font-bold text-blue-700 uppercase tracking-wider">
                                                    💬 Reply to shop owner (optional — visible to them in Help & Support)
                                                </p>
                                                <textarea
                                                    rows={2}
                                                    value={replyDraft[t.id] || ''}
                                                    onChange={e => setReplyDraft(prev => ({ ...prev, [t.id]: e.target.value }))}
                                                    className="w-full border border-blue-200 bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 outline-none resize-none"
                                                    placeholder="e.g. We are looking into this. Please check your internet connection settings..."
                                                />
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={() => updateStatusAndReply(t.id, 'in_progress', replyDraft[t.id])}
                                                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold transition"
                                                    >
                                                        ✅ {t.status === 'open' ? 'Start Work + Send Reply' : 'Update Reply'}
                                                    </button>
                                                    <button
                                                        onClick={() => updateStatusAndReply(t.id, 'closed', replyDraft[t.id])}
                                                        className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-bold transition"
                                                    >
                                                        ✅ Close + Send Reply
                                                    </button>
                                                    <button
                                                        onClick={() => setExpandedReply(null)}
                                                        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-medium transition"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

export default SupportTickets
