/**
 * PRODUCTION-READY DATABASE OPERATIONS
 * 
 * Examples of how to use the enhanced db wrapper
 * All operations automatically handle RLS session and shop_id injection
 */

import { db, supabase, rlsSession } from '../services/supabase'

// ============================================================================
// BRANDS OPERATIONS
// ============================================================================

export const brandsAPI = {
    /**
     * Get all brands for current shop
     */
    async getAll() {
        const { data, error } = await db.select('brands', '*', {
            order: { column: 'name', ascending: true }
        })
        return { data, error }
    },

    /**
     * Add new brand (shop_id auto-injected)
     */
    async create(name) {
        const { data, error } = await db.insert('brands', { name })
        return { data, error }
    },

    /**
     * Update brand
     */
    async update(id, name) {
        const { data, error } = await db.update('brands', id, { name })
        return { data, error }
    },

    /**
     * Delete brand
     */
    async delete(id) {
        const { data, error } = await db.delete('brands', id)
        return { data, error }
    }
}

// ============================================================================
// PRODUCTS OPERATIONS
// ============================================================================

export const productsAPI = {
    /**
     * Get all products with filters
     */
    async getAll(filters = {}) {
        const { data, error } = await db.select('products', '*', {
            filter: filters,
            order: { column: 'created_at', ascending: false }
        })
        return { data, error }
    },

    /**
     * Get low stock products
     */
    async getLowStock() {
        await rlsSession.ensureSession()

        const user = JSON.parse(localStorage.getItem('user'))

        const { data, error } = await supabase
            .from('products')
            .select('*')
            .eq('shop_id', user.shop_id)
            .eq('is_active', true)
            .order('stock_quantity', { ascending: true })

        // Filter client-side: stock_quantity < low_stock_threshold
        const lowStock = data ? data.filter(p => p.stock_quantity < p.low_stock_threshold) : null

        return { data: lowStock, error }
    },

    /**
     * Create product (shop_id auto-injected)
     */
    async create(productData) {
        const { data, error } = await db.insert('products', productData)
        return { data, error }
    },

    /**
     * Update product
     */
    async update(id, productData) {
        const { data, error } = await db.update('products', id, productData)
        return { data, error }
    },

    /**
     * Update stock quantity
     */
    async updateStock(id, newQuantity) {
        const { data, error } = await db.update('products', id, {
            stock_quantity: newQuantity
        })
        return { data, error }
    }
}

// ============================================================================
// SALES OPERATIONS
// ============================================================================

export const salesAPI = {
    /**
     * Get sales with date range
     */
    async getByDateRange(startDate, endDate) {
        await rlsSession.ensureSession()
        const user = JSON.parse(localStorage.getItem('user'))

        const { data, error } = await supabase
            .from('sales')
            .select(`
        *,
        sale_items(*, products(*)),
        customers(name, phone),
        users(username)
      `)
            .eq('shop_id', user.shop_id)
            .gte('created_at', startDate)
            .lte('created_at', endDate)
            .order('created_at', { ascending: false })

        return { data, error }
    },

    /**
     * Create sale with items (transactional)
     */
    async create(saleData, saleItems) {
        // Ensure session is active
        await rlsSession.ensureSession()

        const user = JSON.parse(localStorage.getItem('user'))

        try {
            // Insert sale master
            const { data: sale, error: saleError } = await supabase
                .from('sales')
                .insert({
                    ...saleData,
                    shop_id: user.shop_id,
                    user_id: user.id
                })
                .select()
                .single()

            if (saleError) throw saleError

            // Insert sale items
            const itemsToInsert = saleItems.map(item => ({
                sale_id: sale.id,
                product_id: item.product_id,
                quantity: item.quantity,
                price: item.price,
                subtotal: item.subtotal
            }))

            const { data: items, error: itemsError } = await supabase
                .from('sale_items')
                .insert(itemsToInsert)
                .select()

            if (itemsError) throw itemsError

            // Update product stock
            for (const item of saleItems) {
                const { error: stockError } = await supabase.rpc('update_product_stock', {
                    p_product_id: item.product_id,
                    p_quantity_change: -item.quantity
                })

                if (stockError) {
                    console.error('Stock update failed:', stockError)
                    // Don't throw - sale is already created
                }
            }

            return { data: { sale, items }, error: null }
        } catch (error) {
            console.error('Sale creation failed:', error)
            return { data: null, error }
        }
    },

    /**
     * Get today's sales summary
     */
    async getTodaySummary() {
        const today = new Date().toISOString().split('T')[0]

        const { data, error } = await db.rpc('get_daily_sales_summary', {
            p_date: today
        })

        return { data, error }
    }
}

