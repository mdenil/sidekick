// Pin sidebarSwipe's pointerdown gating. The open-drawer gesture engages
// anywhere on screen (ChatGPT iOS pattern — no edge requirement), but
// MUST NOT engage on text inputs, range sliders, or horizontal-scrollable
// containers — those own horizontal touch natively.
//
// Field-reported bug 2026-05-09: "swiping right inside the composer
// textarea opens the drawer, can't text-select." Pre-fix the gesture
// applied `body.swipe-active` (touch-action:none) on every pointerdown
// regardless of target, killing iOS's native text selection.
//
// Asserts (mobile viewport, drawer collapsed):
//   1. pointerdown anywhere on body (edge OR mid-screen) → swipe-active
//      applies — this IS the ChatGPT-style open path.
//   2. pointerdown on textarea → no swipe-active (iOS native selection).
//   3. pointerdown on range slider → no swipe-active (iOS native drag).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'sidebar-swipe-gate';
export const DESCRIPTION = 'Open-drawer swipe engages anywhere on screen but skips inputs/sliders/h-scrollables';
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

  // ── Case 1: pointerdown on textarea (would-be-but-no) ─────────────
  // The textarea-target bail must hold regardless of x position.
  await fireDown(200, 420, '#composer-input');
  assert(!(await swipeActive()),
    'pointerdown on composer textarea should NOT apply swipe-active');
  await fireUp();
  log('textarea pointerdown: gesture inactive ✓');

  // ── Case 2: pointerdown on a range slider ─────────────────────────
  await page.evaluate(() => {
    const r = document.createElement('input');
    r.type = 'range'; r.id = 'smoke-test-slider';
    r.style.cssText = 'position:fixed;left:50px;top:60%;width:200px;z-index:9999';
    document.body.appendChild(r);
  });
  await fireDown(150, 530, '#smoke-test-slider');
  assert(!(await swipeActive()),
    'pointerdown on range slider should NOT apply swipe-active');
  await fireUp();
  log('range-slider pointerdown: gesture inactive ✓');

  // ── Case 3: pointerdown anywhere on body — engages ────────────────
  // Sanity that the input bails above weren't accidentally so broad
  // they killed the gesture entirely. Mid-screen on body must engage
  // (this is the whole point of the ChatGPT-style anywhere-on-screen
  // affordance).
  await page.evaluate(() => {
    document.getElementById('smoke-test-slider')?.remove();
  });
  await fireDown(200, 300, null);
  assert(await swipeActive(),
    'pointerdown anywhere on body SHOULD apply swipe-active (this IS the open-drawer entry path)');
  await fireUp();
  await page.waitForFunction(() => !document.body.classList.contains('swipe-active'),
    null, { timeout: 1000 });
  log('mid-screen pointerdown on body: gesture engaged then released ✓');
}
