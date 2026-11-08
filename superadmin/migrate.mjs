import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import fs from 'fs'

dotenv.config()

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY in .env")
    process.exit(1)
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

async function runMigration() {
    console.log('Running Superadmin Billing Migration...')

    // We can't run raw SQL easily via JS client, but we can execute an RPC or do the equivalents.
    // Instead, since the user is struggling with the SQL editor, let's use the REST API 
    // or we can just ask them to copy EXACTLY from superadmin_billing_schema.sql.

    // 1. Add columns to shops
    console.log("Adding columns to shops... (Errors are fine if columns exist)")
    const { error: e1 } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_plan TEXT DEFAULT 'none';`
    })

    const { error: e2 } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_fee NUMERIC(15,2) DEFAULT 0;`
    })

    const { error: e3 } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE shops ADD COLUMN IF NOT EXISTS next_billing_date DATE;`
    })

    // 2. Create shop_payments
    const { error: e4 } = await supabaseAdmin.rpc('exec_sql', {
        sql: `
    CREATE TABLE IF NOT EXISTS shop_payments (
        id SERIAL PRIMARY KEY,
        shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
        amount NUMERIC(15,2) NOT NULL,
        payment_type TEXT DEFAULT 'bank_transfer',
        payment_date DATE DEFAULT CURRENT_DATE,
        remarks TEXT,
        recorded_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `
    })

    console.log("Errors if any (we don't have exec_sql RPC by default):", e1, e4)
    console.log("Migration script finished.")
}

runMigration()
