// Pin sidebarSwipe's pointerdown gating: the open-drawer gesture must
// ONLY engage from the left edge of the viewport AND must NEVER engage
// on text inputs, range sliders, or horizontal-scrollable containers.
//
// Field-reported bug 2026-05-09: "swiping right inside the composer
// textarea opens the drawer, can't text-select." Pre-fix the gesture
// applied `body.swipe-active` (touch-action:none) on every pointerdown
// regardless of target, killing iOS's native text selection.
//
// Asserts (mobile viewport, drawer collapsed):
//   1. pointerdown at clientX=100 (outside edge zone) → no swipe-active.
//   2. pointerdown on textarea even within edge zone → no swipe-active.
//   3. pointerdown on range slider even within edge zone → no swipe-active.
//   4. pointerdown at clientX=10 (edge zone) on body → swipe-active applies.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'sidebar-swipe-gate';
export const DESCRIPTION = 'Open-drawer swipe is edge-only and skips inputs/sliders/h-scrollables';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  // Mobile breakpoint is <700px; sidebarSwipe.ts no-ops above that.
  // The smoke runner's default 1280x800 viewport bypasses the entire
  // gesture, so resize to a phone-shaped viewport for this test.
  await page.setViewportSize({ width: 390, height: 844 });

  await waitForReady(page);

  const swipeActive = () => page.evaluate(() => document.body.classList.contains('swipe-active'));

  // Helper: dispatch a real PointerEvent at given coords with optional
  // target selector. Mirrors what a finger touch would produce.
  const fireDown = async (clientX, clientY, sel) => {
    await page.evaluate(({ clientX, clientY, sel }) => {
      const el = sel ? document.querySelector(sel) : document.body;
      if (!el) throw new Error(`no element for selector ${sel}`);
      const evt = new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, isPrimary: true,
        pointerId: 1, pointerType: 'touch',
        clientX, clientY,
      });
      el.dispatchEvent(evt);
    }, { clientX, clientY, sel });
  };

  const fireUp = async () => {
    await page.evaluate(() => {
      const evt = new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, isPrimary: true,
        pointerId: 1, pointerType: 'touch',
        clientX: 0, clientY: 0,
      });
      document.body.dispatchEvent(evt);
    });
  };

  // ── Case 1: middle-of-screen pointerdown should NOT engage ──────────
  await fireDown(200, 400, null);
  assert(!(await swipeActive()),
    'pointerdown at clientX=200 (outside edge) should NOT apply swipe-active');
  await fireUp();
  log('mid-screen pointerdown: gesture inactive ✓');

  // ── Case 2: pointerdown on composer textarea (even at edge) ─────────
  // The textarea sits well past the edge zone in normal layout, but
  // the textarea-target bail must hold even if the layout placed it
  // right against the edge. Set a temporary CSS override to put it
  // at x=0 so the test pin BOTH gates simultaneously.
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    if (ta) (ta).style.cssText += ';position:fixed;left:0;top:50%;width:200px;height:40px;z-index:9999';
  });
  await fireDown(10, 420, '#composer-input');
  assert(!(await swipeActive()),
    'pointerdown on composer textarea should NOT apply swipe-active even within edge zone');
  await fireUp();
  log('textarea pointerdown: gesture inactive ✓');

  // ── Case 3: pointerdown on a range slider ──────────────────────────
  // Inject a temporary <input type=range> at x=0 to pin the gate.
  await page.evaluate(() => {
    const r = document.createElement('input');
    r.type = 'range'; r.id = 'smoke-test-slider';
    r.style.cssText = 'position:fixed;left:0;top:60%;width:200px;z-index:9999';
    document.body.appendChild(r);
  });
  await fireDown(10, 530, '#smoke-test-slider');
  assert(!(await swipeActive()),
    'pointerdown on range slider should NOT apply swipe-active');
  await fireUp();
  log('range-slider pointerdown: gesture inactive ✓');

  // ── Case 4: pointerdown at the actual edge on body — engages ────────
  // Reset the textarea position so it doesn't sit at the edge anymore.
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    if (ta) (ta).style.cssText = '';
    const slider = document.getElementById('smoke-test-slider');
    slider?.remove();
  });
  await fireDown(10, 200, null);
  assert(await swipeActive(),
    'pointerdown at clientX=10 on body SHOULD apply swipe-active (this IS the open-drawer entry path)');
  await fireUp();
  // After pointerup with no horizontal motion, gesture resets and
  // swipe-active is dropped.
  await page.waitForFunction(() => !document.body.classList.contains('swipe-active'),
    null, { timeout: 1000 });
  log('edge-zone pointerdown on body: gesture engaged then released ✓');
}
