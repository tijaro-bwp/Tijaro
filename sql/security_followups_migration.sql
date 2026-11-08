-- ============================================================================
-- Security follow-ups: audit_logs isolation + no plaintext passwords
-- Run in the Supabase SQL Editor AFTER sql/superadmin_edge_functions_migration.sql
-- and after deploying the matching app build. Idempotent: safe to re-run.
-- ============================================================================

-- 1. audit_logs: one table holds both shop audit trails (shop_id set, written by
--    the POS sync queue) and platform/superadmin entries (shop_id NULL, written
--    only by the admin-api Edge Function with the service role).
--
--    Earlier scripts left permissive policies that OR together:
--      "Enable read access for all users"  USING (true)          → anyone reads everything
--      "shops_read_audit"                  USING (shop_id IS NOT NULL) → any shop's logs
--      "shops_insert_audit"                WITH CHECK (true / shop_id > 0) → forge entries for any shop
--    Replace them with a single session-scoped policy: a shop session can only
--    see and write its own shop's rows. Platform rows (shop_id NULL) are
--    reachable only through the service role.
DROP POLICY IF EXISTS "Enable read access for all users"            ON audit_logs;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON audit_logs;
DROP POLICY IF EXISTS "shops_read_audit"                            ON audit_logs;
DROP POLICY IF EXISTS "shops_insert_audit"                          ON audit_logs;
DROP POLICY IF EXISTS "Tenant Isolation"                            ON audit_logs;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON audit_logs FROM anon, authenticated;
-- DELETE is kept because Settings → "Clear all shop data" removes the shop's own logs.
GRANT SELECT, INSERT, DELETE ON audit_logs TO anon, authenticated;

CREATE POLICY "Tenant Isolation" ON audit_logs
AS PERMISSIVE FOR ALL
TO anon, authenticated
USING      (is_valid_session(shop_id))
WITH CHECK (is_valid_session(shop_id));

-- 2. users.raw_password stored every staff password in plaintext, and the users
--    "Tenant Isolation" policy let any logged-in member of a shop (e.g. a cashier)
--    read the plaintext passwords of everyone in that shop. The app no longer
--    reads or writes it: superadmins set a new password and share it once.
--    Dropping the column permanently erases the stored plaintext copies; the
--    hashed `password` column used for login is unaffected.
ALTER TABLE users DROP COLUMN IF EXISTS raw_password;
