import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { Resend } from 'resend'

dotenv.config()

const resend = new Resend(process.env.RESEND_API_KEY)

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Missing Supabase credentials in .env")
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Mock Email/SMS Providers
const mockEmailProvider = {
    send: async ({ to, subject, body }) => {
        console.log(`\n📧 [EMAIL SENT to ${to}]`)
        console.log(`Subject: ${subject}`)
        console.log(`Body:\n${body}\n`)
        return true
    }
}

const mockSMSProvider = {
    send: async ({ to, message }) => {
        console.log(`\n📱 [SMS SENT to ${to}]`)
        console.log(`Message: ${message}\n`)
        return true
    }
}

async function sendWarnings() {
    console.log('🔄 Checking for shops with expiring subscriptions...')

    try {
        const { data: shops, error } = await supabase
            .from('shops')
            .select('id, name, phone, email, next_billing_date, status')
            .eq('status', 'active')
            .not('next_billing_date', 'is', null)

        if (error) throw error

        let warningsSent = 0
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        for (const shop of shops) {
            const billingDate = new Date(shop.next_billing_date)
            billingDate.setHours(0, 0, 0, 0)

            const diffTime = billingDate.getTime() - today.getTime()
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

            let warningType = null

            if (diffDays === 7) warningType = '7_DAYS'
            else if (diffDays === 3) warningType = '3_DAYS'
            else if (diffDays === 1) warningType = '1_DAY'

            if (warningType) {
                console.log(`\n🔔 Shop "${shop.name}" expires in ${diffDays} days. Triggering ${warningType} warning...`)

                const subject = `Urgent: Your EdgeX POS Subscription expires in ${diffDays} day(s)`
                const emailBody = `Dear ${shop.name} team,\n\nThis is a friendly reminder that your EdgeX POS software subscription is due for renewal on ${shop.next_billing_date}.\nTo avoid any interruption of service or auto-suspension, please process your payment soon.\n\nThank you for choosing EdgeX.`
                const smsMessage = `EdgeX POS Reminder: Your subscription for ${shop.name} expires in ${diffDays} day(s) on ${shop.next_billing_date}. Please renew soon to avoid suspension.`

                if (shop.email) {
                    if (process.env.RESEND_API_KEY) {
                        try {
                            // Resend requires verified domains. Use onboarding@resend.dev for testing.
                            const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
                            await resend.emails.send({
                                from: `EdgeX POS <${fromEmail}>`,
                                to: shop.email,
                                subject: subject,
                                text: emailBody
                            })
                            console.log(`\n📧 [REAL EMAIL SENT via Resend from ${fromEmail} to ${shop.email}]`)
                        } catch (emailErr) {
                            console.error(`❌ Failed to send email via Resend to ${shop.email}:`, emailErr)
                        }
                    } else {
                        // Fallback to mock if no API key
                        await mockEmailProvider.send({ to: shop.email, subject, body: emailBody })
                    }
                } else {
                    console.log(`⚠️ No email configured for shop: ${shop.name}`)
                }

                if (shop.phone) {
                    await mockSMSProvider.send({ to: shop.phone, message: smsMessage })
                } else {
                    console.log(`⚠️ No phone number configured for SMS: ${shop.name}`)
                }

                // Log this action to the global audit log
                await supabase.from('audit_logs').insert({
                    actor_email: 'System Cron',
                    action_type: 'SEND_WARNING_NOTIFICATION',
                    target_type: 'SHOP',
                    target_id: shop.id.toString(),
                    details: { days_remaining: diffDays, notified_via: ['email', 'sms'] }
                })

                warningsSent++
            }
        }

        console.log(`\n✅ Finished checking subscriptions. Sent ${warningsSent} warnings.`)

    } catch (err) {
        console.error('Error during notification cron:', err)
    }
}

// Run the script
sendWarnings()
