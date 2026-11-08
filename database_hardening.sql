-- SECURITY HARDENING: ROW LEVEL SECURITY (RLS) POLICIES
-- Run this in the Supabase SQL Editor to enforce tenant isolation.

-- 1. Enable RLS on all tables
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- 2. Define Policies
-- Note: These policies ensure each shop can ONLY see its own data.

DO $$ 
DECLARE 
    t TEXT;
    tables_to_harden TEXT[] := ARRAY[
        'categories', 'brands', 'products', 'suppliers', 
        'customers', 'sales', 'purchases', 'expenses', 
        'customer_payments', 'supplier_payments', 'audit_logs', 'users'
    ];
BEGIN 
    FOREACH t IN ARRAY tables_to_harden LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Tenant Isolation" ON %I', t);
        EXECUTE format('CREATE POLICY "Tenant Isolation" ON %I AS PERMISSIVE FOR ALL TO public USING (shop_id = (current_setting(''request.jwt.claims'', true)::jsonb->>''shop_id'')::integer)', t);
    END LOOP;
END $$;

-- 3. Sale Items & Purchase Items (Isolation via Parent Table)
CREATE POLICY "Sale Items Isolation" ON sale_items FOR ALL TO public USING (sale_id IN (SELECT id FROM sales));
CREATE POLICY "Purchase Items Isolation" ON purchase_items FOR ALL TO public USING (purchase_id IN (SELECT id FROM purchases));

-- 4. Shop Metadata
CREATE POLICY "Users can view their own shop" ON shops FOR SELECT USING (id = (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer);
