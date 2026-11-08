import { getPlanName } from '../utils/featureGate'
import { BRAND } from '../config/brand.js'

const PLAN_ORDER = ['Trial', 'Basic', 'Gold', 'Unlimited']
const FEATURE_UNLOCK_PLAN = {
  brands:          'Basic',
  suppliers:       'Basic',
  purchases:       'Basic',
  customer_ledger: 'Basic',
  reports:         'Basic',
  data_export:     'Basic',
  offline_sync:    'Basic',
  expenses:        'Gold',
  supplier_ledger: 'Gold',
  trash_bin:       'Gold',
  bulk_import:     'Gold',
  audit_logs:      'Gold',
  advanced_reports:'Gold',
  whatsapp:        'Unlimited',
  api_access:      'Unlimited',
}

export default function UpgradeWall({ feature }) {
  const currentPlan = getPlanName()
  const requiredPlan = FEATURE_UNLOCK_PLAN[feature] || 'a higher plan'
  const currentIndex = PLAN_ORDER.indexOf(currentPlan)
  const requiredIndex = PLAN_ORDER.indexOf(requiredPlan)
  const plansToShow = currentIndex >= 0
    ? PLAN_ORDER.slice(currentIndex + 1, requiredIndex + 1)
    : [requiredPlan]

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-6">
      <div className="max-w-md w-full text-center">
        <div className="w-20 h-20 bg-surface-3 rounded-full flex items-center justify-center mx-auto mb-6">
          <span className="text-4xl">🔒</span>
        </div>
        <h2 className="text-2xl font-black text-fg mb-2">Feature Locked</h2>
        <p className="text-fg-muted mb-4">
          This feature is not available on the{' '}
          <span className="font-bold text-fg-2">{currentPlan}</span> plan.
        </p>
        {requiredPlan !== 'a higher plan' && (
          <div className="bg-primary-soft border border-primary-muted rounded-xl p-4 mb-6 text-left">
            <p className="text-xs font-black text-primary-fg uppercase tracking-widest mb-2">Unlocks in</p>
            <div className="flex gap-2 flex-wrap">
              {plansToShow.map(p => (
                <span key={p} className="px-3 py-1 bg-primary text-white text-sm font-bold rounded-full">
                  {p} Plan
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="bg-surface-2 rounded-xl p-4 border border-line-subtle">
          <p className="text-sm font-bold text-fg-3">Contact support to upgrade your plan</p>
          <p className="text-lg font-black text-fg mt-1">📞 {BRAND.supportPhone}</p>
        </div>
      </div>
    </div>
  )
}
