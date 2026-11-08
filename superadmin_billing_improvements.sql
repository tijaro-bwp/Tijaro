-- ============================================================================
-- SUPERADMIN BILLING & DUNNING IMPROVEMENTS
-- Run this in the Supabase SQL Editor
-- ============================================================================

-- 1. Add suspension_reason column to shops if it doesn't exist
ALTER TABLE shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- 2. Update suspend_overdue_shops function with 7-day grace period
CREATE OR REPLACE FUNCTION suspend_overdue_shops()
RETURNS void AS $$
BEGIN
  UPDATE shops
  SET status = 'suspended',
      suspension_reason = 'Automated suspension: Subscription overdue (7-day grace period expired)'
  WHERE status = 'active'
    AND subscription_plan != 'none'
    AND next_billing_date IS NOT NULL
    AND (next_billing_date + INTERVAL '7 days') < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- 3. Update secure_login to return suspension_reason on suspension, and next_billing_date in config
DROP FUNCTION IF EXISTS secure_login(TEXT, TEXT);
CREATE OR REPLACE FUNCTION secure_login(p_username TEXT, p_password_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user           RECORD;
    v_shop           RECORD;
    v_match_count    INTEGER;
    v_session_token  UUID;
    v_clean_username TEXT;
BEGIN
    v_clean_username := TRIM(p_username);

    -- Check for multiple accounts with same username (case-insensitive)
    SELECT COUNT(*) INTO v_match_count
    FROM users
    WHERE LOWER(username) = LOWER(v_clean_username) OR LOWER(email) = LOWER(v_clean_username);

    IF v_match_count > 1 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Multiple accounts found. Please use your email to login.');
    END IF;

    -- Find active user
    SELECT u.* INTO v_user
    FROM users u
    WHERE (LOWER(u.username) = LOWER(v_clean_username) OR LOWER(u.email) = LOWER(v_clean_username))
      AND u.is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    -- Verify password hash
    IF v_user.password != p_password_hash THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    -- Fetch shop and plan limits
    SELECT s.*,
           sp.name            AS plan_name,
           COALESCE(sp.product_limit, 100) AS product_limit,
           COALESCE(sp.user_limit, 3)      AS user_limit,
           COALESCE(sp.features, '{}'::jsonb) AS features
    INTO v_shop
    FROM shops s
    LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.id = v_user.shop_id;

    -- Check if shop is suspended
    IF v_shop.status = 'suspended' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Your account has been suspended. Please contact support: 0301-2616367',
            'suspension_reason', COALESCE(v_shop.suspension_reason, 'No reason specified')
        );
    END IF;

    -- Update sign-in stats
    UPDATE users SET last_sign_in_at = NOW() WHERE id = v_user.id;
    UPDATE shops SET last_sign_in_at = NOW() WHERE id = v_user.shop_id;

    -- Generate and insert new secure session token
    v_session_token := gen_random_uuid();
    INSERT INTO sessions (token, user_id, shop_id)
    VALUES (v_session_token, v_user.id, v_user.shop_id);

    -- Build return response
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
            'plan_name',         COALESCE(v_shop.plan_name, v_shop.subscription_plan, 'Trial'),
            'product_limit',     COALESCE(v_shop.product_limit, 100),
            'user_limit',        COALESCE(v_shop.user_limit, 3),
            'status',            COALESCE(v_shop.status, 'active'),
            'next_billing_date', v_shop.next_billing_date,
            'subscription_fee',  COALESCE(v_shop.subscription_fee, 0),
            'features',          COALESCE(v_shop.features, '{}'::jsonb)
        )
    );
END;
$$;

-- 4. Update get_shop_config to return subscription_fee as well
DROP FUNCTION IF EXISTS get_shop_config(INTEGER);
CREATE OR REPLACE FUNCTION get_shop_config(p_shop_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'status',            s.status,
    'plan_name',         COALESCE(p.name, 'Trial'),
    'product_limit',     COALESCE(p.product_limit, 50),
    'user_limit',        COALESCE(p.user_limit, 2),
    'next_billing_date', s.next_billing_date,
    'subscription_fee',  COALESCE(s.subscription_fee, p.price, 0),
    'features',          COALESCE(p.features, '{}'::jsonb)
  ) INTO v_result
  FROM shops s
  LEFT JOIN subscription_plans p ON s.plan_id = p.id
  WHERE s.id = p_shop_id;
  RETURN COALESCE(v_result, '{"error":"Shop not found"}'::jsonb);
END;
$$;

-- 5. Re-grant permissions
GRANT EXECUTE ON FUNCTION secure_login(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION suspend_overdue_shops() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_shop_config(INTEGER) TO anon, authenticated;
