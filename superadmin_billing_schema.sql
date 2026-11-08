-- Migration Script: Superadmin Subscription & Billing Management
-- Run this in the Supabase SQL Editor

-- 1. Add subscription fields to the shops table
ALTER TABLE shops
ADD COLUMN IF NOT EXISTS subscription_plan TEXT DEFAULT 'none', -- Optional: 'monthly', 'annually', 'none'
ADD COLUMN IF NOT EXISTS subscription_fee NUMERIC(15,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS next_billing_date DATE;

-- 2. Create the Ledger/Payments table for superadmin tracking
CREATE TABLE IF NOT EXISTS shop_payments (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
    amount NUMERIC(15,2) NOT NULL,
    payment_type TEXT DEFAULT 'bank_transfer', -- 'bank_transfer', 'cash', 'card', etc.
    payment_date DATE DEFAULT CURRENT_DATE,
    remarks TEXT,
    recorded_by UUID REFERENCES users(id), -- User who recorded the payment (usually Superadmin)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Update active shops to have a default monthly plan (Optional but helpful baseline)
UPDATE shops 
SET subscription_plan = 'monthly', subscription_fee = 2000, next_billing_date = CURRENT_DATE + INTERVAL '1 month'
WHERE status = 'active' AND subscription_plan = 'none';
