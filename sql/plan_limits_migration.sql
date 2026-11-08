-- ============================================================================
-- Plan limits enforced in the database
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- Why: the product / user limits of a subscription plan were only checked in the
-- browser (read from localStorage), so they could be bypassed by editing storage,
-- by bulk import, or by calling the API directly. These triggers make the
-- database refuse inserts beyond the plan's limit.
--
-- Limit rules (same as secure_login / the app):
--   * shop's plan limit, falling back to 100 products / 3 users when the plan has none
--   * a limit <= 0 means unlimited
--   * rows without a shop (superadmin users) are never limited
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_plan_product_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER            -- must count all of the shop's rows regardless of caller RLS
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_count INTEGER;
BEGIN
  IF NEW.shop_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(sp.product_limit, 100)
    INTO v_limit
    FROM shops s
    LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
   WHERE s.id = NEW.shop_id;

  IF v_limit IS NULL OR v_limit <= 0 THEN
    RETURN NEW; -- unlimited
  END IF;

  SELECT COUNT(*) INTO v_count FROM products WHERE shop_id = NEW.shop_id;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Product limit reached: your plan allows % products. Please upgrade your plan.', v_limit
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_plan_product_limit ON products;
CREATE TRIGGER trg_enforce_plan_product_limit
  BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_product_limit();


CREATE OR REPLACE FUNCTION enforce_plan_user_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_count INTEGER;
BEGIN
  IF NEW.shop_id IS NULL THEN
    RETURN NEW; -- platform superadmins are not tied to a shop
  END IF;

  SELECT COALESCE(sp.user_limit, 3)
    INTO v_limit
    FROM shops s
    LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
   WHERE s.id = NEW.shop_id;

  IF v_limit IS NULL OR v_limit <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_count FROM users WHERE shop_id = NEW.shop_id;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'User limit reached: your plan allows % users. Please upgrade your plan.', v_limit
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_plan_user_limit ON users;
CREATE TRIGGER trg_enforce_plan_user_limit
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_user_limit();
