// writes.js — offline-aware writes (spec §14 Phase 5).
//
// Every save is applied to the local IndexedDB cache FIRST (so the UI is
// always right), then sent to the backend. If the network is down, the
// request goes into the outbox and is replayed — in order — the next time
// we're online. Creates carry a client-generated UUID, and the backend
// deduplicates on id, so a replayed create can never make a second copy.

import { api } from './api.js';
import { putRow, deleteRow, getById, outboxAdd, outboxAll, outboxDelete, outboxCount } from './db.js';

const STORE_FOR = { Companies: 'companies', Contacts: 'contacts', Activities: 'activities' };

function nowIso() { return new Date().toISOString(); }

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/**
 * Create a row. Returns { row, queued }. `queued` true = saved locally,
 * waiting for signal; false = confirmed by the server.
 */
export async function createLocal(table, fields) {
  const row = { ...fields, id: fields.id || newId() };
  row.createdAt = row.createdAt || nowIso();
  row.updatedAt = nowIso();
  if (!row.deleted) row.deleted = 'FALSE';
  await putRow(STORE_FOR[table], row);
  try {
    const resp = await api('create', { table, row });
    if (resp.row) await putRow(STORE_FOR[table], resp.row); // server's authoritative copy
    return { row: resp.row || row, queued: false };
  } catch (err) {
    if (err.kind !== 'network') { await deleteRow(STORE_FOR[table], row.id); throw err; }
    await outboxAdd({ action: 'create', table, payload: row });
    return { row, queued: true };
  }
}

/** Partial update by patch.id. Returns { row, queued }. */
export async function updateLocal(table, patch) {
  const store = STORE_FOR[table];
  const current = await getById(store, patch.id);
  const merged = { ...(current || {}), ...patch, updatedAt: nowIso() };
  await putRow(store, merged);
  try {
    const resp = await api('update', { table, row: patch });
    if (resp.row) await putRow(store, resp.row);
    return { row: resp.row || merged, queued: false };
  } catch (err) {
    if (err.kind !== 'network') { if (current) await putRow(store, current); throw err; }
    await outboxAdd({ action: 'update', table, payload: patch });
    return { row: merged, queued: true };
  }
}

/** Soft delete. Returns { queued }. */
export async function deleteLocal(table, id) {
  const store = STORE_FOR[table];
  const current = await getById(store, id);
  await deleteRow(store, id);
  try {
    await api('softDelete', { table, id });
    return { queued: false };
  } catch (err) {
    if (err.kind !== 'network') { if (current) await putRow(store, current); throw err; }
    await outboxAdd({ action: 'softDelete', table, payload: { id } });
    return { queued: true };
  }
}

/**
 * Replay queued writes, oldest first. Stops (keeps the rest) on the first
 * network failure; drops an entry (with a console note) if the server
 * permanently rejects it. Returns how many are still waiting.
 */
let flushing = false;
export async function flushOutbox() {
  if (flushing) return outboxCount();
  flushing = true;
  try {
    const items = (await outboxAll()).sort((a, b) => a.qid - b.qid);
    for (const item of items) {
      try {
        if (item.action === 'create') {
          const resp = await api('create', { table: item.table, row: item.payload });
          if (resp.row) await putRow(STORE_FOR[item.table], resp.row);
          // a company created offline never got geocoded — do it now
          if (item.table === 'Companies' && !(resp.row && resp.row.lat)) api('geocode', { id: item.payload.id }).catch(() => {});
        } else if (item.action === 'update') {
          const resp = await api('update', { table: item.table, row: item.payload });
          if (resp.row) await putRow(STORE_FOR[item.table], resp.row);
        } else if (item.action === 'softDelete') {
          await api('softDelete', { table: item.table, id: item.payload.id });
        }
        await outboxDelete(item.qid);
      } catch (err) {
        if (err.kind === 'network') break; // still offline — try again later
        console.warn('outbox entry rejected by server, dropping:', item, err.message);
        await outboxDelete(item.qid);
      }
    }
  } finally {
    flushing = false;
  }
  return outboxCount();
}

export { outboxCount };
