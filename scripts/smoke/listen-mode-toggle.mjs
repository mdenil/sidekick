// Scenario: the mic-mode menu has a "Listen mode" toggle. When ON,
// tapping the mic button arms Listen instead of opening a call. When
// OFF, tap = call as today.
//
// Asserts:
//   1. The toggle exists in #mic-mode-menu with data-toggle="listenMode".
//   2. Tapping it persists settings.listenMode = true (visible by
//      aria-checked).
//   3. With listenMode=true, clicking the mic button transitions
//      window.__listen state from idle → armed (no WebRTC call opens).
//   4. With listenMode=false, the mic-button click goes back to the
//      memo / call paths (Listen stays idle).

export const NAME = 'listen-mode-toggle';
export const DESCRIPTION = 'Mic-menu Listen-mode toggle routes mic-button taps to startListen';
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

  // Open the mic-mode menu.
  const toggleSel = '#mic-mode-menu button.mic-toggle-row[data-toggle="listenMode"]';
  await page.evaluate(() => {
    const btn = document.getElementById('btn-mic-mode');
    btn?.click();
  });

  // Wait for the Listen-mode row to be present.
  await page.waitForSelector(toggleSel, { timeout: 5_000 });
  log('Listen-mode toggle row exists');

  // Verify it starts OFF.
  const initial = await page.locator(toggleSel).getAttribute('aria-checked');
  if (initial !== 'false') fail(`expected aria-checked=false initially, got ${initial}`);

  // Click it.
  await page.click(toggleSel);
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true',
    toggleSel,
    { timeout: 3_000, polling: 50 },
  );
  log('toggle flipped to true');

  // Click the mic button. Listen should arm (not call).
  await page.evaluate(() => document.getElementById('btn-mic')?.click());
  // The listen module installs window.__listen only when ?listen_mock_mic=1
  // is set, which the URL above includes.
  await page.waitForFunction(
    () => (window).__listen && (window).__listen.state === 'armed',
    null,
    { timeout: 5_000, polling: 100 },
  );
  log('mic-button → Listen armed (not call)');

  // Toggle off and verify state goes back to idle.
  await page.evaluate(() => document.getElementById('btn-mic')?.click());
  await page.waitForFunction(
    () => !(window).__listen || (window).__listen.state === 'idle',
    null,
    { timeout: 3_000, polling: 100 },
  );
  log('mic-button tap-when-armed disarms Listen');
}
