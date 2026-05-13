// Mobile drawer swipe invariants (left sidebar + right pin drawer):
//   1. Each drawer can be opened + closed independently via swipe
//   2. Both can overlap (one over the other) and dismissed in either
//      order without the underlying drawer mis-handling the gesture
//   3. Closing one doesn't affect the state of the other
//
// This is the smoke Jonathan specifically asked for ("fiddly one so
// add a smoke that tests one at a time and then both drawers in both
// orders - they will overlap on mobile"). Mobile coverage is gated
// behind the new `MOBILE` scenario flag in lib.mjs — first scenario
// to actually exercise the iPhone-shape harness.
//
// Swipe simulation: synthesizes pointerdown / pointermove / pointerup
// events at the window level since the gesture handlers
// (sidebarSwipe.ts, pinDrawerSwipe.ts) listen on `window`. Multiple
// pointermove steps so the velocity calc has signal.

import {
  waitForReady, assert,
} from './lib.mjs';

export const NAME = 'mobile-drawer-swipes';
export const DESCRIPTION = 'mobile: left sidebar + right pin drawer swipe-to-open/close, separately and overlapping';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = true;

export function MOCK_SETUP(_mock) { /* defaults */ }

/** Synthesize a horizontal swipe by dispatching pointer events.
 *  Events fire on the element at the start coordinate (via
 *  elementFromPoint) so handlers' `target.contains` checks see a
 *  realistic target — pure window-dispatch breaks `sidebar.contains
 *  (e.target)` because e.target is `null` on synthetic window events.
 *  Events also bubble to window where the gesture handlers listen. */
