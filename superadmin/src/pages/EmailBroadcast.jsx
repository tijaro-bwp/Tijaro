import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabaseAdmin } from '../services/supabase'
import { Send, Mail, Users, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react'
import { logAction } from '../services/auditService'
import { useAuth } from '../context/AuthContext'
import ReactQuill from 'react-quill-new'
import 'react-quill-new/dist/quill.snow.css'
import { FileText } from 'lucide-react'

export default function EmailBroadcast() {
    const [searchParams] = useSearchParams()
    const { user } = useAuth()
    const [shops, setShops] = useState([])
    const [dbTemplates, setDbTemplates] = useState([])
    const [loading, setLoading] = useState(true)
    const [targetAudience, setTargetAudience] = useState('ALL_ACTIVE')
    const [selectedShopId, setSelectedShopId] = useState('')

    const [subject, setSubject] = useState('')
    const [body, setBody] = useState('')
    const [isManagingTemplates, setIsManagingTemplates] = useState(false)
    const [templateName, setTemplateName] = useState('')
    const [sending, setSending] = useState(false)
    const [statusMsg, setStatusMsg] = useState({ text: '', type: '' })

    useEffect(() => {
        fetchInitialData()
    }, [])

    const fetchInitialData = async () => {
        setLoading(true)
        const [, templates] = await Promise.all([fetchShops(), fetchTemplates()])

        // Handle query params
        const qShopId = searchParams.get('shopId')
        if (qShopId) {
            setTargetAudience('SPECIFIC')
            setSelectedShopId(qShopId)

            // Auto-select a relevant template if possible
            const defaultTemplate = templates?.find(t => t.name.toLowerCase().includes('suspension') || t.name.toLowerCase().includes('overdue'))
            if (defaultTemplate) {
                setSubject(defaultTemplate.subject)
                setBody(defaultTemplate.body)
                setTemplateName(defaultTemplate.name)
            }
        }
        setLoading(false)
    }

    const fetchTemplates = async () => {
        if (!supabaseAdmin) return []
        try {
            const { data, error } = await supabaseAdmin.from('email_templates').select('*').order('name', { ascending: true })
            if (error) throw error
            const list = data || []
            setDbTemplates(list)
            return list
        } catch (err) {
            console.error('Failed to fetch templates:', err)
            return []
        }
    }

    const fetchShops = async () => {
        if (!supabaseAdmin) return setLoading(false)
        try {
            const { data, error } = await supabaseAdmin
                .from('shops')
                .select('id, name, email, status')
                .order('name', { ascending: true })

            if (error) throw error
            setShops(data)
        } catch (err) {
            console.error('Failed to fetch shops:', err)
        } finally {
            setLoading(false)
        }
    }

    const handleSend = async (e) => {
        e.preventDefault()
        if (!subject.trim() || !body.trim()) {
            setStatusMsg({ text: 'Subject and Body are required.', type: 'error' })
            return
        }

        // Determine recipients
        let recipients = []
        if (targetAudience === 'ALL_ACTIVE') {
            recipients = shops.filter(s => s.status === 'active' && s.email)
        } else if (targetAudience === 'ALL') {
            recipients = shops.filter(s => s.email)
        } else if (targetAudience === 'SPECIFIC') {
            const target = shops.find(s => s.id.toString() === selectedShopId)
            if (target && target.email) recipients = [target]
        }

        if (recipients.length === 0) {
            setStatusMsg({ text: 'No valid email recipients found for the selected audience.', type: 'error' })
            return
        }

        if (!confirm(`Are you sure you want to send this email to ${recipients.length} shop(s)?`)) return

        setSending(true)
        setStatusMsg({ text: 'Dispatching emails...', type: 'loading' })
        let successCount = 0
        let failCount = 0

        try {
            // Send individual emails via the local Express API
            for (const shop of recipients) {
                try {
                    const emailApiUrl = import.meta.env.VITE_EMAIL_API_URL || '/api/send-email'
                    const res = await fetch(emailApiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            to: shop.email,
                            subject: subject,
                            // Use HTML formatting
                            body: `
<div style="font-family: sans-serif; line-height: 1.5; color: #334155; padding: 20px;">
<h2 style="color: #4f46e5; margin-bottom: 16px;">Hello ${shop.name} Team,</h2>
<div style="font-size: 16px; margin-bottom: 20px;">${body}</div>
<hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
<p style="font-size: 14px; color: #64748b;">Best regards,<br /><strong>EdgeX POS Administration</strong></p>
</div>
                            `.trim()
                        })
                    })

                    if (!res.ok) {
                        const errorData = await res.json()
                        const detail = errorData.error?.message || errorData.details || 'API Server Error'
                        throw new Error(`Failed to send to ${shop.email}: ${detail}`)
                    }
                    successCount++
                } catch (err) {
                    console.error(`Failed to send to ${shop.email}:`, err)
                    failCount++
                }
            }

            setStatusMsg({
                text: `Broadcast attempted for ${recipients.length} shops. Success: ${successCount}, Failed: ${failCount}.`,
                type: failCount > 0 ? 'error' : 'success'
            })

            // Log the global broadcast action
            await logAction({
                actor_id: user?.id,
                actor_email: user?.email || user?.username,
                action_type: 'SEND_BROADCAST_EMAIL',
                target_type: 'MULTIPLE_SHOPS',
                target_id: targetAudience === 'SPECIFIC' ? selectedShopId.toString() : targetAudience,
                details: { targetAudience, successCount, failCount, subject, bodyPreview: body.substring(0, 50) + '...' }
            })

            // Reset form if entirely successful
            if (failCount === 0) {
                setSubject('')
                setBody('')
            }

        } catch {
            setStatusMsg({ text: 'Broadcast failed due to a severe error.', type: 'error' })
        } finally {
            setSending(false)
        }
    }

    const handleTemplateSelect = (e) => {
        const id = e.target.value
        const template = dbTemplates.find(t => t.id.toString() === id)
        if (template) {
            setSubject(template.subject)
            setBody(template.body)
            setTemplateName(template.name)
        }
    }

    const handleSaveTemplate = async () => {
        if (!templateName.trim() || !subject.trim() || !body.trim()) {
            alert('Please provide template name, subject and body.')
            return
        }

        try {
            const { error } = await supabaseAdmin
                .from('email_templates')
                .upsert({
                    name: templateName,
                    subject,
                    body,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'name' })

            if (error) throw error
            alert('Template saved successfully!')
            fetchTemplates()
            setIsManagingTemplates(false)
        } catch (err) {
            alert('Error saving template: ' + err.message)
        }
    }

    const handleDeleteTemplate = async (id) => {
        if (!confirm('Are you sure you want to delete this template?')) return
        try {
            const { error } = await supabaseAdmin.from('email_templates').delete().eq('id', id)
            if (error) throw error
            fetchTemplates()
        } catch (err) {
            alert('Error deleting template: ' + err.message)
        }
    }

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
                    <Mail className="text-purple-600" size={32} />
                    Email Broadcast
                </h1>
                <p className="text-slate-500 font-medium tracking-wide mt-1 text-sm">Send announcements, updates, and alerts directly to shop owners.</p>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden text-sm">
                <form onSubmit={handleSend} className="p-6 md:p-8 space-y-6">

                    {/* Target Audience */}
                    <div className="bg-slate-50 p-5 rounded-xl border border-slate-100 space-y-4">
                        <h3 className="font-bold text-slate-700 flex items-center gap-2">
                            <Users size={18} className="text-blue-500" /> Select Recipients
                        </h3>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <label className={`cursor-pointer border p-4 rounded-xl flex items-center justify-between transition-all ${targetAudience === 'ALL_ACTIVE' ? 'bg-blue-50 border-blue-500 ring-1 ring-blue-500' : 'bg-white border-slate-200 hover:border-blue-300'}`}>
                                <div className="flex items-center gap-2 font-bold text-slate-700">
                                    <input type="radio" value="ALL_ACTIVE" checked={targetAudience === 'ALL_ACTIVE'} onChange={() => setTargetAudience('ALL_ACTIVE')} className="text-blue-600 focus:ring-blue-500" />
                                    All Active Shops
                                </div>
                            </label>

                            <label className={`cursor-pointer border p-4 rounded-xl flex items-center justify-between transition-all ${targetAudience === 'ALL' ? 'bg-blue-50 border-blue-500 ring-1 ring-blue-500' : 'bg-white border-slate-200 hover:border-blue-300'}`}>
                                <div className="flex items-center gap-2 font-bold text-slate-700">
                                    <input type="radio" value="ALL" checked={targetAudience === 'ALL'} onChange={() => setTargetAudience('ALL')} className="text-blue-600 focus:ring-blue-500" />
                                    All Shops (Inc. Suspended)
                                </div>
                            </label>

                            <label className={`cursor-pointer border p-4 rounded-xl flex items-center justify-between transition-all ${targetAudience === 'SPECIFIC' ? 'bg-blue-50 border-blue-500 ring-1 ring-blue-500' : 'bg-white border-slate-200 hover:border-blue-300'}`}>
                                <div className="flex items-center gap-2 font-bold text-slate-700">
                                    <input type="radio" value="SPECIFIC" checked={targetAudience === 'SPECIFIC'} onChange={() => setTargetAudience('SPECIFIC')} className="text-blue-600 focus:ring-blue-500" />
                                    Specific Shop
                                </div>
                            </label>
                        </div>

                        {targetAudience === 'SPECIFIC' && (
                            <div className="mt-4 animate-in fade-in slide-in-from-top-2">
                                <select
                                    className="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    value={selectedShopId}
                                    onChange={(e) => setSelectedShopId(e.target.value)}
                                    required
                                >
                                    <option value="" disabled>-- Select a Shop --</option>
                                    {shops.map(shop => (
                                        <option key={shop.id} value={shop.id}>
                                            {shop.name} {shop.email ? `<${shop.email}>` : '(No Email - Will Fail)'}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>

                    {/* Email Content */}
                    <div className="space-y-4">
                        <div className="bg-purple-50 p-5 rounded-xl border border-purple-100 mb-2">
                            <div className="flex justify-between items-center mb-3">
                                <label className="block text-xs font-black text-purple-600 uppercase tracking-widest">Quick Templates</label>
                                <button
                                    type="button"
                                    onClick={() => setIsManagingTemplates(!isManagingTemplates)}
                                    className="text-[10px] font-bold text-purple-700 hover:bg-purple-200 bg-purple-100 px-2 py-1 rounded transition"
                                >
                                    {isManagingTemplates ? 'Exit Template Editor' : 'Manage / Save as Template'}
                                </button>
                            </div>

                            <div className="flex gap-3">
                                <select
                                    onChange={handleTemplateSelect}
                                    className="flex-1 px-4 py-2 bg-white border border-purple-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 font-bold text-slate-700"
                                >
                                    <option value="">-- Select a preset --</option>
                                    {dbTemplates.map(t => (
                                        <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                </select>
                            </div>

                            {isManagingTemplates && (
                                <div className="mt-4 p-5 bg-white rounded-xl border border-purple-200 space-y-4 animate-in slide-in-from-top-2 text-sm ring-4 ring-purple-50/50">
                                    <div className="flex items-center gap-2 mb-2 p-2 bg-purple-50 rounded-lg text-[10px] text-purple-700 font-bold uppercase tracking-tight">
                                        <AlertTriangle size={14} /> Correct templates will be updated if the name matches.
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-black text-slate-400 uppercase mb-1 tracking-widest">Preset Name / Save As</label>
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                value={templateName}
                                                onChange={e => setTemplateName(e.target.value)}
                                                placeholder="e.g. Monthly Billing Warning"
                                                className="flex-1 px-4 py-2 border border-slate-200 rounded-lg font-bold text-slate-700 bg-slate-50 focus:bg-white transition"
                                            />
                                            <button
                                                type="button"
                                                onClick={handleSaveTemplate}
                                                className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-black text-[10px] uppercase tracking-widest shadow-lg shadow-purple-500/20 active:scale-95 transition"
                                            >
                                                Update / Save
                                            </button>
                                        </div>
                                    </div>
                                    {dbTemplates.length > 0 && (
                                        <div className="border-t border-slate-100 pt-3">
                                            <label className="block text-[10px] font-black text-slate-400 uppercase mb-2 tracking-widest">Current Presets</label>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                {dbTemplates.map(t => (
                                                    <div key={t.id} className="flex justify-between items-center bg-slate-50 px-3 py-2 rounded-lg border border-slate-100 group transition-all hover:border-purple-200">
                                                        <span className="font-bold text-slate-600 text-xs truncate max-w-[150px]">{t.name}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleDeleteTemplate(t.id)}
                                                            className="text-slate-300 hover:text-red-500 font-bold transition-colors"
                                                            title="Delete Template"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Email Subject</label>
                            <input
                                type="text"
                                value={subject}
                                onChange={e => setSubject(e.target.value)}
                                className="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="e.g., Important Platform Update"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Email Message Body</label>
                            <div className="bg-white rounded-xl overflow-hidden border border-slate-200 focus-within:ring-2 focus-within:ring-blue-500">
                                <ReactQuill
                                    theme="snow"
                                    value={body}
                                    onChange={setBody}
                                    placeholder="Write your beautiful announcement here..."
                                    className="h-64 mb-12"
                                    modules={{
                                        toolbar: [
                                            [{ 'header': [1, 2, 3, false] }],
                                            ['bold', 'italic', 'underline', 'strike'],
                                            [{ 'color': [] }, { 'background': [] }],
                                            [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                                            ['link', 'clean']
                                        ],
                                    }}
                                />
                            </div>
                            <p className="text-[10px] text-slate-400 mt-2 italic">* The system will automatically add a professional header and footer to your message.</p>
                        </div>
                    </div>

                    {/* Status Message */}
                    {statusMsg.text && (
                        <div className={`p-4 rounded-xl flex items-center gap-2 font-bold ${statusMsg.type === 'error' ? 'bg-red-50 text-red-600' :
                            statusMsg.type === 'success' ? 'bg-emerald-50 text-emerald-600' :
                                'bg-blue-50 text-blue-600'
                            }`}>
                            {statusMsg.type === 'error' ? <AlertTriangle size={20} /> :
                                statusMsg.type === 'success' ? <CheckCircle2 size={20} /> :
                                    <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>}
                            {statusMsg.text}
                        </div>
                    )}

                    {/* Submit Button */}
                    <div className="pt-4 border-t border-slate-100 flex justify-end">
                        <button
                            type="submit"
                            disabled={sending || loading}
                            className="flex items-center gap-2 px-8 py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-xl shadow-lg shadow-purple-500/30 transition-all active:scale-95 disabled:opacity-50"
                        >
                            <Send size={18} />
                            {sending ? 'Dispatching Base...' : 'Send Broadcast Notification'}
                        </button>
                    </div>

                </form>
            </div>
        </div>
    )
}
