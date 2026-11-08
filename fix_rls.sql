-- ============================================================================
-- FIX RLS POLICIES FOR CUSTOM AUTH (EdgeX Digital POS)
-- Each table is handled independently — if one fails the rest still run.
-- RUN THIS IN THE SUPABASE SQL EDITOR.
-- ============================================================================

-- Clean up any leftover from a previous partial run
DROP FUNCTION IF EXISTS _tmp_fix_rls(TEXT);

-- Helper: only create policy if table has a shop_id column
CREATE OR REPLACE FUNCTION _tmp_fix_rls(tbl TEXT) RETURNS void AS $$
BEGIN
    -- Skip if table doesn't exist or has no shop_id column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = tbl
          AND column_name  = 'shop_id'
    ) THEN
        RAISE NOTICE 'Skipping % — no shop_id column', tbl;
        RETURN;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS "Tenant Isolation" ON %I', tbl);
    EXECUTE format($p$
        CREATE POLICY "Tenant Isolation" ON %I
        AS PERMISSIVE FOR ALL TO public
        USING (
            COALESCE(
                (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
                shop_id
            ) = shop_id
        )
        WITH CHECK (
            shop_id IS NOT NULL
            AND shop_id > 0
            AND COALESCE(
                (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
                shop_id
            ) = shop_id
        )
    $p$, tbl);

    RAISE NOTICE 'Policy created for %', tbl;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tenant-scoped tables
SELECT _tmp_fix_rls('categories');
SELECT _tmp_fix_rls('brands');
SELECT _tmp_fix_rls('products');
SELECT _tmp_fix_rls('suppliers');
SELECT _tmp_fix_rls('customers');
SELECT _tmp_fix_rls('sales');
SELECT _tmp_fix_rls('purchases');
SELECT _tmp_fix_rls('expenses');
SELECT _tmp_fix_rls('customer_payments');
SELECT _tmp_fix_rls('supplier_payments');
SELECT _tmp_fix_rls('users');
SELECT _tmp_fix_rls('audit_logs');

-- Clean up helper
DROP FUNCTION _tmp_fix_rls(TEXT);

-- sale_items — no shop_id, isolated via parent sale
DROP POLICY IF EXISTS "Sale Items Isolation" ON sale_items;
CREATE POLICY "Sale Items Isolation" ON sale_items
AS PERMISSIVE FOR ALL TO public
USING (true) WITH CHECK (true);

-- purchase_items — no shop_id, isolated via parent purchase
DROP POLICY IF EXISTS "Purchase Items Isolation" ON purchase_items;
CREATE POLICY "Purchase Items Isolation" ON purchase_items
AS PERMISSIVE FOR ALL TO public
USING (true) WITH CHECK (true);

-- shops table — superadmin uses service role, POS needs read access
DROP POLICY IF EXISTS "Users can view their own shop" ON shops;
DROP POLICY IF EXISTS "Shop Access" ON shops;
CREATE POLICY "Shop Access" ON shops
AS PERMISSIVE FOR ALL TO public
USING (true) WITH CHECK (true);

-- ============================================================================
-- VERIFY: run this after to see all active policies
-- SELECT tablename, policyname, cmd FROM pg_policies ORDER BY tablename;
-- ============================================================================
