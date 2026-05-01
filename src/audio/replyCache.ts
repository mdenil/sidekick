/**
 * @fileoverview LRU cache for synthesized agent reply audio (mp3 Blobs).
 *
 * playReplyTts hits /tts on every reply. For "replay last answer" or
 * "wait, what did you say?" interactions a hands-free user re-issues
 * — Listen amplifies this — fetching the same audio twice burns
 * bandwidth + Deepgram quota for no benefit. This module memoizes
 * recent (text, voice) → Blob mappings with a small LRU cap.
 *
 * Cap shape:
 *   - Max 10 entries (most agent turns are short; 10 covers the typical
 *     "in this chat" working set).
 *   - Soft byte ceiling at 5MB total (a 30-second Aura mp3 ~ 200KB; 5MB
 *     ~ 25 short replies of headroom). When the byte total exceeds the
 *     ceiling, evict from the head until under ceiling — independent
 *     of the entry-count cap.
 *
 * Eviction is age-based (last-used wins). Insertion of a new entry that
 * matches an existing key promotes the existing entry to most-recent.
 */

const MAX_ENTRIES = 10;
const MAX_BYTES = 5 * 1024 * 1024;

type Entry = { key: string; blob: Blob; bytes: number };

// Map preserves insertion order, so we can use it as an LRU by re-
// setting a key on access (deletes + re-inserts → moves to tail).
const cache = new Map<string, Entry>();
let totalBytes = 0;

function makeKey(text: string, voice: string): string {
  return `${voice}::${text}`;
}

/** Read a cached blob if present. Promotes to most-recent on hit. */
export function get(text: string, voice: string): Blob | null {
  const key = makeKey(text, voice);
  const entry = cache.get(key);
  if (!entry) return null;
  // Promote: delete + re-insert moves to tail.
  cache.delete(key);
  cache.set(key, entry);
  return entry.blob;
}

/** Insert / update a blob for the given (text, voice). Idempotent —
 *  inserting the same key replaces the existing blob and bumps to
 *  most-recent. Triggers eviction down to MAX_ENTRIES + MAX_BYTES. */
export function set(text: string, voice: string, blob: Blob): void {
  const key = makeKey(text, voice);
  const existing = cache.get(key);
  if (existing) {
    totalBytes -= existing.bytes;
    cache.delete(key);
  }
  const bytes = blob.size;
  cache.set(key, { key, blob, bytes });
  totalBytes += bytes;
  evict();
}

function evict(): void {
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    const entry = cache.get(oldestKey);
    if (!entry) {
      cache.delete(oldestKey);
      continue;
    }
    totalBytes -= entry.bytes;
    cache.delete(oldestKey);
  }
}

/** Drop everything. Used by tests and (future) by the privacy "delete
 *  session memory" path so cached TTS doesn't outlive the chat that
 *  produced it. */
export function clear(): void {
  cache.clear();
  totalBytes = 0;
}

/** Inspect-only — exposed for tests + debug. */
export function stats(): { size: number; bytes: number } {
  return { size: cache.size, bytes: totalBytes };
}
