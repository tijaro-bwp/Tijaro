import Dexie from 'dexie';

export const db = new Dexie('SanitaryPOS_Local');

db.version(1).stores({
  products: 'id, name, brand, category_id, shop_id',
  categories: 'id, name, shop_id',
  suppliers: 'id, name, shop_id',
  customers: 'id, name, shop_id',
  sync_queue: '++id, table, action, data, timestamp'
});

db.version(2).stores({
  products: 'id, name, brand, category_id, shop_id',
  categories: 'id, name, shop_id',
  suppliers: 'id, name, shop_id',
  customers: 'id, name, shop_id',
  sync_queue: '++id, table, action, data, timestamp',
  audit_logs: '++id, action, entity, entity_id, user_id, timestamp',
  held_carts: '++id, customer_id, shop_id, saved_at'
});

db.version(6).stores({
  products: 'id, name, brand, category_id, shop_id',
  categories: 'id, name, shop_id',
  suppliers: 'id, name, shop_id',
  customers: 'id, name, shop_id',
  brands: 'id, name, shop_id',
  sales: 'id, customer_id, shop_id, created_at',
  sale_items: 'id, sale_id, product_id',
  purchases: 'id, supplier_id, shop_id, created_at',
  purchase_items: 'id, purchase_id, product_id',
  expenses: 'id, category, shop_id, date',
  users: 'id, username, shop_id, role',
  shops: 'id, name',
  customer_payments: 'id, customer_id, shop_id, created_at',
  supplier_payments: 'id, supplier_id, shop_id, created_at',
  sync_queue: '++id, table, action, data, timestamp',
  audit_logs: '++id, action, entity, entity_id, user_id, timestamp',
  held_carts: '++id, customer_id, shop_id, saved_at'
});

db.version(7).stores({
  products: 'id, name, brand, category_id, shop_id',
  categories: 'id, name, shop_id',
  suppliers: 'id, name, shop_id',
  customers: 'id, name, shop_id',
  brands: 'id, name, shop_id',
  sales: 'id, customer_id, shop_id, created_at',
  sale_items: 'id, sale_id, product_id',
  purchases: 'id, supplier_id, shop_id, created_at',
  purchase_items: 'id, purchase_id, product_id',
  expenses: 'id, category, shop_id, date',
  users: 'id, username, shop_id, role',
  shops: 'id, name',
  customer_payments: 'id, customer_id, shop_id, created_at',
  supplier_payments: 'id, supplier_id, shop_id, created_at',
  sync_queue: '++id, table, action, data, timestamp',
  audit_logs: '++id, action, entity, entity_id, user_id, timestamp',
  held_carts: '++id, customer_id, shop_id, saved_at',
  trash: '++id, original_table, original_id, shop_id, deleted_at, deleted_by'
});

db.version(8).stores({
  products: 'id, name, brand, category_id, shop_id',
  categories: 'id, name, shop_id',
  suppliers: 'id, name, shop_id',
  customers: 'id, name, shop_id',
  brands: 'id, name, shop_id',
  sales: 'id, customer_id, shop_id, created_at',
  sale_items: 'id, sale_id, product_id',
  purchases: 'id, supplier_id, shop_id, created_at',
  purchase_items: 'id, purchase_id, product_id',
  expenses: 'id, category, shop_id, date',
  users: 'id, username, shop_id, role',
  shops: 'id, name',
  customer_payments: 'id, customer_id, shop_id, created_at',
  supplier_payments: 'id, supplier_id, shop_id, created_at',
  sync_queue: '++id, table, action, data, timestamp',
  audit_logs: '++id, action, entity, entity_id, user_id, timestamp',
  held_carts: '++id, customer_id, shop_id, saved_at',
  trash: '++id, original_table, original_id, shop_id, deleted_at, deleted_by'
});

// v9: audit_logs switches from auto-int PK (++id) to UUID PK (id)
// so syncService can strip it before Supabase INSERT (BIGSERIAL generates its own)
db.version(9).stores({
  products: 'id, name, brand, category_id, shop_id',
  categories: 'id, name, shop_id',
  suppliers: 'id, name, shop_id',
  customers: 'id, name, shop_id',
  brands: 'id, name, shop_id',
  sales: 'id, customer_id, shop_id, created_at',
  sale_items: 'id, sale_id, product_id',
  purchases: 'id, supplier_id, shop_id, created_at',
  purchase_items: 'id, purchase_id, product_id',
  expenses: 'id, category, shop_id, date',
  users: 'id, username, shop_id, role',
  shops: 'id, name',
  customer_payments: 'id, customer_id, shop_id, created_at',
  supplier_payments: 'id, supplier_id, shop_id, created_at',
  sync_queue: '++id, table, action, data, timestamp',
  audit_logs: 'id, action, entity, entity_id, user_id, shop_id, timestamp',
  held_carts: '++id, customer_id, shop_id, saved_at',
  trash: '++id, original_table, original_id, shop_id, deleted_at, deleted_by'
});

