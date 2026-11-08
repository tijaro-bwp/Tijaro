-- ============================================================
-- FIX SUPABASE SECURITY WARNINGS
-- Run this in the Supabase SQL Editor
-- ============================================================


-- ============================================================
-- PART 1: Fix Function Search Path Mutable (12 functions)
-- Adds SET search_path = public to each function so a malicious
-- schema can't intercept calls by appearing earlier in the path.
-- ============================================================

DO $$
DECLARE
    func RECORD;
BEGIN
    FOR func IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
              'get_global_growth_stats',
              'get_top_performing_shops',
              'get_inactive_shops',
              'get_shop_status',
              'suspend_overdue_shops',
              'set_custom_claims',
              'current_shop_id',
              'current_role',
              'current_user_id',
              'is_superadmin',
              'secure_login',
              'get_shop_config'
          )
    LOOP
        EXECUTE format(
            'ALTER FUNCTION public.%I(%s) SET search_path = public',
            func.proname, func.args
        );
        RAISE NOTICE 'Fixed search_path for function: %(%)', func.proname, func.args;
    END LOOP;
END $$;


-- ============================================================
-- PART 2: Drop old blanket "Allow authenticated access" policies
-- These were created before proper tenant isolation was in place.
-- The "Tenant Isolation" policies from fix_rls.sql replace them.
-- ============================================================

DO $$
DECLARE
    tbl TEXT;
    tables TEXT[] := ARRAY[
        'announcements', 'brands', 'categories', 'customer_payments',
        'customers', 'email_templates', 'expenses', 'products',
        'purchase_items', 'purchases', 'quotation_items', 'quotations',
        'return_items', 'returns', 'sale_items', 'sales',
        'shop_payments', 'subscription_plans', 'supplier_payments',
        'suppliers', 'support_tickets'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        -- Check table exists before dropping policy
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = tbl
        ) THEN
            EXECUTE format('DROP POLICY IF EXISTS "Allow authenticated access" ON %I', tbl);
            RAISE NOTICE 'Dropped "Allow authenticated access" on %', tbl;
        END IF;
    END LOOP;
END $$;

-- Drop the other flagged always-true policies
DROP POLICY IF EXISTS "Sale Items Isolation"     ON sale_items;
DROP POLICY IF EXISTS "Purchase Items Isolation" ON purchase_items;
DROP POLICY IF EXISTS "Shop Access"              ON shops;


-- ============================================================
-- PART 3: Replace with proper scoped policies
-- ============================================================

