import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { BRAND } from '../config/brand.js'

const STATUS_STEPS = ['open', 'in_progress', 'closed']
const STATUS_LABEL = { open: 'Submitted', in_progress: 'Working...', closed: 'Resolved' }
const STATUS_ICON  = { open: '📩', in_progress: '🔧', closed: '✅' }
const STATUS_BADGE = {
  open:        'bg-warning-muted text-warning-strong border-warning-line',
  in_progress: 'bg-primary-muted text-primary-strong border-primary-line',
  closed:      'bg-success-muted text-success-strong border-success-line',
}

function TicketTimeline({ status }) {
  const activeIdx = STATUS_STEPS.indexOf(status)
  return (
    <div className="flex items-center">
      {STATUS_STEPS.map((step, i) => {
        const done     = i <= activeIdx
        const isActive = i === activeIdx
        return (
          <div key={step} className="flex items-center flex-1">
            <div className="flex flex-col items-center">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all
                ${isActive && step !== 'closed'
                  ? 'bg-primary border-primary text-white scale-110 shadow-md shadow-primary-line'
                  : done
                    ? 'bg-success border-success text-white'
                    : 'bg-surface-3 border-line text-fg-faint'}`}>
                {done ? (isActive && step !== 'closed' ? '●' : '✓') : i + 1}
              </div>
              <span className={`text-[9px] mt-1 font-bold uppercase tracking-wide whitespace-nowrap
                ${isActive ? 'text-primary-fg' : done ? 'text-success-fg' : 'text-fg-faint'}`}>
                {STATUS_LABEL[step]}
              </span>
            </div>
            {i < STATUS_STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mb-4 mx-1 rounded ${i < activeIdx ? 'bg-success' : 'bg-surface-4'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function Support() {
  const { user } = useAuth()

  // Ticket list state
  const [tickets, setTickets]           = useState([])
  const [loadingTickets, setLoadingTickets] = useState(true)

  // Form state
  const [showForm, setShowForm]   = useState(false)
  const [subject, setSubject]     = useState('')
  const [message, setMessage]     = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted]   = useState(false)

  useEffect(() => {
    fetchMyTickets()
  }, [])

  const fetchMyTickets = async () => {
    setLoadingTickets(true)
    try {
      const { data, error } = await supabase
        .from('support_tickets')
        .select('*')
        .eq('shop_id', user.shop_id)
        .order('created_at', { ascending: false })
      if (error) throw error
      setTickets(data || [])
    } catch (err) {
      console.error('Fetch tickets error:', err)
    } finally {
      setLoadingTickets(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const { error } = await supabase.from('support_tickets').insert([{
        shop_id: user.shop_id,
        subject,
        message,
        status: 'open',
      }])
      if (error) throw error
      setSubmitted(true)
      setSubject('')
      setMessage('')
      fetchMyTickets()
    } catch (err) {
      alert('Failed to send ticket: ' + err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const openNewTicket = () => {
    setShowForm(true)
    setSubmitted(false)
  }

  const inProgressCount = tickets.filter(t => t.status === 'in_progress').length

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-fg">🆘 Help & Support</h1>
          <p className="text-fg-muted text-sm mt-0.5">Ticket submit karein ya apna status check karein.</p>
        </div>
        {!showForm && (
          <button
            onClick={openNewTicket}
            className="px-5 py-2 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl text-sm shadow-lg shadow-primary-muted transition whitespace-nowrap"
          >
            + New Ticket
          </button>
        )}
      </div>

      {/* In-progress alert banner */}
      {inProgressCount > 0 && !showForm && (
        <div className="bg-primary text-white rounded-2xl p-4 flex items-center gap-3 shadow-lg shadow-primary-line">
          <span className="text-2xl animate-bounce">🔧</span>
          <div>
            <p className="font-bold">
              {inProgressCount} ticket{inProgressCount > 1 ? 's' : ''} par kaam ho raha hai!
            </p>
            <p className="text-white/80 text-xs mt-0.5">
              Hamari team neeche active ticket{inProgressCount > 1 ? 's' : ''} par kaam kar rahi hai. Jald hal hoga.
            </p>
          </div>
        </div>
      )}

      {/* New Ticket Form */}
      {showForm && (
        <div className="bg-surface p-6 rounded-2xl shadow-sm border border-line-subtle">
          {submitted ? (
            <div className="text-center py-6">
              <div className="text-5xl mb-3">✅</div>
              <h2 className="text-xl font-bold text-success-strong mb-1">Ticket Submit Ho Gaya!</h2>
              <p className="text-success-fg text-sm mb-6">Hamari team jald hi kaam shuru karegi. Neeche apna status track kar saktay hain.</p>
              <button
                onClick={() => { setSubmitted(false); setShowForm(false) }}
                className="px-6 py-2 bg-success text-white rounded-xl font-bold text-sm"
              >
                OK, Dekhein Tickets ↓
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-bold text-fg">New Support Ticket</h2>
                <button type="button" onClick={() => setShowForm(false)} className="text-fg-subtle hover:text-fg-3 text-sm">✕ Cancel</button>
              </div>
              <div>
                <label className="block text-sm font-bold text-fg-2 mb-1">Unwan (Subject) *</label>
                <input
                  type="text"
                  required
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  placeholder="e.g. Printer connection issue"
                  className="w-full px-4 py-3 border border-line rounded-xl focus:ring-2 focus:ring-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-fg-2 mb-1">Message *</label>
                <textarea
                  required
                  rows="4"
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="Apni mushkil tafseel se bayan karein..."
                  className="w-full px-4 py-3 border border-line rounded-xl focus:ring-2 focus:ring-primary outline-none resize-none"
                />
              </div>
              <div className="bg-primary-soft p-3 rounded-xl border border-primary-muted flex items-center gap-3">
                <span className="text-lg">📞</span>
                <div>
                  <p className="text-[10px] font-bold text-primary-strong uppercase tracking-wider">Urgent Support?</p>
                  <p className="text-primary-fg font-bold text-sm">{BRAND.supportName}: {BRAND.supportPhone}</p>
                </div>
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full py-3 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl shadow-lg shadow-primary-muted transition disabled:opacity-50"
              >
                {submitting ? 'Bheja ja raha hai...' : 'Ticket Submit Karein'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Tickets List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-fg">
            📋 Meri Tickets
            {tickets.length > 0 && (
              <span className="ml-2 px-2 py-0.5 bg-surface-3 text-fg-muted rounded-full text-xs font-bold">{tickets.length}</span>
            )}
          </h2>
          <button onClick={fetchMyTickets} className="text-xs text-primary-fg hover:text-primary-strong font-bold">⟳ Refresh</button>
        </div>

        {loadingTickets ? (
          <div className="text-center text-fg-subtle py-10">
            <div className="text-3xl mb-2 animate-pulse">🔄</div>
            <p>Tickets load ho rahi hain...</p>
          </div>
        ) : tickets.length === 0 ? (
          <div className="bg-surface rounded-2xl border border-line-subtle p-10 text-center shadow-sm">
            <div className="text-4xl mb-3">🎉</div>
            <p className="font-bold text-fg-2">Koi ticket nahi hai!</p>
            <p className="text-fg-subtle text-sm mt-1">Koi masla ho to upar "+ New Ticket" press karein.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {tickets.map(t => (
              <div
                key={t.id}
                className={`bg-surface rounded-2xl border shadow-sm p-5 transition
                  ${t.status === 'in_progress' ? 'border-primary-edge ring-2 ring-primary-muted' :
                    t.status === 'closed'       ? 'border-success-line opacity-80' :
                                                  'border-line-subtle'}`}
              >
                {/* Ticket header */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-fg leading-tight">{t.subject}</p>
                    <p className="text-[11px] text-fg-subtle mt-0.5 font-mono">
                      #{String(t.id).slice(-6).toUpperCase()} · {new Date(t.created_at).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' })}
                    </p>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-[11px] font-bold border flex-shrink-0 ${STATUS_BADGE[t.status]}`}>
                    {STATUS_ICON[t.status]} {STATUS_LABEL[t.status]}
                  </span>
                </div>

                {/* Original message */}
                <p className="text-sm text-fg-3 bg-surface-2 rounded-xl px-4 py-3 mb-4 line-clamp-2 italic">
                  "{t.message}"
                </p>

                {/* Status timeline */}
                <TicketTimeline status={t.status} />

                {/* Status-specific banners */}
                {t.status === 'in_progress' && (
                  <div className="mt-4 bg-primary-soft border border-primary-muted rounded-xl px-4 py-3 flex items-start gap-3">
                    <span className="text-xl animate-pulse mt-0.5">🔧</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-primary-strong text-sm font-bold">Hamari team kaam kar rahi hai!</p>
                      <p className="text-primary-fg text-xs mt-0.5">Is ticket par actively kaam ho raha hai. Thodi dair mein hal ho jayega.</p>
                      {t.admin_reply && (
                        <div className="mt-2 bg-surface border border-primary-line rounded-lg px-3 py-2">
                          <p className="text-[10px] font-bold text-primary-fg uppercase tracking-wider mb-1">💬 Support Team:</p>
                          <p className="text-sm text-fg-2">{t.admin_reply}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {t.status === 'closed' && (
                  <div className="mt-4 bg-success-soft border border-success-muted rounded-xl px-4 py-3 flex items-start gap-3">
                    <span className="text-xl mt-0.5">✅</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-success-strong text-sm font-bold">Ticket hal ho gaya!</p>
                      <p className="text-success-fg text-xs mt-0.5">Agar masla dobara aaye to naya ticket submit karein.</p>
                      {t.admin_reply && (
                        <div className="mt-2 bg-surface border border-success-line rounded-lg px-3 py-2">
                          <p className="text-[10px] font-bold text-success-fg uppercase tracking-wider mb-1">💬 Support Team:</p>
                          <p className="text-sm text-fg-2">{t.admin_reply}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {t.status === 'open' && (
                  <div className="mt-4 bg-warning-soft border border-warning-muted rounded-xl px-4 py-3 flex items-center gap-3">
                    <span className="text-xl">⏳</span>
                    <div>
                      <p className="text-warning-strong text-sm font-bold">Queue mein hai</p>
                      <p className="text-warning-fg text-xs mt-0.5">Hamari team ne ticket receive kar li hai. Jald kaam shuru hoga.</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Contact card (bottom) */}
      {!showForm && (
        <div className="bg-gradient-to-r from-primary to-primary-hover text-white rounded-2xl p-5 flex items-center gap-4 shadow-lg shadow-primary-line">
          <span className="text-3xl">📞</span>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-white/80">Urgent / Direct Support</p>
            <p className="text-lg font-black">{BRAND.supportName}: {BRAND.supportPhone}</p>
            <p className="text-white/80 text-xs mt-0.5">Zabardast mushkil ho to seedha call karein.</p>
          </div>
        </div>
      )}

    </div>
  )
}

export default Support
