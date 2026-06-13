// Field bug #225 (Mac, 2026-06-12): the user was mid-text-selection when
// the PWA spontaneously reloaded and landed on a different chat. Cause:
// sw.js's install handler called self.skipWaiting() unconditionally, so a
// PASSIVE update check (index.html runs reg.update() on visibilitychange
// and every 5 min) activated a freshly deployed SW immediately →
// controllerchange → index.html's listener reloaded the page with zero
// user action.
//
// Invariant under test: a passively detected SW update must park in
// `waiting` (surfaced as "· update ready" on the version label) and only
// activate via the explicit Refresh flow (SKIP_WAITING message) or the
// next app launch. The page must NOT reload by itself.
//
// Trigger: registering the SAME deployed sw.js under a byte-different
// script URL is a real update on this registration and runs the deployed
// install handler — so this smoke fails on a build whose install handler
// auto-activates (skipWaiting) and passes once updates wait.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'sw-update-no-spontaneous-reload';
export const DESCRIPTION = 'passively detected SW update parks in waiting (update-ready hint) — never auto-activates and reloads the page mid-session';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 10_000 });
  log('SW controlling the page ✓');

  // Reload canary — any navigation wipes it.
  await page.evaluate(() => { window.__noReloadCanary = true; });

  await page.evaluate(() => navigator.serviceWorker.register('/sw.js?smoke-passive-update=1'));
  log('passive update staged (byte-different script URL) — waiting for install');

  // Wait until the update parks in `waiting` — or, on the broken build,
  // until the auto-activate → controllerchange → reload wipes the canary.
  let parked = false;
  for (let i = 0; i < 40 && !parked; i++) {
    try {
      const st = await page.evaluate(async () => ({
        waiting: !!(await navigator.serviceWorker.getRegistration())?.waiting,
        canary: window.__noReloadCanary === true,
      }));
      if (!st.canary) break; // reloaded — final asserts report it
      parked = st.waiting;
    } catch { /* evaluate raced a navigation; final asserts catch the reload */ }
    if (!parked) await page.waitForTimeout(250);
  }
  // Settle window: on the broken build activation → reload fires a tick
  // after install; give it every chance to happen before asserting.
  await page.waitForTimeout(2_000);

  const state = await page.evaluate(async () => ({
    canary: window.__noReloadCanary === true,
    waiting: !!(await navigator.serviceWorker.getRegistration())?.waiting,
    versionLabel: document.getElementById('app-version')?.textContent || '',
  }));
  assert(state.canary,
    'page reloaded by itself after a passive SW update — the #225 spontaneous mid-session reload');
  assert(state.waiting, 'updated SW should be parked in waiting state');
  assert(state.versionLabel.includes('update ready'),
    `version label should carry the "update ready" hint — got "${state.versionLabel}"`);
  log('update parked in waiting, "update ready" hint shown, no reload ✓');
}
