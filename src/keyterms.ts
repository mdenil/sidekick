/**
 * Per-user STT keyterm storage. Server-backed (sidekick.db
 * `user_settings`, key `stt_keyterms`) so the list syncs across devices.
 * IndexedDB is kept as a write-through cache so reads still work offline
 * and so existing device-local lists migrate forward automatically.
 *
 * The list seeds itself ONCE on first load by fetching `/api/keyterms`
 * (which the server reads from `default_stt_keyterms.txt`). After that
 * fetch, the seed file is irrelevant — all reads/writes are the synced
 * `user_settings` row, mirrored locally.
 *
 * Schema (IDB mirror) is intentionally trivial: one record
 * `{ id: 'list', terms: string[] }`. No per-term ids, no timestamps; the
 * chip UI mutates the whole list.
 */

import { apiUrl } from './apiBase.ts';

const DB_NAME = 'sidekick-keyterms';
const STORE = 'keyterms';
const DB_VERSION = 1;
const RECORD_ID = 'list';

// Synced settings key on the server (sidekick.db user_settings).
const PREFS_KEY = 'stt_keyterms';
const PREFS_URL = `/api/sidekick/prefs/${PREFS_KEY}`;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
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

/** Parse the seed file format — newline + comma delimited, '#' comments
 *  stripped, dedup case-insensitive. Same shape the server emits and the
 *  chip-UI commit accepts, so editing the seed file by hand or pasting
 *  comma-separated lists into the input both round-trip correctly. */
function parseSeedBody(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const nocomment = line.replace(/#.*$/, '');
    for (const part of nocomment.split(',')) {
      const t = part.trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
  }
  return out;
}

// ── IDB mirror (offline cache + legacy device-local store) ────────────

/** Read the locally-mirrored list. null = nothing cached locally. */
async function idbRead(): Promise<string[] | null> {
  try {
    const db = await openDB();
    const rec: any = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_ID));
    db.close();
    if (rec && Array.isArray(rec.terms)) return rec.terms.map((v: any) => String(v));
    return null;
  } catch {
    return null;
  }
}

/** Mirror the list locally (best-effort; quota/private-mode failures are
 *  swallowed so the UI never breaks on a cache write). */
async function idbWrite(terms: string[]): Promise<void> {
  try {
    const db = await openDB();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).put({
      id: RECORD_ID,
      terms: terms.slice(),
      updatedAt: Date.now(),
    }));
    db.close();
  } catch (e) {
    console.warn('[keyterms] idb mirror write failed:', e);
  }
}

// ── Server (synced source of truth) ───────────────────────────────────

/** GET the synced list. Returns the array (incl. [] for an explicitly
 *  cleared list), or null when the server has no row yet OR is
 *  unreachable — callers distinguish those via the IDB fallback. */
async function serverGet(): Promise<string[] | null> {
  try {
    const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout(apiUrl(PREFS_URL), { timeoutMs: 5_000 });
    if (!r.ok) return null;
    const body: any = await r.json();
    if (Array.isArray(body?.value)) return body.value.map((v: any) => String(v));
    return null;
  } catch (e) {
    console.warn('[keyterms] server read failed:', e);
    return null;
  }
}

/** PUT the synced list. Returns false on failure (offline / server down)
 *  so the caller can rely on the IDB mirror until the next sync. */
async function serverPut(terms: string[]): Promise<boolean> {
  try {
    const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout(apiUrl(PREFS_URL), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: terms.slice() }),
      timeoutMs: 5_000,
    });
    return r.ok;
  } catch (e) {
    console.warn('[keyterms] server write failed:', e);
    return false;
  }
}

// ── Public API (stable across the IDB→server migration) ───────────────

/** Read the saved list. Server is the source of truth; the IDB mirror is
 *  consulted when the server is unreachable and to migrate a legacy
 *  device-local list forward on first sync. Returns null when this user
 *  has never saved a list anywhere (caller should seed from the server
 *  file). Returns [] when the user has explicitly cleared the list. */
export async function readList(): Promise<string[] | null> {
  const fromServer = await serverGet();
  if (fromServer !== null) {
    await idbWrite(fromServer);
    return fromServer;
  }
  // Server has no row yet (or is unreachable): fall back to the local
  // mirror. If a legacy device-local list exists, adopt it onto the
  // server so it starts syncing across devices.
  const legacy = await idbRead();
  if (legacy !== null) {
    const ok = await serverPut(legacy);
    if (ok) console.log(`[keyterms] migrated ${legacy.length} legacy term(s) to server`);
    return legacy;
  }
  return null;
}

/** Persist the given list. Writes the synced server row, then mirrors to
 *  IDB so offline reads stay correct. Logs success/failure so the chip-UI
 *  commit path is observable from DevTools. */
export async function writeList(terms: string[]): Promise<void> {
  const ok = await serverPut(terms);
  await idbWrite(terms);
  console.log(`[keyterms] writeList ${ok ? 'ok' : 'cached-only'}: ${terms.length} term(s)`,
    terms.length ? terms.slice(0, 5).join(', ') + (terms.length > 5 ? ` (+${terms.length - 5})` : '') : '(empty)');
}

/** First-boot seed: returns the saved list, or fetches the server seed
 *  file and persists it once. The fetched list is then returned so the
 *  caller can render chips immediately. Failures (offline, server down)
 *  surface as an empty list — the user can still type new chips. */
export async function loadOrSeed(): Promise<string[]> {
  const saved = await readList();
  if (saved !== null) {
    console.log(`[keyterms] loadOrSeed: ${saved.length} saved`,
      saved.length ? saved.slice(0, 5).join(', ') + (saved.length > 5 ? ` (+${saved.length - 5})` : '') : '(empty)');
    return saved;
  }
  let seeded: string[] = [];
  try {
    const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout(apiUrl('/api/keyterms'), { timeoutMs: 5_000 });
    if (r.ok) seeded = parseSeedBody(await r.text());
  } catch (e) {
    console.warn('[keyterms] seed fetch failed:', e);
  }
  console.log(`[keyterms] loadOrSeed: seeded ${seeded.length} from /api/keyterms`);
  await writeList(seeded);
  return seeded;
}

/** Re-fetch the server seed and merge any NEW entries into the saved
 *  list. User-added chips (entries not in the server list) are preserved.
 *  Removals on the server side are NOT mirrored — once a term is saved,
 *  only an explicit chip-x click removes it. Returns the merged list, or
 *  the existing list if the seed fetch fails (offline, server down). */
export async function rehydrateFromSeed(): Promise<string[]> {
  const existing = (await readList()) ?? [];
  let serverSeed: string[] = [];
  try {
    const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout(apiUrl('/api/keyterms'), { timeoutMs: 5_000 });
    if (!r.ok) return existing;
    serverSeed = parseSeedBody(await r.text());
  } catch (e) {
    console.warn('[keyterms] rehydrate fetch failed:', e);
    return existing;
  }
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  const added: string[] = [];
  for (const t of serverSeed) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(t);
  }
  if (added.length === 0) {
    console.log('[keyterms] rehydrate: no new entries from server');
    return existing;
  }
  const merged = [...existing, ...added];
  await writeList(merged);
  console.log(`[keyterms] rehydrate: +${added.length} new entries`,
    added.slice(0, 5).join(', ') + (added.length > 5 ? ` (+${added.length - 5})` : ''));
  return merged;
}
