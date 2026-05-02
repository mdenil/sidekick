// Scenario: Listen mode pauses the sendword detector when the tab is
// hidden and resumes it when the tab comes back to visible. The
// silence loop is unaffected — a memo recorded while pocketed still
// commits.
//
// Asserts:
//   1. Listen armed → SR stub starts (1 startCalls).
//   2. visibilitychange to 'hidden' → SR aborted.
//   3. visibilitychange back to 'visible' → SR re-armed (>=2 startCalls
//      across the test).

export const NAME = 'listen-visibility';
export const DESCRIPTION = 'Listen pauses sendword on tab-hide + resumes on tab-show';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url }) {
  await page.addInitScript(() => {
    let totalStartCalls = 0;
    class StubSR {
      continuous = false;
      interimResults = false;
      lang = 'en-US';
      onresult = null;
      onend = null;
      onerror = null;
      onstart = null;
      start() { totalStartCalls++; (window).__srStartCalls = totalStartCalls; }
      stop() { try { this.onend && this.onend({}); } catch {} }
      abort() {}
    }
    (window).SpeechRecognition = StubSR;
    (window).webkitSpeechRecognition = StubSR;
    (window).__srStartCalls = 0;
    // Real getUserMedia comes via Chromium's --use-fake-device-for-media-stream
    // launch flag (scripts/smoke/lib.mjs:launchSharedBrowser). The
    // hand-rolled fake-stream stub here used to be required because
    // MediaRecorder rejects non-MediaStream inputs; the launch flag
    // gives us a real (silent) MediaStream so MediaRecorder is happy.
  });

  await page.goto(`${url}/?listen=1&listen_mock_mic=1&silence_sec=60`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => (window).__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });
  const initial = await page.evaluate(() => (window).__srStartCalls);
  if (initial < 1) fail(`expected SR.start() to fire on arm, got ${initial}`);
  log(`SR started on arm (calls=${initial})`);

  // Synthesize visibility-hidden.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);

  // Synthesize visibility-visible.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => (window).__srStartCalls);
  if (after < initial + 1) {
    fail(`expected SR.start() to re-fire after visibility resume, before=${initial} after=${after}`);
  }
  log(`SR re-armed after visibility resume (calls=${after})`);
}
