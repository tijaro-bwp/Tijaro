-- Migration: Save Custom Shop Settings in Database
-- Run this in the Supabase SQL Editor to support persistent shop settings.

-- 1. Add missing settings columns to the shops table if they don't exist
ALTER TABLE shops 
ADD COLUMN IF NOT EXISTS print_template TEXT DEFAULT '2',
ADD COLUMN IF NOT EXISTS wa_reorder_template TEXT,
ADD COLUMN IF NOT EXISTS invoice_prefix TEXT;

-- 2. Drop old overloaded versions of update_shop_settings to prevent Postgres ambiguity errors
DROP FUNCTION IF EXISTS update_shop_settings(INTEGER, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS update_shop_settings(INTEGER, TEXT, TEXT, TEXT);

-- 3. Update the SECURITY DEFINER RPC to support saving all shop settings columns
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
  p_invoice_prefix TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Validate shop exists
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Shop not found');
  END IF;

  -- Update provided fields (use COALESCE to keep existing value if parameter is NULL)
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
    invoice_prefix       = COALESCE(p_invoice_prefix, invoice_prefix)
  WHERE id = p_shop_id;

  -- Return updated shop data
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
      'invoice_prefix', s.invoice_prefix
    )
  ) INTO v_result
  FROM shops s WHERE s.id = p_shop_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION update_shop_settings(
  INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO anon, authenticated;
