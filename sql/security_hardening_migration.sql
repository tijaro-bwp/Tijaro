-- =====================================================================
-- Security hardening: close tenant-isolation holes inherited from the
-- original schema. Safe to run more than once. Run AFTER the base schema
-- and the other migrations, BEFORE real shop data goes in (it is also safe
-- on a live database).
--
-- Model this enforces (see AGENTS.md):
--   * Shop staff reach tenant tables with the anon key + x-session-token;
--     the only shop-facing check is is_valid_session(shop_id).
--   * Superadmin work goes through the admin-api Edge Function with the
--     service role, which bypasses RLS. No browser-side superadmin policies.
--
-- What it fixes:
--   1. Policies that are always true for app requests
--      (COALESCE(jwt shop_id, shop_id) = shop_id, USING (true)).
--   2. Policies trusting app.current_shop_id / app.current_role, which any
--      caller could set through set_custom_claims().
--   3. Supabase-Auth policies on users (any self-signed-up Auth account
--      could read every user row, including password hashes).
--   4. system_configs and shop_backups had no RLS and full anon grants.
--   5. update_shop_settings / get_shop_config accepted any shop id.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Always-true tenant policies -> session isolation
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotations', 'quotation_items', 'returns', 'return_items', 'support_tickets', 'units', 'brand_categories']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Tenant Isolation" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "Tenant Isolation" ON public.%I TO anon, authenticated '
      'USING (public.is_valid_session(shop_id)) WITH CHECK (public.is_valid_session(shop_id))', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS allow_access ON public.units;
DROP POLICY IF EXISTS allow_access ON public.brand_categories;
DROP POLICY IF EXISTS shop_access  ON public.brand_categories;
DROP POLICY IF EXISTS shop_insert  ON public.brand_categories;
DROP POLICY IF EXISTS shop_update  ON public.brand_categories;
DROP POLICY IF EXISTS shop_delete  ON public.brand_categories;

-- Shop payments (subscription fees): shops may read their own; only
-- admin-api (service role) writes.
DROP POLICY IF EXISTS "Tenant Isolation"     ON public.shop_payments;
DROP POLICY IF EXISTS view_shoppay           ON public.shop_payments;
DROP POLICY IF EXISTS "Shop Payments Read Own" ON public.shop_payments;
CREATE POLICY "Shop Payments Read Own" ON public.shop_payments
  FOR SELECT TO anon, authenticated
  USING (public.is_valid_session(shop_id));

-- ---------------------------------------------------------------------
-- 2. Policies driven by spoofable app.current_* settings
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS sa_announce   ON public.announcements;
DROP POLICY IF EXISTS sa_brands     ON public.brands;
DROP POLICY IF EXISTS sa_categories ON public.categories;
DROP POLICY IF EXISTS sa_cpay       ON public.customer_payments;
DROP POLICY IF EXISTS sa_customers  ON public.customers;
DROP POLICY IF EXISTS sa_expenses   ON public.expenses;
DROP POLICY IF EXISTS sa_only_audit ON public.audit_logs;
DROP POLICY IF EXISTS sa_pitems     ON public.purchase_items;
DROP POLICY IF EXISTS sa_plans      ON public.subscription_plans;
DROP POLICY IF EXISTS sa_products   ON public.products;
DROP POLICY IF EXISTS sa_purchases  ON public.purchases;
DROP POLICY IF EXISTS sa_sales      ON public.sales;
DROP POLICY IF EXISTS sa_shoppay    ON public.shop_payments;
DROP POLICY IF EXISTS sa_shops      ON public.shops;
DROP POLICY IF EXISTS sa_sitems     ON public.sale_items;
DROP POLICY IF EXISTS sa_spay       ON public.supplier_payments;
DROP POLICY IF EXISTS sa_suppliers  ON public.suppliers;
DROP POLICY IF EXISTS sa_templates  ON public.email_templates;
DROP POLICY IF EXISTS sa_tickets    ON public.support_tickets;
DROP POLICY IF EXISTS sa_users      ON public.users;

