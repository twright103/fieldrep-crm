// sync.js — keeps the local IndexedDB cache in step with the Google Sheet.
//
// Model (spec §5/§6.3):
//   - first ever load: fullExport  -> cache everything, remember serverTime
//   - every launch/foreground/after-write: sync?since=lastSync -> apply deltas
//   - the server's clock is the only clock: "since" is always the serverTime
//     the server itself returned last time (no device-clock skew problems).

import { api } from './api.js';
import { applyRows, kvGet, kvSet } from './db.js';
import { flushOutbox } from './writes.js';

const LAST_SYNC = 'lastSync';

export const syncState = {
  running: false,
  lastError: null,
  progress: '',      // human-readable first-load progress, e.g. "Companies 1600/2720"
  listeners: new Set(),
};

function notify() {
  for (const fn of syncState.listeners) fn();
}

export function onSyncChange(fn) {
  syncState.listeners.add(fn);
  return () => syncState.listeners.delete(fn);
}

export async function lastSyncTime() {
  return (await kvGet(LAST_SYNC)) || '';
}

/** First-run download of the entire database. */
export async function fullLoad() {
  syncState.running = true;
  syncState.lastError = null;
  notify();
  try {
    await fullLoadInner();
  } catch (err) {
    syncState.lastError = err.message;
    throw err;
  } finally {
    syncState.running = false;
    syncState.progress = '';
    notify();
  }
}

/** Incremental sync. Quietly does nothing useful if never fully loaded. */
export async function syncNow() {
  if (syncState.running) return false;
  syncState.running = true;
  syncState.lastError = null;
  notify();
  try {
    await flushOutbox(); // push queued offline writes BEFORE pulling changes
    const since = await lastSyncTime();
    if (!since) {
      await fullLoadInner();
    } else {
      const data = await api('sync', { since });
      await applyRows('companies', data.changes.Companies);
      await applyRows('contacts', data.changes.Contacts);
      await applyRows('activities', data.changes.Activities);
      await kvSet(LAST_SYNC, data.serverTime);
    }
    return true;
  } catch (err) {
    syncState.lastError = err.message;
    return false;
  } finally {
    syncState.running = false;
    notify();
  }
}

// The actual download, in chunks: one multi-megabyte fullExport response is
// unreliable through Apps Script's redirect delivery (especially on phones),
// so we pull a few hundred rows per request instead. The sync bookmark is the
// serverTime of the FIRST chunk — anything edited mid-download re-syncs.
async function fullLoadInner() {
  const CHUNK = 800;
  const TABLES = [['Companies', 'companies'], ['Contacts', 'contacts'], ['Activities', 'activities']];
  let bookmark = null;
  for (const [table, store] of TABLES) {
    let offset = 0, total = Infinity;
    while (offset < total) {
      const data = await api('exportChunk', { table, offset, limit: CHUNK });
      if (bookmark === null) bookmark = data.serverTime;
      total = data.total;
      await applyRows(store, data.rows);
      offset += data.rows.length;
      syncState.progress = `${table} ${Math.min(offset, total)}/${total}`;
      notify();
      if (!data.rows.length) break; // safety: server returned an empty slice
    }
  }
  const metaResp = await api('getMeta').catch(() => null);
  if (metaResp) await kvSet('meta', metaResp.meta || {});
  await kvSet(LAST_SYNC, bookmark);
}

/** Fire-and-forget background sync (used after writes and on foreground). */
export function syncSoon() {
  setTimeout(() => { syncNow(); }, 250);
}
