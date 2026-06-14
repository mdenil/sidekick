// Regression guard for the #237 stale-index heal (field 2026-06-14).
//
// The #237 self-heal reloads the page when a content-hashed /build module
// is a cache miss AND the server 404s it (a purged build generation). That
// is correct ONLY for the BOOT brick: a cache-first index whose ENTRY
// <script type=module> references a purged generation 404s before the app
// runs, so a one-shot reload pulls a fresh index.
//
// But the app CODE-SPLITS — it lazily import()s hashed /build chunks
// mid-session (e.g. ./audio/shared/speechVad when a dictation starts).
// Every deploy build.mjs rm's build/ and re-hashes ALL modules, so an
// already-running client that lazy-loads a chunk from the now-purged
// generation gets a 404. The original heal reloaded on THAT too — which
// refreshed the page out from under an active user (data loss mid-
// dictation) and the post-reload boot could mis-land on the most-recent
// session. Both were reported in the field while a rapid sequence of
// deploys kept purging the running generation.
//
// FIX: the heal reload is gated to a short window after the SW serves a
// CACHED navigation document (the only time the boot-entry-module 404 can
// happen). Outside that window the SW still purges the stale shell but
// returns the 404 so the dynamic import rejects and the live session
// survives untouched.
//
// This smoke boots the app, waits past the boot-heal window, then triggers
// a lazy import of a hashed module the server 404s. Pre-fix: the SW hands
// back a reload module → import executes it → the page reloads (sentinel
// wiped) → FAIL. Post-fix: the SW returns the 404 → import rejects → the
// page stays put (sentinel alive, composer present) → PASS.

import { waitForReady, assert, DEFAULT_URL } from './lib.mjs';

export const NAME = 'heal-reload-boot-scoped';
export const DESCRIPTION = 'the #237 hashed-module 404 heal reload only fires at boot — a mid-session lazy import() 404 must NOT reload the page (rejects gracefully, live session survives)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

// Matches the SW HASHED_BUILD_RE but the server has no file for it → 404,
// standing in for a purged-generation chunk a lazy import() reaches for.
const DEAD_MODULE = '/build/feature.deadbeef00.mjs';
// Must exceed BOOT_HEAL_WINDOW_MS (8000) in sw.js so the lazy 404 is
// unambiguously OUTSIDE the boot window.
const PAST_BOOT_WINDOW_MS = 9000;

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 10_000 });
  log('SW controlling the page ✓');

  // A reload wipes window globals — use one as a liveness sentinel.
  await page.evaluate(() => { window.__healSentinel = 'alive'; });

  // Let the boot-heal window lapse so the impending hashed 404 cannot be
  // mistaken for a boot-entry-module brick.
  await page.waitForTimeout(PAST_BOOT_WINDOW_MS);
  log(`waited ${PAST_BOOT_WINDOW_MS}ms — past the boot-heal window ✓`);

  // Simulate a mid-session lazy chunk load whose generation was purged.
  // Pre-fix the SW returns an executable reload module; the import runs it
  // and the page reloads. Post-fix the import rejects with the raw 404.
  const importRejected = await page.evaluate(async (dead) => {
    try {
      await import(/* @vite-ignore */ dead);
      return false;
    } catch {
      return true;
    }
  }, DEAD_MODULE);

  // Give any (errant) reload a beat to take effect.
  await page.waitForTimeout(1000);

  const st = await page.evaluate(() => ({
    sentinel: window.__healSentinel,
    composer: !!document.getElementById('composer-input'),
  })).catch(() => ({ sentinel: undefined, composer: false })); // evaluate races a reload

  assert(st.sentinel === 'alive',
    'the page reloaded after a mid-session lazy import() 404 — the heal ' +
    'reload is not boot-scoped and refreshes active users on every deploy ' +
    'that purges the running generation (data-loss regression)');
  assert(st.composer,
    'composer gone after the lazy import() 404 — the live session did not survive');
  assert(importRejected,
    'the lazy import() did not reject — the SW handed back a reload/heal ' +
    'module instead of letting the purged-chunk fetch fail gracefully');
  log('mid-session lazy 404 rejected without reloading — live session survived ✓');
}
