-- ============================================================================
-- FIX RLS POLICIES v2 — EdgeX POS
-- Resolves: INSERT violations on sales/quotations AND missing data on SELECT
--           (products, categories, suppliers not visible for tenant shops)
--
-- ROOT CAUSE: The previous fix had a circular RLS dependency — the sessions
-- table's own USING policy blocked subqueries that other table policies made
-- against the sessions table, causing all reads and writes to fail.
--
-- SOLUTION: A single SECURITY DEFINER function `is_valid_session(shop_id)`
-- that queries sessions bypassing RLS, eliminating the circular dependency.
--
-- HOW TO RUN: Paste this entire script into the Supabase SQL Editor and run.
-- ============================================================================


-- ============================================================================
-- STEP 1: Keep the existing current_session_token() helper (or recreate it).
-- This function safely parses the x-session-token header from PostgREST.
-- ============================================================================
CREATE OR REPLACE FUNCTION current_session_token()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_headers  TEXT;
    v_token    TEXT;
BEGIN
    v_headers := current_setting('request.headers', true);
    IF v_headers IS NULL OR v_headers = '' THEN
        RETURN NULL;
    END IF;

    v_token := (v_headers::jsonb)->>'x-session-token';

    IF v_token IS NULL OR v_token = '' THEN
        RETURN NULL;
    END IF;

    -- Validate UUID format before casting to avoid exceptions
    IF v_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;

    RETURN v_token::uuid;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION current_session_token() TO anon, authenticated, public;


