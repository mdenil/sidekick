// Optimistic capture, Phase 1 (task #195): cold-start splice.
//
// The bridge's STT pipe takes seconds to go hot after the user taps
// call (mic → SDP → Deepgram → first `listening` envelope). Speech in
// that gap is invisible to the bridge but captured by the parallel
// whole-call MediaRecorder (callCapture.ts). At the first `listening`,
// callCapture transcribes the head of the recording (gap + 2s overlap)
// via /transcribe; the call's FIRST dispatch splices that head onto the
// bridge transcript with stitchTranscripts (overlap words dedup the
// seam).
//
// Locked-in behaviors:
//   1. Orange pre-listening state: btn-call gets `.capturing` from call
//      open until the first `listening` envelope, then hands back.
//   2. First dispatch text = stitchTranscripts([head, utterance]) — the
//      seam-overlap words appear exactly once.
//   3. takeHead is single-consume: the SECOND dispatch of the same call
//      goes out un-spliced.
//   4. The recorder stops on close (final-chunk flush before mic release).
//
// Test plan (mocked):
//   - FakePC stub (same as realtime-barge-client-side); the mic stream is
//     Chromium's fake device, so a REAL MediaRecorder runs and real webm
//     chunks decode in extractHead.
//   - /transcribe is routed to return a fixed head transcript whose last
//     3 words ("charlie delta echo") are the first 3 words of the bridge
//     utterance — exercising the ≥3-word seam dedup in stitchTranscripts.
//   - Bridge envelopes (listening, user finals) are injected as
//     MessageEvents on the fake data channel (realtime.ts subscribes via
//     addEventListener('message')).
//   - The `listening` injection is delayed past MIN_GAP_MS (1s) so the
//     head extraction isn't skipped as a too-small gap.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'realtime-coldstart-splice';
export const DESCRIPTION = 'callCapture head + stitchTranscripts splice on first dispatch; orange capturing state until first listening; second dispatch un-spliced';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const HEAD_TRANSCRIPT = 'alpha bravo charlie delta echo';
const SPLICED_EXPECTED = 'alpha bravo charlie delta echo foxtrot golf';

