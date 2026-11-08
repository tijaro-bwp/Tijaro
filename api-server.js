import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { Resend } from 'resend'
import { resolveBrand } from './src/config/brand.js'

dotenv.config()

const app = express()
const port = process.env.PORT || 3001

// Middleware
app.use(cors()) // Allow the React frontend to make requests
app.use(express.json()) // Parse JSON bodies

const resend = new Resend(process.env.RESEND_API_KEY)

// Simple health check route
app.get('/api/health', (req, res) => {
    res.json({ status: 'API Server is running successfully', resendKeyLoaded: !!process.env.RESEND_API_KEY })
})

// Dispatch email route
app.post('/api/send-email', async (req, res) => {
    const { to, subject, body } = req.body

    if (!to || !subject || !body) {
        return res.status(400).json({ error: 'Missing required fields: to, subject, body' })
    }

    // If no Resend API key, run in simulated "mock" mode
    if (!process.env.RESEND_API_KEY) {
        console.log(`\n📧 [MOCK EMAIL SENT to ${to}]`)
        console.log(`Subject: ${subject}`)
        console.log(`Body:\n${body}\n`)
        return res.json({ success: true, message: 'Simulated email sent successfully (No Resend Key found).' })
    }

    try {
        const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
        const response = await resend.emails.send({
            from: `${resolveBrand(process.env).appName} <${fromEmail}>`,
            to,
            subject,
            html: body
        })

        if (response.error) {
            console.error(`❌ Resend API Error for ${to}:`, response.error)
            return res.status(400).json({ success: false, error: response.error })
        }

        console.log(`\n📧 [REAL EMAIL SENT to ${to}] via Resend`, response.data)
        return res.json({ success: true, data: response.data })
    } catch (error) {
        console.error(`❌ Exception sending email via Resend to ${to}:`, error)
        return res.status(500).json({ error: 'Failed to send email via Resend', details: error.message })
    }
})

app.listen(port, () => {
    console.log(`🌐 ${resolveBrand(process.env).appName} API Server listening at http://localhost:${port}`)
})
