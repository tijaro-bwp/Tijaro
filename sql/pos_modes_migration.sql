-- =====================================================================
-- POS Counter / Delivery modes (phase A). See docs/POS_MODES.md.
-- Run after sql/bill_payments_migration.sql. Safe to run twice.
--
--   * Per-shop bill numbers: every new non-quotation bill gets the shop's next
--     number (INV-0001, INV-0002, … using shops.invoice_prefix) in
--     sales.invoice_number, assigned by the database so two tills or an
--     offline device syncing later can never get the same number.
--     Old bills keep their current number (shown from their id).
--   * Delivery orders: sales.channel ('counter' | 'delivery'), delivery_status
--     ('out' | 'delivered' | 'returned' | 'cancelled'), address, note, loader
--     name, dispatched_at / delivered_at.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Delivery columns
-- ---------------------------------------------------------------------
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS channel          text NOT NULL DEFAULT 'counter';
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS delivery_status  text;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS delivery_address text;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS delivery_note    text;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS loader_name      text;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS dispatched_at    timestamptz;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS delivered_at     timestamptz;

DO $$ BEGIN
  ALTER TABLE public.sales ADD CONSTRAINT sales_channel_check CHECK (channel IN ('counter', 'delivery'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.sales ADD CONSTRAINT sales_delivery_status_check
    CHECK (delivery_status IS NULL OR delivery_status IN ('out', 'delivered', 'returned', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS sales_delivery_idx ON public.sales (shop_id, delivery_status, created_at DESC)
  WHERE channel = 'delivery';

-- ---------------------------------------------------------------------
-- Per-shop bill numbers
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shop_invoice_counters (
  shop_id integer PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  last_no integer NOT NULL DEFAULT 0
);
ALTER TABLE public.shop_invoice_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_invoice_counters FROM PUBLIC, anon, authenticated;

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS invoice_no integer;
CREATE UNIQUE INDEX IF NOT EXISTS sales_shop_invoice_no_key ON public.sales (shop_id, invoice_no) WHERE invoice_no IS NOT NULL;

-- SECURITY DEFINER: the counter table is closed to the browser; the trigger
-- only ever touches the counter of the row's own shop (and RLS already
-- decided the caller may insert that row).
CREATE OR REPLACE FUNCTION public.sales_assign_invoice_no() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_no     integer;
  v_prefix text;
BEGIN
  IF NEW.shop_id IS NULL
     OR COALESCE(NEW.sale_type, '') = 'quotation' OR COALESCE(NEW.payment_type, '') = 'quotation'
     OR NEW.invoice_no IS NOT NULL THEN          -- restored bills keep their number
    RETURN NEW;
  END IF;

  INSERT INTO shop_invoice_counters (shop_id, last_no) VALUES (NEW.shop_id, 1)
  ON CONFLICT (shop_id) DO UPDATE SET last_no = shop_invoice_counters.last_no + 1
  RETURNING last_no INTO v_no;

  SELECT NULLIF(regexp_replace(upper(COALESCE(invoice_prefix, '')), '[^A-Z0-9]', '', 'g'), '')
    INTO v_prefix FROM shops WHERE id = NEW.shop_id;

  NEW.invoice_no := v_no;
  NEW.invoice_number := COALESCE(v_prefix, 'INV') || '-' || lpad(v_no::text, 4, '0');
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sales_assign_invoice_no() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sales_invoice_no ON public.sales;
CREATE TRIGGER trg_sales_invoice_no BEFORE INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.sales_assign_invoice_no();

-- ---------------------------------------------------------------------
-- Bill payments use the per-shop number too (replaces the versions from
-- sql/bill_payments_migration.sql; the return columns change, so drop first).
-- ---------------------------------------------------------------------
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
REVOKE EXECUTE ON FUNCTION public.customer_bills_due(integer, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.customer_bills_due(integer, boolean) TO anon, authenticated, service_role;

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

NOTIFY pgrst, 'reload schema';

COMMIT;
