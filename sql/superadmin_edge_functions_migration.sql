-- ============================================================================
-- Superadmin via Edge Functions — session hardening migration
-- Run in the Supabase SQL Editor BEFORE deploying the `admin-api` Edge Function.
-- Idempotent: safe to re-run.
--
-- Why: the browser used to hold the service-role key. Privileged admin work now
-- runs in the `admin-api` Edge Function, which trusts the `sessions` table to
-- decide who is a superadmin. That only works if:
--   1. superadmin logins get a real session row (shop_id NULL — they have no shop),
--   2. nobody can create, read or forge session rows from the browser, and
--   3. nobody can promote themselves to role = 'superadmin' from the browser.
-- ============================================================================

-- 1. Allow superadmin sessions (no shop). Tenant RLS compares
--    sessions.shop_id = <row>.shop_id, so a NULL shop_id never matches any
--    tenant row: a superadmin session sees no shop data through PostgREST.
ALTER TABLE sessions ALTER COLUMN shop_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

-- Only superadmin users may hold a shop-less session.
CREATE OR REPLACE FUNCTION sessions_enforce_shop_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.shop_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = NEW.user_id AND u.role = 'superadmin' AND u.shop_id IS NULL
    ) THEN
        RAISE EXCEPTION 'Only superadmin sessions may omit shop_id' USING ERRCODE = '23502';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_enforce_shop_scope ON sessions;
CREATE TRIGGER sessions_enforce_shop_scope
BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION sessions_enforce_shop_scope();

-- 2. Lock down the sessions table.
--    Earlier scripts granted ALL to anon and added "Sessions Open Access"
--    (USING true / WITH CHECK true): anyone with the public anon key could list
--    every session token or insert a session for any user. Session rows are now
--    written only by SECURITY DEFINER functions (secure_login) and the
--    service-role Edge Function. The browser may read only its OWN row (the
--    impersonation handoff in Login.jsx verifies its token this way).
DROP POLICY IF EXISTS "Sessions Open Access" ON sessions;
DROP POLICY IF EXISTS "Sessions Access"      ON sessions;
DROP POLICY IF EXISTS "Sessions Read Own"    ON sessions;

REVOKE ALL ON sessions FROM anon, authenticated;
GRANT SELECT ON sessions TO anon, authenticated;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Sessions Read Own" ON sessions
AS PERMISSIVE FOR SELECT
TO anon, authenticated
USING (token = current_session_token());

-- 3. Nobody can create or promote a superadmin through PostgREST (anon /
--    authenticated roles). Superadmins are created by the database owner or the
--    service role only. SECURITY DEFINER functions (e.g. secure_login updating
--    last_sign_in_at) run as the owner and are unaffected.
CREATE OR REPLACE FUNCTION users_protect_superadmin_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user IN ('anon', 'authenticated') THEN
        IF NEW.role = 'superadmin' THEN
            RAISE EXCEPTION 'Superadmin accounts cannot be created or modified from the client'
                USING ERRCODE = '42501';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.role = 'superadmin' THEN
            RAISE EXCEPTION 'Superadmin accounts cannot be created or modified from the client'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_protect_superadmin_role ON users;
CREATE TRIGGER users_protect_superadmin_role
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION users_protect_superadmin_role();

-- 4. Canonical secure_login.
--    Several older scripts redefine this function; whichever ran last won, and
--    some versions dropped the session token. This version combines them:
--    session token + features + suspension reason + billing fields, and it
--    supports superadmins (no shop → session with shop_id NULL, 12h expiry).
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
    v_is_superadmin  BOOLEAN;
BEGIN
    v_clean_username := TRIM(p_username);

    SELECT COUNT(*) INTO v_match_count
    FROM users
    WHERE LOWER(username) = LOWER(v_clean_username) OR LOWER(email) = LOWER(v_clean_username);

    IF v_match_count > 1 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Multiple accounts found. Please use your email to login.');
    END IF;

    SELECT u.* INTO v_user
    FROM users u
    WHERE (LOWER(u.username) = LOWER(v_clean_username) OR LOWER(u.email) = LOWER(v_clean_username))
      AND u.is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    IF v_user.password IS NULL OR v_user.password != p_password_hash THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid username or password');
    END IF;

    v_is_superadmin := (v_user.role = 'superadmin' AND v_user.shop_id IS NULL);

    IF NOT v_is_superadmin THEN
        IF v_user.shop_id IS NULL THEN
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
            RETURN jsonb_build_object(
                'success', false,
                'error', 'Your account has been suspended. Please contact support: 0301-2616367',
                'suspension_reason', COALESCE(v_shop.suspension_reason, 'No reason specified')
            );
        END IF;

        UPDATE shops SET last_sign_in_at = NOW() WHERE id = v_user.shop_id;
    END IF;

    UPDATE users SET last_sign_in_at = NOW() WHERE id = v_user.id;

    v_session_token := gen_random_uuid();
    INSERT INTO sessions (token, user_id, shop_id, expires_at)
    VALUES (
        v_session_token,
        v_user.id,
        CASE WHEN v_is_superadmin THEN NULL ELSE v_user.shop_id END,
        CASE WHEN v_is_superadmin THEN NOW() + INTERVAL '12 hours' ELSE NOW() + INTERVAL '30 days' END
    );

    IF v_is_superadmin THEN
        RETURN jsonb_build_object(
            'success', true,
            'session_token', v_session_token,
            'user', jsonb_build_object(
                'id',          v_user.id,
                'username',    v_user.username,
                'email',       COALESCE(v_user.email, ''),
                'role',        'superadmin',
                'shop_id',     NULL,
                'permissions', '[]'::jsonb
            ),
            'shop_config', NULL
        );
    END IF;

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

GRANT EXECUTE ON FUNCTION secure_login(TEXT, TEXT) TO anon, authenticated;

-- 5. Housekeeping: drop expired sessions so the table does not grow forever.
DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < NOW();
