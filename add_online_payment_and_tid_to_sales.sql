-- ========================================================
-- Migration: Add Online Payment Provider & Transaction Reference (TID) to Sales Table
-- Run this script in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/_/sql
-- ========================================================

-- 1. Add online_provider and transaction_ref columns to sales table if they do not exist
ALTER TABLE public.sales 
ADD COLUMN IF NOT EXISTS online_provider TEXT,
ADD COLUMN IF NOT EXISTS transaction_ref TEXT;

-- 2. Add performance indexes for searching and filtering by TID or Provider
CREATE INDEX IF NOT EXISTS idx_sales_transaction_ref ON public.sales(transaction_ref);
CREATE INDEX IF NOT EXISTS idx_sales_online_provider ON public.sales(online_provider);

-- 3. Ensure payment_details JSONB column exists (for multi-split payments with provider/ref)
ALTER TABLE public.sales 
ADD COLUMN IF NOT EXISTS payment_details JSONB;

-- 4. Verification notice
COMMENT ON COLUMN public.sales.online_provider IS 'Name of online payment provider (e.g. jazzcash, easypaisa, sadapay, meezan)';
COMMENT ON COLUMN public.sales.transaction_ref IS 'Transaction reference ID / TID entered during checkout';
