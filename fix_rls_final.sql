-- ============================================================================
-- FIX RLS POLICIES WITH SECURE SESSION FUNCTION (EdgeX Digital POS)
-- Run this script in the Supabase SQL Editor.
-- ============================================================================

-- 1. Create a robust session token helper function
-- This handles missing headers, invalid formats, and other database exceptions safely.
CREATE OR REPLACE FUNCTION current_session_token()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER  -- Bypasses RLS to query headers safely
SET search_path = public
AS $$
DECLARE
    v_headers TEXT;
    v_token_str TEXT;
BEGIN
    v_headers := current_setting('request.headers', true);
    IF v_headers IS NULL OR v_headers = '' THEN
        RETURN NULL;
    END IF;
    
    -- Extract token string safely from json headers
    v_token_str := v_headers::jsonb->>'x-session-token';
    IF v_token_str IS NULL OR v_token_str !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;
    
    RETURN v_token_str::uuid;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION current_session_token() TO anon, authenticated, public;

-- 2. Enable RLS on all tables (if not already enabled)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
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

-- 3. Define RLS Policy for sessions table itself
-- This is critical! Without it, subqueries on sessions inside other policies evaluate to 0 rows.
DROP POLICY IF EXISTS "Sessions Access" ON sessions;
CREATE POLICY "Sessions Access" ON sessions
AS PERMISSIVE FOR ALL TO public
USING (token = current_session_token())
WITH CHECK (true);

-- 4. Define RLS Policies for all tenant-scoped tables
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
        EXECUTE format('CREATE POLICY "Tenant Isolation" ON %I AS PERMISSIVE FOR ALL TO public USING (
            EXISTS (
                SELECT 1 FROM sessions s
                WHERE s.token = current_session_token()
                  AND s.shop_id = %I.shop_id
                  AND s.expires_at > NOW()
            )
        ) WITH CHECK (
            EXISTS (
                SELECT 1 FROM sessions s
                WHERE s.token = current_session_token()
                  AND s.shop_id = %I.shop_id
                  AND s.expires_at > NOW()
            )
        )', t, t, t);
    END LOOP;
END $$;

-- 5. Child table RLS policies (isolated via parent records)
DROP POLICY IF EXISTS "Sale Items Isolation" ON sale_items;
CREATE POLICY "Sale Items Isolation" ON sale_items
AS PERMISSIVE FOR ALL TO public
USING (
    EXISTS (
        SELECT 1 FROM sales s
        JOIN sessions sess ON sess.shop_id = s.shop_id
        WHERE s.id = sale_id
          AND sess.token = current_session_token()
          AND sess.expires_at > NOW()
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM sales s
        JOIN sessions sess ON sess.shop_id = s.shop_id
        WHERE s.id = sale_id
          AND sess.token = current_session_token()
          AND sess.expires_at > NOW()
    )
);

DROP POLICY IF EXISTS "Purchase Items Isolation" ON purchase_items;
CREATE POLICY "Purchase Items Isolation" ON purchase_items
AS PERMISSIVE FOR ALL TO public
USING (
    EXISTS (
        SELECT 1 FROM purchases p
        JOIN sessions sess ON sess.shop_id = p.shop_id
        WHERE p.id = purchase_id
          AND sess.token = current_session_token()
          AND sess.expires_at > NOW()
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM purchases p
        JOIN sessions sess ON sess.shop_id = p.shop_id
        WHERE p.id = purchase_id
          AND sess.token = current_session_token()
          AND sess.expires_at > NOW()
    )
);

-- 6. Shop access policy
DROP POLICY IF EXISTS "Shop Self Access" ON shops;
CREATE POLICY "Shop Self Access" ON shops
AS PERMISSIVE FOR ALL TO public
USING (
    EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.token = current_session_token()
          AND s.shop_id = id
          AND s.expires_at > NOW()
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.token = current_session_token()
          AND s.shop_id = id
          AND s.expires_at > NOW()
    )
);
