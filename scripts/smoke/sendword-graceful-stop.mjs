// Scenario: pausing/stopping the sendword detector must use the
// GRACEFUL SpeechRecognition.stop(), never abort(). On iOS, starting a
// new SR session ~2s after abort() froze the WebView main thread for
// ~8s while the native speech service recovered (device log
// 2026-06-11T22-18-40 — Jonathan's "app froze ~10s on listen toggle").
// sendwordDetector cycles stop→start at EVERY turn boundary (paused
// during TTS, re-armed after), so an abort anywhere in the lifecycle
// re-opens that freeze window.
//
// Stubs SpeechRecognition with a call recorder; drives a full
// listen → commit → re-arm cycle and asserts:
//   - SR started for the first armed session
//   - commit triggered stop() on that instance
//   - abort() was NEVER called on any instance
//   - a fresh SR instance started after re-arm (lifecycle still cycles)

import { assert } from './lib.mjs';

export const NAME = 'sendword-graceful-stop';
export const DESCRIPTION = 'sendword detector pauses SR via graceful stop() — abort() is never used (iOS 8s-freeze guard)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, url }) {
  await page.route('**/transcribe*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: 'hello' }),
    });
  });
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0, 0, 0, 0x01, 0, 0x01, 0,
      0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 0x02, 0, 0x10, 0,
      0x64, 0x61, 0x74, 0x61, 0, 0, 0, 0,
    ]);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });

  // Recording SR stub, injected before boot. Each instance gets an id;
  // every lifecycle method call lands in window.__SR_CALLS__.
  await page.addInitScript(() => {
    window.__SR_CALLS__ = [];
    let nextId = 0;
    class RecordingSR {
      continuous = false;
      interimResults = false;
      lang = 'en-US';
      onresult = null;
      onend = null;
      onerror = null;
      onstart = null;
      constructor() { this._id = ++nextId; }
      _rec(m) { window.__SR_CALLS__.push(`${m}#${this._id}`); }
      start() {
        this._rec('start');
        try { this.onstart && this.onstart({}); } catch {}
      }
      stop() {
        this._rec('stop');
        try { this.onend && this.onend({}); } catch {}
      }
      abort() {
        this._rec('abort');
        try { this.onend && this.onend({}); } catch {}
      }
    }
    window.SpeechRecognition = RecordingSR;
    window.webkitSpeechRecognition = RecordingSR;
  });

  await page.goto(`${url}/?listen=1&silence_sec=10&listen_mock_mic=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => window.__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });
  await page.waitForFunction(
    () => window.__SR_CALLS__.some((c) => c.startsWith('start#')),
    null, { timeout: 5_000, polling: 100 },
  );
  log(`armed, SR calls: ${JSON.stringify(await page.evaluate(() => window.__SR_CALLS__))}`);

  // Commit the turn — commitNow() pauses the detector (the stop path
  // under test), then the reply/cooldown cycle re-arms a fresh session.
  await page.evaluate(() => window.__listen.commit());
  await page.waitForFunction(
    () => window.__SR_CALLS__.some((c) => c.startsWith('stop#')),
    null, { timeout: 5_000, polling: 100 },
  );

  // Wait for re-arm + a SECOND SR instance to start (stop→start cycle
  // still works with graceful stop).
  await page.waitForFunction(() => window.__listen?.state === 'armed', null, {
    timeout: 15_000, polling: 100,
  });
  await page.waitForFunction(
    () => new Set(
      window.__SR_CALLS__.filter((c) => c.startsWith('start#')).map((c) => c.split('#')[1]),
    ).size >= 2,
    null, { timeout: 10_000, polling: 100 },
  );

  const calls = await page.evaluate(() => window.__SR_CALLS__);
  log(`final SR calls: ${JSON.stringify(calls)}`);
  const aborts = calls.filter((c) => c.startsWith('abort#'));
  assert(aborts.length === 0, `SR.abort() was called (${JSON.stringify(aborts)}) — must use graceful stop() (iOS freeze)`);
  const firstId = calls.find((c) => c.startsWith('start#')).split('#')[1];
  assert(
    calls.includes(`stop#${firstId}`),
    `first SR instance was never stop()ped: ${JSON.stringify(calls)}`,
  );
  log('graceful-stop lifecycle OK: stop→re-arm→fresh start, zero aborts');
}
