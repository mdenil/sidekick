// Pin the iOS-tap regression Jonathan personally hit: a tooltip
// that was about to appear (after the 300ms hover delay) must be
// CANCELLED if the user taps before it shows. Without this, on
// touch devices the tooltip would render on top of the very thing
// the user just tapped — most visible bug being a lingering
// tooltip floating above the lockscreen when a UI element fired a
// keep-screen-on call.
//
// Implementation: `pointerdown` and `touchstart` listeners on
// window with capture=true call hideTip() in main.ts (lines 942-
// 943). hideTip clears tipShowTimer + removes the .app-tooltip
// element from the DOM.
//
// Refactor risk: the tooltip module is a candidate for extraction
// to src/util/tooltip.ts (per the pre-refactor audit). If the
// extraction loses the pointerdown/touchstart bindings or drops
// the capture=true flag, this smoke fails — surfaces the
// regression before it ships.
//
// Test plan:
//   1. Add a button with a `title` attribute to the page.
//   2. Hover (pointerenter) over it. Don't wait the 300ms.
//   3. Fire pointerdown before 300ms elapses.
//   4. Wait 400ms total.
//   5. Assert no `.app-tooltip` element exists in the DOM.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'tooltip-hide-on-pointerdown';
export const DESCRIPTION = 'Pending tooltip is cancelled by pointerdown before its 300ms delay elapses';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);

  // Inject a test button with a `title` attr so the tooltip system
  // picks it up. Position fixed so we don't need to chase layout.
  await page.evaluate(() => {
    const btn = document.createElement('button');
    btn.id = 'smoke-tooltip-target';
    btn.title = 'smoke-tooltip-text';
    btn.textContent = 'hover me';
    btn.style.cssText = 'position:fixed;top:200px;left:200px;width:120px;height:40px;z-index:99999';
    document.body.appendChild(btn);
  });

  // Fire pointerenter (the trigger that schedules tipShowTimer).
  await page.evaluate(() => {
    const btn = document.getElementById('smoke-tooltip-target');
    const evt = new PointerEvent('pointerenter', {
      bubbles: true, cancelable: true, isPrimary: true,
      pointerId: 1, pointerType: 'mouse',
    });
    btn?.dispatchEvent(evt);
  });
  log('pointerenter fired on test button — tipShowTimer scheduled');

  // Wait 100ms so the timer is mid-flight but hasn't fired yet
  // (timer is 300ms). Then fire pointerdown which should cancel.
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const evt = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, isPrimary: true,
      pointerId: 1, pointerType: 'touch',
    });
    document.body.dispatchEvent(evt);
  });
  log('pointerdown fired before tooltip would have shown — should cancel');

  // Wait past the 300ms timer threshold.
  await page.waitForTimeout(350);

  const tooltipPresent = await page.evaluate(
    () => !!document.querySelector('.app-tooltip'),
  );
  assert(
    !tooltipPresent,
    'tooltip should NOT appear after pointerdown cancellation — iOS-tap regression',
  );
  log('no .app-tooltip in DOM after pointerdown cancellation ✓');
}
