import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { usePortal, Spinner, ErrorBox } from './portalUi'
import BillView from './BillView'

export default function PortalBill() {
  const { id } = useParams()
  const { slug, shop, call } = usePortal()
  const [bill, setBill] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    const { data, error: err } = await call('bill', { id: Number(id) })
    if (err) { if (err.code !== 'no_session') setError(err.message); return }
    setBill(data)
  }, [call, id])

  useEffect(() => { load() }, [load])

  const back = (
    <Link to={`/c/${slug}/bills`} className="inline-flex items-center gap-1.5 mb-4 text-sm font-semibold text-primary-fg print:hidden">
      <ArrowLeft size={16} aria-hidden="true" /> All bills
    </Link>
  )

  if (error) return <div>{back}<ErrorBox onRetry={load}>{error}</ErrorBox></div>
  if (!bill) return <div>{back}<Spinner /></div>

  return (
    <div>
      {back}
      <BillView bill={bill} shopName={shop?.name} />
      <button type="button" onClick={() => window.print()} className="btn btn-secondary w-full mt-4 print:hidden">
        <Printer size={16} aria-hidden="true" /> Print or save as PDF
      </button>
    </div>
  )
}
