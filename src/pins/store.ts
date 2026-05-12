// Pinned-messages store — IDB-backed list of messages the user has
// flagged as "keep this around, I want to come back to it."
//
// Why this isn't part of badge.ts / unreadStore.ts: pins are a
// completely orthogonal concept. Unread is an *attention* signal
// (something new I haven't seen); pin is a *retention* signal
// (something I deliberately want to keep). Different data model,
// different UX surface, different aggregation queries.
//
// Storage:
//   - DB: sidekick.pins
//   - Store: "items" — keyed by `${chatId}|${msgId}` (composite primary)
//   - Indexes:
//       byChat   — group all pins for a chat
//       byPinAt  — sort all pins newest-first across chats (this is
//                  what the right-side pin drawer reads)
//
// Why composite primary key and not just msgId: msgIds are reused
// across chats in our system (sidekick mints `umsg_` ids per chat,
// other channels may collide). `chatId|msgId` is unambiguous.
//
// Cross-device sync is NOT implemented in this iteration. Pins are
// local to the device. v2 would persist via a hermes plugin column
// on the message row (analogous to how chat mutes ride config.yaml).
// Documented as a follow-up so it's not forgotten.

import { log } from '../util/log.ts';

const DB_NAME = 'sidekick.pins';
const STORE = 'items';

export interface PinnedItem {
  chatId: string;
  msgId: string;
  role: string;       // 'user' / 'assistant' / 'system' — drives the row glyph in the drawer
  text: string;       // body preview, truncated upstream if needed
  timestamp: number;  // message wall-clock time (for display in the drawer)
  pinnedAt: number;   // when the user pinned it (for sort order)
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ['chatId', 'msgId'] });
        store.createIndex('byChat', 'chatId', { unique: false });
        store.createIndex('byPinAt', 'pinnedAt', { unique: false });
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

// In-memory mirror — sessionDrawer's row repaint + chat.ts's bubble
// render both need a SYNC isPinned() check on every paint, so the
// store must resolve queries without awaiting IDB. Hydrated once on
// boot; mutations write IDB async + update the mirror immediately
// so the UI reflects the click instantly.
const pinsByKey = new Map<string, PinnedItem>();
let hydrated = false;

const key = (chatId: string, msgId: string) => `${chatId}|${msgId}`;

/** Restore the persisted pin set on boot. Idempotent. Caller (init
 *  path) should await before the first chat render so bubbles paint
 *  with `.pinned` on the first frame instead of flashing in. */
export async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const db = await open();
    const all = await reqP<PinnedItem[]>(
      db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as any,
    );
    db.close();
    for (const item of all || []) {
      if (item?.chatId && item?.msgId) pinsByKey.set(key(item.chatId, item.msgId), item);
    }
    if (pinsByKey.size > 0) {
      log(`[pins] hydrated ${pinsByKey.size} pin(s) from IDB`);
      notifyChange();
    }
  } catch (e: any) {
    log(`[pins] hydrate failed: ${e?.message ?? e}`);
  }
}

/** Add a pin. Idempotent (re-pinning an already-pinned item refreshes
 *  pinnedAt + text, which is the right behavior if the bubble's text
 *  changed since the last pin). */
export async function pinMessage(item: Omit<PinnedItem, 'pinnedAt'>): Promise<void> {
  if (!item.chatId || !item.msgId) return;
  const full: PinnedItem = { ...item, pinnedAt: Date.now() };
  pinsByKey.set(key(item.chatId, item.msgId), full);
  notifyChange();
  try {
    const db = await open();
    await reqP(
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(full),
    );
    db.close();
  } catch (e: any) {
    log(`[pins] pinMessage IDB write failed: ${e?.message ?? e}`);
  }
}

/** Remove a pin. No-op if not currently pinned. */
export async function unpinMessage(chatId: string, msgId: string): Promise<void> {
  if (!chatId || !msgId) return;
  if (!pinsByKey.delete(key(chatId, msgId))) return;
  notifyChange();
  try {
    const db = await open();
    await reqP(
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete([chatId, msgId]),
    );
    db.close();
  } catch (e: any) {
    log(`[pins] unpinMessage IDB delete failed: ${e?.message ?? e}`);
  }
}

/** Sync pin check — drives the per-bubble + per-row UI repaint after
 *  hydrate() resolves. */
export function isPinned(chatId: string, msgId: string): boolean {
  if (!chatId || !msgId) return false;
  return pinsByKey.has(key(chatId, msgId));
}

/** All pins across every chat, sorted newest-first by pinnedAt.
 *  Backs the right-side pin drawer. */
export function listAllPins(): PinnedItem[] {
  return Array.from(pinsByKey.values()).sort((a, b) => b.pinnedAt - a.pinnedAt);
}

/** Synchronous count across all chats. Used by the right-drawer
 *  toggle button's banner. */
export function totalPinCount(): number {
  return pinsByKey.size;
}

/** Pins for one chat — used if we ever want a per-chat sub-list or
 *  badge on the row. Not used by the drawer (which aggregates) but
 *  cheap to expose. */
export function pinsForChat(chatId: string): PinnedItem[] {
  const out: PinnedItem[] = [];
  for (const item of pinsByKey.values()) {
    if (item.chatId === chatId) out.push(item);
  }
  return out.sort((a, b) => b.pinnedAt - a.pinnedAt);
}

function notifyChange(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('sidekick:pins-changed'));
    }
  } catch { /* non-DOM hosts (test runner) */ }
}

// Test-only window-exposed seam — lets smokes read the in-memory pin
// state synchronously without poking at IDB. Production code never
// references this.
if (typeof window !== 'undefined') {
  (window as any).__pinsDebug = {
    size: () => pinsByKey.size,
    snapshot: () => Array.from(pinsByKey.entries()),
    clearForTest: () => { pinsByKey.clear(); },
  };
}
