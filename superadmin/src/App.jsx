// RETIRED: this standalone superadmin portal used to put a privileged Supabase
// key in the browser bundle. All superadmin features now live in the main POS
// app under /admin, backed by the authenticated `admin-api` Edge Function
// (see docs/ADMIN_EDGE_FUNCTIONS.md). The old pages under src/pages,
// src/components and src/context are no longer imported or bundled.
const posUrl = (import.meta.env.VITE_POS_URL || '').replace(/\/$/, '')
const adminUrl = posUrl ? `${posUrl}/admin` : '/admin'

export default function App() {
  return (
    <main className="min-h-dvh flex items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 text-center">
        <h1 className="text-xl font-black text-slate-800 mb-2">Superadmin portal has moved</h1>
        <p className="text-sm text-slate-600 mb-6">
          Platform administration is now part of EdgeX POS. Sign in there with your superadmin account.
        </p>
        <a
          href={adminUrl}
          className="inline-flex items-center justify-center w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300"
        >
          Open EdgeX POS admin
        </a>
      </div>
    </main>
  )
}
