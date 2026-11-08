-- Customer payments: add bill_number + detail fields for manual historical entries
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS bill_number     TEXT;
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS details         TEXT;
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS payment_mode    TEXT;
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS transaction_ref TEXT;

-- Supplier payments: already has bill_number — add the remaining detail fields
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS details         TEXT;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS payment_mode    TEXT;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS transaction_ref TEXT;
