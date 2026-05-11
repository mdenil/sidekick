// Service-worker lifecycle helpers — the SW-related code main.ts used
// to inline. Extracted 2026-05-11 for the Phase 1 / pre-notifications
// refactor.
//
// Three pieces here:
//
//   1. `waitForSwActivation(newWorker, timeoutMs)` — race a new SW's
//      `controllerchange` event against a timeout. Used by the refresh
//      button to skip the dummy `location.reload()` when the
//      controllerchange listener in index.html is going to reload us
//      anyway. Returns true if the activation happened (caller should
//      NOT reload), false on timeout (caller should reload).
//
//   2. `initPassiveUpdateDetector()` — observe `updatefound` /
//      `statechange` on the active registration and call
//      `markUpdateAvailable` whenever a new worker installs while an
//      existing one is still controlling. Wires "· update ready" onto
//      the #app-version label so the user knows clicking Refresh will
//      jump them forward.
//
//   3. `installForceUpdateConsoleHook()` — exposes `__forceUpdate()`
//      on `window` for DevTools. Unregisters every SW + deletes every
//      Cache + hard-reloads with a cache-bust query. Escape hatch for
//      when the normal refresh path gets stuck.
//
// Behavior preserved byte-for-byte from the in-line versions in
// main.ts pre-extraction. No new semantics; this is a pure lift so
// the upcoming notifications module (Phase 3) has a clean owner for
// SW registration / push-subscribe hooks.

import { log, diag } from './util/log.ts';

/** Race a new SW's `controllerchange` against a timeout.
 *
 *  Posts SKIP_WAITING to the new worker as soon as it's `installed`,
 *  then waits for `navigator.serviceWorker`'s `controllerchange` event.
 *  We have to send SKIP_WAITING explicitly because the upgrade path
 *  doesn't auto-claim — service workers default to "wait for all old
 *  tabs to close" semantics. Setting up the `statechange` listener
 *  AFTER the post is a one-shot dance that handles both timings: the
 *  worker is already `installed` (post immediately, statechange may
 *  not fire) OR it's still `installing` (post on the `installed`
 *  statechange).
 *
 *  Returns:
 *    true  — controllerchange fired in time; index.html's listener
 *            handles the reload. Caller SHOULD NOT manually reload.
 *    false — timeout. Caller should `location.reload()` to pick up
 *            keyterms / settings refresh.
 */
export async function waitForSwActivation(
  newWorker: ServiceWorker,
  timeoutMs: number,
): Promise<boolean> {
  const postSkipWaitingIfReady = () => {
    // Only the SW in `waiting` state honors SKIP_WAITING. `installing`
    // becomes `installed` becomes `waiting` (or `activating` if claim
    // is in flight). Send to whichever is non-null.
    if (newWorker.state === 'installed') {
      newWorker.postMessage({ type: 'SKIP_WAITING' });
    }
  };
  postSkipWaitingIfReady();  // in case it's already installed

  const stateChangeP = new Promise<void>((resolve) => {
    const onChange = () => {
      postSkipWaitingIfReady();
      if (newWorker.state === 'redundant') {
        // Install failed entirely (rare with the resilient install
        // handler but possible). Give up gracefully.
        newWorker.removeEventListener('statechange', onChange);
        resolve();
      }
    };
    newWorker.addEventListener('statechange', onChange);
  });

  const controllerChangeP = new Promise<boolean>((resolve) => {
    const onChange = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
  });

  const timeoutP = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });

  // Race controllerchange against the timeout. stateChangeP is just
  // there to keep firing skip-waiting attempts as the worker progresses.
  void stateChangeP;
  return Promise.race([controllerChangeP, timeoutP]);
}

/** Surface a "· update ready" hint in the #app-version label. The
 *  user clicks Refresh to apply (which triggers the
 *  installed→activated flip). Idempotent — calling repeatedly while
 *  the hint is already present is a no-op. */
function markUpdateAvailable(): void {
  const el = document.getElementById('app-version');
  if (!el) return;
  if (el.dataset.updateAvailable === '1') return;
  el.dataset.updateAvailable = '1';
  // Append a small hint after the existing version text rather than
  // overwriting — that way the user can still see which version they're
  // on AND that an update is waiting.
  const hint = document.createElement('span');
  hint.className = 'version-update-hint';
  hint.textContent = ' · update ready';
  hint.title = 'Click Refresh to apply';
  el.appendChild(hint);
  diag('refresh: update available — added hint to version label');
}

/** Wire passive `updatefound` detection on the active SW registration.
 *  When the browser's periodic update check (or the visibilitychange
 *  one in index.html) finds a new SW and it installs into a `waiting`
 *  state instead of auto-activating (e.g. because the OLD SW didn't
 *  call clients.claim or skipWaiting), `markUpdateAvailable` flags
 *  it in the version label so the user knows clicking Refresh will
 *  jump them forward.
 *
 *  Without this, the only signal a user has that they're stale is the
 *  version string — and if they haven't memorized the latest, they
 *  can't tell.
 *
 *  No-op when `serviceWorker` is unavailable (e.g. older browsers,
 *  insecure context). Safe to call once on boot. */
export function initPassiveUpdateDetector(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;
    const checkUpdateAvailable = () => {
      if (reg.waiting && reg.active) {
        markUpdateAvailable();
      }
    };
    // Initial check: a previous SW may already be sitting in
    // `waiting` state from a prior visibility-change update tick.
    checkUpdateAvailable();
    // updatefound fires whenever reg.installing is set (an update
    // begins). Track it through to `installed`.
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          markUpdateAvailable();
        }
      });
    });
  }).catch(() => {});
}

/** Expose `__forceUpdate()` on `window` for DevTools. When the normal
 *  refresh flow gets stuck ("update ready" toast but reload doesn't
 *  pick up the new code — Jonathan, 2026-05-05), the user can type
 *  `__forceUpdate()` in the console: unregisters every SW, deletes
 *  every Cache, then hard-reloads with a cache-bust query.
 *  Deterministic. The normal refresh flow above SHOULD handle this;
 *  this is the escape hatch for when it doesn't. */
export function installForceUpdateConsoleHook(): void {
  (window as any).__forceUpdate = async () => {
    log('[__forceUpdate] starting nuclear SW + cache reset');
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) {
          const ok = await reg.unregister();
          log(`[__forceUpdate] unregister SW ${reg.scope}: ${ok}`);
        }
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        for (const k of keys) {
          await caches.delete(k);
          log(`[__forceUpdate] cache.delete ${k}`);
        }
      }
    } catch (e: any) {
      log(`[__forceUpdate] cleanup error: ${e?.message}`);
    }
    log('[__forceUpdate] reloading…');
    location.replace(location.pathname + '?fresh=' + Date.now());
  };
}
