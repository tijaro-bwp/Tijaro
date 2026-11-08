import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../services/supabase'
import { useEffect, useState, useRef } from 'react'
import { BRAND } from '../config/brand.js'

// In-memory timestamp to prevent spamming get_shop_status RPC on every page transition
let lastStatusCheckTime = 0
let cachedShopStatus = 'active'

function ProtectedRoute({ children, allowedRoles, requiredModule }) {
  const { user, logout } = useAuth()
  const [isSuspended, setIsSuspended] = useState(false)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true

    async function checkStatus() {
      // Superadmin or user without shop_id does not check shop suspension
      if (!user?.shop_id || (user.role === 'superadmin' && !user.isImpersonating)) {
        return
      }

      // Throttle: Only check RPC if at least 3 minutes have passed since the last check
      const now = Date.now()
      if (now - lastStatusCheckTime < 3 * 60 * 1000) {
        if (cachedShopStatus === 'suspended' && !user.isImpersonating) {
          setIsSuspended(true)
        }
        return
      }

      if (!navigator.onLine) return

      try {
        const { data, error } = await supabase
          .rpc('get_shop_status', { p_shop_id: user.shop_id })

        if (error) throw error

        lastStatusCheckTime = Date.now()
        cachedShopStatus = data

        if (isMountedRef.current) {
          if (!user.isImpersonating && data === 'suspended') {
            setIsSuspended(true)
          }
        }
      } catch (_) {
        // Fail open silently on network glitch so user is never blocked
      }
    }

    checkStatus()

    return () => {
      isMountedRef.current = false
    }
  }, [user])

  if (!user) return <Navigate to="/" replace />

  if (isSuspended) {
    alert('Aap ka account fee na-adaiyegy ki wajah se muattal (suspended) kar diya gaya hai. Baraye meharbani support se rabta karein: ' + BRAND.supportPhone)
    logout()
    return <Navigate to="/" replace />
  }

  // ── 1. Superadmin Route Enforcement ──
  const isSuperadminOnly = allowedRoles && allowedRoles.includes('superadmin') && !allowedRoles.includes('admin')
  if (isSuperadminOnly) {
    if (user.role !== 'superadmin') {
      return <Navigate to="/dashboard" replace />
    }
    return children
  }

  // ── 2. Superadmin accessing Shop Routes ──
  // If user is pure superadmin (not impersonating), redirect them to the Superadmin portal
  if (user.role === 'superadmin' && !user.isImpersonating) {
    return <Navigate to="/admin" replace />
  }

  // ── 3. Shop Admins & Impersonating Superadmins bypass module restrictions ──
  if (user.role === 'admin' || user.isImpersonating) return children

  // ── 4. Module & Role-Based Permissions for Staff (Cashier, Manager, Accountant) ──
  const hasLegacyRole = allowedRoles ? allowedRoles.includes(user.role) : true
  const hasPermission = user.permissions && Array.isArray(user.permissions) && requiredModule
    ? user.permissions.includes(requiredModule)
    : hasLegacyRole

  if (!hasPermission) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-4xl mb-3">🚫</p>
          <h2 className="text-xl font-bold text-fg-2">Access Denied</h2>
          <p className="text-fg-subtle mt-1">Aap ka is page tak access nahi hai.</p>
        </div>
      </div>
    )
  }

  return children
}

export default ProtectedRoute