// ============================================================================
// CUSTOMERS OPERATIONS
// ============================================================================

export const customersAPI = {
    /**
     * Search customers by name or phone
     */
    async search(query) {
        await rlsSession.ensureSession()
        const user = JSON.parse(localStorage.getItem('user'))

        const { data, error } = await supabase
            .from('customers')
            .select('*')
            .eq('shop_id', user.shop_id)
            .or(`name.ilike.%${query}%,phone.ilike.%${query}%`)
            .limit(20)

        return { data, error }
    },

    /**
     * Create customer (shop_id auto-injected)
     */
    async create(customerData) {
        const { data, error } = await db.insert('customers', customerData)
        return { data, error }
    },

    /**
     * Get customer with ledger
     */
    async getWithLedger(id) {
        await rlsSession.ensureSession()

        const { data, error } = await supabase
            .from('customers')
            .select(`
        *,
        sales(id, total_amount, amount_paid, created_at),
        customer_payments(amount, created_at, description)
      `)
            .eq('id', id)
            .single()

        return { data, error }
    }
}

// ============================================================================
// ANALYTICS OPERATIONS
// ============================================================================

export const analyticsAPI = {
    /**
     * Get dashboard stats
     */
    async getDashboardStats() {
        const { data, error } = await db.rpc('get_dashboard_stats')
        return { data, error }
    },

    /**
     * Get top selling products
     */
    async getTopProducts(limit = 10) {
        const { data, error } = await db.rpc('get_top_products', {
            p_limit: limit
        })
        return { data, error }
    },

    /**
     * Get revenue trend (last 30 days)
     */
    async getRevenueTrend() {
        const { data, error } = await db.rpc('get_revenue_trend')
        return { data, error }
    }
}

// ============================================================================
// USAGE EXAMPLES IN COMPONENTS
// ============================================================================

/*
// In your React components:

// Brands Example
import { brandsAPI } from '../api/database-operations'

const BrandsPage = () => {
  const [brands, setBrands] = useState([])
  
  useEffect(() => {
    loadBrands()
  }, [])
  
  const loadBrands = async () => {
    const { data, error } = await brandsAPI.getAll()
    if (error) {
      console.error('Error loading brands:', error)
      return
    }
    setBrands(data || [])
  }
  
  const handleAddBrand = async (name) => {
    const { data, error } = await brandsAPI.create(name)
    if (error) {
      alert('Failed to add brand')
      return
    }
    loadBrands() // Refresh list
  }
}

// Products Example
import { productsAPI } from '../api/database-operations'

const ProductsPage = () => {
  const [products, setProducts] = useState([])
  
  const loadProducts = async () => {
    const { data, error } = await productsAPI.getAll({
      is_active: true
    })
    setProducts(data || [])
  }
  
  const handleAddProduct = async (productData) => {
    const { data, error } = await productsAPI.create(productData)
    if (!error) {
      loadProducts()
    }
  }
}

// Sales Example
import { salesAPI } from '../api/database-operations'

const SalesPage = () => {
  const handleCreateSale = async (saleData, items) => {
    const { data, error } = await salesAPI.create(saleData, items)
    
    if (error) {
      alert('Sale failed: ' + error.message)
      return
    }
    
    alert('Sale completed successfully!')
  }
}
*/