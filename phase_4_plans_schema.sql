-- Phase 4: Dynamic Subscriptions & Feature Limits
-- This migration creates the central plans table and links shops to it.

-- 1. Create the Plans table
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,          -- 'Basic', 'Gold', 'VIP'
    price NUMERIC(15,2) DEFAULT 0,
    billing_cycle TEXT DEFAULT 'monthly', -- 'monthly', 'annually'
    product_limit INTEGER DEFAULT 100,    -- Max products allowed
    user_limit INTEGER DEFAULT 3,         -- Max staff accounts
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Insert baseline plans
INSERT INTO subscription_plans (name, price, product_limit, user_limit)
VALUES 
    ('Trial', 0, 50, 2),
    ('Basic', 2000, 200, 5),
    ('Gold', 5000, 1000, 15),
    ('Unlimited', 10000, 99999, 99)
ON CONFLICT (name) DO NOTHING;

-- 3. Link shops to specific plan IDs
ALTER TABLE shops 
ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES subscription_plans(id);

-- 4. Set default plans for existing shops based on their current text status
UPDATE shops s
SET plan_id = p.id
FROM subscription_plans p
WHERE s.subscription_plan = 'monthly' AND p.name = 'Basic' AND s.plan_id IS NULL;

UPDATE shops s
SET plan_id = p.id
FROM subscription_plans p
WHERE s.subscription_plan = 'trial' AND p.name = 'Trial' AND s.plan_id IS NULL;

-- 5. Create Support Tickets table
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'open', -- 'open', 'closed', 'in_progress'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. RPC for POS to fetch its limits & status securely
CREATE OR REPLACE FUNCTION get_shop_config(p_shop_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'status', s.status,
        'plan_name', COALESCE(p.name, s.subscription_plan, 'TRIAL'),
        'product_limit', COALESCE(p.product_limit, 50),
        'user_limit', COALESCE(p.user_limit, 2),
        'next_billing_date', s.next_billing_date
    ) INTO v_result
    FROM shops s
    LEFT JOIN subscription_plans p ON s.plan_id = p.id
    WHERE s.id = p_shop_id;
    
    RETURN COALESCE(v_result, '{"error": "Shop not found"}'::jsonb);
END;
$$;
