-- Migration: brand_categories junction table
-- Run this in your Supabase SQL editor
-- Safe to re-run — uses IF NOT EXISTS / IF EXISTS guards

CREATE TABLE IF NOT EXISTS brand_categories (
  id bigint primary key generated always as identity,
  brand_id uuid references brands(id) on delete cascade,
  category_id integer references categories(id) on delete cascade,
  shop_id integer,
  unique(brand_id, category_id)
);

-- Row Level Security — permissive (app handles shop isolation via shop_id filter)
ALTER TABLE brand_categories ENABLE ROW LEVEL SECURITY;

-- Drop any old/blocking policies first, then create permissive one
DROP POLICY IF EXISTS "allow_access" ON brand_categories;
DROP POLICY IF EXISTS "Enable all for anon" ON brand_categories;
DROP POLICY IF EXISTS "brand_categories_policy" ON brand_categories;

CREATE POLICY "allow_access" ON brand_categories
  FOR ALL USING (true) WITH CHECK (true);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_brand_categories_brand_id ON brand_categories(brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_categories_shop_id  ON brand_categories(shop_id);

-- Grant access to anon and authenticated roles (required for non-auth RLS apps)
GRANT ALL ON brand_categories TO anon;
GRANT ALL ON brand_categories TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE brand_categories_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE brand_categories_id_seq TO authenticated;
