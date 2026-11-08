-- ============================================================================
-- Customer portal: customers sign in with mobile number + PIN and see their
-- bills, ledger and balance (read-only).
--
-- Run in the Supabase SQL Editor AFTER sql/superadmin_edge_functions_migration.sql
-- and sql/security_followups_migration.sql. Idempotent: safe to re-run.
-- Then deploy the Edge Function:  supabase functions deploy portal-api --no-verify-jwt
-- See docs/CUSTOMER_PORTAL.md.
--
-- Security model
--   * Every table below is service-role only (RLS on, no policies, grants
--     revoked). Neither shop staff browsers nor customers can read PIN hashes or
--     session hashes; only the portal-api Edge Function touches them.
--   * The portal never uses the staff `sessions` table or the shop-wide
--     "Tenant Isolation" RLS. portal-api filters every query by
--     (shop_id, customer_id) itself and returns allow-listed columns only.
-- ============================================================================

-- 1. Pakistani mobile numbers in one canonical form: 92XXXXXXXXXX (digits only).
--    0301-2616367, +92 301 2616367, 0092301..., 3012616367 -> 923012616367.
--    Anything else is returned as its digits so it never silently matches.
CREATE OR REPLACE FUNCTION normalize_pk_phone(p_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  d TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
BEGIN
  IF d = '' THEN RETURN NULL; END IF;
  IF d LIKE '0092%' THEN d := substr(d, 3); END IF;
  IF length(d) = 11 AND d LIKE '03%' THEN RETURN '92' || substr(d, 2); END IF;
  IF length(d) = 10 AND d LIKE '3%'  THEN RETURN '92' || d; END IF;
  RETURN d;
END;
$$;

-- 2. Each shop gets a short public address for its login page: /c/<portal_slug>
CREATE OR REPLACE FUNCTION make_portal_slug(p_name TEXT, p_id INTEGER)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
           NULLIF(trim(both '-' from left(regexp_replace(lower(COALESCE(p_name, '')), '[^a-z0-9]+', '-', 'g'), 48)), ''),
           'shop'
         ) || '-' || p_id
$$;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS portal_slug TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill: lower-case name, non-alphanumerics -> '-', plus the id so it is unique.
UPDATE shops
   SET portal_slug = make_portal_slug(name, id)
 WHERE portal_slug IS NULL OR portal_slug = '';

CREATE UNIQUE INDEX IF NOT EXISTS shops_portal_slug_key ON shops (portal_slug);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_portal_slug_format') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_portal_slug_format
      CHECK (portal_slug IS NULL OR portal_slug ~ '^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])?$');
  END IF;
END $$;

-- New shops get a slug automatically.
CREATE OR REPLACE FUNCTION shops_set_portal_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.portal_slug IS NULL OR NEW.portal_slug = '' THEN
    NEW.portal_slug := make_portal_slug(NEW.name, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shops_portal_slug ON shops;
CREATE TRIGGER trg_shops_portal_slug
  BEFORE INSERT ON shops
  FOR EACH ROW EXECUTE FUNCTION shops_set_portal_slug();

-- 3. Portal accounts: one per customer who has been given a login.
--    Kept out of `customers` on purpose: shop staff can SELECT * on customers,
--    and a 6-digit PIN hash is crackable offline if it ever leaks.
CREATE TABLE IF NOT EXISTS customer_portal_accounts (
  customer_id      INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  shop_id          INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  phone_normalized TEXT    NOT NULL,
  pin_hash         TEXT    NOT NULL,           -- pbkdf2-sha256$<iter>$<salt>$<hash>
  is_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_pin  BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  pin_set_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One login per mobile number per shop (disabled accounts don't block re-use).
CREATE UNIQUE INDEX IF NOT EXISTS customer_portal_accounts_phone_key
  ON customer_portal_accounts (shop_id, phone_normalized)
  WHERE is_enabled;

CREATE INDEX IF NOT EXISTS customer_portal_accounts_shop_idx ON customer_portal_accounts (shop_id);

-- 4. Customer sessions. Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash   TEXT PRIMARY KEY,
  shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address   TEXT,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS customer_sessions_customer_idx ON customer_sessions (customer_id);
CREATE INDEX IF NOT EXISTS customer_sessions_expires_idx  ON customer_sessions (expires_at);

-- 5. Failed-login log for per-IP / per-number throttling.
CREATE TABLE IF NOT EXISTS customer_portal_login_failures (
  id               BIGSERIAL PRIMARY KEY,
  ip_address       TEXT,
  shop_id          INTEGER,
  phone_normalized TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_portal_login_failures_ip_idx    ON customer_portal_login_failures (ip_address, created_at);
CREATE INDEX IF NOT EXISTS customer_portal_login_failures_phone_idx ON customer_portal_login_failures (shop_id, phone_normalized, created_at);

-- 6. Lock all three tables to the service role (portal-api).
ALTER TABLE customer_portal_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_portal_login_failures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON customer_portal_accounts       FROM anon, authenticated;
REVOKE ALL ON customer_sessions              FROM anon, authenticated;
REVOKE ALL ON customer_portal_login_failures FROM anon, authenticated;
REVOKE ALL ON SEQUENCE customer_portal_login_failures_id_seq FROM anon, authenticated;

-- 7. Housekeeping (portal-api calls this opportunistically; also safe for pg_cron).
CREATE OR REPLACE FUNCTION customer_portal_cleanup()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM customer_sessions              WHERE expires_at < NOW();
  DELETE FROM customer_portal_login_failures WHERE created_at < NOW() - INTERVAL '1 day';
$$;

REVOKE ALL ON FUNCTION customer_portal_cleanup() FROM PUBLIC, anon, authenticated;

-- 8. Report: customers in each shop that share a mobile number. Merge or fix
--    these before giving them portal logins (portal-api refuses duplicates).
--    SELECT * FROM customer_portal_duplicate_phones WHERE shop_id = <id>;
CREATE OR REPLACE VIEW customer_portal_duplicate_phones AS
SELECT shop_id,
       normalize_pk_phone(phone) AS phone_normalized,
       count(*)                  AS customers,
       array_agg(id ORDER BY id) AS customer_ids
  FROM customers
 WHERE normalize_pk_phone(phone) IS NOT NULL
 GROUP BY shop_id, normalize_pk_phone(phone)
HAVING count(*) > 1;

REVOKE ALL ON customer_portal_duplicate_phones FROM anon, authenticated;
