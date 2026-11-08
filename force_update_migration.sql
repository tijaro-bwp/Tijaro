-- ============================================================
-- Force Update & Shop Backups Migration
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. system_configs table (for force-refresh version signal)
CREATE TABLE IF NOT EXISTS system_configs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the initial version key
INSERT INTO system_configs (key, value)
VALUES ('force_refresh_version', '0')
ON CONFLICT (key) DO NOTHING;

-- Allow anonymous reads (POS clients read this without auth)
ALTER TABLE system_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read system_configs"
  ON system_configs FOR SELECT
  USING (true);

-- Only service role can write (superadmin uses service role key)
-- No INSERT/UPDATE policy = only service role can write

-- 2. shop_backups table (tracks when each shop was backed up)
CREATE TABLE IF NOT EXISTS shop_backups (
  id             SERIAL PRIMARY KEY,
  shop_id        INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  backed_up_at   TIMESTAMPTZ DEFAULT NOW(),
  backup_rows    INTEGER,
  backed_up_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_shop_backups_shop_date
  ON shop_backups (shop_id, backed_up_at DESC);

-- Service role bypasses RLS, so superadmin can insert freely.
-- No policies needed for superadmin-only table.
