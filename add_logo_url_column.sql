-- Add logo_url column to shops table if it doesn't exist
ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo_url text;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'shops' AND column_name = 'logo_url';
