// Pin the 9c4a043 fix: settings.bargeThreshold flows through into
// the WebRTC offer payload as `barge_threshold`, so the bridge's VAD
// can use a per-user sensitivity instead of the hardcoded default.
//
// Pre-fix the slider was a UI-only no-op since the WebRTC pivot — bridge
// always ran with VAD_RMS_THRESHOLD=300 regardless. Result: speaker→mic
// echo bleed (RMS 700–1200) cancelled the agent's own TTS playback.
//
// Test plan (mocked):
//   1. Stub getUserMedia + RTCPeerConnection so the offer build path
//      runs without a real peer or microphone.
//   2. Intercept POST /api/rtc/offer; capture the body and short-
//      circuit with a 500 (so the connection dies cleanly without
//      the test having to wait for ICE).
//   3. Set settings.bargeThreshold to a known sentinel value.
//   4. Drive openCall('stream') via the controls module (exposed via
//      a temporary __TEST_OPEN_CALL__ shim wired in at boot — falls
//      back to settings flip + mic click if the shim isn't there).
//   5. Assert the captured POST body has `barge_threshold` matching
//      the sentinel (Number-coerced for parity with the prod code).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'barge-threshold-wired';
export const DESCRIPTION = 'settings.bargeThreshold ships through to the WebRTC offer payload';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const SENTINEL = 0.375;  // arbitrary mid-range value, not the default 0.20

export default async function run({ page, log }) {
  // Stub RTCPeerConnection + getUserMedia BEFORE the page boots so the
  // openCall path doesn't actually try to negotiate with a real ICE
  // agent. The connection.ts code calls pc.createOffer + setLocalDesc
  // before POSTing, so we need those to resolve.
  await page.addInitScript(() => {
    const fakeStream = {
      getAudioTracks: () => [{
        stop: () => {}, kind: 'audio', enabled: true, label: 'fake',
        readyState: 'live',
      }],
      getTracks: () => [{ stop: () => {} }],
      getVideoTracks: () => [],
    };
    if (!navigator.mediaDevices) (navigator).mediaDevices = {};
    (navigator).mediaDevices.getUserMedia = async () => fakeStream;

    // Replace RTCPeerConnection with a minimal stub that resolves the
    // createOffer / setLocalDescription pair the offer-builder needs.
    class FakePC extends EventTarget {
      constructor() {
        super();
        this.localDescription = null;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
      }
      addTrack() {}
      addTransceiver() {}
      createDataChannel() {
        const dc = new EventTarget();
        dc.readyState = 'open';
        dc.send = () => {};
        dc.close = () => {};
        return dc;
      }
      async createOffer() { return { sdp: 'v=0\r\n(fake offer)\r\n', type: 'offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription() {}
      addEventListener(_t, _f) { super.addEventListener(_t, _f); }
      close() {}
    }
    window.RTCPeerConnection = FakePC;
  });

  // Capture the offer payload server-side before it goes anywhere.
  let capturedBody = null;
  await page.route('**/api/rtc/offer', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    try { capturedBody = JSON.parse(route.request().postData() || '{}'); }
    catch { capturedBody = null; }
    // Intentionally fail so the open() path bails out fast — we only
    // care about what was sent.
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'test-shortcircuit' }),
    });
  });

  await waitForReady(page);

  // Set the threshold via the settings module (same path the slider
  // takes). settings.set persists; openCall reads
  // settings.get().bargeThreshold synchronously when building the
  // offer payload.
  await page.evaluate(async (threshold) => {
    const settings = await import('/build/settings.mjs');
    settings.set('bargeThreshold', threshold);
  }, SENTINEL);

  // Trigger openCall('stream') by importing the bundled controls
  // module. This is the same call path the mic button takes when
  // settings route to WebRTC. POST is short-circuited above so the
  // open() call rejects after building + sending the offer payload.
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    try { await controls.openCall('stream'); }
    catch { /* expected — POST 500'd by the route handler */ }
  });

  // Wait for the POST to land + be captured.
  const start = Date.now();
  while (!capturedBody && Date.now() - start < 5_000) {
    await page.waitForTimeout(50);
  }

  assert(capturedBody !== null, 'expected POST /api/rtc/offer but none was sent');
  log(`captured offer body: ${JSON.stringify(capturedBody).slice(0, 300)}`);

  assert(
    'barge_threshold' in capturedBody,
    `offer payload missing barge_threshold field; keys: ${JSON.stringify(Object.keys(capturedBody))}`,
  );
  assert(
    typeof capturedBody.barge_threshold === 'number',
    `barge_threshold should be a number, got ${typeof capturedBody.barge_threshold}: ${JSON.stringify(capturedBody.barge_threshold)}`,
  );
  assert(
    Math.abs(capturedBody.barge_threshold - SENTINEL) < 1e-6,
    `barge_threshold mismatch: expected ${SENTINEL}, got ${capturedBody.barge_threshold}`,
  );

  // Bonus: barge_enabled should also be present (same fix wired both
  // through, see commit 05487c8 + 9c4a043).
  assert(
    'barge_enabled' in capturedBody,
    `offer payload missing barge_enabled field; keys: ${JSON.stringify(Object.keys(capturedBody))}`,
  );

  log(`bargeThreshold ${SENTINEL} flowed into offer payload as barge_threshold ✓`);
}
