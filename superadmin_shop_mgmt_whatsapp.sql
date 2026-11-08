-- ============================================================================
-- SUPERADMIN SHOP MANAGEMENT & WHATSAPP AUTOMATION MIGRATION
-- Run this in your Supabase SQL Editor
-- ============================================================================

-- 1. Add raw_password to users for Superadmin Helpdesk visibility
ALTER TABLE users ADD COLUMN IF NOT EXISTS raw_password TEXT;

-- 2. Add business_type to shops for retail domain tracking
ALTER TABLE shops ADD COLUMN IF NOT EXISTS business_type TEXT DEFAULT 'general';

-- 3. Comment explaining raw_password purpose
COMMENT ON COLUMN users.raw_password IS 'Plaintext/readable password stored strictly for Superadmin helpdesk and WhatsApp credential sharing';
COMMENT ON COLUMN shops.business_type IS 'Store vertical: general, grocery, apparel, pharmacy, electronics, hardware';