DROP POLICY IF EXISTS tenant_brands     ON public.brands;
DROP POLICY IF EXISTS tenant_categories ON public.categories;
DROP POLICY IF EXISTS tenant_cpay       ON public.customer_payments;
DROP POLICY IF EXISTS tenant_customers  ON public.customers;
DROP POLICY IF EXISTS tenant_expenses   ON public.expenses;
DROP POLICY IF EXISTS tenant_products   ON public.products;
DROP POLICY IF EXISTS tenant_purchases  ON public.purchases;
DROP POLICY IF EXISTS tenant_sales      ON public.sales;
DROP POLICY IF EXISTS tenant_spay       ON public.supplier_payments;
DROP POLICY IF EXISTS tenant_suppliers  ON public.suppliers;
DROP POLICY IF EXISTS tenant_tickets    ON public.support_tickets;

DROP POLICY IF EXISTS own_shop      ON public.shops;
DROP POLICY IF EXISTS parent_pitems ON public.purchase_items;
DROP POLICY IF EXISTS parent_sitems ON public.sale_items;
DROP POLICY IF EXISTS admin_users   ON public.users;
DROP POLICY IF EXISTS view_users    ON public.users;

-- Nobody outside the database may set the app.current_* claims.
REVOKE EXECUTE ON FUNCTION public.set_custom_claims(uuid, integer, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Supabase-Auth policies on users (the app does not use Supabase Auth)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can read all users"    ON public.users;
DROP POLICY IF EXISTS "Users can update own record" ON public.users;

-- ---------------------------------------------------------------------
-- 4. Tables with no RLS
-- ---------------------------------------------------------------------
-- system_configs: the browser reads only the force-refresh flag (src/main.jsx);
-- everything else goes through admin-api.
ALTER TABLE public.system_configs ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.system_configs FROM anon, authenticated;
DROP POLICY IF EXISTS "Public Force Refresh Flag" ON public.system_configs;
CREATE POLICY "Public Force Refresh Flag" ON public.system_configs
  FOR SELECT TO anon, authenticated
  USING (key = 'force_refresh_version');

-- shop_backups: admin-api only.
ALTER TABLE public.shop_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_backups FROM anon, authenticated;

-- Stale copy of users (with password hashes) from an old maintenance task.
DROP TABLE IF EXISTS public.users_backup_20260319;

-- ---------------------------------------------------------------------
-- 5. SECURITY DEFINER functions that trusted the caller's shop id
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_shop_config(p_shop_id integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_result JSONB;
BEGIN
  IF NOT public.is_valid_session(p_shop_id) THEN
    RETURN '{"error":"Not authorised"}'::jsonb;
  END IF;

  SELECT jsonb_build_object(
    'status',            s.status,
    'plan_name',         COALESCE(p.name, 'Trial'),
    'product_limit',     COALESCE(p.product_limit, 50),
    'user_limit',        COALESCE(p.user_limit, 2),
    'next_billing_date', s.next_billing_date,
    'subscription_fee',  COALESCE(s.subscription_fee, p.price, 0),
    'features',          COALESCE(p.features, '{}'::jsonb)
  ) INTO v_result
  FROM shops s
  LEFT JOIN subscription_plans p ON s.plan_id = p.id
  WHERE s.id = p_shop_id;
  RETURN COALESCE(v_result, '{"error":"Shop not found"}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_shop_settings(
  p_shop_id integer,
  p_name text DEFAULT NULL::text,
  p_phone text DEFAULT NULL::text,
  p_address text DEFAULT NULL::text,
  p_logo_url text DEFAULT NULL::text,
  p_invoice_footer text DEFAULT NULL::text,
  p_quotation_footer text DEFAULT NULL::text,
  p_print_size text DEFAULT NULL::text,
  p_print_mode text DEFAULT NULL::text,
  p_print_template text DEFAULT NULL::text,
  p_wa_reminder_template text DEFAULT NULL::text,
  p_wa_bill_template text DEFAULT NULL::text,
  p_wa_reorder_template text DEFAULT NULL::text,
  p_invoice_prefix text DEFAULT NULL::text,
  p_business_preset text DEFAULT NULL::text,
  p_pricing_mode text DEFAULT NULL::text,
  p_custom_price_label text DEFAULT NULL::text,
  p_wholesale_enabled boolean DEFAULT NULL::boolean
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT public.is_valid_session(p_shop_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorised');
  END IF;

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

-- Admin-only maintenance / analytics: admin-api calls these with the service role.
REVOKE EXECUTE ON FUNCTION public.suspend_overdue_shops()    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_global_growth_stats()  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_top_performing_shops() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_inactive_shops()       FROM PUBLIC, anon, authenticated;

COMMIT;
