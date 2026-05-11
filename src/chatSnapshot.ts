// Transcript snapshot persistence — IDB facade for chat.ts. Extracted
// 2026-05-11 for the Phase 1 / pre-notifications refactor (see
// docs/NOTIFICATIONS_REFACTOR_PLAN.md).
//
// Pure storage layer. No DOM access, no chat-state state. chat.ts
// owns the in-memory `viewedSessionIdRef` + `restoredViewedSessionId`
// and passes the session id into saveSnapshot() when persisting.
//
// Why split from chat.ts: the file was approaching 700 LOC with two
// orthogonal responsibilities — DOM rendering (line bubbles, speaker
// labels, copy buttons, scroll pinning) vs IDB snapshot serialization.
// Lifting the storage half keeps each file focused and lets the
// schema-fingerprint smoke (idb-schema-fingerprint.mjs) cover this
// module without dragging in the DOM half.
//
// Why IndexedDB rather than sessionStorage:
//   (a) sessionStorage caps at ~5MB on Safari — base64 attachments
//       push a busy chat over the limit and persist() silently
//       rolls back to the stale snapshot.
//   (b) sessionStorage vanishes when iOS evicts the PWA.
//   (c) sessionStorage doesn't survive a hard app-kill.
// IDB has GB-scale quota, survives tab close, and keeps the
// "reload always restores everything" invariant the user expects.

import { diag } from './util/log.ts';

const DB_NAME = 'sidekick-chat';
const STORE = 'transcripts';
const SNAPSHOT_KEY = 'current';

// Schema fingerprint. Bump SCHEMA_VERSION any time the on-disk format of
// snapshots, bubble dedup keys, or the dom-shape persisted via persist()
// would diverge between an older PWA bundle's writes and the current
// reader. On boot, a mismatch between the stored fingerprint and this
// constant triggers a one-shot IDB delete + reload-from-server. NO
// migration path — fresh state is correct. Clients on the old version
// get a single blank-transcript first paint (~200ms) then full server-
// driven rebuild.
//
// History:
//   2026-05-11 — current. Bubble dedup keyed by plugin-supplied
//                sidekick_id with integer fallback; control envelopes
//                (approval prompts, etc.) persist to state.db and arrive
//                through history fetch instead of the deprecated
//                IDB-only addSystemLine path.
const SCHEMA_VERSION = '2026-05-11';
const SCHEMA_VERSION_KEY = 'sidekick.idb-schema-version';

/** Snapshot record persisted to IDB. `html` is the serialized
 *  transcript DOM; `sessionId` is the chat the snapshot belongs to
 *  (so reload can re-seed the drawer highlight to the right row). */
export interface SnapshotRecord {
  html: string;
  sessionId?: string;
}

/** Detect a stale-schema IDB and nuke it. Runs once per page load,
 *  BEFORE the first dbOpen(). LocalStorage holds the last-known-good
 *  fingerprint; mismatch → indexedDB.deleteDatabase + write the new
 *  fingerprint. On the next dbOpen the fresh database is created
 *  cleanly. The reader path stays simple — no onupgradeneeded
 *  branches, no version-juggling logic to maintain.
 *
 *  Why localStorage for the fingerprint: synchronous read at boot
 *  means we can decide whether to nuke BEFORE any open(), avoiding
 *  the race where an in-flight tx blocks the delete. Browsers that
 *  evict localStorage (rare; Safari's 7-day inactivity case) will
 *  read undefined → trigger one extra nuke. Acceptable. */
export async function ensureSchemaFresh(): Promise<void> {
  let stored: string | null = null;
  try { stored = localStorage.getItem(SCHEMA_VERSION_KEY); } catch { /* private mode */ }
  if (stored === SCHEMA_VERSION) return;
  diag(`[chat] IDB schema ${stored ?? '(none)'} → ${SCHEMA_VERSION}: wiping cached transcript`);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();        // best-effort; ignore failures
    req.onblocked = () => resolve();      // some other tab holds it open
  });
  try { localStorage.setItem(SCHEMA_VERSION_KEY, SCHEMA_VERSION); } catch { /* private mode */ }
}

function dbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqP<T = any>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Read the current snapshot from IDB. Returns null on any error or
 *  missing record — callers fall through to a fresh server-driven
 *  rebuild. */
export async function loadSnapshot(): Promise<SnapshotRecord | null> {
  try {
    const db = await dbOpen();
    const rec = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(SNAPSHOT_KEY));
    db.close();
    if (rec?.html) return { html: rec.html, sessionId: rec.sessionId };
  } catch {}
  return null;
}

/** Persist a fresh snapshot. Idempotent overwrite — the IDB store
 *  has a fixed-key schema (`current`) so there's only ever one
 *  record. Caller passes the session id explicitly; this module
 *  doesn't track which chat is on screen. Throws are NOT caught here;
 *  the caller (chat.persist) attaches a .catch to log + swallow. */
export async function saveSnapshot(html: string, sessionId: string | null): Promise<void> {
  try {
    const db = await dbOpen();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).put({
      key: SNAPSHOT_KEY, html, sessionId: sessionId ?? undefined, at: Date.now(),
    }));
    db.close();
  } catch {}
}

/** Delete the snapshot (used by chat.clear during a New chat
 *  rotation). Best-effort; failures are swallowed. */
export async function clearSnapshot(): Promise<void> {
  try {
    const db = await dbOpen();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(SNAPSHOT_KEY));
    db.close();
  } catch {}
}
