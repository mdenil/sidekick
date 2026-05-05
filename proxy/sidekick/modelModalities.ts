// Server-side cache + endpoint for OpenRouter input-modality lookups
// PLUS the hermes-side auxiliary-vision advertisement that lets the
// PWA enable the attachment button when the primary is text-only but
// hermes is configured to auto-route images through an auxiliary
// vision model (`auxiliary.vision.model` in ~/.hermes/config.yaml,
// surfaced via the plugin's /v1/sidekick/auxiliary-models endpoint).
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
const UPSTREAM_URL = (process.env.UPSTREAM_URL || 'http://127.0.0.1:8645').replace(/\/+$/, '');
const UPSTREAM_TOKEN = (process.env.UPSTREAM_TOKEN || process.env.SIDEKICK_PLATFORM_TOKEN || '').trim();

// Refresh once a day. The catalog rarely shifts mid-day; a longer
// stale window is fine — the cost of a stale "image-capable" claim
// is just a wasted attach attempt that the model will reject.
const REFRESH_MS = 24 * 60 * 60 * 1000;

// Slim shape: id → input_modalities[]. Drop text-only models so the
// payload stays small; missing IDs default to text-only at the call
// site.
type ModalityMap = Record<string, readonly string[]>;

let cache: {
  fetchedAt: string;
  modalities: ModalityMap;
} = {
  fetchedAt: '',
  modalities: {},
};
let lastRefreshAt = 0;
let refreshInFlight: Promise<void> | null = null;

// Vision-fallback is fetched live (with a short memo) instead of folded
// into the 24h openrouter cache. Why: the original combined-cache design
// cached a transient null when hermes-gateway was still warming on
// sidekick boot, then the 24h TTL locked the dead value in until the
// next day. Localhost call is ~ms; 30s memo avoids hammering on rapid
// modalities-endpoint hits while still recovering quickly from a
// transient miss or a config edit.
const VISION_MEMO_MS = 30 * 1000;
let visionMemo: { value: string | null; at: number } | null = null;
let visionInFlight: Promise<string | null> | null = null;

async function fetchVisionFallbackModelLive(): Promise<string | null> {
  if (!UPSTREAM_TOKEN) return null;
  try {
    const r = await fetch(`${UPSTREAM_URL}/v1/sidekick/auxiliary-models`, {
      headers: { authorization: `Bearer ${UPSTREAM_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json() as { vision?: string | null };
    return typeof j?.vision === 'string' && j.vision ? j.vision : null;
  } catch {
    return null;
  }
}

async function getVisionFallbackModel(): Promise<string | null> {
  if (visionMemo && Date.now() - visionMemo.at < VISION_MEMO_MS) {
    return visionMemo.value;
  }
  if (visionInFlight) return visionInFlight;
  visionInFlight = fetchVisionFallbackModelLive().finally(() => {
    visionInFlight = null;
  });
  const value = await visionInFlight;
  visionMemo = { value, at: Date.now() };
  return value;
}

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
  const [, visionFallbackModel] = await Promise.all([
    ensureFresh(),
    getVisionFallbackModel(),
  ]);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  // No browser-side cache — vision_fallback_model can change as soon as
  // hermes-gateway reloads its config; a stale browser cache would make
  // the PWA gate stale across deploys. Modalities map is module-memory
  // cached on the PWA side (see ensureModalitiesFetched in main.ts).
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({
    fetched_at: cache.fetchedAt,
    modalities: cache.modalities,
    vision_fallback_model: visionFallbackModel,
  }));
}
