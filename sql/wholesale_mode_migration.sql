-- ============================================================================
-- Wholesale Mode Migration
-- Run this in the Supabase SQL Editor BEFORE deploying the frontend that uses
-- wholesale pricing. Safe to re-run (idempotent).
--
-- Adds:
--   products.c_rate            (already used by the app; tracked here to fix schema drift)
--   products.wholesale_price   (new 4th price tier)
--   sales.price_tier           ('retail' | 'wholesale')
--   customers.price_tier       ('retail' | 'wholesale')
--   shops.wholesale_enabled / business_preset / pricing_mode / custom_price_label
--   update_shop_settings()     now persists the fields above
-- ============================================================================

-- 1. Products: price columns
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS c_rate          NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(15,2) DEFAULT 0;

-- 2. Sales: which price tier the sale was rung up at
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS price_tier TEXT DEFAULT 'retail';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_price_tier_check') THEN
    ALTER TABLE sales ADD CONSTRAINT sales_price_tier_check
      CHECK (price_tier IS NULL OR price_tier IN ('retail', 'wholesale'));
  END IF;
END $$;

-- 3. Customers: default tier (wholesale customers auto-switch POS)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS price_tier TEXT DEFAULT 'retail';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_price_tier_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_price_tier_check
      CHECK (price_tier IS NULL OR price_tier IN ('retail', 'wholesale'));
  END IF;
END $$;

-- 4. Shops: pricing configuration persisted server-side
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS wholesale_enabled  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS business_preset    TEXT,
  ADD COLUMN IF NOT EXISTS pricing_mode       TEXT,
  ADD COLUMN IF NOT EXISTS custom_price_label TEXT;

-- 5. Replace update_shop_settings with a version that also saves pricing config.
--    Drop the previous signature (14 args) so Postgres has a single, unambiguous function.
DROP FUNCTION IF EXISTS update_shop_settings(INTEGER, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS update_shop_settings(INTEGER, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS update_shop_settings(
  INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION update_shop_settings(
  p_shop_id INTEGER,
  p_name TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_address TEXT DEFAULT NULL,
  p_logo_url TEXT DEFAULT NULL,
  p_invoice_footer TEXT DEFAULT NULL,
  p_quotation_footer TEXT DEFAULT NULL,
  p_print_size TEXT DEFAULT NULL,
  p_print_mode TEXT DEFAULT NULL,
  p_print_template TEXT DEFAULT NULL,
  p_wa_reminder_template TEXT DEFAULT NULL,
  p_wa_bill_template TEXT DEFAULT NULL,
  p_wa_reorder_template TEXT DEFAULT NULL,
  p_invoice_prefix TEXT DEFAULT NULL,
  p_business_preset TEXT DEFAULT NULL,
  p_pricing_mode TEXT DEFAULT NULL,
  p_custom_price_label TEXT DEFAULT NULL,
  p_wholesale_enabled BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Shop not found');
  END IF;

  UPDATE shops SET
    name                 = COALESCE(p_name, name),
    phone                = COALESCE(p_phone, phone),
    address              = COALESCE(p_address, address),
    logo_url             = COALESCE(p_logo_url, logo_url),
    invoice_footer       = COALESCE(p_invoice_footer, invoice_footer),
    quotation_footer     = COALESCE(p_quotation_footer, quotation_footer),
    print_size           = COALESCE(p_print_size, print_size),
    print_mode           = COALESCE(p_print_mode, print_mode),
    print_template       = COALESCE(p_print_template, print_template),
    wa_reminder_template = COALESCE(p_wa_reminder_template, wa_reminder_template),
    wa_bill_template     = COALESCE(p_wa_bill_template, wa_bill_template),
    wa_reorder_template  = COALESCE(p_wa_reorder_template, wa_reorder_template),
    invoice_prefix       = COALESCE(p_invoice_prefix, invoice_prefix),
    business_preset      = COALESCE(p_business_preset, business_preset),
    pricing_mode         = COALESCE(p_pricing_mode, pricing_mode),
    custom_price_label   = COALESCE(p_custom_price_label, custom_price_label),
    wholesale_enabled    = COALESCE(p_wholesale_enabled, wholesale_enabled)
  WHERE id = p_shop_id;

  SELECT jsonb_build_object(
    'success', true,
    'shop', jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'phone', s.phone,
      'address', s.address,
      'logo_url', s.logo_url,
      'invoice_footer', s.invoice_footer,
      'quotation_footer', s.quotation_footer,
      'print_size', s.print_size,
      'print_mode', s.print_mode,
      'print_template', s.print_template,
      'wa_reminder_template', s.wa_reminder_template,
      'wa_bill_template', s.wa_bill_template,
      'wa_reorder_template', s.wa_reorder_template,
      'invoice_prefix', s.invoice_prefix,
      'business_preset', s.business_preset,
      'pricing_mode', s.pricing_mode,
      'custom_price_label', s.custom_price_label,
      'wholesale_enabled', s.wholesale_enabled
    )
  ) INTO v_result
  FROM shops s WHERE s.id = p_shop_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION update_shop_settings(
  INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, BOOLEAN
) TO anon, authenticated;

-- 6. Plan feature flag. Missing key = allowed by the frontend (forward compat),
--    but the shop must ALSO switch on shops.wholesale_enabled in Settings.
--    Lock it on entry plans explicitly; enable on higher plans.
UPDATE subscription_plans
  SET features = COALESCE(features, '{}'::jsonb) || '{"wholesale": false}'::jsonb
  WHERE name IN ('Trial', 'Basic');

UPDATE subscription_plans
  SET features = COALESCE(features, '{}'::jsonb) || '{"wholesale": true}'::jsonb
  WHERE name NOT IN ('Trial', 'Basic');