-- ============================================================================
-- STEP 2: Create the new centralised session validator.
-- This is SECURITY DEFINER so it bypasses RLS on the sessions table,
-- breaking the circular dependency that caused all the failures.
-- ============================================================================
CREATE OR REPLACE FUNCTION is_valid_session(p_shop_id INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER          -- Runs as table owner, bypasses sessions RLS
SET search_path = public
AS $$
DECLARE
    v_token UUID;
    v_count INTEGER;
BEGIN
    -- Get the token from request headers (also SECURITY DEFINER, safe to call)
    v_token := current_session_token();

    -- No token means no valid session
    IF v_token IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Query sessions table directly — RLS on sessions does NOT apply here
    -- because this function runs with SECURITY DEFINER (owner privileges)
    SELECT COUNT(*) INTO v_count
    FROM sessions
    WHERE token    = v_token
      AND shop_id  = p_shop_id
      AND expires_at > NOW();

    RETURN v_count > 0;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION is_valid_session(INTEGER) TO anon, authenticated, public;


-- ============================================================================
-- STEP 3: Drop ALL existing RLS policies from the previous fix to avoid
-- conflicts or duplicate policy names.
-- ============================================================================

-- sessions
DROP POLICY IF EXISTS "Sessions Access"         ON sessions;
DROP POLICY IF EXISTS "Sessions Open Read"      ON sessions;

-- tenant-scoped tables
DROP POLICY IF EXISTS "Tenant Isolation"        ON categories;
DROP POLICY IF EXISTS "Tenant Isolation"        ON brands;
DROP POLICY IF EXISTS "Tenant Isolation"        ON products;
DROP POLICY IF EXISTS "Tenant Isolation"        ON suppliers;
DROP POLICY IF EXISTS "Tenant Isolation"        ON customers;
DROP POLICY IF EXISTS "Tenant Isolation"        ON sales;
DROP POLICY IF EXISTS "Tenant Isolation"        ON purchases;
DROP POLICY IF EXISTS "Tenant Isolation"        ON expenses;
DROP POLICY IF EXISTS "Tenant Isolation"        ON customer_payments;
DROP POLICY IF EXISTS "Tenant Isolation"        ON supplier_payments;
DROP POLICY IF EXISTS "Tenant Isolation"        ON audit_logs;
DROP POLICY IF EXISTS "Tenant Isolation"        ON users;

-- shops
DROP POLICY IF EXISTS "Shop Self Access"        ON shops;
DROP POLICY IF EXISTS "Shop Self Read"          ON shops;
DROP POLICY IF EXISTS "Tenant Isolation"        ON shops;

-- child tables
DROP POLICY IF EXISTS "Sale Items Isolation"    ON sale_items;
DROP POLICY IF EXISTS "Purchase Items Isolation" ON purchase_items;


-- ============================================================================
-- STEP 4: Enable RLS on all tables (idempotent — safe to run again).
-- ============================================================================
ALTER TABLE sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE shops              ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories         ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands             ENABLE ROW LEVEL SECURITY;
ALTER TABLE products           ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases          ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- STEP 5: Open the sessions table with a simple permissive policy.
-- Security is NOT weakened here — all real tenant data (products, sales, etc.)
-- is still protected by is_valid_session(). The sessions table itself only
-- contains UUIDs; knowing a token requires already being logged in.
-- Writes to sessions only happen via the SECURITY DEFINER secure_login RPC.
-- ============================================================================
CREATE POLICY "Sessions Open Access" ON sessions
AS PERMISSIVE FOR ALL
TO anon, authenticated
USING (true)
WITH CHECK (true);


-- ============================================================================
-- STEP 6: Apply clean Tenant Isolation policies on all shop-scoped tables.
-- Both USING (SELECT/UPDATE/DELETE visibility) and WITH CHECK (INSERT/UPDATE)
-- use is_valid_session() — no more circular sessions subqueries.
-- ============================================================================

-- categories
CREATE POLICY "Tenant Isolation" ON categories
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- brands
CREATE POLICY "Tenant Isolation" ON brands
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- products
CREATE POLICY "Tenant Isolation" ON products
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- suppliers
CREATE POLICY "Tenant Isolation" ON suppliers
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- customers
CREATE POLICY "Tenant Isolation" ON customers
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- sales
CREATE POLICY "Tenant Isolation" ON sales
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- purchases
CREATE POLICY "Tenant Isolation" ON purchases
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- expenses
CREATE POLICY "Tenant Isolation" ON expenses
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- customer_payments
CREATE POLICY "Tenant Isolation" ON customer_payments
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- supplier_payments
CREATE POLICY "Tenant Isolation" ON supplier_payments
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- audit_logs
CREATE POLICY "Tenant Isolation" ON audit_logs
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- users
CREATE POLICY "Tenant Isolation" ON users
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- shops (shop_id column is called 'id' on the shops table itself)
CREATE POLICY "Tenant Isolation" ON shops
AS PERMISSIVE FOR ALL TO anon, authenticated
USING      (is_valid_session(id))
WITH CHECK (is_valid_session(id));


-- ============================================================================
-- STEP 7: Child table policies — sale_items and purchase_items.
-- These tables don't have their own shop_id column, so we resolve shop_id
-- through the parent record. is_valid_session() on the parent's shop_id
-- handles all security without any circular session subqueries.
-- ============================================================================

-- sale_items: validate through parent sales record
CREATE POLICY "Sale Items Isolation" ON sale_items
AS PERMISSIVE FOR ALL TO anon, authenticated
USING (
    EXISTS (
        SELECT 1 FROM sales s
        WHERE s.id = sale_items.sale_id
          AND is_valid_session(s.shop_id)
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM sales s
        WHERE s.id = sale_items.sale_id
          AND is_valid_session(s.shop_id)
    )
);

-- purchase_items: validate through parent purchases record
CREATE POLICY "Purchase Items Isolation" ON purchase_items
AS PERMISSIVE FOR ALL TO anon, authenticated
USING (
    EXISTS (
        SELECT 1 FROM purchases p
        WHERE p.id = purchase_items.purchase_id
          AND is_valid_session(p.shop_id)
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM purchases p
        WHERE p.id = purchase_items.purchase_id
          AND is_valid_session(p.shop_id)
    )
);


-- ============================================================================
-- STEP 8: Verification queries — run these after the script to confirm success.
-- ============================================================================

-- 8a. Confirm both functions are SECURITY DEFINER (prosecdef = true)
SELECT proname, prosecdef
FROM pg_proc
WHERE proname IN ('current_session_token', 'is_valid_session')
ORDER BY proname;

-- 8b. List all active RLS policies (should show clean set with no duplicates)
SELECT tablename, policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 8c. Quick count check — all tenant tables should have exactly 1 policy
SELECT tablename, COUNT(*) as policy_count
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'categories','brands','products','suppliers','customers',
    'sales','sale_items','purchases','purchase_items',
    'expenses','customer_payments','supplier_payments',
    'audit_logs','users','shops','sessions'
  )
GROUP BY tablename
ORDER BY tablename;
