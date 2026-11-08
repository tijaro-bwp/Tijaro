-- ============================================================
-- RPC: update_shop_settings
-- Bypasses RLS to update shop profile (name, phone, address, logo_url)
-- Only allows updating the shop that the calling user belongs to
-- ============================================================

CREATE OR REPLACE FUNCTION update_shop_settings(
  p_shop_id INTEGER,
  p_name TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_address TEXT DEFAULT NULL,
  p_logo_url TEXT DEFAULT NULL
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

  -- Update only provided fields (non-null)
  UPDATE shops SET
    name     = COALESCE(p_name, name),
    phone    = COALESCE(p_phone, phone),
    address  = COALESCE(p_address, address),
    logo_url = COALESCE(p_logo_url, logo_url)
  WHERE id = p_shop_id;

  -- Return updated shop data
  SELECT jsonb_build_object(
    'success', true,
    'shop', jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'phone', s.phone,
      'address', s.address,
      'logo_url', s.logo_url
    )
  ) INTO v_result
  FROM shops s WHERE s.id = p_shop_id;

  RETURN v_result;
END;
$$;

-- Grant execute to anon and authenticated roles
GRANT EXECUTE ON FUNCTION update_shop_settings TO anon;
GRANT EXECUTE ON FUNCTION update_shop_settings TO authenticated;
