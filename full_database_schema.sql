-- FULL DATABASE SCHEMA FOR EDGEX POS PORTING

-- Note: Run this entire script in the Supabase SQL Editor of your new project.

-- 1. Shops (Tenants)
CREATE TABLE IF NOT EXISTS shops (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    email TEXT,
    status TEXT DEFAULT 'active',
    logo_url TEXT,
    notes TEXT,
    last_sign_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Users (Custom internal users, plain text auth structure)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password TEXT NOT NULL, -- SECURITY WARNING: In production, consider Supabase Auth or hashing
    role TEXT NOT NULL DEFAULT 'cashier',
    shop_id INTEGER REFERENCES shops(id),
    is_active BOOLEAN DEFAULT TRUE,
    permissions JSONB DEFAULT '[]'::jsonb,
    last_sign_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Categories
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    shop_id INTEGER REFERENCES shops(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Brands
CREATE TABLE IF NOT EXISTS brands (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    shop_id INTEGER REFERENCES shops(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Products
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    shop_id INTEGER REFERENCES shops(id),
    cost_price NUMERIC(15,2) DEFAULT 0,
    sale_price NUMERIC(15,2) DEFAULT 0,
    stock_quantity INTEGER DEFAULT 0,
    low_stock_threshold INTEGER DEFAULT 10,
    sku TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    balance NUMERIC(15,2) DEFAULT 0,
    shop_id INTEGER REFERENCES shops(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Customers
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    balance NUMERIC(15,2) DEFAULT 0,
    shop_id INTEGER REFERENCES shops(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Sales Master
CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    shop_id INTEGER REFERENCES shops(id),
    total_amount NUMERIC(15,2) DEFAULT 0,
    discount NUMERIC(15,2) DEFAULT 0,
    net_amount NUMERIC(15,2) DEFAULT 0,
    amount_paid NUMERIC(15,2) DEFAULT 0,
    payment_method TEXT DEFAULT 'cash',
    payment_details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Sale Items
CREATE TABLE IF NOT EXISTS sale_items (
    id SERIAL PRIMARY KEY,
    sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER NOT NULL,
    price NUMERIC(15,2) NOT NULL,
    subtotal NUMERIC(15,2) NOT NULL,
    returned_qty INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Purchases Master
CREATE TABLE IF NOT EXISTS purchases (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    shop_id INTEGER REFERENCES shops(id),
    total_amount NUMERIC(15,2) DEFAULT 0,
    discount NUMERIC(15,2) DEFAULT 0,
    net_amount NUMERIC(15,2) DEFAULT 0,
    amount_paid NUMERIC(15,2) DEFAULT 0,
    payment_method TEXT DEFAULT 'cash',
    remarks TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Purchase Items
CREATE TABLE IF NOT EXISTS purchase_items (
    id SERIAL PRIMARY KEY,
    purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER NOT NULL,
    cost_price NUMERIC(15,2) NOT NULL,
    subtotal NUMERIC(15,2) NOT NULL
);

-- 12. Expenses
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    amount NUMERIC(15,2) NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    user_id UUID REFERENCES users(id),
    shop_id INTEGER REFERENCES shops(id),
    date DATE DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Customer Payments (Ledger Receivables)
CREATE TABLE IF NOT EXISTS customer_payments (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    shop_id INTEGER REFERENCES shops(id),
    amount NUMERIC(15,2) NOT NULL,
    description TEXT,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Supplier Payments (Ledger Payables)
CREATE TABLE IF NOT EXISTS supplier_payments (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    shop_id INTEGER REFERENCES shops(id),
    amount NUMERIC(15,2) NOT NULL,
    description TEXT,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 15. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details JSONB,
    user_id UUID REFERENCES users(id),
    shop_id INTEGER REFERENCES shops(id),
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert Default Baseline Data (Optional but recommended)
INSERT INTO shops (name) VALUES ('EdgeX POS Store') ON CONFLICT DO NOTHING;
-- Note: Replace shop_id = 1 below if multiple shops exist
INSERT INTO users (username, password, role, shop_id, permissions) 
VALUES ('admin', '1234', 'admin', 1, '[]'::jsonb) 
ON CONFLICT (username) DO NOTHING;
