-- ============================================================================
-- Data Integrity Migration (stock, balances, duplicate-safe sales/purchases)
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- Why: the app used to compute new stock / balances in the browser from data
-- loaded earlier and write the absolute value back. Two devices (or an offline
-- replay) silently overwrote each other. These functions apply a *change*
-- (delta) atomically inside the database instead.
--
-- The functions are SECURITY INVOKER, so the existing session-token RLS
-- policies ("Tenant Isolation") still decide which rows the caller may touch.
-- ============================================================================

-- 1. Atomic stock change: stock_quantity = stock_quantity + p_delta
CREATE OR REPLACE FUNCTION adjust_product_stock(p_product_id INTEGER, p_delta NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_new NUMERIC;
BEGIN
  UPDATE products
     SET stock_quantity = stock_quantity + p_delta
   WHERE id = p_product_id
  RETURNING stock_quantity INTO v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found or not accessible', p_product_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_new;
END;
$$;

-- 2. Atomic customer balance change (positive = customer owes more)
CREATE OR REPLACE FUNCTION adjust_customer_balance(p_customer_id INTEGER, p_delta NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_new NUMERIC;
BEGIN
  UPDATE customers
     SET outstanding_balance = COALESCE(outstanding_balance, 0) + p_delta
   WHERE id = p_customer_id
  RETURNING outstanding_balance INTO v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer % not found or not accessible', p_customer_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_new;
END;
$$;

-- 3. Atomic supplier balance change (positive = shop owes supplier more)
CREATE OR REPLACE FUNCTION adjust_supplier_balance(p_supplier_id INTEGER, p_delta NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_new NUMERIC;
BEGIN
  UPDATE suppliers
     SET outstanding_balance = COALESCE(outstanding_balance, 0) + p_delta
   WHERE id = p_supplier_id
  RETURNING outstanding_balance INTO v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier % not found or not accessible', p_supplier_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION adjust_product_stock(INTEGER, NUMERIC)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION adjust_customer_balance(INTEGER, NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION adjust_supplier_balance(INTEGER, NUMERIC) TO anon, authenticated;

-- 4. Idempotency keys: one checkout / purchase can only ever create one row,
--    even if the network drops after the server saved it and the app retries.
ALTER TABLE sales     ADD COLUMN IF NOT EXISTS client_ref UUID;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS client_ref UUID;

CREATE UNIQUE INDEX IF NOT EXISTS sales_client_ref_key     ON sales (client_ref)     WHERE client_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS purchases_client_ref_key ON purchases (client_ref) WHERE client_ref IS NOT NULL;
