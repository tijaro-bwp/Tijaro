import { createContext, useContext, useState } from 'react'
import { supabaseAdmin } from '../services/supabase'
import { hashPassword } from '../utils/authUtils'

const AuthContext = createContext()

const SESSION_KEY = 'superadmin_session'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem(SESSION_KEY)
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  })
  const [loading] = useState(false)

  const login = async (email, password) => {
    if (!supabaseAdmin) {
      throw new Error('This legacy portal is retired. Use /admin in EdgeX POS.')
    }

    const hashed = await hashPassword(password)

    // Query the custom users table directly — no Supabase Auth required
    // ilike for case-insensitive email matching (e.g. Admin@X.com == admin@x.com)
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .ilike('email', email.trim())
      .eq('password', hashed)
      .eq('role', 'superadmin')
      .eq('is_active', true)
      .maybeSingle()

    if (error) throw new Error('Database error: ' + error.message)
    if (!data) throw new Error('Invalid email or password, or account is not a Superadmin.')

    const sessionUser = {
      id: data.id,
      email: data.email,
      username: data.username,
      role: data.role,
      shop_id: data.shop_id,
    }

    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionUser))
    setUser(sessionUser)
    return sessionUser
  }

  const logout = () => {
    localStorage.removeItem(SESSION_KEY)
    setUser(null)
  }

  const impersonate = (shopId, shopData) => {
    const impersonatedUser = {
      id: `impersonated-${shopId}`,
      username: `Superadmin (${shopData.name})`,
      role: 'admin',
      shop_id: shopId,
      isImpersonating: true
    }
    localStorage.setItem('originalUser', JSON.stringify(user))
    localStorage.setItem('user', JSON.stringify(impersonatedUser))
    localStorage.setItem('shop_name', shopData.name)
    if (shopData.logo_url) {
      localStorage.setItem('shop_logo', shopData.logo_url)
    } else {
      localStorage.removeItem('shop_logo')
    }
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, impersonate, loading }}>
      {!loading && children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext)
