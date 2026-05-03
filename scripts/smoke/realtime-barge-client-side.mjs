// Lock in the unified barge architecture (v0.381):
//
//   1. Realtime barge fires from the CLIENT side (PWA), via the shared
//      BargeWindow detector + readPeak loop in realtimeBarge.ts.
//   2. The bridge no longer initiates barges — it only RECEIVES the
//      upstream {type:'barge'} envelope and halts the TTS track. The
//      old bridge-side Python RMS VAD is retired (commit 53970d9 added
//      the upstream-handler path; the client-side fire is wired via
//      controls.ts on call-state 'connected').
//
// Why a smoke for this: prevents future regression to the bridge-side
// VAD path. The architecture is intentionally one detector, one tuning,
// one set of bugs (see realtimeBarge.ts module docstring) — a silent
// revert to the dual-detector world would be a real-bug magnet.
//
// Test plan (mocked):
//   1. Stub RTCPeerConnection so we can drive connectionstate
//      transitions manually and capture every data-channel send.
//      getUserMedia uses chromium's --use-fake-device-for-media-stream
//      so platform.getMicAnalyser can build a real AnalyserNode.
//   2. Patch AnalyserNode.prototype.getByteTimeDomainData to inject
//      saturation peaks (255/0 alternating) when window.__TEST_INJECT_PEAK__
//      is true — that way the readPeak()/BargeWindow path runs end-to-end
//      with a real analyser, no hand-rolled peak hooks needed.
//   3. Open a talk-mode call via controls.openCall('talk'). The state-
//      listener in controls.ts wires realtimeBarge.start() on
//      connectionstate='connected'.
//   4. Drive connectionstate='connected' on the FakePC so the state
//      listener fires (the event triggers controls.ts to start the
//      barge loop).
//   5. Mark TTS as playing by calling webrtcSuppress.onAssistantDelta()
//      — the barge loop only ticks while suppress.isSuppressing() is
//      true (mirrors real "TTS is producing audio" gate).
//   6. Flip __TEST_INJECT_PEAK__=true; wait ~750 ms (500 ms warmup +
//      5 frames at 50 ms cadence + buffer).
//   7. Assert:
//      - data channel saw an UPSTREAM JSON.stringify({type:'barge'}) send.
//      - playFeedback was invoked with type='barge' (via the
//        __TEST_FEEDBACK_LOG__ hook in feedback.ts).
//      - the mock backend NEVER pushed a downstream {type:'barge'}
//        envelope (negative — the bridge VAD path is retired).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'realtime-barge-client-side';
export const DESCRIPTION = 'client-side BargeWindow fires + sends upstream {type:\'barge\'}; bridge does not initiate';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  // ── Stub WebRTC + instrumentation hooks BEFORE the page boots ────────
  // Watch console for the downstream-barge log line in main.ts (line ~1025).
  // If the bridge ever revived its VAD path AND fired before our upstream
  // fire, that line would appear and the negative assertion would fail.
  let bridgeInitiatedSeen = false;
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('server-side barge fired')) bridgeInitiatedSeen = true;
  });
  await page.addInitScript(() => {
    // Spy buckets — populated from inside the page.
    /** @type {string[]} Every dataChannel.send() payload (upstream). */
    (window).__TEST_DC_SENDS__ = [];
    /** Toggle: when true, AnalyserNode returns saturation peaks. */
    (window).__TEST_INJECT_PEAK__ = false;
    /** Opt-in to feedback.ts's chime spy (already implemented there). */
    (window).__TEST_FEEDBACK_LOG__ = [];
    /** Per-FakePC handle so the test can flip state to 'connected'. */
    (window).__TEST_FAKE_PC__ = null;

    // Patch AnalyserNode's time-domain reader. When the test flips
    // __TEST_INJECT_PEAK__ on, every readPeak() call sees a saturated
    // signal and BargeWindow's threshold is comfortably exceeded.
    const realRead = AnalyserNode.prototype.getByteTimeDomainData;
    AnalyserNode.prototype.getByteTimeDomainData = function(arr) {
      if ((window).__TEST_INJECT_PEAK__) {
        for (let i = 0; i < arr.length; i++) arr[i] = i % 2 ? 255 : 0;
        return;
      }
      realRead.call(this, arr);
    };

    // FakePC — minimal stand-in for RTCPeerConnection. Intercepts
    // createDataChannel().send() (so we can see the upstream envelope)
    // and exposes a setConnectionState() helper so the test can drive
    // the connectionstatechange transition that controls.ts watches.
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
        // Open synchronously after return so the controls/realtime
        // wiring (which adds 'open' listeners just after createDataChannel)
        // sees it as already-open. Microtask is sufficient — dispatch
        // happens before any setInterval ticks.
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
      /** Test-only: drive connectionstatechange so the state listener
       *  in controls.ts flips to 'connected' and starts the barge loop. */
      _setConnectionState(s) {
        this.connectionState = s;
        this.dispatchEvent(new Event('connectionstatechange'));
      }
    }
    (window).RTCPeerConnection = FakePC;
  });

  // ── Mock the WebRTC signalling endpoints ─────────────────────────────
  // /api/rtc/offer must succeed so the open() promise resolves and the
  // state listener proceeds to 'connected'. /api/rtc/ice and /close are
  // ack-only; we just no-op them with 200.
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

  // Ack the proxy settings sync so settings.set() doesn't log noisy 500s.
  // The mock-backend doesn't route /api/sidekick/config/*, and we don't
  // care about persistence — local in-memory settings are sufficient.
  await page.route('**/api/sidekick/config/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await waitForReady(page);

  // bargeIn must be enabled (default true, but be explicit so a future
  // settings-default flip doesn't quietly skip the loop).
  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('bargeIn', true);
    settings.set('bargeThreshold', 0.10); // default; matches device-default
    settings.set('tts', true);            // talk-mode requires tts=true
  });

  // Prime audio — getMicAnalyser delegates through to
  // platform.getSharedAudioCtx() which is null until primeAudio() runs
  // inside a user-gesture context. In headless smoke we don't have a
  // gesture, but desktop chromium doesn't enforce gesture-binding —
  // simply calling primeAudio() with a fresh <audio> element creates
  // the context and unblocks the analyser.
  await page.evaluate(async () => {
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  // ── Open a talk-mode call ────────────────────────────────────────────
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    try { await controls.openCall('talk'); }
    catch (e) { (window).__TEST_OPEN_ERR__ = String(e?.message || e); }
  });

  // After openCall resolves the FakePC exists and is in 'connecting'
  // state. Drive it to 'connected' so controls.ts wires realtimeBarge.
  await page.waitForFunction(() => !!((window)).__TEST_FAKE_PC__, null, { timeout: 5_000 });
  await page.evaluate(() => {
    const pc = (window).__TEST_FAKE_PC__;
    pc._setConnectionState('connected');
  });

  // Sanity: barge loop should now be running. Mark TTS as "playing"
  // by flipping the suppress flag — that's the same lever the real
  // assistant-delta path uses (suppress.onAssistantDelta() called from
  // main.ts's data-channel listener on every assistant transcript delta).
  await page.evaluate(async () => {
    const suppress = await import('/build/audio/realtime/suppress.mjs');
    suppress.onAssistantDelta();
  });

  // Confirm starting state: nothing sent yet, no chime fired.
  const before = await page.evaluate(() => ({
    sends: ((window)).__TEST_DC_SENDS__.slice(),
    feedback: ((window)).__TEST_FEEDBACK_LOG__.slice(),
  }));
  log(`pre-fire dc sends: ${JSON.stringify(before.sends)}`);
  log(`pre-fire feedback: ${JSON.stringify(before.feedback)}`);

  // ── Inject mic peaks ──────────────────────────────────────────────────
  // 500 ms warmup (BARGE_WARMUP_MS) starts on the first tick after
  // suppress flips on. Frame cadence is 50 ms; BargeWindow defaults are
  // windowSize=5, requiredHot=4. So the earliest fire is warmup + 5
  // frames = 750 ms. Wait ~1.2 s for buffer.
  await page.evaluate(() => { (window).__TEST_INJECT_PEAK__ = true; });

  const dcSendCheck = async () => page.evaluate(() => {
    const sends = ((window)).__TEST_DC_SENDS__;
    return sends.find((s) => {
      try {
        const o = JSON.parse(s);
        return o && o.type === 'barge';
      } catch { return false; }
    }) || null;
  });

  let bargeSend = null;
  const start = Date.now();
  while (!bargeSend && Date.now() - start < 3_000) {
    bargeSend = await dcSendCheck();
    if (!bargeSend) await page.waitForTimeout(100);
  }

  // ── Final state snapshot for diagnostics ─────────────────────────────
  const after = await page.evaluate(() => ({
    sends: ((window)).__TEST_DC_SENDS__.slice(),
    feedback: ((window)).__TEST_FEEDBACK_LOG__.slice(),
  }));
  log(`post-fire dc sends: ${JSON.stringify(after.sends)}`);
  log(`post-fire feedback: ${JSON.stringify(after.feedback)}`);

  // ── Assertions ───────────────────────────────────────────────────────

  // (1) Client-side BargeWindow fired — visible as the upstream envelope
  // appearing on the data channel. realtimeBarge.start's onFire callback
  // calls conn.sendBarge() which JSON.stringify({type:'barge'}) over dc.
  assert(
    bargeSend !== null,
    'expected upstream {type:\'barge\'} on data channel within 3s — ' +
    `got sends: ${JSON.stringify(after.sends)}`,
  );

  // (2) Chime helper fired. feedback.ts pushes {type, t} onto
  // __TEST_FEEDBACK_LOG__ for every playFeedback() call (existing
  // instrumentation hook — predates this smoke). realtimeBarge.tick
  // calls playFeedback('barge') just before invoking onFireCb.
  const bargeChime = after.feedback.find((f) => f.type === 'barge');
  assert(
    !!bargeChime,
    'expected playFeedback(\'barge\') to fire in __TEST_FEEDBACK_LOG__; ' +
    `got: ${JSON.stringify(after.feedback)}`,
  );

  // (3) NEGATIVE: bridge did NOT initiate a downstream {type:'barge'}
  // envelope. The PWA's data-channel listener (main.ts ~1025) logs
  // "[webrtc] server-side barge fired" whenever it receives a downstream
  // barge envelope. Pre-architecture-unification this is what fired —
  // post-unification, the client is the source of truth and this log
  // line should never appear in a clean smoke run. The bridgeInitiatedSeen
  // flag is captured by the console listener attached at scenario start.
  assert(
    !bridgeInitiatedSeen,
    'bridge-side barge fired — the downstream {type:\'barge\'} path should ' +
    'be retired post-unification. If this assertion regresses, the bridge ' +
    'VAD path has been revived. Confirm the architecture intent in ' +
    'src/audio/realtime/realtimeBarge.ts module docstring before making it pass.',
  );

  // Construction check: we never invoked mock.pushEnvelope or any chat
  // helper, so the mock backend has no chats. A non-zero chatCount would
  // indicate a stray /api/sidekick/messages POST somewhere in the stack
  // that should be diagnosed before trusting this assertion.
  assert(
    mock.chatCount() === 0,
    `mock backend was unexpectedly populated (chatCount=${mock.chatCount()}) — ` +
    'this smoke should not exercise any chat/message endpoints',
  );

  log(
    'realtime barge: client-side fire ✓  upstream envelope ✓  chime ✓  ' +
    'bridge-initiated path NOT triggered ✓',
  );
}
