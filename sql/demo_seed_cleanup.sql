-- =====================================================================
-- Removes the demo data that sql/demo_seed.sql added to one shop,
-- including anything recorded later for the demo customers (bills made in
-- the POS, payments, portal logins, bill links). Real data is not touched:
-- demo rows are recognised by their markers (sku DEMO-…, phones 0300000000x,
-- "Demo data" / "demo-seed" notes).
-- Run in the Supabase SQL Editor. Change the shop name below if needed.
-- =====================================================================

DO $$
DECLARE
  v_shop_name text := 'test';   -- <- same shop as the seed
  v_shop   integer;
  v_custs  integer[];
  v_sups   integer[];
  v_prods  integer[];
  v_sales  integer[];
  n        integer;
BEGIN
  SELECT id INTO v_shop FROM shops WHERE lower(trim(name)) = lower(trim(v_shop_name));
  IF v_shop IS NULL THEN RAISE EXCEPTION 'No shop named "%"', v_shop_name; END IF;

  SELECT array_agg(id) INTO v_custs FROM customers WHERE shop_id = v_shop AND phone ~ '^0300000000[0-9]$';
  SELECT array_agg(id) INTO v_sups  FROM suppliers WHERE shop_id = v_shop AND other_details = 'Demo data';
  SELECT array_agg(id) INTO v_prods FROM products  WHERE shop_id = v_shop AND sku LIKE 'DEMO-%';
  SELECT array_agg(id) INTO v_sales FROM sales
   WHERE shop_id = v_shop AND (created_by = 'demo-seed' OR customer_id = ANY (COALESCE(v_custs, '{}')));

  DELETE FROM customer_payments WHERE shop_id = v_shop
     AND (customer_id = ANY (COALESCE(v_custs, '{}')) OR details = 'demo-seed');
  -- Bill links go with their sales (ON DELETE CASCADE); portal logins/sessions with their customers.
  DELETE FROM sale_items WHERE sale_id = ANY (COALESCE(v_sales, '{}'));
  DELETE FROM sales WHERE id = ANY (COALESCE(v_sales, '{}'));
  IF to_regclass('public.customer_portal_accounts') IS NOT NULL THEN
    DELETE FROM customer_sessions WHERE customer_id = ANY (COALESCE(v_custs, '{}'));
    DELETE FROM customer_portal_accounts WHERE customer_id = ANY (COALESCE(v_custs, '{}'));
  END IF;
  DELETE FROM customers WHERE id = ANY (COALESCE(v_custs, '{}'));

  DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE supplier_id = ANY (COALESCE(v_sups, '{}')));
  DELETE FROM purchases WHERE supplier_id = ANY (COALESCE(v_sups, '{}'));
  DELETE FROM suppliers WHERE id = ANY (COALESCE(v_sups, '{}'));

  -- Products: only if no real (non-demo) bill or purchase still uses them.
  DELETE FROM products p WHERE p.id = ANY (COALESCE(v_prods, '{}'))
     AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.product_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM purchase_items pi WHERE pi.product_id = p.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n < COALESCE(array_length(v_prods, 1), 0) THEN
    RAISE NOTICE '% demo product(s) kept because real bills or purchases use them.', array_length(v_prods, 1) - n;
  END IF;

  DELETE FROM expenses WHERE shop_id = v_shop AND note = 'demo-seed';
  DELETE FROM categories c WHERE c.shop_id = v_shop AND c.description = 'Demo data'
     AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id);

  RAISE NOTICE 'Demo data removed from shop % (%): % customers, % bills, % suppliers.',
    v_shop, v_shop_name, COALESCE(array_length(v_custs, 1), 0), COALESCE(array_length(v_sales, 1), 0), COALESCE(array_length(v_sups, 1), 0);
END $$;
