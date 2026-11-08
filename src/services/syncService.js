import { db } from './db';
import { supabase } from './supabase';
import { isTempId, runDeltaRpc, isMissingColumn } from './integrity';

// Tables that only exist locally and should NOT be synced to Supabase
const LOCAL_ONLY_TABLES = ['held_carts', 'held_purchases']
// Note: audit_logs intentionally removed — they now sync to Supabase;

const MAX_RETRIES = 5
// Optional columns an un-migrated database may not have yet
const OPTIONAL_COLUMNS = {
    sales: ['online_provider', 'transaction_ref', 'price_tier', 'client_ref'],
    purchases: ['client_ref'],
}

// A payload that still references an unsynced record (temp UUID in a *_id field
// or RPC param) must wait until that parent record has synced. Retrying it now
// would fail with "invalid integer" and used to get the row deleted.
function hasUnresolvedRef(obj) {
    if (!obj || typeof obj !== 'object') return false
    if (Array.isArray(obj)) return obj.some(hasUnresolvedRef)
    return Object.entries(obj).some(([k, v]) =>
        (k !== 'id' && k !== 'client_ref' && (k.endsWith('_id') || k.startsWith('p_')) && isTempId(String(v ?? ''))) ||
        (v && typeof v === 'object' && hasUnresolvedRef(v))
    )
}

function stripColumns(payload, cols) {
    const strip = (o) => { const c = { ...o }; cols.forEach(k => delete c[k]); return c }
    return Array.isArray(payload) ? payload.map(strip) : strip(payload)
}

// Single-flight: the 30s timer, the `online` event and the Settings "Sync" button
// used to overlap and upload the same queued sale twice.
let inFlight = null

export const syncOfflineData = () => {
    if (inFlight) return inFlight
    const run = async () => {
        // Also serialise across browser tabs where supported
        if (typeof navigator !== 'undefined' && navigator.locks?.request) {
            return navigator.locks.request('edgex-sync-queue', { ifAvailable: true }, async (lock) => {
                if (!lock) return
                await processQueue()
            })
        }
        return processQueue()
    }
    inFlight = run().finally(() => { inFlight = null })
    return inFlight
}

async function markFailure(item, error, { permanent = false } = {}) {
    const retries = (item.retry_count || 0) + 1
    const message = error?.message || String(error || 'Unknown error')
    if (permanent || retries >= MAX_RETRIES) {
        // Never delete business data silently: park it for review/retry in Settings → Data & Backup
        console.warn(`Sync: parking item ${item.id} (${item.table} ${item.action}) after ${retries} attempt(s): ${message}`)
        await db.sync_queue.update(item.id, { retry_count: retries, failed: true, last_error: message, failed_at: new Date().toISOString() })
    } else {
        await db.sync_queue.update(item.id, { retry_count: retries, last_error: message })
    }
}

async function cascadeIdChange(currentItemId, oldId, newId) {
    const remainingQueue = await db.sync_queue.toArray()
    for (const qItem of remainingQueue) {
        if (qItem.id === currentItemId) continue
        let updated = false
        const updateRefs = (obj) => {
            if (!obj || typeof obj !== 'object') return obj
            if (Array.isArray(obj)) {
                return obj.map(o => {
                    const res = updateRefs(o)
                    if (res !== o) updated = true
                    return res
                })
            }
            const copy = { ...obj }
            for (const k in copy) {
                if (copy[k] === oldId) {
                    copy[k] = newId
                    updated = true
                } else if (copy[k] && typeof copy[k] === 'object') {
                    const res = updateRefs(copy[k])
                    if (res !== copy[k]) {
                        copy[k] = res
                        updated = true
                    }
                }
            }
            return copy
        }
        const newPayload = updateRefs(qItem.data)
        if (updated) await db.sync_queue.update(qItem.id, { data: newPayload })
    }
}

