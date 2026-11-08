import { db } from './db'
import { adminCall } from './adminApi'

/**
 * Records a shop-level audit log entry locally in Dexie and prepares it for offline sync.
 * @param {string} action - e.g., 'UPDATE', 'DELETE', 'PRICE_CHANGE'
 * @param {string} entity - e.g., 'products', 'sales'
 * @param {string|number} entityId - ID of the affected record
 * @param {object} details - Any additional info (old/new values, etc.)
 * @param {string} userId - ID of the user performing the action
 * @param {string} shopId - ID of the shop
 */
export const recordAuditLog = async (action, entity, entityId, details, userId, shopId) => {
  const logEntry = {
    id: crypto.randomUUID(), // UUID so syncService strips it before Supabase INSERT (BIGSERIAL PK)
    action,
    action_type: action, // satisfy DB NOT NULL constraint
    entity,
    entity_id: String(entityId),
    details,
    user_id: userId,
    shop_id: shopId,
    timestamp: new Date().toISOString()
  }

  try {
    // 1. Record in local Dexie DB
    if (db?.audit_logs) {
      await db.audit_logs.add(logEntry)
    }

    // 2. Add to sync queue to upload to Supabase
    if (db?.sync_queue) {
      await db.sync_queue.add({
        table: 'audit_logs',
        action: 'INSERT',
        data: logEntry,
        timestamp: logEntry.timestamp
      })
    }

    console.log(`[Audit] Recorded: ${action} on ${entity} (${entityId})`)
  } catch (error) {
    console.error('[Audit] Failed to record log:', error)
  }
}

/**
 * Logs an action to the global platform audit_logs table (Superadmin operations).
 * 
 * @param {Object} params
 * @param {string} params.action_type - e.g. 'SUSPEND_SHOP', 'UPDATE_BILLING', 'ACTIVATE_SHOP'
 * @param {string} params.target_type - e.g. 'SHOP', 'SUBSCRIPTION', 'SYSTEM'
 * @param {string} params.target_id - ID of the shop or entity being modified
 * @param {Object} params.details - Additional json context
 */
export const logAction = async ({
  action_type,
  target_type,
  target_id = null,
  details = {}
}) => {
  // The actor is taken from the verified superadmin session server-side
  // (admin-api Edge Function); any actor_id/actor_email passed here is ignored.
  try {
    const { error } = await adminCall('log_action', {
      action_type,
      target_type,
      target_id: target_id?.toString() || null,
      details
    })
    if (error) {
      console.error('Failed to write audit log:', error.message)
    }
  } catch (err) {
    console.error('Audit Log Exception:', err)
  }
}