export default async function run({ page, log, mock }) {
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));

  await page.addInitScript(() => {
    (window).__TEST_DC_SENDS__ = [];
    (window).__TEST_FAKE_PC__ = null;

    class FakePC extends EventTarget {
      constructor() {
        super();
        this.localDescription = null;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this._dataChannels = [];
        (window).__TEST_FAKE_PC__ = this;
      }
      addTrack() {}
      addTransceiver() {}
      createDataChannel(_label, _opts) {
        const dc = new EventTarget();
        dc.readyState = 'open';
        dc.label = _label;
        dc.send = (payload) => {
          (window).__TEST_DC_SENDS__.push(
            typeof payload === 'string' ? payload : '<binary>',
          );
        };
        dc.close = () => { dc.readyState = 'closed'; };
        queueMicrotask(() => {
          try { dc.dispatchEvent(new Event('open')); } catch {}
        });
        this._dataChannels.push(dc);
        return dc;
      }
      async createOffer() { return { sdp: 'v=0\r\n(fake offer)\r\n', type: 'offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription() {}
      close() { this.connectionState = 'closed'; }
      _setConnectionState(s) {
        this.connectionState = s;
        this.dispatchEvent(new Event('connectionstatechange'));
      }
    }
    (window).RTCPeerConnection = FakePC;
  });

  // ── Routes: WebRTC signalling + the head /transcribe probe ──────────
  let transcribeHits = 0;
  await page.route('**/transcribe', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    transcribeHits++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: HEAD_TRANSCRIPT }),
    });
  });
  await page.route('**/api/rtc/offer', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        peer_id: 'fake-peer-id',
        sdp: 'v=0\r\n(fake answer)\r\n',
        type: 'answer',
      }),
    });
  });
  await page.route('**/api/rtc/ice', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/rtc/close', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/sidekick/config/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await waitForReady(page);

  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('commitPhrase', 'over');
    settings.set('silenceSec', 0); // sendword-only — deterministic dispatch timing
  });

  // ── Open a talk-mode call, drive it connected ────────────────────────
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    try { await controls.openCall('talk'); }
    catch (e) { (window).__TEST_OPEN_ERR__ = String(e?.message || e); }
  });
  const openErr = await page.evaluate(() => (window).__TEST_OPEN_ERR__ || null);
  assert(!openErr, `openCall failed: ${openErr}`);
  await page.waitForFunction(() => !!(window).__TEST_FAKE_PC__, null, { timeout: 5_000 });
  await page.evaluate(() => {
    (window).__TEST_FAKE_PC__._setConnectionState('connected');
  });

  // (1) Pre-listening: orange capturing state is up.
  await page.waitForFunction(
    () => document.getElementById('btn-call')?.classList.contains('capturing'),
    null, { timeout: 2_000 },
  );
  log('pre-listening: btn-call.capturing present OK');
  assert(
    consoleLines.some((l) => l.includes('[call-capture] start')),
    'expected [call-capture] start log — recorder did not start with the call',
  );

  // ── Inject the first `listening` AFTER MIN_GAP_MS (1s) ──────────────
  // The cold-start gap must register as "big enough to have missed
  // speech" or callCapture skips the head entirely.
  await page.waitForTimeout(1_400);
  const injectEnvelope = (obj) => page.evaluate((payload) => {
    const dc = (window).__TEST_FAKE_PC__._dataChannels[0];
    dc.dispatchEvent(new MessageEvent('message', { data: payload }));
  }, JSON.stringify(obj));
  await injectEnvelope({ type: 'listening' });

  // (1b) Listening clears the orange state.
  await page.waitForFunction(
    () => !document.getElementById('btn-call')?.classList.contains('capturing'),
    null, { timeout: 2_000 },
  );
  log('post-listening: btn-call.capturing cleared OK');

  // ── First utterance: bridge finals ending in the sendword ────────────
  // First 3 words overlap the head's last 3 ("charlie delta echo") so
  // the stitch has a seam to dedup.
  await injectEnvelope({ type: 'transcript', role: 'user', text: 'charlie delta echo foxtrot golf', is_final: true });
  await injectEnvelope({ type: 'transcript', role: 'user', text: 'over', is_final: true });

  // Dispatch waits for the head: extraction fires ~3.2s after listening
  // (overlap + chunk slack), then the mocked /transcribe returns
  // instantly. takeHead caps the wait at 4s. Allow 8s end-to-end.
  const findDispatches = () => page.evaluate(() => {
    return (window).__TEST_DC_SENDS__
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((o) => o && o.type === 'dispatch');
  });
  let dispatches = [];
  const t0 = Date.now();
  while (dispatches.length < 1 && Date.now() - t0 < 8_000) {
    dispatches = await findDispatches();
    if (dispatches.length < 1) await page.waitForTimeout(150);
  }
  assert(dispatches.length >= 1, 'no dispatch envelope on the data channel within 8s');
  log(`first dispatch after ${Date.now() - t0}ms: ${JSON.stringify(dispatches[0])}`);

  // (2) Spliced text: head + utterance with the seam deduped.
  assert(
    dispatches[0].text === SPLICED_EXPECTED,
    `first dispatch should be the spliced text "${SPLICED_EXPECTED}" — got "${dispatches[0].text}"`,
  );
  assert(transcribeHits === 1, `expected exactly 1 head /transcribe POST, got ${transcribeHits}`);
  assert(
    consoleLines.some((l) => l.includes('[dictation] cold-start splice')),
    'expected the [dictation] cold-start splice log line',
  );

  // ── Second utterance: head is consumed → un-spliced dispatch ─────────
  await injectEnvelope({ type: 'transcript', role: 'user', text: 'second utterance test', is_final: true });
  await injectEnvelope({ type: 'transcript', role: 'user', text: 'over', is_final: true });
  const t1 = Date.now();
  while (dispatches.length < 2 && Date.now() - t1 < 5_000) {
    dispatches = await findDispatches();
    if (dispatches.length < 2) await page.waitForTimeout(150);
  }
  assert(dispatches.length >= 2, 'no second dispatch envelope within 5s');
  log(`second dispatch: ${JSON.stringify(dispatches[1])}`);
  assert(
    dispatches[1].text === 'second utterance test',
    `second dispatch must be un-spliced (takeHead single-consume) — got "${dispatches[1].text}"`,
  );
  assert(transcribeHits === 1, `head /transcribe must not re-fire on later dispatches, got ${transcribeHits}`);

  // ── (4) Close: recorder stops + flushes ──────────────────────────────
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.closeIfOpen();
  });
  const tStop = Date.now();
  let stopSeen = false;
  while (!stopSeen && Date.now() - tStop < 3_000) {
    stopSeen = consoleLines.some((l) => l.includes('[call-capture] stop'));
    if (!stopSeen) await page.waitForTimeout(100);
  }
  assert(stopSeen, 'expected [call-capture] stop log on call close');

  assert(
    mock.chatCount() === 0,
    `mock backend was unexpectedly populated (chatCount=${mock.chatCount()})`,
  );

  log('cold-start splice: capturing state OK | spliced first dispatch OK | un-spliced second OK | recorder stop OK');
}
