-- ============================================================================
-- SECURE LOGIN FUNCTION
-- Required by Login.jsx → supabase.rpc('secure_login', {...})
-- Run this in the Supabase SQL Editor if it doesn't already exist.
-- ============================================================================

CREATE OR REPLACE FUNCTION secure_login(p_username TEXT, p_password_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER  -- Bypasses RLS so it can read users/shops regardless of JWT
AS $$
DECLARE
    v_user       RECORD;
    v_shop       RECORD;
    v_plan_name  TEXT;
    v_product_limit INTEGER;
    v_user_limit INTEGER;
    v_match_count INTEGER;
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

    -- User not found or inactive
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    -- Validate password (SHA-256 hex hash)
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

    -- Return success response
    RETURN jsonb_build_object(
        'success', true,
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

-- Grant execute permission to anon and authenticated roles
GRANT EXECUTE ON FUNCTION secure_login(TEXT, TEXT) TO anon, authenticated;

-- ============================================================================
-- NOTE: This function uses SHA-256 password hashing.
-- If your existing users have plain-text passwords in the DB, run this
-- to hash them (replace 'yourpassword' with actual values):
--
-- UPDATE users SET password = encode(sha256(password::bytea), 'hex')
-- WHERE length(password) != 64;  -- 64 chars = SHA-256 hex string
--
-- After running above, all new logins via the app will work automatically
-- since the app's hashPassword() uses SHA-256 too.
-- ============================================================================
