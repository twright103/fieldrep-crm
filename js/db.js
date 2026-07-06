// db.js — the local IndexedDB cache. The full dataset lives here so every
// view renders instantly from local data; the network is only for sync.
// Plain IndexedDB with a small promise wrapper — no libraries.

const DB_NAME = 'fieldrep';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const companies = db.createObjectStore('companies', { keyPath: 'id' });
      companies.createIndex('name', 'name');
      const contacts = db.createObjectStore('contacts', { keyPath: 'id' });
      contacts.createIndex('companyId', 'companyId');
      const activities = db.createObjectStore('activities', { keyPath: 'id' });
      activities.createIndex('companyId', 'companyId');
      activities.createIndex('followUpDate', 'followUpDate');
      db.createObjectStore('kv'); // lastSync timestamp, settings
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function kvGet(key) {
  const db = await openDb();
  return reqAsPromise(tx(db, 'kv', 'readonly').get(key));
}

export async function kvSet(key, value) {
  const db = await openDb();
  return reqAsPromise(tx(db, 'kv', 'readwrite').put(value, key));
}

export async function getAll(store) {
  const db = await openDb();
  return reqAsPromise(tx(db, store, 'readonly').getAll());
}

export async function getById(store, id) {
  const db = await openDb();
  return reqAsPromise(tx(db, store, 'readonly').get(id));
}

export async function getByIndex(store, index, value) {
  const db = await openDb();
  return reqAsPromise(tx(db, store, 'readonly').index(index).getAll(value));
}

export async function putRow(store, row) {
  const db = await openDb();
  return reqAsPromise(tx(db, store, 'readwrite').put(row));
}

export async function deleteRow(store, id) {
  const db = await openDb();
  return reqAsPromise(tx(db, store, 'readwrite').delete(id));
}

/**
 * Applies one table's worth of synced rows in a single transaction.
 * Soft-deleted rows are removed locally (the server keeps the tombstone;
 * the cache only ever holds live rows).
 */
export async function applyRows(store, rows) {
  if (!rows || !rows.length) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const row of rows) {
      if (row.deleted === 'TRUE') os.delete(row.id);
      else os.put(row);
    }
    t.oncomplete = () => resolve(rows.length);
    t.onerror = () => reject(t.error);
  });
}

/** Wipes all cached data (Settings → "Reload everything"). */
export async function clearAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['companies', 'contacts', 'activities', 'kv'], 'readwrite');
    for (const s of ['companies', 'contacts', 'activities', 'kv']) t.objectStore(s).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function counts() {
  const db = await openDb();
  const [companies, contacts, activities] = await Promise.all([
    reqAsPromise(tx(db, 'companies', 'readonly').count()),
    reqAsPromise(tx(db, 'contacts', 'readonly').count()),
    reqAsPromise(tx(db, 'activities', 'readonly').count()),
  ]);
  return { companies, contacts, activities };
}
