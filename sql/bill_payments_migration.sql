-- =====================================================================
-- Bill-wise payments, balance snapshots and shareable bill links
-- (delivery / loader strategy, phase 1). See docs/BILL_PAYMENTS.md.
--
-- Run AFTER sql/security_hardening_migration.sql (it re-creates
-- update_shop_settings with the same session check). Safe to run twice.
--
--   * customer_payments.sale_id  — a payment can be recorded against a bill.
--     What a bill still owes = (total - discount) - paid at sale - linked payments.
--     sales.paid_amount stays "paid at the counter", so ledgers and balances
--     (bills add their unpaid part, payments subtract) are unchanged.
--   * customer_payments.batch_ref — idempotency key for record_bill_payment.
--   * sales.prev_balance — customer balance just before the bill, so invoices
--     and messages can show previous balance -> new balance.
--   * shops.wa_payment_template — WhatsApp text sent after a payment.
--   * bill_links — no-login, read-only links to one bill (served by portal-api).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
ALTER TABLE public.customer_payments ADD COLUMN IF NOT EXISTS sale_id   integer REFERENCES public.sales(id) ON DELETE SET NULL;
ALTER TABLE public.customer_payments ADD COLUMN IF NOT EXISTS batch_ref uuid;
CREATE INDEX IF NOT EXISTS customer_payments_sale_id_idx   ON public.customer_payments (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_payments_batch_ref_idx ON public.customer_payments (batch_ref) WHERE batch_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_payments_customer_idx  ON public.customer_payments (shop_id, customer_id);

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS prev_balance numeric(12,2);

ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS wa_payment_template text;

-- ---------------------------------------------------------------------
-- Bills of one customer with what each still owes.
-- SECURITY INVOKER: tenant RLS (is_valid_session) applies to every row read.
-- ---------------------------------------------------------------------
-- Same definitions as sql/pos_modes_migration.sql (bill_no = the shop's bill
-- number, falling back to the id), so the two files can run in any order.
DROP FUNCTION IF EXISTS public.customer_bills_due(integer, boolean);
CREATE FUNCTION public.customer_bills_due(p_customer_id integer, p_only_open boolean DEFAULT true)
RETURNS TABLE (
  sale_id        integer,
  created_at     timestamp without time zone,
  net_total      numeric,
  paid_at_sale   numeric,
  collected      numeric,
  due            numeric,
  bill_no        text
)
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  WITH b AS (
    SELECT s.id,
           s.created_at,
           round(COALESCE(s.total_amount, 0) - COALESCE(s.discount, 0), 2) AS net_total,
           COALESCE(s.paid_amount, 0) AS paid_at_sale,
           COALESCE((SELECT sum(abs(cp.amount)) FROM customer_payments cp
                      WHERE cp.sale_id = s.id AND cp.payment_type = 'payment'), 0) AS collected,
           COALESCE(s.invoice_number, right(s.id::text, 8)) AS bill_no
      FROM sales s
     WHERE s.customer_id = p_customer_id
       AND COALESCE(s.sale_type, '') <> 'quotation'
       AND COALESCE(s.payment_type, '') <> 'quotation'
  )
  SELECT id, created_at, net_total, paid_at_sale, collected,
         greatest(0, round(net_total - paid_at_sale - collected, 2)) AS due, bill_no
    FROM b
   WHERE NOT p_only_open OR round(net_total - paid_at_sale - collected, 2) > 0
   ORDER BY created_at, id;
$$;

CREATE OR REPLACE FUNCTION public.record_bill_payment(
  p_customer_id     integer,
  p_allocations     jsonb,
  p_extra_amount    numeric DEFAULT 0,
  p_payment_mode    text    DEFAULT 'cash',
  p_transaction_ref text    DEFAULT NULL,
  p_note            text    DEFAULT NULL,
  p_paid_at         timestamptz DEFAULT NULL,
  p_client_ref      uuid    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_shop_id   integer;
  v_prev      numeric;
  v_new       numeric;
  v_total     numeric := 0;
  v_extra     numeric := round(COALESCE(p_extra_amount, 0), 2);
  v_ref       uuid    := COALESCE(p_client_ref, gen_random_uuid());
  v_at        timestamp := COALESCE(p_paid_at, now())::timestamp;
  v_mode      text    := NULLIF(trim(COALESCE(p_payment_mode, '')), '');
  v_tref      text    := NULLIF(trim(COALESCE(p_transaction_ref, '')), '');
  v_note      text    := NULLIF(trim(COALESCE(p_note, '')), '');
  v_alloc     jsonb;
  v_sale_id   integer;
  v_amount    numeric;
  v_bill      record;
  v_bills     jsonb := '[]'::jsonb;
  v_seen      integer[] := '{}';
BEGIN
  SELECT shop_id, COALESCE(outstanding_balance, 0) INTO v_shop_id, v_prev
    FROM customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_ref::text));
  IF EXISTS (SELECT 1 FROM customer_payments WHERE batch_ref = v_ref) THEN
    SELECT COALESCE(sum(abs(amount)), 0) INTO v_total FROM customer_payments WHERE batch_ref = v_ref;
    RETURN jsonb_build_object(
      'success', true, 'already_recorded', true, 'total_paid', v_total,
      'prev_balance', v_prev + v_total, 'new_balance', v_prev, 'bills', '[]'::jsonb);
  END IF;

  IF v_extra < 0 THEN
    RAISE EXCEPTION 'Amount cannot be negative' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_allocations, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'p_allocations must be an array' USING ERRCODE = '22023';
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb)) LOOP
    v_sale_id := (v_alloc->>'sale_id')::integer;
    v_amount  := round((v_alloc->>'amount')::numeric, 2);
    IF v_sale_id IS NULL OR v_amount IS NULL THEN
      RAISE EXCEPTION 'Each allocation needs sale_id and amount' USING ERRCODE = '22023';
    END IF;
    IF v_amount = 0 THEN CONTINUE; END IF;
    IF v_amount < 0 THEN
      RAISE EXCEPTION 'Amount cannot be negative' USING ERRCODE = '22023';
    END IF;
    IF v_sale_id = ANY (v_seen) THEN
      RAISE EXCEPTION 'Bill % appears twice', v_sale_id USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_sale_id;

    PERFORM 1 FROM sales WHERE id = v_sale_id AND customer_id = p_customer_id FOR UPDATE;
    SELECT * INTO v_bill FROM customer_bills_due(p_customer_id, false) b WHERE b.sale_id = v_sale_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Bill % does not belong to this customer', v_sale_id USING ERRCODE = 'P0002';
    END IF;
    IF v_amount > v_bill.due + 0.009 THEN
      RAISE EXCEPTION 'Bill % only has Rs % left to pay', v_bill.bill_no, v_bill.due USING ERRCODE = '22023';
    END IF;

    INSERT INTO customer_payments
      (shop_id, customer_id, sale_id, amount, payment_type, note, bill_number, payment_mode, transaction_ref, batch_ref, created_at)
    VALUES
      (v_shop_id, p_customer_id, v_sale_id, v_amount, 'payment',
       COALESCE(v_note, 'Payment against bill #' || v_bill.bill_no),
       v_bill.bill_no, v_mode, v_tref, v_ref, v_at);

    v_total := v_total + v_amount;
    v_bills := v_bills || jsonb_build_object(
      'sale_id', v_sale_id, 'bill_no', v_bill.bill_no, 'net_total', v_bill.net_total,
      'paid_before', v_bill.paid_at_sale + v_bill.collected,
      'paid_now', v_amount, 'due', round(v_bill.due - v_amount, 2));
  END LOOP;

  IF v_extra > 0 THEN
    INSERT INTO customer_payments
      (shop_id, customer_id, amount, payment_type, note, payment_mode, transaction_ref, batch_ref, created_at)
    VALUES
      (v_shop_id, p_customer_id, v_extra, 'payment', COALESCE(v_note, 'Payment received'), v_mode, v_tref, v_ref, v_at);
    v_total := v_total + v_extra;
  END IF;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Enter an amount to receive' USING ERRCODE = '22023';
  END IF;

  UPDATE customers SET outstanding_balance = COALESCE(outstanding_balance, 0) - v_total
   WHERE id = p_customer_id
  RETURNING outstanding_balance INTO v_new;

  RETURN jsonb_build_object(
    'success', true, 'already_recorded', false, 'total_paid', v_total,
    'prev_balance', v_prev, 'new_balance', v_new, 'bills', v_bills);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.customer_bills_due(integer, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_bill_payment(integer, jsonb, numeric, text, text, text, timestamptz, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.customer_bills_due(integer, boolean) TO anon, authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.record_bill_payment(integer, jsonb, numeric, text, text, text, timestamptz, uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- No-login bill links. Only token hashes are stored; the portal-api Edge
-- Function (service role) creates and reads them. No browser access at all.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bill_links (
  token_hash  text PRIMARY KEY,
  shop_id     integer NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  sale_id     integer NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  customer_id integer NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  last_opened_at timestamptz,
  open_count  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bill_links_sale_idx ON public.bill_links (sale_id);
ALTER TABLE public.bill_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bill_links FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- update_shop_settings gains p_wa_payment_template. The parameter list
-- changes, so the old version is dropped (otherwise both would exist).
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.update_shop_settings(integer, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean);

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
  p_wholesale_enabled boolean DEFAULT NULL::boolean,
  p_wa_payment_template text DEFAULT NULL::text
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
    wa_payment_template  = COALESCE(p_wa_payment_template, wa_payment_template),
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
      'wa_payment_template', s.wa_payment_template,
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

REVOKE EXECUTE ON FUNCTION public.update_shop_settings(integer, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.update_shop_settings(integer, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) TO anon, authenticated, service_role;

-- PostgREST caches function signatures; make it see the new ones now.
NOTIFY pgrst, 'reload schema';

COMMIT;
