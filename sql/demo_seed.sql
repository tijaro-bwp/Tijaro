-- =====================================================================
-- Demo data for ONE shop, for testing (POS, ledgers, Receive Payment,
-- WhatsApp messages, bill links, portal).
--
-- Run in the Supabase SQL Editor. Change the shop name below if needed.
-- Needs sql/bill_payments_migration.sql (payments are linked to bills).
-- Remove everything again with sql/demo_seed_cleanup.sql.
--
-- What it adds (all marked so cleanup can find it):
--   4 categories, 16 products (sku DEMO-…), 6 customers (phones 0300000000x),
--   2 suppliers, 2 purchases, 4 expenses, an opening balance,
--   15 bills over the last 30 days (cash, credit, part-paid, wholesale)
--   and 5 payments, most of them against specific bills.
-- Customer balances and each bill's "previous balance" are worked out in
-- date order, so ledgers, invoices and messages all agree.
-- =====================================================================

DO $$
DECLARE
  v_shop_name text := 'test';   -- <- shop to fill (not case-sensitive)

  v_shop   integer;
  v_count  integer;
  v_cats   integer[] := '{}';
  v_prods  integer[] := '{}';
  v_custs  integer[] := '{}';
  v_sups   integer[] := '{}';
  v_sales  integer[] := '{}';
  v_id     integer;
  v_sale   integer;
  v_cust   integer;
  v_tier   text;
  v_at     timestamp;
  v_total  numeric;
  v_paid   numeric;
  v_due    numeric;
  v_prev   numeric;
  v_amount numeric;
  v_mode   text;
  e        jsonb;
  it       jsonb;
  p        jsonb;
  v_price  numeric;

  -- name, category (1-4), cost, retail, wholesale, stock
  products jsonb := '[
    ["PVC Pipe 1/2 inch (6m)",   1,   280,   350,   320, 120],
    ["PVC Pipe 1 inch (6m)",     1,   520,   650,   600,  80],
    ["PVC Elbow 1/2 inch",       1,    18,    30,    25, 500],
    ["PVC Tee 1 inch",           1,    35,    55,    48, 300],
    ["PPR Pipe 25mm",            1,   410,   520,   480,  90],
    ["Kitchen Mixer Tap",        2,  2600,  3500,  3200,  25],
    ["Basin Pillar Tap",         2,  1150,  1600,  1450,  40],
    ["Shower Set Chrome",        2,  4200,  5600,  5100,  15],
    ["Angle Valve",              2,   380,   550,   490, 150],
    ["Commode (Floor Mounted)",  3, 14500, 18500, 17200,   8],
    ["Wash Basin with Pedestal", 3,  6800,  8900,  8200,  10],
    ["Tank Float Valve",         3,   520,   750,   680,  60],
    ["Teflon Tape (roll)",       4,    25,    50,    40, 600],
    ["Pipe Wrench 14 inch",      4,   950,  1350,  1200,  20],
    ["Silicone Sealant",         4,   420,   600,   540,  70],
    ["Hacksaw Frame",            4,   650,   900,   820,  18]
  ]';

  -- name, phone, address, price tier
  customers jsonb := '[
    ["Ali Traders",             "03000000001", "Model Town",      "retail"],
    ["Bilal Construction",      "03000000002", "Satellite Town",  "wholesale"],
    ["Hamza Plumbing Services", "03000000003", "Gulberg",         "retail"],
    ["Usman Builders",          "03000000004", "Cantt",           "retail"],
    ["Zain Hardware Store",     "03000000005", "Main Bazar",      "wholesale"],
    ["Fatima Bibi",             "03000000006", "Shadman Colony",  "retail"]
  ]';

  -- Events in date order. sale: c = customer (null = walk-in), paid = "full" |
  -- "credit" | amount, disc = discount. pay: s = sale number (1-based), amount
  -- or "due". debit / unlinked pay: customer-level entries.
  events jsonb := '[
    {"t":"debit", "d":29, "c":1, "amount":5000, "note":"Opening balance (old dues)"},
    {"t":"sale",  "d":28, "c":1, "paid":"credit", "items":[[1,10],[3,40],[13,20]]},
    {"t":"sale",  "d":27, "c":null, "paid":"full", "items":[[7,1],[13,2]]},
    {"t":"sale",  "d":25, "c":2, "paid":10000, "items":[[2,20],[4,50],[5,15]]},
    {"t":"sale",  "d":24, "c":3, "paid":"full", "items":[[6,2],[9,6]]},
    {"t":"sale",  "d":22, "c":4, "paid":20000, "disc":500, "items":[[10,2],[11,2],[12,4]]},
    {"t":"pay",   "d":20, "s":1, "amount":"due", "mode":"cash"},
    {"t":"sale",  "d":18, "c":5, "paid":"credit", "items":[[1,30],[3,200],[13,100],[15,10]]},
    {"t":"sale",  "d":16, "c":6, "paid":"full", "items":[[8,1],[7,1]]},
    {"t":"pay",   "d":15, "s":3, "amount":15000, "mode":"bank"},
    {"t":"sale",  "d":14, "c":1, "paid":"credit", "items":[[14,1],[16,1],[15,2]]},
    {"t":"sale",  "d":12, "c":null, "paid":"full", "items":[[13,5],[9,2]]},
    {"t":"pay",   "d":10, "s":5, "amount":15000, "mode":"cash"},
    {"t":"sale",  "d":9,  "c":2, "paid":5000, "items":[[2,10],[5,20]]},
    {"t":"upay",  "d":8,  "c":1, "amount":3000, "note":"Payment towards old dues"},
    {"t":"sale",  "d":6,  "c":3, "paid":3000, "items":[[6,1],[12,2],[9,4]]},
    {"t":"sale",  "d":4,  "c":5, "paid":"credit", "items":[[4,40],[3,100]]},
    {"t":"pay",   "d":3,  "s":6, "amount":20000, "mode":"cash"},
    {"t":"sale",  "d":2,  "c":4, "paid":5000, "items":[[11,1],[7,2]]},
    {"t":"sale",  "d":1,  "c":6, "paid":"full", "items":[[12,1],[13,3]]},
    {"t":"sale",  "d":0,  "c":1, "paid":"credit", "items":[[2,5],[4,10],[9,3]]}
  ]';
