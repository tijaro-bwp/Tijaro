-- Add the email column to the existing users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
