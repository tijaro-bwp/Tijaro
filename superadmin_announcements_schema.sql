-- Migration Script: Global System Announcements
-- Run this in the Supabase SQL Editor

CREATE TABLE IF NOT EXISTS announcements (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info', -- 'info', 'warning', 'success', 'error'
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ -- Optional: automatically hide after a certain date
);

-- Insert a welcome announcement
INSERT INTO announcements (message, type, is_active)
VALUES ('Welcome to the new and improved Cloud POS System! If you need support, please contact us.', 'info', true);
