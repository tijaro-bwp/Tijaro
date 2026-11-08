import { useEffect, useState, useCallback } from 'react'
import { supabaseAdmin } from '../services/supabase'
import { useAuth } from '../context/AuthContext'
import { Download, DatabaseBackup, CheckCircle, AlertTriangle, Clock, RefreshCw, Search } from 'lucide-react'
import * as XLSX from 'xlsx'

// Tables to export per shop (in order)
const BACKUP_TABLES = [
  { name: 'shops',              label: 'Shop Info',          singleRow: true },
  { name: 'users',              label: 'Users' },
  { name: 'categories',         label: 'Categories' },
  { name: 'brands',             label: 'Brands' },
  { name: 'suppliers',          label: 'Suppliers' },
  { name: 'products',           label: 'Products' },
  { name: 'customers',          label: 'Customers' },
  { name: 'sales',              label: 'Sales' },
  { name: 'sale_items',         label: 'Sale Items',         joinTable: 'sales' },
  { name: 'purchases',          label: 'Purchases' },
  { name: 'purchase_items',     label: 'Purchase Items',     joinTable: 'purchases' },
  { name: 'customer_payments',  label: 'Customer Payments' },
  { name: 'expenses',           label: 'Expenses' },
]

function BackupStatusChip({ lastBackup }) {
  const [days] = useState(() => lastBackup ? Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86400000) : null)

  if (days === null) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
      <AlertTriangle size={9} /> Never
    </span>
  )
  if (days <= 3) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">
      <CheckCircle size={9} /> {days === 0 ? 'Today' : `${days}d ago`}
    </span>
  )
  if (days <= 7) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200">
      <Clock size={9} /> {days}d ago
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
      <AlertTriangle size={9} /> {days}d ago
    </span>
  )
}

