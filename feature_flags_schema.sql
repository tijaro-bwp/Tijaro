-- ============================================================================
-- Feature Flags Schema — Package System (Trial → Basic → Gold → Unlimited)
-- Run this in Supabase SQL Editor
-- ============================================================================

-- 1. Add features JSONB column to subscription_plans
ALTER TABLE subscription_plans
ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}'::jsonb;

-- 2. Seed feature flags for each plan

UPDATE subscription_plans SET features = '{
  "pos":true,"products":true,"categories":true,"customers":true,
  "sales_history":true,"discount":true,
  "brands":false,"suppliers":false,"purchases":false,
  "customer_ledger":false,"reports":false,"offline_sync":false,
  "data_export":false,"expenses":false,"supplier_ledger":false,
  "trash_bin":false,"bulk_import":false,"audit_logs":false,
  "advanced_reports":false,"whatsapp":false,"api_access":false,
  "print_templates":1
}'::jsonb WHERE name = 'Trial';

UPDATE subscription_plans SET features = '{
  "pos":true,"products":true,"categories":true,"customers":true,
  "sales_history":true,"discount":true,
  "brands":true,"suppliers":true,"purchases":true,
  "customer_ledger":true,"reports":true,"offline_sync":true,
  "data_export":true,"expenses":false,"supplier_ledger":false,
  "trash_bin":false,"bulk_import":false,"audit_logs":false,
  "advanced_reports":false,"whatsapp":false,"api_access":false,
  "print_templates":2
}'::jsonb WHERE name = 'Basic';

UPDATE subscription_plans SET features = '{
  "pos":true,"products":true,"categories":true,"customers":true,
  "sales_history":true,"discount":true,
  "brands":true,"suppliers":true,"purchases":true,
  "customer_ledger":true,"reports":true,"offline_sync":true,
  "data_export":true,"expenses":true,"supplier_ledger":true,
  "trash_bin":true,"bulk_import":true,"audit_logs":true,
  "advanced_reports":true,"whatsapp":false,"api_access":false,
  "print_templates":3
}'::jsonb WHERE name = 'Gold';

UPDATE subscription_plans SET features = '{
  "pos":true,"products":true,"categories":true,"customers":true,
  "sales_history":true,"discount":true,
  "brands":true,"suppliers":true,"purchases":true,
  "customer_ledger":true,"reports":true,"offline_sync":true,
  "data_export":true,"expenses":true,"supplier_ledger":true,
  "trash_bin":true,"bulk_import":true,"audit_logs":true,
  "advanced_reports":true,"whatsapp":true,"api_access":true,
  "print_templates":3
}'::jsonb WHERE name = 'Unlimited';

-- 3. Update get_shop_config() to include features
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
    'features',          COALESCE(p.features, '{}'::jsonb)
  ) INTO v_result
  FROM shops s
  LEFT JOIN subscription_plans p ON s.plan_id = p.id
  WHERE s.id = p_shop_id;
  RETURN COALESCE(v_result, '{"error":"Shop not found"}'::jsonb);
END;
$$;

-- 4. Update secure_login() to include features in shop_config
CREATE OR REPLACE FUNCTION secure_login(p_username TEXT, p_password_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user         RECORD;
    v_shop         RECORD;
    v_match_count  INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_match_count
    FROM users
    WHERE LOWER(username) = LOWER(p_username) OR LOWER(email) = LOWER(p_username);

    IF v_match_count > 1 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Multiple accounts found. Please use your email to login.');
    END IF;

    SELECT u.* INTO v_user
    FROM users u
    WHERE (LOWER(u.username) = LOWER(p_username) OR LOWER(u.email) = LOWER(p_username))
      AND u.is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    IF v_user.password != p_password_hash THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    SELECT s.*,
           sp.name            AS plan_name,
           COALESCE(sp.product_limit, 100) AS product_limit,
           COALESCE(sp.user_limit, 3)      AS user_limit,
           COALESCE(sp.features, '{}'::jsonb) AS features
    INTO v_shop
    FROM shops s
    LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.id = v_user.shop_id;

    IF v_shop.status = 'suspended' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Your account has been suspended. Please contact support: 0301-2616367');
    END IF;

    UPDATE users SET last_sign_in_at = NOW() WHERE id = v_user.id;
    UPDATE shops SET last_sign_in_at = NOW() WHERE id = v_user.shop_id;

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
            'plan_name',     COALESCE(v_shop.plan_name, v_shop.subscription_plan, 'Trial'),
            'product_limit', COALESCE(v_shop.product_limit, 100),
            'user_limit',    COALESCE(v_shop.user_limit, 3),
            'status',        COALESCE(v_shop.status, 'active'),
            'features',      COALESCE(v_shop.features, '{}'::jsonb)
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION secure_login(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_shop_config(INTEGER) TO anon, authenticated;
