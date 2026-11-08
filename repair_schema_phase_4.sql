-- MASTER SCHEMA REPAIR: PHASE 4 FIXES
-- Run this in the Supabase SQL Editor if you see "Could not find column" or "Relationship" errors.

-- 1. Ensure the 'notes' column exists in 'shops'
-- This was a missing piece from Phase 3.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS notes TEXT;

-- 2. Ensure the 'email' column exists in 'shops' (for notifications)
ALTER TABLE shops ADD COLUMN IF NOT EXISTS email TEXT;

-- 3. Ensure the 'plan_id' column exists and is correctly linked
-- If it already exists, this might fail to add the FK, so we do it safely.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS plan_id INTEGER;

-- 4. Explicitly add the foreign key relationship if it's missing
-- This is what enables 'embedding' (relationship checks in PostgREST)
DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.table_constraints 
        WHERE constraint_name = 'shops_plan_id_fkey'
    ) THEN
        ALTER TABLE shops 
        ADD CONSTRAINT shops_plan_id_fkey 
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id);
    END IF;
END $$;

-- 5. Force a schema refresh hint (Supabase usually does this, but these changes are deep)
-- We insert a dummy comment or notify if needed, but usually running DDL is enough.
COMMENT ON TABLE shops IS 'Main tenants table with subscription and growth tracking.';

-- 6. Verify the RPC still works correctly
-- (Re-running just in case earlier SQL had issues)
CREATE OR REPLACE FUNCTION get_shop_config(p_shop_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'status', s.status,
        'plan_name', COALESCE(p.name, s.subscription_plan, 'TRIAL'),
        'product_limit', COALESCE(p.product_limit, 100),
        'user_limit', COALESCE(p.user_limit, 3),
        'next_billing_date', s.next_billing_date
    ) INTO v_result
    FROM shops s
    LEFT JOIN subscription_plans p ON s.plan_id = p.id
    WHERE s.id = p_shop_id;
    
    RETURN COALESCE(v_result, '{"error": "Shop not found"}'::jsonb);
END;
$$;
