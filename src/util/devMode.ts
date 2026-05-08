/**
 * @fileoverview Dev-mode flag — single source of truth for "user wants
 * full diagnostic instrumentation enabled."
 *
 * When ON, behaves as if `?debug=1&debug-relay=1&dictate-debug=1` were
 * present in the URL: high-frequency log()/diag() emit, dictate.ts
 * dlog phase logs fire, log lines stream to /tmp/sidekick-debug/<sid>.log
 * via the relay endpoint.
 *
 * Why a single flag (not three): for Jonathan's on-the-go workflow
 * (catch a bug while biking → open Claude → "look at the log"),
 * he wants either ALL diagnostics or none. The three URL flags exist
 * for surgical desktop debugging where you might enable just one.
 *
 * ── Transparency ─────────────────────────────────────────────────────
 *
 * URL `?debug=1` etc. remains transparent (visible in address bar) on
 * desktop. In standalone PWA mode the address bar isn't visible, so
 * the substitute is a "DEV" pill in the header (rendered by
 * mountDevPill below) that's unmissable when on. No DEV pill = dev
 * mode is off, period.
 *
 * ── Toggle ───────────────────────────────────────────────────────────
 *
 * Long-press the app version label (e.g. "v0.473") to flip the flag.
 * Easter-egg style — discoverable to anyone investigating the version
 * label, invisible to normal users (e.g. on Mom's Pi5 ADHD assistant).
 */

/** True when dev mode is active. Computed at module load — refresh
 *  via hard reload after toggling, the same as URL flags. */
export function isDevMode(): boolean {
  try {
    const qs = new URLSearchParams(location.search);
    // URL flags take precedence: ?debug=0 etc. are explicit kills.
    if (qs.get('debug') === '0' || qs.get('debug-relay') === '0' || qs.get('dictate-debug') === '0') {
      return false;
    }
    if (qs.get('debug') === '1' || qs.get('debug-relay') === '1' || qs.get('dictate-debug') === '1') {
      return true;
    }
    return localStorage.getItem('dev_mode') === '1';
  } catch { return false; }
}

/** Persist the dev-mode flag. Caller should reload the page after
 *  setting so the various module-level flag reads pick it up. */
export function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem('dev_mode', '1');
    else localStorage.removeItem('dev_mode');
  } catch {}
}

/** Mount the DEV pill in the header AND wire the long-press toggle on
 *  the app version label. Call once at boot from main.ts. Idempotent —
 *  safe to call multiple times (won't double-mount).
 *
 *  Long-press = pointerdown + 600ms hold + pointerup-without-leave.
 *  600ms is short enough to feel intentional, long enough to never
 *  collide with a click on the version label (no other behavior). */
export function mountDevPill(): void {
  const versionEl = document.getElementById('app-version');
  if (!versionEl) return;
  if (versionEl.dataset.devPillMounted === '1') return;
  versionEl.dataset.devPillMounted = '1';

  // Render the pill if currently in dev mode. Pill lives next to the
  // version label so anyone looking at "v0.473" sees "v0.473 DEV".
  function renderPill(): void {
    const existing = document.getElementById('dev-pill');
    if (isDevMode()) {
      if (existing) return;
      const pill = document.createElement('span');
      pill.id = 'dev-pill';
      pill.className = 'dev-pill';
      pill.textContent = 'DEV';
      pill.title = 'Dev mode on — full diagnostics + log relay. Long-press version to toggle off.';
      versionEl!.insertAdjacentElement('afterend', pill);
    } else if (existing) {
      existing.remove();
    }
  }
  renderPill();

  // Long-press toggle. Pointer-events for cross-platform (mouse + touch)
  // without the iOS contextual-menu trigger that comes with `touchstart`.
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const HOLD_MS = 600;
  const cancel = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  };
  versionEl.style.cursor = 'pointer';
  versionEl.addEventListener('pointerdown', () => {
    cancel();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      const next = !isDevMode();
      setDevMode(next);
      // The runtime flags in log.ts / dictate.ts are computed at module
      // load, so a reload is needed for them to pick up the change.
      // Render the pill state change immediately so the toggle FEELS
      // responsive, then ask the user to reload to actually flip
      // diagnostics. (Alternative: hot-rewire the flags via setters,
      // but that's more code than it's worth for an easter-egg toggle.)
      renderPill();
      const msg = next
        ? 'Dev mode ON. Reload to start streaming logs to /tmp/sidekick-debug/.'
        : 'Dev mode OFF. Reload to stop log relay.';
      // alert is ugly but reliable on iOS PWA where toasts may be
      // hidden by the soft keyboard or fail to show. Acceptable for
      // an easter-egg admin toggle.
      try { alert(msg); } catch {}
    }, HOLD_MS);
  });
  versionEl.addEventListener('pointerup', cancel);
  versionEl.addEventListener('pointerleave', cancel);
  versionEl.addEventListener('pointercancel', cancel);
}
