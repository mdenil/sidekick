/**
 * @fileoverview IndexedDB-backed cache for the session drawer's list +
 * per-session transcripts. Makes tap-to-resume feel instant instead of
 * the 5-10s it was taking to round-trip through the server + SQL.
 *
 * Design:
 *   - One DB (sidekick-sessions), two stores:
 *     - 'list'     : keyed by 'current'      { sessions: SessionInfo[], updatedAt, schemaVersion }
 *     - 'messages' : keyed by conversation name { id, messages, updatedAt, schemaVersion }
 *   - sessionDrawer.refresh() reads the cached list first (instant render),
 *     then background-fetches from server + updates cache + re-renders.
 *   - sessionDrawer.resume() does the same for messages: replay cached
 *     transcript immediately, background-fetch to reconcile.
 *
 * Stale data is better than a 5s spinner. Background refresh catches up.
 * IDB writes are fire-and-forget; if they fail, the UI is unaffected —
 * next load just re-populates from server.
 *
 * Schema versioning (CACHE_SCHEMA_VERSION below): every cached record
 * carries a schemaVersion. On read, a mismatch is treated as a cache
 * miss + the bad entry is deleted. This lets us evolve the wire shape
 * — adding/removing fields on SessionInfo, message rows, etc. — without
 * having to ship a manual cache-clear or surface stale UI. Bumping the
 * constant is a build-time gate: a user upgrading the PWA past a bump
 * will see one slow-path load while the cache refills from the server.
 */

const DB_NAME = 'sidekick-sessions';
const LIST_STORE = 'list';
const MESSAGES_STORE = 'messages';
const DB_VERSION = 1;

// Bump on every wire-shape change to sessions OR messages cache records.
// Any cached entry without a matching schemaVersion is dropped on read.
//
//   v1 — initial. SessionInfo[] in list; raw message rows in messages.
//   v2 — bumped 2026-05-17 (Crack B of the turn-taking audit). No
//        actual shape change here — establishing the discard-on-
//        mismatch pattern. Future shape edits bump again.
export const CACHE_SCHEMA_VERSION = 2;

/** True when a stored cache record's shape is current. A missing or
 *  mismatched `schemaVersion` means the record was written by an older
 *  build — caller drops it and treats the read as a miss. Exported as
 *  a pure helper so tests can exercise the gate without the IDB
 *  plumbing. */
export function isCurrentCacheRecord(rec: any): boolean {
  return !!rec && typeof rec === 'object' && rec.schemaVersion === CACHE_SCHEMA_VERSION;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIST_STORE)) {
        db.createObjectStore(LIST_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function getListCache(): Promise<{ sessions: any[], updatedAt: number } | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(LIST_STORE, 'readwrite');
    const store = tx.objectStore(LIST_STORE);
    const rec = await reqP(store.get('current'));
    if (!isCurrentCacheRecord(rec)) {
      // Missing OR stale-shape from a previous build. Drop a present-
      // but-stale entry under the same transaction so the next put()
      // doesn't race in. Background fetch in refresh() repopulates.
      if (rec) { try { await reqP(store.delete('current')); } catch {} }
      db.close();
      return null;
    }
    db.close();
    return { sessions: rec.sessions, updatedAt: rec.updatedAt };
  } catch { return null; }
}

export async function putListCache(sessions: any[]): Promise<void> {
  try {
    const db = await openDB();
    await reqP(
      db.transaction(LIST_STORE, 'readwrite').objectStore(LIST_STORE)
        .put({ key: 'current', sessions, updatedAt: Date.now(), schemaVersion: CACHE_SCHEMA_VERSION })
    );
    db.close();
  } catch {}
}

export async function getMessagesCache(id: string): Promise<{ messages: any[], updatedAt: number } | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(MESSAGES_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGES_STORE);
    const rec = await reqP(store.get(id));
    if (!isCurrentCacheRecord(rec)) {
      if (rec) { try { await reqP(store.delete(id)); } catch {} }
      db.close();
      return null;
    }
    db.close();
    return { messages: rec.messages, updatedAt: rec.updatedAt };
  } catch { return null; }
}

export async function putMessagesCache(id: string, messages: any[]): Promise<void> {
  try {
    const db = await openDB();
    await reqP(
      db.transaction(MESSAGES_STORE, 'readwrite').objectStore(MESSAGES_STORE)
        .put({ id, messages, updatedAt: Date.now(), schemaVersion: CACHE_SCHEMA_VERSION })
    );
    db.close();
  } catch {}
}

/** Drop a cached transcript — called after rename/delete so stale previews
 *  don't linger. The list cache is always refetched after those ops too. */
export async function removeMessagesCache(id: string): Promise<void> {
  try {
    const db = await openDB();
    await reqP(db.transaction(MESSAGES_STORE, 'readwrite').objectStore(MESSAGES_STORE).delete(id));
    db.close();
  } catch {}
}

/** Drop the cached session list. Used when the user changes the filter —
 *  the cached list reflects the OLD filter, so refresh() would paint
 *  stale results until the background fetch lands. */
export async function clearListCache(): Promise<void> {
  try {
    const db = await openDB();
    await reqP(db.transaction(LIST_STORE, 'readwrite').objectStore(LIST_STORE).delete('current'));
    db.close();
  } catch {}
}