BEGIN
  -- ── Find the shop ────────────────────────────────────────────────────
  SELECT count(*) INTO v_count FROM shops WHERE lower(trim(name)) = lower(trim(v_shop_name));
  IF v_count = 0 THEN
    RAISE EXCEPTION 'No shop named "%". Shops: %', v_shop_name, (SELECT string_agg(id || ': ' || name, ', ' ORDER BY id) FROM shops);
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'More than one shop is named "%". Edit v_shop_name or use the shop id.', v_shop_name;
  END IF;
  SELECT id INTO v_shop FROM shops WHERE lower(trim(name)) = lower(trim(v_shop_name));

  IF EXISTS (SELECT 1 FROM products WHERE shop_id = v_shop AND sku LIKE 'DEMO-%') THEN
    RAISE NOTICE 'Shop % already has demo data. Run sql/demo_seed_cleanup.sql first to start over.', v_shop;
    RETURN;
  END IF;

  -- ── Catalogue ────────────────────────────────────────────────────────
  FOREACH v_mode IN ARRAY ARRAY['Pipes & Fittings', 'Taps & Mixers', 'Sanitary Ware', 'Tools'] LOOP
    INSERT INTO categories (shop_id, name, description) VALUES (v_shop, v_mode, 'Demo data') RETURNING id INTO v_id;
    v_cats := v_cats || v_id;
  END LOOP;

  FOR i IN 0 .. jsonb_array_length(products) - 1 LOOP
    p := products->i;
    INSERT INTO products (shop_id, category_id, name, sku, cost_price, c_rate, sale_price, wholesale_price, stock_quantity, low_stock_threshold, status)
    VALUES (v_shop, v_cats[(p->>1)::int], p->>0, 'DEMO-' || lpad((i + 1)::text, 3, '0'),
            (p->>2)::numeric, (p->>2)::numeric, (p->>3)::numeric, (p->>4)::numeric, (p->>5)::int, 10, 'active')
    RETURNING id INTO v_id;
    v_prods := v_prods || v_id;
  END LOOP;

  FOR i IN 0 .. jsonb_array_length(customers) - 1 LOOP
    p := customers->i;
    INSERT INTO customers (shop_id, name, phone, address, outstanding_balance, price_tier, created_at)
    VALUES (v_shop, p->>0, p->>1, p->>2, 0, p->>3, (now() - interval '35 days')::timestamp)
    RETURNING id INTO v_id;
    v_custs := v_custs || v_id;
  END LOOP;

  -- ── Sales and payments, in date order ───────────────────────────────
  FOR i IN 0 .. jsonb_array_length(events) - 1 LOOP
    e := events->i;
    v_at := (date_trunc('day', now()) - make_interval(days => (e->>'d')::int) + interval '10 hours' + make_interval(mins => i * 17))::timestamp;
    IF v_at > now()::timestamp THEN v_at := now()::timestamp - interval '5 minutes'; END IF;

    IF e->>'t' = 'sale' THEN
      v_cust := CASE WHEN e->'c' = 'null'::jsonb THEN NULL ELSE v_custs[(e->>'c')::int] END;
      v_tier := COALESCE((SELECT price_tier FROM customers WHERE id = v_cust), 'retail');
      v_total := 0;
      FOR it IN SELECT * FROM jsonb_array_elements(e->'items') LOOP
        p := products->((it->>0)::int - 1);
        v_total := v_total + (it->>1)::int * (CASE WHEN v_tier = 'wholesale' THEN (p->>4)::numeric ELSE (p->>3)::numeric END);
      END LOOP;
      v_amount := v_total - COALESCE((e->>'disc')::numeric, 0);  -- net
      v_paid := CASE e->>'paid' WHEN 'full' THEN v_amount WHEN 'credit' THEN 0 ELSE least(v_amount, (e->>'paid')::numeric) END;
      v_mode := CASE WHEN e->>'paid' = 'credit' THEN 'credit' ELSE 'cash' END;
      v_prev := CASE WHEN v_cust IS NULL THEN NULL ELSE (SELECT outstanding_balance FROM customers WHERE id = v_cust) END;

      INSERT INTO sales (shop_id, customer_id, customer_name, total_amount, discount, paid_amount, payment_type, payment_method,
                         sale_type, status, created_by, created_at, price_tier, prev_balance, payment_details)
      VALUES (v_shop, v_cust, CASE WHEN v_cust IS NULL THEN 'Walk-in Customer' END, v_total, COALESCE((e->>'disc')::numeric, 0),
              v_paid, v_mode, v_mode, 'sale', 'completed', 'demo-seed', v_at, v_tier, v_prev,
              jsonb_build_array(jsonb_build_object('method', v_mode, 'amount', v_paid)))
      RETURNING id INTO v_sale;
      v_sales := v_sales || v_sale;

      FOR it IN SELECT * FROM jsonb_array_elements(e->'items') LOOP
        p := products->((it->>0)::int - 1);
        v_price := CASE WHEN v_tier = 'wholesale' THEN (p->>4)::numeric ELSE (p->>3)::numeric END;
        INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, line_total, cost_price, returned_qty, total_price)
        VALUES (v_sale, v_prods[(it->>0)::int], p->>0, (it->>1)::int, v_price, v_price * (it->>1)::int, (p->>2)::numeric, 0, v_price * (it->>1)::int);
      END LOOP;

      IF v_cust IS NOT NULL THEN
        UPDATE customers SET outstanding_balance = outstanding_balance + (v_amount - v_paid) WHERE id = v_cust;
      END IF;

    ELSIF e->>'t' = 'pay' THEN
      v_sale := v_sales[(e->>'s')::int];
      SELECT customer_id INTO v_cust FROM sales WHERE id = v_sale;
      SELECT due INTO v_due FROM customer_bills_due(v_cust, false) WHERE sale_id = v_sale;
      v_amount := CASE WHEN e->>'amount' = 'due' THEN v_due ELSE least(v_due, (e->>'amount')::numeric) END;
      INSERT INTO customer_payments (shop_id, customer_id, sale_id, amount, payment_type, note, bill_number, payment_mode, details, batch_ref, created_at)
      VALUES (v_shop, v_cust, v_sale, v_amount, 'payment', 'Payment against bill #' || right(v_sale::text, 8),
              right(v_sale::text, 8), e->>'mode', 'demo-seed', gen_random_uuid(), v_at);
      UPDATE customers SET outstanding_balance = outstanding_balance - v_amount WHERE id = v_cust;

    ELSIF e->>'t' IN ('debit', 'upay') THEN
      v_cust := v_custs[(e->>'c')::int];
      v_amount := (e->>'amount')::numeric;
      INSERT INTO customer_payments (shop_id, customer_id, amount, payment_type, note, payment_mode, details, created_at)
      VALUES (v_shop, v_cust, v_amount, CASE WHEN e->>'t' = 'debit' THEN 'debit' ELSE 'payment' END, e->>'note', 'cash', 'demo-seed', v_at);
      UPDATE customers SET outstanding_balance = outstanding_balance + CASE WHEN e->>'t' = 'debit' THEN v_amount ELSE -v_amount END
       WHERE id = v_cust;
    END IF;
  END LOOP;

  -- ── Suppliers, purchases, expenses ──────────────────────────────────
  INSERT INTO suppliers (shop_id, name, phone, address, outstanding_balance, product_type, other_details)
  VALUES (v_shop, 'Pak Pipes Industries', '03000000011', 'Industrial Area', 0, 'Pipes & fittings', 'Demo data') RETURNING id INTO v_id;
  v_sups := v_sups || v_id;
  INSERT INTO suppliers (shop_id, name, phone, address, outstanding_balance, product_type, other_details)
  VALUES (v_shop, 'Royal Sanitary Wholesale', '03000000012', 'Brandreth Road', 0, 'Taps & sanitary ware', 'Demo data') RETURNING id INTO v_id;
  v_sups := v_sups || v_id;

  -- Purchase 1: pipes, paid in full
  INSERT INTO purchases (shop_id, supplier_id, total_amount, paid_amount, payment_status, purchase_date, created_at, payment_type, status)
  VALUES (v_shop, v_sups[1], 52000, 52000, 'paid', (now() - interval '26 days')::date, (now() - interval '26 days')::timestamp, 'cash', 'completed')
  RETURNING id INTO v_id;
  INSERT INTO purchase_items (purchase_id, product_id, product_name, quantity, unit_price, total_price) VALUES
    (v_id, v_prods[1], 'PVC Pipe 1/2 inch (6m)', 100, 280, 28000),
    (v_id, v_prods[2], 'PVC Pipe 1 inch (6m)', 30, 520, 15600),
    (v_id, v_prods[4], 'PVC Tee 1 inch', 240, 35, 8400);

  -- Purchase 2: taps, part paid -> supplier balance 30,000
  INSERT INTO purchases (shop_id, supplier_id, total_amount, paid_amount, payment_status, purchase_date, created_at, payment_type, status)
  VALUES (v_shop, v_sups[2], 80000, 50000, 'partial', (now() - interval '11 days')::date, (now() - interval '11 days')::timestamp, 'cash', 'completed')
  RETURNING id INTO v_id;
  INSERT INTO purchase_items (purchase_id, product_id, product_name, quantity, unit_price, total_price) VALUES
    (v_id, v_prods[6], 'Kitchen Mixer Tap', 10, 2600, 26000),
    (v_id, v_prods[8], 'Shower Set Chrome', 5, 4200, 21000),
    (v_id, v_prods[7], 'Basin Pillar Tap', 20, 1150, 23000),
    (v_id, v_prods[9], 'Angle Valve', 25, 400, 10000);
  UPDATE suppliers SET outstanding_balance = 30000 WHERE id = v_sups[2];

  INSERT INTO expenses (shop_id, amount, description, category, note, expense_date, created_at) VALUES
    (v_shop, 25000, 'Shop rent',            'Rent',      'demo-seed', (now() - interval '27 days')::date, (now() - interval '27 days')::timestamp),
    (v_shop,  8500, 'Electricity bill',     'Utilities', 'demo-seed', (now() - interval '20 days')::date, (now() - interval '20 days')::timestamp),
    (v_shop,  1200, 'Tea and refreshments', 'Misc',      'demo-seed', (now() - interval '10 days')::date, (now() - interval '10 days')::timestamp),
    (v_shop,  2500, 'Loader fuel',          'Transport', 'demo-seed', (now() - interval '5 days')::date,  (now() - interval '5 days')::timestamp);

  RAISE NOTICE 'Demo data added to shop % (%): % products, % customers, % bills.',
    v_shop, v_shop_name, array_length(v_prods, 1), array_length(v_custs, 1), array_length(v_sales, 1);
END $$;

-- What was added: customers with their balance and open bills.
SELECT c.name, c.phone, c.outstanding_balance AS balance,
       (SELECT count(*) FROM customer_bills_due(c.id)) AS open_bills
  FROM customers c JOIN shops s ON s.id = c.shop_id
 WHERE lower(trim(s.name)) = 'test' AND c.phone LIKE '0300000000_'
 ORDER BY c.id;
