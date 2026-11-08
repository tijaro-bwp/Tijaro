-- Add payment_details to sales table to support split payments
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_details JSONB;

-- Add returned_qty to sale_items table to support sales returns
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS returned_qty INTEGER DEFAULT 0;

-- Create audit_logs table for tracking user actions
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details JSONB,
    user_id UUID REFERENCES auth.users(id), -- Or TEXT if you're not using auth.users
    shop_id INTEGER REFERENCES shops(id),
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Note: If your user_id in audit_logs should map to your custom users table, use this instead:
-- user_id INTEGER REFERENCES users(id)

-- Enable RLS for audit_logs if needed
-- ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Add permissions column to users table for feature-level access
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'::jsonb;
