-- Units table for product unit-of-measure (Piece, Kg, Feet, Meter, etc.)
-- Run this in Supabase SQL editor

CREATE TABLE IF NOT EXISTS units (
  id serial primary key,
  name text not null,
  abbreviation text,
  shop_id integer references shops(id) on delete cascade,
  created_at timestamptz default now(),
  unique(name, shop_id)
);

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_access" ON units USING (true) WITH CHECK (true);
GRANT ALL ON units TO anon;
GRANT ALL ON units TO authenticated;

CREATE INDEX IF NOT EXISTS idx_units_shop_id ON units(shop_id);

-- Also add unit_id column to products table if not exists
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_id integer references units(id) on delete set null;