async function swipe(page, fromX, toX, y, steps = 8) {
  await page.evaluate(({ fromX, toX, y, steps }) => {
    const dx = (toX - fromX) / steps;
    const startTarget = document.elementFromPoint(fromX, y) || document.body;
    const opts = (x) => ({
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    startTarget.dispatchEvent(new PointerEvent('pointerdown', opts(fromX)));
    for (let i = 1; i <= steps; i++) {
      const x = fromX + dx * i;
      startTarget.dispatchEvent(new PointerEvent('pointermove', opts(x)));
    }
    startTarget.dispatchEvent(new PointerEvent('pointerup', opts(toX)));
  }, { fromX, toX, y, steps });
  await page.waitForTimeout(300);  // let snap animation finish
}

async function sidebarOpen(page) {
  return page.evaluate(() => !!document.getElementById('sidebar')?.classList.contains('expanded'));
}

async function pinOpen(page) {
  return page.evaluate(() => !document.getElementById('pin-drawer')?.classList.contains('collapsed'));
}

async function forceCloseBoth(page) {
  // Reset state between phases via direct class manipulation — clicks
  // would trigger the gesture handlers we're testing.
  await page.evaluate(() => {
    document.getElementById('sidebar')?.classList.remove('expanded');
    document.body.classList.remove('sidebar-expanded');
    document.getElementById('pin-drawer')?.classList.add('collapsed');
    document.body.classList.remove('pin-drawer-open');
  });
  await page.waitForTimeout(100);
}

async function openSidebarViaSwipe(page) {
  // Drag left-to-right from the LEFT edge. y=400 is mid-screen
  // (390x844 viewport), avoiding header/composer touch targets.
  await swipe(page, 20, 250, 400, 10);
}

async function closeSidebarViaSwipe(page) {
  // Drag right-to-left starting inside the sidebar.
  await swipe(page, 200, 20, 400, 10);
}

async function openPinDrawerViaToggle(page) {
  // The toolbar pin-drawer toggle is .mobile-only; tap it.
  await page.evaluate(() => {
    document.getElementById('btn-pin-drawer')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
  await page.waitForTimeout(200);
}

async function closePinDrawerViaSwipe(page) {
  // Drag left-to-right starting inside the pin drawer (right side).
  // Drawer width on iPhone 390 vw is min(85vw, 320px) = 320px, so a
  // close-swipe needs > 160px of motion to trip the halfway snap.
  // 200→380 = 180px, comfortably past the threshold.
  await swipe(page, 200, 380, 400, 10);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await forceCloseBoth(page);

  // ── Phase 1: sidebar alone ───────────────────────────────────────
  log('phase 1: sidebar alone');
  assert(!(await sidebarOpen(page)), `pre-1: sidebar should start closed`);
  await openSidebarViaSwipe(page);
  assert(await sidebarOpen(page), `phase 1: swipe should open sidebar`);
  log(`  sidebar opened via swipe ✓`);
  await closeSidebarViaSwipe(page);
  assert(!(await sidebarOpen(page)), `phase 1: swipe should close sidebar`);
  log(`  sidebar closed via swipe ✓`);

  // ── Phase 2: pin drawer alone ────────────────────────────────────
  log('phase 2: pin drawer alone');
  await forceCloseBoth(page);
  assert(!(await pinOpen(page)), `pre-2: pin drawer should start closed`);
  await openPinDrawerViaToggle(page);
  assert(await pinOpen(page), `phase 2: tap toggle should open pin drawer`);
  log(`  pin drawer opened via toggle ✓`);
  await closePinDrawerViaSwipe(page);
  assert(!(await pinOpen(page)), `phase 2: swipe should close pin drawer`);
  log(`  pin drawer closed via swipe ✓`);

  // ── Phase 3: sidebar first, then pin drawer ─────────────────────
  log('phase 3: sidebar first, then pin drawer (overlap)');
  await forceCloseBoth(page);
  await openSidebarViaSwipe(page);
  await openPinDrawerViaToggle(page);
  assert(await sidebarOpen(page), `phase 3: sidebar should still be open`);
  assert(await pinOpen(page), `phase 3: pin drawer should be open`);
  // Close pin drawer with swipe — should NOT close the sidebar
  // (gesture target is inside #pin-drawer, sidebar swipe handler
  // bails on that per the 4b54287 fix).
  await closePinDrawerViaSwipe(page);
  assert(!(await pinOpen(page)), `phase 3: pin drawer should close after swipe`);
  assert(await sidebarOpen(page), `phase 3: sidebar should remain open after pin close`);
  log(`  pin closed, sidebar still open ✓`);
  // Now close sidebar — pin drawer already closed, nothing to interfere.
  await closeSidebarViaSwipe(page);
  assert(!(await sidebarOpen(page)), `phase 3: sidebar should close after swipe`);
  log(`  sidebar closed cleanly ✓`);

  // ── Phase 3b: short close-swipe (1/3 threshold) ──────────────────
  // Jonathan field bug 2026-05-13: typical swipes landed at dx~120
  // v~0.5 and snapped back open under the stricter widthPx/2 rule.
  // Lower threshold to widthPx/3 — a flick should close, not a
  // full deliberate half-drag.
  log('phase 3b: short close-swipe should commit at widthPx/3');
  await forceCloseBoth(page);
  await openPinDrawerViaToggle(page);
  assert(await pinOpen(page), `pre-3b: pin drawer should open via toggle`);
  // 200→320 = 120px on a 320px drawer = exactly widthPx/3 + buffer.
  // Pre-fix this would snap back; post-fix it should close.
  await swipe(page, 200, 320, 400, 10);
  assert(!(await pinOpen(page)),
    `phase 3b: short close-swipe should commit at widthPx/3`);
  log(`  short swipe (dx=120, ~1/3) closed drawer ✓`);

  // ── Phase 3c: tap outside drawer dismisses ──────────────────────
  // The X button is the explicit close; tap-anywhere-else should
  // also dismiss on mobile. Same playbook as the sidebar.
  log('phase 3c: tap outside dismisses');
  await forceCloseBoth(page);
  await openPinDrawerViaToggle(page);
  assert(await pinOpen(page), `pre-3c: pin drawer should open via toggle`);
  // Tap the chat area (far left of viewport — drawer occupies the
  // right ~320px on a 390-wide screen so x=30 is comfortably outside).
  await page.evaluate(() => {
    const t = document.elementFromPoint(30, 400) || document.body;
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  assert(!(await pinOpen(page)),
    `phase 3c: tap outside drawer should close it`);
  log(`  tap outside closed drawer ✓`);

  // ── Phase 4: pin drawer first, then sidebar ─────────────────────
  log('phase 4: pin drawer first, then sidebar (overlap, reverse order)');
  await forceCloseBoth(page);
  await openPinDrawerViaToggle(page);
  await openSidebarViaSwipe(page);
  assert(await pinOpen(page), `phase 4: pin drawer should still be open`);
  assert(await sidebarOpen(page), `phase 4: sidebar should be open`);
  // Close sidebar first — pin drawer should remain.
  await closeSidebarViaSwipe(page);
  assert(!(await sidebarOpen(page)), `phase 4: sidebar should close`);
  assert(await pinOpen(page), `phase 4: pin drawer should remain open after sidebar close`);
  log(`  sidebar closed, pin still open ✓`);
  // Close pin drawer with swipe.
  await closePinDrawerViaSwipe(page);
  assert(!(await pinOpen(page)), `phase 4: pin drawer should close after swipe`);
  log(`  pin closed cleanly ✓`);
}
