-- Migration: Dynamic Email Templates
-- This allows Superadmins to manage their own message presets.

CREATE TABLE IF NOT EXISTS email_templates (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,          -- 'Activation', 'Payment Overdue'
    subject TEXT NOT NULL,
    body TEXT NOT NULL,                -- HTML content from ReactQuill
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert initial templates
INSERT INTO email_templates (name, subject, body)
VALUES 
    ('Account Activation', 'Welcome to EdgeX POS! Your Account is Active', '<h1>Congratulations!</h1><p>Your shop account has been successfully activated. You can now log in to your POS system and start managing your business with the most advanced tools.</p><p><b>Next Steps:</b></p><ul><li>Log in to your dashboard</li><li>Add your inventory</li><li>Start selling!</li></ul>'),
    ('Payment Overdue', 'Urgent: Payment Overdue for your POS Subscription', '<h1>Payment Reminder</h1><p>Your subscription payment for the current month is overdue. Please settle your outstanding balance immediately to avoid any service interruption.</p><p>Failure to pay may result in temporary account suspension.</p>'),
    ('Account Suspension', 'Service Suspended: Account Overdue Payment', '<h1 style="color: #e11d48;">Account Suspended</h1><p>Your account has been suspended due to non-payment of dues. Access to POS features has been restricted.</p><p>To reactivate your account, please contact our support team at <b>0301-2616367</b> or settle your balance.</p>'),
    ('Billing Cycle Reminder', 'Upcoming Billing Cycle Reminder', '<h1>Subscription Renewal</h1><p>This is a friendly reminder that your next billing cycle is approaching within the next 3 days.</p><p>Please ensure your payment arrangements are ready to maintain uninterrupted service.</p>')
ON CONFLICT (name) DO NOTHING;
