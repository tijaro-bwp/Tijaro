// Pakistani Online Payment Methods and Providers Configuration

export const PAKISTANI_PAYMENT_PROVIDERS = [
  { id: 'jazzcash', name: 'JazzCash', category: 'wallet', icon: '📱', color: 'bg-red-50 text-red-700 border-red-200' },
  { id: 'easypaisa', name: 'Easypaisa', category: 'wallet', icon: '🟢', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { id: 'sadapay', name: 'SadaPay', category: 'wallet', icon: '💳', color: 'bg-teal-50 text-teal-700 border-teal-200' },
  { id: 'nayapay', name: 'NayaPay', category: 'wallet', icon: '🟣', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  { id: 'meezan', name: 'Meezan Bank', category: 'bank', icon: '🏦', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  { id: 'hbl', name: 'HBL (Habib Bank)', category: 'bank', icon: '🏦', color: 'bg-green-50 text-green-700 border-green-200' },
  { id: 'ubl', name: 'UBL (United Bank)', category: 'bank', icon: '🏦', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  { id: 'mcb', name: 'MCB Bank', category: 'bank', icon: '🏦', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { id: 'abl', name: 'Allied Bank (ABL)', category: 'bank', icon: '🏦', color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  { id: 'alfalah', name: 'Bank Alfalah', category: 'bank', icon: '🏦', color: 'bg-rose-50 text-rose-700 border-rose-200' },
  { id: 'faysal', name: 'Faysal Bank', category: 'bank', icon: '🏦', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  { id: 'bop', name: 'Bank of Punjab (BOP)', category: 'bank', icon: '🏦', color: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  { id: 'askari', name: 'Askari Bank', category: 'bank', icon: '🏦', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { id: 'other_bank', name: 'Other Bank / Raast', category: 'bank', icon: '🏛️', color: 'bg-gray-50 text-gray-700 border-gray-200' },
]

export const ALL_PAYMENT_TYPES = [
  { id: 'cash', label: 'Cash', icon: '💵' },
  { id: 'online', label: 'Online / Bank', icon: '📱' },
  { id: 'credit', label: 'Credit', icon: '📒' },
  { id: 'split', label: 'Split', icon: '🔀' },
]

export function getProviderInfo(providerId) {
  return PAKISTANI_PAYMENT_PROVIDERS.find(p => p.id === providerId) || null
}

export function formatPaymentLabel(paymentType, provider, ref) {
  if (!paymentType) return 'Cash'
  const pt = paymentType.toLowerCase()

  if (pt === 'cash') return 'Cash'
  if (pt === 'credit') return 'Credit'
  if (pt === 'split') return 'Split Payment'
  if (pt === 'quotation') return 'Quotation'

  // If specific provider like 'jazzcash' or 'easypaisa' was stored as payment_type
  const prov = getProviderInfo(provider || pt)
  if (prov) {
    return ref ? `${prov.name} (Ref: ${ref})` : prov.name
  }

  if (pt === 'online' || pt === 'bank') {
    return ref ? `Online Bank (Ref: ${ref})` : 'Online / Bank'
  }

  return paymentType.toUpperCase()
}