async function processQueue() {
    if (!navigator.onLine) return;

    const queue = await db.sync_queue.toArray();
    if (queue.length === 0) return;

    // Filter out local-only table entries and parked (failed) items
    const syncable = [];
    for (const item of queue) {
        if (LOCAL_ONLY_TABLES.includes(item.table)) {
            await db.sync_queue.delete(item.id);
        } else if (!item.failed) {
            syncable.push(item);
        }
    }

    if (syncable.length === 0) return;
    console.log(`Syncing ${syncable.length} offline actions...`);

    const idMapping = {}; // Maps offline string UUIDs to real DB numeric IDs

    for (const item of syncable) {
        try {
            // Helper to recursively replace UUIDs in the payload with real IDs
            const replaceIds = (obj) => {
                if (!obj || typeof obj !== 'object') return obj;
                if (Array.isArray(obj)) return obj.map(replaceIds);
                const newObj = { ...obj };
                for (const key in newObj) {
                    if (typeof newObj[key] === 'string' && idMapping[newObj[key]]) {
                        newObj[key] = idMapping[newObj[key]];
                    } else if (newObj[key] && typeof newObj[key] === 'object') {
                        newObj[key] = replaceIds(newObj[key]);
                    }
                }
                return newObj;
            };

            // Re-read: an earlier item in this run may have rewritten this payload's ids
            const fresh = await db.sync_queue.get(item.id)
            if (!fresh) continue
            let processedData = replaceIds(fresh.data);

            // Parent record not synced yet → wait (no retry penalty)
            const payloadForRefCheck = item.action === 'INSERT'
                ? (Array.isArray(processedData) ? processedData.map(({ id: _i, ...rest }) => rest) : (({ id: _i, ...rest }) => rest)(processedData))
                : processedData
            if (hasUnresolvedRef(payloadForRefCheck)) {
                continue
            }

            // Satisfy Supabase NOT NULL constraint for action_type in audit_logs
            if (item.table === 'audit_logs') {
                if (Array.isArray(processedData)) {
                    processedData = processedData.map(d => ({
                        ...d,
                        action_type: d.action_type || d.action || 'UNKNOWN'
                    }));
                } else {
                    processedData = {
                        ...processedData,
                        action_type: processedData.action_type || processedData.action || 'UNKNOWN'
                    };
                }
            }

            let error;
            let returnedData = null;

            if (item.action === 'RPC') {
                // Atomic stock / balance change (see services/integrity.js)
                const res = await runDeltaRpc(item.table, processedData)
                if (res.ok) {
                    await db.sync_queue.delete(item.id)
                } else if (res.network) {
                    break // connection dropped — stop and keep the rest in order
                } else {
                    await markFailure(item, res.error)
                }
                continue
            }

            if (item.action === 'INSERT') {
                const isArray = Array.isArray(processedData);
                const stripTempId = (d) => {
                    const obj = { ...d };
                    if (typeof obj.id === 'string' && obj.id.includes('-')) delete obj.id;
                    return obj;
                };
                let payload = isArray ? processedData.map(stripTempId) : stripTempId(processedData);

                let { data: resData, error: err } = await supabase.from(item.table).insert(payload).select();

                // Optional columns not migrated yet → retry without them
                const optional = OPTIONAL_COLUMNS[item.table]
                if (err && optional && (isMissingColumn(err) || optional.some(c => err.message?.includes(c)))) {
                    console.warn(`SyncService: retrying ${item.table} insert without optional columns (${optional.join(', ')})`);
                    payload = stripColumns(payload, optional)
                    ;({ data: resData, error: err } = await supabase.from(item.table).insert(payload).select());
                }

                // Duplicate client_ref → the row already reached the server earlier (lost response). Reuse it.
                if (err && err.code === '23505' && !isArray && payload.client_ref) {
                    const { data: existing } = await supabase.from(item.table).select('*').eq('client_ref', payload.client_ref).maybeSingle()
                    if (existing) {
                        console.warn(`SyncService: ${item.table} already saved (client_ref ${payload.client_ref}); reusing it.`)
                        err = null
                        resData = [existing]
                    }
                }

                error = err;
                returnedData = resData;

                if (!error && returnedData) {
                    if (isArray) {
                        const originalIds = processedData.map(d => d.id).filter(id => typeof id === 'string' && id.includes('-'));
                        if (originalIds.length > 0) {
                            await db[item.table].bulkDelete(originalIds);
                        }
                        await db[item.table].bulkPut(returnedData);
                    } else {
                        const oldId = fresh.data.id;
                        if (typeof oldId === 'string' && oldId.includes('-')) {
                            await db[item.table].delete(oldId);
                            const newId = returnedData[0].id;
                            await db[item.table].put(returnedData[0]);
                            // Cascade ID update in remaining sync queue entries
                            await cascadeIdChange(item.id, oldId, newId)
                            // Keep in-memory mapping as backup for current sync run
                            idMapping[oldId] = newId;
                        } else {
                            await db[item.table].put(returnedData[0]);
                        }
                    }
                }
            } else if (item.action === 'UPDATE') {
                const dataObj = Array.isArray(processedData) ? processedData[0] : processedData;
                const { id, ...updateData } = dataObj || {};
                if (id == null) {
                    await markFailure(item, new Error('UPDATE without id'), { permanent: true })
                    continue;
                }
                ({ error } = await supabase.from(item.table).update(updateData).eq('id', id));
            } else if (item.action === 'DELETE') {
                const dataObj = Array.isArray(processedData) ? processedData[0] : processedData;
                if (dataObj?.id == null) {
                    await markFailure(item, new Error('DELETE without id'), { permanent: true })
                    continue;
                }
                ({ error } = await supabase.from(item.table).delete().eq('id', dataObj.id));
            }

            if (!error) {
                await db.sync_queue.delete(item.id);
            } else {
                console.error(`Sync error for ${item.table}:`, error);
                if (/Failed to fetch|NetworkError|Load failed/i.test(error.message || '')) break
                // Schema / type errors will not fix themselves → park immediately (kept for review, not deleted)
                const permanent = ['PGRST205', '42P01', 'PGRST204', '22P02', '23502', '23503'].includes(error.code)
                await markFailure(item, error, { permanent })
            }
        } catch (e) {
            console.error('Sync failed:', e);
        }
    }

    try {
        window.dispatchEvent(new CustomEvent('sync_completed'));
    } catch (_) {}
}

// ── Queue status / recovery (Settings → Data & Backup) ─────────────
export async function getSyncQueueStatus() {
    const all = await db.sync_queue.toArray()
    const failed = all.filter(i => i.failed)
    return { pending: all.length - failed.length, failed: failed.length, failedItems: failed }
}

export async function retryFailedSyncItems() {
    const failed = (await db.sync_queue.toArray()).filter(i => i.failed)
    for (const item of failed) {
        await db.sync_queue.update(item.id, { failed: false, retry_count: 0 })
    }
    return syncOfflineData()
}

// Periodically check for sync if online
setInterval(syncOfflineData, 30000);

window.addEventListener('online', syncOfflineData);