export default function Backups() {
  const { user } = useAuth()
  const [shops, setShops] = useState([])
  const [backupMeta, setBackupMeta] = useState({}) // { shop_id: { backed_up_at, backup_rows } }
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [exporting, setExporting] = useState({}) // { shop_id: true/false }
  const [exportingAll, setExportingAll] = useState(false)
  const [error, setError] = useState('')

  const fetchData = useCallback(async () => {
    if (!supabaseAdmin) {
      setError('This legacy portal is retired. Use /admin in EdgeX POS.')
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [shopsRes, backupsRes] = await Promise.all([
        supabaseAdmin.from('shops').select('id, name, status, phone').order('name'),
        supabaseAdmin
          .from('shop_backups')
          .select('shop_id, backed_up_at, backup_rows')
          .order('backed_up_at', { ascending: false }),
      ])
      setShops(shopsRes.data || [])

      // Keep only most recent backup per shop
      const meta = {}
      ;(backupsRes.data || []).forEach(b => {
        if (!meta[b.shop_id]) meta[b.shop_id] = b
      })
      setBackupMeta(meta)
    } catch (err) {
      setError('Failed to load: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Core export function ──────────────────────────────────────────────────
  const exportShopBackup = async (shop) => {
    if (!supabaseAdmin) return
    setExporting(prev => ({ ...prev, [shop.id]: true }))
    try {
      const wb = XLSX.utils.book_new()
      let totalRows = 0

      for (const tbl of BACKUP_TABLES) {
        let data = []

        if (tbl.singleRow) {
          // Shop info — single row
          const { data: rows } = await supabaseAdmin
            .from(tbl.name).select('*').eq('id', shop.id).limit(1)
          data = rows || []
        } else if (tbl.joinTable) {
          // Tables joined via parent (e.g. sale_items via sales.shop_id)
          // Fetch parent IDs first
          const { data: parentRows } = await supabaseAdmin
            .from(tbl.joinTable).select('id').eq('shop_id', shop.id)
          const parentIds = (parentRows || []).map(r => r.id)
          if (parentIds.length > 0) {
            // Fetch in chunks of 500 to avoid URL length limits
            const chunks = []
            for (let i = 0; i < parentIds.length; i += 500) {
              const chunk = parentIds.slice(i, i + 500)
              const { data: rows } = await supabaseAdmin
                .from(tbl.name).select('*')
                .in(`${tbl.joinTable.slice(0, -1)}_id`, chunk) // sale_items.sale_id
              if (rows) chunks.push(...rows)
            }
            data = chunks
          }
        } else {
          // Standard: filter by shop_id
          let query = supabaseAdmin.from(tbl.name).select('*').eq('shop_id', shop.id)
          const { data: rows } = await query
          data = rows || []
        }

        totalRows += data.length
        const ws = XLSX.utils.json_to_sheet(data.length ? data : [{}])
        XLSX.utils.book_append_sheet(wb, ws, tbl.label.substring(0, 31))
      }

      // Write backup record
      await supabaseAdmin.from('shop_backups').insert([{
        shop_id: shop.id,
        backup_rows: totalRows,
        backed_up_by: user?.email || 'superadmin',
      }])

      // Download
      const filename = `${shop.name.replace(/\s+/g, '_')}_backup_${new Date().toISOString().split('T')[0]}.xlsx`
      XLSX.writeFile(wb, filename)

      // Refresh meta
      setBackupMeta(prev => ({
        ...prev,
        [shop.id]: { backed_up_at: new Date().toISOString(), backup_rows: totalRows }
      }))
    } catch (err) {
      alert(`Backup failed for ${shop.name}: ${err.message}`)
    } finally {
      setExporting(prev => ({ ...prev, [shop.id]: false }))
    }
  }

  const handleExportAll = async () => {
    if (!confirm(`This will export backups for ALL ${filtered.length} shops. This may take several minutes. Continue?`)) return
    setExportingAll(true)
    for (const shop of filtered) {
      await exportShopBackup(shop)
    }
    setExportingAll(false)
  }

  const filtered = shops.filter(s =>
    !search || s.name?.toLowerCase().includes(search.toLowerCase()) || String(s.phone || '').includes(search)
  )

  const overdueCnt = shops.filter(s => {
    const meta = backupMeta[s.id]
    if (!meta) return true
    return Math.floor((Date.now() - new Date(meta.backed_up_at)) / 86400000) > 7
  }).length

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="font-black text-slate-800 text-lg flex items-center gap-2">
            <DatabaseBackup size={20} className="text-blue-600" /> Shop Data Backups
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">Export full XLSX backups of any shop's data</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {overdueCnt > 0 && (
            <span className="text-xs font-bold bg-red-50 text-red-600 border border-red-200 px-3 py-1.5 rounded-lg flex items-center gap-1">
              <AlertTriangle size={13} /> {overdueCnt} shop{overdueCnt > 1 ? 's' : ''} overdue (&gt;7 days)
            </span>
          )}
          <button
            onClick={fetchData}
            className="p-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 transition"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={handleExportAll}
            disabled={exportingAll || filtered.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-bold rounded-xl text-sm transition shadow-lg shadow-blue-500/20 active:scale-95"
          >
            <Download size={16} />
            {exportingAll ? 'Exporting All…' : `Backup All (${filtered.length})`}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 border border-red-200 rounded-xl p-4 font-bold text-sm flex items-center gap-2">
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      {/* Search */}
      <div className="relative w-full sm:w-72">
        <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
        <input
          type="text"
          placeholder="Search shops…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
        />
      </div>

      {/* Table — Desktop */}
      <div className="hidden md:block bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500 font-black">
              <th className="p-4 pl-6">Shop</th>
              <th className="p-4">Last Backup</th>
              <th className="p-4">Status</th>
              <th className="p-4">Rows Exported</th>
              <th className="p-4 text-right pr-6">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan="5" className="p-8 text-center text-slate-400">Loading shops…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan="5" className="p-8 text-center text-slate-400">No shops found.</td></tr>
            ) : filtered.map(shop => {
              const meta = backupMeta[shop.id]
              const isExporting = exporting[shop.id]
              return (
                <tr key={shop.id} className="hover:bg-slate-50/50 transition">
                  <td className="p-4 pl-6">
                    <p className="font-bold text-slate-800">{shop.name}</p>
                    <p className="text-xs text-slate-400 font-mono">#{shop.id} · {shop.phone || 'No phone'}</p>
                  </td>
                  <td className="p-4 text-xs text-slate-600">
                    {meta ? new Date(meta.backed_up_at).toLocaleString('en-PK') : '—'}
                  </td>
                  <td className="p-4">
                    <BackupStatusChip lastBackup={meta?.backed_up_at} />
                  </td>
                  <td className="p-4 text-xs text-slate-500">
                    {meta?.backup_rows ? meta.backup_rows.toLocaleString() + ' rows' : '—'}
                  </td>
                  <td className="p-4 pr-6 text-right">
                    <button
                      onClick={() => exportShopBackup(shop)}
                      disabled={isExporting || exportingAll}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-bold rounded-lg text-xs transition active:scale-95"
                    >
                      <Download size={13} className={isExporting ? 'animate-bounce' : ''} />
                      {isExporting ? 'Exporting…' : 'Export XLSX'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-3">
        {loading ? (
          <div className="bg-white rounded-2xl p-6 text-center text-slate-400 border border-slate-200">Loading…</div>
        ) : filtered.map(shop => {
          const meta = backupMeta[shop.id]
          const isExporting = exporting[shop.id]
          return (
            <div key={shop.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-black text-slate-800">{shop.name}</p>
                  <p className="text-xs text-slate-400 font-mono">#{shop.id}</p>
                </div>
                <BackupStatusChip lastBackup={meta?.backed_up_at} />
              </div>
              <div className="text-xs text-slate-500 bg-slate-50 rounded-xl px-3 py-2 border border-slate-100">
                <span className="font-bold text-slate-600">Last backup: </span>
                {meta ? new Date(meta.backed_up_at).toLocaleString('en-PK') : 'Never'}
                {meta?.backup_rows && <span className="ml-2 text-slate-400">({meta.backup_rows.toLocaleString()} rows)</span>}
              </div>
              <button
                onClick={() => exportShopBackup(shop)}
                disabled={isExporting || exportingAll}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-bold rounded-xl text-sm transition active:scale-95"
              >
                <Download size={15} className={isExporting ? 'animate-bounce' : ''} />
                {isExporting ? 'Exporting…' : 'Export Full Backup'}
              </button>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-wrap gap-3 text-xs text-slate-500">
        <span className="font-bold text-slate-600">Backup includes:</span>
        {BACKUP_TABLES.map(t => (
          <span key={t.name} className="bg-white border border-slate-200 px-2 py-0.5 rounded-lg font-mono">{t.label}</span>
        ))}
      </div>
    </div>
  )
}
