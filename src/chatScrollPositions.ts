// Per-chat scroll-position memory.
//
// "Wherever the user last was in this session, else bottom" — the
// behavior every chat / messaging app defaults to, emulated for the
// single-page sidekick. Save scrollTop on scroll, restore on switch-
// back. No flags, no observers, no special cases.
//
// Storage:
//   - In-memory Map (chatId → SavedPosition) is the read source so
//     sessionResume can branch synchronously on restore vs scroll-to-
//     bottom without making the call chain async.
//   - IDB is the persistence backend; hydrated once at chat.init,
//     write-through (debounced 500ms per chat) on save.
//   - Cache miss → caller scrolls to bottom (per Jonathan, 2026-05-11:
//     "if there's a cache miss in IDB make it scroll to bottom").

import { diag } from './util/log.ts';

const DB_NAME = 'sidekick-scroll';
const STORE = 'positions';
const PERSIST_DEBOUNCE_MS = 500;

export interface SavedScrollPosition {
  chatId: string;
  scrollTop: number;
  /** data-key for the first visible transcript child at save time.
   *  Mid-chat restore prefers this anchor over raw scrollTop so layout
   *  changes above the viewport do not move what the user was reading. */
  anchorKey?: string | null;
  /** Pixel offset from transcript viewport top to anchor top. */
  anchorOffset?: number | null;
  /** True when scrollTop was within AT_BOTTOM_THRESHOLD_PX of the
   *  live edge at save time. Restore uses this to call
   *  forceScrollToBottom (which re-pins after async height growth)
   *  instead of setting a stale scrollTop. Without this, a chat
   *  whose scrollHeight grows after restore (lazy DOM enhancement —
   *  play-bars, copy buttons, timestamps added after initial layout)
   *  leaves the user at the old bottom = new middle. Smoke pins this
   *  via scripts/smoke/scroll-position-persists-on-switch.mjs. */
  atBottom: boolean;
  savedAt: number;
}

/** Threshold for "at the live edge" — matches autoScroll's pinned
 *  threshold in chat.ts. */
export const AT_BOTTOM_THRESHOLD_PX = 300;

const cache = new Map<string, SavedScrollPosition>();
let hydrated = false;

/** Timestamp until which saveScrollPosition() is a no-op. Set by the
 *  restore path after replaySessionMessages so the post-render scroll
 *  event (which fires with scrollTop=0 before the scrollTop assignment
 *  has settled into the new content) doesn't clobber the saved value.
 *  Lasts ~500ms — long enough to cover the rAF retry + final scroll
 *  event from the assignment, short enough that genuine user scrolls
 *  within the next half-second still register. */
let suppressSavesUntil = 0;
export function suppressSavesFor(ms: number): void {
  suppressSavesUntil = Math.max(suppressSavesUntil, Date.now() + ms);
}

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
        diag(`[chat-scroll] hydrate ok: ${rows.length} positions from IDB`);
        resolve();
      };
      req.onerror = () => {
        diag(`[chat-scroll] hydrate getAll() onerror`);
        resolve();
      };
    });
    db.close();
  } catch (e: any) {
    diag(`[chat-scroll] hydrate failed: ${e?.message ?? e}`);
  }
}

/** Synchronously read the saved position for `chatId`, or null on
 *  cache miss. Caller treats null as "scroll to bottom." */
export function getScrollPosition(chatId: string): SavedScrollPosition | null {
  if (!chatId) {
    diag(`[chat-scroll] get: empty chatId → null`);
    return null;
  }
  const v = cache.get(chatId);
  diag(`[chat-scroll] get(${chatId.slice(-12)}) → ${v ? `scrollTop=${v.scrollTop} atBottom=${v.atBottom} anchor=${v.anchorKey || ""} age=${Math.round((Date.now() - v.savedAt) / 1000)}s` : "MISS"}`);
  return v || null;
}

/** Update the cached position for `chatId`. Writes through to IDB
 *  on a per-chat 500ms debounce — high-frequency scroll events
 *  during a streaming reply collapse to one disk write. atBottom is
 *  derived from current scrollTop vs maxTop at the call site. */
export function saveScrollPosition(
  chatId: string,
  scrollTop: number,
  atBottom: boolean,
  anchor?: { key: string | null; offset: number | null } | null,
): void {
  if (!chatId) {
    diag(`[chat-scroll] save: empty chatId, skip`);
    return;
  }
  if (Date.now() < suppressSavesUntil) {
    // Post-render scroll storm — don't overwrite the saved value
    // with the transient scrollTop=0 the browser reports before the
    // restore-rAF assignment settles.
    return;
  }
  const floored = Math.max(0, Math.floor(scrollTop));
  // Log only when scrollTop changes meaningfully from the last save —
  // streaming-reply autoscroll fires many events with identical values
  // (already at bottom, scrollHeight grew but scrollTop pinned). Cuts
  // signal/noise without losing the "user scrolled to X" event.
  const prev = cache.get(chatId);
  if (!prev || Math.abs(prev.scrollTop - floored) >= 50 || prev.atBottom !== atBottom) {
    diag(`[chat-scroll] save(${chatId.slice(-12)}) scrollTop=${floored} atBottom=${atBottom}${prev ? ` (was ${prev.scrollTop} atBottom=${prev.atBottom})` : ' [new]'}`);
  }
  const record: SavedScrollPosition = {
    chatId,
    scrollTop: floored,
    anchorKey: anchor?.key || null,
    anchorOffset: typeof anchor?.offset === "number" ? anchor.offset : null,
    atBottom,
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