// v10: brand_categories junction table for brand-category linking
db.version(10).stores({
  products: 'id, name, brand, category_id, shop_id',
  categories: 'id, name, shop_id',
  suppliers: 'id, name, shop_id',
  customers: 'id, name, shop_id',
  brands: 'id, name, shop_id',
  sales: 'id, customer_id, shop_id, created_at',
  sale_items: 'id, sale_id, product_id',
  purchases: 'id, supplier_id, shop_id, created_at',
  purchase_items: 'id, purchase_id, product_id',
  expenses: 'id, category, shop_id, date',
  users: 'id, username, shop_id, role',
  shops: 'id, name',
  customer_payments: 'id, customer_id, shop_id, created_at',
  supplier_payments: 'id, supplier_id, shop_id, created_at',
  sync_queue: '++id, table, action, data, timestamp',
  audit_logs: 'id, action, entity, entity_id, user_id, shop_id, timestamp',
  held_carts: '++id, customer_id, shop_id, saved_at',
  trash: '++id, original_table, original_id, shop_id, deleted_at, deleted_by',
  brand_categories: '++id, brand_id, category_id, shop_id'
});

// v11: units table for product unit-of-measure (Piece, Kg, Feet, etc.)
db.version(11).stores({
  products: 'id, name, brand, category_id, shop_id',
  categories: 'id, name, shop_id',
  suppliers: 'id, name, shop_id',
  customers: 'id, name, shop_id',
  brands: 'id, name, shop_id',
  sales: 'id, customer_id, shop_id, created_at',
  sale_items: 'id, sale_id, product_id',
  purchases: 'id, supplier_id, shop_id, created_at',
  purchase_items: 'id, purchase_id, product_id',
  expenses: 'id, category, shop_id, date',
  users: 'id, username, shop_id, role',
  shops: 'id, name',
  customer_payments: 'id, customer_id, shop_id, created_at',
  supplier_payments: 'id, supplier_id, shop_id, created_at',
  sync_queue: '++id, table, action, data, timestamp',
  audit_logs: 'id, action, entity, entity_id, user_id, shop_id, timestamp',
  held_carts: '++id, customer_id, shop_id, saved_at',
  trash: '++id, original_table, original_id, shop_id, deleted_at, deleted_by',
  brand_categories: '++id, brand_id, category_id, shop_id',
  units: '++id, name, abbreviation, shop_id'
});

export const addToSyncQueue = async (table, action, data) => {
  await db.sync_queue.add({
    table,
    action,
    data,
    timestamp: new Date().toISOString()
  });
};

export const moveToTrash = async (table, originalId, data, userId, shopId) => {
  await db.trash.add({
    original_table: table,
    original_id: originalId,
    data: JSON.parse(JSON.stringify(data)),
    shop_id: shopId,
    deleted_by: userId,
    deleted_at: new Date().toISOString()
  });
};

export const restoreFromTrash = async (trashItem) => {
  const { original_table, data } = trashItem;
  if (db[original_table]) {
    await db[original_table].put(data);
  }
  await db.trash.delete(trashItem.id);
};

// ── Schema-conflict recovery ─────────────────────────────────────────
// A version conflict (e.g. after rolling back to an older build) used to delete
// the whole local database — including unsynced offline sales. Now the pending
// sync queue is saved to localStorage first and re-queued after the rebuild.
const QUEUE_BACKUP_KEY = 'edgex_sync_queue_backup'

async function backupQueueBeforeRebuild() {
  try {
    const raw = new Dexie('SanitaryPOS_Local') // dynamic mode: opens whatever schema exists
    await raw.open()
    const table = raw.tables.find(t => t.name === 'sync_queue')
    const items = table ? await table.toArray() : []
    raw.close()
    if (items.length > 0) {
      const prev = JSON.parse(localStorage.getItem(QUEUE_BACKUP_KEY) || '[]')
      localStorage.setItem(QUEUE_BACKUP_KEY, JSON.stringify([...prev, ...items]))
    }
    return true
  } catch (e) {
    console.error('Could not back up sync queue before rebuild', e)
    return false
  }
}

async function restoreQueueBackup() {
  let items = []
  try { items = JSON.parse(localStorage.getItem(QUEUE_BACKUP_KEY) || '[]') } catch { items = [] }
  if (!items.length) return
  // eslint-disable-next-line no-unused-vars
  await db.sync_queue.bulkAdd(items.map(({ id, ...rest }) => rest))
  localStorage.removeItem(QUEUE_BACKUP_KEY)
  console.warn(`Restored ${items.length} unsynced action(s) after local database rebuild.`)
}

db.open().then(restoreQueueBackup).catch(async (err) => {
  if (err.name === 'UpgradeError' || err.name === 'VersionError') {
    console.warn('Detected local database schema conflict. Rebuilding database...', err);
    const saved = await backupQueueBeforeRebuild()
    if (!saved) {
      // Do not destroy unsynced data we could not save
      alert('Local data could not be upgraded safely. Please contact support before clearing browser data.')
      return
    }
    await db.delete();
    window.location.reload();
  }
});
