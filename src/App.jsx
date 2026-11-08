import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import ProtectedRoute from './components/ProtectedRoute'
import PWAInstallPrompt from './components/PWAInstallPrompt'
import Layout from './components/Layout'

// Shop POS Pages
const Login = lazy(() => import('./pages/Login'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const POS = lazy(() => import('./pages/POS'))
const Products = lazy(() => import('./pages/Products'))
const AddProduct = lazy(() => import('./pages/AddProduct'))
const EditProduct = lazy(() => import('./pages/EditProduct'))
const MasterData = lazy(() => import('./pages/MasterData'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Purchases = lazy(() => import('./pages/Purchases'))
const Suppliers = lazy(() => import('./pages/Suppliers'))
const SupplierLedger = lazy(() => import('./pages/SupplierLedger'))
const Customers = lazy(() => import('./pages/Customers'))
const CustomerLedger = lazy(() => import('./pages/CustomerLedger'))
const CustomerLedgerOverview = lazy(() => import('./pages/CustomerLedgerOverview'))
const Sales = lazy(() => import('./pages/Sales'))
const Expenses = lazy(() => import('./pages/Expenses'))
const Users = lazy(() => import('./pages/Users'))
const Reports = lazy(() => import('./pages/Reports'))
const Settings = lazy(() => import('./pages/Settings'))
const PurchaseHistory = lazy(() => import('./pages/PurchaseHistory'))
const TrashBin = lazy(() => import('./pages/TrashBin'))
const Support = lazy(() => import('./pages/Support'))
const WhatsAppMessaging = lazy(() => import('./pages/WhatsAppMessaging'))

// Superadmin Portal
const AdminLayout = lazy(() => import('./components/admin/AdminLayout'))
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'))
const ShopsList = lazy(() => import('./pages/admin/ShopsList'))
const Subscriptions = lazy(() => import('./pages/admin/Subscriptions'))
const PlanManagement = lazy(() => import('./pages/admin/PlanManagement'))
const SupportTickets = lazy(() => import('./pages/admin/SupportTickets'))
const Analytics = lazy(() => import('./pages/admin/Analytics'))
const Backups = lazy(() => import('./pages/admin/Backups'))
const AuditLogs = lazy(() => import('./pages/admin/AuditLogs'))
const EmailBroadcast = lazy(() => import('./pages/admin/EmailBroadcast'))
const ResetPassword = lazy(() => import('./pages/admin/ResetPassword'))

function PageFallback() {
  return (
    <div className="flex h-dvh items-center justify-center bg-app">
      <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
    </div>
  )
}

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PWAInstallPrompt />
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Login />} />
            <Route path="/login" element={<Navigate to="/" replace />} />

            {/* ── Superadmin Platform Portal (Role: superadmin only) ── */}
            <Route
              path="/admin"
              element={
                <ProtectedRoute allowedRoles={['superadmin']}>
                  <AdminLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<AdminDashboard />} />
              <Route path="shops" element={<ShopsList />} />
              <Route path="subscriptions" element={<Subscriptions />} />
              <Route path="plans" element={<PlanManagement />} />
              <Route path="tickets" element={<SupportTickets />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="backups" element={<Backups />} />
              <Route path="audit-logs" element={<AuditLogs />} />
              <Route path="broadcast" element={<EmailBroadcast />} />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Route>
            <Route path="/admin/reset-password" element={<ResetPassword />} />

            {/* ── Shop Tenant Routes (Both admin & cashier/staff) ── */}
            <Route path="/dashboard" element={<ProtectedRoute><Layout><Dashboard /></Layout></ProtectedRoute>} />
            <Route path="/pos" element={<ProtectedRoute requiredModule="pos" allowedRoles={['admin', 'manager', 'cashier']}><Layout><POS /></Layout></ProtectedRoute>} />
            <Route path="/customers" element={<ProtectedRoute requiredModule="customers" allowedRoles={['admin', 'manager', 'cashier']}><Layout><Customers /></Layout></ProtectedRoute>} />
            <Route path="/customers/:id" element={<ProtectedRoute requiredModule="customers" allowedRoles={['admin', 'manager', 'cashier']}><Layout><CustomerLedger /></Layout></ProtectedRoute>} />
            <Route path="/customer-ledger" element={<ProtectedRoute requiredModule="customers" allowedRoles={['admin', 'manager', 'cashier']}><Layout><CustomerLedgerOverview /></Layout></ProtectedRoute>} />
            <Route path="/sales" element={<ProtectedRoute requiredModule="sales" allowedRoles={['admin', 'manager', 'accountant']}><Layout><Sales /></Layout></ProtectedRoute>} />

            {/* ── Shop Admin only ── */}
            <Route path="/products" element={<ProtectedRoute requiredModule="products" allowedRoles={['admin']}><Layout><Products /></Layout></ProtectedRoute>} />
            <Route path="/add-product" element={<ProtectedRoute requiredModule="products" allowedRoles={['admin']}><Layout><AddProduct /></Layout></ProtectedRoute>} />
            <Route path="/edit-product/:id" element={<ProtectedRoute requiredModule="products" allowedRoles={['admin']}><Layout><EditProduct /></Layout></ProtectedRoute>} />
            <Route path="/master-data" element={<ProtectedRoute requiredModule="categories" allowedRoles={['admin']}><Layout><MasterData /></Layout></ProtectedRoute>} />
            <Route path="/categories" element={<Navigate to="/master-data" replace />} />
            <Route path="/brands" element={<Navigate to="/master-data" replace />} />
            <Route path="/suppliers" element={<ProtectedRoute requiredModule="suppliers" allowedRoles={['admin']}><Layout><Suppliers /></Layout></ProtectedRoute>} />
            <Route path="/suppliers/:id" element={<ProtectedRoute requiredModule="suppliers" allowedRoles={['admin']}><Layout><SupplierLedger /></Layout></ProtectedRoute>} />
            <Route path="/purchases" element={<ProtectedRoute requiredModule="purchases" allowedRoles={['admin', 'manager']}><Layout><Purchases /></Layout></ProtectedRoute>} />
            <Route path="/purchase-history" element={<ProtectedRoute requiredModule="purchase-history" allowedRoles={['admin', 'manager', 'accountant']}><Layout><PurchaseHistory /></Layout></ProtectedRoute>} />
            <Route path="/expenses" element={<ProtectedRoute requiredModule="expenses" allowedRoles={['admin']}><Layout><Expenses /></Layout></ProtectedRoute>} />
            <Route path="/inventory" element={<ProtectedRoute requiredModule="inventory" allowedRoles={['admin']}><Layout><Inventory /></Layout></ProtectedRoute>} />
            <Route path="/reports" element={<ProtectedRoute requiredModule="reports" allowedRoles={['admin']}><Layout><Reports /></Layout></ProtectedRoute>} />
            <Route path="/users" element={<ProtectedRoute requiredModule="users" allowedRoles={['admin']}><Layout><Users /></Layout></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute requiredModule="settings" allowedRoles={['admin']}><Layout><Settings /></Layout></ProtectedRoute>} />
            <Route path="/trash" element={<ProtectedRoute requiredModule="trash" allowedRoles={['admin']}><Layout><TrashBin /></Layout></ProtectedRoute>} />
            <Route path="/whatsapp" element={<ProtectedRoute requiredModule="customers" allowedRoles={['admin', 'manager', 'cashier']}><Layout><WhatsAppMessaging /></Layout></ProtectedRoute>} />
            <Route path="/support" element={<ProtectedRoute requiredModule="support" allowedRoles={['admin', 'manager', 'cashier', 'accountant']}><Layout><Support /></Layout></ProtectedRoute>} />
          </Routes>
        </Suspense>
      </BrowserRouter>
      </ThemeProvider>
    </AuthProvider>
  )
}

export default App
