// Pin the new call-button (btn-call) tap-to-toggle behavior + the
// Realtime toggle's transport switch.
//
// The two-button-split refactor (2026-05) put a dedicated headset
// button on the LEFT of the composer for calls. Tap behavior depends
// on the `realtime` setting in the call-menu chevron:
//
//   realtime=false (default) → arms turn-based Listen
//   realtime=true            → opens a WebRTC realtime call
//
// Tapping btn-call again while a call is active ends it.
//
// Asserts:
//   1. #btn-call exists in the composer.
//   2. The Realtime toggle exists in #call-mode-menu (not the
//      mic-mode menu — it's a call concern, lives in the call menu).
//   3. Realtime defaults OFF.
//   4. Tap btn-call with realtime=false → window.__listen.state goes
//      armed (no WebRTC opens).
//   5. Tap btn-call again → Listen disarms.
//   6. Flip realtime ON while Listen is armed → Listen disarms (the
//      user's intent — switch transport — wins).

import { tapMic /* unused, but anchors lib import shape */ } from './lib.mjs';

export const NAME = 'call-button-toggle';
export const DESCRIPTION = 'btn-call tap-to-toggle: realtime=false arms Listen, =true opens WebRTC, tap-again ends';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

/** Synthesize a tap on btn-call. The button uses pointerdown (no
 *  state machine, no PTT) — element.click() doesn't fire its handler. */
async function tapCall(page, { afterPrevTapMs = 0 } = {}) {
  if (afterPrevTapMs > 0) await page.waitForTimeout(afterPrevTapMs);
  await page.evaluate(() => {
    const btn = document.getElementById('btn-call');
    if (!btn) throw new Error('tapCall: #btn-call not found');
    const opts = { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1 };
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
  });
}

export default async function run({ page, log, fail, url }) {
  // Real getUserMedia comes via Chromium's --use-fake-device-for-media-stream
  // launch flag. `?listen_mock_mic=1` arms the synthetic-frames hook so
  // turn-based Listen's silence/sendword detection has predictable input.
  await page.goto(`${url}/?listen_mock_mic=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(
    () => /Connected/.test(document.body.innerText),
    null,
    { timeout: 15_000, polling: 250 },
  );

  // 1. btn-call exists.
  const btnCall = await page.locator('#btn-call').count();
  if (btnCall < 1) fail('expected #btn-call to be present in composer');
  log('btn-call present in composer ✓');

  // 2. Open the call-menu chevron and check Realtime toggle exists IN
  //    that menu (not in #mic-mode-menu, which is now the mic-only menu).
  await page.evaluate(() => {
    const btn = document.getElementById('btn-call-mode');
    btn?.click();
  });
  const rtSel = '#call-mode-menu button.mic-toggle-row[data-toggle="realtime"]';
  await page.waitForSelector(rtSel, { timeout: 5_000 });

  // 3. Realtime defaults OFF.
  const initial = await page.locator(rtSel).getAttribute('aria-checked');
  if (initial !== 'false') fail(`expected realtime aria-checked=false initially, got ${initial}`);
  log('Realtime toggle present in #call-mode-menu, OFF by default ✓');

  // 4. Tap btn-call with realtime=false → Listen arms.
  await tapCall(page);
  await page.waitForFunction(
    () => (window).__listen && (window).__listen.state === 'armed',
    null,
    { timeout: 5_000, polling: 100 },
  );
  log('btn-call → Listen armed (realtime OFF default) ✓');

  // 5. Tap btn-call again → Listen disarms. No double-tap guard on
  //    btn-call (calls don't have the gesture state machine), but a
  //    short pause keeps the test deterministic.
  await tapCall(page, { afterPrevTapMs: 200 });
  await page.waitForFunction(
    () => !(window).__listen || (window).__listen.state === 'idle',
    null,
    { timeout: 3_000, polling: 100 },
  );
  log('btn-call tap-when-armed disarms Listen ✓');

  // 6. Flip realtime ON while Listen is armed → Listen disarms (intent
  //    preservation: user wants WebRTC, not turn-based). Tap a third
  //    time to re-arm; capture mutex needs a beat to fully release
  //    after disarm before re-acquire works cleanly.
  await tapCall(page, { afterPrevTapMs: 500 });
  await page.waitForFunction(
    () => (window).__listen && (window).__listen.state === 'armed',
    null,
    { timeout: 10_000, polling: 100 },
  );
  // Click the realtime toggle. Use an in-page click on the button so
  // we route through its bound onclick handler (which calls
  // flipMicSetting). We don't strictly need the menu visible to do
  // that — flipping the underlying setting is what matters for the
  // test assertion below.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} not found`);
    el.click();
  }, rtSel);
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true',
    rtSel,
    { timeout: 3_000, polling: 50 },
  );
  await page.waitForFunction(
    () => !(window).__listen || (window).__listen.state === 'idle',
    null,
    { timeout: 3_000, polling: 100 },
  );
  log('flipping Realtime ON while armed disarms Listen ✓');
}