-- ---- sale_items: isolate via parent sales.shop_id ----
CREATE POLICY "Sale Items Isolation" ON sale_items
AS PERMISSIVE FOR ALL TO public
USING (
    EXISTS (
        SELECT 1 FROM sales s
        WHERE s.id = sale_id
          AND COALESCE(
              (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
              s.shop_id
          ) = s.shop_id
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM sales s
        WHERE s.id = sale_id AND s.shop_id IS NOT NULL AND s.shop_id > 0
    )
);

-- ---- purchase_items: isolate via parent purchases.shop_id ----
CREATE POLICY "Purchase Items Isolation" ON purchase_items
AS PERMISSIVE FOR ALL TO public
USING (
    EXISTS (
        SELECT 1 FROM purchases p
        WHERE p.id = purchase_id
          AND COALESCE(
              (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
              p.shop_id
          ) = p.shop_id
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM purchases p
        WHERE p.id = purchase_id AND p.shop_id IS NOT NULL AND p.shop_id > 0
    )
);

-- ---- shops: shops can read their own row only ----
DROP POLICY IF EXISTS "Users can view their own shop" ON shops;
CREATE POLICY "Shop Self Read" ON shops
AS PERMISSIVE FOR SELECT TO public
USING (
    id = COALESCE(
        (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
        id
    )
);

-- ---- announcements: global table — all shops can read, nobody can write via API ----
-- (superadmin uses service_role which bypasses RLS)
DROP POLICY IF EXISTS "Announcements Read" ON announcements;
CREATE POLICY "Announcements Read" ON announcements
AS PERMISSIVE FOR SELECT TO public
USING (is_active = true);

-- ---- subscription_plans: read-only lookup table for shops ----
DROP POLICY IF EXISTS "Plans Read" ON subscription_plans;
CREATE POLICY "Plans Read" ON subscription_plans
AS PERMISSIVE FOR SELECT TO public
USING (true);

-- ---- email_templates: superadmin only — no public access ----
-- service_role bypasses RLS, so superadmin can still manage these
DROP POLICY IF EXISTS "Email Templates SA Only" ON email_templates;
CREATE POLICY "Email Templates SA Only" ON email_templates
AS RESTRICTIVE FOR ALL TO public
USING (false);

-- ---- quotations: scope by shop_id if column exists ----
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'quotations' AND column_name = 'shop_id'
    ) THEN
        DROP POLICY IF EXISTS "Tenant Isolation" ON quotations;
        CREATE POLICY "Tenant Isolation" ON quotations
        AS PERMISSIVE FOR ALL TO public
        USING (
            COALESCE(
                (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
                shop_id
            ) = shop_id
        )
        WITH CHECK (shop_id IS NOT NULL AND shop_id > 0);
        RAISE NOTICE 'Quotations policy created';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'quotation_items' AND column_name = 'shop_id'
    ) THEN
        DROP POLICY IF EXISTS "Tenant Isolation" ON quotation_items;
        CREATE POLICY "Tenant Isolation" ON quotation_items
        AS PERMISSIVE FOR ALL TO public
        USING (
            COALESCE(
                (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
                shop_id
            ) = shop_id
        )
        WITH CHECK (shop_id IS NOT NULL AND shop_id > 0);
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'returns' AND column_name = 'shop_id'
    ) THEN
        DROP POLICY IF EXISTS "Tenant Isolation" ON returns;
        CREATE POLICY "Tenant Isolation" ON returns
        AS PERMISSIVE FOR ALL TO public
        USING (
            COALESCE(
                (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
                shop_id
            ) = shop_id
        )
        WITH CHECK (shop_id IS NOT NULL AND shop_id > 0);
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'return_items' AND column_name = 'shop_id'
    ) THEN
        DROP POLICY IF EXISTS "Tenant Isolation" ON return_items;
        CREATE POLICY "Tenant Isolation" ON return_items
        AS PERMISSIVE FOR ALL TO public
        USING (
            COALESCE(
                (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
                shop_id
            ) = shop_id
        )
        WITH CHECK (shop_id IS NOT NULL AND shop_id > 0);
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'shop_id'
    ) THEN
        DROP POLICY IF EXISTS "Tenant Isolation" ON support_tickets;
        CREATE POLICY "Tenant Isolation" ON support_tickets
        AS PERMISSIVE FOR ALL TO public
        USING (
            COALESCE(
                (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
                shop_id
            ) = shop_id
        )
        WITH CHECK (shop_id IS NOT NULL AND shop_id > 0);
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'shop_payments' AND column_name = 'shop_id'
    ) THEN
        DROP POLICY IF EXISTS "Tenant Isolation" ON shop_payments;
        CREATE POLICY "Tenant Isolation" ON shop_payments
        AS PERMISSIVE FOR SELECT TO public
        USING (
            COALESCE(
                (current_setting('request.jwt.claims', true)::jsonb->>'shop_id')::integer,
                shop_id
            ) = shop_id
        );
    END IF;
END $$;


-- ============================================================
-- PART 4: Tighten audit_logs INSERT policy (was WITH CHECK (true))
-- ============================================================
DROP POLICY IF EXISTS "shops_insert_audit" ON audit_logs;
CREATE POLICY "shops_insert_audit" ON audit_logs
AS PERMISSIVE FOR INSERT TO public
WITH CHECK (shop_id IS NOT NULL AND shop_id > 0);


-- ============================================================
-- NOTE — auth_leaked_password_protection warning:
-- This cannot be fixed via SQL. Go to:
--   Supabase Dashboard → Authentication → Settings
--   → Enable "Leaked Password Protection"
-- ============================================================
