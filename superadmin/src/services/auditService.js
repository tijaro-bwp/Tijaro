import { supabaseAdmin } from './supabase'

/**
 * Logs an action to the global audit_logs table.
 * 
 * @param {Object} params
 * @param {string} params.actor_id - ID of the admin performing the action
 * @param {string} params.actor_email - Email of the admin
 * @param {string} params.action_type - e.g. 'SUSPEND_SHOP', 'UPDATE_BILLING', 'ACTIVATE_SHOP'
 * @param {string} params.target_type - e.g. 'SHOP', 'SUBSCRIPTION', 'SYSTEM'
 * @param {string} params.target_id - ID of the shop or entity being modified
 * @param {Object} params.details - Additional json context
 */
export const logAction = async ({
    actor_id,
    actor_email,
    action_type,
    target_type,
    target_id = null,
    details = {}
}) => {
    try {
        // We attempt to get IP or user-agent context if possible, but it's optional
        // from the client side.
        const { error } = await supabaseAdmin
            .from('audit_logs')
            .insert({
                actor_id,
                actor_email,
                action_type,
                target_type,
                target_id: target_id?.toString() || null,
                details,
                ip_address: 'Client-Side' // Or fetch via a public API if needed
            })

        if (error) {
            console.error('Failed to write audit log:', error.message)
        }
    } catch (err) {
        console.error('Audit Log Exception:', err)
    }
}
