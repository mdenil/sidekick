// Scenario: the mic-mode menu has a "Realtime" toggle. When OFF (the
// default), tapping the mic with Call mode on arms Listen (turn-based).
// When ON, the same tap opens a WebRTC realtime call.
//
// Asserts:
//   1. The toggle exists in #mic-mode-menu with data-toggle="realtime".
//   2. It starts OFF (default — Listen is the default call transport).
//   3. With Call mode on AND realtime OFF, tapping the mic transitions
//      window.__listen state from idle → armed (no WebRTC call opens).
//   4. Tapping the mic again disarms Listen.
//   5. Flipping realtime ON while armed disarms Listen (intent
//      preservation — user wants WebRTC, not turn-based).

export const NAME = 'listen-mode-toggle';
export const DESCRIPTION = 'Mic-menu Realtime toggle: OFF (default) routes mic taps to Listen; ON routes to WebRTC';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url }) {
  // Bypass real getUserMedia — listen still uses ?listen_mock_mic for the
  // synthetic-frames hook. We stub navigator.mediaDevices.getUserMedia
  // before boot so the listen path's audioPlatform.getMicStream resolves.
  await page.addInitScript(() => {
    const fakeStream = {
      getAudioTracks: () => [{
        stop: () => {}, kind: 'audio', enabled: true, label: 'fake', readyState: 'live',
      }],
      getTracks: () => [{ stop: () => {} }],
      getVideoTracks: () => [],
    };
    if (!navigator.mediaDevices) (navigator).mediaDevices = {};
    (navigator).mediaDevices.getUserMedia = async () => fakeStream;
  });

  await page.goto(`${url}/?listen_mock_mic=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });

  // Listen needs Call mode to be ON (it routes mic-taps; Memo bypasses
  // the realtime branch entirely). Default micCall is false; flip it
  // via the toggle.
  await page.evaluate(() => {
    const btn = document.getElementById('btn-mic-mode');
    btn?.click();
  });
  const callSel = '#mic-mode-menu button.mic-toggle-row[data-toggle="micCall"]';
  await page.waitForSelector(callSel, { timeout: 5_000 });
  await page.click(callSel);
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true',
    callSel,
    { timeout: 3_000, polling: 50 },
  );

  // Realtime toggle: confirm row is present, OFF by default.
  const rtSel = '#mic-mode-menu button.mic-toggle-row[data-toggle="realtime"]';
  await page.waitForSelector(rtSel, { timeout: 5_000 });
  const initial = await page.locator(rtSel).getAttribute('aria-checked');
  if (initial !== 'false') fail(`expected realtime aria-checked=false initially, got ${initial}`);
  log('Realtime toggle present + OFF by default');

  // With Call mode ON and Realtime OFF, mic-tap should arm Listen.
  await page.evaluate(() => document.getElementById('btn-mic')?.click());
  await page.waitForFunction(
    () => (window).__listen && (window).__listen.state === 'armed',
    null,
    { timeout: 5_000, polling: 100 },
  );
  log('mic-button → Listen armed (Call ON + Realtime OFF default)');

  // Tap mic again → disarm.
  await page.evaluate(() => document.getElementById('btn-mic')?.click());
  await page.waitForFunction(
    () => !(window).__listen || (window).__listen.state === 'idle',
    null,
    { timeout: 3_000, polling: 100 },
  );
  log('mic-button tap-when-armed disarms Listen');

  // Flip Realtime ON. Re-arm Listen, then flip Realtime ON should
  // disarm — the user's intent ("switch to WebRTC") wins.
  await page.evaluate(() => document.getElementById('btn-mic')?.click());
  await page.waitForFunction(
    () => (window).__listen && (window).__listen.state === 'armed',
    null,
    { timeout: 5_000, polling: 100 },
  );
  await page.click(rtSel);
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
  log('flipping Realtime ON while armed disarms Listen');
}
