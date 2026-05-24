// Per-chat scroll-position memory.
//
// Save scrollTop on scroll, restore on switch-back. Cache miss → caller
// scrolls to bottom (the "wherever the user last was, else bottom"
// default every chat app implements).
//
// Storage:
//   - In-memory Map (chatId → {scrollTop, atBottom}) is the read source
//     so sessionResume branches synchronously on restore. atBottom is
//     captured from chat.isPinned() at save time: it answers the
//     question "did the user want the live edge?" directly, without
//     having to compare scrollTop against a maxTop that may not reflect
//     the chat's final height at restore time (partial cache renders,
//     post-mount layout shift from tool rows / images / code blocks).
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
  atBottom?: boolean;  // legacy records may lack this; absence → false (literal restore)
  savedAt: number;
}

export interface SavedPosition {
  scrollTop: number;
  atBottom: boolean;
}

const cache = new Map<string, SavedPosition>();
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
            cache.set(r.chatId, {
              scrollTop: r.scrollTop,
              atBottom: r.atBottom === true,  // legacy missing → false
            });
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

export function getScrollPosition(chatId: string): SavedPosition | null {
  if (!chatId) return null;
  const v = cache.get(chatId);
  return v ?? null;
}

export function saveScrollPosition(chatId: string, scrollTop: number, atBottom: boolean): void {
  if (!chatId) return;
  const floored = Math.max(0, Math.floor(scrollTop));
  const prev = cache.get(chatId);
  if (prev && prev.scrollTop === floored && prev.atBottom === atBottom) return;
  diag(`[chat-scroll] save ${chatId.slice(-12)} → ${floored} atBottom=${atBottom} (was ${prev ? `${prev.scrollTop}/${prev.atBottom}` : 'undef'})`);
  cache.set(chatId, { scrollTop: floored, atBottom });
  const pendingTimer = pendingWrites.get(chatId);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingWrites.set(chatId, setTimeout(() => {
    pendingWrites.delete(chatId);
    void persistOne(chatId);
  }, PERSIST_DEBOUNCE_MS));
}

/** Flush the pending IDB write for chatId IMMEDIATELY. Called on session
 *  switch and pagehide so the latest position survives reloads / fast
 *  switches that would outrun the 200ms debounce. */
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
  const rec = cache.get(chatId);
  if (!rec) return;
  try {
    const db = await dbOpen();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      chatId,
      scrollTop: rec.scrollTop,
      atBottom: rec.atBottom,
      savedAt: Date.now(),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e: any) {
    diag(`[chat-scroll] persist failed for ${chatId}: ${e?.message ?? e}`);
  }
}
