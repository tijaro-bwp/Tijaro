-- ============================================================
-- DATABASE MIGRATION: AUDIT & CRITICAL FIXES (EdgeX POS)
-- Run this script in the Supabase SQL Editor.
-- ============================================================

-- 1. Create sessions table for secure custom authentication
CREATE TABLE IF NOT EXISTS sessions (
    token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'
);

-- Grant permissions to public roles for standard table access via PostgREST
GRANT ALL ON sessions TO anon, authenticated;

-- 2. Safely fix products table foreign key delete rules
-- This ensures deleting categories or suppliers will NULLify their links on products instead of failing.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_id_fkey;
ALTER TABLE products ADD CONSTRAINT products_category_id_fkey 
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_supplier_id_fkey;
ALTER TABLE products ADD CONSTRAINT products_supplier_id_fkey 
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;

-- 3. Re-create secure_login with session token generation
CREATE OR REPLACE FUNCTION secure_login(p_username TEXT, p_password_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER  -- Bypasses RLS to read users/shops
SET search_path = public
AS $$
DECLARE
    v_user       RECORD;
    v_shop       RECORD;
    v_plan_name  TEXT;
    v_match_count INTEGER;
    v_session_token UUID;
BEGIN
    -- Check for multiple accounts with same username (case-insensitive)
    SELECT COUNT(*) INTO v_match_count
    FROM users
    WHERE LOWER(username) = LOWER(p_username) OR LOWER(email) = LOWER(p_username);

    IF v_match_count > 1 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Multiple accounts found. Please use your email to login.');
    END IF;

    -- Find user by username or email
    SELECT u.*
    INTO v_user
    FROM users u
    WHERE (LOWER(u.username) = LOWER(p_username) OR LOWER(u.email) = LOWER(p_username))
      AND u.is_active = true
    LIMIT 1;

    -- User not found
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    -- Validate password
    IF v_user.password != p_password_hash THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    -- Fetch shop details
    SELECT s.*, sp.name as plan_name, COALESCE(sp.product_limit, 100) as product_limit, COALESCE(sp.user_limit, 3) as user_limit
    INTO v_shop
    FROM shops s
    LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.id = v_user.shop_id;

    -- Check shop status
    IF v_shop.status = 'suspended' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Your account has been suspended. Please contact support: 0301-2616367');
    END IF;

    -- Update last sign-in timestamps
    UPDATE users SET last_sign_in_at = NOW() WHERE id = v_user.id;
    UPDATE shops SET last_sign_in_at = NOW() WHERE id = v_user.shop_id;

    -- Insert new secure session token
    INSERT INTO sessions (user_id, shop_id)
    VALUES (v_user.id, v_user.shop_id)
    RETURNING token INTO v_session_token;

    -- Return success response
    RETURN jsonb_build_object(
        'success', true,
        'session_token', v_session_token,
        'user', jsonb_build_object(
            'id',          v_user.id,
            'username',    v_user.username,
            'email',       COALESCE(v_user.email, ''),
            'role',        v_user.role,
            'shop_id',     v_user.shop_id,
            'permissions', COALESCE(v_user.permissions, '[]'::jsonb)
        ),
        'shop_config', jsonb_build_object(
            'plan_name',     COALESCE(v_shop.plan_name, v_shop.subscription_plan, 'TRIAL'),
            'product_limit', COALESCE(v_shop.product_limit, 100),
            'user_limit',    COALESCE(v_shop.user_limit, 3),
            'status',        COALESCE(v_shop.status, 'active')
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION secure_login(TEXT, TEXT) TO anon, authenticated;

-- 4. Create a robust session token helper function
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

-- Enable RLS on sessions
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Define RLS Policy for sessions table itself
-- This is critical! Without it, subqueries on sessions inside other policies evaluate to 0 rows.
DROP POLICY IF EXISTS "Sessions Access" ON sessions;
CREATE POLICY "Sessions Access" ON sessions
AS PERMISSIVE FOR ALL TO public
USING (token = current_session_token())
WITH CHECK (true);

-- Apply tightened RLS policies scoped to verified session tokens
-- Dynamically loop and update policies for all scoped tables.
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

-- 5. Tighten child tables sale_items and purchase_items
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

-- 6. Tighten shops access policy
DROP POLICY IF EXISTS "Shop Self Access" ON shops;
DROP POLICY IF EXISTS "Shop Self Read" ON shops;
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
