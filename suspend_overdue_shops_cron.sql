-- Migration Script: Automated Shop Suspension
-- Run this in the Supabase SQL Editor to enable pg_cron and schedule the nightly suspension check.

-- 1. Enable the pg_cron extension (Only works if you are a superuser, typical in Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Create the function that will do the suspension
-- This function checks all active shops that have a next_billing_date set.
-- If the next_billing_date is strictly less than today's date (meaning it has passed),
-- it updates the shop status to 'suspended'.
CREATE OR REPLACE FUNCTION suspend_overdue_shops()
RETURNS void AS $$
BEGIN
  UPDATE shops
  SET status = 'suspended'
  WHERE status = 'active' 
    AND subscription_plan != 'none' 
    AND next_billing_date < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- 3. Schedule the Cron Job
-- This schedules the function to run at 00:00 (Midnight) UTC every single day.
SELECT cron.schedule(
  'suspend-overdue-shops', -- Name of the cron job
  '0 0 * * *',             -- Cron schedule (Midnight every day)
  $$SELECT suspend_overdue_shops();$$
);

-- Note: To check if it was scheduled successfully, you can run:
-- SELECT * FROM cron.job;
