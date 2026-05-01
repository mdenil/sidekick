// Server-side cache + endpoint for OpenRouter input-modality lookups.
//
// Why server-side: the previous design shipped an 800-LOC catalog
// snapshot (`src/data/modelModalities.ts`) baked into the PWA bundle
// and refreshed by a manual script. That meant every model rotation
// required a build + cache-bust + redeploy, and 99% of users only
// ever see ~30 models in their attach-button gate. The proxy fetches
// once on boot (and refreshes daily), and the PWA fetches a small
// JSON map once per session — no JS module to invalidate, no manual
// re-run.
//
// Local-only models (gemma served by llama.cpp on hermes etc.) are
// not in OpenRouter's catalog and never make it into this map. The
// PWA's `isVisionCapableModel` keeps a regex fallback for those.

import http from 'node:http';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

// Refresh once a day. The catalog rarely shifts mid-day; a longer
// stale window is fine — the cost of a stale "image-capable" claim
// is just a wasted attach attempt that the model will reject.
const REFRESH_MS = 24 * 60 * 60 * 1000;

// Slim shape: id → input_modalities[]. Drop text-only models so the
// payload stays small; missing IDs default to text-only at the call
// site.
type ModalityMap = Record<string, readonly string[]>;

let cache: { fetchedAt: string; modalities: ModalityMap } = {
  fetchedAt: '',
  modalities: {},
};
let lastRefreshAt = 0;
let refreshInFlight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  const res = await fetch(OPENROUTER_URL, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}`);
  }
  const catalog = await res.json() as { data?: Array<{
    id?: string;
    architecture?: { input_modalities?: string[] };
  }> };
  const models = Array.isArray(catalog?.data) ? catalog.data : [];

  const next: ModalityMap = {};
  for (const m of models) {
    const id = m?.id;
    const mods = m?.architecture?.input_modalities;
    if (!id || !Array.isArray(mods)) continue;
    const interesting = mods.filter(mod => mod !== 'text');
    if (interesting.length === 0) continue;
    next[id] = mods;
  }
  cache = { fetchedAt: new Date().toISOString(), modalities: next };
  lastRefreshAt = Date.now();
  console.log(`[sidekick:modalities] refreshed (${Object.keys(next).length} multimodal models)`);
}

async function ensureFresh(): Promise<void> {
  if (Date.now() - lastRefreshAt < REFRESH_MS && cache.fetchedAt) return;
  if (refreshInFlight) {
    await refreshInFlight;
    return;
  }
  refreshInFlight = refresh().finally(() => { refreshInFlight = null; });
  try {
    await refreshInFlight;
  } catch (err) {
    // Fail-soft: a transient OpenRouter outage shouldn't 500 the
    // attach gate. Log and serve whatever's in cache (possibly empty
    // on first boot — the PWA falls back to its regex for that case).
    console.warn('[sidekick:modalities] refresh failed, serving cached map:', err);
  }
}

/** Optional eager warm at server boot — surfaces network issues
 *  early instead of deferring to the first PWA request. Safe to skip;
 *  the lazy `ensureFresh` path covers cold cache too. */
export function init(): void {
  void ensureFresh();
}

export async function handleSidekickModelModalities(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  await ensureFresh();
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  // 1h browser-side cache (the PWA also does its own module-memory
  // cache, but a refresh on hard-reload is cheap enough to allow).
  res.setHeader('cache-control', 'private, max-age=3600');
  res.end(JSON.stringify({
    fetched_at: cache.fetchedAt,
    modalities: cache.modalities,
  }));
}
