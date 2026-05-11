// Per-chat scroll-position memory.
//
// On switch-back to a chat, restore the user's last known scroll
// position so the experience is "land where I left off" rather than
// "always jump to bottom" (which silently breaks when async content
// reflow shifts scrollHeight after the synchronous scroll fires —
// see chat.ts forceScrollToBottom for the gory iOS WebKit details).
//
// Storage:
//   - In-memory Map (chatId → SavedPosition) is the read source so
//     sessionResume can branch synchronously on restore vs scroll-to-
//     bottom without making the call chain async.
//   - IDB is the persistence backend; hydrated once at chat.init,
//     write-through (debounced 500ms per chat) on save.
//   - Cache miss → caller scrolls to bottom (per Jonathan, 2026-05-11:
//     "if there's a cache miss in IDB make it scroll to bottom").
//
// "At bottom" is a distinct flag from raw scrollTop because:
//   - Native PWA users expect "I was at the bottom → next visit, I'm
//     at the bottom" regardless of intervening reflow.
//   - Reflow during agent replies grows scrollHeight; a saved
//     scrollTop reads stale. forceScrollToBottom() is the correct
//     restore action for atBottom=true.

import { diag } from './util/log.ts';

const DB_NAME = 'sidekick-scroll';
const STORE = 'positions';
const PERSIST_DEBOUNCE_MS = 500;

export interface SavedScrollPosition {
  chatId: string;
  scrollTop: number;
  atBottom: boolean;
  savedAt: number;
}

const cache = new Map<string, SavedScrollPosition>();
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

/** Load all saved positions into the in-memory cache. Called once at
 *  chat.init so sessionResume can branch synchronously at switch
 *  time. Best-effort — failures leave the cache empty (every chat
 *  becomes a cache miss → forceScrollToBottom fallback, which is the
 *  pre-feature default behavior). */
export async function hydrateScrollPositions(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const db = await dbOpen();
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    await new Promise<void>((resolve) => {
      req.onsuccess = () => {
        const rows = (req.result || []) as SavedScrollPosition[];
        for (const r of rows) {
          if (r?.chatId) cache.set(r.chatId, r);
        }
        diag(`[chat-scroll] hydrated ${rows.length} saved positions from IDB`);
        resolve();
      };
      req.onerror = () => resolve();
    });
    db.close();
  } catch (e: any) {
    diag(`[chat-scroll] hydrate failed: ${e?.message ?? e}`);
  }
}

/** Synchronously read the saved position for `chatId`, or null on
 *  cache miss. Caller treats null as "scroll to bottom." */
export function getScrollPosition(chatId: string): SavedScrollPosition | null {
  if (!chatId) return null;
  return cache.get(chatId) || null;
}

/** Update the cached position for `chatId`. Writes through to IDB
 *  on a per-chat 500ms debounce — high-frequency scroll events
 *  during a streaming reply collapse to one disk write. */
export function saveScrollPosition(
  chatId: string,
  pos: { scrollTop: number; atBottom: boolean },
): void {
  if (!chatId) return;
  const record: SavedScrollPosition = {
    chatId,
    scrollTop: Math.max(0, Math.floor(pos.scrollTop)),
    atBottom: !!pos.atBottom,
    savedAt: Date.now(),
  };
  cache.set(chatId, record);
  schedulePersist(record);
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePersist(record: SavedScrollPosition): void {
  const prev = pendingWrites.get(record.chatId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    pendingWrites.delete(record.chatId);
    // Read FRESH from cache — a later save during the debounce window
    // would have updated cache; we want to persist the most-recent
    // value, not the one captured at schedule time.
    const latest = cache.get(record.chatId);
    if (latest) void persistOne(latest);
  }, PERSIST_DEBOUNCE_MS);
  pendingWrites.set(record.chatId, t);
}

async function persistOne(record: SavedScrollPosition): Promise<void> {
  try {
    const db = await dbOpen();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e: any) {
    diag(`[chat-scroll] persist failed for ${record.chatId}: ${e?.message ?? e}`);
  }
}
