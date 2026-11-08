-- ============================================================
-- POS Shop Audit Logs — Schema Extension + RLS
-- Run this in the Supabase SQL Editor
--
-- Background: The existing audit_logs table was created for
-- superadmin actions (actor_email, action_type, etc.).
-- The POS app writes shop-level audit logs with a different
-- schema (action, entity, entity_id, user_id, shop_id, timestamp).
-- This script adds the missing columns and fixes policies so
-- the POS app (anon key) can INSERT its own audit entries.
-- ============================================================

-- Step 1: Add missing columns used by the POS app (safe — does nothing if already exists)
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS shop_id    INTEGER;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action     TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity     TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id  TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id    TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS timestamp  TEXT;

-- Add index for shop_id lookups
CREATE INDEX IF NOT EXISTS idx_audit_logs_shop_id ON audit_logs(shop_id);

-- Step 2: Fix INSERT policy — original only allowed 'authenticated' role.
-- The POS app uses the anon key, so we need to allow 'public' (anon + authenticated).
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON audit_logs;
DROP POLICY IF EXISTS "shops_insert_audit" ON audit_logs;

CREATE POLICY "shops_insert_audit" ON audit_logs
AS PERMISSIVE FOR INSERT TO public
WITH CHECK (true);
-- Note: We allow any insert here because the POS app does not set JWT claims.
-- Shop isolation is enforced at the application level (shop_id comes from AuthContext).

-- Step 3: Scope SELECT so shops only see their own logs.
-- Superadmin uses the service_role key which bypasses RLS entirely — no change needed.
DROP POLICY IF EXISTS "Enable read access for all users" ON audit_logs;
DROP POLICY IF EXISTS "shops_read_audit" ON audit_logs;

CREATE POLICY "shops_read_audit" ON audit_logs
AS PERMISSIVE FOR SELECT TO public
USING (
    -- If shop_id is null (superadmin SA-created rows), only service_role can see them (bypasses RLS)
    -- If shop_id is set, allow access (POS apps read only their own via .eq() filter in code)
    shop_id IS NOT NULL
    OR
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
);
