// Per-chat scroll-position memory.
//
// Save scrollTop on scroll, restore on switch-back. Cache miss → caller
// scrolls to bottom (the "wherever the user last was, else bottom"
// default every chat app implements).
//
// Storage:
//   - In-memory Map (chatId → scrollTop) is the read source so
//     sessionResume branches synchronously on restore.
//   - IDB persists the cache; hydrated once at chat.init, debounced
//     write-through on save. flush() runs the pending write immediately
//     — sessionDrawer's onBeforeSwitch + pagehide both call it so the
//     latest position survives reloads / fast switches.

import { diag } from './util/log.ts';

const DB_NAME = 'sidekick-scroll';
const STORE = 'positions';
const PERSIST_DEBOUNCE_MS = 200;

interface PositionRecord {
  chatId: string;
  scrollTop: number;
  savedAt: number;
}

/** Pixels-from-bottom threshold used by the restore path: if the saved
 *  scrollTop is within this distance of the CURRENT maxTop, snap to the
 *  current bottom instead of restoring the literal value. Handles "user
 *  was at the live edge; new messages arrived while away → user wants
 *  the new live edge, not the old one." */
export const AT_BOTTOM_THRESHOLD_PX = 300;

const cache = new Map<string, number>();
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
let hydrated = false;

function dbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'chatId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function hydrateScrollPositions(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const db = await dbOpen();
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    await new Promise<void>((resolve) => {
      req.onsuccess = () => {
        const rows = (req.result || []) as PositionRecord[];
        for (const r of rows) {
          if (r?.chatId && typeof r.scrollTop === 'number') {
            cache.set(r.chatId, r.scrollTop);
          }
        }
        diag(`[chat-scroll] hydrate: ${rows.length} positions from IDB`);
        resolve();
      };
      req.onerror = () => resolve();
    });
    db.close();
  } catch (e: any) {
    diag(`[chat-scroll] hydrate failed: ${e?.message ?? e}`);
  }
}

export function getScrollPosition(chatId: string): number | null {
  if (!chatId) return null;
  const v = cache.get(chatId);
  return typeof v === 'number' ? v : null;
}

export function saveScrollPosition(chatId: string, scrollTop: number): void {
  if (!chatId) return;
  const floored = Math.max(0, Math.floor(scrollTop));
  if (cache.get(chatId) === floored) return;
  cache.set(chatId, floored);
  const pendingTimer = pendingWrites.get(chatId);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingWrites.set(chatId, setTimeout(() => {
    pendingWrites.delete(chatId);
    void persistOne(chatId);
  }, PERSIST_DEBOUNCE_MS));
}

/** Flush the pending IDB write for chatId IMMEDIATELY. Called on session
 *  switch and pagehide so the latest position survives reloads / fast
 *  switches that would otherwise outrun the 200ms debounce. */
export function flushScrollPosition(chatId: string): void {
  if (!chatId) return;
  const pending = pendingWrites.get(chatId);
  if (pending) {
    clearTimeout(pending);
    pendingWrites.delete(chatId);
  }
  void persistOne(chatId);
}

async function persistOne(chatId: string): Promise<void> {
  const scrollTop = cache.get(chatId);
  if (typeof scrollTop !== 'number') return;
  try {
    const db = await dbOpen();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ chatId, scrollTop, savedAt: Date.now() });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e: any) {
    diag(`[chat-scroll] persist failed for ${chatId}: ${e?.message ?? e}`);
  }
}
