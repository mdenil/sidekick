// Field bug (mobile PWA, 2026-06-14): the installed PWA was "stuck not
// loading" across several relaunches — a dead boot that only a delete +
// reinstall recovered. Not an offline blip: good Wi-Fi, the UI never
// became responsive.
//
// ROOT CAUSE (the stale-index brick): index.html is served CACHE-FIRST
// by the SW app-shell handler, and it carries an import map mapping each
// /build/*.mjs to a CONTENT-HASHED name (foo.<sha10>.mjs, #182). Every
// deploy build.mjs rm's build/ and re-hashes, so old hashed modules are
// PURGED from the server. The app-shell handler also background-
// revalidates the cached index, so across deploys the cached index can
// advance to a "phantom" generation whose hashed modules were never
// cached (that boot ran older code) AND have since been purged from the
// server. Next launch: cache-first serves the phantom index → its entry
// <script type=module src=/build/main.<phantomhash>.mjs> is a BUILD_CACHE
// miss → network → 404 (purged) → the module never loads → dead boot.
// Relaunch repeats: the same stale index 404s again → reinstall-only.
//
// FIX (SW-level self-heal): when a hashed /build module is a cache miss
// AND the network returns a genuine 404 (the purged-generation signal,
// distinct from an offline fetch rejection), the SW purges the stale
// cached navigation documents and hands back a one-shot reload module.
// The reload re-navigates; with the stale app-shell gone the navigation
// falls through to the network for a FRESH index whose hashed modules the
// server actually has → clean boot. Dormant on healthy boots (no 404 ⇒
// path never runs), so it can't regress the slow-link cached-paint budget.
//
// This smoke poisons the SW cache with a stale index that references a
// hashed module the server 404s, re-navigates, and asserts the app
// reaches a BOOTED state (composer present, stale marker gone). Pre-fix
// the module 404 bricks the boot (composer never appears) → FAIL.
// Post-fix the SW self-heals via one reload → PASS.

import { waitForReady, assert, DEFAULT_URL } from './lib.mjs';

export const NAME = 'stale-index-self-heal';
export const DESCRIPTION = 'a cache-first stale index referencing a purged (404) hashed module self-heals via one SW-driven reload instead of bricking boot';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const STALE_MARKER = 'STALE-PHANTOM-INDEX-DO-NOT-SERVE';
// A hashed name that matches the SW's HASHED_BUILD_RE
// (/^\/build\/.+\.[0-9a-f]{10}\.mjs$/) but that the server has no file
// for — stands in for a purged build generation. Server returns 404.
const DEAD_MODULE = '/build/main.deadbeef00.mjs';

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 10_000 });
  log('SW controlling the page ✓');

  // Poison the SW cache: replace the cached navigation document with a
  // stale "phantom" index that boots ONLY a purged hashed module. Delete
  // any real cached '/' first (caches.match returns the first match across
  // all caches in creation order — the real CACHE_NAME entry would shadow
  // the poison otherwise), then write the poison as the sole copy.
  await page.evaluate(async ({ marker, dead }) => {
    const root = self.location.origin + '/';
    const names = await caches.keys();
    await Promise.all(names.map(async (n) => {
      const c = await caches.open(n);
      await c.delete(root);
      await c.delete('/');
      await c.delete('/index.html');
    }));
    const html =
      `<!doctype html><html><head><title>${marker}</title>` +
      `<script type="module" src="${dead}"></script></head>` +
      `<body><div id="phantom">${marker}</div></body></html>`;
    const cache = await caches.open('smoke-stale-index');
    await cache.put(root, new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    }));
  }, { marker: STALE_MARKER, dead: DEAD_MODULE });
  log('poisoned the app-shell cache with a phantom index (dead module ref) ✓');

  // Re-navigate. Cache-first serves the phantom index; its entry module
  // 404s. Pre-fix: dead boot. Post-fix: the SW intercepts the 404, purges
  // the stale shell, and the one-shot reload pulls a fresh index.
  await page.goto(DEFAULT_URL, { waitUntil: 'domcontentloaded' });

  // THE GATE: the app must reach a booted state. The fresh index renders
  // #composer-input; the phantom never does. Bounded poll so the failure
  // mode (bricked) reports a clear assertion, not a raw Playwright timeout.
  let booted = false;
  let stalePresent = true;
  for (let i = 0; i < 40 && !booted; i++) {
    const st = await page.evaluate(() => ({
      composer: !!document.getElementById('composer-input'),
      stale: document.documentElement.outerHTML.includes('STALE-PHANTOM-INDEX-DO-NOT-SERVE'),
    })).catch(() => ({ composer: false, stale: false })); // evaluate may race the heal reload
    booted = st.composer;
    stalePresent = st.stale;
    if (!booted) await page.waitForTimeout(250);
  }

  assert(booted,
    'PWA stayed bricked: a cache-first phantom index referencing a purged (404) ' +
    'hashed module never booted — the SW did not self-heal the dead boot');
  assert(!stalePresent,
    'the phantom index is still on screen after the heal window — the stale ' +
    'navigation document was not replaced with a fresh server index');
  log('stale-index brick self-healed to a fresh booted index ✓');
}
