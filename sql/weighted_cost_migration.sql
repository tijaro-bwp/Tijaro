-- ============================================================================
-- Weighted-average cost price on stock receipt
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- Why: every purchase used to overwrite products.cost_price with the latest
-- purchase price, so profit on stock bought earlier at a different price was
-- misstated. Receiving stock now blends the cost:
--
--   new_cost = (old_stock * old_cost + received_qty * unit_cost) / (old_stock + received_qty)
--
-- If there was no stock on hand (0 or negative), the new cost is simply the
-- purchase price. Stock and cost change together in one statement, so two
-- devices receiving at the same time cannot overwrite each other.
-- SECURITY INVOKER: the session-token RLS policies still apply.
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_stock_weighted(p_product_id INTEGER, p_qty NUMERIC, p_unit_cost NUMERIC)
RETURNS TABLE (stock_quantity NUMERIC, cost_price NUMERIC)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE products p
     SET cost_price = CASE
           WHEN p.stock_quantity > 0 AND (p.stock_quantity + p_qty) > 0
             THEN ROUND((p.stock_quantity * COALESCE(p.cost_price, 0) + p_qty * p_unit_cost) / (p.stock_quantity + p_qty), 2)
           ELSE p_unit_cost
         END,
         stock_quantity = p.stock_quantity + p_qty
   WHERE p.id = p_product_id
  RETURNING p.stock_quantity::NUMERIC, p.cost_price::NUMERIC;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found or not accessible', p_product_id USING ERRCODE = 'P0002';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_stock_weighted(INTEGER, NUMERIC, NUMERIC) TO anon, authenticated;
